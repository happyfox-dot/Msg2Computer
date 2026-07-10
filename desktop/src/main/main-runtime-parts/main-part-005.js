          }
          return
        }

        if (message.type === 'totp_resync_request') {
          const phone = authorizedPhones.get(connectionPhoneId) || {
            id: connectionPhoneId,
            name: connectionPhoneName,
            deviceType: 'ANDROID_PHONE'
          }
          handleTotpResyncRequest(ws, connectionSessionKey, phone, message.payload)
          return
        }

        if (message.type === 'verify_code') {
          const msgId = typeof message.msgId === 'string' ? message.msgId : ''
          // 手机端 ACK 丢失后会重连重发同一 msgId：重复消息只补 ACK，不再次弹泡/写剪贴板
          if (msgId && hasRecentDelivery(connectionPhoneId, msgId)) {
            sendAuthenticatedCodeAck(ws, connectionSessionKey, msgId)
            return
          }
          const decrypted = decryptMessage(message.payload, connectionSessionKey)
          if (decrypted) {
            const codeData = JSON.parse(decrypted)
            codeData.msgId = codeData.msgId || msgId
            codeData.lastHopDeviceId = connectionPhoneId
            codeData.lastHopDeviceName = connectionPhoneName
            codeData.phoneId = codeData.phoneId || codeData.sourceDeviceId || connectionPhoneId
            codeData.phoneName = codeData.phoneName || codeData.sourceDeviceName || connectionPhoneName
            if (msgId && hasRecentDelivery(connectionPhoneId, msgId, codeData)) {
              sendAuthenticatedCodeAck(ws, connectionSessionKey, msgId)
              return
            }
            dispatchInboundCodeData(codeData, connectionPhoneId)
            if (msgId) {
              rememberDelivery(connectionPhoneId, msgId, codeData)
            }
            // 回 ACK：按需连接模型下手机收到 ACK 才安全断开，确保消息已落地
            sendAuthenticatedCodeAck(ws, connectionSessionKey, msgId)
          }
        }
      } catch (e) {
        console.error('消息处理错误:', e)
      }
    })

  })
}

function decryptMessage(encryptedBase64, keyBase64) {
  try {
    const key = Buffer.from(keyBase64, 'base64')
    const data = Buffer.from(encryptedBase64, 'base64')
    const iv = data.subarray(0, 12)
    const authTag = data.subarray(data.length - 16)
    const ciphertext = data.subarray(12, data.length - 16)

    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv)
    decipher.setAuthTag(authTag)
    let decrypted = decipher.update(ciphertext, null, 'utf8')
    decrypted += decipher.final('utf8')
    return decrypted
  } catch (e) {
    console.error('解密失败:', e)
    return null
  }
}

// 加密一段明文，输出与 Android CryptoUtil.decrypt 对齐的格式：base64( iv[12] + ciphertext + authTag[16] )
function encryptMessage(plaintext, keyBase64) {
  try {
    const key = Buffer.from(keyBase64, 'base64')
    const iv = crypto.randomBytes(12)
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
    const ciphertext = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()])
    const authTag = cipher.getAuthTag()
    return Buffer.concat([iv, ciphertext, authTag]).toString('base64')
  } catch (e) {
    console.error('加密失败:', e)
    return null
  }
}

// 二进制变体：加解密原始字节（文件分片用），返回/接收裸 Buffer 而非 base64，
// 避免网络上 +33% 膨胀。布局与上面一致：iv[12] + ciphertext + authTag[16]，
// 与安卓 CryptoUtil.encryptBytes/decryptBytes 互通。
function encryptBytes(plainBuffer, keyBase64) {
  try {
    const key = Buffer.from(keyBase64, 'base64')
    const iv = crypto.randomBytes(12)
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
    const ciphertext = Buffer.concat([cipher.update(plainBuffer), cipher.final()])
    const authTag = cipher.getAuthTag()
    return Buffer.concat([iv, ciphertext, authTag])
  } catch (e) {
    console.error('二进制加密失败:', e)
    return null
  }
}

function decryptBytes(encryptedBuffer, keyBase64) {
  try {
    const key = Buffer.from(keyBase64, 'base64')
    const data = Buffer.isBuffer(encryptedBuffer) ? encryptedBuffer : Buffer.from(encryptedBuffer)
    if (data.length < 12 + 16) return null
    const iv = data.subarray(0, 12)
    const authTag = data.subarray(data.length - 16)
    const ciphertext = data.subarray(12, data.length - 16)
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv)
    decipher.setAuthTag(authTag)
    return Buffer.concat([decipher.update(ciphertext), decipher.final()])
  } catch (e) {
    console.error('二进制解密失败:', e)
    return null
  }
}

// ==================== 文件传输通道（分片拉取） ====================

// 二进制 HTTP GET 客户端：拉取加密分片本体。现有 postJsonForResponse / relayClient
// 都强制 utf8/JSON 解码，无法承载二进制，这里单独实现，响应体保留为 Buffer。
function httpGetBinary({ host, port, path: reqPath, timeoutMs = 20000 }) {
  return new Promise(resolve => {
    let settled = false
    const done = value => {
      if (settled) return
      settled = true
      resolve(value)
    }
    try {
      const req = http.request(
        {
          hostname: normalizeNetworkHost(host),
          port: Number(port) || JOIN_PORT,
          path: reqPath,
          method: 'GET',
          timeout: timeoutMs
        },
        res => {
          const chunks = []
          res.on('data', chunk => chunks.push(chunk))
          res.on('end', () => done({ status: res.statusCode || 0, body: Buffer.concat(chunks) }))
        }
      )
      req.on('timeout', () => {
        req.destroy(new Error('file_chunk_timeout'))
      })
      req.on('error', () => done(null))
      req.end()
    } catch (_) {
      done(null)
    }
  })
}

// 服务分片时按 senderId 查共享 pairingKey（手机或桌面对端）
function lookupPeerPairingKey(deviceId) {
  const id = String(deviceId || '')
  if (!id) return null
  const phone = authorizedPhones.get(id)
  if (phone && phone.pairingKey && phone.enabled !== false && phone.revoked !== true) {
    return phone.pairingKey
  }
  const peer = pairedDesktopPeers.get(id)
  if (peer && peer.pairingKey && peer.enabled !== false) return peer.pairingKey
  const lsdbNode = topologyLsdb.nodes.get(id)
  if (lsdbNode && lsdbNode.pairingKey && lsdbNode.enabled !== false && lsdbNode.revoked !== true) {
    return lsdbNode.pairingKey
  }
  return null
}

// 拉取时按 originDeviceId 解析源设备的可达地址 + 共享密钥。
// host 可为空：直连不可达时由 resolveFileRelayCandidates 提供代理通道（多跳）。
function collectNetworkHosts(...values) {
  const hosts = []
  const add = value => {
    if (Array.isArray(value)) {
      value.forEach(add)
      return
    }
    const host = normalizeNetworkHost(value || '')
    if (host && !hosts.includes(host)) hosts.push(host)
  }
  values.forEach(add)
  return hosts
}

function resolveFileSource(originDeviceId, manifest = {}) {
  const id = String(originDeviceId || '')
  if (!id) return null
  const manifestHosts = collectNetworkHosts(
    manifest.host,
    manifest.sourceHost,
    manifest.tsHost,
    manifest.sourceTsHost,
    manifest.altHosts,
    manifest.sourceAltHosts
  )
  const phone = authorizedPhones.get(id)
  if (phone && phone.pairingKey) {
    const merged = mergeTrustedNodeRecord(id, phone)
    const hosts = collectNetworkHosts(
      merged.lastIP,
      merged.host,
      merged.relayHost,
      merged.tsHost,
      merged.altHosts,
      manifestHosts
    )
    return {
      id,
      name: merged.name || 'Android Phone',
      host: hosts[0] || '',
      hosts,
      port: Number(merged.relayPort || merged.port) || JOIN_PORT,
      pairingKey: merged.pairingKey,
      type: merged.deviceType || merged.type || 'ANDROID_PHONE'
    }
  }
  const peer = pairedDesktopPeers.get(id)
  if (peer && peer.pairingKey) {
    const merged = mergeTrustedNodeRecord(id, peer)
    const hosts = collectNetworkHosts(
      merged.lastIP,
      merged.host,
      merged.relayHost,
      merged.tsHost,
      merged.altHosts,
      manifestHosts
    )
    return {
      id,
      name: merged.name || 'Desktop PC',
      host: hosts[0] || '',
      hosts,
      port: Number(merged.relayPort || merged.port) || JOIN_PORT,
      pairingKey: merged.pairingKey,
      type: merged.deviceType || merged.type || 'WINDOWS_DESKTOP'
    }
  }
  const lsdbNode = topologyLsdb.nodes.get(id)
  if (lsdbNode && lsdbNode.pairingKey && lsdbNode.enabled !== false && lsdbNode.revoked !== true) {
    const merged = mergeTrustedNodeRecord(id, lsdbNode)
    const hosts = collectNetworkHosts(
      merged.lastIP,
      merged.host,
      merged.relayHost,
      merged.tsHost,
      merged.altHosts,
      manifestHosts
    )
    return {
      id,
      name: merged.name || 'Device Node',
      host: hosts[0] || '',
      hosts,
      port: Number(merged.relayPort || merged.port) || JOIN_PORT,
      pairingKey: merged.pairingKey,
      type: merged.deviceType || merged.type || 'DEVICE_NODE'
    }
  }
  return null
}

