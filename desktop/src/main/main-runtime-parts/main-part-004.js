  incomingClipboardFileSession = { key: '', paths: new Set(), fileIds: new Set(), expectedCount: 0, timer: null, version: null }
}

function ensureIncomingClipboardFileSession(key, expectedCount = 0, version = null) {
  const normalizedKey = String(key || '').trim() || `clipboard-files-${Date.now()}`
  if (incomingClipboardFileSession.key !== normalizedKey) {
    clearIncomingClipboardFiles()
    incomingClipboardFileSession = {
      key: normalizedKey,
      paths: new Set(),
      fileIds: new Set(),
      expectedCount: Math.max(0, Number(expectedCount) || 0),
      timer: null,
      version
    }
  } else if (Number(expectedCount) > incomingClipboardFileSession.expectedCount) {
    incomingClipboardFileSession.expectedCount = Number(expectedCount)
    if (version) incomingClipboardFileSession.version = version
  }
  if (version && !incomingClipboardFileSession.version) {
    incomingClipboardFileSession.version = version
  }
  try {
    fs.mkdirSync(incomingClipboardFileTempDir(), { recursive: true })
  } catch (_) {}
  return incomingClipboardFileSession
}

function scheduleIncomingClipboardFileFlush(sessionKey, codeInfo = {}, latestName = '') {
  if (incomingClipboardFileSession.key !== sessionKey) return
  const session = incomingClipboardFileSession
  if (session.timer) clearTimeout(session.timer)
  const expected = Math.max(0, Number(session.expectedCount) || 0)
  const complete = expected > 0 && session.fileIds.size >= expected
  const delay = complete ? 80 : CLIPBOARD_FILE_BATCH_FLUSH_MS
  session.timer = setTimeout(() => {
    if (incomingClipboardFileSession.key !== sessionKey) return
    const paths = Array.from(incomingClipboardFileSession.paths).filter(item => {
      try {
        return fs.statSync(item).isFile()
      } catch (_) {
        return false
      }
    })
    const version = incomingClipboardFileSession.version
    if (version && !isIncomingClipboardVersionApplicable(version)) {
      incomingClipboardFileSession.timer = null
      clearIncomingClipboardFiles()
      return
    }
    const wrote = writeFilePathsToClipboard(paths)
    if (wrote && version && !isSameGlobalClipVersion(version)) {
      rememberGlobalClipVersion(version.ts, version.origin, version.hash, version.kind || 'file')
      savePairingKey()
    }
    incomingClipboardFileSession.timer = null
  }, delay)
  session.timer.unref?.()
}

function writeFilePathsToClipboard(filePaths) {
  const paths = Array.from(new Set(
    (Array.isArray(filePaths) ? filePaths : [])
      .map(item => path.resolve(String(item || '')))
      .filter(item => {
        try {
          return fs.statSync(item).isFile()
        } catch (_) {
          return false
        }
      })
  ))
  if (paths.length === 0) return false
  if (process.platform !== 'win32') return false
  try {
    const utf16 = Buffer.from(`${paths.join('\u0000')}\u0000\u0000`, 'utf16le')
    clipboard.writeBuffer('FileNameW', utf16)
    lastClipboardFileSignature = getClipboardFileSignature(paths)
    return true
  } catch (error) {
    console.warn('Failed to write file paths to clipboard:', error.message)
    return false
  }
}

function clipboardFilePathsKey(filePaths) {
  return (Array.isArray(filePaths) ? filePaths : [])
    .map(item => path.resolve(String(item || '')))
    .sort()
    .join('\n')
}

function collectEligibleClipboardFiles(filePaths) {
  const maxBytes = Math.max(1, Number(desktopMessageSettings.maxFileSizeMb || 50)) * 1024 * 1024
  const eligible = []
  const skipped = []
  const seen = new Set()
  for (const filePath of Array.isArray(filePaths) ? filePaths : []) {
    const normalized = path.resolve(String(filePath || ''))
    if (!normalized || seen.has(normalized)) continue
    seen.add(normalized)
    let stat = null
    try {
      stat = fs.statSync(normalized)
    } catch (error) {
      skipped.push({ filePath: normalized, reason: error.message || 'unreadable', retryable: true })
      continue
    }
    if (!stat.isFile()) {
      skipped.push({ filePath: normalized, reason: 'not_file', retryable: false })
      continue
    }
    if (stat.size <= 0 || stat.size > maxBytes) {
      skipped.push({ filePath: normalized, reason: `size ${formatBytes(stat.size)} exceeds ${formatBytes(maxBytes)}`, retryable: false })
      continue
    }
    eligible.push({ filePath: normalized, size: stat.size })
  }
  return { eligible, skipped }
}

async function sendClipboardFileBatch(candidate) {
  const targets = getDefaultClipboardFileTargetIds()
  if (targets.length === 0) {
    return { sent: 0, retryable: false, reason: 'no_targets' }
  }

  const sourcePaths = Array.isArray(candidate.retryFilePaths) && candidate.retryFilePaths.length > 0
    ? candidate.retryFilePaths
    : candidate.filePaths
  const { eligible, skipped } = collectEligibleClipboardFiles(sourcePaths)
  if (skipped.length > 0) {
    console.warn('Clipboard file sync skipped entries:', skipped)
  }
  const retryableSkippedPaths = skipped
    .filter(item => item.retryable)
    .map(item => item.filePath)
  if (eligible.length === 0) {
    return {
      sent: 0,
      failedPaths: retryableSkippedPaths,
      retryable: retryableSkippedPaths.length > 0 && candidate.attempts + 1 < CLIPBOARD_FILE_RETRY_LIMIT,
      reason: 'no_eligible_files'
    }
  }

  clearIncomingClipboardFiles()
  const transfer = initFileTransfer()
  const identity = getDesktopIdentity()
  if (!candidate.batchMeta) {
    const clipTs = Date.now()
    const signatureHash = hashClipText(candidate.signature)
    const plannedFileCount = eligible.length + retryableSkippedPaths.length
    candidate.batchMeta = {
      clipTs,
      signatureHash,
      clipboardBatchId: `clip-files-${identity.id}-${clipTs}-${signatureHash}`,
      clipboardFileCount: plannedFileCount,
      clipboardFileTotalBytes: eligible.reduce((sum, item) => sum + item.size, 0)
    }
  }
  const batchMeta = candidate.batchMeta
  let sent = 0
  const failedPaths = Array.from(retryableSkippedPaths)
  for (const [index, item] of eligible.entries()) {
    try {
      const offer = await transfer.offerFile(item.filePath, targets, {
        type: CODE_TYPES.CLIPBOARD_FILE,
        source: 'Clipboard files',
        rawPrefix: 'Clipboard file',
        payloadExtra: {
          ...buildLocalSourceAddressPayload(),
          clipVersion: { ts: batchMeta.clipTs, origin: identity.id, hash: batchMeta.signatureHash, kind: 'file' },
          clipboardBatchId: batchMeta.clipboardBatchId,
          clipboardFileCount: batchMeta.clipboardFileCount,
          clipboardFileIndex: index,
          clipboardFileTotalBytes: batchMeta.clipboardFileTotalBytes
        }
      })
      if (offer && Number(offer.delivered || 0) > 0) sent += 1
      else failedPaths.push(item.filePath)
    } catch (error) {
      console.error(`Clipboard file sync failed for ${item.filePath}:`, error.message)
      failedPaths.push(item.filePath)
    }
  }
  return {
    sent,
    failedPaths,
    retryable: failedPaths.length > 0 && candidate.attempts + 1 < CLIPBOARD_FILE_RETRY_LIMIT,
    reason: failedPaths.length === 0 ? '' : 'partial_or_no_manifest_delivered'
  }
}

async function dispatchPendingClipboardFileBatch(candidate) {
  if (!candidate || candidate.sending) return
  candidate.sending = true
  try {
    const result = await sendClipboardFileBatch(candidate)
    if (pendingClipboardFileBatch !== candidate) return
    candidate.sending = false
    const failedPaths = Array.isArray(result.failedPaths) ? result.failedPaths.filter(Boolean) : []
    if (failedPaths.length === 0 && result.sent > 0) {
      lastClipboardFileSignature = candidate.signature
      pendingClipboardFileBatch = null
      return
    }
    candidate.attempts += 1
    if (!result.retryable || candidate.attempts >= CLIPBOARD_FILE_RETRY_LIMIT) {
      console.warn(`Clipboard file sync abandoned: ${result.reason || 'unknown'}`)
      lastClipboardFileSignature = candidate.signature
      pendingClipboardFileBatch = null
      return
    }
    if (failedPaths.length > 0) {
      candidate.retryFilePaths = failedPaths
    }
    candidate.nextAttemptAt = Date.now() + CLIPBOARD_FILE_RETRY_DELAY_MS
  } catch (error) {
    if (pendingClipboardFileBatch !== candidate) return
    candidate.sending = false
    candidate.attempts += 1
    if (candidate.attempts >= CLIPBOARD_FILE_RETRY_LIMIT) {
      console.warn('Clipboard file sync abandoned:', error.message)
      lastClipboardFileSignature = candidate.signature
      pendingClipboardFileBatch = null
    } else {
      candidate.nextAttemptAt = Date.now() + CLIPBOARD_FILE_RETRY_DELAY_MS
    }
  }
}

