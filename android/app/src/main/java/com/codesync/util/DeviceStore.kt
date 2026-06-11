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
    // 备用地址（如对端的 Tailscale 100.x IP）：主地址连不上时按序轮试，
    // 让设备跨网段（不在同一局域网）时仍可通过 Tailscale 虚拟网连接
    val altHosts: List<String> = emptyList()
)

object DeviceStore {
    private const val PREFS_NAME = "paired_desktop_devices"
    private const val KEY_DEVICES = "devices"

    fun getDevices(context: Context): List<DesktopDevice> {
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
                        altHosts = jsonArrayToList(item.optJSONArray("altHosts"))
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
        enabled: Boolean = true
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
                enabled = enabled,
                lastSyncAt = existing.lastSyncAt,
                updatedAt = now,
                routeMetric = if (incomingRouteFresh) routeMetric else existing.routeMetric,
                routeNextHopId = if (incomingRouteFresh) routeNextHopId else existing.routeNextHopId,
                routeNextHopName = if (incomingRouteFresh) routeNextHopName else existing.routeNextHopName,
                routePath = if (incomingRouteFresh) routePath else existing.routePath,
                routeUpdatedAt = if (incomingRouteFresh) routeUpdatedAt else existing.routeUpdatedAt,
                // 备用地址不参与新鲜度比较：本次没带就保留旧值（主地址变化时剔除重复）
                altHosts = altHosts.ifEmpty { existing.altHosts }.filter { it.isNotBlank() && it != host }.distinct()
            )
        } else {
            DesktopDevice(
                id = normalizedId.ifBlank { UUID.randomUUID().toString() },
                name = name,
                type = deviceType.ifBlank { "WINDOWS_DESKTOP" },
                host = host,
                port = port,
                pairingKey = pairingKey,
                enabled = enabled,
                lastSyncAt = 0L,
                updatedAt = now,
                routeMetric = routeMetric,
                routeNextHopId = routeNextHopId,
                routeNextHopName = routeNextHopName,
                routePath = routePath,
                routeUpdatedAt = routeUpdatedAt,
                altHosts = altHosts.filter { it.isNotBlank() && it != host }.distinct()
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

    fun markDeviceSynced(context: Context, id: String, timestamp: Long = System.currentTimeMillis()) {
        val devices = getDevices(context).map {
            if (it.id == id) it.copy(lastSyncAt = timestamp, updatedAt = System.currentTimeMillis()) else it
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
                    .put("altHosts", JSONArray(device.altHosts))
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

    // 设备表里存有各对端的配对密钥，走加密存储（SecurePrefs 自动迁移旧明文数据）
    private fun prefs(context: Context) = SecurePrefs.get(context, PREFS_NAME)
}
