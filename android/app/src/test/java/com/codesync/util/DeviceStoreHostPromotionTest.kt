package com.codesync.util

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class DeviceStoreHostPromotionTest {
    @Test
    fun authenticatedCandidatePromotionPreservesPoliciesRoutesAndOtherHosts() {
        val context = InMemoryContext()
        SecurePrefs.setTestProviderForTests { ctx, name ->
            ctx.getSharedPreferences("secure_$name", 0)
        }
        try {
            val original = DeviceStore.upsertDevice(
                context = context,
                host = "192.0.2.10",
                port = 19527,
                pairingKey = "pair-key",
                name = "Desktop",
                deviceId = "desktop-a",
                routeMetric = 4,
                routeNextHopId = "relay-a",
                routeNextHopName = "Relay",
                routePath = listOf("phone", "relay-a", "desktop-a"),
                routeUpdatedAt = 1234L,
                altHosts = listOf("198.51.100.20", "203.0.113.30"),
                networkId = "network-a",
                policyAllowSmsCodes = false,
                policyAllowSmsMessages = false,
                policyAllowNotifications = false,
                policyAllowTotp = false,
                policyAllowClipboard = false,
                policyAllowClipboardImage = false,
                policyAllowClipboardFile = true,
                policyAllowFileTransfer = true,
                policyMaxFileSizeMb = 17,
                policyAutoAcceptFiles = true,
                enabled = true
            )

            assertFalse(DeviceStore.promoteSuccessfulHost(context, original.id, "untrusted.example"))
            assertEquals("192.0.2.10", DeviceStore.findDevice(context, original.id)?.host)

            assertTrue(DeviceStore.promoteSuccessfulHost(context, original.id, "198.51.100.20"))
            val promoted = DeviceStore.findDevice(context, original.id)!!
            assertEquals(
                original.copy(
                    host = "198.51.100.20",
                    altHosts = listOf("192.0.2.10", "203.0.113.30"),
                    updatedAt = promoted.updatedAt
                ),
                promoted
            )
        } finally {
            SecurePrefs.setTestProviderForTests(null)
        }
    }
}
