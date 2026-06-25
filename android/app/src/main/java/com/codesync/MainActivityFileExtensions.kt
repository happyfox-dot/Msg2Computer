package com.codesync

import android.Manifest
import android.app.DownloadManager
import android.content.BroadcastReceiver
import android.content.ClipData
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.content.res.ColorStateList
import android.graphics.BitmapFactory
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.provider.DocumentsContract
import android.provider.OpenableColumns
import android.provider.Settings
import android.service.notification.NotificationListenerService
import android.text.InputType
import android.view.Gravity
import android.view.LayoutInflater
import android.view.View
import android.widget.CheckBox
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import com.codesync.databinding.ActivityMainBinding
import com.codesync.service.NodeReceiverService
import com.codesync.service.NotificationRelayService
import com.codesync.service.WebSocketService
import com.codesync.util.DesktopDevice
import com.codesync.util.DeviceStore
import com.codesync.util.ApkUpdater
import com.codesync.util.ClipboardHistoryEntry
import com.codesync.util.ClipboardHistoryStore
import com.codesync.util.ClipboardSyncState
import com.codesync.util.FileTransferCoordinator
import com.codesync.util.FileTransferHistoryStore
import com.codesync.util.FileTransferRegistry
import com.codesync.util.FileTransferStateStore
import com.codesync.util.FileTransferTask
import com.codesync.util.GoogleAuthMigrationParser
import com.codesync.util.LanDiscoveredDevice
import com.codesync.util.LanDiscovery
import com.codesync.util.LanJoinClient
import com.codesync.util.LanJoinCoordinator
import com.codesync.util.LanTrustStore
import com.codesync.util.MigrationOtpAccount
import com.codesync.util.PhoneIdentityStore
import com.codesync.util.RouteManager
import com.codesync.util.SettingsStore
import com.codesync.util.TopologyStore
import com.codesync.util.TotpEntry
import com.codesync.util.TotpStore
import com.codesync.util.TotpUtil
import com.codesync.ui.TopologyGraphView
import com.google.android.material.bottomsheet.BottomSheetDialog
import com.google.android.material.button.MaterialButton
import com.google.android.material.materialswitch.MaterialSwitch
import com.google.android.material.textfield.TextInputEditText
import com.google.android.material.textfield.TextInputLayout
import com.google.zxing.BinaryBitmap
import com.google.zxing.DecodeHintType
import com.google.zxing.MultiFormatReader
import com.google.zxing.RGBLuminanceSource
import com.google.zxing.common.HybridBinarizer
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.io.File
import java.io.FileOutputStream

fun MainActivity.showFileTargetSelectionSheet(onSelected: (List<String>) -> Unit) {
    val options = getFileTransferTargetOptions()
    if (options.isEmpty()) {
        Toast.makeText(this, R.string.file_no_target, Toast.LENGTH_SHORT).show()
        return
    }
    val selectable = BooleanArray(options.size) { options[it].reachable && options[it].allowed }
    val selected = BooleanArray(options.size) { selectable[it] }
    val items = options.map { option ->
        val device = option.device
        val type = if (device.type.contains("PHONE", ignoreCase = true)) "手机" else "电脑"
        val host = (listOf(device.host) + device.altHosts).firstOrNull { it.isNotBlank() }.orEmpty()
        listOf(
            device.name,
            option.statusLabel,
            if (option.allowed) "文件权限已开启" else "文件权限未开启",
            option.reason,
            type,
            host
        ).filter { it.isNotBlank() }.joinToString(" · ")
    }
    showMultiChoiceSheet(
        title = getString(R.string.file_target_select),
        message = getString(R.string.file_target_select_desc),
        items = items,
        selected = selected,
        itemEnabled = selectable,
        positiveText = "继续选择文件",
        onPositive = {
            val targetIds = options
                .filterIndexed { index, option -> selected[index] && option.reachable && option.allowed }
                .map { it.device.id }
            if (targetIds.isEmpty()) {
                pendingFileTransferTargetIds = emptyList()
                Toast.makeText(this, R.string.file_target_none_selected, Toast.LENGTH_SHORT).show()
                return@showMultiChoiceSheet
            }
            onSelected(targetIds)
        }
    )
}

