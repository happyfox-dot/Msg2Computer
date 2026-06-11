const { app, BrowserWindow, Tray, Menu, Notification, clipboard, ipcMain, nativeImage, screen, safeStorage, shell, dialog } = require('electron')
const path = require('path')
const fs = require('fs')
const crypto = require('crypto')
const os = require('os')
const dgram = require('dgram')
const http = require('http')
const { WebSocketServer, WebSocket } = require('ws')
const QRCode = require('qrcode')
const storage = require('./src/storage')
const qrCodeParser = require('./src/qrCodeParser')

let mainWindow = null
let bubbleWindow = null
let bubbleTimer = null
let tray = null
let wss = null
let wsHeartbeatTimer = null
let pairingKey = null
let pairingQRData = null
let authorizedPhones = new Map()
let activePhoneConnections = new Map()
let pairedDesktopPeers = new Map()
let activeDesktopPeerConnections = new Map()
let desktopPeerHostAttempts = new Map()
let discoverySocket = null
let discoveredLanDevices = new Map()
let topologyLsdb = {
  nodes: new Map(),
  links: new Map(),
  seenSeq: new Map()
}
// 每条活跃连接对应的会话密钥（ws -> sessionKey base64），用于反向加密下发 TOTP 种子同步
let phoneSessionKeys = new WeakMap()
let totpSeeds = new Map()
let totpDeleteTombstones = []
let desktopMessageSettings = {
  receiveSmsCodes: true,
  receiveAllSms: true,
  receiveNotifications: true
}

const WS_PORT = 19527
const DISCOVERY_PORT = 19528
const DISCOVERY_PROTOCOL = 'codebridge-lan-discovery'
const CODE_TYPES = {
  SMS: 'sms',
  SMS_MESSAGE: 'sms_message',
  APP_NOTIFICATION: 'app_notification',
  TOTP: 'totp'
}
const DEFAULT_MESSAGE_SETTINGS = {
  receiveSmsCodes: true,
  receiveAllSms: true,
  receiveNotifications: true
}
const PAIRING_CONFIG_FILE = 'pairing.json'
const gotSingleInstanceLock = app.requestSingleInstanceLock()
const ICON_PATH = path.join(__dirname, 'assets', 'icon.ico')
const START_HIDDEN = process.argv.includes('--hidden')
const QUIT_FOR_UPDATE = process.argv.includes('--quit-for-update')
const LOCAL_TOTP_SOURCE_ID = 'desktop-local'
const TOTP_DELETE_TOMBSTONE_TTL_MS = 180 * 24 * 60 * 60 * 1000
const TOTP_DELETE_TOMBSTONE_LIMIT = 300
const ROUTING_PROTOCOL_VERSION = 2
const ROUTE_STALE_MS = 10 * 60 * 1000
const TOPOLOGY_DELTA_TTL = 4
const TOPOLOGY_ENTRY_TTL_MS = 24 * 60 * 60 * 1000
// BFD 式存活检测周期：一个周期未回 pong 即判定链路死亡并 terminate，
// 触发 close → 拓扑重收敛，不再依赖 TCP 自身超时（静默断链可能挂数分钟）
const WS_HEARTBEAT_INTERVAL_MS = 30 * 1000
// LSDB 序列号（OSPF LSA seq 的简化版）：每次下发路由表自增，手机端按
// 来源设备记录已接受的最大序列号，旧序列号的 topology_sync 直接丢弃。
// 用 Date.now() 做初值保证进程重启后序列号仍然单调递增，无需落盘。
let lsdbSequence = Date.now()
const ROUTE_TYPE_COST = {
  routing_adjacency: 10,
  verify_push: 12,
  totp_sync: 12,
  desktop_pair: 10,
  relay_route: 5,
  lan_discovery: 80
}

function getAppIcon() {
  if (!fs.existsSync(ICON_PATH)) {
    return nativeImage.createEmpty()
  }
  return nativeImage.createFromPath(ICON_PATH)
}

function showMainWindow() {
  if (!mainWindow) return
  if (mainWindow.isMinimized()) {
    mainWindow.restore()
  }
  mainWindow.show()
  mainWindow.focus()
}

function quitForUpdate() {
  app.isQuitting = true
  try {
    flushPendingPairingSave()
  } catch (error) {
    console.warn('更新前保存配置失败:', error)
  }
  try {
    if (tray) tray.destroy()
  } catch (_) {}
  try {
    if (bubbleWindow && !bubbleWindow.isDestroyed()) bubbleWindow.destroy()
  } catch (_) {}
  try {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.destroy()
  } catch (_) {}
  app.quit()
  setTimeout(() => app.exit(0), 1500).unref()
}

function shouldStartHidden() {
  if (START_HIDDEN) return true
  if (process.platform !== 'win32') return false

  try {
    const loginSettings = app.getLoginItemSettings()
    return loginSettings.wasOpenedAtLogin || loginSettings.wasOpenedAsHidden
  } catch (e) {
    console.error('Failed to read login item settings:', e)
    return false
  }
}

function configureAutoLaunch() {
  if (process.platform !== 'win32' || !app.isPackaged) return

  try {
    app.setLoginItemSettings({
      openAtLogin: true,
      args: ['--hidden']
    })
  } catch (e) {
    console.error('Failed to configure auto launch:', e)
  }
}

function hideCodeBubble() {
  if (bubbleTimer) {
    clearTimeout(bubbleTimer)
    bubbleTimer = null
  }
  if (bubbleWindow && !bubbleWindow.isDestroyed()) {
    bubbleWindow.close()
  }
  bubbleWindow = null
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[char]))
}

function buildCodeBubbleHtml(codeInfo) {
  const code = escapeHtml(codeInfo.code)
  const source = escapeHtml(codeInfo.source || '未知来源')
  const phoneName = escapeHtml(codeInfo.sourceDeviceName || codeInfo.phoneName || '未知设备')
  const time = escapeHtml(new Date(codeInfo.timestamp || Date.now()).toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit'
  }))

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    html, body {
      width: 100%;
      height: 100%;
      margin: 0;
      overflow: hidden;
      background: transparent;
      font-family: "Microsoft YaHei UI", "Segoe UI", sans-serif;
    }
    .bubble {
      box-sizing: border-box;
      height: calc(100% - 12px);
      margin: 6px;
      padding: 14px 16px 14px 18px;
      color: #f7f9fc;
      background: rgba(20, 22, 30, 0.98);
      border: 1px solid rgba(255, 255, 255, 0.14);
      border-radius: 8px;
      box-shadow: 0 16px 42px rgba(0, 0, 0, 0.34);
      display: grid;
      grid-template-columns: 4px 42px minmax(0, 1fr);
      align-items: center;
      gap: 12px;
      animation: enter 180ms ease-out;
    }
    .accent {
      width: 4px;
      height: 92px;
      border-radius: 999px;
      background: #5cdb8b;
      box-shadow: 0 0 18px rgba(92, 219, 139, 0.34);
    }
    .mark {
      width: 42px;
      height: 42px;
      flex: 0 0 auto;
      border-radius: 8px;
      background: rgba(92, 219, 139, 0.14);
      border: 1px solid rgba(92, 219, 139, 0.22);
      display: flex;
      align-items: center;
      justify-content: center;
      color: #5cdb8b;
      font-size: 18px;
      font-weight: 700;
    }
    .content {
      min-width: 0;
      flex: 1;
    }
    .title {
      display: flex;
      justify-content: space-between;
      gap: 10px;
      font-size: 12px;
      line-height: 18px;
      color: rgba(247, 249, 252, 0.72);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .copied {
      flex: 0 0 auto;
      padding: 1px 7px;
      border-radius: 999px;
      color: #5cdb8b;
      background: rgba(92, 219, 139, 0.12);
      font-size: 11px;
    }
    .code {
      margin-top: 4px;
      font-size: 34px;
      line-height: 38px;
      font-weight: 700;
      letter-spacing: 2px;
      color: #5cdb8b;
      word-break: break-all;
      font-family: "Cascadia Code", "Consolas", monospace;
    }
    .meta {
      margin-top: 7px;
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
      gap: 6px;
      font-size: 11px;
      line-height: 15px;
      color: rgba(247, 249, 252, 0.62);
    }
    .chip {
      min-width: 0;
      padding: 4px 7px;
      border-radius: 6px;
      background: rgba(255, 255, 255, 0.06);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    @keyframes enter {
      from { opacity: 0; transform: translateY(10px); }
      to { opacity: 1; transform: translateY(0); }
    }
  </style>
</head>
<body>
  <div class="bubble">
    <div class="accent"></div>
    <div class="mark">OTP</div>
    <div class="content">
      <div class="title"><span>新验证码</span><span class="copied">已复制</span></div>
      <div class="code">${code}</div>
      <div class="meta">
        <div class="chip">来源 ${source}</div>
        <div class="chip">设备 ${phoneName} · ${time}</div>
      </div>
    </div>
  </div>
</body>
</html>`
}

function showCodeBubble(codeInfo) {
  if (!app.isReady()) return

  hideCodeBubble()

  const bubbleWidth = 360
  const bubbleHeight = 154
  const margin = 18
  const workArea = screen.getPrimaryDisplay().workArea

  bubbleWindow = new BrowserWindow({
    width: bubbleWidth,
    height: bubbleHeight,
    x: workArea.x + workArea.width - bubbleWidth - margin,
    y: workArea.y + workArea.height - bubbleHeight - margin,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    movable: false,
    focusable: false,
    show: false,
    hasShadow: false,
    icon: ICON_PATH,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true
    }
  })

  bubbleWindow.setAlwaysOnTop(true, 'screen-saver')
  bubbleWindow.setIgnoreMouseEvents(true, { forward: true })
  bubbleWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(buildCodeBubbleHtml(codeInfo))}`)
  bubbleWindow.once('ready-to-show', () => {
    if (!bubbleWindow || bubbleWindow.isDestroyed()) return
    bubbleWindow.showInactive()
  })
  bubbleWindow.on('closed', () => {
    bubbleWindow = null
  })

  bubbleTimer = setTimeout(hideCodeBubble, 8000)
}

function createWindow(options = {}) {
  const hidden = options.hidden === true
  const primaryDisplay = screen.getPrimaryDisplay()
  const { width, height } = primaryDisplay.workAreaSize

  mainWindow = new BrowserWindow({
    width: 320,
    height: 560,
    x: width - 330,
    y: height - 570,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    show: false,
    icon: ICON_PATH,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true
    }
  })

  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'))
  mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })

  mainWindow.once('ready-to-show', () => {
    if (!hidden) {
      showMainWindow()
    }
  })

  mainWindow.on('close', (event) => {
    if (!app.isQuitting) {
      event.preventDefault()
      mainWindow.hide()
    }
  })

  mainWindow.on('minimize', (event) => {
    event.preventDefault()
    mainWindow.hide()
  })

  // 省电：窗口显示/隐藏时通知渲染层，隐藏后暂停 TOTP 倒计时定时器，避免后台空转重绘
  const sendVisibility = (visible) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('window-visibility', visible)
    }
  }
  mainWindow.on('show', () => sendVisibility(true))
  mainWindow.on('hide', () => sendVisibility(false))
  mainWindow.on('restore', () => sendVisibility(true))
}

