package com.codesync.service

import org.json.JSONObject
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class NodeReceiverPayloadPolicyTest {
    @Test
    fun expiredVerificationCodeIsDroppedAtExpiryBoundary() {
        val payload = JSONObject()
            .put("type", "sms")
            .put("expiresAt", 2_000L)

        assertFalse(isExpiredVerificationCodePayload(payload, now = 1_999L))
        assertTrue(isExpiredVerificationCodePayload(payload, now = 2_000L))
    }

    @Test
    fun expiryDoesNotDropRawSmsNotificationsOrLegacyCodesWithoutTtl() {
        assertFalse(
            isExpiredVerificationCodePayload(
                JSONObject().put("type", "sms_message").put("expiresAt", 1L),
                now = 2_000L
            )
        )
        assertFalse(
            isExpiredVerificationCodePayload(
                JSONObject().put("type", "app_notification").put("expiresAt", 1L),
                now = 2_000L
            )
        )
        assertFalse(isExpiredVerificationCodePayload(JSONObject().put("type", "sms"), now = 2_000L))
    }

    @Test
    fun persistentOutboxWakeRequiresDueWorkNetworkIdleServiceAndRateLimit() {
        assertTrue(
            shouldWakePersistentOutbox(
                hasDueOutbound = true,
                networkAvailable = true,
                webSocketServiceRunning = false,
                now = 10_000L,
                lastWakeAt = 0L,
                minIntervalMs = 30_000L
            )
        )
        assertFalse(shouldWake(hasDue = false))
        assertFalse(shouldWake(network = false))
        assertFalse(shouldWake(serviceRunning = true))
        assertFalse(shouldWake(now = 39_999L, lastWake = 10_000L))
        assertTrue(shouldWake(now = 40_000L, lastWake = 10_000L))
        assertTrue(shouldWake(now = 5_000L, lastWake = 10_000L))
    }

    private fun shouldWake(
        hasDue: Boolean = true,
        network: Boolean = true,
        serviceRunning: Boolean = false,
        now: Long = 40_000L,
        lastWake: Long = 10_000L
    ): Boolean = shouldWakePersistentOutbox(
        hasDueOutbound = hasDue,
        networkAvailable = network,
        webSocketServiceRunning = serviceRunning,
        now = now,
        lastWakeAt = lastWake,
        minIntervalMs = 30_000L
    )
}
