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

fun MainActivity.showAddTotpDialog() {
    showActionSheet(
        title = getString(R.string.add_totp),
        actions = listOf(
            SheetAction(
                title = getString(R.string.add_totp_scan),
                subtitle = "直接打开相机扫描标准 TOTP 或迁移二维码"
            ) {
                val intent = Intent(this, QRScannerActivity::class.java).apply {
                    putExtra(QRScannerActivity.EXTRA_SCAN_TOTP_ONLY, true)
                }
                startActivity(intent)
            },
            SheetAction(
                title = getString(R.string.add_totp_from_image),
                subtitle = "从截图或相册图片中解析二维码"
            ) {
                pickImageLauncher.launch("image/*")
            },
            SheetAction(
                title = getString(R.string.add_totp_manual),
                subtitle = "手动填写 Base32 密钥和标签"
            ) {
                showManualTotpInputDialog()
            }
        )
    )
}

fun MainActivity.showManualTotpInputDialog() {
    val (dialog, content) = createBottomSheet(getString(R.string.add_totp_manual))
    val labelInput = TextInputEditText(this).apply {
        inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_CAP_SENTENCES
    }
    val secretInput = TextInputEditText(this).apply {
        inputType = InputType.TYPE_CLASS_TEXT or
            InputType.TYPE_TEXT_FLAG_CAP_CHARACTERS or
            InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS
    }

    val labelLayout = TextInputLayout(this).apply {
        hint = getString(R.string.totp_label_hint)
        boxBackgroundColor = ContextCompat.getColor(this@showManualTotpInputDialog, R.color.bg_surface_variant)
        addView(labelInput)
    }
    val secretLayout = TextInputLayout(this).apply {
        hint = getString(R.string.totp_secret_hint)
        boxBackgroundColor = ContextCompat.getColor(this@showManualTotpInputDialog, R.color.bg_surface_variant)
        addView(secretInput)
    }

    content.addView(labelLayout, LinearLayout.LayoutParams(
        LinearLayout.LayoutParams.MATCH_PARENT,
        LinearLayout.LayoutParams.WRAP_CONTENT
    ).apply { topMargin = 14.dp() })
    content.addView(secretLayout, LinearLayout.LayoutParams(
        LinearLayout.LayoutParams.MATCH_PARENT,
        LinearLayout.LayoutParams.WRAP_CONTENT
    ).apply { topMargin = 10.dp() })

    addSheetButton(content, getString(R.string.save)) {
        val secret = secretInput.text?.toString()
            ?.trim()
            ?.uppercase()
            ?.replace(" ", "")
            ?.replace("-", "") ?: ""
        val label = labelInput.text?.toString()?.trim()?.takeIf { it.isNotEmpty() } ?: "TOTP"

        if (secret.isEmpty()) {
            Toast.makeText(this, R.string.totp_secret_required, Toast.LENGTH_SHORT).show()
            return@addSheetButton
        }

        if (!TotpUtil.validateSecret(secret)) {
            Toast.makeText(this, R.string.totp_secret_invalid, Toast.LENGTH_LONG).show()
            return@addSheetButton
        }

        dialog.dismiss()
        saveTotpSecret(label, secret)
    }
    addSheetButton(content, getString(R.string.cancel), outlined = true) {
        dialog.dismiss()
    }
    dialog.show()
}

fun MainActivity.saveTotpSecret(label: String, secret: String) {
    val identity = PhoneIdentityStore.get(this)
    val entry = TotpEntry(
        label = label,
        secret = secret,
        algorithm = "SHA1",
        digits = 6,
        period = 30,
        sourceDeviceId = identity.id,
        sourceDeviceName = identity.name,
        sourceDeviceType = "ANDROID_PHONE",
        isLocal = true
    )
    TotpStore.add(this, entry)
    Toast.makeText(this, getString(R.string.totp_saved, label), Toast.LENGTH_SHORT).show()
    rebuildTotpList()
    // 添加时推送一次到目标节点登记（按需模型：不再每周期反复推送）
    syncTotpToDesktop(entry)
}