// 源不可直达时的分片代理候选：通向源的拓扑 next hop 优先，其后是其它
// 可达的可信节点。排除源自身与本机。
function resolveFileRelayCandidates(originId) {
  const exclude = String(originId || '')
  const identity = getDesktopIdentity()
  const candidates = []
  const excludedIds = new Set([exclude, identity.id])
  const seen = new Set()
  const add = (id, host, port, name) => {
    const normalizedHost = normalizeNetworkHost(host || '')
    if (!id || !normalizedHost || excludedIds.has(id)) return
    const normalizedPort = Number(port) || JOIN_PORT
    const key = `${id}|${normalizedHost}|${normalizedPort}`
    if (seen.has(key)) return
    seen.add(key)
    candidates.push({ id, host: normalizedHost, port: normalizedPort, name: name || id })
  }
  try {
    const snapshot = getTopologySnapshot()
    const routes = snapshot.routeTables?.[identity.id] || []
    for (const route of routes) {
      if (String(route.destinationId || route.to || '') !== exclude) continue
      const hopId = String(route.nextHopId || route.via || '')
      if (!hopId || hopId === exclude) continue
      const hop = authorizedPhones.get(hopId) || pairedDesktopPeers.get(hopId)
      if (hop && hop.enabled !== false && hop.revoked !== true) {
        for (const host of collectNetworkHosts(hop.lastIP, hop.host, hop.relayHost, hop.tsHost, hop.altHosts)) {
          add(hopId, host, hop.relayPort || JOIN_PORT, hop.name)
        }
      }
    }
  } catch (_) {}
  for (const phone of getAuthorizedPhones()) {
    if (phone.enabled === false || phone.revoked === true) continue
    for (const host of collectNetworkHosts(phone.lastIP, phone.host, phone.relayHost, phone.tsHost, phone.altHosts)) {
      add(phone.id, host, phone.relayPort || JOIN_PORT, phone.name)
    }
  }
  for (const peer of getPairedDesktopPeers()) {
    if (peer.enabled === false) continue
    for (const host of collectNetworkHosts(peer.lastIP, peer.host, peer.relayHost, peer.tsHost, peer.altHosts)) {
      add(peer.id, host, peer.relayPort || JOIN_PORT, peer.name)
    }
  }
  for (const node of topologyLsdb.nodes.values()) {
    if (!node || node.enabled === false || node.revoked === true || !node.pairingKey) continue
    for (const host of collectNetworkHosts(node.lastIP, node.host, node.relayHost, node.tsHost, node.altHosts)) {
      add(node.id, host, node.relayPort || node.port || JOIN_PORT, node.name)
    }
  }
  return candidates.slice(0, 12)
}

let fileTransfer = null

function initFileTransfer() {
  if (fileTransfer) return fileTransfer
  const tmpDir = path.join(app.getPath('userData'), 'file-transfers')
  const downloadDir = getFileTransferDownloadDir()
  fileTransfer = createFileTransfer({
    getIdentity: getDesktopIdentity,
    encryptBytes,
    decryptBytes,
    hmacBase64,
    generateNonce,
    // manifest 下发：复用现有 relay/WS 广播逻辑（同剪贴板路径，含多跳/去重）
    sendManifest: async (targetIds, basePayload) => broadcastFileManifestToNodes(targetIds, basePayload),
    lookupPeerKey: lookupPeerPairingKey,
    resolveSource: resolveFileSource,
    resolveRelayCandidates: resolveFileRelayCandidates,
    httpGet: httpGetBinary,
    downloadDir,
    tmpDir,
    onComplete: ({ fileId, name, path: finalPath, size, mime, sourceId, sourceName, sourceType }) => {
      const historyEntry = recordFileTransferHistory({
        fileId,
        name,
        path: finalPath,
        size,
        mime,
        sourceId,
        sourceName,
        sourceType
      })
      showNotification('📁 文件接收完成', `${name}\n来源设备: ${sourceName || '未知'}`)
      if (mainWindow) {
        mainWindow.webContents.send('file-transfer-complete', {
          fileId,
          name,
          path: finalPath,
          size,
          mime,
          sourceId,
          sourceName,
          sourceType,
          historyEntry
        })
        mainWindow.webContents.send('file-transfer-history-changed', getFileTransferHistory())
      }
    },
    onProgress: ({ fileId, name, received, size }) => {
      if (mainWindow) {
        mainWindow.webContents.send('file-transfer-progress', { fileId, name, received, size })
      }
    },
    onError: ({ phase, error }) => {
      console.error(`文件传输错误 [${phase}]: ${error}`)
    },
    log: msg => console.log(msg)
  })
  return fileTransfer
}

// manifest 下发：与 broadcastClipboardToNodes 同款分流（桌面对端走 WS verify_code，
// 手机走 relay HTTP），但只发 manifest 不发本体。targetIds 限定为 offer 的目标。
async function broadcastFileManifestToNodes(targetIds, basePayload) {
  const targets = new Set((Array.isArray(targetIds) ? targetIds : []).map(String))
  const relayPath = [getDesktopIdentity().id]
  const payloadType = String(basePayload?.type || '')
  const topic = payloadType === CODE_TYPES.CLIPBOARD_TEXT || payloadType === CODE_TYPES.CLIPBOARD
    ? busEnvelope.TOPICS.CLIPBOARD_TEXT
    : payloadType === CODE_TYPES.CLIPBOARD_IMAGE
    ? busEnvelope.TOPICS.CLIPBOARD_IMAGE
    : payloadType === CODE_TYPES.CLIPBOARD_FILE
      ? busEnvelope.TOPICS.CLIPBOARD_FILE
      : busEnvelope.TOPICS.FILE_MANIFEST
  const payload = {
    ...basePayload,
    relayPath,
    relayTtl: USER_MESSAGE_RELAY_TTL
  }
  const result = await getContentBus().publish(topic, payload, {
    targetNodeIds: Array.from(targets),
    ttl: USER_MESSAGE_RELAY_TTL,
    routePath: relayPath
  })
  return result.delivered
}

const ONGOING_NOTIFICATION_BUBBLE_KEY_TTL_MS = 6 * 60 * 60 * 1000
const ONGOING_NOTIFICATION_BUBBLE_KEY_LIMIT = 300
const ongoingNotificationBubbleKeys = new Map()

function pruneOngoingNotificationBubbleKeys(now = Date.now()) {
  for (const [key, seenAt] of ongoingNotificationBubbleKeys.entries()) {
    if (!Number.isFinite(seenAt) || now - seenAt > ONGOING_NOTIFICATION_BUBBLE_KEY_TTL_MS) {
      ongoingNotificationBubbleKeys.delete(key)
    }
  }
  while (ongoingNotificationBubbleKeys.size > ONGOING_NOTIFICATION_BUBBLE_KEY_LIMIT) {
    const oldestKey = ongoingNotificationBubbleKeys.keys().next().value
    if (!oldestKey) break
    ongoingNotificationBubbleKeys.delete(oldestKey)
  }
}

function hasOngoingNotificationBubbleKey(key, now = Date.now()) {
  if (!key) return false
  pruneOngoingNotificationBubbleKeys(now)
  return ongoingNotificationBubbleKeys.has(key)
}

function rememberOngoingNotificationBubbleKey(key, now = Date.now()) {
  if (!key) return
  pruneOngoingNotificationBubbleKeys(now)
  if (ongoingNotificationBubbleKeys.has(key)) ongoingNotificationBubbleKeys.delete(key)
  ongoingNotificationBubbleKeys.set(key, now)
  pruneOngoingNotificationBubbleKeys(now)
}

