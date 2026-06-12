const { app, BrowserWindow, Tray, Menu, Notification, clipboard, ipcMain, nativeImage, screen, safeStorage, shell, dialog } = require('electron')
const path = require('path')
const fs = require('fs')
const crypto = require('crypto')
const os = require('os')
const dgram = require('dgram')
const http = require('http')
const { execFile } = require('child_process')
const { WebSocketServer, WebSocket } = require('ws')
const QRCode = require('qrcode')
const storage = require('./src/storage')
const qrCodeParser = require('./src/qrCodeParser')
const messageRouter = require('./src/main/message-router')
const topologyManager = require('./src/main/topology-manager')
const totpStore = require('./src/main/totp-store')
const relayClient = require('./src/main/relay-client')
const busEnvelope = require('./src/main/bus-envelope')
const { createContentBus } = require('./src/main/content-bus')
const { registerDesktopIpc } = require('./src/main/desktop-ipc')
const updater = require('./src/main/updater')
const { createFileTransfer } = require('./src/main/file-transfer')

let mainWindow = null
let bubbleWindow = null
let bubbleTimer = null
// 气泡堆叠队列：短时间内到达的多条消息共用一个气泡窗口，新消息插到顶部，
// 超过 BUBBLE_MAX_ITEMS 时丢弃最旧一条。每次有新消息都重置统一的隐藏计时器。
let bubbleQueue = []
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
let desktopPeerReconnectTimer = null
let discoverySocket = null
let lanJoinServer = null
let localNotifyServer = null
let localEventToken = ''
let lanJoinKeyPair = null
let trustedNetworkId = ''
let allowLanJoinRequests = true
let pendingLanJoinRequests = new Map()
let discoveredLanDevices = new Map()
let topologyLsdb = {
  nodes: new Map(),
  links: new Map(),
  seenSeq: new Map()
}
let topologyDeltaBacklog = []
let contentBus = null
let topologyBroadcastSuppressionDepth = 0
// 每条活跃连接对应的会话密钥（ws -> sessionKey base64），用于反向加密下发 TOTP 种子同步
let phoneSessionKeys = new WeakMap()
let totpSeeds = new Map()
let totpDeleteTombstones = []
let desktopMessageSettings = {
  receiveSmsCodes: true,
  receiveAllSms: true,
  receiveNotifications: true,
  // 剪贴板同步：默认关闭（剪贴板常含密码等敏感内容，需用户显式开启）。
  // 开启后桌面自动把本机剪贴板变化推送给已配对节点，并接受其它节点同步过来的剪贴板。
  syncClipboard: false,
  syncClipboardText: false,
  syncClipboardImage: false,
  syncClipboardFile: false,
  receiveFileTransfer: false,
  autoAcceptFiles: false,
  maxFileSizeMb: 50
}

const WS_PORT = 19527
const DISCOVERY_PORT = 19528
const JOIN_PORT = 19529
const LOCAL_NOTIFY_PORT = 19530
const DISCOVERY_PROTOCOL = 'codebridge-lan-discovery'
const CODE_TYPES = {
  SMS: 'sms',
  SMS_MESSAGE: 'sms_message',
  APP_NOTIFICATION: 'app_notification',
  CLIPBOARD: 'clipboard',
  CLIPBOARD_TEXT: 'clipboard_text',
  CLIPBOARD_IMAGE: 'clipboard_image',
  CLIPBOARD_FILE: 'clipboard_file',
  FILE_TRANSFER: 'file_transfer',
  EXTERNAL_EVENT: 'external_event',
  TOTP: 'totp'
}
const DEFAULT_MESSAGE_SETTINGS = {
  receiveSmsCodes: true,
  receiveAllSms: true,
  receiveNotifications: true,
  // 剪贴板同步默认关闭：剪贴板常含密码等敏感内容，需用户显式启用
  syncClipboard: false,
  syncClipboardText: false,
  syncClipboardImage: false,
  syncClipboardFile: false,
  receiveFileTransfer: false,
  autoAcceptFiles: false,
  maxFileSizeMb: 50
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
const TOPOLOGY_DELTA_BACKLOG_LIMIT = 80
// 用户消息（短信/通知/剪贴板/TOTP 种子）的多跳续传 TTL，与安卓端 SMS_RELAY_TTL 一致。
// 源设备直投所有目标的同时，收到消息的节点会把它续传给目标列表里
// 自己可达而尚未在中继路径中的节点（去重由 originMessageId 保证）。
const USER_MESSAGE_RELAY_TTL = 4
const TOPOLOGY_ENTRY_TTL_MS = 24 * 60 * 60 * 1000
// BFD 式存活检测周期：一个周期未回 pong 即判定链路死亡并 terminate，
// 触发 close → 拓扑重收敛，不再依赖 TCP 自身超时（静默断链可能挂数分钟）
const WS_HEARTBEAT_INTERVAL_MS = 30 * 1000
// 桌面对端断线后的自动重连扫描周期：出站 WS 连接 close 后不会自行恢复，
// 周期性补连已配对且未连接的对端（失败时按 desktopPeerHostAttempts 轮换候选地址）
const DESKTOP_PEER_RECONNECT_INTERVAL_MS = 45 * 1000
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
  bubbleQueue = []
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

function formatBytes(value) {
  const bytes = Number(value) || 0
  if (bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let size = bytes
  let index = 0
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024
    index += 1
  }
  return `${size >= 10 || index === 0 ? size.toFixed(0) : size.toFixed(1)} ${units[index]}`
}

// 气泡视觉规格：窗口宽度、单条/多条高度上限、最多堆叠条数、停留时长。
const BUBBLE_WIDTH = 360
const BUBBLE_MARGIN = 18
const BUBBLE_MAX_ITEMS = 5
const BUBBLE_HIDE_DELAY_MS = 8000
// 单条行的估算高度（含内边距与分隔）；窗口总高 = 表头 + 行数×行高，封顶后内部滚动。
const BUBBLE_ITEM_HEIGHT = 88
const BUBBLE_HEADER_HEIGHT = 16
const BUBBLE_MAX_HEIGHT = 470

// 每种消息类型的强调色与角标文案/图标，决定气泡左侧色条与标记块的样式。
function bubbleTheme(type) {
  switch (type) {
    case 'sms_message':
      return { accent: '#4aa3ff', mark: '短信', tag: '新短信' }
    case 'app_notification':
      return { accent: '#ffb454', mark: '通知', tag: '新通知' }
    case 'clipboard':
    case 'clipboard_text':
      return { accent: '#b48cff', mark: '剪贴', tag: '剪贴板同步' }
    case 'clipboard_image':
      return { accent: '#6cc7ff', mark: '图片', tag: '剪贴板图片' }
    case 'clipboard_file':
    case 'file_transfer':
      return { accent: '#f0c66e', mark: '文件', tag: '文件同步' }
    case 'sms':
    default:
      return { accent: '#5cdb8b', mark: 'OTP', tag: '新验证码' }
  }
}

// 把一条消息归一化为气泡渲染所需的字段（标题行、主体、来源、是否已复制等）。
function toBubbleItem(codeInfo) {
  const type = codeInfo.contentType || codeInfo.type || 'sms'
  const theme = bubbleTheme(type)
  const time = new Date(codeInfo.timestamp || Date.now()).toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit'
  })
  const deviceName = codeInfo.sourceDeviceName || codeInfo.phoneName || '未知设备'

  let primary = ''
  let secondary = ''
  let copied = false
  let big = false
  if (type === 'sms') {
    primary = codeInfo.code || codeInfo.rawMessage || ''
    secondary = `来源 ${codeInfo.source || '未知'} · ${deviceName}`
    copied = !!codeInfo.code
    big = true
  } else if (type === 'sms_message') {
    primary = codeInfo.rawMessage || codeInfo.source || ''
    secondary = `来源 ${codeInfo.source || '短信'} · ${deviceName}`
  } else if (type === 'app_notification') {
    const appName = codeInfo.appName || codeInfo.source || '通知'
    const title = codeInfo.title ? `${codeInfo.title} · ` : ''
    primary = `${title}${codeInfo.rawMessage || ''}`.trim() || appName
    secondary = `${appName} · ${deviceName}`
  } else if (type === 'clipboard' || type === 'clipboard_text') {
    primary = codeInfo.rawMessage || codeInfo.code || ''
    secondary = `剪贴板 · ${deviceName}`
    copied = true
  } else if (type === 'clipboard_image') {
    const manifest = codeInfo.fileManifest || {}
    primary = manifest.name || codeInfo.label || '剪贴板图片'
    secondary = `${formatBytes(manifest.size || 0)} · ${deviceName}`
  } else if (type === 'clipboard_file' || type === 'file_transfer') {
    const manifest = codeInfo.fileManifest || {}
    primary = manifest.name || codeInfo.label || '文件'
    secondary = `${formatBytes(manifest.size || 0)} · ${deviceName}`
  } else {
    primary = codeInfo.rawMessage || codeInfo.code || ''
    secondary = deviceName
  }

  return { type, theme, time, primary, secondary, copied, big }
}

function buildBubbleRowHtml(item) {
  const tag = escapeHtml(item.theme.tag)
  const copied = item.copied ? '<span class="copied">已复制</span>' : ''
  const primaryClass = item.big ? 'primary big' : 'primary'
  return `
    <div class="row" style="--accent: ${item.theme.accent}">
      <div class="accent"></div>
      <div class="mark">${escapeHtml(item.theme.mark)}</div>
      <div class="content">
        <div class="title"><span class="tag">${tag}</span><span class="time">${escapeHtml(item.time)}</span>${copied}</div>
        <div class="${primaryClass}">${escapeHtml(item.primary)}</div>
        <div class="secondary">${escapeHtml(item.secondary)}</div>
      </div>
    </div>`
}

