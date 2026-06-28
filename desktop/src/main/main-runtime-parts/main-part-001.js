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
let pendingTotpResyncPeerIds = new Set()
let discoverySocket = null
let lanJoinServer = null
let localNotifyServer = null
let localEventToken = ''
let lanJoinKeyPair = null
let trustedNetworkId = ''
let pendingNetworkMergeFromIds = new Set()
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
let busReliabilityStore = null
let busOutboxFlushTimer = null
let routeHealthTracker = createRouteHealthTracker()
let topologyBroadcastSuppressionDepth = 0
// 每条活跃连接对应的会话密钥（ws -> sessionKey base64），用于反向加密下发 TOTP 种子同步
let phoneSessionKeys = new WeakMap()
let totpSeeds = new Map()
let totpDeleteTombstones = []
let fileTransferHistory = []
let fileTransferDownloadDir = ''
let desktopMessageSettings = {
  receiveSmsCodes: true,
  receiveAllSms: true,
  receiveNotifications: true,
  // 剪贴板同步：默认关闭（剪贴板常含密码等敏感内容，需用户显式开启）。
  // 开启后桌面自动把本机剪贴板变化推送给已配对节点，并接受其它节点同步过来的剪贴板。
  syncClipboard: false,
  syncClipboardText: false,
  syncClipboardImage: true,
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
  APP_NOTIFICATION_REMOVED: 'app_notification_removed',
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
  syncClipboardImage: true,
  syncClipboardFile: false,
  receiveFileTransfer: false,
  autoAcceptFiles: false,
  maxFileSizeMb: 50
}
const PAIRING_CONFIG_FILE = 'pairing.json'
const TOPOLOGY_DELTA_BACKLOG_FILE = 'topology-delta-backlog.json'
const FILE_TRANSFER_HISTORY_FILE = 'file-transfer-history.json'
const BUS_RELIABILITY_FILE = 'bus-reliability.json'
const FILE_TRANSFER_HISTORY_LIMIT = 300
const gotSingleInstanceLock = app.requestSingleInstanceLock()
const ICON_PATH = path.join(__dirname, 'assets', 'icon.ico')
const START_HIDDEN = process.argv.includes('--hidden')
const QUIT_FOR_UPDATE = process.argv.includes('--quit-for-update')
const LOCAL_TOTP_SOURCE_ID = 'desktop-local'
const TOTP_DELETE_TOMBSTONE_TTL_MS = 180 * 24 * 60 * 60 * 1000
const TOTP_DELETE_TOMBSTONE_LIMIT = 300
const ROUTING_PROTOCOL_VERSION = 2
const ROUTE_STALE_MS = 10 * 60 * 1000
const TOPOLOGY_RECENT_REACHABLE_MS = 2 * 60 * 1000
const TOPOLOGY_DELTA_TTL = 4
const TOPOLOGY_DELTA_BACKLOG_LIMIT = 12
const TOPOLOGY_DELTA_BACKLOG_PER_SOURCE_LIMIT = 3
const TOPOLOGY_DELTA_BACKLOG_MAX_BYTES = 128 * 1024
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
    flushPendingPairingSave({ sync: true })
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
const RECENT_CLIPBOARD_UI_LIMIT = 1000
const recentClipboardUiKeys = new Set()
const recentClipboardUiQueue = []

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

function isClipboardStateType(type) {
  return type === CODE_TYPES.CLIPBOARD ||
    type === CODE_TYPES.CLIPBOARD_TEXT ||
    type === CODE_TYPES.CLIPBOARD_IMAGE
}

function clipboardBusinessKey(payload = {}) {
  const type = String(payload.contentType || payload.type || '').trim()
  if (!isClipboardStateType(type) &&
      type !== CODE_TYPES.CLIPBOARD_FILE &&
      type !== CODE_TYPES.FILE_TRANSFER) {
    return ''
  }
  const version = payload.clipVersion && typeof payload.clipVersion === 'object'
    ? payload.clipVersion
    : {}
  const manifest = payload.fileManifest && typeof payload.fileManifest === 'object'
    ? payload.fileManifest
    : {}
  const origin = String(
    version.origin ||
    payload.originDeviceId ||
    payload.sourceDeviceId ||
    payload.phoneId ||
    ''
  ).trim()
  const ts = String(version.ts || payload.timestamp || '').trim()
  const manifestHash = String(
    version.hash ||
    manifest.sha256 ||
    manifest.fileId ||
    payload.originMessageId ||
    payload.relayMessageId ||
    payload.msgId ||
    ''
  ).trim()
  const text = String(payload.rawMessage || payload.messageBody || payload.body || '')
  const contentHash = manifestHash || (text ? hashClipText(text) : '')
  if (!origin && !ts && !contentHash) return ''
  return [
    'clipboard',
    type || 'unknown',
    String(version.kind || '').trim(),
    origin,
    ts,
    contentHash
  ].join('|')
}

