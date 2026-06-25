package com.codesync

import com.codesync.util.DesktopDevice
import java.io.File

data class SheetAction(
    val title: String,
    val subtitle: String = "",
    val destructive: Boolean = false,
    val enabled: Boolean = true,
    val onClick: () -> Unit
)

data class FileTransferTargetOption(
    val device: DesktopDevice,
    val reachable: Boolean,
    val allowed: Boolean,
    val statusLabel: String,
    val reason: String
)
