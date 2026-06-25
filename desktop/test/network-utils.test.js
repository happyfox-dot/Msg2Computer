'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const networkUtils = require('../src/main/network-utils')

test('network utils normalize IPv4-mapped hosts and preserve host order', () => {
  assert.equal(networkUtils.normalizeNetworkHost('::ffff:192.168.31.77'), '192.168.31.77')
  assert.deepEqual(
    networkUtils.collectNetworkHosts('', '::ffff:192.168.31.77', ['192.168.31.77', '100.64.0.8']),
    ['192.168.31.77', '100.64.0.8']
  )
})

test('network utils prefer LAN interface over Tailscale and virtual interfaces', () => {
  const candidates = networkUtils.getLocalIPCandidates({
    'Tailscale': [{ family: 'IPv4', internal: false, address: '100.64.0.8' }],
    'Wi-Fi': [{ family: 'IPv4', internal: false, address: '192.168.31.77' }],
    'vEthernet': [{ family: 'IPv4', internal: false, address: '172.20.1.10' }]
  })

  assert.equal(networkUtils.isTailscaleAddress('100.64.0.8'), true)
  assert.equal(candidates[0].address, '192.168.31.77')
})

test('network utils compute interface broadcast addresses', () => {
  assert.deepEqual(
    networkUtils.getBroadcastAddresses({
      'Wi-Fi': [{ family: 'IPv4', internal: false, address: '192.168.31.77', netmask: '255.255.255.0' }]
    }).sort(),
    ['192.168.31.255', '255.255.255.255'].sort()
  )
})
