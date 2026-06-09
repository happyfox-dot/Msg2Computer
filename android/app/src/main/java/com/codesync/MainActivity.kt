package com.codesync

import android.Manifest
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
import android.provider.Settings
import android.view.LayoutInflater
import android.view.View
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import com.codesync.databinding.ActivityMainBinding
import com.codesync.service.WebSocketService
import com.codesync.util.DesktopDevice
import com.codesync.util.DeviceStore
import com.codesync.util.GoogleAuthMigrationParser
import com.codesync.util.MigrationOtpAccount
import com.codesync.util.SettingsStore
import com.codesync.util.TotpEntry
import com.codesync.util.TotpStore
import com.codesync.util.TotpUtil
import com.google.android.material.materialswitch.MaterialSwitch
import com.google.zxing.BinaryBitmap
import com.google.zxing.DecodeHintType
import com.google.zxing.MultiFormatReader
import com.google.zxing.RGBLuminanceSource
import com.google.zxing.common.HybridBinarizer
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

class MainActivity : AppCompatActivity() {
    private lateinit var binding: ActivityMainBinding
    private var totpUpdateJob: Job? = null
    private var updatingForwardSwitch = false

    // 相册图片选择器
    private val pickImageLauncher = registerForActivityResult(ActivityResultContracts.GetContent()) { uri: Uri? ->
        uri?.let { handleImageFromGallery(it) }
    }

