        enabled: true,
        active: from.connected === true && to.connected === true,
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
    const peerStateAt = Math.max(
      Number(peer.connectionUpdatedAt || 0) || 0,
      Number(peer.lastSeen || 0) || 0,
      Number(peer.firstSeen || 0) || 0
    )
    const peerSeq = normalizeLsdbSeq(peerStateAt, now)
    const peerEnabled = peer.enabled !== false && !!peer.pairingKey && !!peer.host
    upsertTopologyLsdbNode({
      id: peer.id,
      name: peer.name || 'Desktop PC',
      type: peer.deviceType || 'WINDOWS_DESKTOP',
      role: 'desktop',
      host: peer.host,
      port: normalizeTopologyPort(peer.deviceType || 'WINDOWS_DESKTOP', peer.port || WS_PORT),
      wsPort: normalizeTopologyPort(peer.deviceType || 'WINDOWS_DESKTOP', peer.port || WS_PORT),
      relayPort: JOIN_PORT,
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
      updatedAt: peerStateAt,
      lastSeen: peer.lastSeen || peer.connectionUpdatedAt || 0
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
        updatedAt: peerStateAt,
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
      trustedNode.shouldRouteTrustedTopologyNode(node)
    )
}

function buildTopologyDelta(reason = 'full', options = {}) {
  syncLocalTopologyIntoLsdb('snapshot')
  const identity = getDesktopIdentity()
  const seq = options.seq || nextLsdbSequence()
  const ttl = Number.isFinite(options.ttl) ? options.ttl : TOPOLOGY_DELTA_TTL
  const now = Date.now()
  const mergeFromNetworkIds = uniqueNetworkIds([
    ...normalizeNetworkMergeIds(options.mergeFromNetworkIds || []),
    ...Array.from(pendingNetworkMergeFromIds)
  ]).filter(id => id !== ensureTrustedNetworkId())
  if (options.consumePendingMerge !== false) pendingNetworkMergeFromIds.clear()
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
    ...(mergeFromNetworkIds.length > 0 ? {
      networkMerge: true,
      mergeFromNetworkIds,
      mergedAt: now
    } : {}),
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
  if (sourceId && sourceId !== identity.id && !isKnownTrustedNode(sourceId)) return false
  const currentNetworkId = ensureTrustedNetworkId()
  const mergeFromNetworkIds = normalizeNetworkMergeIds(normalizedDelta.mergeFromNetworkIds || [])
  let networkMerged = false
  let pendingNetworkMerge = null
  if (deltaNetworkId && deltaNetworkId !== currentNetworkId) {
    const canMerge = normalizedDelta.networkMerge === true && mergeFromNetworkIds.includes(currentNetworkId)
    if (!canMerge) return false
    pendingNetworkMerge = { targetNetworkId: deltaNetworkId, mergeFromNetworkIds }
    normalizedDelta = rewriteTopologyDeltaNetwork(normalizedDelta, deltaNetworkId, mergeFromNetworkIds)
    networkMerged = true
  } else if (deltaNetworkId) {
    if (normalizedDelta.networkMerge === true && mergeFromNetworkIds.length > 0) {
      pendingNetworkMerge = { targetNetworkId: deltaNetworkId, mergeFromNetworkIds }
      networkMerged = true
    }
    normalizedDelta = rewriteTopologyDeltaNetwork(normalizedDelta, deltaNetworkId, mergeFromNetworkIds)
  }
  const seq = Number(normalizedDelta.seq || 0)
  let acceptedNewSeq = false
  if (sourceId && sourceId !== identity.id && seq > 0) {
    const lastSeq = topologyLsdb.seenSeq.get(sourceId) || 0
    if (seq <= lastSeq) return false
    acceptedNewSeq = true
  }

  let changed = networkMerged
  const nodes = Array.isArray(normalizedDelta.nodes) ? normalizedDelta.nodes : []
  const links = Array.isArray(normalizedDelta.links) ? normalizedDelta.links : []
  topologyBroadcastSuppressionDepth += 1
  try {
    for (const rawNode of nodes) {
      const node = normalizeLsdbNode(rawNode)
      if (!node || node.id === identity.id) continue
      const nodeChanged = upsertTopologyLsdbNode(node)
      changed = nodeChanged || changed
      const isStoredTrustedNode = authorizedPhones.has(node.id) || pairedDesktopPeers.has(node.id)
      if ((nodeChanged || !isStoredTrustedNode) && trustedNode.shouldImportTrustedTopologyNode(node)) {
        const importNode = trustedNode.withPrimaryTrustedHost(node)
        if (String(importNode.type || '').includes('PHONE')) {
          upsertAuthorizedPhone({
            phoneId: importNode.id,
            phoneName: importNode.name,
            clientIP: importNode.host,
            deviceType: importNode.type,
            pairingKey: importNode.pairingKey,
            relayPort: importNode.relayPort || importNode.port || JOIN_PORT,
            relayHost: importNode.host,
            tsHost: importNode.tsHost,
            networkId: importNode.networkId || ensureTrustedNetworkId(),
            autoPaired: importNode.autoPaired === true,
            trustSourceId: importNode.trustSourceId || sourceId || identity.id,
            trustLevel: importNode.trustLevel || 'trusted_lan',
            acceptedAt: importNode.acceptedAt || importNode.updatedAt || Date.now(),
            capabilities: importNode.capabilities || {},
            contentPolicy: importNode.contentPolicy
          })
          changed = true
        } else if (String(importNode.type || '').includes('DESKTOP')) {
          upsertPairedDesktopPeer({
            id: importNode.id,
            name: importNode.name,
            deviceType: importNode.type,
            host: importNode.host,
            port: importNode.wsPort || importNode.port || WS_PORT,
            pairingKey: importNode.pairingKey,
            tsHost: importNode.tsHost,
            altHosts: importNode.altHosts,
            networkId: importNode.networkId || ensureTrustedNetworkId(),
            autoPaired: importNode.autoPaired === true,
            trustSourceId: importNode.trustSourceId || sourceId || identity.id,
            trustLevel: importNode.trustLevel || 'trusted_lan',
            acceptedAt: importNode.acceptedAt || importNode.updatedAt || Date.now(),
            capabilities: importNode.capabilities || {},
            contentPolicy: importNode.contentPolicy
          })
          changed = true
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
    if (pendingNetworkMerge) {
      mergeTrustedNetworkId(pendingNetworkMerge.targetNetworkId, pendingNetworkMerge.mergeFromNetworkIds)
    }
    if (acceptedNewSeq) {
      topologyLsdb.seenSeq.set(sourceId, seq)
    }
    if (changed && acceptedNewSeq) {
      rememberTopologyDelta(normalizedDelta)
    }
    savePairingKey()
  }

  if (changed) {
    if (mainWindow) {
      mainWindow.webContents.send('topology-changed')
    }
    try {
      connectAllDesktopPeers()
    } catch (error) {
      console.warn('Failed to refresh desktop peer connections after topology update:', error.message)
    }
    if (options.flood !== false && (normalizedDelta.ttl || 0) > 0 && !shouldThrottleTopologyGossipFlood()) {
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
      const nodeType = String(node.type || node.deviceType || 'UNKNOWN_DEVICE')
      const isPhoneNode = nodeType.includes('PHONE')
      return {
      id: node.id,
      name: node.name,
      type: nodeType,
      host: normalizeNetworkHost(node.host || node.lastIP),
      port: isPhoneNode
        ? (Number(node.relayPort || node.port) || JOIN_PORT)
        : normalizeTopologyPort(nodeType, node.wsPort || node.port || WS_PORT),
      wsPort: isPhoneNode ? undefined : normalizeTopologyPort(nodeType, node.wsPort || node.port || WS_PORT),
      relayPort: normalizeTopologyRelayPort(nodeType, node),
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
        active: route.active === true,
        partiallyActive: route.partiallyActive === true,
        activeEdgeCount: route.activeEdgeCount || 0,
        totalEdgeCount: route.totalEdgeCount || 0,
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
let lastTopologyGossipFloodAt = 0
const TOPOLOGY_GOSSIP_MIN_INTERVAL_MS = 5_000

function shouldThrottleTopologyGossipFlood() {
  const now = Date.now()
  if (now - lastTopologyGossipFloodAt < TOPOLOGY_GOSSIP_MIN_INTERVAL_MS) return true
  lastTopologyGossipFloodAt = now
  return false
}

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
    normalizeHost: normalizeNetworkHost,
    validateResponse: options.validateResponse
  })
}

// codebridge_bus 重放窗口：sentAt 纳入 HMAC，超窗整包拒收。与 relay 的
// relaySentAt 不同，bus 协议没有旧版发送端，sentAt 缺失直接拒绝而非跳过。
const BUS_REPLAY_WINDOW_MS = 5 * 60 * 1000
const BUS_NONCE_LIMIT_PER_SENDER = 300
const recentBusNonces = new Map()

function isReplayedBusNonce(senderId, nonce) {
  if (!senderId || !nonce) return true
  const now = Date.now()
  let seen = recentBusNonces.get(senderId)
  if (!seen) {
    seen = new Map()
    recentBusNonces.set(senderId, seen)
  }
  for (const [itemNonce, firstSeen] of seen) {
    if (now - firstSeen > BUS_REPLAY_WINDOW_MS) seen.delete(itemNonce)
  }
  if (seen.has(nonce)) return true
  seen.set(nonce, now)
  while (seen.size > BUS_NONCE_LIMIT_PER_SENDER) {
    const oldest = seen.keys().next().value
    seen.delete(oldest)
  }
  return false
}

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

function parseBusTransportEnvelope(body, peerKeyOrLookup) {
  if (!body || body.type !== 'codebridge_bus') return null
  const senderId = String(body.senderId || '').trim()
  const nonce = String(body.nonce || '').trim()
  const payload = String(body.payload || '').trim()
  const authToken = String(body.authToken || '').trim()
  if (!senderId || !nonce || !payload || !authToken) return null
  const rawKeys = typeof peerKeyOrLookup === 'function'
    ? peerKeyOrLookup(senderId)
    : peerKeyOrLookup
  const peerKeys = Array.from(new Set(
    (Array.isArray(rawKeys) ? rawKeys : [rawKeys])
      .map(key => String(key || '').trim())
      .filter(Boolean)
  ))
  if (peerKeys.length === 0) return null
  const sentAt = Number(body.sentAt || 0)
  if (!Number.isFinite(sentAt) || sentAt <= 0 || Math.abs(Date.now() - sentAt) > BUS_REPLAY_WINDOW_MS) return null
  for (const peerKey of peerKeys) {
    const expected = hmacBase64(peerKey, `${senderId}|${nonce}|${sentAt}|${payload}`)
    if (!timingSafeEqual(expected, authToken)) continue
    if (isReplayedBusNonce(senderId, nonce)) return null
    const plain = decryptMessage(payload, peerKey)
    if (!plain) return null
    const envelope = runCatchingJson(plain)
    return busEnvelope.isEnvelope(envelope) && String(envelope.messageId || '').trim()
      ? { senderId, nonce, envelope, peerKey }
      : null
  }
  return null
}

function timingSafeEqual(a, b) {
  const left = Buffer.from(String(a || ''), 'utf8')
  const right = Buffer.from(String(b || ''), 'utf8')
  return left.length === right.length && crypto.timingSafeEqual(left, right)
}

function discoveredNodeForDelivery(node = {}) {
  const nodeId = String(node.id || node.phoneId || '').trim()
  if (!nodeId) return {}
  const discovered = discoveredLanDevices.get(nodeId)
  return discovered && String(discovered.id || '').trim() === nodeId ? discovered : {}
}

function httpDeliveryCandidateHosts(node = {}, preferredHost = '') {
  return trustedNode.deliveryCandidateHosts(
    node,
    discoveredNodeForDelivery(node),
    preferredHost
  )
}

// Discovery packets identify a candidate address but do not prove ownership of
// the pairing key. Promote only the exact same-id discovery host after the HTTP
// peer has returned a valid, accepted bus ACK signed with that key.
function rememberAuthenticatedHttpDeliveryHost(node = {}, deliveredHost = '') {
  const nodeId = String(node.id || node.phoneId || '').trim()
  const nodeKey = String(node.pairingKey || '').trim()
  const host = normalizeNetworkHost(deliveredHost)
  const discoveredHost = normalizeNetworkHost(discoveredNodeForDelivery(node).host)
  if (!nodeId || !nodeKey || !host || host !== discoveredHost) return false

  const phone = authorizedPhones.get(nodeId)
  if (phone && String(phone.pairingKey || '').trim() === nodeKey) {
    const previousHost = normalizeNetworkHost(phone.lastIP || phone.host)
    if (previousHost === host) return false
    Object.assign(phone, trustedNode.withAuthenticatedHost(phone, host))
    authorizedPhones.set(nodeId, phone)
    savePairingKey()
    notifyPhonesChanged()
    return true
  }

  const peer = pairedDesktopPeers.get(nodeId)
  if (peer && String(peer.pairingKey || '').trim() === nodeKey) {
    const previousHost = normalizeNetworkHost(peer.host || peer.lastIP)
    if (previousHost === host) return false
    Object.assign(peer, trustedNode.withAuthenticatedHost(peer, host))
    pairedDesktopPeers.set(nodeId, peer)
    savePairingKey()
    notifyDesktopPeersChanged()
    return true
  }
  return false
}

async function sendBusEnvelopeDirect(target, envelope, route = {}) {
  if (!target || !target.pairingKey) return false
  const transportEnvelope = buildBusTransportEnvelope(envelope, target.pairingKey)
  if (!transportEnvelope) return false
  // UDP discovery is only an ephemeral fallback until the response below proves
  // possession of the pairing key and binds the ACK to this request nonce.
  const hosts = httpDeliveryCandidateHosts(target, route.host)
  const port = Number(route.port || target.relayPort || target.port) || JOIN_PORT
  for (const host of hosts) {
    const ok = await postJsonToNode(host, port, transportEnvelope, {
      path: '/bus/message',
      timeoutMs: 3500,
      validateResponse: ack => busAck.verifyBusAck(ack, target.pairingKey, {
        nonce: transportEnvelope.nonce,
        messageId: envelope.messageId,
        accepted: true
      })
    })
    if (ok) {
      rememberAuthenticatedHttpDeliveryHost(target, host)
      return true
    }
  }
  return false
}

function wsAckKey(peerId, msgId) {
  const id = String(peerId || '').trim()
  const messageId = String(msgId || '').trim()
  return id && messageId ? `${id}|${messageId}` : ''
}

function settleWsAck(peerId, msgId, ok) {
  const key = wsAckKey(peerId, msgId)
  if (!key) return false
  const pending = pendingWsAcks.get(key)
  if (!pending) return false
  clearTimeout(pending.timer)
  pendingWsAcks.delete(key)
  pending.resolve(ok === true)
  return true
}

function waitForWsAck(peerId, msgId, timeoutMs = WS_BUS_ACK_TIMEOUT_MS) {
  const key = wsAckKey(peerId, msgId)
  if (!key) return Promise.resolve(false)
  settleWsAck(peerId, msgId, false)
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      pendingWsAcks.delete(key)
      resolve(false)
    }, timeoutMs)
    timer.unref?.()
    pendingWsAcks.set(key, { timer, resolve })
  })
}

