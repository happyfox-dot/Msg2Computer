package com.codesync.util

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

data class DesktopDevice(
    val id: String,
    val name: String,
    val type: String,
    val host: String,
    val port: Int,
    val pairingKey: String,
    val enabled: Boolean,
    val revoked: Boolean = false,
    val lastSyncAt: Long,
    val connectionUpdatedAt: Long,
    val updatedAt: Long,
    val routeMetric: Int,
    val routeNextHopId: String,
    val routeNextHopName: String,
    val routePath: List<String>,
    val routeUpdatedAt: Long,
    val allowSmsCodes: Boolean = true,
    val allowSmsMessages: Boolean = true,
    val allowNotifications: Boolean = true,
    val allowTotp: Boolean = true,
    // v2 起默认允许：是否同步由全局总开关（默认关）决定，本位仅作为
    // 针对个别设备的显式关闭（旧默认 false 导致全局开关打开后剪贴板
    // 同步依然提示"没有启用的推送目标"）
    val allowClipboard: Boolean = true,
    val allowClipboardImage: Boolean = true,
    val allowClipboardFile: Boolean = false,
    val allowFileTransfer: Boolean = false,
    val maxFileSizeMb: Int = 50,
    val autoAcceptFiles: Boolean = false,
    // 备用地址（如对端的 Tailscale 100.x IP）：主地址连不上时按序轮试，
    // 让设备跨网段（不在同一局域网）时仍可通过 Tailscale 虚拟网连接
    val altHosts: List<String> = emptyList(),
    val networkId: String = "",
    val autoPaired: Boolean = false,
    val trustSourceId: String = "",
    val trustLevel: String = "",
    val acceptedAt: Long = 0L,
    val capabilities: String = "{}"
)

object DeviceStore {
    private const val TAG = "DeviceStore"
    private const val PREFS_NAME = "paired_desktop_devices"
    private const val KEY_DEVICES = "devices"
    private const val DESKTOP_WS_PORT = 19527
    private const val KEY_CLIPBOARD_IMAGE_POLICY_V3 = "clipboard_image_policy_v3"
    // 剪贴板策略 v2 一次性迁移标记：v1 存储里的 allowClipboard:false 是旧默认值
    // 而非用户选择，首次读取时统一翻转为新默认 true（此后用户的显式关闭原样保留）
    private const val KEY_CLIPBOARD_POLICY_V2 = "clipboard_policy_v2"
    private var lastKnownDevices: List<DesktopDevice>? = null

