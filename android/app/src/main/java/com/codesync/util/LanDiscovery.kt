package com.codesync.util

import android.content.Context
import android.net.wifi.WifiManager
import org.json.JSONObject
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.NetworkInterface
import java.net.SocketTimeoutException

data class LanDiscoveredDevice(
    val id: String,
    val name: String,
    val type: String,
    val host: String,
    val port: Int,
    val pairingKey: String,
    val discoveredAt: Long = System.currentTimeMillis()
)

object LanDiscovery {
    private const val DISCOVERY_PORT = 19528
    private const val WS_PORT = 19527
    const val NODE_RELAY_PORT = 19529
    private const val DISCOVERY_PROTOCOL = "codebridge-lan-discovery"

    /** Tailscale 给每台设备分配的虚拟 IP 固定落在 CGNAT 段 100.64.0.0/10。 */
    fun isTailscaleAddress(host: String): Boolean {
        val parts = host.trim().split(".")
        if (parts.size != 4) return false
        val first = parts[0].toIntOrNull() ?: return false
        val second = parts[1].toIntOrNull() ?: return false
        return first == 100 && second in 64..127
    }

    /** 本机的 Tailscale IPv4；未安装/未登录 Tailscale 时返回空串。 */
    fun localTailscaleHost(): String {
        val interfaces = runCatching { NetworkInterface.getNetworkInterfaces()?.toList() }
            .getOrNull()
            .orEmpty()
        for (networkInterface in interfaces) {
            if (!networkInterface.isUp || networkInterface.isLoopback) continue
            for (interfaceAddress in networkInterface.interfaceAddresses.orEmpty()) {
                val host = interfaceAddress.address?.hostAddress ?: continue
                if (isTailscaleAddress(host)) return host
            }
        }
        return ""
    }

    fun discover(context: Context, timeoutMs: Int = 2500): List<LanDiscoveredDevice> {
        val socket = DatagramSocket().apply {
            broadcast = true
            soTimeout = 300
        }
        val multicastLock = acquireMulticastLock(context)
        val devices = linkedMapOf<String, LanDiscoveredDevice>()
        val localIdentity = PhoneIdentityStore.get(context)

        try {
            sendProbe(context, socket)
            val deadline = System.currentTimeMillis() + timeoutMs
            val buffer = ByteArray(8192)

            while (System.currentTimeMillis() < deadline) {
                val remaining = (deadline - System.currentTimeMillis()).coerceAtLeast(100L)
                socket.soTimeout = remaining.coerceAtMost(500L).toInt()

                try {
                    val packet = DatagramPacket(buffer, buffer.size)
                    socket.receive(packet)
                    val raw = String(packet.data, packet.offset, packet.length, Charsets.UTF_8)
                    val payload = JSONObject(raw)
                    if (payload.optString("type") == "codebridge_discovery_probe") {
                        sendPhoneResponse(context, socket, packet.address, packet.port)
                    }
                    val device = parseDevice(payload, packet.address?.hostAddress.orEmpty(), localIdentity.id)
                        ?: continue
                    devices[device.id] = device
                } catch (_: SocketTimeoutException) {
                    // Continue until the overall discovery window expires.
                }
            }
        } finally {
            runCatching { multicastLock?.release() }
            socket.close()
        }

        return devices.values
            .sortedWith(compareBy<LanDiscoveredDevice> { it.name.lowercase() }.thenBy { it.host })
    }

    fun respondToProbes(context: Context, keepRunning: () -> Boolean) {
        val socket = DatagramSocket(null).apply {
            reuseAddress = true
            soTimeout = 500
            bind(InetSocketAddress(DISCOVERY_PORT))
        }
        val multicastLock = acquireMulticastLock(context)
        val localIdentity = PhoneIdentityStore.get(context)
        val buffer = ByteArray(8192)

        try {
            while (keepRunning()) {
                try {
                    val packet = DatagramPacket(buffer, buffer.size)
                    socket.receive(packet)
                    val raw = String(packet.data, packet.offset, packet.length, Charsets.UTF_8)
                    val payload = JSONObject(raw)
                    if (
                        payload.optString("protocol") == DISCOVERY_PROTOCOL &&
                        payload.optString("type") == "codebridge_discovery_probe" &&
                        payload.optString("deviceId", payload.optString("id", "")) != localIdentity.id
                    ) {
                        sendPhoneResponse(context, socket, packet.address, packet.port)
                    }
                } catch (_: SocketTimeoutException) {
                    // Keep listening while the activity is in foreground.
                } catch (_: Exception) {
                    // Ignore malformed packets and continue responding to valid probes.
                }
            }
        } finally {
            runCatching { multicastLock?.release() }
            socket.close()
        }
    }

