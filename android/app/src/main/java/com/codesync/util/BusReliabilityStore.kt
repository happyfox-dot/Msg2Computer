package com.codesync.util

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import kotlin.math.min
import kotlin.math.pow

object BusReliabilityStore {
    private const val PREFS = "bus_reliability"
    private const val KEY_SEEN = "seen"
    private const val KEY_OUTBOX = "outbox"
    private const val SEEN_LIMIT = 1000
    private const val OUTBOX_LIMIT = 300
    private const val SEEN_TTL_MS = 24 * 60 * 60 * 1000L
    private const val RETRY_BASE_MS = 15 * 1000L
    private const val RETRY_MAX_MS = 5 * 60 * 1000L
    private const val MAX_ATTEMPTS = 8

    fun rememberInbound(context: Context, envelope: JSONObject): Boolean {
        val key = envelopeKey(envelope)
        if (key.isBlank()) return true
        val now = System.currentTimeMillis()
        val seen = loadSeen(context)
        pruneSeen(seen, now)
        if (seen.has(key)) {
            saveSeen(context, seen)
            return false
        }
        seen.put(key, now)
        trimObject(seen, SEEN_LIMIT)
        saveSeen(context, seen)
        return true
    }

    fun rememberOutbound(context: Context, envelope: JSONObject, targetNodeId: String) {
        val messageId = envelope.optString("messageId").trim()
        val target = targetNodeId.trim()
        if (messageId.isBlank() || target.isBlank()) return
        val outbox = loadOutbox(context)
        val key = outboxKey(messageId, target)
        val now = System.currentTimeMillis()
        outbox.put(
            key,
            JSONObject()
                .put("messageId", messageId)
                .put("targetNodeId", target)
                .put("topic", envelope.optString("topic"))
                .put("envelope", JSONObject(envelope.toString()))
                .put("status", "pending")
                .put("attempts", outbox.optJSONObject(key)?.optInt("attempts", 0) ?: 0)
                .put("createdAt", outbox.optJSONObject(key)?.optLong("createdAt", now) ?: now)
                .put("updatedAt", now)
                .put("nextAttemptAt", outbox.optJSONObject(key)?.optLong("nextAttemptAt", 0L) ?: 0L)
        )
        trimObject(outbox, OUTBOX_LIMIT)
        saveOutbox(context, outbox)
    }

    fun markDelivered(context: Context, messageId: String, targetNodeId: String) {
        val outbox = loadOutbox(context)
        outbox.remove(outboxKey(messageId, targetNodeId))
        saveOutbox(context, outbox)
    }

    fun markFailed(context: Context, messageId: String, targetNodeId: String, reason: String = "") {
        val outbox = loadOutbox(context)
        val key = outboxKey(messageId, targetNodeId)
        val item = outbox.optJSONObject(key) ?: return
        val attempts = item.optInt("attempts", 0) + 1
        val now = System.currentTimeMillis()
        item.put("attempts", attempts)
            .put("lastError", reason)
            .put("updatedAt", now)
        if (attempts >= MAX_ATTEMPTS) {
            item.put("status", "failed").put("nextAttemptAt", 0L)
        } else {
            val delay = min(RETRY_MAX_MS.toDouble(), RETRY_BASE_MS * 2.0.pow((attempts - 1).coerceAtLeast(0))).toLong()
            item.put("status", "pending").put("nextAttemptAt", now + delay)
        }
        outbox.put(key, item)
        saveOutbox(context, outbox)
    }

    fun dueOutbound(context: Context, limit: Int = 30): List<JSONObject> {
        val now = System.currentTimeMillis()
        val outbox = loadOutbox(context)
        val records = mutableListOf<JSONObject>()
        val keys = outbox.keys()
        while (keys.hasNext()) {
            val item = outbox.optJSONObject(keys.next()) ?: continue
            if (item.optString("status", "pending") == "pending" &&
                item.optLong("nextAttemptAt", 0L) <= now
            ) {
                records.add(JSONObject(item.toString()))
            }
        }
        return records
            .sortedBy { it.optLong("nextAttemptAt", it.optLong("createdAt", 0L)) }
            .take(limit)
    }

    private fun envelopeKey(envelope: JSONObject): String {
        val messageId = envelope.optString("messageId").trim()
        if (messageId.isBlank()) return ""
        return listOf(
            envelope.optString("networkId").trim(),
            envelope.optString("topic").trim(),
            envelope.optString("originNodeId", envelope.optString("sourceNodeId")).trim(),
            messageId
        ).joinToString("|")
    }

    private fun outboxKey(messageId: String, targetNodeId: String): String =
        "${messageId.trim()}|${targetNodeId.trim()}"

    private fun loadSeen(context: Context): JSONObject =
        runCatching { JSONObject(prefs(context).getString(KEY_SEEN, "{}").orEmpty()) }
            .getOrElse { JSONObject() }

    private fun saveSeen(context: Context, seen: JSONObject) {
        prefs(context).edit().putString(KEY_SEEN, seen.toString()).apply()
    }

    private fun loadOutbox(context: Context): JSONObject =
        runCatching { JSONObject(prefs(context).getString(KEY_OUTBOX, "{}").orEmpty()) }
            .getOrElse { JSONObject() }

    private fun saveOutbox(context: Context, outbox: JSONObject) {
        prefs(context).edit().putString(KEY_OUTBOX, outbox.toString()).apply()
    }

    private fun pruneSeen(seen: JSONObject, now: Long) {
        val remove = mutableListOf<String>()
        val keys = seen.keys()
        while (keys.hasNext()) {
            val key = keys.next()
            if (now - seen.optLong(key, 0L) > SEEN_TTL_MS) remove.add(key)
        }
        remove.forEach { seen.remove(it) }
    }

    private fun trimObject(obj: JSONObject, limit: Int) {
        val entries = mutableListOf<Pair<String, Long>>()
        val keys = obj.keys()
        while (keys.hasNext()) {
            val key = keys.next()
            val value = obj.opt(key)
            val ts = when (value) {
                is JSONObject -> value.optLong("updatedAt", value.optLong("createdAt", 0L))
                else -> obj.optLong(key, 0L)
            }
            entries.add(key to ts)
        }
        entries
            .sortedByDescending { it.second }
            .drop(limit)
            .forEach { obj.remove(it.first) }
    }

    private fun prefs(context: Context) = SecurePrefs.get(context, PREFS)
}
