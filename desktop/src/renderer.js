const codes = []
let authorizedPhones = []
let desktopTotps = []
let totpIntervals = new Map()
let smsDisplayMode = localStorage.getItem('smsDisplayMode') === 'raw' ? 'raw' : 'code'
// 每条短信卡片各自的显示状态（'code' / 'raw'）；未设置的卡片跟随 smsDisplayMode 全局默认
const cardDisplayModes = new Map()
let windowVisible = false
let desktopTotpsDirty = false
let topologySnapshot = null
let selectedTopologyNodeId = ''
let lastPairingInfo = null
let lanDevices = []
let fileTransferTargets = []
let fileTransferHistory = []
let messageSettings = {
  receiveSmsCodes: true,
  receiveAllSms: true,
  receiveNotifications: true,
  // 剪贴板同步默认关闭，需用户显式开启
  syncClipboard: false,
  syncClipboardText: false,
  syncClipboardImage: false,
  syncClipboardFile: false,
  receiveFileTransfer: false
}

document.addEventListener('DOMContentLoaded', async () => {
  setupTitlebar()
  setupTabs()
  setupPhoneList()
  setupSmsDisplayMode()
  setupTopology()
  setupLanDiscovery()
  setupSettings()
  setupQRCodeFeatures() // 新增：二维码功能

  window.electronAPI.onNewCode((codeInfo) => {
    addCode(codeInfo)
    renderTopology()
  })

  window.electronAPI.onPairingQR((qrDataURL) => {
    setPairingQr(qrDataURL)
  })

  window.electronAPI.onPhonesChanged((phones) => {
    authorizedPhones = Array.isArray(phones) ? phones : []
    renderPhones()
    updateConnectionStatusFromPhones()
    refreshTopology()
  })

  window.electronAPI.onCopyFeedback(() => {
    showCopyFeedback()
  })

  window.electronAPI.onDeviceDisconnected(async () => {
    await refreshAuthorizedPhones()
    await refreshTopology()
  })

  window.electronAPI.onWindowVisibility(async (visible) => {
    windowVisible = visible
    if (visible) {
      await refreshDesktopTotps()
    } else {
      // 隐藏到托盘：清掉所有每秒重绘的 SVG 定时器，避免后台空转耗电
      pauseTotpIntervals()
    }
  })

  window.electronAPI.onDesktopTotpsChanged(async () => {
    desktopTotpsDirty = true
    if (windowVisible) {
      await refreshDesktopTotps()
    }
    await refreshTopology()
  })

  window.electronAPI.onDesktopPeersChanged?.(async () => {
    await refreshTopology()
  })

  window.electronAPI.onLanDevicesChanged?.((devices) => {
    lanDevices = Array.isArray(devices) ? devices : []
    renderLanDevices()
  })

  window.electronAPI.onLanJoinRequest?.((request) => {
    showLanJoinRequestModal(request)
  })

  document.getElementById('btn-refresh-qr').addEventListener('click', async () => {
    await window.electronAPI.regeneratePairing()
    await loadPairingQR()
  })

  document.getElementById('btn-copy-address')?.addEventListener('click', function () {
    if (!lastPairingInfo?.host) return
    const lines = [`ws://${lastPairingInfo.host}:${lastPairingInfo.port}`]
    if (lastPairingInfo.tsHost) lines.push(`ws://${lastPairingInfo.tsHost}:${lastPairingInfo.port}`)
    window.electronAPI.copyToClipboard(lines.join('\n'))
    const original = this.textContent
    this.textContent = '✅ 已复制'
    setTimeout(() => { this.textContent = original }, 1500)
  })

  windowVisible = await window.electronAPI.isWindowVisible()
  await loadPairingQR()
  if (windowVisible) {
    await refreshDesktopTotps()
  } else {
    updateTotpDisplay()
  }
  await refreshTopology()
})

function setupTitlebar() {
  document.getElementById('btn-min').addEventListener('click', () => {
    window.electronAPI.minimizeWindow()
  })
  document.getElementById('btn-close').addEventListener('click', () => {
    window.electronAPI.hideWindow()
  })
}

function setupTabs() {
  const tabsNav = document.getElementById('tabs-nav')
  const tabButtons = document.querySelectorAll('.tab-btn')
  const tabPanels = document.querySelectorAll('.tab-panel')
  setupTabDragScroll(tabsNav)

  tabButtons.forEach(button => {
    button.addEventListener('click', () => {
      if (tabsNav?.dataset.suppressClick === 'true') return
      const targetTab = button.dataset.tab

      // 更新按钮状态
      tabButtons.forEach(btn => btn.classList.remove('active'))
      tabButtons.forEach(btn => btn.classList.remove('active'))
      button.classList.add('active')
      button.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' })

      // 更新面板显示
      tabPanels.forEach(panel => {
        if (panel.dataset.panel === targetTab) {
          panel.classList.add('active')
        } else {
          panel.classList.remove('active')
        }
      })

      if (targetTab === 'topology') {
        refreshTopology()
      }
      setTopologyAutoRefresh(targetTab === 'topology')
      // 拓扑页可见时每 10s 自动刷新（设备上线/下线/路由变化无需手点刷新），
      // 离开该页即停，避免后台白耗
      setTopologyAutoRefresh(targetTab === 'topology')
    })
  })
}

function setupTabDragScroll(nav) {
  if (!nav) return
  let isDragging = false
  let dragStartX = 0
  let dragStartScrollLeft = 0
  let moved = false

  const refreshScrollableState = () => {
    nav.classList.toggle('is-scrollable', nav.scrollWidth > nav.clientWidth + 1)
  }

  nav.addEventListener('click', (event) => {
    if (nav.dataset.suppressClick === 'true') {
      event.preventDefault()
      event.stopPropagation()
    }
  }, true)

  nav.addEventListener('wheel', (event) => {
    if (nav.scrollWidth <= nav.clientWidth) return
    const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY
    nav.scrollLeft += delta
    event.preventDefault()
  }, { passive: false })

  nav.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || nav.scrollWidth <= nav.clientWidth) return
    isDragging = true
    moved = false
    dragStartX = event.clientX
    dragStartScrollLeft = nav.scrollLeft
  })

  nav.addEventListener('pointermove', (event) => {
    if (!isDragging) return
    const distance = event.clientX - dragStartX
    if (!moved && Math.abs(distance) <= 4) return
    if (!moved) {
      moved = true
      nav.classList.add('dragging')
      nav.setPointerCapture?.(event.pointerId)
    }
    nav.scrollLeft = dragStartScrollLeft - distance
    event.preventDefault()
  })

  const finishDrag = (event) => {
    if (!isDragging) return
    isDragging = false
    nav.classList.remove('dragging')
    try {
      nav.releasePointerCapture?.(event.pointerId)
    } catch (_) {}
    if (moved) {
      nav.dataset.suppressClick = 'true'
      setTimeout(() => {
        delete nav.dataset.suppressClick
      }, 80)
    }
  }

  nav.addEventListener('pointerup', finishDrag)
  nav.addEventListener('pointercancel', finishDrag)
  nav.addEventListener('mouseleave', finishDrag)
  window.addEventListener('resize', refreshScrollableState)
  requestAnimationFrame(refreshScrollableState)
}

let topologyAutoRefreshTimer = null

function setTopologyAutoRefresh(enabled) {
  if (topologyAutoRefreshTimer) {
    clearInterval(topologyAutoRefreshTimer)
    topologyAutoRefreshTimer = null
  }
  if (!enabled) return
  topologyAutoRefreshTimer = setInterval(() => {
    if (document.hidden) return
    refreshTopology()
  }, 10000)
}

function setupSettings() {
  const githubLink = document.getElementById('link-github')
  if (githubLink) {
    githubLink.addEventListener('click', (e) => {
      e.preventDefault()
      window.electronAPI.openExternal?.('https://github.com/happyfox-dot/Msg2Computer')
    })
  }
  // 版本号动态取自主进程 app.getVersion()，避免 HTML 里硬编码导致与实际打包版本漂移
  const versionEl = document.getElementById('app-version')
  if (versionEl && window.electronAPI.getAppVersion) {
    window.electronAPI.getAppVersion()
      .then((v) => { if (v) versionEl.textContent = `v${v}` })
      .catch(() => {})
  }
  setupMessageSettings()
  setupFileTransferControls()
  setupLanJoinSettings()
  setupUpdateControl()
  updateSettingsStats()
}

// 更新状态文案映射：把主进程 updater 的 status 翻译成用户可读的提示
function describeUpdateState(state) {
  if (!state) return ''
  switch (state.status) {
    case 'checking':
      return '正在检查更新…'
    case 'available':
      return `发现新版本 ${state.version || ''}，正在下载…`
    case 'downloading':
      return `正在下载更新… ${state.percent || 0}%`
    case 'downloaded':
      return `新版本 ${state.version || ''} 已就绪`
    case 'not-available':
      return '当前已是最新版本'
    case 'error':
      return '检查更新失败，请稍后重试'
    default:
      return ''
  }
}

function setupUpdateControl() {
  const btn = document.getElementById('btn-check-update')
  const statusText = document.getElementById('update-status-text')
  if (!btn || !window.electronAPI.checkForUpdate) return

  // 检查失败时给一个「前往 GitHub 手动下载」兜底链接，避免用户卡在无去向的失败提示里。
  // 链接按需创建一次，之后随状态显隐。
  let fallbackLink = null
  const ensureFallbackLink = () => {
    if (fallbackLink) return fallbackLink
    fallbackLink = document.createElement('a')
    fallbackLink.href = '#'
    fallbackLink.className = 'settings-link update-fallback-link'
    fallbackLink.textContent = '手动下载'
    fallbackLink.addEventListener('click', (e) => {
      e.preventDefault()
      window.electronAPI.openExternal?.('https://github.com/happyfox-dot/Msg2Computer/releases/latest')
    })
    btn.parentElement?.appendChild(fallbackLink)
    return fallbackLink
  }

  const applyState = (state) => {
    if (statusText) statusText.textContent = describeUpdateState(state)
    // 检查/下载进行中禁用按钮，避免重复触发
    const busy = state && (state.status === 'checking' || state.status === 'downloading')
    btn.disabled = !!busy
    // 仅在出错时显示手动下载兜底
    const link = (state && state.status === 'error') ? ensureFallbackLink() : fallbackLink
    if (link) link.style.display = (state && state.status === 'error') ? 'inline' : 'none'
  }

  // 订阅主进程推送的实时更新状态（下载进度、下载完成等）
  window.electronAPI.onUpdateStatus?.((state) => applyState(state))

  // 进入设置页时同步一次当前状态（可能开机静默检查已经跑过了）
  window.electronAPI.getUpdateState?.().then(applyState).catch(() => {})

  btn.addEventListener('click', async () => {
    applyState({ status: 'checking' })
    try {
      await window.electronAPI.checkForUpdate()
    } catch (error) {
      console.error('检查更新失败:', error)
      applyState({ status: 'error' })
    }
  })
}