function buildBubbleStackHtml(items) {
  const rows = items.map(buildBubbleRowHtml).join('')
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
    .stack {
      box-sizing: border-box;
      height: calc(100% - 12px);
      margin: 6px;
      padding: 6px;
      color: #f7f9fc;
      background: rgba(20, 22, 30, 0.98);
      border: 1px solid rgba(255, 255, 255, 0.14);
      border-radius: 10px;
      box-shadow: 0 16px 42px rgba(0, 0, 0, 0.34);
      overflow: hidden;
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .row {
      box-sizing: border-box;
      padding: 9px 12px 9px 12px;
      border-radius: 7px;
      background: rgba(255, 255, 255, 0.04);
      display: grid;
      grid-template-columns: 4px 38px minmax(0, 1fr);
      align-items: center;
      gap: 10px;
      animation: enter 160ms ease-out;
    }
    .row + .row { margin-top: 0; }
    .accent {
      width: 4px;
      height: 54px;
      border-radius: 999px;
      background: var(--accent);
      box-shadow: 0 0 16px color-mix(in srgb, var(--accent) 40%, transparent);
    }
    .mark {
      width: 38px;
      height: 38px;
      border-radius: 8px;
      background: color-mix(in srgb, var(--accent) 16%, transparent);
      border: 1px solid color-mix(in srgb, var(--accent) 26%, transparent);
      display: flex;
      align-items: center;
      justify-content: center;
      color: var(--accent);
      font-size: 13px;
      font-weight: 700;
    }
    .content { min-width: 0; }
    .title {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 11px;
      line-height: 16px;
      color: rgba(247, 249, 252, 0.72);
    }
    .tag { color: var(--accent); font-weight: 600; }
    .time { margin-left: auto; color: rgba(247, 249, 252, 0.5); }
    .copied {
      padding: 1px 6px;
      border-radius: 999px;
      color: var(--accent);
      background: color-mix(in srgb, var(--accent) 14%, transparent);
      font-size: 10px;
    }
    .primary {
      margin-top: 3px;
      font-size: 14px;
      line-height: 19px;
      color: #f7f9fc;
      overflow: hidden;
      text-overflow: ellipsis;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      word-break: break-all;
    }
    .primary.big {
      font-size: 28px;
      line-height: 32px;
      font-weight: 700;
      letter-spacing: 2px;
      color: var(--accent);
      -webkit-line-clamp: 1;
      font-family: "Cascadia Code", "Consolas", monospace;
    }
    .secondary {
      margin-top: 4px;
      font-size: 11px;
      line-height: 15px;
      color: rgba(247, 249, 252, 0.58);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    @keyframes enter {
      from { opacity: 0; transform: translateY(8px); }
      to { opacity: 1; transform: translateY(0); }
    }
  </style>
</head>
<body>
  <div class="stack">${rows}</div>
</body>
</html>`
}

function bubbleHeightForCount(count) {
  const height = BUBBLE_HEADER_HEIGHT + count * BUBBLE_ITEM_HEIGHT
  return Math.min(BUBBLE_MAX_HEIGHT, height)
}

// 把一条消息压入气泡队列并刷新窗口：窗口不存在则创建，存在则重建内容并按条数调高。
function pushBubble(codeInfo) {
  if (!app.isReady()) return

  bubbleQueue.unshift(toBubbleItem(codeInfo))
  if (bubbleQueue.length > BUBBLE_MAX_ITEMS) {
    bubbleQueue = bubbleQueue.slice(0, BUBBLE_MAX_ITEMS)
  }

  const height = bubbleHeightForCount(bubbleQueue.length)
  const workArea = screen.getPrimaryDisplay().workArea
  const x = workArea.x + workArea.width - BUBBLE_WIDTH - BUBBLE_MARGIN
  const y = workArea.y + workArea.height - height - BUBBLE_MARGIN
  const html = `data:text/html;charset=utf-8,${encodeURIComponent(buildBubbleStackHtml(bubbleQueue))}`

  if (!bubbleWindow || bubbleWindow.isDestroyed()) {
    bubbleWindow = new BrowserWindow({
      width: BUBBLE_WIDTH,
      height,
      x,
      y,
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
    bubbleWindow.loadURL(html)
    bubbleWindow.once('ready-to-show', () => {
      if (!bubbleWindow || bubbleWindow.isDestroyed()) return
      bubbleWindow.showInactive()
    })
    bubbleWindow.on('closed', () => {
      bubbleWindow = null
    })
  } else {
    // 已有窗口：重设位置/高度（随条数增长向上扩展）并重载堆叠内容
    bubbleWindow.setBounds({ x, y, width: BUBBLE_WIDTH, height })
    bubbleWindow.loadURL(html)
  }

  if (bubbleTimer) clearTimeout(bubbleTimer)
  bubbleTimer = setTimeout(hideCodeBubble, BUBBLE_HIDE_DELAY_MS)
}

// 兼容旧调用名：验证码等单条消息仍可调用 showCodeBubble，内部走统一的堆叠队列。
function showCodeBubble(codeInfo) {
  pushBubble(codeInfo)
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

function deliveryDedupKey(phoneId, msgId, payload = null) {
  const sourceId = String(
    payload?.originDeviceId ||
    payload?.sourceDeviceId ||
    payload?.phoneId ||
    phoneId ||
    ''
  ).trim()
  const messageId = String(
    payload?.originMessageId ||
    payload?.relayMessageId ||
    payload?.msgId ||
    msgId ||
    ''
  ).trim()
  if (!sourceId || !messageId) return ''
  return `${sourceId}|${messageId}`
}

function hasRecentDelivery(phoneId, msgId, payload = null) {
  const key = deliveryDedupKey(phoneId, msgId, payload)
  return key ? recentDeliveryKeys.has(key) : false
}

function rememberDelivery(phoneId, msgId, payload = null) {
  const key = deliveryDedupKey(phoneId, msgId, payload)
  if (!key) return
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

function generateTrustedNetworkId() {
  return `net-${crypto.randomBytes(16).toString('hex')}`
}

function ensureTrustedNetworkId() {
  if (!trustedNetworkId) trustedNetworkId = generateTrustedNetworkId()
  return trustedNetworkId
}

function getLanJoinKeyPair() {
  if (!lanJoinKeyPair) {
    lanJoinKeyPair = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  }
  return lanJoinKeyPair
}

function exportLanJoinPublicKey() {
  const { publicKey } = getLanJoinKeyPair()
  return publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
}

function deriveLanJoinKey(privateKey, peerPublicKeyBase64) {
  const publicKey = crypto.createPublicKey({
    key: Buffer.from(String(peerPublicKeyBase64 || ''), 'base64'),
    type: 'spki',
    format: 'der'
  })
  const shared = crypto.diffieHellman({ privateKey, publicKey })
  return crypto
    .createHash('sha256')
    .update(shared)
    .update('codebridge-lan-join-v1')
    .digest('base64')
}

function createLanJoinRequestKey(targetJoinPublicKey) {
  const pair = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  return {
    publicKey: pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    sessionKey: deriveLanJoinKey(pair.privateKey, targetJoinPublicKey)
  }
}

function createLanJoinAcceptKey(requesterPublicKey) {
  return deriveLanJoinKey(getLanJoinKeyPair().privateKey, requesterPublicKey)
}

function getJoinFingerprint(identity = getDesktopIdentity()) {
  return crypto
    .createHash('sha256')
    .update(`${identity.id}|${identity.name}|${identity.type}|${ensureTrustedNetworkId()}`)
    .digest('hex')
    .slice(0, 16)
    .match(/.{1,4}/g)
    .join('-')
}

function getNodeCapabilities() {
  return {
    topology: true,
    relay: true,
    sms: true,
    totp: true,
    clipboardText: true,
    clipboardImage: true,
    clipboardFile: true,
    fileTransfer: true,
    softBus: true,
    p2pDirect: true,
    externalEvents: true,
    joinRequest: true
  }
}

function contentPolicyForJoinTemplate(template = 'basic') {
  if (template === 'topology_only') {
    return normalizePushContentPolicy({
      allowSmsCodes: false,
      allowSmsMessages: false,
      allowNotifications: false,
      allowTotp: false,
      allowClipboard: false,
      allowClipboardText: false,
      allowClipboardImage: false,
      allowClipboardFile: false,
      allowFileTransfer: false,
      allowExternalEvents: false,
      maxFileSizeMb: 50,
      autoAcceptFiles: false
    })
  }
  if (template === 'full') {
    return normalizePushContentPolicy({
      allowSmsCodes: true,
      allowSmsMessages: true,
      allowNotifications: true,
      allowTotp: true,
      allowClipboard: true,
      allowClipboardText: true,
      allowClipboardImage: true,
      allowClipboardFile: true,
      allowFileTransfer: true,
      allowExternalEvents: true,
      maxFileSizeMb: 50,
      autoAcceptFiles: false
    })
  }
  return normalizePushContentPolicy({
    allowSmsCodes: true,
    allowSmsMessages: false,
    // 与剪贴板 v2 同理：是否推送通知由手机端"发送通知"全局开关（默认关，
    // 且需通知使用权）决定，per-device 位默认放行；旧默认 false 导致
    // LAN 配对后通知永远没有可推送目标，用户极难发现。
    allowNotifications: true,
    allowTotp: true,
    // 局域网可信环境：剪贴板文本默认放行（与 allowNotifications 同款修复，
    // 实际是否同步仍由两端"剪贴板同步"全局开关把关）。图片/文件/传输涉及更大
    // 数据量，保持默认关，由用户按需显式开启。
    allowClipboard: true,
    allowClipboardText: true,
    allowClipboardImage: false,
    allowClipboardFile: false,
    allowFileTransfer: false,
    allowExternalEvents: true,
    maxFileSizeMb: 50,
    autoAcceptFiles: false
  })
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

// 防重放：手机每次连接在 onOpen 生成全新的随机 phoneNonce 并参与 authToken 计算。
// 明文 ws:// 上抓到的一帧 auth 可被原样重放，从而把该手机的 lastIP 改写成攻击者 IP，
// 使后续 relay 投递重定向。这里按手机记录近期已用过的 nonce，重复出现即拒绝。
// 纯服务端逻辑，不改协议，旧版手机端无需升级即可兼容。
const AUTH_NONCE_TTL_MS = 5 * 60 * 1000
const AUTH_NONCE_LIMIT_PER_PHONE = 200
const recentAuthNonces = new Map() // phoneId -> Map<nonce, firstSeenAt>

// 返回 true 表示该 (phoneId, phoneNonce) 在窗口期内已出现过（即重放），应拒绝。
// 校验通过的新 nonce 会被记录下来；调用方应仅在 authToken 校验成功后调用，
// 避免攻击者用无效帧刷爆记录表。
function isReplayedAuthNonce(phoneId, phoneNonce) {
  if (!phoneId || !phoneNonce) return true
  const now = Date.now()
  let seen = recentAuthNonces.get(phoneId)
  if (!seen) {
    seen = new Map()
    recentAuthNonces.set(phoneId, seen)
  }
  // 过期清理：滚出 TTL 的 nonce 删除，避免无限增长
  for (const [nonce, firstSeen] of seen) {
    if (now - firstSeen > AUTH_NONCE_TTL_MS) seen.delete(nonce)
  }
  if (seen.has(phoneNonce)) return true
  seen.set(phoneNonce, now)
  // 容量上限（LRU 语义，超限淘汰最旧）：限制单台手机的内存占用
  while (seen.size > AUTH_NONCE_LIMIT_PER_PHONE) {
    const oldest = seen.keys().next().value
    seen.delete(oldest)
  }
  return false
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
    networkId: String(raw.networkId || '').trim(),
    autoPaired: raw.autoPaired === true,
    trustSourceId: String(raw.trustSourceId || '').trim(),
    trustLevel: String(raw.trustLevel || '').trim(),
    acceptedAt: Number(raw.acceptedAt || 0) || 0,
    capabilities: raw.capabilities && typeof raw.capabilities === 'object' ? raw.capabilities : {},
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
  if (existing && normalizeLsdbSeq(existing.seq, 0) >= node.seq) return false
  const merged = existing ? { ...existing, ...node, pairingKey: node.pairingKey || existing.pairingKey } : node
  topologyLsdb.nodes.set(node.id, merged)
  return JSON.stringify(existing || {}) !== JSON.stringify(merged)
}

function upsertTopologyLsdbLink(rawLink) {
  const link = normalizeLsdbLink(rawLink)
  if (!link) return false
  const existing = topologyLsdb.links.get(link.id)
  if (existing && normalizeLsdbSeq(existing.seq, 0) >= link.seq) return false
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

function protectTopologyDeltaSecrets(delta = {}) {
  const protectedDelta = JSON.parse(JSON.stringify(delta || {}))
  if (Array.isArray(protectedDelta.nodes)) {
    protectedDelta.nodes = protectedDelta.nodes.map(node => ({
      ...node,
      pairingKey: node && node.pairingKey ? protectSecret(node.pairingKey) : ''
    }))
  }
  return protectedDelta
}

function unprotectTopologyDeltaSecrets(delta = {}) {
  const plainDelta = JSON.parse(JSON.stringify(delta || {}))
  if (Array.isArray(plainDelta.nodes)) {
    plainDelta.nodes = plainDelta.nodes.map(node => ({
      ...node,
      pairingKey: node && (node.pairingKey || node.pk)
        ? unprotectSecret(node.pairingKey || node.pk)
        : ''
    }))
  }
  return plainDelta
}

function importTopologyDeltaBacklog(saved = []) {
  topologyDeltaBacklog = (Array.isArray(saved) ? saved : [])
    .map(unprotectTopologyDeltaSecrets)
    .filter(delta => delta && delta.type === 'topology_delta' && Number(delta.seq || 0) > 0)
    .sort((a, b) => Number(a.seq || 0) - Number(b.seq || 0))
    .slice(-TOPOLOGY_DELTA_BACKLOG_LIMIT)
}

function exportTopologyDeltaBacklog() {
  return topologyDeltaBacklog
    .slice(-TOPOLOGY_DELTA_BACKLOG_LIMIT)
    .map(protectTopologyDeltaSecrets)
}

function rememberTopologyDelta(delta = {}, options = {}) {
  const identity = getDesktopIdentity()
  if (!delta || delta.type !== 'topology_delta') return
  const sourceDeviceId = String(delta.sourceDeviceId || delta.originDeviceId || '').trim()
  if (!sourceDeviceId) return
  if (options.requireLocalSource === true && sourceDeviceId !== identity.id) return
  const seq = Number(delta.seq || 0)
  if (!Number.isFinite(seq) || seq <= 0) return
  topologyDeltaBacklog = topologyDeltaBacklog
    .filter(item => {
      const itemSourceId = String(item.sourceDeviceId || item.originDeviceId || '').trim()
      return itemSourceId !== sourceDeviceId || Number(item.seq || 0) !== seq
    })
    .concat(JSON.parse(JSON.stringify(delta)))
    .sort((a, b) => Number(a.seq || 0) - Number(b.seq || 0))
    .slice(-TOPOLOGY_DELTA_BACKLOG_LIMIT)
}

function rememberLocalTopologyDelta(delta = {}) {
  return rememberTopologyDelta(delta, { requireLocalSource: true })
}

function topologySeenSeqObject() {
  return Object.fromEntries(Array.from(topologyLsdb.seenSeq.entries()))
}

function replayTopologyBacklogToPeer(ws, sessionKey, seenSeq = {}) {
  const currentNetworkId = ensureTrustedNetworkId()
  const deltas = topologyDeltaBacklog
    .filter(delta => {
      const deltaNetworkId = String(delta.networkId || '').trim()
      if (deltaNetworkId && deltaNetworkId !== currentNetworkId) return false
      const sourceDeviceId = String(delta.sourceDeviceId || delta.originDeviceId || '').trim()
      if (!sourceDeviceId) return false
      const lastSeen = Number(seenSeq && seenSeq[sourceDeviceId]) || 0
      return Number(delta.seq || 0) > lastSeen
    })
    .sort((a, b) => Number(a.seq || 0) - Number(b.seq || 0))
  if (deltas.length === 0) return false
  let sent = 0
  for (const delta of deltas) {
    if (sendEncryptedControlMessage(ws, sessionKey, 'topology_delta', delta)) sent += 1
  }
  return sent > 0
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

function createLocalEventToken() {
  return crypto.randomBytes(32)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '')
}

function ensureLocalEventToken() {
  if (!localEventToken) {
    localEventToken = process.env.CODEBRIDGE_LOCAL_EVENT_TOKEN || createLocalEventToken()
  }
  return localEventToken
}

function isLocalEventAuthorized(req) {
  const token = ensureLocalEventToken()
  const headerToken = String(req.headers['x-codebridge-token'] || '').trim()
  const authHeader = String(req.headers.authorization || '').trim()
  const bearerToken = authHeader.toLowerCase().startsWith('bearer ')
    ? authHeader.slice(7).trim()
    : ''
  return headerToken === token || bearerToken === token
}

function normalizeMessageSettings(settings = {}) {
  return messageRouter.normalizeMessageSettings(settings)
}

function normalizePushContentPolicy(policy = {}) {
  return messageRouter.normalizePushContentPolicy(policy)
}

function canPushContentToNode(target, type) {
  return messageRouter.canPushContentToNode(target, type, CODE_TYPES)
}

function canReceiveContentType(type) {
  return messageRouter.canReceiveContentType(type, desktopMessageSettings, CODE_TYPES)
}

function topicToLegacyType(topic) {
  return busEnvelope.legacyTypeForTopic(topic)
}

function canPushTopicToNode(target, topic) {
  return canPushContentToNode(target, topicToLegacyType(topic))
}

function canReceiveBusTopic(topic) {
  return canReceiveContentType(topicToLegacyType(topic))
}

function getContentBus() {
  if (contentBus) return contentBus
  contentBus = createContentBus({
    getIdentity: getDesktopIdentity,
    getNetworkId: ensureTrustedNetworkId,
    getTargetNode: targetId => {
      const resolved = resolveForwardTarget(targetId)
      return resolved ? resolved.node : null
    },
    getTopologyRoutes: sourceId => {
      const snapshot = getTopologySnapshot()
      return snapshot.routeTables?.[sourceId] || []
    },
    hasActiveWs: targetId => {
      const outbound = activeDesktopPeerConnections.get(targetId)
      if (outbound && outbound.readyState === WebSocket.OPEN && outbound.__codebridgeSessionKey) return true
      const inbound = activePhoneConnections.get(targetId)
      return !!(inbound && Array.from(inbound).some(ws => ws.readyState === WebSocket.OPEN && phoneSessionKeys.get(ws)))
    },
    canPush: canPushTopicToNode,
    canReceive: topic => canReceiveBusTopic(topic),
    sendDirect: (target, envelope, route) => sendBusEnvelopeDirect(target, envelope, route),
    sendWs: (target, envelope) => sendBusEnvelopeWs(target, envelope),
    sendRelay: (target, envelope) => sendBusEnvelopeLegacyRelay(target, envelope),
    onReceive: (envelope, context) => dispatchInboundBusEnvelope(envelope, context.lastHopDeviceId || ''),
    log: message => console.log(message)
  })
  return contentBus
}

function loadOrCreatePairingKey() {
  const configPath = getPairingConfigPath()
  try {
    if (fs.existsSync(configPath)) {
      const saved = JSON.parse(fs.readFileSync(configPath, 'utf8'))
      // 剪贴板策略 v2 迁移：v1 配置里的 allowClipboard:false 是旧默认值而非
      // 用户选择（旧默认让剪贴板同步永远没有可推送目标），加载时清掉该键，
      // 让新默认（true，受全局总开关约束）生效。落盘时写 policyVersion:2，
      // 此后用户在 UI 里的显式关闭会被原样保留。
      const savedPolicyVersion = Number(saved.policyVersion) || 1
      const upgradeContentPolicy = entry => {
        const source = (entry && (entry.contentPolicy || entry)) || {}
        if (savedPolicyVersion >= 2) return source
        const cleaned = { ...source }
        delete cleaned.allowClipboard
        return cleaned
      }
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
          networkId: String(phone.networkId || '').trim(),
          autoPaired: phone.autoPaired === true,
          trustSourceId: String(phone.trustSourceId || '').trim(),
          trustLevel: String(phone.trustLevel || '').trim(),
          acceptedAt: Number(phone.acceptedAt || 0) || 0,
          capabilities: phone.capabilities && typeof phone.capabilities === 'object' ? phone.capabilities : {},
          contentPolicy: normalizePushContentPolicy(upgradeContentPolicy(phone)),
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
          networkId: String(peer.networkId || '').trim(),
          autoPaired: peer.autoPaired === true,
          trustSourceId: String(peer.trustSourceId || '').trim(),
          trustLevel: String(peer.trustLevel || '').trim(),
          acceptedAt: Number(peer.acceptedAt || 0) || 0,
          capabilities: peer.capabilities && typeof peer.capabilities === 'object' ? peer.capabilities : {},
          contentPolicy: normalizePushContentPolicy(upgradeContentPolicy(peer)),
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
      clipboardSyncState = normalizeClipboardSyncState(saved.clipboardSyncState || {})
      clipboardImageSyncState = normalizeClipboardSyncState(saved.clipboardImageSyncState || {})
      trustedNetworkId = String(saved.networkId || saved.trustedNetworkId || '').trim()
      allowLanJoinRequests = saved.allowLanJoinRequests !== false
      localEventToken = unprotectSecret(saved.localEventToken || '') || ''
      importSavedTopologyLsdb(saved.topologyLsdb || {})
      importTopologyDeltaBacklog(saved.topologyDeltaBacklog || [])
      pruneTotpDeleteTombstones()
      if (saved.pairingKey) {
        // 新格式是 safe:/plain: 前缀密文，旧版明文（base64 不含冒号）原样返回；
        // DPAPI 解密失败（如换了系统用户）返回空串 → 走下方重新生成
        const restoredKey = unprotectSecret(saved.pairingKey)
        if (restoredKey) {
          pairingKey = restoredKey
          ensureTrustedNetworkId()
          if (!localEventToken) {
            ensureLocalEventToken()
            savePairingKey()
          }
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
  ensureTrustedNetworkId()
  ensureLocalEventToken()
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
        // 内容策略格式版本：v2 起 allowClipboard 默认 true（见 loadOrCreatePairingKey 迁移）
        policyVersion: 2,
        networkId: ensureTrustedNetworkId(),
        allowLanJoinRequests,
        localEventToken: protectSecret(ensureLocalEventToken()),
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
          networkId: phone.networkId || '',
          autoPaired: phone.autoPaired === true,
          trustSourceId: phone.trustSourceId || '',
          trustLevel: phone.trustLevel || '',
          acceptedAt: phone.acceptedAt || 0,
          capabilities: phone.capabilities || {},
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
          networkId: peer.networkId || '',
          autoPaired: peer.autoPaired === true,
          trustSourceId: peer.trustSourceId || '',
          trustLevel: peer.trustLevel || '',
          acceptedAt: peer.acceptedAt || 0,
          capabilities: peer.capabilities || {},
          contentPolicy: normalizePushContentPolicy(peer.contentPolicy || peer)
        })),
        totpSeeds: getStoredTotpSeeds(),
        totpDeleteTombstones: getStoredTotpDeleteTombstones(),
        topologyLsdb: exportTopologyLsdb(),
        topologyDeltaBacklog: exportTopologyDeltaBacklog(),
        messageSettings: normalizeMessageSettings(desktopMessageSettings),
        // 剪贴板 LWW 版本（仅哈希不含明文）：跨重启保持，避免补推用旧值盖新值
        clipboardSyncState: { ...clipboardSyncState },
        clipboardImageSyncState: { ...clipboardImageSyncState },
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

function notifyPhonesChanged(options = {}) {
  if (mainWindow) {
    mainWindow.webContents.send('phones-changed', getAuthorizedPhones())
  }
  if (options.topologyChanged !== false) {
    scheduleTopologyBroadcast()
  }
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
    connected: existing?.connected === true
  }
  const topologyChanged = !existing ||
    existing.lastIP !== phone.lastIP ||
    Number(existing.relayPort || 19529) !== Number(phone.relayPort || 19529) ||
    String(existing.pairingKey || '') !== String(phone.pairingKey || '') ||
    String(existing.tsHost || '') !== String(phone.tsHost || '') ||
    String(existing.networkId || '') !== String(phone.networkId || '') ||
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
    tsHost: String(pairingData?.tsHost || '').trim(),
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
    joinPort: JOIN_PORT,
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
  const pairingKeyValue = String(payload.pairingKey || payload.pk || '').trim()
  if (!host || !Number.isFinite(port)) return null
  const isTrusted = authorizedPhones.has(id) || pairedDesktopPeers.has(id) || isKnownTrustedNode(id)

  return {
    id,
    name: String(payload.deviceName || payload.name || id).trim(),
    deviceType,
    host,
    port,
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

function adoptTrustedNetworkId(networkId) {
  const incoming = String(networkId || '').trim()
  if (!incoming) return ensureTrustedNetworkId()
  const existing = String(trustedNetworkId || '').trim()
  if (existing && existing !== incoming && getTrustedPeerCount() > 0) {
    throw new Error('network_id_mismatch')
  }
  trustedNetworkId = incoming
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
  if (isKnownTrustedNode(target.id)) return { success: true, alreadyTrusted: true }

  const identity = getDesktopIdentity()
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
  adoptTrustedNetworkId(accept.networkId)
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
    applyTopologyDeltaPayload(accept.topologySnapshot, { excludeNodeId: accept.acceptedByNodeId || peer.id })
  }
  syncLocalTopologyIntoLsdb('lan_join_accepted')
  broadcastTopologyToAllPeers('lan_join_accepted')
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

  syncLocalTopologyIntoLsdb('lan_join_accept')
  const delta = buildTopologyDelta('lan_join_accept')
  broadcastTopologyToAllPeers('lan_join_accept')

  const acceptPayload = {
    networkId,
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
  const parsed = parseBusTransportEnvelope(body, pairingKey)
  if (!parsed) {
    return { status: 403, body: { type: 'bus_ack', accepted: false, reason: 'invalid_bus_envelope' } }
  }
  const { senderId, envelope } = parsed
  const routePath = Array.isArray(envelope.routePath) ? envelope.routePath : []
  if (routePath.includes(getDesktopIdentity().id)) {
    return { status: 202, body: { type: 'bus_ack', accepted: true, duplicate: true } }
  }
  if (!isKnownTrustedNode(senderId)) {
    return { status: 403, body: { type: 'bus_ack', accepted: false, reason: 'untrusted_sender' } }
  }
  const accepted = getContentBus().receiveEnvelope(envelope, {
    lastHopDeviceId: senderId,
    remoteAddress
  })
  return {
    status: accepted ? 200 : 202,
    body: { type: 'bus_ack', accepted, messageId: envelope.messageId }
  }
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
      authToken: parsedUrl.searchParams.get('authToken')
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
    const baseQuery = ['from', 'to', 'senderId', 'nonce', 'authToken']
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
    return Array.from(new Set(explicitIds)).filter(id => {
      const target = resolveForwardTarget(id)
      return target && canPushExternalEventToNode(target.node, event.channel)
    })
  }
  if (event.target.mode === 'local') return []

  const ids = []
  for (const phone of authorizedPhones.values()) {
    if (phone.id === identity.id) continue
    if (phone.enabled === false || phone.revoked === true) continue
    if (!phone.pairingKey || !(phone.lastIP || phone.host)) continue
    if (canPushExternalEventToNode(phone, event.channel)) ids.push(phone.id)
  }
  for (const peer of pairedDesktopPeers.values()) {
    if (peer.id === identity.id) continue
    if (peer.enabled === false || !peer.pairingKey) continue
    if (canPushExternalEventToNode(peer, event.channel)) ids.push(peer.id)
  }
  return Array.from(new Set(ids))
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
  if (connected) {
    phone.lastSeen = Date.now()
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
  upsertTopologyLsdbNode({
    id: identity.id,
    name: identity.name,
    type: identity.type,
    role: 'local_desktop',
    host: getLocalIP(),
    port: WS_PORT,
    pairingKey,
    tsHost: getTailscaleIPv4(),
    networkId: ensureTrustedNetworkId(),
    autoPaired: false,
    trustSourceId: identity.id,
    trustLevel: 'local',
    acceptedAt: now,
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
      networkId: peer.networkId || ensureTrustedNetworkId(),
      autoPaired: peer.autoPaired === true,
      trustSourceId: peer.trustSourceId || identity.id,
      trustLevel: peer.trustLevel || 'trusted_lan',
      acceptedAt: peer.acceptedAt || peer.firstSeen || now,
      capabilities: peer.capabilities || {},
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
    networkId: options.networkId || ensureTrustedNetworkId(),
    seq,
    ttl,
    updatedAt: now,
    nodes: Array.from(topologyLsdb.nodes.values()).map(node => ({ ...node, type: node.type })),
    links: Array.from(topologyLsdb.links.values())
  }
}

function isKnownTrustedNode(nodeId) {
  const id = String(nodeId || '').trim()
  if (!id) return false
  const identity = getDesktopIdentity()
  if (id === identity.id) return true
  const phone = authorizedPhones.get(id)
  if (phone && phone.enabled !== false && phone.revoked !== true && phone.pairingKey) return true
  const peer = pairedDesktopPeers.get(id)
  if (peer && peer.enabled !== false && peer.pairingKey) return true
  const node = topologyLsdb.nodes.get(id)
  return !!(node && node.enabled !== false && node.revoked !== true && node.pairingKey &&
    (!node.networkId || node.networkId === ensureTrustedNetworkId()))
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
  const deltaNetworkId = String(normalizedDelta.networkId || '').trim()
  if (deltaNetworkId && deltaNetworkId !== ensureTrustedNetworkId()) return false
  if (sourceId && sourceId !== identity.id && !isKnownTrustedNode(sourceId)) return false
  const seq = Number(normalizedDelta.seq || 0)
  let acceptedNewSeq = false
  if (sourceId && sourceId !== identity.id && seq > 0) {
    const lastSeq = topologyLsdb.seenSeq.get(sourceId) || 0
    if (seq <= lastSeq) return false
    topologyLsdb.seenSeq.set(sourceId, seq)
    rememberTopologyDelta(normalizedDelta)
    acceptedNewSeq = true
  }

  let changed = false
  const nodes = Array.isArray(normalizedDelta.nodes) ? normalizedDelta.nodes : []
  const links = Array.isArray(normalizedDelta.links) ? normalizedDelta.links : []
  topologyBroadcastSuppressionDepth += 1
  try {
    for (const rawNode of nodes) {
      const node = normalizeLsdbNode(rawNode)
      if (!node || node.id === identity.id) continue
      const nodeChanged = upsertTopologyLsdbNode(node)
      changed = nodeChanged || changed
      if (nodeChanged && node.routable && node.pairingKey && node.host) {
        if (String(node.type || '').includes('PHONE')) {
          upsertAuthorizedPhone({
            phoneId: node.id,
            phoneName: node.name,
            clientIP: node.host,
            deviceType: node.type,
            pairingKey: node.pairingKey,
            relayPort: node.port || 19529,
            relayHost: node.host,
            tsHost: node.tsHost,
            networkId: node.networkId || ensureTrustedNetworkId(),
            autoPaired: node.autoPaired === true,
            trustSourceId: node.trustSourceId || sourceId || identity.id,
            trustLevel: node.trustLevel || 'trusted_lan',
            acceptedAt: node.acceptedAt || node.updatedAt || Date.now(),
            capabilities: node.capabilities || {},
            contentPolicy: node.contentPolicy
          })
        } else if (String(node.type || '').includes('DESKTOP')) {
          upsertPairedDesktopPeer({
            id: node.id,
            name: node.name,
            deviceType: node.type,
            host: node.host,
            port: node.port || WS_PORT,
            pairingKey: node.pairingKey,
            tsHost: node.tsHost,
            networkId: node.networkId || ensureTrustedNetworkId(),
            autoPaired: node.autoPaired === true,
            trustSourceId: node.trustSourceId || sourceId || identity.id,
            trustLevel: node.trustLevel || 'trusted_lan',
            acceptedAt: node.acceptedAt || node.updatedAt || Date.now(),
            capabilities: node.capabilities || {},
            contentPolicy: node.contentPolicy
          })
        }
      }
    }
    for (const rawLink of links) {
      changed = upsertTopologyLsdbLink(rawLink) || changed
    }
  } finally {
    topologyBroadcastSuppressionDepth = Math.max(0, topologyBroadcastSuppressionDepth - 1)
  }

  if (changed || acceptedNewSeq) {
    savePairingKey()
  }

  if (changed) {
    if (mainWindow) {
      mainWindow.webContents.send('topology-changed')
    }
    if (options.flood !== false && (normalizedDelta.ttl || 0) > 0) {
      const nextTtl = Math.max(0, Number(normalizedDelta.ttl || 0) - 1)
      broadcastTopologyToAllPeers('gossip', {
        baseDelta: {
          ...normalizedDelta,
          ttl: nextTtl,
          relayTtl: nextTtl,
          relayPath: Array.isArray(normalizedDelta.relayPath)
            ? Array.from(new Set([...normalizedDelta.relayPath, identity.id]))
            : Array.from(new Set([sourceId, identity.id].filter(Boolean)))
        },
        preserveSource: true,
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
  if (topologyBroadcastSuppressionDepth > 0) return
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

function handleTopologySnapshotRequest(ws, sessionKey, requestPayload = {}) {
  if (requestPayload && requestPayload.seenSeq) {
    const replayed = replayTopologyBacklogToPeer(ws, sessionKey, requestPayload.seenSeq)
    if (replayed) return true
  }
  return sendEncryptedControlMessage(
    ws,
    sessionKey,
    'topology_delta',
    buildTopologyDelta('snapshot_response')
  )
}

function requestTopologySnapshot(ws, sessionKey) {
  const identity = getDesktopIdentity()
  return sendEncryptedControlMessage(ws, sessionKey, 'topology_snapshot_request', {
    type: 'topology_snapshot_request',
    sourceDeviceId: identity.id,
    seenSeq: topologySeenSeqObject(),
    timestamp: Date.now()
  })
}

function postJsonToNode(host, port, body, optionsOrTimeout = 3500) {
  const options = typeof optionsOrTimeout === 'number'
    ? { timeoutMs: optionsOrTimeout }
    : (optionsOrTimeout || {})
  return relayClient.postJsonToNode(host, port, body, {
    timeoutMs: options.timeoutMs || 3500,
    path: options.path || '/relay',
    normalizeHost: normalizeNetworkHost
  })
}

// codebridge_bus 重放窗口：sentAt 纳入 HMAC，超窗整包拒收。与 relay 的
// relaySentAt 不同，bus 协议没有旧版发送端，sentAt 缺失直接拒绝而非跳过。
const BUS_REPLAY_WINDOW_MS = 5 * 60 * 1000

function buildBusTransportEnvelope(envelope, peerKey) {
  const identity = getDesktopIdentity()
  const payload = encryptMessage(JSON.stringify(envelope), peerKey)
  if (!payload) return null
  const nonce = generateNonce()
  const sentAt = Date.now()
  return {
    type: 'codebridge_bus',
    version: 1,
    senderId: identity.id,
    nonce,
    sentAt,
    payload,
    authToken: hmacBase64(peerKey, `${identity.id}|${nonce}|${sentAt}|${payload}`)
  }
}

function parseBusTransportEnvelope(body, peerKey) {
  if (!body || body.type !== 'codebridge_bus') return null
  const senderId = String(body.senderId || '').trim()
  const nonce = String(body.nonce || '').trim()
  const payload = String(body.payload || '').trim()
  const authToken = String(body.authToken || '').trim()
  if (!senderId || !nonce || !payload || !authToken) return null
  const sentAt = Number(body.sentAt || 0)
  if (!Number.isFinite(sentAt) || sentAt <= 0 || Math.abs(Date.now() - sentAt) > BUS_REPLAY_WINDOW_MS) return null
  const expected = hmacBase64(peerKey, `${senderId}|${nonce}|${sentAt}|${payload}`)
  if (!timingSafeEqual(expected, authToken)) return null
  const plain = decryptMessage(payload, peerKey)
  if (!plain) return null
  const envelope = JSON.parse(plain)
  return busEnvelope.isEnvelope(envelope) ? { senderId, envelope } : null
}

function timingSafeEqual(a, b) {
  const left = Buffer.from(String(a || ''), 'utf8')
  const right = Buffer.from(String(b || ''), 'utf8')
  return left.length === right.length && crypto.timingSafeEqual(left, right)
}

async function sendBusEnvelopeDirect(target, envelope, route = {}) {
  if (!target || !target.pairingKey) return false
  const transportEnvelope = buildBusTransportEnvelope(envelope, target.pairingKey)
  if (!transportEnvelope) return false
  const hosts = route.host
    ? [route.host]
    : [target.lastIP || target.host, target.tsHost]
      .map(normalizeNetworkHost)
      .filter(Boolean)
      .filter((host, index, arr) => arr.indexOf(host) === index)
  const port = Number(route.port || target.relayPort || target.port) || JOIN_PORT
  for (const host of hosts) {
    const ok = await postJsonToNode(host, port, transportEnvelope, { path: '/bus/message', timeoutMs: 3500 })
    if (ok) return true
  }
  return false
}

function sendBusEnvelopeWs(target, envelope) {
  const targetId = String(target?.id || target?.phoneId || '').trim()
  if (!targetId) return false
  const outbound = activeDesktopPeerConnections.get(targetId)
  if (outbound && outbound.readyState === WebSocket.OPEN && outbound.__codebridgeSessionKey) {
    const encrypted = encryptMessage(JSON.stringify(envelope), outbound.__codebridgeSessionKey)
    if (encrypted) {
      try {
        outbound.send(JSON.stringify({ type: 'bus_message', msgId: envelope.messageId, payload: encrypted }))
        return true
      } catch (e) {
        console.error('bus WS send failed:', e)
      }
    }
  }
  const inboundConnections = activePhoneConnections.get(targetId)
  if (inboundConnections) {
    for (const ws of inboundConnections) {
      const sessionKey = phoneSessionKeys.get(ws)
      if (!sessionKey || ws.readyState !== WebSocket.OPEN) continue
      const encrypted = encryptMessage(JSON.stringify(envelope), sessionKey)
      if (!encrypted) continue
      try {
        ws.send(JSON.stringify({ type: 'bus_message', msgId: envelope.messageId, payload: encrypted }))
        return true
      } catch (e) {
        console.error('bus inbound WS send failed:', e)
      }
    }
  }
  return false
}

async function sendBusEnvelopeLegacyRelay(target, envelope) {
  const payload = busEnvelope.toLegacyPayload(envelope)
  if (String(target?.deviceType || target?.type || '').includes('PHONE')) {
    return sendRelayEnvelopeToPhone(target, payload, { skipBus: true })
  }
  return sendVerifyCodeToDesktopNode(target.id, JSON.stringify(payload), envelope.messageId)
}

function dispatchInboundBusEnvelope(envelope, lastHopDeviceId = '') {
  if (!busEnvelope.isEnvelope(envelope)) return false
  const payload = busEnvelope.toLegacyPayload(envelope)
  if (hasRecentDelivery(lastHopDeviceId, envelope.messageId, payload)) return true
  rememberDelivery(lastHopDeviceId, envelope.messageId, payload)
  dispatchInboundCodeData(payload, lastHopDeviceId)
  return true
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
  const preserveSource = options.preserveSource === true
  const delta = {
    ...baseDelta,
    ...(preserveSource ? {} : {
      sourceDeviceId: identity.id,
      sourceDeviceName: identity.name,
      sourceDeviceType: identity.type,
      originDeviceId: baseDelta.originDeviceId || identity.id
    }),
    ttl: Number.isFinite(baseDelta.ttl) ? baseDelta.ttl : TOPOLOGY_DELTA_TTL
  }
  if (!preserveSource) {
    rememberLocalTopologyDelta(delta)
    savePairingKey()
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

// ==================== 剪贴板同步 ====================

// 剪贴板轮询周期：略高于 QR 监听，兼顾及时性与 CPU 占用。
const CLIPBOARD_POLL_INTERVAL_MS = 900
// 单条同步的剪贴板上限，超长内容（如整段文件）不同步，避免气泡/传输膨胀。
const CLIPBOARD_MAX_LENGTH = 20000
// 首版图片剪贴板用 inline manifest 走现有加密 relay，必须保守限制大小。
const CLIPBOARD_INLINE_IMAGE_MAX_BYTES = 180 * 1024
let clipboardWatchTimer = null
// 上一次本机剪贴板内容快照：用于检测变化。
let lastClipboardText = ''
let lastClipboardImageHash = ''
let lastClipboardFileSignature = ''

// 剪贴板 LWW（last-writer-wins）寄存器状态：网络中剪贴板是一个单值寄存器，
// 每次复制产生新版本 (ts, origin)。节点只应用比已知版本更新的内容——
// 旧值、乱序副本、回环副本全部被版本比较吸收，取代了旧的 suppressClipboardText
// 单次回环抑制。只存内容哈希不存明文；随 pairing.json 持久化，
// 重启后的上线补推不会把旧值打上新时间戳盖掉别人的新内容。
let clipboardSyncState = { ts: 0, origin: '', hash: '' }
let clipboardImageSyncState = { ts: 0, origin: '', hash: '' }

function hashClipText(text) {
  return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex').slice(0, 24)
}

function hashBuffer(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex')
}

function isNewerClipVersion(ts, origin) {
  if (!Number.isFinite(ts) || ts <= 0) return false
  if (ts !== clipboardSyncState.ts) return ts > clipboardSyncState.ts
  // 同毫秒平手用 origin 字典序裁决，保证所有节点裁决结果一致
  return String(origin || '') > String(clipboardSyncState.origin || '')
}

function isNewerClipImageVersion(ts, origin) {
  if (!Number.isFinite(ts) || ts <= 0) return false
  if (ts !== clipboardImageSyncState.ts) return ts > clipboardImageSyncState.ts
  return String(origin || '') > String(clipboardImageSyncState.origin || '')
}

function rememberClipVersion(ts, origin, text) {
  clipboardSyncState = { ts, origin: String(origin || ''), hash: hashClipText(text) }
  savePairingKey()
}

function rememberClipImageVersion(ts, origin, hash) {
  clipboardImageSyncState = { ts, origin: String(origin || ''), hash: String(hash || '') }
  savePairingKey()
}

function normalizeClipboardSyncState(saved = {}) {
  return {
    ts: Number(saved.ts) || 0,
    origin: String(saved.origin || ''),
    hash: String(saved.hash || '')
  }
}

function startClipboardSyncWatcher() {
  if (clipboardWatchTimer) return
  try {
    lastClipboardText = clipboard.readText() || ''
    const image = clipboard.readImage()
    lastClipboardImageHash = image && !image.isEmpty() ? hashBuffer(image.toPNG()).slice(0, 24) : ''
    lastClipboardFileSignature = getClipboardFileSignature(readClipboardFilePaths())
  } catch (_) {
    lastClipboardText = ''
    lastClipboardImageHash = ''
    lastClipboardFileSignature = ''
  }
  clipboardWatchTimer = setInterval(pollClipboardForSync, CLIPBOARD_POLL_INTERVAL_MS)
}

function stopClipboardSyncWatcher() {
  if (clipboardWatchTimer) {
    clearInterval(clipboardWatchTimer)
    clipboardWatchTimer = null
  }
}

function pollClipboardForSync() {
  if (
    desktopMessageSettings.syncClipboardText !== true &&
    desktopMessageSettings.syncClipboardImage !== true &&
    desktopMessageSettings.syncClipboardFile !== true
  ) return
  let text = ''
  if (desktopMessageSettings.syncClipboardText === true) {
    try {
      text = clipboard.readText() || ''
    } catch (_) {
      text = ''
    }
    if (text !== lastClipboardText) {
      lastClipboardText = text
      if (text && text.length <= CLIPBOARD_MAX_LENGTH && hashClipText(text) !== clipboardSyncState.hash) {
        // 本机新复制：产生新版本并广播
        rememberClipVersion(Date.now(), getDesktopIdentity().id, text)
        broadcastClipboardToNodes(text)
      }
    }
  }

  if (desktopMessageSettings.syncClipboardImage === true) {
    pollClipboardImageForSync()
  }

  if (desktopMessageSettings.syncClipboardFile === true) {
    pollClipboardFilesForSync()
  }
}

function pollClipboardImageForSync() {
  let image
  try {
    image = clipboard.readImage()
  } catch (_) {
    return
  }
  if (!image || image.isEmpty()) {
    lastClipboardImageHash = ''
    return
  }
  const png = image.toPNG()
  const hash = hashBuffer(png)
  const shortHash = hash.slice(0, 24)
  if (shortHash === lastClipboardImageHash) return
  lastClipboardImageHash = shortHash
  if (shortHash === clipboardImageSyncState.hash) return
  if (png.length > CLIPBOARD_INLINE_IMAGE_MAX_BYTES) {
    // 大图回退：不整包 inline 进 relay 消息，转 manifest + 分片拉取
    //（与文件传输同通道），接收端拉完写剪贴板。版本先行登记，
    // 避免轮询期间把同一张图重复 offer。
    const clipTs = Date.now()
    rememberClipImageVersion(clipTs, getDesktopIdentity().id, shortHash)
    offerClipboardImageAsFile(png, clipTs, shortHash).catch(error => {
      console.error('剪贴板大图 manifest 同步失败:', error.message)
    })
    return
  }
  rememberClipImageVersion(Date.now(), getDesktopIdentity().id, shortHash)
  broadcastClipboardImageToNodes(png, hash)
}

function getDefaultClipboardImageTargetIds() {
  const ids = []
  for (const phone of getAuthorizedPhones()) {
    if (phone.enabled === false || phone.revoked === true) continue
    if (!phone.pairingKey || !(phone.lastIP || phone.host)) continue
    if (canPushContentToNode(phone, CODE_TYPES.CLIPBOARD_IMAGE)) ids.push(phone.id)
  }
  for (const peer of getPairedDesktopPeers()) {
    if (peer.enabled === false || !peer.pairingKey) continue
    if (canPushContentToNode(peer, CODE_TYPES.CLIPBOARD_IMAGE)) ids.push(peer.id)
  }
  return Array.from(new Set(ids))
}

// 大图剪贴板发送侧：PNG 先暂存本地（offer 有效期内充当分片源），再按
// clipboard_image 类型 offer。payloadExtra 带 clipVersion 供接收端 LWW 排序。
async function offerClipboardImageAsFile(pngBuffer, clipTs, shortHash) {
  const targets = getDefaultClipboardImageTargetIds()
  if (targets.length === 0) {
    console.warn('剪贴板大图同步跳过：没有启用图片剪贴板的推送目标')
    return
  }
  const outDir = path.join(app.getPath('userData'), 'clipboard-images-out')
  let filePath
  try {
    fs.mkdirSync(outDir, { recursive: true })
    for (const entry of fs.readdirSync(outDir)) {
      const full = path.join(outDir, entry)
      try {
        // 超过 offer 有效期（30 分钟）的暂存图已不可能再被拉取
        if (Date.now() - fs.statSync(full).mtimeMs > 30 * 60 * 1000) fs.unlinkSync(full)
      } catch (_) {}
    }
    filePath = path.join(outDir, `clipboard-${clipTs}-${shortHash}.png`)
    fs.writeFileSync(filePath, pngBuffer)
  } catch (e) {
    console.error('剪贴板大图暂存失败:', e.message)
    return
  }
  const identity = getDesktopIdentity()
  await initFileTransfer().offerFile(filePath, targets, {
    type: CODE_TYPES.CLIPBOARD_IMAGE,
    source: '剪贴板图片',
    rawPrefix: '剪贴板图片',
    payloadExtra: {
      clipVersion: { ts: clipTs, origin: identity.id, hash: shortHash, kind: 'image' }
    }
  })
}

function readClipboardFilePaths() {
  if (process.platform !== 'win32') return []
  const decodeUtf16Paths = buffer => {
    if (!buffer || buffer.length < 4) return []
    return buffer.toString('utf16le')
      .split('\u0000')
      .map(item => item.trim())
      .filter(Boolean)
  }
  const decodeAnsiPaths = buffer => {
    if (!buffer || buffer.length < 2) return []
    return buffer.toString('utf8')
      .split('\u0000')
      .map(item => item.trim())
      .filter(Boolean)
  }

  try {
    const paths = decodeUtf16Paths(clipboard.readBuffer('FileNameW'))
    if (paths.length > 0) return paths
  } catch (_) {}

  try {
    return decodeAnsiPaths(clipboard.readBuffer('FileName'))
  } catch (_) {
    return []
  }
}

function getClipboardFileSignature(filePaths) {
  if (!Array.isArray(filePaths) || filePaths.length === 0) return ''
  const parts = []
  for (const filePath of filePaths) {
    try {
      const normalized = path.resolve(String(filePath || ''))
      const stat = fs.statSync(normalized)
      if (!stat.isFile()) continue
      parts.push(`${normalized}|${stat.size}|${Math.round(stat.mtimeMs)}`)
    } catch (_) {}
  }
  return parts.join('\n')
}

async function pollClipboardFilesForSync() {
  const filePaths = readClipboardFilePaths()
  const signature = getClipboardFileSignature(filePaths)
  if (!signature) {
    lastClipboardFileSignature = ''
    return
  }
  if (signature === lastClipboardFileSignature) return
  lastClipboardFileSignature = signature

  const targets = getDefaultClipboardFileTargetIds()
  if (targets.length === 0) {
    console.warn('Clipboard file sync skipped: no file-transfer targets are enabled')
    return
  }

  const transfer = initFileTransfer()
  const maxBytes = Math.max(1, Number(desktopMessageSettings.maxFileSizeMb || 50)) * 1024 * 1024
  for (const filePath of filePaths) {
    let stat = null
    try {
      stat = fs.statSync(filePath)
    } catch (error) {
      console.warn(`Clipboard file sync skipped unreadable file: ${filePath}`, error.message)
      continue
    }
    if (!stat.isFile()) continue
    if (stat.size <= 0 || stat.size > maxBytes) {
      console.warn(`Clipboard file sync skipped ${filePath}: ${formatBytes(stat.size)} exceeds ${formatBytes(maxBytes)}`)
      continue
    }
    transfer.offerFile(filePath, targets, {
      type: CODE_TYPES.CLIPBOARD_FILE,
      source: '剪贴板文件',
      rawPrefix: '剪贴板文件'
    }).catch(error => {
      console.error(`Clipboard file sync failed for ${filePath}:`, error.message)
    })
  }
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

function broadcastClipboardImageToNodes(pngBuffer, sha256, options = {}) {
  if (!Buffer.isBuffer(pngBuffer) || pngBuffer.length === 0) return
  if (pngBuffer.length > CLIPBOARD_INLINE_IMAGE_MAX_BYTES) return
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

  const targetPhones = getAuthorizedPhones().filter(phone =>
    phone.enabled !== false &&
    phone.revoked !== true &&
    !exclude.has(phone.id) &&
    canPushContentToNode(phone, CODE_TYPES.CLIPBOARD_IMAGE) &&
    phone.pairingKey &&
    (phone.lastIP || phone.host)
  )
  const targetDesktopPeerIds = new Set(
    Array.from(activeDesktopPeerConnections.keys()).filter(peerId => {
      if (exclude.has(peerId)) return false
      const peer = pairedDesktopPeers.get(peerId)
      return !!peer && peer.enabled !== false && canPushContentToNode(peer, CODE_TYPES.CLIPBOARD_IMAGE)
    })
  )
  const targetDeviceIds = [
    ...targetPhones.map(phone => phone.id),
    ...Array.from(targetDesktopPeerIds)
  ]
  if (targetDeviceIds.length === 0) return

  const fullHash = sha256 || hashBuffer(pngBuffer)
  const shortHash = fullHash.slice(0, 24)
  const originMessageId = `clip-img-${clipOrigin}-${clipTs}-${shortHash}`
  const manifest = {
    fileId: originMessageId,
    name: `clipboard-${clipTs}.png`,
    mime: 'image/png',
    size: pngBuffer.length,
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
    rawMessage: `剪贴板图片 ${formatBytes(pngBuffer.length)}`,
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
    dataBase64: pngBuffer.toString('base64'),
    relayPath,
    // gossip 续传携带衰减后的入站 TTL（options.ttl）；原发（本机新复制/上线补推）
    // 不传 ttl，用满 TTL。避免每跳重置导致 TTL 安全网失效（见剪贴板文本同款修复）。
    relayTtl: Number.isFinite(Number(options.ttl))
      ? Math.max(0, Number(options.ttl))
      : USER_MESSAGE_RELAY_TTL,
    targetDeviceIds
  }

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
  if (!text || text.length > CLIPBOARD_MAX_LENGTH) return false
  const version = (codeData && codeData.clipVersion) || {}
  // 旧版负载无 clipVersion：退化用消息时间戳参与排序，保持互通
  const ts = Number(version.ts) || Number(codeInfo.timestamp) || 0
  const origin = String(version.origin || codeInfo.originDeviceId || codeInfo.sourceDeviceId || '')
  if (hashClipText(text) === clipboardSyncState.hash) return false
  if (!isNewerClipVersion(ts, origin)) return false
  rememberClipVersion(ts, origin, text)
  // 先同步本地快照再写剪贴板，防 900ms 轮询把这次远端写入当成本机新复制
  lastClipboardText = text
  clipboard.writeText(text)
  showCodeBubble(codeInfo)
  showNotification('📋 剪贴板同步', `${text.slice(0, 80)}\n来源设备: ${codeInfo.sourceDeviceName}`)
  return true
}

function applyRemoteClipboardImage(codeInfo, codeData) {
  const manifest = codeInfo.fileManifest || codeData.fileManifest || {}
  const dataBase64 = String(codeInfo.dataBase64 || codeData.dataBase64 || '')
  if (!dataBase64 || manifest.mime !== 'image/png') return false
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
  if (shortHash === clipboardImageSyncState.hash) return false
  if (!isNewerClipImageVersion(ts, origin)) return false
  const image = nativeImage.createFromBuffer(buffer)
  if (image.isEmpty()) return false
  rememberClipImageVersion(ts, origin, shortHash)
  lastClipboardImageHash = shortHash
  clipboard.writeImage(image)
  showCodeBubble(codeInfo)
  showNotification('🖼️ 剪贴板图片同步', `${manifest.name || 'clipboard.png'}\n来源设备: ${codeInfo.sourceDeviceName}`)
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
  if (!text || text.length > CLIPBOARD_MAX_LENGTH) return null
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

function pushClipboardStateToPhone(phone) {
  if (!phone || !canPushContentToNode(phone, CODE_TYPES.CLIPBOARD_TEXT)) return
  if (!phone.pairingKey || !(phone.lastIP || phone.host)) return
  const payload = buildClipboardStatePushPayload([phone.id])
  if (!payload) return
  sendRelayEnvelopeToPhone(phone, payload).catch(() => {})
}

function pushClipboardStateToDesktopPeer(ws, sessionKey, peerId) {
  if (!ws || ws.readyState !== WebSocket.OPEN || !sessionKey) return
  const payload = buildClipboardStatePushPayload([peerId])
  if (!payload) return
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
  if (!phone || !phone.pairingKey || !(phone.lastIP || phone.host)) return false
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
        peer.lastSeen = Date.now()
        pairedDesktopPeers.set(peer.id, peer)
        savePairingKey()
        notifyDesktopPeersChanged()
        sendLocalTotpSeedsToDesktopPeer(ws, sessionKey, peer)
        // 对端（重新）连上时补推本机当前剪贴板状态（LWW 防旧盖新）
        pushClipboardStateToDesktopPeer(ws, sessionKey, peer.id)
        sendEncryptedControlMessage(ws, sessionKey, 'topology_delta', buildTopologyDelta('desktop_peer_auth'))
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
              sendEncryptedControlMessage(ws, connectionSessionKey, 'topology_delta', buildTopologyDelta('auth_ok'))
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
            codeData.msgId = codeData.msgId || msgId
            codeData.lastHopDeviceId = connectionPhoneId
            codeData.lastHopDeviceName = connectionPhoneName
            codeData.phoneId = codeData.phoneId || codeData.sourceDeviceId || connectionPhoneId
            codeData.phoneName = codeData.phoneName || codeData.sourceDeviceName || connectionPhoneName
            if (msgId && hasRecentDelivery(connectionPhoneId, msgId, codeData)) {
              ws.send(JSON.stringify({ type: 'code_ack', msgId }))
              return
            }
            dispatchInboundCodeData(codeData, connectionPhoneId)
            if (msgId) {
              rememberDelivery(connectionPhoneId, msgId, codeData)
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
  return null
}

// 拉取时按 originDeviceId 解析源设备的可达地址 + 共享密钥。
// host 可为空：直连不可达时由 resolveFileRelayCandidates 提供代理通道（多跳）。
function resolveFileSource(originDeviceId) {
  const id = String(originDeviceId || '')
  if (!id) return null
  const phone = authorizedPhones.get(id)
  if (phone && phone.pairingKey) {
    return {
      id,
      name: phone.name || 'Android Phone',
      host: normalizeNetworkHost(phone.lastIP || phone.host || ''),
      port: Number(phone.relayPort || phone.port) || JOIN_PORT,
      pairingKey: phone.pairingKey
    }
  }
  const peer = pairedDesktopPeers.get(id)
  if (peer && peer.pairingKey) {
    return {
      id,
      name: peer.name || 'Desktop PC',
      host: normalizeNetworkHost(peer.host || peer.tsHost || ''),
      port: Number(peer.relayPort || JOIN_PORT) || JOIN_PORT,
      pairingKey: peer.pairingKey
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
  const seen = new Set([exclude, identity.id])
  const add = (id, host, port, name) => {
    const normalizedHost = normalizeNetworkHost(host || '')
    if (!id || !normalizedHost || seen.has(id)) return
    seen.add(id)
    candidates.push({ id, host: normalizedHost, port: Number(port) || JOIN_PORT, name: name || id })
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
        add(hopId, hop.lastIP || hop.host || hop.tsHost, hop.relayPort || JOIN_PORT, hop.name)
      }
    }
  } catch (_) {}
  for (const phone of getAuthorizedPhones()) {
    if (phone.enabled === false || phone.revoked === true) continue
    add(phone.id, phone.lastIP || phone.host, phone.relayPort || JOIN_PORT, phone.name)
  }
  for (const peer of getPairedDesktopPeers()) {
    if (peer.enabled === false) continue
    add(peer.id, peer.host || peer.tsHost, peer.relayPort || JOIN_PORT, peer.name)
  }
  return candidates.slice(0, 6)
}

let fileTransfer = null

function initFileTransfer() {
  if (fileTransfer) return fileTransfer
  const tmpDir = path.join(app.getPath('userData'), 'file-transfers')
  let downloadDir
  try {
    downloadDir = app.getPath('downloads')
  } catch (_) {
    downloadDir = path.join(app.getPath('userData'), 'downloads')
  }
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
    onComplete: ({ fileId, name, path: finalPath, sourceName }) => {
      showNotification('📁 文件接收完成', `${name}\n来源设备: ${sourceName || '未知'}`)
      if (mainWindow) {
        mainWindow.webContents.send('file-transfer-complete', { fileId, name, path: finalPath, sourceName })
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
  const payload = {
    ...basePayload,
    relayPath,
    relayTtl: USER_MESSAGE_RELAY_TTL
  }
  const result = await getContentBus().publish(busEnvelope.TOPICS.FILE_MANIFEST, payload, {
    targetNodeIds: Array.from(targets),
    ttl: USER_MESSAGE_RELAY_TTL,
    routePath: relayPath
  })
  return result.delivered
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
    pushAuthorityDeviceId,
    originMessageId,
    relayMessageId,
    originDeviceId,
    originDeviceName,
    lastHopDeviceId,
    lastHopDeviceName,
    msgId,
    fileManifest,
    dataBase64
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
    dataBase64: dataBase64 || ''
  }

  if (mainWindow) {
    mainWindow.webContents.send('new-code', codeInfo)
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
    showCodeBubble(codeInfo)
    showNotification(`🔔 ${codeInfo.appName || '新通知'}`, `${titleText}\n${bodyText}\n来源设备: ${codeInfo.sourceDeviceName}`)
  } else if (codeInfo.type === CODE_TYPES.CLIPBOARD || codeInfo.type === CODE_TYPES.CLIPBOARD_TEXT) {
    // LWW 应用；状态前进时把同一版本继续 gossip 给本机授权邻居（见剪贴板同步小节）
    if (applyRemoteClipboard(codeInfo, codeData)) {
      gossipClipboardState(codeData)
    }
  } else if (codeInfo.type === CODE_TYPES.CLIPBOARD_IMAGE) {
    const imageManifest = codeInfo.fileManifest || (codeData && codeData.fileManifest) || {}
    if (imageManifest.inline === false && imageManifest.fileId) {
      // 大图（>inline 上限）：分片拉取后写剪贴板，见 handleIncomingClipboardImageManifest
      handleIncomingClipboardImageManifest(codeInfo, codeData, imageManifest)
    } else if (applyRemoteClipboardImage(codeInfo, codeData)) {
      gossipClipboardImageState(codeData)
    }
  } else if (codeInfo.type === CODE_TYPES.FILE_TRANSFER || codeInfo.type === CODE_TYPES.CLIPBOARD_FILE) {
    // 文件传输：manifest 已到达，按策略决定是否回连源设备拉取本体（分片）。
    // 接收开关 + 大小上限 + autoAcceptFiles 三道闸；非自动接收则弹确认对话框。
    handleIncomingFileManifest(codeInfo, codeData)
  }
}

// 大图剪贴板（>inline 上限）：manifest + 分片拉取，完成后写本机剪贴板。
// 与文件传输不同：不弹确认框（已受 syncClipboardImage 接收开关把关）、
// 不落下载目录、应用后即删。拉取前先做 LWW 预检，避免下载旧版本。
function handleIncomingClipboardImageManifest(codeInfo, codeData, manifest) {
  if (manifest.mime !== 'image/png') return
  const maxBytes = Math.max(1, Number(desktopMessageSettings.maxFileSizeMb || 50)) * 1024 * 1024
  const size = Number(manifest.size || 0)
  if (size <= 0 || size > maxBytes) return
  const version = (codeData && codeData.clipVersion) || {}
  const ts = Number(version.ts) || Number(codeInfo.timestamp) || 0
  const origin = String(version.origin || codeInfo.originDeviceId || codeInfo.sourceDeviceId || '')
  const shortHash = String(manifest.sha256 || '').slice(0, 24)
  if (shortHash && shortHash === clipboardImageSyncState.hash) return
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
          rememberClipImageVersion(ts, origin, appliedHash)
          // 先同步本地快照再写剪贴板，防轮询把这次远端写入当成本机新复制
          lastClipboardImageHash = appliedHash
          clipboard.writeImage(image)
          showCodeBubble(codeInfo)
          showNotification('🖼️ 剪贴板图片同步', `${manifest.name || 'clipboard.png'}\n来源设备: ${codeInfo.sourceDeviceName}`)
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

function pruneFileBatchDecisions() {
  const now = Date.now()
  for (const [batchId, entry] of fileBatchDecisions) {
    if (now > entry.expiresAt) fileBatchDecisions.delete(batchId)
  }
}

function handleIncomingFileManifest(codeInfo, codeData) {
  const manifest = codeInfo.fileManifest || (codeData && codeData.fileManifest) || null
  if (!manifest || !manifest.fileId || manifest.inline === true) return
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
    fileTransfer.startIncomingPull(manifest, { maxBytes }).catch(err => {
      console.error('文件拉取启动失败:', err)
    })
  }
  if (autoAccept) {
    beginPull()
    return
  }

  const batchId = String((codeData && codeData.batchId) || codeInfo.batchId || '')
  if (!batchId) {
    // 非批量：弹原生确认框。用户同意后才回连拉取。
    dialog.showMessageBox(mainWindow || undefined, {
      type: 'question',
      buttons: ['接收', '拒绝'],
      defaultId: 0,
      cancelId: 1,
      title: '文件传输请求',
      message: `${sourceName} 想发送文件`,
      detail: `${manifest.name || '文件'}（${formatBytes(size)}）\n来自: ${sourceName}`
    }).then(result => {
      if (result.response === 0) beginPull()
    }).catch(err => {
      console.error('文件接收确认对话框失败:', err)
    })
    return
  }

  pruneFileBatchDecisions()
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
  if (!dataBase64 || manifest.mime !== 'image/png') return
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

// 本机是否该本地消费这条消息。
// 源设备直投（无 lastRelayDeviceId）一律消费，与旧行为完全一致（兼容旧版
// 配对条目 id 不一致的情况）；中转副本（续传而来）只有本机在目标列表内才消费，
// 否则只续传不展示——避免「下一跳路由经过的桌面把过路消息当自己的弹出来」。
function isLocalTargetOfPayload(codeData) {
  const relayed = !!String(codeData.lastRelayDeviceId || '').trim()
  if (!relayed) return true
  const ids = payloadTargetIds(codeData)
  if (ids.length === 0) return true
  return ids.includes(getDesktopIdentity().id)
}

// 在已知节点表里解析续传目标：桌面对端 → 已授权手机 → 拓扑 LSDB（gossip 学到的）
function resolveForwardTarget(targetId) {
  const peer = pairedDesktopPeers.get(targetId)
  if (peer) return { kind: 'desktop', node: peer }
  const phone = authorizedPhones.get(targetId)
  if (phone) {
    return String(phone.deviceType || '').includes('DESKTOP')
      ? { kind: 'desktop', node: phone }
      : { kind: 'phone', node: phone }
  }
  const lsdbNode = topologyLsdb.nodes.get(targetId)
  if (lsdbNode) {
    if (String(lsdbNode.type || '').includes('PHONE')) {
      return {
        kind: 'phone',
        node: {
          id: lsdbNode.id,
          name: lsdbNode.name,
          pairingKey: lsdbNode.pairingKey,
          lastIP: lsdbNode.host || lsdbNode.lastIP,
          tsHost: lsdbNode.tsHost || '',
          relayPort: Number(lsdbNode.port) || 19529,
          enabled: lsdbNode.enabled !== false,
          revoked: lsdbNode.revoked === true
        }
      }
    }
    return { kind: 'desktop', node: lsdbNode }
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

function forwardMessageToNode(targetId, payload, messageKey) {
  const target = resolveForwardTarget(targetId)
  if (!target || target.node.enabled === false || target.node.revoked === true) return false
  if (target.kind === 'phone') {
    const phone = target.node
    if (!phone.pairingKey || !(phone.lastIP || phone.host)) return false
    sendRelayEnvelopeToPhone(phone, payload).then(ok => {
      if (!ok) console.warn(`续传到手机失败: ${phone.name || targetId}`)
    }).catch(error => {
      console.error(`续传到手机异常 ${phone.name || targetId}:`, error.message)
    })
    return true
  }
  return sendVerifyCodeToDesktopNode(targetId, JSON.stringify(payload), messageKey)
}

// 把一条入站用户消息续传给源设备目标列表里的其余节点（本机可达的部分）。
// 与手机端 enqueueRelayPayload 的防环/范围规则一致。
function forwardRelayedMessage(codeData, lastHopDeviceId = '') {
  try {
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
  } else if (isLocalTarget) {
    handleVerifyCode(codeData)
  }
  forwardRelayedMessage(codeData, lastHopDeviceId)
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

function getDefaultFileTransferTargetIds() {
  const ids = []
  for (const phone of getAuthorizedPhones()) {
    if (phone.enabled === false || phone.revoked === true) continue
    if (!phone.pairingKey || !(phone.lastIP || phone.host)) continue
    if (canPushContentToNode(phone, CODE_TYPES.FILE_TRANSFER)) ids.push(phone.id)
  }
  for (const peer of getPairedDesktopPeers()) {
    if (peer.enabled === false || !peer.pairingKey) continue
    if (canPushContentToNode(peer, CODE_TYPES.FILE_TRANSFER)) ids.push(peer.id)
  }
  return Array.from(new Set(ids))
}

function getDefaultClipboardFileTargetIds() {
  const ids = []
  for (const phone of getAuthorizedPhones()) {
    if (phone.enabled === false || phone.revoked === true) continue
    if (!phone.pairingKey || !(phone.lastIP || phone.host)) continue
    if (
      canPushContentToNode(phone, CODE_TYPES.CLIPBOARD_FILE) ||
      canPushContentToNode(phone, CODE_TYPES.FILE_TRANSFER)
    ) {
      ids.push(phone.id)
    }
  }
  for (const peer of getPairedDesktopPeers()) {
    if (peer.enabled === false || !peer.pairingKey) continue
    if (
      canPushContentToNode(peer, CODE_TYPES.CLIPBOARD_FILE) ||
      canPushContentToNode(peer, CODE_TYPES.FILE_TRANSFER)
    ) {
      ids.push(peer.id)
    }
  }
  return Array.from(new Set(ids))
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
    const requestedTargets = Array.isArray(targetIds)
      ? targetIds.map(id => String(id || '').trim()).filter(Boolean)
      : []
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
    const options = {}
    if (item.rel) options.relativePath = item.rel
    if (batchId) {
      options.payloadExtra = { batchId, batchCount: items.length, batchTotalBytes }
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
    const requestedTargets = Array.isArray(targetIds)
      ? targetIds.map(id => String(id || '').trim()).filter(Boolean)
      : []
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
  getTopology: () => getTopologySnapshot(),
  getMessageSettings: () => normalizeMessageSettings(desktopMessageSettings),
  setMessageSettings: updates => {
    desktopMessageSettings = normalizeMessageSettings({
      ...desktopMessageSettings,
      ...(updates || {})
    })
    savePairingKey()
    if (
      desktopMessageSettings.syncClipboardText === true ||
      desktopMessageSettings.syncClipboardImage === true ||
      desktopMessageSettings.syncClipboardFile === true
    ) {
      try {
        lastClipboardText = clipboard.readText() || ''
        const image = clipboard.readImage()
        lastClipboardImageHash = image && !image.isEmpty() ? hashBuffer(image.toPNG()).slice(0, 24) : ''
        lastClipboardFileSignature = getClipboardFileSignature(readClipboardFilePaths())
      } catch (_) {
        lastClipboardText = ''
        lastClipboardImageHash = ''
        lastClipboardFileSignature = ''
      }
    }
    return normalizeMessageSettings(desktopMessageSettings)
  },
  fileSelectAndSend: targetIds => selectAndSendFile(targetIds),
  fileSelectAndSendFolder: targetIds => selectAndSendFolder(targetIds),
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