function createTray() {
  const icon = getAppIcon()
  tray = new Tray(icon)
  tray.setToolTip('验证码同步 - 运行中')

  const contextMenu = Menu.buildFromTemplate([
    { label: '显示窗口', click: () => mainWindow && mainWindow.show() },
    { label: '隐藏窗口', click: () => mainWindow && mainWindow.hide() },
    { type: 'separator' },
    { label: '重新配对', click: regeneratePairingKey },
    { type: 'separator' },
    { label: '退出', click: () => { app.isQuitting = true; app.quit() } }
  ])
  tray.setContextMenu(contextMenu)
  tray.on('click', () => {
    if (mainWindow) {
      mainWindow.isVisible() ? mainWindow.hide() : mainWindow.show()
    }
  })
}

// 近期已处理消息记录：手机端 ACK 丢失会重连重发同一 msgId，按 (phoneId|msgId) 去重，
// 避免同一条验证码重复弹泡、重复覆盖剪贴板
const RECENT_DELIVERY_LIMIT = 300
const recentDeliveryKeys = new Set()
const recentDeliveryQueue = []

function hasRecentDelivery(phoneId, msgId) {
  return recentDeliveryKeys.has(`${phoneId}|${msgId}`)
}

function rememberDelivery(phoneId, msgId) {
  const key = `${phoneId}|${msgId}`
  if (recentDeliveryKeys.has(key)) return
  recentDeliveryKeys.add(key)
  recentDeliveryQueue.push(key)
  if (recentDeliveryQueue.length > RECENT_DELIVERY_LIMIT) {
    recentDeliveryKeys.delete(recentDeliveryQueue.shift())
  }
}

function getDesktopIdentity() {
  try {
    return {
      id: storage.getDeviceId(),
      name: storage.getDeviceName(),
      type: process.platform === 'win32'
        ? 'WINDOWS_DESKTOP'
        : (process.platform === 'darwin' ? 'MAC_DESKTOP' : 'LINUX_DESKTOP')
    }
  } catch (_) {
    return {
      id: `desktop-${crypto.createHash('sha256').update(os.hostname()).digest('hex').slice(0, 16)}`,
      name: os.hostname() || 'Desktop PC',
      type: 'WINDOWS_DESKTOP'
    }
  }
}

function generateNonce() {
  return crypto.randomBytes(16).toString('base64')
}

function hmacBase64(keyBase64, message) {
  return crypto
    .createHmac('sha256', Buffer.from(keyBase64, 'base64'))
    .update(message)
    .digest('base64')
}

function deriveSessionKey(phoneNonce, serverNonce) {
  return hmacBase64(pairingKey, `session|${phoneNonce}|${serverNonce}`)
}

function isValidAuthToken(phoneId, phoneNonce, authToken) {
  if (!pairingKey || !phoneId || !phoneNonce || !authToken) return false

  try {
    const expected = Buffer.from(hmacBase64(pairingKey, `${phoneId}|${phoneNonce}`), 'base64')
    const actual = Buffer.from(String(authToken), 'base64')
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual)
  } catch (e) {
    console.error('Failed to verify auth token:', e)
    return false
  }
}

function normalizeNetworkHost(value) {
  const host = String(value || '').trim()
  if (host.startsWith('::ffff:')) return host.slice(7)
  return host
}

function formatHttpHost(host) {
  const value = normalizeNetworkHost(host)
  return value.includes(':') && !value.startsWith('[') ? `[${value}]` : value
}

function normalizeLsdbSeq(value, fallback = Date.now()) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? Math.round(number) : fallback
}

function normalizeLsdbNode(raw = {}) {
  const id = String(raw.id || raw.deviceId || '').trim()
  if (!id) return null
  const type = normalizeDeviceType(raw.type || raw.deviceType, 'UNKNOWN_DEVICE')
  const isPhone = type.includes('PHONE')
  const host = normalizeNetworkHost(raw.host || raw.lastIP || raw.relayHost || '')
  const pairingKeyValue = String(raw.pairingKey || raw.pk || '').trim()
  const now = Date.now()
  const updatedAt = normalizeLsdbSeq(raw.updatedAt || raw.lastSeen, now)
  return {
    id,
    name: String(raw.name || raw.deviceName || id).trim(),
    type,
    role: raw.role || (type.includes('DESKTOP') ? 'desktop' : (isPhone ? 'phone' : 'peer')),
    host,
    lastIP: normalizeNetworkHost(raw.lastIP || host),
    port: Number(raw.port || raw.relayPort || (isPhone ? 19529 : WS_PORT)),
    pairingKey: pairingKeyValue,
    tsHost: String(raw.tsHost || '').trim(),
    altHosts: Array.isArray(raw.altHosts)
      ? raw.altHosts.map(normalizeNetworkHost).filter(Boolean)
      : [],
    enabled: raw.enabled !== false,
    revoked: raw.revoked === true,
    contentPolicy: normalizePushContentPolicy(raw.contentPolicy || raw),
    connected: raw.connected === true,
    status: raw.status || (raw.connected ? 'online' : 'offline'),
    authority: raw.authority || 'topology_gossip',
    routable: raw.routable === true || (!!host && !!pairingKeyValue && raw.enabled !== false && raw.revoked !== true),
    sourceId: String(raw.sourceId || raw.originDeviceId || raw.sourceDeviceId || '').trim(),
    seq: normalizeLsdbSeq(raw.seq || raw.updatedAt, updatedAt),
    updatedAt,
    lastSeen: normalizeLsdbSeq(raw.lastSeen || raw.updatedAt, updatedAt),
    expiresAt: Number(raw.expiresAt) || (updatedAt + TOPOLOGY_ENTRY_TTL_MS)
  }
}

function normalizeLsdbLink(raw = {}) {
  const from = String(raw.from || raw.source || '').trim()
  const to = String(raw.to || raw.target || '').trim()
  if (!from || !to) return null
  const type = String(raw.type || 'routing_adjacency').trim()
  const now = Date.now()
  const updatedAt = normalizeLsdbSeq(raw.updatedAt, now)
  return {
    id: String(raw.id || `${from}->${to}:${type}`).trim(),
    from,
    to,
    type,
    label: raw.label || '拓扑链路',
    direction: raw.direction || 'peer',
    enabled: raw.enabled !== false,
    active: raw.active === true,
    routable: raw.routable === true,
    contentPolicy: normalizePushContentPolicy(raw.contentPolicy || raw),
    authority: raw.authority || 'topology_gossip',
    metric: Number(raw.metric || 0) || undefined,
    description: raw.description || '',
    seq: normalizeLsdbSeq(raw.seq || raw.updatedAt, updatedAt),
    updatedAt,
    expiresAt: Number(raw.expiresAt) || (updatedAt + TOPOLOGY_ENTRY_TTL_MS)
  }
}

function upsertTopologyLsdbNode(rawNode) {
  const node = normalizeLsdbNode(rawNode)
  if (!node) return false
  const existing = topologyLsdb.nodes.get(node.id)
  if (existing && normalizeLsdbSeq(existing.seq, 0) > node.seq) return false
  const merged = existing ? { ...existing, ...node, pairingKey: node.pairingKey || existing.pairingKey } : node
  topologyLsdb.nodes.set(node.id, merged)
  return JSON.stringify(existing || {}) !== JSON.stringify(merged)
}

function upsertTopologyLsdbLink(rawLink) {
  const link = normalizeLsdbLink(rawLink)
  if (!link) return false
  const existing = topologyLsdb.links.get(link.id)
  if (existing && normalizeLsdbSeq(existing.seq, 0) > link.seq) return false
  const merged = existing ? { ...existing, ...link } : link
  topologyLsdb.links.set(link.id, merged)
  return JSON.stringify(existing || {}) !== JSON.stringify(merged)
}

function pruneTopologyLsdb() {
  const now = Date.now()
  const identity = getDesktopIdentity()
  for (const [id, node] of topologyLsdb.nodes.entries()) {
    if (id !== identity.id && node.expiresAt && node.expiresAt < now) {
      topologyLsdb.nodes.delete(id)
    }
  }
  for (const [id, link] of topologyLsdb.links.entries()) {
    if (link.expiresAt && link.expiresAt < now) {
      topologyLsdb.links.delete(id)
    }
  }
}

function importSavedTopologyLsdb(saved = {}) {
  topologyLsdb = {
    nodes: new Map(),
    links: new Map(),
    seenSeq: new Map()
  }
  ;(saved.nodes || []).forEach(node => {
    upsertTopologyLsdbNode({
      ...node,
      pairingKey: unprotectSecret(node.pairingKey || node.pk || '')
    })
  })
  ;(saved.links || []).forEach(link => upsertTopologyLsdbLink(link))
  ;(saved.seenSeq || []).forEach(item => {
    const id = String(item.id || item.sourceId || '').trim()
    const seq = Number(item.seq || 0)
    if (id && Number.isFinite(seq)) topologyLsdb.seenSeq.set(id, seq)
  })
  pruneTopologyLsdb()
}

function exportTopologyLsdb() {
  pruneTopologyLsdb()
  return {
    nodes: Array.from(topologyLsdb.nodes.values()).map(node => ({
      ...node,
      pairingKey: protectSecret(node.pairingKey || '')
    })),
    links: Array.from(topologyLsdb.links.values()),
    seenSeq: Array.from(topologyLsdb.seenSeq.entries()).map(([id, seq]) => ({ id, seq }))
  }
}

function getPairingConfigPath() {
  return path.join(app.getPath('userData'), PAIRING_CONFIG_FILE)
}

function normalizeMessageSettings(settings = {}) {
  return {
    receiveSmsCodes: settings.receiveSmsCodes !== false,
    receiveAllSms: settings.receiveAllSms !== false,
    receiveNotifications: settings.receiveNotifications !== false
  }
}

function normalizePushContentPolicy(policy = {}) {
  return {
    allowSmsCodes: policy.allowSmsCodes !== false,
    allowSmsMessages: policy.allowSmsMessages !== false,
    allowNotifications: policy.allowNotifications !== false,
    allowTotp: policy.allowTotp !== false
  }
}

function canPushContentToNode(target, type) {
  if (!target) return false
  const policy = normalizePushContentPolicy(target.contentPolicy || target)
  if (type === CODE_TYPES.SMS) return policy.allowSmsCodes
  if (type === CODE_TYPES.SMS_MESSAGE) return policy.allowSmsMessages
  if (type === CODE_TYPES.APP_NOTIFICATION) return policy.allowNotifications
  if (type === 'totp' || type === 'totp_sync' || type === 'totp_seed' || type === 'totp_revoke') {
    return policy.allowTotp
  }
  return true
}

function canReceiveContentType(type) {
  const contentType = type || CODE_TYPES.SMS
  if (contentType === CODE_TYPES.SMS) return desktopMessageSettings.receiveSmsCodes !== false
  if (contentType === CODE_TYPES.SMS_MESSAGE) return desktopMessageSettings.receiveAllSms !== false
  if (contentType === CODE_TYPES.APP_NOTIFICATION) return desktopMessageSettings.receiveNotifications !== false
  return true
}

