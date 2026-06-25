'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const handshake = require('../src/main/crypto-handshake')

test('LAN join ECDH derives the same accept and request session key', () => {
  const serverPair = handshake.createLanJoinKeyPair()
  const request = handshake.createLanJoinRequestKey(handshake.exportPublicKey(serverPair.publicKey))
  const acceptKey = handshake.createLanJoinAcceptKey(serverPair.privateKey, request.publicKey)

  assert.equal(request.sessionKey, acceptKey)
})

test('handshake derives stable fingerprints and session HMAC keys', () => {
  const identity = { id: 'desktop-a', name: 'Desk A', type: 'WINDOWS_DESKTOP' }
  assert.equal(
    handshake.getJoinFingerprint(identity, 'net-a'),
    handshake.getJoinFingerprint(identity, 'net-a')
  )
  assert.equal(
    handshake.deriveSessionKeyWithPairingKey(Buffer.from('pairing-key-32-byte-ish').toString('base64'), 'p1', 's1'),
    handshake.hmacBase64(Buffer.from('pairing-key-32-byte-ish').toString('base64'), 'session|p1|s1')
  )
})
