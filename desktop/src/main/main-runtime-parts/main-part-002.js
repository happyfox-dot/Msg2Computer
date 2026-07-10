          trustLevel: peer.trustLevel || '',
          acceptedAt: peer.acceptedAt || 0,
          capabilities: peer.capabilities || {},
          connectionUpdatedAt: peer.connectionUpdatedAt || 0,
          contentPolicy: normalizePushContentPolicy(peer.contentPolicy || peer)
        })),
        totpSeeds: getStoredTotpSeeds(),
        totpDeleteTombstones: getStoredTotpDeleteTombstones(),
        topologyLsdb: exportTopologyLsdb(),
        messageSettings: normalizeMessageSettings(desktopMessageSettings),
        fileTransferDownloadDir: fileTransferDownloadDir || '',
        // 剪贴板 LWW 版本（仅哈希不含明文）：跨重启保持，避免补推用旧值盖新值
        clipboardSyncState: { ...clipboardSyncState },
        clipboardImageSyncState: { ...clipboardImageSyncState },
        clipboardGlobalSyncState: { ...clipboardGlobalSyncState },
        updatedAt: Date.now()
  }
}

function normalizeFileTransferDownloadDir(value = '') {
  const raw = String(value || '').trim()
  if (!raw) return ''
  try {
    const resolved = path.resolve(raw)
    return path.isAbsolute(resolved) ? resolved : ''
  } catch (_) {
    return ''
  }
}

function defaultFileTransferDownloadDir() {
  try {
    return app.getPath('downloads')
  } catch (_) {
    return path.join(app.getPath('userData'), 'downloads')
  }
}

function getFileTransferDownloadDir() {
  return normalizeFileTransferDownloadDir(fileTransferDownloadDir) || defaultFileTransferDownloadDir()
}

function resetFileTransferManager() {
  if (!fileTransfer) return
  try {
    fileTransfer.cancelAll?.()
  } catch (_) {
    // Best-effort: changing the receive directory should not block the UI.
  }
  fileTransfer = null
}

function fileTransferSettingsSnapshot() {
  const customDownloadDir = normalizeFileTransferDownloadDir(fileTransferDownloadDir)
  return {
    downloadDir: customDownloadDir || defaultFileTransferDownloadDir(),
    customDownloadDir,
    usingDefault: !customDownloadDir
  }
}

async function chooseFileTransferDownloadDir() {
  const result = await dialog.showOpenDialog(mainWindow || undefined, {
    title: '选择文件接收保存目录',
    properties: ['openDirectory', 'createDirectory']
  })
  if (result.canceled || !result.filePaths?.[0]) {
    return fileTransferSettingsSnapshot()
  }
  fileTransferDownloadDir = normalizeFileTransferDownloadDir(result.filePaths[0])
  savePairingKey()
  resetFileTransferManager()
  return fileTransferSettingsSnapshot()
}

function setFileTransferDownloadDir(dir = '') {
  fileTransferDownloadDir = normalizeFileTransferDownloadDir(dir)
  savePairingKey()
  resetFileTransferManager()
  return fileTransferSettingsSnapshot()
}

async function openFileTransferDownloadDir() {
  const dir = getFileTransferDownloadDir()
  try {
    fs.mkdirSync(dir, { recursive: true })
  } catch (error) {
    return { success: false, error: error.message || '无法创建目录' }
  }
  return openLocalPath(dir, false)
}

async function regeneratePairingKey() {
  pairingKey = crypto.randomBytes(32).toString('base64')
  savePairingKey()
  await refreshPairingQR()
}

async function refreshPairingQR() {
  if (!pairingKey) {
    loadOrCreatePairingKey()
  }
  const localIP = getLocalIP()
  const desktopIdentity = getDesktopIdentity()
  const tailscaleIP = getTailscaleIPv4()
  const pairingInfo = JSON.stringify({
    id: desktopIdentity.id,
    deviceId: desktopIdentity.id,
    host: localIP,
    port: WS_PORT,
    pk: pairingKey,
    name: desktopIdentity.name,
    type: desktopIdentity.type,
    deviceType: desktopIdentity.type,
    protocol: 'codebridge-lan',
    topologyRole: 'target',
    // 手机扫码后会把它存为备用地址：不在同一局域网时走 Tailscale 虚拟网连接
    ...(tailscaleIP ? { tsHost: tailscaleIP } : {})
  })

  pairingQRData = pairingInfo
  const qrDataURL = await QRCode.toDataURL(pairingInfo, { width: 250, margin: 1 })
  if (mainWindow) {
    mainWindow.webContents.send('pairing-qr', qrDataURL)
  }
  return qrDataURL
}

function getLocalIP() {
  const candidates = getLocalIPCandidates()
  return candidates[0]?.address || '127.0.0.1'
}

// Tailscale 给每台设备分配的虚拟 IP 固定落在 CGNAT 段 100.64.0.0/10
function isTailscaleAddress(address) {
  const parts = String(address || '').trim().split('.').map(Number)
  return parts.length === 4 && parts.every(Number.isFinite) &&
    parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127
}

// 本机的 Tailscale IPv4；未安装/未登录时返回空串。
// 注意 getLocalIP 的评分故意压低 tailscale 接口（局域网直连优先），
// 这里单独按地址段扫描，用于配对二维码和 node 信息的备用地址。
function getTailscaleIPv4() {
  const nets = os.networkInterfaces()
  for (const addresses of Object.values(nets)) {
    for (const net of addresses || []) {
      if (net.family !== 'IPv4' || net.internal) continue
      if (isTailscaleAddress(net.address)) return net.address
    }
  }
  return ''
}

function getLocalIPCandidates() {
  const nets = os.networkInterfaces()
  const candidates = []

  for (const [name, addresses] of Object.entries(nets)) {
    for (const net of addresses || []) {
      if (net.family !== 'IPv4' || net.internal) continue
      candidates.push({
        name,
        address: net.address,
        score: scoreNetworkAddress(name, net.address)
      })
    }
  }

  return candidates.sort((a, b) => b.score - a.score)
}

function scoreNetworkAddress(interfaceName, address) {
  let score = 0
  const lowerName = interfaceName.toLowerCase()

  if (isPrivateIPv4(address)) score += 50
  if (address.startsWith('192.168.')) score += 30
  if (address.startsWith('10.')) score += 20
  if (is172PrivateIPv4(address)) score += 20
  if (/wi-?fi|wlan|wireless|ethernet|以太网|无线/.test(lowerName)) score += 20
  if (/vethernet|virtual|docker|wsl|vmware|virtualbox|hyper-v|bluetooth|loopback|tailscale|zerotier|vpn|wireguard/.test(lowerName)) {
    score -= 100
  }
  if (address.startsWith('169.254.')) score -= 50

  return score
}

function isPrivateIPv4(address) {
  return address.startsWith('10.') || address.startsWith('192.168.') || is172PrivateIPv4(address)
}

function is172PrivateIPv4(address) {
  const parts = address.split('.').map(Number)
  return parts.length === 4 && parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31
}

function normalizePhoneId(phoneId, clientIP) {
  const id = typeof phoneId === 'string' ? phoneId.trim() : ''
  if (id) return id
  return `legacy-${crypto.createHash('sha256').update(clientIP || 'unknown').digest('hex').slice(0, 16)}`
}

function normalizePhoneName(phoneName, fallback) {
  const name = typeof phoneName === 'string' ? phoneName.trim() : ''
  return name || fallback || 'Android Phone'
}

function normalizeDeviceType(deviceType, fallback = 'ANDROID_PHONE') {
  const value = String(deviceType || '').trim().toUpperCase()
  if (value.includes('WINDOWS')) return 'WINDOWS_DESKTOP'
  if (value.includes('MAC')) return 'MAC_DESKTOP'
  if (value.includes('LINUX')) return 'LINUX_DESKTOP'
  if (value.includes('DESKTOP')) return fallback.includes('DESKTOP') ? fallback : 'WINDOWS_DESKTOP'
  if (value.includes('IOS')) return 'IOS_PHONE'
  if (value.includes('PHONE') || value.includes('ANDROID')) return 'ANDROID_PHONE'
  return fallback
}

function getAuthorizedPhones() {
  return Array.from(authorizedPhones.values())
    .sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0))
}

function getPairedDesktopPeers() {
  return Array.from(pairedDesktopPeers.values())
    .sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0))
}

function notifyPhonesChanged(options = {}) {
  if (mainWindow) {
    mainWindow.webContents.send('phones-changed', getAuthorizedPhones())
  }
  if (options.topologyChanged !== false) {
    scheduleTopologyBroadcast()
  }
}

