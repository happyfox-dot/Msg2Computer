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
