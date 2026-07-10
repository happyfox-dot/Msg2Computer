'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')

const busEnvelope = require('../src/main/bus-envelope')
const busAck = require('../src/main/bus-ack')
const relayClient = require('../src/main/relay-client')
const {
  buildPeerRoutes,
  chooseBestRoute,
  createRouteHealthTracker,
  deriveReachabilitySnapshot,
  isReachableStatus,
  isTailscaleAddress
} = require('../src/main/route-manager')
const {
  createBusReliabilityStore
} = require('../src/main/bus-reliability')
const { createContentBus } = require('../src/main/content-bus')

test('legacy payload converts to bus envelope and back without losing routing fields', () => {
  const legacy = {
    type: 'sms_message',
    rawMessage: 'hello',
    targetDeviceIds: ['B', 'B', 'C'],
    relayTtl: 3,
    timestamp: 123
  }
  const envelope = busEnvelope.fromLegacyPayload(legacy, {
    identity: { id: 'A', name: 'Phone A', type: 'ANDROID_PHONE' },
    networkId: 'net-1'
  })

  assert.equal(envelope.topic, busEnvelope.TOPICS.SMS_RAW)
  assert.deepEqual(envelope.targetNodeIds, ['B', 'C'])
  assert.equal(envelope.ttl, 3)
  assert.equal(busEnvelope.isEnvelope(envelope), true)

  const roundTrip = busEnvelope.toLegacyPayload(envelope)
  assert.equal(roundTrip.type, 'sms_message')
  assert.equal(roundTrip.contentType, 'sms_message')
  assert.equal(roundTrip.networkId, 'net-1')
  assert.deepEqual(roundTrip.targetDeviceIds, ['B', 'C'])
})

test('notification removal legacy payload maps to dedicated bus topic', () => {
  const legacy = {
    type: 'app_notification_removed',
    notificationKey: 'key-1',
    targetDeviceIds: ['B'],
    relayTtl: 2
  }
  const envelope = busEnvelope.fromLegacyPayload(legacy, {
    identity: { id: 'A', name: 'Phone A', type: 'ANDROID_PHONE' },
    networkId: 'net-1'
  })

  assert.equal(envelope.topic, busEnvelope.TOPICS.APP_NOTIFICATION_REMOVED)
  const roundTrip = busEnvelope.toLegacyPayload(envelope)
  assert.equal(roundTrip.type, 'app_notification_removed')
  assert.equal(roundTrip.notificationKey, 'key-1')
})

test('route manager prefers LAN, then Tailscale, then relay fallback', () => {
  const routes = buildPeerRoutes({
    target: {
      id: 'B',
      host: '192.168.31.20',
      tsHost: '100.90.1.2',
      relayPort: 19529,
      pairingKey: 'key'
    },
    topologyRoutes: [{ destinationId: 'B', nextHopId: 'C', metric: 3, path: ['A', 'C', 'B'] }],
    hasActiveWs: true
  })

  assert.equal(isTailscaleAddress('100.90.1.2'), true)
  assert.equal(routes[0].transportType, 'lan_direct')
  assert.equal(routes.some(route => route.transportType === 'tailscale_direct'), true)
  assert.equal(routes.some(route => route.transportType === 'legacy_ws'), true)
  assert.equal(routes.some(route => route.transportType === 'relay_route'), true)
  assert.equal(chooseBestRoute({ target: { id: 'B', host: '192.168.31.20' } }).transportType, 'lan_direct')
})

test('route health penalizes recently failed direct routes', () => {
  const tracker = createRouteHealthTracker({ failurePenalty: 50, cooldownMs: 60_000 })
  const targetId = 'B'
  const routes = [
    { targetId, transportType: 'lan_direct', host: '192.168.31.20', metric: 10 },
    { targetId, transportType: 'relay_route', nextHopId: 'C', metric: 40 }
  ]

  tracker.recordResult(targetId, routes[0], false)
  const ranked = tracker.rankRoutes(targetId, routes)

  assert.equal(ranked[0].transportType, 'relay_route')
})

test('reachability snapshot marks connected peers online and recent direct peers reachable', () => {
  const now = 1_000_000
  const online = deriveReachabilitySnapshot({
    node: { id: 'B', host: '192.168.31.20', pairingKey: 'key' },
    trusted: true,
    connected: true,
    now
  })
  const reachable = deriveReachabilitySnapshot({
    node: {
      id: 'C',
      host: '192.168.31.30',
      pairingKey: 'key',
      lastSeen: now - 10_000
    },
    trusted: true,
    now
  })

  assert.equal(online.status, 'online')
  assert.equal(isReachableStatus(online.status), true)
  assert.equal(reachable.status, 'reachable')
  assert.equal(reachable.sendable, true)
})

test('reachability snapshot keeps stale or untrusted nodes out of sendable targets', () => {
  const now = 1_000_000
  const known = deriveReachabilitySnapshot({
    node: {
      id: 'D',
      host: '192.168.31.40',
      pairingKey: 'key',
      lastSeen: now - 10 * 60 * 1000
    },
    trusted: true,
    now
  })
  const routeKnown = deriveReachabilitySnapshot({
    node: {
      id: 'E',
      routeNextHopId: 'B',
      routeMetric: 15,
      routeUpdatedAt: now - 15 * 60 * 1000
    },
    route: {
      destinationId: 'E',
      nextHopId: 'B',
      metric: 15,
      active: true,
      partiallyActive: false,
      updatedAt: now - 15 * 60 * 1000
    },
    trusted: true,
    now
  })
  const untrusted = deriveReachabilitySnapshot({
    node: { id: 'F', host: '192.168.31.50' },
    trusted: false,
    now
  })

  assert.equal(known.status, 'known')
  assert.equal(known.sendable, false)
  assert.equal(routeKnown.status, 'known')
  assert.equal(routeKnown.reachable, false)
  assert.equal(untrusted.status, 'known')
  assert.equal(untrusted.sendable, false)
})