function loadOrCreatePairingKey() {
  const configPath = getPairingConfigPath()
  try {
    if (fs.existsSync(configPath)) {
      const saved = JSON.parse(fs.readFileSync(configPath, 'utf8'))
      authorizedPhones = new Map((saved.authorizedPhones || []).map(phone => [
        phone.id,
        {
          id: phone.id,
          name: phone.name || 'Android Phone',
          deviceType: phone.deviceType || 'ANDROID_PHONE',
          enabled: phone.enabled !== false,
          revoked: phone.revoked === true,
          firstSeen: phone.firstSeen || Date.now(),
          lastSeen: phone.lastSeen || Date.now(),
          lastIP: normalizeNetworkHost(phone.lastIP),
          relayPort: Number(phone.relayPort) || 19529,
          pairingKey: unprotectSecret(phone.pairingKey || phone.pk || ''),
          tsHost: String(phone.tsHost || '').trim(),
          contentPolicy: normalizePushContentPolicy(phone.contentPolicy || phone),
          connected: false
        }
      ]).filter(([id]) => !!id))
      pairedDesktopPeers = new Map((saved.desktopPeers || []).map(peer => [
        peer.id,
        {
          id: peer.id,
          name: peer.name || 'Desktop PC',
          deviceType: peer.deviceType || peer.type || 'WINDOWS_DESKTOP',
          host: peer.host || '',
          port: Number(peer.port) || WS_PORT,
          pairingKey: unprotectSecret(peer.pairingKey || peer.pk || ''),
          tsHost: String(peer.tsHost || '').trim(),
          enabled: peer.enabled !== false,
          firstSeen: peer.firstSeen || Date.now(),
          lastSeen: peer.lastSeen || 0,
          lastIP: peer.lastIP || peer.host || '',
          contentPolicy: normalizePushContentPolicy(peer.contentPolicy || peer),
          connected: false
        }
      ]).filter(([id, peer]) => !!id && !!peer.host && !!peer.pairingKey))
      totpSeeds = new Map((saved.totpSeeds || []).map(seed => {
        const normalized = normalizeTotpSeed({
          ...seed,
          secret: unprotectSecret(seed.secret)
        })
        return normalized ? [normalized.id, normalized] : null
      }).filter(Boolean))
      totpDeleteTombstones = (saved.totpDeleteTombstones || []).map(item => normalizeTotpDeleteTombstone({
        ...item,
        secret: unprotectSecret(item.secret)
      })).filter(Boolean)
      desktopMessageSettings = normalizeMessageSettings(saved.messageSettings || {})
      importSavedTopologyLsdb(saved.topologyLsdb || {})
      pruneTotpDeleteTombstones()
      if (saved.pairingKey) {
        // 新格式是 safe:/plain: 前缀密文，旧版明文（base64 不含冒号）原样返回；
        // DPAPI 解密失败（如换了系统用户）返回空串 → 走下方重新生成
        const restoredKey = unprotectSecret(saved.pairingKey)
        if (restoredKey) {
          pairingKey = restoredKey
          return
        }
      }
    }
  } catch (e) {
    console.error('Failed to load pairing config:', e)
    // 配置损坏时先备份原文件再重置，给用户留下恢复配对数据的机会
    try {
      fs.copyFileSync(configPath, `${configPath}.corrupt-${Date.now()}`)
      showNotification(
        '配对数据加载失败',
        '配置文件已损坏，已备份为 pairing.json.corrupt-*。所有设备需要重新扫码配对。'
      )
    } catch (_) {}
  }

  pairingKey = crypto.randomBytes(32).toString('base64')
  savePairingKey()
}

let pairingSaveTimer = null

// 调用极频繁（每次设备上线、每条消息落库都会触发），防抖合并 500ms 内的写盘
function savePairingKey() {
  if (pairingSaveTimer) return
  pairingSaveTimer = setTimeout(() => {
    pairingSaveTimer = null
    flushPairingConfigToDisk()
  }, 500)
}

function flushPendingPairingSave() {
  if (!pairingSaveTimer) return
  clearTimeout(pairingSaveTimer)
  pairingSaveTimer = null
  flushPairingConfigToDisk()
}

