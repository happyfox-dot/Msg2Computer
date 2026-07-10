package com.codesync.util

import android.content.Context

object PolicyManager {
    fun canSendTo(context: Context, type: String, device: DesktopDevice): Boolean {
        if (!isTrustedDevice(device)) return false
        return isContentAllowedByPeer(type, device) && when (normalizeType(type)) {
            "sms" -> device.allowSmsCodes
            "sms_message" -> device.allowSmsMessages
            "app_notification" -> device.allowNotifications
            "totp", "totp_seed", "totp_revoke", "totp_resync_request" -> device.allowTotp
            "clipboard", "clipboard_text" ->
                SettingsStore.isSyncClipboardEnabled(context)
            "clipboard_image" ->
                SettingsStore.isSyncClipboardImageEnabled(context)
            "clipboard_file" ->
                SettingsStore.isSyncClipboardFileEnabled(context)
            "file_transfer" -> true
            "topology_delta", "topology_sync", "node_advertisement", "link_advertisement" -> true
            else -> true
        }
    }

    fun canForwardTo(type: String, device: DesktopDevice): Boolean =
        isTrustedDevice(device) && isContentAllowedByPeer(type, device)

    fun canReceive(context: Context, type: String): Boolean =
        SettingsStore.shouldReceiveContent(context, normalizeType(type))

    fun canRelay(type: String, device: DesktopDevice): Boolean =
        isTrustedDevice(device) && (isRelaySupportedType(type) || isTopologyType(type))

    fun isTrustedDevice(device: DesktopDevice): Boolean =
        device.enabled && !device.revoked && device.pairingKey.isNotBlank()

    /**
     * Stronger trust check for inbound LAN traffic. A retained pairing record is not
     * sufficient: disabled/revoked nodes and nodes from another trust network must
     * not be allowed to authenticate or relay traffic.
     */
    fun isTrustedNetworkDevice(context: Context, device: DesktopDevice?): Boolean {
        if (device == null || !isTrustedDevice(device)) return false
        val localNetworkId = LanTrustStore.getNetworkId(context).trim()
        if (localNetworkId.isBlank()) return false
        val stored = DeviceStore.findDevice(context, device.id) ?: return false
        if (!isTrustedDevice(stored) ||
            !MessageDigestCompat.constantTimeEquals(stored.pairingKey, device.pairingKey)
        ) return false

        val storedNetworkId = stored.networkId.trim()
        val suppliedNetworkId = device.networkId.trim()
        if (suppliedNetworkId.isBlank() != storedNetworkId.isBlank()) return false
        if (suppliedNetworkId.isNotBlank() &&
            !MessageDigestCompat.constantTimeEquals(suppliedNetworkId, storedNetworkId)
        ) return false

        // A pre-network-version pairing may pass transport authentication long
        // enough to receive fresh, authenticated topology_sync. Never bind it to
        // this phone's locally generated network here: topology_sync is the sole
        // authority that adopts and persists the peer network.
        if (storedNetworkId.isBlank()) return true
        return MessageDigestCompat.constantTimeEquals(localNetworkId, storedNetworkId)
    }

    fun isTopologyType(type: String): Boolean {
        return when (normalizeType(type)) {
            "topology_delta", "topology_sync", "node_advertisement", "link_advertisement" -> true
            else -> false
        }
    }

    fun isRelaySupportedType(type: String): Boolean =
        isUserMessageType(type) ||
            normalizeType(type) == "totp_seed" ||
            normalizeType(type) == "totp_revoke" ||
            normalizeType(type) == "totp_resync_request" ||
            isTopologyType(type)

    fun isUserMessageType(type: String): Boolean {
        return when (normalizeType(type)) {
            "sms",
            "sms_message",
            "app_notification",
            "clipboard",
            "clipboard_text",
            "clipboard_image",
            "clipboard_file",
            "file_transfer" -> true
            else -> false
        }
    }

    fun normalizeType(type: String): String =
        when (type.trim()) {
            "verify_code" -> "sms"
            "app_notification_removed" -> "app_notification"
            else -> type.trim()
        }

    private fun isContentAllowedByPeer(type: String, device: DesktopDevice): Boolean {
        return when (normalizeType(type)) {
            "sms" -> device.allowSmsCodes
            "sms_message" -> device.allowSmsMessages
            "app_notification" -> device.allowNotifications
            "totp", "totp_seed", "totp_revoke", "totp_resync_request" -> device.allowTotp
            "clipboard", "clipboard_text" -> device.allowClipboard
            // These are independent permissions. A broad text-clipboard or manual
            // file-transfer grant must never bypass an explicit image/file denial.
            "clipboard_image" -> device.allowClipboardImage
            "clipboard_file" -> device.allowClipboardFile
            "file_transfer" -> device.allowFileTransfer
            "topology_delta", "topology_sync", "node_advertisement", "link_advertisement" -> true
            else -> true
        }
    }

    /** Avoid a regular String.equals timing signal on trust-network identifiers. */
    private object MessageDigestCompat {
        fun constantTimeEquals(left: String, right: String): Boolean {
            val a = left.toByteArray(Charsets.UTF_8)
            val b = right.toByteArray(Charsets.UTF_8)
            return java.security.MessageDigest.isEqual(a, b)
        }
    }
}
