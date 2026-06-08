const codes = []
let authorizedPhones = []
let totpIntervals = new Map()
let smsDisplayMode = localStorage.getItem('smsDisplayMode') === 'raw' ? 'raw' : 'code'
// 每条短信卡片各自的显示状态（'code' / 'raw'）；未设置的卡片跟随 smsDisplayMode 全局默认
const cardDisplayModes = new Map()
let windowVisible = true

document.addEventListener('DOMContentLoaded', async () => {
  setupTitlebar()
  setupPhoneList()
  setupSmsDisplayMode()
  await loadPairingQR()

  window.electronAPI.onNewCode((codeInfo) => {
    addCode(codeInfo)
  })

  window.electronAPI.onPairingQR((qrDataURL) => {
    document.getElementById('qr-image').src = qrDataURL
  })

  window.electronAPI.onPhonesChanged((phones) => {
    authorizedPhones = Array.isArray(phones) ? phones : []
    renderPhones()
    updateConnectionStatusFromPhones()
  })

  window.electronAPI.onCopyFeedback(() => {
    showCopyFeedback()
  })

  window.electronAPI.onDeviceDisconnected(async () => {
    await refreshAuthorizedPhones()
  })

  window.electronAPI.onWindowVisibility((visible) => {
    windowVisible = visible
    if (visible) {
      // 重新显示：重建 TOTP 倒计时定时器并立即刷新一次
      updateTotpDisplay()
    } else {
      // 隐藏到托盘：清掉所有每秒重绘的 SVG 定时器，避免后台空转耗电
      pauseTotpIntervals()
    }
  })

  document.getElementById('btn-refresh-qr').addEventListener('click', async () => {
    await window.electronAPI.regeneratePairing()
    await loadPairingQR()
  })
})

function setupTitlebar() {
  document.getElementById('btn-min').addEventListener('click', () => {
    window.electronAPI.minimizeWindow()
  })
  document.getElementById('btn-close').addEventListener('click', () => {
    window.electronAPI.hideWindow()
  })
}

function setupPhoneList() {
  const container = document.getElementById('phones-list')

  container.addEventListener('change', async (event) => {
    const target = event.target
    if (!target.matches('[data-action="toggle-phone"]')) return

    const row = target.closest('.phone-row')
    if (!row) return

    target.disabled = true
    try {
      const phones = await window.electronAPI.setPhoneEnabled(row.dataset.phoneId, target.checked)
      authorizedPhones = Array.isArray(phones) ? phones : []
      renderPhones()
      updateConnectionStatusFromPhones()
    } catch (error) {
      console.error('Failed to change phone state:', error)
      target.checked = !target.checked
    } finally {
      target.disabled = false
    }
  })

  container.addEventListener('click', async (event) => {
    const revokeButton = event.target.closest('[data-action="revoke-phone"]')
    if (!revokeButton) return

    const row = revokeButton.closest('.phone-row')
    if (!row) return

    const phone = authorizedPhones.find(item => item.id === row.dataset.phoneId)
    const phoneName = phone?.name || '这台手机'
    if (!window.confirm(`撤销 ${phoneName} 的授权？`)) return

    revokeButton.disabled = true
    try {
      const phones = await window.electronAPI.revokePhone(row.dataset.phoneId)
      authorizedPhones = Array.isArray(phones) ? phones : []
      renderPhones()
      updateConnectionStatusFromPhones()
    } catch (error) {
      console.error('Failed to revoke phone:', error)
      revokeButton.disabled = false
    }
  })

  container.addEventListener('click', async (event) => {
    const restoreButton = event.target.closest('[data-action="restore-phone"]')
    if (!restoreButton) return

    const row = restoreButton.closest('.phone-row')
    if (!row) return

    restoreButton.disabled = true
    try {
      const phones = await window.electronAPI.restorePhone(row.dataset.phoneId)
      authorizedPhones = Array.isArray(phones) ? phones : []
      renderPhones()
      updateConnectionStatusFromPhones()
    } catch (error) {
      console.error('Failed to restore phone:', error)
      restoreButton.disabled = false
    }
  })
}

function setupSmsDisplayMode() {
  const codeButton = document.getElementById('btn-display-code')
  const rawButton = document.getElementById('btn-display-raw')
  if (!codeButton || !rawButton) return

  const updateButtons = () => {
    codeButton.classList.toggle('active', smsDisplayMode === 'code')
    rawButton.classList.toggle('active', smsDisplayMode === 'raw')
  }

  codeButton.addEventListener('click', () => {
    smsDisplayMode = 'code'
    localStorage.setItem('smsDisplayMode', smsDisplayMode)
    cardDisplayModes.clear()
    updateButtons()
    renderCodes()
  })

  rawButton.addEventListener('click', () => {
    smsDisplayMode = 'raw'
    localStorage.setItem('smsDisplayMode', smsDisplayMode)
    cardDisplayModes.clear()
    updateButtons()
    renderCodes()
  })

  updateButtons()
}