function flushPairingConfigToDisk() {
  const configPath = getPairingConfigPath()
  const tmpPath = `${configPath}.tmp`
  try {
    fs.mkdirSync(path.dirname(configPath), { recursive: true })
    // 先写临时文件再原子替换：直接覆盖时写一半崩溃会损坏 JSON，
    // 下次启动静默重置 pairingKey，所有已配对设备和 TOTP 种子全部丢失
    fs.writeFileSync(
      tmpPath,
      JSON.stringify({
        // 配对密钥是信任体系的根，与 TOTP 种子同样用 safeStorage（DPAPI）加密落盘；
        // 旧版明文文件由 unprotectSecret 兼容读取，首次重新落盘即转为密文
        pairingKey: protectSecret(pairingKey),
        authorizedPhones: getAuthorizedPhones().map(phone => ({
          id: phone.id,
          name: phone.name,
          deviceType: phone.deviceType,
          enabled: phone.enabled,
          revoked: phone.revoked,
          firstSeen: phone.firstSeen,
          lastSeen: phone.lastSeen,
          lastIP: phone.lastIP,
          relayPort: phone.relayPort,
          tsHost: phone.tsHost || '',
          contentPolicy: normalizePushContentPolicy(phone.contentPolicy || phone),
          pairingKey: protectSecret(phone.pairingKey)
        })),
        desktopPeers: getPairedDesktopPeers().map(peer => ({
          id: peer.id,
          name: peer.name,
          deviceType: peer.deviceType,
          host: peer.host,
          port: peer.port,
          pairingKey: protectSecret(peer.pairingKey),
          tsHost: peer.tsHost || '',
          enabled: peer.enabled,
          firstSeen: peer.firstSeen,
          lastSeen: peer.lastSeen,
          lastIP: peer.lastIP,
          contentPolicy: normalizePushContentPolicy(peer.contentPolicy || peer)
        })),
        totpSeeds: getStoredTotpSeeds(),
        totpDeleteTombstones: getStoredTotpDeleteTombstones(),
        topologyLsdb: exportTopologyLsdb(),
        messageSettings: normalizeMessageSettings(desktopMessageSettings),
        updatedAt: Date.now()
      }, null, 2),
      'utf8'
    )
    fs.renameSync(tmpPath, configPath)
  } catch (e) {
    console.error('Failed to save pairing config:', e)
  }
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

function notifyPhonesChanged() {
  if (mainWindow) {
    mainWindow.webContents.send('phones-changed', getAuthorizedPhones())
  }
  scheduleTopologyBroadcast()
}

function notifyDesktopPeersChanged() {
  if (mainWindow) {
    mainWindow.webContents.send('desktop-peers-changed', getPairedDesktopPeers())
  }
  scheduleTopologyBroadcast()
}

function upsertAuthorizedPhone({
  phoneId,
  phoneName,
  clientIP,
  deviceType,
  pairingKey: phonePairingKey,
  relayPort,
  relayHost,
  tsHost
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
    contentPolicy: normalizePushContentPolicy(existing?.contentPolicy || existing || {}),
    connected: existing?.connected === true
  }
  authorizedPhones.set(phoneId, phone)
  savePairingKey()
  notifyPhonesChanged()
  return phone
}

function normalizeDesktopPeer(pairingData) {
  const id = String(pairingData?.id || pairingData?.deviceId || '').trim()
  const host = String(pairingData?.host || '').trim()
  const port = Number(pairingData?.port || WS_PORT)
  const pairingKeyValue = String(pairingData?.pairingKey || pairingData?.pk || '').trim()
  if (!id || !host || !pairingKeyValue || !Number.isFinite(port)) return null

  return {
    id,
    name: String(pairingData.name || pairingData.deviceName || 'Desktop PC').trim(),
    deviceType: normalizeDeviceType(pairingData.deviceType || pairingData.type, 'WINDOWS_DESKTOP'),
    host,
    port,
    pairingKey: pairingKeyValue,
    tsHost: String(pairingData?.tsHost || '').trim()
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
    contentPolicy: normalizePushContentPolicy(existing?.contentPolicy || existing || {}),
    connected: existing?.connected === true
  }
  pairedDesktopPeers.set(peer.id, peer)
  savePairingKey()
  notifyDesktopPeersChanged()
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
  const pairingKeyValue = String(payload.pairingKey || payload.pk || '').trim()
  if (!host || !Number.isFinite(port)) return null

  return {
    id,
    name: String(payload.deviceName || payload.name || id).trim(),
    deviceType,
    host,
    port,
    pairingKey: pairingKeyValue,
    protocol: DISCOVERY_PROTOCOL,
    discoveredAt: Date.now(),
    canPair: !!pairingKeyValue
  }
}

function rememberDiscoveredLanDevice(device) {
  if (!device || !device.id) return
  discoveredLanDevices.set(device.id, device)
  if (mainWindow) {
    mainWindow.webContents.send('lan-devices-changed', getDiscoveredLanDevices())
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
        response.host = getLocalIP()
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

function scanLanDevices(timeoutMs = 2500) {
  startLanDiscoveryService()
  discoveredLanDevices.clear()
  broadcastDiscoveryProbe()
  return new Promise(resolve => {
    setTimeout(() => resolve(getDiscoveredLanDevices()), timeoutMs)
  })
}

function setPhoneConnected(phoneId, connected) {
  const phone = authorizedPhones.get(phoneId)
  if (!phone) return
  phone.connected = connected
  if (connected) {
    phone.lastSeen = Date.now()
  }
  notifyPhonesChanged()
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
  upsertTopologyLsdbNode({
    id: identity.id,
    name: identity.name,
    type: identity.type,
    role: 'local_desktop',
    host: getLocalIP(),
    port: WS_PORT,
    pairingKey,
    tsHost: getTailscaleIPv4(),
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
    const phoneSeq = normalizeLsdbSeq(phone.lastSeen || phone.firstSeen, now)
    upsertTopologyLsdbNode({
      id: phone.id,
      name: phone.name || 'Android Phone',
      type: phone.deviceType || 'ANDROID_PHONE',
      role: 'phone',
      host: phone.lastIP,
      port: Number(phone.relayPort) || 19529,
      pairingKey: phone.pairingKey,
      tsHost: phone.tsHost || '',
      enabled: phone.enabled !== false,
      revoked: phone.revoked === true,
      contentPolicy: normalizePushContentPolicy(phone.contentPolicy || phone),
      connected: phone.connected === true,
      status: getPhoneTopologyStatus(phone),
      routable: phone.enabled !== false && phone.revoked !== true && !!phone.pairingKey && !!phone.lastIP,
      authority: 'source_device',
      sourceId: identity.id,
      seq: phoneSeq,
      updatedAt: phone.lastSeen || now,
      lastSeen: phone.lastSeen || now
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
      updatedAt: phone.lastSeen || now,
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
      updatedAt: phone.lastSeen || now,
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
        enabled: true,
        active: from.connected === true || to.connected === true,
        routable: true,
        authority: 'source_device',
        seq: normalizeLsdbSeq(updatedAt, now),
        updatedAt,
        description: `经 ${identity.name} 交换路由信息后，两个手机节点可直接同步短信和 TOTP`
      })
    }
  }

  getPairedDesktopPeers().forEach(peer => {
    if (!peer.id) return
    const peerSeq = normalizeLsdbSeq(peer.lastSeen || peer.firstSeen, now)
    const peerEnabled = peer.enabled !== false && !!peer.pairingKey && !!peer.host
    upsertTopologyLsdbNode({
      id: peer.id,
      name: peer.name || 'Desktop PC',
      type: peer.deviceType || 'WINDOWS_DESKTOP',
      role: 'desktop',
      host: peer.host,
      port: Number(peer.port) || WS_PORT,
      pairingKey: peer.pairingKey,
      tsHost: peer.tsHost || '',
      enabled: peer.enabled !== false,
      contentPolicy: normalizePushContentPolicy(peer.contentPolicy || peer),
      connected: peer.connected === true,
      status: peer.connected ? 'online' : (peer.enabled === false ? 'disabled' : 'offline'),
      routable: peerEnabled,
      authority: 'desktop_owner',
      sourceId: identity.id,
      seq: peerSeq,
      updatedAt: peer.lastSeen || now,
      lastSeen: peer.lastSeen || now
    })
    for (const [from, to, direction] of [
      [identity.id, peer.id, 'outbound'],
      [peer.id, identity.id, 'inbound']
    ]) {
      upsertTopologyLsdbLink({
        id: `${from}->${to}:desktop-pair`,
        from,
        to,
        type: 'desktop_pair',
        label: direction === 'outbound' ? '桌面端种子同步' : '桌面端反向同步',
        direction,
        enabled: peerEnabled,
        active: peer.connected === true,
        routable: peerEnabled,
        authority: 'desktop_owner',
        seq: peerSeq,
        updatedAt: peer.lastSeen || now,
        description: '桌面节点之间互相同步拓扑控制面和本机 TOTP 种子'
      })
    }
  })

  pruneTopologyLsdb()
  if (reason !== 'snapshot') savePairingKey()
}

function getKnownRoutableTopologyNodes() {
  syncLocalTopologyIntoLsdb('snapshot')
  const identity = getDesktopIdentity()
  return Array.from(topologyLsdb.nodes.values())
    .filter(node =>
      node.id &&
      node.id !== identity.id &&
      node.enabled !== false &&
      node.revoked !== true &&
      node.routable === true &&
      node.pairingKey &&
      (node.host || node.lastIP)
    )
}

function buildTopologyDelta(reason = 'full', options = {}) {
  syncLocalTopologyIntoLsdb('snapshot')
  const identity = getDesktopIdentity()
  const seq = options.seq || nextLsdbSequence()
  const ttl = Number.isFinite(options.ttl) ? options.ttl : TOPOLOGY_DELTA_TTL
  const now = Date.now()
  return {
    type: 'topology_delta',
    version: ROUTING_PROTOCOL_VERSION,
    routingProtocol: 'link-state-spf',
    controlPlane: true,
    messageTypes: ['node_advertisement', 'link_advertisement'],
    reason,
    sourceDeviceId: options.sourceDeviceId || identity.id,
    sourceDeviceName: options.sourceDeviceName || identity.name,
    sourceDeviceType: options.sourceDeviceType || identity.type,
    originDeviceId: options.originDeviceId || identity.id,
    seq,
    ttl,
    updatedAt: now,
    nodes: Array.from(topologyLsdb.nodes.values()).map(node => ({ ...node, type: node.type })),
    links: Array.from(topologyLsdb.links.values())
  }
}

function applyTopologyDeltaPayload(rawPayload, options = {}) {
  const delta = typeof rawPayload === 'string' ? JSON.parse(rawPayload) : rawPayload
  if (!delta || !delta.type) return false
  const identity = getDesktopIdentity()
  let normalizedDelta = delta
  if (delta.type === 'node_advertisement') {
    normalizedDelta = { type: 'topology_delta', nodes: [delta], links: [], seq: delta.seq, sourceDeviceId: delta.sourceDeviceId || delta.id }
  } else if (delta.type === 'link_advertisement') {
    normalizedDelta = { type: 'topology_delta', nodes: [], links: [delta], seq: delta.seq, sourceDeviceId: delta.sourceDeviceId || delta.from }
  }
  if (normalizedDelta.type !== 'topology_delta') return false

  const sourceId = String(normalizedDelta.sourceDeviceId || normalizedDelta.originDeviceId || '').trim()
  const seq = Number(normalizedDelta.seq || 0)
  if (sourceId && sourceId !== identity.id && seq > 0) {
    const lastSeq = topologyLsdb.seenSeq.get(sourceId) || 0
    if (seq <= lastSeq) return false
    topologyLsdb.seenSeq.set(sourceId, seq)
  }

  let changed = false
  const nodes = Array.isArray(normalizedDelta.nodes) ? normalizedDelta.nodes : []
  const links = Array.isArray(normalizedDelta.links) ? normalizedDelta.links : []
  for (const rawNode of nodes) {
    const node = normalizeLsdbNode(rawNode)
    if (!node || node.id === identity.id) continue
    changed = upsertTopologyLsdbNode(node) || changed
    if (node.routable && node.pairingKey && node.host) {
      if (String(node.type || '').includes('PHONE')) {
        upsertAuthorizedPhone({
          phoneId: node.id,
          phoneName: node.name,
          clientIP: node.host,
          deviceType: node.type,
          pairingKey: node.pairingKey,
          relayPort: node.port || 19529,
          relayHost: node.host,
          tsHost: node.tsHost
        })
      } else if (String(node.type || '').includes('DESKTOP')) {
        upsertPairedDesktopPeer({
          id: node.id,
          name: node.name,
          deviceType: node.type,
          host: node.host,
          port: node.port || WS_PORT,
          pairingKey: node.pairingKey,
          tsHost: node.tsHost
        })
      }
    }
  }
  for (const rawLink of links) {
    changed = upsertTopologyLsdbLink(rawLink) || changed
  }

  if (changed) {
    savePairingKey()
    if (mainWindow) {
      mainWindow.webContents.send('topology-changed')
    }
    if (options.flood !== false && (normalizedDelta.ttl || 0) > 0) {
      const nextTtl = Math.max(0, Number(normalizedDelta.ttl || 0) - 1)
      broadcastTopologyToAllPeers('gossip', {
        baseDelta: buildTopologyDelta('gossip', { ttl: nextTtl }),
        excludeNodeId: options.excludeNodeId || sourceId
      })
    }
  }
  return changed
}

// 复用调用方传入的拓扑快照（一次广播 N 台手机只算一次），
// 不传时（如单台手机鉴权成功后的首次下发）才自行计算
function buildPhoneRoutingTable(forPhoneId = '', topology = null) {
  const identity = getDesktopIdentity()
  const snapshot = topology || getTopologySnapshot()
  const routes = snapshot.routeTables?.[forPhoneId] || []
  const knownNodes = getKnownRoutableTopologyNodes()
  const nodesById = new Map(knownNodes.map(node => [node.id, node]))
  const routeByDestination = new Map(routes.map(route => [route.destinationId || route.to, route]))

  const nodes = Array.from(nodesById.values())
    .filter(node => {
      const route = routeByDestination.get(node.id)
      return node.id &&
        node.id !== forPhoneId &&
        node.enabled !== false &&
        node.revoked !== true &&
        node.pairingKey &&
        (node.host || node.lastIP) &&
        route
    })
    .map(node => {
      const route = routeByDestination.get(node.id)
      return {
      id: node.id,
      name: node.name,
      type: node.type || node.deviceType || 'UNKNOWN_DEVICE',
      host: normalizeNetworkHost(node.host || node.lastIP),
      port: Number(node.port || node.relayPort) || (String(node.type || '').includes('PHONE') ? 19529 : WS_PORT),
      pairingKey: node.pairingKey,
      tsHost: node.tsHost || '',
      altHosts: node.altHosts || [],
      enabled: true,
      lastSeen: node.lastSeen || node.updatedAt || 0,
      routeVia: identity.id,
      routeViaName: identity.name,
      relation: 'topology_peer',
      route: {
        protocol: 'link-state-spf',
        metric: route.metric,
        hopCount: route.hopCount,
        nextHopId: route.nextHopId,
        nextHopName: route.nextHopName,
        path: route.path || [],
        pathLabels: route.pathLabels || [],
        updatedAt: route.updatedAt || snapshot.updatedAt || Date.now()
      }
    }
    })

  return {
    type: 'topology_sync',
    version: ROUTING_PROTOCOL_VERSION,
    routingProtocol: 'link-state-spf',
    sourceDeviceId: identity.id,
    sourceDeviceName: identity.name,
    sourceDeviceType: identity.type,
    nodes,
    routes: routes
      .filter(route => nodesById.has(route.destinationId || route.to))
      .map(route => ({
        from: route.from,
        to: route.destinationId || route.to,
        destinationId: route.destinationId || route.to,
        nextHopId: route.nextHopId,
        nextHopName: route.nextHopName,
        metric: route.metric,
        hopCount: route.hopCount,
        path: route.path || [],
        pathLabels: route.pathLabels || [],
        via: route.via || route.nextHopId,
        type: 'spf_route',
        label: route.label || 'SPF 路由'
      })),
    lsdbVersion: snapshot.routing?.version || ROUTING_PROTOCOL_VERSION,
    lsdbSeq: nextLsdbSequence(),
    updatedAt: Date.now()
  }
}

function sendTopologyToPhone(phoneId, ws, sessionKey, topology = null) {
  if (!phoneId || !ws || ws.readyState !== WebSocket.OPEN || !sessionKey) return
  const payload = JSON.stringify(buildPhoneRoutingTable(phoneId, topology))
  const encrypted = encryptMessage(payload, sessionKey)
  if (!encrypted) return
  try {
    ws.send(JSON.stringify({ type: 'topology_sync', payload: encrypted }))
  } catch (e) {
    console.error('发送节点路由表失败:', e)
  }
}

let topologyBroadcastTimer = null

// SPF 节流（FRR `timers throttle spf` 的简化版）：设备上线/下线风暴期间
// 拓扑连环变化，合并 250ms 内的触发为一次「全量计算 + 广播」。
// 配合下面广播内快照复用，把一次风暴的开销从 变化数×手机数 次 SPF 降到 1 次。
function scheduleTopologyBroadcast() {
  if (topologyBroadcastTimer) return
  topologyBroadcastTimer = setTimeout(() => {
    topologyBroadcastTimer = null
    broadcastTopologyToAllPeers('scheduled')
  }, 250)
}

function broadcastTopologyToPhones() {
  if (activePhoneConnections.size === 0) return
  // 整次广播只计算一份拓扑快照；旧实现每台手机都重建全图并跑一遍全节点 Dijkstra
  const topology = getTopologySnapshot()
  for (const [phoneId, connections] of activePhoneConnections.entries()) {
    for (const ws of connections) {
      const sessionKey = phoneSessionKeys.get(ws)
      sendTopologyToPhone(phoneId, ws, sessionKey, topology)
    }
  }
}

function sendEncryptedControlMessage(ws, sessionKey, messageType, payload) {
  if (!ws || ws.readyState !== WebSocket.OPEN || !sessionKey) return false
  const encrypted = encryptMessage(JSON.stringify(payload), sessionKey)
  if (!encrypted) return false
  try {
    ws.send(JSON.stringify({ type: messageType, payload: encrypted }))
    return true
  } catch (e) {
    console.error(`发送控制面消息失败 ${messageType}:`, e)
    return false
  }
}

function postJsonToNode(host, port, body, timeoutMs = 3500) {
  return new Promise(resolve => {
    const data = Buffer.from(JSON.stringify(body), 'utf8')
    const req = http.request({
      hostname: normalizeNetworkHost(host),
      port,
      path: '/relay',
      method: 'POST',
      timeout: timeoutMs,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': data.length
      }
    }, res => {
      res.resume()
      res.on('end', () => resolve(res.statusCode >= 200 && res.statusCode < 300))
    })
    req.on('timeout', () => {
      req.destroy()
      resolve(false)
    })
    req.on('error', () => resolve(false))
    req.write(data)
    req.end()
  })
}

async function sendTopologyDeltaRelayToPhone(phone, delta) {
  if (!phone || !phone.pairingKey || !(phone.lastIP || phone.host)) return false
  const identity = getDesktopIdentity()
  const stampedPayload = {
    ...delta,
    relaySentAt: Date.now(),
    relayMessageId: `topology-${identity.id}-${delta.seq || Date.now()}`,
    relayPath: Array.isArray(delta.relayPath) ? delta.relayPath : [identity.id],
    relayTtl: Number.isFinite(delta.ttl) ? delta.ttl : TOPOLOGY_DELTA_TTL,
    originDeviceId: delta.originDeviceId || identity.id
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
  const hosts = [phone.lastIP || phone.host, phone.tsHost]
    .map(normalizeNetworkHost)
    .filter(Boolean)
    .filter((host, index, arr) => arr.indexOf(host) === index)
  for (const host of hosts) {
    const ok = await postJsonToNode(host, Number(phone.relayPort || phone.port) || 19529, envelope)
    if (ok) return true
  }
  return false
}

function broadcastTopologyToAllPeers(reason = 'broadcast', options = {}) {
  const baseDelta = options.baseDelta || buildTopologyDelta(reason)
  const excludeNodeId = String(options.excludeNodeId || '').trim()
  const identity = getDesktopIdentity()
  const delta = {
    ...baseDelta,
    sourceDeviceId: identity.id,
    sourceDeviceName: identity.name,
    sourceDeviceType: identity.type,
    ttl: Number.isFinite(baseDelta.ttl) ? baseDelta.ttl : TOPOLOGY_DELTA_TTL
  }

  const topology = getTopologySnapshot()
  for (const [phoneId, connections] of activePhoneConnections.entries()) {
    if (phoneId === excludeNodeId) continue
    for (const ws of connections) {
      const sessionKey = phoneSessionKeys.get(ws)
      sendTopologyToPhone(phoneId, ws, sessionKey, topology)
      sendEncryptedControlMessage(ws, sessionKey, 'topology_delta', delta)
    }
  }

  for (const [peerId, ws] of activeDesktopPeerConnections.entries()) {
    if (peerId === excludeNodeId) continue
    sendEncryptedControlMessage(ws, ws.__codebridgeSessionKey, 'topology_delta', delta)
  }

  for (const phone of getAuthorizedPhones()) {
    if (phone.id === excludeNodeId || phone.enabled === false || phone.revoked === true) continue
    if (!phone.pairingKey || !phone.lastIP) continue
    const isActive = activePhoneConnections.has(phone.id)
    if (!isActive) {
      sendTopologyDeltaRelayToPhone(phone, delta).catch(error => {
        console.error(`拓扑 relay 失败 ${phone.name}:`, error.message)
      })
    }
  }
}

function removeActivePhoneConnection(phoneId, ws) {
  const connections = activePhoneConnections.get(phoneId)
  if (!connections) return
  connections.delete(ws)
  if (connections.size === 0) {
    activePhoneConnections.delete(phoneId)
    setPhoneConnected(phoneId, false)
  }
}

function closePhoneConnections(phoneId, reason = 'Phone disabled') {
  const connections = activePhoneConnections.get(phoneId)
  if (!connections) return
  for (const ws of connections) {
    ws.close(1000, reason)
  }
  activePhoneConnections.delete(phoneId)
  setPhoneConnected(phoneId, false)
}

function setPhoneEnabled(phoneId, enabled) {
  const phone = authorizedPhones.get(phoneId)
  if (!phone) return getAuthorizedPhones()
  if (phone.revoked) return getAuthorizedPhones()
  phone.enabled = !!enabled
  if (!enabled) {
    closePhoneConnections(phoneId, 'Phone disabled')
  }
  savePairingKey()
  notifyPhonesChanged()
  return getAuthorizedPhones()
}

function setPhoneContentPolicy(phoneId, updates = {}) {
  const phone = authorizedPhones.get(phoneId)
  if (!phone) return getAuthorizedPhones()
  if (phone.revoked) return getAuthorizedPhones()
  phone.contentPolicy = normalizePushContentPolicy({
    ...(phone.contentPolicy || {}),
    ...updates
  })
  authorizedPhones.set(phoneId, phone)
  savePairingKey()
  notifyPhonesChanged()
  scheduleTopologyBroadcast()
  return getAuthorizedPhones()
}

function revokePhone(phoneId) {
  const phone = authorizedPhones.get(phoneId)
  if (!phone) return getAuthorizedPhones()
  phone.enabled = false
  phone.revoked = true
  closePhoneConnections(phoneId, 'Phone revoked')
  savePairingKey()
  notifyPhonesChanged()
  return getAuthorizedPhones()
}

// 恢复一台已撤销的手机：清掉 revoked 标记并重新启用。
// 撤销是单向拒绝（重连仍被 deny），只有用户在当前节点主动恢复才能再次授权，
// 这样既保留了撤销的安全语义，又给了「误撤销 / 想重新授权」一个明确入口。
function restorePhone(phoneId) {
  const phone = authorizedPhones.get(phoneId)
  if (!phone || !phone.revoked) return getAuthorizedPhones()
  phone.revoked = false
  phone.enabled = true
  savePairingKey()
  notifyPhonesChanged()
  return getAuthorizedPhones()
}

function getStoredTotpSeeds() {
  return Array.from(totpSeeds.values()).map(seed => ({
    id: seed.id,
    label: seed.label,
    issuer: seed.issuer,
    accountName: seed.accountName,
    algorithm: seed.algorithm,
    digits: seed.digits,
    period: seed.period,
    phoneId: seed.phoneId,
    phoneName: seed.phoneName,
    sourceDeviceId: seed.sourceDeviceId,
    sourceDeviceName: seed.sourceDeviceName,
    sourceDeviceType: seed.sourceDeviceType,
    targetDevices: seed.targetDevices,
    pushAuthority: seed.pushAuthority,
    pushAuthorityDeviceId: seed.pushAuthorityDeviceId,
    importAction: seed.importAction,
    createdAt: seed.createdAt,
    updatedAt: seed.updatedAt,
    pinnedAt: seed.pinnedAt || 0,
    secret: protectSecret(seed.secret)
  }))
}

function getStoredTotpDeleteTombstones() {
  pruneTotpDeleteTombstones()
  return totpDeleteTombstones.map(item => ({
    id: item.id,
    label: item.label,
    issuer: item.issuer,
    accountName: item.accountName,
    algorithm: item.algorithm,
    digits: item.digits,
    period: item.period,
    phoneId: item.phoneId,
    phoneName: item.phoneName,
    sourceDeviceId: item.sourceDeviceId,
    sourceDeviceName: item.sourceDeviceName,
    sourceDeviceType: item.sourceDeviceType,
    pushAuthority: item.pushAuthority,
    pushAuthorityDeviceId: item.pushAuthorityDeviceId,
    deletedAt: item.deletedAt,
    updatedAt: item.updatedAt,
    secret: protectSecret(item.secret)
  }))
}

function normalizeTotpDeleteTombstone(data) {
  const secret = normalizeTotpSecret(data?.secret)
  const sourceDeviceId = String(data?.sourceDeviceId || '').trim()
  if (!secret || !sourceDeviceId) return null
  const identity = getDesktopIdentity()
  const now = Date.now()
  return {
    id: data.id || `deleted-${crypto
      .createHash('sha256')
      .update([secret, sourceDeviceId, data.issuer || '', data.accountName || '', data.label || ''].join('|'))
      .digest('hex')
      .slice(0, 20)}`,
    label: String(data.label || 'TOTP').trim(),
    issuer: String(data.issuer || '').trim(),
    accountName: String(data.accountName || '').trim(),
    algorithm: normalizeTotpAlgorithm(data.algorithm),
    digits: clampInteger(data.digits, 6, 8, 6),
    period: clampInteger(data.period, 15, 120, 30),
    phoneId: LOCAL_TOTP_SOURCE_ID,
    phoneName: data.phoneName || `${identity.name} (本机)`,
    sourceDeviceId,
    sourceDeviceName: data.sourceDeviceName || identity.name,
    sourceDeviceType: data.sourceDeviceType || identity.type,
    pushAuthority: data.pushAuthority || 'local_desktop',
    pushAuthorityDeviceId: data.pushAuthorityDeviceId || sourceDeviceId,
    deletedAt: Number(data.deletedAt) || now,
    updatedAt: Number(data.updatedAt) || Number(data.deletedAt) || now,
    secret
  }
}

function pruneTotpDeleteTombstones() {
  const cutoff = Date.now() - TOTP_DELETE_TOMBSTONE_TTL_MS
  totpDeleteTombstones = totpDeleteTombstones
    .filter(item => item && item.deletedAt >= cutoff)
    .sort((a, b) => (b.deletedAt || 0) - (a.deletedAt || 0))
    .slice(0, TOTP_DELETE_TOMBSTONE_LIMIT)
}

function clearTotpDeleteTombstone(seed) {
  if (!seed) return
  const secret = normalizeTotpSecret(seed.secret)
  const sourceDeviceId = String(seed.sourceDeviceId || '').trim()
  if (!secret || !sourceDeviceId) return
  totpDeleteTombstones = totpDeleteTombstones.filter(item =>
    !(normalizeTotpSecret(item.secret) === secret && item.sourceDeviceId === sourceDeviceId)
  )
}

function recordTotpDeleteTombstone(seed) {
  const tombstone = normalizeTotpDeleteTombstone({
    ...seed,
    deletedAt: Date.now(),
    updatedAt: Date.now()
  })
  if (!tombstone) return
  clearTotpDeleteTombstone(tombstone)
  totpDeleteTombstones.unshift(tombstone)
  pruneTotpDeleteTombstones()
}

function protectSecret(secret) {
  const value = String(secret || '')
  if (!value) return ''

  try {
    if (safeStorage?.isEncryptionAvailable()) {
      return `safe:${safeStorage.encryptString(value).toString('base64')}`
    }
  } catch (e) {
    console.error('Failed to encrypt TOTP secret:', e)
  }

  return `plain:${Buffer.from(value, 'utf8').toString('base64')}`
}

function unprotectSecret(value) {
  const stored = String(value || '')
  if (!stored) return ''

  try {
    if (stored.startsWith('safe:')) {
      return safeStorage.decryptString(Buffer.from(stored.slice(5), 'base64'))
    }
    if (stored.startsWith('plain:')) {
      return Buffer.from(stored.slice(6), 'base64').toString('utf8')
    }
  } catch (e) {
    console.error('Failed to decrypt TOTP secret:', e)
    return ''
  }

  return stored
}

function normalizeTotpSeed(seedData) {
  const secret = normalizeTotpSecret(seedData.secret)
  if (!secret) return null

  const desktopIdentity = getDesktopIdentity()
  const sourceTypeText = String(seedData.sourceDeviceType || '').toUpperCase()
  const isLocalDesktopSeed = seedData.phoneId === LOCAL_TOTP_SOURCE_ID ||
    seedData.sourceDeviceId === LOCAL_TOTP_SOURCE_ID ||
    (
      seedData.isLocal !== false &&
      sourceTypeText.includes('DESKTOP') &&
      (!seedData.sourceDeviceId || seedData.sourceDeviceId === desktopIdentity.id || seedData.phoneId === desktopIdentity.id)
    )
  const issuer = String(seedData.issuer || '').trim()
  const accountName = String(seedData.accountName || '').trim()
  const label = String(seedData.label || [issuer, accountName].filter(Boolean).join(': ') || 'TOTP').trim()
  const algorithm = normalizeTotpAlgorithm(seedData.algorithm)
  const digits = clampInteger(seedData.digits, 6, 8, 6)
  const period = clampInteger(seedData.period, 15, 120, 30)
  const id = seedData.id || `totp-${crypto
    .createHash('sha256')
    .update([secret, issuer, accountName, label, algorithm, digits, period].join('|'))
    .digest('hex')
    .slice(0, 20)}`
  const now = Date.now()
  const sourceDeviceId = isLocalDesktopSeed
    ? (seedData.sourceDeviceId && seedData.sourceDeviceId !== LOCAL_TOTP_SOURCE_ID ? seedData.sourceDeviceId : desktopIdentity.id)
    : (seedData.sourceDeviceId || seedData.phoneId || '')
  const sourceDeviceName = isLocalDesktopSeed
    ? (seedData.sourceDeviceName && seedData.sourceDeviceName !== '未知手机' ? seedData.sourceDeviceName : desktopIdentity.name)
    : (seedData.sourceDeviceName || seedData.phoneName || '未知手机')
  const sourceDeviceType = isLocalDesktopSeed
    ? (seedData.sourceDeviceType && seedData.sourceDeviceType !== 'ANDROID_PHONE' ? seedData.sourceDeviceType : desktopIdentity.type)
    : (seedData.sourceDeviceType || 'ANDROID_PHONE')

  return {
    id,
    label,
    issuer,
    accountName,
    secret,
    algorithm,
    digits,
    period,
    phoneId: isLocalDesktopSeed ? LOCAL_TOTP_SOURCE_ID : (seedData.phoneId || ''),
    phoneName: seedData.phoneName || (isLocalDesktopSeed ? `${desktopIdentity.name} (本机)` : '未知手机'),
    sourceDeviceId,
    sourceDeviceName,
    sourceDeviceType,
    targetDevices: Array.isArray(seedData.targetDevices) ? seedData.targetDevices : [],
    pushAuthority: seedData.pushAuthority || (isLocalDesktopSeed ? 'local_desktop' : 'source_device'),
    pushAuthorityDeviceId: seedData.pushAuthorityDeviceId || sourceDeviceId,
    createdAt: seedData.createdAt || now,
    updatedAt: seedData.updatedAt || now,
    pinnedAt: Number(seedData.pinnedAt || 0) || 0
  }
}

function normalizeTotpSecret(secret) {
  const normalized = String(secret || '').toUpperCase().replace(/[\s-]/g, '')
  return /^[A-Z2-7]{16,}$/.test(normalized) ? normalized : ''
}

function normalizeTotpAlgorithm(algorithm) {
  const normalized = String(algorithm || '').toUpperCase().replace(/[-_]/g, '')
  if (normalized === 'SHA256') return 'SHA256'
  if (normalized === 'SHA512') return 'SHA512'
  return 'SHA1'
}

function clampInteger(value, min, max, fallback) {
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, parsed))
}

function normalizeComparableText(value) {
  return String(value || '').trim().toLowerCase()
}

function isSameTotpConfig(a, b) {
  if (!a || !b) return false
  if (normalizeTotpSecret(a.secret) !== normalizeTotpSecret(b.secret)) return false
  if (normalizeTotpAlgorithm(a.algorithm) !== normalizeTotpAlgorithm(b.algorithm)) return false
  if (Number(a.digits || 6) !== Number(b.digits || 6)) return false
  if (Number(a.period || 30) !== Number(b.period || 30)) return false

  const issuerA = normalizeComparableText(a.issuer)
  const issuerB = normalizeComparableText(b.issuer)
  const accountA = normalizeComparableText(a.accountName)
  const accountB = normalizeComparableText(b.accountName)
  const labelA = normalizeComparableText(a.label)
  const labelB = normalizeComparableText(b.label)

  if (issuerA && issuerB && issuerA === issuerB && (!accountA || !accountB || accountA === accountB)) return true
  if (accountA && accountB && accountA === accountB && (!issuerA || !issuerB || issuerA === issuerB)) return true
  return !!labelA && labelA === labelB
}

function findExistingTotpSeed(normalized) {
  if (!normalized) return null
  const byId = totpSeeds.get(normalized.id)
  if (byId) return byId
  for (const seed of totpSeeds.values()) {
    if (isSameTotpConfig(seed, normalized)) return seed
  }
  return null
}

function upsertTotpSeed(seedData) {
  const normalized = normalizeTotpSeed(seedData)
  if (!normalized) return null

  const existing = findExistingTotpSeed(normalized)
  const seed = {
    ...existing,
    ...normalized,
    id: existing?.id || normalized.id,
    createdAt: existing?.createdAt || normalized.createdAt,
    pinnedAt: normalized.pinnedAt || existing?.pinnedAt || 0,
    updatedAt: Date.now(),
    importAction: existing ? 'updated' : 'added'
  }
  totpSeeds.set(seed.id, seed)
  savePairingKey()
  notifyTotpSeedsChanged()
  return seed
}

function importStorageTotpsIntoPrimaryStore() {
  let imported = 0
  try {
    const identity = getDesktopIdentity()
    const storedTotps = storage.getAllTotps()
    for (const item of storedTotps) {
      const sourceType = String(item.sourceDeviceType || '').toUpperCase()
      const isLocalItem = item.isLocal !== false && (
        !item.phoneId ||
        item.sourceDeviceId === identity.id ||
        sourceType.includes('DESKTOP')
      )
      const normalized = normalizeTotpSeed({
        ...item,
        phoneId: isLocalItem ? LOCAL_TOTP_SOURCE_ID : (item.phoneId || item.sourceDeviceId || ''),
        phoneName: item.phoneName || (isLocalItem ? `${identity.name} (本机)` : item.sourceDeviceName || '未知手机'),
        sourceDeviceId: isLocalItem ? identity.id : item.sourceDeviceId,
        sourceDeviceName: isLocalItem ? identity.name : item.sourceDeviceName,
        sourceDeviceType: isLocalItem ? identity.type : item.sourceDeviceType,
        pushAuthority: isLocalItem ? 'local_desktop' : item.pushAuthority,
        pushAuthorityDeviceId: isLocalItem ? identity.id : item.pushAuthorityDeviceId
      })
      if (!normalized || totpSeeds.has(normalized.id)) continue
      totpSeeds.set(normalized.id, normalized)
      imported += 1
    }
  } catch (e) {
    console.error('Failed to import legacy storage TOTP data:', e)
  }

  if (imported > 0) {
    savePairingKey()
  }
}

function toPublicTotpSeed(seed) {
  if (!seed) return null
  return {
    id: seed.id,
    label: seed.label,
    issuer: seed.issuer,
    accountName: seed.accountName,
    algorithm: seed.algorithm,
    digits: seed.digits,
    period: seed.period,
    phoneId: seed.phoneId,
    phoneName: seed.phoneName,
    sourceDeviceId: seed.sourceDeviceId,
    sourceDeviceName: seed.sourceDeviceName,
    sourceDeviceType: seed.sourceDeviceType,
    targetDevices: seed.targetDevices,
    pushAuthority: seed.pushAuthority,
    pushAuthorityDeviceId: seed.pushAuthorityDeviceId,
    createdAt: seed.createdAt,
    updatedAt: seed.updatedAt,
    pinnedAt: seed.pinnedAt || 0
  }
}

function getTotpSeedRecords() {
  return Array.from(totpSeeds.values())
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
    .map(toPublicTotpSeed)
}

function addLocalTotpSeed(totp) {
  const identity = getDesktopIdentity()
  const seed = upsertTotpSeed({
    ...totp,
    phoneId: totp.phoneId || LOCAL_TOTP_SOURCE_ID,
    phoneName: totp.phoneName || `${identity.name} (本机)`,
    sourceDeviceId: totp.sourceDeviceId || identity.id,
    sourceDeviceName: totp.sourceDeviceName || identity.name,
    sourceDeviceType: totp.sourceDeviceType || identity.type,
    pushAuthority: totp.pushAuthority || 'local_desktop',
    pushAuthorityDeviceId: totp.pushAuthorityDeviceId || identity.id
  })
  // 本机新增的种子，若此刻有手机在线则即时广播；离线手机会在下次连接时补齐
  if (seed && seed.phoneId === LOCAL_TOTP_SOURCE_ID) {
    clearTotpDeleteTombstone(seed)
    savePairingKey()
    broadcastTotpSyncToPhones(seed, 'add')
    broadcastTotpSyncToDesktopPeers(seed, 'add')
  }
  return toPublicTotpSeed(seed)
}

function updateTotpSeed(id, updates) {
  const existing = totpSeeds.get(String(id || ''))
  if (!existing) return null

  const seed = normalizeTotpSeed({
    ...existing,
    ...updates,
    id: existing.id,
    phoneId: existing.phoneId,
    phoneName: existing.phoneName,
    createdAt: existing.createdAt,
    pinnedAt: Object.prototype.hasOwnProperty.call(updates || {}, 'pinnedAt')
      ? Number(updates.pinnedAt || 0)
      : existing.pinnedAt
  })
  if (!seed) return null

  seed.updatedAt = Date.now()
  seed.importAction = 'updated'
  totpSeeds.set(seed.id, seed)
  try {
    storage.updateTotp(seed.id, updates)
  } catch (e) {
    console.error('Failed to update legacy TOTP storage:', e)
  }
  savePairingKey()
  notifyTotpSeedsChanged()
  if (seed.phoneId === LOCAL_TOTP_SOURCE_ID) {
    clearTotpDeleteTombstone(seed)
    savePairingKey()
    broadcastTotpSyncToPhones(seed, 'add')
    broadcastTotpSyncToDesktopPeers(seed, 'add')
  }
  return toPublicTotpSeed(seed)
}

function deleteTotpSeed(id) {
  const seed = totpSeeds.get(String(id || ''))
  const removed = totpSeeds.delete(String(id || ''))
  if (removed) {
    try {
      storage.deleteTotp(String(id || ''))
    } catch (e) {
      console.error('Failed to delete legacy TOTP storage:', e)
    }
    // 仅本机来源的删除才同步给手机；远程来源的本地删除不影响其他设备
    if (seed && seed.phoneId === LOCAL_TOTP_SOURCE_ID) {
      recordTotpDeleteTombstone(seed)
    }
    savePairingKey()
    notifyTotpSeedsChanged()
    if (seed && seed.phoneId === LOCAL_TOTP_SOURCE_ID) {
      broadcastTotpSyncToPhones(seed, 'delete')
      broadcastTotpSyncToDesktopPeers(seed, 'delete')
    }
  }
  return removed
}

function notifyTotpSeedsChanged() {
  if (mainWindow) {
    mainWindow.webContents.send('desktop-totps-changed')
  }
}

// ==================== TOTP 双向同步（桌面 → 手机） ====================
// 设计：TOTP 只需同步「种子配置」，每台设备本地算码，无需常驻连接。
// 桌面作为服务器无法主动连手机，因此在手机鉴权连上的那一刻顺带下发本机种子；
// 桌面本地新增/修改时，若此刻有手机在线则即时广播，否则等手机下次连接时补齐。

/** 把一条 TOTP 种子封装成可下发的同步负载（明文 JSON 字符串）。 */
function buildTotpSyncPayload(seed, action = 'add') {
  const identity = getDesktopIdentity()
  const isLocalDesktopSeed = seed.phoneId === LOCAL_TOTP_SOURCE_ID ||
    seed.sourceDeviceId === LOCAL_TOTP_SOURCE_ID
  return JSON.stringify({
    type: 'totp_sync',
    action, // 'add' | 'delete'
    id: seed.id,
    label: seed.label,
    secret: seed.secret,
    issuer: seed.issuer,
    accountName: seed.accountName,
    algorithm: seed.algorithm,
    digits: seed.digits,
    period: seed.period,
    sourceDeviceId: isLocalDesktopSeed ? identity.id : (seed.sourceDeviceId || identity.id),
    sourceDeviceName: isLocalDesktopSeed ? identity.name : (seed.sourceDeviceName || identity.name),
    sourceDeviceType: isLocalDesktopSeed ? identity.type : (seed.sourceDeviceType || identity.type),
    updatedAt: seed.updatedAt || Date.now()
  })
}

/** 鉴权成功时，把本机来源（desktop-local）的全部 TOTP 种子一次性下发给该手机。 */
function sendLocalTotpSeedsToPhone(ws, sessionKey, phoneId) {
  if (!ws || !sessionKey) return
  const phone = authorizedPhones.get(phoneId)
  if (!canPushContentToNode(phone, 'totp')) return
  const localSeeds = Array.from(totpSeeds.values())
    .filter(seed => seed.phoneId === LOCAL_TOTP_SOURCE_ID && seed.secret)
  for (const seed of localSeeds) {
    try {
      const payload = buildTotpSyncPayload(seed, 'add')
      const encrypted = encryptMessage(payload, sessionKey)
      ws.send(JSON.stringify({ type: 'totp_sync', payload: encrypted }))
    } catch (e) {
      console.error('下发 TOTP 种子失败:', e)
    }
  }
  if (localSeeds.length > 0) {
    console.log(`已向手机 ${phoneId} 下发 ${localSeeds.length} 个本机 TOTP 种子`)
  }
  sendTotpDeleteTombstonesToPhone(ws, sessionKey, phoneId)
}

function sendTotpDeleteTombstonesToPhone(ws, sessionKey, phoneId) {
  if (!ws || !sessionKey) return
  pruneTotpDeleteTombstones()
  for (const tombstone of totpDeleteTombstones) {
    try {
      const payload = buildTotpSyncPayload(tombstone, 'delete')
      const encrypted = encryptMessage(payload, sessionKey)
      if (!encrypted) continue
      ws.send(JSON.stringify({ type: 'totp_sync', payload: encrypted }))
    } catch (e) {
      console.error('下发 TOTP 删除状态失败:', e)
    }
  }
  if (totpDeleteTombstones.length > 0) {
    console.log(`已向手机 ${phoneId} 补发 ${totpDeleteTombstones.length} 条 TOTP 删除状态`)
  }
}

/** 向所有在线手机广播一条 TOTP 同步消息（用于本机即时新增/删除）。 */
function broadcastTotpSyncToPhones(seed, action = 'add') {
  if (!seed) return
  const payloadPlain = buildTotpSyncPayload(seed, action)
  for (const [phoneId, connections] of activePhoneConnections.entries()) {
    const phone = authorizedPhones.get(phoneId)
    if (!canPushContentToNode(phone, 'totp')) continue
    for (const ws of connections) {
      // 每条连接有各自的会话密钥（基于 nonce 派生），必须按 ws 取
      const sessionKey = phoneSessionKeys.get(ws)
      if (!sessionKey) continue
      const encrypted = encryptMessage(payloadPlain, sessionKey)
      if (!encrypted) continue
      try {
        ws.send(JSON.stringify({ type: 'totp_sync', payload: encrypted }))
      } catch (e) {
        console.error('广播 TOTP 同步失败:', e)
      }
    }
  }
}

function broadcastTotpSyncToDesktopPeers(seed, action = 'add') {
  if (!seed) return
  const payloadPlain = buildTotpSyncPayload(seed, action)
  for (const [peerId, ws] of activeDesktopPeerConnections.entries()) {
    const peer = pairedDesktopPeers.get(peerId)
    if (!canPushContentToNode(peer, 'totp')) continue
    if (!ws || ws.readyState !== WebSocket.OPEN) continue
    const sessionKey = ws.__codebridgeSessionKey
    if (!sessionKey) continue
    const encrypted = encryptMessage(payloadPlain, sessionKey)
    if (!encrypted) continue
    try {
      ws.send(JSON.stringify({ type: 'totp_sync', payload: encrypted }))
    } catch (e) {
      console.error('广播桌面 TOTP 同步失败:', e)
    }
  }
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
  const localSeeds = getLocalTotpSeeds()
  for (const seed of localSeeds) {
    const payload = buildTotpSeedPushPayload(seed, peer)
    const encrypted = encryptMessage(payload, sessionKey)
    if (!encrypted) continue
    ws.send(JSON.stringify({
      type: 'verify_code',
      msgId: `desktop-seed-${seed.id}-${Date.now()}`,
      payload: encrypted
    }))
  }
  sendTotpDeleteTombstonesToDesktopPeer(ws, sessionKey, peer)
}

function sendTotpDeleteTombstonesToDesktopPeer(ws, sessionKey, peer) {
  if (!ws || !sessionKey || !peer || ws.readyState !== WebSocket.OPEN) return
  pruneTotpDeleteTombstones()
  for (const tombstone of totpDeleteTombstones) {
    const payload = buildTotpSyncPayload(tombstone, 'delete')
    const encrypted = encryptMessage(payload, sessionKey)
    if (!encrypted) continue
    ws.send(JSON.stringify({ type: 'totp_sync', payload: encrypted }))
  }
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
  if (existing && existing.readyState === WebSocket.OPEN) return true

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
        peer.lastSeen = Date.now()
        pairedDesktopPeers.set(peer.id, peer)
        savePairingKey()
        notifyDesktopPeersChanged()
        sendLocalTotpSeedsToDesktopPeer(ws, sessionKey, peer)
        sendEncryptedControlMessage(ws, sessionKey, 'topology_delta', buildTopologyDelta('desktop_peer_auth'))
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
      pairedDesktopPeers.set(peer.id, latest)
      notifyDesktopPeersChanged()
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
    offline: '离线',
    disabled: '已禁用',
    revoked: '已撤销',
    discovered: '已发现',
    synced: '已同步'
  }[status] || '未知'
}

