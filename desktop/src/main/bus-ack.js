'use strict'

const crypto = require('crypto')

const BUS_ACK_CONTEXT = 'codebridge-bus-ack-v1'

function frameUtf8(value) {
  const text = String(value)
  return `${Buffer.byteLength(text, 'utf8')}:${text}`
}

function canonicalBusAckContext({ nonce, messageId, accepted } = {}) {
  if (typeof nonce !== 'string' || !nonce) return ''
  if (typeof messageId !== 'string' || !messageId) return ''
  if (accepted !== true && accepted !== false) return ''
  const acceptedFlag = accepted ? '1' : '0'
  return [
    BUS_ACK_CONTEXT,
    frameUtf8(nonce),
    frameUtf8(messageId),
    frameUtf8(acceptedFlag)
  ].join('|')
}

function createBusAckToken(pairingKey, fields = {}) {
  const context = canonicalBusAckContext(fields)
  if (!context) return ''
  try {
    const key = Buffer.from(String(pairingKey || ''), 'base64')
    if (key.length === 0) return ''
    return crypto.createHmac('sha256', key).update(context, 'utf8').digest('base64')
  } catch (_) {
    return ''
  }
}

function timingSafeTokenEqual(expected, actual) {
  try {
    const left = Buffer.from(String(expected || ''), 'base64')
    const right = Buffer.from(String(actual || ''), 'base64')
    return left.length > 0 && left.length === right.length && crypto.timingSafeEqual(left, right)
  } catch (_) {
    return false
  }
}

function buildBusAck(pairingKey, fields = {}, extras = {}) {
  const nonce = typeof fields.nonce === 'string' ? fields.nonce : ''
  const messageId = typeof fields.messageId === 'string' ? fields.messageId : ''
  const accepted = fields.accepted
  const ackToken = createBusAckToken(pairingKey, { nonce, messageId, accepted })
  if (!ackToken) return null
  return {
    ...extras,
    type: 'bus_ack',
    accepted,
    messageId,
    ackToken
  }
}

function verifyBusAck(ack, pairingKey, expected = {}) {
  if (!ack || ack.type !== 'bus_ack') return false
  if (ack.accepted !== true && ack.accepted !== false) return false
  if (typeof ack.messageId !== 'string' || ack.messageId !== expected.messageId) return false
  if (typeof expected.nonce !== 'string' || !expected.nonce) return false
  if (expected.accepted !== undefined && ack.accepted !== expected.accepted) return false
  const token = createBusAckToken(pairingKey, {
    nonce: expected.nonce,
    messageId: ack.messageId,
    accepted: ack.accepted
  })
  return timingSafeTokenEqual(token, ack.ackToken)
}

module.exports = {
  BUS_ACK_CONTEXT,
  frameUtf8,
  canonicalBusAckContext,
  createBusAckToken,
  buildBusAck,
  verifyBusAck
}
