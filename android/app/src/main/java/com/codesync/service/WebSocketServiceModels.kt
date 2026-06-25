package com.codesync.service

import com.codesync.util.DesktopDevice
import okhttp3.WebSocket
import kotlinx.coroutines.Job

data class DeviceConnection(
    val device: DesktopDevice,
    var webSocket: WebSocket? = null,
    var sessionKey: String? = null,
    var authenticated: Boolean = false,
    var deniedByDesktop: Boolean = false,
    var reconnectJob: Job? = null,
    // true 表示这是无负载的配对测试连接，鉴权后短暂保持再主动断开
    var registerOnly: Boolean = false,
    var forceConnect: Boolean = false,
    var phoneNonce: String = ""
)

data class PendingPayload(
    val msgId: String,
    val payload: String,
    val targetIds: MutableSet<String>,
    val type: String
)