fun MainActivity.showFileReceiveHistory() {
    val history = FileTransferHistoryStore.get(this)
    val activeTasks = FileTransferStateStore.getActive(this)
    val (dialog, content) = createBottomSheet(getString(R.string.file_receive_history))
    if (activeTasks.isNotEmpty()) {
        content.addView(TextView(this).apply {
            text = "进行中的文件传输"
            setTextColor(ContextCompat.getColor(this@showFileReceiveHistory, R.color.text_primary))
            textSize = 15f
            setTypeface(typeface, android.graphics.Typeface.BOLD)
            setPadding(0, 14.dp(), 0, 2.dp())
        })
        activeTasks.take(20).forEach { task ->
            addFileTransferTaskRow(content, dialog, task)
        }
    }
    if (history.isEmpty()) {
        content.addView(TextView(this).apply {
            text = getString(R.string.file_history_empty)
            setTextColor(ContextCompat.getColor(this@showFileReceiveHistory, R.color.text_secondary))
            textSize = 13f
            setPadding(0, 12.dp(), 0, 4.dp())
        })
    } else {
        history.take(60).forEach { item ->
            val row = LinearLayout(this).apply {
                orientation = LinearLayout.VERTICAL
                setBackgroundResource(R.drawable.bg_row)
                setPadding(12.dp(), 10.dp(), 12.dp(), 10.dp())
                alpha = if (item.exists) 1f else 0.55f
                isClickable = item.exists
                setOnClickListener {
                    if (item.exists) openReceivedFile(item.path, item.mime)
                }
            }
            row.addView(TextView(this).apply {
                text = item.name
                setTextColor(ContextCompat.getColor(this@showFileReceiveHistory, R.color.text_primary))
                textSize = 14f
                setTypeface(typeface, android.graphics.Typeface.BOLD)
            })
            row.addView(TextView(this).apply {
                val time = if (item.receivedAt > 0) {
                    SimpleDateFormat("MM-dd HH:mm", Locale.getDefault()).format(Date(item.receivedAt))
                } else {
                    ""
                }
                text = listOf(
                    item.sourceDeviceName,
                    formatFileSize(item.size),
                    time,
                    if (item.exists) "" else "文件已移动或删除"
                ).filter { it.isNotBlank() }.joinToString(" · ")
                setTextColor(ContextCompat.getColor(this@showFileReceiveHistory, R.color.text_secondary))
                textSize = 12f
                setPadding(0, 4.dp(), 0, 0)
            })
            row.addView(TextView(this).apply {
                text = item.path
                setTextColor(ContextCompat.getColor(this@showFileReceiveHistory, R.color.text_secondary))
                textSize = 11f
                setPadding(0, 4.dp(), 0, 0)
            })
            if (item.exists) {
                addSheetButton(row, "打开文件", outlined = true) {
                    openReceivedFile(item.path, item.mime)
                }
            }
            content.addView(row, LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
            ).apply {
                topMargin = 8.dp()
            })
        }
    }
    addSheetButton(content, getString(android.R.string.ok), outlined = true) {
        dialog.dismiss()
    }
    dialog.show()
}