function notifyDesktopPeersChanged(options = {}) {
  if (mainWindow) {
    mainWindow.webContents.send('desktop-peers-changed', getPairedDesktopPeers())
  }
  if (options.topologyChanged !== false) {
    scheduleTopologyBroadcast()
  }
}

function upsertAuthorizedPhone({
  phoneId,
  phoneName,
  clientIP,
  deviceType,
  pairingKey: phonePairingKey,
  relayPort,
  relayHost,
  tsHost,
  networkId,
  autoPaired,
  trustSourceId,
  trustLevel,
  acceptedAt,
  capabilities,
  contentPolicy
}) {
  const now = Date.now()
  const existing = authorizedPhones.get(phoneId)
  const host = normalizeNetworkHost(relayHost || clientIP || existing?.lastIP || '')
  const normalizedPairingKey = String(phonePairingKey || existing?.pairingKey || '').trim()
  const phone = {
    id: phoneId,
    name: normalizePhoneName(phoneName, existing?.name),
    deviceType: normalizeDeviceType(deviceType || existing?.deviceType, 'ANDROID_PHONE'),
    enabled: existing ? existing.enabled !== false : true,
    revoked: existing?.revoked === true,
    firstSeen: existing?.firstSeen || now,
    lastSeen: now,
    lastIP: host,
    relayPort: Number(relayPort || existing?.relayPort) || 19529,
    pairingKey: normalizedPairingKey,
    // 手机上报的 Tailscale IP：随路由表分发给其它手机节点做备用 relay 地址
    tsHost: String(tsHost || existing?.tsHost || '').trim(),
    networkId: String(networkId || existing?.networkId || ensureTrustedNetworkId()).trim(),
    autoPaired: autoPaired === true || existing?.autoPaired === true,
    trustSourceId: String(trustSourceId || existing?.trustSourceId || '').trim(),
    trustLevel: String(trustLevel || existing?.trustLevel || '').trim(),
    acceptedAt: Number(acceptedAt || existing?.acceptedAt || 0) || 0,
    capabilities: capabilities && typeof capabilities === 'object' ? capabilities : (existing?.capabilities || {}),
    contentPolicy: normalizePushContentPolicy(contentPolicy || existing?.contentPolicy || existing || {}),
    connectionUpdatedAt: existing?.connectionUpdatedAt || 0,
    connected: existing?.connected === true
  }
  const topologyChanged = !existing ||
    existing.lastIP !== phone.lastIP ||
    Number(existing.relayPort || 19529) !== Number(phone.relayPort || 19529) ||
    String(existing.pairingKey || '') !== String(phone.pairingKey || '') ||
    String(existing.tsHost || '') !== String(phone.tsHost || '') ||
    String(existing.networkId || '') !== String(phone.networkId || '') ||
    existing.autoPaired !== phone.autoPaired ||
    String(existing.trustSourceId || '') !== String(phone.trustSourceId || '') ||
    String(existing.trustLevel || '') !== String(phone.trustLevel || '') ||
    Number(existing.acceptedAt || 0) !== Number(phone.acceptedAt || 0) ||
    String(existing.deviceType || '') !== String(phone.deviceType || '') ||
    JSON.stringify(normalizePushContentPolicy(existing.contentPolicy || existing || {})) !== JSON.stringify(phone.contentPolicy || {}) ||
    JSON.stringify(existing.capabilities || {}) !== JSON.stringify(phone.capabilities || {})
  authorizedPhones.set(phoneId, phone)
  savePairingKey()
  notifyPhonesChanged({ topologyChanged })
  return phone
}

function normalizeDesktopPeer(pairingData) {
  const id = String(pairingData?.id || pairingData?.deviceId || '').trim()
  const addressData = trustedNode.withPrimaryTrustedHost(pairingData || {})
  const host = String(addressData.host || '').trim()
  const deviceType = normalizeDeviceType(pairingData?.deviceType || pairingData?.type, 'WINDOWS_DESKTOP')
  const port = normalizeTopologyPort(deviceType, pairingData?.wsPort || pairingData?.port || WS_PORT)
  const pairingKeyValue = String(pairingData?.pairingKey || pairingData?.pk || '').trim()
  if (!id || !host || !pairingKeyValue || !Number.isFinite(port)) return null

  return {
    id,
    name: String(pairingData?.name || pairingData?.deviceName || 'Desktop PC').trim(),
    deviceType,
    host,
    port,
    pairingKey: pairingKeyValue,
    tsHost: String(pairingData?.tsHost || '').trim(),
    altHosts: Array.isArray(addressData.altHosts) ? addressData.altHosts : [],
    networkId: String(pairingData?.networkId || '').trim(),
    autoPaired: pairingData?.autoPaired === true,
    trustSourceId: String(pairingData?.trustSourceId || '').trim(),
    trustLevel: String(pairingData?.trustLevel || '').trim(),
    acceptedAt: Number(pairingData?.acceptedAt || 0) || 0,
    capabilities: pairingData?.capabilities && typeof pairingData.capabilities === 'object'
      ? pairingData.capabilities
      : {},
    contentPolicy: pairingData?.contentPolicy
  }
}

function upsertPairedDesktopPeer(pairingData) {
  const normalized = normalizeDesktopPeer(pairingData)
  if (!normalized) return null

  const identity = getDesktopIdentity()
  if (normalized.id === identity.id) {
    return {
      error: 'self_pairing',
      message: '不能配对当前设备自己的二维码'
    }
  }

  const now = Date.now()
  const existing = pairedDesktopPeers.get(normalized.id)
  const peer = {
    ...existing,
    ...normalized,
    enabled: existing ? existing.enabled !== false : true,
    firstSeen: existing?.firstSeen || now,
    lastSeen: now,
    lastIP: normalized.host,
    networkId: normalized.networkId || existing?.networkId || ensureTrustedNetworkId(),
    autoPaired: normalized.autoPaired || existing?.autoPaired === true,
    trustSourceId: normalized.trustSourceId || existing?.trustSourceId || '',
    trustLevel: normalized.trustLevel || existing?.trustLevel || '',
    acceptedAt: normalized.acceptedAt || existing?.acceptedAt || 0,
    capabilities: Object.keys(normalized.capabilities || {}).length > 0 ? normalized.capabilities : (existing?.capabilities || {}),
    contentPolicy: normalizePushContentPolicy(normalized.contentPolicy || existing?.contentPolicy || existing || {}),
    connectionUpdatedAt: existing?.connectionUpdatedAt || 0,
    connected: existing?.connected === true,
    altHosts: normalized.altHosts.length > 0 ? normalized.altHosts : (existing?.altHosts || [])
  }
  const topologyChanged = !existing ||
    String(existing.name || '') !== String(peer.name || '') ||
    String(existing.host || '') !== String(peer.host || '') ||
    Number(existing.port || 0) !== Number(peer.port || 0) ||
    String(existing.pairingKey || '') !== String(peer.pairingKey || '') ||
    String(existing.tsHost || '') !== String(peer.tsHost || '') ||
    JSON.stringify(existing.altHosts || []) !== JSON.stringify(peer.altHosts || []) ||
    String(existing.networkId || '') !== String(peer.networkId || '') ||
    existing.enabled !== peer.enabled ||
    String(existing.deviceType || '') !== String(peer.deviceType || '') ||
    String(existing.trustSourceId || '') !== String(peer.trustSourceId || '') ||
    String(existing.trustLevel || '') !== String(peer.trustLevel || '') ||
    Number(existing.acceptedAt || 0) !== Number(peer.acceptedAt || 0) ||
    JSON.stringify(normalizePushContentPolicy(existing.contentPolicy || existing || {})) !== JSON.stringify(peer.contentPolicy || {}) ||
    JSON.stringify(existing.capabilities || {}) !== JSON.stringify(peer.capabilities || {})
  pairedDesktopPeers.set(peer.id, peer)
  savePairingKey()
  notifyDesktopPeersChanged({ topologyChanged })
  return peer
}

function deriveSessionKeyWithPairingKey(pairingKeyValue, phoneNonce, serverNonce) {
  return crypto
    .createHmac('sha256', Buffer.from(pairingKeyValue, 'base64'))
    .update(`session|${phoneNonce}|${serverNonce}`)
    .digest('base64')
}