function getPhoneTopologyStatus(phone) {
  if (phone.revoked) return 'revoked'
  if (phone.enabled === false) return 'disabled'
  if (phone.connected) return 'online'
  return 'offline'
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
    status: existing.status === 'online' ? existing.status : (node.status || existing.status)
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
  if (!edge || edge.enabled === false || edge.routable !== true) return false
  const type = String(edge.type || '')
  return Object.prototype.hasOwnProperty.call(ROUTE_TYPE_COST, type)
}

function getRouteEdgeMetric(edge) {
  const base = ROUTE_TYPE_COST[edge.type] || 50
  const stalePenalty = edge.updatedAt && Date.now() - edge.updatedAt > ROUTE_STALE_MS ? 20 : 0
  const inactivePenalty = edge.active ? 0 : 15
  const disabledPenalty = edge.enabled === false ? 9999 : 0
  return Math.max(1, Math.round(Number(edge.metric || 0) || base) + stalePenalty + inactivePenalty + disabledPenalty)
}

function buildLinkStateDatabase(nodes, edges) {
  const nodeMap = new Map()
  nodes.forEach(node => {
    if (node?.id) nodeMap.set(String(node.id), node)
  })

  const adjacency = new Map()
  nodeMap.forEach((_node, id) => adjacency.set(id, []))

  edges.filter(isRoutingTransportEdge).forEach(edge => {
    const from = String(edge.from)
    const to = String(edge.to)
    if (!nodeMap.has(from) || !nodeMap.has(to)) return
    const routeEdge = {
      to,
      metric: getRouteEdgeMetric(edge),
      edgeId: edge.id,
      edgeType: edge.type,
      label: edge.label || '链路',
      active: edge.active === true,
      updatedAt: edge.updatedAt || 0
    }
    adjacency.get(from).push(routeEdge)
    adjacency.get(to).push({
      ...routeEdge,
      to: from
    })
  })

  return { nodeMap, adjacency }
}