function pollClipboardFilesForSync() {
  const filePaths = readClipboardFilePaths()
  const signature = getClipboardFileSignature(filePaths)
  if (!signature) {
    lastClipboardFileSignature = ''
    pendingClipboardFileBatch = null
    return
  }
  if (signature === lastClipboardFileSignature) return

  const now = Date.now()
  const pathsKey = clipboardFilePathsKey(filePaths)
  if (!pendingClipboardFileBatch || pendingClipboardFileBatch.signature !== signature) {
    pendingClipboardFileBatch = {
      signature,
      pathsKey,
      filePaths: Array.from(filePaths),
      stableSince: now,
      attempts: 0,
      nextAttemptAt: now,
      sending: false,
      retryFilePaths: null
    }
    return
  }

  if (pendingClipboardFileBatch.pathsKey !== pathsKey) {
    pendingClipboardFileBatch.pathsKey = pathsKey
    pendingClipboardFileBatch.filePaths = Array.from(filePaths)
    pendingClipboardFileBatch.stableSince = now
    pendingClipboardFileBatch.attempts = 0
    pendingClipboardFileBatch.nextAttemptAt = now
    pendingClipboardFileBatch.retryFilePaths = null
    return
  }

  pendingClipboardFileBatch.filePaths = Array.from(filePaths)
  if (now - pendingClipboardFileBatch.stableSince < CLIPBOARD_FILE_STABLE_MS) return
  if (pendingClipboardFileBatch.sending || now < pendingClipboardFileBatch.nextAttemptAt) return
  dispatchPendingClipboardFileBatch(pendingClipboardFileBatch)
}

// 把一条剪贴板状态推送给已配对节点（本机新复制的广播与收到后的 gossip 扩散共用）。
// 投递通道按对端类型分流：
//   - 手机节点：走 relay HTTP（端口 19529 的 NodeReceiverService）。手机的 WS 客户端
//     不处理入站 verify_code，且按需模型下平时不连桌面，relay HTTP 才是手机的收件入口。
//   - 桌面对端：走已建立的 WS 连接发 verify_code。
// options：{ ts, origin, originDeviceName, relayPath, exclude } —— gossip 时保留
// 原始版本与来源，不重新署名；不传则视为本机新复制（用当前 clipboardSyncState）。
function broadcastClipboardToNodes(text, options = {}) {
  const identity = getDesktopIdentity()
  const clipTs = Number(options.ts) || clipboardSyncState.ts || Date.now()
  const clipOrigin = String(options.origin || clipboardSyncState.origin || identity.id)
  const originDeviceName = String(options.originDeviceName || (clipOrigin === identity.id ? identity.name : clipOrigin))
  const relayPath = Array.from(new Set(
    (Array.isArray(options.relayPath) ? options.relayPath.map(String) : []).concat(identity.id)
  ))
  const exclude = options.exclude instanceof Set ? options.exclude : new Set()
  relayPath.forEach(id => exclude.add(id))
  exclude.add(clipOrigin)

  const targetPhones = getAuthorizedPhones().filter(phone =>
    phone.enabled !== false &&
    phone.revoked !== true &&
    !exclude.has(phone.id) &&
    canPushContentToNode(phone, CODE_TYPES.CLIPBOARD_TEXT) &&
    phone.pairingKey &&
    (phone.lastIP || phone.host)
  )
  // 桌面对端没有 per-device 剪贴板策略 UI（allowClipboard 恒为默认 false，
  // 旧实现查它导致桌面间剪贴板永远不发——死代码）。桌面间是对等互信关系，
  // 改为只受两端总开关控制：本端开了才会走到这里，对端有自己的接收开关把关。
  const targetDesktopPeerIds = new Set(
    Array.from(activeDesktopPeerConnections.keys()).filter(peerId => {
      if (exclude.has(peerId)) return false
      const peer = pairedDesktopPeers.get(peerId)
      return !!peer && peer.enabled !== false
    })
  )
  const targetDeviceIds = [
    ...targetPhones.map(phone => phone.id),
    ...Array.from(targetDesktopPeerIds)
  ]
  if (targetDeviceIds.length === 0) return
  // originMessageId 与版本绑定：同一版本经多条路径/多次补推到达同一节点时，
  // 接收端用既有去重表（手机 markRelayMessageSeen / 桌面 recentDeliveryKeys）
  // 即可收敛为一次处理，LWW 版本比较是第二道语义防线
  const originMessageId = `clip-${clipOrigin}-${clipTs}`
  const basePayload = {
    type: CODE_TYPES.CLIPBOARD_TEXT,
    code: '',
    source: '剪贴板',
    rawMessage: text,
    timestamp: clipTs,
    phoneId: clipOrigin,
    phoneName: originDeviceName,
    sourceDeviceId: clipOrigin,
    sourceDeviceName: originDeviceName,
    sourceDeviceType: clipOrigin === identity.id ? identity.type : 'UNKNOWN_DEVICE',
    originDeviceId: clipOrigin,
    originDeviceName,
    originMessageId,
    relayMessageId: originMessageId,
    clipVersion: { ts: clipTs, origin: clipOrigin },
    relayPath,
    // gossip 续传携带并衰减入站 TTL（options.ttl），原发（本机新复制/上线补推）
    // 不传 options.ttl 时用满 TTL。绝不每跳重置——否则 TTL 安全网失效，
    // 风暴边界退化为去重表（详见 Android rewriteClipboardGossipTargets 注释）。
    relayTtl: Number.isFinite(Number(options.ttl)) ? Math.max(0, Number(options.ttl)) : USER_MESSAGE_RELAY_TTL,
    targetDeviceIds
  }

  // 桌面对端：WS verify_code（payload 用各连接的会话密钥加密）
  const peerPayloadPlain = JSON.stringify(basePayload)
  let delivered = 0
  for (const [peerId, ws] of activeDesktopPeerConnections.entries()) {
    if (!targetDesktopPeerIds.has(peerId)) continue
    if (!ws || ws.readyState !== WebSocket.OPEN) continue
    const sessionKey = ws.__codebridgeSessionKey
    if (!sessionKey) continue
    const encrypted = encryptMessage(peerPayloadPlain, sessionKey)
    if (!encrypted) continue
    try {
      ws.send(JSON.stringify({ type: 'verify_code', msgId: originMessageId, payload: encrypted }))
      delivered += 1
    } catch (e) {
      console.error('剪贴板同步到桌面对端失败:', e)
    }
  }

  // 手机节点：relay HTTP（每台用其 relay 配对密钥加密，独立打时间戳）
  for (const phone of targetPhones) {
    sendRelayEnvelopeToPhone(phone, basePayload).then(ok => {
      if (!ok) console.warn(`剪贴板 relay 到手机失败: ${phone.name}`)
    }).catch(error => {
      console.error(`剪贴板 relay 异常 ${phone.name}:`, error.message)
    })
  }

  if (delivered > 0 || targetPhones.length > 0) {
    console.log(`剪贴板已同步 v${clipTs}：桌面对端 ${delivered}，手机 ${targetPhones.length}`)
  }
}