async function loadPairingQR() {
  const info = await window.electronAPI.getPairingInfo()
  updatePairingAddress(info)
  authorizedPhones = Array.isArray(info.authorizedPhones) ? info.authorizedPhones : []
  renderPhones()
  updateConnectionStatusFromPhones()
}

async function refreshAuthorizedPhones() {
  const phones = await window.electronAPI.getAuthorizedPhones()
  authorizedPhones = Array.isArray(phones) ? phones : []
  renderPhones()
  updateConnectionStatusFromPhones()
}

function addCode(codeInfo) {
  const now = Date.now()
  const normalized = {
    ...codeInfo,
    phoneId: codeInfo.phoneId || '',
    phoneName: codeInfo.phoneName || '未知手机',
    timestamp: codeInfo.timestamp || now
  }
  const duplicate = codes.find(c =>
    c.code === normalized.code &&
    c.type === normalized.type &&
    getCodePhoneKey(c) === getCodePhoneKey(normalized) &&
    (now - c.timestamp) < 30000
  )
  if (duplicate) return

  normalized.id = `code-${now}-${Math.random().toString(36).substr(2, 6)}`
  codes.unshift(normalized)

  if (codes.length > 50) codes.length = 50

  if (normalized.type === 'totp') {
    updateTotpDisplay()
  } else {
    renderCodes()
  }

  if (authorizedPhones.length > 0) {
    updateConnectionStatusFromPhones()
  } else {
    updateConnectionStatus(true, 1)
  }
}

function renderPhones() {
  const container = document.getElementById('phones-list')
  const countEl = document.getElementById('phones-count')

  countEl.textContent = authorizedPhones.length ? `(${authorizedPhones.length})` : ''

  if (authorizedPhones.length === 0) {
    container.innerHTML = '<div class="empty-state">暂无已授权手机</div>'
    return
  }

  container.innerHTML = authorizedPhones.map(phone => {
    const state = getPhoneState(phone)
    const checked = phone.enabled !== false && phone.revoked !== true
    const meta = [
      phone.lastSeen ? `上次 ${formatTime(phone.lastSeen)}` : '',
      phone.lastIP || ''
    ].filter(Boolean).join(' · ')

    // 已撤销的手机：开关不可用，右侧操作改为「恢复」（解除撤销，重新授权）；
    // 未撤销的手机：正常的启用/禁用开关 + 「撤销」。
    const actionButton = phone.revoked
      ? `<button class="phone-restore" data-action="restore-phone" title="恢复授权">恢复</button>`
      : `<button class="phone-revoke" data-action="revoke-phone" title="撤销授权">撤销</button>`

    return `
      <div class="phone-row ${state.className}" data-phone-id="${escapeHtml(phone.id)}">
        <div class="phone-main">
          <div class="phone-header">
            <span class="phone-name">${escapeHtml(phone.name || 'Android Phone')}</span>
            <span class="phone-status">${state.label}</span>
          </div>
          <div class="phone-meta">${escapeHtml(meta || '等待连接')}</div>
        </div>
        <label class="phone-toggle" title="启用或禁用这台手机">
          <input type="checkbox" data-action="toggle-phone" ${checked ? 'checked' : ''} ${phone.revoked ? 'disabled' : ''}>
          <span></span>
        </label>
        ${actionButton}
      </div>
    `
  }).join('')
}

