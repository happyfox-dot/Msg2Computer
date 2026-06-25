package com.codesync.service

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.net.wifi.WifiManager
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import android.util.Base64
import android.util.Log
import androidx.core.app.NotificationCompat
import com.codesync.MainActivity
import com.codesync.R
import com.codesync.util.BusReliabilityStore
import com.codesync.util.ClipboardSyncState
import com.codesync.util.ContentBus
import com.codesync.util.CryptoUtil
import com.codesync.util.DesktopDevice
import com.codesync.util.DeviceStore
import com.codesync.util.FileTransferRegistry
import com.codesync.util.LanDiscovery
import com.codesync.util.PhoneIdentityStore
import com.codesync.util.PolicyManager
import com.codesync.util.RouteManager
import com.codesync.util.SettingsStore
import com.codesync.util.TotpEntry
import com.codesync.util.TotpStore
import com.codesync.util.TopologyStore
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.security.MessageDigest
import java.util.Locale
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicLong

private const val REGISTER_HOLD_MS = 1_500L
private const val RECONNECT_BASE_DELAY_MS = 2_000L
private const val RECONNECT_MAX_DELAY_MS = 15_000L
private const val LSDB_SEQ_PREFS = "topology_lsdb_seq"

fun WebSocketService.connectDevice(device: DesktopDevice, registerOnly: Boolean, force: Boolean = false) {
    if (!force && !device.enabled) return

    if (isPhoneDevice(device)) {
        DeviceStore.markDeviceSynced(this, device.id)
        updateConnectionState(
            if (registerOnly) "已加入设备节点 ${device.name}" else "手机节点 ${device.name} 使用 relay 投递"
        )
        stopIfNothingPending(if (registerOnly) "已加入设备节点 ${device.name}" else "空闲")
        return
    }

    val existing = connections[device.id]
    if (existing?.authenticated == true || existing?.webSocket != null) {
        // 已在连接/已连上：若现在带了负载，鉴权完成后会一并 flush
        if (!registerOnly) existing.registerOnly = false
        if (force) existing.forceConnect = true
        Log.d(WebSocketService.TAG, "Reuse existing connection for ${device.name}, registerOnly=$registerOnly, force=$force")
        if (existing.authenticated && existing.webSocket != null && !registerOnly) {
            val delivered = flushPendingForDevice(device.id)
            if (delivered) {
                updateConnectionState("已连接 ${device.name}，正在投递")
                checkAllDoneAndStop()
            } else if (!deviceHasPending(device.id)) {
                scheduleCloseAfterIdle(device.id)
            }
        }
        return
    }

    existing?.reconnectJob?.cancel()
    existing?.webSocket?.close(1000, "Reconnect")

    val connection = DeviceConnection(
        device = device,
        registerOnly = registerOnly,
        forceConnect = force
    )
    connections[device.id] = connection

    val candidates = candidateHosts(device)
    // 纯路由可达设备（拓扑同步允许 host 空但有 route）没有直连地址，
    // 不能走 WebSocket 直连——否则 candidates 为空，% candidates.size 触发
    // 除零崩溃。这类设备本就应经 relay/nextHop 投递，这里清掉空壳连接早返回。
    if (candidates.isEmpty()) {
        connections.remove(device.id)?.reconnectJob?.cancel()
        Log.d(WebSocketService.TAG, "Skip WS connect for ${device.name}: no direct host (route-only)")
        stopIfNothingPending("空闲")
        return
    }
    val connectHost = candidates[(hostRotation[device.id] ?: 0) % candidates.size]
    updateConnectionState("正在连接 ${device.name} ($connectHost:${device.port})")

    val request = Request.Builder()
        .url("ws://${formatHttpHost(connectHost)}:${device.port}")
        .build()

    connection.webSocket = wsClient.newWebSocket(request, object : WebSocketListener() {
        override fun onOpen(webSocket: WebSocket, response: Response) {
            Log.d(WebSocketService.TAG, "Connected to ${device.name}")
            val phoneIdentity = PhoneIdentityStore.get(this@connectDevice)
            val phoneNonce = CryptoUtil.generateNonce()
            connection.phoneNonce = phoneNonce
            // 注意：auth 消息走明文 ws://，不携带本机 relay 配对密钥；
            // 密钥在鉴权成功、会话密钥建立后通过加密 node_info 上报（见 auth_ok 分支）
    val authMsg = JSONObject()
        .put("type", "auth")
        .put("authVersion", 2)
        .put("phoneId", phoneIdentity.id)
        .put("phoneName", phoneIdentity.name)
        .put("phoneDeviceType", "ANDROID_PHONE")
        .put("phoneNonce", phoneNonce)
        .put("requestTopology", connection.registerOnly || deviceHasPendingType(device.id, "topology_delta"))
        .put("authToken", CryptoUtil.hmacSha256Base64(device.pairingKey, "${phoneIdentity.id}|$phoneNonce"))
        .toString()
    webSocket.send(authMsg)
        }

        override fun onMessage(webSocket: WebSocket, text: String) {
            try {
                val msg = JSONObject(text)
                when (msg.optString("type")) {
                    "auth_ok" -> {
                        connection.sessionKey = if (msg.optString("keyMode") == "derived") {
                            val serverNonce = msg.optString("serverNonce")
                            CryptoUtil.deriveSessionKey(device.pairingKey, connection.phoneNonce, serverNonce)
                        } else {
                            msg.optString("sessionKey")
                        }
                        connection.authenticated = true
                        updateConnectionState("已连接 ${device.name}")
                        reconnectAttempts.remove(device.id)
                        hostRotation.remove(device.id)
                        // 会话密钥就绪后第一时间加密上报本机 relay 信息（替代明文 auth 字段）
                        sendNodeInfo(webSocket, connection)
                        val hasPendingTopology = deviceHasPendingType(device.id, "topology_delta")
                        if (connection.registerOnly || hasPendingTopology) {
                            requestTopologySnapshot(webSocket, connection)
                        }
                        if (connection.registerOnly && !hasPendingTopology) {
                            sendStoredTopologyDelta(webSocket, connection)
                        }
                        DeviceStore.markDeviceSynced(this@connectDevice, device.id)
                        Log.d(WebSocketService.TAG, "Authenticated ${device.name}")
                        val delivered = flushPendingForDevice(device.id)
                        if (deviceHasPending(device.id)) {
                            updateConnectionState("已连接 ${device.name}，正在投递")
                        } else {
                            // 没有待投递负载（纯配对测试，或已全部送达）：短暂保持后断开
                            updateConnectionState(
                                if (connection.registerOnly) "配对成功 ${device.name}"
                                else "已送达 ${device.name}"
                            )
                            scheduleCloseAfterIdle(device.id)
                        }
                        if (delivered) checkAllDoneAndStop()
                    }
                    "code_ack" -> {
                        val ackedId = msg.optString("msgId")
                        Log.d(WebSocketService.TAG, "ACK ${device.name}: $ackedId")
                        DeviceStore.markDeviceSynced(this@connectDevice, device.id)
                        ackDelivery(device.id, ackedId)
                        if (!deviceHasPending(device.id)) {
                            scheduleCloseAfterIdle(device.id)
                        }
                        checkAllDoneAndStop()
                    }
                    "totp_sync" -> {
                        // 桌面端下发的 TOTP 种子同步（一次性，本地算码，无需常驻连接）。
                        // 收到后解密落库并通知界面刷新；注意：这不是 ACK，不能触发结束/断开逻辑，
                        // 收到后保持短暂空闲再断开，以便同一次连接里多条种子都能收齐。
                        handleTotpSync(connection, msg.optString("payload"))
                        if (!deviceHasPending(device.id)) {
                            scheduleCloseAfterIdle(device.id)
                        }
                    }
                    "topology_sync" -> {
                        handleTopologySync(connection, msg.optString("payload"))
                    }
                    "topology_delta", "node_advertisement", "link_advertisement" -> {
                        handleTopologyDelta(connection, msg.optString("payload"))
                        val msgId = msg.optString("msgId")
                        if (msgId.isNotBlank()) {
                            webSocket.send(JSONObject().put("type", "code_ack").put("msgId", msgId).toString())
                        }
                    }
                    "topology_snapshot_request" -> {
                        val sessionKey = connection.sessionKey
                        val encryptedPayload = msg.optString("payload")
                        if (!sessionKey.isNullOrBlank() && encryptedPayload.isNotBlank()) {
                            runCatching { JSONObject(CryptoUtil.decrypt(encryptedPayload, sessionKey)) }
                                .onSuccess { request ->
                                    val replayed = replayTopologyBacklog(webSocket, connection, request.optJSONObject("seenSeq"))
                                    if (!replayed) {
                                        sendStoredTopologyDelta(webSocket, connection, reason = "snapshot_response", remember = false)
                                    }
                                }
                        }
                    }
                    "auth_fail" -> {
                        Log.e(WebSocketService.TAG, "Authentication failed for ${device.name}")
                        connection.deniedByDesktop = true
                        updateConnectionState("配对密钥不匹配，请重新扫描 ${device.name} 的二维码")
                        webSocket.close(1000, "Authentication failed")
                    }
                    "auth_denied" -> {
                        connection.deniedByDesktop = true
                        connection.authenticated = false
                        val reason = msg.optString("reason")
                        val message = when (reason) {
                            "phone_disabled" -> "目标节点已禁用或撤销此手机：${device.name}"
                            else -> "目标节点拒绝此手机授权：${device.name}"
                        }
                        Log.e(WebSocketService.TAG, "Phone authorization denied by ${device.name}: $reason")
                        updateConnectionState(message)
                        // 该目标节点拒绝，不再为它保留待投递
                        dropPendingForDevice(device.id)
                        webSocket.close(1000, "Phone authorization denied")
                    }
                }
            } catch (e: Exception) {
                Log.e(WebSocketService.TAG, "Message parse error", e)
            }
        }

        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
            Log.e(WebSocketService.TAG, "Connection failed for ${device.name}", t)
            connection.authenticated = false
            connection.webSocket = null
            // 本地址失败，下次重连轮换到下一个候选地址（如对端的 Tailscale IP）
            hostRotation[device.id] = (hostRotation[device.id] ?: 0) + 1
            updateConnectionState("连接失败 ${device.name}: ${formatConnectionError(t)}")
            if (!connection.deniedByDesktop && deviceHasPending(device.id)) {
                scheduleReconnect(device.id)
            } else {
                cleanupConnection(device.id)
                checkAllDoneAndStop()
            }
        }

        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
            Log.d(WebSocketService.TAG, "Closed ${device.name}: $reason")
            connection.authenticated = false
            connection.webSocket = null
            if (!connection.deniedByDesktop && deviceHasPending(device.id)) {
                scheduleReconnect(device.id)
            } else {
                cleanupConnection(device.id)
                checkAllDoneAndStop()
            }
        }
    })
}

