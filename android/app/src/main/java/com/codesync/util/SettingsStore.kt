package com.codesync.util

import android.content.Context
import org.json.JSONObject

/**
 * 轻量偏好存储。按需投递模型下，"短信自动转发"是一个开关偏好，
 * 而不是一条常驻连接——SmsReceiver 在转发前读取它决定是否推送。
 */
object SettingsStore {
    private const val PREFS_NAME = "code_sync_settings"
    private const val KEY_FORWARD_SMS = "forward_sms_enabled"
    private const val KEY_SEND_ALL_SMS = "send_all_sms_enabled"
    private const val KEY_SEND_NOTIFICATIONS = "send_notifications_enabled"
    private const val KEY_NOTIFICATION_APP_POLICIES = "notification_app_policies_v1"
    private const val KEY_RECEIVE_SMS_CODES = "receive_sms_codes_enabled"
    private const val KEY_RECEIVE_ALL_SMS = "receive_all_sms_enabled"
    private const val KEY_RECEIVE_NOTIFICATIONS = "receive_notifications_enabled"
    // 剪贴板同步：单一开关同时控制收与发，默认关闭（剪贴板常含密码等敏感内容）。
    // 受 Android 10+ 后台读剪贴板限制，发送侧只能由用户在前台主动触发；
    // 接收侧（把其它节点同步来的剪贴板写入本机）不受限，可自动完成。
    private const val KEY_SYNC_CLIPBOARD = "sync_clipboard_enabled"
    private const val KEY_SYNC_CLIPBOARD_IMAGE = "sync_clipboard_image_enabled"
    private const val KEY_SYNC_CLIPBOARD_FILE = "sync_clipboard_file_enabled"
    private const val KEY_RECEIVE_FILE_TRANSFER = "receive_file_transfer_enabled"
    private const val KEY_RECEIVE_FILE_TRANSFER_DEFAULT_MIGRATED =
        "receive_file_transfer_default_migrated_v2"
    private const val KEY_FILE_RECEIVE_SUBDIR = "file_receive_subdir"
    private const val DEFAULT_ONGOING_NOTIFICATION_INTERVAL_MS = 10_000L
    private const val MIN_NOTIFICATION_INTERVAL_MS = 1_000L
    private const val MAX_NOTIFICATION_INTERVAL_MS = 10 * 60_000L

    data class NotificationAppPolicy(
        val packageName: String,
        val allowNormal: Boolean = true,
        val allowOngoing: Boolean = false,
        val minIntervalMs: Long = DEFAULT_ONGOING_NOTIFICATION_INTERVAL_MS
    ) {
        fun isDefault(): Boolean =
            allowNormal && !allowOngoing && minIntervalMs == DEFAULT_ONGOING_NOTIFICATION_INTERVAL_MS
    }

    fun isForwardingEnabled(context: Context): Boolean =
        prefs(context).getBoolean(KEY_FORWARD_SMS, true)

    fun setForwardingEnabled(context: Context, enabled: Boolean) {
        prefs(context).edit().putBoolean(KEY_FORWARD_SMS, enabled).apply()
    }

    fun isSendAllSmsEnabled(context: Context): Boolean =
        prefs(context).getBoolean(KEY_SEND_ALL_SMS, false)

    fun setSendAllSmsEnabled(context: Context, enabled: Boolean) {
        prefs(context).edit().putBoolean(KEY_SEND_ALL_SMS, enabled).apply()
    }

    fun isSendNotificationsEnabled(context: Context): Boolean =
        prefs(context).getBoolean(KEY_SEND_NOTIFICATIONS, false)

    fun setSendNotificationsEnabled(context: Context, enabled: Boolean) {
        prefs(context).edit().putBoolean(KEY_SEND_NOTIFICATIONS, enabled).apply()
    }

