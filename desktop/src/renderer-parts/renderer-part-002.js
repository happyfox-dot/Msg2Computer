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
    discoveredOnly: node.discoveredOnly === true,
    statusLabel: node.statusLabel || getTopologyStatusLabel(node),
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
  const existingRank = getTopologyStatusRank(existing)
  const normalizedRank = getTopologyStatusRank(normalized)
  const preferredStatus = existingRank >= normalizedRank ? existing.status : normalized.status
  const preferredDiscoveredOnly = existingRank >= normalizedRank
    ? existing.discoveredOnly === true
    : normalized.discoveredOnly === true
  nodeMap.set(normalized.id, {
    ...existing,
    ...normalized,
    name: normalized.name || existing.name,
    type: normalized.type || existing.type,
    role: existing.role === 'local_desktop' ? existing.role : normalized.role,
    status: preferredStatus,
    discoveredOnly: preferredDiscoveredOnly,
    statusLabel: getTopologyStatusLabel({
      status: preferredStatus,
      discoveredOnly: preferredDiscoveredOnly
    }),
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
  return getTopologyStatusSortRank(b) - getTopologyStatusSortRank(a) ||
    String(a.name || '').localeCompare(String(b.name || ''), 'zh-CN')
}

function getTopologyStatusSortRank(nodeOrStatus) {
  const status = typeof nodeOrStatus === 'string' ? nodeOrStatus : nodeOrStatus?.status
  const discoveredOnly = typeof nodeOrStatus === 'object' && nodeOrStatus?.discoveredOnly === true
  return ({
    online: 5,
    reachable: 4,
    known: discoveredOnly ? 2 : 3,
    synced: 2,
    offline: 1,
    disabled: 0,
    revoked: -1
  }[status] || 0)
}

function getTopologyStatusRank(nodeOrStatus) {
  const status = typeof nodeOrStatus === 'string' ? nodeOrStatus : nodeOrStatus?.status
  const discoveredOnly = typeof nodeOrStatus === 'object' && nodeOrStatus?.discoveredOnly === true
  return ({
    revoked: 7,
    disabled: 6,
    online: 5,
    reachable: 4,
    known: discoveredOnly ? 2 : 3,
    synced: 2,
    offline: 1
  }[status] || 0)
}

function getTopologyStatusLabel(nodeOrStatus) {
  const status = typeof nodeOrStatus === 'string' ? nodeOrStatus : nodeOrStatus?.status
  const discoveredOnly = typeof nodeOrStatus === 'object' && nodeOrStatus?.discoveredOnly === true
  if (status === 'known' && discoveredOnly) return '仅发现'
  return {
    online: '在线',
    reachable: '近期可达',
    known: '已知节点',
    offline: '离线',
    disabled: '已禁用',
    revoked: '已撤销',
    synced: '已同步'
  }[status] || '未知'
}

function getTopologyNodeStatusLabel(node) {
  if (!node) return '未知'
  if (node.status === 'online') return '在线'
  if (node.status === 'reachable') return node.lastSeen ? `近期可达 · 上次同步 ${formatRelativeTime(node.lastSeen)}` : '近期可达'
  if (node.status === 'known' && node.discoveredOnly === true) return '已发现 · 未配对'
  if (node.status === 'known') return node.lastSeen ? `已知节点 · 上次同步 ${formatRelativeTime(node.lastSeen)}` : '已知节点 · 当前未验证'
  if (node.status === 'disabled') return '已禁用'
  if (node.status === 'revoked') return '已撤销'
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
    app_notification_removed: 'App 通知结束',
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
  if (contentType === 'app_notification' || contentType === 'app_notification_removed') {
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
