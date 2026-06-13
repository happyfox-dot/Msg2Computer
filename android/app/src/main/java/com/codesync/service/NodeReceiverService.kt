package com.codesync.service

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.ClipData
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.os.IBinder
import android.util.Base64
import android.util.Log
import androidx.core.content.FileProvider
import androidx.core.app.NotificationCompat
import com.codesync.MainActivity
import com.codesync.R
import com.codesync.util.ClipboardSyncState
import com.codesync.util.ContentBus
import com.codesync.util.CryptoUtil
import com.codesync.util.DeviceStore
import com.codesync.util.FileTransferCoordinator
import com.codesync.util.FileTransferRegistry
import com.codesync.util.LanDiscovery
import com.codesync.util.LanJoinClient
import com.codesync.util.LanJoinCoordinator
import com.codesync.util.LanJoinCrypto
import com.codesync.util.LanTrustStore
import com.codesync.util.PendingLanJoinRequest
import com.codesync.util.PhoneIdentityStore
import com.codesync.util.SettingsStore
import com.codesync.util.TotpEntry
import com.codesync.util.TotpStore
import com.codesync.util.TopologyStore
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.ServerSocket
import java.net.Socket
import java.net.URL
import java.net.URLDecoder
import java.net.URLEncoder
import java.security.MessageDigest
import java.util.Locale

class NodeReceiverService : Service() {
    companion object {
        private const val TAG = "NodeReceiverService"
        private const val NOTIFICATION_ID = 1002
        private const val CHANNEL_ID = "code_sync_node_receiver"
        private const val MAX_BODY_BYTES = 512 * 1024
        private const val MAX_INLINE_CLIPBOARD_IMAGE_BYTES = 180 * 1024
        private const val FILE_TRANSFER_CHUNK_BYTES = 1024 * 1024
        private const val FILE_TRANSFER_TIMEOUT_MS = 20_000
        private const val RECENT_IDS_LIMIT = 200
        private const val PREFS_NAME = "node_relay_dedup"
        private const val KEY_RECENT_IDS = "recent_ids"
        private const val IMAGE_STATE_PREFS = "clipboard_image_sync_state"
        // 中继消息时间窗：超出视为重放（去重表只有 200 条，旧消息滚出后可被整包重放）。
        // 容差要覆盖多跳转发延迟与节点间时钟偏差；TOTP 本身要求时钟同步，±5 分钟足够
        private const val RELAY_REPLAY_WINDOW_MS = 5 * 60 * 1000L
        // relay nonce 去重：与时间窗配合堵住"窗口内整包重放"。每条 relay 帧带随机 nonce，
        // 仅内存留存（窗口期外的旧 nonce 必被时间窗拦截，无需跨重启持久化）。
        private const val RELAY_NONCE_TTL_MS = RELAY_REPLAY_WINDOW_MS
        private const val RELAY_NONCE_LIMIT_PER_SENDER = 300
    }

    private val serviceScope = CoroutineScope(Dispatchers.IO + SupervisorJob())
    @Volatile
    private var running = false
    private var serverSocket: ServerSocket? = null
    private var lanResponderJob: Job? = null

    private data class FileSource(
        val id: String,
        val name: String,
        val host: String,
        val port: Int,
        val type: String,
        val pairingKey: String
    )

    private data class ReceivedFile(
        val name: String,
        val file: File,
        val size: Long,
        val mime: String,
        val sourceName: String
    )

    private data class HttpRequest(
        val method: String,
        val path: String,
        val query: Map<String, String>,
        val body: String
    )

    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        startForeground(NOTIFICATION_ID, buildNotification())
        if (!running) {
            running = true
            serviceScope.launch { listenLoop() }
        }
        startLanResponder()
        return START_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun listenLoop() {
        try {
            serverSocket = ServerSocket(LanDiscovery.NODE_RELAY_PORT)
            Log.d(TAG, "Node receiver listening on ${LanDiscovery.NODE_RELAY_PORT}")
            while (running) {
                val socket = serverSocket?.accept() ?: break
                serviceScope.launch {
                    handleClient(socket)
                }
            }
        } catch (e: Exception) {
            if (running) Log.e(TAG, "Node receiver failed", e)
        }
    }

    private fun startLanResponder() {
        if (lanResponderJob?.isActive == true) return
        lanResponderJob = serviceScope.launch {
            runCatching {
                LanDiscovery.respondToProbes(this@NodeReceiverService) { running }
            }.onFailure {
                Log.w(TAG, "LAN discovery responder stopped", it)
            }
        }
    }

    private suspend fun handleClient(socket: Socket) {
        socket.use {
            try {
                val request = readHttpRequest(socket)
                if (request == null) {
                    writeHttpResponse(socket, 400)
                    return
                }
                if (request.method == "GET" && (request.path.startsWith("/file/proxy/") || request.path.startsWith("/bus/file/proxy/"))) {
                    handleFileProxyRequest(socket, request)
                    return
                }
                if (request.method == "GET" && (request.path.startsWith("/file/") || request.path.startsWith("/bus/file/"))) {
                    handleFileChunkRequest(socket, request)
                    return
                }
                if (request.method == "POST") {
                    val json = JSONObject(request.body)
                    if (json.optString("type") == "join_request") {
                        val response = handleJoinRequest(json, socket.inetAddress?.hostAddress.orEmpty())
                        writeJsonHttpResponse(socket, response.first, response.second)
                    } else if (json.optString("type") == "codebridge_bus") {
                        val response = handleBusEnvelope(json)
                        writeJsonHttpResponse(socket, response.first, response.second)
                    } else {
                        writeHttpResponse(socket, handleRelayEnvelope(json))
                    }
                } else {
                    writeHttpResponse(socket, 400)
                }
            } catch (e: Exception) {
                Log.e(TAG, "Relay request failed", e)
                writeHttpResponse(socket, 400)
            }
        }
    }

    private fun handleFileChunkRequest(socket: Socket, request: HttpRequest) {
        val fileId = request.path
            .removePrefix("/bus/file/")
            .removePrefix("/file/")
            .trim()
        if (fileId.isBlank()) {
            writeHttpResponse(socket, 400)
            return
        }
        val result = FileTransferRegistry.serveChunk(
            context = this,
            fileId = fileId,
            fromRaw = request.query["from"],
            toRaw = request.query["to"],
            senderId = request.query["senderId"],
            nonce = request.query["nonce"],
            authToken = request.query["authToken"]
        )
        if (result.status == 206 && result.body != null) {
            writeBinaryHttpResponse(
                socket = socket,
                code = 206,
                body = result.body,
                contentRange = result.contentRange,
                totalSize = result.totalSize
            )
        } else {
            writeHttpResponse(socket, result.status)
        }
    }

