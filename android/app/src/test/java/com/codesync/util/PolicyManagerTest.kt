package com.codesync.util

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PolicyManagerTest {
    @Test
    fun localClipboardSwitchDoesNotBlockRelayForwarding() {
        val context = InMemoryContext()
        SettingsStore.setSyncClipboardEnabled(context, false)
        val device = trustedDevice(allowClipboard = true)

        assertFalse(PolicyManager.canSendTo(context, "clipboard_text", device))
        assertTrue(PolicyManager.canForwardTo("clipboard_text", device))
    }

    @Test
    fun manualFileTransferIgnoresClipboardFileSwitch() {
        val context = InMemoryContext()
        SettingsStore.setSyncClipboardFileEnabled(context, false)
        val device = trustedDevice(allowFileTransfer = true)

        assertTrue(PolicyManager.canSendTo(context, "file_transfer", device))
        assertFalse(PolicyManager.canSendTo(context, "clipboard_file", device))
    }

    @Test
    fun specificClipboardPermissionsCannotBeBypassedByBroaderGrants() {
        val imageDenied = trustedDevice(
            allowClipboard = true,
            allowClipboardImage = false
        )
        val clipboardFileDenied = trustedDevice(
            allowClipboardFile = false,
            allowFileTransfer = true
        )

        assertFalse(PolicyManager.canForwardTo("clipboard_image", imageDenied))
        assertFalse(PolicyManager.canForwardTo("clipboard_file", clipboardFileDenied))
    }

    @Test
    fun inboundNetworkTrustRequiresEnabledNonRevokedPeerOnCurrentNetwork() {
        val context = InMemoryContext()
        SecurePrefs.setTestProviderForTests { ctx, name ->
            ctx.getSharedPreferences("secure_$name", 0)
        }
        try {
            val networkId = LanTrustStore.getNetworkId(context)
            val trusted = DeviceStore.upsertDevice(
                context = context,
                host = "192.0.2.10",
                port = 19529,
                pairingKey = "pair-key",
                name = "Node B",
                deviceId = "node-b",
                networkId = networkId,
                enabled = true
            )

            assertTrue(PolicyManager.isTrustedNetworkDevice(context, trusted))
            assertFalse(PolicyManager.isTrustedNetworkDevice(context, trusted.copy(enabled = false)))
            assertFalse(PolicyManager.isTrustedNetworkDevice(context, trusted.copy(revoked = true)))
            assertFalse(PolicyManager.isTrustedNetworkDevice(context, trusted.copy(pairingKey = "")))
            assertFalse(PolicyManager.isTrustedNetworkDevice(context, trusted.copy(networkId = "net-foreign")))
            assertFalse(PolicyManager.isTrustedNetworkDevice(context, trusted.copy(networkId = "")))

            val storedLegacyPeer = DeviceStore.upsertDevice(
                context = context,
                host = "192.0.2.20",
                port = 19527,
                pairingKey = "legacy-pair-key",
                name = "Legacy peer",
                deviceId = "legacy-peer",
                enabled = true
            )
            assertTrue(PolicyManager.isTrustedNetworkDevice(context, storedLegacyPeer))
            assertEquals("", DeviceStore.findDevice(context, storedLegacyPeer.id)?.networkId)

            // HTTP/trust preflight must not bind a legacy peer to the phone's
            // random local network. Only fresh authenticated topology_sync adopts.
            val desktopNetworkId = "net-desktop-authenticated"
            LanTrustStore.adoptNetworkId(
                context = context,
                networkId = desktopNetworkId,
                allowMerge = true,
                mergeFromNetworkIds = listOf(networkId)
            )
            val topologyBoundPeer = DeviceStore.findDevice(context, storedLegacyPeer.id)!!
            assertEquals(desktopNetworkId, LanTrustStore.getNetworkId(context))
            assertEquals(desktopNetworkId, topologyBoundPeer.networkId)
            assertTrue(PolicyManager.isTrustedNetworkDevice(context, topologyBoundPeer))
        } finally {
            SecurePrefs.setTestProviderForTests(null)
        }
    }

    private fun trustedDevice(
        allowClipboard: Boolean = true,
        allowClipboardImage: Boolean = true,
        allowClipboardFile: Boolean = false,
        allowFileTransfer: Boolean = false,
        networkId: String = ""
    ): DesktopDevice =
        DesktopDevice(
            id = "node-b",
            name = "Node B",
            type = "WINDOWS_DESKTOP",
            host = "192.0.2.10",
            port = 19529,
            pairingKey = "pair-key",
            enabled = true,
            lastSyncAt = 0L,
            connectionUpdatedAt = 0L,
            updatedAt = 0L,
            routeMetric = 0,
            routeNextHopId = "",
            routeNextHopName = "",
            routePath = emptyList(),
            routeUpdatedAt = 0L,
            allowClipboard = allowClipboard,
            allowClipboardImage = allowClipboardImage,
            allowClipboardFile = allowClipboardFile,
            allowFileTransfer = allowFileTransfer,
            networkId = networkId
        )
}