/**
 * 鉴权成功后通过加密通道上报本机 relay 配对密钥与端口。
 * 旧版把这两个字段放在明文 auth 消息里，同网段抓包即可伪造对本机的中继投递；
 * 现在桌面端通过 node_info（会话密钥加密）获取，旧桌面端会忽略未知消息类型。
 */
fun WebSocketService.sendNodeInfo(webSocket: WebSocket, connection: DeviceConnection) {
    val sessionKey = connection.sessionKey ?: return
    try {
        val identity = PhoneIdentityStore.get(this)
        val info = JSONObject()
            .put("type", "node_info")
            .put("nodePairingKey", identity.pairingKey)
            .put("nodeRelayPort", LanDiscovery.NODE_RELAY_PORT)
            .put("nodeRelayHost", LanDiscovery.localLanHost())
            .put("capabilities", JSONObject()
                .put("topology", true)
                .put("relay", true)
                .put("sms", true)
                .put("totp", true)
                .put("clipboardText", true)
                .put("clipboardImage", true)
                .put("clipboardFile", true)
                .put("fileTransfer", true)
                .put("softBus", true)
                .put("p2pDirect", true)
                .put("joinRequest", true))
            .apply {
                // 本机的 Tailscale IP（如有）：桌面端会把它随路由表分发给其它
                // 手机节点作为备用 relay 地址，实现跨网段的节点直连
                val tsHost = LanDiscovery.localTailscaleHost()
                if (tsHost.isNotBlank()) put("nodeTsHost", tsHost)
            }
            .toString()
        webSocket.send(
            JSONObject()
                .put("type", "node_info")
                .put("payload", CryptoUtil.encrypt(info, sessionKey))
                .toString()
        )
    } catch (e: Exception) {
        Log.e(WebSocketService.TAG, "发送 node_info 失败", e)
    }
}

