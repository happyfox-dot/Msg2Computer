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
import com.codesync.util.TopologyViewModel
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
    internal lateinit var binding: ActivityMainBinding
    internal var totpUpdateJob: Job? = null
    private var notificationRebindJob: Job? = null
    private var updatingForwardSwitch = false
    private var updatingMessagePolicySwitches = false
    internal var discoveredLanNodes: List<LanDiscoveredDevice> = emptyList()
    internal val shownFileTransferRequests = mutableSetOf<String>()
    internal var pendingFileTransferTargetIds: List<String> = emptyList()
    private var lastAutoClipboardHash = ""
    private var lastAutoClipboardAt = 0L

    // 应用内更新：DownloadManager 的下载 id 与待安装的版本号；下载完成由系统广播触发安装
    private var pendingUpdateDownloadId: Long = -1L
    private var pendingUpdateVersionName: String = ""
    // 安装失败兜底用的 release 页面地址（下载完成时一并记下，便于失败时跳浏览器手动下载）
    private var pendingUpdatePageUrl: String = ""
    // 等待「安装未知应用」授权后继续下载的更新信息（去设置页授权 → onResume 续流程）
    private var pendingUpdateInfo: ApkUpdater.UpdateInfo? = null
    private var topologyDirty = true
    private var topologyModel: TopologyViewModel.Model? = null



    private enum class MainPage {
        HOME,
        MESSAGES,
        CLIPBOARD,
        DEVICES,
        TOPOLOGY,
        TOTP
    }

    private var currentMainPage = MainPage.HOME

    // 相册图片选择器
    internal val pickImageLauncher = registerForActivityResult(ActivityResultContracts.GetContent()) { uri: Uri? ->
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
                    refreshDeviceList()
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
            when (intent?.action) {
                FileTransferCoordinator.ACTION_FILE_TRANSFER_REQUEST -> {
                    val requestId = intent.getStringExtra(FileTransferCoordinator.EXTRA_REQUEST_ID).orEmpty()
                    if (requestId.isNotBlank()) showFileTransferRequest(requestId)
                }
                FileTransferStateStore.ACTION_FILE_TRANSFER_STATE_CHANGED -> {
                    renderClipboardHistory()
                    refreshConnectionSnapshot()
                }
            }
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
        refreshNotificationAccessStatus()
        ensureNotificationRelayBound()

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
            IntentFilter().apply {
                addAction(FileTransferCoordinator.ACTION_FILE_TRANSFER_REQUEST)
                addAction(FileTransferStateStore.ACTION_FILE_TRANSFER_STATE_CHANGED)
            },
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
        renderClipboardHistory()
        syncForwardSwitch()
        syncMessagePolicySwitches()
        refreshConnectionSnapshot()
        refreshNotificationAccessStatus()
        ensureNotificationRelayBound()

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
        val clipboard = getSystemService(Context.CLIPBOARD_SERVICE) as android.content.ClipboardManager
        val clip = clipboard.primaryClip?.takeIf { it.itemCount > 0 } ?: return
        val uriItems = clipboardUriItems(clip)
        if (uriItems.isNotEmpty()) {
            // A URI clip written by our receiver is already represented by the stored LWW
            // version. Re-uploading it on focus would manufacture a new file-batch version and
            // cause a clipboard echo between nodes.
            if (clip.description.label?.toString()?.startsWith("codebridge_clipboard_") == true) return
            val fingerprint = ClipboardSyncState.hash(
                uriItems.joinToString("|") { it.toString() }
            )
            val now = System.currentTimeMillis()
            if (fingerprint == lastAutoClipboardHash && now - lastAutoClipboardAt < 5_000L) return
            lastAutoClipboardHash = fingerprint
            lastAutoClipboardAt = now
            if (uriItems.size == 1 && isClipboardImageUri(clip, uriItems.first())) {
                sendClipboardImage(uriItems.first())
            } else {
                sendClipboardFiles(uriItems)
            }
            return
        }
        if (RouteManager.targetsForType(
                context = this,
                type = "clipboard_text",
                reachableOnly = WebSocketService.requiresLiveDeliveryTarget("clipboard_text")
            ).isEmpty()
        ) return
        // URI clips are handled above. Do not coerce content:// into text, and preserve leading
        // and trailing whitespace in real text clips.
        val text = clip.getItemAt(0).coerceToText(this)?.toString().orEmpty()
        if (text.isBlank()) return
        val hash = ClipboardSyncState.hash(text)
        if (hash == ClipboardSyncState.appliedHash(this)) return
        val now = System.currentTimeMillis()
        if (hash == lastAutoClipboardHash && now - lastAutoClipboardAt < 5_000L) return
        lastAutoClipboardHash = hash
        lastAutoClipboardAt = now
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

    internal fun startNodeReceiverService() {
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
        setupPageNavigation()

        binding.btnScanQR.setOnClickListener {
            startActivity(Intent(this, QRScannerActivity::class.java))
        }

        binding.btnDiscoverLan.setOnClickListener {
            showLanDiscoveryDialog()
        }

        binding.btnTestPush.setOnClickListener {
            showTestPushDialog()
        }

        binding.topologyContent.btnRefreshTopology.setOnClickListener {
            refreshDeviceList()
            rebuildTopologyList(force = true)
            refreshConnectionSnapshot()
        }
        binding.topologyContent.topologyGraph.setOnNodeClickListener { nodeId ->
            showTopologyNodeDetail(nodeId)
        }

        binding.btnAddTotp.setOnClickListener {
            showAddTotpDialog()
        }

        binding.btnTotpAccess.setOnClickListener {
            showRevokeTotpAccessDialog()
        }

        binding.btnTotpFullSync.setOnClickListener {
            requestFullTotpSync()
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
        binding.btnHomeSyncClipboard.setOnClickListener {
            showMainPage(MainPage.CLIPBOARD)
            sendCurrentClipboard()
        }
        binding.btnRefreshClipboardHistory.setOnClickListener {
            renderClipboardHistory()
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
        renderClipboardHistory()
    }

    private fun setupPageNavigation() {
        binding.btnPageHome.setOnClickListener { showMainPage(MainPage.HOME) }
        binding.btnPageMessages.setOnClickListener { showMainPage(MainPage.MESSAGES) }
        binding.btnPageClipboard.setOnClickListener { showMainPage(MainPage.CLIPBOARD) }
        binding.btnPageDevices.setOnClickListener { showMainPage(MainPage.DEVICES) }
        binding.btnPageTopology.setOnClickListener { showMainPage(MainPage.TOPOLOGY) }
        binding.btnPageTotp.setOnClickListener { showMainPage(MainPage.TOTP) }
        showMainPage(MainPage.HOME)
    }

    private fun showMainPage(page: MainPage) {
        currentMainPage = page
        val pages = listOf(
            MainPage.HOME to binding.pageHome,
            MainPage.MESSAGES to binding.pageMessages,
            MainPage.CLIPBOARD to binding.pageClipboard,
            MainPage.DEVICES to binding.pageDevices,
            MainPage.TOPOLOGY to binding.pageTopology,
            MainPage.TOTP to binding.pageTotp
        )
        pages.forEach { (itemPage, view) ->
            view.visibility = if (itemPage == page) View.VISIBLE else View.GONE
        }
        val buttons = listOf(
            MainPage.HOME to binding.btnPageHome,
            MainPage.MESSAGES to binding.btnPageMessages,
            MainPage.CLIPBOARD to binding.btnPageClipboard,
            MainPage.DEVICES to binding.btnPageDevices,
            MainPage.TOPOLOGY to binding.btnPageTopology,
            MainPage.TOTP to binding.btnPageTotp
        )
        val activeBg = ContextCompat.getColor(this, R.color.primary_container)
        val idleBg = ContextCompat.getColor(this, R.color.bg_surface_variant)
        val activeText = ContextCompat.getColor(this, R.color.text_primary)
        val idleText = ContextCompat.getColor(this, R.color.text_secondary)
        buttons.forEach { (itemPage, button) ->
            val active = itemPage == page
            button.backgroundTintList = ColorStateList.valueOf(if (active) activeBg else idleBg)
            button.setTextColor(if (active) activeText else idleText)
            button.strokeWidth = if (active) 1.dp() else 0
        }
        when (page) {
            MainPage.CLIPBOARD -> renderClipboardHistory()
            MainPage.DEVICES -> refreshDeviceList()
            MainPage.TOPOLOGY -> if (topologyDirty || topologyModel == null) rebuildTopologyList(force = true)
            MainPage.TOTP -> rebuildTotpList()
            else -> Unit
        }
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
            if (isChecked) {
                val component = notificationRelayComponent()
                if (!isNotificationListenerEnabled(component)) {
                    Toast.makeText(this, R.string.notification_access_enable_prompt, Toast.LENGTH_LONG).show()
                    startActivity(Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS))
                } else {
                    ensureNotificationRelayBound()
                }
            }
            refreshNotificationAccessStatus()
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
            SettingsStore.setSendNotificationsEnabled(this, true)
            syncMessagePolicySwitches()
            refreshNotificationAccessStatus()
            Toast.makeText(this, R.string.notification_access_enable_prompt, Toast.LENGTH_LONG).show()
            startActivity(Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS))
        }
        binding.btnNotificationAppPolicy.setOnClickListener {
            showNotificationAppPolicySheet()
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
        binding.btnSetFileReceiveDir.setOnClickListener {
            showFileReceiveDirEditor()
        }
        binding.btnResetFileReceiveDir.setOnClickListener {
            SettingsStore.setFileReceiveSubdir(this, "")
            refreshFileReceiveDirLabel()
            Toast.makeText(this, R.string.file_receive_dir_saved, Toast.LENGTH_SHORT).show()
        }
        refreshFileReceiveDirLabel()
    }

    /** 读取当前剪贴板内容并投递到启用的设备节点（仅前台可读，符合系统限制）。 */
    private fun refreshFileReceiveDirLabel() {
        val defaultDir = "CodeBridge"
        val subdir = SettingsStore.getFileReceiveSubdir(this)
        val displaySubdir = subdir.ifBlank { defaultDir }
        val root = getExternalFilesDir(android.os.Environment.DIRECTORY_DOWNLOADS) ?: filesDir
        binding.txtFileReceiveDir.text = File(root, displaySubdir).absolutePath
    }

    private fun showFileReceiveDirEditor() {
        val (dialog, content) = createBottomSheet(getString(R.string.file_receive_dir_title))
        val input = TextInputEditText(this).apply {
            setText(SettingsStore.getFileReceiveSubdir(this@MainActivity))
            hint = getString(R.string.file_receive_dir_hint)
            inputType = InputType.TYPE_CLASS_TEXT
            setSingleLine(true)
        }
        val layout = TextInputLayout(this).apply {
            hint = getString(R.string.file_receive_dir_hint)
            addView(input)
        }
        content.addView(layout)
        addSheetButton(content, getString(R.string.save)) {
            SettingsStore.setFileReceiveSubdir(this, input.text?.toString().orEmpty())
            refreshFileReceiveDirLabel()
            Toast.makeText(this, R.string.file_receive_dir_saved, Toast.LENGTH_SHORT).show()
            dialog.dismiss()
        }
        addSheetButton(content, getString(R.string.cancel), outlined = true) {
            dialog.dismiss()
        }
        dialog.show()
    }

    private fun sendCurrentClipboard() {
        if (!SettingsStore.isSyncClipboardEnabled(this)) {
            Toast.makeText(this, R.string.clipboard_sync_disabled, Toast.LENGTH_SHORT).show()
            return
        }
        val clipboard = getSystemService(Context.CLIPBOARD_SERVICE) as android.content.ClipboardManager
        val clip = clipboard.primaryClip?.takeIf { it.itemCount > 0 }
        if (clip == null) {
            Toast.makeText(this, R.string.clipboard_empty, Toast.LENGTH_SHORT).show()
            return
        }
        val uriItems = clipboardUriItems(clip)
        if (uriItems.isNotEmpty()) {
            if (uriItems.size == 1 && isClipboardImageUri(clip, uriItems.first())) {
                sendClipboardImage(uriItems.first())
            } else {
                sendClipboardFiles(uriItems)
            }
            return
        }
        if (RouteManager.targetsForType(
                context = this,
                type = "clipboard_text",
                reachableOnly = WebSocketService.requiresLiveDeliveryTarget("clipboard_text")
            ).isEmpty()
        ) {
            Toast.makeText(this, R.string.clipboard_no_target, Toast.LENGTH_SHORT).show()
            return
        }
        val text = clip.getItemAt(0).coerceToText(this)?.toString().orEmpty()
        if (text.isBlank()) {
            Toast.makeText(this, R.string.clipboard_empty, Toast.LENGTH_SHORT).show()
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
        startServiceForAction(WebSocketService.ACTION_SEND_CLIPBOARD) {
            putExtra(WebSocketService.EXTRA_MESSAGE_BODY, text)
        }
        Toast.makeText(this, R.string.clipboard_sent, Toast.LENGTH_SHORT).show()
        renderClipboardHistory()
        refreshConnectionSnapshot()
    }

    private fun sendClipboardImage(uri: Uri) {
        if (!SettingsStore.isSyncClipboardImageEnabled(this)) {
            Toast.makeText(this, "图片剪贴板同步未开启", Toast.LENGTH_SHORT).show()
            return
        }
        if (RouteManager.targetsForType(
                context = this,
                type = "clipboard_image",
                reachableOnly = WebSocketService.requiresLiveDeliveryTarget("clipboard_image")
            ).isEmpty()
        ) {
            Toast.makeText(this, "没有启用图片剪贴板的推送目标", Toast.LENGTH_SHORT).show()
            return
        }
        val appliedTs = ClipboardSyncState.appliedTs(this)
        val capturedAt = maxOf(
            System.currentTimeMillis(),
            if (appliedTs == Long.MAX_VALUE) Long.MAX_VALUE else appliedTs + 1L
        )
        val identity = PhoneIdentityStore.get(this)
        ClipboardSyncState.rememberHash(
            this,
            capturedAt,
            identity.id,
            ClipboardSyncState.hash("pending-image:$capturedAt:$uri"),
            "image"
        )
        lifecycleScope.launch {
            val prepared = withContext(Dispatchers.IO) {
                runCatching { prepareClipboardImageFile(uri) }
            }
            prepared.onSuccess { image ->
                val file = image.file
                PhoneIdentityStore.get(this@MainActivity).let { identity ->
                    ClipboardHistoryStore.addFile(
                        context = this@MainActivity,
                        kind = "image",
                        direction = "outgoing",
                        title = file.name,
                        path = file.absolutePath,
                        mime = image.mime,
                        size = file.length(),
                        sourceDeviceId = identity.id,
                        sourceDeviceName = identity.name
                    )
                }
                startServiceForAction(WebSocketService.ACTION_SEND_FILE) {
                    putExtra(WebSocketService.EXTRA_CONTENT_TYPE, "clipboard_image")
                    putExtra(WebSocketService.EXTRA_FILE_PATH, file.absolutePath)
                    putExtra(WebSocketService.EXTRA_FILE_NAME, file.name)
                    putExtra(WebSocketService.EXTRA_FILE_MIME, image.mime)
                    putExtra(WebSocketService.EXTRA_CLIP_VERSION_TS, capturedAt)
                }
                Toast.makeText(this@MainActivity, "图片剪贴板已发送", Toast.LENGTH_SHORT).show()
                renderClipboardHistory()
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

    private fun sendClipboardFiles(uris: List<Uri>) {
        if (!SettingsStore.isSyncClipboardFileEnabled(this)) {
            Toast.makeText(this, R.string.file_transfer_disabled, Toast.LENGTH_SHORT).show()
            return
        }
        if (RouteManager.targetsForType(
                context = this,
                type = "clipboard_file",
                reachableOnly = WebSocketService.requiresLiveDeliveryTarget("clipboard_file")
            ).isEmpty()
        ) {
            Toast.makeText(this, R.string.file_no_target, Toast.LENGTH_SHORT).show()
            return
        }
        // Capture the LWW version before asynchronous content:// copies start. Every file in the
        // clip carries this batch id, so preparation order cannot split one clipboard value into
        // multiple versions. The service parses the embedded timestamp.
        val appliedTs = ClipboardSyncState.appliedTs(this)
        val clipTs = maxOf(
            System.currentTimeMillis(),
            if (appliedTs == Long.MAX_VALUE) Long.MAX_VALUE else appliedTs + 1L
        )
        val batchId = "clip-files-$clipTs-${java.util.UUID.randomUUID()}"
        val identity = PhoneIdentityStore.get(this)
        ClipboardSyncState.rememberHash(
            this,
            clipTs,
            identity.id,
            ClipboardSyncState.hash("clipboard-file-batch:$batchId"),
            "file"
        )
        pendingFileTransferTargetIds = emptyList()
        uris.forEach { uri ->
            handleFileForTransfer(
                uri = uri,
                batchId = batchId,
                batchCount = uris.size,
                contentType = "clipboard_file"
            )
        }
        Toast.makeText(this, "文件剪贴板已开始同步", Toast.LENGTH_SHORT).show()
    }

    private fun clipboardUriItems(clip: ClipData): List<Uri> =
        (0 until clip.itemCount).mapNotNull { index -> clip.getItemAt(index).uri }

    private fun isClipboardImageUri(clip: ClipData, uri: Uri): Boolean {
        val resolverMime = runCatching { contentResolver.getType(uri).orEmpty() }.getOrDefault("")
        if (resolverMime.startsWith("image/", ignoreCase = true)) return true
        if (clip.itemCount == 1 && clip.description.hasMimeType("image/*")) return true
        return FileTransferRegistry.guessMime(uri.lastPathSegment.orEmpty())
            .startsWith("image/", ignoreCase = true)
    }

    private fun sendSelectedFile() {
        if (!SettingsStore.isSyncClipboardFileEnabled(this)) {
            Toast.makeText(this, R.string.file_transfer_disabled, Toast.LENGTH_SHORT).show()
            return
        }
        if (getFileTransferTargetOptions().isEmpty()) {
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
        if (getFileTransferTargetOptions().isEmpty()) {
            Toast.makeText(this, R.string.file_no_target, Toast.LENGTH_SHORT).show()
            return
        }
        showFileTargetSelectionSheet { targetIds ->
            pendingFileTransferTargetIds = targetIds
            pickFolderLauncher.launch(null)
        }
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

    private fun notificationRelayComponent(): ComponentName =
        ComponentName(this, NotificationRelayService::class.java)

    private fun refreshNotificationAccessStatus() {
        val listenerEnabled = isNotificationListenerEnabled(notificationRelayComponent())
        val sendEnabled = SettingsStore.isSendNotificationsEnabled(this)
        val textRes = when {
            listenerEnabled && sendEnabled -> R.string.notification_access_status_enabled_active
            listenerEnabled -> R.string.notification_access_status_enabled_inactive
            else -> R.string.notification_access_status_disabled
        }
        binding.txtNotificationAccessStatus.text = getString(textRes)
        val colorRes = when {
            listenerEnabled && sendEnabled -> R.color.status_online
            listenerEnabled -> R.color.warning
            else -> R.color.text_secondary
        }
        binding.txtNotificationAccessStatus.setTextColor(ContextCompat.getColor(this, colorRes))
    }

    private fun ensureNotificationRelayBound() {
        if (!SettingsStore.isSendNotificationsEnabled(this)) return
        val component = notificationRelayComponent()
        if (!isNotificationListenerEnabled(component)) {
            WebSocketService.reportExternalStatus(this, "App 通知监听未授权")
            return
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            notificationRebindJob?.cancel()
            notificationRebindJob = lifecycleScope.launch {
                listOf(0L, 1_500L, 5_000L).forEach { delayMs ->
                    if (delayMs > 0) delay(delayMs)
                    runCatching { NotificationListenerService.requestRebind(component) }
                }
            }
        }
    }

    private fun isNotificationListenerEnabled(component: ComponentName): Boolean {
        val enabled = Settings.Secure.getString(
            contentResolver,
            "enabled_notification_listeners"
        ).orEmpty()
        return enabled.split(':').any { value ->
            val enabledComponent = ComponentName.unflattenFromString(value) ?: return@any false
            enabledComponent.packageName == component.packageName &&
                enabledComponent.className == component.className
        }
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
        val targets = RouteManager.targetsForType(
            context = this,
            type = "sms",
            reachableOnly = WebSocketService.requiresLiveDeliveryTarget("sms")
        ).map { it.device }
        val targetCount = targets.size
        if (targetCount == 0) {
            Toast.makeText(this, getString(R.string.test_push_no_target), Toast.LENGTH_SHORT).show()
            return
        }
        val code = (100000..999999).random().toString()
        androidx.appcompat.app.AlertDialog.Builder(this)
            .setTitle(getString(R.string.test_push_title))
            .setMessage(getString(R.string.test_push_message, code, targetCount))
            .setPositiveButton(getString(R.string.test_push_confirm)) { _, _ ->
                startServiceForAction(WebSocketService.ACTION_SEND_SMS) {
                    putExtra(WebSocketService.EXTRA_CODE, code)
                    putExtra(WebSocketService.EXTRA_SOURCE, getString(R.string.test_push_source))
                    putExtra(WebSocketService.EXTRA_MESSAGE_BODY, getString(R.string.test_push_body, code))
                }
                Toast.makeText(this, getString(R.string.test_push_sent, code), Toast.LENGTH_LONG).show()
                refreshConnectionSnapshot()
            }
            .setNegativeButton(android.R.string.cancel, null)
            .show()
    }

    internal fun refreshDeviceList() {
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

    private fun tintDot(dot: View, online: Boolean) {
        val color = ContextCompat.getColor(
            this,
            if (online) R.color.status_online else R.color.status_offline
        )
        dot.backgroundTintList = ColorStateList.valueOf(color)
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
        tintDot(dot, isDeviceOnline(device))

        switch.setOnCheckedChangeListener(null)
        switch.isChecked = device.enabled
        switch.setOnCheckedChangeListener { _, checked ->
            DeviceStore.setDeviceEnabled(this, device.id, checked)
            TopologyStore.markDeviceState(this, device.copy(enabled = checked), enabled = checked)
            tintDot(dot, checked && WebSocketService.connectedDeviceIds.contains(device.id))
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
        val connectionState = getTopologyDeviceStateLabel(device)
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
            add("连接：$connectionState")
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
            if (device.allowClipboardImage) add("剪贴板图片")
            if (device.allowFileTransfer) add("文件")
        }
        return if (items.isEmpty()) getString(R.string.policy_none) else items.joinToString(" · ")
    }

    private fun isDeviceOnline(device: DesktopDevice): Boolean =
        WebSocketService.connectedDeviceIds.contains(device.id)

    private fun isReachableTopologyStatus(status: String): Boolean =
        RouteManager.isReachableStatus(status)

    private fun getTopologyDeviceStatus(device: DesktopDevice): String =
        RouteManager.statusForDevice(
            device = device,
            route = RouteManager.routeMap(this)[device.id],
            connectedDeviceIds = WebSocketService.connectedDeviceIds
        )

    private fun getTopologyDeviceStateLabel(device: DesktopDevice): String =
        RouteManager.statusLabel(getTopologyDeviceStatus(device))

    private fun isFileTransferReachable(device: DesktopDevice): Boolean =
        isReachableTopologyStatus(getTopologyDeviceStatus(device))

    internal fun getFileTransferTargetOptions(): List<FileTransferTargetOption> {
        return RouteManager.targetsForType(
            context = this,
            type = "file_transfer",
            connectedDeviceIds = WebSocketService.connectedDeviceIds,
            includeDisallowed = true,
            includeUnavailable = true,
            reachableOnly = false
        )
            .distinctBy { it.device.id }
            .map { option ->
                FileTransferTargetOption(
                    device = option.device,
                    reachable = option.reachable,
                    allowed = option.allowed,
                    statusLabel = RouteManager.statusLabel(option.status),
                    reason = option.reason
                )
            }
            .sortedWith(
                compareByDescending<FileTransferTargetOption> { it.reachable && it.allowed }
                    .thenByDescending { it.reachable }
                    .thenBy { it.device.name.lowercase(Locale.ROOT) }
            )
    }
    internal fun rebuildTopologyList(force: Boolean = false) {
        if (currentMainPage != MainPage.TOPOLOGY && !force) {
            topologyDirty = true
            return
        }
        topologyDirty = false
        val container = binding.topologyContent.topologyList
        container.removeAllViews()

        val phone = PhoneIdentityStore.get(this)
        val remoteTotps = loadTotpEntries().filter { !it.isLocal && it.sourceDeviceId.isNotBlank() }
        val model = TopologyViewModel.build(
            context = this,
            discoveredLanNodes = discoveredLanNodes,
            remoteTotps = remoteTotps,
            connectedDeviceIds = WebSocketService.connectedDeviceIds
        )
        topologyModel = model

        binding.topologyContent.topologyGraph.setGraph(
            model.nodes.map {
                TopologyGraphView.Node(
                    id = it.id,
                    name = it.name,
                    type = it.type,
                    status = it.status,
                    discoveredOnly = it.discoveredOnly,
                    local = it.local,
                    meta = it.meta
                )
            },
            model.edges.map {
                TopologyGraphView.Edge(
                    from = it.from,
                    to = it.to,
                    label = it.label,
                    active = it.active,
                    kind = it.kind,
                    metric = it.metric
                )
            }
        )

        if (model.nodes.size <= 1 && model.edges.isEmpty()) {
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

        val onlineCount = model.nodes.count { it.status == "online" }
        val reachableCount = model.nodes.count { it.status == "reachable" }
        val knownCount = model.nodes.count { it.status == "known" && !it.discoveredOnly }
        val discoveredCount = model.nodes.count { it.status == "known" && it.discoveredOnly }
        container.addView(
            createTopologyRow(
                title = "${deviceIcon("ANDROID_PHONE")} ${phone.name}",
                meta = "可信网络 · ${model.nodes.size} 个节点 · ${model.edges.size} 条链路",
                detail = listOf(
                    "networkId：${LanTrustStore.getNetworkId(this).ifBlank { "未建立" }}",
                    "在线直连：$onlineCount",
                    "近期可达：$reachableCount",
                    "已知离线：$knownCount",
                    "仅发现未授权：$discoveredCount",
                    "说明：图中实线偏向在线/活跃链路，虚线表示近期可达、历史或发现链路"
                )
            )
        )

        model.nodes.filter { !it.local }.forEach { node ->
            container.addView(
                createTopologyRow(
                    title = "${deviceIcon(node.type)} ${node.name}",
                    meta = "${TopologyViewModel.statusLabel(node.status, node.discoveredOnly)} · ${node.meta}",
                    detail = node.detailLines
                )
            )
        }

        if (model.edges.isNotEmpty()) {
            container.addView(
                createTopologyRow(
                    title = "链路状态",
                    meta = "${model.edges.count { it.active }} 条在线 / ${model.edges.count { it.routable }} 条可路由",
                    detail = model.edges.take(24).map { edge ->
                        val from = model.nodeMap[edge.from]?.name ?: edge.from
                        val to = model.nodeMap[edge.to]?.name ?: edge.to
                        val state = when {
                            edge.active -> "在线"
                            edge.routable -> "可路由"
                            edge.kind == "discovery" -> "仅发现"
                            else -> "历史/离线"
                        }
                        "$from -- $to：${edge.label} · $state${if (edge.metric > 0) " · m=${edge.metric}" else ""}"
                    }
                )
            )
        }
    }

    private fun showTopologyNodeDetail(nodeId: String) {
        val model = topologyModel ?: return
        val node = model.nodeMap[nodeId] ?: return
        val relatedEdges = model.edges
            .filter { it.from == nodeId || it.to == nodeId }
            .take(12)
            .map { edge ->
                val from = model.nodeMap[edge.from]?.name ?: edge.from
                val to = model.nodeMap[edge.to]?.name ?: edge.to
                val state = when {
                    edge.active -> "在线"
                    edge.routable -> "可路由"
                    edge.kind == "discovery" -> "仅发现"
                    else -> "历史/离线"
                }
                "$from -- $to：${edge.label} · $state${if (edge.metric > 0) " · m=${edge.metric}" else ""}"
            }
        val (dialog, content) = createBottomSheet(getString(R.string.topology_device_detail))
        content.addView(TextView(this).apply {
            text = (node.detailLines + listOf("关联链路：") + relatedEdges.ifEmpty { listOf("暂无关联链路") }).joinToString("\n")
            setTextColor(ContextCompat.getColor(this@MainActivity, R.color.text_secondary))
            textSize = 13f
            setPadding(0, 12.dp(), 0, 4.dp())
        })
        addSheetButton(content, getString(android.R.string.ok), outlined = true) {
            dialog.dismiss()
        }
        dialog.show()
    }

    internal fun deviceIcon(type: String): String {
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

    internal fun Int.dp(): Int = (this * resources.displayMetrics.density).toInt()

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

    internal fun formatFullSyncTime(timestamp: Long): String {
        if (timestamp <= 0L) return getString(R.string.last_sync_never)
        return SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.getDefault()).format(Date(timestamp))
    }

    internal fun formatFileSize(size: Long): String {
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

    internal fun refreshConnectionSnapshot() {
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
            if (currentMainPage == MainPage.TOPOLOGY) {
                rebuildTopologyList(force = true)
            } else {
                topologyDirty = true
            }

            val detailText = detail?.takeIf { it.isNotBlank() }
            binding.tvConnectionDetail.text = detailText.orEmpty()
            binding.tvConnectionDetail.visibility = if (detailText == null) View.GONE else View.VISIBLE
        }
    }

    override fun onDestroy() {
        notificationRebindJob?.cancel()
        totpUpdateJob?.cancel()
        runCatching { unregisterReceiver(downloadCompleteReceiver) }
        runCatching { unregisterReceiver(lanJoinReceiver) }
        runCatching { unregisterReceiver(fileTransferReceiver) }
        super.onDestroy()
    }
}
