package com.codesync.util

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

data class FileTransferHistoryEntry(
    val id: String,
    val fileId: String,
    val name: String,
    val path: String,
    val size: Long,
    val mime: String,
    val sourceDeviceId: String,
    val sourceDeviceName: String,
    val receivedAt: Long,
    val exists: Boolean
)

object FileTransferHistoryStore {
    private const val PREFS = "file_transfer_history"
    private const val KEY_ITEMS = "items"
    private const val LIMIT = 200

    fun get(context: Context): List<FileTransferHistoryEntry> {
        val raw = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .getString(KEY_ITEMS, "[]")
            .orEmpty()
        val array = runCatching { JSONArray(raw) }.getOrDefault(JSONArray())
        val items = mutableListOf<FileTransferHistoryEntry>()
        for (index in 0 until array.length()) {
            val item = array.optJSONObject(index) ?: continue
            val path = item.optString("path").trim()
            val name = item.optString("name").ifBlank { File(path).name }
            if (path.isBlank() || name.isBlank()) continue
            items += FileTransferHistoryEntry(
                id = item.optString("id").ifBlank {
                    item.optString("fileId").ifBlank { "$path-${item.optLong("receivedAt")}" }
                },
                fileId = item.optString("fileId"),
                name = name,
                path = path,
                size = item.optLong("size", 0L),
                mime = item.optString("mime"),
                sourceDeviceId = item.optString("sourceDeviceId"),
                sourceDeviceName = item.optString("sourceDeviceName").ifBlank { "未知设备" },
                receivedAt = item.optLong("receivedAt", 0L),
                exists = File(path).exists()
            )
        }
        return items.sortedByDescending { it.receivedAt }.take(LIMIT)
    }

    fun addReceived(
        context: Context,
        fileId: String,
        name: String,
        path: String,
        size: Long,
        mime: String,
        sourceDeviceId: String,
        sourceDeviceName: String
    ) {
        val now = System.currentTimeMillis()
        val entry = JSONObject()
            .put("id", fileId.ifBlank { "$path-$now" })
            .put("fileId", fileId)
            .put("name", name)
            .put("path", path)
            .put("size", size)
            .put("mime", mime)
            .put("sourceDeviceId", sourceDeviceId)
            .put("sourceDeviceName", sourceDeviceName.ifBlank { "未知设备" })
            .put("receivedAt", now)

        val existing = get(context)
            .filterNot { it.fileId == fileId || it.path == path }
            .map { toJson(it) }
        val next = JSONArray().put(entry)
        existing.take(LIMIT - 1).forEach { next.put(it) }
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit()
            .putString(KEY_ITEMS, next.toString())
            .apply()
    }

    private fun toJson(entry: FileTransferHistoryEntry): JSONObject =
        JSONObject()
            .put("id", entry.id)
            .put("fileId", entry.fileId)
            .put("name", entry.name)
            .put("path", entry.path)
            .put("size", entry.size)
            .put("mime", entry.mime)
            .put("sourceDeviceId", entry.sourceDeviceId)
            .put("sourceDeviceName", entry.sourceDeviceName)
            .put("receivedAt", entry.receivedAt)
}
