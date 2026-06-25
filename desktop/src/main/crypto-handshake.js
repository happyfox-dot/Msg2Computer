'use strict'

const crypto = require('crypto')

function generateNonce() {
  return crypto.randomBytes(16).toString('base64')
}

function generateTrustedNetworkId() {
  return `net-${crypto.randomBytes(16).toString('hex')}`
}

function createLanJoinKeyPair() {
  return crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
}

function exportPublicKey(publicKey) {
  return publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
}

function deriveLanJoinKey(privateKey, peerPublicKeyBase64) {
  const publicKey = crypto.createPublicKey({
    key: Buffer.from(String(peerPublicKeyBase64 || ''), 'base64'),
    type: 'spki',
    format: 'der'
  })
  const shared = crypto.diffieHellman({ privateKey, publicKey })
  return crypto
    .createHash('sha256')
    .update(shared)
    .update('codebridge-lan-join-v1')
    .digest('base64')
}

function createLanJoinRequestKey(targetJoinPublicKey) {
  const pair = createLanJoinKeyPair()
  return {
    publicKey: exportPublicKey(pair.publicKey),
    sessionKey: deriveLanJoinKey(pair.privateKey, targetJoinPublicKey)
  }
}

function createLanJoinAcceptKey(serverPrivateKey, requesterPublicKey) {
  return deriveLanJoinKey(serverPrivateKey, requesterPublicKey)
}

function getJoinFingerprint(identity = {}, networkId = '') {
  return crypto
    .createHash('sha256')
    .update(`${identity.id || ''}|${identity.name || ''}|${identity.type || ''}|${networkId || ''}`)
    .digest('hex')
    .slice(0, 16)
    .match(/.{1,4}/g)
    .join('-')
}

function hmacBase64(keyBase64, message) {
  return crypto
    .createHmac('sha256', Buffer.from(keyBase64, 'base64'))
    .update(message)
    .digest('base64')
}

function deriveSessionKeyWithPairingKey(pairingKeyValue, phoneNonce, serverNonce) {
  return hmacBase64(pairingKeyValue, `session|${phoneNonce}|${serverNonce}`)
}

module.exports = {
  generateNonce,
  generateTrustedNetworkId,
  createLanJoinKeyPair,
  exportPublicKey,
  deriveLanJoinKey,
  createLanJoinRequestKey,
  createLanJoinAcceptKey,
  getJoinFingerprint,
  hmacBase64,
  deriveSessionKeyWithPairingKey
}
