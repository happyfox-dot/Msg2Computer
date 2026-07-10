'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const busAck = require('../src/main/bus-ack')

const pairingKey = 'BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc='

test('bus ACK canonical framing uses UTF-8 byte lengths and matches Android vector', () => {
  const fields = {
    nonce: '随机-α',
    messageId: '消息-β',
    accepted: true
  }
  assert.equal(
    busAck.canonicalBusAckContext(fields),
    'codebridge-bus-ack-v1|9:随机-α|9:消息-β|1:1'
  )
  assert.equal(
    busAck.createBusAckToken(pairingKey, fields),
    'OZKGeqxJtBs5jRGAZ2l4n1QmufvP4Ma55vWEW7BSgYs='
  )
})

test('bus ACK validation binds accepted flag, message id, and original request nonce', () => {
  const fields = {
    nonce: 'request-nonce',
    messageId: 'bus-message-1',
    accepted: true
  }
  const ack = busAck.buildBusAck(pairingKey, fields, { duplicate: true })
  assert.equal(busAck.verifyBusAck(ack, pairingKey, fields), true)
  assert.equal(busAck.verifyBusAck(ack, pairingKey, { ...fields, nonce: 'other-nonce' }), false)
  assert.equal(busAck.verifyBusAck(ack, pairingKey, { ...fields, messageId: 'bus-message-2' }), false)
  assert.equal(busAck.verifyBusAck({ ...ack, accepted: false }, pairingKey, fields), false)
  assert.equal(busAck.verifyBusAck({ ...ack, ackToken: 'fake' }, pairingKey, fields), false)
  assert.equal(busAck.verifyBusAck({ type: 'bus_ack', accepted: true, messageId: fields.messageId }, pairingKey, fields), false)
})

test('rejected bus ACKs have a distinct authenticated flag and cannot count as accepted', () => {
  const fields = {
    nonce: 'request-nonce',
    messageId: 'bus-message-1',
    accepted: false
  }
  const ack = busAck.buildBusAck(pairingKey, fields, { reason: 'policy_denied' })
  assert.equal(busAck.verifyBusAck(ack, pairingKey, fields), true)
  assert.equal(busAck.verifyBusAck(ack, pairingKey, { ...fields, accepted: true }), false)
  assert.notEqual(
    ack.ackToken,
    busAck.createBusAckToken(pairingKey, { ...fields, accepted: true })
  )
})