    fun getNotificationAppPolicy(context: Context, packageName: String): NotificationAppPolicy {
        val normalizedPackage = packageName.trim()
        if (normalizedPackage.isBlank()) return NotificationAppPolicy("")
        val rawPolicy = readNotificationPolicies(context).optJSONObject(normalizedPackage)
            ?: return NotificationAppPolicy(normalizedPackage)
        return NotificationAppPolicy(
            packageName = normalizedPackage,
            allowNormal = rawPolicy.optBoolean("allowNormal", true),
            allowOngoing = rawPolicy.optBoolean("allowOngoing", false),
            minIntervalMs = clampNotificationInterval(
                rawPolicy.optLong("minIntervalMs", DEFAULT_ONGOING_NOTIFICATION_INTERVAL_MS)
            )
        )
    }

    fun setNotificationAppPolicy(context: Context, policy: NotificationAppPolicy) {
        val normalizedPackage = policy.packageName.trim()
        if (normalizedPackage.isBlank()) return
        val normalized = policy.copy(
            packageName = normalizedPackage,
            minIntervalMs = clampNotificationInterval(policy.minIntervalMs)
        )
        val policies = readNotificationPolicies(context)
        if (normalized.isDefault()) {
            policies.remove(normalizedPackage)
        } else {
            policies.put(
                normalizedPackage,
                JSONObject()
                    .put("allowNormal", normalized.allowNormal)
                    .put("allowOngoing", normalized.allowOngoing)
                    .put("minIntervalMs", normalized.minIntervalMs)
            )
        }
        prefs(context).edit().putString(KEY_NOTIFICATION_APP_POLICIES, policies.toString()).apply()
    }

    fun getNotificationAppPolicies(context: Context): Map<String, NotificationAppPolicy> {
        val policies = readNotificationPolicies(context)
        val result = linkedMapOf<String, NotificationAppPolicy>()
        val keys = policies.keys()
        while (keys.hasNext()) {
            val packageName = keys.next()
            result[packageName] = getNotificationAppPolicy(context, packageName)
        }
        return result
    }

    fun isNotificationPackageAllowed(
        context: Context,
        packageName: String,
        ongoing: Boolean
    ): Boolean {
        if (!isSendNotificationsEnabled(context)) return false
        val policy = getNotificationAppPolicy(context, packageName)
        return if (ongoing) policy.allowOngoing else policy.allowNormal
    }

    fun isReceiveSmsCodesEnabled(context: Context): Boolean =
        prefs(context).getBoolean(KEY_RECEIVE_SMS_CODES, true)

    fun setReceiveSmsCodesEnabled(context: Context, enabled: Boolean) {
        prefs(context).edit().putBoolean(KEY_RECEIVE_SMS_CODES, enabled).apply()
    }

    fun isReceiveAllSmsEnabled(context: Context): Boolean =
        prefs(context).getBoolean(KEY_RECEIVE_ALL_SMS, true)

    fun setReceiveAllSmsEnabled(context: Context, enabled: Boolean) {
        prefs(context).edit().putBoolean(KEY_RECEIVE_ALL_SMS, enabled).apply()
    }

    fun isReceiveNotificationsEnabled(context: Context): Boolean =
        prefs(context).getBoolean(KEY_RECEIVE_NOTIFICATIONS, true)

    fun setReceiveNotificationsEnabled(context: Context, enabled: Boolean) {
        prefs(context).edit().putBoolean(KEY_RECEIVE_NOTIFICATIONS, enabled).apply()
    }

    fun isSyncClipboardEnabled(context: Context): Boolean =
        prefs(context).getBoolean(KEY_SYNC_CLIPBOARD, false)

    fun setSyncClipboardEnabled(context: Context, enabled: Boolean) {
        prefs(context).edit().putBoolean(KEY_SYNC_CLIPBOARD, enabled).apply()
    }

    fun isSyncClipboardImageEnabled(context: Context): Boolean =
        prefs(context).getBoolean(KEY_SYNC_CLIPBOARD_IMAGE, isSyncClipboardEnabled(context))