fun WebSocketService.requestTopologySnapshot(webSocket: WebSocket, connection: DeviceConnection) {
    val sessionKey = connection.sessionKey ?: return
    try {
        val identity = PhoneIdentityStore.get(this)
        val payload = JSONObject()
            .put("type", "topology_snapshot_request")
            .put("sourceDeviceId", identity.id)
            .put("seenSeq", TopologyStore.seenSeqSnapshot(this))
            .put("timestamp", System.currentTimeMillis())
        webSocket.send(
            JSONObject()
                .put("type", "topology_snapshot_request")
                .put("payload", CryptoUtil.encrypt(payload.toString(), sessionKey))
                .toString()
        )
    } catch (e: Exception) {
        Log.e(WebSocketService.TAG, "请求 topology snapshot 失败", e)
    }
}

fun WebSocketService.sendStoredTopologyDelta(
    webSocket: WebSocket,
    connection: DeviceConnection,
    reason: String = "android_auth",
    remember: Boolean = true
) {
    val sessionKey = connection.sessionKey ?: return
    try {
        val delta = TopologyStore.buildDelta(
            context = this,
            reason = reason,
            connectedDeviceIds = WebSocketService.connectedDeviceIds
        )
        if (remember) TopologyStore.rememberLocalDelta(this, delta)
        webSocket.send(
            JSONObject()
                .put("type", "topology_delta")
                .put("payload", CryptoUtil.encrypt(delta.toString(), sessionKey))
                .toString()
        )
    } catch (e: Exception) {
        Log.e(WebSocketService.TAG, "发送 topology_delta 失败", e)
    }
}

