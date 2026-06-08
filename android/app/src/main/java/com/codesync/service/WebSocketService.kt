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
import android.util.Log
import androidx.core.app.NotificationCompat
import com.codesync.MainActivity
import com.codesync.util.CryptoUtil
import com.codesync.util.DesktopDevice
import com.codesync.util.DeviceStore
import com.codesync.util.PhoneIdentityStore
import com.codesync.util.TotpUtil
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicLong

/**
 * 按需投递服务（事件驱动）。
 *
 * 与旧的常驻连接模型不同：平时完全不保持任何连接，也不做空闲重连。
 * 只有在收到验证码短信（或一次性 TOTP / 配对测试）时才临时连接：
 *   连接 → 鉴权 → 加密发送（带 msgId）→ 等电脑回 code_ack → 关闭连接。
 * 所有目标都投递完成（或超过投递时限）后立即停止服务，空闲期零耗电。
 */
class WebSocketService : Service() {

    companion object {
        const val TAG = "WebSocketService"
        const val ACTION_CONNECT = "com.codesync.CONNECT"
        const val ACTION_DISCONNECT = "com.codesync.DISCONNECT"
        const val ACTION_SEND_SMS = "com.codesync.SEND_SMS"
        const val ACTION_SEND_TOTP = "com.codesync.SEND_TOTP"

        const val EXTRA_CODE = "code"
        const val EXTRA_SOURCE = "source"
        const val EXTRA_MESSAGE_BODY = "message_body"
        const val EXTRA_TOTP_LABEL = "totp_label"
        const val EXTRA_TOTP_SECRET = "totp_secret"
        const val EXTRA_DEVICE_ID = "device_id"

        const val NOTIFICATION_ID = 1001
        const val CHANNEL_ID = "code_sync_service"
        const val CONNECTION_STATE_ACTION = "com.codesync.CONNECTION_STATE"

        // 投递时限：一次任务最多尝试这么久（覆盖电脑暂时离线时的几次退避重试），
        // 超时就放弃并停服务，避免无限挂着重连耗电。
        private const val DELIVERY_MAX_LIFETIME_MS = 90_000L
        // 单次连接尝试的重试退避：2s → 4s → 8s，封顶 15s。
        private const val RECONNECT_BASE_DELAY_MS = 2_000L
        private const val RECONNECT_MAX_DELAY_MS = 15_000L
        // 配对测试连接（无负载）鉴权成功后保持这么久再断开，给电脑端登记时间。
        private const val REGISTER_HOLD_MS = 1_500L

        @Volatile
        var isConnected = false
        @Volatile
        var connectedCount = 0
        @Volatile
        var connectedDeviceIds: Set<String> = emptySet()
        @Volatile
        var lastStatusMessage = "空闲"
        @Volatile
        var isRunning = false

        fun reportExternalStatus(context: Context, message: String) {
            lastStatusMessage = message
            val intent = Intent(CONNECTION_STATE_ACTION).apply {
                putExtra("connected", isConnected)
                putExtra("connected_count", connectedCount)
                putExtra("status_message", message)
            }
            context.sendBroadcast(intent)
        }
    }

    private data class DeviceConnection(
        val device: DesktopDevice,
        val client: OkHttpClient,
        var webSocket: WebSocket? = null,
        var sessionKey: String? = null,
        var authenticated: Boolean = false,
        var deniedByDesktop: Boolean = false,
        var reconnectJob: Job? = null,
        var reconnectAttempts: Int = 0,
        // true 表示这是无负载的配对测试连接，鉴权后短暂保持再主动断开
        var registerOnly: Boolean = false
    )

    private data class PendingPayload(
        val msgId: String,
        val payload: String,
        val targetIds: MutableSet<String>,
        val type: String
    )

    private val serviceScope = CoroutineScope(Dispatchers.IO + SupervisorJob())
    private val connections = ConcurrentHashMap<String, DeviceConnection>()
    private val pendingPayloads = mutableListOf<PendingPayload>()
    private var deliveryDeadlineJob: Job? = null
    private val msgIdSeq = AtomicLong(0)

    private var forwardWakeLock: PowerManager.WakeLock? = null
    private var forwardWifiLock: WifiManager.WifiLock? = null
    private var lockReleaseJob: Job? = null
    private val lockGeneration = AtomicLong(0)

