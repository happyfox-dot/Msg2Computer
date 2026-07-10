package com.codesync.util

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import kotlin.math.min
import kotlin.math.pow

object BusReliabilityStore {
    private const val TAG = "BusReliabilityStore"
    private const val PREFS = "bus_reliability"
    private const val KEY_SEEN = "seen"
    private const val KEY_OUTBOX = "outbox"
    private const val SEEN_LIMIT = 1000
    private const val OUTBOX_LIMIT = 80
    private const val MAX_OUTBOX_BYTES = 512 * 1024
    private const val MAX_RECORD_BYTES = 64 * 1024
    private const val SEEN_TTL_MS = 24 * 60 * 60 * 1000L
    private const val RETRY_BASE_MS = 15 * 1000L
    private const val RETRY_MAX_MS = 5 * 60 * 1000L
    private const val MAX_ATTEMPTS = 4
    private val lock = Any()

    fun rememberInbound(context: Context, envelope: JSONObject): Boolean {
        val key = envelopeKey(envelope)
        if (key.isBlank()) return true
        synchronized(lock) {
            val now = System.currentTimeMillis()
            val seen = loadSeen(context) ?: return false
            pruneSeen(seen, now)
            if (seen.has(key)) {
                saveSeen(context, seen)
                return false
            }
            seen.put(key, now)
            trimObject(seen, SEEN_LIMIT)
            return saveSeen(context, seen)
        }
    }

    fun rememberOutbound(context: Context, envelope: JSONObject, targetNodeId: String) {
        val messageId = envelope.optString("messageId").trim()
        val target = targetNodeId.trim()
        if (messageId.isBlank() || target.isBlank()) return
        if (!shouldPersistOutbound(envelope)) return
        val envelopeCopy = safeEnvelopeCopy(envelope) ?: return
        synchronized(lock) {
            val outbox = loadOutbox(context) ?: return
            val key = outboxKey(messageId, target)
            val now = System.currentTimeMillis()
            outbox.put(
                key,
                JSONObject()
                    .put("messageId", messageId)
                    .put("targetNodeId", target)
                    .put("topic", envelope.optString("topic"))
                    .put("envelope", envelopeCopy)
                    .put("status", "pending")
                    .put("attempts", outbox.optJSONObject(key)?.optInt("attempts", 0) ?: 0)
                    .put("createdAt", outbox.optJSONObject(key)?.optLong("createdAt", now) ?: now)
                    .put("updatedAt", now)
                    .put("nextAttemptAt", outbox.optJSONObject(key)?.optLong("nextAttemptAt", 0L) ?: 0L)
            )
            trimObject(outbox, OUTBOX_LIMIT)
            saveOutbox(context, outbox)
        }
    }

    fun markDelivered(context: Context, messageId: String, targetNodeId: String) {
        synchronized(lock) {
            val outbox = loadOutbox(context) ?: return
            outbox.remove(outboxKey(messageId, targetNodeId))
            saveOutbox(context, outbox)
        }
    }

    fun markFailed(context: Context, messageId: String, targetNodeId: String, reason: String = "") {
        synchronized(lock) {
            val outbox = loadOutbox(context) ?: return
            val key = outboxKey(messageId, targetNodeId)
            val item = outbox.optJSONObject(key) ?: return
            val attempts = item.optInt("attempts", 0) + 1
            val now = System.currentTimeMillis()
            if (attempts >= MAX_ATTEMPTS || !shouldPersistRecord(item)) {
                outbox.remove(key)
                saveOutbox(context, outbox)
                return
            }
            item.put("attempts", attempts)
                .put("lastError", reason)
                .put("updatedAt", now)
            val delay = min(RETRY_MAX_MS.toDouble(), RETRY_BASE_MS * 2.0.pow((attempts - 1).coerceAtLeast(0))).toLong()
            item.put("status", "pending").put("nextAttemptAt", now + delay)
            outbox.put(key, item)
            saveOutbox(context, outbox)
        }
    }

    fun dueOutbound(context: Context, limit: Int = 30): List<JSONObject> {
        synchronized(lock) {
            val now = System.currentTimeMillis()
            val outbox = loadOutbox(context) ?: return emptyList()
            val records = mutableListOf<JSONObject>()
            val remove = mutableListOf<String>()
            val keys = outbox.keys()
            while (keys.hasNext()) {
                val key = keys.next()
                val item = outbox.optJSONObject(key) ?: continue
                if (!shouldPersistRecord(item)) {
                    remove.add(key)
                    continue
                }
                if (item.optString("status", "pending") == "pending" &&
                    item.optLong("nextAttemptAt", 0L) <= now
                ) {
                    runCatching { records.add(JSONObject(item.toString())) }
                }
            }
            if (remove.isNotEmpty()) {
                remove.forEach { outbox.remove(it) }
                saveOutbox(context, outbox)
            }
            return records
                .sortedBy { it.optLong("nextAttemptAt", it.optLong("createdAt", 0L)) }
                .take(limit)
        }
    }

    private fun envelopeKey(envelope: JSONObject): String =
        ContentBus.businessDedupeKey(envelope)

    private fun outboxKey(messageId: String, targetNodeId: String): String =
        "${messageId.trim()}|${targetNodeId.trim()}"

    private fun loadSeen(context: Context): JSONObject? {
        val preferences = prefs(context)
        if (!SecurePrefs.isStorageAvailable(preferences)) return null
        return runCatching { JSONObject(preferences.getString(KEY_SEEN, "{}").orEmpty()) }
            .onFailure { safeStorageLog(TAG, "Unable to read encrypted inbound dedupe state", it) }
            .getOrNull()
    }

