package com.codesync.util

import android.content.Context

/**
 * 轻量偏好存储。按需投递模型下，"短信自动转发"是一个开关偏好，
 * 而不是一条常驻连接——SmsReceiver 在转发前读取它决定是否推送。
 */
object SettingsStore {
    private const val PREFS_NAME = "code_sync_settings"
    private const val KEY_FORWARD_SMS = "forward_sms_enabled"

    fun isForwardingEnabled(context: Context): Boolean =
        prefs(context).getBoolean(KEY_FORWARD_SMS, true)

    fun setForwardingEnabled(context: Context, enabled: Boolean) {
        prefs(context).edit().putBoolean(KEY_FORWARD_SMS, enabled).apply()
    }

    private fun prefs(context: Context) =
        context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
}