fun MainActivity.syncTotpToDesktop(entry: TotpEntry) {
    if (DeviceStore.getEnabledDevices(this).isEmpty()) return
    startServiceForAction(WebSocketService.ACTION_SEND_TOTP_SEED) {
        putExtra(WebSocketService.EXTRA_TOTP_LABEL, entry.label)
        putExtra(WebSocketService.EXTRA_TOTP_SECRET, entry.secret)
        putExtra(WebSocketService.EXTRA_TOTP_ISSUER, entry.issuer)
        putExtra(WebSocketService.EXTRA_TOTP_ACCOUNT, entry.accountName)
        putExtra(WebSocketService.EXTRA_TOTP_ALGORITHM, entry.algorithm)
        putExtra(WebSocketService.EXTRA_TOTP_DIGITS, entry.digits)
        putExtra(WebSocketService.EXTRA_TOTP_PERIOD, entry.period)
    }
}

fun MainActivity.syncDeletedTotpToDesktop(entry: TotpEntry) {
    if (DeviceStore.getEnabledDevices(this).isEmpty()) return
    startServiceForAction(WebSocketService.ACTION_DELETE_TOTP_SEED) {
        putExtra(WebSocketService.EXTRA_TOTP_LABEL, entry.label)
        putExtra(WebSocketService.EXTRA_TOTP_SECRET, entry.secret)
        putExtra(WebSocketService.EXTRA_TOTP_ISSUER, entry.issuer)
        putExtra(WebSocketService.EXTRA_TOTP_ACCOUNT, entry.accountName)
        putExtra(WebSocketService.EXTRA_TOTP_ALGORITHM, entry.algorithm)
        putExtra(WebSocketService.EXTRA_TOTP_DIGITS, entry.digits)
        putExtra(WebSocketService.EXTRA_TOTP_PERIOD, entry.period)
    }
    refreshConnectionSnapshot()
}

/** 从相册选择的图片中解析二维码 */
fun MainActivity.handleImageFromGallery(uri: Uri) {
    try {
        val inputStream = contentResolver.openInputStream(uri)
        if (inputStream == null) {
            Toast.makeText(this, R.string.totp_image_read_failed, Toast.LENGTH_SHORT).show()
            return
        }

        val bitmap = BitmapFactory.decodeStream(inputStream)
        inputStream.close()

        if (bitmap == null) {
            Toast.makeText(this, R.string.totp_image_read_failed, Toast.LENGTH_SHORT).show()
            return
        }

        // 使用 ZXing 解析图片中的二维码
        val width = bitmap.width
        val height = bitmap.height
        val pixels = IntArray(width * height)
        bitmap.getPixels(pixels, 0, width, 0, 0, width, height)

        val source = RGBLuminanceSource(width, height, pixels)
        val binaryBitmap = BinaryBitmap(HybridBinarizer(source))

        val reader = MultiFormatReader()
        val hints = mapOf(DecodeHintType.TRY_HARDER to true)

        try {
            val result = reader.decode(binaryBitmap, hints)
            val qrContent = result.text

            if (qrContent.isNullOrBlank()) {
                Toast.makeText(this, R.string.totp_qr_not_found, Toast.LENGTH_SHORT).show()
                return
            }

            if (qrContent.startsWith("otpauth-migration://", ignoreCase = true)) {
                handleGoogleMigration(qrContent)
            } else if (qrContent.startsWith("otpauth://totp", ignoreCase = true)) {
                parseTotpUri(qrContent)
            } else {
                Toast.makeText(this, R.string.totp_qr_invalid, Toast.LENGTH_LONG).show()
            }
        } catch (e: Exception) {
            Toast.makeText(this, R.string.totp_qr_not_found, Toast.LENGTH_SHORT).show()
        } finally {
            bitmap.recycle()
        }
    } catch (e: Exception) {
        Toast.makeText(this, getString(R.string.totp_import_failed, e.message), Toast.LENGTH_LONG).show()
    }
}