// 安全要求：发现包只用于「看见设备」，绝不携带配对密钥。
// 否则同网段任何人发一个 probe 即可拿到密钥，进而伪装手机鉴权、推导会话密钥。
// 密钥交换只走二维码扫描或已建立的加密通道。
function buildDiscoveryPayload(type = 'codebridge_discovery_response') {
  const identity = getDesktopIdentity()
  return {
    type,
    protocol: DISCOVERY_PROTOCOL,
    version: 1,
    deviceId: identity.id,
    id: identity.id,
    deviceName: identity.name,
    name: identity.name,
    deviceType: identity.type,
    host: getLocalIP(),
    port: WS_PORT,
    joinPort: JOIN_PORT,
    relayPort: JOIN_PORT,
    tsHost: getTailscaleIPv4(),
    joinPublicKey: exportLanJoinPublicKey(),
    joinFingerprint: getJoinFingerprint(identity),
    capabilities: getNodeCapabilities(),
    networkId: ensureTrustedNetworkId(),
    discoveryPort: DISCOVERY_PORT,
    topologyRole: 'peer',
    timestamp: Date.now()
  }
}

function normalizeDiscoveredLanDevice(payload, remoteAddress) {
  if (!payload || payload.protocol !== DISCOVERY_PROTOCOL) return null
  const identity = getDesktopIdentity()
  const id = String(payload.deviceId || payload.id || '').trim()
  if (!id || id === identity.id) return null

  const deviceType = normalizeDeviceType(payload.deviceType || payload.type, 'WINDOWS_DESKTOP')
  const host = String(remoteAddress || payload.host || '').trim()
  const port = Number(payload.port || WS_PORT)
  const joinPort = Number(payload.joinPort || payload.relayPort || JOIN_PORT)
  const tsHost = normalizeNetworkHost(payload.tsHost || '')
  const pairingKeyValue = String(payload.pairingKey || payload.pk || '').trim()
  if (!host || !Number.isFinite(port)) return null
  const isTrusted = authorizedPhones.has(id) || pairedDesktopPeers.has(id) || isKnownTrustedNode(id)

  return {
    id,
    name: String(payload.deviceName || payload.name || id).trim(),
    deviceType,
    host,
    port,
    relayPort: Number.isFinite(joinPort) && joinPort > 0 ? joinPort : JOIN_PORT,
    tsHost,
    joinPort: Number.isFinite(joinPort) && joinPort > 0 ? joinPort : JOIN_PORT,
    joinPublicKey: String(payload.joinPublicKey || '').trim(),
    joinFingerprint: String(payload.joinFingerprint || '').trim(),
    capabilities: payload.capabilities && typeof payload.capabilities === 'object' ? payload.capabilities : {},
    networkId: String(payload.networkId || '').trim(),
    trustStatus: isTrusted ? 'trusted' : 'unconfirmed',
    pairingKey: pairingKeyValue,
    protocol: DISCOVERY_PROTOCOL,
    discoveredAt: Date.now(),
    canPair: !!pairingKeyValue,
    canRequestJoin: !isTrusted && !!payload.joinPublicKey
  }
}

function rememberDiscoveredLanDevice(device) {
  if (!device || !device.id) return
  // UDP discovery is unauthenticated. Keep its source address only as an
  // ephemeral connection candidate; connectDesktopPeer commits it after the
  // derived-key handshake proves possession of the paired secret.
  discoveredLanDevices.set(device.id, decorateDiscoveredLanDevice(device))
  if (mainWindow) {
    mainWindow.webContents.send('lan-devices-changed', getDiscoveredLanDevices())
  }
}

function decorateDiscoveredLanDevice(device) {
  if (!device || !device.id) return device
  const isTrusted = isKnownTrustedNode(device.id)
  if (!isTrusted) return device
  return {
    ...device,
    trustStatus: 'trusted',
    canPair: false,
    canRequestJoin: false
  }
}

function getDiscoveredLanDevices() {
  const cutoff = Date.now() - 30000
  for (const [id, device] of discoveredLanDevices.entries()) {
    if ((device.discoveredAt || 0) < cutoff) {
      discoveredLanDevices.delete(id)
    }
  }
  return Array.from(discoveredLanDevices.values())
    .map(decorateDiscoveredLanDevice)
    .sort((a, b) => (b.discoveredAt || 0) - (a.discoveredAt || 0))
}

function ipToInt(address) {
  return address.split('.').reduce((acc, part) => ((acc << 8) + Number(part)) >>> 0, 0)
}

function intToIp(value) {
  return [24, 16, 8, 0].map(shift => (value >>> shift) & 255).join('.')
}

function getBroadcastAddresses() {
  const addresses = new Set(['255.255.255.255'])
  for (const iface of Object.values(os.networkInterfaces())) {
    for (const net of iface || []) {
      if (net.family !== 'IPv4' || net.internal || !net.address || !net.netmask) continue
      try {
        const broadcast = (ipToInt(net.address) | (~ipToInt(net.netmask))) >>> 0
        addresses.add(intToIp(broadcast))
      } catch (_) {}
    }
  }
  return Array.from(addresses)
}

function sendDiscoveryPacket(payload, address, port = DISCOVERY_PORT) {
  if (!discoverySocket) return
  const message = Buffer.from(JSON.stringify(payload), 'utf8')
  try {
    discoverySocket.send(message, port, address)
  } catch (e) {
    console.error('发送局域网发现包失败:', e.message)
  }
}

function broadcastDiscoveryProbe() {
  const payload = buildDiscoveryPayload('codebridge_discovery_probe')
  for (const address of getBroadcastAddresses()) {
    sendDiscoveryPacket(payload, address, DISCOVERY_PORT)
  }
  // Tailscale 不转发 UDP 广播：纯 Tailscale 场景（两台设备从未同网段）下
  // 广播探测完全到不了对端，这里另行枚举 tailnet 对端逐个单播（异步补发，
  // 响应与广播响应走同一收包路径）
  probeTailnetPeers()
}

// ==================== Tailnet 单播发现 ====================

const TAILSCALE_STATUS_TIMEOUT_MS = 4000
let tailnetProbeInFlight = false

function execTailscaleStatus(binPath) {
  return new Promise((resolve, reject) => {
    execFile(binPath, ['status', '--json'], {
      timeout: TAILSCALE_STATUS_TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true
    }, (error, stdout) => {
      if (error) return reject(error)
      resolve(stdout)
    })
  })
}

// 通过 tailscale CLI 枚举 tailnet 内在线对端的 IPv4（100.64.0.0/10）。
// 未安装 / 未登录 / CLI 不在候选路径时静默返回空数组，发现功能退化为纯广播。
async function listTailnetPeerIPv4s() {
  const binCandidates = process.platform === 'win32'
    ? ['tailscale', 'C:\\Program Files\\Tailscale\\tailscale.exe']
    : ['tailscale', '/usr/local/bin/tailscale', '/Applications/Tailscale.app/Contents/MacOS/Tailscale']
  for (const bin of binCandidates) {
    let stdout
    try {
      stdout = await execTailscaleStatus(bin)
    } catch (_) {
      continue
    }
    try {
      const status = JSON.parse(stdout)
      return Object.values(status.Peer || {})
        .filter(peer => peer && peer.Online === true)
        .flatMap(peer => peer.TailscaleIPs || [])
        .filter(isTailscaleAddress)
    } catch (e) {
      console.error('解析 tailscale status 输出失败:', e.message)
      return []
    }
  }
  return []
}

async function probeTailnetPeers() {
  if (tailnetProbeInFlight || !discoverySocket) return
  tailnetProbeInFlight = true
  try {
    const peerIPs = await listTailnetPeerIPv4s()
    if (peerIPs.length === 0) return
    const payload = buildDiscoveryPayload('codebridge_discovery_probe')
    // 对端回包与后续连接都要走隧道，探测包里携带本机 Tailscale IP
    // 而不是局域网 IP（后者对 tailnet 对端不可达）
    const tsHost = getTailscaleIPv4()
    if (tsHost) payload.host = tsHost
    for (const ip of peerIPs) {
      sendDiscoveryPacket(payload, ip, DISCOVERY_PORT)
    }
    console.log(`已向 ${peerIPs.length} 个 tailnet 在线节点单播发现探测`)
  } catch (e) {
    console.error('Tailnet 发现探测失败:', e.message)
  } finally {
    tailnetProbeInFlight = false
  }
}

