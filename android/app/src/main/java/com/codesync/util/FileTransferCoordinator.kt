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
    val payload: JSONObject,
    val batchCount: Int = 0
)

object FileTransferCoordinator {
    const val ACTION_FILE_TRANSFER_REQUEST = "com.codesync.FILE_TRANSFER_REQUEST"
    const val EXTRA_REQUEST_ID = "request_id"

    private const val APPROVAL_TIMEOUT_MS = 120000L
    private const val BATCH_DECISION_TTL_MS = 10 * 60 * 1000L

    private val pending =
        ConcurrentHashMap<String, Pair<PendingFileTransferRequest, CompletableDeferred<FileTransferDecision>>>()

    // 同批（batchId）只弹一次确认：首个请求持有弹窗权，其余等待同一结论；
    // 结论在窗口期内缓存，对确认后才到达的同批 manifest 直接生效
    private val batchPending = ConcurrentHashMap<String, CompletableDeferred<FileTransferDecision>>()
    private val batchDecided = ConcurrentHashMap<String, Pair<FileTransferDecision, Long>>()

    suspend fun requestApproval(context: Context, payload: JSONObject): FileTransferDecision {
        val manifest = payload.optJSONObject("fileManifest") ?: return FileTransferDecision(false)
        val batchId = payload.optString("batchId").trim()
        val deferred = CompletableDeferred<FileTransferDecision>()
        if (batchId.isNotBlank()) {
            pruneBatchDecisions()
            batchDecided[batchId]?.let { return it.first }
            val existing = batchPending.putIfAbsent(batchId, deferred)
            if (existing != null) {
                return withTimeoutOrNull(APPROVAL_TIMEOUT_MS) { existing.await() } ?: FileTransferDecision(false)
            }
        }
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
            payload = JSONObject(payload.toString()),
            batchCount = payload.optInt("batchCount", 0)
        )
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
        val decision = withTimeoutOrNull(APPROVAL_TIMEOUT_MS) { deferred.await() } ?: FileTransferDecision(false)
        pending.remove(request.requestId)
        if (batchId.isNotBlank()) {
            // 超时未决也算拒绝：让 decided 缓存挡住同批余下文件重复弹窗
            if (!deferred.isCompleted) deferred.complete(decision)
            batchDecided[batchId] = decision to System.currentTimeMillis()
            batchPending.remove(batchId)
        }
        return decision
    }

    fun getPending(requestId: String): PendingFileTransferRequest? =
        pending[requestId]?.first

    fun respond(requestId: String, accepted: Boolean): Boolean {
        val entry = pending.remove(requestId) ?: return false
        entry.second.complete(FileTransferDecision(accepted))
        return true
    }

    private fun pruneBatchDecisions() {
        val now = System.currentTimeMillis()
        val iterator = batchDecided.entries.iterator()
        while (iterator.hasNext()) {
            if (now - iterator.next().value.second > BATCH_DECISION_TTL_MS) iterator.remove()
        }
    }
}
