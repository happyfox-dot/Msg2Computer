'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const joinPolicy = require('../src/main/join-policy')

test('join policy exposes peer softbus capabilities', () => {
  const capabilities = joinPolicy.getNodeCapabilities()

  assert.equal(capabilities.softBus, true)
  assert.equal(capabilities.p2pDirect, true)
  assert.equal(capabilities.joinRequest, true)
})

test('join policy templates keep files opt-in unless full sync is selected', () => {
  const basic = joinPolicy.contentPolicyForJoinTemplate('basic')
  const full = joinPolicy.contentPolicyForJoinTemplate('full')
  const topologyOnly = joinPolicy.contentPolicyForJoinTemplate('topology_only')

  assert.equal(basic.allowSmsCodes, true)
  assert.equal(basic.allowClipboardText, true)
  assert.equal(basic.allowFileTransfer, false)
  assert.equal(full.allowFileTransfer, true)
  assert.equal(full.allowClipboardFile, true)
  assert.equal(topologyOnly.allowSmsCodes, false)
  assert.equal(topologyOnly.allowTotp, false)
})