fun MainActivity.addFileTransferTaskRow(parent: LinearLayout, dialog: BottomSheetDialog, task: FileTransferTask) {
    val row = LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL
        setBackgroundResource(R.drawable.bg_row)
        setPadding(12.dp(), 10.dp(), 12.dp(), 10.dp())
    }
    row.addView(TextView(this).apply {
        text = task.name
        setTextColor(ContextCompat.getColor(this@addFileTransferTaskRow, R.color.text_primary))
        textSize = 14f
        setTypeface(typeface, android.graphics.Typeface.BOLD)
        maxLines = 2
    })
    val progressPercent = if (task.size > 0L) {
        ((task.received * 100L) / task.size).toInt().coerceIn(0, 100)
    } else {
        0
    }
    row.addView(ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal).apply {
        max = 100
        progress = progressPercent
        setPadding(0, 8.dp(), 0, 0)
    })
    row.addView(TextView(this).apply {
        val time = if (task.updatedAt > 0L) {
            SimpleDateFormat("MM-dd HH:mm:ss", Locale.getDefault()).format(Date(task.updatedAt))
        } else {
            ""
        }
        text = listOf(
            fileTransferStatusLabel(task.status),
            "${formatFileSize(task.received)} / ${formatFileSize(task.size)}",
            task.sourceDeviceName,
            time
        ).filter { it.isNotBlank() }.joinToString(" · ")
        setTextColor(ContextCompat.getColor(this@addFileTransferTaskRow, R.color.text_secondary))
        textSize = 12f
        setPadding(0, 5.dp(), 0, 0)
    })
    if (task.error.isNotBlank()) {
        row.addView(TextView(this).apply {
            text = "错误：${task.error}"
            setTextColor(ContextCompat.getColor(this@addFileTransferTaskRow, R.color.danger))
            textSize = 12f
            setPadding(0, 5.dp(), 0, 0)
        })
    }
    when (task.status) {
        FileTransferStateStore.STATUS_RUNNING,
        FileTransferStateStore.STATUS_PENDING -> {
            addSheetButton(row, "暂停", outlined = true) {
                FileTransferStateStore.pause(this, task.fileId)
                Toast.makeText(this, "已暂停文件接收", Toast.LENGTH_SHORT).show()
                dialog.dismiss()
                showFileReceiveHistory()
            }
        }
        FileTransferStateStore.STATUS_PAUSED -> {
            addSheetButton(row, "继续", outlined = true) {
                resumeFileTransfer(task.fileId)
                Toast.makeText(this, "正在继续接收文件", Toast.LENGTH_SHORT).show()
                dialog.dismiss()
                showFileReceiveHistory()
            }
        }
        FileTransferStateStore.STATUS_FAILED -> {
            addSheetButton(row, "失败重试", outlined = true) {
                resumeFileTransfer(task.fileId)
                Toast.makeText(this, "正在重试文件接收", Toast.LENGTH_SHORT).show()
                dialog.dismiss()
                showFileReceiveHistory()
            }
        }
    }
    parent.addView(row, LinearLayout.LayoutParams(
        LinearLayout.LayoutParams.MATCH_PARENT,
        LinearLayout.LayoutParams.WRAP_CONTENT
    ).apply {
        topMargin = 8.dp()
    })
}

fun MainActivity.fileTransferStatusLabel(status: String): String =
    when (status) {
        FileTransferStateStore.STATUS_PENDING -> "等待中"
        FileTransferStateStore.STATUS_RUNNING -> "接收中"
        FileTransferStateStore.STATUS_PAUSED -> "已暂停"
        FileTransferStateStore.STATUS_FAILED -> "失败"
        FileTransferStateStore.STATUS_COMPLETED -> "已完成"
        else -> status.ifBlank { "未知" }
    }

fun MainActivity.resumeFileTransfer(fileId: String) {
    FileTransferStateStore.resume(this, fileId)
    val intent = Intent(this, NodeReceiverService::class.java).apply {
        action = NodeReceiverService.ACTION_RETRY_FILE_TRANSFER
        putExtra(NodeReceiverService.EXTRA_FILE_ID, fileId)
    }
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        startForegroundService(intent)
    } else {
        startService(intent)
    }
}