function startLanDiscoveryService() {
  if (discoverySocket) return
  discoverySocket = dgram.createSocket({ type: 'udp4', reuseAddr: true })

  discoverySocket.on('error', (error) => {
    console.error('LAN discovery socket error:', error)
  })

  discoverySocket.on('message', (message, rinfo) => {
    try {
      const payload = JSON.parse(message.toString('utf8'))
      if (payload.protocol !== DISCOVERY_PROTOCOL) return

      const discovered = normalizeDiscoveredLanDevice(payload, rinfo.address)
      if (discovered) {
        rememberDiscoveredLanDevice(discovered)
      }

      if (payload.type === 'codebridge_discovery_probe') {
        const response = buildDiscoveryPayload('codebridge_discovery_response')
        // 探测来自 tailnet 对端时，回报本机 Tailscale IP（局域网 IP 对其不可达）
        response.host = isTailscaleAddress(rinfo.address)
          ? (getTailscaleIPv4() || getLocalIP())
          : getLocalIP()
        sendDiscoveryPacket(response, rinfo.address, rinfo.port)
      }
    } catch (e) {
      console.error('解析局域网发现包失败:', e.message)
    }
  })

  discoverySocket.bind(DISCOVERY_PORT, () => {
    try {
      discoverySocket.setBroadcast(true)
    } catch (e) {
      console.error('启用 UDP 广播失败:', e.message)
    }
  })
}

// 扫描窗口：局域网广播响应通常 <1s；tailnet 单播多出一次 CLI 调用 + 隧道往返，
// 窗口放宽到 3.5s。窗口结束后迟到的响应仍会进入发现列表并推送给界面。
function scanLanDevices(timeoutMs = 3500) {
  startLanDiscoveryService()
  discoveredLanDevices.clear()
  broadcastDiscoveryProbe()
  return new Promise(resolve => {
    setTimeout(() => resolve(getDiscoveredLanDevices()), timeoutMs)
  })
}

function getTrustedPeerCount() {
  return Array.from(authorizedPhones.values()).filter(phone => phone?.pairingKey && phone.enabled !== false).length +
    Array.from(pairedDesktopPeers.values()).filter(peer => peer?.pairingKey && peer.enabled !== false).length
}

function adoptTrustedNetworkId(networkId, options = {}) {
  const incoming = String(networkId || '').trim()
  if (!incoming) return ensureTrustedNetworkId()
  const existing = String(trustedNetworkId || '').trim()
  if (existing && existing !== incoming && getTrustedPeerCount() > 0) {
    if (options.allowMerge !== true) throw new Error('network_id_mismatch')
    mergeTrustedNetworkId(incoming, options.mergeFromNetworkIds || [])
    return trustedNetworkId
  }
  mergeTrustedNetworkId(incoming, options.mergeFromNetworkIds || [])
  savePairingKey()
  return trustedNetworkId
}

function buildLanJoinNodeProfile(extra = {}) {
  const identity = getDesktopIdentity()
  const now = Date.now()
  return {
    id: identity.id,
    deviceId: identity.id,
    name: identity.name,
    deviceName: identity.name,
    type: identity.type,
    deviceType: identity.type,
    host: getLocalIP(),
    port: WS_PORT,
    joinPort: JOIN_PORT,
    relayPort: JOIN_PORT,
    tsHost: getTailscaleIPv4(),
    networkId: ensureTrustedNetworkId(),
    autoPaired: false,
    trustSourceId: identity.id,
    trustLevel: 'local',
    acceptedAt: now,
    capabilities: getNodeCapabilities(),
    ...extra
  }
}

function readHttpRequestBody(req, maxBytes = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let total = 0
    req.on('data', chunk => {
      total += chunk.length
      if (total > maxBytes) {
        reject(new Error('request_too_large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function sendJsonResponse(res, statusCode, body) {
  const json = JSON.stringify(body || {})
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(json)
  })
  res.end(json)
}

function sendBinaryResponse(res, statusCode, body, headers = {}) {
  const buffer = Buffer.isBuffer(body) ? body : Buffer.from(body || '')
  res.writeHead(statusCode, {
    'Content-Type': 'application/octet-stream',
    'Content-Length': buffer.length,
    'Cache-Control': 'no-store',
    ...headers
  })
  res.end(buffer)
}

function postJsonForResponse(host, port, body, options = {}) {
  const timeoutMs = options.timeoutMs || 45000
  const pathName = options.path || '/join'
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(body || {}), 'utf8')
    const req = http.request({
      hostname: host,
      port,
      path: pathName,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': payload.length
      },
      timeout: timeoutMs
    }, res => {
      const chunks = []
      res.on('data', chunk => chunks.push(chunk))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        let parsed = null
        try {
          parsed = text ? JSON.parse(text) : {}
        } catch (e) {
          return reject(new Error(`invalid_response: ${e.message}`))
        }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const reason = parsed?.reason || parsed?.error || `http_${res.statusCode}`
          return reject(new Error(reason))
        }
        resolve(parsed)
      })
    })
    req.on('timeout', () => {
      req.destroy(new Error('join_request_timeout'))
    })
    req.on('error', reject)
    req.write(payload)
    req.end()
  })
}

function storeTrustedNodeFromJoin(node, options = {}) {
  const type = normalizeDeviceType(node?.deviceType || node?.type, 'UNKNOWN_DEVICE')
  const id = String(node?.id || node?.deviceId || '').trim()
  const host = normalizeNetworkHost(node?.host || node?.lastIP || '')
  const nodePairingKey = String(options.pairingKey || node?.pairingKey || node?.pk || '').trim()
  if (!id || !host || !nodePairingKey) throw new Error('invalid_join_node')

  const acceptedAt = Number(options.acceptedAt || node?.acceptedAt || Date.now())
  const common = {
    networkId: options.networkId || node?.networkId || ensureTrustedNetworkId(),
    autoPaired: options.autoPaired !== false,
    trustSourceId: options.trustSourceId || node?.trustSourceId || '',
    trustLevel: options.trustLevel || node?.trustLevel || 'trusted_lan',
    acceptedAt,
    capabilities: node?.capabilities || options.capabilities || {},
    contentPolicy: options.contentPolicy || node?.contentPolicy
  }

  if (type.includes('PHONE')) {
    return upsertAuthorizedPhone({
      phoneId: id,
      phoneName: node?.name || node?.deviceName || 'Android Phone',
      clientIP: host,
      deviceType: type,
      pairingKey: nodePairingKey,
      relayPort: Number(node?.relayPort || node?.joinPort || node?.port) || JOIN_PORT,
      relayHost: host,
      tsHost: node?.tsHost,
      ...common
    })
  }

  return upsertPairedDesktopPeer({
    id,
    name: node?.name || node?.deviceName || `Desktop ${host}`,
    deviceType: type,
    host,
    port: Number(node?.port) || WS_PORT,
    pairingKey: nodePairingKey,
    tsHost: node?.tsHost,
    ...common
  })
}

function normalizeLanJoinDevice(device) {
  const id = String(device?.id || device?.deviceId || '').trim()
  const host = normalizeNetworkHost(device?.host || '')
  const joinPublicKey = String(device?.joinPublicKey || '').trim()
  const joinPort = Number(device?.joinPort || JOIN_PORT)
  if (!id || !host || !joinPublicKey || !Number.isFinite(joinPort) || joinPort <= 0) {
    return null
  }
  return {
    ...device,
    id,
    host,
    joinPort,
    joinPublicKey,
    deviceType: normalizeDeviceType(device?.deviceType || device?.type, 'UNKNOWN_DEVICE')
  }
}

