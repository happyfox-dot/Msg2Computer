package com.codesync.util

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.security.MessageDigest

object ContentBus {
    const val BUS_VERSION = 1

    // codebridge_bus 重放窗口：sentAt 纳入 HMAC，超窗整包拒收。与 relay 的
    // relaySentAt 不同，bus 协议没有旧版发送端，sentAt 缺失直接拒绝而非跳过。
    private const val BUS_REPLAY_WINDOW_MS = 5 * 60 * 1000L
    private const val BUS_NONCE_LIMIT_PER_SENDER = 300
    private val recentBusNonces = mutableMapOf<String, LinkedHashMap<String, Long>>()

    object Topic {
        const val TOPOLOGY_DELTA = "topology.delta"
        const val SMS_CODE = "sms.code"
        const val SMS_RAW = "sms.raw"
        const val APP_NOTIFICATION = "notification.app"
        const val TOTP_SEED = "totp.seed"
        const val TOTP_REVOKE = "totp.revoke"
        const val CLIPBOARD_TEXT = "clipboard.text"
        const val CLIPBOARD_IMAGE = "clipboard.image"
        const val CLIPBOARD_FILE = "clipboard.file"
        const val FILE_MANIFEST = "file.manifest"
    }

    fun topicForLegacyType(type: String): String = when (type) {
        "topology_delta", "node_advertisement", "link_advertisement" -> Topic.TOPOLOGY_DELTA
        "sms" -> Topic.SMS_CODE
        "sms_message" -> Topic.SMS_RAW
        "app_notification" -> Topic.APP_NOTIFICATION
        "totp_seed" -> Topic.TOTP_SEED
        "totp_revoke" -> Topic.TOTP_REVOKE
        "clipboard", "clipboard_text" -> Topic.CLIPBOARD_TEXT
        "clipboard_image" -> Topic.CLIPBOARD_IMAGE
        "clipboard_file" -> Topic.CLIPBOARD_FILE
        "file_transfer" -> Topic.FILE_MANIFEST
        else -> type.replace('_', '.')
    }

    fun legacyTypeForTopic(topic: String): String = when (topic) {
        Topic.TOPOLOGY_DELTA -> "topology_delta"
        Topic.SMS_CODE -> "sms"
        Topic.SMS_RAW -> "sms_message"
        Topic.APP_NOTIFICATION -> "app_notification"
        Topic.TOTP_SEED -> "totp_seed"
        Topic.TOTP_REVOKE -> "totp_revoke"
        Topic.CLIPBOARD_TEXT -> "clipboard_text"
        Topic.CLIPBOARD_IMAGE -> "clipboard_image"
        Topic.CLIPBOARD_FILE -> "clipboard_file"
        Topic.FILE_MANIFEST -> "file_transfer"
        else -> topic.replace('.', '_')
    }

    fun isEnvelope(json: JSONObject): Boolean =
        json.optInt("busVersion", 0) >= 1 &&
            json.optString("topic").isNotBlank() &&
            json.optString("messageId").isNotBlank()

    fun envelopeFromLegacyPayload(
        context: Context,
        legacyPayload: JSONObject,
        topic: String = topicForLegacyType(legacyPayload.optString("type"))
    ): JSONObject {
        val identity = PhoneIdentityStore.get(context)
        val now = System.currentTimeMillis()
        val messageId = legacyPayload.optString("originMessageId")
            .ifBlank { legacyPayload.optString("relayMessageId") }
            .ifBlank { legacyPayload.optString("msgId") }
            .ifBlank { legacyPayload.optJSONObject("fileManifest")?.optString("fileId").orEmpty() }
            .ifBlank { "bus-${identity.id}-$now" }
        return JSONObject()
            .put("busVersion", BUS_VERSION)
            .put("messageId", messageId)
            .put("networkId", legacyPayload.optString("networkId", LanTrustStore.getNetworkId(context)))
            .put("topic", topic)
            .put("sourceNodeId", identity.id)
            .put("sourceNodeName", identity.name)
            .put("sourceNodeType", "ANDROID_PHONE")
            .put(
                "originNodeId",
                legacyPayload.optString("originDeviceId")
                    .ifBlank { legacyPayload.optString("sourceDeviceId", identity.id) }
            )
            .put("targetNodeIds", copyStringArray(legacyPayload.optJSONArray("targetDeviceIds")))
            .put("ttl", legacyPayload.optInt("relayTtl", legacyPayload.optInt("ttl", 4)).coerceAtLeast(0))
            .put("seq", legacyPayload.optLong("seq", now))
            .put("qos", "at_least_once")
            .put("routePath", copyStringArray(legacyPayload.optJSONArray("relayPath")))
            .put("timestamp", legacyPayload.optLong("timestamp", now))
            .put("payload", JSONObject(legacyPayload.toString()))
    }