    // 多跳分片代理：GET /file/proxy/{originId}/{fileId}?from=&to=&senderId=&nonce=&authToken=&hop=N
    // 鉴权与分片加密在请求方与源设备之间端到端完成，本节点只转发字节。
    // 源就是本机时直接服务；否则源可直达就转直连请求，不可直达且 hop 有余量
    // 时交给下一个可信节点继续代理（hop 递减防环）。
    private fun handleFileProxyRequest(socket: Socket, request: HttpRequest) {
        val segments = request.path
            .removePrefix("/bus/file/proxy/")
            .removePrefix("/file/proxy/")
            .split("/", limit = 2)
        val originId = segments.getOrNull(0).orEmpty().trim()
        val fileId = segments.getOrNull(1).orEmpty().trim()
        if (originId.isBlank() || fileId.isBlank()) {
            writeHttpResponse(socket, 400)
            return
        }
        if (originId == PhoneIdentityStore.get(this).id) {
            handleFileChunkRequest(socket, request.copy(path = "/file/$fileId"))
            return
        }
        val hop = (request.query["hop"]?.toIntOrNull() ?: 0).coerceIn(0, 4)
        if (hop <= 0) {
            writeHttpResponse(socket, 502)
            return
        }
        val requesterId = request.query["senderId"].orEmpty()
        val baseQuery = listOf("from", "to", "senderId", "nonce", "authToken")
            .mapNotNull { key -> request.query[key]?.let { "$key=${urlEncode(it)}" } }
            .joinToString("&")
        val origin = DeviceStore.findDevice(this, originId)
        val forwardUrl = if (origin != null && origin.host.isNotBlank()) {
            "http://${origin.host}:${LanDiscovery.NODE_RELAY_PORT}/file/${urlEncode(fileId)}?$baseQuery"
        } else {
            val next = DeviceStore.getEnabledDevices(this)
                .firstOrNull { it.id != originId && it.id != requesterId && it.host.isNotBlank() }
            if (next == null) {
                writeHttpResponse(socket, 502)
                return
            }
            "http://${next.host}:${LanDiscovery.NODE_RELAY_PORT}/file/proxy/${urlEncode(originId)}/${urlEncode(fileId)}?$baseQuery&hop=${hop - 1}"
        }
        val bytes = runCatching { httpGetBytes(forwardUrl) }.getOrNull()
        if (bytes != null) {
            writeBinaryHttpResponse(socket, 206, bytes, "", 0L)
        } else {
            writeHttpResponse(socket, 502)
        }
    }

    // Content-Length 是字节数，必须按字节读取后再整体解码 UTF-8。
    // 之前用 BufferedReader 读「contentLength 个字符」，含中文的 payload（每字 3 字节）
    // 会试图读超出实际内容的字符数，阻塞到对端超时，导致中文短信中继失败。
    private fun readHttpRequest(socket: Socket): HttpRequest? {
        val input = socket.getInputStream().buffered()
        val requestLine = readHeaderLine(input).orEmpty()
        val parts = requestLine.split(" ")
        if (parts.size < 2) return null
        val method = parts[0].uppercase(Locale.US)
        val rawTarget = parts[1]

        var contentLength = 0
        while (true) {
            val line = readHeaderLine(input) ?: return null
            if (line.isEmpty()) break
            val separator = line.indexOf(':')
            if (separator <= 0) continue
            val name = line.substring(0, separator).trim().lowercase(Locale.US)
            val value = line.substring(separator + 1).trim()
            if (name == "content-length") {
                contentLength = value.toIntOrNull() ?: 0
            }
        }
        if (contentLength > MAX_BODY_BYTES) return null

        val body = if (contentLength > 0) {
            val bytes = ByteArray(contentLength)
            var read = 0
            while (read < contentLength) {
                val count = input.read(bytes, read, contentLength - read)
                if (count <= 0) break
                read += count
            }
            String(bytes, 0, read, Charsets.UTF_8)
        } else {
            ""
        }

        val question = rawTarget.indexOf('?')
        val rawPath = if (question >= 0) rawTarget.substring(0, question) else rawTarget
        val rawQuery = if (question >= 0) rawTarget.substring(question + 1) else ""
        return HttpRequest(
            method = method,
            path = urlDecode(rawPath),
            query = parseQuery(rawQuery),
            body = body
        )
    }

    private fun parseQuery(raw: String): Map<String, String> {
        if (raw.isBlank()) return emptyMap()
        return raw.split("&")
            .mapNotNull { part ->
                val separator = part.indexOf('=')
                if (separator < 0) return@mapNotNull null
                val key = urlDecode(part.substring(0, separator))
                val value = urlDecode(part.substring(separator + 1))
                key.takeIf { it.isNotBlank() }?.let { it to value }
            }
            .toMap()
    }

    /** 按字节读一行 HTTP 头（头部是 ASCII，逐字节安全），返回 null 表示流已结束。 */
    private fun readHeaderLine(input: InputStream): String? {
        val sb = StringBuilder()
        while (true) {
            val b = input.read()
            if (b == -1) return if (sb.isEmpty()) null else sb.toString()
            if (b == '\n'.code) break
            if (b != '\r'.code) sb.append(b.toChar())
        }
        return sb.toString()
    }

    private suspend fun handleJoinRequest(request: JSONObject, remoteAddress: String): Pair<Int, JSONObject> {
        val requestId = request.optString("requestId").trim()
        if (!LanTrustStore.isJoinRequestAllowed(this)) {
            return 403 to JSONObject().put("type", "join_reject").put("requestId", requestId).put("reason", "join_requests_disabled")
        }
        if (request.optString("protocol") != "codebridge-lan-discovery" || requestId.isBlank()) {
            return 400 to JSONObject().put("type", "join_reject").put("reason", "invalid_join_request")
        }
        val requesterPublicKey = request.optString("ephemeralPublicKey").trim()
        val encryptedPayload = request.optString("payload").trim()
        if (requesterPublicKey.isBlank() || encryptedPayload.isBlank()) {
            return 400 to JSONObject().put("type", "join_reject").put("requestId", requestId).put("reason", "missing_join_fields")
        }

        val sessionKey = LanJoinCrypto.createAcceptKey(this, requesterPublicKey)
        val payload = JSONObject(CryptoUtil.decrypt(encryptedPayload, sessionKey))
        val requesterNode = payload.optJSONObject("node") ?: JSONObject()
            .put("id", request.optString("nodeId"))
            .put("name", request.optString("nodeName"))
            .put("type", request.optString("nodeType"))
            .put("host", request.optString("host"))
            .put("port", request.optInt("port", 19527))
            .put("joinPort", request.optInt("joinPort", LanDiscovery.NODE_RELAY_PORT))
            .put("capabilities", request.optJSONObject("capabilities") ?: JSONObject())
        val nodeId = requesterNode.optString("id", requesterNode.optString("deviceId")).trim()
        val requesterPairingKey = payload.optString("nodePairingKey").trim()
        if (nodeId.isBlank() || requesterPairingKey.isBlank()) {
            return 400 to JSONObject().put("type", "join_reject").put("requestId", requestId).put("reason", "invalid_requester_identity")
        }

        val host = requesterNode.optString("host", request.optString("host")).ifBlank { remoteAddress }
        val joinView = PendingLanJoinRequest(
            requestId = requestId,
            nodeId = nodeId,
            nodeName = requesterNode.optString("name", requesterNode.optString("deviceName", nodeId)),
            nodeType = requesterNode.optString("type", requesterNode.optString("deviceType", request.optString("nodeType", "UNKNOWN_DEVICE"))),
            host = host,
            port = requesterNode.optInt("port", request.optInt("port", 19527)),
            joinPort = requesterNode.optInt("joinPort", request.optInt("joinPort", LanDiscovery.NODE_RELAY_PORT)),
            fingerprint = request.optString("fingerprint"),
            capabilities = requesterNode.optJSONObject("capabilities") ?: request.optJSONObject("capabilities") ?: JSONObject(),
            networkId = payload.optString("networkId"),
            requestedContentPolicy = payload.optJSONObject("requestedContentPolicy") ?: JSONObject()
        )
        val decision = LanJoinCoordinator.requestApproval(this, joinView)
        if (!decision.accepted) {
            return 200 to JSONObject().put("type", "join_reject").put("requestId", requestId).put("reason", "user_rejected")
        }

        val acceptedAt = System.currentTimeMillis()
        val networkId = LanTrustStore.getNetworkId(this)
        val policy = LanJoinClient.contentPolicy(decision.template)
        val device = DeviceStore.upsertDevice(
            context = this,
            host = host,
            port = joinView.port,
            pairingKey = requesterPairingKey,
            name = joinView.nodeName,
            deviceId = nodeId,
            deviceType = joinView.nodeType,
            networkId = networkId,
            autoPaired = true,
            trustSourceId = PhoneIdentityStore.get(this).id,
            trustLevel = "trusted_lan",
            acceptedAt = acceptedAt,
            capabilities = joinView.capabilities.toString(),
            enabled = true
        )
        LanJoinClient.applyContentPolicy(this, device.id, policy)
        val updatedDevice = DeviceStore.findDevice(this, device.id) ?: device
        TopologyStore.markDeviceState(this, updatedDevice, enabled = true)
        payload.optJSONObject("topologySnapshot")?.let {
            runCatching { TopologyStore.applyDelta(this, it) }
        }
        broadcastTopologyChange("lan_join_accept")

        val identity = PhoneIdentityStore.get(this)
        val acceptPayload = JSONObject()
            .put("networkId", networkId)
            .put("acceptedByNodeId", identity.id)
            .put("acceptedAt", acceptedAt)
            .put("nodePairingKey", identity.pairingKey)
            .put("initialContentPolicy", policy)
            .put("topologySnapshot", TopologyStore.buildDelta(this, reason = "lan_join_accept"))
            .put("node", LanJoinClient.localNodeProfile(this).put("pairingKey", identity.pairingKey))
        return 200 to JSONObject()
            .put("type", "join_accept")
            .put("protocol", "codebridge-lan-discovery")
            .put("version", 1)
            .put("requestId", requestId)
            .put("acceptedNodeId", updatedDevice.id)
            .put("payload", CryptoUtil.encrypt(acceptPayload.toString(), sessionKey))
    }

