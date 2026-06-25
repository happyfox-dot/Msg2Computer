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

fun MainActivity.showLanDiscoveryDialog() {
    binding.btnDiscoverLan.isEnabled = false
    Toast.makeText(this, R.string.discovering_lan, Toast.LENGTH_SHORT).show()

    lifecycleScope.launch {
        try {
            val devices = withContext(Dispatchers.IO) {
                LanDiscovery.discover(this@showLanDiscoveryDialog)
            }
            if (devices.isEmpty()) {
                Toast.makeText(this@showLanDiscoveryDialog, R.string.lan_discovery_empty, Toast.LENGTH_SHORT).show()
                return@launch
            }
            discoveredLanNodes = devices
            val refreshed = refreshTrustedLanDeviceAddresses(devices)
            if (refreshed) {
                refreshDeviceList()
                broadcastTopologyChange("lan_discovery_address_refresh")
            }
            rebuildTopologyList()
            showDiscoveredLanDevices(devices)
        } catch (e: Exception) {
            val message = e.message ?: e.javaClass.simpleName
            Toast.makeText(
                this@showLanDiscoveryDialog,
                getString(R.string.lan_discovery_failed, message),
                Toast.LENGTH_LONG
            ).show()
        } finally {
            binding.btnDiscoverLan.isEnabled = true
        }
    }
}

fun MainActivity.refreshTrustedLanDeviceAddresses(devices: List<LanDiscoveredDevice>): Boolean {
    var changed = false
    devices.forEach { discovered ->
        val existing = DeviceStore.findDevice(this, discovered.id) ?: return@forEach
        if (existing.pairingKey.isBlank()) return@forEach
        val updated = DeviceStore.upsertDevice(
            context = this,
            host = discovered.host,
            port = discovered.port,
            pairingKey = existing.pairingKey,
            name = discovered.name.ifBlank { existing.name },
            deviceId = existing.id,
            deviceType = discovered.type.ifBlank { existing.type },
            networkId = existing.networkId,
            autoPaired = existing.autoPaired,
            trustSourceId = existing.trustSourceId,
            trustLevel = existing.trustLevel,
            acceptedAt = existing.acceptedAt,
            capabilities = discovered.capabilities.ifBlank { existing.capabilities }
        )
        if (updated.host != existing.host ||
            updated.port != existing.port ||
            updated.altHosts != existing.altHosts ||
            updated.capabilities != existing.capabilities
        ) {
            TopologyStore.markDeviceState(this, updated, enabled = updated.enabled)
            changed = true
        }
    }
    return changed
}

fun MainActivity.showDiscoveredLanDevices(devices: List<LanDiscoveredDevice>) {
    showActionSheet(
        title = getString(R.string.lan_discovery_title),
        actions = devices.map { device ->
            val existing = DeviceStore.findDevice(this, device.id)
            val isTrusted = existing != null && existing.pairingKey.isNotBlank() && existing.enabled
            val canPairNode = !isTrusted && (device.pairingKey.isNotBlank() || device.joinPublicKey.isNotBlank())
            val stateText = when {
                isTrusted -> "已信任"
                device.joinPublicKey.isNotBlank() -> "可请求加入可信网络"
                device.pairingKey.isNotBlank() -> "可加入推送目标"
                else -> "未确认节点"
            }
            SheetAction(
                title = "${deviceIcon(device.type)} ${device.name}",
                subtitle = "${device.host}:${device.joinPort} · ${device.type} · $stateText"
            ) {
                if (canPairNode) {
                    pairDiscoveredLanDevice(device)
                } else {
                    showDetailSheet(
                        title = device.name,
                        lines = listOf(
                            "类型：${device.type}",
                            "地址：${device.host}:${device.joinPort}",
                            "状态：$stateText",
                            "指纹：${device.joinFingerprint.ifBlank { "未提供" }}",
                            if (isTrusted) "说明：该节点已在本机可信设备列表中" else "说明：该节点未提供入网公钥，暂不能请求加入"
                        )
                    )
                }
            }
        }
    )
}

fun MainActivity.showLanJoinRequest(requestId: String) {
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

fun MainActivity.showFileTransferRequest(requestId: String) {
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

fun MainActivity.pairDiscoveredLanDevice(device: LanDiscoveredDevice) {
    val existing = DeviceStore.findDevice(this, device.id)
    if (existing != null && existing.pairingKey.isNotBlank() && existing.enabled) {
        val refreshed = refreshTrustedLanDeviceAddresses(listOf(device))
        refreshDeviceList()
        rebuildTopologyList()
        refreshConnectionSnapshot()
        if (refreshed) broadcastTopologyChange("lan_discovery_address_refresh")
        startServiceForAction(WebSocketService.ACTION_CONNECT) {
            putExtra(WebSocketService.EXTRA_DEVICE_ID, existing.id)
        }
        Toast.makeText(this, "${existing.name} 已是可信节点，已刷新地址并测试连接", Toast.LENGTH_SHORT).show()
        return
    }
    if (device.pairingKey.isBlank() && device.joinPublicKey.isNotBlank()) {
        lifecycleScope.launch {
            try {
                val result = withContext(Dispatchers.IO) {
                    LanJoinClient.requestJoin(this@pairDiscoveredLanDevice, device, "basic")
                }
                if (result.success && result.device != null) {
                    refreshDeviceList()
                    rebuildTopologyList()
                    startServiceForAction(WebSocketService.ACTION_CONNECT) {
                        putExtra(WebSocketService.EXTRA_DEVICE_ID, result.device.id)
                    }
                    broadcastTopologyChange("lan_join_accepted")
                    Toast.makeText(
                        this@pairDiscoveredLanDevice,
                        getString(R.string.lan_device_paired, result.device.name),
                        Toast.LENGTH_SHORT
                    ).show()
                    refreshConnectionSnapshot()
                } else {
                    Toast.makeText(
                        this@pairDiscoveredLanDevice,
                        if (result.rejected) "入网请求被拒绝" else "入网失败：${result.error}",
                        Toast.LENGTH_LONG
                    ).show()
                }
            } catch (e: Exception) {
                Toast.makeText(
                    this@pairDiscoveredLanDevice,
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

fun MainActivity.showDisconnectTargetsDialog() {
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
fun MainActivity.disableDevices(devices: List<DesktopDevice>) {
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

fun MainActivity.showRevokeTotpAccessDialog() {
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

fun MainActivity.revokeTotpAccess(devices: List<DesktopDevice>) {
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

