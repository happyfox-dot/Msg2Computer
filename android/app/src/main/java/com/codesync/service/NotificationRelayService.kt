package com.codesync.service

import android.app.Notification
import android.content.ComponentName
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import android.util.Log
import com.codesync.util.RouteManager
import com.codesync.util.SettingsStore

class NotificationRelayService : NotificationListenerService() {

    companion object {
        private const val TAG = "NotificationRelayService"
        private const val RECENT_WINDOW_MS = 5_000L
        private const val ONGOING_SAME_CONTENT_WINDOW_MS = 60_000L
        private const val MAX_BODY_LENGTH = 2_000
    }

    private data class RecentNotification(
        val signature: String,
        val seenAt: Long
    )

    private val recentNotifications = LinkedHashMap<String, RecentNotification>()
    private var lastSkipStatus = ""
    private var lastSkipStatusAt = 0L

    override fun onListenerConnected() {
        super.onListenerConnected()
        Log.i(TAG, "Notification listener connected")
        WebSocketService.reportExternalStatus(this, "App 通知监听已连接")
    }

    override fun onListenerDisconnected() {
        super.onListenerDisconnected()
        Log.w(TAG, "Notification listener disconnected, requesting rebind")
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
            Log.d(TAG, "notification relay disabled, package=${sbn.packageName}")
            reportSkipStatus("App 通知推送开关未开启")
            return
        }
        if (sbn.packageName == packageName) return

        val isOngoing = sbn.isOngoing
        val appPolicy = SettingsStore.getNotificationAppPolicy(this, sbn.packageName)
        if (!SettingsStore.isNotificationPackageAllowed(this, sbn.packageName, isOngoing)) {
            Log.d(TAG, "notification skipped by app policy package=${sbn.packageName}, ongoing=$isOngoing")
            return
        }

        val targets = RouteManager.targetsForType(this, "app_notification").map { it.device }
        if (targets.isEmpty()) {
            Log.d(TAG, "notification received but no app_notification targets, package=${sbn.packageName}")
            WebSocketService.reportExternalStatus(this, "收到 App 通知，但没有启用 App 通知的推送目标")
            return
        }

        val notification = sbn.notification ?: return
        val title = firstNonBlank(
            extractText(notification, Notification.EXTRA_TITLE),
            extractText(notification, Notification.EXTRA_TITLE_BIG),
            extractText(notification, Notification.EXTRA_SUB_TEXT)
        )
        val text = extractNotificationBody(notification)
        if (title.isBlank() && text.isBlank()) {
            Log.d(TAG, "notification has no title/body, package=${sbn.packageName}")
            reportSkipStatus("收到 App 通知，但标题和正文为空")
            return
        }

        val appName = resolveAppName(sbn.packageName)
        val body = text.ifBlank { title }.take(MAX_BODY_LENGTH)
        val notificationKey = notificationKey(sbn)
        val signature = notificationSignature(notification, title, body)
        val dedupeKey = if (isOngoing) notificationKey else "${sbn.packageName}|$title|$body"
        if (
            isRecentDuplicate(
                key = dedupeKey,
                signature = signature,
                throttleWindowMs = if (isOngoing) appPolicy.minIntervalMs else 0L,
                duplicateWindowMs = if (isOngoing) ONGOING_SAME_CONTENT_WINDOW_MS else RECENT_WINDOW_MS
            )
        ) {
            Log.d(TAG, "notification skipped by dedupe/throttle package=${sbn.packageName}, ongoing=$isOngoing")
            return
        }

        Log.d(TAG, "notification forwarding package=${sbn.packageName}, ongoing=$isOngoing, targets=${targets.size}")