function broadcastClipboardImageToNodes(imageBuffer, sha256, options = {}) {
  if (!Buffer.isBuffer(imageBuffer) || imageBuffer.length === 0) return
  if (imageBuffer.length > CLIPBOARD_INLINE_IMAGE_MAX_BYTES) return
  const mime = normalizeClipboardImageMime(options.mime) || 'image/png'
  const ext = options.ext || clipboardImageExtension(mime)
  const identity = getDesktopIdentity()
  const clipTs = Number(options.ts) || clipboardImageSyncState.ts || Date.now()
  const clipOrigin = String(options.origin || clipboardImageSyncState.origin || identity.id)
  const originDeviceName = String(options.originDeviceName || (clipOrigin === identity.id ? identity.name : clipOrigin))
  const relayPath = Array.from(new Set(
    (Array.isArray(options.relayPath) ? options.relayPath.map(String) : []).concat(identity.id)
  ))
  const exclude = options.exclude instanceof Set ? options.exclude : new Set()
  relayPath.forEach(id => exclude.add(id))
  exclude.add(clipOrigin)

  const targetDeviceIds = getDefaultClipboardImageTargetIds()
    .filter(id => !exclude.has(id))
  if (targetDeviceIds.length === 0) return

  const fullHash = sha256 || hashBuffer(imageBuffer)
  const shortHash = fullHash.slice(0, 24)
  const originMessageId = `clip-img-${clipOrigin}-${clipTs}-${shortHash}`
  const manifest = {
    fileId: originMessageId,
    name: `clipboard-${clipTs}.${ext}`,
    mime,
    size: imageBuffer.length,
    sha256: fullHash,
    originDeviceId: clipOrigin,
    targetDeviceIds,
    expiresAt: Date.now() + 10 * 60 * 1000,
    inline: true
  }
  const basePayload = {
    type: CODE_TYPES.CLIPBOARD_IMAGE,
    code: '',
    source: '剪贴板图片',
    label: manifest.name,
    rawMessage: `剪贴板图片 ${formatBytes(imageBuffer.length)}`,
    timestamp: clipTs,
    phoneId: clipOrigin,
    phoneName: originDeviceName,
    sourceDeviceId: clipOrigin,
    sourceDeviceName: originDeviceName,
    sourceDeviceType: clipOrigin === identity.id ? identity.type : 'UNKNOWN_DEVICE',
    originDeviceId: clipOrigin,
    originDeviceName,
    originMessageId,
    relayMessageId: originMessageId,
    clipVersion: { ts: clipTs, origin: clipOrigin, hash: shortHash, kind: 'image' },
    fileManifest: manifest,
    dataBase64: imageBuffer.toString('base64'),
    relayPath,
    // gossip 续传携带衰减后的入站 TTL（options.ttl）；原发（本机新复制/上线补推）
    // 不传 ttl，用满 TTL。避免每跳重置导致 TTL 安全网失效（见剪贴板文本同款修复）。
    relayTtl: Number.isFinite(Number(options.ttl))
      ? Math.max(0, Number(options.ttl))
      : USER_MESSAGE_RELAY_TTL,
    targetDeviceIds
  }

  getContentBus().publish(busEnvelope.TOPICS.CLIPBOARD_IMAGE, basePayload, {
    targetNodeIds: targetDeviceIds,
    ttl: basePayload.relayTtl,
    routePath: relayPath
  }).then(result => {
    if (result.delivered > 0) {
      console.log(`clipboard image synced v${clipTs}: delivered=${result.delivered}/${targetDeviceIds.length}`)
    }
  }).catch(error => {
    console.error('clipboard image sync failed:', error.message)
  })
  return

  const peerPayloadPlain = JSON.stringify(basePayload)
  let delivered = 0
  for (const [peerId, ws] of activeDesktopPeerConnections.entries()) {
    if (!targetDesktopPeerIds.has(peerId)) continue
    if (!ws || ws.readyState !== WebSocket.OPEN) continue
    const sessionKey = ws.__codebridgeSessionKey
    if (!sessionKey) continue
    const encrypted = encryptMessage(peerPayloadPlain, sessionKey)
    if (!encrypted) continue
    try {
      ws.send(JSON.stringify({ type: 'verify_code', msgId: originMessageId, payload: encrypted }))
      delivered += 1
    } catch (e) {
      console.error('剪贴板图片同步到桌面对端失败:', e)
    }
  }

  for (const phone of targetPhones) {
    sendRelayEnvelopeToPhone(phone, basePayload).then(ok => {
      if (!ok) console.warn(`剪贴板图片 relay 到手机失败: ${phone.name}`)
    }).catch(error => {
      console.error(`剪贴板图片 relay 异常 ${phone.name}:`, error.message)
    })
  }

  if (delivered > 0 || targetPhones.length > 0) {
    console.log(`剪贴板图片已同步 v${clipTs}：桌面对端 ${delivered}，手机 ${targetPhones.length}`)
  }
}

// ===== 剪贴板 LWW 应用 / gossip / 上线补推 =====

// 应用一条远端剪贴板（LWW）：仅当版本比已应用版本新、且内容确实不同才写入。
// 返回 true 表示本机状态前进了，调用方据此把该状态继续 gossip 给本机邻居。
function applyRemoteClipboard(codeInfo, codeData) {
  const text = codeInfo.rawMessage || ''
  if (!text || clipboardTextByteLength(text) > CLIPBOARD_MAX_LENGTH) return false
  const version = (codeData && codeData.clipVersion) || {}
  // 旧版负载无 clipVersion：退化用消息时间戳参与排序，保持互通
  const ts = Number(version.ts) || Number(codeInfo.timestamp) || 0
  const origin = String(version.origin || codeInfo.originDeviceId || codeInfo.sourceDeviceId || '')
  if (isSameGlobalClipHash(hashClipText(text))) return false
  if (!isNewerClipVersion(ts, origin)) return false
  rememberClipVersion(ts, origin, text)
  // 先同步本地快照再写剪贴板，防 900ms 轮询把这次远端写入当成本机新复制
  lastClipboardText = text
  clearIncomingClipboardFiles()
  clipboard.writeText(text)
  return true
}

function applyRemoteClipboardImage(codeInfo, codeData) {
  const manifest = codeInfo.fileManifest || codeData.fileManifest || {}
  const dataBase64 = String(codeInfo.dataBase64 || codeData.dataBase64 || '')
  if (!dataBase64 || !normalizeClipboardImageMime(manifest.mime)) return false
  const maxBytes = Math.max(1, Number(desktopMessageSettings.maxFileSizeMb || 50)) * 1024 * 1024
  const size = Number(manifest.size || 0)
  if (size <= 0 || size > maxBytes || size > CLIPBOARD_INLINE_IMAGE_MAX_BYTES) return false
  const buffer = Buffer.from(dataBase64, 'base64')
  if (buffer.length !== size) return false
  const fullHash = hashBuffer(buffer)
  if (manifest.sha256 && manifest.sha256 !== fullHash) return false
  const shortHash = fullHash.slice(0, 24)
  const version = (codeData && codeData.clipVersion) || {}
  const ts = Number(version.ts) || Number(codeInfo.timestamp) || 0
  const origin = String(version.origin || codeInfo.originDeviceId || codeInfo.sourceDeviceId || '')
  if (isSameGlobalClipHash(shortHash)) return false
  if (!isNewerClipImageVersion(ts, origin)) return false
  const image = nativeImage.createFromBuffer(buffer)
  if (image.isEmpty()) return false
  rememberClipImageVersion(ts, origin, shortHash)
  clearIncomingClipboardFiles()
  clipboard.writeImage(image)
  refreshClipboardImageSnapshotAfterWrite(shortHash)
  return true
}

// 应用成功后把同一状态（保留原始版本与来源）扩散给本机授权邻居。
// 每个节点对同一版本最多应用一次 → 最多 gossip 一次，全网收敛必然终止；
// 传播范围是剪贴板授权图的连通分量，不再受限于源设备直接认识的节点。
function gossipClipboardState(codeData) {
  const text = codeData.rawMessage || ''
  if (!text) return
  const version = codeData.clipVersion || {}
  // 续传 TTL = 入站 TTL − 1（衰减）；入站无 TTL（旧负载）时退化为满 TTL。
  // LWW 版本守卫已保证每个版本每节点最多 gossip 一次，TTL 是第二道边界。
  const inboundTtl = Number(codeData.relayTtl ?? codeData.ttl)
  const nextTtl = Number.isFinite(inboundTtl) ? Math.max(0, inboundTtl - 1) : USER_MESSAGE_RELAY_TTL
  if (nextTtl <= 0) return
  broadcastClipboardToNodes(text, {
    ts: Number(version.ts) || Number(codeData.timestamp) || clipboardSyncState.ts,
    origin: String(version.origin || codeData.originDeviceId || ''),
    originDeviceName: codeData.originDeviceName || codeData.sourceDeviceName || '',
    relayPath: Array.isArray(codeData.relayPath) ? codeData.relayPath : [],
    ttl: nextTtl,
    exclude: new Set(
      [String(codeData.lastHopDeviceId || ''), String(codeData.lastRelayDeviceId || '')].filter(Boolean)
    )
  })
}

// 上线补推：节点（重新）连上的那一刻把本机当前剪贴板状态推一次。
// 剪贴板只有一个值，离线期间错过的消息无需补队列，补「最新版本」即可最终一致；
// 推过去的若是旧版本，对端 LWW 会丢弃。只推已版本化的内容（哈希对得上），
// 避免把启动前就躺在剪贴板里的陈年内容打上新时间戳扩散出去。
function buildClipboardStatePushPayload(targetIds) {
  if (desktopMessageSettings.syncClipboardText !== true) return null
  if (!clipboardSyncState.ts) return null
  let text = ''
  try {
    text = clipboard.readText() || ''
  } catch (_) {
    return null
  }
  if (!text || clipboardTextByteLength(text) > CLIPBOARD_MAX_LENGTH) return null
  if (hashClipText(text) !== clipboardSyncState.hash) return null
  const identity = getDesktopIdentity()
  const originMessageId = `clip-${clipboardSyncState.origin}-${clipboardSyncState.ts}`
  return {
    type: CODE_TYPES.CLIPBOARD_TEXT,
    code: '',
    source: '剪贴板',
    rawMessage: text,
    timestamp: clipboardSyncState.ts,
    phoneId: clipboardSyncState.origin,
    phoneName: identity.name,
    sourceDeviceId: clipboardSyncState.origin,
    sourceDeviceName: identity.name,
    sourceDeviceType: identity.type,
    originDeviceId: clipboardSyncState.origin,
    originDeviceName: identity.name,
    originMessageId,
    relayMessageId: originMessageId,
    clipVersion: { ts: clipboardSyncState.ts, origin: clipboardSyncState.origin },
    relayPath: [identity.id],
    relayTtl: USER_MESSAGE_RELAY_TTL,
    targetDeviceIds: targetIds
  }
}

function offerCurrentClipboardStateAsFile(targetIds) {
  if (desktopMessageSettings.syncClipboardText !== true) return false
  if (!clipboardSyncState.ts) return false
  let text = ''
  try {
    text = clipboard.readText() || ''
  } catch (_) {
    return false
  }
  if (!text || clipboardTextByteLength(text) <= CLIPBOARD_MAX_LENGTH) return false
  const actualHash = hashClipText(text)
  if (actualHash !== clipboardSyncState.hash) return false
  offerClipboardTextAsFile(text, clipboardSyncState.ts, actualHash, {
    origin: clipboardSyncState.origin || getDesktopIdentity().id,
    targetIds
  }).catch(error => {
    console.error('补推剪贴板长文本失败:', error.message)
  })
  return true
}

