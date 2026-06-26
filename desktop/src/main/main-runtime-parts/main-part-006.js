})

app.on('before-quit', () => {
  // 退出前把防抖中未落盘的配对数据写掉
  flushPendingPairingSave({ sync: true })
  busReliabilityStore?.flushSave?.()
  if (busOutboxFlushTimer) {
    clearInterval(busOutboxFlushTimer)
    busOutboxFlushTimer = null
  }
  if (topologyBroadcastTimer) {
    clearTimeout(topologyBroadcastTimer)
    topologyBroadcastTimer = null
  }
  if (wsHeartbeatTimer) {
    clearInterval(wsHeartbeatTimer)
    wsHeartbeatTimer = null
  }
  if (wss) wss.close()
  if (discoverySocket) {
    try {
      discoverySocket.close()
    } catch (_) {}
  }
  if (lanJoinServer) {
    try {
      lanJoinServer.close()
    } catch (_) {}
  }
  if (localNotifyServer) {
    try {
      localNotifyServer.close()
    } catch (_) {}
  }
  for (const ws of activeDesktopPeerConnections.values()) {
    try {
      ws.close()
    } catch (_) {}
  }
})