function handleVerifyCode(codeData) {
  const {
    code,
    source,
    type,
    contentType,
    timestamp,
    label,
    title,
    appName,
    packageName,
    notificationKey,
    notificationOngoing,
    notificationPostTime,
    phoneId,
    phoneName,
    rawMessage,
    messageBody,
    body,
    sourceDeviceId,
    sourceDeviceName,
    sourceDeviceType,
    targetDevices,
    targetDeviceIds,
    pushAuthority,
    pushAuthorityDeviceId,
    originMessageId,
    relayMessageId,
    originDeviceId,
    originDeviceName,
    lastHopDeviceId,
    lastHopDeviceName,
    msgId,
    fileManifest,
    dataBase64,
    clipVersion,
    batchId,
    expiresAt
  } = codeData
  const desktopIdentity = getDesktopIdentity()
  const normalizedTargets = Array.isArray(targetDevices)
    ? targetDevices
    : (Array.isArray(targetDeviceIds) ? targetDeviceIds.map(id => ({ id })) : [])
  const normalizedType = contentType || type || CODE_TYPES.SMS
  if (!canReceiveContentType(normalizedType)) {
    console.log('Message skipped by receive policy:', normalizedType)
    return
  }

  const codeInfo = {
    code: code || '',
    source: source || '未知',
    type: normalizedType,
    contentType: normalizedType,
    timestamp: timestamp || Date.now(),
    label: label || '',
    title: title || '',
    appName: appName || '',
    packageName: packageName || '',
    notificationKey: notificationKey || '',
    notificationOngoing: !!notificationOngoing,
    notificationPostTime: notificationPostTime || 0,
    phoneId: phoneId || '',
    phoneName: phoneName || '未知手机',
    sourceDeviceId: sourceDeviceId || phoneId || '',
    sourceDeviceName: sourceDeviceName || phoneName || '未知手机',
    sourceDeviceType: sourceDeviceType || 'ANDROID_PHONE',
    targetDeviceId: desktopIdentity.id,
    targetDeviceName: desktopIdentity.name,
    targetDeviceType: desktopIdentity.type,
    targetDevices: normalizedTargets,
    pushAuthority: pushAuthority || 'source_device',
    pushAuthorityDeviceId: pushAuthorityDeviceId || sourceDeviceId || phoneId || '',
    originMessageId: originMessageId || relayMessageId || msgId || '',
    relayMessageId: relayMessageId || '',
    originDeviceId: originDeviceId || sourceDeviceId || phoneId || '',
    originDeviceName: originDeviceName || sourceDeviceName || phoneName || '',
    lastHopDeviceId: lastHopDeviceId || '',
    lastHopDeviceName: lastHopDeviceName || '',
    topology: {
      source: {
        id: sourceDeviceId || phoneId || '',
        name: sourceDeviceName || phoneName || '未知手机',
        type: sourceDeviceType || 'ANDROID_PHONE'
      },
      currentTarget: desktopIdentity,
      allTargets: normalizedTargets
    },
    rawMessage: rawMessage || messageBody || body || '',
    fileManifest: fileManifest || null,
    dataBase64: dataBase64 || '',
    clipVersion: clipVersion || null,
    batchId: batchId || '',
    expiresAt: Number(expiresAt || 0) || 0
  }

  let codeInfoEmitted = false
  const emitCodeInfo = (info = codeInfo) => {
    if (codeInfoEmitted || !mainWindow) return false
    codeInfoEmitted = true
    if (hasRecentClipboardUi(info)) return false
    rememberRecentClipboardUi(info)
    mainWindow.webContents.send('new-code', info)
    return true
  }

  if (!isClipboardStateType(codeInfo.type)) {
    emitCodeInfo()
  }

  // 三种用户消息都走气泡堆叠展示；系统通知（Windows 通知中心）同时保留。
  if (codeInfo.type === CODE_TYPES.SMS && codeInfo.code) {
    showCodeBubble(codeInfo)
    showNotification('📩 新验证码', `${codeInfo.code}\n来源: ${codeInfo.source}\n手机: ${codeInfo.phoneName}`)
    // 验证码自动复制是本机便利功能：先同步轮询快照再写入，避免剪贴板同步
    // 把它当成「本机新复制」广播出去——否则同一条验证码会以剪贴板同步的
    // 身份在各节点二次弹出/写回源手机（短信推送本身已送达所有目标）
    lastClipboardText = codeInfo.code
    clipboard.writeText(codeInfo.code)
  } else if (codeInfo.type === CODE_TYPES.SMS_MESSAGE) {
    const preview = codeInfo.rawMessage || codeInfo.source
    showCodeBubble(codeInfo)
    showNotification('📨 新短信', `${preview}\n来源设备: ${codeInfo.sourceDeviceName}`)
  } else if (codeInfo.type === CODE_TYPES.APP_NOTIFICATION) {
    const titleText = codeInfo.title || codeInfo.appName || codeInfo.source
    const bodyText = codeInfo.rawMessage || ''
    const ongoingKey = codeInfo.notificationOngoing && codeInfo.notificationKey
      ? `${codeInfo.sourceDeviceId || codeInfo.phoneId || ''}|${codeInfo.notificationKey}`
      : ''
    const now = Date.now()
    const shouldNotify = !ongoingKey || !hasOngoingNotificationBubbleKey(ongoingKey, now)
    if (ongoingKey) rememberOngoingNotificationBubbleKey(ongoingKey, now)
    if (shouldNotify) {
      showCodeBubble(codeInfo)
      showNotification(`🔔 ${codeInfo.appName || '新通知'}`, `${titleText}\n${bodyText}\n来源设备: ${codeInfo.sourceDeviceName}`)
    }
  } else if (codeInfo.type === CODE_TYPES.APP_NOTIFICATION_REMOVED) {
    const ongoingKey = codeInfo.notificationKey
      ? `${codeInfo.sourceDeviceId || codeInfo.phoneId || ''}|${codeInfo.notificationKey}`
      : ''
    if (ongoingKey) ongoingNotificationBubbleKeys.delete(ongoingKey)
  } else if (codeInfo.type === CODE_TYPES.CLIPBOARD || codeInfo.type === CODE_TYPES.CLIPBOARD_TEXT) {
    const textManifest = codeInfo.fileManifest || (codeData && codeData.fileManifest) || {}
    if (textManifest.inline === false && textManifest.fileId) {
      handleIncomingClipboardTextManifest(codeInfo, codeData, textManifest, emitCodeInfo)
      // 超长文本：业务上仍是剪贴板文本，底层用文件分片拉取，完成后写剪贴板。
    } else if (applyRemoteClipboard(codeInfo, codeData)) {
      emitCodeInfo()
      // LWW 应用；状态前进时把同一版本继续 gossip 给本机授权邻居（见剪贴板同步小节）
      gossipClipboardState(codeData)
    }
  } else if (codeInfo.type === CODE_TYPES.CLIPBOARD_IMAGE) {
    const imageManifest = codeInfo.fileManifest || (codeData && codeData.fileManifest) || {}
    if (imageManifest.inline === false && imageManifest.fileId) {
      // 大图（>inline 上限）：分片拉取后写剪贴板，见 handleIncomingClipboardImageManifest
      if (isIncomingClipboardImageCandidateNew(codeInfo, codeData, imageManifest)) {
        handleIncomingClipboardImageManifest(codeInfo, codeData, imageManifest, emitCodeInfo)
      }
    } else if (applyRemoteClipboardImage(codeInfo, codeData)) {
      emitCodeInfo()
      gossipClipboardImageState(codeData)
    }
  } else if (codeInfo.type === CODE_TYPES.FILE_TRANSFER || codeInfo.type === CODE_TYPES.CLIPBOARD_FILE) {
    // 文件传输：manifest 已到达，按策略决定是否回连源设备拉取本体（分片）。
    // 接收开关 + 大小上限 + autoAcceptFiles 三道闸；非自动接收则弹确认对话框。
    handleIncomingFileManifest(codeInfo, codeData)
  }
}

function handleIncomingClipboardTextManifest(codeInfo, codeData, manifest, onApplied = null) {
  const mime = String(manifest.mime || '').toLowerCase()
  if (mime && !mime.startsWith('text/plain') && !mime.startsWith('text/markdown') && mime !== 'application/octet-stream') return
  const maxBytes = Math.max(1, Number(desktopMessageSettings.maxFileSizeMb || 50)) * 1024 * 1024
  const size = Number(manifest.size || 0)
  if (size <= 0 || size > maxBytes) return
  const version = (codeData && codeData.clipVersion) || {}
  const ts = Number(version.ts) || Number(codeInfo.timestamp) || 0
  const origin = String(version.origin || codeInfo.originDeviceId || codeInfo.sourceDeviceId || '')
  const shortHash = String(version.hash || manifest.sha256 || '').slice(0, 24)
  if (shortHash && isSameGlobalClipHash(shortHash)) return
  if (!isNewerClipVersion(ts, origin)) return
  const inDir = path.join(app.getPath('userData'), 'clipboard-text-in')
  initFileTransfer().startIncomingPull(manifest, {
    maxBytes,
    targetDir: inDir,
    onComplete: ({ path: finalPath }) => {
      try {
        const text = fs.readFileSync(finalPath, 'utf8')
        if (!text) return
        const actualHash = hashClipText(text)
        if (shortHash && actualHash !== shortHash) return
        if (isSameGlobalClipHash(actualHash)) return
        if (!isNewerClipVersion(ts, origin)) return
        clipboard.writeText(text)
        lastClipboardText = text
        clearIncomingClipboardFiles()
        rememberClipVersion(ts, origin, text)
        const info = { ...codeInfo, rawMessage: text }
        if (typeof onApplied === 'function') onApplied(info)
        offerClipboardTextAsFile(text, ts, actualHash, { origin }).catch(error => {
          console.error('剪贴板长文本 gossip 失败:', error.message)
        })
      } catch (e) {
        console.error('剪贴板长文本应用失败:', e.message)
      } finally {
        try { fs.unlinkSync(finalPath) } catch (_) {}
      }
    }
  }).catch(err => {
    console.error('剪贴板长文本拉取失败:', err)
  })
}

// 大图剪贴板（>inline 上限）：manifest + 分片拉取，完成后写本机剪贴板。
// 与文件传输不同：不弹确认框（已受 syncClipboardImage 接收开关把关）、
// 不落下载目录、应用后即删。拉取前先做 LWW 预检，避免下载旧版本。
function isIncomingClipboardImageCandidateNew(codeInfo, codeData, manifest = {}) {
  const version = (codeData && codeData.clipVersion) || {}
  const ts = Number(version.ts) || Number(codeInfo.timestamp) || 0
  const origin = String(version.origin || codeInfo.originDeviceId || codeInfo.sourceDeviceId || '')
  const shortHash = String(version.hash || manifest.sha256 || '').slice(0, 24)
  if (shortHash && isSameGlobalClipHash(shortHash)) return false
  return isNewerClipImageVersion(ts, origin)
}

function handleIncomingClipboardImageManifest(codeInfo, codeData, manifest, onApplied = null) {
  if (!normalizeClipboardImageMime(manifest.mime)) return
  const maxBytes = Math.max(1, Number(desktopMessageSettings.maxFileSizeMb || 50)) * 1024 * 1024
  const size = Number(manifest.size || 0)
  if (size <= 0 || size > maxBytes) return
  const version = (codeData && codeData.clipVersion) || {}
  const ts = Number(version.ts) || Number(codeInfo.timestamp) || 0
  const origin = String(version.origin || codeInfo.originDeviceId || codeInfo.sourceDeviceId || '')
  const shortHash = String(manifest.sha256 || '').slice(0, 24)
  if (shortHash && isSameGlobalClipHash(shortHash)) return
  if (!isNewerClipImageVersion(ts, origin)) return
  const inDir = path.join(app.getPath('userData'), 'clipboard-images-in')
  initFileTransfer().startIncomingPull(manifest, {
    maxBytes,
    targetDir: inDir,
    onComplete: ({ path: finalPath }) => {
      try {
        const buffer = fs.readFileSync(finalPath)
        const image = nativeImage.createFromBuffer(buffer)
        if (!image.isEmpty()) {
          const appliedHash = shortHash || hashBuffer(buffer).slice(0, 24)
          if (isSameGlobalClipHash(appliedHash)) return
          if (!isNewerClipImageVersion(ts, origin)) return
          clipboard.writeImage(image)
          clearIncomingClipboardFiles()
          rememberClipImageVersion(ts, origin, appliedHash)
          refreshClipboardImageSnapshotAfterWrite(appliedHash)
          if (typeof onApplied === 'function') onApplied(codeInfo)
        }
      } catch (e) {
        console.error('剪贴板大图应用失败:', e.message)
      }
      try { fs.unlinkSync(finalPath) } catch (_) {}
    }
  }).catch(err => {
    console.error('剪贴板大图拉取失败:', err)
  })
}

// 收到 file_transfer / clipboard_file 的 manifest 后的接收决策与拉取启动。
// manifest 本身是小 JSON（走 relay 通道已鉴权/去重）；本体走 file-transfer.js
// 的分片 GET 拉取。这里负责策略闸门与（必要时）用户确认。
// 带 batchId 的 manifest 同批只确认一次，结论对整批生效（含确认后才到达的）。
const fileBatchDecisions = new Map() // batchId -> { status, queue, expiresAt }
const fileManifestDecisions = new Map() // manifestKey -> { status, started, expiresAt }
const FILE_MANIFEST_DECISION_TTL_MS = 10 * 60 * 1000

function pruneFileBatchDecisions() {
  const now = Date.now()
  for (const [batchId, entry] of fileBatchDecisions) {
    if (now > entry.expiresAt) fileBatchDecisions.delete(batchId)
  }
  for (const [manifestKey, entry] of fileManifestDecisions) {
    if (now > entry.expiresAt) fileManifestDecisions.delete(manifestKey)
  }
}

