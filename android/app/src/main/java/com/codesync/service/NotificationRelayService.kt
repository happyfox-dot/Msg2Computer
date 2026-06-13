package com.codesync.service

import android.app.Notification
import android.content.ComponentName
import android.content.Intent
import android.os.Build
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import android.util.Log
import com.codesync.util.DeviceStore
import com.codesync.util.SettingsStore

class NotificationRelayService : NotificationListenerService() {

    companion object {
        private const val TAG = "NotificationRelayService"
        private const val RECENT_WINDOW_MS = 5_000L
        private const val MAX_BODY_LENGTH = 2_000
    }

    private val recentNotifications = LinkedHashMap<String, Long>()

    override fun onListenerConnected() {
        super.onListenerConnected()
        Log.i(TAG, "通知监听服务已连接")
        WebSocketService.reportExternalStatus(this, "通知监听服务已连接")
    }

    override fun onListenerDisconnected() {
        super.onListenerDisconnected()
        Log.w(TAG, "通知监听服务已断开，尝试重新绑定")
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            runCatching {
                NotificationListenerService.requestRebind(
                    ComponentName(this, NotificationRelayService::class.java)
                )
            }
        }
    }

    override fun onNotificationPosted(sbn: StatusBarNotification?) {
        sbn ?: return
        if (!SettingsStore.isSendNotificationsEnabled(this)) {
            Log.d(TAG, "通知推送总开关关闭，跳过 package=${sbn.packageName}")
            return
        }
        if (sbn.packageName == packageName) return
        if (sbn.isOngoing) return
        val targets = DeviceStore.getEnabledDevices(this).filter { it.allowNotifications }
        if (targets.isEmpty()) {
            Log.d(TAG, "收到通知但没有允许 App 通知的目标，package=${sbn.packageName}")
            WebSocketService.reportExternalStatus(this, "收到通知，但没有启用“应用通知”的推送目标")
            return
        }

        val notification = sbn.notification ?: return
        val title = extractText(notification, Notification.EXTRA_TITLE)
        val text = extractNotificationBody(notification)
        if (title.isBlank() && text.isBlank()) {
            Log.d(TAG, "通知标题和正文为空，跳过 package=${sbn.packageName}")
            return
        }

        val appName = resolveAppName(sbn.packageName)
        val body = text.ifBlank { title }.take(MAX_BODY_LENGTH)
        val dedupeKey = "${sbn.packageName}|${title}|${body}"
        if (isRecentDuplicate(dedupeKey)) {
            Log.d(TAG, "通知短时间重复，跳过 package=${sbn.packageName}")
            return
        }

        Log.d(TAG, "收到通知，准备推送 package=${sbn.packageName}, targets=${targets.size}")

        val intent = Intent(this, WebSocketService::class.java).apply {
            action = WebSocketService.ACTION_SEND_NOTIFICATION
            putExtra(WebSocketService.EXTRA_TITLE, title)
            putExtra(WebSocketService.EXTRA_MESSAGE_BODY, body)
            putExtra(WebSocketService.EXTRA_APP_NAME, appName)
            putExtra(WebSocketService.EXTRA_PACKAGE_NAME, sbn.packageName)
        }
        runCatching {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                startForegroundService(intent)
            } else {
                startService(intent)
            }
        }.onFailure {
            Log.e(TAG, "启动通知同步服务失败", it)
            WebSocketService.reportExternalStatus(
                this,
                "收到通知，但启动同步服务失败：${it.message ?: it.javaClass.simpleName}"
            )
        }
    }

    private fun extractNotificationBody(notification: Notification): String {
        val bigText = extractText(notification, Notification.EXTRA_BIG_TEXT)
        if (bigText.isNotBlank()) return bigText

        val textLines = notification.extras.getCharSequenceArray(Notification.EXTRA_TEXT_LINES)
        if (!textLines.isNullOrEmpty()) {
            return textLines
                .mapNotNull { it?.toString()?.trim()?.takeIf(String::isNotBlank) }
                .joinToString("\n")
        }
        return extractText(notification, Notification.EXTRA_TEXT)
    }

    private fun extractText(notification: Notification, key: String): String {
        return notification.extras.getCharSequence(key)?.toString()?.trim().orEmpty()
    }

    private fun resolveAppName(packageName: String): String {
        return runCatching {
            val appInfo = packageManager.getApplicationInfo(packageName, 0)
            packageManager.getApplicationLabel(appInfo).toString()
        }.getOrDefault(packageName)
    }

    private fun isRecentDuplicate(key: String): Boolean {
        val now = System.currentTimeMillis()
        val iterator = recentNotifications.entries.iterator()
        while (iterator.hasNext()) {
            if (now - iterator.next().value > RECENT_WINDOW_MS) iterator.remove()
        }
        val lastSeen = recentNotifications[key]
        if (lastSeen != null && now - lastSeen <= RECENT_WINDOW_MS) return true
        recentNotifications[key] = now
        while (recentNotifications.size > 80) {
            val first = recentNotifications.entries.firstOrNull() ?: break
            recentNotifications.remove(first.key)
        }
        return false
    }
}
