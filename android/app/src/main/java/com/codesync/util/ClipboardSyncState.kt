package com.codesync.util

import android.content.Context
import java.security.MessageDigest

/**
 * 剪贴板 LWW（last-writer-wins）寄存器状态。
 *
 * 网络中剪贴板是一个单值寄存器：每次复制产生新版本 (ts, origin)，节点只应用
 * 比已应用版本更新的内容——旧值、乱序副本、回环副本全部被版本比较吸收。
 * 与桌面端 clipboardSyncState 同一套规则（同毫秒平手用 origin 字典序裁决）。
 * 只存内容哈希不存明文。
 */
object ClipboardSyncState {
    private const val PREFS_NAME = "clipboard_sync_state"
    private const val KEY_TS = "applied_ts"
    private const val KEY_ORIGIN = "applied_origin"
    private const val KEY_HASH = "applied_hash"

    fun hash(text: String): String {
        val digest = MessageDigest.getInstance("SHA-256").digest(text.toByteArray(Charsets.UTF_8))
        return digest.joinToString("") { "%02x".format(it) }.take(24)
    }

    fun appliedTs(context: Context): Long = prefs(context).getLong(KEY_TS, 0L)

    fun appliedOrigin(context: Context): String =
        prefs(context).getString(KEY_ORIGIN, "").orEmpty()

    fun appliedHash(context: Context): String =
        prefs(context).getString(KEY_HASH, "").orEmpty()

    /** 收到的版本是否比已应用版本新。 */
    fun isNewer(context: Context, ts: Long, origin: String): Boolean {
        if (ts <= 0L) return false
        val applied = appliedTs(context)
        if (ts != applied) return ts > applied
        return origin > appliedOrigin(context)
    }

    fun remember(context: Context, ts: Long, origin: String, text: String) {
        prefs(context).edit()
            .putLong(KEY_TS, ts)
            .putString(KEY_ORIGIN, origin)
            .putString(KEY_HASH, hash(text))
            .apply()
    }

    private fun prefs(context: Context) =
        context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
}
