package com.codesync.service

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.IBinder
import android.util.Log
import androidx.core.app.NotificationCompat
import com.codesync.MainActivity
import com.codesync.R
import com.codesync.util.CryptoUtil
import com.codesync.util.LanDiscovery
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
import java.io.InputStream
import java.net.ServerSocket
import java.net.Socket
import java.security.MessageDigest
import java.util.Locale

class NodeReceiverService : Service() {
    companion object {
        private const val TAG = "NodeReceiverService"
        private const val NOTIFICATION_ID = 1002
        private const val CHANNEL_ID = "code_sync_node_receiver"
        private const val MAX_BODY_BYTES = 64 * 1024
        private const val RECENT_IDS_LIMIT = 200
        private const val PREFS_NAME = "node_relay_dedup"
        private const val KEY_RECENT_IDS = "recent_ids"
        // 中继消息时间窗：超出视为重放（去重表只有 200 条，旧消息滚出后可被整包重放）。
        // 容差要覆盖多跳转发延迟与节点间时钟偏差；TOTP 本身要求时钟同步，±5 分钟足够
        private const val RELAY_REPLAY_WINDOW_MS = 5 * 60 * 1000L
    }

    private val serviceScope = CoroutineScope(Dispatchers.IO + SupervisorJob())
    @Volatile
    private var running = false
    private var serverSocket: ServerSocket? = null
    private var lanResponderJob: Job? = null

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

    private fun handleClient(socket: Socket) {
        socket.use {
            val responseCode = try {
                val body = readHttpBody(socket)
                if (body.isBlank()) {
                    400
                } else {
                    handleRelayEnvelope(JSONObject(body))
                }
            } catch (e: Exception) {
                Log.e(TAG, "Relay request failed", e)
                400
            }
            writeHttpResponse(socket, responseCode)
        }
    }

    // Content-Length 是字节数，必须按字节读取后再整体解码 UTF-8。
    // 之前用 BufferedReader 读「contentLength 个字符」，含中文的 payload（每字 3 字节）
    // 会试图读超出实际内容的字符数，阻塞到对端超时，导致中文短信中继失败。
    private fun readHttpBody(socket: Socket): String {
        val input = socket.getInputStream().buffered()
        val requestLine = readHeaderLine(input).orEmpty()
        if (!requestLine.uppercase(Locale.US).startsWith("POST ")) return ""

        var contentLength = 0
        while (true) {
            val line = readHeaderLine(input) ?: return ""
            if (line.isEmpty()) break
            val separator = line.indexOf(':')
            if (separator <= 0) continue
            val name = line.substring(0, separator).trim().lowercase(Locale.US)
            val value = line.substring(separator + 1).trim()
            if (name == "content-length") {
                contentLength = value.toIntOrNull() ?: 0
            }
        }
        if (contentLength <= 0 || contentLength > MAX_BODY_BYTES) return ""

        val bytes = ByteArray(contentLength)
        var read = 0
        while (read < contentLength) {
            val count = input.read(bytes, read, contentLength - read)
            if (count <= 0) break
            read += count
        }
        return String(bytes, 0, read, Charsets.UTF_8)
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

        // 时间窗校验：relaySentAt 在加密负载内（GCM 防篡改），由发送方每跳重新打戳。
        // 旧版发送端没有该字段（=0）时跳过，保持互通
        val sentAt = payload.optLong("relaySentAt", 0L)
        if (sentAt > 0L && kotlin.math.abs(System.currentTimeMillis() - sentAt) > RELAY_REPLAY_WINDOW_MS) {
            Log.w(TAG, "Relay message outside replay window (sentAt=$sentAt), dropped")
            return 202
        }

        val payloadType = payload.optString("type")
        if (!isSupportedPayload(payloadType)) return 202

        val relayMessageId = payload.optString("relayMessageId")
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
        if (targetDeviceIds != null && targetDeviceIds.length() > 0 &&
            !jsonArrayContains(targetDeviceIds, identity.id)
        ) {
            Log.w(TAG, "Relay target scope does not include this node")
            return 202
        }

        if (isTopologyPayload(payloadType)) {
            val changed = TopologyStore.applyDelta(this, payload)
            if (changed) {
                sendBroadcast(Intent(WebSocketService.TOTP_SYNCED_ACTION))
                WebSocketService.reportExternalStatus(this, "已更新拓扑控制面")
            }
        } else if (isUserMessagePayload(payloadType)) {
            val sourceName = payload.optString("sourceDeviceName", payload.optString("phoneName", "未知设备"))
            if (SettingsStore.shouldReceiveContent(this, payloadType)) {
                notifyUserMessageRelay(payload)
                WebSocketService.reportExternalStatus(this, receivedStatusMessage(payloadType, sourceName))
            } else {
                Log.d(TAG, "本机接收策略已关闭 $payloadType，跳过本机显示但保留中继")
            }
        } else {
            handleTotpRelayPayload(payload)
        }

        val ttl = payload.optInt("relayTtl", 0)
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
            type == "app_notification"
    }

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
            else -> "收到中继消息"
        }
        val notificationText = when (type) {
            "sms" -> "$code · $sourceName"
            "sms_message" -> "$source · $sourceName"
            "app_notification" -> "$appName · $sourceName"
            else -> sourceName
        }
        val bigText = when (type) {
            "sms" -> "验证码: $code\n来源节点: $sourceName\n短信来源: $source\n短信内容: ${rawMessage.ifBlank { source }}"
            "sms_message" -> "来源节点: $sourceName\n短信来源: $source\n短信内容: ${rawMessage.ifBlank { source }}"
            "app_notification" -> "来源节点: $sourceName\n应用: $appName\n标题: ${title.ifBlank { "无标题" }}\n内容: $rawMessage"
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

    private fun receivedStatusMessage(type: String, sourceName: String): String {
        return when (type) {
            "sms" -> "收到中继验证码：$sourceName"
            "sms_message" -> "收到中继短信：$sourceName"
            "app_notification" -> "收到中继通知：$sourceName"
            else -> "收到中继消息：$sourceName"
        }
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
