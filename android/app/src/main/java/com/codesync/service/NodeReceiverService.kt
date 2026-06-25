package com.codesync.service

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.ClipData
import android.content.ClipDescription
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
import com.codesync.util.ClipboardHistoryStore
import com.codesync.util.ClipboardSyncState
import com.codesync.util.BusReliabilityStore
import com.codesync.util.ContentBus
import com.codesync.util.CryptoUtil
import com.codesync.util.DeviceStore
import com.codesync.util.FileTransferCoordinator
import com.codesync.util.FileTransferHistoryStore
import com.codesync.util.FileTransferRegistry
import com.codesync.util.FileTransferStateStore
import com.codesync.util.LanDiscovery
import com.codesync.util.LanJoinClient
import com.codesync.util.LanJoinCoordinator
import com.codesync.util.LanJoinCrypto
import com.codesync.util.LanTrustStore
import com.codesync.util.PendingLanJoinRequest
import com.codesync.util.PhoneIdentityStore
import com.codesync.util.RouteManager
import com.codesync.util.SettingsStore
import com.codesync.util.TotpEntry
import com.codesync.util.TotpStore
import com.codesync.util.TopologyStore
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.cancel
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.RandomAccessFile
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.ServerSocket
import java.net.Socket
import java.net.URL
import java.net.URLDecoder
import java.net.URLEncoder
import java.security.MessageDigest
import java.util.Locale
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicInteger

class NodeReceiverService : Service() {
    companion object {
        private const val TAG = "NodeReceiverService"
        private const val NOTIFICATION_ID = 1002
        private const val CHANNEL_ID = "code_sync_node_receiver"
        private const val MAX_BODY_BYTES = 512 * 1024
        private const val MAX_INLINE_CLIPBOARD_IMAGE_BYTES = 768 * 1024
        private const val FILE_TRANSFER_CHUNK_BYTES = 4 * 1024 * 1024
        private const val FILE_TRANSFER_TIMEOUT_MS = 20_000
        private const val FILE_TRANSFER_PARALLEL_PULLS = 4
        private const val FILE_TRANSFER_BLOCK_RETRIES = 3
        private const val CLIPBOARD_TEMP_PREFS = "clipboard_temp_state"
        private const val CLIPBOARD_FILE_TEMP_DIR = "CodeBridgeClipboardFiles"
        private const val CLIPBOARD_IMAGE_TEMP_DIR = "clipboard_images"
        const val ACTION_RETRY_FILE_TRANSFER = "com.codesync.RETRY_FILE_TRANSFER"
        const val EXTRA_FILE_ID = "file_id"
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
        private const val TOPOLOGY_GOSSIP_MIN_INTERVAL_MS = 5_000L
        @Volatile
        private var lastTopologyGossipBroadcastAt = 0L
    }

    private val serviceScope = CoroutineScope(Dispatchers.IO + SupervisorJob())
    @Volatile
    private var running = false
    private var serverSocket: ServerSocket? = null
    private var lanResponderJob: Job? = null
    private val incomingFileTransfers = ConcurrentHashMap.newKeySet<String>()

    private data class FileSource(
        val id: String,
        val name: String,
        val host: String,
        val hosts: List<String>,
        val port: Int,
        val type: String,
        val pairingKey: String
    )

    private data class ReceivedFile(
        val name: String,
        val file: File,
        val size: Long,
        val mime: String,
        val sourceId: String,
        val sourceName: String
    )