function pushClipboardStateToPhone(phone) {
  if (!phone || !canPushContentToNode(phone, CODE_TYPES.CLIPBOARD_TEXT)) return
  if (!phone.pairingKey || !(phone.lastIP || phone.host)) return
  const payload = buildClipboardStatePushPayload([phone.id])
  if (!payload) {
    offerCurrentClipboardStateAsFile([phone.id])
    return
  }
  sendRelayEnvelopeToPhone(phone, payload).catch(() => {})
}

function pushClipboardStateToDesktopPeer(ws, sessionKey, peerId) {
  if (!ws || ws.readyState !== WebSocket.OPEN || !sessionKey) return
  const payload = buildClipboardStatePushPayload([peerId])
  if (!payload) {
    offerCurrentClipboardStateAsFile([peerId])
    return
  }
  const encrypted = encryptMessage(JSON.stringify(payload), sessionKey)
  if (!encrypted) return
  try {
    ws.send(JSON.stringify({ type: 'verify_code', msgId: payload.originMessageId, payload: encrypted }))
  } catch (e) {
    console.error('补推剪贴板状态到桌面对端失败:', e)
  }
}

// 通过 relay HTTP 把一条用户消息负载发给单台手机（拓扑 relay 的同款信封格式）。
// 剪贴板推送与桌面续传共用：每次发送独立打 relaySentAt 时间戳供对端做重放窗口校验。
async function sendRelayEnvelopeToPhone(phone, basePayload, options = {}) {
  if (!phone || !phone.pairingKey || !hasDirectNodeAddress(phone)) return false
  if (options.skipBus !== true && nodeSupportsSoftBus(phone)) {
    const envelope = busEnvelope.fromLegacyPayload(basePayload, {
      identity: getDesktopIdentity(),
      networkId: ensureTrustedNetworkId()
    })
    const ok = await sendBusEnvelopeDirect(phone, envelope).catch(() => false)
    if (ok) return true
  }
  const identity = getDesktopIdentity()
  const stampedPayload = {
    ...basePayload,
    relaySentAt: Date.now()
  }
  const encryptedPayload = encryptMessage(JSON.stringify(stampedPayload), phone.pairingKey)
  if (!encryptedPayload) return false
  const nonce = generateNonce()
  const authToken = hmacBase64(phone.pairingKey, `${identity.id}|${nonce}|${encryptedPayload}`)
  const envelope = {
    type: 'codebridge_relay',
    version: 1,
    senderId: identity.id,
    nonce,
    payload: encryptedPayload,
    authToken
  }
  const hosts = collectNetworkHosts(phone.lastIP, phone.host, phone.relayHost, phone.tsHost, phone.altHosts)
  for (const host of hosts) {
    const ok = await postJsonToNode(host, Number(phone.relayPort || phone.port) || 19529, envelope)
    if (ok) return true
  }
  return false
}

function buildTotpSeedPushPayload(seed, targetPeer) {
  const identity = getDesktopIdentity()
  return JSON.stringify({
    type: 'totp_seed',
    id: seed.id,
    label: seed.label,
    secret: seed.secret,
    issuer: seed.issuer,
    accountName: seed.accountName,
    algorithm: seed.algorithm,
    digits: seed.digits,
    period: seed.period,
    phoneId: identity.id,
    phoneName: identity.name,
    sourceDeviceId: identity.id,
    sourceDeviceName: identity.name,
    sourceDeviceType: identity.type,
    targetDevices: targetPeer ? [{
      id: targetPeer.id,
      name: targetPeer.name,
      type: targetPeer.deviceType
    }] : [],
    pushAuthority: 'local_desktop',
    pushAuthorityDeviceId: identity.id,
    updatedAt: seed.updatedAt || Date.now()
  })
}

function sendLocalTotpSeedsToDesktopPeer(ws, sessionKey, peer) {
  if (!ws || !sessionKey || !peer || ws.readyState !== WebSocket.OPEN) return
  if (!canPushContentToNode(peer, 'totp')) return
  const cutoff = getTotpSyncCutoff(peer)
  const localSeeds = getLocalTotpSeeds()
    .filter(seed => (Number(seed.updatedAt || seed.createdAt || 0) || 0) > cutoff)
  let sent = 0
  for (const seed of localSeeds) {
    const payload = buildTotpSeedPushPayload(seed, peer)
    const encrypted = encryptMessage(payload, sessionKey)
    if (!encrypted) continue
    ws.send(JSON.stringify({
      type: 'verify_code',
      msgId: `desktop-seed-${seed.id}-${Date.now()}`,
      payload: encrypted
    }))
    sent += 1
  }
  const tombstoneCount = sendTotpDeleteTombstonesToDesktopPeer(ws, sessionKey, peer, cutoff)
  if (sent > 0 || tombstoneCount > 0) {
    markDesktopPeerTotpSeedSynced(peer.id)
  }
}

function sendTotpDeleteTombstonesToDesktopPeer(ws, sessionKey, peer, cutoff = 0) {
  if (!ws || !sessionKey || !peer || ws.readyState !== WebSocket.OPEN) return 0
  pruneTotpDeleteTombstones()
  const pendingTombstones = totpDeleteTombstones
    .filter(tombstone => (Number(tombstone.deletedAt || tombstone.updatedAt || 0) || 0) > cutoff)
  let sent = 0
  for (const tombstone of pendingTombstones) {
    const payload = buildTotpSyncPayload(tombstone, 'delete')
    const encrypted = encryptMessage(payload, sessionKey)
    if (!encrypted) continue
    ws.send(JSON.stringify({ type: 'totp_sync', payload: encrypted }))
    sent += 1
  }
  return sent
}

function handleDesktopPeerTotpSync(peer, encryptedPayload, sessionKey) {
  if (!peer || !encryptedPayload || !sessionKey) return
  const plain = decryptMessage(encryptedPayload, sessionKey)
  if (!plain) return

  try {
    const sync = JSON.parse(plain)
    if (sync.action === 'delete') {
      const secret = normalizeTotpSecret(sync.secret)
      let removed = 0
      for (const [id, seed] of totpSeeds.entries()) {
        const sameSecret = normalizeTotpSecret(seed.secret) === secret
        const sameSource = !sync.sourceDeviceId || seed.sourceDeviceId === sync.sourceDeviceId
        if (sameSecret && sameSource && seed.phoneId !== LOCAL_TOTP_SOURCE_ID) {
          totpSeeds.delete(id)
          removed += 1
        }
      }
      if (removed > 0) {
        savePairingKey()
        notifyTotpSeedsChanged()
      }
      return
    }

    upsertTotpSeed({
      ...sync,
      phoneId: peer.id,
      phoneName: peer.name,
      sourceDeviceId: sync.sourceDeviceId || peer.id,
      sourceDeviceName: sync.sourceDeviceName || peer.name,
      sourceDeviceType: sync.sourceDeviceType || peer.deviceType,
      pushAuthority: sync.pushAuthority || 'desktop_owner',
      pushAuthorityDeviceId: sync.pushAuthorityDeviceId || sync.sourceDeviceId || peer.id
    })
  } catch (e) {
    console.error('处理桌面端 TOTP 同步失败:', e)
  }
}