function hasRecentClipboardUi(payload = {}) {
  const key = clipboardBusinessKey(payload)
  return key ? recentClipboardUiKeys.has(key) : false
}

function rememberRecentClipboardUi(payload = {}) {
  const key = clipboardBusinessKey(payload)
  if (!key || recentClipboardUiKeys.has(key)) return
  recentClipboardUiKeys.add(key)
  recentClipboardUiQueue.push(key)
  while (recentClipboardUiQueue.length > RECENT_CLIPBOARD_UI_LIMIT) {
    recentClipboardUiKeys.delete(recentClipboardUiQueue.shift())
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

function uniqueNetworkIds(values = []) {
  return Array.from(new Set(
    values
      .map(value => String(value || '').trim())
      .filter(Boolean)
  ))
}

function normalizeNetworkMergeIds(value) {
  if (Array.isArray(value)) return uniqueNetworkIds(value)
  if (value && typeof value === 'object') {
    if (Array.isArray(value.mergeFromNetworkIds)) return normalizeNetworkMergeIds(value.mergeFromNetworkIds)
    if (Array.isArray(value.networkAliases)) return normalizeNetworkMergeIds(value.networkAliases)
  }
  return []
}

function rewriteStoredNetworkIds(targetNetworkId, mergeFromNetworkIds = []) {
  const target = String(targetNetworkId || '').trim()
  if (!target) return []
  const mergeFrom = uniqueNetworkIds(mergeFromNetworkIds).filter(id => id !== target)
  const shouldRewrite = id => {
    const value = String(id || '').trim()
    return !value || value === target || mergeFrom.includes(value)
  }

  for (const phone of authorizedPhones.values()) {
    if (shouldRewrite(phone.networkId)) phone.networkId = target
  }
  for (const peer of pairedDesktopPeers.values()) {
    if (shouldRewrite(peer.networkId)) peer.networkId = target
  }
  for (const node of topologyLsdb.nodes.values()) {
    if (shouldRewrite(node.networkId)) {
      node.networkId = target
      node.updatedAt = Date.now()
      node.seq = nextLsdbSequence()
    }
  }
  topologyDeltaBacklog = topologyDeltaBacklog.map(delta => {
    const copy = JSON.parse(JSON.stringify(delta))
    if (shouldRewrite(copy.networkId)) copy.networkId = target
    if (Array.isArray(copy.nodes)) {
      copy.nodes = copy.nodes.map(node => {
        const next = { ...node }
        if (shouldRewrite(next.networkId)) next.networkId = target
        return next
      })
    }
    return copy
  })
  return mergeFrom
}

function mergeTrustedNetworkId(targetNetworkId, mergeFromNetworkIds = []) {
  const target = String(targetNetworkId || '').trim()
  if (!target) return []
  const previous = String(trustedNetworkId || '').trim()
  const mergeFrom = uniqueNetworkIds([previous, ...mergeFromNetworkIds]).filter(id => id && id !== target)
  trustedNetworkId = target
  rewriteStoredNetworkIds(target, mergeFrom)
  mergeFrom.forEach(id => pendingNetworkMergeFromIds.add(id))
  saveTopologyDeltaBacklog()
  savePairingKey()
  return mergeFrom
}

function rewriteTopologyDeltaNetwork(rawDelta, targetNetworkId, mergeFromNetworkIds = []) {
  if (!rawDelta || typeof rawDelta !== 'object') return rawDelta
  const target = String(targetNetworkId || '').trim()
  if (!target) return rawDelta
  const mergeFrom = uniqueNetworkIds([
    rawDelta.networkId,
    ...normalizeNetworkMergeIds(rawDelta.mergeFromNetworkIds || []),
    ...mergeFromNetworkIds
  ]).filter(id => id && id !== target)
  const delta = JSON.parse(JSON.stringify(rawDelta))
  delta.networkId = target
  if (mergeFrom.length > 0) {
    delta.networkMerge = true
    delta.mergeFromNetworkIds = mergeFrom
    delta.mergedAt = Date.now()
  }
  if (Array.isArray(delta.nodes)) {
    delta.nodes = delta.nodes.map(node => ({
      ...node,
      networkId: target,
      autoPaired: node.autoPaired === true || node.trustLevel === 'trusted_lan',
      trustLevel: node.trustLevel || 'trusted_lan'
    }))
  }
  return delta
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
    allowClipboardImage: true,
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

const TOPOLOGY_VOLATILE_FIELDS = new Set([
  'seq',
  'updatedAt',
  'lastSeen',
  'expiresAt',
  'connected',
  'status',
  'active'
])

function normalizeTopologyPort(type, port) {
  const value = Number(port)
  const isPhone = String(type || '').includes('PHONE')
  if (isPhone) {
    return Number.isFinite(value) && value > 0 ? Math.round(value) : JOIN_PORT
  }
  if (!Number.isFinite(value) || value <= 0 || Math.round(value) === JOIN_PORT) {
    return WS_PORT
  }
  return Math.round(value)
}

function normalizeTopologyRelayPort(type, raw = {}) {
  const isPhone = String(type || '').includes('PHONE')
  const value = Number(raw.relayPort || raw.joinPort || (isPhone ? raw.port : JOIN_PORT))
  return Number.isFinite(value) && value > 0 ? Math.round(value) : JOIN_PORT
}

function topologySemanticFingerprint(value, ignoredKeys = TOPOLOGY_VOLATILE_FIELDS) {
  if (Array.isArray(value)) {
    return `[${value.map(item => topologySemanticFingerprint(item, ignoredKeys)).join(',')}]`
  }
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .filter(key => !ignoredKeys.has(key))
      .sort()
      .map(key => `${key}:${topologySemanticFingerprint(value[key], ignoredKeys)}`)
      .join(',')}}`
  }
  return JSON.stringify(value ?? null)
}

function isSemanticTopologyUpdate(incoming, existing) {
  if (!existing) return true
  const incomingSeq = normalizeLsdbSeq(incoming.seq || incoming.updatedAt, 0)
  const existingSeq = normalizeLsdbSeq(existing.seq || existing.updatedAt, 0)
  if (incomingSeq > 0 && existingSeq > 0 && incomingSeq < existingSeq) return false
  return topologySemanticFingerprint(incoming) !== topologySemanticFingerprint(existing)
}

function isTopologyVolatileRefresh(incoming, existing) {
  if (!existing) return false
  const incomingSeq = normalizeLsdbSeq(incoming.seq || incoming.updatedAt, 0)
  const existingSeq = normalizeLsdbSeq(existing.seq || existing.updatedAt, 0)
  return incomingSeq > existingSeq &&
    topologySemanticFingerprint(incoming) === topologySemanticFingerprint(existing)
}

function refreshTopologyVolatileFields(existing, incoming) {
  const refreshed = { ...(existing || {}) }
  for (const key of TOPOLOGY_VOLATILE_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(incoming, key)) {
      refreshed[key] = incoming[key]
    }
  }
  return refreshed
}

function normalizeLsdbNode(raw = {}) {
  const id = String(raw.id || raw.deviceId || '').trim()
  if (!id) return null
  const type = normalizeDeviceType(raw.type || raw.deviceType, 'UNKNOWN_DEVICE')
  const isPhone = type.includes('PHONE')
  const host = normalizeNetworkHost(raw.host || raw.lastIP || raw.relayHost || '')
  const pairingKeyValue = String(raw.pairingKey || raw.pk || '').trim()
  const altHosts = Array.isArray(raw.altHosts)
    ? raw.altHosts.map(normalizeNetworkHost).filter(Boolean)
    : []
  const hasAddressOrRoute = !!host ||
    !!String(raw.tsHost || '').trim() ||
    altHosts.length > 0 ||
    !!String(raw.routeNextHopId || '').trim() ||
    Number(raw.routeMetric || 0) > 0 ||
    (Array.isArray(raw.routePath) && raw.routePath.length > 1)
  const now = Date.now()
  const updatedAt = normalizeLsdbSeq(raw.updatedAt || raw.lastSeen, now)
  const rawLastSeen = Number(raw.lastSeen || 0)
  const lastSeen = Number.isFinite(rawLastSeen) && rawLastSeen > 0
    ? normalizeLsdbSeq(rawLastSeen, 0)
    : 0
  return {
    id,
    name: String(raw.name || raw.deviceName || id).trim(),
    type,
    role: raw.role || (type.includes('DESKTOP') ? 'desktop' : (isPhone ? 'phone' : 'peer')),
    host,
    lastIP: normalizeNetworkHost(raw.lastIP || host),
    port: normalizeTopologyPort(type, raw.wsPort || raw.port || raw.relayPort),
    wsPort: isPhone ? undefined : normalizeTopologyPort(type, raw.wsPort || raw.port || WS_PORT),
    relayPort: normalizeTopologyRelayPort(type, raw),
    pairingKey: pairingKeyValue,
    tsHost: String(raw.tsHost || '').trim(),
    altHosts,
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
    routable: raw.routable === true || (hasAddressOrRoute && !!pairingKeyValue && raw.enabled !== false && raw.revoked !== true),
    sourceId: String(raw.sourceId || raw.originDeviceId || raw.sourceDeviceId || '').trim(),
    seq: normalizeLsdbSeq(raw.seq || raw.updatedAt, updatedAt),
    updatedAt,
    lastSeen,
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
  const merged = existing ? { ...existing, ...node, pairingKey: node.pairingKey || existing.pairingKey } : node
  if (isSemanticTopologyUpdate(merged, existing)) {
    topologyLsdb.nodes.set(node.id, merged)
    return true
  }
  if (isTopologyVolatileRefresh(merged, existing)) {
    topologyLsdb.nodes.set(node.id, refreshTopologyVolatileFields(existing, merged))
  }
  return false
}

function upsertTopologyLsdbLink(rawLink) {
  const link = normalizeLsdbLink(rawLink)
  if (!link) return false
  const existing = topologyLsdb.links.get(link.id)
  const merged = existing ? { ...existing, ...link } : link
  if (isSemanticTopologyUpdate(merged, existing)) {
    topologyLsdb.links.set(link.id, merged)
    return true
  }
  if (isTopologyVolatileRefresh(merged, existing)) {
    topologyLsdb.links.set(link.id, refreshTopologyVolatileFields(existing, merged))
  }
  return false
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

function compactTopologyNodeForBacklog(raw = {}) {
  const node = normalizeLsdbNode(raw)
  if (!node) return null
  return {
    id: node.id,
    name: node.name,
    type: node.type,
    role: node.role,
    host: node.host,
    lastIP: node.lastIP,
    port: node.port,
    wsPort: node.wsPort,
    relayPort: node.relayPort,
    pairingKey: node.pairingKey,
    tsHost: node.tsHost,
    altHosts: node.altHosts,
    networkId: node.networkId,
    autoPaired: node.autoPaired,
    trustSourceId: node.trustSourceId,
    trustLevel: node.trustLevel,
    acceptedAt: node.acceptedAt,
    capabilities: node.capabilities,
    enabled: node.enabled,
    revoked: node.revoked,
    contentPolicy: node.contentPolicy,
    connected: node.connected,
    status: node.status,
    authority: node.authority,
    routable: node.routable,
    sourceId: node.sourceId,
    seq: node.seq,
    updatedAt: node.updatedAt,
    lastSeen: node.lastSeen,
    expiresAt: node.expiresAt
  }
}

function compactTopologyLinkForBacklog(raw = {}) {
  const link = normalizeLsdbLink(raw)
  if (!link) return null
  return {
    id: link.id,
    from: link.from,
    to: link.to,
    type: link.type,
    label: link.label,
    direction: link.direction,
    enabled: link.enabled,
    active: link.active,
    routable: link.routable,
    contentPolicy: link.contentPolicy,
    authority: link.authority,
    metric: link.metric,
    description: link.description,
    seq: link.seq,
    updatedAt: link.updatedAt,
    expiresAt: link.expiresAt
  }
}

function compactTopologyDeltaForBacklog(delta = {}) {
  if (!delta || delta.type !== 'topology_delta') return null
  const nodes = Array.isArray(delta.nodes)
    ? delta.nodes.map(compactTopologyNodeForBacklog).filter(Boolean)
    : []
  const links = Array.isArray(delta.links)
    ? delta.links.map(compactTopologyLinkForBacklog).filter(Boolean)
    : []
  const compact = {
    type: 'topology_delta',
    version: delta.version || ROUTING_PROTOCOL_VERSION,
    routingProtocol: delta.routingProtocol || 'link-state-spf',
    controlPlane: delta.controlPlane !== false,
    messageTypes: Array.isArray(delta.messageTypes) ? delta.messageTypes : ['node_advertisement', 'link_advertisement'],
    reason: delta.reason || 'backlog',
    sourceDeviceId: String(delta.sourceDeviceId || delta.originDeviceId || '').trim(),
    sourceDeviceName: String(delta.sourceDeviceName || '').trim(),
    sourceDeviceType: String(delta.sourceDeviceType || '').trim(),
    originDeviceId: String(delta.originDeviceId || delta.sourceDeviceId || '').trim(),
    networkId: String(delta.networkId || '').trim(),
    seq: Number(delta.seq || 0),
    ttl: Number.isFinite(Number(delta.ttl)) ? Number(delta.ttl) : TOPOLOGY_DELTA_TTL,
    updatedAt: Number(delta.updatedAt || delta.seq || Date.now()) || Date.now(),
    nodes,
    links
  }
  if (delta.networkMerge === true) {
    compact.networkMerge = true
    compact.mergeFromNetworkIds = normalizeNetworkMergeIds(delta.mergeFromNetworkIds || [])
    compact.mergedAt = Number(delta.mergedAt || compact.updatedAt) || compact.updatedAt
  }
  return compact.sourceDeviceId && compact.seq > 0 ? compact : null
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

function deltaBacklogSourceId(delta = {}) {
  return String(delta.sourceDeviceId || delta.originDeviceId || '').trim()
}

function trimTopologyDeltaBacklog(items = []) {
  const perSourceCounts = new Map()
  let kept = items
    .map(compactTopologyDeltaForBacklog)
    .filter(Boolean)
    .sort((a, b) => Number(b.seq || 0) - Number(a.seq || 0))
    .filter(delta => {
      const sourceId = deltaBacklogSourceId(delta)
      const count = perSourceCounts.get(sourceId) || 0
      if (count >= TOPOLOGY_DELTA_BACKLOG_PER_SOURCE_LIMIT) return false
      perSourceCounts.set(sourceId, count + 1)
      return true
    })
    .slice(0, TOPOLOGY_DELTA_BACKLOG_LIMIT)
    .reverse()

  while (kept.length > 1 && Buffer.byteLength(JSON.stringify(kept), 'utf8') > TOPOLOGY_DELTA_BACKLOG_MAX_BYTES) {
    kept = kept.slice(1)
  }
  return kept
}

function importTopologyDeltaBacklog(saved = []) {
  topologyDeltaBacklog = trimTopologyDeltaBacklog((Array.isArray(saved) ? saved : [])
    .map(unprotectTopologyDeltaSecrets)
    .filter(delta => delta && delta.type === 'topology_delta' && Number(delta.seq || 0) > 0))
}

function exportTopologyDeltaBacklog() {
  topologyDeltaBacklog = trimTopologyDeltaBacklog(topologyDeltaBacklog)
  return topologyDeltaBacklog
    .map(protectTopologyDeltaSecrets)
}

function buildTopologyDeltaBacklogState() {
  return {
    version: 1,
    topologyDeltaBacklog: exportTopologyDeltaBacklog(),
    updatedAt: Date.now()
  }
}

function normalizeTopologyDeltaBacklogState(raw, legacyBacklog = []) {
  if (Array.isArray(raw)) return raw
  if (raw && Array.isArray(raw.topologyDeltaBacklog)) return raw.topologyDeltaBacklog
  if (raw && Array.isArray(raw.deltas)) return raw.deltas
  return Array.isArray(legacyBacklog) ? legacyBacklog : []
}

function loadTopologyDeltaBacklogState(legacyBacklog = []) {
  const saved = readJsonSync(getTopologyDeltaBacklogPath(), null)
  return normalizeTopologyDeltaBacklogState(saved, legacyBacklog)
}

let topologyBacklogSaveTimer = null
let topologyBacklogSaveDirty = false
let topologyBacklogSaveInFlight = null

function saveTopologyDeltaBacklog() {
  if (topologyBacklogSaveTimer) return
  topologyBacklogSaveTimer = setTimeout(() => {
    topologyBacklogSaveTimer = null
    flushTopologyDeltaBacklogToDisk()
  }, 500)
  topologyBacklogSaveTimer.unref?.()
}

function flushPendingTopologyBacklogSave(options = {}) {
  if (topologyBacklogSaveTimer) {
    clearTimeout(topologyBacklogSaveTimer)
    topologyBacklogSaveTimer = null
  }
  return flushTopologyDeltaBacklogToDisk(options)
}

function flushTopologyDeltaBacklogToDisk(options = {}) {
  if (options.sync === true) {
    topologyBacklogSaveDirty = false
    try {
      writeJsonAtomicSync(getTopologyDeltaBacklogPath(), buildTopologyDeltaBacklogState())
    } catch (error) {
      console.error('Failed to save topology delta backlog:', error)
    }
    return Promise.resolve()
  }
  topologyBacklogSaveDirty = true
  if (!topologyBacklogSaveInFlight) {
    topologyBacklogSaveInFlight = drainTopologyBacklogSaveQueue()
      .finally(() => {
        topologyBacklogSaveInFlight = null
        if (topologyBacklogSaveDirty) flushTopologyDeltaBacklogToDisk()
      })
  }
  return topologyBacklogSaveInFlight
}

async function drainTopologyBacklogSaveQueue() {
  while (topologyBacklogSaveDirty) {
    topologyBacklogSaveDirty = false
    try {
      await writeJsonAtomic(getTopologyDeltaBacklogPath(), buildTopologyDeltaBacklogState())
    } catch (error) {
      console.error('Failed to save topology delta backlog:', error)
    }
  }
}

function rememberTopologyDelta(delta = {}, options = {}) {
  const identity = getDesktopIdentity()
  if (!delta || delta.type !== 'topology_delta') return
  const sourceDeviceId = String(delta.sourceDeviceId || delta.originDeviceId || '').trim()
  if (!sourceDeviceId) return
  if (options.requireLocalSource === true && sourceDeviceId !== identity.id) return
  const seq = Number(delta.seq || 0)
  if (!Number.isFinite(seq) || seq <= 0) return
  const compactDelta = compactTopologyDeltaForBacklog(delta)
  if (!compactDelta) return
  topologyDeltaBacklog = trimTopologyDeltaBacklog(topologyDeltaBacklog
    .filter(item => {
      const itemSourceId = deltaBacklogSourceId(item)
      return itemSourceId !== sourceDeviceId || Number(item.seq || 0) !== seq
    })
    .concat(compactDelta))
  saveTopologyDeltaBacklog()
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

function getTopologyDeltaBacklogPath() {
  return path.join(app.getPath('userData'), TOPOLOGY_DELTA_BACKLOG_FILE)
}

function getFileTransferHistoryPath() {
  return path.join(app.getPath('userData'), FILE_TRANSFER_HISTORY_FILE)
}

function getBusReliabilityPath() {
  return path.join(app.getPath('userData'), BUS_RELIABILITY_FILE)
}

function loadBusReliabilityState() {
  try {
    const filePath = getBusReliabilityPath()
    if (!fs.existsSync(filePath)) return {}
    return JSON.parse(fs.readFileSync(filePath, 'utf8'))
  } catch (error) {
    console.warn('Failed to load bus reliability state:', error.message)
    return {}
  }
}

function saveBusReliabilityState(state) {
  const filePath = getBusReliabilityPath()
  const tmpPath = `${filePath}.tmp`
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(tmpPath, JSON.stringify(state || {}, null, 2), 'utf8')
    fs.renameSync(tmpPath, filePath)
  } catch (error) {
    console.warn('Failed to save bus reliability state:', error.message)
  }
}

function getBusReliabilityStore() {
  if (!busReliabilityStore) {
    busReliabilityStore = createBusReliabilityStore({
      loadState: loadBusReliabilityState,
      saveState: saveBusReliabilityState
    })
  }
  return busReliabilityStore
}

function startBusOutboxFlushTimer() {
  if (busOutboxFlushTimer) return
  busOutboxFlushTimer = setInterval(() => {
    getContentBus().flushOutbox(25).catch(error => {
      console.warn('Bus outbox flush failed:', error.message)
    })
  }, 30 * 1000)
  busOutboxFlushTimer.unref?.()
}

function loadFileTransferHistory() {
  try {
    const filePath = getFileTransferHistoryPath()
    if (!fs.existsSync(filePath)) {
      fileTransferHistory = []
      return
    }
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'))
    fileTransferHistory = Array.isArray(parsed)
      ? parsed.map(normalizeFileTransferHistoryEntry).filter(Boolean).slice(0, FILE_TRANSFER_HISTORY_LIMIT)
      : []
  } catch (error) {
    console.warn('Failed to load file transfer history:', error.message)
    fileTransferHistory = []
  }
}

function saveFileTransferHistory() {
  try {
    const filePath = getFileTransferHistoryPath()
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(filePath, JSON.stringify(fileTransferHistory.slice(0, FILE_TRANSFER_HISTORY_LIMIT), null, 2))
  } catch (error) {
    console.warn('Failed to save file transfer history:', error.message)
  }
}

function normalizeFileTransferHistoryEntry(raw = {}) {
  const filePath = String(raw.path || raw.filePath || '').trim()
  const name = String(raw.name || path.basename(filePath) || '').trim()
  if (!filePath || !name) return null
  const receivedAt = Number(raw.receivedAt || raw.timestamp || Date.now()) || Date.now()
  return {
    id: String(raw.id || raw.fileId || `${receivedAt}-${crypto.createHash('sha1').update(filePath).digest('hex').slice(0, 12)}`),
    fileId: String(raw.fileId || ''),
    name,
    path: filePath,
    directory: String(raw.directory || path.dirname(filePath)),
    size: Number(raw.size || 0) || 0,
    mime: String(raw.mime || ''),
    sourceId: String(raw.sourceId || raw.sourceDeviceId || ''),
    sourceName: String(raw.sourceName || raw.sourceDeviceName || '未知设备'),
    sourceType: String(raw.sourceType || raw.sourceDeviceType || ''),
    receivedAt,
    exists: fs.existsSync(filePath)
  }
}

function recordFileTransferHistory(entry = {}) {
  const normalized = normalizeFileTransferHistoryEntry({
    ...entry,
    receivedAt: entry.receivedAt || Date.now()
  })
  if (!normalized) return null
  fileTransferHistory = [
    normalized,
    ...fileTransferHistory.filter(item =>
      item.fileId !== normalized.fileId &&
      item.path !== normalized.path &&
      item.id !== normalized.id
    )
  ].slice(0, FILE_TRANSFER_HISTORY_LIMIT)
  saveFileTransferHistory()
  return normalized
}

function getFileTransferHistory() {
  return fileTransferHistory
    .map(entry => normalizeFileTransferHistoryEntry(entry))
    .filter(Boolean)
    .slice(0, FILE_TRANSFER_HISTORY_LIMIT)
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

function mergeContentPolicyForDuplicateNode(nodeId, preferred = {}) {
  const records = [
    topologyLsdb.nodes.get(String(nodeId || '').trim()),
    authorizedPhones.get(String(nodeId || '').trim()),
    pairedDesktopPeers.get(String(nodeId || '').trim()),
    preferred
  ].filter(Boolean)
  const merged = normalizePushContentPolicy(preferred.contentPolicy || preferred || {})
  for (const record of records) {
    const policy = normalizePushContentPolicy(record.contentPolicy || record || {})
    if (policy.allowClipboardFile === true) merged.allowClipboardFile = true
    if (policy.allowFileTransfer === true) merged.allowFileTransfer = true
    if (policy.autoAcceptFiles === true) merged.autoAcceptFiles = true
    merged.maxFileSizeMb = Math.max(
      Number(merged.maxFileSizeMb || 50) || 50,
      Number(policy.maxFileSizeMb || 50) || 50
    )
  }
  return normalizePushContentPolicy(merged)
}

function mergeTrustedNodeRecord(nodeId, preferred = {}) {
  const id = String(nodeId || preferred.id || preferred.phoneId || '').trim()
  if (!id) return preferred
  const phone = authorizedPhones.get(id)
  const peer = pairedDesktopPeers.get(id)
  const lsdbNode = topologyLsdb.nodes.get(id)
  const records = [lsdbNode, phone, peer, preferred].filter(Boolean)
  const base = records.reduce((acc, record) => ({ ...acc, ...record }), {})
  const hosts = collectNetworkHosts(
    ...records.flatMap(record => [
      record.lastIP,
      record.host,
      record.relayHost,
      record.tsHost,
      record.altHosts
    ])
  )
  const primaryHost = normalizeNetworkHost(preferred.host || preferred.lastIP || base.host || base.lastIP || hosts[0] || '')
  const pairingKeyValue = preferred.pairingKey || peer?.pairingKey || phone?.pairingKey || lsdbNode?.pairingKey || ''
  return {
    ...base,
    ...preferred,
    id,
    phoneId: preferred.phoneId || base.phoneId || id,
    pairingKey: pairingKeyValue,
    contentPolicy: mergeContentPolicyForDuplicateNode(id, preferred),
    host: primaryHost || hosts[0] || '',
    lastIP: normalizeNetworkHost(preferred.lastIP || base.lastIP || primaryHost || hosts[0] || ''),
    relayHost: normalizeNetworkHost(preferred.relayHost || base.relayHost || ''),
    tsHost: normalizeNetworkHost(preferred.tsHost || base.tsHost || ''),
    altHosts: hosts.filter(host => host && host !== primaryHost),
    relayPort: Number(preferred.relayPort || base.relayPort || preferred.port || base.port) || JOIN_PORT
  }
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
  startBusOutboxFlushTimer()
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
    sendRelay: (target, envelope, route) => sendBusEnvelopeLegacyRelay(target, envelope, route),
    onReceive: (envelope, context) => dispatchInboundBusEnvelope(envelope, context.lastHopDeviceId || ''),
    log: message => console.log(message),
    reliabilityStore: getBusReliabilityStore(),
    routeHealth: routeHealthTracker
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
        const cleaned = { ...source }
        if (savedPolicyVersion < 2) {
          delete cleaned.allowClipboard
        }
        if (savedPolicyVersion < 3) {
          const clipboardAllowed = cleaned.allowClipboard !== false && cleaned.allowClipboardText !== false
          if (clipboardAllowed && cleaned.allowClipboardImage === false) delete cleaned.allowClipboardImage
          if (clipboardAllowed && cleaned.allowImages === false) delete cleaned.allowImages
        }
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
          lastSeen: Number(phone.lastSeen || 0) || 0,
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
          connectionUpdatedAt: Number(phone.connectionUpdatedAt || 0) || 0,
          connected: false
        }
      ]).filter(([id]) => !!id))
      pairedDesktopPeers = new Map((saved.desktopPeers || []).map(peer => [
        peer.id,
        {
          id: peer.id,
          name: peer.name || 'Desktop PC',
          deviceType: peer.deviceType || peer.type || 'WINDOWS_DESKTOP',
          host: trustedNode.primaryTrustedNodeHost(peer) || '',
          port: Number(peer.port) || WS_PORT,
          pairingKey: unprotectSecret(peer.pairingKey || peer.pk || ''),
          tsHost: String(peer.tsHost || '').trim(),
          altHosts: Array.isArray(peer.altHosts) ? peer.altHosts.map(normalizeNetworkHost).filter(Boolean) : [],
          enabled: peer.enabled !== false,
          firstSeen: peer.firstSeen || Date.now(),
          lastSeen: peer.lastSeen || 0,
          lastIP: normalizeNetworkHost(peer.lastIP || peer.host || peer.tsHost || '') || trustedNode.primaryTrustedNodeHost(peer) || '',
          networkId: String(peer.networkId || '').trim(),
          autoPaired: peer.autoPaired === true,
          trustSourceId: String(peer.trustSourceId || '').trim(),
          trustLevel: String(peer.trustLevel || '').trim(),
          acceptedAt: Number(peer.acceptedAt || 0) || 0,
          capabilities: peer.capabilities && typeof peer.capabilities === 'object' ? peer.capabilities : {},
          contentPolicy: normalizePushContentPolicy(upgradeContentPolicy(peer)),
          connectionUpdatedAt: Number(peer.connectionUpdatedAt || 0) || 0,
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
      const savedMessageSettings = { ...(saved.messageSettings || {}) }
      if (savedPolicyVersion < 4) {
        savedMessageSettings.syncClipboardImage = true
      }
      desktopMessageSettings = normalizeMessageSettings(savedMessageSettings)
      fileTransferDownloadDir = normalizeFileTransferDownloadDir(saved.fileTransferDownloadDir || '')
      clipboardSyncState = normalizeClipboardSyncState(saved.clipboardSyncState || {})
      clipboardImageSyncState = normalizeClipboardSyncState(saved.clipboardImageSyncState || {})
      clipboardGlobalSyncState = normalizeClipboardSyncState(
        saved.clipboardGlobalSyncState ||
        clipboardVersion.bestClipboardVersion(clipboardSyncState, clipboardImageSyncState)
      )
      trustedNetworkId = String(saved.networkId || saved.trustedNetworkId || '').trim()
      allowLanJoinRequests = saved.allowLanJoinRequests !== false
      localEventToken = unprotectSecret(saved.localEventToken || '') || ''
      importSavedTopologyLsdb(saved.topologyLsdb || {})
      importTopologyDeltaBacklog(loadTopologyDeltaBacklogState(saved.topologyDeltaBacklog || []))
      if (Array.isArray(saved.topologyDeltaBacklog) && saved.topologyDeltaBacklog.length > 0) {
        saveTopologyDeltaBacklog()
      }
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
let pairingSaveDirty = false
let pairingSaveInFlight = null

// 调用极频繁（每次设备上线、每条消息落库都会触发），防抖合并 500ms 内的写盘
function savePairingKey() {
  if (pairingSaveTimer) return
  pairingSaveTimer = setTimeout(() => {
    pairingSaveTimer = null
    flushPairingConfigToDisk()
  }, 500)
  pairingSaveTimer.unref?.()
}

function flushPendingPairingSave(options = {}) {
  if (pairingSaveTimer) {
    clearTimeout(pairingSaveTimer)
    pairingSaveTimer = null
  }
  const sync = options.sync === true || app.isQuitting === true
  flushPendingTopologyBacklogSave({ sync })
  return flushPairingConfigToDisk({ sync })
}

function flushPairingConfigToDisk(options = {}) {
  if (options.sync === true) {
    pairingSaveDirty = false
    try {
      writeJsonAtomicSync(getPairingConfigPath(), buildPairingConfigState())
    } catch (error) {
      console.error('Failed to save pairing config:', error)
    }
    return Promise.resolve()
  }
  pairingSaveDirty = true
  if (!pairingSaveInFlight) {
    pairingSaveInFlight = drainPairingConfigSaveQueue()
      .finally(() => {
        pairingSaveInFlight = null
        if (pairingSaveDirty) flushPairingConfigToDisk()
      })
  }
  return pairingSaveInFlight
}

async function drainPairingConfigSaveQueue() {
  while (pairingSaveDirty) {
    pairingSaveDirty = false
    try {
      await writeJsonAtomic(getPairingConfigPath(), buildPairingConfigState())
    } catch (error) {
      console.error('Failed to save pairing config:', error)
    }
  }
}

function buildPairingConfigState() {
  return {
    // 内容策略格式版本：v2 起 allowClipboard 默认 true（见 loadOrCreatePairingKey 迁移）
    policyVersion: 4,
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
          connectionUpdatedAt: phone.connectionUpdatedAt || 0,
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
          altHosts: Array.isArray(peer.altHosts) ? peer.altHosts : [],
          enabled: peer.enabled,
          firstSeen: peer.firstSeen,
          lastSeen: peer.lastSeen,
          lastIP: peer.lastIP,
          networkId: peer.networkId || '',
          autoPaired: peer.autoPaired === true,
          trustSourceId: peer.trustSourceId || '',