fun WebSocketService.replayTopologyBacklog(
    webSocket: WebSocket,
    connection: DeviceConnection,
    seenSeq: JSONObject?
): Boolean {
    val sessionKey = connection.sessionKey ?: return false
    val deltas = TopologyStore.replayDeltasSince(this, seenSeq)
    if (deltas.isEmpty()) return false
    return try {
        deltas.forEach { delta ->
            webSocket.send(
                JSONObject()
                    .put("type", "topology_delta")
                    .put("payload", CryptoUtil.encrypt(delta.toString(), sessionKey))
                    .toString()
            )
        }
        true
    } catch (e: Exception) {
        Log.e(WebSocketService.TAG, "回放 topology delta 失败", e)
        false
    }
}

fun WebSocketService.handleTopologyDelta(connection: DeviceConnection, encryptedPayload: String) {
    val sessionKey = connection.sessionKey
    if (sessionKey.isNullOrBlank() || encryptedPayload.isBlank()) {
        Log.w(WebSocketService.TAG, "topology_delta 缺少会话密钥或负载，忽略")
        return
    }
    val plain = try {
        CryptoUtil.decrypt(encryptedPayload, sessionKey)
    } catch (e: Exception) {
        Log.e(WebSocketService.TAG, "topology_delta 解密失败", e)
        return
    }
    try {
        val delta = JSONObject(plain)
        val changed = TopologyStore.applyDelta(this, delta)
        if (changed) {
            updateConnectionState("已更新拓扑：${connection.device.name}")
            broadcastTopologyDelta("topology_delta_received", excludeDeviceId = connection.device.id)
            notifyTotpSynced()
        }
    } catch (e: Exception) {
        Log.e(WebSocketService.TAG, "topology_delta 解析失败", e)
    }
}