function connectDesktopPeer(peer, options = {}) {
  if (!peer || peer.enabled === false) return false
  const existing = activeDesktopPeerConnections.get(peer.id)
  // OPEN 复用；CONNECTING 也直接返回，避免重连扫描期间叠出重复连接
  if (existing && (existing.readyState === WebSocket.OPEN || existing.readyState === WebSocket.CONNECTING)) {
    return true
  }

  const identity = getDesktopIdentity()
  const phoneNonce = generateNonce()
  // 候选地址轮换：主地址连不上时下一次尝试换 Tailscale 地址（跨网段对端）
  const hostCandidates = [peer.host, peer.tsHost].filter(Boolean).filter((h, i, arr) => arr.indexOf(h) === i)
  const attempt = desktopPeerHostAttempts.get(peer.id) || 0
  const connectHost = hostCandidates[attempt % hostCandidates.length] || peer.host
  const ws = new WebSocket(`ws://${connectHost}:${peer.port}`)
  ws.isAlive = true
  ws.on('pong', () => { ws.isAlive = true })
  activeDesktopPeerConnections.set(peer.id, ws)

  ws.on('open', () => {
    try {
      const authToken = crypto
        .createHmac('sha256', Buffer.from(peer.pairingKey, 'base64'))
        .update(`${identity.id}|${phoneNonce}`)
        .digest('base64')
      ws.send(JSON.stringify({
        type: 'auth',
        authVersion: 2,
        phoneId: identity.id,
        phoneName: identity.name,
        deviceId: identity.id,
        deviceName: identity.name,
        deviceType: identity.type,
        phoneNonce,
        authToken
      }))
    } catch (e) {
      console.error('桌面互配认证失败:', e)
      ws.close()
    }
  })

  ws.on('message', (data) => {
    try {
      const message = JSON.parse(data.toString())
      if (message.type === 'auth_ok') {
        const sessionKey = message.keyMode === 'derived'
          ? deriveSessionKeyWithPairingKey(peer.pairingKey, phoneNonce, message.serverNonce)
          : message.sessionKey
        ws.__codebridgeSessionKey = sessionKey
        desktopPeerHostAttempts.delete(peer.id)
        peer.connected = true
        peer.connectionUpdatedAt = Date.now()
        peer.lastSeen = peer.connectionUpdatedAt
        pairedDesktopPeers.set(peer.id, peer)
        savePairingKey()
        notifyDesktopPeersChanged({ topologyChanged: false })
        sendLocalTotpSeedsToDesktopPeer(ws, sessionKey, peer)
        // 对端（重新）连上时补推本机当前剪贴板状态（LWW 防旧盖新）
        pushClipboardStateToDesktopPeer(ws, sessionKey, peer.id)
        requestTopologySnapshot(ws, sessionKey)
        return
      }

      if (message.type === 'topology_delta' || message.type === 'node_advertisement' || message.type === 'link_advertisement') {
        const msgId = typeof message.msgId === 'string' ? message.msgId : ''
        const plain = decryptMessage(message.payload, ws.__codebridgeSessionKey)
        if (plain) {
          applyTopologyDeltaPayload(plain, { excludeNodeId: peer.id })
          if (msgId) {
            ws.send(JSON.stringify({ type: 'code_ack', msgId }))
          }
        }
        return
      }

      if (message.type === 'topology_snapshot_request') {
        const plain = decryptMessage(message.payload, ws.__codebridgeSessionKey)
        if (plain) {
          const requestPayload = JSON.parse(plain)
          handleTopologySnapshotRequest(ws, ws.__codebridgeSessionKey, requestPayload)
        }
        return
      }

      if (message.type === 'bus_message') {
        const msgId = typeof message.msgId === 'string' ? message.msgId : ''
        const plain = decryptMessage(message.payload, ws.__codebridgeSessionKey)
        if (!plain) return
        const envelope = JSON.parse(plain)
        if (busEnvelope.isEnvelope(envelope)) {
          if (msgId && hasRecentDelivery(peer.id, msgId, busEnvelope.toLegacyPayload(envelope))) {
            ws.send(JSON.stringify({ type: 'code_ack', msgId }))
            return
          }
          getContentBus().receiveEnvelope(envelope, { lastHopDeviceId: peer.id })
          if (msgId) ws.send(JSON.stringify({ type: 'code_ack', msgId }))
        }
        return
      }

      // 对端（作为 WS 服务器一侧）经这条出站连接反向投递/续传的用户消息。
      // 旧实现里客户端一侧不处理 verify_code，对端只能等本机反向连它才能送达。
      if (message.type === 'verify_code') {
        const msgId = typeof message.msgId === 'string' ? message.msgId : ''
        if (msgId && hasRecentDelivery(peer.id, msgId)) {
          ws.send(JSON.stringify({ type: 'code_ack', msgId }))
          return
        }
        const plain = decryptMessage(message.payload, ws.__codebridgeSessionKey)
        if (!plain) return
        const codeData = JSON.parse(plain)
        codeData.msgId = codeData.msgId || msgId
        codeData.lastHopDeviceId = peer.id
        codeData.lastHopDeviceName = peer.name
        if (msgId && hasRecentDelivery(peer.id, msgId, codeData)) {
          ws.send(JSON.stringify({ type: 'code_ack', msgId }))
          return
        }
        dispatchInboundCodeData(codeData, peer.id)
        if (msgId) {
          rememberDelivery(peer.id, msgId, codeData)
          ws.send(JSON.stringify({ type: 'code_ack', msgId }))
        }
        return
      }

      if (message.type === 'totp_sync') {
        handleDesktopPeerTotpSync(peer, message.payload, ws.__codebridgeSessionKey)
        return
      }

      if (message.type === 'auth_fail' || message.type === 'auth_denied') {
        console.error('桌面互配被拒绝:', peer.name, message.reason || message.type)
        ws.close()
      }
    } catch (e) {
      console.error('桌面互配消息处理失败:', e)
    }
  })

  ws.on('close', () => {
    activeDesktopPeerConnections.delete(peer.id)
    const latest = pairedDesktopPeers.get(peer.id)
    if (latest) {
      latest.connected = false
      latest.connectionUpdatedAt = Date.now()
      pairedDesktopPeers.set(peer.id, latest)
      notifyDesktopPeersChanged({ topologyChanged: false })
    }
  })

  ws.on('error', (error) => {
    console.error(`连接桌面设备失败 ${peer.name}@${connectHost}:`, error.message)
    desktopPeerHostAttempts.set(peer.id, attempt + 1)
  })

  if (options.showNotification !== false) {
    showNotification('桌面配对中', `正在连接 ${peer.name}`)
  }
  return true
}

function pairDesktopPeer(pairingData) {
  const deviceType = normalizeDeviceType(pairingData?.deviceType || pairingData?.type, 'WINDOWS_DESKTOP')
  if (deviceType.includes('PHONE')) {
    const id = String(pairingData?.id || pairingData?.deviceId || '').trim()
    const host = normalizeNetworkHost(pairingData?.host || '')
    const port = Number(pairingData?.port || pairingData?.relayPort || 19529)
    const phonePairingKey = String(pairingData?.pairingKey || pairingData?.pk || '').trim()
    if (!id || !host || !phonePairingKey) {
      return { success: false, error: '无效的手机节点信息' }
    }
    const phone = upsertAuthorizedPhone({
      phoneId: id,
      phoneName: pairingData.name || pairingData.deviceName || 'Android Phone',
      clientIP: host,
      deviceType,
      pairingKey: phonePairingKey,
      relayPort: port,
      tsHost: pairingData?.tsHost
    })
    return {
      success: true,
      peer: phone
    }
  }

  const peer = upsertPairedDesktopPeer(pairingData)
  if (!peer || peer.error) {
    return {
      success: false,
      error: peer?.message || '无效的桌面配对二维码'
    }
  }
  connectDesktopPeer(peer)
  return {
    success: true,
    peer
  }
}

function connectAllDesktopPeers() {
  for (const peer of pairedDesktopPeers.values()) {
    if (peer.enabled !== false) {
      connectDesktopPeer(peer, { showNotification: false })
    }
  }
}

// 桌面对端自动重连：对端重启或网络闪断后，出站连接的 close 只清理状态，
// 不会自动恢复（手机方向有 relay HTTP 兜底，桌面对端没有）。这里周期性
// 重新发起连接，已是 OPEN/CONNECTING 的对端由 connectDesktopPeer 自行跳过。
function startDesktopPeerReconnectLoop() {
  if (desktopPeerReconnectTimer) return
  desktopPeerReconnectTimer = setInterval(() => {
    connectAllDesktopPeers()
  }, DESKTOP_PEER_RECONNECT_INTERVAL_MS)
}

function revokeTotpSeeds(revokeData) {
  const scope = String(revokeData.scope || 'phone').trim().toLowerCase()
  const phoneId = String(revokeData.phoneId || revokeData.sourceDeviceId || '').trim()
  const sourceDeviceId = String(revokeData.sourceDeviceId || phoneId).trim()
  const revokeSecret = normalizeTotpSecret(revokeData.secret)
  const revokeIssuer = normalizeComparableText(revokeData.issuer)
  const revokeAccount = normalizeComparableText(revokeData.accountName)
  const revokeLabel = normalizeComparableText(revokeData.label)
  const seedIds = Array.isArray(revokeData.seedIds)
    ? new Set(revokeData.seedIds.map(id => String(id || '').trim()).filter(Boolean))
    : null
  if (
    scope !== 'seed' &&
    !phoneId &&
    (!seedIds || seedIds.size === 0)
  ) {
    return 0
  }
  if (
    scope === 'seed' &&
    !phoneId &&
    !sourceDeviceId &&
    !revokeSecret &&
    !revokeIssuer &&
    !revokeAccount &&
    !revokeLabel &&
    (!seedIds || seedIds.size === 0)
  ) {
    return 0
  }

  let removed = 0
  for (const [id, seed] of totpSeeds.entries()) {
    if (seed.phoneId === LOCAL_TOTP_SOURCE_ID) continue

    const matchedById = !!seedIds && seedIds.has(id)
    const matchedByPhone = scope !== 'seed' && !seedIds && phoneId && (
      seed.phoneId === phoneId ||
      seed.sourceDeviceId === phoneId ||
      seed.sourceDeviceId === sourceDeviceId
    )
    let matchedBySeed = false

    if (scope === 'seed') {
      const sourceMatches = !phoneId && !sourceDeviceId
        ? true
        : seed.phoneId === phoneId ||
          seed.sourceDeviceId === phoneId ||
          seed.sourceDeviceId === sourceDeviceId
      const secretMatches = revokeSecret && normalizeTotpSecret(seed.secret) === revokeSecret
      const issuerMatches = revokeIssuer && normalizeComparableText(seed.issuer) === revokeIssuer
      const accountMatches = revokeAccount && normalizeComparableText(seed.accountName) === revokeAccount
      const labelMatches = revokeLabel && normalizeComparableText(seed.label) === revokeLabel
      const metadataMatches = !revokeSecret && (issuerMatches || accountMatches || labelMatches)
      matchedBySeed = sourceMatches && (secretMatches || metadataMatches)
    }

    if (matchedById || matchedByPhone || matchedBySeed) {
      totpSeeds.delete(id)
      removed += 1
    }
  }

  if (removed > 0) {
    savePairingKey()
    notifyTotpSeedsChanged()
  }
  return removed
}