    private val connectionReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            if (intent?.action != WebSocketService.CONNECTION_STATE_ACTION) return
            updateConnectionUI(
                connected = intent.getBooleanExtra("connected", false),
                connectedCount = intent.getIntExtra("connected_count", 0),
                detail = intent.getStringExtra("status_message")
            )
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
        // 按需模型：启动时不再建立常驻连接，仅展示当前空闲状态
        refreshConnectionSnapshot()
        startTotpUpdates()
    }

    override fun onResume() {
        super.onResume()
        refreshDeviceList()
        syncForwardSwitch()
        refreshConnectionSnapshot()
    }

    override fun onStart() {
        super.onStart()
        val filter = IntentFilter(WebSocketService.CONNECTION_STATE_ACTION)
        ContextCompat.registerReceiver(
            this,
            connectionReceiver,
            filter,
            ContextCompat.RECEIVER_NOT_EXPORTED
        )
        refreshConnectionSnapshot()
    }

    override fun onStop() {
        runCatching { unregisterReceiver(connectionReceiver) }
        super.onStop()
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
        // 读取相册权限（Android 13+ 使用 READ_MEDIA_IMAGES）
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.READ_MEDIA_IMAGES)
                != PackageManager.PERMISSION_GRANTED
            ) {
                permissions.add(Manifest.permission.READ_MEDIA_IMAGES)
            }
        } else {
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.READ_EXTERNAL_STORAGE)
                != PackageManager.PERMISSION_GRANTED
            ) {
                permissions.add(Manifest.permission.READ_EXTERNAL_STORAGE)
            }
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

        AlertDialog.Builder(this)
            .setTitle(R.string.battery_title)
            .setMessage(R.string.battery_message)
            .setPositiveButton(R.string.battery_go) { _, _ ->
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
            .setNegativeButton(R.string.cancel, null)
            .show()
    }

    private fun setupUI() {
        binding.btnScanQR.setOnClickListener {
            startActivity(Intent(this, QRScannerActivity::class.java))
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

        syncForwardSwitch()
        binding.switchAutoSync.setOnCheckedChangeListener { _, isChecked ->
            if (updatingForwardSwitch) return@setOnCheckedChangeListener
            SettingsStore.setForwardingEnabled(this, isChecked)
            val msg = if (isChecked) R.string.forwarding_on else R.string.forwarding_off
            Toast.makeText(this, msg, Toast.LENGTH_SHORT).show()
            refreshConnectionSnapshot()
        }
    }

    /** 把开关状态同步为「短信自动转发」偏好，而非常驻连接开关。 */
    private fun syncForwardSwitch() {
        updatingForwardSwitch = true
        binding.switchAutoSync.isChecked = SettingsStore.isForwardingEnabled(this)
        updatingForwardSwitch = false
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
            return
        }

        val inflater = LayoutInflater.from(this)
        devices.forEach { device ->
            binding.deviceList.addView(createDeviceRow(inflater, device))
        }
    }

    private fun createDeviceRow(inflater: LayoutInflater, device: DesktopDevice): View {
        val row = inflater.inflate(R.layout.item_device, binding.deviceList, false)
        val dot = row.findViewById<View>(R.id.deviceDot)
        val name = row.findViewById<TextView>(R.id.deviceName)
        val address = row.findViewById<TextView>(R.id.deviceAddress)
        val switch = row.findViewById<MaterialSwitch>(R.id.deviceSwitch)

        name.text = device.name
        address.text = getString(R.string.device_address, device.host, device.port)
        tintDot(dot, device.enabled)

        switch.setOnCheckedChangeListener(null)
        switch.isChecked = device.enabled
        switch.setOnCheckedChangeListener { _, checked ->
            DeviceStore.setDeviceEnabled(this, device.id, checked)
            tintDot(dot, checked)
            if (checked) {
                // 启用时做一次配对登记连接，让电脑端立即看到这台手机在线
                startServiceForAction(WebSocketService.ACTION_CONNECT) {
                    putExtra(WebSocketService.EXTRA_DEVICE_ID, device.id)
                }
            }
        }

        row.setOnLongClickListener {
            confirmRemoveDevice(device)
            true
        }
        return row
    }

    private fun tintDot(dot: View, online: Boolean) {
        val color = ContextCompat.getColor(
            this,
            if (online) R.color.status_online else R.color.status_offline
        )
        dot.backgroundTintList = ColorStateList.valueOf(color)
    }

    private fun confirmRemoveDevice(device: DesktopDevice) {
        AlertDialog.Builder(this)
            .setTitle(R.string.remove_device_title)
            .setMessage(getString(R.string.remove_device_message, device.name))
            .setPositiveButton(R.string.remove) { _, _ ->
                DeviceStore.removeDevice(this, device.id)
                refreshDeviceList()
            }
            .setNegativeButton(R.string.cancel, null)
            .show()
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
        }.toTypedArray()
        val selected = BooleanArray(devices.size) { devices[it].enabled }

        AlertDialog.Builder(this)
            .setTitle(R.string.select_disconnect_title)
            .setMultiChoiceItems(items, selected) { _, index, checked ->
                selected[index] = checked
            }
            .setPositiveButton(R.string.disconnect_selected) { _, _ ->
                disableDevices(devices.filterIndexed { index, _ -> selected[index] })
            }
            .setNeutralButton(R.string.disconnect_all) { _, _ ->
                disableDevices(devices)
            }
            .setNegativeButton(R.string.cancel, null)
            .show()
    }

    /** 按需模型下「断开」即关闭该电脑的推送目标（停止向其转发）。 */
    private fun disableDevices(devices: List<DesktopDevice>) {
        if (devices.isEmpty()) {
            Toast.makeText(this, R.string.select_device_to_disconnect, Toast.LENGTH_SHORT).show()
            return
        }

        devices.forEach { DeviceStore.setDeviceEnabled(this, it.id, false) }
        refreshDeviceList()
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
        }.toTypedArray()
        val selected = BooleanArray(devices.size) { false }

        AlertDialog.Builder(this)
            .setTitle(R.string.revoke_totp_access_title)
            .setMessage(R.string.revoke_totp_access_message)
            .setMultiChoiceItems(items, selected) { _, index, checked ->
                selected[index] = checked
            }
            .setPositiveButton(R.string.revoke_totp_access_selected) { _, _ ->
                revokeTotpAccess(devices.filterIndexed { index, _ -> selected[index] })
            }
            .setNegativeButton(R.string.cancel, null)
            .show()
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
        val items = arrayOf(
            getString(R.string.add_totp_scan),      // 📷 扫描二维码
            getString(R.string.add_totp_from_image), // 🖼️ 从相册导入
            getString(R.string.add_totp_manual)     // ⌨️ 手动输入密钥
        )

        AlertDialog.Builder(this)
            .setTitle(R.string.add_totp)
            .setItems(items) { _, which ->
                when (which) {
                    0 -> {
                        // 扫描二维码
                        val intent = Intent(this, QRScannerActivity::class.java).apply {
                            putExtra(QRScannerActivity.EXTRA_SCAN_TOTP_ONLY, true)
                        }
                        startActivity(intent)
                    }
                    1 -> {
                        // 从相册导入
                        pickImageLauncher.launch("image/*")
                    }
                    2 -> showManualTotpInputDialog()
                }
            }
            .setNegativeButton(R.string.cancel, null)
            .show()
    }

    private fun showManualTotpInputDialog() {
        val secretInput = com.google.android.material.textfield.TextInputEditText(this).apply {
            hint = getString(R.string.totp_secret_hint)
            inputType = android.text.InputType.TYPE_CLASS_TEXT or
                        android.text.InputType.TYPE_TEXT_FLAG_CAP_CHARACTERS or
                        android.text.InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS
        }
        val labelInput = com.google.android.material.textfield.TextInputEditText(this).apply {
            hint = getString(R.string.totp_label_hint)
            inputType = android.text.InputType.TYPE_CLASS_TEXT or
                        android.text.InputType.TYPE_TEXT_FLAG_CAP_SENTENCES
        }

        val layout = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(40, 20, 40, 10)
            addView(labelInput.apply {
                layoutParams = LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.MATCH_PARENT,
                    LinearLayout.LayoutParams.WRAP_CONTENT
                ).apply { bottomMargin = 16 }
            })
            addView(secretInput.apply {
                layoutParams = LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.MATCH_PARENT,
                    LinearLayout.LayoutParams.WRAP_CONTENT
                )
            })
        }

        AlertDialog.Builder(this)
            .setTitle(R.string.add_totp_manual)
            .setView(layout)
            .setPositiveButton(R.string.save) { _, _ ->
                val secret = secretInput.text?.toString()
                    ?.trim()
                    ?.uppercase()
                    ?.replace(" ", "")
                    ?.replace("-", "") ?: ""
                val label = labelInput.text?.toString()?.trim()?.takeIf { it.isNotEmpty() } ?: "TOTP"

                if (secret.isEmpty()) {
                    Toast.makeText(this, R.string.totp_secret_required, Toast.LENGTH_SHORT).show()
                    return@setPositiveButton
                }

                if (!TotpUtil.validateSecret(secret)) {
                    Toast.makeText(this, R.string.totp_secret_invalid, Toast.LENGTH_LONG).show()
                    return@setPositiveButton
                }

                saveTotpSecret(label, secret)
            }
            .setNegativeButton(R.string.cancel, null)
            .show()
    }

    private fun saveTotpSecret(label: String, secret: String) {
        val entry = TotpEntry(
            label = label,
            secret = secret,
            algorithm = "SHA1",
            digits = 6,
            period = 30
        )
        TotpStore.add(this, entry)
        Toast.makeText(this, getString(R.string.totp_saved, label), Toast.LENGTH_SHORT).show()
        rebuildTotpList()
        // 添加时推送一次到电脑端登记（按需模型：不再每周期反复推送）
        syncTotpToDesktop(entry)
    }

    private fun syncTotpToDesktop(entry: TotpEntry) {
        if (DeviceStore.getEnabledDevices(this).isEmpty()) return
        startServiceForAction(WebSocketService.ACTION_SEND_TOTP_SEED) {
            putExtra(WebSocketService.EXTRA_TOTP_LABEL, entry.label)
            putExtra(WebSocketService.EXTRA_TOTP_SECRET, entry.secret)
            putExtra(WebSocketService.EXTRA_TOTP_ALGORITHM, entry.algorithm)
            putExtra(WebSocketService.EXTRA_TOTP_DIGITS, entry.digits)
            putExtra(WebSocketService.EXTRA_TOTP_PERIOD, entry.period)
        }
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

                // 判断是否是 TOTP 二维码
                if (qrContent.startsWith("otpauth://totp", ignoreCase = true)) {
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
        val accountNames: Array<String> = accounts.map { account ->
            val label = account.getDisplayLabel()
            val details = "${account.getAlgorithmString()}, ${account.getDigitsInt()} 位"
            "$label\n  $details"
        }.toTypedArray()

        val selected = BooleanArray(accounts.size) { true } // 默认全选

        AlertDialog.Builder(this)
            .setTitle(getString(R.string.google_migration_found, accounts.size))
            .setMultiChoiceItems(accountNames, selected) { _: android.content.DialogInterface, which: Int, isChecked: Boolean ->
                selected[which] = isChecked
            }
            .setPositiveButton(R.string.import_selected) { _: android.content.DialogInterface, _: Int ->
                val selectedAccounts = accounts.filterIndexed { index: Int, _: MigrationOtpAccount -> selected[index] }
                if (selectedAccounts.isEmpty()) {
                    Toast.makeText(this, R.string.no_account_selected, Toast.LENGTH_SHORT).show()
                    return@setPositiveButton
                }
                batchImportAccounts(selectedAccounts)
            }
            .setNeutralButton(R.string.import_all) { _: android.content.DialogInterface, _: Int ->
                batchImportAccounts(accounts)
            }
            .setNegativeButton(R.string.cancel, null)
            .show()
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
        val entry = TotpEntry(
            label = label,
            secret = secret,
            issuer = issuer,
            accountName = accountName,
            algorithm = algorithm,
            digits = digits,
            period = period
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
        AlertDialog.Builder(this)
            .setTitle(R.string.delete_totp_title)
            .setMessage(getString(R.string.delete_totp_message, entry.label))
            .setPositiveButton(R.string.delete) { _, _ ->
                TotpStore.remove(this, entry.label)
                rebuildTotpList()
                Toast.makeText(this, getString(R.string.totp_deleted, entry.label), Toast.LENGTH_SHORT).show()
            }
            .setNegativeButton(R.string.cancel, null)
            .show()
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
        clipboard.setPrimaryClip(android.content.ClipData.newPlainText("code", text))
        Toast.makeText(this, "$text 已复制", Toast.LENGTH_SHORT).show()
    }

    private fun refreshConnectionSnapshot() {
        val forwarding = SettingsStore.isForwardingEnabled(this)
        val detail = if (WebSocketService.isRunning) {
            WebSocketService.lastStatusMessage
        } else if (forwarding) {
            getString(R.string.status_idle)
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
                if (online) "投递中 ($connectedCount)" else getString(R.string.status_idle)
            val color = ContextCompat.getColor(
                this,
                if (online) R.color.status_online else R.color.text_secondary
            )
            binding.tvConnectionStatus.setTextColor(color)
            binding.statusDot.backgroundTintList = ColorStateList.valueOf(color)

            val detailText = detail?.takeIf { it.isNotBlank() }
            binding.tvConnectionDetail.text = detailText.orEmpty()
            binding.tvConnectionDetail.visibility = if (detailText == null) View.GONE else View.VISIBLE
        }
    }

    override fun onDestroy() {
        totpUpdateJob?.cancel()
        super.onDestroy()
    }
}