function fileManifestPromptKey(codeInfo = {}, codeData = {}, manifest = {}) {
  const source = String(
    codeInfo.originDeviceId ||
    codeInfo.sourceDeviceId ||
    codeInfo.phoneId ||
    manifest.originDeviceId ||
    ''
  ).trim()
  const identity = String(
    manifest.fileId ||
    manifest.sha256 ||
    codeInfo.originMessageId ||
    codeInfo.relayMessageId ||
    codeData.originMessageId ||
    ''
  ).trim()
  const fallback = [
    String(manifest.name || ''),
    String(manifest.size || ''),
    String(manifest.updatedAt || manifest.createdAt || codeInfo.timestamp || '')
  ].join('|')
  return `${source}|${identity || fallback}`
}

function incomingClipboardFileKey(codeInfo, codeData, manifest) {
  return clipboardFileSession.incomingClipboardFileKey(codeInfo, codeData, manifest)
}

function incomingClipboardVersion(codeInfo = {}, codeData = {}, manifest = {}, kind = 'file') {
  const version = (codeData && codeData.clipVersion) || codeInfo.clipVersion || {}
  return {
    ts: Number(version.ts) || Number(codeInfo.timestamp) || 0,
    origin: String(version.origin || codeInfo.originDeviceId || codeInfo.sourceDeviceId || ''),
    hash: String(version.hash || version.signature || manifest.sha256 || '').slice(0, 24),
    kind
  }
}

function isIncomingClipboardVersionNewer(version = {}) {
  if (version.hash && isSameGlobalClipHash(version.hash)) return false
  return clipboardVersion.isNewerClipboardVersion(clipboardGlobalSyncState, version)
}

function isSameGlobalClipVersion(version = {}) {
  const current = clipboardVersion.normalizeClipboardVersion(clipboardGlobalSyncState)
  const incoming = clipboardVersion.normalizeClipboardVersion(version)
  return incoming.ts > 0 &&
    current.ts === incoming.ts &&
    current.origin === incoming.origin &&
    (!incoming.hash || current.hash === incoming.hash)
}

function isIncomingClipboardVersionApplicable(version = {}) {
  return isSameGlobalClipVersion(version) || isIncomingClipboardVersionNewer(version)
}

function handleIncomingClipboardFileManifest(codeInfo, codeData, manifest) {
  const maxFileSizeMb = Math.max(1, Number(desktopMessageSettings.maxFileSizeMb || 50))
  const maxBytes = maxFileSizeMb * 1024 * 1024
  const size = Number(manifest.size || 0)
  if (size <= 0 || size > maxBytes) return
  const expectedCount = Math.max(
    Number((codeData && codeData.clipboardFileCount) || 0),
    Number(codeInfo.clipboardFileCount || 0),
    Number((codeData && codeData.batchCount) || 0),
    Number(codeInfo.batchCount || 0)
  )
  const sessionKeyCandidate = incomingClipboardFileKey(codeInfo, codeData, manifest)
  const version = incomingClipboardVersion(codeInfo, codeData, manifest, 'file')
  if (incomingClipboardFileSession.key !== sessionKeyCandidate &&
    !isIncomingClipboardVersionApplicable(version)
  ) {
    return
  }
  const session = ensureIncomingClipboardFileSession(sessionKeyCandidate, expectedCount, version)
  const sessionKey = session.key
  initFileTransfer().startIncomingPull(manifest, {
    maxBytes,
    targetDir: incomingClipboardFileTempDir(),
    onComplete: ({ path: finalPath, name }) => {
      if (incomingClipboardFileSession.key !== sessionKey) {
        try { fs.unlinkSync(finalPath) } catch (_) {}
        return
      }
      if (manifest.fileId) session.fileIds.add(String(manifest.fileId))
      session.paths.add(finalPath)
      scheduleIncomingClipboardFileFlush(sessionKey, codeInfo, name || path.basename(finalPath))
    }
  }).catch(err => {
    console.error('Clipboard file pull failed:', err)
  })
}

function handleIncomingFileManifest(codeInfo, codeData) {
  const manifest = codeInfo.fileManifest || (codeData && codeData.fileManifest) || null
  if (!manifest || !manifest.fileId || manifest.inline === true) return
  if (codeInfo.type === CODE_TYPES.CLIPBOARD_FILE) {
    handleIncomingClipboardFileManifest(codeInfo, codeData, manifest)
    return
  }
  // 接收开关（file_transfer 受 receiveFileTransfer 把关；canReceiveContentType 已在
  // 调用前校验过类型接收开关，这里再取大小上限与自动接收策略）
  const maxFileSizeMb = Math.max(1, Number(desktopMessageSettings.maxFileSizeMb || 50))
  const maxBytes = maxFileSizeMb * 1024 * 1024
  const size = Number(manifest.size || 0)
  if (size <= 0) return
  if (size > maxBytes) {
    showNotification('📁 文件被拒收', `${manifest.name || '文件'} 超出大小上限 ${maxFileSizeMb}MB`)
    return
  }
  const sourceName = codeInfo.sourceDeviceName || codeInfo.phoneName || manifest.originDeviceName || '未知设备'
  const autoAccept = desktopMessageSettings.autoAcceptFiles === true
  const beginPull = () => {
    initFileTransfer().startIncomingPull(manifest, { maxBytes }).catch(err => {
      console.error('文件拉取启动失败:', err)
    })
  }
  if (autoAccept) {
    beginPull()
    return
  }

  pruneFileBatchDecisions()
  const batchId = String((codeData && codeData.batchId) || codeInfo.batchId || '')
  if (!batchId) {
    // 非批量：同一 manifest 在对端重试/多路径 relay 时只弹一次。
    const promptKey = fileManifestPromptKey(codeInfo, codeData, manifest)
    const existing = fileManifestDecisions.get(promptKey)
    if (existing) {
      if (existing.status === 'accepted' && !existing.started) {
        existing.started = true
        beginPull()
      }
      return
    }
    const entry = {
      status: 'pending',
      started: false,
      expiresAt: Date.now() + FILE_MANIFEST_DECISION_TTL_MS
    }
    fileManifestDecisions.set(promptKey, entry)
    dialog.showMessageBox(mainWindow || undefined, {
      type: 'question',
      buttons: ['接收', '拒绝'],
      defaultId: 0,
      cancelId: 1,
      title: '文件传输请求',
      message: `${sourceName} 想发送文件`,
      detail: `${manifest.name || '文件'}（${formatBytes(size)}）\n来自: ${sourceName}`
    }).then(result => {
      entry.status = result.response === 0 ? 'accepted' : 'rejected'
      entry.expiresAt = Date.now() + FILE_MANIFEST_DECISION_TTL_MS
      if (entry.status === 'accepted' && !entry.started) {
        entry.started = true
        beginPull()
      }
    }).catch(err => {
      fileManifestDecisions.delete(promptKey)
      console.error('文件接收确认对话框失败:', err)
    })
    return
  }

  const existing = fileBatchDecisions.get(batchId)
  if (existing) {
    if (existing.status === 'accepted') beginPull()
    else if (existing.status === 'pending') existing.queue.push(beginPull)
    // rejected：同批余下文件静默丢弃
    return
  }
  const entry = {
    status: 'pending',
    queue: [beginPull],
    expiresAt: Date.now() + 10 * 60 * 1000
  }
  fileBatchDecisions.set(batchId, entry)
  const batchCount = Number((codeData && codeData.batchCount) || codeInfo.batchCount) || 0
  const batchTotalBytes = Number((codeData && codeData.batchTotalBytes) || codeInfo.batchTotalBytes) || 0
  const countText = batchCount > 1 ? `${batchCount} 个文件` : '文件'
  dialog.showMessageBox(mainWindow || undefined, {
    type: 'question',
    buttons: ['全部接收', '全部拒绝'],
    defaultId: 0,
    cancelId: 1,
    title: '文件传输请求',
    message: `${sourceName} 想发送 ${countText}`,
    detail: `${manifest.name || '文件'}${batchCount > 1 ? ` 等 ${countText}` : ''}（共 ${formatBytes(batchTotalBytes || size)}）\n来自: ${sourceName}\n本次选择对整批文件生效`
  }).then(result => {
    entry.status = result.response === 0 ? 'accepted' : 'rejected'
    const queued = entry.queue.splice(0)
    if (entry.status === 'accepted') queued.forEach(fn => fn())
  }).catch(err => {
    fileBatchDecisions.delete(batchId)
    console.error('文件接收确认对话框失败:', err)
  })
}

function handleTotpSeed(seedData) {
  const seed = upsertTotpSeed(seedData)
  if (!seed) {
    showNotification('TOTP 同步失败', '收到的 TOTP 密钥格式无效。')
    return
  }

  showNotification('TOTP 已同步', `${seed.label}\n来源: ${seed.phoneName}`)
}

function handleTotpRevoke(revokeData) {
  const removed = revokeTotpSeeds(revokeData)
  const phoneName = revokeData.phoneName || '未知手机'
  const isSeedDelete = String(revokeData.scope || '').toLowerCase() === 'seed'
  const title = isSeedDelete ? 'TOTP 已同步删除' : 'TOTP 显示权限已撤销'
  const subject = isSeedDelete ? (revokeData.label || 'TOTP') : '验证码'
  if (isSeedDelete && removed === 0) return
  if (removed > 0) {
    showNotification(title, `已删除 ${removed} 个${subject}\n来源: ${phoneName}`)
  } else {
    showNotification(title, `没有可删除的${subject}\n来源: ${phoneName}`)
  }
}

function showNotification(title, body, options = {}) {
  if (Notification.isSupported()) {
    const notification = new Notification({ title, body, urgency: 'critical' })
    if (options.url) {
      notification.on('click', () => {
        shell.openExternal(options.url).catch(error => {
          console.error('Failed to open notification URL:', error)
        })
      })
    }
    notification.show()
  }
}