    private fun loadDevices(context: Context): List<DesktopDevice>? {
        val devices = mutableListOf<DesktopDevice>()

        try {
            // 加密存储读取（getString 会触发解密）与策略升级都要纳入 try：
            // Keystore 失效/加密数据损坏时会抛 SecurityException/AEADBadTagException，
            // 而 getDevices 在启动、路由刷新、拓扑广播等大量路径被调用，
            // 一旦这里未捕获就会反复崩溃。降级为返回空设备表远好过闪退。
            val preferences = prefs(context)
            if (!SecurePrefs.isStorageAvailable(preferences)) return null
            if (!ensureClipboardPolicyUpgrade(preferences)) return null
            val raw = preferences.getString(KEY_DEVICES, "[]") ?: "[]"
            val array = JSONArray(raw)
            for (i in 0 until array.length()) {
                val item = array.optJSONObject(i) ?: continue
                val host = item.optString("host").trim()
                val pairingKey = item.optString("pairingKey").trim()
                val routeMetric = item.optInt("routeMetric", 0)
                val routeNextHopId = item.optString("routeNextHopId").trim()
                val routeNextHopName = item.optString("routeNextHopName").trim()
                val routePath = jsonArrayToList(item.optJSONArray("routePath"))
                val altHosts = jsonArrayToList(item.optJSONArray("altHosts"))
                    .map { it.trim() }
                    .filter { it.isNotBlank() && it != host }
                    .distinct()
                val hasRoute = routeMetric > 0 || routeNextHopId.isNotBlank() || routePath.size > 1
                if (pairingKey.isBlank() || (host.isBlank() && altHosts.isEmpty() && !hasRoute)) continue

                val deviceType = item.optString("type", "WINDOWS_DESKTOP")
                devices.add(
                    DesktopDevice(
                        id = item.optString("id", UUID.randomUUID().toString()),
                        name = item.optString("name", host),
                        type = deviceType,
                        host = host,
                        port = normalizePortForType(deviceType, item.optInt("port", defaultPortForType(deviceType))),
                        pairingKey = pairingKey,
                        enabled = item.optBoolean("enabled", true),
                        revoked = item.optBoolean("revoked", false),
                        lastSyncAt = item.optLong("lastSyncAt", 0L),
                        connectionUpdatedAt = item.optLong("connectionUpdatedAt", 0L),
                        updatedAt = item.optLong("updatedAt", System.currentTimeMillis()),
                        routeMetric = routeMetric,
                        routeNextHopId = routeNextHopId,
                        routeNextHopName = routeNextHopName,
                        routePath = routePath,
                        routeUpdatedAt = item.optLong("routeUpdatedAt", 0L),
                        allowSmsCodes = item.optBoolean("allowSmsCodes", true),
                        allowSmsMessages = item.optBoolean("allowSmsMessages", true),
                        allowNotifications = item.optBoolean("allowNotifications", true),
                        allowTotp = item.optBoolean("allowTotp", true),
                        allowClipboard = item.optBoolean(
                            "allowClipboardText",
                            item.optBoolean("allowClipboard", true)
                        ),
                        allowClipboardImage = item.optBoolean(
                            "allowClipboardImage",
                            item.optBoolean("allowClipboard", true)
                        ),
                        allowClipboardFile = item.optBoolean("allowClipboardFile", false),
                        allowFileTransfer = item.optBoolean("allowFileTransfer", false),
                        maxFileSizeMb = item.optInt("maxFileSizeMb", 50).coerceIn(1, 512),
                        autoAcceptFiles = item.optBoolean("autoAcceptFiles", false),
                        altHosts = altHosts,
                        networkId = item.optString("networkId"),
                        autoPaired = item.optBoolean("autoPaired", false),
                        trustSourceId = item.optString("trustSourceId"),
                        trustLevel = item.optString("trustLevel"),
                        acceptedAt = item.optLong("acceptedAt", 0L),
                        capabilities = item.optString("capabilities", "{}").ifBlank { "{}" }
                    )
                )
            }
        } catch (error: Exception) {
            safeStorageLog(TAG, "Unable to decrypt/read device table; preserving encrypted data", error)
            return null
        }

        return devices.sortedByDescending { it.updatedAt }
    }

    @Synchronized
    fun getDevices(context: Context): List<DesktopDevice> {
        val loaded = loadDevices(context)
        if (loaded != null) lastKnownDevices = loaded
        return loaded ?: lastKnownDevices ?: emptyList()
    }

    fun getEnabledDevices(context: Context): List<DesktopDevice> =
        getDevices(context).filter { it.enabled && !it.revoked }

    fun findDevice(context: Context, id: String): DesktopDevice? =
        getDevices(context).firstOrNull { it.id == id }