    private fun broadcastTopologyChange(reason: String) {
        val intent = Intent(this, WebSocketService::class.java).apply {
            action = WebSocketService.ACTION_BROADCAST_TOPOLOGY
            putExtra(WebSocketService.EXTRA_TOPOLOGY_REASON, reason)
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            startForegroundService(intent)
        } else {
            startService(intent)
        }
    }

    private fun handleRelayEnvelope(envelope: JSONObject): Int {
        if (envelope.optString("type") != "codebridge_relay") return 400
        val identity = PhoneIdentityStore.get(this)
        val senderId = envelope.optString("senderId").trim()
        val nonce = envelope.optString("nonce").trim()
        val encryptedPayload = envelope.optString("payload").trim()
        val authToken = envelope.optString("authToken").trim()
        if (senderId.isBlank() || nonce.isBlank() || encryptedPayload.isBlank() || authToken.isBlank()) {
            return 400
        }

        val expected = CryptoUtil.hmacSha256Base64(
            identity.pairingKey,
            "$senderId|$nonce|$encryptedPayload"
        )
        // 常量时间比较，避免逐字节短路泄露 HMAC 前缀匹配长度
        if (!MessageDigest.isEqual(
                expected.toByteArray(Charsets.UTF_8),
                authToken.toByteArray(Charsets.UTF_8)
            )
        ) {
            Log.w(TAG, "Relay auth failed from $senderId")
            return 403
        }

        val plain = CryptoUtil.decrypt(encryptedPayload, identity.pairingKey)
        val payload = JSONObject(plain)

        // nonce 去重：authToken 已过，登记该 (senderId, nonce)。重放帧的 nonce 在
        // 窗口期内重复 → 拒绝。补齐 bus 路径已有的强重放校验，堵住「relaySentAt 缺失
        // 且 originMessageId 滚出 200 条去重表后整包重放」的口子。
        if (isReplayedRelayNonce(senderId, nonce)) {
            Log.w(TAG, "Relay nonce replay from $senderId, dropped")
            return 202
        }

        // 时间窗校验：relaySentAt 在加密负载内（GCM 防篡改），由发送方每跳重新打戳。
        // 旧版发送端没有该字段（=0）时跳过，保持互通
        val sentAt = payload.optLong("relaySentAt", 0L)
        if (sentAt > 0L && kotlin.math.abs(System.currentTimeMillis() - sentAt) > RELAY_REPLAY_WINDOW_MS) {
            Log.w(TAG, "Relay message outside replay window (sentAt=$sentAt), dropped")
            return 202
        }

        val payloadType = payload.optString("type")
        if (!isSupportedPayload(payloadType)) return 202

        val relayMessageId = payload.optString("originMessageId")
            .ifBlank { payload.optString("relayMessageId") }
            .ifBlank { payload.optString("msgId") }
        if (relayMessageId.isBlank()) return 400

        val relayPath = payload.optJSONArray("relayPath") ?: JSONArray()
        if (jsonArrayContains(relayPath, identity.id)) {
            return 202
        }
        // 原子地「查重并登记」：旧实现先查后记两步分离，并发连接下同一消息可能双投
        if (!markRelayMessageSeen(relayMessageId)) {
            return 202
        }
        val targetDeviceIds = payload.optJSONArray("targetDeviceIds")
        val isLocalTarget = targetDeviceIds == null ||
            targetDeviceIds.length() == 0 ||
            jsonArrayContains(targetDeviceIds, identity.id)
        if (!isLocalTarget) {
            Log.d(TAG, "Relay target scope does not include this node; relay only")
        }

        if (isTopologyPayload(payloadType)) {
            val changed = TopologyStore.applyDelta(this, payload)
            if (changed) {
                sendBroadcast(Intent(WebSocketService.TOTP_SYNCED_ACTION))
                WebSocketService.reportExternalStatus(this, "已更新拓扑控制面")
            }
        } else if (isUserMessagePayload(payloadType)) {
            val sourceName = payload.optString("sourceDeviceName", payload.optString("phoneName", "未知设备"))
            if (isLocalTarget && SettingsStore.shouldReceiveContent(this, payloadType)) {
                if (isClipboardTextPayload(payloadType)) {
                    // LWW：仅当版本比已应用版本新且内容不同才写入与提示，
                    // 旧值/重复/回环副本静默丢弃。应用成功后把目标列表改写为
                    // 本机的剪贴板授权邻居（gossip 再扩散），传播范围由
                    // 「源设备直接认识的节点」扩大为授权图的连通分量
                    if (applyRemoteClipboard(payload)) {
                        notifyUserMessageRelay(payload)
                        WebSocketService.reportExternalStatus(this, receivedStatusMessage(payloadType, sourceName))
                        rewriteClipboardGossipTargets(payload)
                    }
                } else if (payloadType == "clipboard_image") {
                    val imageManifest = payload.optJSONObject("fileManifest")
                    if (imageManifest != null && !imageManifest.optBoolean("inline", true)) {
                        // 大图（>inline 上限）：分片拉取后写剪贴板。relay 续传用的是
                        // 拉取前的原始 payload（见下方 ttl 分支），无需 gossip 改写
                        serviceScope.launch {
                            if (pullRemoteClipboardImage(payload)) {
                                notifyUserMessageRelay(payload)
                                WebSocketService.reportExternalStatus(
                                    this@NodeReceiverService,
                                    receivedStatusMessage(payloadType, sourceName)
                                )
                            }
                        }
                    } else if (applyRemoteClipboardImage(payload)) {
                        notifyUserMessageRelay(payload)
                        WebSocketService.reportExternalStatus(this, receivedStatusMessage(payloadType, sourceName))
                        rewriteClipboardImageGossipTargets(payload)
                    }
                } else if (payloadType == "file_transfer" || payloadType == "clipboard_file") {
                    serviceScope.launch {
                        notifyFileTransferRequested(payload)
                        val decision = FileTransferCoordinator.requestApproval(this@NodeReceiverService, payload)
                        if (!decision.accepted) {
                            WebSocketService.reportExternalStatus(
                                this@NodeReceiverService,
                                "已拒绝文件同步：$sourceName"
                            )
                            return@launch
                        }
                        val received = pullIncomingFileTransfer(payload)
                        if (received != null) {
                            notifyFileTransferComplete(received)
                            WebSocketService.reportExternalStatus(
                                this@NodeReceiverService,
                                "已接收文件：${received.name}"
                            )
                        }
                    }
                } else {
                    notifyUserMessageRelay(payload)
                    WebSocketService.reportExternalStatus(this, receivedStatusMessage(payloadType, sourceName))
                }
            } else {
                Log.d(TAG, "本机接收策略已关闭 $payloadType，跳过本机显示但保留中继")
            }
        } else if (isLocalTarget) {
            handleTotpRelayPayload(payload)
        }

        val ttl = payload.optInt("relayTtl", 0)
        if (ttl > 0 && !isTopologyPayload(payloadType)) {
            val relayIntent = Intent(this, WebSocketService::class.java).apply {
                action = WebSocketService.ACTION_RELAY_SMS
                putExtra(WebSocketService.EXTRA_RELAY_PAYLOAD, payload.toString())
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                startForegroundService(relayIntent)
            } else {
                startService(relayIntent)
            }
        }
        return 200
    }