/** 鉴权成功后无待投递负载时，保持很短时间再断开（给登记/缓冲落地留余量）。 */
fun WebSocketService.scheduleCloseAfterIdle(deviceId: String) {
    val connection = connections[deviceId] ?: return
    connection.reconnectJob?.cancel()
    connection.reconnectJob = serviceScope.launch {
        delay(REGISTER_HOLD_MS)
        if (!deviceHasPending(deviceId)) {
            cleanupConnection(deviceId)
            checkAllDoneAndStop()
        }
    }
}

fun WebSocketService.scheduleReconnect(deviceId: String) {
    val connection = connections[deviceId] ?: return
    connection.reconnectJob?.cancel()

    val attempt = reconnectAttempts[deviceId] ?: 0
    val delayMs = (RECONNECT_BASE_DELAY_MS shl attempt.coerceAtMost(3))
        .coerceAtMost(RECONNECT_MAX_DELAY_MS)
    reconnectAttempts[deviceId] = (attempt + 1).coerceAtMost(8)

    connection.reconnectJob = serviceScope.launch {
        delay(delayMs)
        val latest = DeviceStore.findDevice(this@scheduleReconnect, deviceId)
        if (latest != null && (latest.enabled || connection.forceConnect) &&
            deviceHasPending(deviceId) &&
            connections[deviceId]?.authenticated != true
        ) {
            updateConnectionState("正在重连 ${latest.name}")
            connectDevice(latest, registerOnly = false, force = connection.forceConnect)
        } else {
            cleanupConnection(deviceId)
            checkAllDoneAndStop()
        }
    }
}

/**
 * 处理桌面节点下发的路由表。电脑作为拓扑交换点，把其它已授权手机的
 * relay 地址和配对密钥告诉本机；本机随后可直接向这些手机节点推送短信/TOTP。
 */