function renderCodes() {
  const smsCodes = codes.filter(c => c.type !== 'totp')
  const container = document.getElementById('codes-list')

  if (smsCodes.length === 0) {
    container.innerHTML = '<div class="empty-state">等待接收验证码...</div>'
    return
  }

  container.innerHTML = smsCodes.map(c => {
    const time = new Date(c.timestamp)
    const timeStr = `${time.getHours().toString().padStart(2,'0')}:${time.getMinutes().toString().padStart(2,'0')}:${time.getSeconds().toString().padStart(2,'0')}`
    const rawMessage = getRawMessage(c)
    const hasRaw = Boolean(rawMessage)
    // 每条卡片独立的显示状态：优先用本条已切换过的状态，否则跟随顶部全局默认。
    // 没有原文的短信无法切换，强制显示验证码。
    const itemMode = (hasRaw && (cardDisplayModes.get(c.id) || smsDisplayMode) === 'raw') ? 'raw' : 'code'
    const showRaw = itemMode === 'raw'
    const primaryContent = showRaw ? rawMessage : c.code
    const primaryClass = showRaw ? 'code-raw-message' : 'code-value'
    const codeMeta = showRaw
      ? `<div class="code-extracted">验证码: ${escapeHtml(c.code)}</div>`
      : ''
    const toggleHint = hasRaw
      ? `<button class="toggle-raw-btn" data-action="toggle-raw" title="切换显示原文/验证码">${showRaw ? '验证码' : '原文'}</button>`
      : ''

    return `
      <div class="code-item ${Date.now() - c.timestamp < 3000 ? 'new-code' : ''}" data-id="${c.id}">
        <div class="code-main">
          <div class="${primaryClass}" data-copy-value="${escapeHtml(c.code)}">${escapeHtml(primaryContent)}</div>
          ${codeMeta}
          <div class="code-source">${escapeHtml(c.source || '未知来源')}</div>
          <div class="code-phone">来自: ${escapeHtml(c.phoneName || '未知手机')}</div>
        </div>
        <div class="code-side">
          <div class="code-time">${timeStr}</div>
          <div class="code-actions">
            ${toggleHint}
            <button class="copy-code-btn">📋 复制</button>
          </div>
        </div>
      </div>
    `
  }).join('')

  container.querySelectorAll('.copy-code-btn').forEach(button => {
    button.addEventListener('click', function(e) {
      e.stopPropagation()
      const codeEl = this.closest('.code-item')?.querySelector('[data-copy-value]')
      if (codeEl) {
        window.electronAPI.copyToClipboard(codeEl.dataset.copyValue || codeEl.textContent)
      }
    })
  })

  container.querySelectorAll('[data-action="toggle-raw"]').forEach(button => {
    button.addEventListener('click', function(e) {
      e.stopPropagation()
      toggleCardDisplayMode(this.closest('.code-item')?.dataset.id)
    })
  })

  // 点击卡片正文：在该条的「验证码 / 原文」之间切换；无原文则回退为复制验证码。
  container.querySelectorAll('.code-item').forEach(item => {
    item.addEventListener('click', function(e) {
      if (e.target.closest('button')) return
      // 原文区域允许自由选中复制文本，不触发整卡切换
      if (e.target.closest('.code-raw-message') && window.getSelection()?.toString()) return
      const id = this.dataset.id
      const codeData = codes.find(c => c.id === id)
      if (codeData && getRawMessage(codeData)) {
        toggleCardDisplayMode(id)
      } else {
        const codeEl = this.querySelector('[data-copy-value]')
        if (codeEl) {
          window.electronAPI.copyToClipboard(codeEl.dataset.copyValue || codeEl.textContent)
        }
      }
    })
  })
}

function toggleCardDisplayMode(id) {
  if (!id) return
  const current = cardDisplayModes.get(id) || smsDisplayMode
  cardDisplayModes.set(id, current === 'raw' ? 'code' : 'raw')
  renderCodes()
}

function pauseTotpIntervals() {
  // 隐藏到托盘时调用：清掉所有每秒重绘的 SVG 倒计时定时器。
  // DOM 内容保留，重新显示时 updateTotpDisplay() 会重建定时器。
  for (const interval of totpIntervals.values()) {
    clearInterval(interval)
  }
  totpIntervals.clear()
}

function updateTotpDisplay() {
  const totpCodes = codes.filter(c => c.type === 'totp')
  const container = document.getElementById('totp-list')

  for (const interval of totpIntervals.values()) {
    clearInterval(interval)
  }
  totpIntervals.clear()

  if (totpCodes.length === 0) {
    container.innerHTML = '<div class="empty-state">暂无 TOTP 验证码</div>'
    return
  }

  const latestTotps = new Map()
  totpCodes.forEach(c => {
    const key = getTotpKey(c)
    if (!latestTotps.has(key) || c.timestamp > latestTotps.get(key).timestamp) {
      latestTotps.set(key, c)
    }
  })

  const period = (TOTP.PERIOD || 30) * 1000
  container.innerHTML = Array.from(latestTotps.entries()).map(([key, c]) => {
    const progress = TOTP.getPeriodProgress()
    const circumference = 2 * Math.PI * 16
    const offset = circumference * (1 - progress)
    const remaining = TOTP.getRemainingSeconds()
    const id = `totp-${hashString(key)}`
    // 按需模型：电脑端只持有手机推来的码快照，无法本地重算。
    // 若推送时间已不在当前 30s 周期内，该码必然已过期，给出明确提示。
    const expired = !c.timestamp || (Date.now() - c.timestamp) > period
    return `
      <div class="totp-item ${expired ? 'totp-expired' : ''}" data-id="${id}">
        <div class="totp-progress">
          <svg width="40" height="40" viewBox="0 0 40 40">
            <circle class="bg" cx="20" cy="20" r="16"></circle>
            <circle class="fg" cx="20" cy="20" r="16"
              stroke-dasharray="${circumference}" stroke-dashoffset="${offset}"></circle>
            <text class="remaining" x="20" y="20" dy=".35em">${remaining}s</text>
          </svg>
        </div>
        <div class="totp-main">
          <div class="totp-label">${escapeHtml(c.label || 'TOTP')}</div>
          <div class="code-phone">来自: ${escapeHtml(c.phoneName || '未知手机')}</div>
        </div>
        <div class="totp-code" data-copy-value="${escapeHtml(c.code)}">${escapeHtml(c.code)}${expired ? '<span class="totp-stale">已过期</span>' : ''}</div>
      </div>
    `
  }).join('')

  container.querySelectorAll('.totp-item').forEach(item => {
    item.addEventListener('click', function() {
      const codeEl = this.querySelector('.totp-code')
      if (codeEl) {
        window.electronAPI.copyToClipboard(codeEl.dataset.copyValue || codeEl.textContent)
      }
    })
  })

  latestTotps.forEach((c, key) => {
    const id = `totp-${hashString(key)}`
    setupTotpProgressUpdate(id)
  })
}