    private fun handleBusEnvelope(transport: JSONObject): Pair<Int, JSONObject> {
        val identity = PhoneIdentityStore.get(this)
        val parsed = ContentBus.parseTransportEnvelope(this, transport) { senderId ->
            if (senderId == identity.id) {
                identity.pairingKey
            } else {
                DeviceStore.findDevice(this, senderId)?.pairingKey
            }
        }
            ?: return 403 to JSONObject()
                .put("type", "bus_ack")
                .put("accepted", false)
                .put("reason", "invalid_bus_envelope")
        val senderId = parsed.first
        val envelope = parsed.second
        val trusted = senderId == identity.id || DeviceStore.findDevice(this, senderId) != null
        if (!trusted) {
            return 403 to JSONObject()
                .put("type", "bus_ack")
                .put("accepted", false)
                .put("reason", "untrusted_sender")
        }

        val legacyPayload = ContentBus.legacyPayloadFromEnvelope(envelope)
        // 转回 relay 信封时补打 relaySentAt（缺失时 handleRelayEnvelope 会跳过重放窗口校验）
        legacyPayload.put("relaySentAt", System.currentTimeMillis())
        val encryptedPayload = CryptoUtil.encrypt(legacyPayload.toString(), identity.pairingKey)
        val nonce = CryptoUtil.generateNonce()
        val relay = JSONObject()
            .put("type", "codebridge_relay")
            .put("version", 1)
            .put("senderId", senderId)
            .put("nonce", nonce)
            .put("payload", encryptedPayload)
            .put("authToken", CryptoUtil.hmacSha256Base64(identity.pairingKey, "$senderId|$nonce|$encryptedPayload"))
        val status = handleRelayEnvelope(relay)
        return status to JSONObject()
            .put("type", "bus_ack")
            .put("accepted", status in 200..299)
            .put("messageId", envelope.optString("messageId"))
    }

    private fun jsonArrayContains(array: JSONArray, value: String): Boolean {
        for (i in 0 until array.length()) {
            if (array.optString(i) == value) return true
        }
        return false
    }

    private fun isSupportedPayload(type: String): Boolean {
        return isUserMessagePayload(type) ||
            type == "totp_seed" ||
            type == "totp_revoke" ||
            isTopologyPayload(type)
    }

    private fun isUserMessagePayload(type: String): Boolean {
        return type == "sms" ||
            type == "sms_message" ||
            type == "app_notification" ||
            isClipboardTextPayload(type) ||
            type == "clipboard_image" ||
            type == "clipboard_file" ||
            type == "file_transfer"
    }

    private fun isClipboardTextPayload(type: String): Boolean =
        type == "clipboard" || type == "clipboard_text"

    private fun isTopologyPayload(type: String): Boolean {
        return type == "topology_delta" ||
            type == "node_advertisement" ||
            type == "link_advertisement"
    }

    private fun handleTotpRelayPayload(payload: JSONObject) {
        when (payload.optString("type")) {
            "totp_seed" -> {
                val secret = payload.optString("secret").takeIf { it.isNotBlank() } ?: return
                val entry = TotpEntry(
                    label = payload.optString("label").ifBlank { "TOTP" },
                    secret = secret,
                    issuer = payload.optString("issuer"),
                    accountName = payload.optString("accountName"),
                    algorithm = payload.optString("algorithm", "SHA1").ifBlank { "SHA1" },
                    digits = payload.optInt("digits", 6),
                    period = payload.optInt("period", 30),
                    sourceDeviceId = payload.optString("sourceDeviceId", payload.optString("phoneId")),
                    sourceDeviceName = payload.optString("sourceDeviceName", payload.optString("phoneName")),
                    sourceDeviceType = payload.optString("sourceDeviceType", "ANDROID_PHONE").ifBlank { "ANDROID_PHONE" },
                    isLocal = false
                ).withStableId()
                TotpStore.add(this, entry)
                sendBroadcast(Intent(WebSocketService.TOTP_SYNCED_ACTION))
                WebSocketService.reportExternalStatus(this, "收到中继 TOTP：${entry.label}")
            }
            "totp_revoke" -> {
                val secret = normalizeSecret(payload.optString("secret"))
                if (secret.isBlank()) return
                val sourceDeviceId = payload.optString("sourceDeviceId", payload.optString("phoneId")).trim()
                val removed = TotpStore.loadAll(this)
                    .filter {
                        normalizeSecret(it.secret) == secret &&
                            !it.isLocal &&
                            (sourceDeviceId.isBlank() || it.sourceDeviceId == sourceDeviceId)
                    }
                removed.forEach { TotpStore.removeById(this, it.id) }
                if (removed.isNotEmpty()) {
                    sendBroadcast(Intent(WebSocketService.TOTP_SYNCED_ACTION))
                    WebSocketService.reportExternalStatus(this, "已同步删除 ${removed.size} 个中继 TOTP")
                }
            }
        }
    }

    private fun normalizeSecret(secret: String?): String {
        return secret.orEmpty().uppercase(Locale.ROOT).replace(Regex("[\\s-]"), "")
    }

    // 去重表常驻内存（LRU 语义，超限淘汰最旧），后台异步落盘。
    // 旧实现每条消息都把整个 200 条 ID 的 JSON 数组从 SharedPreferences
    // 同步整读整写一遍，且查重与记录非原子。
    private val recentRelayIds = LinkedHashSet<String>()
    private var recentIdsLoaded = false

    // senderId -> (nonce -> firstSeenAt)。仅在 authToken 校验通过后登记，
    // 避免攻击者用无效帧刷爆表。窗口期外的 nonce 由时间窗兜底，无需持久化。
    private val recentRelayNonces = HashMap<String, LinkedHashMap<String, Long>>()

