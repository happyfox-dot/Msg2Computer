package com.codesync

import android.Manifest
import android.app.DownloadManager
import android.content.BroadcastReceiver
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
import com.codesync.service.WebSocketService
import com.codesync.util.DesktopDevice
import com.codesync.util.DeviceStore
import com.codesync.util.ApkUpdater
import com.codesync.util.ClipboardSyncState
import com.codesync.util.FileTransferCoordinator
import com.codesync.util.FileTransferHistoryStore
import com.codesync.util.FileTransferRegistry
import com.codesync.util.GoogleAuthMigrationParser
import com.codesync.util.LanDiscoveredDevice
import com.codesync.util.LanDiscovery
import com.codesync.util.LanJoinClient
import com.codesync.util.LanJoinCoordinator
import com.codesync.util.LanTrustStore
import com.codesync.util.MigrationOtpAccount
import com.codesync.util.PhoneIdentityStore
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

class MainActivity : AppCompatActivity() {
    private lateinit var binding: ActivityMainBinding
    private var totpUpdateJob: Job? = null
    private var updatingForwardSwitch = false
    private var updatingMessagePolicySwitches = false
    private var discoveredLanNodes: List<LanDiscoveredDevice> = emptyList()
    private val shownFileTransferRequests = mutableSetOf<String>()
    private var pendingFileTransferTargetIds: List<String> = emptyList()

    // 应用内更新：DownloadManager 的下载 id 与待安装的版本号；下载完成由系统广播触发安装
    private var pendingUpdateDownloadId: Long = -1L
    private var pendingUpdateVersionName: String = ""
    // 安装失败兜底用的 release 页面地址（下载完成时一并记下，便于失败时跳浏览器手动下载）
    private var pendingUpdatePageUrl: String = ""
    // 等待「安装未知应用」授权后继续下载的更新信息（去设置页授权 → onResume 续流程）
    private var pendingUpdateInfo: ApkUpdater.UpdateInfo? = null

    private data class SheetAction(
        val title: String,
        val subtitle: String = "",
        val destructive: Boolean = false,
        val enabled: Boolean = true,
        val onClick: () -> Unit
    )

    // 相册图片选择器
    private val pickImageLauncher = registerForActivityResult(ActivityResultContracts.GetContent()) { uri: Uri? ->
        uri?.let { handleImageFromGallery(it) }
    }

    private val pickFileLauncher = registerForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { uris: List<Uri>? ->
        if (!uris.isNullOrEmpty()) {
            // 同批文件带相同 batchId：接收端只确认一次
            val batchId = if (uris.size > 1) "batch-${java.util.UUID.randomUUID()}" else ""
            uris.forEach { handleFileForTransfer(it, batchId, uris.size) }
        } else {
            pendingFileTransferTargetIds = emptyList()
        }
    }

    private val pickFolderLauncher = registerForActivityResult(ActivityResultContracts.OpenDocumentTree()) { uri: Uri? ->
        if (uri != null) {
            handleFolderForTransfer(uri)
        } else {
            pendingFileTransferTargetIds = emptyList()
        }
    }

