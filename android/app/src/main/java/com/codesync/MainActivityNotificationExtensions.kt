package com.codesync

import android.content.Intent
import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
import android.content.res.ColorStateList
import android.os.Build
import android.view.Gravity
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.core.content.ContextCompat
import com.codesync.util.SettingsStore
import com.google.android.material.materialswitch.MaterialSwitch

private data class NotificationAppOption(
    val packageName: String,
    val label: String
)

fun MainActivity.showNotificationAppPolicySheet() {
    val (dialog, content) = createBottomSheet(
        title = getString(R.string.notification_app_policy_title),
        message = getString(R.string.notification_app_policy_desc)
    )
    val apps = loadNotificationAppOptions()
    if (apps.isEmpty()) {
        content.addView(TextView(this).apply {
            text = getString(R.string.notification_app_policy_empty)
            setTextColor(ContextCompat.getColor(this@showNotificationAppPolicySheet, R.color.text_secondary))
            textSize = 13f
            setPadding(0, 14.dp(), 0, 2.dp())
        })
    } else {
        apps.forEach { app ->
            content.addView(createNotificationAppPolicyRow(app), LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
            ).apply {
                topMargin = 10.dp()
            })
        }
    }
    addSheetButton(content, getString(android.R.string.ok), outlined = true) {
        dialog.dismiss()
    }
    dialog.show()
}

private fun MainActivity.createNotificationAppPolicyRow(app: NotificationAppOption): LinearLayout {
    val policy = SettingsStore.getNotificationAppPolicy(this, app.packageName)
    val row = LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL
        setBackgroundResource(R.drawable.bg_row)
        setPadding(14.dp(), 12.dp(), 14.dp(), 12.dp())
    }
    val top = LinearLayout(this).apply {
        orientation = LinearLayout.HORIZONTAL
        gravity = Gravity.CENTER_VERTICAL
    }
    top.addView(LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL
        addView(TextView(this@createNotificationAppPolicyRow).apply {
            text = app.label
            setTextColor(ContextCompat.getColor(this@createNotificationAppPolicyRow, R.color.text_primary))
            textSize = 14f
            setTypeface(typeface, android.graphics.Typeface.BOLD)
            maxLines = 1
        })
        addView(TextView(this@createNotificationAppPolicyRow).apply {
            text = app.packageName
            setTextColor(ContextCompat.getColor(this@createNotificationAppPolicyRow, R.color.text_secondary))
            textSize = 11f
            maxLines = 1
        })
    }, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
    row.addView(top)

    val switchRow = LinearLayout(this).apply {
        orientation = LinearLayout.HORIZONTAL
        gravity = Gravity.CENTER_VERTICAL
        setPadding(0, 8.dp(), 0, 0)
    }
    val normalSwitch = createNotificationPolicySwitch(
        text = getString(R.string.notification_policy_normal),
        checked = policy.allowNormal
    )
    val ongoingSwitch = createNotificationPolicySwitch(
        text = getString(R.string.notification_policy_ongoing),
        checked = policy.allowOngoing
    )
    normalSwitch.setOnCheckedChangeListener { _, checked ->
        val current = SettingsStore.getNotificationAppPolicy(this, app.packageName)
        SettingsStore.setNotificationAppPolicy(this, current.copy(allowNormal = checked))
        Toast.makeText(this, R.string.notification_policy_saved, Toast.LENGTH_SHORT).show()
    }
    ongoingSwitch.setOnCheckedChangeListener { _, checked ->
        val current = SettingsStore.getNotificationAppPolicy(this, app.packageName)
        SettingsStore.setNotificationAppPolicy(this, current.copy(allowOngoing = checked))
        Toast.makeText(this, R.string.notification_policy_saved, Toast.LENGTH_SHORT).show()
    }
    switchRow.addView(normalSwitch, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
    switchRow.addView(ongoingSwitch, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
    row.addView(switchRow)
    return row
}

private fun MainActivity.createNotificationPolicySwitch(text: String, checked: Boolean): MaterialSwitch {
    return MaterialSwitch(this).apply {
        this.text = text
        isChecked = checked
        setTextColor(ContextCompat.getColor(this@createNotificationPolicySwitch, R.color.text_primary))
        textSize = 12f
        buttonTintList = ColorStateList.valueOf(
            ContextCompat.getColor(this@createNotificationPolicySwitch, R.color.primary)
        )
    }
}

private fun MainActivity.loadNotificationAppOptions(): List<NotificationAppOption> {
    val packageManager = packageManager
    val launcherApps = queryLauncherApps(packageManager)
    val configuredApps = SettingsStore.getNotificationAppPolicies(this).keys.mapNotNull { packageName ->
        resolveNotificationAppOption(packageManager, packageName)
    }
    return (launcherApps + configuredApps)
        .filter { it.packageName != packageName }
        .distinctBy { it.packageName }
        .sortedWith(compareBy(String.CASE_INSENSITIVE_ORDER) { it.label })
}

private fun MainActivity.queryLauncherApps(packageManager: PackageManager): List<NotificationAppOption> {
    val launcherIntent = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER)
    val activities = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
        packageManager.queryIntentActivities(
            launcherIntent,
            PackageManager.ResolveInfoFlags.of(0)
        )
    } else {
        @Suppress("DEPRECATION")
        packageManager.queryIntentActivities(launcherIntent, 0)
    }
    return activities.mapNotNull { resolveInfo ->
        val packageName = resolveInfo.activityInfo?.packageName.orEmpty()
        if (packageName.isBlank()) return@mapNotNull null
        val label = resolveInfo.loadLabel(packageManager)?.toString()?.trim().orEmpty()
        NotificationAppOption(packageName, label.ifBlank { packageName })
    }
}

private fun resolveNotificationAppOption(
    packageManager: PackageManager,
    packageName: String
): NotificationAppOption? {
    if (packageName.isBlank()) return null
    val appInfo: ApplicationInfo = runCatching {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            packageManager.getApplicationInfo(
                packageName,
                PackageManager.ApplicationInfoFlags.of(0)
            )
        } else {
            @Suppress("DEPRECATION")
            packageManager.getApplicationInfo(packageName, 0)
        }
    }.getOrNull() ?: return NotificationAppOption(packageName, packageName)
    val label = packageManager.getApplicationLabel(appInfo).toString().trim()
    return NotificationAppOption(packageName, label.ifBlank { packageName })
}