    override fun onCreate() {
        super.onCreate()
        isRunning = true
        createNotificationChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        startForeground(NOTIFICATION_ID, buildNotification())

        when (intent?.action) {
            ACTION_CONNECT -> handleConnect(intent)
            ACTION_DISCONNECT -> handleDisconnect()
            ACTION_SEND_SMS -> handleSendSms(intent)
            ACTION_SEND_TOTP -> handleSendTotp(intent)
            else -> stopIfNothingPending("空闲")
        }

        // 按需模型：任务自然结束后会自行 stopSelf，不需要系统自动重启
        return START_NOT_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    /** 配对测试 / 登记：连接并鉴权一次（让电脑端记录这台手机），短暂保持后断开。 */
    private fun handleConnect(intent: Intent) {
        val deviceId = intent.getStringExtra(EXTRA_DEVICE_ID)
        val device = if (deviceId != null) {
            DeviceStore.findDevice(this, deviceId)
        } else {
            DeviceStore.getEnabledDevices(this).firstOrNull()
        }

        if (device == null) {
            stopIfNothingPending("请先扫描电脑端二维码")
            return
        }

        armDeliveryDeadline()
        connectDevice(device, registerOnly = true)
    }

    private fun handleDisconnect() {
        stopService("已停止")
    }

    private fun handleSendSms(intent: Intent) {
        val code = intent.getStringExtra(EXTRA_CODE) ?: run {
            stopIfNothingPending("空闲")
            return
        }
        val source = intent.getStringExtra(EXTRA_SOURCE) ?: "短信"
        val messageBody = intent.getStringExtra(EXTRA_MESSAGE_BODY)
        holdForwardLocks()
        enqueueAndDeliver(code, source, "sms", rawMessage = messageBody)
    }

    private fun handleSendTotp(intent: Intent) {
        val label = intent.getStringExtra(EXTRA_TOTP_LABEL) ?: run {
            stopIfNothingPending("空闲")
            return
        }
        val secret = intent.getStringExtra(EXTRA_TOTP_SECRET) ?: run {
            stopIfNothingPending("空闲")
            return
        }
        val code = TotpUtil.generate(secret)
        holdForwardLocks()
        enqueueAndDeliver(code, label, "totp", label = label)
    }

    /** 构造一条带 msgId 的负载，登记到待投递队列，然后向所有启用电脑发起连接投递。 */
    private fun enqueueAndDeliver(
        code: String,
        source: String,
        type: String,
        label: String? = null,
        rawMessage: String? = null
    ) {
        val enabledDevices = DeviceStore.getEnabledDevices(this)
        if (enabledDevices.isEmpty()) {
            updateConnectionState("没有启用的电脑推送目标")
            releaseForwardLocks()
            stopService("没有启用的电脑推送目标")
            return
        }

        val phoneIdentity = PhoneIdentityStore.get(this)
        val msgId = "m-${System.currentTimeMillis()}-${msgIdSeq.incrementAndGet()}"
        val payload = JSONObject()
            .put("code", code)
            .put("source", source)
            .put("type", type)
            .put("timestamp", System.currentTimeMillis())
            .put("phoneId", phoneIdentity.id)
            .put("phoneName", phoneIdentity.name)
            .apply {
                if (label != null) put("label", label)
                if (!rawMessage.isNullOrBlank()) put("rawMessage", rawMessage)
            }
            .toString()

        val targetIds = enabledDevices.map { it.id }.toMutableSet()
        synchronized(pendingPayloads) {
            pendingPayloads.add(PendingPayload(msgId, payload, targetIds, type))
            // 离线累积时限制队列规模，优先丢弃旧的 TOTP（短信更重要）
            while (pendingPayloads.size > 20) {
                val totpIndex = pendingPayloads.indexOfFirst { it.type == "totp" }
                pendingPayloads.removeAt(if (totpIndex >= 0) totpIndex else 0)
            }
        }

        updateConnectionState(
            if (type == "sms") "正在投递验证码到 ${enabledDevices.size} 台电脑" else "正在同步 TOTP"
        )
        armDeliveryDeadline()
        enabledDevices.forEach { connectDevice(it, registerOnly = false) }
    }

    private fun connectDevice(device: DesktopDevice, registerOnly: Boolean) {
        if (!device.enabled) return

        val existing = connections[device.id]
        if (existing?.authenticated == true || existing?.webSocket != null) {
            // 已在连接/已连上：若现在带了负载，鉴权完成后会一并 flush
            if (!registerOnly) existing.registerOnly = false
            return
        }

        existing?.reconnectJob?.cancel()
        existing?.webSocket?.close(1000, "Reconnect")
        existing?.client?.dispatcher?.executorService?.shutdown()

        val client = OkHttpClient.Builder()
            .connectTimeout(8, TimeUnit.SECONDS)
            .readTimeout(20, TimeUnit.SECONDS)
            .build()

        val connection = DeviceConnection(
            device = device,
            client = client,
            registerOnly = registerOnly
        )
        connections[device.id] = connection
        updateConnectionState("正在连接 ${device.name} (${device.host}:${device.port})")

        val request = Request.Builder()
            .url("ws://${device.host}:${device.port}")
            .build()

        connection.webSocket = client.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                Log.d(TAG, "Connected to ${device.name}")
                val phoneIdentity = PhoneIdentityStore.get(this@WebSocketService)
                val authMsg = JSONObject()
                    .put("type", "auth")
                    .put("pairingKey", device.pairingKey)
                    .put("phoneId", phoneIdentity.id)
                    .put("phoneName", phoneIdentity.name)
                    .toString()
                webSocket.send(authMsg)
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                try {
                    val msg = JSONObject(text)
                    when (msg.optString("type")) {
                        "auth_ok" -> {
                            connection.sessionKey = msg.optString("sessionKey")
                            connection.authenticated = true
                            connection.reconnectAttempts = 0
                            Log.d(TAG, "Authenticated ${device.name}")
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
                            Log.d(TAG, "ACK ${device.name}: $ackedId")
                            ackDelivery(device.id, ackedId)
                            if (!deviceHasPending(device.id)) {
                                scheduleCloseAfterIdle(device.id)
                            }
                            checkAllDoneAndStop()
                        }
                        "auth_fail" -> {
                            Log.e(TAG, "Authentication failed for ${device.name}")
                            connection.deniedByDesktop = true
                            updateConnectionState("配对密钥不匹配，请重新扫描 ${device.name} 的二维码")
                            webSocket.close(1000, "Authentication failed")
                        }
                        "auth_denied" -> {
                            connection.deniedByDesktop = true
                            connection.authenticated = false
                            val reason = msg.optString("reason")
                            val message = when (reason) {
                                "phone_disabled" -> "电脑端已禁用或撤销此手机：${device.name}"
                                else -> "电脑端拒绝此手机授权：${device.name}"
                            }
                            Log.e(TAG, "Phone authorization denied by ${device.name}: $reason")
                            updateConnectionState(message)
                            // 该电脑拒绝，不再为它保留待投递
                            dropPendingForDevice(device.id)
                            webSocket.close(1000, "Phone authorization denied")
                        }
                    }
                } catch (e: Exception) {
                    Log.e(TAG, "Message parse error", e)
                }
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                Log.e(TAG, "Connection failed for ${device.name}", t)
                connection.authenticated = false
                connection.webSocket = null
                updateConnectionState("连接失败 ${device.name}: ${formatConnectionError(t)}")
                if (!connection.deniedByDesktop && deviceHasPending(device.id)) {
                    scheduleReconnect(device.id)
                } else {
                    cleanupConnection(device.id)
                    checkAllDoneAndStop()
                }
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                Log.d(TAG, "Closed ${device.name}: $reason")
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

    /** 鉴权成功后无待投递负载时，保持很短时间再断开（给登记/缓冲落地留余量）。 */
    private fun scheduleCloseAfterIdle(deviceId: String) {
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

    private fun scheduleReconnect(deviceId: String) {
        val connection = connections[deviceId] ?: return
        connection.reconnectJob?.cancel()

        val attempt = connection.reconnectAttempts
        val delayMs = (RECONNECT_BASE_DELAY_MS shl attempt.coerceAtMost(3))
            .coerceAtMost(RECONNECT_MAX_DELAY_MS)
        connection.reconnectAttempts = (attempt + 1).coerceAtMost(8)

        connection.reconnectJob = serviceScope.launch {
            delay(delayMs)
            val latest = DeviceStore.findDevice(this@WebSocketService, deviceId)
            if (latest?.enabled == true && deviceHasPending(deviceId) &&
                connections[deviceId]?.authenticated != true
            ) {
                updateConnectionState("正在重连 ${latest.name}")
                connectDevice(latest, registerOnly = false)
            } else {
                cleanupConnection(deviceId)
                checkAllDoneAndStop()
            }
        }
    }

    /** 向已鉴权且有待投递负载的设备发送，返回是否发出了至少一条。 */
    private fun flushPendingForDevice(deviceId: String): Boolean {
        val connection = connections[deviceId] ?: return false
        var sentAny = false
        synchronized(pendingPayloads) {
            pendingPayloads
                .filter { deviceId in it.targetIds }
                .forEach { pending ->
                    if (sendPayload(connection, pending.payload, pending.msgId)) {
                        sentAny = true
                    }
                }
        }
        return sentAny
    }

    private fun sendPayload(connection: DeviceConnection, payload: String, msgId: String): Boolean {
        val webSocket = connection.webSocket ?: return false
        val sessionKey = connection.sessionKey ?: return false
        if (!connection.authenticated) return false

        return try {
            val encrypted = CryptoUtil.encrypt(payload, sessionKey)
            val message = JSONObject()
                .put("type", "verify_code")
                .put("msgId", msgId)
                .put("payload", encrypted)
                .toString()
            val queued = webSocket.send(message)
            if (queued) Log.d(TAG, "Sent $msgId to ${connection.device.name}")
            queued
        } catch (e: Exception) {
            Log.e(TAG, "Failed to send code to ${connection.device.name}", e)
            false
        }
    }

    /** 收到 ACK：把该 msgId 对应负载里这台设备移除；负载无目标时整条删除。 */
    private fun ackDelivery(deviceId: String, msgId: String) {
        synchronized(pendingPayloads) {
            val iterator = pendingPayloads.iterator()
            while (iterator.hasNext()) {
                val pending = iterator.next()
                if (pending.msgId == msgId || msgId.isBlank()) {
                    pending.targetIds.remove(deviceId)
                    if (pending.targetIds.isEmpty()) iterator.remove()
                    if (msgId.isNotBlank()) break
                }
            }
        }
    }

    private fun deviceHasPending(deviceId: String): Boolean {
        synchronized(pendingPayloads) {
            return pendingPayloads.any { deviceId in it.targetIds }
        }
    }

    private fun dropPendingForDevice(deviceId: String) {
        synchronized(pendingPayloads) {
            val iterator = pendingPayloads.iterator()
            while (iterator.hasNext()) {
                val pending = iterator.next()
                pending.targetIds.remove(deviceId)
                if (pending.targetIds.isEmpty()) iterator.remove()
            }
        }
    }

    private fun cleanupConnection(deviceId: String) {
        val connection = connections.remove(deviceId) ?: return
        connection.reconnectJob?.cancel()
        connection.webSocket?.close(1000, "Done")
        connection.client.dispatcher.executorService.shutdown()
    }

    /** 投递时限：到点仍未送达就放弃并停服务，避免无限挂着重连。 */
    private fun armDeliveryDeadline() {
        deliveryDeadlineJob?.cancel()
        deliveryDeadlineJob = serviceScope.launch {
            delay(DELIVERY_MAX_LIFETIME_MS)
            val remaining = synchronized(pendingPayloads) { pendingPayloads.size }
            if (remaining > 0) {
                Log.w(TAG, "Delivery deadline reached, giving up $remaining pending")
                stopService("部分验证码未送达（电脑可能离线）")
            } else {
                stopService("空闲")
            }
        }
    }

    private fun checkAllDoneAndStop() {
        val remaining = synchronized(pendingPayloads) { pendingPayloads.size }
        val activeConns = connections.values.count { it.webSocket != null || it.authenticated }
        if (remaining == 0 && activeConns == 0) {
            stopService(if (lastStatusMessage.startsWith("已送达") || lastStatusMessage.startsWith("配对")) lastStatusMessage else "已送达")
        }
    }

    private fun stopIfNothingPending(statusMessage: String) {
        val remaining = synchronized(pendingPayloads) { pendingPayloads.size }
        if (remaining == 0 && connections.isEmpty()) {
            stopService(statusMessage)
        }
    }

    private fun stopService(statusMessage: String) {
        deliveryDeadlineJob?.cancel()
        lockReleaseJob?.cancel()
        releaseForwardLocks()
        connections.keys.toList().forEach { cleanupConnection(it) }
        synchronized(pendingPayloads) { pendingPayloads.clear() }

        isConnected = false
        connectedCount = 0
        connectedDeviceIds = emptySet()
        lastStatusMessage = statusMessage
        broadcastConnectionState(false, 0, statusMessage)
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    private fun updateConnectionState(statusMessage: String? = null) {
        connectedDeviceIds = connections.values
            .filter { it.authenticated }
            .map { it.device.id }
            .toSet()
        connectedCount = connectedDeviceIds.size
        isConnected = connectedCount > 0
        lastStatusMessage = statusMessage ?: if (connectedCount > 0) "投递中" else "空闲"
        updateNotification(lastStatusMessage)
        broadcastConnectionState(isConnected, connectedCount, lastStatusMessage)
    }

    private fun updateNotification(text: String) {
        val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        manager.notify(NOTIFICATION_ID, buildNotification(text))
    }

    private fun buildNotification(status: String = "验证码同步"): Notification {
        val intent = Intent(this, MainActivity::class.java)
        val pendingIntent = PendingIntent.getActivity(
            this, 0, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("验证码同步")
            .setContentText(status)
            .setSmallIcon(android.R.drawable.ic_dialog_info)
            .setOngoing(true)
            .setContentIntent(pendingIntent)
            .build()
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                "Code Sync Service",
                NotificationManager.IMPORTANCE_LOW
            ).apply {
                description = "验证码投递期间短暂运行"
            }
            val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            manager.createNotificationChannel(channel)
        }
    }

    private fun broadcastConnectionState(connected: Boolean, connectedCount: Int, statusMessage: String) {
        val intent = Intent(CONNECTION_STATE_ACTION).apply {
            putExtra("connected", connected)
            putExtra("connected_count", connectedCount)
            putExtra("status_message", statusMessage)
        }
        sendBroadcast(intent)
    }

    private fun formatConnectionError(t: Throwable): String {
        val message = t.message?.takeIf { it.isNotBlank() } ?: t.javaClass.simpleName
        return when {
            message.contains("CLEARTEXT", ignoreCase = true) ->
                "系统禁止明文局域网连接，请安装已开启局域网 ws:// 支持的新版本"
            message.contains("timeout", ignoreCase = true) ->
                "连接超时，请确认手机和电脑在同一 Wi-Fi，且 Windows 防火墙允许端口 19527"
            message.contains("failed to connect", ignoreCase = true) ->
                "无法访问电脑 IP/端口，请检查二维码 IP、局域网和防火墙"
            else -> message
        }
    }

    /** 投递期间临时持有唤醒锁 + Wi-Fi 锁，确保熄屏也能完成发送；时限后或停服务时释放。 */
    private fun holdForwardLocks(timeoutMs: Long = DELIVERY_MAX_LIFETIME_MS) {
        val generation = lockGeneration.incrementAndGet()
        lockReleaseJob?.cancel()
        lockReleaseJob = null
        releaseForwardLocks()

        try {
            val powerManager = getSystemService(Context.POWER_SERVICE) as PowerManager
            forwardWakeLock = powerManager
                .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "CodeSync:Forward")
                .apply {
                    setReferenceCounted(false)
                    acquire(timeoutMs)
                }
        } catch (e: Exception) {
            Log.e(TAG, "Failed to acquire wake lock", e)
        }

        try {
            val wifiManager = applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
            forwardWifiLock = wifiManager
                .createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, "CodeSync:ForwardWifi")
                .apply {
                    setReferenceCounted(false)
                    acquire()
                }
        } catch (e: Exception) {
            Log.e(TAG, "Failed to acquire Wi-Fi lock", e)
        }

        lockReleaseJob = serviceScope.launch {
            delay(timeoutMs)
            if (lockGeneration.get() == generation) {
                releaseForwardLocks()
            }
        }
    }

    private fun releaseForwardLocks() {
        try {
            forwardWakeLock?.takeIf { it.isHeld }?.release()
        } catch (e: Exception) {
            Log.e(TAG, "Failed to release wake lock", e)
        } finally {
            forwardWakeLock = null
        }

        try {
            forwardWifiLock?.takeIf { it.isHeld }?.release()
        } catch (e: Exception) {
            Log.e(TAG, "Failed to release Wi-Fi lock", e)
        } finally {
            forwardWifiLock = null
        }
    }

    override fun onDestroy() {
        deliveryDeadlineJob?.cancel()
        lockReleaseJob?.cancel()
        releaseForwardLocks()
        connections.keys.toList().forEach { cleanupConnection(it) }
        serviceScope.cancel()
        isRunning = false
        isConnected = false
        connectedCount = 0
        connectedDeviceIds = emptySet()
        lastStatusMessage = "服务已停止"
        super.onDestroy()
    }
}
