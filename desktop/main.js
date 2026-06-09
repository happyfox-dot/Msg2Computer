const { app, BrowserWindow, Tray, Menu, Notification, clipboard, ipcMain, nativeImage, screen, safeStorage, shell } = require('electron')
const path = require('path')
const fs = require('fs')
const crypto = require('crypto')
const os = require('os')
const { WebSocketServer } = require('ws')
const QRCode = require('qrcode')

let mainWindow = null
let bubbleWindow = null
let bubbleTimer = null
let tray = null
let wss = null
let pairingKey = null
let pairingQRData = null
let authorizedPhones = new Map()
let activePhoneConnections = new Map()
let totpSeeds = new Map()

const WS_PORT = 19527
const CODE_TYPES = { SMS: 'sms', TOTP: 'totp' }
const PAIRING_CONFIG_FILE = 'pairing.json'
const gotSingleInstanceLock = app.requestSingleInstanceLock()
const ICON_PATH = path.join(__dirname, 'assets', 'icon.ico')
const START_HIDDEN = process.argv.includes('--hidden')

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
  const phoneName = escapeHtml(codeInfo.phoneName || '未知手机')

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
      padding: 14px 16px;
      color: #f7f9fc;
      background: rgba(23, 26, 33, 0.96);
      border: 1px solid rgba(255, 255, 255, 0.14);
      border-radius: 8px;
      box-shadow: 0 16px 42px rgba(0, 0, 0, 0.34);
      display: flex;
      align-items: center;
      gap: 12px;
      animation: enter 180ms ease-out;
    }
    .mark {
      width: 40px;
      height: 40px;
      flex: 0 0 auto;
      border-radius: 8px;
      background: #276ef1;
      display: flex;
      align-items: center;
      justify-content: center;
      color: #fff;
      font-size: 20px;
      font-weight: 700;
    }
    .content {
      min-width: 0;
      flex: 1;
    }
    .title {
      font-size: 13px;
      line-height: 18px;
      color: rgba(247, 249, 252, 0.78);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .code {
      margin-top: 2px;
      font-size: 30px;
      line-height: 36px;
      font-weight: 700;
      letter-spacing: 0;
      color: #ffffff;
      word-break: break-all;
    }
    .meta {
      margin-top: 4px;
      font-size: 12px;
      line-height: 16px;
      color: rgba(247, 249, 252, 0.64);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    @keyframes enter {
      from { opacity: 0; transform: translateY(10px); }
      to { opacity: 1; transform: translateY(0); }
    }
  </style>
</head>
<body>
  <div class="bubble">
    <div class="mark">码</div>
    <div class="content">
      <div class="title">新验证码，已复制到剪贴板</div>
      <div class="code">${code}</div>
      <div class="meta">${source} · ${phoneName}</div>
    </div>
  </div>
</body>
</html>`
}

function showCodeBubble(codeInfo) {
  if (!app.isReady()) return

  hideCodeBubble()

  const bubbleWidth = 320
  const bubbleHeight = 132
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

function generateSessionKey() {
  return crypto.randomBytes(32).toString('base64')
}

function getPairingConfigPath() {
  return path.join(app.getPath('userData'), PAIRING_CONFIG_FILE)
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
          enabled: phone.enabled !== false,
          revoked: phone.revoked === true,
          firstSeen: phone.firstSeen || Date.now(),
          lastSeen: phone.lastSeen || Date.now(),
          lastIP: phone.lastIP || '',
          connected: false
        }
      ]).filter(([id]) => !!id))
      totpSeeds = new Map((saved.totpSeeds || []).map(seed => {
        const normalized = normalizeTotpSeed({
          ...seed,
          secret: unprotectSecret(seed.secret)
        })
        return normalized ? [normalized.id, normalized] : null
      }).filter(Boolean))
      if (saved.pairingKey) {
        pairingKey = saved.pairingKey
        return
      }
    }
  } catch (e) {
    console.error('Failed to load pairing config:', e)
  }

  pairingKey = crypto.randomBytes(32).toString('base64')
  savePairingKey()
}

function savePairingKey() {
  const configPath = getPairingConfigPath()
  try {
    fs.mkdirSync(path.dirname(configPath), { recursive: true })
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        pairingKey,
        authorizedPhones: getAuthorizedPhones().map(phone => ({
          id: phone.id,
          name: phone.name,
          enabled: phone.enabled,
          revoked: phone.revoked,
          firstSeen: phone.firstSeen,
          lastSeen: phone.lastSeen,
          lastIP: phone.lastIP
        })),
        totpSeeds: getStoredTotpSeeds(),
        updatedAt: Date.now()
      }, null, 2),
      'utf8'
    )
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
  const pairingInfo = JSON.stringify({
    host: localIP,
    port: WS_PORT,
    pk: pairingKey,
    name: os.hostname()
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

function getAuthorizedPhones() {
  return Array.from(authorizedPhones.values())
    .sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0))
}

function notifyPhonesChanged() {
  if (mainWindow) {
    mainWindow.webContents.send('phones-changed', getAuthorizedPhones())
  }
}

function upsertAuthorizedPhone({ phoneId, phoneName, clientIP }) {
  const now = Date.now()
  const existing = authorizedPhones.get(phoneId)
  const phone = {
    id: phoneId,
    name: normalizePhoneName(phoneName, existing?.name),
    enabled: existing ? existing.enabled !== false : true,
    revoked: existing?.revoked === true,
    firstSeen: existing?.firstSeen || now,
    lastSeen: now,
    lastIP: clientIP || existing?.lastIP || '',
    connected: existing?.connected === true
  }
  authorizedPhones.set(phoneId, phone)
  savePairingKey()
  notifyPhonesChanged()
  return phone
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
// 撤销是单向拒绝（重连仍被 deny），只有用户在电脑端主动恢复才能再次授权，
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
    createdAt: seed.createdAt,
    updatedAt: seed.updatedAt,
    secret: protectSecret(seed.secret)
  }))
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

  return {
    id,
    label,
    issuer,
    accountName,
    secret,
    algorithm,
    digits,
    period,
    phoneId: seedData.phoneId || '',
    phoneName: seedData.phoneName || '未知手机',
    createdAt: seedData.createdAt || now,
    updatedAt: seedData.updatedAt || now
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

function upsertTotpSeed(seedData) {
  const normalized = normalizeTotpSeed(seedData)
  if (!normalized) return null

  const existing = totpSeeds.get(normalized.id)
  const seed = {
    ...normalized,
    createdAt: existing?.createdAt || normalized.createdAt,
    updatedAt: Date.now()
  }
  totpSeeds.set(seed.id, seed)
  savePairingKey()
  notifyTotpSeedsChanged()
  return seed
}

function notifyTotpSeedsChanged() {
  if (mainWindow) {
    mainWindow.webContents.send('desktop-totps-changed')
  }
}

function revokeTotpSeeds(revokeData) {
  const phoneId = String(revokeData.phoneId || '').trim()
  const seedIds = Array.isArray(revokeData.seedIds)
    ? new Set(revokeData.seedIds.map(id => String(id || '').trim()).filter(Boolean))
    : null
  if (!phoneId && (!seedIds || seedIds.size === 0)) return 0

  let removed = 0
  for (const [id, seed] of totpSeeds.entries()) {
    const matchedById = seedIds && seedIds.has(id)
    const matchedByPhone = !seedIds && phoneId && seed.phoneId === phoneId
    if (matchedById || matchedByPhone) {
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
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
    .map(seed => {
      const time = Math.floor(Date.now() / 1000)
      const remaining = seed.period - (time % seed.period)
      return {
        id: seed.id,
        label: seed.label,
        issuer: seed.issuer,
        accountName: seed.accountName,
        phoneId: seed.phoneId,
        phoneName: seed.phoneName,
        type: CODE_TYPES.TOTP,
        code: generateTotpCode(seed, time),
        timestamp: Date.now(),
        period: seed.period,
        remaining,
        progress: remaining / seed.period,
        digits: seed.digits,
        algorithm: seed.algorithm,
        updatedAt: seed.updatedAt
      }
    })
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

function startWebSocketServer() {
  wss = new WebSocketServer({ port: WS_PORT })

  wss.on('error', (error) => {
    console.error('WebSocket server error:', error)
    if (error.code === 'EADDRINUSE') {
      showNotification('验证码同步启动失败', `端口 ${WS_PORT} 已被占用，请确认是否已有一个桌面端正在运行。`)
      showMainWindow()
    }
  })

  wss.on('connection', (ws, req) => {
    const clientIP = req.socket.remoteAddress
    let isAuthenticated = false
    let connectionSessionKey = null
    let connectionPhoneId = null
    let connectionPhoneName = null

    ws.on('message', (data) => {
      try {
        const message = JSON.parse(data.toString())

        if (message.type === 'auth') {
          if (message.pairingKey === pairingKey) {
            const phoneId = normalizePhoneId(message.phoneId, clientIP)
            const phoneName = normalizePhoneName(message.phoneName, clientIP)
            const phone = upsertAuthorizedPhone({ phoneId, phoneName, clientIP })
            if (!phone.enabled || phone.revoked) {
              ws.send(JSON.stringify({ type: 'auth_denied', reason: 'phone_disabled' }))
              ws.close()
              return
            }
            isAuthenticated = true
            connectionPhoneId = phone.id
            connectionPhoneName = phone.name
            connectionSessionKey = generateSessionKey()
            addActivePhoneConnection(phone.id, ws)
            ws.send(JSON.stringify({ type: 'auth_ok', sessionKey: connectionSessionKey }))
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

        if (message.type === 'verify_code') {
          const decrypted = decryptMessage(message.payload, connectionSessionKey)
          if (decrypted) {
            const codeData = JSON.parse(decrypted)
            codeData.phoneId = connectionPhoneId
            codeData.phoneName = connectionPhoneName || codeData.phoneName
            if (codeData.type === 'totp_seed') {
              handleTotpSeed(codeData)
            } else if (codeData.type === 'totp_revoke') {
              handleTotpRevoke(codeData)
            } else {
              handleVerifyCode(codeData)
            }
            // 回 ACK：按需连接模型下手机收到 ACK 才安全断开，确保消息已落地
            ws.send(JSON.stringify({ type: 'code_ack', msgId: message.msgId || '' }))
          }
        }
      } catch (e) {
        console.error('消息处理错误:', e)
      }
    })

    ws.on('close', () => {
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

function handleVerifyCode(codeData) {
  const { code, source, type, timestamp, label, phoneId, phoneName, rawMessage, messageBody } = codeData

  const codeInfo = {
    code,
    source: source || '未知',
    type: type || CODE_TYPES.SMS,
    timestamp: timestamp || Date.now(),
    label: label || '',
    phoneId: phoneId || '',
    phoneName: phoneName || '未知手机',
    rawMessage: rawMessage || messageBody || ''
  }

  if (mainWindow) {
    mainWindow.webContents.send('new-code', codeInfo)
  }

  if (codeInfo.type === CODE_TYPES.SMS) {
    showCodeBubble(codeInfo)
    showNotification('📩 新验证码', `${codeInfo.code}\n来源: ${codeInfo.source}\n手机: ${codeInfo.phoneName}`)
  }

  clipboard.writeText(codeInfo.code)
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
  if (removed > 0) {
    showNotification('TOTP 显示权限已撤销', `已删除 ${removed} 个验证码\n来源: ${phoneName}`)
  } else {
    showNotification('TOTP 显示权限已撤销', `没有可删除的验证码\n来源: ${phoneName}`)
  }
}

function showNotification(title, body) {
  if (Notification.isSupported()) {
    new Notification({ title, body, urgency: 'critical' }).show()
  }
}

ipcMain.handle('get-pairing-info', async () => {
  if (!pairingKey) {
    loadOrCreatePairingKey()
  }
  const qrDataURL = await refreshPairingQR()
  return {
    host: getLocalIP(),
    port: WS_PORT,
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

ipcMain.handle('is-window-visible', () => {
  return mainWindow ? mainWindow.isVisible() : false
})

ipcMain.handle('set-phone-enabled', (event, phoneId, enabled) => {
  return setPhoneEnabled(phoneId, enabled)
})

ipcMain.handle('revoke-phone', (event, phoneId) => {
  return revokePhone(phoneId)
})

ipcMain.handle('restore-phone', (event, phoneId) => {
  return restorePhone(phoneId)
})

ipcMain.handle('open-external', async (event, url) => {
  await shell.openExternal(url)
})

if (!gotSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', (event, argv) => {
    if (!argv.includes('--hidden')) {
      showMainWindow()
    }
  })

  app.whenReady().then(async () => {
    const startHidden = shouldStartHidden()
    configureAutoLaunch()
    loadOrCreatePairingKey()
    createWindow({ hidden: startHidden })
    createTray()
    startWebSocketServer()
    await refreshPairingQR()

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
  if (wss) wss.close()
})