function computeShortestRoutesFrom(sourceId, lsdb) {
  const { nodeMap, adjacency } = lsdb
  const source = String(sourceId || '')
  if (!source || !nodeMap.has(source)) return []

  const distance = new Map()
  const previous = new Map()
  const previousEdge = new Map()
  const visited = new Set()
  nodeMap.forEach((_node, id) => distance.set(id, Infinity))
  distance.set(source, 0)

  while (visited.size < nodeMap.size) {
    let current = ''
    let best = Infinity
    for (const [id, metric] of distance.entries()) {
      if (!visited.has(id) && metric < best) {
        current = id
        best = metric
      }
    }
    if (!current) break
    visited.add(current)

    for (const edge of adjacency.get(current) || []) {
      if (visited.has(edge.to)) continue
      const nextMetric = best + edge.metric
      if (nextMetric < (distance.get(edge.to) || Infinity)) {
        distance.set(edge.to, nextMetric)
        previous.set(edge.to, current)
        previousEdge.set(edge.to, edge)
      }
    }
  }

  const routes = []
  for (const [destination, metric] of distance.entries()) {
    if (destination === source || !Number.isFinite(metric)) continue
    const path = [destination]
    const edgePath = []
    let cursor = destination
    while (previous.has(cursor)) {
      const edge = previousEdge.get(cursor)
      if (edge) edgePath.unshift(edge)
      cursor = previous.get(cursor)
      path.unshift(cursor)
      if (cursor === source) break
    }
    if (path[0] !== source || path.length < 2) continue
    const nextHopId = path[1]
    const destinationNode = nodeMap.get(destination) || {}
    routes.push({
      id: `${source}->${destination}:spf`,
      from: source,
      to: destination,
      destinationId: destination,
      destinationName: destinationNode.name || destination,
      destinationType: destinationNode.type || '',
      nextHopId,
      nextHopName: nodeMap.get(nextHopId)?.name || nextHopId,
      metric,
      hopCount: path.length - 1,
      path,
      pathLabels: edgePath.map(edge => edge.label),
      via: nextHopId,
      type: 'spf_route',
      label: `SPF 路由 metric ${metric}`,
      enabled: true,
      active: edgePath.some(edge => edge.active),
      authority: 'link_state',
      updatedAt: Math.max(0, ...edgePath.map(edge => edge.updatedAt || 0))
    })
  }

  return routes.sort((a, b) => a.metric - b.metric || a.hopCount - b.hopCount || a.destinationName.localeCompare(b.destinationName))
}

