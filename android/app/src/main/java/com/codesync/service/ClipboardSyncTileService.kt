package com.codesync.service

import android.app.PendingIntent
import android.content.Intent
import android.os.Build
import android.service.quicksettings.TileService
import com.codesync.ClipboardSyncActivity

/**
 * 快捷设置磁贴「同步剪贴板」：下拉通知栏点一下，把当前剪贴板同步到所有授权节点，
 * 无需打开应用。磁贴自身不是焦点应用、读不到剪贴板（Android 10+ 限制），
 * 点击后拉起透明的 [ClipboardSyncActivity]，由它在获焦后读取并投递。
 */
class ClipboardSyncTileService : TileService() {

    override fun onClick() {
        super.onClick()
        val intent = Intent(this, ClipboardSyncActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            // API 34 起 Intent 版本被禁用，必须走 PendingIntent
            startActivityAndCollapse(
                PendingIntent.getActivity(
                    this, 0, intent,
                    PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
                )
            )
        } else {
            @Suppress("DEPRECATION")
            startActivityAndCollapse(intent)
        }
    }
}
