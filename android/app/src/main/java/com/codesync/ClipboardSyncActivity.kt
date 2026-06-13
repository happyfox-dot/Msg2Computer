package com.codesync

import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import com.codesync.service.WebSocketService
import com.codesync.util.ClipboardHistoryStore
import com.codesync.util.DeviceStore
import com.codesync.util.PhoneIdentityStore
import com.codesync.util.SettingsStore

/**
 * 透明一闪 Activity：Android 10+ 仅「持有焦点的应用」可读剪贴板，快捷磁贴自身
 * 读不到。磁贴点击拉起本页，在获得窗口焦点的瞬间读取剪贴板并交给投递服务，
 * 然后立即关闭——用户感知上就是"点一下磁贴即同步"。
 */
class ClipboardSyncActivity : AppCompatActivity() {

    private var handled = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // 无布局：依赖透明主题，等 onWindowFocusChanged 获焦后执行
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (!hasFocus || handled) return
        handled = true
        syncClipboardOnce()
        finish()
    }

    private fun syncClipboardOnce() {
        if (!SettingsStore.isSyncClipboardEnabled(this)) {
            Toast.makeText(this, R.string.clipboard_sync_disabled, Toast.LENGTH_SHORT).show()
            return
        }
        if (DeviceStore.getEnabledDevices(this).none { it.allowClipboard }) {
            Toast.makeText(this, R.string.clipboard_no_target, Toast.LENGTH_SHORT).show()
            return
        }
        val clipboard = getSystemService(Context.CLIPBOARD_SERVICE) as android.content.ClipboardManager
        val text = clipboard.primaryClip?.takeIf { it.itemCount > 0 }
            ?.getItemAt(0)?.coerceToText(this)?.toString()?.trim().orEmpty()
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
        // 不做「已同步就跳过」：磁贴是用户显式动作，语义是"把当前状态再推一遍"，
        // 用于补齐当时离线没收到的节点。内容未变时复用现有版本号（见
        // handleSendClipboard），已有该版本的节点经去重/LWW 自然忽略，幂等无害。
        val intent = Intent(this, WebSocketService::class.java).apply {
            action = WebSocketService.ACTION_SEND_CLIPBOARD
            putExtra(WebSocketService.EXTRA_MESSAGE_BODY, text)
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            startForegroundService(intent)
        } else {
            startService(intent)
        }
        Toast.makeText(this, R.string.clipboard_sent, Toast.LENGTH_SHORT).show()
    }
}