/** 解析 otpauth:// URI 并保存 TOTP */
fun MainActivity.parseTotpUri(uri: String) {
    try {
        // 检查是否是 Google Authenticator 迁移格式
        if (uri.startsWith("otpauth-migration://", ignoreCase = true)) {
            handleGoogleMigration(uri)
            return
        }

        val parsedUri = Uri.parse(uri)

        if (!parsedUri.scheme.equals("otpauth", ignoreCase = true) ||
            !parsedUri.host.equals("totp", ignoreCase = true)
        ) {
            Toast.makeText(this, R.string.totp_qr_invalid, Toast.LENGTH_SHORT).show()
            return
        }

        val secret = parsedUri.getQueryParameter("secret")
            ?.uppercase()
            ?.replace(" ", "")
            ?.replace("-", "")
            ?.trim()
            ?: ""

        if (!TotpUtil.validateSecret(secret)) {
            Toast.makeText(this, R.string.totp_secret_invalid, Toast.LENGTH_SHORT).show()
            return
        }

        val rawLabel = parsedUri.pathSegments.firstOrNull()?.trim()?.takeIf { it.isNotEmpty() } ?: "TOTP"
        val issuerFromQuery = parsedUri.getQueryParameter("issuer")?.trim().orEmpty()
        val colonIndex = rawLabel.indexOf(':')
        val issuer = issuerFromQuery.ifBlank {
            if (colonIndex > 0) rawLabel.substring(0, colonIndex).trim() else ""
        }
        val accountName = if (colonIndex >= 0 && colonIndex < rawLabel.lastIndex) {
            rawLabel.substring(colonIndex + 1).trim()
        } else {
            rawLabel
        }.ifBlank { "TOTP" }
        val label = listOf(issuer, accountName).filter { it.isNotBlank() }.joinToString(": ")
            .ifBlank { accountName }

        val algorithm = parsedUri.getQueryParameter("algorithm")?.uppercase() ?: "SHA1"
        val digits = parsedUri.getQueryParameter("digits")?.toIntOrNull() ?: 6
        val period = parsedUri.getQueryParameter("period")?.toIntOrNull() ?: 30

        // 保存并同步到桌面
        saveTotpSecretWithDetails(label, secret, issuer, accountName, algorithm, digits, period)

        Toast.makeText(this, getString(R.string.totp_imported, label), Toast.LENGTH_SHORT).show()
    } catch (e: Exception) {
        Toast.makeText(this, getString(R.string.totp_import_failed, e.message), Toast.LENGTH_LONG).show()
    }
}

/** 处理 Google Authenticator 迁移协议（批量导入） */
fun MainActivity.handleGoogleMigration(uri: String) {
    try {
        val accounts = GoogleAuthMigrationParser.parse(uri)

        if (accounts.isNullOrEmpty()) {
            Toast.makeText(this, R.string.google_migration_parse_failed, Toast.LENGTH_LONG).show()
            return
        }

        // 显示批量导入确认对话框
        showBatchImportDialog(accounts)
    } catch (e: Exception) {
        Toast.makeText(this, getString(R.string.totp_import_failed, e.message), Toast.LENGTH_LONG).show()
    }
}

/** 显示批量导入确认对话框 */
fun MainActivity.showBatchImportDialog(accounts: List<MigrationOtpAccount>) {
    val accountNames: List<String> = accounts.map { account ->
        val label = account.getDisplayLabel()
        val details = "${account.getAlgorithmString()}, ${account.getDigitsInt()} 位"
        "$label\n  $details"
    }

    val selected = BooleanArray(accounts.size) { true } // 默认全选

    showMultiChoiceSheet(
        title = getString(R.string.google_migration_found, accounts.size),
        message = "选择要导入到本机的动态验证码",
        items = accountNames,
        selected = selected,
        positiveText = getString(R.string.import_selected),
        neutralText = getString(R.string.import_all),
        onPositive = {
            val selectedAccounts = accounts.filterIndexed { index: Int, _: MigrationOtpAccount -> selected[index] }
            if (selectedAccounts.isEmpty()) {
                Toast.makeText(this, R.string.no_account_selected, Toast.LENGTH_SHORT).show()
            } else {
                batchImportAccounts(selectedAccounts)
            }
        },
        onNeutral = {
            batchImportAccounts(accounts)
        }
    )
}

