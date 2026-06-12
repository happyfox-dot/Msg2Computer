package com.codesync.util

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.io.OutputStreamWriter
import java.net.HttpURLConnection
import java.net.NetworkInterface
import java.net.URL

object LanJoinClient {
    data class JoinResult(
        val success: Boolean,
        val rejected: Boolean = false,
        val device: DesktopDevice? = null,
        val error: String = ""
    )

    fun requestJoin(context: Context, target: LanDiscoveredDevice, template: String = "basic"): JoinResult {
        if (target.joinPublicKey.isBlank()) {
            return JoinResult(success = false, error = "missing_join_public_key")
        }
        val identity = PhoneIdentityStore.get(context)
        val requestId = "join-${System.currentTimeMillis()}-${CryptoUtil.generateNonce().take(8)}"
        val requestKey = LanJoinCrypto.createRequestKey(target.joinPublicKey)
        val payload = JSONObject()
            .put("nodePairingKey", identity.pairingKey)
            .put("requestedContentPolicy", contentPolicy(template))
            .put("networkId", LanTrustStore.getNetworkId(context))
            .put("topologySnapshot", TopologyStore.buildDelta(context, reason = "lan_join_request_snapshot"))
            .put("node", localNodeProfile(context))

        val body = JSONObject()
            .put("type", "join_request")
            .put("protocol", "codebridge-lan-discovery")
            .put("version", 1)
            .put("requestId", requestId)
            .put("nodeId", identity.id)
            .put("nodeName", identity.name)
            .put("nodeType", "ANDROID_PHONE")
            .put("host", localHostForJoin())
            .put("port", LanDiscovery.NODE_RELAY_PORT)
            .put("joinPort", LanDiscovery.NODE_RELAY_PORT)
            .put("capabilities", capabilities())
            .put("ephemeralPublicKey", requestKey.ephemeralPublicKey)
            .put("fingerprint", LanJoinCrypto.fingerprint(context))
            .put("payload", CryptoUtil.encrypt(payload.toString(), requestKey.sessionKey))

        val response = postJson(target.host, target.joinPort, body)
        if (response.optString("type") == "join_reject") {
            return JoinResult(success = false, rejected = true, error = response.optString("reason", "join_rejected"))
        }
        if (response.optString("type") != "join_accept") {
            return JoinResult(success = false, error = "invalid_join_accept")
        }
        val plain = CryptoUtil.decrypt(response.optString("payload"), requestKey.sessionKey)
        val accept = JSONObject(plain)
        val networkId = accept.optString("networkId")
        LanTrustStore.adoptNetworkId(context, networkId)

        val node = accept.optJSONObject("node") ?: JSONObject()
            .put("id", target.id)
            .put("name", target.name)
            .put("type", target.type)
            .put("host", target.host)
            .put("port", target.port)
        val acceptedAt = accept.optLong("acceptedAt", System.currentTimeMillis())
        val pairingKey = accept.optString("nodePairingKey")
        if (pairingKey.isBlank()) return JoinResult(success = false, error = "missing_pairing_key")

        val device = DeviceStore.upsertDevice(
            context = context,
            host = node.optString("host", target.host).ifBlank { target.host },
            port = node.optInt("port", target.port),
            pairingKey = pairingKey,
            name = node.optString("name", target.name).ifBlank { target.name },
            deviceId = node.optString("id", target.id).ifBlank { target.id },
            deviceType = node.optString("type", target.type).ifBlank { target.type },
            altHosts = listOfNotNull(node.optString("tsHost").takeIf { it.isNotBlank() }),
            networkId = networkId,
            autoPaired = true,
            trustSourceId = accept.optString("acceptedByNodeId", node.optString("id", target.id)),
            trustLevel = "trusted_lan",
            acceptedAt = acceptedAt,
            capabilities = node.optJSONObject("capabilities")?.toString().orEmpty(),
            enabled = true
        )
        applyContentPolicy(context, device.id, accept.optJSONObject("initialContentPolicy"))
        val updatedDevice = DeviceStore.findDevice(context, device.id) ?: device
        TopologyStore.markDeviceState(context, updatedDevice, enabled = true)
        accept.optJSONObject("topologySnapshot")?.let {
            TopologyStore.applyDelta(context, it)
        }
        return JoinResult(success = true, device = updatedDevice)
    }