function getDesktopTotps() {
  return Array.from(totpSeeds.values())
    .sort((a, b) => {
      const pinA = Number(a.pinnedAt || 0)
      const pinB = Number(b.pinnedAt || 0)
      if (pinA || pinB) return pinB - pinA
      return (b.updatedAt || 0) - (a.updatedAt || 0)
    })
    .map(seed => {
      const time = Math.floor(Date.now() / 1000)
      const remaining = seed.period - (time % seed.period)
      // 本机创建的种子拥有最高权限：删除会同步到其它设备；远端副本删除只影响本机展示。
      const isLocal = !seed.phoneId || seed.phoneId === LOCAL_TOTP_SOURCE_ID
      return {
        id: seed.id,
        label: seed.label,
        issuer: seed.issuer,
        accountName: seed.accountName,
        phoneId: seed.phoneId,
        phoneName: seed.phoneName,
        sourceDeviceId: seed.sourceDeviceId,
        sourceDeviceName: seed.sourceDeviceName,
        sourceDeviceType: seed.sourceDeviceType,
        targetDevices: seed.targetDevices,
        pushAuthority: seed.pushAuthority,
        pushAuthorityDeviceId: seed.pushAuthorityDeviceId,
        isLocal,
        canDelete: true,
        canEdit: isLocal,
        type: CODE_TYPES.TOTP,
        code: generateTotpCode(seed, time),
        timestamp: Date.now(),
        period: seed.period,
        remaining,
        progress: remaining / seed.period,
        digits: seed.digits,
        algorithm: seed.algorithm,
        pinnedAt: seed.pinnedAt || 0,
        isPinned: !!seed.pinnedAt,
        updatedAt: seed.updatedAt
      }
    })
}

function getDeviceStatusLabel(status) {
  return {
    online: '在线',
    reachable: '可路由',
    known: '已知节点',
    offline: '离线',
    disabled: '已禁用',
    revoked: '已撤销',
    discovered: '已发现',
    synced: '已同步'
  }[status] || '未知'
}

function isRecentTopologyTimestamp(value, windowMs = TOPOLOGY_RECENT_REACHABLE_MS) {
  const timestamp = Number(value || 0)
  return Number.isFinite(timestamp) && timestamp > 0 && Date.now() - timestamp <= windowMs
}

function getTopologyFreshnessAt(node = {}) {
  return Math.max(
    Number(node.connectionUpdatedAt || 0) || 0,
    Number(node.lastSeen || 0) || 0,
    Number(node.routeUpdatedAt || 0) || 0
  )
}

function hasTopologyPathCandidate(node = {}) {
  return hasDirectNodeAddress(node) ||
    node.routable === true ||
    !!String(node.routeNextHopId || '').trim() ||
    Number(node.routeMetric || 0) > 0 ||
    (Array.isArray(node.routePath) && node.routePath.length > 1)
}

function getLayeredTopologyStatus(node = {}, options = {}) {
  if (node.revoked === true) return 'revoked'
  if (node.enabled === false) return 'disabled'
  const id = String(node.id || node.phoneId || '').trim()
  const connected = Object.prototype.hasOwnProperty.call(options, 'connected')
    ? options.connected === true
    : (node.connected === true || hasActiveWsForNode(id))
  if (connected) return 'online'
  const trusted = options.trusted === true || !!node.pairingKey || !!lookupPeerPairingKey(id)
  const hasPath = options.hasPath === true || hasTopologyPathCandidate(node)
  if (trusted && hasPath && isRecentTopologyTimestamp(getTopologyFreshnessAt(node), options.recentMs)) {
    return 'reachable'
  }
  if (trusted && hasPath) return 'known'
  return 'offline'
}

function getPhoneTopologyStatus(phone) {
  return getLayeredTopologyStatus(phone, {
    connected: phone.connected === true || hasActiveWsForNode(phone.id)
  })
}

function normalizeTopologyDevice(device, fallback = {}) {
  if (!device) return null
  const id = String(device.id || device.deviceId || fallback.id || '').trim()
  if (!id) return null
  return {
    id,
    name: String(device.name || device.deviceName || fallback.name || id).trim(),
    type: String(device.type || device.deviceType || fallback.type || 'WINDOWS_DESKTOP').trim(),
    role: fallback.role || 'remote',
    status: fallback.status || 'offline',
    authority: fallback.authority || '',
    contentPolicy: normalizePushContentPolicy(device.contentPolicy || device || fallback),
    lastSeen: device.lastSeen || fallback.lastSeen || 0,
    lastIP: device.lastIP || device.host || fallback.lastIP || ''
  }
}

function getTopologyStatusPriority(status) {
  return {
    revoked: 7,
    disabled: 6,
    online: 5,
    reachable: 4,
    known: 3,
    synced: 2,
    discovered: 1,
    offline: 0
  }[status] ?? 0
}

function mergeTopologyNode(nodes, node) {
  if (!node || !node.id) return
  const existing = nodes.get(node.id)
  if (!existing) {
    nodes.set(node.id, node)
    return
  }
  nodes.set(node.id, {
    ...existing,
    ...node,
    name: node.name || existing.name,
    type: node.type || existing.type,
    role: existing.role === 'local_desktop' ? existing.role : (node.role || existing.role),
    status: getTopologyStatusPriority(existing.status) >= getTopologyStatusPriority(node.status)
      ? existing.status
      : (node.status || existing.status)
  })
}

function addTopologyEdge(edges, edge) {
  if (!edge || !edge.from || !edge.to) return
  const key = edge.id || `${edge.from}->${edge.to}:${edge.type || 'sync'}`
  const normalized = {
    ...edge,
    id: key,
    enabled: edge.enabled !== false,
    active: edge.active === true,
    routable: edge.routable === true
  }
  if (edge.metric || isRoutingTransportEdge(normalized)) {
    normalized.metric = edge.metric || getRouteEdgeMetric(normalized)
  }
  if (edges.has(key)) {
    const existing = edges.get(key)
    const merged = {
      ...existing,
      ...normalized,
      label: existing.label || normalized.label,
      description: existing.description || normalized.description,
      active: existing.active === true || normalized.active === true,
      routable: existing.routable === true || normalized.routable === true
    }
    if (isRoutingTransportEdge(merged)) {
      merged.metric = getRouteEdgeMetric(merged)
    }
    edges.set(key, merged)
    return
  }
  edges.set(key, normalized)
}

function isRoutingTransportEdge(edge) {
  return topologyManager.isRoutingTransportEdge(edge, ROUTE_TYPE_COST)
}

function getRouteEdgeMetric(edge) {
  return topologyManager.getRouteEdgeMetric(edge, {
    routeTypeCost: ROUTE_TYPE_COST,
    routeStaleMs: ROUTE_STALE_MS
  })
}

function buildLinkStateDatabase(nodes, edges) {
  return topologyManager.buildLinkStateDatabase(nodes, edges, {
    routeTypeCost: ROUTE_TYPE_COST,
    routeStaleMs: ROUTE_STALE_MS
  })
}

function computeShortestRoutesFrom(sourceId, lsdb) {
  return topologyManager.computeShortestRoutesFrom(sourceId, lsdb)
}

function computeLinkStateRoutes(nodes, edges) {
  return topologyManager.computeLinkStateRoutes(nodes, edges, {
    routeTypeCost: ROUTE_TYPE_COST,
    routeStaleMs: ROUTE_STALE_MS,
    protocolVersion: ROUTING_PROTOCOL_VERSION
  })
}

function getLocalTotpSeeds() {
  return Array.from(totpSeeds.values())
    .filter(seed => seed && seed.phoneId === LOCAL_TOTP_SOURCE_ID && seed.secret)
}