    private fun saveSeen(context: Context, seen: JSONObject): Boolean {
        val preferences = prefs(context)
        if (!SecurePrefs.isStorageAvailable(preferences)) return false
        return runCatching { preferences.edit().putString(KEY_SEEN, seen.toString()).commit() }
            .onFailure { safeStorageLog(TAG, "Unable to save encrypted inbound dedupe state", it) }
            .getOrDefault(false)
    }

    private fun loadOutbox(context: Context): JSONObject? {
        val preferences = prefs(context)
        if (!SecurePrefs.isStorageAvailable(preferences)) return null
        return runCatching {
            val raw = preferences.getString(KEY_OUTBOX, "{}").orEmpty()
            if (raw.toByteArray(Charsets.UTF_8).size > MAX_OUTBOX_BYTES * 2) {
                throw IllegalStateException("encrypted outbox exceeds safety limit")
            } else {
                JSONObject(raw)
            }
        }.onFailure { safeStorageLog(TAG, "Unable to read encrypted outbox; preserving source", it) }
            .getOrNull()
    }

    private fun saveOutbox(context: Context, outbox: JSONObject): Boolean {
        pruneOutbox(outbox)
        val serialized = runCatching { outbox.toString() }.getOrElse {
            safeStorageLog(TAG, "Unable to serialize outbox; preserving stored value", it)
            return false
        }
        if (serialized.toByteArray(Charsets.UTF_8).size > MAX_OUTBOX_BYTES) {
            shrinkOutboxToBudget(outbox)
        }
        val compact = runCatching { outbox.toString() }.getOrElse {
            safeStorageLog(TAG, "Unable to compact outbox; preserving stored value", it)
            return false
        }
        val preferences = prefs(context)
        if (!SecurePrefs.isStorageAvailable(preferences)) return false
        return runCatching { preferences.edit().putString(KEY_OUTBOX, compact).commit() }
            .onFailure { safeStorageLog(TAG, "Unable to save encrypted outbox; preserving stored value", it) }
            .getOrDefault(false)
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

    private fun shouldPersistOutbound(envelope: JSONObject): Boolean {
        val topic = envelope.optString("topic")
        val payload = envelope.optJSONObject("payload")
        val expiresAt = envelope.optLong("expiresAt", 0L).takeIf { it > 0L }
            ?: payload?.optLong("expiresAt", 0L)?.takeIf { it > 0L }
        if (expiresAt != null && expiresAt <= System.currentTimeMillis()) return false
        val manifest = payload?.optJSONObject("fileManifest")
        if (manifest != null) {
            if (manifest.optBoolean("inline", false)) return false
            val manifestExpiresAt = manifest.optLong("expiresAt", 0L)
            if (manifestExpiresAt > 0L && manifestExpiresAt <= System.currentTimeMillis()) return false
        } else if (
            topic == ContentBus.Topic.CLIPBOARD_IMAGE ||
            topic == ContentBus.Topic.CLIPBOARD_FILE ||
            topic == ContentBus.Topic.FILE_MANIFEST
        ) {
            return false
        }
        val size = runCatching { envelope.toString().toByteArray(Charsets.UTF_8).size }
            .getOrDefault(MAX_RECORD_BYTES + 1)
        return size in 1..MAX_RECORD_BYTES
    }

    private fun safeEnvelopeCopy(envelope: JSONObject): JSONObject? {
        if (!shouldPersistOutbound(envelope)) return null
        return runCatching { JSONObject(envelope.toString()) }.getOrNull()
    }

    private fun shouldPersistRecord(item: JSONObject): Boolean {
        val envelope = item.optJSONObject("envelope") ?: return false
        if (!shouldPersistOutbound(envelope)) return false
        val size = runCatching { item.toString().toByteArray(Charsets.UTF_8).size }
            .getOrDefault(MAX_RECORD_BYTES + 1)
        return size in 1..MAX_RECORD_BYTES
    }

    private fun pruneOutbox(outbox: JSONObject) {
        val remove = mutableListOf<String>()
        val keys = outbox.keys()
        while (keys.hasNext()) {
            val key = keys.next()
            val item = outbox.optJSONObject(key)
            if (item == null || !shouldPersistRecord(item)) remove.add(key)
        }
        remove.forEach { outbox.remove(it) }
        trimObject(outbox, OUTBOX_LIMIT)
    }

    private fun shrinkOutboxToBudget(outbox: JSONObject) {
        pruneOutbox(outbox)
        while (runCatching { outbox.toString().toByteArray(Charsets.UTF_8).size }
                .getOrDefault(MAX_OUTBOX_BYTES + 1) > MAX_OUTBOX_BYTES
        ) {
            val oldest = oldestKey(outbox) ?: break
            outbox.remove(oldest)
        }
    }

    private fun oldestKey(obj: JSONObject): String? {
        var oldestKey: String? = null
        var oldestTs = Long.MAX_VALUE
        val keys = obj.keys()
        while (keys.hasNext()) {
            val key = keys.next()
            val value = obj.optJSONObject(key)
            val ts = if (value != null) value.optLong("updatedAt", value.optLong("createdAt", 0L)) else 0L
            if (ts < oldestTs) {
                oldestTs = ts
                oldestKey = key
            }
        }
        return oldestKey
    }

    private fun prefs(context: Context) = SecurePrefs.get(context, PREFS)
}