function computeLinkStateRoutes(nodes, edges) {
  const lsdb = buildLinkStateDatabase(nodes, edges)
  const routeTables = {}
  const routes = []
  for (const nodeId of lsdb.nodeMap.keys()) {
    const table = computeShortestRoutesFrom(nodeId, lsdb)
    routeTables[nodeId] = table
    routes.push(...table)
  }
  return {
    protocol: 'link-state-spf',
    version: ROUTING_PROTOCOL_VERSION,
    routeTables,
    routes,
    updatedAt: Date.now()
  }
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
    mergeTopologyNode(nodes, {
      ...node,
      deviceType: node.type,
      status: node.id === identity.id ? 'online' : (node.status || 'offline'),
      enabled: node.enabled !== false,
      connected: node.id === identity.id || node.connected === true,
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
        active: from.connected === true || to.connected === true,
        authority: 'source_device',
        updatedAt: Math.max(from.lastSeen || 0, to.lastSeen || 0),
        description: `经 ${identity.name} 交换路由信息后，两个手机节点可直接同步短信和 TOTP`
      })
    }
  }

  desktopPeers.forEach(peer => {
    const status = peer.connected ? 'online' : (peer.enabled === false ? 'disabled' : 'offline')
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
  const key = base32ToBuffer(seed.secret)
  if (key.length === 0) return ''.padStart(seed.digits, '0')

  const counter = BigInt(Math.floor(timestampSeconds / seed.period))
  const counterBuffer = Buffer.alloc(8)
  let value = counter
  for (let i = 7; i >= 0; i -= 1) {
    counterBuffer[i] = Number(value & 0xffn)
    value >>= 8n
  }

  const hmacAlgorithm = seed.algorithm === 'SHA512'
    ? 'sha512'
    : seed.algorithm === 'SHA256'
      ? 'sha256'
      : 'sha1'
  const digest = crypto.createHmac(hmacAlgorithm, key).update(counterBuffer).digest()
  const offset = digest[digest.length - 1] & 0x0f
  const binary = ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff)
  const otp = binary % (10 ** seed.digits)
  return String(otp).padStart(seed.digits, '0')
}

