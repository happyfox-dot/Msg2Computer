'use strict'

const crypto = require('crypto')

const AUTH_CONTEXT_VERSION = 'codebridge-auth-v1'
const ACK_CONTEXT_VERSION = 'codebridge-ack-v1'

function canonicalField(value) {
  const text = String(value ?? '')
  return `${Buffer.byteLength(text, 'utf8')}:${text}`
}

function canonicalAuthContext(clientId, serverId, clientNonce, serverNonce) {
  return [
    AUTH_CONTEXT_VERSION,
    canonicalField(clientId),
    canonicalField(serverId),
    canonicalField(clientNonce),
    canonicalField(serverNonce)
  ].join('|')
}

function canonicalAckContext(msgId) {
  return [ACK_CONTEXT_VERSION, canonicalField(msgId)].join('|')
}

function decodeCanonicalBase64(value, expectedBytes) {
  const text = typeof value === 'string' ? value : ''
  if (!text) return null
  try {
    const decoded = Buffer.from(text, 'base64')
    if (decoded.length !== expectedBytes || decoded.toString('base64') !== text) return null
    return decoded
  } catch (_) {
    return null
  }
}

function hmacBase64(keyBase64, message) {
  const key = decodeCanonicalBase64(keyBase64, 32)
  if (!key) return ''
  return crypto.createHmac('sha256', key).update(message, 'utf8').digest('base64')
}

function timingSafeBase64Equal(expectedBase64, actualBase64) {
  const expected = decodeCanonicalBase64(expectedBase64, 32)
  const actual = decodeCanonicalBase64(actualBase64, 32)
  return Boolean(expected && actual && crypto.timingSafeEqual(expected, actual))
}

function isValidHandshakeNonce(value, expectedBytes = 16) {
  const nonce = typeof value === 'string' ? value.trim() : ''
  if (!nonce || nonce.length > 128) return false
  try {
    const decoded = Buffer.from(nonce, 'base64')
    return decoded.length === expectedBytes && decoded.toString('base64') === nonce
  } catch (_) {
    return false
  }
}

function createServerProof(pairingKey, options = {}) {
  const clientId = String(options.clientId || '')
  const serverId = String(options.serverId || '')
  const clientNonce = String(options.clientNonce || '')
  const serverNonce = String(options.serverNonce || '')
  if (!clientId || !serverId || !isValidHandshakeNonce(clientNonce) || !isValidHandshakeNonce(serverNonce)) {
    return ''
  }
  return hmacBase64(
    pairingKey,
    canonicalAuthContext(clientId, serverId, clientNonce, serverNonce)
  )
}

function verifyServerProof(pairingKey, serverProof, options = {}) {
  const expected = createServerProof(pairingKey, options)
  return Boolean(expected && timingSafeBase64Equal(expected, serverProof))
}

function createCodeAckToken(sessionKey, msgId) {
  const normalizedMsgId = String(msgId || '')
  if (!normalizedMsgId) return ''
  return hmacBase64(sessionKey, canonicalAckContext(normalizedMsgId))
}

function verifyCodeAckToken(sessionKey, msgId, ackToken) {
  const expected = createCodeAckToken(sessionKey, msgId)
  return Boolean(expected && timingSafeBase64Equal(expected, ackToken))
}

function resolveDerivedSessionKey(message, options = {}) {
  if (!message || message.keyMode !== 'derived' || !isValidHandshakeNonce(message.serverNonce)) {
    return null
  }
  if (typeof options.deriveSessionKey !== 'function') return null
  const pairingKey = String(options.pairingKey || '')
  const clientNonce = String(options.clientNonce || '')
  const clientId = String(options.clientId || '')
  const expectedServerId = String(options.expectedServerId || '')
  const serverId = String(message.serverId || '')
  if (!pairingKey || !clientNonce || !clientId || !expectedServerId || serverId !== expectedServerId) return null
  if (!verifyServerProof(pairingKey, message.serverProof, {
    clientId,
    serverId,
    clientNonce,
    serverNonce: message.serverNonce
  })) return null
  const sessionKey = options.deriveSessionKey(pairingKey, clientNonce, message.serverNonce)
  if (typeof sessionKey !== 'string') return null
  try {
    const decoded = Buffer.from(sessionKey, 'base64')
    return decoded.length === 32 && decoded.toString('base64') === sessionKey
      ? sessionKey
      : null
  } catch (_) {
    return null
  }
}

function guardUnauthenticatedWebSocket(ws, options = {}) {
  const setTimeoutImpl = options.setTimeout || setTimeout
  const clearTimeoutImpl = options.clearTimeout || clearTimeout
  const authTimeoutMs = Math.max(1000, Number(options.authTimeoutMs || 10_000))
  let authenticated = false
  let cleaned = false

  const cleanup = () => {
    if (cleaned) return
    cleaned = true
    clearTimeoutImpl(authTimer)
    try { options.onCleanup?.() } catch (_) {}
  }

  const terminate = () => {
    try {
      if (typeof ws.terminate === 'function') ws.terminate()
      else if (typeof ws.close === 'function') ws.close()
    } catch (_) {}
  }

  const authTimer = setTimeoutImpl(() => {
    if (authenticated || cleaned) return
    try { options.onAuthTimeout?.() } catch (_) {}
    cleanup()
    try {
      if (typeof ws.close === 'function') ws.close(1008, 'authentication timeout')
    } catch (_) {}
    terminate()
  }, authTimeoutMs)
  authTimer.unref?.()

  ws.on('error', error => {
    try { options.onError?.(error) } catch (_) {}
    cleanup()
    terminate()
  })
  ws.on('close', cleanup)

  return {
    markAuthenticated() {
      if (cleaned) return false
      authenticated = true
      clearTimeoutImpl(authTimer)
      return true
    },
    cleanup,
    isAuthenticated: () => authenticated,
    isCleaned: () => cleaned
  }
}

module.exports = {
  canonicalAuthContext,
  canonicalAckContext,
  isValidHandshakeNonce,
  createServerProof,
  verifyServerProof,
  createCodeAckToken,
  verifyCodeAckToken,
  resolveDerivedSessionKey,
  guardUnauthenticatedWebSocket
}
