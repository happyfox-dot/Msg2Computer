package com.codesync.util

import android.content.Context
import java.security.MessageDigest

object SmsForwardDedupStore {
    private const val PREFS = "sms_forward_dedup"
    private const val KEY_LAST_HASH = "last_hash"
    private const val KEY_LAST_AT = "last_at"
    private const val DUPLICATE_WINDOW_MS = 2 * 60 * 1000L

    fun shouldForward(context: Context, sender: String, body: String, contentType: String): Boolean {
        val key = hash("${contentType.trim()}|${sender.trim()}|${body.trim()}")
        val now = System.currentTimeMillis()
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val lastKey = prefs.getString(KEY_LAST_HASH, "").orEmpty()
        val lastAt = prefs.getLong(KEY_LAST_AT, 0L)
        if (key == lastKey && now - lastAt in 0 until DUPLICATE_WINDOW_MS) {
            return false
        }
        prefs.edit()
            .putString(KEY_LAST_HASH, key)
            .putLong(KEY_LAST_AT, now)
            .apply()
        return true
    }

    private fun hash(value: String): String {
        return MessageDigest.getInstance("SHA-256")
            .digest(value.toByteArray(Charsets.UTF_8))
            .joinToString("") { "%02x".format(it) }
            .take(24)
    }
}
