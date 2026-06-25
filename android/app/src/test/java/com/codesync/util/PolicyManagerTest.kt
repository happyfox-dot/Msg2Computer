package com.codesync.util

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

    private fun trustedDevice(
        allowClipboard: Boolean = true,
        allowClipboardFile: Boolean = false,
        allowFileTransfer: Boolean = false
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
            allowClipboardFile = allowClipboardFile,
            allowFileTransfer = allowFileTransfer
        )
}