fun MainActivity.renderClipboardHistory() {
    val container = binding.clipboardHistoryList
    container.removeAllViews()
    val history = ClipboardHistoryStore.get(this)
    if (history.isEmpty()) {
        container.addView(TextView(this).apply {
            text = getString(R.string.clipboard_history_empty)
            setTextColor(ContextCompat.getColor(this@renderClipboardHistory, R.color.text_secondary))
            textSize = 13f
            gravity = Gravity.CENTER
            setPadding(0, 18.dp(), 0, 8.dp())
        })
        return
    }

    history.take(50).forEach { item ->
        val row = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundResource(R.drawable.bg_row)
            setPadding(12.dp(), 10.dp(), 12.dp(), 10.dp())
            alpha = if (item.exists) 1f else 0.58f
            isClickable = true
            setOnClickListener { showClipboardHistoryDetail(item) }
        }
        row.addView(TextView(this).apply {
            text = "${clipboardKindLabel(item.kind)} · ${clipboardDirectionLabel(item.direction)}"
            setTextColor(ContextCompat.getColor(this@renderClipboardHistory, R.color.text_primary))
            textSize = 14f
            setTypeface(typeface, android.graphics.Typeface.BOLD)
        })
        row.addView(TextView(this).apply {
            text = clipboardHistoryPreview(item)
            setTextColor(ContextCompat.getColor(this@renderClipboardHistory, R.color.text_secondary))
            textSize = 12f
            maxLines = 2
            setPadding(0, 4.dp(), 0, 0)
        })
        row.addView(TextView(this).apply {
            val time = if (item.createdAt > 0L) {
                SimpleDateFormat("MM-dd HH:mm", Locale.getDefault()).format(Date(item.createdAt))
            } else {
                ""
            }
            text = listOf(
                item.sourceDeviceName,
                if (item.kind == "text") "${item.text.length} 字" else formatFileSize(item.size),
                time,
                if (item.exists) "" else "文件已移动或删除"
            ).filter { it.isNotBlank() }.joinToString(" · ")
            setTextColor(ContextCompat.getColor(this@renderClipboardHistory, R.color.text_tertiary))
            textSize = 11f
            setPadding(0, 4.dp(), 0, 0)
        })
        container.addView(row, LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT,
            LinearLayout.LayoutParams.WRAP_CONTENT
        ).apply {
            bottomMargin = 8.dp()
        })
    }
}

fun MainActivity.showClipboardHistoryDetail(item: ClipboardHistoryEntry) {
    val (dialog, content) = createBottomSheet(getString(R.string.clipboard_history_detail))
    val detail = buildList {
        add("类型：${clipboardKindLabel(item.kind)}")
        add("方向：${clipboardDirectionLabel(item.direction)}")
        add("来源：${item.sourceDeviceName}")
        add("时间：${formatFullSyncTime(item.createdAt)}")
        if (item.kind == "text") {
            add("长度：${item.text.length} 字")
            add("")
            add(item.text)
        } else {
            add("大小：${formatFileSize(item.size)}")
            add("MIME：${item.mime.ifBlank { "未知" }}")
            add("路径：${item.path}")
            if (!item.exists) add("状态：文件已移动或删除")
        }
    }.joinToString("\n")
    content.addView(TextView(this).apply {
        text = detail
        setTextColor(ContextCompat.getColor(this@showClipboardHistoryDetail, R.color.text_secondary))
        textSize = 13f
        setPadding(0, 12.dp(), 0, 4.dp())
    })
    if (item.kind == "text") {
        addSheetButton(content, getString(R.string.copy)) {
            copyToClipboard(item.text)
            dialog.dismiss()
        }
    } else if (item.exists) {
        addSheetButton(content, "复制到剪贴板") {
            copyHistoryFileToClipboard(item)
            dialog.dismiss()
        }
        addSheetButton(content, "打开") {
            openReceivedFile(item.path, item.mime)
            dialog.dismiss()
        }
    }
    addSheetButton(content, getString(android.R.string.ok), outlined = true) {
        dialog.dismiss()
    }
    dialog.show()
}

fun MainActivity.clipboardKindLabel(kind: String): String = when (kind) {
    "image" -> "图片"
    "file" -> "文件"
    else -> "文本"
}

fun MainActivity.clipboardDirectionLabel(direction: String): String =
    if (direction == "outgoing") getString(R.string.clipboard_history_outgoing)
    else getString(R.string.clipboard_history_incoming)

fun MainActivity.clipboardHistoryPreview(item: ClipboardHistoryEntry): String {
    if (item.kind == "text") {
        return item.text
            .replace('\n', ' ')
            .replace('\r', ' ')
            .take(140)
    }
    return listOf(item.title, item.path).filter { it.isNotBlank() }.joinToString("\n")
}

