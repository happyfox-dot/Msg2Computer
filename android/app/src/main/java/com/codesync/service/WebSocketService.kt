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
import com.codesync.util.ClipboardSyncState
import com.codesync.util.CryptoUtil
import com.codesync.util.DesktopDevice
import com.codesync.util.DeviceStore
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
import java.util.Locale
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicLong

/**
 * 按需投递服务（事件驱动）。
 *
 * 与旧的常驻连接模型不同：平时完全不保持任何连接，也不做空闲重连。
 * 只有在收到验证码短信（或一次性 TOTP / 配对测试）时才临时连接：
 *   连接 → 鉴权 → 加密发送（带 msgId）→ 等目标节点回 code_ack → 关闭连接。
 * 所有目标都投递完成（或超过投递时限）后立即停止服务，空闲期零耗电。
 */
class WebSocketService : Service() {

    companion object {
        const val TAG = "WebSocketService"
        const val ACTION_CONNECT = "com.codesync.CONNECT"
        const val ACTION_DISCONNECT = "com.codesync.DISCONNECT"
        const val ACTION_SEND_SMS = "com.codesync.SEND_SMS"
        const val ACTION_SEND_TOTP_SEED = "com.codesync.SEND_TOTP_SEED"
        const val ACTION_DELETE_TOTP_SEED = "com.codesync.DELETE_TOTP_SEED"
        const val ACTION_REVOKE_TOTP_ACCESS = "com.codesync.REVOKE_TOTP_ACCESS"
        const val ACTION_RELAY_SMS = "com.codesync.RELAY_SMS"
        const val ACTION_BROADCAST_TOPOLOGY = "com.codesync.BROADCAST_TOPOLOGY"
        const val ACTION_SEND_NOTIFICATION = "com.codesync.SEND_NOTIFICATION"
        const val ACTION_SEND_CLIPBOARD = "com.codesync.SEND_CLIPBOARD"

        const val EXTRA_CODE = "code"
        const val EXTRA_SOURCE = "source"
        const val EXTRA_MESSAGE_BODY = "message_body"
        const val EXTRA_CONTENT_TYPE = "content_type"
        const val EXTRA_TITLE = "title"
        const val EXTRA_APP_NAME = "app_name"
        const val EXTRA_PACKAGE_NAME = "package_name"
        const val EXTRA_TOTP_LABEL = "totp_label"
        const val EXTRA_TOTP_SECRET = "totp_secret"
        const val EXTRA_TOTP_ISSUER = "totp_issuer"
        const val EXTRA_TOTP_ACCOUNT = "totp_account"
        const val EXTRA_TOTP_ALGORITHM = "totp_algorithm"
        const val EXTRA_TOTP_DIGITS = "totp_digits"
        const val EXTRA_TOTP_PERIOD = "totp_period"
        const val EXTRA_DEVICE_ID = "device_id"
        const val EXTRA_DEVICE_IDS = "device_ids"
        const val EXTRA_RELAY_PAYLOAD = "relay_payload"
        const val EXTRA_TOPOLOGY_REASON = "topology_reason"

        const val NOTIFICATION_ID = 1001
        const val CHANNEL_ID = "code_sync_service"
        const val CONNECTION_STATE_ACTION = "com.codesync.CONNECTION_STATE"
        // 收到桌面节点下发的 TOTP 种子并存库后，发此本地广播通知界面刷新列表
        const val TOTP_SYNCED_ACTION = "com.codesync.TOTP_SYNCED"

        // 投递时限：一次任务最多尝试这么久（覆盖目标设备暂时离线时的几次退避重试），
        // 超时就放弃并停服务，避免无限挂着重连耗电。
        private const val DELIVERY_MAX_LIFETIME_MS = 90_000L
        // 单次连接尝试的重试退避：2s → 4s → 8s，封顶 15s。
        private const val RECONNECT_BASE_DELAY_MS = 2_000L
        private const val RECONNECT_MAX_DELAY_MS = 15_000L
        // 配对测试连接（无负载）鉴权成功后保持这么久再断开，给目标节点登记时间。
        private const val REGISTER_HOLD_MS = 1_500L
        private const val SMS_RELAY_TTL = 4
        // 各来源桌面已接受的最大 LSDB 序列号（key=桌面设备 ID），用于丢弃乱序旧路由表
        private const val LSDB_SEQ_PREFS = "topology_lsdb_seq"

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
        var webSocket: WebSocket? = null,
        var sessionKey: String? = null,
        var authenticated: Boolean = false,
        var deniedByDesktop: Boolean = false,
        var reconnectJob: Job? = null,
        // true 表示这是无负载的配对测试连接，鉴权后短暂保持再主动断开
        var registerOnly: Boolean = false,
        var forceConnect: Boolean = false,
        var phoneNonce: String = ""
    )

    private data class PendingPayload(
        val msgId: String,
        val payload: String,
        val targetIds: MutableSet<String>,
        val type: String
    )

    private val serviceScope = CoroutineScope(Dispatchers.IO + SupervisorJob())
    private val connections = ConcurrentHashMap<String, DeviceConnection>()
    // 每个目标设备当前轮到第几个候选地址（主地址 + altHosts 如 Tailscale IP）。
    // 连接失败时递增，下次重连换下一个地址；鉴权成功后归零，回到优先用主地址。
    private val hostRotation = ConcurrentHashMap<String, Int>()
    // 重连退避计数按 deviceId 存：DeviceConnection 每次重连都会重建，
    // 计数放在对象字段上会随之归零，导致指数退避从未生效（恒为基础间隔）
    private val reconnectAttempts = ConcurrentHashMap<String, Int>()
    private val pendingPayloads = mutableListOf<PendingPayload>()
    private var deliveryDeadlineJob: Job? = null
    private val msgIdSeq = AtomicLong(0)
    private val relayHttpClient = OkHttpClient.Builder()
        .connectTimeout(5, TimeUnit.SECONDS)
        .writeTimeout(8, TimeUnit.SECONDS)
        .readTimeout(8, TimeUnit.SECONDS)
        .build()