async function requestLanJoin(device, template = 'basic') {
  if (!pairingKey) loadOrCreatePairingKey()
  const target = normalizeLanJoinDevice(device)
  if (!target) return { success: false, error: 'invalid_lan_join_target' }
  if (isKnownTrustedNode(target.id)) {
    return {
      success: true,
      alreadyTrusted: true,
      peer: authorizedPhones.get(target.id) || pairedDesktopPeers.get(target.id) || topologyLsdb.nodes.get(target.id) || target
    }
  }

  const identity = getDesktopIdentity()
  const previousNetworkId = String(trustedNetworkId || '').trim()
  const requestId = `join-${Date.now()}-${crypto.randomBytes(6).toString('hex')}`
  const { publicKey, sessionKey } = createLanJoinRequestKey(target.joinPublicKey)
  const policy = contentPolicyForJoinTemplate(template)
  const requestPayload = {
    nodePairingKey: pairingKey,
    requestedContentPolicy: policy,
    networkId: trustedNetworkId || '',
    topologySnapshot: getTrustedPeerCount() > 0 ? buildTopologyDelta('lan_join_request_snapshot') : null,
    node: buildLanJoinNodeProfile({
      networkId: trustedNetworkId || '',
      trustLevel: 'join_request'
    })
  }

  const body = {
    type: 'join_request',
    protocol: DISCOVERY_PROTOCOL,
    version: 1,
    requestId,
    nodeId: identity.id,
    nodeName: identity.name,
    nodeType: identity.type,
    host: getLocalIP(),
    port: WS_PORT,
    joinPort: JOIN_PORT,
    capabilities: getNodeCapabilities(),
    ephemeralPublicKey: publicKey,
    fingerprint: getJoinFingerprint(identity),
    payload: encryptMessage(JSON.stringify(requestPayload), sessionKey)
  }

  const response = await postJsonForResponse(target.host, target.joinPort, body, { timeoutMs: 90000 })
  if (response.type === 'join_reject') {
    return { success: false, rejected: true, error: response.reason || 'join_rejected' }
  }
  if (response.type !== 'join_accept' || !response.payload) {
    return { success: false, error: 'invalid_join_accept' }
  }

  const acceptPlain = decryptMessage(response.payload, sessionKey)
  if (!acceptPlain) return { success: false, error: 'decrypt_join_accept_failed' }
  const accept = JSON.parse(acceptPlain)
  const mergeFromNetworkIds = uniqueNetworkIds([
    previousNetworkId,
    ...normalizeNetworkMergeIds(accept.mergeFromNetworkIds || [])
  ])
  adoptTrustedNetworkId(accept.networkId, { allowMerge: true, mergeFromNetworkIds })
  const acceptedAt = Number(accept.acceptedAt || Date.now())
  const acceptorNode = accept.node || {
    id: target.id,
    name: target.name,
    type: target.deviceType,
    host: target.host,
    port: target.port || WS_PORT,
    joinPort: target.joinPort,
    capabilities: target.capabilities || {}
  }
  const peer = storeTrustedNodeFromJoin(acceptorNode, {
    pairingKey: accept.nodePairingKey,
    networkId: accept.networkId,
    autoPaired: true,
    trustSourceId: accept.acceptedByNodeId || acceptorNode.id,
    trustLevel: 'trusted_lan',
    acceptedAt,
    contentPolicy: accept.initialContentPolicy
  })

  if (accept.topologySnapshot) {
    applyTopologyDeltaPayload(
      rewriteTopologyDeltaNetwork(accept.topologySnapshot, accept.networkId, mergeFromNetworkIds),
      { excludeNodeId: accept.acceptedByNodeId || peer.id }
    )
  }
  syncLocalTopologyIntoLsdb('lan_join_accepted')
  broadcastTopologyToAllPeers('lan_join_accepted', { mergeFromNetworkIds })
  return { success: true, peer, networkId: accept.networkId }
}

function respondLanJoinRequest(requestId, accepted, template = 'basic') {
  const pending = pendingLanJoinRequests.get(requestId)
  if (!pending) return { success: false, error: 'join_request_not_found' }
  pendingLanJoinRequests.delete(requestId)
  clearTimeout(pending.timer)
  pending.resolve({
    accepted: accepted === true,
    template: String(template || 'basic')
  })
  return { success: true }
}

function promptLanJoinRequest(request) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return Promise.resolve({ accepted: false, template: 'basic' })
  }
  showMainWindow()
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      pendingLanJoinRequests.delete(request.requestId)
      resolve({ accepted: false, template: 'basic', timeout: true })
    }, 120000)
    pendingLanJoinRequests.set(request.requestId, { resolve, timer })
    mainWindow.webContents.send('lan-join-request', request)
  })
}

async function handleLanJoinRequest(body, remoteAddress = '') {
  if (!allowLanJoinRequests) {
    return { status: 403, body: { type: 'join_reject', reason: 'join_requests_disabled' } }
  }
  if (!body || body.type !== 'join_request' || body.protocol !== DISCOVERY_PROTOCOL) {
    return { status: 400, body: { type: 'join_reject', reason: 'invalid_join_request' } }
  }

  const requestId = String(body.requestId || '').trim()
  const requesterPublicKey = String(body.ephemeralPublicKey || '').trim()
  const encryptedPayload = String(body.payload || '').trim()
  if (!requestId || !requesterPublicKey || !encryptedPayload) {
    return { status: 400, body: { type: 'join_reject', reason: 'missing_join_fields' } }
  }

  const sessionKey = createLanJoinAcceptKey(requesterPublicKey)
  const plain = decryptMessage(encryptedPayload, sessionKey)
  if (!plain) {
    return { status: 400, body: { type: 'join_reject', reason: 'decrypt_failed' } }
  }
  const payload = JSON.parse(plain)
  const requesterNode = payload.node || {
    id: body.nodeId,
    name: body.nodeName,
    type: body.nodeType,
    host: body.host,
    port: body.port,
    joinPort: body.joinPort,
    capabilities: body.capabilities || {}
  }
  const nodeId = String(requesterNode.id || requesterNode.deviceId || body.nodeId || '').trim()
  const requesterPairingKey = String(payload.nodePairingKey || requesterNode.pairingKey || '').trim()
  if (!nodeId || !requesterPairingKey) {
    return { status: 400, body: { type: 'join_reject', requestId, reason: 'invalid_requester_identity' } }
  }

  const requestView = {
    requestId,
    nodeId,
    nodeName: requesterNode.name || requesterNode.deviceName || body.nodeName || nodeId,
    nodeType: normalizeDeviceType(requesterNode.type || requesterNode.deviceType || body.nodeType, 'UNKNOWN_DEVICE'),
    host: normalizeNetworkHost(requesterNode.host || body.host || remoteAddress || ''),
    port: Number(requesterNode.port || body.port) || WS_PORT,
    joinPort: Number(requesterNode.joinPort || body.joinPort) || JOIN_PORT,
    fingerprint: body.fingerprint || '',
    capabilities: requesterNode.capabilities || body.capabilities || {},
    networkId: payload.networkId || '',
    requestedContentPolicy: payload.requestedContentPolicy || {}
  }

  const decision = await promptLanJoinRequest(requestView)
  if (!decision.accepted) {
    return { status: 200, body: { type: 'join_reject', requestId, reason: decision.timeout ? 'join_request_timeout' : 'user_rejected' } }
  }

  const acceptedAt = Date.now()
  const contentPolicy = contentPolicyForJoinTemplate(decision.template || 'basic')
  const networkId = ensureTrustedNetworkId()
  const mergeFromNetworkIds = uniqueNetworkIds([
    payload.networkId,
    payload.topologySnapshot && payload.topologySnapshot.networkId,
    ...normalizeNetworkMergeIds(payload.topologySnapshot?.mergeFromNetworkIds || [])
  ]).filter(id => id !== networkId)
  const trustedNode = {
    ...requesterNode,
    id: nodeId,
    host: requestView.host,
    port: requestView.port,
    joinPort: requestView.joinPort,
    networkId,
    autoPaired: true,
    trustSourceId: getDesktopIdentity().id,
    trustLevel: 'trusted_lan',
    acceptedAt,
    pairingKey: requesterPairingKey,
    contentPolicy
  }
  const peer = storeTrustedNodeFromJoin(trustedNode, {
    pairingKey: requesterPairingKey,
    networkId,
    autoPaired: true,
    trustSourceId: getDesktopIdentity().id,
    trustLevel: 'trusted_lan',
    acceptedAt,
    contentPolicy
  })

  if (payload.topologySnapshot) {
    applyTopologyDeltaPayload(
      rewriteTopologyDeltaNetwork(payload.topologySnapshot, networkId, mergeFromNetworkIds),
      { excludeNodeId: nodeId }
    )
  }

  syncLocalTopologyIntoLsdb('lan_join_accept')
  const delta = buildTopologyDelta('lan_join_accept', { mergeFromNetworkIds })
  broadcastTopologyToAllPeers('lan_join_accept', { baseDelta: delta })

  const acceptPayload = {
    networkId,
    mergeFromNetworkIds,
    acceptedByNodeId: getDesktopIdentity().id,
    acceptedAt,
    nodePairingKey: pairingKey,
    initialContentPolicy: contentPolicy,
    topologySnapshot: delta,
    node: buildLanJoinNodeProfile({
      pairingKey,
      networkId,
      autoPaired: false,
      trustLevel: 'local'
    })
  }

  return {
    status: 200,
    body: {
      type: 'join_accept',
      protocol: DISCOVERY_PROTOCOL,
      version: 1,
      requestId,
      acceptedNodeId: peer.id,
      payload: encryptMessage(JSON.stringify(acceptPayload), sessionKey)
    }
  }
}