fun MainActivity.copyHistoryFileToClipboard(item: ClipboardHistoryEntry) {
    val file = File(item.path)
    if (!file.exists()) {
        Toast.makeText(this, "文件不存在", Toast.LENGTH_SHORT).show()
        return
    }
    runCatching {
        val uri = FileProvider.getUriForFile(this, "${packageName}.fileprovider", file)
        val clipboard = getSystemService(Context.CLIPBOARD_SERVICE) as android.content.ClipboardManager
        clipboard.setPrimaryClip(ClipData.newUri(contentResolver, item.title.ifBlank { file.name }, uri))
        Toast.makeText(this, "已复制到剪贴板", Toast.LENGTH_SHORT).show()
    }.onFailure { error ->
        Toast.makeText(this, "复制文件失败：${error.message ?: "unknown"}", Toast.LENGTH_SHORT).show()
    }
}

fun MainActivity.openReceivedFile(path: String, mime: String) {
    val file = File(path)
    if (!file.exists()) {
        Toast.makeText(this, "文件不存在", Toast.LENGTH_SHORT).show()
        return
    }
    val uri = FileProvider.getUriForFile(this, "${packageName}.fileprovider", file)
    val intent = Intent(Intent.ACTION_VIEW).apply {
        setDataAndType(uri, mime.ifBlank { FileTransferRegistry.guessMime(file.name) })
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
    }
    runCatching {
        startActivity(Intent.createChooser(intent, "打开文件"))
    }.onFailure {
        Toast.makeText(this, "没有可打开该文件的应用", Toast.LENGTH_SHORT).show()
    }
}

fun MainActivity.handleFileForTransfer(
    uri: Uri,
    batchId: String = "",
    batchCount: Int = 0,
    contentType: String = "file_transfer"
) {
    lifecycleScope.launch {
        val prepared = withContext(Dispatchers.IO) {
            runCatching { copyUriToOutgoingFile(uri) }
        }
        prepared.onSuccess { file ->
            val name = queryDisplayName(uri).ifBlank { file.name }
            val mime = contentResolver.getType(uri).orEmpty()
                .ifBlank { FileTransferRegistry.guessMime(name) }
            PhoneIdentityStore.get(this@handleFileForTransfer).let { identity ->
                ClipboardHistoryStore.addFile(
                    context = this@handleFileForTransfer,
                    kind = "file",
                    direction = "outgoing",
                    title = name,
                    path = file.absolutePath,
                    mime = mime,
                    size = file.length(),
                    sourceDeviceId = identity.id,
                    sourceDeviceName = identity.name
                )
            }
            startNodeReceiverService()
            startServiceForAction(WebSocketService.ACTION_SEND_FILE) {
                putExtra(WebSocketService.EXTRA_CONTENT_TYPE, contentType)
                putExtra(WebSocketService.EXTRA_FILE_PATH, file.absolutePath)
                putExtra(WebSocketService.EXTRA_FILE_NAME, name)
                putExtra(WebSocketService.EXTRA_FILE_MIME, mime)
                putStringArrayListExtra(
                    WebSocketService.EXTRA_TARGET_DEVICE_IDS,
                    ArrayList(pendingFileTransferTargetIds)
                )
                if (batchId.isNotBlank()) {
                    putExtra(WebSocketService.EXTRA_BATCH_ID, batchId)
                    putExtra(WebSocketService.EXTRA_BATCH_COUNT, batchCount)
                }
            }
            Toast.makeText(
                this@handleFileForTransfer,
                getString(R.string.file_transfer_started, name),
                Toast.LENGTH_LONG
            ).show()
            renderClipboardHistory()
            refreshConnectionSnapshot()
        }.onFailure { error ->
            Toast.makeText(
                this@handleFileForTransfer,
                getString(R.string.file_prepare_failed, error.message ?: "unknown"),
                Toast.LENGTH_LONG
            ).show()
        }
    }
}

data class FolderFileItem(
    val file: File,
    val name: String,
    val mime: String,
    val relativePath: String
)

data class FolderCollectResult(val files: List<FolderFileItem>, val skipped: Int)