    // 所有 WebSocket 连接共享一个 client（OkHttp 官方建议）：每个连接单独
    // new 一个 client 会重复创建线程池/连接池，多设备 + 按需频繁连接时浪费明显
    private val wsClient = OkHttpClient.Builder()
        .connectTimeout(8, TimeUnit.SECONDS)
        .readTimeout(20, TimeUnit.SECONDS)
        // BFD 式快速失效检测：每 15s 发 ping，未按时收到 pong 则 OkHttp 直接
        // 判定连接失败并回调 onFailure → scheduleReconnect，不再等 TCP 超时；
        // 同时 pong 会重置 readTimeout，避免长连接空闲期被 20s 读超时误杀
        .pingInterval(15, TimeUnit.SECONDS)
        .build()

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
            ACTION_SEND_NOTIFICATION -> handleSendNotification(intent)
            ACTION_SEND_CLIPBOARD -> handleSendClipboard(intent)
            ACTION_SEND_TOTP_SEED -> handleSendTotpSeed(intent)
            ACTION_DELETE_TOTP_SEED -> handleDeleteTotpSeed(intent)
            ACTION_REVOKE_TOTP_ACCESS -> handleRevokeTotpAccess(intent)
            ACTION_RELAY_SMS -> handleRelaySms(intent)
            ACTION_BROADCAST_TOPOLOGY -> handleBroadcastTopology(intent)
            else -> stopIfNothingPending("空闲")
        }

        // 按需模型：任务自然结束后会自行 stopSelf，不需要系统自动重启
        return START_NOT_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    /** 配对测试 / 登记：连接并鉴权一次（让目标节点记录这台手机），短暂保持后断开。 */
    private fun handleConnect(intent: Intent) {
        val deviceId = intent.getStringExtra(EXTRA_DEVICE_ID)
        val device = if (deviceId != null) {
            DeviceStore.findDevice(this, deviceId)
        } else {
            DeviceStore.getEnabledDevices(this).firstOrNull()
        }

        if (device == null) {
            stopIfNothingPending("请先扫描设备配对二维码")
            return
        }

        armDeliveryDeadline()
        if (!isPhoneDevice(device)) {
            enqueueStoredTotpDeleteTombstones(listOf(device))
        }
        connectDevice(device, registerOnly = true)
    }

    private fun handleDisconnect() {
        stopService("已停止")
    }

    private fun handleSendSms(intent: Intent) {
        val contentType = intent.getStringExtra(EXTRA_CONTENT_TYPE)?.takeIf { it.isNotBlank() } ?: "sms"
        val code = intent.getStringExtra(EXTRA_CODE).orEmpty()
        if (contentType == "sms" && code.isBlank()) {
            stopIfNothingPending("空闲")
            return
        }
        val source = intent.getStringExtra(EXTRA_SOURCE) ?: "短信"
        val messageBody = intent.getStringExtra(EXTRA_MESSAGE_BODY)
        holdForwardLocks()
        enqueueAndDeliver(
            code = code,
            source = source,
            type = contentType,
            label = if (contentType == "sms_message") "短信" else null,
            rawMessage = messageBody
        )
    }

    private fun handleSendNotification(intent: Intent) {
        val body = intent.getStringExtra(EXTRA_MESSAGE_BODY)?.takeIf { it.isNotBlank() } ?: run {
            stopIfNothingPending("空闲")
            return
        }
        val title = intent.getStringExtra(EXTRA_TITLE).orEmpty()
        val appName = intent.getStringExtra(EXTRA_APP_NAME)?.takeIf { it.isNotBlank() } ?: "通知"
        val packageName = intent.getStringExtra(EXTRA_PACKAGE_NAME).orEmpty()
        holdForwardLocks()
        enqueueAndDeliver(
            code = "",
            source = appName,
            type = "app_notification",
            label = title,
            rawMessage = body,
            title = title,
            appName = appName,
            packageName = packageName
        )
    }

    private fun handleSendClipboard(intent: Intent) {
        val text = intent.getStringExtra(EXTRA_MESSAGE_BODY)?.takeIf { it.isNotBlank() } ?: run {
            stopIfNothingPending("空闲")
            return
        }
        holdForwardLocks()
        // 剪贴板 LWW 版本：内容与已应用版本相同 → 复用现有版本（等于把当前状态
        // 重新推一遍，接收端按版本去重/丢弃，天然幂等）；新内容 → 产生新版本
        val identity = PhoneIdentityStore.get(this)
        val clipTs: Long
        val clipOrigin: String
        if (ClipboardSyncState.hash(text) == ClipboardSyncState.appliedHash(this) &&
            ClipboardSyncState.appliedTs(this) > 0L
        ) {
            clipTs = ClipboardSyncState.appliedTs(this)
            clipOrigin = ClipboardSyncState.appliedOrigin(this).ifBlank { identity.id }
        } else {
            clipTs = System.currentTimeMillis()
            clipOrigin = identity.id
            ClipboardSyncState.remember(this, clipTs, clipOrigin, text)
        }
        enqueueAndDeliver(
            code = "",
            source = "剪贴板",
            type = "clipboard",
            label = "剪贴板",
            rawMessage = text,
            clipVersionTs = clipTs,
            clipVersionOrigin = clipOrigin
        )
    }

    private fun handleRelaySms(intent: Intent) {
        val payload = intent.getStringExtra(EXTRA_RELAY_PAYLOAD)?.takeIf { it.isNotBlank() } ?: run {
            stopIfNothingPending("空闲")
            return
        }
        holdForwardLocks()
        enqueueRelayPayload(payload)
    }

    private fun handleSendTotpSeed(intent: Intent) {
        val label = intent.getStringExtra(EXTRA_TOTP_LABEL)?.takeIf { it.isNotBlank() } ?: "TOTP"
        val secret = intent.getStringExtra(EXTRA_TOTP_SECRET) ?: run {
            stopIfNothingPending("空闲")
            return
        }
        val issuer = intent.getStringExtra(EXTRA_TOTP_ISSUER).orEmpty()
        val accountName = intent.getStringExtra(EXTRA_TOTP_ACCOUNT).orEmpty()
        val algorithm = intent.getStringExtra(EXTRA_TOTP_ALGORITHM)?.takeIf { it.isNotBlank() } ?: "SHA1"
        val digits = intent.getIntExtra(EXTRA_TOTP_DIGITS, 6).coerceIn(6, 8)
        val period = intent.getIntExtra(EXTRA_TOTP_PERIOD, 30).coerceIn(15, 120)

        holdForwardLocks()
        enqueueTotpSeed(
            label = label,
            secret = secret,
            issuer = issuer,
            accountName = accountName,
            algorithm = algorithm,
            digits = digits,
            period = period
        )
    }

    private fun handleDeleteTotpSeed(intent: Intent) {
        val label = intent.getStringExtra(EXTRA_TOTP_LABEL)?.takeIf { it.isNotBlank() } ?: "TOTP"
        val secret = intent.getStringExtra(EXTRA_TOTP_SECRET)?.takeIf { it.isNotBlank() } ?: run {
            stopIfNothingPending("空闲")
            return
        }
        val issuer = intent.getStringExtra(EXTRA_TOTP_ISSUER).orEmpty()
        val accountName = intent.getStringExtra(EXTRA_TOTP_ACCOUNT).orEmpty()
        val algorithm = intent.getStringExtra(EXTRA_TOTP_ALGORITHM)?.takeIf { it.isNotBlank() } ?: "SHA1"
        val digits = intent.getIntExtra(EXTRA_TOTP_DIGITS, 6).coerceIn(6, 8)
        val period = intent.getIntExtra(EXTRA_TOTP_PERIOD, 30).coerceIn(15, 120)

        holdForwardLocks()
        enqueueTotpSeedDelete(
            label = label,
            secret = secret,
            issuer = issuer,
            accountName = accountName,
            algorithm = algorithm,
            digits = digits,
            period = period
        )
    }

    private fun handleRevokeTotpAccess(intent: Intent) {
        val requestedIds = intent.getStringArrayListExtra(EXTRA_DEVICE_IDS)?.toSet().orEmpty()
        if (requestedIds.isEmpty()) {
            stopIfNothingPending("未选择设备")
            return
        }

        val targetDevices = DeviceStore.getDevices(this).filter { it.id in requestedIds }
        if (targetDevices.isEmpty()) {
            stopIfNothingPending("未找到要撤销的设备")
            return
        }

        holdForwardLocks()
        enqueueTotpRevoke(targetDevices)
    }

    private fun handleBroadcastTopology(intent: Intent) {
        val reason = intent.getStringExtra(EXTRA_TOPOLOGY_REASON) ?: "android_topology_change"
        val excludeDeviceId = intent.getStringExtra(EXTRA_DEVICE_ID).orEmpty()
        broadcastTopologyDelta(reason, excludeDeviceId)
    }

    private fun broadcastTopologyDelta(reason: String, excludeDeviceId: String = "", ttl: Int = SMS_RELAY_TTL) {
        val targetDevices = DeviceStore.getEnabledDevices(this)
            .filter { it.id != excludeDeviceId }
        if (targetDevices.isEmpty()) {
            stopIfNothingPending("没有可同步的设备节点")
            return
        }

        val identity = PhoneIdentityStore.get(this)
        val delta = TopologyStore.buildDelta(this, reason = reason, ttl = ttl)
        val relayMessageId = "topology-${identity.id}-${delta.optLong("seq", System.currentTimeMillis())}-${msgIdSeq.incrementAndGet()}"
        val payload = JSONObject(delta.toString())
            .put("originDeviceId", identity.id)
            .put("originDeviceName", identity.name)
            .put("relayMessageId", relayMessageId)
            .put("relayPath", JSONArray().put(identity.id))
            .put("relayTtl", ttl)
            .put("relayPolicy", "topology_gossip")
            .toString()

        enqueuePayloadToDevices(
            payload = payload,
            targetDevices = targetDevices,
            type = "topology_delta",
            statusMessage = "正在同步拓扑到 ${targetDevices.size} 个设备节点",
            force = true
        )
    }

    /** 构造一条带 msgId 的负载，登记到待投递队列，然后向所有启用设备节点发起连接投递。 */
    private fun enqueueAndDeliver(
        code: String,
        source: String,
        type: String,
        label: String? = null,
        rawMessage: String? = null,
        title: String? = null,
        appName: String? = null,
        packageName: String? = null,
        clipVersionTs: Long = 0L,
        clipVersionOrigin: String = ""
    ) {
        val targetDevices = targetDevicesForType(type)
        if (targetDevices.isEmpty()) {
            updateConnectionState("没有启用的推送目标")
            releaseForwardLocks()
            stopService("没有允许接收该内容的推送目标")
            return
        }

        val phoneIdentity = PhoneIdentityStore.get(this)
        val targetTopology = buildTargetTopology(targetDevices)
        val msgId = "m-${phoneIdentity.id}-${System.currentTimeMillis()}-${msgIdSeq.incrementAndGet()}"
        // 剪贴板：originMessageId 与 LWW 版本绑定（clip-<origin>-<ts>），同一版本经
        // 多条路径/重复推送到达同一节点时，接收端用既有去重表即可收敛为一次处理
        val originMessageId = if (type == "clipboard" && clipVersionTs > 0L) {
            "clip-$clipVersionOrigin-$clipVersionTs"
        } else {
            msgId
        }
        val relayMessageId = originMessageId
        val payload = JSONObject()
            .put("code", code)
            .put("source", source)
            .put("type", type)
            .put("timestamp", System.currentTimeMillis())
            .put("phoneId", phoneIdentity.id)
            .put("phoneName", phoneIdentity.name)
            .put("sourceDeviceId", phoneIdentity.id)
            .put("sourceDeviceName", phoneIdentity.name)
            .put("sourceDeviceType", "ANDROID_PHONE")
            .put("targetDevices", targetTopology)
            .put("targetDeviceIds", JSONArray(targetDevices.map { it.id }))
            .put("pushAuthority", "source_device")
            .put("pushAuthorityDeviceId", phoneIdentity.id)
            .apply {
                if (isUserMessageType(type)) {
                    put("originDeviceId", if (type == "clipboard" && clipVersionOrigin.isNotBlank()) clipVersionOrigin else phoneIdentity.id)
                    put("originDeviceName", phoneIdentity.name)
                    put("originMessageId", originMessageId)
                    put("relayMessageId", relayMessageId)
                    put("relayPath", JSONArray().put(phoneIdentity.id))
                    put("relayTtl", SMS_RELAY_TTL)
                    put("relayPolicy", "source_selected_targets")
                }
                if (type == "clipboard" && clipVersionTs > 0L) {
                    put(
                        "clipVersion",
                        JSONObject().put("ts", clipVersionTs).put("origin", clipVersionOrigin)
                    )
                }
                if (label != null) put("label", label)
                if (!rawMessage.isNullOrBlank()) put("rawMessage", rawMessage)
                if (!title.isNullOrBlank()) put("title", title)
                if (!appName.isNullOrBlank()) put("appName", appName)
                if (!packageName.isNullOrBlank()) put("packageName", packageName)
            }
            .toString()

        enqueuePayloadToDevices(
            payload = payload,
            targetDevices = targetDevices,
            type = type,
            statusMessage = deliveryStatusMessage(type, targetDevices.size),
            msgId = msgId
        )
    }

    private fun enqueueRelayPayload(plainPayload: String, excludeDeviceId: String = "") {
        val identity = PhoneIdentityStore.get(this)
        val payload = runCatching { JSONObject(plainPayload) }.getOrNull() ?: run {
            stopIfNothingPending("中继负载无效")
            return
        }
        val payloadType = payload.optString("type")
        if (!isRelaySupportedType(payloadType)) {
            stopIfNothingPending("该负载类型不支持节点中继")
            return
        }

        val relayPath = payload.optJSONArray("relayPath") ?: JSONArray()
        if (jsonArrayContains(relayPath, identity.id)) {
            stopIfNothingPending("已在中继路径中，跳过重复转发")
            return
        }

        val nextPath = JSONArray()
        for (i in 0 until relayPath.length()) {
            relayPath.optString(i).takeIf { it.isNotBlank() }?.let { nextPath.put(it) }
        }
        nextPath.put(identity.id)

        val allowedTargetIds = jsonArrayToSet(payload.optJSONArray("targetDeviceIds"))
        val pathIds = jsonArrayToSet(nextPath)
        val originId = payload.optString("originDeviceId", payload.optString("sourceDeviceId"))
        val currentRelayTtl = payload.optInt("relayTtl", payload.optInt("ttl", 0))
        val nextRelayTtl = (currentRelayTtl - 1).coerceAtLeast(0)
        val stableMsgId = stablePayloadMessageId(payload)
        val nextTargets = selectRelayNextTargets(
            payloadType = payloadType,
            allowedTargetIds = allowedTargetIds,
            pathIds = pathIds,
            excludeDeviceId = excludeDeviceId,
            originId = originId
        )

        if (nextTargets.isEmpty()) {
            updateConnectionState("已接收中继消息，无需继续转发")
            releaseForwardLocks()
            stopService("已接收中继消息")
            return
        }

        val nextPayloadJson = JSONObject(payload.toString())
            .put("originMessageId", payload.optString("originMessageId").ifBlank { stableMsgId })
            .put("relayPath", nextPath)
            .put("relayTtl", nextRelayTtl)
            .put("lastRelayDeviceId", identity.id)
            .put("lastRelayDeviceName", identity.name)
            .put("nextHopDevices", buildTargetTopology(nextTargets))
        if (isTopologyPayloadType(payloadType)) {
            nextPayloadJson.put("ttl", nextRelayTtl)
        }
        val nextPayload = nextPayloadJson.toString()

        enqueuePayloadToDevices(
            payload = nextPayload,
            targetDevices = nextTargets,
            type = payloadType,
            statusMessage = relayStatusMessage(payloadType, nextTargets.size),
            msgId = stableMsgId
        )
    }

    private fun enqueueTotpSeed(
        label: String,
        secret: String,
        issuer: String,
        accountName: String,
        algorithm: String,
        digits: Int,
        period: Int
    ) {
        val enabledDevices = targetDevicesForType("totp_seed")
        if (enabledDevices.isEmpty()) {
            updateConnectionState("没有启用的推送目标")
            releaseForwardLocks()
            stopService("没有允许接收 TOTP 的推送目标")
            return
        }

        val phoneIdentity = PhoneIdentityStore.get(this)
        val targetTopology = buildTargetTopology(enabledDevices)
        val msgId = "m-${System.currentTimeMillis()}-${msgIdSeq.incrementAndGet()}"
        val relayMessageId = "relay-${phoneIdentity.id}-${System.currentTimeMillis()}-${msgIdSeq.incrementAndGet()}"
        val payload = JSONObject()
            .put("type", "totp_seed")
            .put("label", label)
            .put("secret", secret)
            .put("issuer", issuer)
            .put("accountName", accountName)
            .put("algorithm", algorithm)
            .put("digits", digits)
            .put("period", period)
            .put("timestamp", System.currentTimeMillis())
            .put("phoneId", phoneIdentity.id)
            .put("phoneName", phoneIdentity.name)
            .put("sourceDeviceId", phoneIdentity.id)
            .put("sourceDeviceName", phoneIdentity.name)
            .put("sourceDeviceType", "ANDROID_PHONE")
            .put("targetDevices", targetTopology)
            .put("targetDeviceIds", JSONArray(enabledDevices.map { it.id }))
            .put("pushAuthority", "source_device")
            .put("pushAuthorityDeviceId", phoneIdentity.id)
            .put("originDeviceId", phoneIdentity.id)
            .put("originDeviceName", phoneIdentity.name)
            .put("relayMessageId", relayMessageId)
            .put("relayPath", JSONArray().put(phoneIdentity.id))
            .put("relayTtl", SMS_RELAY_TTL)
            .put("relayPolicy", "source_selected_targets")
            .toString()

        enqueuePayloadToDevices(
            payload = payload,
            targetDevices = enabledDevices,
            type = "totp_seed",
            statusMessage = "正在同步 TOTP 密钥到 ${enabledDevices.size} 个桌面节点",
            msgId = msgId
        )
    }

    private fun enqueueTotpSeedDelete(
        label: String,
        secret: String,
        issuer: String,
        accountName: String,
        algorithm: String,
        digits: Int,
        period: Int
    ) {
        val enabledDevices = targetDevicesForType("totp_revoke")
        if (enabledDevices.isEmpty()) {
            updateConnectionState("没有启用的推送目标")
            releaseForwardLocks()
            stopService("没有允许接收 TOTP 的推送目标")
            return
        }

        val phoneIdentity = PhoneIdentityStore.get(this)
        val targetTopology = buildTargetTopology(enabledDevices)
        val msgId = "m-${System.currentTimeMillis()}-${msgIdSeq.incrementAndGet()}"
        val relayMessageId = "relay-${phoneIdentity.id}-${System.currentTimeMillis()}-${msgIdSeq.incrementAndGet()}"
        val payload = JSONObject()
            .put("type", "totp_revoke")
            .put("scope", "seed")
            .put("label", label)
            .put("secret", secret)
            .put("issuer", issuer)
            .put("accountName", accountName)
            .put("algorithm", algorithm)
            .put("digits", digits)
            .put("period", period)
            .put("timestamp", System.currentTimeMillis())
            .put("phoneId", phoneIdentity.id)
            .put("phoneName", phoneIdentity.name)
            .put("sourceDeviceId", phoneIdentity.id)
            .put("sourceDeviceName", phoneIdentity.name)
            .put("sourceDeviceType", "ANDROID_PHONE")
            .put("targetDevices", targetTopology)
            .put("targetDeviceIds", JSONArray(enabledDevices.map { it.id }))
            .put("pushAuthority", "source_device")
            .put("pushAuthorityDeviceId", phoneIdentity.id)
            .put("originDeviceId", phoneIdentity.id)
            .put("originDeviceName", phoneIdentity.name)
            .put("relayMessageId", relayMessageId)
            .put("relayPath", JSONArray().put(phoneIdentity.id))
            .put("relayTtl", SMS_RELAY_TTL)
            .put("relayPolicy", "source_selected_targets")
            .toString()

        enqueuePayloadToDevices(
            payload = payload,
            targetDevices = enabledDevices,
            type = "totp_revoke",
            statusMessage = "正在同步删除 TOTP 到 ${enabledDevices.size} 个桌面节点",
            msgId = msgId
        )
    }

    private fun enqueueStoredTotpDeleteTombstones(targetDevices: List<DesktopDevice>) {
        if (targetDevices.isEmpty()) return

        val tombstones = TotpStore.loadDeleteTombstones(this).filter { it.isLocal }
        if (tombstones.isEmpty()) return

        val phoneIdentity = PhoneIdentityStore.get(this)
        val targetTopology = buildTargetTopology(targetDevices)
        val targetIds = targetDevices.map { it.id }.toMutableSet()

        synchronized(pendingPayloads) {
            tombstones.forEach { entry ->
                val msgId = "m-${System.currentTimeMillis()}-${msgIdSeq.incrementAndGet()}"
                val payload = JSONObject()
                    .put("type", "totp_revoke")
                    .put("scope", "seed")
                    .put("label", entry.label)
                    .put("secret", entry.secret)
                    .put("issuer", entry.issuer)
                    .put("accountName", entry.accountName)
                    .put("algorithm", entry.algorithm)
                    .put("digits", entry.digits)
                    .put("period", entry.period)
                    .put("timestamp", System.currentTimeMillis())
                    .put("phoneId", phoneIdentity.id)
                    .put("phoneName", phoneIdentity.name)
                    .put("sourceDeviceId", phoneIdentity.id)
                    .put("sourceDeviceName", phoneIdentity.name)
                    .put("sourceDeviceType", "ANDROID_PHONE")
                    .put("targetDevices", targetTopology)
                    .put("targetDeviceIds", JSONArray(targetDevices.map { it.id }))
                    .put("pushAuthority", "source_device")
                    .put("pushAuthorityDeviceId", phoneIdentity.id)
                    .toString()
                pendingPayloads.add(PendingPayload(msgId, payload, targetIds.toMutableSet(), "totp_revoke"))
            }
            while (pendingPayloads.size > 20) {
                val lowPriorityIndex = pendingPayloads.indexOfFirst {
                    it.type == "totp" || it.type == "totp_seed" || it.type == "totp_revoke"
                }
                pendingPayloads.removeAt(if (lowPriorityIndex >= 0) lowPriorityIndex else 0)
            }
        }
    }

    private fun enqueueTotpRevoke(targetDevices: List<DesktopDevice>) {
        val desktopTargets = targetDevices.filterNot { isPhoneDevice(it) }
        if (desktopTargets.isEmpty()) {
            updateConnectionState("未找到要撤销的桌面节点")
            releaseForwardLocks()
            stopService("未找到要撤销的桌面节点")
            return
        }

        val phoneIdentity = PhoneIdentityStore.get(this)
        val targetTopology = buildTargetTopology(desktopTargets)
        val msgId = "m-${System.currentTimeMillis()}-${msgIdSeq.incrementAndGet()}"
        val payload = JSONObject()
            .put("type", "totp_revoke")
            .put("scope", "phone")
            .put("timestamp", System.currentTimeMillis())
            .put("phoneId", phoneIdentity.id)
            .put("phoneName", phoneIdentity.name)
            .put("sourceDeviceId", phoneIdentity.id)
            .put("sourceDeviceName", phoneIdentity.name)
            .put("sourceDeviceType", "ANDROID_PHONE")
            .put("targetDevices", targetTopology)
            .put("targetDeviceIds", JSONArray(desktopTargets.map { it.id }))
            .put("pushAuthority", "source_device")
            .put("pushAuthorityDeviceId", phoneIdentity.id)
            .toString()

        enqueuePayloadToDevices(
            payload = payload,
            targetDevices = desktopTargets,
            type = "totp_revoke",
            statusMessage = "正在撤销 ${desktopTargets.size} 个桌面节点的 TOTP 显示权限",
            msgId = msgId,
            force = true
        )
    }

    private fun buildTargetTopology(devices: List<DesktopDevice>): JSONArray {
        val targets = JSONArray()
        devices.forEach { device ->
            targets.put(
                JSONObject()
                    .put("id", device.id)
                    .put("name", device.name)
                    .put("type", device.type)
                    .put("host", device.host)
                    .put("port", device.port)
                    .put("enabled", device.enabled)
                    .put("routeMetric", device.routeMetric)
                    .put("routeNextHopId", device.routeNextHopId)
                    .put("routeNextHopName", device.routeNextHopName)
                    .put("routePath", JSONArray(device.routePath))
                    .put("routeUpdatedAt", device.routeUpdatedAt)
                    .put("allowSmsCodes", device.allowSmsCodes)
                    .put("allowSmsMessages", device.allowSmsMessages)
                    .put("allowNotifications", device.allowNotifications)
                    .put("allowTotp", device.allowTotp)
                    .put("allowClipboard", device.allowClipboard)
            )
        }
        return targets
    }

    private fun enqueuePayloadToDevices(
        payload: String,
        targetDevices: List<DesktopDevice>,
        type: String,
        statusMessage: String,
        msgId: String = "m-${System.currentTimeMillis()}-${msgIdSeq.incrementAndGet()}",
        force: Boolean = false
    ) {
        val eligibleDevices = if (isRelaySupportedType(type)) {
            targetDevices
        } else {
            targetDevices.filterNot { isPhoneDevice(it) }
        }.sortedWith(
            compareBy<DesktopDevice> { if (it.routeMetric > 0) it.routeMetric else Int.MAX_VALUE / 2 }
                .thenByDescending { it.lastSyncAt }
        )
        if (eligibleDevices.isEmpty()) {
            val message = "没有可投递的设备节点"
            updateConnectionState(message)
            releaseForwardLocks()
            stopService(message)
            return
        }

        val targetIds = eligibleDevices.map { it.id }.toMutableSet()
        synchronized(pendingPayloads) {
            pendingPayloads.add(PendingPayload(msgId, payload, targetIds, type))
            trimPendingPayloads()
        }

        updateConnectionState(statusMessage)
        armDeliveryDeadline()

        val relayTargets = if (isRelaySupportedType(type)) eligibleDevices.filter { isPhoneDevice(it) } else emptyList()
        val websocketTargets = eligibleDevices.filterNot { isPhoneDevice(it) }
        Log.d(
            TAG,
            "Dispatch $type msgId=$msgId targets=${eligibleDevices.size}, " +
                "websocket=${websocketTargets.size}, relay=${relayTargets.size}, " +
                eligibleDevices.joinToString { "${it.name}/${it.type}/${it.host}:${it.port}" }
        )
        relayTargets.forEach { deliverRelayToPhoneTarget(it, payload, msgId) }
        websocketTargets.forEach { connectDevice(it, registerOnly = false, force = force) }
    }

    private fun trimPendingPayloads() {
        while (pendingPayloads.size > 20) {
            val lowPriorityIndex = pendingPayloads.indexOfFirst {
                it.type == "totp" || it.type == "totp_seed" || it.type == "totp_revoke"
            }
            pendingPayloads.removeAt(if (lowPriorityIndex >= 0) lowPriorityIndex else 0)
        }
    }

    private fun deliverRelayToPhoneTarget(device: DesktopDevice, payload: String, msgId: String) {
        serviceScope.launch {
            val success = sendRelayHttp(device, payload)
            if (success) {
                DeviceStore.markDeviceSynced(this@WebSocketService, device.id)
                ackDelivery(device.id, msgId)
                updateConnectionState("已中继到 ${device.name}")
            } else {
                updateConnectionState("中继失败 ${device.name}")
            }
            checkAllDoneAndStop()
        }
    }

    private fun sendRelayHttp(device: DesktopDevice, payload: String): Boolean {
        if (device.port <= 0 || device.pairingKey.isBlank()) return false
        val hosts = candidateHosts(device)
        if (hosts.isEmpty()) return false
        return try {
            val identity = PhoneIdentityStore.get(this)
            // 发送时间戳放在加密负载内（GCM 保证完整性）：接收端拒绝超出
            // 时间窗的消息，堵住「去重表滚出 200 条后整包重放」的口子。
            // 放负载里而不是改 HMAC 公式，新旧版本可以互通。
            val stampedPayload = runCatching {
                JSONObject(payload).put("relaySentAt", System.currentTimeMillis()).toString()
            }.getOrDefault(payload)
            val encryptedPayload = CryptoUtil.encrypt(stampedPayload, device.pairingKey)
            val nonce = CryptoUtil.generateNonce()
            val authToken = CryptoUtil.hmacSha256Base64(
                device.pairingKey,
                "${identity.id}|$nonce|$encryptedPayload"
            )
            val envelope = JSONObject()
                .put("type", "codebridge_relay")
                .put("version", 1)
                .put("senderId", identity.id)
                .put("nonce", nonce)
                .put("payload", encryptedPayload)
                .put("authToken", authToken)
                .toString()
            // 候选地址按序尝试（主地址 → Tailscale 等备用地址）：
            // 连接异常才换下一个；只要对端有 HTTP 应答（含 4xx）说明地址可达，
            // 换地址也解决不了鉴权问题，直接返回
            for (host in hosts) {
                try {
                    val body = envelope.toRequestBody("application/json; charset=utf-8".toMediaType())
                    val request = Request.Builder()
                        .url("http://${formatHttpHost(host)}:${device.port}/relay")
                        .post(body)
                        .build()
                    relayHttpClient.newCall(request).execute().use { response ->
                        if (!response.isSuccessful) {
                            Log.w(TAG, "Relay HTTP rejected by ${device.name}@$host: ${response.code}")
                        }
                        return response.isSuccessful
                    }
                } catch (e: Exception) {
                    Log.w(TAG, "Relay HTTP unreachable for ${device.name}@$host: ${e.message}")
                }
            }
            false
        } catch (e: Exception) {
            Log.e(TAG, "Relay HTTP failed for ${device.name}", e)
            false
        }
    }

    /** 目标设备的候选地址列表：主地址优先，其后是 altHosts（如 Tailscale IP）。 */
    private fun candidateHosts(device: DesktopDevice): List<String> {
        return (listOf(device.host) + device.altHosts)
            .filter { it.isNotBlank() }
            .distinct()
    }

    private fun formatHttpHost(host: String): String {
        return if (host.contains(":") && !host.startsWith("[")) "[$host]" else host
    }

    private fun isPhoneDevice(device: DesktopDevice): Boolean {
        return device.type.uppercase(Locale.ROOT).contains("PHONE")
    }

    private fun targetDevicesForType(type: String): List<DesktopDevice> {
        return DeviceStore.getEnabledDevices(this).filter { device ->
            when (type) {
                "sms" -> device.allowSmsCodes
                "sms_message" -> device.allowSmsMessages
                "app_notification" -> device.allowNotifications
                "totp", "totp_seed", "totp_revoke" -> device.allowTotp
                // 剪贴板不细分到每设备策略，仅受全局开关控制：所有启用设备都接收
                "clipboard" -> device.allowClipboard && SettingsStore.isSyncClipboardEnabled(this)
                else -> true
            }
        }
    }

    private fun selectRelayNextTargets(
        payloadType: String,
        allowedTargetIds: Set<String>,
        pathIds: Set<String>,
        excludeDeviceId: String,
        originId: String
    ): List<DesktopDevice> {
        val candidates = targetDevicesForType(payloadType)
        val byId = candidates.associateBy { it.id }
        val selected = linkedMapOf<String, DesktopDevice>()

        candidates.forEach { finalTarget ->
            if (finalTarget.id in pathIds ||
                finalTarget.id == excludeDeviceId ||
                finalTarget.id == originId ||
                (allowedTargetIds.isNotEmpty() && finalTarget.id !in allowedTargetIds)
            ) {
                return@forEach
            }

            val nextHopId = finalTarget.routeNextHopId.trim()
            val routedNextHop = if (
                nextHopId.isNotBlank() &&
                nextHopId != finalTarget.id &&
                nextHopId !in pathIds &&
                nextHopId != excludeDeviceId &&
                nextHopId != originId
            ) {
                byId[nextHopId]
            } else {
                null
            }

            val deliveryTarget = routedNextHop ?: finalTarget
            if (deliveryTarget.id !in pathIds &&
                deliveryTarget.id != excludeDeviceId &&
                deliveryTarget.id != originId
            ) {
                selected[deliveryTarget.id] = deliveryTarget
            }
        }

        return selected.values.sortedWith(
            compareBy<DesktopDevice> { if (it.routeMetric > 0) it.routeMetric else Int.MAX_VALUE / 2 }
                .thenByDescending { it.lastSyncAt }
        )
    }

    private fun isRelaySupportedType(type: String): Boolean {
        return isUserMessageType(type) ||
            type == "totp_seed" ||
            type == "totp_revoke" ||
            isTopologyPayloadType(type)
    }

    private fun isUserMessageType(type: String): Boolean {
        return type == "sms" ||
            type == "sms_message" ||
            type == "app_notification" ||
            type == "clipboard"
    }

    private fun deliveryStatusMessage(type: String, targetCount: Int): String {
        return when (type) {
            "sms" -> "正在投递验证码到 $targetCount 个设备节点"
            "sms_message" -> "正在投递短信到 $targetCount 个设备节点"
            "app_notification" -> "正在投递通知到 $targetCount 个设备节点"
            "clipboard" -> "正在同步剪贴板到 $targetCount 个设备节点"
            else -> "正在同步 TOTP"
        }
    }

    private fun relayStatusMessage(type: String, targetCount: Int): String {
        return when (type) {
            "sms" -> "正在中继验证码到 $targetCount 个设备节点"
            "sms_message" -> "正在中继短信到 $targetCount 个设备节点"
            "app_notification" -> "正在中继通知到 $targetCount 个设备节点"
            "clipboard" -> "正在中继剪贴板到 $targetCount 个设备节点"
            else -> "正在中继 TOTP 到 $targetCount 个设备节点"
        }
    }

    private fun isTopologyPayloadType(type: String): Boolean {
        return type == "topology_delta" ||
            type == "node_advertisement" ||
            type == "link_advertisement"
    }

    private fun jsonArrayContains(array: JSONArray, value: String): Boolean {
        for (i in 0 until array.length()) {
            if (array.optString(i) == value) return true
        }
        return false
    }

    private fun jsonArrayToSet(array: JSONArray?): Set<String> {
        if (array == null) return emptySet()
        val values = mutableSetOf<String>()
        for (i in 0 until array.length()) {
            array.optString(i).takeIf { it.isNotBlank() }?.let { values.add(it) }
        }
        return values
    }

    private fun jsonArrayToList(array: JSONArray?): List<String> {
        if (array == null) return emptyList()
        val values = mutableListOf<String>()
        for (i in 0 until array.length()) {
            array.optString(i).takeIf { it.isNotBlank() }?.let { values.add(it) }
        }
        return values
    }

    private fun stablePayloadMessageId(payload: JSONObject): String {
        return payload.optString("originMessageId")
            .ifBlank { payload.optString("relayMessageId") }
            .ifBlank { payload.optString("msgId") }
            .ifBlank { "m-${System.currentTimeMillis()}-${msgIdSeq.incrementAndGet()}" }
    }

    private fun connectDevice(device: DesktopDevice, registerOnly: Boolean, force: Boolean = false) {
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
            Log.d(TAG, "Reuse existing connection for ${device.name}, registerOnly=$registerOnly, force=$force")
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
        val connectHost = candidates[(hostRotation[device.id] ?: 0) % candidates.size]
        updateConnectionState("正在连接 ${device.name} ($connectHost:${device.port})")

        val request = Request.Builder()
            .url("ws://${formatHttpHost(connectHost)}:${device.port}")
            .build()

        connection.webSocket = wsClient.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                Log.d(TAG, "Connected to ${device.name}")
                val phoneIdentity = PhoneIdentityStore.get(this@WebSocketService)
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
                            reconnectAttempts.remove(device.id)
                            hostRotation.remove(device.id)
                            // 会话密钥就绪后第一时间加密上报本机 relay 信息（替代明文 auth 字段）
                            sendNodeInfo(webSocket, connection)
                            sendStoredTopologyDelta(webSocket, connection)
                            DeviceStore.markDeviceSynced(this@WebSocketService, device.id)
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
                            DeviceStore.markDeviceSynced(this@WebSocketService, device.id)
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
                                "phone_disabled" -> "目标节点已禁用或撤销此手机：${device.name}"
                                else -> "目标节点拒绝此手机授权：${device.name}"
                            }
                            Log.e(TAG, "Phone authorization denied by ${device.name}: $reason")
                            updateConnectionState(message)
                            // 该目标节点拒绝，不再为它保留待投递
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

    /**
     * 鉴权成功后通过加密通道上报本机 relay 配对密钥与端口。
     * 旧版把这两个字段放在明文 auth 消息里，同网段抓包即可伪造对本机的中继投递；
     * 现在桌面端通过 node_info（会话密钥加密）获取，旧桌面端会忽略未知消息类型。
     */
    private fun sendNodeInfo(webSocket: WebSocket, connection: DeviceConnection) {
        val sessionKey = connection.sessionKey ?: return
        try {
            val identity = PhoneIdentityStore.get(this)
            val info = JSONObject()
                .put("type", "node_info")
                .put("nodePairingKey", identity.pairingKey)
                .put("nodeRelayPort", LanDiscovery.NODE_RELAY_PORT)
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
            Log.e(TAG, "发送 node_info 失败", e)
        }
    }

    private fun sendStoredTopologyDelta(webSocket: WebSocket, connection: DeviceConnection) {
        val sessionKey = connection.sessionKey ?: return
        try {
            val delta = TopologyStore.buildDelta(this, reason = "android_auth")
            webSocket.send(
                JSONObject()
                    .put("type", "topology_delta")
                    .put("payload", CryptoUtil.encrypt(delta.toString(), sessionKey))
                    .toString()
            )
        } catch (e: Exception) {
            Log.e(TAG, "发送 topology_delta 失败", e)
        }
    }

    private fun handleTopologyDelta(connection: DeviceConnection, encryptedPayload: String) {
        val sessionKey = connection.sessionKey
        if (sessionKey.isNullOrBlank() || encryptedPayload.isBlank()) {
            Log.w(TAG, "topology_delta 缺少会话密钥或负载，忽略")
            return
        }
        val plain = try {
            CryptoUtil.decrypt(encryptedPayload, sessionKey)
        } catch (e: Exception) {
            Log.e(TAG, "topology_delta 解密失败", e)
            return
        }
        try {
            val delta = JSONObject(plain)
            val changed = TopologyStore.applyDelta(this, delta)
            if (changed) {
                updateConnectionState("已更新拓扑：${connection.device.name}")
                notifyTotpSynced()
                val ttl = delta.optInt("relayTtl", delta.optInt("ttl", SMS_RELAY_TTL))
                if (ttl > 0 && DeviceStore.getEnabledDevices(this).any { it.id != connection.device.id }) {
                    enqueueRelayPayload(delta.toString(), excludeDeviceId = connection.device.id)
                }
            }
        } catch (e: Exception) {
            Log.e(TAG, "topology_delta 解析失败", e)
        }
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

        val attempt = reconnectAttempts[deviceId] ?: 0
        val delayMs = (RECONNECT_BASE_DELAY_MS shl attempt.coerceAtMost(3))
            .coerceAtMost(RECONNECT_MAX_DELAY_MS)
        reconnectAttempts[deviceId] = (attempt + 1).coerceAtMost(8)

        connection.reconnectJob = serviceScope.launch {
            delay(delayMs)
            val latest = DeviceStore.findDevice(this@WebSocketService, deviceId)
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
    private fun handleTopologySync(connection: DeviceConnection, encryptedPayload: String) {
        val sessionKey = connection.sessionKey
        if (sessionKey.isNullOrBlank() || encryptedPayload.isBlank()) {
            Log.w(TAG, "topology_sync 缺少会话密钥或负载，忽略")
            return
        }

        val plain = try {
            CryptoUtil.decrypt(encryptedPayload, sessionKey)
        } catch (e: Exception) {
            Log.e(TAG, "topology_sync 解密失败", e)
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
                    Log.w(TAG, "丢弃过期 topology_sync：seq=$lsdbSeq < $lastSeq，来源 ${connection.device.name}")
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
                val host = node.optString("host").trim()
                val normalizedType = type.ifBlank { "UNKNOWN_DEVICE" }
                val isPhone = normalizedType.uppercase(Locale.ROOT).contains("PHONE")
                val port = node.optInt("port", if (isPhone) LanDiscovery.NODE_RELAY_PORT else 19527)
                val pairingKey = node.optString("pairingKey", node.optString("pk", "")).trim()
                val route = node.optJSONObject("route") ?: routeByDestination[id]
                if (id.isBlank() || id == identity.id || host.isBlank() || pairingKey.isBlank()) continue
                DeviceStore.upsertDevice(
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
                    routePath = jsonArrayToList(route?.optJSONArray("path")),
                    // 路由新鲜度以「整包路由表的计算时间」为准（同一包内统一），而不是
                    // 单条边的 updatedAt——后者来自 lastSeen，可能比已存值旧，
                    // 会被 DeviceStore 的新鲜度比较误判为过期路由
                    routeUpdatedAt = sync.optLong("updatedAt", 0L).takeIf { it > 0L }
                        ?: route?.optLong("updatedAt", 0L) ?: 0L,
                    altHosts = (jsonArrayToList(node.optJSONArray("altHosts")) +
                        listOfNotNull(node.optString("tsHost").trim().takeIf { it.isNotBlank() }))
                        .distinct()
                )
                imported += 1
            }
            if (imported > 0) {
                updateConnectionState("已更新 $imported 个可达设备节点")
                Log.d(TAG, "topology_sync imported $imported peers from ${connection.device.name}")
            }
        } catch (e: Exception) {
            Log.e(TAG, "topology_sync 解析失败", e)
        }
    }

    private fun lastAcceptedLsdbSeq(sourceId: String): Long =
        getSharedPreferences(LSDB_SEQ_PREFS, Context.MODE_PRIVATE).getLong(sourceId, 0L)

    private fun rememberLsdbSeq(sourceId: String, seq: Long) {
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
    private fun handleTotpSync(connection: DeviceConnection, encryptedPayload: String) {
        val sessionKey = connection.sessionKey
        if (sessionKey.isNullOrBlank() || encryptedPayload.isBlank()) {
            Log.w(TAG, "totp_sync 缺少会话密钥或负载，忽略")
            return
        }

        val plain = try {
            CryptoUtil.decrypt(encryptedPayload, sessionKey)
        } catch (e: Exception) {
            Log.e(TAG, "totp_sync 解密失败", e)
            return
        }

        try {
            val sync = JSONObject(plain)
            when (sync.optString("action", "add")) {
                "delete" -> {
                    val secret = normalizeSecret(sync.optString("secret"))
                    if (secret.isBlank()) return
                    val sourceDeviceId = sync.optString("sourceDeviceId").trim()
                    val removed = TotpStore.loadAll(this)
                        .filter {
                            normalizeSecret(it.secret) == secret &&
                                !it.isLocal &&
                                (sourceDeviceId.isBlank() || it.sourceDeviceId == sourceDeviceId)
                        }
                    removed.forEach { TotpStore.removeById(this, it.id) }
                    if (removed.isNotEmpty()) {
                        Log.d(TAG, "totp_sync 删除 ${removed.size} 条来自 ${connection.device.name} 的种子")
                        notifyTotpSynced()
                    }
                }
                else -> { // "add"
                    val secret = sync.optString("secret")
                    if (secret.isBlank()) return
                    val entry = TotpEntry(
                        label = sync.optString("label").ifBlank { "TOTP" },
                        secret = secret,
                        issuer = sync.optString("issuer"),
                        accountName = sync.optString("accountName"),
                        algorithm = sync.optString("algorithm", "SHA1").ifBlank { "SHA1" },
                        digits = sync.optInt("digits", 6),
                        period = sync.optInt("period", 30),
                        sourceDeviceId = sync.optString("sourceDeviceId"),
                        sourceDeviceName = sync.optString("sourceDeviceName"),
                        sourceDeviceType = sync.optString("sourceDeviceType", "WINDOWS_DESKTOP")
                            .ifBlank { "WINDOWS_DESKTOP" },
                        // 远程来源：只读，不可在本机编辑/再同步
                        isLocal = false
                    ).withStableId()
                    TotpStore.add(this, entry)
                    Log.d(TAG, "totp_sync 已落库种子 ${entry.label}（来自 ${connection.device.name}）")
                    notifyTotpSynced()
                }
            }
        } catch (e: Exception) {
            Log.e(TAG, "totp_sync 解析失败", e)
        }
    }

    /** 规范化 secret 用于匹配：去空格/连字符并大写。 */
    private fun normalizeSecret(secret: String?): String {
        return secret.orEmpty().uppercase().replace(Regex("[\\s-]"), "")
    }

    /** 发本地广播，通知界面 TOTP 列表已因同步而变化。 */
    private fun notifyTotpSynced() {
        sendBroadcast(Intent(TOTP_SYNCED_ACTION))
    }

    /** 向已鉴权且有待投递负载的设备发送，返回是否发出了至少一条。 */
    private fun flushPendingForDevice(deviceId: String): Boolean {
        val connection = connections[deviceId] ?: return false
        var sentAny = false
        synchronized(pendingPayloads) {
            pendingPayloads
                .filter { deviceId in it.targetIds }
                .forEach { pending ->
                    if (sendPayload(connection, pending.payload, pending.msgId, pending.type)) {
                        sentAny = true
                    }
                }
        }
        return sentAny
    }

    private fun sendPayload(connection: DeviceConnection, payload: String, msgId: String, payloadType: String): Boolean {
        val webSocket = connection.webSocket ?: return false
        val sessionKey = connection.sessionKey ?: return false
        if (!connection.authenticated) return false

        return try {
            val encrypted = CryptoUtil.encrypt(payload, sessionKey)
            val messageType = if (isTopologyPayloadType(payloadType)) payloadType else "verify_code"
            val message = JSONObject()
                .put("type", messageType)
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
        // 本轮投递已结束（送达或放弃），重置该设备的退避与地址轮换状态
        reconnectAttempts.remove(deviceId)
        hostRotation.remove(deviceId)
        val connection = connections.remove(deviceId) ?: return
        connection.reconnectJob?.cancel()
        connection.webSocket?.close(1000, "Done")
    }

    /** 投递时限：到点仍未送达就放弃并停服务，避免无限挂着重连。 */
    private fun armDeliveryDeadline() {
        deliveryDeadlineJob?.cancel()
        deliveryDeadlineJob = serviceScope.launch {
            delay(DELIVERY_MAX_LIFETIME_MS)
            val remaining = synchronized(pendingPayloads) { pendingPayloads.size }
            if (remaining > 0) {
                Log.w(TAG, "Delivery deadline reached, giving up $remaining pending")
                stopService("部分验证码未送达（设备可能离线）")
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
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            stopForeground(STOP_FOREGROUND_REMOVE)
        } else {
            @Suppress("DEPRECATION")
            stopForeground(true)
        }
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
                "连接超时，请确认设备在同一 Wi-Fi，且目标节点防火墙允许对应端口"
            message.contains("failed to connect", ignoreCase = true) ->
                "无法访问目标节点 IP/端口，请检查二维码 IP、局域网和防火墙"
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
        // 共享 client 随服务一起释放线程池（服务重建时会 new 新实例）
        runCatching { wsClient.dispatcher.executorService.shutdown() }
        runCatching { relayHttpClient.dispatcher.executorService.shutdown() }
        serviceScope.cancel()
        isRunning = false
        isConnected = false
        connectedCount = 0
        connectedDeviceIds = emptySet()
        lastStatusMessage = "服务已停止"
        super.onDestroy()
    }
}