function handleBusMessageRequest(body, remoteAddress = '') {
  const parsed = parseBusTransportEnvelope(body, senderId => [pairingKey, lookupPeerPairingKey(senderId)])
  if (!parsed) {
    return { status: 403, body: { type: 'bus_ack', accepted: false, reason: 'invalid_bus_envelope' } }
  }
  const { senderId, nonce, envelope, peerKey } = parsed
  const signedAck = (accepted, extras = {}) => busAck.buildBusAck(peerKey, {
    nonce,
    messageId: envelope.messageId,
    accepted
  }, extras)
  if (!isKnownTrustedNode(senderId)) {
    return {
      status: 403,
      body: signedAck(false, { reason: 'untrusted_sender' }) || {
        type: 'bus_ack',
        accepted: false,
        messageId: envelope.messageId,
        reason: 'untrusted_sender'
      }
    }
  }
  const routePath = Array.isArray(envelope.routePath) ? envelope.routePath : []
  if (routePath.includes(getDesktopIdentity().id)) {
    return {
      status: 202,
      body: signedAck(true, { duplicate: true })
    }
  }
  const accepted = getContentBus().receiveEnvelope(envelope, {
    lastHopDeviceId: senderId,
    remoteAddress
  })
  return {
    status: accepted ? 200 : 202,
    body: signedAck(accepted)
  }
}

function handleLegacyRelayRequest(body, remoteAddress = '') {
  if (!body || body.type !== 'codebridge_relay') {
    return { status: 400, body: { ok: false, error: 'invalid_relay_envelope' } }
  }
  const senderId = String(body.senderId || '').trim()
  const nonce = String(body.nonce || '').trim()
  const encryptedPayload = String(body.payload || '').trim()
  const authToken = String(body.authToken || '').trim()
  if (!senderId || !nonce || !encryptedPayload || !authToken) {
    return { status: 400, body: { ok: false, error: 'missing_relay_fields' } }
  }
  if (!isKnownTrustedNode(senderId)) {
    return { status: 403, body: { ok: false, error: 'untrusted_sender' } }
  }
  const keys = Array.from(new Set([pairingKey, lookupPeerPairingKey(senderId)]
    .map(key => String(key || '').trim())
    .filter(Boolean)))
  for (const key of keys) {
    const expected = hmacBase64(key, `${senderId}|${nonce}|${encryptedPayload}`)
    if (!timingSafeEqual(expected, authToken)) continue
    if (isReplayedBusNonce(senderId, `relay:${nonce}`)) {
      return { status: 202, body: { ok: true, duplicate: true } }
    }
    const plain = decryptMessage(encryptedPayload, key)
    if (!plain) return { status: 403, body: { ok: false, error: 'decrypt_failed' } }
    const payload = runCatchingJson(plain)
    if (!payload) return { status: 400, body: { ok: false, error: 'invalid_relay_payload' } }
    const sentAt = Number(payload.relaySentAt || 0)
    if (sentAt > 0 && Math.abs(Date.now() - sentAt) > BUS_REPLAY_WINDOW_MS) {
      return { status: 202, body: { ok: true, stale: true } }
    }
    dispatchInboundCodeData(payload, senderId)
    return { status: 200, body: { ok: true, remoteAddress } }
  }
  return { status: 403, body: { ok: false, error: 'relay_auth_failed' } }
}

function startLanJoinServer() {
  if (lanJoinServer) return
  lanJoinServer = http.createServer(async (req, res) => {
    try {
      const parsedUrl = new URL(req.url || '/', 'http://127.0.0.1')
      if (req.method === 'GET' && (parsedUrl.pathname.startsWith('/file/proxy/') || parsedUrl.pathname.startsWith('/bus/file/proxy/'))) {
        await handleFileProxyRequest(parsedUrl, res)
        return
      }
      if (req.method === 'GET' && (parsedUrl.pathname.startsWith('/file/') || parsedUrl.pathname.startsWith('/bus/file/'))) {
        await handleFileChunkRequest(parsedUrl, res)
        return
      }
      if (req.method === 'POST' && parsedUrl.pathname === '/bus/message') {
        const raw = await readHttpRequestBody(req)
        const body = raw ? JSON.parse(raw) : {}
        const result = handleBusMessageRequest(body, req.socket?.remoteAddress || '')
        sendJsonResponse(res, result.status || 200, result.body || {})
        return
      }
      if (req.method === 'POST' && parsedUrl.pathname === '/relay') {
        const raw = await readHttpRequestBody(req)
        const body = raw ? JSON.parse(raw) : {}
        const result = handleLegacyRelayRequest(body, req.socket?.remoteAddress || '')
        sendJsonResponse(res, result.status || 200, result.body || {})
        return
      }
      if (req.method !== 'POST' || parsedUrl.pathname !== '/join') {
        sendJsonResponse(res, 404, { error: 'not_found' })
        return
      }
      const raw = await readHttpRequestBody(req)
      const body = raw ? JSON.parse(raw) : {}
      const result = await handleLanJoinRequest(body, req.socket?.remoteAddress || '')
      sendJsonResponse(res, result.status || 200, result.body || {})
    } catch (error) {
      console.error('LAN join request failed:', error)
      sendJsonResponse(res, 500, { type: 'join_reject', reason: error.message || 'join_failed' })
    }
  })
  lanJoinServer.on('error', error => {
    console.error(`LAN join server failed on ${JOIN_PORT}:`, error.message)
  })
  lanJoinServer.listen(JOIN_PORT, '0.0.0.0')
}

async function handleFileChunkRequest(parsedUrl, res) {
  const fileId = decodeURIComponent(
    parsedUrl.pathname.startsWith('/bus/file/')
      ? parsedUrl.pathname.slice('/bus/file/'.length)
      : parsedUrl.pathname.slice('/file/'.length)
  )
  await serveLocalFileChunk(fileId, parsedUrl, res)
}

async function serveLocalFileChunk(fileId, parsedUrl, res) {
  try {
    if (!fileId) {
      sendJsonResponse(res, 400, { error: 'missing_file_id' })
      return
    }
    const transfer = initFileTransfer()
    const result = await transfer.serveFileChunk({
      fileId,
      from: parsedUrl.searchParams.get('from'),
      to: parsedUrl.searchParams.get('to'),
      senderId: parsedUrl.searchParams.get('senderId'),
      nonce: parsedUrl.searchParams.get('nonce'),
      authToken: parsedUrl.searchParams.get('authToken'),
      chunkEncoding: parsedUrl.searchParams.get('chunkEncoding') || 'aes-gcm'
    })
    if (!result || result.status !== 206 || !Buffer.isBuffer(result.body)) {
      sendJsonResponse(res, result?.status || 500, { error: 'file_chunk_unavailable' })
      return
    }
    sendBinaryResponse(res, 206, result.body, {
      'Accept-Ranges': 'bytes',
      'Content-Range': result.contentRange || '',
      'X-CodeBridge-File-Size': String(result.totalSize || '')
    })
  } catch (error) {
    console.error('File chunk request failed:', error)
    sendJsonResponse(res, 500, { error: error.message || 'file_chunk_failed' })
  }
}

// 多跳分片代理：GET /file/proxy/{originId}/{fileId}?from=&to=&senderId=&nonce=&authToken=&hop=N
// 鉴权与分片加密在请求方与源设备之间端到端完成，本节点只转发字节。
// 源就是本机时直接服务；否则源可直达就转直连请求，不可直达且 hop 有余量
// 时交给下一个可信节点继续代理（hop 递减防环）。
async function handleFileProxyRequest(parsedUrl, res) {
  try {
    const prefix = parsedUrl.pathname.startsWith('/bus/file/proxy/') ? '/bus/file/proxy/' : '/file/proxy/'
    const segments = parsedUrl.pathname.slice(prefix.length).split('/')
    const originId = decodeURIComponent(segments[0] || '')
    const fileId = decodeURIComponent(segments.slice(1).join('/') || '')
    if (!originId || !fileId) {
      sendJsonResponse(res, 400, { error: 'bad_proxy_path' })
      return
    }
    if (originId === getDesktopIdentity().id) {
      await serveLocalFileChunk(fileId, parsedUrl, res)
      return
    }
    const hop = Math.min(4, Math.max(0, Number(parsedUrl.searchParams.get('hop') || 0)))
    if (hop <= 0) {
      sendJsonResponse(res, 502, { error: 'proxy_hop_exhausted' })
      return
    }
    const baseQuery = ['from', 'to', 'senderId', 'nonce', 'authToken', 'chunkEncoding']
      .map(key => {
        const value = parsedUrl.searchParams.get(key)
        return value === null ? '' : `${key}=${encodeURIComponent(value)}`
      })
      .filter(Boolean)
      .join('&')
    const requesterId = parsedUrl.searchParams.get('senderId') || ''
    const origin = resolveFileSource(originId)
    let forwardHost = origin && origin.host ? origin.host : ''
    let forwardPort = origin ? origin.port : JOIN_PORT
    let forwardPath = `/file/${encodeURIComponent(fileId)}?${baseQuery}`
    if (!forwardHost) {
      const next = resolveFileRelayCandidates(originId)
        .find(cand => cand.id !== requesterId)
      if (!next) {
        sendJsonResponse(res, 502, { error: 'origin_unreachable' })
        return
      }
      forwardHost = next.host
      forwardPort = next.port
      forwardPath = `/file/proxy/${encodeURIComponent(originId)}/${encodeURIComponent(fileId)}?${baseQuery}&hop=${hop - 1}`
    }
    const resp = await httpGetBinary({ host: forwardHost, port: forwardPort, path: forwardPath, timeoutMs: 20000 })
    if (!resp) {
      sendJsonResponse(res, 502, { error: 'proxy_forward_failed' })
      return
    }
    if (resp.status === 206) {
      sendBinaryResponse(res, 206, resp.body, { 'Accept-Ranges': 'bytes' })
    } else {
      sendJsonResponse(res, resp.status >= 100 && resp.status <= 599 ? resp.status : 502, { error: 'proxy_upstream_status' })
    }
  } catch (error) {
    console.error('File proxy request failed:', error)
    try {
      sendJsonResponse(res, 500, { error: 'proxy_error' })
    } catch (_) {}
  }
}