    private fun sendProbe(context: Context, socket: DatagramSocket) {
        val identity = PhoneIdentityStore.get(context)
        // 安全要求：发现包绝不携带配对密钥（pairingKey 只通过二维码或已建立的加密通道交换），
        // 否则同网段任何人都能抓包拿到密钥并伪造中继/鉴权
        val payload = JSONObject()
            .put("type", "codebridge_discovery_probe")
            .put("protocol", DISCOVERY_PROTOCOL)
            .put("version", 1)
            .put("deviceId", identity.id)
            .put("id", identity.id)
            .put("deviceName", identity.name)
            .put("name", identity.name)
            .put("deviceType", "ANDROID_PHONE")
            .put("host", "")
            .put("port", NODE_RELAY_PORT)
            .put("topologyRole", "peer")
            .put("timestamp", System.currentTimeMillis())
        val bytes = payload.toString().toByteArray(Charsets.UTF_8)

        for (address in getBroadcastAddresses()) {
            runCatching {
                val packet = DatagramPacket(bytes, bytes.size, address, DISCOVERY_PORT)
                socket.send(packet)
            }
        }
    }

    private fun sendPhoneResponse(
        context: Context,
        socket: DatagramSocket,
        target: InetAddress?,
        targetPort: Int
    ) {
        if (target == null) return
        val port = targetPort.takeIf { it > 0 } ?: DISCOVERY_PORT
        val identity = PhoneIdentityStore.get(context)
        // 同 sendProbe：响应包只暴露身份与地址，不携带配对密钥
        val payload = JSONObject()
            .put("type", "codebridge_discovery_response")
            .put("protocol", DISCOVERY_PROTOCOL)
            .put("version", 1)
            .put("deviceId", identity.id)
            .put("id", identity.id)
            .put("deviceName", identity.name)
            .put("name", identity.name)
            .put("deviceType", "ANDROID_PHONE")
            .put("host", "")
            .put("port", NODE_RELAY_PORT)
            .put("topologyRole", "peer")
            .put("timestamp", System.currentTimeMillis())
        val bytes = payload.toString().toByteArray(Charsets.UTF_8)
        runCatching {
            socket.send(DatagramPacket(bytes, bytes.size, target, port))
        }
    }

    private fun parseDevice(payload: JSONObject, remoteAddress: String, localId: String): LanDiscoveredDevice? {
        if (payload.optString("protocol") != DISCOVERY_PROTOCOL) return null

        val deviceType = payload.optString("deviceType", payload.optString("type", ""))
            .uppercase()
        if (!deviceType.contains("DESKTOP") && !deviceType.contains("PHONE")) return null

        // 新版节点的发现包不再携带配对密钥（pairingKey 为空 → 界面提示需扫码配对）；
        // 仍解析旧版节点广播的密钥字段以保持兼容
        val pairingKey = payload.optString("pairingKey", payload.optString("pk", "")).trim()

        val id = payload.optString("deviceId", payload.optString("id", "")).trim()
        if (id.isBlank() || id == localId) return null

        val host = remoteAddress.ifBlank { payload.optString("host", "").trim() }
        val port = payload.optInt("port", WS_PORT)

        if (host.isBlank()) return null

        return LanDiscoveredDevice(
            id = id,
            name = payload.optString("deviceName", payload.optString("name", "Device $host"))
                .trim()
                .ifBlank { "Device $host" },
            type = deviceType,
            host = host,
            port = if (port > 0) port else WS_PORT,
            pairingKey = pairingKey
        )
    }

    private fun getBroadcastAddresses(): List<InetAddress> {
        val addresses = linkedSetOf<InetAddress>()
        runCatching { addresses.add(InetAddress.getByName("255.255.255.255")) }

        val interfaces = runCatching { NetworkInterface.getNetworkInterfaces()?.toList() }
            .getOrNull()
            .orEmpty()
        for (networkInterface in interfaces) {
            if (!networkInterface.isUp || networkInterface.isLoopback) continue
            for (interfaceAddress in networkInterface.interfaceAddresses.orEmpty()) {
                val broadcast = interfaceAddress.broadcast ?: continue
                addresses.add(broadcast)
            }
        }

        return addresses.toList()
    }

    private fun acquireMulticastLock(context: Context): WifiManager.MulticastLock? {
        val wifiManager = context.applicationContext
            .getSystemService(Context.WIFI_SERVICE) as? WifiManager
        return runCatching {
            wifiManager?.createMulticastLock("CodeSync:LanDiscovery")?.apply {
                setReferenceCounted(false)
                acquire()
            }
        }.getOrNull()
    }
}