    @Synchronized
    fun upsertDevice(
        context: Context,
        host: String,
        port: Int,
        pairingKey: String,
        name: String = "Desktop $host:$port",
        deviceId: String = "",
        deviceType: String = "WINDOWS_DESKTOP",
        routeMetric: Int = 0,
        routeNextHopId: String = "",
        routeNextHopName: String = "",
        routePath: List<String> = emptyList(),
        routeUpdatedAt: Long = 0L,
        altHosts: List<String> = emptyList(),
        networkId: String = "",
        autoPaired: Boolean = false,
        trustSourceId: String = "",
        trustLevel: String = "",
        acceptedAt: Long = 0L,
        capabilities: String = "{}",
        policyAllowSmsCodes: Boolean? = null,
        policyAllowSmsMessages: Boolean? = null,
        policyAllowNotifications: Boolean? = null,
        policyAllowTotp: Boolean? = null,
        policyAllowClipboard: Boolean? = null,
        policyAllowClipboardImage: Boolean? = null,
        policyAllowClipboardFile: Boolean? = null,
        policyAllowFileTransfer: Boolean? = null,
        policyMaxFileSizeMb: Int? = null,
        policyAutoAcceptFiles: Boolean? = null,
        revoked: Boolean? = null,
        // 「启用」开关归本机用户所有：null（默认）表示本次调用不改写已存值，
        // 仅新建条目时取 true。拓扑同步（topology_sync/gossip）必须用默认值，
        // 否则用户在本机禁用的推送目标会被任何一次同步悄悄重新启用；
        // 只有用户显式配对（扫码/局域网配对）才传 true 表达重新启用意图。
        enabled: Boolean? = null
    ): DesktopDevice {
        val loaded = loadDevices(context)
        if (loaded != null) lastKnownDevices = loaded
        val devices = (loaded ?: lastKnownDevices ?: emptyList()).toMutableList()
        val now = System.currentTimeMillis()
        val normalizedId = deviceId.ifBlank { "" }
        val normalizedType = deviceType.ifBlank { "WINDOWS_DESKTOP" }
        val normalizedPort = normalizePortForType(normalizedType, port)
        val index = devices.indexOfFirst {
            (normalizedId.isNotBlank() && it.id == normalizedId) ||
                (host.isNotBlank() && it.host == host && it.port == normalizedPort)
        }

        val device = if (index >= 0) {
            val existing = devices[index]
            val mergedHost = host.ifBlank { existing.host }
            // 路由新鲜度门（OSPF LSA 规则的简化版）：只有携带不早于已存时间戳的
            // 路由信息才允许覆盖路由字段。routeUpdatedAt=0 表示本次调用不携带路由
            // （配对/扫码等流程），完整保留原有路由。旧实现会把 routeMetric 无条件
            // 覆盖（含清零），且更陈旧的 topology_sync 也能覆盖较新的路由。
            val incomingRouteFresh = routeUpdatedAt > 0L && routeUpdatedAt >= existing.routeUpdatedAt
            existing.copy(
                id = normalizedId.ifBlank { existing.id },
                name = name.ifBlank { existing.name },
                type = normalizedType.ifBlank { existing.type },
                host = mergedHost,
                port = normalizedPort,
                pairingKey = pairingKey,
                enabled = enabled ?: existing.enabled,
                revoked = revoked ?: if (enabled == true) false else existing.revoked,
                lastSyncAt = existing.lastSyncAt,
                connectionUpdatedAt = existing.connectionUpdatedAt,
                updatedAt = now,
                routeMetric = if (incomingRouteFresh) routeMetric else existing.routeMetric,
                routeNextHopId = if (incomingRouteFresh) routeNextHopId else existing.routeNextHopId,
                routeNextHopName = if (incomingRouteFresh) routeNextHopName else existing.routeNextHopName,
                routePath = if (incomingRouteFresh) routePath else existing.routePath,
                routeUpdatedAt = if (incomingRouteFresh) routeUpdatedAt else existing.routeUpdatedAt,
                allowSmsCodes = existing.allowSmsCodes,
                allowSmsMessages = existing.allowSmsMessages,
                allowNotifications = existing.allowNotifications,
                allowTotp = existing.allowTotp,
                allowClipboard = existing.allowClipboard,
                allowClipboardImage = existing.allowClipboardImage,
                allowClipboardFile = existing.allowClipboardFile,
                allowFileTransfer = existing.allowFileTransfer,
                maxFileSizeMb = existing.maxFileSizeMb,
                autoAcceptFiles = existing.autoAcceptFiles,
                // 备用地址不参与新鲜度比较：本次没带就保留旧值（主地址变化时剔除重复）
                altHosts = (altHosts + existing.altHosts)
                    .filter { it.isNotBlank() && it != mergedHost }
                    .distinct(),
                networkId = networkId.ifBlank { existing.networkId },
                autoPaired = autoPaired || existing.autoPaired,
                trustSourceId = trustSourceId.ifBlank { existing.trustSourceId },
                trustLevel = trustLevel.ifBlank { existing.trustLevel },
                acceptedAt = acceptedAt.takeIf { it > 0L } ?: existing.acceptedAt,
                capabilities = capabilities.ifBlank { existing.capabilities }.ifBlank { "{}" }
            )
        } else {
            DesktopDevice(
                id = normalizedId.ifBlank { UUID.randomUUID().toString() },
                name = name,
                type = normalizedType,
                host = host,
                port = normalizedPort,
                pairingKey = pairingKey,
                enabled = enabled ?: true,
                revoked = revoked ?: false,
                lastSyncAt = 0L,
                connectionUpdatedAt = 0L,
                updatedAt = now,
                routeMetric = routeMetric,
                routeNextHopId = routeNextHopId,
                routeNextHopName = routeNextHopName,
                routePath = routePath,
                routeUpdatedAt = routeUpdatedAt,
                allowSmsCodes = policyAllowSmsCodes ?: true,
                allowSmsMessages = policyAllowSmsMessages ?: true,
                allowNotifications = policyAllowNotifications ?: true,
                allowTotp = policyAllowTotp ?: true,
                allowClipboard = policyAllowClipboard ?: true,
                allowClipboardImage = policyAllowClipboardImage ?: (policyAllowClipboard ?: true),
                allowClipboardFile = policyAllowClipboardFile ?: false,
                allowFileTransfer = policyAllowFileTransfer ?: false,
                maxFileSizeMb = (policyMaxFileSizeMb ?: 50).coerceIn(1, 512),
                autoAcceptFiles = policyAutoAcceptFiles ?: false,
                altHosts = altHosts.filter { it.isNotBlank() && it != host }.distinct(),
                networkId = networkId,
                autoPaired = autoPaired,
                trustSourceId = trustSourceId,
                trustLevel = trustLevel,
                acceptedAt = acceptedAt,
                capabilities = capabilities.ifBlank { "{}" }
            )
        }

        if (index >= 0) {
            if (!hasEffectiveDeviceChange(devices[index], device)) return devices[index]
            devices[index] = device
        } else {
            devices.add(device)
        }
        if (loaded != null) saveDevices(context, devices)
        return device
    }

