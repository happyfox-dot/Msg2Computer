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

fun MainActivity.createBottomSheet(title: String, message: String? = null): Pair<BottomSheetDialog, LinearLayout> {
    val dialog = BottomSheetDialog(this)
    val content = LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL
        setPadding(20.dp(), 10.dp(), 20.dp(), 18.dp())
    }
    content.addView(View(this).apply {
        setBackgroundColor(ContextCompat.getColor(this@createBottomSheet, R.color.outline))
        layoutParams = LinearLayout.LayoutParams(44.dp(), 4.dp()).apply {
            gravity = Gravity.CENTER_HORIZONTAL
            bottomMargin = 18.dp()
        }
    })
    content.addView(TextView(this).apply {
        text = title
        setTextColor(ContextCompat.getColor(this@createBottomSheet, R.color.text_primary))
        textSize = 19f
        setTypeface(typeface, android.graphics.Typeface.BOLD)
    })
    if (!message.isNullOrBlank()) {
        content.addView(TextView(this).apply {
            text = message
            setTextColor(ContextCompat.getColor(this@createBottomSheet, R.color.text_secondary))
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

fun MainActivity.addSheetButton(
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
            setTextColor(ContextCompat.getColor(this@addSheetButton, R.color.danger))
        }
        if (outlined) {
            strokeColor = ColorStateList.valueOf(ContextCompat.getColor(this@addSheetButton, R.color.outline))
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

fun MainActivity.showActionSheet(title: String, actions: List<SheetAction>) {
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
                this@showActionSheet,
                if (action.destructive) R.color.danger else R.color.text_primary
            ))
            textSize = 15f
            setTypeface(typeface, android.graphics.Typeface.BOLD)
        })
        if (action.subtitle.isNotBlank()) {
            row.addView(TextView(this).apply {
                text = action.subtitle
                setTextColor(ContextCompat.getColor(this@showActionSheet, R.color.text_secondary))
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

fun MainActivity.showConfirmSheet(
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

fun MainActivity.showDetailSheet(title: String, lines: List<String>) {
    val (dialog, content) = createBottomSheet(title)
    content.addView(TextView(this).apply {
        text = lines.joinToString("\n")
        setTextColor(ContextCompat.getColor(this@showDetailSheet, R.color.text_secondary))
        textSize = 13f
        setPadding(0, 12.dp(), 0, 4.dp())
    })
    addSheetButton(content, getString(android.R.string.ok), outlined = true) {
        dialog.dismiss()
    }
    dialog.show()
}

fun MainActivity.showMultiChoiceSheet(
    title: String,
    message: String,
    items: List<String>,
    selected: BooleanArray,
    itemEnabled: BooleanArray? = null,
    positiveText: String,
    neutralText: String? = null,
    onPositive: () -> Unit,
    onNeutral: (() -> Unit)? = null
) {
    val (dialog, content) = createBottomSheet(title, message)
    items.forEachIndexed { index, item ->
        val enabled = itemEnabled?.getOrNull(index) ?: true
        val row = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setBackgroundResource(R.drawable.bg_row)
            setPadding(10.dp(), 8.dp(), 12.dp(), 8.dp())
            alpha = if (enabled) 1f else 0.48f
        }
        val checkBox = CheckBox(this).apply {
            isChecked = selected[index] && enabled
            isEnabled = enabled
            buttonTintList = ColorStateList.valueOf(ContextCompat.getColor(this@showMultiChoiceSheet, R.color.primary))
            setOnCheckedChangeListener { _, checked -> selected[index] = checked }
        }
        row.setOnClickListener {
            if (enabled) checkBox.isChecked = !checkBox.isChecked
        }
        row.addView(checkBox)
        row.addView(TextView(this).apply {
            text = item
            setTextColor(ContextCompat.getColor(
                this@showMultiChoiceSheet,
                if (enabled) R.color.text_primary else R.color.text_secondary
            ))
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

fun MainActivity.confirmRemoveDevice(device: DesktopDevice) {
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

