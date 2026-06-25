package com.codesync.util

import android.content.Context

object PolicyManager {
    fun canSendTo(context: Context, type: String, device: DesktopDevice): Boolean {
        if (!isTrustedDevice(device)) return false
        return isContentAllowedByPeer(type, device) && when (normalizeType(type)) {
            "sms" -> device.allowSmsCodes
            "sms_message" -> device.allowSmsMessages
            "app_notification" -> device.allowNotifications
            "totp", "totp_seed", "totp_revoke" -> device.allowTotp
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
            else -> type.trim()
        }

    private fun isContentAllowedByPeer(type: String, device: DesktopDevice): Boolean {
        return when (normalizeType(type)) {
            "sms" -> device.allowSmsCodes
            "sms_message" -> device.allowSmsMessages
            "app_notification" -> device.allowNotifications
            "totp", "totp_seed", "totp_revoke" -> device.allowTotp
            "clipboard", "clipboard_text" -> device.allowClipboard
            "clipboard_image" -> device.allowClipboardImage || device.allowClipboard
            "clipboard_file" -> device.allowClipboardFile || device.allowFileTransfer
            "file_transfer" -> device.allowFileTransfer
            "topology_delta", "topology_sync", "node_advertisement", "link_advertisement" -> true
            else -> true
        }
    }
}