/** 批量导入账号 */
fun MainActivity.batchImportAccounts(accounts: List<MigrationOtpAccount>) {
    var successCount = 0
    var failCount = 0

    accounts.forEach { account: MigrationOtpAccount ->
        try {
            if (TotpUtil.validateSecret(account.secret)) {
                saveTotpSecretWithDetails(
                    label = account.getDisplayLabel(),
                    secret = account.secret,
                    issuer = account.issuer,
                    accountName = account.getAccountName(),
                    algorithm = account.getAlgorithmString(),
                    digits = account.getDigitsInt(),
                    period = 30
                )
                successCount++
            } else {
                failCount++
            }
        } catch (e: Exception) {
            failCount++
        }
    }

    val message = if (failCount == 0) {
        getString(R.string.batch_import_success, successCount)
    } else {
        getString(R.string.batch_import_partial, successCount, failCount)
    }

    Toast.makeText(this, message, Toast.LENGTH_LONG).show()
}

/** 保存 TOTP 密钥（带完整参数）并同步到桌面 */
fun MainActivity.saveTotpSecretWithDetails(
    label: String,
    secret: String,
    issuer: String = "",
    accountName: String = "",
    algorithm: String = "SHA1",
    digits: Int = 6,
    period: Int = 30
) {
    val identity = PhoneIdentityStore.get(this)
    val entry = TotpEntry(
        label = label,
        secret = secret,
        issuer = issuer,
        accountName = accountName,
        algorithm = algorithm,
        digits = digits,
        period = period,
        sourceDeviceId = identity.id,
        sourceDeviceName = identity.name,
        sourceDeviceType = "ANDROID_PHONE",
        isLocal = true
    )
    TotpStore.add(this, entry)
    rebuildTotpList()

    // 同步到桌面（带完整参数）
    syncTotpToDesktop(entry)
}

fun MainActivity.loadTotpEntries(): List<TotpEntry> {
    return TotpStore.loadAll(this)
}

fun MainActivity.startServiceForAction(action: String, configure: Intent.() -> Unit = {}) {
    val intent = Intent(this, WebSocketService::class.java).apply {
        this.action = action
        configure()
    }
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O &&
        action != WebSocketService.ACTION_DISCONNECT
    ) {
        startForegroundService(intent)
    } else {
        startService(intent)
    }
}

fun MainActivity.broadcastTopologyChange(reason: String) {
    startServiceForAction(WebSocketService.ACTION_BROADCAST_TOPOLOGY) {
        putExtra(WebSocketService.EXTRA_TOPOLOGY_REASON, reason)
    }
}

fun MainActivity.startTotpUpdates() {
    totpUpdateJob?.cancel()
    // repeatOnLifecycle：进入后台时自动挂起，回到前台再恢复，避免后台空转。
    // 仅本地刷新 UI 倒计时，周期切换时本地重算验证码——不做任何网络推送。
    totpUpdateJob = lifecycleScope.launch {
        repeatOnLifecycle(Lifecycle.State.STARTED) {
            var lastCounter = -1L
            rebuildTotpList()
            while (true) {
                val counter = TotpUtil.getCurrentCounter()
                if (counter != lastCounter) {
                    rebuildTotpList()
                    lastCounter = counter
                }
                updateTotpCountdowns()
                delay(1000)
            }
        }
    }
}

/** 根据已保存的 TOTP 重建卡片列表（验证码本地生成，支持完整参数）。 */
fun MainActivity.rebuildTotpList() {
    val entries = loadTotpEntries()
    val container = binding.totpList
    container.removeAllViews()

    if (entries.isEmpty()) {
        container.addView(
            TextView(this).apply {
                text = getString(R.string.totp_empty)
                setTextColor(ContextCompat.getColor(this@rebuildTotpList, R.color.text_tertiary))
                textSize = 14f
            }
        )
        return
    }

    val inflater = LayoutInflater.from(this)
    entries.forEach { entry: TotpEntry ->
        val row = inflater.inflate(R.layout.item_totp, container, false)
        row.findViewById<TextView>(R.id.totpLabel).text = entry.label
        val pinView = row.findViewById<TextView>(R.id.totpPin)
        pinView.text = if (entry.pinnedAt > 0) "★" else "☆"
        pinView.contentDescription = getString(
            if (entry.pinnedAt > 0) R.string.totp_unpin else R.string.totp_pin
        )
        pinView.setTextColor(
            ContextCompat.getColor(
                this,
                if (entry.pinnedAt > 0) R.color.warning else R.color.text_tertiary
            )
        )
        pinView.setOnClickListener {
            val shouldPin = entry.pinnedAt <= 0
            TotpStore.setPinned(this, entry.withStableId().id, shouldPin)
            rebuildTotpList()
            Toast.makeText(
                this,
                getString(if (shouldPin) R.string.totp_pinned else R.string.totp_unpinned, entry.label),
                Toast.LENGTH_SHORT
            ).show()
        }

        // 使用完整参数生成 TOTP
        val code = TotpUtil.generate(
            entry.secret,
            algorithm = entry.algorithm,
            digits = entry.digits,
            period = entry.period
        )
        row.findViewById<TextView>(R.id.totpCode).text = code

        // 复制按钮
        row.findViewById<ImageView>(R.id.totpCopy).setOnClickListener {
            copyToClipboard(TotpUtil.generate(
                entry.secret,
                algorithm = entry.algorithm,
                digits = entry.digits,
                period = entry.period
            ))
        }

        // 点击复制
        row.setOnClickListener {
            copyToClipboard(TotpUtil.generate(
                entry.secret,
                algorithm = entry.algorithm,
                digits = entry.digits,
                period = entry.period
            ))
        }

        // 长按删除
        row.setOnLongClickListener {
            confirmDeleteTotp(entry)
            true
        }

        container.addView(row)
    }
    updateTotpCountdowns()
}