async function setupMessageSettings() {
  const fields = {
    receiveSmsCodes: document.getElementById('chk-receive-sms-codes'),
    receiveAllSms: document.getElementById('chk-receive-all-sms'),
    receiveNotifications: document.getElementById('chk-receive-notifications'),
    syncClipboardText: document.getElementById('chk-sync-clipboard-text'),
    syncClipboardImage: document.getElementById('chk-sync-clipboard-image'),
    syncClipboardFile: document.getElementById('chk-sync-clipboard-file')
  }
  if (!fields.receiveSmsCodes || !window.electronAPI.getMessageSettings) return

  const applyToUi = () => {
    Object.entries(fields).forEach(([key, element]) => {
      if (!element) return
      if (key.startsWith('syncClipboard')) {
        element.checked = key === 'syncClipboardFile'
          ? (messageSettings.syncClipboardFile === true || messageSettings.receiveFileTransfer === true)
          : messageSettings[key] === true
      } else {
        element.checked = messageSettings[key] !== false
      }
    })
  }

  try {
    messageSettings = await window.electronAPI.getMessageSettings()
    applyToUi()
  } catch (error) {
    console.error('Failed to load message settings:', error)
  }

  Object.entries(fields).forEach(([key, element]) => {
    if (!element) return
    element.addEventListener('change', async () => {
      const nextSettings = {
        ...messageSettings,
        [key]: element.checked,
        syncClipboard: key === 'syncClipboardText' ? element.checked : messageSettings.syncClipboard,
        receiveFileTransfer: key === 'syncClipboardFile' ? element.checked : messageSettings.receiveFileTransfer
      }
      try {
        messageSettings = await window.electronAPI.setMessageSettings(nextSettings)
        applyToUi()
      } catch (error) {
        console.error('Failed to save message settings:', error)
        element.checked = messageSettings[key] !== false
      }
    })
  })
}