function gossipClipboardImageState(codeData) {
  const dataBase64 = String(codeData.dataBase64 || '')
  const manifest = codeData.fileManifest || {}
  if (!dataBase64 || !normalizeClipboardImageMime(manifest.mime)) return
  const buffer = Buffer.from(dataBase64, 'base64')
  if (!buffer.length || buffer.length > CLIPBOARD_INLINE_IMAGE_MAX_BYTES) return
  const version = codeData.clipVersion || {}
  // gossip 续传：携带入站 TTL−1，让 TTL 一路衰减（不再每跳重置）。LWW 版本守卫
  // 已保证每个版本每节点最多应用/gossip 一次，TTL 是第二道边界。
  const inboundTtl = Number(codeData.relayTtl ?? codeData.ttl)
  const nextTtl = Number.isFinite(inboundTtl) ? Math.max(0, inboundTtl - 1) : undefined
  broadcastClipboardImageToNodes(buffer, manifest.sha256 || hashBuffer(buffer), {
    ts: Number(version.ts) || Number(codeData.timestamp) || clipboardImageSyncState.ts,
    origin: String(version.origin || codeData.originDeviceId || ''),
    originDeviceName: codeData.originDeviceName || codeData.sourceDeviceName || '',
    relayPath: Array.isArray(codeData.relayPath) ? codeData.relayPath : [],
    ttl: nextTtl,
    exclude: new Set(
      [String(codeData.lastHopDeviceId || ''), String(codeData.lastRelayDeviceId || '')].filter(Boolean)
    )
  })
}

// ==================== 用户消息多跳续传（桌面节点作为中转站） ====================
// 旧实现里桌面是"终点站"：收到 verify_code 只本地消费，relayTtl/relayPath/
// targetDeviceIds 全被忽略，导致 A→桌面B→C 的传递链在 B 断掉。
// 这里补齐与安卓端 NodeReceiverService/enqueueRelayPayload 对等的续传语义：
// 防环（relayPath）、TTL 递减、originMessageId 去重（接收方已有）、
// 范围约束（source_selected_targets：只续传给源设备指定的目标）。

// 与安卓端 isRelaySupportedType 对齐；拓扑类消息走 applyTopologyDeltaPayload
// 自己的 gossip 洪泛，不经这里
const RELAY_FORWARD_TYPES = new Set([
  'sms',
  'sms_message',
  'app_notification',
  'app_notification_removed',
  'clipboard',
  'clipboard_text',
  'clipboard_image',
  'clipboard_file',
  'file_transfer',
  'totp_seed',
  'totp_revoke'
])

function payloadTargetIds(codeData) {
  if (Array.isArray(codeData.targetDeviceIds)) {
    return codeData.targetDeviceIds.map(id => String(id || '').trim()).filter(Boolean)
  }
  if (Array.isArray(codeData.targetDevices)) {
    return codeData.targetDevices.map(t => String(t?.id || '').trim()).filter(Boolean)
  }
  return []
}

function isInlineClipboardStatePayload(codeData) {
  const type = String(codeData.contentType || codeData.type || '').trim()
  if (type !== CODE_TYPES.CLIPBOARD &&
      type !== CODE_TYPES.CLIPBOARD_TEXT &&
      type !== CODE_TYPES.CLIPBOARD_IMAGE) {
    return false
  }
  const manifest = codeData.fileManifest || {}
  return manifest.inline !== false
}

// 本机是否该本地消费这条消息。
// 源设备直投（无 lastRelayDeviceId）一律消费，与旧行为完全一致（兼容旧版
// 配对条目 id 不一致的情况）；中转副本（续传而来）只有本机在目标列表内才消费，
// 否则只续传不展示——避免「下一跳路由经过的桌面把过路消息当自己的弹出来」。
function isLocalTargetOfPayload(codeData) {
  const relayed = !!String(codeData.lastRelayDeviceId || codeData.lastHopDeviceId || '').trim()
  if (!relayed) return true
  const ids = payloadTargetIds(codeData)
  if (ids.length === 0) return true
  return ids.includes(getDesktopIdentity().id)
}

function handlePlainTotpResyncRequest(request, lastHopDeviceId = '') {
  const requesterId = String(request.sourceDeviceId || request.originDeviceId || lastHopDeviceId || '').trim()
  if (!requesterId || requesterId === getDesktopIdentity().id) return
  const resolved = resolveForwardTarget(requesterId)
  const node = resolved?.node || authorizedPhones.get(requesterId) || pairedDesktopPeers.get(requesterId)
  if (!node) return
  const type = String(node.deviceType || node.type || '').toUpperCase()
  if (type.includes('PHONE')) {
    sendLocalTotpSeedsToPhone(null, null, requesterId, { force: true })
  } else {
    sendLocalTotpSeedsToDesktopPeer(null, null, node, { force: true })
  }
}

// 在已知节点表里解析续传目标：桌面对端 → 已授权手机 → 拓扑 LSDB（gossip 学到的）
function resolveForwardTarget(targetId) {
  const peer = pairedDesktopPeers.get(targetId)
  if (peer) return { kind: 'desktop', node: mergeTrustedNodeRecord(targetId, peer) }
  const phone = authorizedPhones.get(targetId)
  if (phone) {
    const node = mergeTrustedNodeRecord(targetId, phone)
    return String(node.deviceType || node.type || '').includes('DESKTOP')
      ? { kind: 'desktop', node }
      : { kind: 'phone', node }
  }
  const lsdbNode = topologyLsdb.nodes.get(targetId)
  if (lsdbNode) {
    const node = mergeTrustedNodeRecord(targetId, lsdbNode)
    if (String(node.type || node.deviceType || '').includes('PHONE')) {
      return {
        kind: 'phone',
        node: {
          ...node,
          id: node.id,
          name: node.name,
          pairingKey: node.pairingKey,
          lastIP: node.host || node.lastIP,
          tsHost: node.tsHost || '',
          relayPort: Number(node.relayPort || node.port) || 19529,
          enabled: node.enabled !== false,
          revoked: node.revoked === true
        }
      }
    }
    return { kind: 'desktop', node }
  }
  return null
}

// 经任一可用的加密 WS 通道把 verify_code 发给目标桌面节点：
// 优先本机发起的出站对端连接，其次对端发起的入站连接（对端客户端已支持
// 处理 verify_code，见 connectDesktopPeer 的消息分支）。都没有则尝试唤起
// 对端连接（本条消息放弃，后续消息可用）。
function sendVerifyCodeToDesktopNode(targetId, payloadPlain, msgId) {
  const peer = pairedDesktopPeers.get(targetId)
  if (peer && nodeSupportsSoftBus(peer)) {
    const payload = runCatchingJson(payloadPlain)
    if (payload) {
      const envelope = busEnvelope.fromLegacyPayload(payload, {
        identity: getDesktopIdentity(),
        networkId: ensureTrustedNetworkId()
      })
      if (sendBusEnvelopeWs(peer, envelope)) return true
    }
  }
  const outbound = activeDesktopPeerConnections.get(targetId)
  if (outbound && outbound.readyState === WebSocket.OPEN && outbound.__codebridgeSessionKey) {
    const encrypted = encryptMessage(payloadPlain, outbound.__codebridgeSessionKey)
    if (encrypted) {
      try {
        outbound.send(JSON.stringify({ type: 'verify_code', msgId, payload: encrypted }))
        return true
      } catch (e) {
        console.error('续传到桌面对端失败:', e)
      }
    }
  }
  const inboundConnections = activePhoneConnections.get(targetId)
  if (inboundConnections) {
    for (const ws of inboundConnections) {
      if (ws.readyState !== WebSocket.OPEN) continue
      const sessionKey = phoneSessionKeys.get(ws)
      if (!sessionKey) continue
      const encrypted = encryptMessage(payloadPlain, sessionKey)
      if (!encrypted) continue
      try {
        ws.send(JSON.stringify({ type: 'verify_code', msgId, payload: encrypted }))
        return true
      } catch (e) {
        console.error('续传到入站桌面连接失败:', e)
      }
    }
  }
  if (peer && peer.enabled !== false) {
    connectDesktopPeer(peer, { showNotification: false })
  }
  return false
}

function runCatchingJson(text) {
  try {
    return JSON.parse(text)
  } catch (_) {
    return null
  }
}

function nodeSupportsSoftBus(node = {}) {
  const caps = node.capabilities && typeof node.capabilities === 'object' ? node.capabilities : {}
  return caps.softBus === true || caps.p2pDirect === true
}

function hasActiveWsForNode(nodeId) {
  const id = String(nodeId || '').trim()
  if (!id) return false
  const desktopWs = activeDesktopPeerConnections.get(id)
  if (desktopWs && desktopWs.readyState === WebSocket.OPEN && desktopWs.__codebridgeSessionKey) return true
  const phoneConnections = activePhoneConnections.get(id)
  return !!(phoneConnections && Array.from(phoneConnections).some(ws =>
    ws && ws.readyState === WebSocket.OPEN && phoneSessionKeys.get(ws)
  ))
}

function hasDirectNodeAddress(node = {}) {
  return collectNetworkHosts(node.lastIP, node.host, node.relayHost, node.tsHost, node.altHosts).length > 0
}

function hasKnownDeliveryPath(node = {}) {
  const id = String(node.id || node.phoneId || '').trim()
  const pairingKey = node.pairingKey || lookupPeerPairingKey(id)
  if (!id || !pairingKey) return false
  if (hasDirectNodeAddress(node) || hasActiveWsForNode(id)) return true
  try {
    const identity = getDesktopIdentity()
    const routes = getTopologySnapshot().routeTables?.[identity.id] || []
    return routes.some(route => {
      if (String(route.destinationId || route.to || '') !== id) return false
      const hopId = String(route.nextHopId || route.via || '').trim()
      if (!hopId || hopId === id || hopId === identity.id) return false
      const hop = resolveForwardTarget(hopId)?.node
      return !!hop && hop.enabled !== false && hop.revoked !== true &&
        !!hop.pairingKey && (hasDirectNodeAddress(hop) || hasActiveWsForNode(hopId))
    })
  } catch (_) {
    return false
  }
}