    fun legacyPayloadFromEnvelope(envelope: JSONObject): JSONObject {
        val payload = JSONObject(envelope.optJSONObject("payload")?.toString() ?: "{}")
        val type = payload.optString("type").ifBlank { legacyTypeForTopic(envelope.optString("topic")) }
        payload.put("type", type)
        payload.put("contentType", payload.optString("contentType").ifBlank { type })
        payload.put("originMessageId", payload.optString("originMessageId").ifBlank { envelope.optString("messageId") })
        payload.put("relayMessageId", payload.optString("relayMessageId").ifBlank { envelope.optString("messageId") })
        payload.put("msgId", payload.optString("msgId").ifBlank { envelope.optString("messageId") })
        payload.put("networkId", payload.optString("networkId").ifBlank { envelope.optString("networkId") })
        payload.put("sourceDeviceId", payload.optString("sourceDeviceId").ifBlank { envelope.optString("sourceNodeId") })
        payload.put("originDeviceId", payload.optString("originDeviceId").ifBlank { envelope.optString("originNodeId") })
        payload.put("targetDeviceIds", copyStringArray(envelope.optJSONArray("targetNodeIds")))
        payload.put("relayPath", copyStringArray(envelope.optJSONArray("routePath")))
        payload.put("relayTtl", payload.optInt("relayTtl", envelope.optInt("ttl", 0)))
        payload.put("timestamp", payload.optLong("timestamp", envelope.optLong("timestamp", System.currentTimeMillis())))
        return payload
    }

    fun wrapTransportEnvelope(context: Context, envelope: JSONObject, peerKey: String): JSONObject {
        val identity = PhoneIdentityStore.get(context)
        val encryptedPayload = CryptoUtil.encrypt(envelope.toString(), peerKey)
        val nonce = CryptoUtil.generateNonce()
        val sentAt = System.currentTimeMillis()
        return JSONObject()
            .put("type", "codebridge_bus")
            .put("version", 1)
            .put("senderId", identity.id)
            .put("nonce", nonce)
            .put("sentAt", sentAt)
            .put("payload", encryptedPayload)
            .put("authToken", CryptoUtil.hmacSha256Base64(peerKey, "${identity.id}|$nonce|$sentAt|$encryptedPayload"))
    }

    fun parseTransportEnvelope(
        context: Context,
        transport: JSONObject,
        peerKeyResolver: (String) -> String? = { null }
    ): Pair<String, JSONObject>? {
        if (transport.optString("type") != "codebridge_bus") return null
        val identity = PhoneIdentityStore.get(context)
        val senderId = transport.optString("senderId").trim()
        val nonce = transport.optString("nonce").trim()
        val encryptedPayload = transport.optString("payload").trim()
        val authToken = transport.optString("authToken").trim()
        if (senderId.isBlank() || nonce.isBlank() || encryptedPayload.isBlank() || authToken.isBlank()) return null
        val peerKey = peerKeyResolver(senderId)?.takeIf { it.isNotBlank() } ?: identity.pairingKey
        val sentAt = transport.optLong("sentAt", 0L)
        if (sentAt <= 0L || kotlin.math.abs(System.currentTimeMillis() - sentAt) > BUS_REPLAY_WINDOW_MS) return null
        val expected = CryptoUtil.hmacSha256Base64(peerKey, "$senderId|$nonce|$sentAt|$encryptedPayload")
        if (!MessageDigest.isEqual(expected.toByteArray(), authToken.toByteArray())) return null
        if (isReplayedBusNonce(senderId, nonce)) return null
        val envelope = JSONObject(CryptoUtil.decrypt(encryptedPayload, peerKey))
        return if (isEnvelope(envelope)) senderId to envelope else null
    }

    private fun isReplayedBusNonce(senderId: String, nonce: String): Boolean {
        if (senderId.isBlank() || nonce.isBlank()) return true
        val now = System.currentTimeMillis()
        synchronized(recentBusNonces) {
            val seen = recentBusNonces.getOrPut(senderId) { LinkedHashMap() }
            val iterator = seen.entries.iterator()
            while (iterator.hasNext()) {
                if (now - iterator.next().value > BUS_REPLAY_WINDOW_MS) iterator.remove()
            }
            if (seen.containsKey(nonce)) return true
            seen[nonce] = now
            while (seen.size > BUS_NONCE_LIMIT_PER_SENDER) {
                val first = seen.entries.iterator()
                if (!first.hasNext()) break
                first.next()
                first.remove()
            }
        }
        return false
    }

    private fun copyStringArray(array: JSONArray?): JSONArray {
        val result = JSONArray()
        if (array == null) return result
        for (i in 0 until array.length()) {
            array.optString(i).trim().takeIf { it.isNotBlank() }?.let { result.put(it) }
        }
        return result
    }
}