function getTopologySnapshot() {
  syncLocalTopologyIntoLsdb('snapshot')
  const identity = getDesktopIdentity()
  const nodes = new Map()
  const edges = new Map()
  const phones = getAuthorizedPhones()
  const desktopPeers = getPairedDesktopPeers()
  const lanDevices = getDiscoveredLanDevices()
  const localTotpSeeds = getLocalTotpSeeds()

  mergeTopologyNode(nodes, {
    id: identity.id,
    name: identity.name,
    type: identity.type,
    role: 'local_desktop',
    status: 'online',
    authority: 'local_desktop'
  })

  for (const node of topologyLsdb.nodes.values()) {
    if (!node.id) continue
    const lsdbConnected = node.id === identity.id || hasActiveWsForNode(node.id)
    const lsdbStatus = getLayeredTopologyStatus(node, { connected: lsdbConnected })
    mergeTopologyNode(nodes, {
      ...node,
      deviceType: node.type,
      status: lsdbStatus,
      enabled: node.enabled !== false,
      connected: lsdbConnected,
      lastSeen: node.lastSeen || node.updatedAt || 0,
      lastIP: node.lastIP || node.host || '',
      authority: node.authority || 'topology_gossip'
    })
  }

  phones.forEach(phone => {
    const status = getPhoneTopologyStatus(phone)
    mergeTopologyNode(nodes, {
      id: phone.id,
      name: phone.name || 'Android Phone',
      type: phone.deviceType || 'ANDROID_PHONE',
      role: String(phone.deviceType || '').includes('DESKTOP') ? 'desktop' : 'phone',
      status,
      enabled: phone.enabled !== false,
      revoked: phone.revoked === true,
      contentPolicy: normalizePushContentPolicy(phone.contentPolicy || phone),
      connected: phone.connected === true,
      lastSeen: phone.lastSeen || 0,
      lastIP: phone.lastIP || '',
      authority: 'source_device'
    })

    addTopologyEdge(edges, {
      id: `${phone.id}->${identity.id}:verify-push`,
      from: phone.id,
      to: identity.id,
      type: 'verify_push',
      label: '短信 / TOTP 推送',
      direction: 'inbound',
      enabled: phone.enabled !== false && phone.revoked !== true,
      active: phone.connected === true,
      authority: 'source_device',
      updatedAt: phone.lastSeen || 0,
      description: '手机作为来源设备，控制推送到当前设备节点的范围'
    })

    addTopologyEdge(edges, {
      id: `${identity.id}->${phone.id}:routing-adjacency`,
      from: identity.id,
      to: phone.id,
      type: 'routing_adjacency',
      label: '路由表同步邻接',
      direction: 'outbound',
      enabled: phone.enabled !== false && phone.revoked !== true,
      active: phone.connected === true,
      authority: 'link_state',
      updatedAt: phone.lastSeen || 0,
      description: '电脑节点向手机下发链路状态和 SPF 路由表'
    })

    if (localTotpSeeds.length > 0) {
      addTopologyEdge(edges, {
        id: `${identity.id}->${phone.id}:totp-sync`,
        from: identity.id,
        to: phone.id,
        type: 'totp_sync',
        label: `本机 TOTP 同步 (${localTotpSeeds.length})`,
        direction: 'outbound',
        enabled: phone.enabled !== false && phone.revoked !== true && canPushContentToNode(phone, 'totp'),
        active: phone.connected === true,
        authority: 'local_desktop',
        updatedAt: phone.lastSeen || 0,
        description: '本机节点添加的 TOTP 种子会在手机连接时同步给手机'
      })
    }
  })

  const routablePhones = phones.filter(phone =>
    phone.enabled !== false &&
    phone.revoked !== true &&
    phone.pairingKey &&
    phone.lastIP
  )
  for (const from of routablePhones) {
    for (const to of routablePhones) {
      if (from.id === to.id) continue
      const viaTailscale = isTailscaleAddress(from.lastIP) || isTailscaleAddress(to.lastIP) ||
        (!!from.tsHost && !!to.tsHost)
      addTopologyEdge(edges, {
        id: `${from.id}->${to.id}:phone-relay-route`,
        from: from.id,
        to: to.id,
        type: 'relay_route',
        label: viaTailscale ? '节点直连 relay (Tailscale)' : '节点直连 relay',
        direction: 'peer',
        enabled: true,
        active: from.connected === true && to.connected === true,
        authority: 'source_device',
        updatedAt: Math.max(from.lastSeen || 0, to.lastSeen || 0),
        description: `经 ${identity.name} 交换路由信息后，两个手机节点可直接同步短信和 TOTP`
      })
    }
  }

  desktopPeers.forEach(peer => {
    const status = getLayeredTopologyStatus(peer, {
      connected: peer.connected === true || hasActiveWsForNode(peer.id)
    })
    mergeTopologyNode(nodes, {
      id: peer.id,
      name: peer.name,
      type: peer.deviceType || 'WINDOWS_DESKTOP',
      role: 'desktop',
      status,
      enabled: peer.enabled !== false,
      contentPolicy: normalizePushContentPolicy(peer.contentPolicy || peer),
      connected: peer.connected === true,
      lastSeen: peer.lastSeen || 0,
      lastIP: peer.lastIP || peer.host || '',
      authority: 'desktop_owner'
    })

    addTopologyEdge(edges, {
      id: `${identity.id}->${peer.id}:desktop-pair`,
      from: identity.id,
      to: peer.id,
      type: 'desktop_pair',
      label: '桌面端种子同步',
      direction: 'outbound',
      enabled: peer.enabled !== false && canPushContentToNode(peer, 'totp'),
      active: peer.connected === true,
      authority: 'desktop_owner',
      updatedAt: peer.lastSeen || 0,
      description: '本机节点与局域网设备节点互相同步本机 TOTP 种子'
    })

    addTopologyEdge(edges, {
      id: `${peer.id}->${identity.id}:desktop-pair`,
      from: peer.id,
      to: identity.id,
      type: 'desktop_pair',
      label: '桌面端反向同步',
      direction: 'inbound',
      enabled: peer.enabled !== false,
      active: peer.connected === true,
      authority: 'desktop_owner',
      updatedAt: peer.lastSeen || 0,
      description: '对端节点连接后同步它管理的 TOTP 种子到本机'
    })
  })

  lanDevices.forEach(device => {
    const alreadyKnown = authorizedPhones.has(device.id) || pairedDesktopPeers.has(device.id)
    if (alreadyKnown) return
    mergeTopologyNode(nodes, {
      id: device.id,
      name: device.name,
      type: device.deviceType || 'UNKNOWN_DEVICE',
      role: String(device.deviceType || '').includes('PHONE') ? 'phone' : 'peer',
      status: 'discovered',
      enabled: false,
      connected: false,
      lastSeen: device.discoveredAt || 0,
      lastIP: device.host || '',
      authority: 'lan_discovery'
    })
    addTopologyEdge(edges, {
      id: `${identity.id}->${device.id}:lan-discovery`,
      from: identity.id,
      to: device.id,
      type: 'lan_discovery',
      label: '局域网发现',
      direction: 'outbound',
      enabled: false,
      active: false,
      authority: 'lan_discovery',
      updatedAt: device.discoveredAt || 0,
      description: '同一局域网内发现的 CodeBridge 对等节点；是否可同步仍取决于配对协议'
    })
  })

  for (const seed of totpSeeds.values()) {
    const source = normalizeTopologyDevice({
      id: seed.sourceDeviceId || seed.phoneId,
      name: seed.sourceDeviceName || seed.phoneName,
      type: seed.sourceDeviceType || (seed.phoneId === LOCAL_TOTP_SOURCE_ID ? identity.type : 'ANDROID_PHONE')
    }, {
      id: seed.phoneId || LOCAL_TOTP_SOURCE_ID,
      name: seed.phoneName || '未知设备',
      type: seed.phoneId === LOCAL_TOTP_SOURCE_ID ? identity.type : 'ANDROID_PHONE',
      role: seed.phoneId === LOCAL_TOTP_SOURCE_ID ? 'local_desktop' : 'source',
      status: seed.phoneId === LOCAL_TOTP_SOURCE_ID ? 'online' : 'offline',
      authority: seed.pushAuthority || 'source_device',
      lastSeen: seed.updatedAt || seed.createdAt || 0
    })

    if (source) {
      if (source.id === LOCAL_TOTP_SOURCE_ID) {
        source.id = identity.id
        source.name = identity.name
        source.type = identity.type
        source.role = 'local_desktop'
        source.status = 'online'
      }
      mergeTopologyNode(nodes, source)
    }

    const targets = Array.isArray(seed.targetDevices) ? seed.targetDevices : []
    targets.forEach(target => {
      const normalizedTarget = normalizeTopologyDevice(target, {
        type: 'WINDOWS_DESKTOP',
        role: target.id === identity.id ? 'local_desktop' : 'desktop',
        status: target.id === identity.id ? 'online' : 'offline'
      })
      if (!normalizedTarget) return
      if (normalizedTarget.id === identity.id) {
        normalizedTarget.role = 'local_desktop'
        normalizedTarget.status = 'online'
        normalizedTarget.name = identity.name
        normalizedTarget.type = identity.type
      }
      mergeTopologyNode(nodes, normalizedTarget)
      if (source && source.id !== normalizedTarget.id) {
        addTopologyEdge(edges, {
          id: `${source.id}->${normalizedTarget.id}:seed-${seed.id}`,
          from: source.id,
          to: normalizedTarget.id,
          type: 'totp_seed_scope',
          label: seed.label || 'TOTP 授权分发',
          direction: source.id === identity.id ? 'outbound' : 'inbound',
          enabled: true,
          active: normalizedTarget.id === identity.id,
          authority: seed.pushAuthority || 'source_device',
          updatedAt: seed.updatedAt || seed.createdAt || 0,
          description: '来源设备声明的验证码分发范围'
        })
      }
    })
  }

  for (const link of topologyLsdb.links.values()) {
    addTopologyEdge(edges, link)
  }

  const nodeList = Array.from(nodes.values()).map(node => ({
    ...node,
    statusLabel: getDeviceStatusLabel(node.status)
  }))
  const edgeList = Array.from(edges.values())
  const routing = computeLinkStateRoutes(nodeList, edgeList)
  const localRouteByDestination = new Map((routing.routeTables[identity.id] || []).map(route => [route.destinationId, route]))
  const routedNodeList = nodeList.map(node => {
    const route = localRouteByDestination.get(node.id)
    if (!route) return node
    return {
      ...node,
      routeMetric: route.metric,
      routeHopCount: route.hopCount,
      routeNextHopId: route.nextHopId,
      routeNextHopName: route.nextHopName,
      routePath: route.path,
      routePathLabels: route.pathLabels,
      routeUpdatedAt: route.updatedAt
    }
  })
  const localTotpCount = localTotpSeeds.length

  return {
    localNodeId: identity.id,
    nodes: routedNodeList,
    edges: edgeList,
    routes: routing.routes,
    routeTables: routing.routeTables,
    routing: {
      protocol: routing.protocol,
      version: routing.version,
      routeCount: routing.routes.length,
      updatedAt: routing.updatedAt
    },
    summary: {
      nodeCount: routedNodeList.length,
      edgeCount: edgeList.length,
      routeCount: routing.routes.length,
      phoneCount: phones.length,
      connectedPhoneCount: phones.filter(phone => phone.connected && phone.enabled !== false && phone.revoked !== true).length,
      desktopPeerCount: desktopPeers.length,
      desktopCount: routedNodeList.filter(node => String(node.type || '').includes('DESKTOP')).length,
      localTotpCount,
      remoteTotpCount: Array.from(totpSeeds.values()).filter(seed => seed.phoneId !== LOCAL_TOTP_SOURCE_ID).length
    },
    updatedAt: Date.now()
  }
}