function forwardMessageToNode(targetId, payload, messageKey) {
  const target = resolveForwardTarget(targetId)
  if (!target || target.node.enabled === false || target.node.revoked === true) return false
  if (target.kind === 'phone') {
    const phone = target.node
    if (!phone.pairingKey || !hasDirectNodeAddress(phone)) return false
    sendRelayEnvelopeToPhone(phone, payload).then(ok => {
      if (!ok) console.warn(`续传到手机失败: ${phone.name || targetId}`)
    }).catch(error => {
      console.error(`续传到手机异常 ${phone.name || targetId}:`, error.message)
    })
    return true
  }
  const peer = target.node
  if (peer && peer.pairingKey && hasDirectNodeAddress(peer)) {
    const envelope = busEnvelope.fromLegacyPayload(payload, {
      identity: getDesktopIdentity(),
      networkId: ensureTrustedNetworkId()
    })
    sendBusEnvelopeDirect(peer, envelope).then(ok => {
      if (!ok) sendVerifyCodeToDesktopNode(targetId, JSON.stringify(payload), messageKey)
    }).catch(() => {
      sendVerifyCodeToDesktopNode(targetId, JSON.stringify(payload), messageKey)
    })
    return true
  }
  return sendVerifyCodeToDesktopNode(targetId, JSON.stringify(payload), messageKey)
}

// 把一条入站用户消息续传给源设备目标列表里的其余节点（本机可达的部分）。
// 与手机端 enqueueRelayPayload 的防环/范围规则一致。
function forwardRelayedMessage(codeData, lastHopDeviceId = '') {
  try {
    if (messageRouter.isExpiredContentPayload(codeData, Date.now(), CODE_TYPES)) return
    const identity = getDesktopIdentity()
    const type = String(codeData.contentType || codeData.type || '').trim()
    if (!RELAY_FORWARD_TYPES.has(type)) return
    const ttl = Number(codeData.relayTtl ?? codeData.ttl ?? 0)
    if (!Number.isFinite(ttl) || ttl <= 0) return

    const relayPath = Array.isArray(codeData.relayPath)
      ? codeData.relayPath.map(id => String(id || '').trim()).filter(Boolean)
      : []
    if (relayPath.includes(identity.id)) return

    // source_selected_targets：续传范围严格限于源设备指定的目标；
    // 没有目标列表的（旧版负载）不续传，保持旧行为
    const targetIds = payloadTargetIds(codeData)
    if (targetIds.length === 0) return

    const messageKey = String(
      codeData.originMessageId || codeData.relayMessageId || codeData.msgId || ''
    ).trim()
    if (!messageKey) return

    const originId = String(
      codeData.originDeviceId || codeData.sourceDeviceId || codeData.phoneId || ''
    ).trim()
    const excluded = new Set([...relayPath, identity.id, originId, String(lastHopDeviceId || '')].filter(Boolean))
    const pendingTargets = targetIds.filter(id => !excluded.has(id))
    if (pendingTargets.length === 0) return

    const nextPayload = {
      ...codeData,
      relayPath: Array.from(new Set([...relayPath, identity.id])),
      relayTtl: ttl - 1,
      lastRelayDeviceId: identity.id,
      lastRelayDeviceName: identity.name
    }

    let forwarded = 0
    for (const targetId of pendingTargets) {
      if (forwardMessageToNode(targetId, nextPayload, messageKey)) forwarded += 1
    }
    if (forwarded > 0) {
      console.log(`已续传 ${type} 消息到 ${forwarded}/${pendingTargets.length} 个节点 (ttl=${ttl - 1})`)
    }
  } catch (e) {
    console.error('消息续传失败:', e)
  }
}

// 统一分发一条已解密的入站业务消息（手机入站 / 桌面对端两个方向共用）：
// 本机在目标列表内才本地消费；带 relayTtl 的消息续传给其余目标。
function dispatchInboundCodeData(codeData, lastHopDeviceId = '') {
  // Transport ACKs may still be returned so the source can stop retrying, but
  // delayed verification codes must never be displayed, copied, or forwarded.
  if (messageRouter.isExpiredContentPayload(codeData, Date.now(), CODE_TYPES)) {
    console.log('Expired verification code discarded:', codeData.originMessageId || codeData.msgId || '')
    return
  }
  if (lastHopDeviceId && !codeData.lastHopDeviceId) codeData.lastHopDeviceId = lastHopDeviceId
  if (
    codeData.type === 'topology_delta' ||
    codeData.type === 'node_advertisement' ||
    codeData.type === 'link_advertisement'
  ) {
    applyTopologyDeltaPayload(codeData, { excludeNodeId: lastHopDeviceId })
    return
  }
  const isLocalTarget = isLocalTargetOfPayload(codeData)
  if (codeData.type === 'totp_seed') {
    if (isLocalTarget) handleTotpSeed(codeData)
  } else if (codeData.type === 'totp_revoke') {
    if (isLocalTarget) handleTotpRevoke(codeData)
  } else if (codeData.type === 'totp_resync_request') {
    if (isLocalTarget) {
      handlePlainTotpResyncRequest(codeData, lastHopDeviceId)
    } else {
      forwardRelayedMessage(codeData, lastHopDeviceId)
    }
    return
  } else if (isLocalTarget) {
    handleVerifyCode(codeData)
  }
  // Inline clipboard states already gossip after a successful local apply. Running the
  // generic relay path as well creates duplicate routes in a mesh and can loop images.
  if (!(isLocalTarget && isInlineClipboardStatePayload(codeData))) {
    forwardRelayedMessage(codeData, lastHopDeviceId)
  }
}

function normalizeExternalUrl(url) {
  try {
    const parsed = new URL(String(url || ''))
    if (!['https:', 'http:'].includes(parsed.protocol)) return null
    return parsed.toString()
  } catch (_) {
    return null
  }
}

async function openLocalPath(targetPath, reveal = false) {
  const normalized = String(targetPath || '').trim()
  if (!normalized) return { success: false, error: '路径为空' }
  if (!fs.existsSync(normalized)) return { success: false, error: '文件不存在' }
  if (reveal) {
    shell.showItemInFolder(normalized)
    return { success: true }
  }
  const error = await shell.openPath(normalized)
  return error ? { success: false, error } : { success: true }
}

function isSupportedImagePath(filePath) {
  const normalized = String(filePath || '')
  const ext = path.extname(normalized).toLowerCase()
  return ['.png', '.jpg', '.jpeg', '.gif', '.bmp'].includes(ext) && fs.existsSync(normalized)
}

function getDefaultFileTransferTargetIds() {
  return getFileTransferTargets()
    .filter(target => target.selected)
    .map(target => target.id)
}

function normalizeRequestedFileTargetIds(targetIds = []) {
  const requested = Array.isArray(targetIds)
    ? targetIds.map(id => String(id || '').trim()).filter(Boolean)
    : []
  if (requested.length === 0) return []
  const allowed = new Set(getFileTransferTargets()
    .filter(target => target.allowed && target.reachable)
    .map(target => target.id))
  return Array.from(new Set(requested.filter(id => allowed.has(id))))
}

function findRouteForTarget(routes = [], targetId = '') {
  const id = String(targetId || '').trim()
  if (!id) return null
  return routes.find(route => String(route.destinationId || route.to || '') === id) || null
}

function buildUnifiedTargetCatalog() {
  const identity = getDesktopIdentity()
  const nodes = new Map()
  const topologySnapshot = getTopologySnapshot()
  const snapshotNodeById = new Map((topologySnapshot.nodes || []).map(node => [String(node.id || ''), node]))
  const routes = topologySnapshot.routeTables?.[identity.id] || []

  const inferKind = (node, fallback = 'node') => {
    const type = String(node?.deviceType || node?.type || '').toUpperCase()
    if (type.includes('PHONE')) return 'phone'
    if (type.includes('DESKTOP')) return 'desktop'
    return fallback
  }

  const append = (raw, fallbackKind = 'node') => {
    if (!raw) return
    const id = String(raw.id || raw.phoneId || '').trim()
    if (!id || id === identity.id) return

    const mergedRecord = mergeTrustedNodeRecord(id, raw)
    const previous = nodes.get(id) || {}
    const mergedHosts = collectNetworkHosts(
      previous.lastIP,
      previous.host,
      previous.relayHost,
      previous.tsHost,
      previous.altHosts,
      mergedRecord.lastIP,
      mergedRecord.host,
      mergedRecord.relayHost,
      mergedRecord.tsHost,
      mergedRecord.altHosts
    )
    const type = mergedRecord.deviceType || mergedRecord.type || previous.deviceType || previous.type ||
      (fallbackKind === 'phone' ? 'ANDROID_PHONE' : fallbackKind === 'desktop' ? 'WINDOWS_DESKTOP' : 'DEVICE_NODE')
    const lastSeen = Math.max(
      Number(previous.lastSeen || previous.updatedAt || 0) || 0,
      Number(mergedRecord.lastSeen || mergedRecord.updatedAt || 0) || 0
    )
    const connected = previous.connected === true || mergedRecord.connected === true || hasActiveWsForNode(id)
    const contentPolicy = mergeContentPolicyForDuplicateNode(id, {
      ...(previous.contentPolicy ? { contentPolicy: previous.contentPolicy } : previous),
      ...mergedRecord
    })

    nodes.set(id, {
      ...previous,
      ...mergedRecord,
      id,
      name: mergedRecord.name || previous.name || (fallbackKind === 'phone' ? 'Android Phone' : 'Device Node'),
      type,
      deviceType: type,
      kind: inferKind({ ...previous, ...mergedRecord, type }, fallbackKind),
      pairingKey: mergedRecord.pairingKey || previous.pairingKey || '',
      contentPolicy,
      lastSeen,
      connected,
      status: connected ? 'online' : (mergedRecord.status || previous.status || 'known'),
      lastIP: mergedRecord.lastIP || previous.lastIP || mergedHosts[0] || '',
      host: mergedRecord.host || previous.host || mergedHosts[0] || '',
      relayHost: mergedRecord.relayHost || previous.relayHost || '',
      tsHost: mergedRecord.tsHost || previous.tsHost || '',
      altHosts: mergedHosts,
      relayPort: mergedRecord.relayPort || mergedRecord.port || previous.relayPort || previous.port || JOIN_PORT
    })
  }

  for (const node of topologyLsdb.nodes.values()) append(node, inferKind(node))
  getAuthorizedPhones().forEach(phone => append(phone, 'phone'))
  getPairedDesktopPeers().forEach(peer => append(peer, 'desktop'))

  return Array.from(nodes.values())
    .map(node => {
      const id = String(node.id || '').trim()
      const hosts = collectNetworkHosts(node.lastIP, node.host, node.relayHost, node.tsHost, node.altHosts)
      const snapshotNode = snapshotNodeById.get(id) || null
      const route = findRouteForTarget(routes, id)
      const reachability = getNodeReachabilitySnapshot({ ...(snapshotNode || {}), ...node }, {
        connected: node.connected === true || hasActiveWsForNode(id),
        trusted: !!(node.pairingKey || lookupPeerPairingKey(id)),
        route
      })
      return {
        id,
        name: node.name || id,
        type: node.deviceType || node.type || 'DEVICE_NODE',
        kind: node.kind || inferKind(node),
        host: hosts[0] || '',
        lastSeen: node.lastSeen || 0,
        status: reachability.status,
        statusLabel: getDeviceStatusLabel(reachability.status),
        reachable: reachability.reachable,
        trusted: reachability.trusted,
        sendable: reachability.sendable,
        reason: '',
        routeNextHopId: route?.nextHopId || '',
        routeNextHopName: route?.nextHopName || '',
        routeMetric: route?.metric || 0,
        maxFileSizeMb: Number(node.contentPolicy?.maxFileSizeMb || node.maxFileSizeMb || desktopMessageSettings.maxFileSizeMb || 50),
        node,
        snapshotNode,
        route,
        reachability
      }
    })
    .sort((a, b) => {
      if (a.reachable !== b.reachable) return a.reachable ? -1 : 1
      if (a.trusted !== b.trusted) return a.trusted ? -1 : 1
      return String(a.name || a.id).localeCompare(String(b.name || b.id), 'zh-Hans-CN')
    })
}