        val intent = Intent(this, WebSocketService::class.java).apply {
            action = WebSocketService.ACTION_SEND_NOTIFICATION
            putExtra(WebSocketService.EXTRA_TITLE, title)
            putExtra(WebSocketService.EXTRA_MESSAGE_BODY, body)
            putExtra(WebSocketService.EXTRA_APP_NAME, appName)
            putExtra(WebSocketService.EXTRA_PACKAGE_NAME, sbn.packageName)
            putExtra(WebSocketService.EXTRA_NOTIFICATION_KEY, notificationKey)
            putExtra(WebSocketService.EXTRA_NOTIFICATION_ONGOING, isOngoing)
            putExtra(WebSocketService.EXTRA_NOTIFICATION_POST_TIME, sbn.postTime)
        }
        runCatching {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                startForegroundService(intent)
            } else {
                startService(intent)
            }
        }.onFailure {
            Log.e(TAG, "failed to start notification relay service", it)
            WebSocketService.reportExternalStatus(
                this,
                "收到 App 通知，但启动同步服务失败：${it.message ?: it.javaClass.simpleName}"
            )
        }
    }

    override fun onNotificationRemoved(sbn: StatusBarNotification?) {
        sbn ?: return
        if (sbn.packageName == packageName) return
        if (!sbn.isOngoing) return
        // 移除事件也要同步出去：若通知展示后用户才关闭了总开关或 ongoing 规则，
        // 这里再按策略拦截会导致桌面端状态卡和 ongoing 气泡去重键永远残留。

        val notification = sbn.notification
        val title = notification?.let {
            firstNonBlank(
                extractText(it, Notification.EXTRA_TITLE),
                extractText(it, Notification.EXTRA_TITLE_BIG),
                extractText(it, Notification.EXTRA_SUB_TEXT)
            )
        }.orEmpty()
        val notificationKey = notificationKey(sbn)
        val appName = resolveAppName(sbn.packageName)
        val intent = Intent(this, WebSocketService::class.java).apply {
            action = WebSocketService.ACTION_SEND_NOTIFICATION_REMOVED
            putExtra(WebSocketService.EXTRA_TITLE, title)
            putExtra(WebSocketService.EXTRA_APP_NAME, appName)
            putExtra(WebSocketService.EXTRA_PACKAGE_NAME, sbn.packageName)
            putExtra(WebSocketService.EXTRA_NOTIFICATION_KEY, notificationKey)
            putExtra(WebSocketService.EXTRA_NOTIFICATION_ONGOING, true)
            putExtra(WebSocketService.EXTRA_NOTIFICATION_POST_TIME, sbn.postTime)
        }
        runCatching {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                startForegroundService(intent)
            } else {
                startService(intent)
            }
        }.onFailure {
            Log.e(TAG, "failed to start notification removal relay service", it)
        }
    }

    private fun extractNotificationBody(notification: Notification): String {
        val bigText = extractText(notification, Notification.EXTRA_BIG_TEXT)
        if (bigText.isNotBlank()) return bigText

        val messages = extractMessagingText(notification)
        if (messages.isNotBlank()) return messages

        val textLines = notification.extras.getCharSequenceArray(Notification.EXTRA_TEXT_LINES)
        if (!textLines.isNullOrEmpty()) {
            return textLines
                .mapNotNull { it?.toString()?.trim()?.takeIf(String::isNotBlank) }
                .joinToString("\n")
        }

        return firstNonBlank(
            extractText(notification, Notification.EXTRA_TEXT),
            extractText(notification, Notification.EXTRA_SUMMARY_TEXT),
            extractText(notification, Notification.EXTRA_SUB_TEXT),
            notification.tickerText?.toString()?.trim().orEmpty()
        )
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

    private fun extractMessagingText(notification: Notification): String {
        val parcelables = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            notification.extras.getParcelableArray(
                Notification.EXTRA_MESSAGES,
                Bundle::class.java
            )
        } else {
            @Suppress("DEPRECATION")
            notification.extras.getParcelableArray(Notification.EXTRA_MESSAGES)
                ?.mapNotNull { it as? Bundle }
                ?.toTypedArray()
        } ?: return ""

        return parcelables
            .mapNotNull { bundle ->
                val text = bundle.getCharSequence("text")?.toString()?.trim().orEmpty()
                if (text.isBlank()) return@mapNotNull null
                val sender = bundle.getCharSequence("sender")?.toString()?.trim().orEmpty()
                if (sender.isBlank()) text else "$sender: $text"
            }
            .joinToString("\n")
    }

    private fun firstNonBlank(vararg values: String): String =
        values.firstOrNull { it.isNotBlank() }.orEmpty()

    private fun notificationKey(sbn: StatusBarNotification): String =
        runCatching { sbn.key }
            .getOrDefault("${sbn.packageName}:${sbn.id}:${sbn.tag.orEmpty()}")

    private fun notificationSignature(notification: Notification, title: String, body: String): String {
        val progress = notification.extras.getInt(Notification.EXTRA_PROGRESS, -1)
        val progressMax = notification.extras.getInt(Notification.EXTRA_PROGRESS_MAX, -1)
        val progressIndeterminate = notification.extras.getBoolean(
            Notification.EXTRA_PROGRESS_INDETERMINATE,
            false
        )
        return listOf(title, body, progress, progressMax, progressIndeterminate).joinToString("|")
    }

    private fun reportSkipStatus(message: String) {
        val now = System.currentTimeMillis()
        if (message == lastSkipStatus && now - lastSkipStatusAt < 30_000L) return
        lastSkipStatus = message
        lastSkipStatusAt = now
        WebSocketService.reportExternalStatus(this, message)
    }

    private fun isRecentDuplicate(
        key: String,
        signature: String,
        throttleWindowMs: Long,
        duplicateWindowMs: Long
    ): Boolean {
        val now = System.currentTimeMillis()
        val retainWindowMs = maxOf(
            ONGOING_SAME_CONTENT_WINDOW_MS,
            duplicateWindowMs,
            throttleWindowMs
        )
        val iterator = recentNotifications.entries.iterator()
        while (iterator.hasNext()) {
            if (now - iterator.next().value.seenAt > retainWindowMs) {
                iterator.remove()
            }
        }
        val lastSeen = recentNotifications[key]
        if (lastSeen != null) {
            val age = now - lastSeen.seenAt
            if (lastSeen.signature == signature && age <= duplicateWindowMs) return true
            if (throttleWindowMs > 0L && age <= throttleWindowMs) return true
        }
        recentNotifications[key] = RecentNotification(signature, now)
        while (recentNotifications.size > 80) {
            val first = recentNotifications.entries.firstOrNull() ?: break
            recentNotifications.remove(first.key)
        }
        return false
    }
}