fun WebSocketService.handleTopologySync(connection: DeviceConnection, encryptedPayload: String) {
    val sessionKey = connection.sessionKey
    if (sessionKey.isNullOrBlank() || encryptedPayload.isBlank()) {
        Log.w(WebSocketService.TAG, "topology_sync 缺少会话密钥或负载，忽略")
        return
    }

    val plain = try {
        CryptoUtil.decrypt(encryptedPayload, sessionKey)
    } catch (e: Exception) {
        Log.e(WebSocketService.TAG, "topology_sync 解密失败", e)
        return
    }

    try {
        val sync = JSONObject(plain)
        if (sync.optString("type") != "topology_sync") return
        val identity = PhoneIdentityStore.get(this)

        // OSPF LSA 新鲜度规则的简化版：按来源桌面记录已接受的最大 lsdbSeq，
        // 收到更小的序列号说明是迟到/乱序的旧路由表，整包丢弃。否则手机同时
        // 连接两台桌面时，后到的陈旧 topology_sync 会覆盖更新的路由。
        // 旧版桌面端不带 lsdbSeq（=0）时跳过检查以保持兼容。
        val sourceId = sync.optString("sourceDeviceId").trim().ifBlank { connection.device.id }
        val lsdbSeq = sync.optLong("lsdbSeq", 0L)
        if (lsdbSeq > 0L) {
            val lastSeq = lastAcceptedLsdbSeq(sourceId)
            if (lsdbSeq < lastSeq) {
                Log.w(WebSocketService.TAG, "丢弃过期 topology_sync：seq=$lsdbSeq < $lastSeq，来源 ${connection.device.name}")
                return
            }
            rememberLsdbSeq(sourceId, lsdbSeq)
        }

        val nodes = sync.optJSONArray("nodes") ?: JSONArray()
        val routeByDestination = mutableMapOf<String, JSONObject>()
        val routes = sync.optJSONArray("routes") ?: JSONArray()
        TopologyStore.applyDelta(
            this,
            JSONObject()
                .put("type", "topology_delta")
                .put("version", sync.optInt("version", 2))
                .put("routingProtocol", sync.optString("routingProtocol", "link-state-spf"))
                .put("sourceDeviceId", sourceId)
                .put("sourceDeviceName", sync.optString("sourceDeviceName", connection.device.name))
                .put("sourceDeviceType", sync.optString("sourceDeviceType", connection.device.type))
                .put("seq", lsdbSeq.takeIf { it > 0L } ?: sync.optLong("updatedAt", System.currentTimeMillis()))
                .put("ttl", 4)
                .put("updatedAt", sync.optLong("updatedAt", System.currentTimeMillis()))
                .put("nodes", nodes)
                .put("links", JSONArray())
        )
        for (i in 0 until routes.length()) {
            val route = routes.optJSONObject(i) ?: continue
            val destinationId = route.optString("destinationId", route.optString("to")).trim()
            if (destinationId.isNotBlank()) routeByDestination[destinationId] = route
        }
        var imported = 0
        for (i in 0 until nodes.length()) {
            val node = nodes.optJSONObject(i) ?: continue
            val id = node.optString("id").trim()
            val type = node.optString("type", node.optString("deviceType", "")).trim()
            val directHost = node.optString("host").trim()
            val altHosts = (jsonArrayToList(node.optJSONArray("altHosts")) +
                listOfNotNull(node.optString("tsHost").trim().takeIf { it.isNotBlank() }))
                .map { it.trim() }
                .filter { it.isNotBlank() }
                .distinct()
            val host = directHost.ifBlank { altHosts.firstOrNull().orEmpty() }
            val normalizedType = type.ifBlank { "UNKNOWN_DEVICE" }
            val isPhone = normalizedType.uppercase(Locale.ROOT).contains("PHONE")
            val rawPort = node.optInt(
                "wsPort",
                node.optInt("port", if (isPhone) LanDiscovery.NODE_RELAY_PORT else 19527)
            )
            val port = if (isPhone) {
                if (rawPort > 0) rawPort else LanDiscovery.NODE_RELAY_PORT
            } else {
                when {
                    rawPort <= 0 -> 19527
                    rawPort == LanDiscovery.NODE_RELAY_PORT -> 19527
                    else -> rawPort
                }
            }
            val pairingKey = node.optString("pairingKey", node.optString("pk", "")).trim()
            val route = node.optJSONObject("route") ?: routeByDestination[id]
            val routePath = jsonArrayToList(route?.optJSONArray("path"))
            val hasRoute = (route?.optInt("metric", 0) ?: 0) > 0 ||
                route?.optString("nextHopId").orEmpty().isNotBlank() ||
                routePath.size > 1
            if (id.isBlank() || id == identity.id || pairingKey.isBlank()) continue
            if (host.isBlank() && !hasRoute) continue
            val existingDevice = DeviceStore.findDevice(this, id)
            val updatedDevice = DeviceStore.upsertDevice(
                context = this,
                host = host,
                port = port,
                pairingKey = pairingKey,
                name = node.optString("name", "Device $host").ifBlank { "Device $host" },
                deviceId = id,
                deviceType = normalizedType,
                routeMetric = route?.optInt("metric", 0) ?: 0,
                routeNextHopId = route?.optString("nextHopId").orEmpty(),
                routeNextHopName = route?.optString("nextHopName").orEmpty(),
                routePath = routePath,
                // 路由新鲜度以「整包路由表的计算时间」为准（同一包内统一），而不是
                // 单条边的 updatedAt——后者来自 lastSeen，可能比已存值旧，
                // 会被 DeviceStore 的新鲜度比较误判为过期路由
                routeUpdatedAt = sync.optLong("updatedAt", 0L).takeIf { it > 0L }
                    ?: route?.optLong("updatedAt", 0L) ?: 0L,
                altHosts = altHosts.filter { it != host },
                policyAllowSmsCodes = node.optBoolean("allowSmsCodes", true),
                policyAllowSmsMessages = node.optBoolean("allowSmsMessages", true),
                policyAllowNotifications = node.optBoolean("allowNotifications", true),
                policyAllowTotp = node.optBoolean("allowTotp", true),
                policyAllowClipboard = node.optBoolean(
                    "allowClipboardText",
                    node.optBoolean("allowClipboard", false)
                ),
                policyAllowClipboardImage = node.optBoolean("allowClipboardImage", false),
                policyAllowClipboardFile = node.optBoolean("allowClipboardFile", false),
                policyAllowFileTransfer = node.optBoolean("allowFileTransfer", false),
                policyMaxFileSizeMb = node.optInt("maxFileSizeMb", 50),
                policyAutoAcceptFiles = node.optBoolean("autoAcceptFiles", false)
            )
            if (existingDevice != updatedDevice) imported += 1
        }
        if (imported > 0) {
            updateConnectionState("已更新 $imported 个可达设备节点")
            broadcastTopologyDelta("topology_sync_imported", excludeDeviceId = connection.device.id)
            Log.d(WebSocketService.TAG, "topology_sync imported $imported peers from ${connection.device.name}")
        }
    } catch (e: Exception) {
        Log.e(WebSocketService.TAG, "topology_sync 解析失败", e)
    }
}

