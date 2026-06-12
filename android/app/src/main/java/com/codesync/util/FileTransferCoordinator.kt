package com.codesync.util

import android.content.Context
import android.content.Intent
import com.codesync.MainActivity
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.withTimeoutOrNull
import org.json.JSONObject
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

data class FileTransferDecision(
    val accepted: Boolean
)

data class PendingFileTransferRequest(
    val requestId: String,
    val sourceDeviceId: String,
    val sourceDeviceName: String,
    val fileName: String,
    val mime: String,
    val size: Long,
    val sha256: String,
    val expiresAt: Long,
    val payload: JSONObject
)

object FileTransferCoordinator {
    const val ACTION_FILE_TRANSFER_REQUEST = "com.codesync.FILE_TRANSFER_REQUEST"
    const val EXTRA_REQUEST_ID = "request_id"

    private val pending =
        ConcurrentHashMap<String, Pair<PendingFileTransferRequest, CompletableDeferred<FileTransferDecision>>>()

    suspend fun requestApproval(context: Context, payload: JSONObject): FileTransferDecision {
        val manifest = payload.optJSONObject("fileManifest") ?: return FileTransferDecision(false)
        val request = PendingFileTransferRequest(
            requestId = "file-${UUID.randomUUID()}",
            sourceDeviceId = manifest.optString("originDeviceId")
                .ifBlank { payload.optString("originDeviceId") }
                .ifBlank { payload.optString("sourceDeviceId") },
            sourceDeviceName = manifest.optString("originDeviceName")
                .ifBlank { payload.optString("originDeviceName") }
                .ifBlank { payload.optString("sourceDeviceName", "未知设备") },
            fileName = manifest.optString("name").ifBlank { payload.optString("label", "文件") },
            mime = manifest.optString("mime", "application/octet-stream"),
            size = manifest.optLong("size", 0L),
            sha256 = manifest.optString("sha256"),
            expiresAt = manifest.optLong("expiresAt", 0L),
            payload = JSONObject(payload.toString())
        )
        val deferred = CompletableDeferred<FileTransferDecision>()
        pending[request.requestId] = request to deferred
        val activityIntent = Intent(context, MainActivity::class.java).apply {
            action = ACTION_FILE_TRANSFER_REQUEST
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
            putExtra(EXTRA_REQUEST_ID, request.requestId)
        }
        context.startActivity(activityIntent)
        context.sendBroadcast(Intent(ACTION_FILE_TRANSFER_REQUEST).apply {
            setPackage(context.packageName)
            putExtra(EXTRA_REQUEST_ID, request.requestId)
        })
        val decision = withTimeoutOrNull(120000L) { deferred.await() } ?: FileTransferDecision(false)
        pending.remove(request.requestId)
        return decision
    }

    fun getPending(requestId: String): PendingFileTransferRequest? =
        pending[requestId]?.first

    fun respond(requestId: String, accepted: Boolean): Boolean {
        val entry = pending.remove(requestId) ?: return false
        entry.second.complete(FileTransferDecision(accepted))
        return true
    }
}
