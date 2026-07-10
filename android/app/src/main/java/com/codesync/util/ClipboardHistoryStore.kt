package com.codesync.util

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.security.MessageDigest

data class ClipboardHistoryEntry(
    val id: String,
    val kind: String,
    val direction: String,
    val title: String,
    val text: String,
    val path: String,
    val mime: String,
    val size: Long,
    val sourceDeviceId: String,
    val sourceDeviceName: String,
    val createdAt: Long,
    val contentKey: String,
    val exists: Boolean
)

object ClipboardHistoryStore {
    private const val TAG = "ClipboardHistory"
    private const val PREFS = "clipboard_history"
    private const val KEY_ITEMS = "items"
    private const val LIMIT = 50
    private val historyLock = Any()
    private var lastKnownEntries: List<ClipboardHistoryEntry>? = null

    private fun readEntries(context: Context): List<ClipboardHistoryEntry>? {
        val preferences = prefs(context)
        if (!SecurePrefs.isStorageAvailable(preferences)) return null
        val raw = runCatching { preferences.getString(KEY_ITEMS, "[]").orEmpty() }
            .onFailure { safeStorageLog(TAG, "Unable to read encrypted clipboard history", it) }
            .getOrNull() ?: return null
        val array = runCatching { JSONArray(raw) }
            .onFailure { safeStorageLog(TAG, "Malformed encrypted clipboard history; preserving source", it) }
            .getOrNull() ?: return null
        val items = mutableListOf<ClipboardHistoryEntry>()
        for (index in 0 until array.length()) {
            val item = array.optJSONObject(index) ?: return null
            val kind = item.optString("kind", "text").ifBlank { "text" }
            val path = item.optString("path")
            val text = item.optString("text")
            if (kind == "text" && text.isBlank()) return null
            if (kind != "text" && path.isBlank()) return null
            items += ClipboardHistoryEntry(
                id = item.optString("id").ifBlank { "${kind}-${item.optLong("createdAt")}-$index" },
                kind = kind,
                direction = item.optString("direction", "incoming").ifBlank { "incoming" },
                title = item.optString("title").ifBlank { defaultTitle(kind) },
                text = text,
                path = path,
                mime = item.optString("mime"),
                size = item.optLong("size", if (path.isNotBlank()) File(path).length() else text.length.toLong()),
                sourceDeviceId = item.optString("sourceDeviceId"),
                sourceDeviceName = item.optString("sourceDeviceName").ifBlank { "本机" },
                createdAt = item.optLong("createdAt", 0L),
                contentKey = item.optString("contentKey").ifBlank {
                    buildContentKey(
                        kind = kind,
                        direction = item.optString("direction", "incoming").ifBlank { "incoming" },
                        sourceDeviceId = item.optString("sourceDeviceId"),
                        text = text,
                        title = item.optString("title"),
                        mime = item.optString("mime"),
                        size = item.optLong("size", if (path.isNotBlank()) File(path).length() else text.length.toLong()),
                        path = path
                    )
                },
                exists = path.isBlank() || File(path).exists()
            )
        }
        return items.sortedByDescending { it.createdAt }.take(LIMIT)
    }

    fun get(context: Context): List<ClipboardHistoryEntry> = synchronized(historyLock) {
        val loaded = readEntries(context)
        if (loaded != null) lastKnownEntries = loaded
        loaded ?: lastKnownEntries ?: emptyList()
    }

    fun addText(
        context: Context,
        text: String,
        direction: String,
        sourceDeviceId: String,
        sourceDeviceName: String,
        createdAt: Long = System.currentTimeMillis()
    ) {
        val clean = text.trim()
        if (clean.isBlank()) return
        add(
            context,
            JSONObject()
                .put("id", "text-$direction-${sourceDeviceId.ifBlank { "local" }}-$createdAt-${hash(clean)}")
                .put("kind", "text")
                .put("direction", direction)
                .put("title", "文本剪贴板")
                .put("text", clean)
                .put("sourceDeviceId", sourceDeviceId)
                .put("sourceDeviceName", sourceDeviceName.ifBlank { "本机" })
                .put("createdAt", createdAt)
                .put(
                    "contentKey",
                    buildContentKey(
                        kind = "text",
                        direction = direction,
                        sourceDeviceId = sourceDeviceId,
                        text = clean
                    )
                )
        )
    }

