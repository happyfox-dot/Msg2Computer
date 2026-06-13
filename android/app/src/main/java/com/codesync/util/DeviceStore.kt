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
    val lastSyncAt: Long,
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
    private const val PREFS_NAME = "paired_desktop_devices"
    private const val KEY_DEVICES = "devices"
    private const val KEY_CLIPBOARD_IMAGE_POLICY_V3 = "clipboard_image_policy_v3"
    // 剪贴板策略 v2 一次性迁移标记：v1 存储里的 allowClipboard:false 是旧默认值
    // 而非用户选择，首次读取时统一翻转为新默认 true（此后用户的显式关闭原样保留）
    private const val KEY_CLIPBOARD_POLICY_V2 = "clipboard_policy_v2"

    fun getDevices(context: Context): List<DesktopDevice> {
        ensureClipboardPolicyUpgrade(context)
        val raw = prefs(context).getString(KEY_DEVICES, "[]") ?: "[]"
        val devices = mutableListOf<DesktopDevice>()

        try {
            val array = JSONArray(raw)
            for (i in 0 until array.length()) {
                val item = array.optJSONObject(i) ?: continue
                val host = item.optString("host")
                val pairingKey = item.optString("pairingKey")
                if (host.isBlank() || pairingKey.isBlank()) continue

                devices.add(
                    DesktopDevice(
                        id = item.optString("id", UUID.randomUUID().toString()),
                        name = item.optString("name", host),
                        type = item.optString("type", "WINDOWS_DESKTOP"),
                        host = host,
                        port = item.optInt("port", 19527),
                        pairingKey = pairingKey,
                        enabled = item.optBoolean("enabled", true),
                        lastSyncAt = item.optLong("lastSyncAt", 0L),
                        updatedAt = item.optLong("updatedAt", System.currentTimeMillis()),
                        routeMetric = item.optInt("routeMetric", 0),
                        routeNextHopId = item.optString("routeNextHopId"),
                        routeNextHopName = item.optString("routeNextHopName"),
                        routePath = jsonArrayToList(item.optJSONArray("routePath")),
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
                        altHosts = jsonArrayToList(item.optJSONArray("altHosts")),
                        networkId = item.optString("networkId"),
                        autoPaired = item.optBoolean("autoPaired", false),
                        trustSourceId = item.optString("trustSourceId"),
                        trustLevel = item.optString("trustLevel"),
                        acceptedAt = item.optLong("acceptedAt", 0L),
                        capabilities = item.optString("capabilities", "{}").ifBlank { "{}" }
                    )
                )
            }
        } catch (_: Exception) {
            return emptyList()
        }

        return devices.sortedByDescending { it.updatedAt }
    }

    fun getEnabledDevices(context: Context): List<DesktopDevice> =
        getDevices(context).filter { it.enabled }

    fun findDevice(context: Context, id: String): DesktopDevice? =
        getDevices(context).firstOrNull { it.id == id }

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
        // 「启用」开关归本机用户所有：null（默认）表示本次调用不改写已存值，
        // 仅新建条目时取 true。拓扑同步（topology_sync/gossip）必须用默认值，
        // 否则用户在本机禁用的推送目标会被任何一次同步悄悄重新启用；
        // 只有用户显式配对（扫码/局域网配对）才传 true 表达重新启用意图。
        enabled: Boolean? = null
    ): DesktopDevice {
        val devices = getDevices(context).toMutableList()
        val now = System.currentTimeMillis()
        val normalizedId = deviceId.ifBlank { "" }
        val index = devices.indexOfFirst {
            (normalizedId.isNotBlank() && it.id == normalizedId) || (it.host == host && it.port == port)
        }

        val device = if (index >= 0) {
            val existing = devices[index]
            // 路由新鲜度门（OSPF LSA 规则的简化版）：只有携带不早于已存时间戳的
            // 路由信息才允许覆盖路由字段。routeUpdatedAt=0 表示本次调用不携带路由
            // （配对/扫码等流程），完整保留原有路由。旧实现会把 routeMetric 无条件
            // 覆盖（含清零），且更陈旧的 topology_sync 也能覆盖较新的路由。
            val incomingRouteFresh = routeUpdatedAt > 0L && routeUpdatedAt >= existing.routeUpdatedAt
            existing.copy(
                id = normalizedId.ifBlank { existing.id },
                name = name.ifBlank { existing.name },
                type = deviceType.ifBlank { existing.type },
                host = host,
                port = port,
                pairingKey = pairingKey,
                enabled = enabled ?: existing.enabled,
                lastSyncAt = existing.lastSyncAt,
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
                altHosts = altHosts.ifEmpty { existing.altHosts }.filter { it.isNotBlank() && it != host }.distinct(),
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
                type = deviceType.ifBlank { "WINDOWS_DESKTOP" },
                host = host,
                port = port,
                pairingKey = pairingKey,
                enabled = enabled ?: true,
                lastSyncAt = 0L,
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
            devices[index] = device
        } else {
            devices.add(device)
        }
        saveDevices(context, devices)
        return device
    }

    fun setDeviceEnabled(context: Context, id: String, enabled: Boolean) {
        val devices = getDevices(context).map {
            if (it.id == id) it.copy(enabled = enabled, updatedAt = System.currentTimeMillis()) else it
        }
        saveDevices(context, devices)
    }

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
        val devices = getDevices(context).map {
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

    fun markDeviceSynced(context: Context, id: String, timestamp: Long = System.currentTimeMillis()) {
        val devices = getDevices(context).map {
            if (it.id == id) it.copy(lastSyncAt = timestamp) else it
        }
        saveDevices(context, devices)
    }

    fun removeDevice(context: Context, id: String) {
        saveDevices(context, getDevices(context).filterNot { it.id == id })
    }

    private fun saveDevices(context: Context, devices: List<DesktopDevice>) {
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
                    .put("lastSyncAt", device.lastSyncAt)
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
        prefs(context).edit().putString(KEY_DEVICES, array.toString()).apply()
    }

    private fun jsonArrayToList(array: JSONArray?): List<String> {
        if (array == null) return emptyList()
        return (0 until array.length()).mapNotNull {
            array.optString(it).takeIf { value -> value.isNotBlank() }
        }
    }

    /** v1→v2：把存量设备的 allowClipboard 统一翻转为 true（详见 KEY_CLIPBOARD_POLICY_V2）。 */
    private fun ensureClipboardPolicyUpgrade(context: Context) {
        val p = prefs(context)
        val needsTextUpgrade = !p.getBoolean(KEY_CLIPBOARD_POLICY_V2, false)
        val needsImageUpgrade = !p.getBoolean(KEY_CLIPBOARD_IMAGE_POLICY_V3, false)
        if (!needsTextUpgrade && !needsImageUpgrade) return
        val raw = p.getString(KEY_DEVICES, "[]") ?: "[]"
        runCatching {
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
                .apply()
        }.onFailure {
            p.edit()
                .putBoolean(KEY_CLIPBOARD_POLICY_V2, true)
                .putBoolean(KEY_CLIPBOARD_IMAGE_POLICY_V3, true)
                .apply()
        }
    }

    // 设备表里存有各对端的配对密钥，走加密存储（SecurePrefs 自动迁移旧明文数据）
    private fun prefs(context: Context) = SecurePrefs.get(context, PREFS_NAME)
}