    private class FileTransferPausedException : RuntimeException("file_transfer_paused")

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
        if (intent?.action == ACTION_RETRY_FILE_TRANSFER) {
            handleRetryFileTransfer(intent)
        }
        if (!running) {
            running = true
            serviceScope.launch { listenLoop() }
        }
        startLanResponder()
        return START_STICKY
    }

    private fun handleRetryFileTransfer(intent: Intent) {
        val fileId = intent.getStringExtra(EXTRA_FILE_ID).orEmpty()
        val task = FileTransferStateStore.get(this, fileId) ?: return
        if (task.payload.isBlank()) return
        FileTransferStateStore.resume(this, fileId)
        serviceScope.launch {
            val payload = runCatching { JSONObject(task.payload) }.getOrNull() ?: return@launch
            notifyFileTransferRequested(payload)
            val received = pullIncomingFileTransfer(payload)
            if (received != null) {
                notifyFileTransferComplete(received)
                WebSocketService.reportExternalStatus(this@NodeReceiverService, "已接收文件：${received.name}")
            }
        }
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
            authToken = request.query["authToken"],
            chunkEncoding = request.query["chunkEncoding"]
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
        val baseQuery = listOf("from", "to", "senderId", "nonce", "authToken", "chunkEncoding")
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
        val mergeFromNetworkIds = (
            listOf(payload.optString("networkId")) +
                jsonArrayToList(payload.optJSONObject("topologySnapshot")?.optJSONArray("mergeFromNetworkIds")) +
                listOf(payload.optJSONObject("topologySnapshot")?.optString("networkId").orEmpty())
            )
            .map { it.trim() }
            .filter { it.isNotBlank() && it != networkId }
            .distinct()
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
            runCatching {
                TopologyStore.applyDelta(
                    context = this,
                    rawDelta = it,
                    allowNetworkMerge = true,
                    mergeToNetworkId = networkId,
                    mergeFromNetworkIds = mergeFromNetworkIds
                )
            }
        }
        broadcastTopologyChange("lan_join_accept")

        val identity = PhoneIdentityStore.get(this)
        val acceptPayload = JSONObject()
            .put("networkId", networkId)
            .put("mergeFromNetworkIds", JSONArray(mergeFromNetworkIds))
            .put("acceptedByNodeId", identity.id)
            .put("acceptedAt", acceptedAt)
            .put("nodePairingKey", identity.pairingKey)
            .put("initialContentPolicy", policy)
            .put("topologySnapshot", TopologyStore.buildDelta(this, reason = "lan_join_accept", mergeFromNetworkIds = mergeFromNetworkIds))
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
        if (shouldThrottleTopologyGossip(reason)) return
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

    private fun shouldThrottleTopologyGossip(reason: String): Boolean {
        if (reason != "topology_delta_received") return false
        val now = System.currentTimeMillis()
        synchronized(NodeReceiverService::class.java) {
            if (now - lastTopologyGossipBroadcastAt < TOPOLOGY_GOSSIP_MIN_INTERVAL_MS) return true
            lastTopologyGossipBroadcastAt = now
            return false
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
        if (!rememberLegacyBusinessMessage(payload)) {
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
                broadcastTopologyChange("topology_delta_received")
            }
        } else if (isUserMessagePayload(payloadType)) {
            val sourceName = payload.optString("sourceDeviceName", payload.optString("phoneName", "未知设备"))
            if (isLocalTarget && SettingsStore.shouldReceiveContent(this, payloadType)) {
                if (isClipboardTextPayload(payloadType)) {
                    // LWW：仅当版本比已应用版本新且内容不同才写入与提示，
                    // 旧值/重复/回环副本静默丢弃。应用成功后把目标列表改写为
                    // 本机的剪贴板授权邻居（gossip 再扩散），传播范围由
                    // 「源设备直接认识的节点」扩大为授权图的连通分量
                    val textManifest = payload.optJSONObject("fileManifest")
                    if (textManifest != null && !textManifest.optBoolean("inline", true)) {
                        serviceScope.launch {
                            if (pullRemoteClipboardText(payload)) {
                                notifyUserMessageRelay(payload)
                                WebSocketService.reportExternalStatus(
                                    this@NodeReceiverService,
                                    receivedStatusMessage(payloadType, sourceName)
                                )
                                relayClipboardGossipAfterApply(payload, ::rewriteClipboardGossipTargets)
                            }
                        }
                    } else if (applyRemoteClipboard(payload)) {
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
                                relayClipboardGossipAfterApply(payload, ::rewriteClipboardImageGossipTargets)
                            }
                        }
                    } else if (applyRemoteClipboardImage(payload)) {
                        notifyUserMessageRelay(payload)
                        WebSocketService.reportExternalStatus(this, receivedStatusMessage(payloadType, sourceName))
                        rewriteClipboardImageGossipTargets(payload)
                    }
                } else if (payloadType == "clipboard_file") {
                    handleIncomingClipboardFilePayload(payload, sourceName)
                } else if (payloadType == "file_transfer") {
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

        val ttl = payload.optInt("relayTtl", payload.optInt("ttl", 0))
        if (ttl > 0) {
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

    private fun rememberLegacyBusinessMessage(payload: JSONObject): Boolean {
        val envelope = runCatching {
            ContentBus.envelopeFromLegacyPayload(this, payload)
        }.getOrNull() ?: return true
        return BusReliabilityStore.rememberInbound(this, envelope)
    }

    private fun handleDecodedBusPayload(payload: JSONObject, lastHopDeviceId: String): Int {
        val identity = PhoneIdentityStore.get(this)
        if (lastHopDeviceId.isNotBlank() && payload.optString("lastHopDeviceId").isBlank()) {
            payload.put("lastHopDeviceId", lastHopDeviceId)
        }
        val payloadType = payload.optString("type")
        if (!isSupportedPayload(payloadType)) return 202

        val messageId = payload.optString("originMessageId")
            .ifBlank { payload.optString("relayMessageId") }
            .ifBlank { payload.optString("msgId") }
        if (messageId.isBlank()) return 400

        val relayPath = payload.optJSONArray("relayPath") ?: JSONArray()
        if (jsonArrayContains(relayPath, identity.id)) return 202

        val targetDeviceIds = payload.optJSONArray("targetDeviceIds")
        val isLocalTarget = targetDeviceIds == null ||
            targetDeviceIds.length() == 0 ||
            jsonArrayContains(targetDeviceIds, identity.id)
        if (!isLocalTarget) {
            Log.d(TAG, "Bus target scope does not include this node; relay only")
        }

        if (isTopologyPayload(payloadType)) {
            val changed = TopologyStore.applyDelta(this, payload)
            if (changed) {
                sendBroadcast(Intent(WebSocketService.TOTP_SYNCED_ACTION))
                WebSocketService.reportExternalStatus(this, "已更新拓扑控制面")
                broadcastTopologyChange("topology_delta_received")
            }
        } else if (isUserMessagePayload(payloadType)) {
            val sourceName = payload.optString("sourceDeviceName", payload.optString("phoneName", "未知设备"))
            if (isLocalTarget && SettingsStore.shouldReceiveContent(this, payloadType)) {
                if (isClipboardTextPayload(payloadType)) {
                    val textManifest = payload.optJSONObject("fileManifest")
                    if (textManifest != null && !textManifest.optBoolean("inline", true)) {
                        serviceScope.launch {
                            if (pullRemoteClipboardText(payload)) {
                                notifyUserMessageRelay(payload)
                                WebSocketService.reportExternalStatus(
                                    this@NodeReceiverService,
                                    receivedStatusMessage(payloadType, sourceName)
                                )
                                relayClipboardGossipAfterApply(payload, ::rewriteClipboardGossipTargets)
                            }
                        }
                    } else if (applyRemoteClipboard(payload)) {
                        notifyUserMessageRelay(payload)
                        WebSocketService.reportExternalStatus(this, receivedStatusMessage(payloadType, sourceName))
                        rewriteClipboardGossipTargets(payload)
                    }
                } else if (payloadType == "clipboard_image") {
                    val imageManifest = payload.optJSONObject("fileManifest")
                    if (imageManifest != null && !imageManifest.optBoolean("inline", true)) {
                        serviceScope.launch {
                            if (pullRemoteClipboardImage(payload)) {
                                notifyUserMessageRelay(payload)
                                WebSocketService.reportExternalStatus(
                                    this@NodeReceiverService,
                                    receivedStatusMessage(payloadType, sourceName)
                                )
                                relayClipboardGossipAfterApply(payload, ::rewriteClipboardImageGossipTargets)
                            }
                        }
                    } else if (applyRemoteClipboardImage(payload)) {
                        notifyUserMessageRelay(payload)
                        WebSocketService.reportExternalStatus(this, receivedStatusMessage(payloadType, sourceName))
                        rewriteClipboardImageGossipTargets(payload)
                    }
                } else if (payloadType == "clipboard_file") {
                    handleIncomingClipboardFilePayload(payload, sourceName)
                } else if (payloadType == "file_transfer") {
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
                Log.d(TAG, "Local receive policy disabled for $payloadType; relay continues if needed")
            }
        } else if (isLocalTarget) {
            handleTotpRelayPayload(payload)
        }

        val ttl = payload.optInt("relayTtl", payload.optInt("ttl", 0))
        if (ttl > 0) {
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
        val status = if (BusReliabilityStore.rememberInbound(this, envelope)) {
            handleDecodedBusPayload(legacyPayload, senderId)
        } else {
            202
        }
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

    private fun jsonArrayToList(array: JSONArray?): List<String> {
        if (array == null) return emptyList()
        return (0 until array.length()).mapNotNull {
            array.optString(it).trim().takeIf { value -> value.isNotBlank() }
        }
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
        if (
            type == "clipboard" ||
            type == "clipboard_text" ||
            type == "clipboard_image" ||
            type == "clipboard_file"
        ) {
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

    private fun handleIncomingClipboardFilePayload(payload: JSONObject, sourceName: String) {
        serviceScope.launch {
            val manifest = payload.optJSONObject("fileManifest") ?: return@launch
            val version = clipboardVersionFromPayload(payload, manifest, "file")
            val versionKey = clipboardFileVersionKey(payload, manifest)
            if (!isCurrentClipboardTempKey("clipboard_file_key", versionKey) &&
                !isIncomingClipboardVersionNewer(version)
            ) {
                return@launch
            }
            prepareClipboardTempDirectory("clipboard_file_key", clipboardFileTempRoot(), versionKey)
            clearClipboardImageTempFiles()
            val received = pullIncomingFileTransfer(
                payload = payload,
                saveToHistory = false,
                subDirectoryName = CLIPBOARD_FILE_TEMP_DIR
            )
            if (received != null && !isCurrentClipboardTempKey("clipboard_file_key", versionKey)) {
                runCatching { received.file.delete() }
                return@launch
            }
            if (received != null && writeClipboardFilesFromTempRoot()) {
                ClipboardSyncState.rememberHash(
                    this@NodeReceiverService,
                    version.ts,
                    version.origin,
                    version.hash,
                    version.kind
                )
                ClipboardHistoryStore.addFile(
                    context = this@NodeReceiverService,
                    kind = "file",
                    direction = "incoming",
                    title = received.name,
                    path = received.file.absolutePath,
                    mime = received.mime,
                    size = received.size,
                    sourceDeviceId = received.sourceId,
                    sourceDeviceName = received.sourceName
                )
                relayClipboardGossipAfterApply(payload, ::rewriteClipboardFileGossipTargets)
                WebSocketService.reportExternalStatus(
                    this@NodeReceiverService,
                    "已同步剪贴板文件：${received.name} · $sourceName"
                )
            }
        }
    }

    private data class ClipboardVersion(
        val ts: Long,
        val origin: String,
        val hash: String,
        val kind: String
    )

    private fun clipboardVersionFromPayload(
        payload: JSONObject,
        manifest: JSONObject,
        kind: String
    ): ClipboardVersion {
        val version = payload.optJSONObject("clipVersion")
        val ts = (version?.optLong("ts", 0L) ?: 0L).takeIf { it > 0L }
            ?: payload.optLong("timestamp", 0L)
        val origin = version?.optString("origin").orEmpty()
            .ifBlank { payload.optString("originDeviceId", payload.optString("sourceDeviceId")) }
        val hash = version?.optString("hash").orEmpty()
            .ifBlank { version?.optString("signature").orEmpty() }
            .ifBlank { manifest.optString("sha256").take(24) }
        return ClipboardVersion(ts, origin, hash, kind)
    }

    private fun isIncomingClipboardVersionNewer(version: ClipboardVersion): Boolean {
        if (version.hash.isNotBlank() && version.hash == ClipboardSyncState.appliedHash(this)) return false
        return ClipboardSyncState.isNewer(this, version.ts, version.origin)
    }

    private fun clipboardFileVersionKey(payload: JSONObject, manifest: JSONObject): String {
        val version = payload.optJSONObject("clipVersion")
        val versionTs = version?.optLong("ts", 0L) ?: 0L
        val versionOrigin = version?.optString("origin").orEmpty()
        val versionHash = version?.optString("hash").orEmpty()
            .ifBlank { version?.optString("signature").orEmpty() }
        if (versionTs > 0L && versionOrigin.isNotBlank()) {
            return listOf(versionTs.toString(), versionOrigin, versionHash).joinToString("|")
        }
        return payload.optString("clipboardBatchId")
            .ifBlank { payload.optString("batchId") }
            .ifBlank { manifest.optString("fileId") }
            .ifBlank { System.currentTimeMillis().toString() }
    }

    private fun prepareClipboardTempDirectory(prefKey: String, dir: File, versionKey: String) {
        val prefs = getSharedPreferences(CLIPBOARD_TEMP_PREFS, Context.MODE_PRIVATE)
        val previousKey = prefs.getString(prefKey, "").orEmpty()
        if (previousKey != versionKey) {
            runCatching { dir.deleteRecursively() }
            prefs.edit().putString(prefKey, versionKey).apply()
        }
        dir.mkdirs()
    }

    private fun isCurrentClipboardTempKey(prefKey: String, versionKey: String): Boolean =
        getSharedPreferences(CLIPBOARD_TEMP_PREFS, Context.MODE_PRIVATE)
            .getString(prefKey, "")
            .orEmpty() == versionKey

    private fun clipboardFileTempRoot(): File {
        val downloadsRoot = getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS) ?: filesDir
        return File(downloadsRoot, CLIPBOARD_FILE_TEMP_DIR)
    }

    private fun clearClipboardFileTempFiles() {
        runCatching { clipboardFileTempRoot().deleteRecursively() }
        getSharedPreferences(CLIPBOARD_TEMP_PREFS, Context.MODE_PRIVATE)
            .edit()
            .remove("clipboard_file_key")
            .apply()
    }

    private fun clearClipboardImageTempFiles() {
        runCatching { File(filesDir, CLIPBOARD_IMAGE_TEMP_DIR).deleteRecursively() }
        getSharedPreferences(CLIPBOARD_TEMP_PREFS, Context.MODE_PRIVATE)
            .edit()
            .remove("clipboard_image_key")
            .apply()
    }

    private fun currentClipboardTempFiles(): List<File> =
        clipboardFileTempRoot()
            .walkTopDown()
            .filter { file ->
                file.isFile &&
                    !file.name.endsWith(".part", ignoreCase = true) &&
                    !file.name.endsWith(".json", ignoreCase = true)
            }
            .sortedBy { it.absolutePath }
            .toList()

    private fun writeClipboardFilesFromTempRoot(): Boolean {
        val files = currentClipboardTempFiles()
        if (files.isEmpty()) return false
        return runCatching {
            val clipboard = getSystemService(Context.CLIPBOARD_SERVICE) as android.content.ClipboardManager
            val firstUri = FileProvider.getUriForFile(this, "${packageName}.fileprovider", files.first())
            val clip = ClipData.newUri(contentResolver, "codebridge_clipboard_files", firstUri)
            files.drop(1).forEach { file ->
                val uri = FileProvider.getUriForFile(this, "${packageName}.fileprovider", file)
                clip.addItem(ClipData.Item(uri))
            }
            clipboard.setPrimaryClip(clip)
            true
        }.onFailure {
            Log.w(TAG, "写入文件剪贴板失败: ${it.message}")
        }.getOrDefault(false)
    }

    private suspend fun pullIncomingFileTransfer(
        payload: JSONObject,
        saveToHistory: Boolean = true,
        subDirectoryName: String = "CodeBridge"
    ): ReceivedFile? {
        val manifest = payload.optJSONObject("fileManifest") ?: return null
        if (manifest.optBoolean("inline", false)) return null
        val fileId = manifest.optString("fileId").trim()
        if (fileId.isBlank()) return null
        if (!incomingFileTransfers.add(fileId)) {
            Log.d(TAG, "Skip duplicate in-flight file transfer: $fileId")
            return null
        }
        return try {
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
        val usePlainChunks = jsonArrayToList(manifest.optJSONArray("chunkEncodings")).contains("none")
        val name = sanitizeFileName(manifest.optString("name").ifBlank { "file" })
        val mime = manifest.optString("mime", "application/octet-stream").ifBlank { "application/octet-stream" }
        val expectedHash = manifest.optString("sha256").lowercase(Locale.ROOT)
        val downloadsRoot = getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS) ?: filesDir
        val receiveSubdir = if (saveToHistory && subDirectoryName == "CodeBridge") {
            SettingsStore.getFileReceiveSubdirOrDefault(this, subDirectoryName)
        } else {
            subDirectoryName
        }
        // 目录分享：relativePath 重建相对目录（逐段消毒，杜绝路径穿越）
        val dir = relativeSubDir(File(downloadsRoot, receiveSubdir), manifest.optString("relativePath"))
            .apply { mkdirs() }
        val partFile = File(dir, "$fileId.part")
        val sidecarFile = File(dir, "$fileId.part.json")
        val blocks = buildTransferBlocks(size, chunkSize)
        val completedBlocks = loadTransferSidecar(sidecarFile, manifest, size, chunkSize)
        if (!partFile.isFile) completedBlocks.clear()

        // 拉取通道：直连源设备优先，其后是可信节点代理（多跳场景，代理只
        // 转发字节，鉴权与分片加密仍在本机与源设备之间端到端完成）。
        val routes = mutableListOf<Pair<String, String>>() // label to url 前缀（不含 query）
        val sourceHosts = source.hosts.ifEmpty {
            listOf(source.host).filter { it.isNotBlank() }
        }
        for (host in sourceHosts) {
            routes.add("direct:$host" to "http://$host:${source.port}/file/${urlEncode(fileId)}")
        }
        DeviceStore.getEnabledDevices(this)
            .filter { it.id != source.id }
            .take(5)
            .forEach { device ->
                (listOf(device.host) + device.altHosts)
                    .filter { it.isNotBlank() }
                    .distinct()
                    .forEach { host ->
                        routes.add(
                            "proxy:${device.name}@$host" to
                                "http://$host:${LanDiscovery.NODE_RELAY_PORT}/file/proxy/${urlEncode(source.id)}/${urlEncode(fileId)}"
                        )
                    }
            }
        if (routes.isEmpty()) {
            Log.w(TAG, "文件拉取失败：源不可直达且没有可用代理节点")
            return null
        }
        val blockHashes = jsonArrayToList(manifest.optJSONArray("blockHashes"))
            .map { it.lowercase(Locale.ROOT) }
        val routeFailures = java.util.concurrent.ConcurrentHashMap<String, Int>()
        fun orderedRoutes(): List<Pair<String, String>> =
            routes.sortedWith(
                compareBy<Pair<String, String>> { routeFailures[it.first] ?: 0 }
                    .thenBy { if (it.first.startsWith("direct")) 0 else 1 }
            )
        fun markRouteSuccess(label: String) {
            routeFailures[label] = 0
        }
        fun markRouteFailure(label: String) {
            routeFailures[label] = (routeFailures[label] ?: 0) + 1
        }
        val progressNotificationId = "pull-$fileId".hashCode()
        var lastProgressAt = 0L

        fun fetchPlainBlock(block: TransferBlock): ByteArray {
            var lastError = "unknown"
            repeat(FILE_TRANSFER_BLOCK_RETRIES) { attempt ->
                if (FileTransferStateStore.isPaused(this, fileId)) {
                    throw FileTransferPausedException()
                }
                for ((label, urlBase) in orderedRoutes()) {
                    if (FileTransferStateStore.isPaused(this, fileId)) {
                        throw FileTransferPausedException()
                    }
                    val nonce = CryptoUtil.generateNonce()
                    val authToken = CryptoUtil.hmacSha256Base64(
                        transferKey,
                        "${identity.id}|$nonce|$fileId|${block.from}-${block.to}"
                    )
                    val encodingQuery = if (usePlainChunks) "&chunkEncoding=none" else ""
                    val query = "from=${block.from}&to=${block.to}" +
                        "&senderId=${urlEncode(identity.id)}" +
                        "&nonce=${urlEncode(nonce)}" +
                        "&authToken=${urlEncode(authToken)}" +
                        encodingQuery
                    val url = if (label.startsWith("direct")) "$urlBase?$query" else "$urlBase?$query&hop=3"
                    val encrypted = runCatching { httpGetBytes(url) }
                        .onFailure {
                            lastError = "$label:${it.message ?: it.javaClass.simpleName}"
                            markRouteFailure(label)
                        }
                        .getOrNull()
                        ?: continue
                    val plain = if (usePlainChunks) {
                        encrypted
                    } else {
                        runCatching { CryptoUtil.decryptBytes(encrypted, transferKey) }
                            .onFailure {
                                lastError = "$label:decrypt_failed"
                                markRouteFailure(label)
                            }
                            .getOrNull()
                            ?: continue
                    }
                    val expectedLen = block.length.toInt()
                    if (plain.size != expectedLen) {
                        lastError = "$label:chunk_length_mismatch expected=$expectedLen got=${plain.size}"
                        markRouteFailure(label)
                        continue
                    }
                    val expectedBlockHash = blockHashes.getOrNull(block.index).orEmpty()
                    if (expectedBlockHash.isNotBlank() && !MessageDigest.isEqual(
                            expectedBlockHash.toByteArray(Charsets.UTF_8),
                            sha256Hex(plain).toByteArray(Charsets.UTF_8)
                        )
                    ) {
                        lastError = "$label:chunk_hash_mismatch index=${block.index}"
                        markRouteFailure(label)
                        continue
                    }
                    markRouteSuccess(label)
                    return plain
                }
                if (attempt < FILE_TRANSFER_BLOCK_RETRIES - 1) {
                    Thread.sleep((250L * (attempt + 1)).coerceAtMost(1_000L))
                }
            }
            throw IllegalStateException("block ${block.index} failed after $FILE_TRANSFER_BLOCK_RETRIES retries: $lastError")
        }

        try {
            RandomAccessFile(partFile, "rw").use { output ->
                output.setLength(size)
                saveTransferSidecar(sidecarFile, manifest, size, chunkSize, completedBlocks)
                val receivedBefore = completedBlockBytes(blocks, completedBlocks)
                FileTransferStateStore.startOrUpdate(this, payload, receivedBefore, size, partFile.absolutePath)
                if (FileTransferStateStore.isPaused(this, fileId)) {
                    throw FileTransferPausedException()
                }

                val pendingBlocks = blocks.filter { it.index !in completedBlocks }
                val nextBlock = AtomicInteger(0)
                val stateLock = Any()
                val parallelism = manifest.optInt("parallelPulls", FILE_TRANSFER_PARALLEL_PULLS)
                    .coerceIn(1, FILE_TRANSFER_PARALLEL_PULLS)
                if (pendingBlocks.isNotEmpty()) {
                    coroutineScope {
                        (0 until minOf(parallelism, pendingBlocks.size)).map {
                            async(Dispatchers.IO) {
                                while (true) {
                                    val block = pendingBlocks.getOrNull(nextBlock.getAndIncrement()) ?: break
                                    if (FileTransferStateStore.isPaused(this@NodeReceiverService, fileId)) {
                                        throw FileTransferPausedException()
                                    }
                                    val plain = fetchPlainBlock(block)
                                    if (FileTransferStateStore.isPaused(this@NodeReceiverService, fileId)) {
                                        throw FileTransferPausedException()
                                    }
                                    synchronized(stateLock) {
                                        if (block.index !in completedBlocks) {
                                            output.seek(block.from)
                                            output.write(plain)
                                            completedBlocks.add(block.index)
                                            saveTransferSidecar(sidecarFile, manifest, size, chunkSize, completedBlocks)
                                            val now = System.currentTimeMillis()
                                            val receivedBytes = completedBlockBytes(blocks, completedBlocks)
                                            FileTransferStateStore.updateProgress(
                                                this@NodeReceiverService,
                                                fileId,
                                                receivedBytes,
                                                size
                                            )
                                            if (now - lastProgressAt >= 500 || receivedBytes >= size) {
                                                lastProgressAt = now
                                                notifyFileTransferProgress(progressNotificationId, name, receivedBytes, size)
                                            }
                                        }
                                    }
                                }
                            }
                        }.awaitAll()
                    }
                }
            }
            if (completedBlocks.size != blocks.size) {
                throw IllegalStateException("incomplete transfer blocks=${completedBlocks.size}/${blocks.size}")
            }
            val actualHash = sha256File(partFile)
            if (expectedHash.isNotBlank() && !MessageDigest.isEqual(
                    expectedHash.toByteArray(Charsets.UTF_8),
                    actualHash.toByteArray(Charsets.UTF_8)
                )
            ) {
                partFile.delete()
                sidecarFile.delete()
                FileTransferStateStore.markFailed(this, fileId, "hash_mismatch")
                getSystemService(NotificationManager::class.java).cancel(progressNotificationId)
                Log.w(TAG, "文件 hash 校验失败 expected=${expectedHash.take(12)} actual=${actualHash.take(12)}")
                return null
            }
            val finalFile = uniqueFile(dir, name)
            sidecarFile.delete()
            if (!partFile.renameTo(finalFile)) {
                partFile.copyTo(finalFile, overwrite = true)
                partFile.delete()
            }
            getSystemService(NotificationManager::class.java).cancel(progressNotificationId)
            DeviceStore.markDeviceSynced(this, source.id)
            if (saveToHistory) {
                FileTransferHistoryStore.addReceived(
                    context = this,
                    fileId = fileId,
                    name = finalFile.name,
                    path = finalFile.absolutePath,
                    size = size,
                    mime = mime,
                    sourceDeviceId = source.id,
                    sourceDeviceName = source.name
                )
            }
            FileTransferStateStore.markCompleted(this, fileId, finalFile.absolutePath)
            ReceivedFile(
                name = finalFile.name,
                file = finalFile,
                size = size,
                mime = mime,
                sourceId = source.id,
                sourceName = source.name
            )
        } catch (e: FileTransferPausedException) {
            FileTransferStateStore.pause(this, fileId)
            getSystemService(NotificationManager::class.java).cancel(progressNotificationId)
            Log.i(TAG, "File transfer paused: $fileId")
            null
        } catch (e: Exception) {
            FileTransferStateStore.markFailed(this, fileId, e.message ?: e.javaClass.simpleName)
            getSystemService(NotificationManager::class.java).cancel(progressNotificationId)
            Log.e(TAG, "文件拉取失败: ${e.message}", e)
            null
        }
        } finally {
            incomingFileTransfers.remove(fileId)
        }
    }

    /** relativePath 含文件名（最后一段丢弃），其余各段消毒后映射为子目录。 */
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
        val hosts = (listOf(host) +
            (device?.altHosts ?: emptyList()) +
            jsonArrayToList(manifest.optJSONArray("altHosts")) +
            jsonArrayToList(payload.optJSONArray("sourceAltHosts")) +
            listOf(manifest.optString("tsHost"), payload.optString("sourceTsHost")))
            .map { it.trim() }
            .filter { it.isNotBlank() }
            .distinct()
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
            hosts = hosts,
            port = port,
            type = device?.type ?: payload.optString("sourceDeviceType", "UNKNOWN_DEVICE"),
            pairingKey = device?.pairingKey.orEmpty()
        )
    }

    private fun writeClipboard(text: String) {
        if (text.isBlank()) return
        runCatching {
            clearClipboardFileTempFiles()
            clearClipboardImageTempFiles()
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
    private fun applyRemoteClipboard(payload: JSONObject, overrideText: String? = null): Boolean {
        val text = overrideText ?: payload.optString("rawMessage")
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
        ClipboardHistoryStore.addText(
            context = this,
            text = text,
            direction = "incoming",
            sourceDeviceId = origin,
            sourceDeviceName = payload.optString("originDeviceName")
                .ifBlank { payload.optString("sourceDeviceName") }
                .ifBlank { origin.ifBlank { "未知设备" } },
            createdAt = ts
        )
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
    private fun normalizeClipboardImageMime(mime: String): String {
        val value = mime.lowercase(Locale.ROOT)
        return when (value) {
            "image/jpeg", "image/jpg" -> "image/jpeg"
            "image/png" -> "image/png"
            else -> ""
        }
    }

    private fun clipboardImageExtension(mime: String): String =
        if (normalizeClipboardImageMime(mime) == "image/jpeg") "jpg" else "png"

    private suspend fun pullRemoteClipboardImage(payload: JSONObject): Boolean {
        val manifest = payload.optJSONObject("fileManifest") ?: return false
        val mime = normalizeClipboardImageMime(manifest.optString("mime"))
        if (mime.isBlank()) return false
        val version = payload.optJSONObject("clipVersion")
        val shortHash = manifest.optString("sha256").take(24)
        val ts = (version?.optLong("ts", 0L) ?: 0L).takeIf { it > 0L }
            ?: payload.optLong("timestamp", 0L)
        val origin = version?.optString("origin").orEmpty()
            .ifBlank { payload.optString("originDeviceId", payload.optString("sourceDeviceId")) }
        if (!isNewerClipboardImageVersion(ts, origin, shortHash)) return false
        val received = pullIncomingFileTransfer(
            payload,
            saveToHistory = false,
            subDirectoryName = "CodeBridgeClipboard"
        ) ?: return false
        val bytes = runCatching { received.file.readBytes() }.getOrNull()
        runCatching { received.file.delete() }
        if (bytes == null || bytes.isEmpty()) return false
        if (!isNewerClipboardImageVersion(ts, origin, shortHash)) return false
        val clipboardFile = writeClipboardImage(bytes, ts, shortHash, mime) ?: return false
        rememberClipboardImageVersion(ts, origin, shortHash)
        rememberClipboardImageHistory(payload, clipboardFile, bytes.size.toLong(), ts, origin)
        return true
    }

    private suspend fun pullRemoteClipboardText(payload: JSONObject): Boolean {
        val manifest = payload.optJSONObject("fileManifest") ?: return false
        val mime = manifest.optString("mime").lowercase(Locale.ROOT)
        if (
            mime.isNotBlank() &&
            !mime.startsWith("text/plain") &&
            !mime.startsWith("text/markdown") &&
            mime != "application/octet-stream"
        ) {
            return false
        }
        val version = payload.optJSONObject("clipVersion")
        val shortHash = version?.optString("hash").orEmpty()
            .ifBlank { manifest.optString("sha256").take(24) }
        val ts = (version?.optLong("ts", 0L) ?: 0L).takeIf { it > 0L }
            ?: payload.optLong("timestamp", 0L)
        val origin = version?.optString("origin").orEmpty()
            .ifBlank { payload.optString("originDeviceId", payload.optString("sourceDeviceId")) }
        if (shortHash.isNotBlank() && shortHash == ClipboardSyncState.appliedHash(this)) return false
        if (!ClipboardSyncState.isNewer(this, ts, origin)) return false
        val received = pullIncomingFileTransfer(
            payload,
            saveToHistory = false,
            subDirectoryName = "CodeBridgeClipboard"
        ) ?: return false
        val text = runCatching { received.file.readText(Charsets.UTF_8) }.getOrNull()
        runCatching { received.file.delete() }
        if (text.isNullOrEmpty()) return false
        if (shortHash.isNotBlank() && ClipboardSyncState.hash(text) != shortHash) return false
        return applyRemoteClipboard(payload, text)
    }

    private fun applyRemoteClipboardImage(payload: JSONObject): Boolean {
        val manifest = payload.optJSONObject("fileManifest") ?: return false
        val mime = normalizeClipboardImageMime(manifest.optString("mime"))
        if (mime.isBlank()) return false
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
        val clipboardFile = writeClipboardImage(bytes, ts, shortHash, mime) ?: return false
        rememberClipboardImageVersion(ts, origin, shortHash)
        rememberClipboardImageHistory(payload, clipboardFile, bytes.size.toLong(), ts, origin)
        return true
    }

    private fun writeClipboardImage(bytes: ByteArray, ts: Long, shortHash: String, mime: String): File? {
        return runCatching {
            clearClipboardFileTempFiles()
            val dir = File(filesDir, CLIPBOARD_IMAGE_TEMP_DIR)
            prepareClipboardTempDirectory(
                "clipboard_image_key",
                dir,
                "${ts.takeIf { it > 0L } ?: System.currentTimeMillis()}|$shortHash"
            )
            val normalizedMime = normalizeClipboardImageMime(mime).ifBlank { "image/png" }
            val file = File(
                dir,
                "clipboard-${ts.takeIf { it > 0L } ?: System.currentTimeMillis()}-$shortHash.${clipboardImageExtension(normalizedMime)}"
            )
            file.writeBytes(bytes)
            val uri: Uri = FileProvider.getUriForFile(
                this,
                "${packageName}.fileprovider",
                file
            )
            val clipboard = getSystemService(Context.CLIPBOARD_SERVICE) as android.content.ClipboardManager
            val clip = ClipData(
                ClipDescription("codebridge_clipboard_image", arrayOf(normalizedMime)),
                ClipData.Item(uri)
            )
            clipboard.setPrimaryClip(clip)
            file
        }.onFailure {
            Log.w(TAG, "写入图片剪贴板失败: ${it.message}")
        }.getOrNull()
    }

    private fun rememberClipboardImageHistory(
        payload: JSONObject,
        file: File,
        size: Long,
        ts: Long,
        origin: String
    ) {
        ClipboardHistoryStore.addFile(
            context = this,
            kind = "image",
            direction = "incoming",
            title = payload.optJSONObject("fileManifest")?.optString("name").orEmpty()
                .ifBlank { "剪贴板图片" },
            path = file.absolutePath,
            mime = normalizeClipboardImageMime(payload.optJSONObject("fileManifest")?.optString("mime").orEmpty())
                .ifBlank { "image/png" },
            size = size,
            sourceDeviceId = origin,
            sourceDeviceName = payload.optString("originDeviceName")
                .ifBlank { payload.optString("sourceDeviceName") }
                .ifBlank { origin.ifBlank { "未知设备" } },
            createdAt = ts.takeIf { it > 0L } ?: System.currentTimeMillis()
        )
    }

    private fun isNewerClipboardImageVersion(ts: Long, origin: String, hash: String): Boolean {
        val prefs = getSharedPreferences(IMAGE_STATE_PREFS, Context.MODE_PRIVATE)
        if (hash.isNotBlank() && hash == ClipboardSyncState.appliedHash(this)) return false
        if (!ClipboardSyncState.isNewer(this, ts, origin)) return false
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
        ClipboardSyncState.rememberHash(this, ts, origin, hash, "image")
    }

    private fun rewriteClipboardGossipTargets(payload: JSONObject) {
        val targets = RouteManager.targetsForType(
            context = this,
            type = "clipboard_text",
            respectLocalSendSettings = false
        )
            .map { it.device.id }
        if (targets.isEmpty()) return
        payload.put("targetDeviceIds", JSONArray(targets))
    }

    private fun rewriteClipboardImageGossipTargets(payload: JSONObject) {
        val targets = RouteManager.targetsForType(
            context = this,
            type = "clipboard_image",
            respectLocalSendSettings = false
        )
            .map { it.device.id }
        if (targets.isEmpty()) return
        payload.put("targetDeviceIds", JSONArray(targets))
    }

    private fun rewriteClipboardFileGossipTargets(payload: JSONObject) {
        val targets = RouteManager.targetsForType(
            context = this,
            type = "clipboard_file",
            respectLocalSendSettings = false
        )
            .map { it.device.id }
        if (targets.isEmpty()) return
        payload.put("targetDeviceIds", JSONArray(targets))
    }

    private fun relayClipboardGossipAfterApply(
        payload: JSONObject,
        rewriteTargets: (JSONObject) -> Unit
    ) {
        val ttl = payload.optInt("relayTtl", payload.optInt("ttl", 0))
        if (ttl <= 0) return
        val nextPayload = JSONObject(payload.toString())
        rewriteTargets(nextPayload)
        val targets = nextPayload.optJSONArray("targetDeviceIds")
        if (targets == null || targets.length() == 0) return
        val relayIntent = Intent(this, WebSocketService::class.java).apply {
            action = WebSocketService.ACTION_RELAY_SMS
            putExtra(WebSocketService.EXTRA_RELAY_PAYLOAD, nextPayload.toString())
        }
        runCatching {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                startForegroundService(relayIntent)
            } else {
                startService(relayIntent)
            }
        }.onFailure {
            Log.w(TAG, "Clipboard gossip relay start skipped: ${it.message}")
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
