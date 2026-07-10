package com.codesync.util

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class BusAckAuthTest {
    private val key = "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc="
    private val nonce = "随机-α"
    private val messageId = "消息-β"
    private val expectedToken = "OZKGeqxJtBs5jRGAZ2l4n1QmufvP4Ma55vWEW7BSgYs="

    @Test
    fun canonicalContextUsesUtf8ByteLengthsAndMatchesDesktopVector() {
        assertEquals(
            "codebridge-bus-ack-v1|9:随机-α|9:消息-β|1:1",
            BusAckAuth.canonicalContext(nonce, messageId, accepted = true)
        )
        assertEquals(expectedToken, BusAckAuth.sign(key, nonce, messageId, accepted = true))
        assertTrue(BusAckAuth.verify(key, nonce, messageId, true, expectedToken))
    }

    @Test
    fun acceptedAckMustBeSignedAndBoundToNonceMessageAndAcceptedFlag() {
        val valid = BusAckAuth.signedAck(key, nonce, messageId, accepted = true)
        assertTrue(BusAckAuth.isAcceptedAck(valid, messageId, nonce, key))

        assertFalse(BusAckAuth.isAcceptedAck(JSONObject(valid.toString()).removeToken(), messageId, nonce, key))
        assertFalse(BusAckAuth.isAcceptedAck(valid, "other-message", nonce, key))
        assertFalse(BusAckAuth.isAcceptedAck(valid, messageId, "other-nonce", key))

        val rejected = BusAckAuth.signedAck(key, nonce, messageId, accepted = false)
        assertFalse(BusAckAuth.isAcceptedAck(rejected, messageId, nonce, key))
        assertEquals(
            "codebridge-bus-ack-v1|9:随机-α|9:消息-β|1:0",
            BusAckAuth.canonicalContext(nonce, messageId, accepted = false)
        )
    }

    private fun JSONObject.removeToken(): JSONObject = apply { remove("ackToken") }
}
