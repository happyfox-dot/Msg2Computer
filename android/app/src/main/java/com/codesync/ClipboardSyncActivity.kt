package com.codesync

import android.content.ClipData
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.OpenableColumns
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import com.codesync.service.WebSocketService
import com.codesync.util.ClipboardHistoryStore
import com.codesync.util.ClipboardSyncState
import com.codesync.util.FileTransferRegistry
import com.codesync.util.PhoneIdentityStore
import com.codesync.util.RouteManager
import com.codesync.util.SettingsStore
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File
import java.io.FileOutputStream
import java.util.UUID

/**
 * Transparent focused activity used by the quick-settings tile to read the clipboard once.
 * Android 10+ only grants clipboard reads to the focused app.
 */
class ClipboardSyncActivity : AppCompatActivity() {

    private var handled = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (!hasFocus || handled) return
        handled = true
        syncClipboardOnce()
    }

    private fun syncClipboardOnce() {
        if (!SettingsStore.isSyncClipboardEnabled(this)) {
            finishWithToast(getString(R.string.clipboard_sync_disabled))
            return
        }
        val clipboard = getSystemService(Context.CLIPBOARD_SERVICE) as android.content.ClipboardManager
        val clip = clipboard.primaryClip?.takeIf { it.itemCount > 0 }
        if (clip == null) {
            finishWithToast(getString(R.string.clipboard_empty))
            return
        }
        val uris = (0 until clip.itemCount).mapNotNull { clip.getItemAt(it).uri }
        if (uris.isNotEmpty()) {
            syncUriClipboard(clip, uris)
            return
        }
        syncTextClipboard(clip)
    }

    private fun syncTextClipboard(clip: ClipData) {
        if (!hasTarget("clipboard_text")) {
            finishWithToast(getString(R.string.clipboard_no_target))
            return
        }
        // URI items were handled before this point. Keep user whitespace exactly as copied.
        val text = clip.getItemAt(0).coerceToText(this)?.toString().orEmpty()
        if (text.isBlank()) {
            finishWithToast(getString(R.string.clipboard_empty))
            return
        }
        PhoneIdentityStore.get(this).let { identity ->
            ClipboardHistoryStore.addText(
                context = this,
                text = text,
                direction = "outgoing",
                sourceDeviceId = identity.id,
                sourceDeviceName = identity.name
            )
        }
        val intent = Intent(this, WebSocketService::class.java).apply {
            action = WebSocketService.ACTION_SEND_CLIPBOARD
            putExtra(WebSocketService.EXTRA_MESSAGE_BODY, text)
        }
        if (startForwardService(intent)) {
            finishWithToast(getString(R.string.clipboard_sent))
        }
    }

    private fun syncUriClipboard(clip: ClipData, uris: List<Uri>) {
        val singleImage = uris.size == 1 && isImageUri(clip, uris.first())
        val contentType = if (singleImage) "clipboard_image" else "clipboard_file"
        val featureEnabled = if (singleImage) {
            SettingsStore.isSyncClipboardImageEnabled(this)
        } else {
            SettingsStore.isSyncClipboardFileEnabled(this)
        }
        if (!featureEnabled) {
            finishWithToast(if (singleImage) "图片剪贴板同步未开启" else getString(R.string.file_transfer_disabled))
            return
        }
        if (!hasTarget(contentType)) {
            finishWithToast(if (singleImage) "没有启用图片剪贴板的推送目标" else getString(R.string.file_no_target))
            return
        }

        val appliedTs = ClipboardSyncState.appliedTs(this)
        val capturedAt = maxOf(
            System.currentTimeMillis(),
            if (appliedTs == Long.MAX_VALUE) Long.MAX_VALUE else appliedTs + 1L
        )
        val batchId = if (singleImage) "" else "clip-files-$capturedAt-${UUID.randomUUID()}"
        val identity = PhoneIdentityStore.get(this)
        val reservationHash = if (singleImage) {
            ClipboardSyncState.hash("pending-image:$capturedAt:${uris.first()}")
        } else {
            ClipboardSyncState.hash("clipboard-file-batch:$batchId")
        }
        ClipboardSyncState.rememberHash(
            this,
            capturedAt,
            identity.id,
            reservationHash,
            if (singleImage) "image" else "file"
        )
        lifecycleScope.launch {
            val prepared = withContext(Dispatchers.IO) {
                runCatching { uris.map { prepareUri(it, clip) } }
            }
            prepared.onSuccess { files ->
                var started = true
                for (item in files) {
                    val intent = Intent(this@ClipboardSyncActivity, WebSocketService::class.java).apply {
                        action = WebSocketService.ACTION_SEND_FILE
                        putExtra(WebSocketService.EXTRA_CONTENT_TYPE, contentType)
                        putExtra(WebSocketService.EXTRA_FILE_PATH, item.file.absolutePath)
                        putExtra(WebSocketService.EXTRA_FILE_NAME, item.name)
                        putExtra(WebSocketService.EXTRA_FILE_MIME, item.mime)
                        if (singleImage) {
                            putExtra(WebSocketService.EXTRA_CLIP_VERSION_TS, capturedAt)
                        } else {
                            putExtra(WebSocketService.EXTRA_BATCH_ID, batchId)
                            putExtra(WebSocketService.EXTRA_BATCH_COUNT, files.size)
                        }
                    }
                    if (!startForwardService(intent)) {
                        started = false
                        break
                    }
                }
                if (started) {
                    val historyIdentity = PhoneIdentityStore.get(this@ClipboardSyncActivity)
                    files.forEach { item ->
                        ClipboardHistoryStore.addFile(
                            context = this@ClipboardSyncActivity,
                            kind = if (singleImage) "image" else "file",
                            direction = "outgoing",
                            title = item.name,
                            path = item.file.absolutePath,
                            mime = item.mime,
                            size = item.file.length(),
                            sourceDeviceId = historyIdentity.id,
                            sourceDeviceName = historyIdentity.name
                        )
                    }
                    finishWithToast(if (singleImage) "图片剪贴板已发送" else "文件剪贴板已开始同步")
                }
            }.onFailure { error ->
                finishWithToast("剪贴板文件读取失败：${error.message ?: error.javaClass.simpleName}")
            }
        }
    }

    private fun hasTarget(type: String): Boolean =
        RouteManager.targetsForType(
            context = this,
            type = type,
            reachableOnly = WebSocketService.requiresLiveDeliveryTarget(type)
        ).isNotEmpty()

    private fun isImageUri(clip: ClipData, uri: Uri): Boolean {
        val mime = resolveMime(clip, uri)
        return mime.startsWith("image/", ignoreCase = true) ||
            (clip.itemCount == 1 && clip.description.hasMimeType("image/*"))
    }

    private data class PreparedUri(val file: File, val name: String, val mime: String)

    private fun prepareUri(uri: Uri, clip: ClipData): PreparedUri {
        val displayName = queryDisplayName(uri).ifBlank { "clipboard-${System.currentTimeMillis()}" }
        val safeName = sanitizeFileName(displayName)
        val directory = File(filesDir, "outgoing_clipboard_tile").apply { mkdirs() }
        directory.listFiles()?.forEach { old ->
            if (System.currentTimeMillis() - old.lastModified() > 30 * 60 * 1000L) {
                runCatching { old.delete() }
            }
        }
        val output = File(directory, "${UUID.randomUUID()}-$safeName")
        try {
            contentResolver.openInputStream(uri)?.use { input ->
                FileOutputStream(output).use { target ->
                    val buffer = ByteArray(128 * 1024)
                    var total = 0L
                    while (true) {
                        val count = input.read(buffer)
                        if (count <= 0) break
                        total += count
                        if (total > 512L * 1024L * 1024L) error("文件超过发送上限")
                        target.write(buffer, 0, count)
                    }
                }
            } ?: error("无法读取 content URI")
            if (output.length() <= 0L) error("文件为空")
        } catch (error: Throwable) {
            runCatching { output.delete() }
            throw error
        }
        return PreparedUri(output, displayName, resolveMime(clip, uri))
    }

    private fun resolveMime(clip: ClipData, uri: Uri): String {
        val fromResolver = runCatching { contentResolver.getType(uri).orEmpty() }.getOrDefault("")
        if (fromResolver.isNotBlank()) return fromResolver
        val inferred = FileTransferRegistry.guessMime(
            queryDisplayName(uri).ifBlank { uri.lastPathSegment.orEmpty() }
        )
        if (inferred != "application/octet-stream") return inferred
        return if (clip.itemCount == 1 && clip.description.hasMimeType("image/*")) {
            "image/png"
        } else {
            inferred
        }
    }

    private fun queryDisplayName(uri: Uri): String = runCatching {
        contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor ->
            if (cursor.moveToFirst()) {
                val index = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                if (index >= 0) return@runCatching cursor.getString(index).orEmpty()
            }
        }
        uri.lastPathSegment.orEmpty()
    }.getOrDefault(uri.lastPathSegment.orEmpty())

    private fun sanitizeFileName(name: String): String =
        name.substringAfterLast('/').substringAfterLast('\\')
            .replace(Regex("[\\\\/\\x00-\\x1F<>:\"|?*]"), "_")
            .trim()
            .take(180)
            .ifBlank { "file" }

    private fun startForwardService(intent: Intent): Boolean {
        return runCatching {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                startForegroundService(intent)
            } else {
                startService(intent)
            }
        }.onFailure { error ->
            finishWithToast("启动同步服务失败：${error.message ?: error.javaClass.simpleName}")
        }.isSuccess
    }

    private fun finishWithToast(message: String) {
        Toast.makeText(this, message, Toast.LENGTH_SHORT).show()
        if (!isFinishing) finish()
    }
}