function generateTotpCode(seed, timestampSeconds = Math.floor(Date.now() / 1000)) {
  return totpStore.generateTotpCode(seed, timestampSeconds)
}

function base32ToBuffer(base32) {
  return totpStore.base32ToBuffer(base32)
}

// 周期 ping 所有 WebSocket 连接（入站手机 + 出站桌面对端）。
// 一个周期内未回 pong 的连接视为静默断链，立即 terminate；terminate 会触发
// 各自的 close 处理（removeActivePhoneConnection / peer.connected=false），
// 进而 notifyPhonesChanged → broadcastTopologyToPhones 完成路由重收敛。
function startWsHeartbeat() {
  if (wsHeartbeatTimer) clearInterval(wsHeartbeatTimer)
  wsHeartbeatTimer = setInterval(() => {
    if (wss) {
      wss.clients.forEach(ws => {
        if (ws.isAlive === false) {
          ws.terminate()
          return
        }
        ws.isAlive = false
        try { ws.ping() } catch (e) { /* 连接已坏，等下个周期 terminate */ }
      })
    }
    for (const ws of activeDesktopPeerConnections.values()) {
      if (ws.readyState !== WebSocket.OPEN) continue
      if (ws.isAlive === false) {
        ws.terminate()
        continue
      }
      ws.isAlive = false
      try { ws.ping() } catch (e) { /* 同上 */ }
    }
  }, WS_HEARTBEAT_INTERVAL_MS)
}

function startWebSocketServer() {
  wss = new WebSocketServer({ port: WS_PORT })

  wss.on('error', (error) => {
    console.error('WebSocket server error:', error)
    if (error.code === 'EADDRINUSE') {
      showNotification('验证码同步启动失败', `端口 ${WS_PORT} 已被占用，请确认是否已有一个桌面端正在运行。`)
      showMainWindow()
    }
  })

  startWsHeartbeat()

  wss.on('connection', (ws, req) => {
    const clientIP = req.socket.remoteAddress
    let isAuthenticated = false
    let connectionSessionKey = null
    let connectionPhoneId = null
    let connectionPhoneName = null

    ws.isAlive = true
    ws.on('pong', () => { ws.isAlive = true })

    ws.on('message', (data) => {
      try {
        const message = JSON.parse(data.toString())

        if (message.type === 'auth') {
          const phoneId = normalizePhoneId(message.phoneId, clientIP)
          const phoneName = normalizePhoneName(message.phoneName, clientIP)
          const deviceType = normalizeDeviceType(message.deviceType || message.phoneDeviceType, 'ANDROID_PHONE')
          const phoneNonce = typeof message.phoneNonce === 'string' ? message.phoneNonce.trim() : ''
          const requestTopologyOnAuth = message.requestTopology === true

          // 只接受 authVersion 2（HMAC 派生会话密钥）。
          // 旧 v1 路径（明文比对 pairingKey、明文下发 sessionKey）在 ws:// 上等于把会话密钥
          // 直接交给同网段抓包者，已移除；旧版手机端需升级后才能连接。
          if (message.authVersion === 2 && isValidAuthToken(phoneId, phoneNonce, message.authToken)) {
            // 防重放：手机每次连接都用新随机 phoneNonce 计算 authToken，
            // 因此同一 (phoneId, phoneNonce) 在窗口期内只允许成功鉴权一次。
            // ws:// 是明文，抓到一帧合法 auth 原样重放即可把该手机 lastIP
            // 改成攻击者 IP，使后续 relay 投递重定向——这里堵住该口子。
            // 只在 token 校验通过后才消费 nonce，避免被无效帧刷爆记录表。
            if (isReplayedAuthNonce(phoneId, phoneNonce)) {
              console.warn(`Rejected replayed auth from ${phoneId}@${clientIP}`)
              ws.send(JSON.stringify({ type: 'auth_fail' }))
              ws.close()
              return
            }
            const phone = upsertAuthorizedPhone({
              phoneId,
              phoneName,
              clientIP,
              deviceType,
              // 兼容旧版手机在明文 auth 里携带 relay 信息；新版手机改为 auth_ok 后
              // 通过加密 node_info 消息上报（见下方 node_info 分支）
              pairingKey: message.nodePairingKey || message.pairingKeyForNode,
              relayPort: message.nodeRelayPort || message.relayPort,
              relayHost: message.nodeRelayHost || message.relayHost
            })
            if (!phone.enabled || phone.revoked) {
              ws.send(JSON.stringify({ type: 'auth_denied', reason: 'phone_disabled' }))
              ws.close()
              return
            }
            isAuthenticated = true
            connectionPhoneId = phone.id
            connectionPhoneName = phone.name
            const serverNonce = generateNonce()
            connectionSessionKey = deriveSessionKey(phoneNonce, serverNonce)
            addActivePhoneConnection(phone.id, ws)
            phoneSessionKeys.set(ws, connectionSessionKey)
            ws.send(JSON.stringify({
              type: 'auth_ok',
              keyMode: 'derived',
              serverNonce
            }))
            if (requestTopologyOnAuth) {
              sendTopologyToPhone(phone.id, ws, connectionSessionKey)
              requestTopologySnapshot(ws, connectionSessionKey)
            }
            // 鉴权成功的一刻顺带把本机 TOTP 种子下发给手机（一次性同步，零额外耗电）
            sendLocalTotpSeedsToPhone(ws, connectionSessionKey, phone.id)
            // 上线补推当前剪贴板状态：离线期间错过的值靠这里补齐（LWW 防旧盖新）。
            // 入站桌面对端走 WS（其客户端已处理 verify_code），手机走 relay HTTP
            if (String(phone.deviceType || '').includes('DESKTOP')) {
              pushClipboardStateToDesktopPeer(ws, connectionSessionKey, phone.id)
            } else {
              pushClipboardStateToPhone(phone)
            }
          } else {
            ws.send(JSON.stringify({ type: 'auth_fail' }))
            ws.close()
          }
          return
        }

        if (!isAuthenticated) {
          ws.send(JSON.stringify({ type: 'error', message: '未认证' }))
          return
        }

        // 手机在 auth_ok 后通过加密通道上报自己的 relay 密钥/端口，
        // 替代旧版在明文 auth 消息里携带 nodePairingKey 的做法
        if (message.type === 'node_info') {
          const plain = decryptMessage(message.payload, connectionSessionKey)
          if (plain) {
            try {
              const info = JSON.parse(plain)
              upsertAuthorizedPhone({
                phoneId: connectionPhoneId,
                phoneName: connectionPhoneName,
                clientIP,
                pairingKey: info.nodePairingKey,
                relayPort: info.nodeRelayPort,
                relayHost: info.nodeRelayHost,
                tsHost: info.nodeTsHost
              })
            } catch (e) {
              console.error('处理 node_info 失败:', e)
            }
          }
          return
        }

        if (message.type === 'topology_delta' || message.type === 'node_advertisement' || message.type === 'link_advertisement') {
          const msgId = typeof message.msgId === 'string' ? message.msgId : ''
          const plain = decryptMessage(message.payload, connectionSessionKey)
          if (plain) {
            applyTopologyDeltaPayload(plain, { excludeNodeId: connectionPhoneId })
            if (msgId) {
              ws.send(JSON.stringify({ type: 'code_ack', msgId }))
            }
          }
          return
        }

        if (message.type === 'topology_snapshot_request') {
          const plain = decryptMessage(message.payload, connectionSessionKey)
          if (plain) {
            const requestPayload = JSON.parse(plain)
            handleTopologySnapshotRequest(ws, connectionSessionKey, requestPayload)
          }
          return
        }

        if (message.type === 'bus_message') {
          const msgId = typeof message.msgId === 'string' ? message.msgId : ''
          const plain = decryptMessage(message.payload, connectionSessionKey)
          if (!plain) return
          const envelope = JSON.parse(plain)
          if (busEnvelope.isEnvelope(envelope)) {
            if (msgId && hasRecentDelivery(connectionPhoneId, msgId, busEnvelope.toLegacyPayload(envelope))) {
              ws.send(JSON.stringify({ type: 'code_ack', msgId }))
              return
            }
            getContentBus().receiveEnvelope(envelope, { lastHopDeviceId: connectionPhoneId })
            if (msgId) ws.send(JSON.stringify({ type: 'code_ack', msgId }))
