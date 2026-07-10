package com.codesync.util

import okio.ByteString.Companion.decodeBase64
import okio.ByteString.Companion.toByteString
import org.json.JSONObject
import java.security.MessageDigest
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

/** Authentication for HTTP soft-bus acknowledgements shared with desktop. */
object BusAckAuth {
    private const val DOMAIN = "codebridge-bus-ack-v1"

    fun canonicalContext(nonce: String, messageId: String, accepted: Boolean): String {
        val acceptedFlag = if (accepted) "1" else "0"
        return listOf(
            DOMAIN,
            frame(nonce),
            frame(messageId),
            frame(acceptedFlag)
        ).joinToString("|")
    }

    fun sign(
        pairingKeyBase64: String,
        nonce: String,
        messageId: String,
        accepted: Boolean
    ): String? = runCatching {
        val key = pairingKeyBase64.trim().decodeBase64()?.toByteArray()
            ?.takeIf { it.isNotEmpty() }
            ?: return null
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(key, "HmacSHA256"))
        mac.doFinal(canonicalContext(nonce, messageId, accepted).toByteArray(Charsets.UTF_8))
            .toByteString()
            .base64()
    }.getOrNull()

    fun verify(
        pairingKeyBase64: String,
        nonce: String,
        messageId: String,
        accepted: Boolean,
        ackToken: String
    ): Boolean {
        val actual = ackToken.trim().decodeBase64()?.toByteArray() ?: return false
        val expected = sign(pairingKeyBase64, nonce, messageId, accepted)
            ?.decodeBase64()
            ?.toByteArray()
            ?: return false
        return MessageDigest.isEqual(expected, actual)
    }

    fun signedAck(
        pairingKeyBase64: String,
        nonce: String,
        messageId: String,
        accepted: Boolean,
        reason: String = ""
    ): JSONObject {
        val ack = JSONObject()
            .put("type", "bus_ack")
            .put("accepted", accepted)
            .put("messageId", messageId)
        if (reason.isNotBlank()) ack.put("reason", reason)
        sign(pairingKeyBase64, nonce, messageId, accepted)?.let { ack.put("ackToken", it) }
        return ack
    }

    fun isAcceptedAck(
        ack: JSONObject,
        expectedMessageId: String,
        requestNonce: String,
        pairingKeyBase64: String
    ): Boolean {
        if (ack.optString("type") != "bus_ack") return false
        if (ack.optString("messageId") != expectedMessageId) return false
        if (ack.opt("accepted") != true) return false
        val token = ack.optString("ackToken").trim()
        if (token.isBlank()) return false
        return verify(pairingKeyBase64, requestNonce, expectedMessageId, accepted = true, ackToken = token)
    }

    private fun frame(value: String): String =
        "${value.toByteArray(Charsets.UTF_8).size}:$value"
}