    private fun defaultPortForType(type: String): Int =
        if (type.uppercase().contains("PHONE")) LanDiscovery.NODE_RELAY_PORT else DESKTOP_WS_PORT

    private fun normalizePortForType(type: String, port: Int): Int {
        val isPhone = type.uppercase().contains("PHONE")
        if (isPhone) return if (port > 0) port else LanDiscovery.NODE_RELAY_PORT
        return when {
            port <= 0 -> DESKTOP_WS_PORT
            port == LanDiscovery.NODE_RELAY_PORT -> DESKTOP_WS_PORT
            else -> port
        }
    }

    private fun hasEffectiveDeviceChange(old: DesktopDevice, next: DesktopDevice): Boolean {
        return old.id != next.id ||
            old.name != next.name ||
            old.type != next.type ||
            old.host != next.host ||
            old.port != next.port ||
            old.pairingKey != next.pairingKey ||
            old.enabled != next.enabled ||
            old.revoked != next.revoked ||
            old.routeMetric != next.routeMetric ||
            old.routeNextHopId != next.routeNextHopId ||
            old.routeNextHopName != next.routeNextHopName ||
            old.routePath != next.routePath ||
            old.routeUpdatedAt != next.routeUpdatedAt ||
            old.allowSmsCodes != next.allowSmsCodes ||
            old.allowSmsMessages != next.allowSmsMessages ||
            old.allowNotifications != next.allowNotifications ||
            old.allowTotp != next.allowTotp ||
            old.allowClipboard != next.allowClipboard ||
            old.allowClipboardImage != next.allowClipboardImage ||
            old.allowClipboardFile != next.allowClipboardFile ||
            old.allowFileTransfer != next.allowFileTransfer ||
            old.maxFileSizeMb != next.maxFileSizeMb ||
            old.autoAcceptFiles != next.autoAcceptFiles ||
            old.altHosts != next.altHosts ||
            old.networkId != next.networkId ||
            old.autoPaired != next.autoPaired ||
            old.trustSourceId != next.trustSourceId ||
            old.trustLevel != next.trustLevel ||
            old.acceptedAt != next.acceptedAt ||
            old.capabilities != next.capabilities
    }

