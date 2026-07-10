'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')

const {
  serializeSecureJsonState,
  parseSecureJsonState
} = require('../src/main/secure-json-state')
const {
  canonicalAuthContext,
  canonicalAckContext,
  isValidHandshakeNonce,
  createServerProof,
  verifyServerProof,
  createCodeAckToken,
  verifyCodeAckToken,
  resolveDerivedSessionKey,
  guardUnauthenticatedWebSocket
} = require('../src/main/websocket-security')

function fakeSafeStorage() {
  return {
    isEncryptionAvailable: () => true,
    encryptString: value => Buffer.from(String(value).split('').reverse().join(''), 'utf8'),
    decryptString: value => Buffer.from(value).toString('utf8').split('').reverse().join('')
  }
}

test('secure JSON state encrypts payloads and reads legacy plaintext for migration', () => {
  const safeStorage = fakeSafeStorage()
  const state = { outbox: [{ envelope: { payload: { code: '839201' } } }] }
  const serialized = serializeSecureJsonState(state, { safeStorage })

  assert.equal(serialized.includes('839201'), false)
  assert.deepEqual(parseSecureJsonState(serialized, { safeStorage }).state, state)

  const legacy = parseSecureJsonState(JSON.stringify(state), { safeStorage })
  assert.equal(legacy.legacyPlaintext, true)
  assert.deepEqual(legacy.state, state)
})

test('secure JSON state drops outbox content when OS encryption is unavailable', () => {
  const state = { version: 1, seen: [{ key: 'dedupe' }], outbox: [{ secret: 'otp' }] }
  const serialized = serializeSecureJsonState(state, {
    fallbackState: value => ({ version: value.version, seen: value.seen, outbox: [] })
  })
  const decoded = parseSecureJsonState(serialized)

  assert.deepEqual(decoded.state.outbox, [])
  assert.deepEqual(decoded.state.seen, [{ key: 'dedupe' }])
  assert.equal(serialized.includes('otp'), false)
})

test('desktop auth accepts only a derived key with a canonical 16-byte server nonce', () => {
  const pairingKey = Buffer.alloc(32, 3).toString('base64')
  const clientNonce = Buffer.alloc(16, 5).toString('base64')
  const nonce = Buffer.alloc(16, 7).toString('base64')
  const derivedKey = Buffer.alloc(32, 9).toString('base64')
  const deriveSessionKey = () => derivedKey
  const proof = createServerProof(pairingKey, {
    clientId: 'phone-1',
    serverId: 'desktop-1',
    clientNonce,
    serverNonce: nonce
  })
  const authOk = {
    keyMode: 'derived',
    serverId: 'desktop-1',
    serverNonce: nonce,
    serverProof: proof
  }

  assert.equal(isValidHandshakeNonce(nonce), true)
  assert.equal(isValidHandshakeNonce('not-base64'), false)
  assert.equal(resolveDerivedSessionKey(authOk, {
    pairingKey,
    clientId: 'phone-1',
    expectedServerId: 'desktop-1',
    clientNonce,
    deriveSessionKey
  }), derivedKey)
  assert.equal(resolveDerivedSessionKey({ keyMode: 'plain', sessionKey: derivedKey }, {
    pairingKey,
    clientId: 'phone-1',
    expectedServerId: 'desktop-1',
    clientNonce,
    deriveSessionKey
  }), null)
  assert.equal(resolveDerivedSessionKey({ keyMode: 'derived', serverNonce: 'bad' }, {
    pairingKey,
    clientId: 'phone-1',
    expectedServerId: 'desktop-1',
    clientNonce,
    deriveSessionKey
  }), null)
  assert.equal(resolveDerivedSessionKey({ ...authOk, serverId: 'attacker' }, {
    pairingKey,
    clientId: 'phone-1',
    expectedServerId: 'desktop-1',
    clientNonce,
    deriveSessionKey
  }), null)
  assert.equal(resolveDerivedSessionKey({ ...authOk, serverProof: `${proof.slice(0, -2)}AA` }, {
    pairingKey,
    clientId: 'phone-1',
    expectedServerId: 'desktop-1',
    clientNonce,
    deriveSessionKey
  }), null)
})

test('server proof and ACK tokens use canonical length-prefixed contexts', () => {
  const pairingKey = Buffer.alloc(32, 11).toString('base64')
  const sessionKey = Buffer.alloc(32, 12).toString('base64')
  const clientNonce = Buffer.alloc(16, 13).toString('base64')
  const serverNonce = Buffer.alloc(16, 14).toString('base64')

  assert.equal(
    canonicalAuthContext('phone', 'desktop', clientNonce, serverNonce),
    `codebridge-auth-v1|5:phone|7:desktop|24:${clientNonce}|24:${serverNonce}`
  )
  assert.equal(canonicalAckContext('m-123'), 'codebridge-ack-v1|5:m-123')

  const proof = createServerProof(pairingKey, {
    clientId: 'phone', serverId: 'desktop', clientNonce, serverNonce
  })
  assert.equal(verifyServerProof(pairingKey, proof, {
    clientId: 'phone', serverId: 'desktop', clientNonce, serverNonce
  }), true)
  assert.equal(verifyServerProof(pairingKey, proof, {
    clientId: 'phone', serverId: 'other', clientNonce, serverNonce
  }), false)

  const ackToken = createCodeAckToken(sessionKey, 'm-123')
  assert.equal(verifyCodeAckToken(sessionKey, 'm-123', ackToken), true)
  assert.equal(verifyCodeAckToken(sessionKey, 'm-124', ackToken), false)
  assert.equal(verifyCodeAckToken(sessionKey, 'm-123', ''), false)
})

test('connection guard consumes websocket errors and cleans up exactly once', () => {
  const ws = new EventEmitter()
  let terminated = 0
  let cleaned = 0
  let timerCallback = null
  ws.terminate = () => { terminated += 1 }
  ws.close = () => {}

  const guard = guardUnauthenticatedWebSocket(ws, {
    setTimeout: callback => {
      timerCallback = callback
      return { unref() {} }
    },
    clearTimeout: () => {},
    onCleanup: () => { cleaned += 1 }
  })

  ws.emit('error', new Error('bad frame'))
  ws.emit('close')
  timerCallback()

  assert.equal(guard.isCleaned(), true)
  assert.equal(guard.markAuthenticated(), false)
  assert.equal(cleaned, 1)
  assert.equal(terminated, 1)
})