function setupFileTransferControls() {
  const button = document.getElementById('btn-send-file')
  const folderButton = document.getElementById('btn-send-folder')
  const refreshTargetsButton = document.getElementById('btn-refresh-file-targets')
  const refreshHistoryButton = document.getElementById('btn-refresh-file-history')
  const status = document.getElementById('file-transfer-status')
  const transferList = document.getElementById('file-transfer-list')
  const targetList = document.getElementById('file-target-list')
  const historyList = document.getElementById('file-history-list')
  if (!button || !window.electronAPI.selectAndSendFile) return

  const setStatus = (text) => {
    if (status) status.textContent = text || ''
  }

  const formatBytes = (bytes) => {
    const value = Number(bytes || 0)
    if (!Number.isFinite(value) || value <= 0) return ''
    if (value < 1024) return `${value} B`
    if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
    if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`
    return `${(value / 1024 / 1024 / 1024).toFixed(1)} GB`
  }

  const getSelectedTargetIds = () => {
    if (!targetList) return []
    return Array.from(targetList.querySelectorAll('input[data-file-target-id]:checked'))
      .map(input => input.dataset.fileTargetId)
      .filter(Boolean)
  }

  const renderFileTargets = () => {
    if (!targetList) return
    if (!fileTransferTargets.length) {
      targetList.innerHTML = '<div class="empty-state compact">暂无可发送文件的设备节点</div>'
      return
    }
    targetList.innerHTML = fileTransferTargets.map(target => {
      const disabled = !target.allowed || !target.reachable
      const checked = target.selected && !disabled
      const statusText = target.statusLabel || getTopologyStatusLabel(target.status || (target.reachable ? 'reachable' : 'offline'))
      const meta = [
        statusText,
        getDeviceTypeName(target.type),
        target.host || '',
        target.routeNextHopName ? `经 ${target.routeNextHopName}` : '',
        target.lastSeen ? `上次同步 ${formatTime(target.lastSeen)}` : '',
        target.reason || ''
      ].filter(Boolean).join(' · ')
      return `
        <label class="file-target-row ${disabled ? 'disabled' : ''}">
          <input type="checkbox" data-file-target-id="${escapeHtml(target.id)}" ${checked ? 'checked' : ''} ${disabled ? 'disabled' : ''}>
          <span class="file-target-icon">${getDeviceIcon(target.type)}</span>
          <span class="file-target-main">
            <span class="file-target-name">${escapeHtml(target.name || target.id)}</span>
            <span class="file-target-meta">${escapeHtml(meta)}</span>
          </span>
        </label>
      `
    }).join('')
  }

  const loadFileTargets = async () => {
    try {
      fileTransferTargets = await window.electronAPI.getFileTransferTargets?.() || []
      renderFileTargets()
    } catch (error) {
      console.error('Failed to load file transfer targets:', error)
      if (targetList) targetList.innerHTML = '<div class="empty-state compact">目标节点加载失败</div>'
    }
  }

  const renderFileHistory = () => {
    if (!historyList) return
    if (!fileTransferHistory.length) {
      historyList.innerHTML = '<div class="empty-state compact">暂无接收文件历史</div>'
      return
    }
    const groups = new Map()
    for (const item of fileTransferHistory) {
      const key = item.sourceId || item.sourceName || 'unknown'
      if (!groups.has(key)) groups.set(key, { sourceName: item.sourceName || '未知设备', items: [] })
      groups.get(key).items.push(item)
    }
    historyList.innerHTML = Array.from(groups.values()).map(group => `
      <div class="file-history-group">
        <div class="file-history-source">${escapeHtml(group.sourceName)}</div>
        ${group.items.slice(0, 20).map(item => {
          const meta = [
            item.receivedAt ? formatTime(item.receivedAt) : '',
            formatBytes(item.size),
            item.exists === false ? '文件已移动或删除' : ''
          ].filter(Boolean).join(' · ')
          return `
            <div class="file-history-row ${item.exists === false ? 'missing' : ''}">
              <div class="file-history-main">
                <div class="file-history-name">${escapeHtml(item.name || '文件')}</div>
                <div class="file-history-meta">${escapeHtml(meta)}</div>
                <div class="file-history-path" title="${escapeHtml(item.path || '')}">${escapeHtml(item.path || '')}</div>
              </div>
              <div class="file-history-actions">
                <button type="button" data-action="open-file-history" data-path="${escapeHtml(item.path || '')}" ${item.exists === false ? 'disabled' : ''}>打开</button>
                <button type="button" data-action="reveal-file-history" data-path="${escapeHtml(item.path || '')}" ${item.exists === false ? 'disabled' : ''}>定位</button>
              </div>
            </div>
          `
        }).join('')}
      </div>
    `).join('')
  }

  const loadFileHistory = async () => {
    try {
      fileTransferHistory = await window.electronAPI.getFileTransferHistory?.() || []
      renderFileHistory()
    } catch (error) {
      console.error('Failed to load file transfer history:', error)
      if (historyList) historyList.innerHTML = '<div class="empty-state compact">接收历史加载失败</div>'
    }
  }

  const handleSendResult = (result, kind) => {
    if (result?.canceled) {
      setStatus('')
    } else if (result?.success) {
      const count = Array.isArray(result.sent) ? result.sent.length : 0
      setStatus(`已发送 ${count} 个文件`)
      showNotification(`${kind}已发送`, `共 ${count} 个文件 → ${result.targetIds?.length || 0} 个节点`)
    } else {
      setStatus(result?.error || '发送失败')
      showNotification(`${kind}发送失败`, result?.error || '没有可用目标')
    }
  }

  const bindSendButton = (element, invoke, kind) => {
    if (!element || typeof invoke !== 'function') return
    element.addEventListener('click', async () => {
      const targetIds = getSelectedTargetIds()
      if (targetIds.length === 0) {
        setStatus('请先选择至少一个接收节点')
        showNotification('未选择接收节点', '请在文件传输目标中勾选设备节点')
        return
      }
      element.disabled = true
      setStatus('选择中…')
      try {
        handleSendResult(await invoke(targetIds), kind)
      } catch (error) {
        setStatus('发送失败')
        showNotification(`${kind}发送失败`, error.message || '请重试')
      } finally {
        element.disabled = false
        setTimeout(() => setStatus(''), 5000)
      }
    })
  }

  bindSendButton(button, (targetIds) => window.electronAPI.selectAndSendFile(targetIds), '文件')
  bindSendButton(folderButton, (targetIds) => window.electronAPI.selectAndSendFolder?.(targetIds), '文件夹')
  refreshTargetsButton?.addEventListener('click', loadFileTargets)
  refreshHistoryButton?.addEventListener('click', loadFileHistory)
  historyList?.addEventListener('click', async (event) => {
    const actionButton = event.target.closest('button[data-action]')
    if (!actionButton) return
    const filePath = actionButton.dataset.path || ''
    const result = actionButton.dataset.action === 'open-file-history'
      ? await window.electronAPI.openFileTransferPath?.(filePath)
      : await window.electronAPI.revealFileTransferPath?.(filePath)
    if (result && result.success === false) {
      showNotification('文件路径不可用', result.error || '无法打开文件')
      await loadFileHistory()
    }
  })

  // 接收进度列表：每个 fileId 一行（文件名 + 进度条 + 百分比），完成后短暂停留
  const transferRows = new Map()
  const upsertTransferRow = (fileId, name, received, size, done) => {
    if (!transferList || !fileId) return
    let row = transferRows.get(fileId)
    if (!row) {
      const root = document.createElement('div')
      root.className = 'file-transfer-row'
      const label = document.createElement('div')
      label.className = 'file-transfer-name'
      const track = document.createElement('div')
      track.className = 'file-transfer-track'
      const bar = document.createElement('div')
      bar.className = 'file-transfer-bar'
      track.appendChild(bar)
      root.appendChild(label)
      root.appendChild(track)
      transferList.appendChild(root)
      row = { root, label, bar }
      transferRows.set(fileId, row)
    }
    const percent = size > 0 ? Math.min(100, Math.round((received || 0) * 100 / size)) : 0
    row.bar.style.width = `${done ? 100 : percent}%`
    row.label.textContent = done ? `${name || '文件'} · 完成` : `${name || '文件'} · ${percent}%`
    if (done) {
      row.root.classList.add('done')
      transferRows.delete(fileId)
      setTimeout(() => row.root.remove(), 4000)
    }
  }

  window.electronAPI.onFileTransferProgress?.((progress) => {
    if (!progress || !progress.size) return
    upsertTransferRow(progress.fileId, progress.name, progress.received, progress.size, false)
  })
  window.electronAPI.onFileTransferComplete?.((result) => {
    upsertTransferRow(result?.fileId || result?.name || 'last', result?.name, 1, 1, true)
    showNotification('文件接收完成', result?.name || '')
    if (result?.historyEntry) {
      fileTransferHistory = [
        result.historyEntry,
        ...fileTransferHistory.filter(item => item.id !== result.historyEntry.id && item.path !== result.historyEntry.path)
      ]
      renderFileHistory()
    } else {
      loadFileHistory()
    }
  })
  window.electronAPI.onFileTransferHistoryChanged?.((history) => {
    fileTransferHistory = Array.isArray(history) ? history : []
    renderFileHistory()
  })
  loadFileTargets()
  loadFileHistory()
}

async function setupLanJoinSettings() {
  const checkbox = document.getElementById('chk-allow-lan-join')
  if (!checkbox || !window.electronAPI.getLanJoinSettings) return

  try {
    const settings = await window.electronAPI.getLanJoinSettings()
    checkbox.checked = settings?.allowLanJoinRequests !== false
  } catch (error) {
    console.error('Failed to load LAN join settings:', error)
  }

  checkbox.addEventListener('change', async () => {
    try {
      const settings = await window.electronAPI.setLanJoinSettings({
        allowLanJoinRequests: checkbox.checked
      })
      checkbox.checked = settings?.allowLanJoinRequests !== false
    } catch (error) {
      console.error('Failed to save LAN join settings:', error)
      checkbox.checked = !checkbox.checked
    }
  })
}

function setupPhoneList() {
  const container = document.getElementById('phones-list')

  container.addEventListener('change', async (event) => {
    const target = event.target
    const row = target.closest('.phone-row')
    if (!row) return

    if (target.matches('[data-action="toggle-phone-totp"], [data-action="toggle-phone-clipboard"], [data-action="toggle-phone-clipboard-image"], [data-action="toggle-phone-file"]')) {
      target.disabled = true
      try {
        const updates = target.dataset.action === 'toggle-phone-clipboard'
          ? { allowClipboard: target.checked, allowClipboardText: target.checked }
          : target.dataset.action === 'toggle-phone-clipboard-image'
            ? { allowClipboardImage: target.checked }
            : target.dataset.action === 'toggle-phone-file'
              ? { allowClipboardFile: target.checked, allowFileTransfer: target.checked }
              : { allowTotp: target.checked }
        const phones = await window.electronAPI.setPhoneContentPolicy(row.dataset.phoneId, updates)
        authorizedPhones = Array.isArray(phones) ? phones : []
        renderPhones()
        renderTopology()
      } catch (error) {
        console.error('Failed to change phone content policy:', error)
        target.checked = !target.checked
      } finally {
        target.disabled = false
      }
      return
    }

    if (!target.matches('[data-action="toggle-phone"]')) return

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

function setupTopology() {
  const refreshButton = document.getElementById('btn-refresh-topology')
  const graph = document.getElementById('topology-graph')
  if (refreshButton) {
    refreshButton.addEventListener('click', async () => {
      refreshButton.disabled = true
      try {
        await refreshTopology()
      } finally {
        refreshButton.disabled = false
      }
    })
  }

  if (graph) {
    graph.addEventListener('mouseover', (event) => {
      const nodeEl = event.target.closest('[data-topology-node-id]')
      if (!nodeEl || !graph.contains(nodeEl)) return
      renderTopologyNodeDetail(nodeEl.dataset.topologyNodeId, { transient: true })
    })
    graph.addEventListener('mouseleave', () => {
      renderTopologyNodeDetail(selectedTopologyNodeId)
    })
    graph.addEventListener('click', (event) => {
      const nodeEl = event.target.closest('[data-topology-node-id]')
      if (!nodeEl || !graph.contains(nodeEl)) return
      selectedTopologyNodeId = nodeEl.dataset.topologyNodeId || ''
      renderTopologyNodeDetail(selectedTopologyNodeId)
      graph.querySelectorAll('.topology-directed-node.selected, .topology-node.selected')
        .forEach(item => item.classList.remove('selected'))
      nodeEl.classList.add('selected')
    })
  }
}

function setupLanDiscovery() {
  const scanButton = document.getElementById('btn-scan-lan')
  const container = document.getElementById('lan-devices-list')
  if (!scanButton || !container) return

  scanButton.addEventListener('click', async () => {
    scanButton.disabled = true
    scanButton.textContent = '扫描中...'
    container.innerHTML = '<div class="empty-state">正在扫描局域网设备...</div>'
    try {
      lanDevices = await window.electronAPI.scanLanDevices()
      if (!Array.isArray(lanDevices)) lanDevices = []
      renderLanDevices()
    } catch (error) {
      console.error('Failed to scan LAN devices:', error)
      container.innerHTML = '<div class="empty-state">局域网扫描失败</div>'
    } finally {
      scanButton.disabled = false
      scanButton.textContent = '发现设备'
    }
  })

  container.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-action="pair-lan-device"]')
    if (!button) return
    const device = lanDevices.find(item => item.id === button.dataset.deviceId)
    if (!device) return
    button.disabled = true
    try {
      const result = device.canRequestJoin && typeof window.electronAPI.requestLanJoin === 'function'
        ? await window.electronAPI.requestLanJoin(device, 'basic')
        : await window.electronAPI.pairDesktopDevice(device)
      if (result?.success) {
        showNotification(device.canRequestJoin ? '已加入可信网络' : '桌面配对已发起', result.peer?.name || device.name)
        await refreshTopology()
        lanDevices = await window.electronAPI.getLanDevices()
        renderLanDevices()
      } else {
        showNotification(result?.rejected ? '入网被拒绝' : '配对失败', result?.error || '无法连接该设备')
      }
    } catch (error) {
      console.error('Failed to pair LAN device:', error)
      showNotification('配对失败', error.message || '无法连接该设备')
    } finally {
      button.disabled = false
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
  lastPairingInfo = info
  setPairingQr(info?.qrDataURL)
  updatePairingAddress(info)
  authorizedPhones = Array.isArray(info.authorizedPhones) ? info.authorizedPhones : []
  renderPhones()
  updateConnectionStatusFromPhones()
  await refreshTopology()
}

function setPairingQr(qrDataURL) {
  const qrImage = document.getElementById('qr-image')
  if (qrImage && qrDataURL) {
    qrImage.src = qrDataURL
  }
}

async function refreshAuthorizedPhones() {
  const phones = await window.electronAPI.getAuthorizedPhones()
  authorizedPhones = Array.isArray(phones) ? phones : []
  renderPhones()
  updateConnectionStatusFromPhones()
  await refreshTopology()
}

async function refreshDesktopTotps() {
  if (!windowVisible) {
    desktopTotpsDirty = true
    return
  }
  desktopTotpsDirty = false
  desktopTotps = await window.electronAPI.getDesktopTotps()
  if (!Array.isArray(desktopTotps)) desktopTotps = []
  updateTotpDisplay()
  await refreshTopology()
}

function addCode(codeInfo) {
  const now = Date.now()
  const normalized = {
    ...codeInfo,
    type: codeInfo.contentType || codeInfo.type || 'sms',
    contentType: codeInfo.contentType || codeInfo.type || 'sms',
    code: codeInfo.code || '',
    phoneId: codeInfo.phoneId || '',
    phoneName: codeInfo.phoneName || '未知手机',
    timestamp: codeInfo.timestamp || now
  }
  const duplicateKey = getMessageDuplicateKey(normalized)
  const duplicate = codes.find(c =>
    getMessageDuplicateKey(c) === duplicateKey &&
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

  updateSettingsStats()
}

async function refreshTopology() {
  if (typeof window.electronAPI.getTopology !== 'function') return
  try {
    topologySnapshot = await window.electronAPI.getTopology()
  } catch (error) {
    console.error('Failed to refresh topology:', error)
  }
  renderTopology()
}

function renderPhones() {
  const container = document.getElementById('phones-list')
  const countEl = document.getElementById('phones-count')

  // 更新角标
  if (authorizedPhones.length > 0) {
    countEl.textContent = authorizedPhones.length
    countEl.style.display = 'flex'
  } else {
    countEl.style.display = 'none'
  }

  if (authorizedPhones.length === 0) {
    container.innerHTML = '<div class="empty-state">暂无已授权设备</div>'
    return
  }

  container.innerHTML = authorizedPhones.map(phone => {
    const state = getPhoneState(phone)
    const checked = phone.enabled !== false && phone.revoked !== true
    const contentPolicy = phone.contentPolicy || {}
    const totpChecked = contentPolicy.allowTotp !== false
    const clipboardChecked = contentPolicy.allowClipboardText !== false && contentPolicy.allowClipboard !== false
    const clipboardImageChecked = contentPolicy.allowClipboardImage === true
    const fileChecked = contentPolicy.allowClipboardFile === true || contentPolicy.allowFileTransfer === true
    const meta = [
      phone.lastSeen ? `上次 ${formatTime(phone.lastSeen)}` : '',
      phone.lastIP || ''
    ].filter(Boolean).join(' · ')

    // 已撤销的手机：开关不可用，右侧操作改为「恢复」（解除撤销，重新授权）；
    // 未撤销的手机：正常的启用/禁用开关 + 「撤销」。
    const actionButton = phone.revoked
      ? `<button class="phone-restore" data-action="restore-phone" title="恢复授权">恢复</button>`
      : `<button class="phone-revoke" data-action="revoke-phone" title="撤销授权">撤销</button>`
    const deviceType = phone.deviceType || 'ANDROID_PHONE'
    const deviceIcon = getDeviceIcon(deviceType)

    return `
      <div class="phone-row ${state.className}" data-phone-id="${escapeHtml(phone.id)}">
        <div class="phone-main">
          <div class="phone-header">
            <span class="phone-name">${deviceIcon} ${escapeHtml(phone.name || 'Android Phone')}</span>
            <span class="phone-status">${state.label}</span>
          </div>
          <div class="phone-meta">${escapeHtml(meta || '等待连接')}</div>
        </div>
        <label class="phone-toggle" title="启用或禁用这台手机">
          <input type="checkbox" data-action="toggle-phone" ${checked ? 'checked' : ''} ${phone.revoked ? 'disabled' : ''}>
          <span></span>
        </label>
        <label class="phone-policy-toggle" title="是否向该节点推送本机 TOTP">
          <input type="checkbox" data-action="toggle-phone-totp" ${totpChecked ? 'checked' : ''} ${phone.revoked ? 'disabled' : ''}>
          <span>TOTP</span>
        </label>
        <label class="phone-policy-toggle" title="是否向该节点同步本机剪贴板">
          <input type="checkbox" data-action="toggle-phone-clipboard" ${clipboardChecked ? 'checked' : ''} ${phone.revoked ? 'disabled' : ''}>
          <span>文本</span>
        </label>
        <label class="phone-policy-toggle" title="是否向该节点同步本机图片剪贴板">
          <input type="checkbox" data-action="toggle-phone-clipboard-image" ${clipboardImageChecked ? 'checked' : ''} ${phone.revoked ? 'disabled' : ''}>
          <span>图片</span>
        </label>
        <label class="phone-policy-toggle" title="是否向该节点同步本机文件剪贴板和文件">
          <input type="checkbox" data-action="toggle-phone-file" ${fileChecked ? 'checked' : ''} ${phone.revoked ? 'disabled' : ''}>
          <span>文件</span>
        </label>
        ${actionButton}
      </div>
    `
  }).join('')
}

function renderLanDevices() {
  const container = document.getElementById('lan-devices-list')
  if (!container) return

  if (!lanDevices.length) {
    container.innerHTML = '<div class="empty-state">未发现局域网设备</div>'
    return
  }

  container.innerHTML = lanDevices.map(device => {
    const icon = getDeviceIcon(device.deviceType)
    const typeName = getDeviceTypeName(device.deviceType)
    const address = [device.host, device.joinPort || device.port].filter(Boolean).join(':')
    const canPair = device.canPair === true || device.canRequestJoin === true
    const trustLabel = device.trustStatus === 'trusted' ? '已信任' : (device.canRequestJoin ? '未确认' : '已发现')
    const fingerprint = device.joinFingerprint ? ` · 指纹 ${device.joinFingerprint}` : ''
    const action = canPair
      ? `<button class="lan-pair-btn" data-action="pair-lan-device" data-device-id="${escapeHtml(device.id)}">${device.canRequestJoin ? '请求加入' : '加入'}</button>`
      : `<span class="lan-device-hint">${escapeHtml(trustLabel)}</span>`

    return `
      <div class="lan-device-row">
        <div class="lan-device-icon">${icon}</div>
        <div class="lan-device-main">
          <div class="lan-device-name">${escapeHtml(device.name || '未知设备')}</div>
          <div class="lan-device-meta">${escapeHtml(typeName)} · ${escapeHtml(address)} · ${escapeHtml(trustLabel)}${escapeHtml(fingerprint)}</div>
        </div>
        ${action}
      </div>
    `
  }).join('')
}

function capabilitySummary(capabilities = {}) {
  const items = []
  if (capabilities.topology) items.push('拓扑')
  if (capabilities.relay) items.push('中继')
  if (capabilities.sms) items.push('短信')
  if (capabilities.totp) items.push('TOTP')
  if (capabilities.clipboardText) items.push('剪贴板')
  if (capabilities.fileTransfer) items.push('文件')
  return items.length ? items.join('、') : '未声明'
}

function showLanJoinRequestModal(request) {
  if (!request?.requestId) return
  document.querySelectorAll('.lan-join-dialog').forEach(item => item.remove())
  const dialog = document.createElement('div')
  dialog.className = 'lan-join-dialog'
  const typeName = getDeviceTypeName(request.nodeType)
  const lines = [
    ['设备', request.nodeName || request.nodeId],
    ['类型', typeName],
    ['地址', [request.host, request.joinPort || request.port].filter(Boolean).join(':')],
    ['指纹', request.fingerprint || '未提供'],
    ['能力', capabilitySummary(request.capabilities || {})],
    ['网络', request.networkId || '新节点']
  ]

  dialog.innerHTML = `
    <div class="lan-join-card">
      <div class="lan-join-title">局域网加入请求</div>
      <div class="lan-join-subtitle">确认后该节点会进入可信拓扑，并获得当前拓扑快照。</div>
      <div class="lan-join-device">
        ${lines.map(([label, value]) => `
          <div class="lan-join-line">
            <span>${escapeHtml(label)}</span>
            <strong>${escapeHtml(value)}</strong>
          </div>
        `).join('')}
      </div>
      <div class="lan-join-actions">
        <button class="btn-dialog btn-secondary" data-template="topology_only">只加入拓扑</button>
        <button class="btn-dialog btn-secondary" data-template="basic">基础同步</button>
        <button class="btn-dialog btn-primary" data-template="full">完整同步</button>
      </div>
      <button class="lan-join-reject" data-action="reject">拒绝</button>
    </div>
  `

  const respond = async (accepted, template = 'basic') => {
    try {
      await window.electronAPI.respondLanJoin(request.requestId, accepted, template)
      showNotification(accepted ? '已允许入网' : '已拒绝入网', request.nodeName || request.nodeId)
    } catch (error) {
      showNotification('处理入网请求失败', error.message || '请重试')
    } finally {
      dialog.remove()
    }
  }

  dialog.querySelectorAll('[data-template]').forEach(button => {
    button.addEventListener('click', () => respond(true, button.dataset.template || 'basic'))
  })
  dialog.querySelector('[data-action="reject"]')?.addEventListener('click', () => respond(false))
  dialog.addEventListener('click', event => {
    if (event.target === dialog) respond(false)
  })
  document.body.appendChild(dialog)
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
    const contentType = c.contentType || c.type || 'sms'
    const isVerification = contentType === 'sms'
    const isNotification = contentType === 'app_notification'
    const rawMessage = getRawMessage(c)
    const hasRaw = Boolean(rawMessage)
    const itemMode = isVerification && hasRaw && (cardDisplayModes.get(c.id) || smsDisplayMode) === 'raw'
      ? 'raw'
      : 'code'
    const showRaw = itemMode === 'raw' || !isVerification
    const primaryContent = isVerification
      ? (showRaw ? rawMessage : (c.code || rawMessage || ''))
      : (rawMessage || c.title || c.source || '')
    const primaryClass = isVerification && !showRaw ? 'code-value' : 'code-raw-message'
    const contentTypeLabel = getContentTypeLabel(contentType)
    const contentMeta = isNotification && c.title
      ? `<div class="code-message-title">${escapeHtml(c.title)}</div>`
      : ''
    const codeMeta = isVerification && showRaw && c.code
      ? `<div class="code-extracted">验证码: ${escapeHtml(c.code)}</div>`
      : ''
    const toggleHint = isVerification && hasRaw
      ? `<button class="toggle-raw-btn" data-action="toggle-raw" title="切换显示原文/验证码">${showRaw ? '验证码' : '原文'}</button>`
      : ''
    const copyLabel = isVerification ? '📋 复制码' : '📋 复制'

    // 来源设备信息
    const sourceDeviceIcon = getDeviceIcon(c.sourceDeviceType || 'ANDROID_PHONE')
    const sourceDeviceName = c.sourceDeviceName || c.phoneName || '未知设备'
    const targetDeviceName = c.targetDeviceName || '当前设备'
    const targetCount = Array.isArray(c.targetDevices) ? c.targetDevices.length : 0
    const routeText = targetCount > 1
      ? `${sourceDeviceName} -> ${targetCount} 个设备`
      : `${sourceDeviceName} -> ${targetDeviceName}`
    const isLocal = c.isLocal || false
    const sourceClass = isLocal ? 'local' : 'remote'

    return `
      <div class="code-item ${Date.now() - c.timestamp < 3000 ? 'new-code' : ''}" data-id="${c.id}" title="点击查看详细内容">
        <div class="code-main">
          <div class="code-type-badge type-${escapeHtml(contentType)}">${escapeHtml(contentTypeLabel)}</div>
          ${contentMeta}
          <div class="${primaryClass}">${escapeHtml(primaryContent)}</div>
          ${codeMeta}
          <div class="code-source">${escapeHtml(getMessageSourceText(c))}</div>
          <div class="source-device ${sourceClass}">
            <span class="source-device-icon">${sourceDeviceIcon}</span>
            <span>${escapeHtml(sourceDeviceName)}</span>
          </div>
          <div class="source-route">${escapeHtml(routeText)}</div>
        </div>
        <div class="code-side">
          <div class="code-time">${timeStr}</div>
          <div class="code-actions">
            ${toggleHint}
            <button class="copy-code-btn">${copyLabel}</button>
          </div>
        </div>
      </div>
    `
  }).join('')

  container.querySelectorAll('.copy-code-btn').forEach(button => {
    button.addEventListener('click', function(e) {
      e.stopPropagation()
      const id = this.closest('.code-item')?.dataset.id
      const codeData = codes.find(c => c.id === id)
      const value = getCopyValueForMessage(codeData)
      if (value) window.electronAPI.copyToClipboard(value)
    })
  })

  container.querySelectorAll('[data-action="toggle-raw"]').forEach(button => {
    button.addEventListener('click', function(e) {
      e.stopPropagation()
      toggleCardDisplayMode(this.closest('.code-item')?.dataset.id)
    })
  })

  // 点击卡片正文打开详情；复制与原文/验证码切换保留为显式按钮。
  container.querySelectorAll('.code-item').forEach(item => {
    item.addEventListener('click', function(e) {
      if (e.target.closest('button')) return
      // 原文区域允许自由选中复制文本，不触发详情弹窗
      if (window.getSelection?.()?.toString()) return
      const id = this.dataset.id
      const codeData = codes.find(c => c.id === id)
      if (codeData) showMessageDetailDialog(codeData)
    })
  })
}

function showMessageDetailDialog(codeInfo) {
  if (!codeInfo) return
  document.querySelectorAll('.message-detail-dialog').forEach(item => item.remove())

  const dialog = document.createElement('div')
  dialog.className = 'message-detail-dialog'
  const contentType = codeInfo.contentType || codeInfo.type || 'sms'
  const rawMessage = getRawMessage(codeInfo)
  const copyValue = getCopyValueForMessage(codeInfo)
  const manifest = codeInfo.fileManifest || {}
  const targetDevices = Array.isArray(codeInfo.targetDevices) ? codeInfo.targetDevices : []
  const targetText = targetDevices.length
    ? targetDevices.map(item => typeof item === 'string'
      ? item
      : (item?.name || item?.deviceName || item?.id || item?.deviceId)
    ).filter(Boolean).slice(0, 8).join('、')
    : (codeInfo.targetDeviceName || '当前设备')

  const rows = [
    ['类型', getContentTypeLabel(contentType)],
    ['时间', formatFullTime(codeInfo.timestamp)],
    ['来源', getMessageSourceText(codeInfo)],
    ['来源设备', codeInfo.sourceDeviceName || codeInfo.phoneName || '未知设备'],
    ['目标设备', targetDevices.length > 8 ? `${targetText} 等 ${targetDevices.length} 个设备` : targetText],
    ['上一跳', codeInfo.lastHopDeviceName || ''],
    ['消息 ID', codeInfo.originMessageId || codeInfo.relayMessageId || ''],
    ['推送权限', getAuthorityLabel(codeInfo.pushAuthority) || codeInfo.pushAuthority || '']
  ]

  if (codeInfo.code) rows.splice(2, 0, ['验证码', codeInfo.code])
  if (codeInfo.title) rows.push(['标题', codeInfo.title])
  if (codeInfo.appName) rows.push(['应用', codeInfo.appName])
  if (codeInfo.packageName) rows.push(['包名', codeInfo.packageName])
  if (manifest && Object.keys(manifest).length) {
    rows.push(['文件名', manifest.name || ''])
    rows.push(['MIME', manifest.mime || ''])
    rows.push(['大小', manifest.size ? formatBytesCompact(manifest.size) : ''])
    rows.push(['SHA-256', manifest.sha256 || ''])
    rows.push(['File ID', manifest.fileId || ''])
  }

  const bodyText = rawMessage || codeInfo.source || ''
  dialog.innerHTML = `
    <div class="message-detail-card">
      <div class="message-detail-header">
        <div>
          <div class="message-detail-title">${escapeHtml(getContentTypeLabel(contentType))}</div>
          <div class="message-detail-subtitle">${escapeHtml(codeInfo.sourceDeviceName || codeInfo.phoneName || '未知设备')} · ${escapeHtml(formatFullTime(codeInfo.timestamp))}</div>
        </div>
        <button class="message-detail-close" data-action="close" title="关闭">×</button>
      </div>
      <div class="message-detail-grid">
        ${rows.filter(([, value]) => value !== undefined && value !== null && String(value).trim() !== '').map(([label, value]) => `
          <div class="message-detail-row">
            <span>${escapeHtml(label)}</span>
            <strong title="${escapeHtml(String(value))}">${escapeHtml(String(value))}</strong>
          </div>
        `).join('')}
      </div>
      <div class="message-detail-section">
        <div class="message-detail-section-title">详细内容</div>
        <pre class="message-detail-body">${escapeHtml(bodyText || '无正文')}</pre>
      </div>
      <div class="message-detail-actions">
        ${copyValue ? '<button class="btn-dialog btn-secondary" data-action="copy-main">复制主要内容</button>' : ''}
        ${rawMessage && rawMessage !== copyValue ? '<button class="btn-dialog btn-secondary" data-action="copy-raw">复制原文</button>' : ''}
        <button class="btn-dialog btn-primary" data-action="close">关闭</button>
      </div>
    </div>
  `

  const close = () => {
    document.removeEventListener('keydown', onKeydown)
    dialog.remove()
  }
  const onKeydown = (event) => {
    if (event.key === 'Escape') close()
  }
  dialog.querySelectorAll('[data-action="close"]').forEach(button => {
    button.addEventListener('click', close)
  })
  dialog.querySelector('[data-action="copy-main"]')?.addEventListener('click', () => {
    if (copyValue) window.electronAPI.copyToClipboard(copyValue)
  })
  dialog.querySelector('[data-action="copy-raw"]')?.addEventListener('click', () => {
    if (rawMessage) window.electronAPI.copyToClipboard(rawMessage)
  })
  dialog.addEventListener('click', event => {
    if (event.target === dialog) close()
  })
  document.addEventListener('keydown', onKeydown)
  document.body.appendChild(dialog)
}

function renderTopology() {
  const summaryEl = document.getElementById('topology-summary')
  const graphEl = document.getElementById('topology-graph')
  const edgeListEl = document.getElementById('topology-edge-list')
  if (!summaryEl || !graphEl || !edgeListEl) return

  const view = buildTopologyViewModel()
  const nodes = view.nodes
  const edges = view.edges

  summaryEl.innerHTML = `
    <div class="topology-stat">
      <span class="topology-stat-value">${nodes.length}</span>
      <span class="topology-stat-label">节点</span>
    </div>
    <div class="topology-stat">
      <span class="topology-stat-value">${edges.length}</span>
      <span class="topology-stat-label">链路</span>
    </div>
    <div class="topology-stat">
      <span class="topology-stat-value">${view.routeCount}</span>
      <span class="topology-stat-label">SPF 路由</span>
    </div>
    <div class="topology-stat">
      <span class="topology-stat-value">${view.connectedPhoneCount}</span>
      <span class="topology-stat-label">手机在线</span>
    </div>
    <div class="topology-stat">
      <span class="topology-stat-value">${view.localTotpCount}</span>
      <span class="topology-stat-label">本机 TOTP</span>
    </div>
  `

  if (nodes.length === 0) {
    graphEl.innerHTML = '<div class="empty-state">暂无拓扑数据</div>'
    edgeListEl.innerHTML = ''
    renderTopologyNodeDetail('')
    return
  }

  graphEl.innerHTML = renderDirectedTopologyGraph(view)
  applySelectedTopologyNode()
  renderTopologyNodeDetail(selectedTopologyNodeId)

  if (edges.length === 0) {
    edgeListEl.innerHTML = '<div class="topology-empty-edge">还没有形成同步链路</div>'
    return
  }

  edgeListEl.innerHTML = edges.map(edge => renderTopologyEdge(edge, view.nodeMap)).join('')
}

function applySelectedTopologyNode() {
  const graph = document.getElementById('topology-graph')
  if (!graph) return
  graph.querySelectorAll('.topology-directed-node.selected, .topology-node.selected')
    .forEach(item => item.classList.remove('selected'))
  // 选中节点时：相关链路高亮，其余链路淡化，方便看清单个节点的连接关系
  const paths = graph.querySelectorAll('.topology-directed-path')
  paths.forEach(path => path.classList.remove('related', 'dimmed'))
  if (!selectedTopologyNodeId) return
  const selected = graph.querySelector(`[data-topology-node-id="${cssEscape(selectedTopologyNodeId)}"]`)
  if (selected) selected.classList.add('selected')
  paths.forEach(path => {
    const related = path.dataset.edgeFrom === selectedTopologyNodeId ||
      path.dataset.edgeTo === selectedTopologyNodeId
    path.classList.add(related ? 'related' : 'dimmed')
  })
}

function buildTopologyViewModel() {
  const snapshot = topologySnapshot || {}
  const nodeMap = new Map()
  const edgeMap = new Map()

  ;(Array.isArray(snapshot.nodes) ? snapshot.nodes : []).forEach(node => {
    mergeTopologyViewNode(nodeMap, node)
  })
  ;(Array.isArray(snapshot.edges) ? snapshot.edges : []).forEach(edge => {
    addTopologyViewEdge(edgeMap, edge)
  })

  codes.slice(0, 30).forEach(code => {
    addRecentCodeTopology(nodeMap, edgeMap, code, snapshot.localNodeId)
  })

  const nodes = Array.from(nodeMap.values())
  const localNodeId = snapshot.localNodeId || nodes.find(node => node.role === 'local_desktop')?.id || ''
  const phoneNodes = nodes
    .filter(node => isPhoneNode(node))
    .sort(sortTopologyNodes)
  const localNodes = nodes
    .filter(node => node.id === localNodeId || node.role === 'local_desktop')
    .sort(sortTopologyNodes)
  const desktopNodes = nodes
    .filter(node => !isPhoneNode(node) && node.id !== localNodeId && node.role !== 'local_desktop')
    .sort(sortTopologyNodes)
  const edges = Array.from(edgeMap.values())
    .sort((a, b) => Number(b.active) - Number(a.active) || Number(b.enabled) - Number(a.enabled) || (b.updatedAt || 0) - (a.updatedAt || 0))

  return {
    nodes,
    nodeMap,
    edges,
    phoneNodes,
    localNodes,
    desktopNodes,
    connectedPhoneCount: phoneNodes.filter(node => node.status === 'online').length,
    localTotpCount: snapshot.summary?.localTotpCount || desktopTotps.filter(item => item.isLocal).length,
    routeCount: snapshot.summary?.routeCount || snapshot.routing?.routeCount || 0
  }
}

function getMessageDuplicateKey(codeInfo) {
  const originMessageId = codeInfo.originMessageId || codeInfo.relayMessageId || codeInfo.msgId
  if (originMessageId) {
    return `${codeInfo.originDeviceId || codeInfo.sourceDeviceId || codeInfo.phoneId || ''}|${originMessageId}`
  }
  const contentType = codeInfo.contentType || codeInfo.type || 'sms'
  if (contentType === 'sms') return codeInfo.code || getRawMessage(codeInfo)
  return [
    codeInfo.source || '',
    codeInfo.title || '',
    codeInfo.appName || '',
    getRawMessage(codeInfo)
  ].join('|')
}

function renderDirectedTopologyGraph(view) {
  const nodeHeight = 66
  const gap = 14
  const top = 14
  const lanes = [
    { key: 'phone', title: '手机 / 来源', nodes: view.phoneNodes, x: 40 },
    { key: 'local', title: '本机节点', nodes: view.localNodes, x: 370 },
    { key: 'desktop', title: '其它节点', nodes: view.desktopNodes, x: 700 }
  ]
  const maxLaneCount = Math.max(1, ...lanes.map(lane => lane.nodes.length))
  const height = top + maxLaneCount * nodeHeight + (maxLaneCount - 1) * gap + 34
  const positions = new Map()

  lanes.forEach(lane => {
    lane.nodes.forEach((node, index) => {
      positions.set(node.id, {
        x: lane.x,
        y: top + index * (nodeHeight + gap) + 22,
        lane: lane.key
      })
    })
  })

  const paths = view.edges
    .filter(edge => positions.has(String(edge.from)) && positions.has(String(edge.to)))
    .map(edge => renderDirectedTopologyPath(edge, positions))
    .join('')

  const laneTitles = lanes.map(lane => `
    <div class="topology-directed-title" style="left:${lane.x / 10}%">${escapeHtml(lane.title)}</div>
  `).join('')

  const nodes = lanes.flatMap(lane => lane.nodes.map(node => {
    const pos = positions.get(node.id)
    return renderDirectedTopologyNode(node, pos)
  })).join('')

  return `
    <div class="topology-directed" style="height:${height}px">
      ${laneTitles}
      <svg class="topology-directed-svg" viewBox="0 0 1000 ${height}" preserveAspectRatio="none">
        ${paths}
      </svg>
      ${nodes}
    </div>
    ${renderTopologyLegend()}
  `
}

// 链路类型 → 图例与配色（CSS 中 type-* 类对应同一套颜色）
const TOPOLOGY_EDGE_TYPES = [
  { type: 'verify_push', label: '验证码推送' },
  { type: 'relay_route', label: '节点直连中继' },
  { type: 'spf_route', label: 'SPF 路由' },
  { type: 'totp_sync', label: 'TOTP 同步' },
  { type: 'desktop_pair', label: '桌面互配' },
  { type: 'routing_adjacency', label: '路由表下发' },
  { type: 'lan_discovery', label: '局域网发现' }
]

function renderTopologyLegend() {
  const items = TOPOLOGY_EDGE_TYPES.map(item => `
    <span class="topology-legend-item">
      <i class="topology-legend-swatch type-${item.type}"></i>${escapeHtml(item.label)}
    </span>
  `).join('')
  return `
    <div class="topology-legend">
      ${items}
      <span class="topology-legend-item"><i class="topology-legend-swatch legend-active"></i>实线 = 在线连接</span>
      <span class="topology-legend-item"><i class="topology-legend-swatch legend-partial"></i>点线 = 部分在线</span>
      <span class="topology-legend-item"><i class="topology-legend-swatch legend-idle"></i>虚线 = 可路由 / 离线 / 历史</span>
    </div>
  `
}

function getTopologyEdgeState(edge) {
  if (!edge) return 'disabled'
  if (edge.type === 'lan_discovery') return 'discovered'
  if (edge.type === 'recent_verify' || edge.type === 'totp_seed_scope') return 'history'
  if (edge.enabled === false) return 'disabled'
  if (edge.active === true) return 'online'
  if (edge.partiallyActive === true) return 'partial'
  if (edge.routable === true || edge.metric) return 'routable'
  return 'offline'
}

function getTopologyEdgeStateLabel(edge) {
  const state = getTopologyEdgeState(edge)
  return {
    online: '在线连接',
    partial: '部分在线',
    routable: '可路由候选',
    discovered: '局域网发现',
    history: '同步历史',
    disabled: '已停用',
    offline: '离线'
  }[state] || '未知'
}

function renderDirectedTopologyPath(edge, positions) {
  const from = positions.get(String(edge.from))
  const to = positions.get(String(edge.to))
  const forward = from.x <= to.x
  const startX = forward ? from.x + 260 : from.x
  const endX = forward ? to.x : to.x + 260
  const startY = from.y + 33
  const endY = to.y + 33
  const midX = (startX + endX) / 2
  const curve = `M ${startX} ${startY} C ${midX} ${startY}, ${midX} ${endY}, ${endX} ${endY}`
  const edgeState = getTopologyEdgeState(edge)
  const className = [
    'topology-directed-path',
    `type-${edge.type || 'sync'}`,
    `state-${edgeState}`,
    edgeState === 'online' ? 'active' : '',
    edgeState === 'partial' ? 'partial' : '',
    edge.enabled ? '' : 'disabled'
  ].filter(Boolean).join(' ')
  const tooltip = [
    edge.label || '同步',
    edge.metric ? `metric ${edge.metric}` : '',
    getTopologyEdgeStateLabel(edge)
  ].filter(Boolean).join(' · ')
  // metric 标在曲线中点略上方，只对参与路由计算的链路显示
  const midY = (startY + endY) / 2
  const metricLabel = edge.metric
    ? `<text class="topology-path-metric type-${escapeHtml(edge.type || 'sync')}" x="${midX}" y="${midY - 6}" text-anchor="middle">${escapeHtml(String(edge.metric))}</text>`
    : ''
  return `<path class="${className}"
    data-edge-from="${escapeHtml(String(edge.from))}"
    data-edge-to="${escapeHtml(String(edge.to))}"
    d="${curve}"><title>${escapeHtml(tooltip)}</title></path>${metricLabel}`
}

function renderDirectedTopologyNode(node, pos) {
  const icon = getDeviceIcon(node.type)
  const typeName = getDeviceTypeName(node.type)
  const statusLabel = getTopologyNodeStatusLabel(node)
  // SPF 路由信息徽标：直达显示 metric，多跳显示下一跳
  const viaOther = node.routeNextHopId && node.routePath && node.routePath.length > 2
  const routeChip = node.routeMetric
    ? `<span class="topology-node-route" title="SPF metric ${escapeHtml(String(node.routeMetric))}${viaOther ? `，经 ${escapeHtml(node.routeNextHopName || '')} 中继` : ''}">${viaOther ? `经 ${escapeHtml(node.routeNextHopName || '中继')}` : `m ${escapeHtml(String(node.routeMetric))}`}</span>`
    : ''
  const tsBadge = isTailscaleHost(node.lastIP)
    ? '<span class="topology-node-ts" title="通过 Tailscale 虚拟网连接">TS</span>'
    : ''
  return `
    <div class="topology-directed-node status-${escapeHtml(node.status || 'offline')} role-${escapeHtml(node.role || 'remote')}"
      style="left:${pos.x / 10}%; top:${pos.y}px"
      data-topology-node-id="${escapeHtml(node.id)}"
      tabindex="0"
      title="${escapeHtml(buildTopologyNodeTitle(node))}">
      <div class="topology-node-icon">${icon}</div>
      <div class="topology-node-main">
        <div class="topology-node-name">${escapeHtml(node.name || node.id)}${tsBadge}</div>
        <div class="topology-node-meta">${escapeHtml(typeName)} · ${escapeHtml(statusLabel)}${routeChip}</div>
      </div>
      <span class="topology-node-dot"></span>
    </div>
  `
}

// Tailscale 的 CGNAT 段 100.64.0.0/10
function isTailscaleHost(address) {
  const parts = String(address || '').trim().split('.').map(Number)
  return parts.length === 4 && parts.every(Number.isFinite) &&
    parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127
}

function addRecentCodeTopology(nodeMap, edgeMap, code, localNodeId) {
  const sourceId = code.sourceDeviceId || code.phoneId
  if (!sourceId) return

  mergeTopologyViewNode(nodeMap, {
    id: sourceId,
    name: code.sourceDeviceName || code.phoneName || '未知手机',
    type: code.sourceDeviceType || 'ANDROID_PHONE',
    role: 'source',
    status: 'synced',
    authority: code.pushAuthority || 'source_device',
    lastSeen: code.timestamp || Date.now()
  })

  const targetDevices = Array.isArray(code.targetDevices) && code.targetDevices.length > 0
    ? code.targetDevices
    : [{
        id: code.targetDeviceId || localNodeId,
        name: code.targetDeviceName || '当前设备',
        type: code.targetDeviceType || 'WINDOWS_DESKTOP'
      }]

  targetDevices.forEach(target => {
    const targetId = target?.id || target?.deviceId
    if (!targetId) return
    mergeTopologyViewNode(nodeMap, {
      id: targetId,
      name: target.name || target.deviceName || (targetId === localNodeId ? '当前设备' : targetId),
      type: target.type || target.deviceType || 'WINDOWS_DESKTOP',
      role: targetId === localNodeId ? 'local_desktop' : 'desktop',
      status: targetId === localNodeId ? 'online' : 'offline',
      lastSeen: code.timestamp || Date.now()
    })
    addTopologyViewEdge(edgeMap, {
      id: `${sourceId}->${targetId}:recent-${code.type || 'sms'}`,
      from: sourceId,
      to: targetId,
      type: 'recent_verify',
      label: code.type === 'totp' ? '最近 TOTP 推送' : '最近短信推送',
      enabled: true,
      active: false,
      authority: code.pushAuthority || 'source_device',
      updatedAt: code.timestamp || Date.now(),
      count: 1
    })
  })
}

function mergeTopologyViewNode(nodeMap, node) {
  if (!node || !node.id) return
  const normalized = {
    id: String(node.id),
    name: node.name || node.id,
    type: node.type || 'ANDROID_PHONE',
    role: node.role || 'remote',
    status: node.status || 'offline',
    statusLabel: node.statusLabel || getTopologyStatusLabel(node.status || 'offline'),
    authority: node.authority || '',
    enabled: node.enabled,
    revoked: node.revoked,
    connected: node.connected,
    lastSeen: node.lastSeen || 0,
    lastIP: node.lastIP || '',
    routeMetric: node.routeMetric || 0,
    routeHopCount: node.routeHopCount || 0,
    routeNextHopId: node.routeNextHopId || '',
    routeNextHopName: node.routeNextHopName || '',
    routePath: Array.isArray(node.routePath) ? node.routePath : [],
    routePathLabels: Array.isArray(node.routePathLabels) ? node.routePathLabels : [],
    contentPolicy: normalizeTopologyContentPolicy(node.contentPolicy || node)
  }
  const existing = nodeMap.get(normalized.id)
  if (!existing) {
    nodeMap.set(normalized.id, normalized)
    return
  }
  const preferredStatus = getTopologyStatusRank(existing.status) >= getTopologyStatusRank(normalized.status)
    ? existing.status
    : normalized.status
  nodeMap.set(normalized.id, {
    ...existing,
    ...normalized,
    name: normalized.name || existing.name,
    type: normalized.type || existing.type,
    role: existing.role === 'local_desktop' ? existing.role : normalized.role,
    status: preferredStatus,
    statusLabel: getTopologyStatusLabel(preferredStatus),
    lastSeen: Math.max(existing.lastSeen || 0, normalized.lastSeen || 0),
    lastIP: normalized.lastIP || existing.lastIP || '',
    routeMetric: normalized.routeMetric || existing.routeMetric || 0,
    routeHopCount: normalized.routeHopCount || existing.routeHopCount || 0,
    routeNextHopId: normalized.routeNextHopId || existing.routeNextHopId || '',
    routeNextHopName: normalized.routeNextHopName || existing.routeNextHopName || '',
    routePath: normalized.routePath.length ? normalized.routePath : (existing.routePath || []),
    routePathLabels: normalized.routePathLabels.length ? normalized.routePathLabels : (existing.routePathLabels || []),
    contentPolicy: normalized.contentPolicy || existing.contentPolicy
  })
}

function normalizeTopologyContentPolicy(policy = {}) {
  const allowClipboardText = policy.allowClipboardText !== false && policy.allowClipboard !== false
  const hasClipboardImagePolicy = Object.prototype.hasOwnProperty.call(policy, 'allowClipboardImage') ||
    Object.prototype.hasOwnProperty.call(policy, 'allowImages')
  return {
    allowSmsCodes: policy.allowSmsCodes !== false,
    allowSmsMessages: policy.allowSmsMessages !== false,
    allowNotifications: policy.allowNotifications !== false,
    allowTotp: policy.allowTotp !== false,
    allowClipboard: allowClipboardText,
    allowClipboardText,
    allowClipboardImage: hasClipboardImagePolicy
      ? policy.allowClipboardImage !== false && policy.allowImages !== false && policy.allowClipboard !== false
      : policy.allowClipboard !== false,
    allowClipboardFile: policy.allowClipboardFile === true,
    allowFileTransfer: policy.allowFileTransfer === true
  }
}

function formatTopologyContentPolicy(policy = {}) {
  const normalized = normalizeTopologyContentPolicy(policy)
  const items = []
  if (normalized.allowSmsCodes) items.push('验证码')
  if (normalized.allowSmsMessages) items.push('短信')
  if (normalized.allowNotifications) items.push('通知')
  if (normalized.allowTotp) items.push('TOTP')
  if (normalized.allowClipboardText) items.push('剪贴板文本')
  if (normalized.allowClipboardImage) items.push('剪贴板图片')
  if (normalized.allowClipboardFile || normalized.allowFileTransfer) items.push('文件')
  return items.length ? items.join('、') : '不推送'
}

function addTopologyViewEdge(edgeMap, edge) {
  if (!edge || !edge.from || !edge.to) return
  const endpoints = [String(edge.from), String(edge.to)].sort()
  const key = `${endpoints[0]}--${endpoints[1]}:${edge.type || 'sync'}`
  const existing = edgeMap.get(key)
  if (existing) {
    edgeMap.set(key, {
      ...existing,
      active: existing.active || edge.active === true,
      partiallyActive: existing.partiallyActive || edge.partiallyActive === true,
      routable: existing.routable === true || edge.routable === true,
      enabled: existing.enabled !== false && edge.enabled !== false,
      updatedAt: Math.max(existing.updatedAt || 0, edge.updatedAt || 0),
      metric: Math.min(existing.metric || edge.metric || 0, edge.metric || existing.metric || 0),
      count: (existing.count || 1) + (edge.count || 1)
    })
    return
  }
  edgeMap.set(key, {
    ...edge,
    id: key,
    label: edge.label || '同步',
    type: edge.type || 'sync',
    enabled: edge.enabled !== false,
    active: edge.active === true,
    partiallyActive: edge.partiallyActive === true,
    routable: edge.routable === true,
    authority: edge.authority || '',
    updatedAt: edge.updatedAt || 0,
    count: edge.count || 1
  })
}

function renderTopologyLane(title, nodes) {
  const body = nodes.length > 0
    ? nodes.map(renderTopologyNode).join('')
    : '<div class="topology-lane-empty">暂无节点</div>'
  return `
    <section class="topology-lane">
      <div class="topology-lane-title">${escapeHtml(title)}</div>
      <div class="topology-lane-body">${body}</div>
    </section>
  `
}

function renderTopologyNode(node) {
  const icon = getDeviceIcon(node.type)
  const typeName = getDeviceTypeName(node.type)
  const statusLabel = getTopologyNodeStatusLabel(node)
  const authorityLabel = getAuthorityLabel(node.authority)
  const meta = [typeName, statusLabel, authorityLabel].filter(Boolean).join(' · ')
  const extra = node.lastIP ? `<div class="topology-node-extra">${escapeHtml(node.lastIP)}</div>` : ''
  return `
    <div class="topology-node status-${escapeHtml(node.status || 'offline')} role-${escapeHtml(node.role || 'remote')}"
      data-topology-node-id="${escapeHtml(node.id)}"
      tabindex="0"
      title="${escapeHtml(buildTopologyNodeTitle(node))}">
      <div class="topology-node-icon">${icon}</div>
      <div class="topology-node-main">
        <div class="topology-node-name">${escapeHtml(node.name || node.id)}</div>
        <div class="topology-node-meta">${escapeHtml(meta)}</div>
        ${extra}
      </div>
      <span class="topology-node-dot"></span>
    </div>
  `
}

function renderTopologyNodeDetail(nodeId, options = {}) {
  const detailEl = document.getElementById('topology-node-detail')
  if (!detailEl) return

  const view = buildTopologyViewModel()
  const node = nodeId ? view.nodeMap.get(String(nodeId)) : null
  if (!node) {
    if (!options.transient) {
      detailEl.innerHTML = '<div class="topology-node-detail-empty">点击或悬停节点查看设备详情</div>'
    }
    return
  }

  const relatedEdges = view.edges.filter(edge =>
    String(edge.from) === String(node.id) || String(edge.to) === String(node.id)
  )
  const typeName = getDeviceTypeName(node.type)
  const statusLabel = getTopologyNodeStatusLabel(node)
  const authorityLabel = getAuthorityLabel(node.authority)
  const lastSyncText = node.lastSeen ? formatFullTime(node.lastSeen) : '暂无同步记录'
  const routePathText = Array.isArray(node.routePath) && node.routePath.length > 0
    ? node.routePath.map(id => view.nodeMap.get(String(id))?.name || id).join(' → ')
    : ''
  const edgeRows = relatedEdges.length > 0
    ? relatedEdges.slice(0, 6).map(edge => {
      const fromNode = view.nodeMap.get(String(edge.from)) || { name: edge.from, type: 'ANDROID_PHONE' }
      const toNode = view.nodeMap.get(String(edge.to)) || { name: edge.to, type: 'WINDOWS_DESKTOP' }
      const state = edge.active ? '活跃' : (edge.enabled ? '待同步' : '已停用')
      return `
        <div class="topology-node-detail-edge">
          <span>连接</span>
          <strong>${escapeHtml(fromNode.name || edge.from)} -- ${escapeHtml(toNode.name || edge.to)}</strong>
          <em>${escapeHtml(edge.label || '同步')} · ${escapeHtml(state)}</em>
        </div>
      `
    }).join('')
    : '<div class="topology-node-detail-muted">暂无关联链路</div>'

  detailEl.innerHTML = `
    <div class="topology-node-detail-header">
      <span class="topology-node-detail-icon">${getDeviceIcon(node.type)}</span>
      <div>
        <div class="topology-node-detail-name">${escapeHtml(node.name || node.id)}</div>
        <div class="topology-node-detail-meta">${escapeHtml(typeName)} · ${escapeHtml(statusLabel)}</div>
      </div>
    </div>
    <div class="topology-node-detail-grid">
      <div><span>节点 ID</span><strong title="${escapeHtml(node.id)}">${escapeHtml(shortenId(node.id))}</strong></div>
      <div><span>角色</span><strong>${escapeHtml(getTopologyRoleLabel(node.role))}</strong></div>
      <div><span>最后同步</span><strong>${escapeHtml(lastSyncText)}</strong></div>
      <div><span>最后地址</span><strong>${escapeHtml(node.lastIP || '无')}${isTailscaleHost(node.lastIP) ? '（Tailscale）' : ''}</strong></div>
      <div><span>权限</span><strong>${escapeHtml(authorityLabel || '默认')}</strong></div>
      <div><span>状态</span><strong>${escapeHtml(node.enabled === false ? '已禁用' : node.revoked ? '已撤销' : '可用')}</strong></div>
      <div><span>SPF Metric</span><strong>${escapeHtml(node.routeMetric ? String(node.routeMetric) : '本机/未计算')}</strong></div>
      <div><span>下一跳</span><strong>${escapeHtml(node.routeNextHopName || '无')}</strong></div>
      <div><span>路由路径</span><strong>${escapeHtml(routePathText || '无')}</strong></div>
      <div><span>推送策略</span><strong>${escapeHtml(formatTopologyContentPolicy(node.contentPolicy))}</strong></div>
    </div>
    <div class="topology-node-detail-section">
      <div class="topology-node-detail-section-title">相关链路</div>
      ${edgeRows}
    </div>
  `
}

function buildTopologyNodeTitle(node) {
  return [
    node.name || node.id,
    getDeviceTypeName(node.type),
    getTopologyNodeStatusLabel(node),
    node.lastSeen ? `上次同步 ${formatFullTime(node.lastSeen)}` : '暂无同步记录',
    node.lastIP ? `地址 ${node.lastIP}` : ''
  ].filter(Boolean).join('\n')
}

function renderTopologyEdge(edge, nodeMap) {
  const fromNode = nodeMap.get(String(edge.from)) || { name: edge.from, type: 'ANDROID_PHONE' }
  const toNode = nodeMap.get(String(edge.to)) || { name: edge.to, type: 'WINDOWS_DESKTOP' }
  const authority = getAuthorityLabel(edge.authority)
  const count = edge.count > 1 ? ` · ${edge.count} 次` : ''
  const metric = edge.metric ? ` · metric ${edge.metric}` : ''
  const statusText = getTopologyEdgeStateLabel(edge)
  const edgeState = getTopologyEdgeState(edge)
  const className = [
    'topology-edge',
    `state-${edgeState}`,
    edgeState === 'online' ? 'active' : '',
    edgeState === 'partial' ? 'partial' : '',
    edge.enabled ? '' : 'disabled'
  ].filter(Boolean).join(' ')

  return `
    <div class="${className}">
      <div class="topology-edge-route">
        <span class="topology-edge-node">${getDeviceIcon(fromNode.type)} ${escapeHtml(fromNode.name || edge.from)}</span>
        <span class="topology-edge-arrow">--</span>
        <span class="topology-edge-node">${getDeviceIcon(toNode.type)} ${escapeHtml(toNode.name || edge.to)}</span>
      </div>
      <div class="topology-edge-detail">
        <span>${escapeHtml(edge.label || '同步')}</span>
        <span>${escapeHtml(statusText)}${escapeHtml(metric)}${authority ? ` · ${escapeHtml(authority)}` : ''}${escapeHtml(count)}</span>
      </div>
    </div>
  `
}

function isPhoneNode(node) {
  return String(node.type || '').includes('PHONE') || node.role === 'phone'
}

function sortTopologyNodes(a, b) {
  return getTopologyStatusSortRank(b.status) - getTopologyStatusSortRank(a.status) ||
    String(a.name || '').localeCompare(String(b.name || ''), 'zh-CN')
}

function getTopologyStatusSortRank(status) {
  return ({
    online: 5,
    reachable: 4,
    synced: 3,
    discovered: 2,
    offline: 1,
    disabled: 0,
    revoked: -1
  }[status] || 0)
}

function getTopologyStatusRank(status) {
  return ({
    revoked: 7,
    disabled: 6,
    online: 5,
    reachable: 4,
    synced: 3,
    discovered: 2,
    offline: 1
  }[status] || 0)
}

function getTopologyStatusLabel(status) {
  return {
    online: '在线',
    reachable: '可路由',
    offline: '离线',
    disabled: '已禁用',
    revoked: '已撤销',
    discovered: '已发现',
    synced: '已同步'
  }[status] || '未知'
}

function getTopologyNodeStatusLabel(node) {
  if (!node) return '未知'
  if (node.status === 'online') return '在线'
  if (node.status === 'reachable') return node.lastSeen ? `可路由 · 上次同步 ${formatRelativeTime(node.lastSeen)}` : '可路由 · 未在线'
  if (node.status === 'disabled') return '已禁用'
  if (node.status === 'revoked') return '已撤销'
  if (node.status === 'discovered') return '已发现 · 未配对'
  if (node.status === 'synced') return node.lastSeen ? `已同步 ${formatRelativeTime(node.lastSeen)}` : '已同步'
  if (node.lastSeen) return `上次同步 ${formatRelativeTime(node.lastSeen)}`
  return '等待首次同步'
}

function getTopologyRoleLabel(role) {
  return {
    local_desktop: '本机节点',
    phone: '手机',
    source: '来源设备',
    desktop: '桌面节点',
    remote: '远端设备'
  }[role] || '设备'
}

function getAuthorityLabel(authority) {
  return {
    source_device: '来源设备控制',
    local_desktop: '本机控制',
    desktop_owner: '节点端控制'
  }[authority] || ''
}

function shortenId(id) {
  const text = String(id || '')
  if (text.length <= 18) return text
  return `${text.slice(0, 8)}…${text.slice(-6)}`
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
  const container = document.getElementById('totp-list')

  for (const interval of totpIntervals.values()) {
    clearInterval(interval)
  }
  totpIntervals.clear()

  if (desktopTotps.length > 0) {
    renderDesktopTotps(container)
    updateSettingsStats()
    return
  }

  const totpCodes = codes.filter(c => c.type === 'totp')
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
    // 按需模型：当前节点只持有手机推来的码快照，无法本地重算。
    // 若推送时间已不在当前 30s 周期内，该码必然已过期，给出明确提示。
    const expired = !c.timestamp || (Date.now() - c.timestamp) > period
    const title = getTotpDisplayTitle(c)
    const account = getTotpAccountText(c)
    const sourceType = c.sourceDeviceType || 'ANDROID_PHONE'
    const sourceName = c.sourceDeviceName || c.phoneName || '未知手机'
    const sourceIcon = getDeviceIcon(sourceType)
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
          <div class="totp-title-row">
            <div class="totp-label" title="${escapeHtml(c.label || title)}">${escapeHtml(title)}</div>
            <span class="totp-origin-pill remote">推送</span>
          </div>
          ${account ? `<div class="totp-account" title="${escapeHtml(account)}">${escapeHtml(account)}</div>` : ''}
          <div class="totp-source-row">
            <div class="totp-source-badge" data-type="${escapeHtml(sourceType)}">
              <span class="source-device-icon">${sourceIcon}</span>
              <span class="totp-source-name">${escapeHtml(sourceName)}</span>
            </div>
          </div>
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

function renderDesktopTotps(container) {
  container.innerHTML = desktopTotps.map(c => {
    const progress = Number.isFinite(c.progress) ? c.progress : 1
    const circumference = 2 * Math.PI * 16
    const offset = circumference * (1 - progress)
    const remaining = Number.isFinite(c.remaining) ? c.remaining : ''
    const id = `totp-${hashString(c.id || getTotpKey(c))}`

    // 来源标注（Phase 2）：显示该条目来自哪台设备。
    // 本机创建的（isLocal）拥有最高权限；远程同步来的删除只影响本机展示。
    const sourceType = c.sourceDeviceType || (c.isLocal ? 'WINDOWS_DESKTOP' : 'ANDROID_PHONE')
    const sourceName = c.sourceDeviceName || c.phoneName || '未知设备'
    const sourceIcon = getDeviceIcon(sourceType)
    const title = getTotpDisplayTitle(c)
    const account = getTotpAccountText(c)
    const originText = c.isLocal ? '本机' : '同步'
    const originClass = c.isLocal ? 'local' : 'remote'
    const permissionTag = c.isLocal
      ? '<span class="source-local-tag">可管理</span>'
      : '<span class="readonly-badge">可隐藏</span>'
    const pinBtn = `<button class="totp-pin-btn ${c.isPinned ? 'active' : ''}" data-action="pin-totp" title="${c.isPinned ? '取消置顶' : '置顶'}">${c.isPinned ? '★' : '☆'}</button>`
    const editBtn = c.canEdit
      ? `<button class="totp-edit-btn" data-action="edit-totp" title="编辑">✎</button>`
      : ''
    const deleteBtn = c.canDelete
      ? `<button class="totp-delete-btn" data-action="delete-totp" title="删除">🗑</button>`
      : ''
    return `
      <div class="totp-item" data-id="${id}" data-totp-id="${escapeHtml(c.id || '')}">
        <div class="totp-progress">
          <svg width="40" height="40" viewBox="0 0 40 40">
            <circle class="bg" cx="20" cy="20" r="16"></circle>
            <circle class="fg" cx="20" cy="20" r="16"
              stroke-dasharray="${circumference}" stroke-dashoffset="${offset}"></circle>
            <text class="remaining" x="20" y="20" dy=".35em">${remaining}s</text>
          </svg>
        </div>
        <div class="totp-main">
          <div class="totp-title-row">
            <div class="totp-label" title="${escapeHtml(c.label || title)}">${escapeHtml(title)}</div>
            <span class="totp-origin-pill ${originClass}">${originText}</span>
          </div>
          ${account ? `<div class="totp-account" title="${escapeHtml(account)}">${escapeHtml(account)}</div>` : ''}
          <div class="totp-source-row">
            <div class="totp-source-badge" data-type="${escapeHtml(sourceType)}">
              <span class="source-device-icon">${sourceIcon}</span>
              <span class="totp-source-name">${escapeHtml(sourceName)}</span>
              ${permissionTag}
            </div>
          </div>
        </div>
        <div class="totp-code" data-copy-value="${escapeHtml(c.code)}">${escapeHtml(c.code)}</div>
        <div class="totp-actions-inline">
          ${pinBtn}
          ${editBtn}
          ${deleteBtn}
        </div>
      </div>
    `
  }).join('')

  container.querySelectorAll('.totp-item').forEach(item => {
    item.addEventListener('click', function(e) {
      // 点击删除按钮时不触发复制
      if (e.target.closest('[data-action="delete-totp"]')) return
      if (e.target.closest('[data-action="pin-totp"]')) return
      if (e.target.closest('[data-action="edit-totp"]')) return
      const codeEl = this.querySelector('.totp-code')
      if (codeEl) {
        window.electronAPI.copyToClipboard(codeEl.dataset.copyValue || codeEl.textContent)
      }
    })
    const delBtn = item.querySelector('[data-action="delete-totp"]')
    const editButton = item.querySelector('[data-action="edit-totp"]')
    const pinButton = item.querySelector('[data-action="pin-totp"]')
    if (pinButton) {
      pinButton.addEventListener('click', async (e) => {
        e.stopPropagation()
        const totpId = item.dataset.totpId
        if (!totpId) return
        const totp = desktopTotps.find(entry => entry.id === totpId)
        try {
          pinButton.disabled = true
          await window.electronAPI.updateTotp(totpId, {
            pinnedAt: totp?.isPinned ? 0 : Date.now()
          })
          await refreshDesktopTotps()
        } catch (error) {
          console.error('Failed to pin TOTP:', error)
          showNotification('置顶失败', error.message || '更新置顶状态失败')
        } finally {
          pinButton.disabled = false
        }
      })
    }
    if (editButton) {
      editButton.addEventListener('click', (e) => {
        e.stopPropagation()
        const totpId = item.dataset.totpId
        const totp = desktopTotps.find(entry => entry.id === totpId)
        if (totp) showEditTotpDialog(totp)
      })
    }
    if (delBtn) {
      delBtn.addEventListener('click', async (e) => {
        e.stopPropagation()
        const totpId = item.dataset.totpId
        if (!totpId) return
        const totp = desktopTotps.find(entry => entry.id === totpId)
        const label = totp?.label || '这条 TOTP'
        const confirmMessage = totp?.isLocal
          ? `删除「${label}」？这会同步删除其它设备上的这个 TOTP 副本。`
          : `从本机隐藏「${label}」？来源设备不会受影响。`
        if (!window.confirm(confirmMessage)) return

        delBtn.disabled = true
        try {
          const removed = await window.electronAPI.deleteTotp(totpId)
          if (!removed) {
            showNotification('删除失败', '没有找到这条 TOTP')
            return
          }
          showNotification(totp?.isLocal ? '已删除' : '已隐藏', label)
          await refreshDesktopTotps()
        } catch (error) {
          console.error('Failed to delete TOTP:', error)
          showNotification('删除失败', error.message || '删除 TOTP 失败')
        } finally {
          delBtn.disabled = false
        }
      })
    }
  })

  if (windowVisible) {
    const interval = setInterval(async () => {
      await refreshDesktopTotps()
    }, 1000)
    totpIntervals.set('desktop-totps', interval)
  }
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

function showEditTotpDialog(totp) {
  const existing = document.querySelector('.totp-edit-dialog')
  if (existing) existing.remove()

  const dialog = document.createElement('div')
  dialog.className = 'totp-edit-dialog'
  dialog.innerHTML = `
    <div class="dialog-content">
      <div class="dialog-title">编辑 TOTP</div>
      <div class="dialog-body totp-edit-form">
        <label>
          <span>说明</span>
          <input data-field="label" value="${escapeHtml(totp.label || '')}" maxlength="120">
        </label>
        <label>
          <span>发行方</span>
          <input data-field="issuer" value="${escapeHtml(totp.issuer || '')}" maxlength="80">
        </label>
        <label>
          <span>账号</span>
          <input data-field="accountName" value="${escapeHtml(totp.accountName || '')}" maxlength="120">
        </label>
        <label>
          <span>算法</span>
          <select data-field="algorithm">
            ${['SHA1', 'SHA256', 'SHA512'].map(value =>
              `<option value="${value}" ${totp.algorithm === value ? 'selected' : ''}>${value}</option>`
            ).join('')}
          </select>
        </label>
        <div class="totp-edit-grid">
          <label>
            <span>位数</span>
            <select data-field="digits">
              ${[6, 8].map(value =>
                `<option value="${value}" ${Number(totp.digits) === value ? 'selected' : ''}>${value}</option>`
              ).join('')}
            </select>
          </label>
          <label>
            <span>周期</span>
            <input data-field="period" type="number" min="15" max="120" step="1" value="${Number(totp.period || 30)}">
          </label>
        </div>
      </div>
      <div class="dialog-actions">
        <button class="btn-dialog btn-secondary" data-action="cancel">取消</button>
        <button class="btn-dialog btn-primary" data-action="save">保存</button>
      </div>
    </div>
  `

  document.body.appendChild(dialog)
  dialog.querySelector('[data-action="cancel"]')?.addEventListener('click', () => dialog.remove())
  dialog.querySelector('[data-action="save"]')?.addEventListener('click', async () => {
    await saveTotpEdit(dialog, totp.id)
  })
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) dialog.remove()
  })
}

async function saveTotpEdit(dialog, totpId) {
  const valueOf = (field) => dialog.querySelector(`[data-field="${field}"]`)?.value?.trim() || ''
  const updates = {
    label: valueOf('label') || 'TOTP',
    issuer: valueOf('issuer'),
    accountName: valueOf('accountName'),
    algorithm: valueOf('algorithm') || 'SHA1',
    digits: Number(valueOf('digits') || 6),
    period: Number(valueOf('period') || 30)
  }

  try {
    const result = await window.electronAPI.updateTotp(totpId, updates)
    if (!result) {
      showNotification('保存失败', '没有找到这条 TOTP')
      return
    }
    dialog.remove()
    showNotification('已保存', updates.label)
    await refreshDesktopTotps()
  } catch (error) {
    console.error('Failed to update TOTP:', error)
    showNotification('保存失败', error.message || '更新 TOTP 失败')
  }
}

function updateConnectionStatusFromPhones() {
  const connectedCount = authorizedPhones.filter(phone =>
    phone.connected === true &&
    phone.enabled !== false &&
    phone.revoked !== true
  ).length
  updateConnectionStatus(connectedCount > 0, connectedCount)
  updateSettingsStats()
}

function updateConnectionStatus(connected, count = 0) {
  const statusEl = document.getElementById('connection-status')
  const statusDetailEl = document.getElementById('connection-status-detail')

  const statusClass = connected ? 'status-connected' : 'status-disconnected'
  const statusText = connected
    ? (count > 1 ? `● 已连接 ${count} 台设备` : '● 已连接')
    : `● ${getLastSyncStatusText()}`

  if (statusEl) {
    statusEl.className = statusClass
    statusEl.textContent = statusText
  }

  if (statusDetailEl) {
    statusDetailEl.className = statusClass
    statusDetailEl.textContent = statusText
  }
}

function getLastSyncStatusText() {
  const lastSync = getLastSyncTimestamp()
  return lastSync ? `上次同步 ${formatRelativeTime(lastSync)}` : '等待首次同步'
}

function getLastSyncTimestamp() {
  const phoneTimes = authorizedPhones.map(phone => phone.lastSeen || 0)
  const codeTimes = codes.map(code => code.timestamp || 0)
  const totpTimes = desktopTotps.map(totp => totp.updatedAt || totp.timestamp || 0)
  const topologyTimes = (topologySnapshot?.nodes || []).map(node => node.lastSeen || 0)
  return Math.max(0, ...phoneTimes, ...codeTimes, ...totpTimes, ...topologyTimes)
}

function updateSettingsStats() {
  const statsPhones = document.getElementById('stats-phones')
  const statsSms = document.getElementById('stats-sms')
  const statsTotp = document.getElementById('stats-totp')

  if (statsPhones) {
    statsPhones.textContent = `${authorizedPhones.length} 台`
  }

  if (statsSms) {
    const smsCount = codes.filter(c => c.type !== 'totp').length
    statsSms.textContent = `${smsCount} 条`
  }

  if (statsTotp) {
    const totpCount = desktopTotps.length > 0 ? desktopTotps.length : codes.filter(c => c.type === 'totp').length
    statsTotp.textContent = `${totpCount} 个`
  }
}

function updatePairingAddress(info) {
  const addressEl = document.getElementById('pairing-address')
  if (!addressEl) return
  if (!info?.host || !info?.port) {
    addressEl.textContent = ''
    return
  }
  const lines = [`二维码地址: ws://${info.host}:${info.port}`]
  if (info.tsHost) {
    lines.push(`Tailscale: ws://${info.tsHost}:${info.port}（跨网段设备经 Tailscale 连接）`)
  }
  addressEl.textContent = lines.join('\n')
  addressEl.style.whiteSpace = 'pre-line'
}

function getPhoneState(phone) {
  if (phone.revoked) return { label: '已撤销', className: 'phone-revoked' }
  if (phone.enabled === false) return { label: '已禁用', className: 'phone-disabled' }
  if (phone.connected) return { label: '在线', className: 'phone-connected' }
  return {
    label: phone.lastSeen ? `上次 ${formatRelativeTime(phone.lastSeen)}` : '等待同步',
    className: 'phone-offline'
  }
}

function getCodePhoneKey(codeInfo) {
  return codeInfo.phoneId || codeInfo.phoneName || 'unknown-phone'
}

function getRawMessage(codeInfo) {
  if (!codeInfo) return ''
  return codeInfo.rawMessage || codeInfo.messageBody || codeInfo.body || ''
}

function getContentTypeLabel(type) {
  return {
    sms: '验证码短信',
    sms_message: '普通短信',
    app_notification: 'App 通知',
    clipboard: '剪贴板',
    clipboard_text: '剪贴板文本',
    clipboard_image: '剪贴板图片',
    clipboard_file: '剪贴板文件',
    file_transfer: '文件传输'
  }[type] || '消息'
}

function getMessageSourceText(codeInfo) {
  if (!codeInfo) return '未知来源'
  const contentType = codeInfo.contentType || codeInfo.type || 'sms'
  if (contentType === 'app_notification') {
    return [codeInfo.appName || codeInfo.source || '通知', codeInfo.packageName || '']
      .filter(Boolean)
      .join(' · ')
  }
  return codeInfo.source || '未知来源'
}

function getCopyValueForMessage(codeInfo) {
  if (!codeInfo) return ''
  const contentType = codeInfo.contentType || codeInfo.type || 'sms'
  if (contentType === 'sms') return codeInfo.code || getRawMessage(codeInfo)
  const title = codeInfo.title ? `${codeInfo.title}\n` : ''
  return `${title}${getRawMessage(codeInfo) || codeInfo.source || ''}`.trim()
}

function getTotpDisplayTitle(codeInfo) {
  const issuer = String(codeInfo.issuer || '').trim()
  const label = String(codeInfo.label || '').trim()
  if (issuer) return issuer
  if (!label) return 'TOTP'

  const separatorIndex = label.indexOf(':')
  if (separatorIndex > 0) {
    return label.slice(0, separatorIndex).trim() || label
  }
  return label
}

function getTotpAccountText(codeInfo) {
  const accountName = String(codeInfo.accountName || '').trim()
  if (accountName) return accountName

  const issuer = String(codeInfo.issuer || '').trim()
  const label = String(codeInfo.label || '').trim()
  if (!label) return ''

  if (issuer && label.toLowerCase().startsWith(issuer.toLowerCase())) {
    return label.slice(issuer.length).replace(/^[:：\s-]+/, '').trim()
  }

  const separatorIndex = label.indexOf(':')
  if (separatorIndex > 0 && separatorIndex < label.length - 1) {
    return label.slice(separatorIndex + 1).trim()
  }
  return ''
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

function formatRelativeTime(timestamp) {
  if (!timestamp) return ''
  const delta = Date.now() - timestamp
  if (delta < 60000) return '刚刚'
  if (delta < 3600000) return `${Math.floor(delta / 60000)} 分钟前`
  const time = new Date(timestamp)
  const today = new Date()
  const isToday = time.toDateString() === today.toDateString()
  const hm = `${time.getHours().toString().padStart(2, '0')}:${time.getMinutes().toString().padStart(2, '0')}`
  if (isToday) return `今天 ${hm}`
  return `${time.getMonth() + 1}-${time.getDate()} ${hm}`
}

function formatFullTime(timestamp) {
  if (!timestamp) return ''
  const time = new Date(timestamp)
  const pad = value => String(value).padStart(2, '0')
  return `${time.getFullYear()}-${pad(time.getMonth() + 1)}-${pad(time.getDate())} ${pad(time.getHours())}:${pad(time.getMinutes())}:${pad(time.getSeconds())}`
}

function formatBytesCompact(bytes) {
  const value = Number(bytes || 0)
  if (!Number.isFinite(value) || value <= 0) return ''
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`
  return `${(value / 1024 / 1024 / 1024).toFixed(1)} GB`
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

function cssEscape(text) {
  if (window.CSS && typeof window.CSS.escape === 'function') {
    return window.CSS.escape(String(text))
  }
  return String(text).replace(/["\\]/g, '\\$&')
}

window.copyCode = copyCode