function truncateText(value, maxLength) {
  const text = String(value || '').trim()
  if (text.length <= maxLength) return text
  return text.slice(0, Math.max(0, maxLength - 3)).trimEnd() + '...'
}

function normalizeExternalEventPayload(payload = {}) {
  const channel = String(payload.channel || payload.source || payload.appName || 'external').trim().slice(0, 64) || 'external'
  const title = truncateText(payload.title || payload.subject || `${channel} event`, 160)
  const body = truncateText(payload.body || payload.message || payload.rawMessage || '', 1800)
  const url = normalizeExternalUrl(payload.url || payload.link || '')
  const timestamp = Number(payload.timestamp || payload.createdAt || Date.now())
  const priority = ['low', 'normal', 'high', 'critical'].includes(String(payload.priority || '').toLowerCase())
    ? String(payload.priority).toLowerCase()
    : 'normal'
  const dedupSeed = [
    channel,
    payload.eventId || payload.dedupKey || '',
    title,
    body,
    url,
    Number.isFinite(timestamp) ? timestamp : Date.now()
  ].join('|')
  const fallbackId = crypto.createHash('sha256').update(dedupSeed).digest('hex').slice(0, 24)
  const eventId = truncateText(payload.eventId || payload.dedupKey || `${channel}-${fallbackId}`, 180)
  const appName = truncateText(payload.appName || channel, 80)
  const target = payload.target && typeof payload.target === 'object' ? payload.target : {}
  return {
    channel,
    eventId,
    dedupKey: truncateText(payload.dedupKey || eventId, 180),
    title,
    body,
    url,
    appName,
    priority,
    timestamp: Number.isFinite(timestamp) ? timestamp : Date.now(),
    ttl: Math.max(0, Math.min(USER_MESSAGE_RELAY_TTL, Number(payload.ttl ?? payload.relayTtl ?? USER_MESSAGE_RELAY_TTL) || USER_MESSAGE_RELAY_TTL)),
    target: {
      mode: String(target.mode || '').trim().toLowerCase(),
      includeLocal: target.includeLocal !== false,
      deviceIds: Array.isArray(target.deviceIds)
        ? target.deviceIds.map(id => String(id || '').trim()).filter(Boolean)
        : []
    }
  }
}

function canPushExternalEventToNode(node, channel) {
  if (!node) return false
  if (!canPushContentToNode(node, CODE_TYPES.APP_NOTIFICATION)) return false
  if (!canPushContentToNode(node, CODE_TYPES.EXTERNAL_EVENT)) return false
  const policy = normalizePushContentPolicy(node.contentPolicy || node)
  if (policy.externalEventChannels.length === 0) return true
  return policy.externalEventChannels.includes(channel)
}

function resolveExternalEventTargetIds(event) {
  const identity = getDesktopIdentity()
  const explicitIds = event.target.deviceIds.filter(id => id && id !== identity.id)
  if (event.target.mode === 'devices' || explicitIds.length > 0) {
    const allowedTargets = getTargetSelectionsForType(CODE_TYPES.APP_NOTIFICATION, {
      requestedIds: explicitIds,
      permissionLabel: '通知推送权限未开启',
      allowNode: node => canPushExternalEventToNode(node, event.channel)
    })
      .filter(target => target.selected)
      .map(target => target.id)
    return Array.from(new Set(allowedTargets))
  }
  if (event.target.mode === 'local') return []

  return getTargetSelectionsForType(CODE_TYPES.APP_NOTIFICATION, {
    permissionLabel: '通知推送权限未开启',
    allowNode: node => canPushExternalEventToNode(node, event.channel)
  })
    .filter(target => target.id !== identity.id && target.selected)
    .map(target => target.id)
}

function showExternalEventLocally(event, bodyText) {
  pushBubble({
    type: CODE_TYPES.APP_NOTIFICATION,
    contentType: CODE_TYPES.APP_NOTIFICATION,
    appName: event.appName,
    title: event.title,
    rawMessage: bodyText,
    source: event.channel,
    sourceDeviceName: 'Local',
    timestamp: event.timestamp
  })
  showNotification(event.title, bodyText, { url: event.url })
}

function dispatchOutboundExternalEvent(payload = {}) {
  const event = normalizeExternalEventPayload(payload)
  const identity = getDesktopIdentity()
  const targetDeviceIds = resolveExternalEventTargetIds(event)
  const bodyText = event.url ? `${event.body}\n${event.url}`.trim() : event.body
  const originMessageId = event.dedupKey || event.eventId
  const outboundPayload = {
    type: CODE_TYPES.APP_NOTIFICATION,
    contentType: CODE_TYPES.APP_NOTIFICATION,
    appName: event.appName,
    title: event.title,
    source: event.channel,
    rawMessage: bodyText,
    timestamp: event.timestamp,
    phoneId: identity.id,
    phoneName: identity.name,
    sourceDeviceId: identity.id,
    sourceDeviceName: identity.name,
    sourceDeviceType: identity.type,
    originDeviceId: identity.id,
    originDeviceName: identity.name,
    originMessageId,
    relayMessageId: originMessageId,
    relayPath: [identity.id],
    relayTtl: event.ttl,
    targetDeviceIds,
    externalEvent: {
      channel: event.channel,
      eventId: event.eventId,
      dedupKey: event.dedupKey,
      url: event.url,
      priority: event.priority
    }
  }

  if (hasRecentDelivery(identity.id, originMessageId, outboundPayload)) {
    return {
      ok: true,
      duplicate: true,
      eventId: event.eventId,
      targetDeviceIds,
      forwarded: 0,
      deliveredLocal: false
    }
  }

  let deliveredLocal = false
  if (event.target.includeLocal && canReceiveContentType(CODE_TYPES.APP_NOTIFICATION)) {
    showExternalEventLocally(event, bodyText)
    deliveredLocal = true
  }

  let forwarded = 0
  for (const targetId of targetDeviceIds) {
    if (forwardMessageToNode(targetId, outboundPayload, originMessageId)) forwarded += 1
  }
  rememberDelivery(identity.id, originMessageId, outboundPayload)

  return {
    ok: true,
    eventId: event.eventId,
    channel: event.channel,
    targetDeviceIds,
    forwarded,
    deliveredLocal
  }
}

function normalizeLocalNotifyPayload(payload = {}) {
  const title = String(payload.title || payload.appName || 'CodeBridge').trim().slice(0, 120)
  const body = String(payload.body || payload.message || payload.rawMessage || '').trim().slice(0, 1200)
  const url = normalizeExternalUrl(payload.url || payload.link || '')
  const appName = String(payload.appName || payload.source || '本机脚本').trim().slice(0, 80)
  return {
    title: title || 'CodeBridge',
    body,
    url,
    appName: appName || '本机脚本'
  }
}

function handleLocalNotifyPayload(payload = {}) {
  const notification = normalizeLocalNotifyPayload(payload)
  const body = notification.url
    ? `${notification.body}\n${notification.url}`.trim()
    : notification.body

  pushBubble({
    type: CODE_TYPES.APP_NOTIFICATION,
    contentType: CODE_TYPES.APP_NOTIFICATION,
    appName: notification.appName,
    title: notification.title,
    rawMessage: body,
    source: notification.appName,
    sourceDeviceName: '本机',
    timestamp: Date.now()
  })
  showNotification(notification.title, body, { url: notification.url })
}

