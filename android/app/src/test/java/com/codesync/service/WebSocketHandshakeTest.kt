package com.codesync.service

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class WebSocketHandshakeTest {

    @Test
    fun acceptsCanonicalSixteenByteNonce() {
        assertTrue(isValidHandshakeNonce("AAECAwQFBgcICQoLDA0ODw=="))
        assertTrue(isValidHandshakeNonce("/////////////////////w=="))
    }

    @Test
    fun rejectsMissingMalformedAndNonCanonicalNonce() {
        assertFalse(isValidHandshakeNonce(""))
        assertFalse(isValidHandshakeNonce("short"))
        assertFalse(isValidHandshakeNonce("AAECAwQFBgcICQoLDA0ODw"))
        assertFalse(isValidHandshakeNonce("AAECAwQFBgcICQoLDA0ODx=="))
        assertFalse(isValidHandshakeNonce("AAAAAAAAAAAAAAAAAAAAAE=="))
        assertFalse(isValidHandshakeNonce("AAECAwQFBgcICQoLDA0ODw==\n"))
    }

    @Test
    fun usesSameLengthPrefixedProofAndAckContextsAsDesktop() {
        val clientNonce = "DQ0NDQ0NDQ0NDQ0NDQ0NDQ=="
        val serverNonce = "Dg4ODg4ODg4ODg4ODg4ODg=="
        assertEquals(
            "codebridge-auth-v1|5:phone|7:desktop|24:$clientNonce|24:$serverNonce",
            canonicalAuthContext("phone", "desktop", clientNonce, serverNonce)
        )
        assertEquals("codebridge-ack-v1|5:m-123", canonicalCodeAckContext("m-123"))
        assertEquals("codebridge-auth-v1|6:手机|6:桌面|1:c|1:s", canonicalAuthContext("手机", "桌面", "c", "s"))
    }
}
