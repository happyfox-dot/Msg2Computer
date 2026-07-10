'use strict'

function normalizeClipboardVersion(state = {}) {
  return {
    ts: Number(state.ts) || 0,
    origin: String(state.origin || ''),
    hash: String(state.hash || ''),
    kind: String(state.kind || '')
  }
}

function compareClipboardVersion(a = {}, b = {}) {
  const left = normalizeClipboardVersion(a)
  const right = normalizeClipboardVersion(b)
  if (left.ts !== right.ts) return left.ts - right.ts
  return left.origin.localeCompare(right.origin)
}

function isNewerClipboardVersion(current = {}, incoming = {}) {
  const next = normalizeClipboardVersion(incoming)
  if (next.ts <= 0) return false
  return compareClipboardVersion(next, current) > 0
}

function rememberClipboardVersion(_current = {}, incoming = {}) {
  return normalizeClipboardVersion(incoming)
}

function bestClipboardVersion(...states) {
  return states
    .map(normalizeClipboardVersion)
    .reduce((best, state) => (compareClipboardVersion(state, best) > 0 ? state : best), normalizeClipboardVersion())
}

function hasSameClipboardHash(current = {}, hash = '') {
  const value = String(hash || '')
  return !!value && value === normalizeClipboardVersion(current).hash
}

function nextLocalClipboardTimestamp(current = {}, now = Date.now()) {
  const currentTs = normalizeClipboardVersion(current).ts
  return Math.max(Number(now) || 0, currentTs + 1)
}

module.exports = {
  normalizeClipboardVersion,
  compareClipboardVersion,
  isNewerClipboardVersion,
  rememberClipboardVersion,
  bestClipboardVersion,
  hasSameClipboardHash,
  nextLocalClipboardTimestamp
}
