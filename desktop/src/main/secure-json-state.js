'use strict'

const SECURE_STATE_FORMAT = 'codebridge.secure-json'
const SECURE_STATE_VERSION = 1

function encryptionAvailable(safeStorage) {
  try {
    return !!safeStorage &&
      typeof safeStorage.isEncryptionAvailable === 'function' &&
      safeStorage.isEncryptionAvailable() === true &&
      typeof safeStorage.encryptString === 'function' &&
      typeof safeStorage.decryptString === 'function'
  } catch (_) {
    return false
  }
}

function serializeSecureJsonState(state, options = {}) {
  const safeStorage = options.safeStorage
  const serialized = JSON.stringify(state || {})
  if (encryptionAvailable(safeStorage)) {
    return JSON.stringify({
      format: SECURE_STATE_FORMAT,
      version: SECURE_STATE_VERSION,
      encryption: 'safeStorage',
      payload: safeStorage.encryptString(serialized).toString('base64')
    }, null, 2)
  }

  const fallbackState = typeof options.fallbackState === 'function'
    ? options.fallbackState(state || {})
    : {}
  return JSON.stringify({
    format: SECURE_STATE_FORMAT,
    version: SECURE_STATE_VERSION,
    encryption: 'unavailable',
    state: fallbackState || {}
  }, null, 2)
}

function parseSecureJsonState(raw, options = {}) {
  const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw
  if (!parsed || parsed.format !== SECURE_STATE_FORMAT) {
    return {
      state: parsed && typeof parsed === 'object' ? parsed : {},
      legacyPlaintext: true,
      encrypted: false
    }
  }

  if (parsed.encryption === 'safeStorage') {
    if (!encryptionAvailable(options.safeStorage)) {
      const error = new Error('safeStorage is unavailable for encrypted state')
      error.code = 'SAFE_STORAGE_UNAVAILABLE'
      throw error
    }
    const payload = String(parsed.payload || '')
    if (!payload) throw new Error('encrypted state payload is empty')
    const plaintext = options.safeStorage.decryptString(Buffer.from(payload, 'base64'))
    const state = JSON.parse(plaintext)
    return { state, legacyPlaintext: false, encrypted: true }
  }

  if (parsed.encryption === 'unavailable') {
    return {
      state: parsed.state && typeof parsed.state === 'object' ? parsed.state : {},
      legacyPlaintext: false,
      encrypted: false
    }
  }

  throw new Error(`unsupported secure state encryption: ${String(parsed.encryption || '')}`)
}

module.exports = {
  SECURE_STATE_FORMAT,
  encryptionAvailable,
  serializeSecureJsonState,
  parseSecureJsonState
}
