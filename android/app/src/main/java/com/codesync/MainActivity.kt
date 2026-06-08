package com.codesync

import android.Manifest
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.content.res.ColorStateList
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
import com.codesync.util.SettingsStore
import com.codesync.util.TotpUtil
import com.google.android.material.materialswitch.MaterialSwitch
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

class MainActivity : AppCompatActivity() {
    private lateinit var binding: ActivityMainBinding
    private var totpUpdateJob: Job? = null
    private var updatingForwardSwitch = false

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
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.READ_SMS)
            != PackageManager.PERMISSION_GRANTED
        ) {
            permissions.add(Manifest.permission.READ_SMS)
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

    private fun showAddTotpDialog() {
        val secretInput = com.google.android.material.textfield.TextInputEditText(this).apply {
            hint = getString(R.string.totp_secret_hint)
        }
        val labelInput = com.google.android.material.textfield.TextInputEditText(this).apply {
            hint = getString(R.string.totp_label_hint)
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
            .setTitle(R.string.add_totp)
            .setView(layout)
            .setPositiveButton(R.string.save) { _, _ ->
                val secret = secretInput.text?.toString()?.trim()?.replace(" ", "") ?: ""
                val label = labelInput.text?.toString()?.trim()?.takeIf { it.isNotEmpty() } ?: "TOTP"
                if (secret.isNotEmpty()) {
                    saveTotpSecret(label, secret)
                }
            }
            .setNegativeButton(R.string.cancel, null)
            .show()
    }

    private fun saveTotpSecret(label: String, secret: String) {
        val prefs = getSharedPreferences("totp_secrets", MODE_PRIVATE)
        val existing = prefs.getStringSet("entries", emptySet())?.toMutableSet() ?: mutableSetOf()
        existing.add("$label|$secret")
        prefs.edit().putStringSet("entries", existing).apply()
        Toast.makeText(this, getString(R.string.totp_saved, label), Toast.LENGTH_SHORT).show()
        rebuildTotpList()
        // 添加时推送一次到电脑端登记（按需模型：不再每周期反复推送）
        syncTotpToDesktop(label, secret)
    }

    private fun syncTotpToDesktop(label: String, secret: String) {
        if (DeviceStore.getEnabledDevices(this).isEmpty()) return
        startServiceForAction(WebSocketService.ACTION_SEND_TOTP) {
            putExtra(WebSocketService.EXTRA_TOTP_LABEL, label)
            putExtra(WebSocketService.EXTRA_TOTP_SECRET, secret)
        }
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

    private fun loadTotpEntries(): List<Pair<String, String>> {
        val prefs = getSharedPreferences("totp_secrets", MODE_PRIVATE)
        val entries = prefs.getStringSet("entries", emptySet()) ?: emptySet()
        return entries.mapNotNull { entry ->
            val parts = entry.split("|")
            if (parts.size == 2) parts[0] to parts[1] else null
        }.sortedBy { it.first.lowercase() }
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

    /** 根据已保存的 TOTP 重建卡片列表（验证码本地生成）。 */
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
        entries.forEach { (label, secret) ->
            val row = inflater.inflate(R.layout.item_totp, container, false)
            row.findViewById<TextView>(R.id.totpLabel).text = label
            row.findViewById<TextView>(R.id.totpCode).text = TotpUtil.generate(secret)
            row.findViewById<ImageView>(R.id.totpCopy).setOnClickListener {
                copyToClipboard(TotpUtil.generate(secret))
            }
            row.setOnClickListener { copyToClipboard(TotpUtil.generate(secret)) }
            container.addView(row)
        }
        updateTotpCountdowns()
    }

    /** 每秒更新所有 TOTP 行的倒计时环和剩余秒数（本地，不耗流量）。 */
    private fun updateTotpCountdowns() {
        val remaining = TotpUtil.getRemainingSeconds()
        val container = binding.totpList
        for (i in 0 until container.childCount) {
            val child = container.getChildAt(i)
            val progress = child.findViewById<ProgressBar>(R.id.totpProgress) ?: continue
            val text = child.findViewById<TextView>(R.id.totpRemaining) ?: continue
            progress.progress = remaining
            text.text = remaining.toString()
            val color = ContextCompat.getColor(
                this,
                if (remaining <= 5) R.color.danger else R.color.accent_green
            )
            progress.progressTintList = ColorStateList.valueOf(color)
            text.setTextColor(color)
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