    fun contentPolicy(template: String): JSONObject {
        val normalized = template.trim().lowercase()
        return when (normalized) {
            "topology_only" -> JSONObject()
                .put("allowSmsCodes", false)
                .put("allowSmsMessages", false)
                .put("allowNotifications", false)
                .put("allowTotp", false)
                .put("allowClipboard", false)
                .put("allowClipboardText", false)
                .put("allowClipboardImage", false)
                .put("allowClipboardFile", false)
                .put("allowFileTransfer", false)
                .put("maxFileSizeMb", 50)
                .put("autoAcceptFiles", false)
            "full" -> JSONObject()
                .put("allowSmsCodes", true)
                .put("allowSmsMessages", true)
                .put("allowNotifications", true)
                .put("allowTotp", true)
                .put("allowClipboard", true)
                .put("allowClipboardText", true)
                .put("allowClipboardImage", true)
                .put("allowClipboardFile", true)
                .put("allowFileTransfer", true)
                .put("maxFileSizeMb", 50)
                .put("autoAcceptFiles", false)
                .put("allowFiles", true)
                .put("allowImages", true)
            else -> JSONObject()
                .put("allowSmsCodes", true)
                .put("allowSmsMessages", false)
                .put("allowNotifications", false)
                .put("allowTotp", true)
                .put("allowClipboard", false)
                .put("allowClipboardText", false)
                .put("allowClipboardImage", false)
                .put("allowClipboardFile", false)
                .put("allowFileTransfer", false)
                .put("maxFileSizeMb", 50)
                .put("autoAcceptFiles", false)
        }
    }

    fun localNodeProfile(context: Context): JSONObject {
        val identity = PhoneIdentityStore.get(context)
        return JSONObject()
            .put("id", identity.id)
            .put("deviceId", identity.id)
            .put("name", identity.name)
            .put("deviceName", identity.name)
            .put("type", "ANDROID_PHONE")
            .put("deviceType", "ANDROID_PHONE")
            .put("host", localHostForJoin())
            .put("port", LanDiscovery.NODE_RELAY_PORT)
            .put("joinPort", LanDiscovery.NODE_RELAY_PORT)
            .put("relayPort", LanDiscovery.NODE_RELAY_PORT)
            .put("tsHost", LanDiscovery.localTailscaleHost())
            .put("networkId", LanTrustStore.getNetworkId(context))
            .put("autoPaired", false)
            .put("trustSourceId", identity.id)
            .put("trustLevel", "local")
            .put("acceptedAt", System.currentTimeMillis())
            .put("capabilities", capabilities())
    }

    fun capabilities(): JSONObject =
        JSONObject()
            .put("topology", true)
            .put("relay", true)
            .put("sms", true)
            .put("totp", true)
            .put("clipboardText", true)
            .put("clipboardImage", true)
            .put("clipboardFile", false)
            .put("fileTransfer", false)
            .put("joinRequest", true)

    fun applyContentPolicy(context: Context, deviceId: String, policy: JSONObject?) {
        if (policy == null) return
        DeviceStore.setDeviceContentPolicy(
            context = context,
            id = deviceId,
            allowSmsCodes = policy.optBoolean("allowSmsCodes", true),
            allowSmsMessages = policy.optBoolean("allowSmsMessages", false),
            allowNotifications = policy.optBoolean("allowNotifications", false),
            allowTotp = policy.optBoolean("allowTotp", true),
            allowClipboard = policy.optBoolean(
                "allowClipboardText",
                policy.optBoolean("allowClipboard", false)
            ),
            allowClipboardImage = policy.optBoolean(
                "allowClipboardImage",
                policy.optBoolean("allowImages", false)
            ),
            allowClipboardFile = policy.optBoolean(
                "allowClipboardFile",
                policy.optBoolean("allowFiles", false)
            ),
            allowFileTransfer = policy.optBoolean(
                "allowFileTransfer",
                policy.optBoolean("allowFiles", false)
            ),
            maxFileSizeMb = policy.optInt("maxFileSizeMb", 50),
            autoAcceptFiles = policy.optBoolean("autoAcceptFiles", false)
        )
    }

    private fun postJson(host: String, port: Int, body: JSONObject): JSONObject {
        val url = URL("http://$host:$port/join")
        val connection = (url.openConnection() as HttpURLConnection).apply {
            requestMethod = "POST"
            connectTimeout = 15000
            readTimeout = 90000
            doOutput = true
            setRequestProperty("Content-Type", "application/json")
        }
        OutputStreamWriter(connection.outputStream, Charsets.UTF_8).use {
            it.write(body.toString())
        }
        val stream = if (connection.responseCode in 200..299) {
            connection.inputStream
        } else {
            connection.errorStream ?: connection.inputStream
        }
        val text = stream.bufferedReader(Charsets.UTF_8).use { it.readText() }
        if (connection.responseCode !in 200..299) {
            throw IllegalStateException(JSONObject(text.ifBlank { "{}" }).optString("reason", "http_${connection.responseCode}"))
        }
        return JSONObject(text.ifBlank { "{}" })
    }

    private fun localHostForJoin(): String {
        val tailscale = LanDiscovery.localTailscaleHost()
        if (tailscale.isNotBlank()) return tailscale
        val interfaces = runCatching { NetworkInterface.getNetworkInterfaces()?.toList() }
            .getOrNull()
            .orEmpty()
        for (networkInterface in interfaces) {
            if (!networkInterface.isUp || networkInterface.isLoopback) continue
            for (address in networkInterface.inetAddresses.toList()) {
                val host = address.hostAddress ?: continue
                if (!address.isLoopbackAddress && host.count { it == '.' } == 3) return host
            }
        }
        return ""
    }

    private fun listOfNotNull(value: String?): List<String> =
        if (value.isNullOrBlank()) emptyList() else listOf(value)
}