fun MainActivity.handleFolderForTransfer(treeUri: Uri) {
    Toast.makeText(this, "正在准备文件夹…", Toast.LENGTH_SHORT).show()
    lifecycleScope.launch {
        val prepared = withContext(Dispatchers.IO) {
            runCatching { collectFolderFiles(treeUri) }
        }
        prepared.onSuccess { result ->
            if (result.files.isEmpty()) {
                Toast.makeText(this@handleFolderForTransfer, "文件夹内没有可发送的文件", Toast.LENGTH_LONG).show()
                return@onSuccess
            }
            val batchId = "batch-${java.util.UUID.randomUUID()}"
            val identity = PhoneIdentityStore.get(this@handleFolderForTransfer)
            startNodeReceiverService()
            result.files.forEach { item ->
                ClipboardHistoryStore.addFile(
                    context = this@handleFolderForTransfer,
                    kind = "file",
                    direction = "outgoing",
                    title = item.name,
                    path = item.file.absolutePath,
                    mime = item.mime,
                    size = item.file.length(),
                    sourceDeviceId = identity.id,
                    sourceDeviceName = identity.name
                )
                startServiceForAction(WebSocketService.ACTION_SEND_FILE) {
                    putExtra(WebSocketService.EXTRA_FILE_PATH, item.file.absolutePath)
                    putExtra(WebSocketService.EXTRA_FILE_NAME, item.name)
                    putExtra(WebSocketService.EXTRA_FILE_MIME, item.mime)
                    putExtra(WebSocketService.EXTRA_RELATIVE_PATH, item.relativePath)
                    putStringArrayListExtra(
                        WebSocketService.EXTRA_TARGET_DEVICE_IDS,
                        ArrayList(pendingFileTransferTargetIds)
                    )
                    putExtra(WebSocketService.EXTRA_BATCH_ID, batchId)
                    putExtra(WebSocketService.EXTRA_BATCH_COUNT, result.files.size)
                }
            }
            val skippedText = if (result.skipped > 0) "，跳过 ${result.skipped} 个" else ""
            Toast.makeText(
                this@handleFolderForTransfer,
                "正在发送文件夹（${result.files.size} 个文件$skippedText）",
                Toast.LENGTH_LONG
            ).show()
            renderClipboardHistory()
            refreshConnectionSnapshot()
        }.onFailure { error ->
            Toast.makeText(
                this@handleFolderForTransfer,
                getString(R.string.file_prepare_failed, error.message ?: "unknown"),
                Toast.LENGTH_LONG
            ).show()
        }
    }
}

/** 经 SAF 递归收集文件夹内文件并复制到发件暂存目录（保留相对路径）。 */
fun MainActivity.collectFolderFiles(treeUri: Uri): FolderCollectResult {
    val maxFiles = 200
    val maxFileBytes = 512L * 1024L * 1024L
    val rootDocId = DocumentsContract.getTreeDocumentId(treeUri)
    val rootName = sanitizeOutgoingFileName(
        queryDisplayName(DocumentsContract.buildDocumentUriUsingTree(treeUri, rootDocId)).ifBlank { "folder" }
    )
    val files = mutableListOf<FolderFileItem>()
    var skipped = 0

    fun walk(docId: String, relDir: String) {
        if (files.size >= maxFiles) return
        val childrenUri = DocumentsContract.buildChildDocumentsUriUsingTree(treeUri, docId)
        contentResolver.query(
            childrenUri,
            arrayOf(
                DocumentsContract.Document.COLUMN_DOCUMENT_ID,
                DocumentsContract.Document.COLUMN_DISPLAY_NAME,
                DocumentsContract.Document.COLUMN_MIME_TYPE,
                DocumentsContract.Document.COLUMN_SIZE
            ),
            null, null, null
        )?.use { cursor ->
            while (cursor.moveToNext()) {
                if (files.size >= maxFiles) {
                    skipped += 1
                    continue
                }
                val childId = cursor.getString(0) ?: continue
                val childName = sanitizeOutgoingFileName(cursor.getString(1).orEmpty())
                val childMime = cursor.getString(2).orEmpty()
                val childSize = cursor.getLong(3)
                if (childMime == DocumentsContract.Document.MIME_TYPE_DIR) {
                    walk(childId, "$relDir$childName/")
                } else {
                    if (childSize <= 0L || childSize > maxFileBytes) {
                        skipped += 1
                        continue
                    }
                    val childUri = DocumentsContract.buildDocumentUriUsingTree(treeUri, childId)
                    val copied = runCatching { copyUriToOutgoingFile(childUri) }.getOrNull()
                    if (copied == null) {
                        skipped += 1
                        continue
                    }
                    files.add(
                        FolderFileItem(
                            file = copied,
                            name = childName,
                            mime = childMime.ifBlank { FileTransferRegistry.guessMime(childName) },
                            relativePath = "$rootName/$relDir$childName"
                        )
                    )
                }
            }
        }
    }
    walk(rootDocId, "")
    return FolderCollectResult(files, skipped)
}

