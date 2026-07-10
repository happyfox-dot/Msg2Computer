'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const trustedNode = require('../src/main/trusted-node')

test('trusted topology node with only Tailscale host is importable', () => {
  const node = {
    id: 'phone-c',
    routable: true,
    pairingKey: 'pairing-key',
    tsHost: '100.64.0.8'
  }

  assert.equal(trustedNode.shouldImportTrustedTopologyNode(node), true)
  assert.equal(trustedNode.primaryTrustedNodeHost(node), '100.64.0.8')
})

test('trusted topology node with only alternate hosts is importable', () => {
  const node = {
    id: 'desktop-d',
    routable: true,
    pairingKey: 'pairing-key',
    altHosts: ['::ffff:192.168.31.200', '100.64.0.12']
  }

  assert.equal(trustedNode.shouldImportTrustedTopologyNode(node), true)
  assert.deepEqual(trustedNode.withPrimaryTrustedHost(node), {
    ...node,
    host: '192.168.31.200',
    lastIP: '192.168.31.200',
    altHosts: ['100.64.0.12']
  })
})

test('route-only trusted node can enter routing but not direct import', () => {
  const node = {
    id: 'relay-only',
    routable: true,
    pairingKey: 'pairing-key',
    routeNextHopId: 'desktop-b',
    routePath: ['desktop-a', 'desktop-b', 'relay-only']
  }

  assert.equal(trustedNode.shouldImportTrustedTopologyNode(node), false)
  assert.equal(trustedNode.shouldRouteTrustedTopologyNode(node), true)
})

test('discovery host is only a candidate until authenticated', () => {
  const peer = {
    id: 'desktop-b',
    host: '192.168.1.10',
    lastIP: '192.168.1.10',
    tsHost: '100.64.0.10',
    pairingKey: 'secret'
  }
  const before = { ...peer }
  const candidates = trustedNode.connectionCandidateHosts(peer, {
    id: 'desktop-b',
    host: '192.168.1.99'
  })

  assert.deepEqual(peer, before)
  assert.deepEqual(candidates, ['192.168.1.10', '100.64.0.10', '192.168.1.99'])

  const authenticated = trustedNode.withAuthenticatedHost(peer, '192.168.1.99')
  assert.equal(authenticated.host, '192.168.1.99')
  assert.equal(authenticated.lastIP, '192.168.1.99')
  assert.deepEqual(authenticated.altHosts, ['192.168.1.10'])
})

test('discovery candidate must match the paired node id', () => {
  assert.deepEqual(trustedNode.connectionCandidateHosts(
    { id: 'desktop-b', host: '192.168.1.10' },
    { id: 'attacker', host: '192.168.1.99' }
  ), ['192.168.1.10'])
})

test('HTTP delivery retains stored hosts and appends only a same-id discovery host', () => {
  const phone = {
    id: 'phone-b',
    lastIP: '192.168.1.10',
    tsHost: '100.64.0.10'
  }
  const before = { ...phone }

  assert.deepEqual(trustedNode.deliveryCandidateHosts(
    phone,
    { id: 'phone-b', host: '192.168.1.99' },
    '192.168.1.20'
  ), [
    '192.168.1.20',
    '192.168.1.10',
    '100.64.0.10',
    '192.168.1.99'
  ])
  assert.deepEqual(phone, before)
  assert.deepEqual(trustedNode.deliveryCandidateHosts(
    phone,
    { id: 'attacker', host: '192.168.1.77' }
  ), ['192.168.1.10', '100.64.0.10'])
})