    private val connectionReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            when (intent?.action) {
                WebSocketService.CONNECTION_STATE_ACTION -> {
                    updateConnectionUI(
                        connected = intent.getBooleanExtra("connected", false),
                        connectedCount = intent.getIntExtra("connected_count", 0),
                        detail = intent.getStringExtra("status_message")
                    )
                }
                WebSocketService.TOTP_SYNCED_ACTION -> {
                    rebuildTotpList()
                    rebuildTopologyList()
                }
            }
        }
    }

    // DownloadManager 下载完成广播：匹配到本次更新的下载 id 时拉起系统安装器
    private val downloadCompleteReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            if (intent?.action != DownloadManager.ACTION_DOWNLOAD_COMPLETE) return
            val id = intent.getLongExtra(DownloadManager.EXTRA_DOWNLOAD_ID, -1L)
            if (id == -1L || id != pendingUpdateDownloadId) return
            handleUpdateDownloadComplete(id)
        }
    }

    private val lanJoinReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            if (intent?.action != LanJoinCoordinator.ACTION_JOIN_REQUEST) return
            val requestId = intent.getStringExtra(LanJoinCoordinator.EXTRA_REQUEST_ID).orEmpty()
            if (requestId.isNotBlank()) showLanJoinRequest(requestId)
        }
    }

    private val fileTransferReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            if (intent?.action != FileTransferCoordinator.ACTION_FILE_TRANSFER_REQUEST) return
            val requestId = intent.getStringExtra(FileTransferCoordinator.EXTRA_REQUEST_ID).orEmpty()
            if (requestId.isNotBlank()) showFileTransferRequest(requestId)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityMainBinding.inflate(layoutInflater)
        setContentView(binding.root)

        requestPermissions()
        requestBatteryOptimizationExemption()
        setupUI()
        refreshDeviceList()
        rebuildTopologyList()
        // 按需模型：启动时不再建立常驻连接，仅展示当前空闲状态
        refreshConnectionSnapshot()
        startTotpUpdates()

        // 下载完成广播跟随 Activity 生命周期注册（下载期间退到后台仍可收到，
        // 进程被杀则由用户重新点「检查更新」续流程）。
        // ACTION_DOWNLOAD_COMPLETE 由系统 DownloadProvider 发出（受保护广播），
        // Android 13+ 需显式 RECEIVER_EXPORTED 才能收到跨应用广播。
        ContextCompat.registerReceiver(
            this,
            downloadCompleteReceiver,
            IntentFilter(DownloadManager.ACTION_DOWNLOAD_COMPLETE),
            ContextCompat.RECEIVER_EXPORTED
        )
        ContextCompat.registerReceiver(
            this,
            lanJoinReceiver,
            IntentFilter(LanJoinCoordinator.ACTION_JOIN_REQUEST),
            ContextCompat.RECEIVER_NOT_EXPORTED
        )
        ContextCompat.registerReceiver(
            this,
            fileTransferReceiver,
            IntentFilter(FileTransferCoordinator.ACTION_FILE_TRANSFER_REQUEST),
            ContextCompat.RECEIVER_NOT_EXPORTED
        )
        handleLanJoinIntent(intent)
        handleFileTransferIntent(intent)
        // 启动后静默检查一次更新（已被用户忽略的版本不再打扰）
        autoCheckUpdateSilently()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleLanJoinIntent(intent)
        handleFileTransferIntent(intent)
    }

    private fun handleLanJoinIntent(intent: Intent?) {
        if (intent?.action != LanJoinCoordinator.ACTION_JOIN_REQUEST) return
        val requestId = intent.getStringExtra(LanJoinCoordinator.EXTRA_REQUEST_ID).orEmpty()
        if (requestId.isNotBlank()) showLanJoinRequest(requestId)
    }

    private fun handleFileTransferIntent(intent: Intent?) {
        if (intent?.action != FileTransferCoordinator.ACTION_FILE_TRANSFER_REQUEST) return
        val requestId = intent.getStringExtra(FileTransferCoordinator.EXTRA_REQUEST_ID).orEmpty()
        if (requestId.isNotBlank()) showFileTransferRequest(requestId)
    }

    override fun onResume() {
        super.onResume()
        refreshDeviceList()
        rebuildTopologyList()
        syncForwardSwitch()
        syncMessagePolicySwitches()
        refreshConnectionSnapshot()

        // 从「安装未知应用」设置页返回：已授权则继续下载，未授权则明确告知已取消
        // （原先静默放弃，用户以为没反应；现在给一条 toast 引导重试）
        pendingUpdateInfo?.let { info ->
            pendingUpdateInfo = null
            if (ApkUpdater.canInstallPackages(this)) {
                startUpdateDownload(info)
            } else {
                Toast.makeText(
                    this, R.string.update_install_permission_denied, Toast.LENGTH_LONG
                ).show()
            }
        }
    }

    // 回前台时自动同步剪贴板：Android 10+ 仅前台焦点应用可读剪贴板，这是
    // 「手机→其它节点」方向能做到的最自动的时机——用户复制后切回本应用即同步。
    // 内容与已同步版本相同时静默跳过（对话框开关引起的焦点抖动也会走到这里，
    // 哈希比较保证幂等，开销可忽略）。
    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) maybeAutoSyncClipboard()
    }

    private fun maybeAutoSyncClipboard() {
        if (!SettingsStore.isSyncClipboardEnabled(this)) return
        if (DeviceStore.getEnabledDevices(this).none { it.allowClipboard }) return
        val clipboard = getSystemService(Context.CLIPBOARD_SERVICE) as android.content.ClipboardManager
        val text = clipboard.primaryClip?.takeIf { it.itemCount > 0 }
            ?.getItemAt(0)?.coerceToText(this)?.toString()?.trim().orEmpty()
        if (text.isBlank() || text.length > 20000) return
        if (ClipboardSyncState.hash(text) == ClipboardSyncState.appliedHash(this)) return
        startServiceForAction(WebSocketService.ACTION_SEND_CLIPBOARD) {
            putExtra(WebSocketService.EXTRA_MESSAGE_BODY, text)
        }
    }

    override fun onStart() {
        super.onStart()
        val filter = IntentFilter(WebSocketService.CONNECTION_STATE_ACTION).apply {
            addAction(WebSocketService.TOTP_SYNCED_ACTION)
        }
        ContextCompat.registerReceiver(
            this,
            connectionReceiver,
            filter,
            ContextCompat.RECEIVER_NOT_EXPORTED
        )
        startNodeReceiverService()
        refreshConnectionSnapshot()
    }

    override fun onStop() {
        runCatching { unregisterReceiver(connectionReceiver) }
        super.onStop()
    }

    private fun startNodeReceiverService() {
        val intent = Intent(this, NodeReceiverService::class.java)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            startForegroundService(intent)
        } else {
            startService(intent)
        }
    }

    private fun requestPermissions() {
        val permissions = mutableListOf<String>()

        if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECEIVE_SMS)
            != PackageManager.PERMISSION_GRANTED
        ) {
            permissions.add(Manifest.permission.RECEIVE_SMS)
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS)
            != PackageManager.PERMISSION_GRANTED
        ) {
            permissions.add(Manifest.permission.POST_NOTIFICATIONS)
        }
        if (permissions.isNotEmpty()) {
            requestPermissionLauncher.launch(permissions.toTypedArray())
        }
    }

    private val requestPermissionLauncher =
        registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { results ->
            val denied = results.entries.filter { !it.value }
            if (denied.isNotEmpty()) {
                Toast.makeText(this, R.string.permission_sms_required, Toast.LENGTH_LONG).show()
            }
        }

    private fun requestBatteryOptimizationExemption() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return

        val powerManager = getSystemService(POWER_SERVICE) as PowerManager
        if (powerManager.isIgnoringBatteryOptimizations(packageName)) return

        showConfirmSheet(
            title = getString(R.string.battery_title),
            message = getString(R.string.battery_message),
            positiveText = getString(R.string.battery_go)
        ) {
                try {
                    startActivity(
                        Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).apply {
                            data = Uri.parse("package:$packageName")
                        }
                    )
                } catch (_: Exception) {
                    startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS))
                }
        }
    }

    private fun setupUI() {
        binding.btnScanQR.setOnClickListener {
            startActivity(Intent(this, QRScannerActivity::class.java))
        }

        binding.btnDiscoverLan.setOnClickListener {
            showLanDiscoveryDialog()
        }

        binding.btnTestPush.setOnClickListener {
            showTestPushDialog()
        }

        binding.btnRefreshTopology.setOnClickListener {
            refreshDeviceList()
            rebuildTopologyList()
            refreshConnectionSnapshot()
        }

        binding.btnAddTotp.setOnClickListener {
            showAddTotpDialog()
        }

        binding.btnDisconnect.setOnClickListener {
            showDisconnectTargetsDialog()
        }

        binding.btnRevokeTotpAccess.setOnClickListener {
            showRevokeTotpAccessDialog()
        }

        binding.txtCurrentVersion.text =
            getString(R.string.update_current_version, ApkUpdater.currentVersionName(this))
        binding.btnCheckUpdate.setOnClickListener {
            checkForAppUpdate(manual = true)
        }

        syncForwardSwitch()
        binding.switchAutoSync.setOnCheckedChangeListener { _, isChecked ->
            if (updatingForwardSwitch) return@setOnCheckedChangeListener
            SettingsStore.setForwardingEnabled(this, isChecked)
            val msg = if (isChecked) R.string.forwarding_on else R.string.forwarding_off
            Toast.makeText(this, msg, Toast.LENGTH_SHORT).show()
            refreshConnectionSnapshot()
        }

        binding.switchAllowLanJoin.isChecked = LanTrustStore.isJoinRequestAllowed(this)
        binding.switchAllowLanJoin.setOnCheckedChangeListener { _, isChecked ->
            LanTrustStore.setJoinRequestAllowed(this, isChecked)
            Toast.makeText(
                this,
                if (isChecked) "已允许局域网入网请求" else "已关闭局域网入网请求",
                Toast.LENGTH_SHORT
            ).show()
        }

        setupMessagePolicyControls()
    }

    // ====== 应用内更新（GitHub Releases 侧载更新）======

    private val updatePrefs by lazy { getSharedPreferences("app_update", MODE_PRIVATE) }

    /** 启动后延迟静默检查：有新版且未被用户忽略时弹更新框，其余情况完全无感。 */
    private fun autoCheckUpdateSilently() {
        lifecycleScope.launch {
            delay(3000)
            val info = ApkUpdater.checkLatest() ?: return@launch
            if (!ApkUpdater.hasUpdate(this@MainActivity, info)) return@launch
            if (info.versionName == updatePrefs.getString("skipped_version", null)) return@launch
            if (isFinishing || !lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)) return@launch
            showUpdateFoundDialog(info, manual = false)
        }
    }

    /** 手动检查更新：按钮置忙，最新/失败/有新版都有明确反馈。 */
    private fun checkForAppUpdate(manual: Boolean) {
        binding.btnCheckUpdate.isEnabled = false
        binding.btnCheckUpdate.setText(R.string.update_checking)
        lifecycleScope.launch {
            val info = ApkUpdater.checkLatest()
            binding.btnCheckUpdate.isEnabled = true
            binding.btnCheckUpdate.setText(R.string.check_update)
            when {
                info == null ->
                    Toast.makeText(this@MainActivity, R.string.update_check_failed, Toast.LENGTH_SHORT).show()
                !ApkUpdater.hasUpdate(this@MainActivity, info) ->
                    Toast.makeText(this@MainActivity, R.string.update_already_latest, Toast.LENGTH_SHORT).show()
                else -> showUpdateFoundDialog(info, manual)
            }
        }
    }

    private fun showUpdateFoundDialog(info: ApkUpdater.UpdateInfo, manual: Boolean) {
        val message = info.notes.ifBlank { getString(R.string.update_found_message_default) }
        val builder = androidx.appcompat.app.AlertDialog.Builder(this)
            .setTitle(getString(R.string.update_found_title, info.versionName))
            .setMessage(message)
            .setPositiveButton(R.string.update_download) { _, _ ->
                if (info.apkUrl == null) {
                    // 该 release 没上传 APK 资产：兜底跳浏览器手动下载
                    Toast.makeText(this, R.string.update_no_apk, Toast.LENGTH_LONG).show()
                    runCatching { startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(info.pageUrl))) }
                } else {
                    startUpdateDownload(info)
                }
            }
            .setNegativeButton(R.string.cancel, null)
        if (!manual) {
            // 自动弹出的提示允许「忽略此版本」，之后启动不再打扰（手动检查仍会提示）
            builder.setNeutralButton(R.string.update_skip_version) { _, _ ->
                updatePrefs.edit().putString("skipped_version", info.versionName).apply()
            }
        }
        builder.show()
    }

    /** 发起 APK 下载；Android 8+ 先确保「安装未知应用」权限，授权后经 onResume 续流程。 */
    private fun startUpdateDownload(info: ApkUpdater.UpdateInfo) {
        val apkUrl = info.apkUrl ?: return
        if (!ApkUpdater.canInstallPackages(this)) {
            androidx.appcompat.app.AlertDialog.Builder(this)
                .setTitle(R.string.update_install_permission_title)
                .setMessage(R.string.update_install_permission_message)
                .setPositiveButton(R.string.update_install_permission_go) { _, _ ->
                    pendingUpdateInfo = info
                    runCatching {
                        startActivity(
                            Intent(
                                Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                                Uri.parse("package:$packageName")
                            )
                        )
                    }
                }
                .setNegativeButton(R.string.cancel, null)
                .show()
            return
        }
        val downloadId = ApkUpdater.downloadApk(
            this, apkUrl, info.versionName,
            getString(R.string.app_name) + " " + info.versionName
        )
        if (downloadId == -1L) {
            Toast.makeText(this, R.string.update_download_failed, Toast.LENGTH_SHORT).show()
            return
        }
        pendingUpdateDownloadId = downloadId
        pendingUpdateVersionName = info.versionName
        pendingUpdatePageUrl = info.pageUrl
        Toast.makeText(this, R.string.update_downloading, Toast.LENGTH_SHORT).show()
    }

    /** 下载完成：校验 DownloadManager 状态后拉起系统安装器。 */
    private fun handleUpdateDownloadComplete(downloadId: Long) {
        pendingUpdateDownloadId = -1L
        val versionName = pendingUpdateVersionName
        val pageUrl = pendingUpdatePageUrl
        pendingUpdateVersionName = ""
        pendingUpdatePageUrl = ""
        if (versionName.isEmpty()) return

        val dm = getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager
        val successful = dm.query(DownloadManager.Query().setFilterById(downloadId))?.use { cursor ->
            cursor.moveToFirst() &&
                cursor.getInt(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS)) ==
                DownloadManager.STATUS_SUCCESSFUL
        } ?: false

        if (!successful) {
            // 下载本身失败（网络中断 / 存储不足等）：提示重试即可
            Toast.makeText(this, R.string.update_download_failed, Toast.LENGTH_LONG).show()
            return
        }

        if (!ApkUpdater.installApk(this, ApkUpdater.apkFile(this, versionName))) {
            // 下载成功但拉不起安装器：最常见是签名不一致，系统直接拒绝。
            // 给出手动下载兜底，避免用户卡在毫无去向的「下载失败」里。
            showInstallFailedDialog(pageUrl)
        }
    }

    /** 安装未能启动时的兜底：解释原因并提供「前往 GitHub 手动下载」。 */
    private fun showInstallFailedDialog(pageUrl: String) {
        val fallbackUrl = pageUrl.ifBlank {
            "https://github.com/happyfox-dot/Msg2Computer/releases/latest"
        }
        androidx.appcompat.app.AlertDialog.Builder(this)
            .setTitle(R.string.update_install_failed_title)
            .setMessage(R.string.update_install_failed_message)
            .setPositiveButton(R.string.update_open_github) { _, _ ->
                runCatching { startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(fallbackUrl))) }
            }
            .setNegativeButton(R.string.cancel, null)
            .show()
    }

    /** 把开关状态同步为「短信自动转发」偏好，而非常驻连接开关。 */
    private fun syncForwardSwitch() {
        updatingForwardSwitch = true
        binding.switchAutoSync.isChecked = SettingsStore.isForwardingEnabled(this)
        updatingForwardSwitch = false
    }

    private fun setupMessagePolicyControls() {
        syncMessagePolicySwitches()

        binding.switchSendAllSms.setOnCheckedChangeListener { _, isChecked ->
            if (updatingMessagePolicySwitches) return@setOnCheckedChangeListener
            SettingsStore.setSendAllSmsEnabled(this, isChecked)
            showMessagePolicySaved()
        }
        binding.switchSendNotifications.setOnCheckedChangeListener { _, isChecked ->
            if (updatingMessagePolicySwitches) return@setOnCheckedChangeListener
            SettingsStore.setSendNotificationsEnabled(this, isChecked)
            showMessagePolicySaved()
        }
        binding.switchReceiveSmsCodes.setOnCheckedChangeListener { _, isChecked ->
            if (updatingMessagePolicySwitches) return@setOnCheckedChangeListener
            SettingsStore.setReceiveSmsCodesEnabled(this, isChecked)
            showMessagePolicySaved()
        }
        binding.switchReceiveAllSms.setOnCheckedChangeListener { _, isChecked ->
            if (updatingMessagePolicySwitches) return@setOnCheckedChangeListener
            SettingsStore.setReceiveAllSmsEnabled(this, isChecked)
            showMessagePolicySaved()
        }
        binding.switchReceiveNotifications.setOnCheckedChangeListener { _, isChecked ->
            if (updatingMessagePolicySwitches) return@setOnCheckedChangeListener
            SettingsStore.setReceiveNotificationsEnabled(this, isChecked)
            showMessagePolicySaved()
        }
        binding.switchSyncClipboard.setOnCheckedChangeListener { _, isChecked ->
            if (updatingMessagePolicySwitches) return@setOnCheckedChangeListener
            SettingsStore.setSyncClipboardEnabled(this, isChecked)
            showMessagePolicySaved()
        }
        binding.switchSyncClipboardFile.setOnCheckedChangeListener { _, isChecked ->
            if (updatingMessagePolicySwitches) return@setOnCheckedChangeListener
            SettingsStore.setSyncClipboardFileEnabled(this, isChecked)
            showMessagePolicySaved()
        }
        binding.switchReceiveFileTransfer.setOnCheckedChangeListener { _, isChecked ->
            if (updatingMessagePolicySwitches) return@setOnCheckedChangeListener
            SettingsStore.setReceiveFileTransferEnabled(this, isChecked)
            showMessagePolicySaved()
        }
        binding.btnNotificationAccess.setOnClickListener {
            startActivity(Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS))
        }
        // 受 Android 10+ 后台读剪贴板限制，手机→其它节点只能在前台主动触发：
        // 点击按钮时（App 处于前台，读剪贴板合法）读取当前剪贴板并投递。
        binding.btnSyncClipboard.setOnClickListener {
            sendCurrentClipboard()
        }
        binding.btnSendFile.setOnClickListener {
            sendSelectedFile()
        }
        binding.btnSendFolder.setOnClickListener {
            sendSelectedFolder()
        }
        binding.btnFileHistory.setOnClickListener {
            showFileReceiveHistory()
        }
    }

    /** 读取当前剪贴板内容并投递到启用的设备节点（仅前台可读，符合系统限制）。 */
    private fun sendCurrentClipboard() {
        if (!SettingsStore.isSyncClipboardEnabled(this)) {
            Toast.makeText(this, R.string.clipboard_sync_disabled, Toast.LENGTH_SHORT).show()
            return
        }
        val clipboard = getSystemService(Context.CLIPBOARD_SERVICE) as android.content.ClipboardManager
        val item = clipboard.primaryClip?.takeIf { it.itemCount > 0 }?.getItemAt(0)
        val uri = item?.uri
        val uriMime = uri?.let { contentResolver.getType(it).orEmpty() }.orEmpty()
        if (uri != null && uriMime.startsWith("image/")) {
            sendClipboardImage(uri)
            return
        }
        if (DeviceStore.getEnabledDevices(this).none { it.allowClipboard }) {
            Toast.makeText(this, R.string.clipboard_no_target, Toast.LENGTH_SHORT).show()
            return
        }
        val text = item?.coerceToText(this)?.toString()?.trim().orEmpty()
        if (text.isBlank()) {
            Toast.makeText(this, R.string.clipboard_empty, Toast.LENGTH_SHORT).show()
            return
        }
        startServiceForAction(WebSocketService.ACTION_SEND_CLIPBOARD) {
            putExtra(WebSocketService.EXTRA_MESSAGE_BODY, text)
        }
        Toast.makeText(this, R.string.clipboard_sent, Toast.LENGTH_SHORT).show()
        refreshConnectionSnapshot()
    }

    private fun sendClipboardImage(uri: Uri) {
        if (!SettingsStore.isSyncClipboardImageEnabled(this)) {
            Toast.makeText(this, "图片剪贴板同步未开启", Toast.LENGTH_SHORT).show()
            return
        }
        if (DeviceStore.getEnabledDevices(this).none { it.allowClipboardImage || it.allowClipboard }) {
            Toast.makeText(this, "没有启用图片剪贴板的推送目标", Toast.LENGTH_SHORT).show()
            return
        }
        lifecycleScope.launch {
            val prepared = withContext(Dispatchers.IO) {
                runCatching { prepareClipboardImagePng(uri) }
            }
            prepared.onSuccess { file ->
                startServiceForAction(WebSocketService.ACTION_SEND_FILE) {
                    putExtra(WebSocketService.EXTRA_CONTENT_TYPE, "clipboard_image")
                    putExtra(WebSocketService.EXTRA_FILE_PATH, file.absolutePath)
                    putExtra(WebSocketService.EXTRA_FILE_NAME, file.name)
                    putExtra(WebSocketService.EXTRA_FILE_MIME, "image/png")
                }
                Toast.makeText(this@MainActivity, "图片剪贴板已发送", Toast.LENGTH_SHORT).show()
                refreshConnectionSnapshot()
            }.onFailure { error ->
                Toast.makeText(
                    this@MainActivity,
                    "图片剪贴板准备失败：${error.message ?: "unknown"}",
                    Toast.LENGTH_LONG
                ).show()
            }
        }
    }

    private fun sendSelectedFile() {
        if (!SettingsStore.isSyncClipboardFileEnabled(this)) {
            Toast.makeText(this, R.string.file_transfer_disabled, Toast.LENGTH_SHORT).show()
            return
        }
        if (DeviceStore.getEnabledDevices(this).none { it.allowFileTransfer }) {
            Toast.makeText(this, R.string.file_no_target, Toast.LENGTH_SHORT).show()
            return
        }
        showFileTargetSelectionSheet { targetIds ->
            pendingFileTransferTargetIds = targetIds
            pickFileLauncher.launch(arrayOf("*/*"))
        }
    }

    private fun sendSelectedFolder() {
        if (!SettingsStore.isSyncClipboardFileEnabled(this)) {
            Toast.makeText(this, R.string.file_transfer_disabled, Toast.LENGTH_SHORT).show()
            return
        }
        if (DeviceStore.getEnabledDevices(this).none { it.allowFileTransfer }) {
            Toast.makeText(this, R.string.file_no_target, Toast.LENGTH_SHORT).show()
            return
        }
        showFileTargetSelectionSheet { targetIds ->
            pendingFileTransferTargetIds = targetIds
            pickFolderLauncher.launch(null)
        }
    }

    private fun showFileTargetSelectionSheet(onSelected: (List<String>) -> Unit) {
        val devices = DeviceStore.getEnabledDevices(this)
            .filter { it.allowFileTransfer }
            .sortedBy { it.name.lowercase(Locale.ROOT) }
        if (devices.isEmpty()) {
            Toast.makeText(this, R.string.file_no_target, Toast.LENGTH_SHORT).show()
            return
        }
        val selected = BooleanArray(devices.size) { true }
        val items = devices.map { device ->
            val type = if (device.type.contains("PHONE", ignoreCase = true)) "手机" else "电脑"
            val host = (listOf(device.host) + device.altHosts).firstOrNull { it.isNotBlank() }.orEmpty()
            listOf(device.name, type, host).filter { it.isNotBlank() }.joinToString(" · ")
        }
        showMultiChoiceSheet(
            title = getString(R.string.file_target_select),
            message = getString(R.string.file_target_select_desc),
            items = items,
            selected = selected,
            positiveText = "继续选择文件",
            onPositive = {
                val targetIds = devices.filterIndexed { index, _ -> selected[index] }.map { it.id }
                if (targetIds.isEmpty()) {
                    pendingFileTransferTargetIds = emptyList()
                    Toast.makeText(this, R.string.file_target_none_selected, Toast.LENGTH_SHORT).show()
                    return@showMultiChoiceSheet
                }
                onSelected(targetIds)
            }
        )
    }

    private fun showFileReceiveHistory() {
        val history = FileTransferHistoryStore.get(this)
        val (dialog, content) = createBottomSheet(getString(R.string.file_receive_history))
        if (history.isEmpty()) {
            content.addView(TextView(this).apply {
                text = getString(R.string.file_history_empty)
                setTextColor(ContextCompat.getColor(this@MainActivity, R.color.text_secondary))
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
                    setTextColor(ContextCompat.getColor(this@MainActivity, R.color.text_primary))
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
                    setTextColor(ContextCompat.getColor(this@MainActivity, R.color.text_secondary))
                    textSize = 12f
                    setPadding(0, 4.dp(), 0, 0)
                })
                row.addView(TextView(this).apply {
                    text = item.path
                    setTextColor(ContextCompat.getColor(this@MainActivity, R.color.text_secondary))
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

    private fun openReceivedFile(path: String, mime: String) {
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

    private fun handleFileForTransfer(uri: Uri, batchId: String = "", batchCount: Int = 0) {
        lifecycleScope.launch {
            val prepared = withContext(Dispatchers.IO) {
                runCatching { copyUriToOutgoingFile(uri) }
            }
            prepared.onSuccess { file ->
                val name = queryDisplayName(uri).ifBlank { file.name }
                val mime = contentResolver.getType(uri).orEmpty()
                    .ifBlank { FileTransferRegistry.guessMime(name) }
                startNodeReceiverService()
                startServiceForAction(WebSocketService.ACTION_SEND_FILE) {
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
                    this@MainActivity,
                    getString(R.string.file_transfer_started, name),
                    Toast.LENGTH_LONG
                ).show()
                refreshConnectionSnapshot()
            }.onFailure { error ->
                Toast.makeText(
                    this@MainActivity,
                    getString(R.string.file_prepare_failed, error.message ?: "unknown"),
                    Toast.LENGTH_LONG
                ).show()
            }
        }
    }

    private data class FolderFileItem(
        val file: File,
        val name: String,
        val mime: String,
        val relativePath: String
    )

    private data class FolderCollectResult(val files: List<FolderFileItem>, val skipped: Int)

    private fun handleFolderForTransfer(treeUri: Uri) {
        Toast.makeText(this, "正在准备文件夹…", Toast.LENGTH_SHORT).show()
        lifecycleScope.launch {
            val prepared = withContext(Dispatchers.IO) {
                runCatching { collectFolderFiles(treeUri) }
            }
            prepared.onSuccess { result ->
                if (result.files.isEmpty()) {
                    Toast.makeText(this@MainActivity, "文件夹内没有可发送的文件", Toast.LENGTH_LONG).show()
                    return@onSuccess
                }
                val batchId = "batch-${java.util.UUID.randomUUID()}"
                startNodeReceiverService()
                result.files.forEach { item ->
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
                    this@MainActivity,
                    "正在发送文件夹（${result.files.size} 个文件$skippedText）",
                    Toast.LENGTH_LONG
                ).show()
                refreshConnectionSnapshot()
            }.onFailure { error ->
                Toast.makeText(
                    this@MainActivity,
                    getString(R.string.file_prepare_failed, error.message ?: "unknown"),
                    Toast.LENGTH_LONG
                ).show()
            }
        }
    }

    /** 经 SAF 递归收集文件夹内文件并复制到发件暂存目录（保留相对路径）。 */
    private fun collectFolderFiles(treeUri: Uri): FolderCollectResult {
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

    private fun copyUriToOutgoingFile(uri: Uri): File {
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

    private fun prepareClipboardImagePng(uri: Uri): File {
        val bitmap = contentResolver.openInputStream(uri)?.use { input ->
            BitmapFactory.decodeStream(input)
        } ?: error("invalid_image")
        val dir = File(filesDir, "outgoing_clipboard_images").apply { mkdirs() }
        val outputFile = uniqueFile(dir, "clipboard-${System.currentTimeMillis()}.png")
        FileOutputStream(outputFile).use { output ->
            if (!bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, output)) {
                error("encode_failed")
            }
        }
        bitmap.recycle()
        return outputFile
    }

    private fun queryDisplayName(uri: Uri): String {
        contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor ->
            if (cursor.moveToFirst()) {
                val index = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                if (index >= 0) return cursor.getString(index).orEmpty()
            }
        }
        return uri.lastPathSegment.orEmpty()
    }

    private fun sanitizeOutgoingFileName(name: String): String {
        return name.substringAfterLast('/').substringAfterLast('\\')
            .replace(Regex("[\\\\/\\x00-\\x1F<>:\"|?*]"), "_")
            .trim()
            .take(180)
            .ifBlank { "file" }
    }

    private fun uniqueFile(dir: File, name: String): File {
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

    private fun syncMessagePolicySwitches() {
        updatingMessagePolicySwitches = true
        binding.switchSendAllSms.isChecked = SettingsStore.isSendAllSmsEnabled(this)
        binding.switchSendNotifications.isChecked = SettingsStore.isSendNotificationsEnabled(this)
        binding.switchReceiveSmsCodes.isChecked = SettingsStore.isReceiveSmsCodesEnabled(this)
        binding.switchReceiveAllSms.isChecked = SettingsStore.isReceiveAllSmsEnabled(this)
        binding.switchReceiveNotifications.isChecked = SettingsStore.isReceiveNotificationsEnabled(this)
        binding.switchSyncClipboard.isChecked = SettingsStore.isSyncClipboardEnabled(this)
        binding.switchSyncClipboardFile.isChecked = SettingsStore.isSyncClipboardFileEnabled(this)
        binding.switchReceiveFileTransfer.isChecked = SettingsStore.isReceiveFileTransferEnabled(this)
        updatingMessagePolicySwitches = false
    }

    private fun showMessagePolicySaved() {
        Toast.makeText(this, R.string.message_policy_saved, Toast.LENGTH_SHORT).show()
        refreshConnectionSnapshot()
    }

    /**
     * 测试推送：生成一条模拟验证码，走与真实短信完全相同的投递链路
     * （ACTION_SEND_SMS → 连接/鉴权 → 加密投递 + 手机节点 relay 中继），
     * 用于配对后验证整条推送链路是否通畅。
     */
    private fun showTestPushDialog() {
        val enabledCount = DeviceStore.getEnabledDevices(this).size
        if (enabledCount == 0) {
            Toast.makeText(this, getString(R.string.test_push_no_target), Toast.LENGTH_SHORT).show()
            return
        }
        val code = (100000..999999).random().toString()
        androidx.appcompat.app.AlertDialog.Builder(this)
            .setTitle(getString(R.string.test_push_title))
            .setMessage(getString(R.string.test_push_message, code, enabledCount))
            .setPositiveButton(getString(R.string.test_push_confirm)) { _, _ ->
                startServiceForAction(WebSocketService.ACTION_SEND_SMS) {
                    putExtra(WebSocketService.EXTRA_CODE, code)
                    putExtra(WebSocketService.EXTRA_SOURCE, getString(R.string.test_push_source))
                    putExtra(WebSocketService.EXTRA_MESSAGE_BODY, getString(R.string.test_push_body, code))
                }
                Toast.makeText(this, getString(R.string.test_push_sent, code), Toast.LENGTH_LONG).show()
            }
            .setNegativeButton(android.R.string.cancel, null)
            .show()
    }

    private fun refreshDeviceList() {
        val devices = DeviceStore.getDevices(this)
        binding.deviceList.removeAllViews()

        if (devices.isEmpty()) {
            binding.deviceList.addView(
                TextView(this).apply {
                    text = getString(R.string.no_device_paired)
                    setTextColor(ContextCompat.getColor(this@MainActivity, R.color.text_secondary))
                    textSize = 13f
                }
            )
            rebuildTopologyList()
            return
        }

        val inflater = LayoutInflater.from(this)
        devices.forEach { device ->
            binding.deviceList.addView(createDeviceRow(inflater, device))
        }
        rebuildTopologyList()
    }

    private fun createDeviceRow(inflater: LayoutInflater, device: DesktopDevice): View {
        val row = inflater.inflate(R.layout.item_device, binding.deviceList, false)
        val dot = row.findViewById<View>(R.id.deviceDot)
        val name = row.findViewById<TextView>(R.id.deviceName)
        val address = row.findViewById<TextView>(R.id.deviceAddress)
        val switch = row.findViewById<MaterialSwitch>(R.id.deviceSwitch)

        name.text = device.name
        // 单行摘要：地址 · TS（Tailscale 可达）· 路由 · 上次同步；点击行可看完整详情
        val viaOtherNode = device.routeNextHopId.isNotBlank() && device.routeNextHopId != device.id
        val hasTailscale = (listOf(device.host) + device.altHosts)
            .any { LanDiscovery.isTailscaleAddress(it) }
        address.text = buildList {
            add(getString(R.string.device_address, device.host, device.port))
            if (hasTailscale) add("TS")
            if (viaOtherNode) add("经 ${device.routeNextHopName.ifBlank { "中继" }}")
            add("内容: ${deviceContentPolicySummary(device)}")
            add(getString(R.string.last_sync_time, formatRelativeSyncTime(device.lastSyncAt)))
        }.joinToString(" · ")
        tintDot(dot, device.enabled)

        switch.setOnCheckedChangeListener(null)
        switch.isChecked = device.enabled
        switch.setOnCheckedChangeListener { _, checked ->
            DeviceStore.setDeviceEnabled(this, device.id, checked)
            TopologyStore.markDeviceState(this, device.copy(enabled = checked), enabled = checked)
            tintDot(dot, checked)
            rebuildTopologyList()
            broadcastTopologyChange(if (checked) "device_enabled" else "device_disabled")
            if (checked) {
                // 启用时做一次配对登记连接，让目标节点立即看到这台手机在线
                startServiceForAction(WebSocketService.ACTION_CONNECT) {
                    putExtra(WebSocketService.EXTRA_DEVICE_ID, device.id)
                }
            }
        }

        row.setOnClickListener {
            showDeviceDetailSheet(device)
        }
        row.setOnLongClickListener {
            confirmRemoveDevice(device)
            true
        }
        return row
    }

    /** 设备节点完整详情（地址 / Tailscale / 路由 / 同步时间），点设备行弹出。 */
    private fun showDeviceDetailSheet(device: DesktopDevice) {
        val state = if (device.enabled) getString(R.string.push_enabled) else getString(R.string.push_disabled)
        val tailscaleHosts = (listOf(device.host) + device.altHosts)
            .filter { LanDiscovery.isTailscaleAddress(it) }
        val viaOtherNode = device.routeNextHopId.isNotBlank() && device.routeNextHopId != device.id
        val detail = buildList {
            add("设备：${device.name}")
            add("类型：${device.type}")
            add("地址：${device.host}:${device.port}")
            if (device.altHosts.isNotEmpty()) add("备用地址：${device.altHosts.joinToString("、")}")
            if (tailscaleHosts.isNotEmpty()) add("Tailscale：${tailscaleHosts.joinToString("、")}（跨网段可达）")
            add(
                when {
                    viaOtherNode -> "路由：经 ${device.routeNextHopName.ifBlank { device.routeNextHopId }} 中继" +
                        (if (device.routeMetric > 0) "（metric ${device.routeMetric}）" else "")
                    device.routeMetric > 0 -> "路由：SPF 直连（metric ${device.routeMetric}）"
                    else -> "路由：直连"
                }
            )
            if (device.routePath.size > 2) add("路径：${device.routePath.joinToString(" → ")}")
            add("状态：$state")
            add("推送内容：${deviceContentPolicySummary(device)}")
            add("上次同步：${formatFullSyncTime(device.lastSyncAt)}")
            add("提示：长按列表项可移除该设备")
        }
        val (dialog, content) = createBottomSheet(getString(R.string.topology_device_detail))
        content.addView(TextView(this).apply {
            text = detail.joinToString("\n")
            setTextColor(ContextCompat.getColor(this@MainActivity, R.color.text_secondary))
            textSize = 13f
            setPadding(0, 12.dp(), 0, 4.dp())
        })
        addSheetButton(content, getString(R.string.device_content_policy)) {
            dialog.dismiss()
            showDeviceContentPolicySheet(device)
        }
        addSheetButton(content, getString(android.R.string.ok), outlined = true) {
            dialog.dismiss()
        }
        dialog.show()
    }

    private fun showDeviceContentPolicySheet(device: DesktopDevice) {
        val items = listOf(
            getString(R.string.policy_sms_codes),
            getString(R.string.policy_all_sms),
            getString(R.string.policy_notifications),
            getString(R.string.policy_totp),
            getString(R.string.policy_clipboard),
            "剪贴板图片",
            "文件传输"
        )
        val selected = booleanArrayOf(
            device.allowSmsCodes,
            device.allowSmsMessages,
            device.allowNotifications,
            device.allowTotp,
            device.allowClipboard,
            device.allowClipboardImage,
            device.allowFileTransfer
        )

        showMultiChoiceSheet(
            title = getString(R.string.device_content_policy),
            message = getString(R.string.device_content_policy_desc, device.name),
            items = items,
            selected = selected,
            positiveText = getString(R.string.save),
            onPositive = {
                DeviceStore.setDeviceContentPolicy(
                    context = this,
                    id = device.id,
                    allowSmsCodes = selected[0],
                    allowSmsMessages = selected[1],
                    allowNotifications = selected[2],
                    allowTotp = selected[3],
                    allowClipboard = selected[4],
                    allowClipboardImage = selected[5],
                    allowClipboardFile = selected[6],
                    allowFileTransfer = selected[6]
                )
                refreshDeviceList()
                rebuildTopologyList()
                broadcastTopologyChange("device_content_policy_changed")
                Toast.makeText(this, R.string.message_policy_saved, Toast.LENGTH_SHORT).show()
            }
        )
    }

    private fun deviceContentPolicySummary(device: DesktopDevice): String {
        val items = buildList {
            if (device.allowSmsCodes) add(getString(R.string.policy_sms_codes_short))
            if (device.allowSmsMessages) add(getString(R.string.policy_all_sms_short))
            if (device.allowNotifications) add(getString(R.string.policy_notifications_short))
            if (device.allowTotp) add("TOTP")
            if (device.allowClipboard) add(getString(R.string.policy_clipboard_short))
            if (device.allowClipboardImage) add("图片剪贴板")
            if (device.allowFileTransfer) add("文件")
        }
        return items.joinToString("、").ifBlank { getString(R.string.policy_none) }
    }

    private fun tintDot(dot: View, online: Boolean) {
        val color = ContextCompat.getColor(
            this,
            if (online) R.color.status_online else R.color.status_offline
        )
        dot.backgroundTintList = ColorStateList.valueOf(color)
    }

    private fun rebuildTopologyList() {
        val container = binding.topologyList
        container.removeAllViews()

        val phone = PhoneIdentityStore.get(this)
        val devices = DeviceStore.getDevices(this)
        val remoteTotps = loadTotpEntries().filter { !it.isLocal && it.sourceDeviceId.isNotBlank() }
        val pairedIds = devices.map { it.id }.toSet()
        val discoveredPeers = discoveredLanNodes
            .filter { it.id != phone.id && it.id !in pairedIds }
            .distinctBy { it.id }

        val graphNodes = mutableListOf(
            TopologyGraphView.Node(
                id = phone.id,
                name = phone.name,
                type = "ANDROID_PHONE",
                status = "online",
                local = true
            )
        )
        val graphEdges = mutableListOf<TopologyGraphView.Edge>()

        container.addView(
            createTopologyRow(
                title = "${deviceIcon("ANDROID_PHONE")} ${phone.name}",
                meta = "${getString(R.string.topology_local_phone)} · 对等节点 · 来源设备",
                detail = listOf(
                    "设备：${phone.name}",
                    "类型：ANDROID_PHONE",
                    "角色：验证码来源设备",
                    "推送目标：${devices.count { it.enabled }} / ${devices.size} 个节点",
                    "局域网发现：${discoveredPeers.size} 个临近节点"
                )
            )
        )

        devices.forEach { device ->
            // 路由信息（由桌面节点 SPF 计算后下发）：直连显示地址，多跳显示下一跳
            val viaOtherNode = device.routeNextHopId.isNotBlank() && device.routeNextHopId != device.id
            val tsTag = if (
                LanDiscovery.isTailscaleAddress(device.host) ||
                device.altHosts.any { LanDiscovery.isTailscaleAddress(it) }
            ) " · TS" else ""
            graphNodes.add(
                TopologyGraphView.Node(
                    id = device.id,
                    name = device.name,
                    type = device.type,
                    status = if (device.enabled) "enabled" else "disabled",
                    meta = when {
                        viaOtherNode -> "经 ${device.routeNextHopName.ifBlank { "中继节点" }}$tsTag"
                        else -> device.host + tsTag
                    }
                )
            )
            graphEdges.add(
                TopologyGraphView.Edge(
                    from = phone.id,
                    to = device.id,
                    label = when {
                        viaOtherNode -> "经 ${device.routeNextHopName.ifBlank { "中继" }}"
                        device.routeMetric > 0 -> "SPF 路由"
                        else -> "推送"
                    },
                    active = device.enabled,
                    kind = if (viaOtherNode) "relay" else "push",
                    metric = device.routeMetric
                )
            )
        }

        remoteTotps
            .groupBy { it.sourceDeviceId }
            .forEach { (sourceId, entries) ->
                val first = entries.first()
                val nodeId = sourceId.ifBlank { first.sourceDeviceName }
                if (nodeId.isNotBlank() && graphNodes.none { it.id == nodeId }) {
                    graphNodes.add(
                        TopologyGraphView.Node(
                            id = nodeId,
                            name = first.sourceDeviceName.ifBlank { "远端节点" },
                            type = first.sourceDeviceType,
                            status = "synced"
                        )
                    )
                }
                if (nodeId.isNotBlank()) {
                    graphEdges.add(
                        TopologyGraphView.Edge(
                            from = nodeId,
                            to = phone.id,
                            label = "TOTP 同步",
                            active = true,
                            kind = "totp"
                        )
                    )
                }
            }

        discoveredPeers.forEach { peer ->
            graphNodes.add(
                TopologyGraphView.Node(
                    id = peer.id,
                    name = peer.name,
                    type = peer.type,
                    status = "discovered",
                    meta = "${peer.host} · 待配对"
                )
            )
            graphEdges.add(
                TopologyGraphView.Edge(
                    from = phone.id,
                    to = peer.id,
                    label = "发现",
                    active = false,
                    kind = "discovery"
                )
            )
        }

        binding.topologyGraph.setGraph(graphNodes, graphEdges)

        if (devices.isEmpty() && remoteTotps.isEmpty() && discoveredPeers.isEmpty()) {
            container.addView(
                TextView(this).apply {
                    text = getString(R.string.topology_empty)
                    setTextColor(ContextCompat.getColor(this@MainActivity, R.color.text_tertiary))
                    textSize = 13f
                    gravity = Gravity.CENTER
                    setPadding(0, 18, 0, 8)
                }
            )
            return
        }

        devices.forEach { device ->
            val state = if (device.enabled) getString(R.string.push_enabled) else getString(R.string.push_disabled)
            val lastSync = formatRelativeSyncTime(device.lastSyncAt)
            val routeLine = when {
                device.routeNextHopId.isNotBlank() && device.routeNextHopId != device.id ->
                    "路由：经 ${device.routeNextHopName.ifBlank { device.routeNextHopId }} 中继" +
                        (if (device.routeMetric > 0) "（metric ${device.routeMetric}）" else "")
                device.routeMetric > 0 -> "路由：SPF 直连（metric ${device.routeMetric}）"
                else -> "路由：直连"
            }
            val tailscaleHosts = (listOf(device.host) + device.altHosts)
                .filter { LanDiscovery.isTailscaleAddress(it) }
            container.addView(
                createTopologyRow(
                    title = "${deviceIcon("ANDROID_PHONE")} ${phone.name}  --  ${deviceIcon(device.type)} ${device.name}",
                    meta = "${getString(R.string.topology_push_edge)} · $state · ${getString(R.string.status_last_sync, lastSync)}",
                    detail = buildList {
                        add("来源：${phone.name}")
                        add("目标：${device.name}")
                        add("地址：${device.host}:${device.port}")
                        if (device.altHosts.isNotEmpty()) {
                            add("备用地址：${device.altHosts.joinToString("、")}")
                        }
                        if (tailscaleHosts.isNotEmpty()) {
                            add("Tailscale：${tailscaleHosts.joinToString("、")}（跨网段可达）")
                        }
                        add(routeLine)
                        if (device.routePath.size > 2) {
                            add("路径：${device.routePath.joinToString(" → ")}")
                        }
                        add("状态：$state")
                        add("推送内容：${deviceContentPolicySummary(device)}")
                        add("上次同步：${formatFullSyncTime(device.lastSyncAt)}")
                        add("权限：来源手机控制推送范围")
                    }
                )
            )
        }

        remoteTotps
            .groupBy { it.sourceDeviceId }
            .forEach { (_, entries) ->
                val first = entries.first()
                val sourceName = first.sourceDeviceName.ifBlank { "远端节点" }
                container.addView(
                    createTopologyRow(
                        title = "${deviceIcon(first.sourceDeviceType)} $sourceName  --  ${deviceIcon("ANDROID_PHONE")} ${phone.name}",
                        meta = "远端 TOTP 种子同步 · ${entries.size} 个验证码",
                        detail = listOf(
                            "来源：$sourceName",
                            "目标：${phone.name}",
                            "类型：${first.sourceDeviceType}",
                            "同步内容：${entries.size} 个 TOTP 种子",
                            "权限：远端来源只读，本机不再二次分发"
                        )
                    )
                )
            }

        discoveredPeers.forEach { peer ->
            val pairHint = if (peer.type.contains("DESKTOP") && peer.pairingKey.isNotBlank()) {
                "可配对"
            } else {
                "仅发现，暂未建立直连同步"
            }
            container.addView(
                createTopologyRow(
                    title = "${deviceIcon("ANDROID_PHONE")} ${phone.name}  ⇢  ${deviceIcon(peer.type)} ${peer.name}",
                    meta = "局域网对等节点 · $pairHint · ${peer.host}:${peer.port}",
                    detail = listOf(
                        "节点：${peer.name}",
                        "类型：${peer.type}",
                        "地址：${peer.host}:${peer.port}",
                        "状态：局域网已发现",
                        "说明：手机节点会进入拓扑，但当前同步连接仍需受配对协议控制"
                    )
                )
            )
        }
    }

    private fun deviceIcon(type: String): String {
        return if (type.uppercase(Locale.ROOT).contains("PHONE")) "📱" else "💻"
    }

    private fun createTopologyRow(title: String, meta: String, detail: List<String>): View {
        return LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundResource(R.drawable.bg_row)
            setPadding(14.dp(), 11.dp(), 14.dp(), 11.dp())
            isClickable = true
            isFocusable = true
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
            ).apply {
                bottomMargin = 8.dp()
            }

            addView(TextView(this@MainActivity).apply {
                text = title
                setTextColor(ContextCompat.getColor(this@MainActivity, R.color.text_primary))
                textSize = 13f
                setTypeface(typeface, android.graphics.Typeface.BOLD)
                maxLines = 2
            })
            addView(TextView(this@MainActivity).apply {
                text = meta
                setTextColor(ContextCompat.getColor(this@MainActivity, R.color.text_secondary))
                textSize = 11f
                setPadding(0, 3.dp(), 0, 0)
            })

            setOnClickListener {
                showDetailSheet(getString(R.string.topology_device_detail), detail)
            }
        }
    }

    private fun Int.dp(): Int = (this * resources.displayMetrics.density).toInt()

    private fun createBottomSheet(title: String, message: String? = null): Pair<BottomSheetDialog, LinearLayout> {
        val dialog = BottomSheetDialog(this)
        val content = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(20.dp(), 10.dp(), 20.dp(), 18.dp())
        }
        content.addView(View(this).apply {
            setBackgroundColor(ContextCompat.getColor(this@MainActivity, R.color.outline))
            layoutParams = LinearLayout.LayoutParams(44.dp(), 4.dp()).apply {
                gravity = Gravity.CENTER_HORIZONTAL
                bottomMargin = 18.dp()
            }
        })
        content.addView(TextView(this).apply {
            text = title
            setTextColor(ContextCompat.getColor(this@MainActivity, R.color.text_primary))
            textSize = 19f
            setTypeface(typeface, android.graphics.Typeface.BOLD)
        })
        if (!message.isNullOrBlank()) {
            content.addView(TextView(this).apply {
                text = message
                setTextColor(ContextCompat.getColor(this@MainActivity, R.color.text_secondary))
                textSize = 13f
                setPadding(0, 8.dp(), 0, 4.dp())
            })
        }

        val scroll = ScrollView(this).apply {
            addView(content)
        }
        dialog.setContentView(scroll)
        return dialog to content
    }

    private fun addSheetButton(
        parent: LinearLayout,
        text: String,
        destructive: Boolean = false,
        outlined: Boolean = false,
        onClick: () -> Unit
    ): MaterialButton {
        val button = MaterialButton(this).apply {
            this.text = text
            cornerRadius = 14.dp()
            minHeight = 48.dp()
            if (destructive) {
                setTextColor(ContextCompat.getColor(this@MainActivity, R.color.danger))
            }
            if (outlined) {
                strokeColor = ColorStateList.valueOf(ContextCompat.getColor(this@MainActivity, R.color.outline))
                strokeWidth = 1.dp()
            }
            setOnClickListener { onClick() }
        }
        parent.addView(button, LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT,
            48.dp()
        ).apply {
            topMargin = 10.dp()
        })
        return button
    }

    private fun showActionSheet(title: String, actions: List<SheetAction>) {
        val (dialog, content) = createBottomSheet(title)
        actions.forEach { action ->
            val row = LinearLayout(this).apply {
                orientation = LinearLayout.VERTICAL
                setBackgroundResource(R.drawable.bg_row)
                alpha = if (action.enabled) 1f else 0.45f
                isEnabled = action.enabled
                isClickable = action.enabled
                setPadding(14.dp(), 12.dp(), 14.dp(), 12.dp())
                setOnClickListener {
                    dialog.dismiss()
                    action.onClick()
                }
            }
            row.addView(TextView(this).apply {
                text = action.title
                setTextColor(ContextCompat.getColor(
                    this@MainActivity,
                    if (action.destructive) R.color.danger else R.color.text_primary
                ))
                textSize = 15f
                setTypeface(typeface, android.graphics.Typeface.BOLD)
            })
            if (action.subtitle.isNotBlank()) {
                row.addView(TextView(this).apply {
                    text = action.subtitle
                    setTextColor(ContextCompat.getColor(this@MainActivity, R.color.text_secondary))
                    textSize = 12f
                    setPadding(0, 3.dp(), 0, 0)
                })
            }
            content.addView(row, LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
            ).apply {
                topMargin = 10.dp()
            })
        }
        addSheetButton(content, getString(R.string.cancel), outlined = true) {
            dialog.dismiss()
        }
        dialog.show()
    }

    private fun showConfirmSheet(
        title: String,
        message: String,
        positiveText: String,
        destructive: Boolean = false,
        onConfirm: () -> Unit
    ) {
        val (dialog, content) = createBottomSheet(title, message)
        addSheetButton(content, positiveText, destructive = destructive) {
            dialog.dismiss()
            onConfirm()
        }
        addSheetButton(content, getString(R.string.cancel), outlined = true) {
            dialog.dismiss()
        }
        dialog.show()
    }

    private fun showDetailSheet(title: String, lines: List<String>) {
        val (dialog, content) = createBottomSheet(title)
        content.addView(TextView(this).apply {
            text = lines.joinToString("\n")
            setTextColor(ContextCompat.getColor(this@MainActivity, R.color.text_secondary))
            textSize = 13f
            setPadding(0, 12.dp(), 0, 4.dp())
        })
        addSheetButton(content, getString(android.R.string.ok), outlined = true) {
            dialog.dismiss()
        }
        dialog.show()
    }

    private fun showMultiChoiceSheet(
        title: String,
        message: String,
        items: List<String>,
        selected: BooleanArray,
        positiveText: String,
        neutralText: String? = null,
        onPositive: () -> Unit,
        onNeutral: (() -> Unit)? = null
    ) {
        val (dialog, content) = createBottomSheet(title, message)
        items.forEachIndexed { index, item ->
            val row = LinearLayout(this).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
                setBackgroundResource(R.drawable.bg_row)
                setPadding(10.dp(), 8.dp(), 12.dp(), 8.dp())
            }
            val checkBox = CheckBox(this).apply {
                isChecked = selected[index]
                buttonTintList = ColorStateList.valueOf(ContextCompat.getColor(this@MainActivity, R.color.primary))
                setOnCheckedChangeListener { _, checked -> selected[index] = checked }
            }
            row.setOnClickListener {
                checkBox.isChecked = !checkBox.isChecked
            }
            row.addView(checkBox)
            row.addView(TextView(this).apply {
                text = item
                setTextColor(ContextCompat.getColor(this@MainActivity, R.color.text_primary))
                textSize = 13f
            }, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
            content.addView(row, LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
            ).apply {
                topMargin = 8.dp()
            })
        }
        addSheetButton(content, positiveText) {
            dialog.dismiss()
            onPositive()
        }
        if (!neutralText.isNullOrBlank() && onNeutral != null) {
            addSheetButton(content, neutralText, outlined = true) {
                dialog.dismiss()
                onNeutral()
            }
        }
        addSheetButton(content, getString(R.string.cancel), outlined = true) {
            dialog.dismiss()
        }
        dialog.show()
    }

    private fun confirmRemoveDevice(device: DesktopDevice) {
        showConfirmSheet(
            title = getString(R.string.remove_device_title),
            message = getString(R.string.remove_device_message, device.name),
            positiveText = getString(R.string.remove),
            destructive = true
        ) {
                TopologyStore.markDeviceState(this, device.copy(enabled = false), enabled = false, revoked = true)
                DeviceStore.removeDevice(this, device.id)
                refreshDeviceList()
                rebuildTopologyList()
                broadcastTopologyChange("device_revoked")
        }
    }

    private fun showLanDiscoveryDialog() {
        binding.btnDiscoverLan.isEnabled = false
        Toast.makeText(this, R.string.discovering_lan, Toast.LENGTH_SHORT).show()

        lifecycleScope.launch {
            try {
                val devices = withContext(Dispatchers.IO) {
                    LanDiscovery.discover(this@MainActivity)
                }
                if (devices.isEmpty()) {
                    Toast.makeText(this@MainActivity, R.string.lan_discovery_empty, Toast.LENGTH_SHORT).show()
                    return@launch
                }
                discoveredLanNodes = devices
                rebuildTopologyList()
                showDiscoveredLanDevices(devices)
            } catch (e: Exception) {
                val message = e.message ?: e.javaClass.simpleName
                Toast.makeText(
                    this@MainActivity,
                    getString(R.string.lan_discovery_failed, message),
                    Toast.LENGTH_LONG
                ).show()
            } finally {
                binding.btnDiscoverLan.isEnabled = true
            }
        }
    }

    private fun showDiscoveredLanDevices(devices: List<LanDiscoveredDevice>) {
        showActionSheet(
            title = getString(R.string.lan_discovery_title),
            actions = devices.map { device ->
                val canPairNode = device.pairingKey.isNotBlank() || device.joinPublicKey.isNotBlank()
                SheetAction(
                    title = "${deviceIcon(device.type)} ${device.name}",
                    subtitle = "${device.host}:${device.joinPort} · ${device.type} · ${if (device.joinPublicKey.isNotBlank()) "可请求加入可信网络" else if (device.pairingKey.isNotBlank()) "可加入推送目标" else "未确认节点"}"
                ) {
                    if (canPairNode) {
                        pairDiscoveredLanDevice(device)
                    } else {
                        showDetailSheet(
                            title = device.name,
                            lines = listOf(
                                "类型：${device.type}",
                                "地址：${device.host}:${device.joinPort}",
                                "状态：未确认",
                                "指纹：${device.joinFingerprint.ifBlank { "未提供" }}",
                                "说明：该节点未提供入网公钥，暂不能请求加入"
                            )
                        )
                    }
                }
            }
        )
    }

    private fun showLanJoinRequest(requestId: String) {
        val request = LanJoinCoordinator.getPending(requestId) ?: return
        val caps = mutableListOf<String>().apply {
            if (request.capabilities.optBoolean("topology")) add("拓扑")
            if (request.capabilities.optBoolean("relay")) add("中继")
            if (request.capabilities.optBoolean("sms")) add("短信")
            if (request.capabilities.optBoolean("totp")) add("TOTP")
            if (request.capabilities.optBoolean("clipboardImage")) add("图片剪贴板")
            if (request.capabilities.optBoolean("clipboardText")) add("剪贴板")
            if (request.capabilities.optBoolean("fileTransfer")) add("文件")
        }.joinToString("、").ifBlank { "未声明" }
        val subtitle = listOf(
            "${request.host}:${request.joinPort}",
            request.nodeType,
            "指纹 ${request.fingerprint.ifBlank { "未提供" }}",
            "能力 $caps",
            "网络 ${request.networkId.ifBlank { "新节点" }}"
        ).joinToString("\n")

        showActionSheet(
            title = "局域网加入请求：${request.nodeName}",
            actions = listOf(
                SheetAction(
                    title = "基础同步",
                    subtitle = subtitle + "\n允许短信验证码、TOTP、拓扑同步"
                ) {
                    LanJoinCoordinator.respond(requestId, accepted = true, template = "basic")
                    Toast.makeText(this, "已允许 ${request.nodeName} 加入", Toast.LENGTH_SHORT).show()
                },
                SheetAction(
                    title = "完整同步",
                    subtitle = subtitle + "\n允许短信、通知、剪贴板、图片和文件"
                ) {
                    LanJoinCoordinator.respond(requestId, accepted = true, template = "full")
                    Toast.makeText(this, "已允许 ${request.nodeName} 完整同步", Toast.LENGTH_SHORT).show()
                },
                SheetAction(
                    title = "只加入拓扑",
                    subtitle = subtitle + "\n仅参与拓扑显示和中继"
                ) {
                    LanJoinCoordinator.respond(requestId, accepted = true, template = "topology_only")
                    Toast.makeText(this, "已允许 ${request.nodeName} 加入拓扑", Toast.LENGTH_SHORT).show()
                },
                SheetAction(
                    title = "拒绝",
                    subtitle = subtitle,
                    destructive = true
                ) {
                    LanJoinCoordinator.respond(requestId, accepted = false)
                    Toast.makeText(this, "已拒绝 ${request.nodeName}", Toast.LENGTH_SHORT).show()
                }
            )
        )
    }

    private fun showFileTransferRequest(requestId: String) {
        val request = FileTransferCoordinator.getPending(requestId) ?: return
        if (!shownFileTransferRequests.add(requestId)) return
        val expiresText = if (request.expiresAt > 0L) {
            SimpleDateFormat("HH:mm:ss", Locale.getDefault()).format(Date(request.expiresAt))
        } else {
            "未声明"
        }
        val hashText = request.sha256.take(16).ifBlank { "未声明" }
        val detail = listOfNotNull(
            "来源节点：${request.sourceDeviceName}",
            "文件名称：${request.fileName}",
            "文件大小：${formatFileSize(request.size)}",
            "文件类型：${request.mime.ifBlank { "application/octet-stream" }}",
            "Hash：$hashText",
            "有效期：$expiresText",
            if (request.batchCount > 1) "本批共 ${request.batchCount} 个文件，本次选择对整批生效" else null
        ).joinToString("\n")

        val (dialog, content) = createBottomSheet(
            title = "文件接收请求",
            message = detail
        )
        addSheetButton(content, if (request.batchCount > 1) "全部接收" else "接收文件") {
            shownFileTransferRequests.remove(requestId)
            FileTransferCoordinator.respond(requestId, accepted = true)
            dialog.dismiss()
            Toast.makeText(this, "正在接收 ${request.fileName}", Toast.LENGTH_SHORT).show()
        }
        addSheetButton(content, if (request.batchCount > 1) "全部拒绝" else "拒绝", outlined = true) {
            shownFileTransferRequests.remove(requestId)
            FileTransferCoordinator.respond(requestId, accepted = false)
            dialog.dismiss()
            Toast.makeText(this, "已拒绝文件", Toast.LENGTH_SHORT).show()
        }
        dialog.setOnCancelListener {
            shownFileTransferRequests.remove(requestId)
            FileTransferCoordinator.respond(requestId, accepted = false)
        }
        dialog.show()
    }

    private fun pairDiscoveredLanDevice(device: LanDiscoveredDevice) {
        if (device.pairingKey.isBlank() && device.joinPublicKey.isNotBlank()) {
            lifecycleScope.launch {
                try {
                    val result = withContext(Dispatchers.IO) {
                        LanJoinClient.requestJoin(this@MainActivity, device, "basic")
                    }
                    if (result.success && result.device != null) {
                        refreshDeviceList()
                        rebuildTopologyList()
                        startServiceForAction(WebSocketService.ACTION_CONNECT) {
                            putExtra(WebSocketService.EXTRA_DEVICE_ID, result.device.id)
                        }
                        broadcastTopologyChange("lan_join_accepted")
                        Toast.makeText(
                            this@MainActivity,
                            getString(R.string.lan_device_paired, result.device.name),
                            Toast.LENGTH_SHORT
                        ).show()
                        refreshConnectionSnapshot()
                    } else {
                        Toast.makeText(
                            this@MainActivity,
                            if (result.rejected) "入网请求被拒绝" else "入网失败：${result.error}",
                            Toast.LENGTH_LONG
                        ).show()
                    }
                } catch (e: Exception) {
                    Toast.makeText(
                        this@MainActivity,
                        "入网失败：${e.message ?: e.javaClass.simpleName}",
                        Toast.LENGTH_LONG
                    ).show()
                }
            }
            return
        }
        val paired = DeviceStore.upsertDevice(
            context = this,
            host = device.host,
            port = device.port,
            pairingKey = device.pairingKey,
            name = device.name,
            deviceId = device.id,
            deviceType = device.type,
            // 用户显式配对：明确表达启用意图（拓扑同步路径则不改写本地开关）
            enabled = true
        )
        TopologyStore.markDeviceState(this, paired, enabled = paired.enabled)

        refreshDeviceList()
        startServiceForAction(WebSocketService.ACTION_CONNECT) {
            putExtra(WebSocketService.EXTRA_DEVICE_ID, paired.id)
        }
        broadcastTopologyChange("lan_device_paired")
        Toast.makeText(
            this,
            getString(R.string.lan_device_paired, paired.name),
            Toast.LENGTH_SHORT
        ).show()
        refreshConnectionSnapshot()
    }

    private fun showDisconnectTargetsDialog() {
        val devices = DeviceStore.getDevices(this)
        if (devices.isEmpty()) {
            Toast.makeText(this, R.string.no_device_to_disconnect, Toast.LENGTH_SHORT).show()
            return
        }

        val items = devices.map { device ->
            val state = if (device.enabled) getString(R.string.push_enabled)
            else getString(R.string.push_disabled)
            "${device.name}\n${device.host}:${device.port} · $state"
        }
        val selected = BooleanArray(devices.size) { devices[it].enabled }

        showMultiChoiceSheet(
            title = getString(R.string.select_disconnect_title),
            message = getString(R.string.select_device_to_disconnect),
            items = items,
            selected = selected,
            positiveText = getString(R.string.disconnect_selected),
            neutralText = getString(R.string.disconnect_all),
            onPositive = {
                disableDevices(devices.filterIndexed { index, _ -> selected[index] })
            },
            onNeutral = {
                disableDevices(devices)
            }
        )
    }

    /** 按需模型下「断开」即关闭该设备节点的推送目标（停止向其转发）。 */
    private fun disableDevices(devices: List<DesktopDevice>) {
        if (devices.isEmpty()) {
            Toast.makeText(this, R.string.select_device_to_disconnect, Toast.LENGTH_SHORT).show()
            return
        }

        devices.forEach {
            DeviceStore.setDeviceEnabled(this, it.id, false)
            TopologyStore.markDeviceState(this, it.copy(enabled = false), enabled = false)
        }
        refreshDeviceList()
        broadcastTopologyChange("devices_disabled")
        Toast.makeText(
            this,
            getString(R.string.disconnected_n_devices, devices.size),
            Toast.LENGTH_SHORT
        ).show()
        refreshConnectionSnapshot()
    }

    private fun showRevokeTotpAccessDialog() {
        val devices = DeviceStore.getDevices(this)
        if (devices.isEmpty()) {
            Toast.makeText(this, R.string.no_device_to_disconnect, Toast.LENGTH_SHORT).show()
            return
        }

        val items = devices.map { device ->
            val state = if (device.enabled) getString(R.string.push_enabled)
            else getString(R.string.push_disabled)
            "${device.name}\n${device.host}:${device.port} · $state"
        }
        val selected = BooleanArray(devices.size) { false }

        showMultiChoiceSheet(
            title = getString(R.string.revoke_totp_access_title),
            message = getString(R.string.revoke_totp_access_message),
            items = items,
            selected = selected,
            positiveText = getString(R.string.revoke_totp_access_selected),
            onPositive = {
                revokeTotpAccess(devices.filterIndexed { index, _ -> selected[index] })
            }
        )
    }

    private fun revokeTotpAccess(devices: List<DesktopDevice>) {
        if (devices.isEmpty()) {
            Toast.makeText(this, R.string.select_device_to_revoke_totp, Toast.LENGTH_SHORT).show()
            return
        }

        startServiceForAction(WebSocketService.ACTION_REVOKE_TOTP_ACCESS) {
            putStringArrayListExtra(
                WebSocketService.EXTRA_DEVICE_IDS,
                ArrayList(devices.map { it.id })
            )
        }
        Toast.makeText(
            this,
            getString(R.string.revoking_totp_access_n_devices, devices.size),
            Toast.LENGTH_SHORT
        ).show()
        refreshConnectionSnapshot()
    }

    private fun showAddTotpDialog() {
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

    private fun showManualTotpInputDialog() {
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
            boxBackgroundColor = ContextCompat.getColor(this@MainActivity, R.color.bg_surface_variant)
            addView(labelInput)
        }
        val secretLayout = TextInputLayout(this).apply {
            hint = getString(R.string.totp_secret_hint)
            boxBackgroundColor = ContextCompat.getColor(this@MainActivity, R.color.bg_surface_variant)
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

    private fun saveTotpSecret(label: String, secret: String) {
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

    private fun syncTotpToDesktop(entry: TotpEntry) {
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

    private fun syncDeletedTotpToDesktop(entry: TotpEntry) {
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
    private fun handleImageFromGallery(uri: Uri) {
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
    private fun parseTotpUri(uri: String) {
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
    private fun handleGoogleMigration(uri: String) {
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
    private fun showBatchImportDialog(accounts: List<MigrationOtpAccount>) {
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
    private fun batchImportAccounts(accounts: List<MigrationOtpAccount>) {
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
    private fun saveTotpSecretWithDetails(
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

    private fun loadTotpEntries(): List<TotpEntry> {
        return TotpStore.loadAll(this)
    }

    private fun startServiceForAction(action: String, configure: Intent.() -> Unit = {}) {
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

    private fun broadcastTopologyChange(reason: String) {
        startServiceForAction(WebSocketService.ACTION_BROADCAST_TOPOLOGY) {
            putExtra(WebSocketService.EXTRA_TOPOLOGY_REASON, reason)
        }
    }

    private fun startTotpUpdates() {
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
    private fun rebuildTotpList() {
        val entries = loadTotpEntries()
        val container = binding.totpList
        container.removeAllViews()

        if (entries.isEmpty()) {
            container.addView(
                TextView(this).apply {
                    text = getString(R.string.totp_empty)
                    setTextColor(ContextCompat.getColor(this@MainActivity, R.color.text_tertiary))
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
    private fun confirmDeleteTotp(entry: TotpEntry) {
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
    private fun updateTotpCountdowns() {
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

    private fun copyToClipboard(text: String) {
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

    private fun getLastSyncAt(): Long {
        return DeviceStore.getDevices(this).maxOfOrNull { it.lastSyncAt } ?: 0L
    }

    private fun formatRelativeSyncTime(timestamp: Long): String {
        if (timestamp <= 0L) return getString(R.string.last_sync_never)
        val delta = System.currentTimeMillis() - timestamp
        return when {
            delta < 60_000L -> "刚刚"
            delta < 3_600_000L -> "${delta / 60_000L} 分钟前"
            delta < 24 * 3_600_000L -> "${delta / 3_600_000L} 小时前"
            else -> SimpleDateFormat("MM-dd HH:mm", Locale.getDefault()).format(Date(timestamp))
        }
    }

    private fun formatFullSyncTime(timestamp: Long): String {
        if (timestamp <= 0L) return getString(R.string.last_sync_never)
        return SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.getDefault()).format(Date(timestamp))
    }

    private fun formatFileSize(size: Long): String {
        if (size <= 0L) return "0 B"
        val units = arrayOf("B", "KB", "MB", "GB")
        var value = size.toDouble()
        var index = 0
        while (value >= 1024.0 && index < units.lastIndex) {
            value /= 1024.0
            index += 1
        }
        return if (index == 0) "$size ${units[index]}" else String.format(Locale.US, "%.1f %s", value, units[index])
    }

    private fun getLastSyncStatusText(): String {
        val lastSyncAt = getLastSyncAt()
        return if (lastSyncAt > 0L) {
            getString(R.string.status_last_sync, formatRelativeSyncTime(lastSyncAt))
        } else {
            getString(R.string.status_waiting_first_sync)
        }
    }

    private fun refreshConnectionSnapshot() {
        val forwarding = SettingsStore.isForwardingEnabled(this)
        val detail = if (WebSocketService.isRunning) {
            WebSocketService.lastStatusMessage
        } else if (forwarding) {
            getLastSyncStatusText()
        } else {
            getString(R.string.forwarding_off)
        }
        updateConnectionUI(
            connected = WebSocketService.isConnected,
            connectedCount = WebSocketService.connectedCount,
            detail = detail
        )
    }

    fun updateConnectionUI(connected: Boolean, connectedCount: Int = 0, detail: String? = null) {
        runOnUiThread {
            val online = connected && connectedCount > 0
            binding.tvConnectionStatus.text =
                if (online) "投递中 ($connectedCount)"
                else getLastSyncStatusText()
            val color = ContextCompat.getColor(
                this,
                if (online) R.color.status_online else R.color.text_secondary
            )
            binding.tvConnectionStatus.setTextColor(color)
            binding.statusDot.backgroundTintList = ColorStateList.valueOf(color)
            rebuildTopologyList()

            val detailText = detail?.takeIf { it.isNotBlank() }
            binding.tvConnectionDetail.text = detailText.orEmpty()
            binding.tvConnectionDetail.visibility = if (detailText == null) View.GONE else View.VISIBLE
        }
    }

    override fun onDestroy() {
        totpUpdateJob?.cancel()
        runCatching { unregisterReceiver(downloadCompleteReceiver) }
        runCatching { unregisterReceiver(lanJoinReceiver) }
        runCatching { unregisterReceiver(fileTransferReceiver) }
        super.onDestroy()
    }
}