test('discovery-only nodes reuse known status with discoveredOnly marker', () => {
  const snapshot = deriveReachabilitySnapshot({
    node: { id: 'G', host: '192.168.31.60', authority: 'lan_discovery', discoveredOnly: true },
    trusted: false,
    discoveredOnly: true,
    now: 1_000_000
  })

  assert.equal(snapshot.status, 'known')
  assert.equal(snapshot.discoveredOnly, true)
  assert.equal(snapshot.sendable, false)
})

test('bus reliability store deduplicates inbound messages and retries pending outbound', () => {
  let saved = null
  const store = createBusReliabilityStore({
    retryBaseMs: 1,
    retryMaxMs: 10,
    maxAttempts: 2,
    saveState: state => { saved = state }
  })
  const envelope = {
    networkId: 'net',
    topic: 'clipboard.text',
    originNodeId: 'A',
    sourceNodeId: 'A',
    messageId: 'm-1'
  }

  assert.equal(store.rememberInbound(envelope), true)
  assert.equal(store.rememberInbound(envelope), false)

  const record = store.rememberOutbound(envelope, 'B')
  assert.equal(record.status, 'pending')
  assert.equal(store.dueRecords().length, 1)
  store.markFailed('m-1', 'B', 'network')
  assert.equal(store.size().outbox, 1)
  store.markDelivered('m-1', 'B')
  assert.equal(store.size().outbox, 0)
  store.flushSave()
  assert.equal(saved.version, 1)
})

test('bus reliability drops expired codes and terminal failures from outbox', () => {
  const expiredStore = createBusReliabilityStore()
  const expiredCode = {
    networkId: 'net',
    topic: 'sms.code',
    originNodeId: 'A',
    sourceNodeId: 'A',
    messageId: 'expired',
    timestamp: Date.now() - 3 * 60 * 1000,
    payload: { type: 'sms', code: '839201' }
  }
  assert.equal(expiredStore.rememberOutbound(expiredCode, 'B'), null)

  const failedStore = createBusReliabilityStore({ maxAttempts: 1 })
  const pending = {
    ...expiredCode,
    messageId: 'pending',
    timestamp: Date.now(),
    payload: { type: 'sms', code: '123456', expiresAt: Date.now() + 60_000 }
  }
  assert.ok(failedStore.rememberOutbound(pending, 'B'))
  failedStore.markFailed('pending', 'B', 'network')
  assert.equal(failedStore.size().outbox, 0)
  assert.deepEqual(failedStore.exportState().outbox, [])
})

test('content bus waits for async websocket ack before marking delivered', async () => {
  const delivered = []
  const failed = []
  let resolveWs
  const bus = createContentBus({
    getIdentity: () => ({ id: 'A', name: 'Node A', type: 'WINDOWS_DESKTOP' }),
    getNetworkId: () => 'net-1',
    getTargetNode: targetId => ({ id: targetId, name: 'Node B', pairingKey: 'key' }),
    getTopologyRoutes: () => [],
    hasActiveWs: () => true,
    canPush: () => true,
    canReceive: () => true,
    sendWs: () => new Promise(resolve => { resolveWs = resolve }),
    reliabilityStore: {
      rememberInbound: () => true,
      rememberOutbound: () => {},
      markDelivered: (messageId, targetNodeId) => delivered.push({ messageId, targetNodeId }),
      markFailed: (messageId, targetNodeId, reason) => failed.push({ messageId, targetNodeId, reason }),
      dueRecords: () => []
    }
  })

  const publish = bus.publish(busEnvelope.TOPICS.CLIPBOARD_TEXT, {
    type: 'clipboard_text',
    text: 'hello'
  }, { targetNodeIds: ['B'] })
  await new Promise(resolve => setImmediate(resolve))

  assert.equal(delivered.length, 0)
  assert.equal(failed.length, 0)
  resolveWs(true)

  const result = await publish
  assert.equal(result.delivered, 1)
  assert.equal(delivered.length, 1)
  assert.equal(delivered[0].targetNodeId, 'B')
})

test('relay HTTP client treats rejected bus ack as delivery failure', async () => {
  const server = http.createServer((req, res) => {
    req.resume()
    res.writeHead(202, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ type: 'bus_ack', accepted: false, reason: 'policy_denied' }))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const { port } = server.address()
    const ok = await relayClient.postJsonToNode('127.0.0.1', port, { hello: 'bus' }, { path: '/bus/message' })
    assert.equal(ok, false)
  } finally {
    await new Promise(resolve => server.close(resolve))
  }
})

test('relay HTTP response validator rejects fake ACK and accepts a nonce-bound signed ACK', async () => {
  const pairingKey = Buffer.alloc(32, 13).toString('base64')
  const expected = {
    nonce: 'request-nonce',
    messageId: 'message-123',
    accepted: true
  }
  let signed = false
  const server = http.createServer((req, res) => {
    req.resume()
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(signed
      ? busAck.buildBusAck(pairingKey, expected)
      : { type: 'bus_ack', accepted: true, messageId: expected.messageId }))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const { port } = server.address()
    const options = {
      path: '/bus/message',
      validateResponse: ack => busAck.verifyBusAck(ack, pairingKey, expected)
    }
    assert.equal(await relayClient.postJsonToNode('127.0.0.1', port, {}, options), false)
    signed = true
    assert.equal(await relayClient.postJsonToNode('127.0.0.1', port, {}, options), true)
  } finally {
    await new Promise(resolve => server.close(resolve))
  }
})