fun WebSocketService.sha256Hex(bytes: ByteArray): String {
    return MessageDigest.getInstance("SHA-256")
        .digest(bytes)
        .joinToString("") { "%02x".format(it) }
}

fun WebSocketService.formatBytes(size: Long): String {
    val units = arrayOf("B", "KB", "MB", "GB")
    var value = size.toDouble()
    var index = 0
    while (value >= 1024.0 && index < units.lastIndex) {
        value /= 1024.0
        index += 1
    }
    return if (index == 0) {
        "$size ${units[index]}"
    } else {
        String.format(Locale.US, "%.1f %s", value, units[index])
    }
}

fun WebSocketService.lastAcceptedLsdbSeq(sourceId: String): Long =
    getSharedPreferences(LSDB_SEQ_PREFS, Context.MODE_PRIVATE).getLong(sourceId, 0L)

fun WebSocketService.rememberLsdbSeq(sourceId: String, seq: Long) {
    getSharedPreferences(LSDB_SEQ_PREFS, Context.MODE_PRIVATE)
        .edit()
        .putLong(sourceId, seq)
        .apply()
}

/**
 * 处理桌面端下发的 TOTP 种子同步消息。
 * 外层已是 { type:"totp_sync", payload:<密文> }，这里解密 payload 得到种子明文，
 * 按 action 落库（add/delete），再发本地广播通知 MainActivity 刷新列表。
 *
 * 设计要点：
 * - 只同步「种子配置」，本地算码，因此无需常驻连接；
 * - 远程来源条目标记 isLocal=false（只读，界面隐藏编辑/删除入口）；
 * - 删除按 secret 匹配本地条目，不用对方的 id（桌面与本机的 id 算法不同）；
 * - 同一种子重复下发由 TotpStore 按 stableId 幂等覆盖，无需额外去重。
 */