    @Synchronized
    fun setDeviceEnabled(context: Context, id: String, enabled: Boolean) {
        val current = loadDevices(context) ?: return
        val devices = current.map {
            if (it.id == id) it.copy(enabled = enabled, updatedAt = System.currentTimeMillis()) else it
        }
        saveDevices(context, devices)
    }

    @Synchronized
    fun setDeviceContentPolicy(
        context: Context,
        id: String,
        allowSmsCodes: Boolean,
        allowSmsMessages: Boolean,
        allowNotifications: Boolean,
        allowTotp: Boolean,
        allowClipboard: Boolean,
        allowClipboardImage: Boolean? = null,
        allowClipboardFile: Boolean? = null,
        allowFileTransfer: Boolean? = null,
        maxFileSizeMb: Int? = null,
        autoAcceptFiles: Boolean? = null
    ) {
        val current = loadDevices(context) ?: return
        val devices = current.map {
            if (it.id == id) {
                it.copy(
                    allowSmsCodes = allowSmsCodes,
                    allowSmsMessages = allowSmsMessages,
                    allowNotifications = allowNotifications,
                    allowTotp = allowTotp,
                    allowClipboard = allowClipboard,
                    allowClipboardImage = allowClipboardImage ?: it.allowClipboardImage,
                    allowClipboardFile = allowClipboardFile ?: it.allowClipboardFile,
                    allowFileTransfer = allowFileTransfer ?: it.allowFileTransfer,
                    maxFileSizeMb = (maxFileSizeMb ?: it.maxFileSizeMb).coerceIn(1, 512),
                    autoAcceptFiles = autoAcceptFiles ?: it.autoAcceptFiles,
                    updatedAt = System.currentTimeMillis()
                )
            } else {
                it
            }
        }
        saveDevices(context, devices)
    }

    @Synchronized
    fun markDeviceSynced(context: Context, id: String, timestamp: Long = System.currentTimeMillis()) {
        val current = loadDevices(context) ?: return
        val devices = current.map {
            if (it.id == id) it.copy(lastSyncAt = timestamp) else it
        }
        saveDevices(context, devices)
    }

    @Synchronized
    fun markDeviceConnectionChanged(context: Context, id: String, timestamp: Long = System.currentTimeMillis()) {
        val current = loadDevices(context) ?: return
        val devices = current.map {
            if (it.id == id) it.copy(connectionUpdatedAt = timestamp) else it
        }
        saveDevices(context, devices)
    }

    /**
     * Promotes a previously stored candidate only after an authenticated exchange.
     * No trust, route, or content-policy field is reconstructed or overwritten.
     */
    @Synchronized
    fun promoteSuccessfulHost(context: Context, id: String, successfulHost: String): Boolean {
        val promoted = successfulHost.trim()
        if (id.isBlank() || promoted.isBlank()) return false
        val current = loadDevices(context) ?: return false
        val index = current.indexOfFirst { it.id == id }
        if (index < 0) return false
        val existing = current[index]
        val knownHosts = (listOf(existing.host) + existing.altHosts)
            .map { it.trim() }
            .filter { it.isNotBlank() }
            .distinct()
        if (promoted !in knownHosts) return false
        if (existing.host == promoted) return true

        val devices = current.toMutableList()
        devices[index] = existing.copy(
            host = promoted,
            altHosts = knownHosts.filter { it != promoted },
            updatedAt = System.currentTimeMillis()
        )
        return saveDevices(context, devices)
    }

    @Synchronized
    fun removeDevice(context: Context, id: String) {
        val current = loadDevices(context) ?: return
        saveDevices(context, current.filterNot { it.id == id })
    }

    @Synchronized
    fun rewriteNetworkId(context: Context, targetNetworkId: String, mergeFromNetworkIds: List<String>) {
        val target = targetNetworkId.trim()
        if (target.isBlank()) return
        val mergeFrom = mergeFromNetworkIds.map { it.trim() }.filter { it.isNotBlank() && it != target }.toSet()
        val currentDevices = loadDevices(context) ?: return
        val devices = currentDevices.map { device ->
            val current = device.networkId.trim()
            if (current.isBlank() || current == target || current in mergeFrom) {
                device.copy(networkId = target, updatedAt = System.currentTimeMillis())
            } else {
                device
            }
        }
        saveDevices(context, devices)
    }