function startLocalNotifyServer() {
  if (localNotifyServer) return
  localNotifyServer = http.createServer(async (req, res) => {
    try {
    const requestUrl = new URL(req.url || '/', 'http://127.0.0.1')
    if (req.headers.origin) {
      sendJsonResponse(res, 403, { ok: false, error: 'browser_origin_not_allowed' })
      return
    }
    if (req.method === 'GET' && (requestUrl.pathname === '/health' || requestUrl.pathname === '/api/v1/events/health')) {
      sendJsonResponse(res, 200, {
        ok: true,
        service: 'codebridge-local-notify',
        eventsApi: {
          path: '/api/v1/events',
          tokenHeader: 'x-codebridge-token',
          tokenUrl: '/api/v1/events/token'
        }
      })
      return
    }
    if (req.method === 'GET' && requestUrl.pathname === '/api/v1/events/token') {
      sendJsonResponse(res, 200, {
        ok: true,
        token: ensureLocalEventToken(),
        header: 'x-codebridge-token'
      })
      return
    }
    if (req.method === 'POST' && requestUrl.pathname === '/api/v1/events/test') {
      if (!isLocalEventAuthorized(req)) {
        sendJsonResponse(res, 401, { ok: false, error: 'unauthorized' })
        return
      }
      const result = dispatchOutboundExternalEvent({
        channel: 'test',
        eventId: `test-${Date.now()}`,
        title: 'CodeBridge external event test',
        body: 'The local external event ingress API is working.',
        target: { mode: requestUrl.searchParams.get('mode') || 'local' }
      })
      sendJsonResponse(res, 200, result)
      return
    }
    if (req.method === 'POST' && requestUrl.pathname === '/api/v1/events') {
      if (!isLocalEventAuthorized(req)) {
        sendJsonResponse(res, 401, { ok: false, error: 'unauthorized' })
        return
      }
      try {
        const raw = await readHttpRequestBody(req, 64 * 1024)
        const body = raw ? JSON.parse(raw) : {}
        const result = dispatchOutboundExternalEvent(body)
        sendJsonResponse(res, 200, result)
      } catch (error) {
        console.error('Local external event request failed:', error)
        sendJsonResponse(res, 400, { ok: false, error: error.message || 'external_event_failed' })
      }
      return
    }
    if (req.method !== 'POST' || requestUrl.pathname !== '/notify') {
      sendJsonResponse(res, 404, { error: 'not_found' })
      return
    }
    try {
      const raw = await readHttpRequestBody(req, 16 * 1024)
      const body = raw ? JSON.parse(raw) : {}
      handleLocalNotifyPayload(body)
      sendJsonResponse(res, 200, { ok: true })
    } catch (error) {
      console.error('Local notify request failed:', error)
      sendJsonResponse(res, 400, { ok: false, error: error.message || 'notify_failed' })
    }
    } catch (error) {
      console.error('Unhandled local notify request error:', error)
      if (!res.headersSent) {
        sendJsonResponse(res, 500, { ok: false, error: 'internal_error' })
      } else {
        try { res.destroy() } catch (_) {}
      }
    }
  })
  localNotifyServer.on('error', error => {
    console.error(`Local notify server failed on ${LOCAL_NOTIFY_PORT}:`, error.message)
  })
  localNotifyServer.listen(LOCAL_NOTIFY_PORT, '127.0.0.1')
}

function setPhoneConnected(phoneId, connected) {
  const phone = authorizedPhones.get(phoneId)
  if (!phone) return
  phone.connected = connected
  phone.connectionUpdatedAt = Date.now()
  if (connected) {
    phone.lastSeen = phone.connectionUpdatedAt
  }
  notifyPhonesChanged({ topologyChanged: false })
}

function addActivePhoneConnection(phoneId, ws) {
  if (!activePhoneConnections.has(phoneId)) {
    activePhoneConnections.set(phoneId, new Set())
  }
  activePhoneConnections.get(phoneId).add(ws)
  setPhoneConnected(phoneId, true)
}

function nextLsdbSequence() {
  lsdbSequence = Math.max(lsdbSequence + 1, Date.now())
  return lsdbSequence
}

function syncLocalTopologyIntoLsdb(reason = 'local_state') {
  const identity = getDesktopIdentity()
  const now = Date.now()
  const localSeq = nextLsdbSequence()
  const existingLocalNode = topologyLsdb.nodes.get(identity.id)
  const localAcceptedAt = Number(existingLocalNode?.acceptedAt || 0) || now
  upsertTopologyLsdbNode({
    id: identity.id,
    name: identity.name,
    type: identity.type,
    role: 'local_desktop',
    host: getLocalIP(),
    port: WS_PORT,
    wsPort: WS_PORT,
    relayPort: JOIN_PORT,
    pairingKey,
    tsHost: getTailscaleIPv4(),
    networkId: ensureTrustedNetworkId(),
    autoPaired: false,
    trustSourceId: identity.id,
    trustLevel: 'local',
    acceptedAt: localAcceptedAt,
    capabilities: getNodeCapabilities(),
    status: 'online',
    connected: true,
    routable: true,
    authority: 'local_desktop',
    sourceId: identity.id,
    seq: localSeq,
    updatedAt: now,
    lastSeen: now
  })

  getAuthorizedPhones().forEach(phone => {
    if (!phone.id) return
    const phoneStateAt = Math.max(
      Number(phone.connectionUpdatedAt || 0) || 0,
      Number(phone.lastSeen || 0) || 0,
      Number(phone.firstSeen || 0) || 0
    )
    const phoneSeq = normalizeLsdbSeq(phoneStateAt, now)
    upsertTopologyLsdbNode({
      id: phone.id,
      name: phone.name || 'Android Phone',
      type: phone.deviceType || 'ANDROID_PHONE',
      role: 'phone',
      host: phone.lastIP,
      port: Number(phone.relayPort) || JOIN_PORT,
      relayPort: Number(phone.relayPort) || JOIN_PORT,
      pairingKey: phone.pairingKey,
      tsHost: phone.tsHost || '',
      networkId: phone.networkId || ensureTrustedNetworkId(),
      autoPaired: phone.autoPaired === true,
      trustSourceId: phone.trustSourceId || identity.id,
      trustLevel: phone.trustLevel || 'trusted_lan',
      acceptedAt: phone.acceptedAt || phone.firstSeen || now,
      capabilities: phone.capabilities || {},
      enabled: phone.enabled !== false,
      revoked: phone.revoked === true,
      contentPolicy: normalizePushContentPolicy(phone.contentPolicy || phone),
      connected: phone.connected === true,
      status: getPhoneTopologyStatus(phone),
      routable: phone.enabled !== false && phone.revoked !== true && !!phone.pairingKey && !!phone.lastIP,
      authority: 'source_device',
      sourceId: identity.id,
      seq: phoneSeq,
      updatedAt: phoneStateAt,
      lastSeen: phone.lastSeen || phone.connectionUpdatedAt || 0
    })
    const edgeEnabled = phone.enabled !== false && phone.revoked !== true && !!phone.pairingKey && !!phone.lastIP
    upsertTopologyLsdbLink({
      id: `${phone.id}->${identity.id}:verify-push`,
      from: phone.id,
      to: identity.id,
      type: 'verify_push',
      label: '短信 / TOTP 推送',
      direction: 'inbound',
      enabled: edgeEnabled,
      active: phone.connected === true,
      routable: edgeEnabled,
      authority: 'source_device',
      seq: phoneSeq,
      updatedAt: phoneStateAt,
      description: '手机作为来源设备，控制推送到当前设备节点的范围'
    })
    upsertTopologyLsdbLink({
      id: `${identity.id}->${phone.id}:routing-adjacency`,
      from: identity.id,
      to: phone.id,
      type: 'routing_adjacency',
      label: '路由表同步邻接',
      direction: 'outbound',
      enabled: edgeEnabled,
      active: phone.connected === true,
      routable: edgeEnabled,
      authority: 'link_state',
      seq: phoneSeq,
      updatedAt: phoneStateAt,
      description: '电脑节点向手机下发链路状态和 SPF 路由表'
    })
  })

  const routablePhones = getAuthorizedPhones().filter(phone =>
    phone.enabled !== false &&
    phone.revoked !== true &&
    phone.pairingKey &&
    phone.lastIP
  )
  for (const from of routablePhones) {
    for (const to of routablePhones) {
      if (from.id === to.id) continue
      const updatedAt = Math.max(from.lastSeen || 0, to.lastSeen || 0, now)
      upsertTopologyLsdbLink({
        id: `${from.id}->${to.id}:phone-relay-route`,
        from: from.id,
        to: to.id,
        type: 'relay_route',
        label: '节点直连 relay',
        direction: 'peer',
