package com.codesync.util

import android.content.Context

/**
 * 轻量偏好存储。按需投递模型下，"短信自动转发"是一个开关偏好，
 * 而不是一条常驻连接——SmsReceiver 在转发前读取它决定是否推送。
 */
object SettingsStore {
    private const val PREFS_NAME = "code_sync_settings"
    private const val KEY_FORWARD_SMS = "forward_sms_enabled"
    private const val KEY_SEND_ALL_SMS = "send_all_sms_enabled"
    private const val KEY_SEND_NOTIFICATIONS = "send_notifications_enabled"
    private const val KEY_RECEIVE_SMS_CODES = "receive_sms_codes_enabled"
    private const val KEY_RECEIVE_ALL_SMS = "receive_all_sms_enabled"
    private const val KEY_RECEIVE_NOTIFICATIONS = "receive_notifications_enabled"
    // 剪贴板同步：单一开关同时控制收与发，默认关闭（剪贴板常含密码等敏感内容）。
    // 受 Android 10+ 后台读剪贴板限制，发送侧只能由用户在前台主动触发；
    // 接收侧（把其它节点同步来的剪贴板写入本机）不受限，可自动完成。
    private const val KEY_SYNC_CLIPBOARD = "sync_clipboard_enabled"

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

    fun shouldReceiveContent(context: Context, type: String): Boolean {
        return when (type) {
            "sms" -> isReceiveSmsCodesEnabled(context)
            "sms_message" -> isReceiveAllSmsEnabled(context)
            "app_notification" -> isReceiveNotificationsEnabled(context)
            "clipboard" -> isSyncClipboardEnabled(context)
            else -> true
        }
    }

    private fun prefs(context: Context) =
        context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
}
