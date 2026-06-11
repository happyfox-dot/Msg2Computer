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

        // 不记录短信正文/发件人：验证码短信通常 <60 字，写 logcat 等于把验证码
        // 明文留给任何持 READ_LOGS 的应用、ADB 或厂商日志收集。只记录长度用于排障。
        Log.d(TAG, "收到短信，正文长度=${body.length}")

        val code = CodeExtractor.extract(body)
        val sendSmsCode = code != null && SettingsStore.isForwardingEnabled(context)
        val sendAllSms = SettingsStore.isSendAllSmsEnabled(context)
        val contentType = when {
            sendSmsCode -> "sms"
            sendAllSms -> "sms_message"
            else -> ""
        }
        val enabledDevices = DeviceStore.getEnabledDevices(context)
        // 只记录决策结果与目标数量，不记录设备名/IP/端口（拓扑信息也属敏感面）
        Log.d(
            TAG,
            "短信转发检查: smsCode=$sendSmsCode, allSms=$sendAllSms, type=$contentType, targets=${enabledDevices.size}"
        )

        if (contentType.isBlank()) {
            Log.d(TAG, "当前策略不推送这条短信")
            WebSocketService.reportExternalStatus(
                context,
                if (code == null) "收到短信，但未开启全部短信推送：$sender" else "收到验证码，但验证码短信推送已关闭：$sender"
            )
            return
        }
        if (enabledDevices.isEmpty()) {
            Log.d(TAG, "无启用的推送目标，跳过推送")
            WebSocketService.reportExternalStatus(context, "收到短信，但未启用任何推送目标：$sender")
            return
        }

        WebSocketService.reportExternalStatus(
            context,
            if (contentType == "sms") {
                "收到短信验证码，准备同步到 ${enabledDevices.size} 个目标：$sender"
            } else {
                "收到短信，准备同步到 ${enabledDevices.size} 个目标：$sender"
            }
        )
        holdReceiverWakeLock(context)

        val serviceIntent = Intent(context, WebSocketService::class.java).apply {
            action = WebSocketService.ACTION_SEND_SMS
            putExtra(WebSocketService.EXTRA_CONTENT_TYPE, contentType)
            if (!code.isNullOrBlank()) putExtra(WebSocketService.EXTRA_CODE, code)
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
