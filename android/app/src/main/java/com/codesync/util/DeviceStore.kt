package com.codesync.util

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

data class DesktopDevice(
    val id: String,
    val name: String,
    val host: String,
    val port: Int,
    val pairingKey: String,
    val enabled: Boolean,
    val updatedAt: Long
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
                        host = host,
                        port = item.optInt("port", 19527),
                        pairingKey = pairingKey,
                        enabled = item.optBoolean("enabled", true),
                        updatedAt = item.optLong("updatedAt", System.currentTimeMillis())
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
        name: String = "Desktop $host:$port"
    ): DesktopDevice {
        val devices = getDevices(context).toMutableList()
        val now = System.currentTimeMillis()
        val index = devices.indexOfFirst { it.host == host && it.port == port }

        val device = if (index >= 0) {
            devices[index].copy(
                name = name.ifBlank { devices[index].name },
                pairingKey = pairingKey,
                enabled = true,
                updatedAt = now
            )
        } else {
            DesktopDevice(
                id = UUID.randomUUID().toString(),
                name = name,
                host = host,
                port = port,
                pairingKey = pairingKey,
                enabled = true,
                updatedAt = now
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
                    .put("host", device.host)
                    .put("port", device.port)
                    .put("pairingKey", device.pairingKey)
                    .put("enabled", device.enabled)
                    .put("updatedAt", device.updatedAt)
            )
        }
        prefs(context).edit().putString(KEY_DEVICES, array.toString()).apply()
    }

    private fun prefs(context: Context) =
        context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
}