    fun setSyncClipboardImageEnabled(context: Context, enabled: Boolean) {
        prefs(context).edit().putBoolean(KEY_SYNC_CLIPBOARD_IMAGE, enabled).apply()
    }

    fun isSyncClipboardFileEnabled(context: Context): Boolean =
        prefs(context).getBoolean(KEY_SYNC_CLIPBOARD_FILE, false)

    fun setSyncClipboardFileEnabled(context: Context, enabled: Boolean) {
        prefs(context).edit().putBoolean(KEY_SYNC_CLIPBOARD_FILE, enabled).apply()
    }

    fun isReceiveFileTransferEnabled(context: Context): Boolean {
        migrateReceiveFileTransferDefault(context)
        return prefs(context).getBoolean(KEY_RECEIVE_FILE_TRANSFER, true)
    }

    fun setReceiveFileTransferEnabled(context: Context, enabled: Boolean) {
        prefs(context).edit()
            .putBoolean(KEY_RECEIVE_FILE_TRANSFER, enabled)
            .putBoolean(KEY_RECEIVE_FILE_TRANSFER_DEFAULT_MIGRATED, true)
            .apply()
    }

    fun getFileReceiveSubdir(context: Context): String =
        sanitizeFileReceiveSubdir(prefs(context).getString(KEY_FILE_RECEIVE_SUBDIR, "").orEmpty())

    fun setFileReceiveSubdir(context: Context, subdir: String) {
        prefs(context).edit()
            .putString(KEY_FILE_RECEIVE_SUBDIR, sanitizeFileReceiveSubdir(subdir))
            .apply()
    }

    fun getFileReceiveSubdirOrDefault(context: Context, defaultSubdir: String = "CodeBridge"): String =
        getFileReceiveSubdir(context).ifBlank { defaultSubdir }

    fun sanitizeFileReceiveSubdir(raw: String): String {
        return raw
            .trim()
            .replace('\\', '/')
            .split('/')
            .map {
                it.trim()
                    .replace(Regex("[\\x00-\\x1F<>:\"|?*]"), "_")
                    .trim('.')
                    .take(60)
            }
            .filter { it.isNotBlank() && it != "." && it != ".." }
            .take(4)
            .joinToString("/")
    }

    fun shouldReceiveContent(context: Context, type: String): Boolean {
        return when (type) {
            "sms" -> isReceiveSmsCodesEnabled(context)
            "sms_message" -> isReceiveAllSmsEnabled(context)
            "app_notification", "app_notification_removed" -> isReceiveNotificationsEnabled(context)
            "clipboard", "clipboard_text" -> isSyncClipboardEnabled(context)
            "clipboard_image" -> isSyncClipboardImageEnabled(context)
            "clipboard_file" -> isSyncClipboardFileEnabled(context)
            "file_transfer" -> isReceiveFileTransferEnabled(context)
            else -> true
        }
    }

    private fun prefs(context: Context) =
        context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    private fun readNotificationPolicies(context: Context): JSONObject =
        runCatching {
            JSONObject(prefs(context).getString(KEY_NOTIFICATION_APP_POLICIES, "{}").orEmpty())
        }.getOrDefault(JSONObject())

    private fun clampNotificationInterval(value: Long): Long =
        value.coerceIn(MIN_NOTIFICATION_INTERVAL_MS, MAX_NOTIFICATION_INTERVAL_MS)

    private fun migrateReceiveFileTransferDefault(context: Context) {
        val prefs = prefs(context)
        if (prefs.getBoolean(KEY_RECEIVE_FILE_TRANSFER_DEFAULT_MIGRATED, false)) return
        prefs.edit()
            .putBoolean(KEY_RECEIVE_FILE_TRANSFER, true)
            .putBoolean(KEY_RECEIVE_FILE_TRANSFER_DEFAULT_MIGRATED, true)
            .apply()
    }
}