fun MainActivity.copyUriToOutgoingFile(uri: Uri): File {
    val name = sanitizeOutgoingFileName(queryDisplayName(uri).ifBlank { "file-${System.currentTimeMillis()}" })
    val dir = File(filesDir, "outgoing_files").apply { mkdirs() }
    val outputFile = uniqueFile(dir, name)
    contentResolver.openInputStream(uri)?.use { input ->
        FileOutputStream(outputFile).use { output ->
            val buffer = ByteArray(128 * 1024)
            while (true) {
                val read = input.read(buffer)
                if (read <= 0) break
                output.write(buffer, 0, read)
            }
        }
    } ?: error("无法读取文件")
    if (outputFile.length() <= 0L) {
        outputFile.delete()
        error("文件为空")
    }
    return outputFile
}

data class PreparedClipboardImage(val file: File, val mime: String)

fun MainActivity.prepareClipboardImageFile(uri: Uri): PreparedClipboardImage {
    val bitmap = contentResolver.openInputStream(uri)?.use { input ->
        BitmapFactory.decodeStream(input)
    } ?: error("invalid_image")
    val dir = File(filesDir, "outgoing_clipboard_images").apply { mkdirs() }
    val usePng = bitmap.hasAlpha()
    val mime = if (usePng) "image/png" else "image/jpeg"
    val ext = if (usePng) "png" else "jpg"
    val format = if (usePng) android.graphics.Bitmap.CompressFormat.PNG else android.graphics.Bitmap.CompressFormat.JPEG
    val quality = if (usePng) 100 else 90
    val outputFile = uniqueFile(dir, "clipboard-${System.currentTimeMillis()}.$ext")
    FileOutputStream(outputFile).use { output ->
        if (!bitmap.compress(format, quality, output)) {
            error("encode_failed")
        }
    }
    bitmap.recycle()
    return PreparedClipboardImage(outputFile, mime)
}

fun MainActivity.queryDisplayName(uri: Uri): String {
    contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor ->
        if (cursor.moveToFirst()) {
            val index = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
            if (index >= 0) return cursor.getString(index).orEmpty()
        }
    }
    return uri.lastPathSegment.orEmpty()
}

fun MainActivity.sanitizeOutgoingFileName(name: String): String {
    return name.substringAfterLast('/').substringAfterLast('\\')
        .replace(Regex("[\\\\/\\x00-\\x1F<>:\"|?*]"), "_")
        .trim()
        .take(180)
        .ifBlank { "file" }
}

fun MainActivity.uniqueFile(dir: File, name: String): File {
    val safe = sanitizeOutgoingFileName(name)
    var candidate = File(dir, safe)
    if (!candidate.exists()) return candidate
    val dot = safe.lastIndexOf('.')
    val stem = if (dot > 0) safe.substring(0, dot) else safe
    val ext = if (dot > 0) safe.substring(dot) else ""
    for (i in 1..9999) {
        candidate = File(dir, "$stem ($i)$ext")
        if (!candidate.exists()) return candidate
    }
    return File(dir, "$stem-${System.currentTimeMillis()}$ext")
}