    fun addFile(
        context: Context,
        kind: String,
        direction: String,
        title: String,
        path: String,
        mime: String,
        size: Long,
        sourceDeviceId: String,
        sourceDeviceName: String,
        createdAt: Long = System.currentTimeMillis()
    ) {
        val filePath = path.trim()
        if (filePath.isBlank()) return
        val normalizedKind = when (kind) {
            "image", "file" -> kind
            else -> "file"
        }
        val name = title.ifBlank { File(filePath).name.ifBlank { defaultTitle(normalizedKind) } }
        add(
            context,
            JSONObject()
                .put("id", "$normalizedKind-$direction-${sourceDeviceId.ifBlank { "local" }}-$createdAt-${hash(filePath)}")
                .put("kind", normalizedKind)
                .put("direction", direction)
                .put("title", name)
                .put("path", filePath)
                .put("mime", mime)
                .put("size", size.takeIf { it > 0L } ?: File(filePath).length())
                .put("sourceDeviceId", sourceDeviceId)
                .put("sourceDeviceName", sourceDeviceName.ifBlank { "本机" })
                .put("createdAt", createdAt)
                .put(
                    "contentKey",
                    buildContentKey(
                        kind = normalizedKind,
                        direction = direction,
                        sourceDeviceId = sourceDeviceId,
                        title = name,
                        mime = mime,
                        size = size.takeIf { it > 0L } ?: File(filePath).length(),
                        path = filePath
                    )
                )
        )
    }

    private fun add(context: Context, entry: JSONObject) {
        synchronized(historyLock) {
            val contentKey = entry.optString("contentKey")
            val loaded = readEntries(context) ?: return
            val existing = loaded
                .filterNot { it.id == entry.optString("id") || (contentKey.isNotBlank() && it.contentKey == contentKey) }
                .map(::toJson)
            val next = JSONArray().put(entry)
            existing.take(LIMIT - 1).forEach { next.put(it) }
            // commit keeps the read/modify/write transaction durable before the lock
            // is released. Clipboard content is sensitive, so it lives in encrypted
            // preferences and never in the legacy plaintext preference file.
            val preferences = prefs(context)
            if (!SecurePrefs.isStorageAvailable(preferences)) return
            val committed = runCatching {
                preferences.edit().putString(KEY_ITEMS, next.toString()).commit()
            }.onFailure { safeStorageLog(TAG, "Unable to persist encrypted clipboard history", it) }
                .getOrDefault(false)
            if (committed) readEntries(context)?.let { lastKnownEntries = it }
        }
    }

    private fun toJson(entry: ClipboardHistoryEntry): JSONObject =
        JSONObject()
            .put("id", entry.id)
            .put("kind", entry.kind)
            .put("direction", entry.direction)
            .put("title", entry.title)
            .put("text", entry.text)
            .put("path", entry.path)
            .put("mime", entry.mime)
            .put("size", entry.size)
            .put("sourceDeviceId", entry.sourceDeviceId)
            .put("sourceDeviceName", entry.sourceDeviceName)
            .put("createdAt", entry.createdAt)
            .put("contentKey", entry.contentKey)

    private fun defaultTitle(kind: String): String = when (kind) {
        "image" -> "图片剪贴板"
        "file" -> "文件剪贴板"
        else -> "文本剪贴板"
    }

    private fun hash(value: String): String {
        val digest = MessageDigest.getInstance("SHA-256").digest(value.toByteArray(Charsets.UTF_8))
        return digest.joinToString("") { "%02x".format(it) }.take(12)
    }

    private fun buildContentKey(
        kind: String,
        direction: String,
        sourceDeviceId: String,
        text: String = "",
        title: String = "",
        mime: String = "",
        size: Long = 0L,
        path: String = ""
    ): String {
        val source = sourceDeviceId.ifBlank { "local" }
        val material = if (kind == "text") {
            text.trim()
        } else {
            listOf(title, mime, size.toString(), File(path).name).joinToString("|")
        }
        return "$kind|$direction|$source|${hash(material)}"
    }

    private fun prefs(context: Context) =
        SecurePrefs.get(context, PREFS)
}
