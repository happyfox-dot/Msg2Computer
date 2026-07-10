package com.codesync.util

import android.content.Context
import java.security.MessageDigest

/**
 * Process-local SMS broadcast de-duplication.
 *
 * This intentionally is not persisted: [shouldForward] is called before Android confirms that
 * the foreground service could be started. Persisting at that point can suppress a later retry
 * even though no message was ever queued. A small bounded LRU still absorbs duplicate receiver
 * deliveries in the same process without leaving a durable false-positive marker.
 */
object SmsForwardDedupStore {
    private const val DUPLICATE_WINDOW_MS = 2 * 60 * 1000L
    private const val MAX_RECENT_MESSAGES = 64
    private val lock = Any()
    private val recent = LinkedHashMap<String, Long>(MAX_RECENT_MESSAGES, 0.75f, true)

    @Suppress("UNUSED_PARAMETER")
    fun shouldForward(context: Context, sender: String, body: String, contentType: String): Boolean =
        shouldForwardAt(sender, body, contentType, System.currentTimeMillis())

    internal fun shouldForwardAt(
        sender: String,
        body: String,
        contentType: String,
        now: Long
    ): Boolean {
        val key = hash("${contentType.trim()}|${sender.trim()}|${body.trim()}")
        synchronized(lock) {
            val iterator = recent.entries.iterator()
            while (iterator.hasNext()) {
                val age = now - iterator.next().value
                if (age < 0L || age >= DUPLICATE_WINDOW_MS) iterator.remove()
            }
            if (recent.containsKey(key)) return false
            recent[key] = now
            while (recent.size > MAX_RECENT_MESSAGES) {
                val oldest = recent.entries.iterator()
                if (!oldest.hasNext()) break
                oldest.next()
                oldest.remove()
            }
            return true
        }
    }

    internal fun clearForTests() {
        synchronized(lock) { recent.clear() }
    }

    private fun hash(value: String): String {
        return MessageDigest.getInstance("SHA-256")
            .digest(value.toByteArray(Charsets.UTF_8))
            .joinToString("") { "%02x".format(it) }
            .take(24)
    }
}