function buildTargetReason(target, allowed, permissionLabel = '未开启推送权限') {
  if (target.status === 'revoked') return '已被源设备撤销授权'
  if (target.status === 'disabled') return '当前节点已禁用'
  if (!target.trusted) return '未完成可信配对'
  if (!target.reachable) {
    if (target.status === 'known') return '已知节点，当前未验证可达'
    return '当前不可达'
  }
  if (!allowed) return permissionLabel
  if (target.routeNextHopId && target.routeNextHopId !== target.id) {
    return `经 ${target.routeNextHopName || target.routeNextHopId}`
  }
  return ''
}

function getTargetSelectionsForType(type, options = {}) {
  const requestedIds = options.requestedIds instanceof Set
    ? options.requestedIds
    : new Set(Array.isArray(options.requestedIds) ? options.requestedIds.map(id => String(id || '').trim()).filter(Boolean) : [])
  const excludedIds = options.excludeIds instanceof Set
    ? options.excludeIds
    : new Set(Array.isArray(options.excludeIds) ? options.excludeIds.map(id => String(id || '').trim()).filter(Boolean) : [])
  const allowNode = typeof options.allowNode === 'function'
    ? options.allowNode
    : (node => canPushContentToNode(node, type))
  const permissionLabel = options.permissionLabel || '未开启推送权限'
  const includeUntrusted = options.includeUntrusted === true
  const includeUnreachable = options.includeUnreachable === true

  return buildUnifiedTargetCatalog()
    .filter(target => !excludedIds.has(target.id))
    .filter(target => requestedIds.size === 0 || requestedIds.has(target.id))
    .map(target => {
      const allowed = target.trusted && allowNode(target.node)
      const selected = target.sendable && allowed
      const reason = buildTargetReason(target, allowed, permissionLabel)
      return {
        ...target,
        allowed,
        selected,
        reason
      }
    })
    .filter(target => includeUntrusted || target.trusted || target.status === 'revoked' || target.status === 'disabled')
    .filter(target => includeUnreachable || target.reachable || target.status === 'known' || target.status === 'offline' || target.status === 'revoked' || target.status === 'disabled')
    .sort((a, b) => {
      if (a.selected !== b.selected) return a.selected ? -1 : 1
      if (a.reachable !== b.reachable) return a.reachable ? -1 : 1
      if (a.trusted !== b.trusted) return a.trusted ? -1 : 1
      return String(a.name || a.id).localeCompare(String(b.name || b.id), 'zh-Hans-CN')
    })
}

function getFileTransferTargets() {
  return getTargetSelectionsForType(CODE_TYPES.FILE_TRANSFER, {
    includeUntrusted: true,
    includeUnreachable: true,
    permissionLabel: '文件传输权限未开启'
  })
}

function getDefaultClipboardFileTargetIds() {
  return getTargetSelectionsForType(CODE_TYPES.CLIPBOARD_FILE, {
    allowNode: node =>
      canPushContentToNode(node, CODE_TYPES.CLIPBOARD_FILE) ||
      canPushContentToNode(node, CODE_TYPES.FILE_TRANSFER)
  })
    .filter(target => target.selected)
    .map(target => target.id)
}

async function selectAndSendFile(targetIds = []) {
  try {
    const result = await dialog.showOpenDialog(mainWindow || undefined, {
      title: '选择要同步的文件',
      properties: ['openFile', 'multiSelections']
    })
    if (result.canceled || result.filePaths.length === 0) {
      return { success: false, canceled: true }
    }
    const requestedTargets = normalizeRequestedFileTargetIds(targetIds)
    const targets = requestedTargets.length > 0 ? Array.from(new Set(requestedTargets)) : getDefaultFileTransferTargetIds()
    if (targets.length === 0) {
      return { success: false, error: '没有启用文件传输的推送目标' }
    }
    const maxBytes = Math.max(1, Number(desktopMessageSettings.maxFileSizeMb || 50)) * 1024 * 1024
    const eligible = []
    const skipped = []
    for (const filePath of result.filePaths) {
      let stat = null
      try {
        stat = fs.statSync(filePath)
      } catch (error) {
        skipped.push({ filePath, reason: error.message })
        continue
      }
      if (!stat.isFile()) {
        skipped.push({ filePath, reason: '不是普通文件' })
        continue
      }
      if (stat.size <= 0 || stat.size > maxBytes) {
        skipped.push({ filePath, reason: `文件大小超出上限 ${formatBytes(maxBytes)}` })
        continue
      }
      eligible.push({ filePath, size: stat.size })
    }
    const sent = await offerFileBatch(eligible.map(item => ({ abs: item.filePath, size: item.size })), targets)
    return {
      success: sent.length > 0,
      targetIds: targets,
      sent,
      skipped,
      error: sent.length > 0 ? '' : '没有文件被发送'
    }
  } catch (error) {
    return { success: false, error: error.message || '文件发送失败' }
  }
}

// 把一组文件按同一 batchId 依次 offer（接收端同批只确认一次）。
// item.rel 存在时作为目录分享的相对路径随 manifest 下发。
async function offerFileBatch(items, targets) {
  const transfer = initFileTransfer()
  const batchId = items.length > 1 ? `batch-${getDesktopIdentity().id}-${Date.now()}` : ''
  const batchTotalBytes = items.reduce((sum, item) => sum + (item.size || 0), 0)
  const sent = []
  for (const item of items) {
    const options = { payloadExtra: buildLocalSourceAddressPayload() }
    if (item.rel) options.relativePath = item.rel
    if (batchId) {
      options.payloadExtra = {
        ...options.payloadExtra,
        batchId,
        batchCount: items.length,
        batchTotalBytes
      }
    }
    const offer = await transfer.offerFile(item.abs, targets, options)
    if (offer) sent.push({ filePath: item.abs, ...offer })
  }
  return sent
}

const MAX_FOLDER_FILES = 500

// 递归收集文件夹内可发送的文件（不跟随符号链接，超限/不可读记入 skipped）
function walkFolderFiles(rootDir, maxBytes) {
  const files = []
  const skipped = []
  const walk = dir => {
    if (files.length >= MAX_FOLDER_FILES) return
    let entries = []
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch (error) {
      skipped.push({ filePath: dir, reason: error.message })
      return
    }
    for (const entry of entries) {
      if (files.length >= MAX_FOLDER_FILES) {
        skipped.push({ filePath: path.join(dir, entry.name), reason: `超出单次 ${MAX_FOLDER_FILES} 个文件上限` })
        return
      }
      const full = path.join(dir, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        walk(full)
        continue
      }
      if (!entry.isFile()) continue
      let stat = null
      try {
        stat = fs.statSync(full)
      } catch (error) {
        skipped.push({ filePath: full, reason: error.message })
        continue
      }
      if (stat.size <= 0 || stat.size > maxBytes) {
        skipped.push({ filePath: full, reason: `文件大小超出上限 ${formatBytes(maxBytes)}` })
        continue
      }
      files.push({
        abs: full,
        rel: path.relative(rootDir, full).split(path.sep).join('/'),
        size: stat.size
      })
    }
  }
  walk(rootDir)
  return { files, skipped }
}

async function selectAndSendFolder(targetIds = []) {
  try {
    const result = await dialog.showOpenDialog(mainWindow || undefined, {
      title: '选择要同步的文件夹',
      properties: ['openDirectory']
    })
    if (result.canceled || result.filePaths.length === 0) {
      return { success: false, canceled: true }
    }
    const requestedTargets = normalizeRequestedFileTargetIds(targetIds)
    const targets = requestedTargets.length > 0 ? Array.from(new Set(requestedTargets)) : getDefaultFileTransferTargetIds()
    if (targets.length === 0) {
      return { success: false, error: '没有启用文件传输的推送目标' }
    }
    const rootDir = result.filePaths[0]
    const rootName = path.basename(rootDir) || 'folder'
    const maxBytes = Math.max(1, Number(desktopMessageSettings.maxFileSizeMb || 50)) * 1024 * 1024
    const { files, skipped } = walkFolderFiles(rootDir, maxBytes)
    if (files.length === 0) {
      return { success: false, error: '文件夹内没有可发送的文件', skipped }
    }
    const sent = await offerFileBatch(
      files.map(item => ({ abs: item.abs, size: item.size, rel: `${rootName}/${item.rel}` })),
      targets
    )
    return {
      success: sent.length > 0,
      targetIds: targets,
      folder: rootDir,
      sent,
      skipped,
      error: sent.length > 0 ? '' : '没有文件被发送'
    }
  } catch (error) {
    return { success: false, error: error.message || '文件夹发送失败' }
  }
}