function resolveWsCodeAck(peerId, msgId) {
  return settleWsAck(peerId, msgId, true)
}

function failPendingWsAcksForPeer(peerId) {
  const prefix = `${String(peerId || '').trim()}|`
  if (!prefix.trim()) return
  for (const [key, pending] of Array.from(pendingWsAcks.entries())) {
    if (!key.startsWith(prefix)) continue
    clearTimeout(pending.timer)
    pendingWsAcks.delete(key)
    pending.resolve(false)
  }
}

function sendWsJson(ws, payload) {
  return new Promise(resolve => {
    try {
      ws.send(payload, error => resolve(!error))
    } catch (_) {
      resolve(false)
    }
  })
}

async function sendWsMessageAndWaitAck(ws, peerId, message) {
  const msgId = String(message?.msgId || '').trim()
  if (!ws || ws.readyState !== WebSocket.OPEN || !msgId) return false
  const ackPromise = waitForWsAck(peerId, msgId)
  const sent = await sendWsJson(ws, JSON.stringify(message))
  if (!sent) {
    settleWsAck(peerId, msgId, false)
    return false
  }
  return ackPromise
}

async function sendBusEnvelopeWsReliable(target, envelope) {
  const targetId = String(target?.id || target?.phoneId || '').trim()
  if (!targetId) return false
  const outbound = activeDesktopPeerConnections.get(targetId)
  if (outbound && outbound.readyState === WebSocket.OPEN && outbound.__codebridgeSessionKey) {
    const encrypted = encryptMessage(JSON.stringify(envelope), outbound.__codebridgeSessionKey)
    if (encrypted) {
      const ok = await sendWsMessageAndWaitAck(outbound, targetId, {
        type: 'bus_message',
        msgId: envelope.messageId,
        payload: encrypted
      })
      if (ok) return true
    }
  }
  const inboundConnections = activePhoneConnections.get(targetId)
  if (inboundConnections) {
    for (const ws of inboundConnections) {
      const sessionKey = phoneSessionKeys.get(ws)
      if (!sessionKey || ws.readyState !== WebSocket.OPEN) continue
      const encrypted = encryptMessage(JSON.stringify(envelope), sessionKey)
      if (!encrypted) continue
      const ok = await sendWsMessageAndWaitAck(ws, targetId, {
        type: 'bus_message',
        msgId: envelope.messageId,
        payload: encrypted
      })
      if (ok) return true
    }
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

async function sendBusEnvelopeLegacyRelay(target, envelope, route = {}) {
  const payload = busEnvelope.toLegacyPayload(envelope)
  const targetId = String(target?.id || target?.phoneId || envelope.targetNodeIds?.[0] || '').trim()
  const nextHopId = String(route.nextHopId || '').trim()
  const deliveryTarget = nextHopId && nextHopId !== targetId
    ? (resolveForwardTarget(nextHopId)?.node || target)
    : target
  const deliveryTargetId = String(deliveryTarget?.id || deliveryTarget?.phoneId || targetId).trim()
  if (String(deliveryTarget?.deviceType || deliveryTarget?.type || '').includes('PHONE')) {
    return sendRelayEnvelopeToPhone(deliveryTarget, payload, { skipBus: true })
  }
  const directOk = await sendBusEnvelopeDirect(deliveryTarget, envelope).catch(() => false)
  if (directOk) return true
  sendVerifyCodeToDesktopNode(deliveryTargetId, JSON.stringify(payload), envelope.messageId)
  return false
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
  if (!phone || !phone.pairingKey || !hasDirectNodeAddress(phone)) return false
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
  const hosts = httpDeliveryCandidateHosts(phone)
  for (const host of hosts) {
    const ok = await postJsonToNode(host, Number(phone.relayPort || phone.port) || 19529, envelope)
    if (ok) return true
  }
  return false
}

function broadcastTopologyToAllPeers(reason = 'broadcast', options = {}) {
  const baseDelta = options.baseDelta || buildTopologyDelta(reason, {
    mergeFromNetworkIds: options.mergeFromNetworkIds || []
  })
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

  const topologyEnvelope = busEnvelope.fromLegacyPayload(delta, {
    identity,
    networkId: ensureTrustedNetworkId()
  })
  for (const peer of getPairedDesktopPeers()) {
    const peerId = String(peer.id || '').trim()
    if (!peerId || peerId === excludeNodeId || peer.enabled === false || !peer.pairingKey) continue
    const active = activeDesktopPeerConnections.get(peerId)
    if (active && active.readyState === WebSocket.OPEN) continue
    if (!hasDirectNodeAddress(peer)) continue
    sendBusEnvelopeDirect(peer, topologyEnvelope).catch(error => {
      console.error(`拓扑 direct bus 到桌面对端失败 ${peer.name || peerId}:`, error.message)
    })
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
  const result = setNodeContentPolicy(phoneId, updates)
  return result.phones
}

function setNodeContentPolicy(nodeId, updates = {}) {
  const id = String(nodeId || '').trim()
  if (!id) {
    return { phones: getAuthorizedPhones(), fileTargets: getFileTransferTargets() }
  }
  const nextUpdates = updates && typeof updates === 'object' ? updates : {}
  let changed = false
  const phone = authorizedPhones.get(id)
  if (phone && !phone.revoked) {
    phone.contentPolicy = normalizePushContentPolicy({
      ...(phone.contentPolicy || phone || {}),
      ...nextUpdates
    })
    authorizedPhones.set(id, phone)
    changed = true
  }
  const peer = pairedDesktopPeers.get(id)
  if (peer && peer.enabled !== false) {
    peer.contentPolicy = normalizePushContentPolicy({
      ...(peer.contentPolicy || peer || {}),
      ...nextUpdates
    })
    pairedDesktopPeers.set(id, peer)
    changed = true
  }
  const lsdbNode = topologyLsdb.nodes.get(id)
  if (lsdbNode) {
    const policy = normalizePushContentPolicy({
      ...(lsdbNode.contentPolicy || lsdbNode || {}),
      ...nextUpdates
    })
    topologyLsdb.nodes.set(id, {
      ...lsdbNode,
      contentPolicy: policy,
      allowClipboardFile: policy.allowClipboardFile,
      allowFileTransfer: policy.allowFileTransfer,
      maxFileSizeMb: policy.maxFileSizeMb,
      autoAcceptFiles: policy.autoAcceptFiles,
      updatedAt: Date.now(),
      seq: nextLsdbSequence()
    })
    changed = true
  }
  if (changed) {
    savePairingKey()
    notifyPhonesChanged()
    notifyDesktopPeersChanged()
    if (mainWindow) {
      mainWindow.webContents.send('topology-changed')
    }
    scheduleTopologyBroadcast()
  }
  return { phones: getAuthorizedPhones(), fileTargets: getFileTransferTargets() }
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
  const readableSeeds = Array.from(totpSeeds.values()).map(seed => ({
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
  const readableIds = new Set(readableSeeds.map(seed => String(seed.id || '').trim()).filter(Boolean))
  const preservedSeeds = unreadableTotpSeeds.filter(seed => {
    const id = String(seed?.id || '').trim()
    return seed && (!id || !readableIds.has(id))
  })
  return [...readableSeeds, ...preservedSeeds]
}

function getStoredTotpDeleteTombstones() {
  pruneTotpDeleteTombstones()
  const readableTombstones = totpDeleteTombstones.map(item => ({
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
  const readableIds = new Set(readableTombstones.map(item => String(item.id || '').trim()).filter(Boolean))
  const preservedTombstones = unreadableTotpDeleteTombstones.filter(item => {
    const id = String(item?.id || '').trim()
    return item && (!id || !readableIds.has(id))
  })
  return [...readableTombstones, ...preservedTombstones]
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

/** 节点可达时，把本机来源（desktop-local）的新增 TOTP 种子补推给该目标。 */
// Explicit full sync can use trusted recovery sources; automatic incremental sync stays local-only.
function isLocalDesktopTotpSeed(seed) {
  return !!seed && (
    seed.phoneId === LOCAL_TOTP_SOURCE_ID ||
    seed.sourceDeviceId === LOCAL_TOTP_SOURCE_ID
  )
}

function getTotpSeedsForSync(options = {}) {
  const includeRecoverySources = options.force === true ||
    options.includeRecoverySources === true ||
    options.includeRemote === true
  return Array.from(totpSeeds.values())
    .filter(seed => seed && seed.secret)
    .filter(seed => includeRecoverySources || isLocalDesktopTotpSeed(seed))
}

function getTotpSeedPushSource(seed) {
  const identity = getDesktopIdentity()
  const local = isLocalDesktopTotpSeed(seed)
  const sourceDeviceId = local
    ? identity.id
    : String(seed?.sourceDeviceId || seed?.phoneId || '').trim() || identity.id
  const sourceDeviceName = local
    ? identity.name
    : String(seed?.sourceDeviceName || seed?.phoneName || '').trim() || identity.name
  const sourceDeviceType = local
    ? identity.type
    : String(seed?.sourceDeviceType || '').trim() || 'ANDROID_PHONE'
  const seedPhoneId = String(seed?.phoneId || '').trim()
  const phoneId = local
    ? identity.id
    : (seedPhoneId && seedPhoneId !== LOCAL_TOTP_SOURCE_ID ? seedPhoneId : sourceDeviceId)
  const phoneName = local
    ? identity.name
    : String(seed?.phoneName || '').trim() || sourceDeviceName
  return {
    local,
    phoneId,
    phoneName,
    sourceDeviceId,
    sourceDeviceName,
    sourceDeviceType,
    pushAuthority: local ? 'local_desktop' : 'trusted_recovery_source'
  }
}

// Automatic catch-up uses this cutoff for local-source changes.
function getTotpSyncCutoff(node) {
  return Number(node?.lastTotpSeedSyncAt || 0) || 0
}

function markPhoneTotpSeedSynced(phoneId, timestamp = Date.now()) {
  const phone = authorizedPhones.get(phoneId)
  if (!phone) return
  phone.lastTotpSeedSyncAt = Math.max(Number(phone.lastTotpSeedSyncAt || 0) || 0, timestamp)
  authorizedPhones.set(phoneId, phone)
  savePairingKey()
}

function markDesktopPeerTotpSeedSynced(peerId, timestamp = Date.now()) {
  const peer = pairedDesktopPeers.get(peerId)
  if (!peer) return
  peer.lastTotpSeedSyncAt = Math.max(Number(peer.lastTotpSeedSyncAt || 0) || 0, timestamp)
  pairedDesktopPeers.set(peerId, peer)
  savePairingKey()
}

function sendLocalTotpSeedsToPhone(ws, sessionKey, phoneId, options = {}) {
  const phone = authorizedPhones.get(phoneId)
  if (!canPushContentToNode(phone, 'totp')) return
  const cutoff = options.force === true ? 0 : getTotpSyncCutoff(phone)
  const localSeeds = getTotpSeedsForSync(options)
    .filter(seed => (Number(seed.updatedAt || seed.createdAt || 0) || 0) > cutoff)
  if (localSeeds.length > 0) {
    console.log(`已向手机 ${phoneId} 下发 ${localSeeds.length} 个本机 TOTP 种子`)
  }
  const deliveries = localSeeds.map(seed =>
    publishTotpChangeToTargets(seed, 'add', [phone]).catch(error => {
      console.error('下发 TOTP 种子失败:', error)
      return { delivered: 0, deliveredTargetIds: [] }
    })
  )
  deliveries.push(sendTotpDeleteTombstonesToPhone(ws, sessionKey, phoneId, cutoff))
  Promise.all(deliveries).then(results => {
    const delivered = results.reduce((sum, result) => sum + Number(result.delivered || 0), 0)
    if (results.some(result => (result.deliveredTargetIds || []).includes(phoneId))) {
      markPhoneTotpSeedSynced(phoneId)
      console.log(`Sent ${delivered} TOTP changes to phone ${phoneId}`)
    }
  }).catch(error => {
    console.error('手机 TOTP 补推失败:', error)
  })
}

function sendTotpDeleteTombstonesToPhone(ws, sessionKey, phoneId, cutoff = 0) {
  const phone = authorizedPhones.get(phoneId)
  if (!phone) return Promise.resolve({ delivered: 0, deliveredTargetIds: [] })
  pruneTotpDeleteTombstones()
  const pendingTombstones = totpDeleteTombstones
    .filter(tombstone => (Number(tombstone.deletedAt || tombstone.updatedAt || 0) || 0) > cutoff)
  if (pendingTombstones.length === 0) return Promise.resolve({ delivered: 0, deliveredTargetIds: [] })
  return Promise.all(pendingTombstones.map(tombstone =>
    publishTotpChangeToTargets(tombstone, 'delete', [phone]).catch(error => {
      console.error('下发 TOTP 删除状态失败:', error)
      return { delivered: 0, deliveredTargetIds: [] }
    })
  )).then(results => ({
    delivered: results.reduce((sum, result) => sum + Number(result.delivered || 0), 0),
    deliveredTargetIds: Array.from(new Set(results.flatMap(result => result.deliveredTargetIds || [])))
  }))
}

/** 向允许接收 TOTP 的手机节点发布一条 TOTP 同步消息（用于本机即时新增/删除）。 */
function broadcastTotpSyncToPhones(seed, action = 'add') {
  if (!seed) return
  const targets = getTargetSelectionsForType(CODE_TYPES.TOTP, {
    permissionLabel: 'TOTP 同步权限未开启'
  })
    .filter(target => target.kind === 'phone' && target.selected)
    .map(target => target.node)
  if (targets.length === 0) return
  publishTotpChangeToTargets(seed, action, targets).then(result => {
    const timestamp = Number(seed.updatedAt || seed.deletedAt || Date.now()) || Date.now()
    for (const phoneId of result.deliveredTargetIds || []) {
      markPhoneTotpSeedSynced(phoneId, timestamp)
    }
  }).catch(error => {
    console.error('广播 TOTP 同步失败:', error)
  })
}

function broadcastTotpSyncToDesktopPeers(seed, action = 'add') {
  if (!seed) return
  const targets = getTargetSelectionsForType(CODE_TYPES.TOTP, {
    permissionLabel: 'TOTP 同步权限未开启'
  })
    .filter(target => target.kind === 'desktop' && target.selected)
    .map(target => target.node)
  if (targets.length === 0) return
  publishTotpChangeToTargets(seed, action, targets).then(result => {
    const timestamp = Number(seed.updatedAt || seed.deletedAt || Date.now()) || Date.now()
    for (const peerId of result.deliveredTargetIds || []) {
      markDesktopPeerTotpSeedSynced(peerId, timestamp)
    }
  }).catch(error => {
    console.error('广播桌面 TOTP 同步失败:', error)
  })
}

// ==================== 剪贴板同步 ====================

// 剪贴板轮询周期：略高于 QR 监听，兼顾及时性与 CPU 占用。
const CLIPBOARD_POLL_INTERVAL_MS = 900
// 剪贴板文本 inline 上限；超过后仍按“剪贴板文本”同步，但底层转文件分片传输。
const CLIPBOARD_MAX_LENGTH = 20 * 1024
// 首版图片剪贴板用 inline manifest 走现有加密 relay，必须保守限制大小。
const CLIPBOARD_INLINE_IMAGE_MAX_BYTES = 768 * 1024
const CLIPBOARD_IMAGE_JPEG_QUALITY = 90
const CLIPBOARD_FILE_STABLE_MS = 900
const CLIPBOARD_FILE_RETRY_DELAY_MS = 1200
const CLIPBOARD_FILE_RETRY_LIMIT = 3
const CLIPBOARD_FILE_BATCH_FLUSH_MS = 1200
let clipboardWatchTimer = null
// 上一次本机剪贴板内容快照：用于检测变化。
let lastClipboardText = ''
let lastClipboardImageHash = ''
let lastClipboardFileSignature = ''
let cachedNativeClipboardFilePaths = []
let cachedNativeClipboardSequence = 0
let nativeClipboardFileSnapshotReady = false
let nativeClipboardFileSnapshotPromise = null
let nativeClipboardFileSnapshotStartedAt = 0
let lastClipboardFileReadReady = true
let clipboardFileWatcherPrimed = false
let lastUnreadableClipboardFileWarningAt = 0
let suppressClipboardImagePollUntil = 0
let pendingClipboardFileBatch = null
let incomingClipboardFileSession = { key: '', paths: new Set(), fileIds: new Set(), expectedCount: 0, timer: null, version: null }

// 剪贴板 LWW（last-writer-wins）寄存器状态：网络中剪贴板是一个单值寄存器，
// 每次复制产生新版本 (ts, origin)。节点只应用比已知版本更新的内容——
// 旧值、乱序副本、回环副本全部被版本比较吸收，取代了旧的 suppressClipboardText
// 单次回环抑制。只存内容哈希不存明文；随 pairing.json 持久化，
// 重启后的上线补推不会把旧值打上新时间戳盖掉别人的新内容。
let clipboardSyncState = { ts: 0, origin: '', hash: '' }
let clipboardImageSyncState = { ts: 0, origin: '', hash: '' }
let clipboardGlobalSyncState = { ts: 0, origin: '', hash: '', kind: '' }

function hashClipText(text) {
  return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex').slice(0, 24)
}

function clipboardTextByteLength(text) {
  return Buffer.byteLength(String(text || ''), 'utf8')
}

function hashBuffer(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex')
}

function normalizeClipboardImageMime(mime = '') {
  const value = String(mime || '').toLowerCase()
  if (value === 'image/jpeg' || value === 'image/jpg') return 'image/jpeg'
  if (value === 'image/png') return 'image/png'
  return ''
}

function clipboardImageExtension(mime = '') {
  return normalizeClipboardImageMime(mime) === 'image/jpeg' ? 'jpg' : 'png'
}

function encodeClipboardImageForSync(image) {
  if (!image || image.isEmpty()) return null
  try {
    const jpeg = image.toJPEG(CLIPBOARD_IMAGE_JPEG_QUALITY)
    if (Buffer.isBuffer(jpeg) && jpeg.length > 0) {
      return { buffer: jpeg, mime: 'image/jpeg', ext: 'jpg' }
    }
  } catch (_) {}
  const png = image.toPNG()
  return Buffer.isBuffer(png) && png.length > 0
    ? { buffer: png, mime: 'image/png', ext: 'png' }
    : null
}

function readClipboardImageSyncHash() {
  try {
    const image = clipboard.readImage()
    if (!image || image.isEmpty()) return ''
    const encoded = encodeClipboardImageForSync(image)
    return encoded ? hashBuffer(encoded.buffer).slice(0, 24) : ''
  } catch (_) {
    return ''
  }
}

function refreshClipboardImageSnapshotAfterWrite(fallbackHash = '') {
  if (fallbackHash) lastClipboardImageHash = fallbackHash
  suppressClipboardImagePollUntil = Date.now() + 1500
  ;[80, 350, 1000].forEach(delayMs => {
    const timer = setTimeout(() => {
      const currentHash = readClipboardImageSyncHash()
      if (currentHash) lastClipboardImageHash = currentHash
    }, delayMs)
    timer.unref?.()
  })
}

function isNewerClipVersion(ts, origin) {
  return clipboardVersion.isNewerClipboardVersion(clipboardGlobalSyncState, { ts, origin })
  // 同毫秒平手用 origin 字典序裁决，保证所有节点裁决结果一致
}

function isNewerClipImageVersion(ts, origin) {
  return clipboardVersion.isNewerClipboardVersion(clipboardGlobalSyncState, { ts, origin })
}

function isSameGlobalClipHash(hash) {
  return clipboardVersion.hasSameClipboardHash(clipboardGlobalSyncState, hash)
}

function rememberGlobalClipVersion(ts, origin, hash, kind) {
  clipboardGlobalSyncState = clipboardVersion.rememberClipboardVersion(clipboardGlobalSyncState, {
    ts,
    origin: String(origin || ''),
    hash: String(hash || ''),
    kind: String(kind || '')
  })
}

function nextLocalClipboardTimestamp() {
  return clipboardVersion.nextLocalClipboardTimestamp(clipboardGlobalSyncState)
}

function rememberClipVersion(ts, origin, text) {
  const hash = hashClipText(text)
  clipboardSyncState = { ts, origin: String(origin || ''), hash, kind: 'text' }
  rememberGlobalClipVersion(ts, origin, hash, 'text')
  savePairingKey()
}

function rememberClipImageVersion(ts, origin, hash) {
  clipboardImageSyncState = { ts, origin: String(origin || ''), hash: String(hash || ''), kind: 'image' }
  rememberGlobalClipVersion(ts, origin, hash, 'image')
  savePairingKey()
}

function normalizeClipboardSyncState(saved = {}) {
  return clipboardVersion.normalizeClipboardVersion(saved)
}

function startClipboardSyncWatcher() {
  if (clipboardWatchTimer) return
  try {
    lastClipboardText = clipboard.readText() || ''
    lastClipboardImageHash = readClipboardImageSyncHash()
    if (desktopMessageSettings.syncClipboardFile === true) {
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
    } else {
      lastClipboardFileSignature = ''
      clipboardFileWatcherPrimed = false
    }
  } catch (_) {
    lastClipboardText = ''
    lastClipboardImageHash = ''
    lastClipboardFileSignature = ''
    clipboardFileWatcherPrimed = false
  }
  pendingClipboardFileBatch = null
  clipboardWatchTimer = setInterval(pollClipboardForSync, CLIPBOARD_POLL_INTERVAL_MS)
}

function stopClipboardSyncWatcher() {
  if (clipboardWatchTimer) {
    clearInterval(clipboardWatchTimer)
    clipboardWatchTimer = null
  }
  pendingClipboardFileBatch = null
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
      if (text && hashClipText(text) !== clipboardSyncState.hash) {
        // 本机新复制：产生新版本并广播。小文本 inline 走消息通道；
        // 超长文本保持"剪贴板文本"业务语义，但底层转 manifest + 分片拉取。
        const clipTs = nextLocalClipboardTimestamp()
        clearIncomingClipboardFiles()
        rememberClipVersion(clipTs, getDesktopIdentity().id, text)
        if (clipboardTextByteLength(text) <= CLIPBOARD_MAX_LENGTH) {
          broadcastClipboardToNodes(text)
        } else {
          offerClipboardTextAsFile(text, clipTs, clipboardSyncState.hash).catch(error => {
            console.error('剪贴板长文本 manifest 同步失败:', error.message)
          })
        }
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
  const encodedImage = encodeClipboardImageForSync(image)
  if (!encodedImage) return
  const imageBuffer = encodedImage.buffer
  const hash = hashBuffer(imageBuffer)
  const shortHash = hash.slice(0, 24)
  if (Date.now() < suppressClipboardImagePollUntil) {
    lastClipboardImageHash = shortHash
    return
  }
  if (shortHash === lastClipboardImageHash) return
  lastClipboardImageHash = shortHash
  if (isSameGlobalClipHash(shortHash)) return
  clearIncomingClipboardFiles()
  if (imageBuffer.length > CLIPBOARD_INLINE_IMAGE_MAX_BYTES) {
    // 大图回退：不整包 inline 进 relay 消息，转 manifest + 分片拉取
    //（与文件传输同通道），接收端拉完写剪贴板。版本先行登记，
    // 避免轮询期间把同一张图重复 offer。
    const clipTs = nextLocalClipboardTimestamp()
    rememberClipImageVersion(clipTs, getDesktopIdentity().id, shortHash)
    offerClipboardImageAsFile(imageBuffer, clipTs, shortHash, encodedImage).catch(error => {
      console.error('剪贴板大图 manifest 同步失败:', error.message)
    })
    return
  }
  rememberClipImageVersion(nextLocalClipboardTimestamp(), getDesktopIdentity().id, shortHash)
  broadcastClipboardImageToNodes(imageBuffer, hash, encodedImage)
}

function getDefaultClipboardImageTargetIds() {
  return getTargetSelectionsForType(CODE_TYPES.CLIPBOARD_IMAGE, {
    permissionLabel: '剪贴板图片权限未开启'
  })
    .filter(target => target.selected)
    .map(target => target.id)
}

function getDefaultClipboardTextTargetIds() {
  return getTargetSelectionsForType(CODE_TYPES.CLIPBOARD_TEXT, {
    allowNode: node => {
      const type = String(node.deviceType || node.type || '').toUpperCase()
      if (type.includes('DESKTOP')) return true
      return canPushContentToNode(node, CODE_TYPES.CLIPBOARD_TEXT)
    },
    permissionLabel: '剪贴板文本权限未开启'
  })
    .filter(target => target.selected)
    .map(target => target.id)
}

async function offerClipboardTextAsFile(text, clipTs, shortHash, options = {}) {
  const defaultTargets = getDefaultClipboardTextTargetIds()
  const allowedTargets = new Set(defaultTargets)
  const requestedTargets = Array.isArray(options.targetIds)
    ? options.targetIds.map(String).filter(id => id && allowedTargets.has(id))
    : defaultTargets
  const targets = Array.from(new Set(requestedTargets))
  if (targets.length === 0) return
  const bytes = Buffer.from(String(text || ''), 'utf8')
  if (bytes.length === 0) return
  const maxBytes = Math.max(1, Number(desktopMessageSettings.maxFileSizeMb || 50)) * 1024 * 1024
  if (bytes.length > maxBytes) {
    console.warn(`Clipboard text sync skipped: ${formatBytes(bytes.length)} exceeds ${formatBytes(maxBytes)}`)
    return
  }
  const outDir = path.join(app.getPath('userData'), 'clipboard-text-out')
  let filePath
  try {
    fs.mkdirSync(outDir, { recursive: true })
    for (const entry of fs.readdirSync(outDir)) {
      const full = path.join(outDir, entry)
      try {
        if (Date.now() - fs.statSync(full).mtimeMs > 30 * 60 * 1000) fs.unlinkSync(full)
      } catch (_) {}
    }
    filePath = path.join(outDir, `clipboard-${clipTs}-${shortHash}.txt`)
    fs.writeFileSync(filePath, bytes)
  } catch (e) {
    console.error('剪贴板长文本暂存失败:', e.message)
    return
  }
  const identity = getDesktopIdentity()
  const clipOrigin = String(options.origin || identity.id)
  await initFileTransfer().offerFile(filePath, targets, {
    type: CODE_TYPES.CLIPBOARD_TEXT,
    source: '剪贴板',
    rawPrefix: '剪贴板文本',
    payloadExtra: {
      ...buildLocalSourceAddressPayload(),
      clipVersion: { ts: clipTs, origin: clipOrigin, hash: shortHash, kind: 'text' },
      clipboardTextEncoding: 'utf-8'
    }
  })
}

// 大图剪贴板发送侧：PNG 先暂存本地（offer 有效期内充当分片源），再按
// clipboard_image 类型 offer。payloadExtra 带 clipVersion 供接收端 LWW 排序。
function buildLocalSourceAddressPayload() {
  const sourceHost = getLocalIP()
  const sourceTsHost = getTailscaleIPv4()
  return {
    sourceHost,
    sourceTsHost,
    sourceAltHosts: [sourceTsHost].filter(host => host && host !== sourceHost)
  }
}

async function offerClipboardImageAsFile(imageBuffer, clipTs, shortHash, imageInfo = {}) {
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
    const ext = imageInfo.ext || clipboardImageExtension(imageInfo.mime)
    filePath = path.join(outDir, `clipboard-${clipTs}-${shortHash}.${ext}`)
    fs.writeFileSync(filePath, imageBuffer)
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
      ...buildLocalSourceAddressPayload(),
      clipVersion: { ts: clipTs, origin: identity.id, hash: shortHash, kind: 'image' }
    }
  })
}

function readClipboardFilePaths() {
  if (process.platform !== 'win32') return []
  let usedNativeFallback = false
  let nativeRefreshPending = false
  const paths = readClipboardFilePathsFromClipboard(clipboard, {
    readNativeFileDropList: () => {
      usedNativeFallback = true
      nativeRefreshPending = scheduleNativeClipboardFileSnapshot()
      return cachedNativeClipboardFilePaths
    }
  })
  lastClipboardFileReadReady = !usedNativeFallback || (
    nativeClipboardFileSnapshotReady && !nativeRefreshPending
  )
  return paths
}

function warnUnreadableNativeClipboard(error) {
  const now = Date.now()
  if (now - lastUnreadableClipboardFileWarningAt < 30_000) return
  lastUnreadableClipboardFileWarningAt = now
  console.warn('Windows file clipboard could not be read:', error?.message || error || 'empty file-drop list')
}

function scheduleNativeClipboardFileSnapshot() {
  const now = Date.now()
  if (nativeClipboardFileSnapshotPromise) return true
  if (now - nativeClipboardFileSnapshotStartedAt < 1500) return false
  nativeClipboardFileSnapshotStartedAt = now
  nativeClipboardFileSnapshotPromise = readWindowsFileDropSnapshot({ timeoutMs: 1200 })
    .then(snapshot => {
      const sequence = Math.max(0, Number(snapshot?.sequence || 0) || 0)
      if (!nativeClipboardFileSnapshotReady || sequence === 0 || sequence !== cachedNativeClipboardSequence) {
        cachedNativeClipboardSequence = sequence
        cachedNativeClipboardFilePaths = Array.isArray(snapshot?.paths)
          ? Array.from(snapshot.paths)
          : []
      }
      nativeClipboardFileSnapshotReady = true
      if (cachedNativeClipboardFilePaths.length === 0) {
        warnUnreadableNativeClipboard('empty file-drop list')
      }
    })
    .catch(error => {
      nativeClipboardFileSnapshotReady = false
      warnUnreadableNativeClipboard(error)
    })
    .finally(() => {
      nativeClipboardFileSnapshotPromise = null
    })
  return true
}

function getClipboardFileSignature(filePaths) {
  if (!Array.isArray(filePaths) || filePaths.length === 0) return ''
  const parts = []
  const seen = new Set()
  for (const filePath of filePaths) {
    try {
      const normalized = path.resolve(String(filePath || ''))
      if (seen.has(normalized)) continue
      seen.add(normalized)
      const stat = fs.statSync(normalized)
      if (!stat.isFile()) continue
      parts.push(`${normalized}|${stat.size}|${Math.round(stat.mtimeMs)}`)
    } catch (_) {}
  }
  return parts.sort().join('\n')
}

function incomingClipboardFileTempDir() {
  return path.join(app.getPath('userData'), 'clipboard-files-in')
}

function clearIncomingClipboardFiles() {
  const dir = incomingClipboardFileTempDir()
  if (incomingClipboardFileSession.timer) {
    clearTimeout(incomingClipboardFileSession.timer)
  }
  try {
    fs.rmSync(dir, { recursive: true, force: true })
  } catch (_) {}
