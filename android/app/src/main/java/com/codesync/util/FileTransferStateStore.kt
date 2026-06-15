package com.codesync.util

import android.content.Context
import android.content.Intent
import org.json.JSONArray
import org.json.JSONObject

data class FileTransferTask(
    val fileId: String,
    val name: String,
    val mime: String,
    val size: Long,
    val received: Long,
    val sourceDeviceId: String,
    val sourceDeviceName: String,
    val status: String,
    val error: String,
    val payload: String,
    val partPath: String,
    val finalPath: String,
    val createdAt: Long,
    val updatedAt: Long
)

object FileTransferStateStore {
    const val ACTION_FILE_TRANSFER_STATE_CHANGED = "com.codesync.FILE_TRANSFER_STATE_CHANGED"

    const val STATUS_PENDING = "pending"
    const val STATUS_RUNNING = "running"
    const val STATUS_PAUSED = "paused"
    const val STATUS_FAILED = "failed"
    const val STATUS_COMPLETED = "completed"

    private const val PREFS = "file_transfer_state"
    private const val KEY_TASKS = "tasks"
    private const val LIMIT = 120

    fun getAll(context: Context): List<FileTransferTask> {
        val array = loadArray(context)
        val result = mutableListOf<FileTransferTask>()
        for (i in 0 until array.length()) {
            val item = array.optJSONObject(i) ?: continue
            val fileId = item.optString("fileId").trim()
            if (fileId.isBlank()) continue
            result += FileTransferTask(
                fileId = fileId,
                name = item.optString("name").ifBlank { fileId },
                mime = item.optString("mime"),
                size = item.optLong("size", 0L),
                received = item.optLong("received", 0L),
                sourceDeviceId = item.optString("sourceDeviceId"),
                sourceDeviceName = item.optString("sourceDeviceName").ifBlank { "未知设备" },
                status = item.optString("status").ifBlank { STATUS_PENDING },
                error = item.optString("error"),
                payload = item.optString("payload"),
                partPath = item.optString("partPath"),
                finalPath = item.optString("finalPath"),
                createdAt = item.optLong("createdAt", item.optLong("updatedAt", 0L)),
                updatedAt = item.optLong("updatedAt", 0L)
            )
        }
        return result.sortedByDescending { it.updatedAt }
    }

    fun get(context: Context, fileId: String): FileTransferTask? =
        getAll(context).firstOrNull { it.fileId == fileId }

    fun getActive(context: Context): List<FileTransferTask> =
        getAll(context).filter {
            it.status == STATUS_PENDING ||
                it.status == STATUS_RUNNING ||
                it.status == STATUS_PAUSED ||
                it.status == STATUS_FAILED
        }

    fun startOrUpdate(
        context: Context,
        payload: JSONObject,
        received: Long,
        total: Long,
        partPath: String
    ): FileTransferTask? {
        val manifest = payload.optJSONObject("fileManifest") ?: return null
        val fileId = manifest.optString("fileId").trim()
        if (fileId.isBlank()) return null
        val existing = get(context, fileId)
        val now = System.currentTimeMillis()
        val status = if (existing?.status == STATUS_PAUSED) STATUS_PAUSED else STATUS_RUNNING
        return upsert(
            context,
            JSONObject()
                .put("fileId", fileId)
                .put("name", manifest.optString("name").ifBlank { payload.optString("label", "文件") })
                .put("mime", manifest.optString("mime", "application/octet-stream"))
                .put("size", total)
                .put("received", received)
                .put("sourceDeviceId", manifest.optString("originDeviceId").ifBlank { payload.optString("sourceDeviceId") })
                .put("sourceDeviceName", manifest.optString("originDeviceName").ifBlank { payload.optString("sourceDeviceName", "未知设备") })
                .put("status", status)
                .put("error", "")
                .put("payload", payload.toString())
                .put("partPath", partPath)
                .put("finalPath", existing?.finalPath.orEmpty())
                .put("createdAt", existing?.createdAt?.takeIf { it > 0L } ?: now)
                .put("updatedAt", now)
        )
    }

    fun updateProgress(context: Context, fileId: String, received: Long, total: Long) {
        mutate(context, fileId) {
            if (optString("status") != STATUS_PAUSED) {
                put("status", STATUS_RUNNING)
            }
            put("received", received)
            if (total > 0L) put("size", total)
            put("error", "")
        }
    }

    fun pause(context: Context, fileId: String) {
        mutate(context, fileId) {
            put("status", STATUS_PAUSED)
            put("updatedAt", System.currentTimeMillis())
        }
    }

    fun resume(context: Context, fileId: String) {
        mutate(context, fileId) {
            put("status", STATUS_PENDING)
            put("error", "")
            put("updatedAt", System.currentTimeMillis())
        }
    }

    fun markFailed(context: Context, fileId: String, error: String) {
        mutate(context, fileId) {
            put("status", STATUS_FAILED)
            put("error", error)
        }
    }

    fun markCompleted(context: Context, fileId: String, finalPath: String) {
        mutate(context, fileId) {
            put("status", STATUS_COMPLETED)
            put("received", optLong("size", optLong("received", 0L)))
            put("finalPath", finalPath)
            put("error", "")
        }
    }

    fun isPaused(context: Context, fileId: String): Boolean =
        get(context, fileId)?.status == STATUS_PAUSED

    private fun mutate(context: Context, fileId: String, block: JSONObject.() -> Unit) {
        val array = loadArray(context)
        for (i in 0 until array.length()) {
            val item = array.optJSONObject(i) ?: continue
            if (item.optString("fileId") != fileId) continue
            item.block()
            item.put("updatedAt", System.currentTimeMillis())
            saveArray(context, array)
            broadcast(context, fileId)
            return
        }
    }

    private fun upsert(context: Context, item: JSONObject): FileTransferTask {
        val array = loadArray(context)
        val next = JSONArray()
        var replaced = false
        for (i in 0 until array.length()) {
            val existing = array.optJSONObject(i) ?: continue
            if (existing.optString("fileId") == item.optString("fileId")) {
                next.put(item)
                replaced = true
            } else {
                next.put(existing)
            }
        }
        if (!replaced) next.put(item)
        val trimmed = JSONArray()
        val items = (0 until next.length())
            .mapNotNull { next.optJSONObject(it) }
            .sortedByDescending { it.optLong("updatedAt", 0L) }
            .take(LIMIT)
        items.forEach { trimmed.put(it) }
        saveArray(context, trimmed)
        broadcast(context, item.optString("fileId"))
        return get(context, item.optString("fileId"))!!
    }

    private fun loadArray(context: Context): JSONArray =
        runCatching { JSONArray(SecurePrefs.get(context, PREFS).getString(KEY_TASKS, "[]").orEmpty()) }
            .getOrElse { JSONArray() }

    private fun saveArray(context: Context, array: JSONArray) {
        SecurePrefs.get(context, PREFS).edit().putString(KEY_TASKS, array.toString()).apply()
    }

    private fun broadcast(context: Context, fileId: String) {
        context.sendBroadcast(Intent(ACTION_FILE_TRANSFER_STATE_CHANGED).apply {
            setPackage(context.packageName)
            putExtra("file_id", fileId)
        })
    }
}