function setupTotpProgressUpdate(id) {
  // 窗口隐藏到托盘时不创建每秒重绘的定时器，重新显示时由 updateTotpDisplay 重建
  if (!windowVisible) return
  const interval = setInterval(() => {
    const progress = TOTP.getPeriodProgress()
    const remaining = TOTP.getRemainingSeconds()
    const item = document.querySelector(`.totp-item[data-id="${id}"]`)
    if (!item) {
      clearInterval(interval)
      totpIntervals.delete(id)
      return
    }
    const circle = item.querySelector('.fg')
    const text = item.querySelector('.remaining')
    if (circle) {
      const circumference = 2 * Math.PI * 16
      circle.setAttribute('stroke-dashoffset', circumference * (1 - progress))
      circle.style.stroke = remaining <= 5 ? '#e06060' : '#5cdb8b'
    }
    if (text) {
      text.textContent = `${remaining}s`
    }
  }, 1000)
  totpIntervals.set(id, interval)
}

function updateConnectionStatusFromPhones() {
  const connectedCount = authorizedPhones.filter(phone =>
    phone.connected === true &&
    phone.enabled !== false &&
    phone.revoked !== true
  ).length
  updateConnectionStatus(connectedCount > 0, connectedCount)
}

function updateConnectionStatus(connected, count = 0) {
  const statusEl = document.getElementById('connection-status')
  if (connected) {
    statusEl.className = 'status-connected'
    statusEl.textContent = count > 1 ? `● 已连接 ${count} 台手机` : '● 已连接'
  } else {
    statusEl.className = 'status-disconnected'
    statusEl.textContent = '● 未连接'
  }
}

function updatePairingAddress(info) {
  const addressEl = document.getElementById('pairing-address')
  if (!addressEl) return
  if (!info?.host || !info?.port) {
    addressEl.textContent = ''
    return
  }
  addressEl.textContent = `二维码地址: ws://${info.host}:${info.port}`
}

function getPhoneState(phone) {
  if (phone.revoked) return { label: '已撤销', className: 'phone-revoked' }
  if (phone.enabled === false) return { label: '已禁用', className: 'phone-disabled' }
  if (phone.connected) return { label: '在线', className: 'phone-connected' }
  return { label: '离线', className: 'phone-offline' }
}

function getCodePhoneKey(codeInfo) {
  return codeInfo.phoneId || codeInfo.phoneName || 'unknown-phone'
}

function getRawMessage(codeInfo) {
  return codeInfo.rawMessage || codeInfo.messageBody || codeInfo.body || ''
}

function getTotpKey(codeInfo) {
  return `${getCodePhoneKey(codeInfo)}:${codeInfo.label || 'TOTP'}`
}

function formatTime(timestamp) {
  const time = new Date(timestamp)
  const now = Date.now()
  if (now - timestamp < 60000) return '刚刚'
  return `${time.getHours().toString().padStart(2,'0')}:${time.getMinutes().toString().padStart(2,'0')}`
}

function hashString(text) {
  let hash = 0
  for (let i = 0; i < text.length; i += 1) {
    hash = ((hash * 31) + text.charCodeAt(i)) >>> 0
  }
  return hash.toString(36)
}

function copyCode(code, event) {
  if (event) event.stopPropagation()
  window.electronAPI.copyToClipboard(code)
}

function showCopyFeedback() {
  const existing = document.querySelector('.copy-feedback')
  if (existing) existing.remove()

  const feedback = document.createElement('div')
  feedback.className = 'copy-feedback'
  feedback.textContent = '✅ 已复制!'
  document.body.appendChild(feedback)
  setTimeout(() => feedback.remove(), 1000)
}

function escapeHtml(text) {
  if (!text) return ''
  const div = document.createElement('div')
  div.textContent = text
  return div.innerHTML
}

window.copyCode = copyCode