function base32ToBuffer(base32) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
  let bits = 0
  let value = 0
  const bytes = []

  for (const char of String(base32 || '').toUpperCase().replace(/[\s-=]/g, '')) {
    const index = alphabet.indexOf(char)
    if (index < 0) continue
    value = (value << 5) | index
    bits += 5
    if (bits >= 8) {
      bits -= 8
      bytes.push((value >> bits) & 0xff)
    }
  }

  return Buffer.from(bytes)
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

          // 只接受 authVersion 2（HMAC 派生会话密钥）。
          // 旧 v1 路径（明文比对 pairingKey、明文下发 sessionKey）在 ws:// 上等于把会话密钥
          // 直接交给同网段抓包者，已移除；旧版手机端需升级后才能连接。
          if (message.authVersion === 2 && isValidAuthToken(phoneId, phoneNonce, message.authToken)) {
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
            sendTopologyToPhone(phone.id, ws, connectionSessionKey)
            sendEncryptedControlMessage(ws, connectionSessionKey, 'topology_delta', buildTopologyDelta('auth_ok'))
            // 鉴权成功的一刻顺带把本机 TOTP 种子下发给手机（一次性同步，零额外耗电）
            sendLocalTotpSeedsToPhone(ws, connectionSessionKey, phone.id)
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

        if (message.type === 'verify_code') {
          const msgId = typeof message.msgId === 'string' ? message.msgId : ''
          // 手机端 ACK 丢失后会重连重发同一 msgId：重复消息只补 ACK，不再次弹泡/写剪贴板
          if (msgId && hasRecentDelivery(connectionPhoneId, msgId)) {
            ws.send(JSON.stringify({ type: 'code_ack', msgId }))
            return
          }
          const decrypted = decryptMessage(message.payload, connectionSessionKey)
          if (decrypted) {
            const codeData = JSON.parse(decrypted)
            codeData.phoneId = connectionPhoneId
            codeData.phoneName = connectionPhoneName || codeData.phoneName
            if (codeData.type === 'totp_seed') {
              handleTotpSeed(codeData)
            } else if (codeData.type === 'totp_revoke') {
              handleTotpRevoke(codeData)
            } else if (codeData.type === 'topology_delta' || codeData.type === 'node_advertisement' || codeData.type === 'link_advertisement') {
              applyTopologyDeltaPayload(codeData, { excludeNodeId: connectionPhoneId })
            } else {
              handleVerifyCode(codeData)
            }
            if (msgId) {
              rememberDelivery(connectionPhoneId, msgId)
            }
            // 回 ACK：按需连接模型下手机收到 ACK 才安全断开，确保消息已落地
            ws.send(JSON.stringify({ type: 'code_ack', msgId }))
          }
        }
      } catch (e) {
        console.error('消息处理错误:', e)
      }
    })

    ws.on('close', () => {
      phoneSessionKeys.delete(ws)
      if (connectionPhoneId) {
        removeActivePhoneConnection(connectionPhoneId, ws)
      }
      if (mainWindow) {
        mainWindow.webContents.send('device-disconnected')
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
    pushAuthorityDeviceId
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
    topology: {
      source: {
        id: sourceDeviceId || phoneId || '',
        name: sourceDeviceName || phoneName || '未知手机',
        type: sourceDeviceType || 'ANDROID_PHONE'
      },
      currentTarget: desktopIdentity,
      allTargets: normalizedTargets
    },
    rawMessage: rawMessage || messageBody || body || ''
  }

  if (mainWindow) {
    mainWindow.webContents.send('new-code', codeInfo)
  }

  if (codeInfo.type === CODE_TYPES.SMS && codeInfo.code) {
    showCodeBubble(codeInfo)
    showNotification('📩 新验证码', `${codeInfo.code}\n来源: ${codeInfo.source}\n手机: ${codeInfo.phoneName}`)
    clipboard.writeText(codeInfo.code)
  } else if (codeInfo.type === CODE_TYPES.SMS_MESSAGE) {
    const preview = codeInfo.rawMessage || codeInfo.source
    showNotification('📨 新短信', `${preview}\n来源设备: ${codeInfo.sourceDeviceName}`)
  } else if (codeInfo.type === CODE_TYPES.APP_NOTIFICATION) {
    const titleText = codeInfo.title || codeInfo.appName || codeInfo.source
    const bodyText = codeInfo.rawMessage || ''
    showNotification(`🔔 ${codeInfo.appName || '新通知'}`, `${titleText}\n${bodyText}\n来源设备: ${codeInfo.sourceDeviceName}`)
  }
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

function showNotification(title, body) {
  if (Notification.isSupported()) {
    new Notification({ title, body, urgency: 'critical' }).show()
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

function isSupportedImagePath(filePath) {
  const normalized = String(filePath || '')
  const ext = path.extname(normalized).toLowerCase()
  return ['.png', '.jpg', '.jpeg', '.gif', '.bmp'].includes(ext) && fs.existsSync(normalized)
}

ipcMain.handle('get-pairing-info', async () => {
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
})

ipcMain.handle('copy-to-clipboard', (event, text) => {
  clipboard.writeText(text)

  if (mainWindow) {
    mainWindow.webContents.send('copy-feedback')
  }
})

ipcMain.handle('hide-window', () => {
  if (mainWindow) mainWindow.hide()
})

ipcMain.handle('minimize-window', () => {
  if (mainWindow) mainWindow.hide()
})

ipcMain.handle('regenerate-pairing', async () => {
  await regeneratePairingKey()
  return true
})

ipcMain.handle('get-authorized-phones', () => getAuthorizedPhones())

ipcMain.handle('get-desktop-totps', () => getDesktopTotps())

ipcMain.handle('get-topology', () => getTopologySnapshot())

ipcMain.handle('get-message-settings', () => normalizeMessageSettings(desktopMessageSettings))

ipcMain.handle('set-message-settings', (event, updates) => {
  desktopMessageSettings = normalizeMessageSettings({
    ...desktopMessageSettings,
    ...(updates || {})
  })
  savePairingKey()
  return normalizeMessageSettings(desktopMessageSettings)
})

ipcMain.handle('scan-lan-devices', async () => {
  return scanLanDevices()
})

ipcMain.handle('get-lan-devices', () => getDiscoveredLanDevices())

ipcMain.handle('pair-desktop-device', (event, pairingData) => {
  return pairDesktopPeer(pairingData)
})

ipcMain.handle('is-window-visible', () => {
  return mainWindow ? mainWindow.isVisible() : false
})

ipcMain.handle('set-phone-enabled', (event, phoneId, enabled) => {
  return setPhoneEnabled(phoneId, enabled)
})

ipcMain.handle('set-phone-content-policy', (event, phoneId, updates) => {
  return setPhoneContentPolicy(phoneId, updates)
})

ipcMain.handle('revoke-phone', (event, phoneId) => {
  return revokePhone(phoneId)
})

ipcMain.handle('restore-phone', (event, phoneId) => {
  return restorePhone(phoneId)
})

ipcMain.handle('open-external', async (event, url) => {
  const externalUrl = normalizeExternalUrl(url)
  if (!externalUrl) return false
  await shell.openExternal(externalUrl)
  return true
})

// ==================== Storage API ====================

// TOTP 管理
ipcMain.handle('storage-get-all-totps', () => {
  return getTotpSeedRecords()
})

ipcMain.handle('storage-add-totp', (event, totp) => {
  return addLocalTotpSeed(totp)
})

ipcMain.handle('storage-update-totp', (event, id, updates) => {
  return updateTotpSeed(id, updates)
})

ipcMain.handle('storage-delete-totp', (event, id) => {
  return deleteTotpSeed(id)
})

ipcMain.handle('storage-get-totp-by-id', (event, id) => {
  return toPublicTotpSeed(totpSeeds.get(String(id || '')))
})

// 短信管理
ipcMain.handle('storage-get-all-sms', () => {
  return storage.getAllSms()
})

ipcMain.handle('storage-add-sms', (event, sms) => {
  return storage.addSms(sms)
})

ipcMain.handle('storage-delete-sms', (event, id) => {
  return storage.deleteSms(id)
})

ipcMain.handle('storage-clear-all-sms', () => {
  return storage.clearAllSms()
})

// 统计信息
ipcMain.handle('storage-get-stats', () => {
  const stats = storage.getStats()
  return {
    ...stats,
    totpCount: totpSeeds.size,
    localTotpCount: Array.from(totpSeeds.values()).filter(seed => seed.phoneId === LOCAL_TOTP_SOURCE_ID).length,
    remoteTotpCount: Array.from(totpSeeds.values()).filter(seed => seed.phoneId !== LOCAL_TOTP_SOURCE_ID).length
  }
})

// 设备信息
ipcMain.handle('storage-get-device-id', () => {
  return storage.getDeviceId()
})

ipcMain.handle('storage-get-device-name', () => {
  return storage.getDeviceName()
})

ipcMain.handle('storage-set-device-name', (event, name) => {
  return storage.setDeviceName(name)
})

// 数据导入导出
ipcMain.handle('storage-export-data', () => {
  const data = storage.exportData()
  return {
    ...data,
    totps: getTotpSeedRecords()
  }
})

ipcMain.handle('storage-import-data', (event, data) => {
  const result = storage.importData(data)
  // 导入的数据立即合并进主存储并通知界面，不必等下次重启
  importStorageTotpsIntoPrimaryStore()
  notifyTotpSeedsChanged()
  return result
})

// ==================== QR Code Parser API ====================

// 启动剪贴板监听
ipcMain.handle('qr-start-clipboard-watch', () => {
  qrCodeParser.startClipboardWatcher((result) => {
    // 解析成功后发送到渲染进程
    if (mainWindow) {
      mainWindow.webContents.send('qr-code-detected', result)
    }
  })
  return { success: true }
})

// 停止剪贴板监听
ipcMain.handle('qr-stop-clipboard-watch', () => {
  qrCodeParser.stopClipboardWatcher()
  return { success: true }
})

// 解析文件
ipcMain.handle('qr-parse-file', async (event, filePath) => {
  try {
    if (!isSupportedImagePath(filePath)) {
      return { success: false, error: '不支持的图片文件' }
    }
    const result = await qrCodeParser.parseFile(filePath)
    return { success: true, result }
  } catch (error) {
    return { success: false, error: error.message }
  }
})

// 选择文件并解析
ipcMain.handle('qr-select-and-parse', async () => {
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
})

// 从剪贴板解析
ipcMain.handle('qr-parse-clipboard', async () => {
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
    importStorageTotpsIntoPrimaryStore()
    createWindow({ hidden: startHidden })
    createTray()
    startWebSocketServer()
    startLanDiscoveryService()
    await refreshPairingQR()
    connectAllDesktopPeers()

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
})

app.on('before-quit', () => {
  // 退出前把防抖中未落盘的配对数据写掉
  flushPendingPairingSave()
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
  for (const ws of activeDesktopPeerConnections.values()) {
    try {
      ws.close()
    } catch (_) {}
  }
})