registerDesktopIpc(ipcMain, {
  getPairingInfo: async () => {
    if (!pairingKey) {
      loadOrCreatePairingKey()
    }
    const qrDataURL = await refreshPairingQR()
    return {
      host: getLocalIP(),
      port: WS_PORT,
      tsHost: getTailscaleIPv4(),
      qrDataURL,
      hasPairingKey: !!pairingKey,
      authorizedPhones: getAuthorizedPhones()
    }
  },
  copyToClipboard: text => {
    clipboard.writeText(text)
    if (mainWindow) {
      mainWindow.webContents.send('copy-feedback')
    }
  },
  hideWindow: () => {
    if (mainWindow) mainWindow.hide()
  },
  minimizeWindow: () => {
    if (mainWindow) mainWindow.hide()
  },
  regeneratePairing: async () => {
    await regeneratePairingKey()
    return true
  },
  getAuthorizedPhones: () => getAuthorizedPhones(),
  getDesktopTotps: () => getDesktopTotps(),
  requestTotpResync: targetIds => requestFullTotpSync(targetIds),
  getTopology: () => getTopologySnapshot(),
  getMessageSettings: () => ({
    ...normalizeMessageSettings(desktopMessageSettings),
    currentPlatform: process.platform,
    supportedPlatforms: {
      clipboardFileSync: ['win32']
    }
  }),
  setMessageSettings: updates => {
    const previousSettings = normalizeMessageSettings(desktopMessageSettings)
    desktopMessageSettings = normalizeMessageSettings({
      ...desktopMessageSettings,
      ...(updates || {})
    })
    if (process.platform !== 'win32') desktopMessageSettings.syncClipboardFile = false
    savePairingKey()
    if (
      desktopMessageSettings.syncClipboardText === true ||
      desktopMessageSettings.syncClipboardImage === true ||
      desktopMessageSettings.syncClipboardFile === true
    ) {
      startClipboardSyncWatcher()
      try {
        if (desktopMessageSettings.syncClipboardText !== true || previousSettings.syncClipboardText !== true) {
          lastClipboardText = clipboard.readText() || ''
        }
        if (desktopMessageSettings.syncClipboardImage === true && previousSettings.syncClipboardImage !== true) {
          lastClipboardImageHash = ''
        } else {
          lastClipboardImageHash = readClipboardImageSyncHash()
        }
        if (desktopMessageSettings.syncClipboardFile === true && previousSettings.syncClipboardFile !== true) {
          // Force a fresh native sequence snapshot when the watcher is enabled;
          // a cache captured before enablement must not be emitted as a new copy.
          nativeClipboardFileSnapshotReady = false
          nativeClipboardFileSnapshotStartedAt = 0
          const filePaths = readClipboardFilePaths()
          if (lastClipboardFileReadReady) {
            lastClipboardFileSignature = getClipboardFileSignature(filePaths)
            clipboardFileWatcherPrimed = true
          } else {
            lastClipboardFileSignature = ''
            clipboardFileWatcherPrimed = false
          }
        } else if (desktopMessageSettings.syncClipboardFile !== true) {
          lastClipboardFileSignature = ''
          clipboardFileWatcherPrimed = false
        }
      } catch (_) {
        lastClipboardText = ''
        lastClipboardImageHash = ''
        lastClipboardFileSignature = ''
      }
      if (desktopMessageSettings.syncClipboardImage === true && previousSettings.syncClipboardImage !== true) {
        setTimeout(pollClipboardForSync, 25)
      }
    }
    return {
      ...normalizeMessageSettings(desktopMessageSettings),
      currentPlatform: process.platform,
      supportedPlatforms: {
        clipboardFileSync: ['win32']
      }
    }
  },
  fileSelectAndSend: targetIds => selectAndSendFile(targetIds),
  fileSelectAndSendFolder: targetIds => selectAndSendFolder(targetIds),
  fileTransferTargets: () => getFileTransferTargets(),
  fileTransferTargetPolicy: (nodeId, updates) => setNodeContentPolicy(nodeId, updates).fileTargets,
  fileTransferHistory: () => getFileTransferHistory(),
  fileTransferSettings: () => fileTransferSettingsSnapshot(),
  fileTransferChooseDownloadDir: () => chooseFileTransferDownloadDir(),
  fileTransferResetDownloadDir: () => setFileTransferDownloadDir(''),
  fileTransferOpenDownloadDir: () => openFileTransferDownloadDir(),
  fileTransferOpenPath: filePath => openLocalPath(filePath, false),
  fileTransferRevealPath: filePath => openLocalPath(filePath, true),
  getLanJoinSettings: () => ({
    allowLanJoinRequests: allowLanJoinRequests !== false,
    networkId: ensureTrustedNetworkId()
  }),
  setLanJoinSettings: updates => {
    if (updates && Object.prototype.hasOwnProperty.call(updates, 'allowLanJoinRequests')) {
      allowLanJoinRequests = updates.allowLanJoinRequests !== false
      savePairingKey()
    }
    return {
      allowLanJoinRequests: allowLanJoinRequests !== false,
      networkId: ensureTrustedNetworkId()
    }
  },
  scanLanDevices: () => scanLanDevices(),
  getLanDevices: () => getDiscoveredLanDevices(),
  pairDesktopDevice: pairingData => pairDesktopPeer(pairingData),
  requestLanJoin: (device, template) => requestLanJoin(device, template),
  respondLanJoin: (requestId, accepted, template) => respondLanJoinRequest(requestId, accepted, template),
  isWindowVisible: () => mainWindow ? mainWindow.isVisible() : false,
  setPhoneEnabled: (phoneId, enabled) => setPhoneEnabled(phoneId, enabled),
  setPhoneContentPolicy: (phoneId, updates) => setPhoneContentPolicy(phoneId, updates),
  revokePhone: phoneId => revokePhone(phoneId),
  restorePhone: phoneId => restorePhone(phoneId),
  openExternal: async url => {
    const externalUrl = normalizeExternalUrl(url)
    if (!externalUrl) return false
    await shell.openExternal(externalUrl)
    return true
  },
  checkForUpdate: () => updater.checkForUpdate(true),
  getUpdateState: () => updater.getUpdateState(),
  getAppVersion: () => app.getVersion(),
  storageGetAllTotps: () => getTotpSeedRecords(),
  storageAddTotp: totp => addLocalTotpSeed(totp),
  storageUpdateTotp: (id, updates) => updateTotpSeed(id, updates),
  storageDeleteTotp: id => deleteTotpSeed(id),
  storageGetTotpById: id => toPublicTotpSeed(totpSeeds.get(String(id || ''))),
  storageGetAllSms: () => storage.getAllSms(),
  storageAddSms: sms => storage.addSms(sms),
  storageDeleteSms: id => storage.deleteSms(id),
  storageClearAllSms: () => storage.clearAllSms(),
  storageGetStats: () => {
    const stats = storage.getStats()
    return {
      ...stats,
      totpCount: totpSeeds.size,
      localTotpCount: Array.from(totpSeeds.values()).filter(seed => seed.phoneId === LOCAL_TOTP_SOURCE_ID).length,
      remoteTotpCount: Array.from(totpSeeds.values()).filter(seed => seed.phoneId !== LOCAL_TOTP_SOURCE_ID).length
    }
  },
  storageGetDeviceId: () => storage.getDeviceId(),
  storageGetDeviceName: () => storage.getDeviceName(),
  storageSetDeviceName: name => storage.setDeviceName(name),
  storageExportData: () => ({
    ...storage.exportData(),
    totps: getTotpSeedRecords()
  }),
  storageImportData: data => {
    const result = storage.importData(data)
    importStorageTotpsIntoPrimaryStore()
    notifyTotpSeedsChanged()
    return result
  },
  qrStartClipboardWatch: () => {
    qrCodeParser.startClipboardWatcher(result => {
      if (mainWindow) {
        mainWindow.webContents.send('qr-code-detected', result)
      }
    })
    return { success: true }
  },
  qrStopClipboardWatch: () => {
    qrCodeParser.stopClipboardWatcher()
    return { success: true }
  },
  qrParseFile: async filePath => {
    try {
      if (!isSupportedImagePath(filePath)) {
        return { success: false, error: '不支持的图片文件' }
      }
      const result = await qrCodeParser.parseFile(filePath)
      return { success: true, result }
    } catch (error) {
      return { success: false, error: error.message }
    }
  },
  qrSelectAndParse: async () => {
    try {
      const result = await dialog.showOpenDialog(mainWindow, {
        title: '选择二维码图片',
        filters: [
          { name: '图片', extensions: ['png', 'jpg', 'jpeg', 'gif', 'bmp'] }
        ],
        properties: ['openFile', 'multiSelections']
      })

      if (result.canceled || result.filePaths.length === 0) {
        return { success: false, canceled: true }
      }

      const supportedFiles = result.filePaths.filter(isSupportedImagePath)
      if (supportedFiles.length === 0) {
        return { success: false, error: '不支持的图片文件' }
      }
      const qrResult = await qrCodeParser.parseFiles(supportedFiles)
      return { success: true, result: qrResult, filePaths: supportedFiles }
    } catch (error) {
      return { success: false, error: error.message }
    }
  },
  qrParseClipboard: async () => {
    try {
      const image = clipboard.readImage()
      if (image.isEmpty()) {
        return { success: false, error: '剪贴板中没有图片' }
      }

      const result = await qrCodeParser.parseImage(image)
      return { success: true, result }
    } catch (error) {
      return { success: false, error: error.message }
    }
  }
})



if (!gotSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', (event, argv) => {
    if (argv.includes('--quit-for-update')) {
      quitForUpdate()
      return
    }
    if (!argv.includes('--hidden')) {
      showMainWindow()
    }
  })

  app.whenReady().then(async () => {
    if (QUIT_FOR_UPDATE) {
      quitForUpdate()
      return
    }

    const startHidden = shouldStartHidden()
    configureAutoLaunch()

    // 初始化存储模块
    storage.initialize()

    loadOrCreatePairingKey()
    loadFileTransferHistory()
    importStorageTotpsIntoPrimaryStore()
    createWindow({ hidden: startHidden })
    createTray()
    updater.initAutoUpdater(mainWindow)
    startWebSocketServer()
    startLanDiscoveryService()
    startLanJoinServer()
    startLocalNotifyServer()
    startClipboardSyncWatcher()
    await refreshPairingQR()
    connectAllDesktopPeers()
    startDesktopPeerReconnectLoop()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
      showMainWindow()
    })
  })
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