    private fun saveDevices(context: Context, devices: List<DesktopDevice>): Boolean {
        val array = JSONArray()
        devices.forEach { device ->
            array.put(
                JSONObject()
                    .put("id", device.id)
                    .put("name", device.name)
                    .put("type", device.type)
                    .put("host", device.host)
                    .put("port", device.port)
                    .put("pairingKey", device.pairingKey)
                    .put("enabled", device.enabled)
                    .put("revoked", device.revoked)
                    .put("lastSyncAt", device.lastSyncAt)
                    .put("connectionUpdatedAt", device.connectionUpdatedAt)
                    .put("updatedAt", device.updatedAt)
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
                    .put("allowClipboardText", device.allowClipboard)
                    .put("allowClipboardImage", device.allowClipboardImage)
                    .put("allowClipboardFile", device.allowClipboardFile)
                    .put("allowFileTransfer", device.allowFileTransfer)
                    .put("maxFileSizeMb", device.maxFileSizeMb)
                    .put("autoAcceptFiles", device.autoAcceptFiles)
                    .put("altHosts", JSONArray(device.altHosts))
                    .put("networkId", device.networkId)
                    .put("autoPaired", device.autoPaired)
                    .put("trustSourceId", device.trustSourceId)
                    .put("trustLevel", device.trustLevel)
                    .put("acceptedAt", device.acceptedAt)
                    .put("capabilities", device.capabilities)
            )
        }
        val preferences = prefs(context)
        if (!SecurePrefs.isStorageAvailable(preferences)) return false
        val committed = runCatching {
            preferences.edit().putString(KEY_DEVICES, array.toString()).commit()
        }.onFailure { safeStorageLog(TAG, "Unable to persist encrypted device table", it) }
            .getOrDefault(false)
        if (committed) lastKnownDevices = devices.sortedByDescending { it.updatedAt }
        return committed
    }

    private fun jsonArrayToList(array: JSONArray?): List<String> {
        if (array == null) return emptyList()
        return (0 until array.length()).mapNotNull {
            array.optString(it).takeIf { value -> value.isNotBlank() }
        }
    }

    /** v1→v2：把存量设备的 allowClipboard 统一翻转为 true（详见 KEY_CLIPBOARD_POLICY_V2）。 */
    private fun ensureClipboardPolicyUpgrade(p: android.content.SharedPreferences): Boolean {
        return runCatching {
            val needsTextUpgrade = !p.getBoolean(KEY_CLIPBOARD_POLICY_V2, false)
            val needsImageUpgrade = !p.getBoolean(KEY_CLIPBOARD_IMAGE_POLICY_V3, false)
            if (!needsTextUpgrade && !needsImageUpgrade) return@runCatching true
            val raw = p.getString(KEY_DEVICES, "[]") ?: "[]"
            val array = JSONArray(raw)
            for (i in 0 until array.length()) {
                val item = array.optJSONObject(i) ?: continue
                if (needsTextUpgrade) item.put("allowClipboard", true)
                if (needsImageUpgrade &&
                    item.optBoolean("allowClipboard", true) &&
                    !item.optBoolean("allowClipboardImage", false)
                ) {
                    item.put("allowClipboardImage", true)
                }
            }
            p.edit()
                .putString(KEY_DEVICES, array.toString())
                .putBoolean(KEY_CLIPBOARD_POLICY_V2, true)
                .putBoolean(KEY_CLIPBOARD_IMAGE_POLICY_V3, true)
                .commit()
        }.onFailure {
            safeStorageLog(TAG, "Unable to read/upgrade encrypted device policy; preserving source", it)
        }.getOrDefault(false)
    }

    // 设备表里存有各对端的配对密钥，走加密存储（SecurePrefs 自动迁移旧明文数据）
    private fun prefs(context: Context) = SecurePrefs.get(context, PREFS_NAME)
}
