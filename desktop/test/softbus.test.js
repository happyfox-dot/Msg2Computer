'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const busEnvelope = require('../src/main/bus-envelope')
const {
  buildPeerRoutes,
  chooseBestRoute,
  createRouteHealthTracker,
  isTailscaleAddress
} = require('../src/main/route-manager')
const {
  createBusReliabilityStore
} = require('../src/main/bus-reliability')

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