/** 确认删除 TOTP */
fun MainActivity.confirmDeleteTotp(entry: TotpEntry) {
    showConfirmSheet(
        title = getString(R.string.delete_totp_title),
        message = getString(R.string.delete_totp_message, entry.label),
        positiveText = getString(R.string.delete),
        destructive = true
    ) {
            val normalized = entry.withStableId()
            TotpStore.removeById(this, normalized.id)
            if (normalized.isLocal) {
                TotpStore.addDeleteTombstone(this, normalized)
                syncDeletedTotpToDesktop(normalized)
            }
            rebuildTotpList()
            rebuildTopologyList()
            Toast.makeText(this, getString(R.string.totp_deleted, entry.label), Toast.LENGTH_SHORT).show()
    }
}

/** 每秒更新所有 TOTP 行的倒计时环和剩余秒数（本地，支持动态周期）。 */
fun MainActivity.updateTotpCountdowns() {
    val entries = loadTotpEntries()
    val container = binding.totpList

    for (i in 0 until container.childCount) {
        val child = container.getChildAt(i)
        val progress = child.findViewById<ProgressBar>(R.id.totpProgress) ?: continue
        val text = child.findViewById<TextView>(R.id.totpRemaining) ?: continue
        val codeView = child.findViewById<TextView>(R.id.totpCode) ?: continue

        // 获取对应的 TOTP 条目（按索引匹配）
        if (i >= entries.size) continue
        val entry = entries[i]

        val remaining = TotpUtil.getRemainingSeconds(entry.period)
        progress.max = entry.period
        progress.progress = remaining
        text.text = remaining.toString()

        val color = ContextCompat.getColor(
            this,
            if (remaining <= 5) R.color.danger else R.color.accent_green
        )
        progress.progressTintList = ColorStateList.valueOf(color)
        text.setTextColor(color)

        // 周期切换时重新生成验证码
        val currentCounter = TotpUtil.getCurrentCounter(entry.period)
        val tag = child.tag as? Long
        if (tag == null || tag != currentCounter) {
            child.tag = currentCounter
            codeView.text = TotpUtil.generate(
                entry.secret,
                algorithm = entry.algorithm,
                digits = entry.digits,
                period = entry.period
            )
        }
    }
}

fun MainActivity.copyToClipboard(text: String) {
    val clipboard = getSystemService(Context.CLIPBOARD_SERVICE) as android.content.ClipboardManager
    val clip = android.content.ClipData.newPlainText("code", text)
    // Android 13+ 剪贴板预览会明文显示内容；标记为敏感后系统改为遮蔽显示。
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
        clip.description.extras = android.os.PersistableBundle().apply {
            putBoolean("android.content.extra.IS_SENSITIVE", true)
        }
    }
    clipboard.setPrimaryClip(clip)
    // 不在 Toast 里回显验证码：Toast 可被无障碍服务/截屏读取。
    Toast.makeText(this, "已复制", Toast.LENGTH_SHORT).show()
}