    /** 原子地查重并登记 relay nonce，返回 true 表示重放（应拒绝）。 */
    private fun isReplayedRelayNonce(senderId: String, nonce: String): Boolean {
        if (senderId.isBlank() || nonce.isBlank()) return true
        val now = System.currentTimeMillis()
        synchronized(recentRelayNonces) {
            val seen = recentRelayNonces.getOrPut(senderId) {
                object : LinkedHashMap<String, Long>(RELAY_NONCE_LIMIT_PER_SENDER + 1, 0.75f, true) {
                    override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, Long>?): Boolean =
                        size > RELAY_NONCE_LIMIT_PER_SENDER
                }
            }
            val iterator = seen.entries.iterator()
            while (iterator.hasNext()) {
                if (now - iterator.next().value > RELAY_NONCE_TTL_MS) iterator.remove()
            }
            if (seen.containsKey(nonce)) return true
            seen[nonce] = now
        }
        return false
    }

    /** 原子地查重并登记，返回 false 表示该消息已处理过。 */
    private fun markRelayMessageSeen(id: String): Boolean {
        val firstSeen = synchronized(recentRelayIds) {
            ensureRecentIdsLoadedLocked()
            if (!recentRelayIds.add(id)) {
                false
            } else {
                while (recentRelayIds.size > RECENT_IDS_LIMIT) {
                    recentRelayIds.remove(recentRelayIds.first())
                }
                true
            }
        }
        if (firstSeen) persistRecentIdsAsync()
        return firstSeen
    }

    private fun ensureRecentIdsLoadedLocked() {
        if (recentIdsLoaded) return
        val raw = getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            .getString(KEY_RECENT_IDS, "[]")
            .orEmpty()
        runCatching {
            val array = JSONArray(raw)
            for (i in 0 until array.length()) {
                array.optString(i).takeIf { it.isNotBlank() }?.let { recentRelayIds.add(it) }
            }
        }
        recentIdsLoaded = true
    }

    private fun persistRecentIdsAsync() {
        serviceScope.launch {
            val snapshot = synchronized(recentRelayIds) { recentRelayIds.toList() }
            val array = JSONArray()
            snapshot.forEach { array.put(it) }
            getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
                .edit()
                .putString(KEY_RECENT_IDS, array.toString())
                .apply()
        }
    }

    private fun notifyUserMessageRelay(payload: JSONObject) {
        val type = payload.optString("type")
        if (type == "clipboard_text") {
            notifyClipboardTextRelay(payload)
            return
        }
        if (type == "clipboard_image") {
            notifyClipboardImageRelay(payload)
            return
        }
        val code = payload.optString("code")
        val source = payload.optString("source", "短信")
        val sourceName = payload.optString("sourceDeviceName", payload.optString("phoneName", "未知设备"))
        val rawMessage = payload.optString("rawMessage")
        val title = payload.optString("title")
        val appName = payload.optString("appName", source.ifBlank { "通知" })
        val notificationTitle = when (type) {
            "sms" -> "收到中继验证码"
            "sms_message" -> "收到中继短信"
            "app_notification" -> "收到中继通知"
            "clipboard" -> "已同步剪贴板"
            else -> "收到中继消息"
        }
        val notificationText = when (type) {
            "sms" -> "$code · $sourceName"
            "sms_message" -> "$source · $sourceName"
            "app_notification" -> "$appName · $sourceName"
            "clipboard" -> "${rawMessage.take(40)} · $sourceName"
            else -> sourceName
        }
        val bigText = when (type) {
            "sms" -> "验证码: $code\n来源节点: $sourceName\n短信来源: $source\n短信内容: ${rawMessage.ifBlank { source }}"
            "sms_message" -> "来源节点: $sourceName\n短信来源: $source\n短信内容: ${rawMessage.ifBlank { source }}"
            "app_notification" -> "来源节点: $sourceName\n应用: $appName\n标题: ${title.ifBlank { "无标题" }}\n内容: $rawMessage"
            "clipboard" -> "来源节点: $sourceName\n已写入本机剪贴板:\n$rawMessage"
            else -> payload.toString()
        }
        val notification = NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle(notificationTitle)
            .setContentText(notificationText)
            .setStyle(NotificationCompat.BigTextStyle().bigText(bigText))
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setAutoCancel(true)
            .setContentIntent(mainPendingIntent())
            .build()
        val manager = getSystemService(NotificationManager::class.java)
        manager.notify((System.currentTimeMillis() % Int.MAX_VALUE).toInt(), notification)
    }

    private fun notifyClipboardTextRelay(payload: JSONObject) {
        val sourceName = payload.optString("sourceDeviceName", payload.optString("phoneName", "未知设备"))
        val rawMessage = payload.optString("rawMessage")
        val notification = NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle("已同步剪贴板文本")
            .setContentText("${rawMessage.take(40)} · $sourceName")
            .setStyle(NotificationCompat.BigTextStyle().bigText("来源节点: $sourceName\n已写入本机剪贴板:\n$rawMessage"))
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setAutoCancel(true)
            .setContentIntent(mainPendingIntent())
            .build()
        getSystemService(NotificationManager::class.java)
            .notify((System.currentTimeMillis() % Int.MAX_VALUE).toInt(), notification)
    }

    private fun notifyClipboardImageRelay(payload: JSONObject) {
        val sourceName = payload.optString("sourceDeviceName", payload.optString("phoneName", "未知设备"))
        val manifest = payload.optJSONObject("fileManifest")
        val fileName = manifest?.optString("name").orEmpty().ifBlank { payload.optString("label", "clipboard.png") }
        val fileSize = manifest?.optLong("size", 0L) ?: 0L
        val notification = NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle("已同步剪贴板图片")
            .setContentText("$fileName ${formatBytes(fileSize)} · $sourceName")
            .setStyle(NotificationCompat.BigTextStyle().bigText("来源节点: $sourceName\n已写入本机图片剪贴板:\n$fileName (${formatBytes(fileSize)})"))
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setAutoCancel(true)
            .setContentIntent(mainPendingIntent())
            .build()
        getSystemService(NotificationManager::class.java)
            .notify((System.currentTimeMillis() % Int.MAX_VALUE).toInt(), notification)
    }

    private fun notifyFileTransferRequested(payload: JSONObject) {
        val sourceName = payload.optString("sourceDeviceName", payload.optString("phoneName", "未知设备"))
        val manifest = payload.optJSONObject("fileManifest")
        val fileName = manifest?.optString("name").orEmpty().ifBlank { payload.optString("label", "文件") }
        val fileSize = manifest?.optLong("size", 0L) ?: 0L
        val notification = NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle("正在接收文件")
            .setContentText("$fileName ${formatBytes(fileSize)} · $sourceName")
            .setStyle(NotificationCompat.BigTextStyle().bigText("来源节点: $sourceName\n正在拉取并校验文件:\n$fileName (${formatBytes(fileSize)})"))
            .setPriority(NotificationCompat.PRIORITY_DEFAULT)
            .setAutoCancel(true)
            .setContentIntent(mainPendingIntent())
            .build()
        getSystemService(NotificationManager::class.java)
            .notify((System.currentTimeMillis() % Int.MAX_VALUE).toInt(), notification)
    }

    private fun notifyFileTransferComplete(file: ReceivedFile) {
        val openIntent = Intent(Intent.ACTION_VIEW).apply {
            val uri = FileProvider.getUriForFile(
                this@NodeReceiverService,
                "${packageName}.fileprovider",
                file.file
            )
            setDataAndType(uri, file.mime.ifBlank { "application/octet-stream" })
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        val pendingIntent = PendingIntent.getActivity(
            this,
            (System.currentTimeMillis() % Int.MAX_VALUE).toInt(),
            openIntent,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
        val notification = NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle("文件接收完成")
            .setContentText("${file.name} ${formatBytes(file.size)} · ${file.sourceName}")
            .setStyle(NotificationCompat.BigTextStyle().bigText("来源节点: ${file.sourceName}\n保存位置: ${file.file.absolutePath}\n点击打开文件。"))
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setAutoCancel(true)
            .setContentIntent(pendingIntent)
            .build()
        getSystemService(NotificationManager::class.java)
            .notify((System.currentTimeMillis() % Int.MAX_VALUE).toInt(), notification)
    }

    private fun pullIncomingFileTransfer(payload: JSONObject): ReceivedFile? {
        val manifest = payload.optJSONObject("fileManifest") ?: return null
        if (manifest.optBoolean("inline", false)) return null
        val fileId = manifest.optString("fileId").trim()
        if (fileId.isBlank()) return null
        val size = manifest.optLong("size", 0L)
        val source = resolveFileSource(payload, manifest) ?: run {
            Log.w(TAG, "文件拉取失败：找不到源设备")
            return null
        }
        val maxFileSizeMb = (DeviceStore.findDevice(this, source.id)?.maxFileSizeMb ?: 50).coerceIn(1, 512)
        val maxBytes = maxFileSizeMb * 1024L * 1024L
        if (size <= 0L || size > maxBytes) {
            Log.w(TAG, "文件拉取被拒绝：size=$size max=$maxBytes")
            return null
        }
        val identity = PhoneIdentityStore.get(this)
        val transferKey = if (source.type.uppercase(Locale.ROOT).contains("PHONE")) {
            source.pairingKey.ifBlank { identity.pairingKey }
        } else {
            identity.pairingKey
        }
        val chunkSize = manifest.optLong("chunkSize", FILE_TRANSFER_CHUNK_BYTES.toLong())
            .coerceIn(1L, FILE_TRANSFER_CHUNK_BYTES.toLong())
        val name = sanitizeFileName(manifest.optString("name").ifBlank { "file" })
        val mime = manifest.optString("mime", "application/octet-stream").ifBlank { "application/octet-stream" }
        val expectedHash = manifest.optString("sha256").lowercase(Locale.ROOT)
        val downloadsRoot = getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS) ?: filesDir
        // 目录分享：relativePath 重建相对目录（逐段消毒，杜绝路径穿越）
        val dir = relativeSubDir(File(downloadsRoot, "CodeBridge"), manifest.optString("relativePath"))
            .apply { mkdirs() }
        val partFile = File(dir, "$fileId.part")
        val digest = MessageDigest.getInstance("SHA-256")

        // 拉取通道：直连源设备优先，其后是可信节点代理（多跳场景，代理只
        // 转发字节，鉴权与分片加密仍在本机与源设备之间端到端完成）。
        val routes = mutableListOf<Pair<String, String>>() // label to url 前缀（不含 query）
        if (source.host.isNotBlank()) {
            routes.add("direct" to "http://${source.host}:${source.port}/file/${urlEncode(fileId)}")
        }
        DeviceStore.getEnabledDevices(this)
            .filter { it.id != source.id && it.host.isNotBlank() }
            .take(5)
            .forEach { device ->
                routes.add(
                    "proxy:${device.name}" to
                        "http://${device.host}:${LanDiscovery.NODE_RELAY_PORT}/file/proxy/${urlEncode(source.id)}/${urlEncode(fileId)}"
                )
            }
        if (routes.isEmpty()) {
            Log.w(TAG, "文件拉取失败：源不可直达且没有可用代理节点")
            return null
        }
        var routeIndex = 0
        val progressNotificationId = "pull-$fileId".hashCode()
        var lastProgressAt = 0L

        return try {
            FileOutputStream(partFile).use { output ->
                var offset = 0L
                while (offset < size) {
                    val to = minOf(offset + chunkSize - 1, size - 1)
                    var encrypted: ByteArray? = null
                    while (routeIndex < routes.size) {
                        val (label, urlBase) = routes[routeIndex]
                        // nonce 每次请求重新生成：上一通道可能已把 nonce 送达源设备
                        val nonce = CryptoUtil.generateNonce()
                        val authToken = CryptoUtil.hmacSha256Base64(
                            transferKey,
                            "${identity.id}|$nonce|$fileId|$offset-$to"
                        )
                        val query = "from=$offset&to=$to" +
                            "&senderId=${urlEncode(identity.id)}" +
                            "&nonce=${urlEncode(nonce)}" +
                            "&authToken=${urlEncode(authToken)}"
                        val url = if (label == "direct") "$urlBase?$query" else "$urlBase?$query&hop=3"
                        encrypted = runCatching { httpGetBytes(url) }.getOrNull()
                        if (encrypted != null) break
                        Log.w(TAG, "分片通道不可用 $label，切换下一通道")
                        routeIndex += 1
                    }
                    if (encrypted == null) {
                        throw IllegalStateException("分片拉取失败（所有通道均不可达）@$offset")
                    }
                    val plain = CryptoUtil.decryptBytes(encrypted, transferKey)
                    val expectedLen = (to - offset + 1).toInt()
                    if (plain.size != expectedLen) {
                        throw IllegalStateException("chunk length mismatch expected=$expectedLen got=${plain.size}")
                    }
                    output.write(plain)
                    digest.update(plain)
                    offset += plain.size
                    // 进度通知（节流 ≥500ms，末片必发）
                    val now = System.currentTimeMillis()
                    if (now - lastProgressAt >= 500 || offset >= size) {
                        lastProgressAt = now
                        notifyFileTransferProgress(progressNotificationId, name, offset, size)
                    }
                }
            }
            val actualHash = digest.digest().joinToString("") { "%02x".format(it) }
            if (expectedHash.isNotBlank() && !MessageDigest.isEqual(
                    expectedHash.toByteArray(Charsets.UTF_8),
                    actualHash.toByteArray(Charsets.UTF_8)
                )
            ) {
                partFile.delete()
                getSystemService(NotificationManager::class.java).cancel(progressNotificationId)
                Log.w(TAG, "文件 hash 校验失败 expected=${expectedHash.take(12)} actual=${actualHash.take(12)}")
                return null
            }
            val finalFile = uniqueFile(dir, name)
            if (!partFile.renameTo(finalFile)) {
                partFile.copyTo(finalFile, overwrite = true)
                partFile.delete()
            }
            getSystemService(NotificationManager::class.java).cancel(progressNotificationId)
            DeviceStore.markDeviceSynced(this, source.id)
            ReceivedFile(name = finalFile.name, file = finalFile, size = size, mime = mime, sourceName = source.name)
        } catch (e: Exception) {
            runCatching { partFile.delete() }
            getSystemService(NotificationManager::class.java).cancel(progressNotificationId)
            Log.e(TAG, "文件拉取失败: ${e.message}", e)
            null
        }
    }

    /** relativePath 含文件名（最后一段丢弃），其余各段消毒后映射为子目录。 */
    private fun relativeSubDir(baseDir: File, relativePath: String): File {
        var dir = baseDir
        relativePath.split('/', '\\')
            .dropLast(1)
            .filter { it.isNotBlank() }
            .map { sanitizeFileName(it) }
            .filter { it != "." && it != ".." }
            .take(8)
            .forEach { dir = File(dir, it) }
        return dir
    }

    private fun notifyFileTransferProgress(notificationId: Int, name: String, received: Long, total: Long) {
        val percent = if (total > 0) ((received * 100) / total).toInt().coerceIn(0, 100) else 0
        val notification = NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle("正在接收 $name")
            .setContentText("$percent% · ${formatBytes(received)} / ${formatBytes(total)}")
            .setProgress(100, percent, false)
            .setOnlyAlertOnce(true)
            .setOngoing(true)
            .build()
        getSystemService(NotificationManager::class.java).notify(notificationId, notification)
    }

    private fun resolveFileSource(payload: JSONObject, manifest: JSONObject): FileSource? {
        val sourceId = manifest.optString("originDeviceId")
            .ifBlank { payload.optString("originDeviceId") }
            .ifBlank { payload.optString("sourceDeviceId") }
            .ifBlank { payload.optString("phoneId") }
            .trim()
        if (sourceId.isBlank()) return null
        val device = DeviceStore.findDevice(this, sourceId)
        // host 可为空：直连不可达时由 pullIncomingFileTransfer 的代理通道兜底（多跳）
        val host = device?.host.orEmpty()
            .ifBlank { manifest.optString("host") }
            .ifBlank { payload.optString("sourceHost") }
            .trim()
        val port = manifest.optInt(
            "relayPort",
            payload.optInt("relayPort", LanDiscovery.NODE_RELAY_PORT)
        ).takeIf { it > 0 } ?: LanDiscovery.NODE_RELAY_PORT
        val name = device?.name
            ?: manifest.optString("originDeviceName")
                .ifBlank { payload.optString("originDeviceName") }
                .ifBlank { payload.optString("sourceDeviceName", "未知设备") }
        return FileSource(
            id = sourceId,
            name = name,
            host = host,
            port = port,
            type = device?.type ?: payload.optString("sourceDeviceType", "UNKNOWN_DEVICE"),
            pairingKey = device?.pairingKey.orEmpty()
        )
    }

    private fun httpGetBytes(urlText: String): ByteArray {
        val connection = (URL(urlText).openConnection() as HttpURLConnection).apply {
            connectTimeout = FILE_TRANSFER_TIMEOUT_MS
            readTimeout = FILE_TRANSFER_TIMEOUT_MS
            requestMethod = "GET"
            useCaches = false
        }
        return try {
            val status = connection.responseCode
            if (status != HttpURLConnection.HTTP_PARTIAL) {
                throw IllegalStateException("HTTP $status")
            }
            connection.inputStream.use { it.readBytes() }
        } finally {
            connection.disconnect()
        }
    }

    private fun sanitizeFileName(name: String): String {
        val clean = name.substringAfterLast('/').substringAfterLast('\\')
            .replace(Regex("[\\\\/\\x00-\\x1F<>:\"|?*]"), "_")
            .trim()
            .take(180)
        return clean.ifBlank { "file" }
    }

    private fun uniqueFile(dir: File, name: String): File {
        val safe = sanitizeFileName(name)
        var candidate = File(dir, safe)
        if (!candidate.exists()) return candidate
        val dot = safe.lastIndexOf('.')
        val stem = if (dot > 0) safe.substring(0, dot) else safe
        val ext = if (dot > 0) safe.substring(dot) else ""
        for (i in 1..9999) {
            candidate = File(dir, "$stem ($i)$ext")
            if (!candidate.exists()) return candidate
        }
        return File(dir, "$stem-${System.currentTimeMillis()}$ext")
    }

    private fun urlEncode(value: String): String =
        URLEncoder.encode(value, Charsets.UTF_8.name())

    private fun receivedStatusMessage(type: String, sourceName: String): String {
        if (type == "clipboard_text") return "已同步剪贴板文本：$sourceName"
        if (type == "clipboard_image") return "已同步剪贴板图片：$sourceName"
        if (type == "clipboard_file" || type == "file_transfer") return "已接收文件同步请求：$sourceName"
        return when (type) {
            "sms" -> "收到中继验证码：$sourceName"
            "sms_message" -> "收到中继短信：$sourceName"
            "app_notification" -> "收到中继通知：$sourceName"
            "clipboard" -> "已同步剪贴板：$sourceName"
            else -> "收到中继消息：$sourceName"
        }
    }

    /** 把同步来的剪贴板内容写入本机系统剪贴板（写入不受后台限制）。 */
    private fun writeClipboard(text: String) {
        if (text.isBlank()) return
        runCatching {
            val clipboard = getSystemService(Context.CLIPBOARD_SERVICE) as android.content.ClipboardManager
            clipboard.setPrimaryClip(android.content.ClipData.newPlainText("codebridge_clipboard", text))
        }.onFailure {
            Log.w(TAG, "写入剪贴板失败: ${it.message}")
        }
    }

    /**
     * LWW 应用远端剪贴板：仅当版本比已应用版本新、且内容确实不同才写入。
     * 返回 true 表示本机状态前进（调用方据此继续 gossip 扩散）。
     */
    private fun applyRemoteClipboard(payload: JSONObject): Boolean {
        val text = payload.optString("rawMessage")
        if (text.isBlank()) return false
        val version = payload.optJSONObject("clipVersion")
        // 旧版负载无 clipVersion：退化用消息时间戳参与排序，保持互通
        val ts = (version?.optLong("ts", 0L) ?: 0L).takeIf { it > 0L }
            ?: payload.optLong("timestamp", 0L)
        val origin = version?.optString("origin").orEmpty()
            .ifBlank { payload.optString("originDeviceId", payload.optString("sourceDeviceId")) }
        if (ClipboardSyncState.hash(text) == ClipboardSyncState.appliedHash(this)) return false
        if (!ClipboardSyncState.isNewer(this, ts, origin)) {
            Log.d(TAG, "剪贴板 LWW：丢弃过期版本 ts=$ts")
            return false
        }
        writeClipboard(text)
        ClipboardSyncState.remember(this, ts, origin, text)
        return true
    }

    /**
     * gossip 改写：incoming 的目标列表是上一跳的授权集，应用成功后换成本机的
     * 剪贴板授权设备，并刷新 TTL，随后的 ACTION_RELAY_SMS 续传据此把状态扩散给
     * 上一跳不认识的节点。刷新 TTL 是安全的：LWW 保证每个节点对同一版本最多
     * 应用/扩散一次，洪泛必然收敛。
     */
    // 大图剪贴板：LWW 预检 → 分片拉取 → 写剪贴板。与文件传输不同：不弹确认框
    //（已受 shouldReceiveContent 的图片剪贴板开关把关），不留存下载目录，应用后即删。
    private fun pullRemoteClipboardImage(payload: JSONObject): Boolean {
        val manifest = payload.optJSONObject("fileManifest") ?: return false
        if (manifest.optString("mime") != "image/png") return false
        val version = payload.optJSONObject("clipVersion")
        val shortHash = manifest.optString("sha256").take(24)
        val ts = (version?.optLong("ts", 0L) ?: 0L).takeIf { it > 0L }
            ?: payload.optLong("timestamp", 0L)
        val origin = version?.optString("origin").orEmpty()
            .ifBlank { payload.optString("originDeviceId", payload.optString("sourceDeviceId")) }
        if (!isNewerClipboardImageVersion(ts, origin, shortHash)) return false
        val received = pullIncomingFileTransfer(payload) ?: return false
        val bytes = runCatching { received.file.readBytes() }.getOrNull()
        runCatching { received.file.delete() }
        if (bytes == null || bytes.isEmpty()) return false
        if (!writeClipboardImage(bytes, ts, shortHash)) return false
        rememberClipboardImageVersion(ts, origin, shortHash)
        return true
    }

    private fun applyRemoteClipboardImage(payload: JSONObject): Boolean {
        val manifest = payload.optJSONObject("fileManifest") ?: return false
        if (manifest.optString("mime") != "image/png") return false
        if (!manifest.optBoolean("inline", true)) return false
        val dataBase64 = payload.optString("dataBase64")
        if (dataBase64.isBlank()) return false
        val declaredSize = manifest.optLong("size", 0L)
        if (declaredSize <= 0L || declaredSize > MAX_INLINE_CLIPBOARD_IMAGE_BYTES) return false
        val bytes = runCatching { Base64.decode(dataBase64, Base64.DEFAULT) }.getOrNull() ?: return false
        if (bytes.size.toLong() != declaredSize) return false
        val fullHash = sha256Hex(bytes)
        val expectedHash = manifest.optString("sha256")
        if (expectedHash.isNotBlank() && !MessageDigest.isEqual(
                expectedHash.toByteArray(Charsets.UTF_8),
                fullHash.toByteArray(Charsets.UTF_8)
            )
        ) {
            return false
        }
        val version = payload.optJSONObject("clipVersion")
        val shortHash = fullHash.take(24)
        val ts = (version?.optLong("ts", 0L) ?: 0L).takeIf { it > 0L }
            ?: payload.optLong("timestamp", 0L)
        val origin = version?.optString("origin").orEmpty()
            .ifBlank { payload.optString("originDeviceId", payload.optString("sourceDeviceId")) }
        if (!isNewerClipboardImageVersion(ts, origin, shortHash)) return false
        if (!writeClipboardImage(bytes, ts, shortHash)) return false
        rememberClipboardImageVersion(ts, origin, shortHash)
        return true
    }

    private fun writeClipboardImage(bytes: ByteArray, ts: Long, shortHash: String): Boolean {
        return runCatching {
            val dir = File(filesDir, "clipboard_images").apply { mkdirs() }
            val file = File(dir, "clipboard-${ts.takeIf { it > 0L } ?: System.currentTimeMillis()}-$shortHash.png")
            file.writeBytes(bytes)
            val uri: Uri = FileProvider.getUriForFile(
                this,
                "${packageName}.fileprovider",
                file
            )
            val clipboard = getSystemService(Context.CLIPBOARD_SERVICE) as android.content.ClipboardManager
            clipboard.setPrimaryClip(ClipData.newUri(contentResolver, "codebridge_clipboard_image", uri))
            true
        }.onFailure {
            Log.w(TAG, "写入图片剪贴板失败: ${it.message}")
        }.getOrDefault(false)
    }

    private fun isNewerClipboardImageVersion(ts: Long, origin: String, hash: String): Boolean {
        val prefs = getSharedPreferences(IMAGE_STATE_PREFS, Context.MODE_PRIVATE)
        if (hash.isNotBlank() && hash == prefs.getString("hash", "")) return false
        val currentTs = prefs.getLong("ts", 0L)
        val currentOrigin = prefs.getString("origin", "").orEmpty()
        if (ts <= 0L) return true
        if (ts < currentTs) return false
        if (ts == currentTs && origin <= currentOrigin) return false
        return true
    }

    private fun rememberClipboardImageVersion(ts: Long, origin: String, hash: String) {
        getSharedPreferences(IMAGE_STATE_PREFS, Context.MODE_PRIVATE)
            .edit()
            .putLong("ts", ts)
            .putString("origin", origin)
            .putString("hash", hash)
            .apply()
    }

    private fun sha256Hex(bytes: ByteArray): String {
        return MessageDigest.getInstance("SHA-256")
            .digest(bytes)
            .joinToString("") { "%02x".format(it) }
    }

    private fun formatBytes(size: Long): String {
        if (size <= 0L) return "0 B"
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

    // gossip 改写只扩展目标到本机授权邻居，绝不重置 relayTtl：入站 TTL 必须
    // 一路衰减（转发在 enqueueRelayPayload 里 -1），否则网状拓扑下 TTL 安全网失效，
    // 唯一防线退化为去重表，去重表滚动淘汰后旧版本会被重新处理并再次 gossip → 风暴。
    private fun rewriteClipboardGossipTargets(payload: JSONObject) {
        val targets = DeviceStore.getEnabledDevices(this)
            .filter { it.allowClipboard }
            .map { it.id }
        if (targets.isEmpty()) return
        payload.put("targetDeviceIds", JSONArray(targets))
    }

    private fun rewriteClipboardImageGossipTargets(payload: JSONObject) {
        val targets = DeviceStore.getEnabledDevices(this)
            .filter { it.allowClipboardImage || it.allowClipboard }
            .map { it.id }
        if (targets.isEmpty()) return
        payload.put("targetDeviceIds", JSONArray(targets))
    }

    private fun writeHttpResponse(socket: Socket, code: Int) {
        try {
            val text = if (code in 200..299) "OK" else "ERR"
            val status = when (code) {
                200 -> "200 OK"
                202 -> "202 Accepted"
                400 -> "400 Bad Request"
                403 -> "403 Forbidden"
                else -> "500 Internal Server Error"
            }
            val bytes = text.toByteArray(Charsets.UTF_8)
            val response = "HTTP/1.1 $status\r\n" +
                "Content-Type: text/plain; charset=utf-8\r\n" +
                "Content-Length: ${bytes.size}\r\n" +
                "Connection: close\r\n\r\n"
            socket.getOutputStream().write(response.toByteArray(Charsets.UTF_8))
            socket.getOutputStream().write(bytes)
            socket.getOutputStream().flush()
        } catch (e: Exception) {
            Log.w(TAG, "Relay response write skipped: ${e.message}")
        }
    }

    private fun writeJsonHttpResponse(socket: Socket, code: Int, body: JSONObject) {
        try {
            val status = when (code) {
                200 -> "200 OK"
                202 -> "202 Accepted"
                400 -> "400 Bad Request"
                403 -> "403 Forbidden"
                404 -> "404 Not Found"
                409 -> "409 Conflict"
                410 -> "410 Gone"
                416 -> "416 Range Not Satisfiable"
                else -> "500 Internal Server Error"
            }
            val bytes = body.toString().toByteArray(Charsets.UTF_8)
            val response = "HTTP/1.1 $status\r\n" +
                "Content-Type: application/json; charset=utf-8\r\n" +
                "Content-Length: ${bytes.size}\r\n" +
                "Connection: close\r\n\r\n"
            socket.getOutputStream().write(response.toByteArray(Charsets.UTF_8))
            socket.getOutputStream().write(bytes)
            socket.getOutputStream().flush()
        } catch (e: Exception) {
            Log.w(TAG, "JSON response write skipped: ${e.message}")
        }
    }

    private fun writeBinaryHttpResponse(
        socket: Socket,
        code: Int,
        body: ByteArray,
        contentRange: String,
        totalSize: Long
    ) {
        try {
            val status = when (code) {
                206 -> "206 Partial Content"
                200 -> "200 OK"
                else -> "$code OK"
            }
            val response = "HTTP/1.1 $status\r\n" +
                "Content-Type: application/octet-stream\r\n" +
                "Content-Length: ${body.size}\r\n" +
                "Accept-Ranges: bytes\r\n" +
                "Content-Range: $contentRange\r\n" +
                "X-CodeBridge-File-Size: $totalSize\r\n" +
                "Cache-Control: no-store\r\n" +
                "Connection: close\r\n\r\n"
            socket.getOutputStream().write(response.toByteArray(Charsets.UTF_8))
            socket.getOutputStream().write(body)
            socket.getOutputStream().flush()
        } catch (e: Exception) {
            Log.w(TAG, "Binary response write skipped: ${e.message}")
        }
    }

    private fun urlDecode(value: String): String =
        runCatching { URLDecoder.decode(value, Charsets.UTF_8.name()) }.getOrDefault(value)

    private fun buildNotification(): Notification {
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle("节点收件服务")
            .setContentText("正在接收同网段受信节点的消息中继")
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setContentIntent(mainPendingIntent())
            .build()
    }

    private fun mainPendingIntent(): PendingIntent {
        val intent = Intent(this, MainActivity::class.java)
        return PendingIntent.getActivity(
            this,
            0,
            intent,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val channel = NotificationChannel(
            CHANNEL_ID,
            "节点收件服务",
            NotificationManager.IMPORTANCE_LOW
        )
        getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
    }

    override fun onDestroy() {
        running = false
        runCatching { serverSocket?.close() }
        serviceScope.cancel()
        super.onDestroy()
    }
}
