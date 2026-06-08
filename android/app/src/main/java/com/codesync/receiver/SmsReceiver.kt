package com.codesync.receiver

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.PowerManager
import android.provider.Telephony
import android.util.Log
import com.codesync.service.WebSocketService
import com.codesync.util.CodeExtractor
import com.codesync.util.DeviceStore
import com.codesync.util.SettingsStore

class SmsReceiver : BroadcastReceiver() {

    companion object {
        const val TAG = "SmsReceiver"
    }

    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Telephony.Sms.Intents.SMS_RECEIVED_ACTION) return

        val messages = Telephony.Sms.Intents.getMessagesFromIntent(intent)
        if (messages.isNullOrEmpty()) return

        val sender = messages.firstNotNullOfOrNull { it.originatingAddress } ?: "未知号码"
        val body = messages.joinToString(separator = "") { it.messageBody.orEmpty() }.trim()
        if (body.isBlank()) return

        Log.d(TAG, "收到短信来自 $sender: ${body.take(60)}...")

        val code = CodeExtractor.extract(body)
        if (code == null) {
            Log.d(TAG, "收到短信但未识别到验证码")
            WebSocketService.reportExternalStatus(context, "收到短信，但未识别到验证码：$sender")
            return
        }

        Log.d(TAG, "提取到验证码: $code")

        // 按需模型前置检查：转发开关关闭、或没有启用的电脑目标，就不唤起服务（省电）
        if (!SettingsStore.isForwardingEnabled(context)) {
            Log.d(TAG, "短信转发已关闭，跳过推送")
            return
        }
        if (DeviceStore.getEnabledDevices(context).isEmpty()) {
            Log.d(TAG, "无启用的电脑目标，跳过推送")
            WebSocketService.reportExternalStatus(context, "收到验证码，但未启用任何电脑：$sender")
            return
        }

        WebSocketService.reportExternalStatus(context, "收到短信验证码，准备同步：$sender")
        holdReceiverWakeLock(context)

        val serviceIntent = Intent(context, WebSocketService::class.java).apply {
            action = WebSocketService.ACTION_SEND_SMS
            putExtra(WebSocketService.EXTRA_CODE, code)
            putExtra(WebSocketService.EXTRA_SOURCE, sender)
            putExtra(WebSocketService.EXTRA_MESSAGE_BODY, body)
        }

        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(serviceIntent)
            } else {
                context.startService(serviceIntent)
            }
        } catch (e: Exception) {
            Log.e(TAG, "启动同步服务失败", e)
            WebSocketService.reportExternalStatus(context, "验证码已识别，但启动同步服务失败：${e.message ?: e.javaClass.simpleName}")
        }
    }

    private fun holdReceiverWakeLock(context: Context) {
        try {
            val powerManager = context.getSystemService(Context.POWER_SERVICE) as PowerManager
            powerManager
                .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "CodeSync:SmsReceiver")
                .apply {
                    setReferenceCounted(false)
                    acquire(10_000L)
                }
        } catch (e: Exception) {
            Log.e(TAG, "短信接收唤醒锁获取失败", e)
        }
    }
}
