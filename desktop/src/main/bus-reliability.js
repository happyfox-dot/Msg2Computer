'use strict'

const DEFAULT_SEEN_LIMIT = 1000
const DEFAULT_OUTBOX_LIMIT = 300
const DEFAULT_SEEN_TTL_MS = 24 * 60 * 60 * 1000
const DEFAULT_RETRY_BASE_MS = 15 * 1000
const DEFAULT_RETRY_MAX_MS = 5 * 60 * 1000
const DEFAULT_MAX_ATTEMPTS = 8
const DEFAULT_MAX_RECORD_BYTES = 256 * 1024

function nowMs() {
  return Date.now()
}

function safeJsonClone(value) {
  return JSON.parse(JSON.stringify(value || {}))
}

function envelopeKey(envelope = {}) {
  const networkId = String(envelope.networkId || '').trim()
  const topic = String(envelope.topic || '').trim()
  const origin = String(envelope.originNodeId || envelope.sourceNodeId || '').trim()
  const messageId = String(envelope.messageId || '').trim()
  return [networkId, topic, origin, messageId].join('|')
}

function outboxKey(messageId, targetNodeId) {
  return `${String(messageId || '').trim()}|${String(targetNodeId || '').trim()}`
}

function normalizeRecord(raw = {}) {
  const envelope = raw.envelope && typeof raw.envelope === 'object' ? raw.envelope : null
  const targetNodeId = String(raw.targetNodeId || '').trim()
  const messageId = String(raw.messageId || envelope?.messageId || '').trim()
  if (!envelope || !targetNodeId || !messageId) return null
  if (!shouldPersistEnvelope(envelope)) return null
  const attempts = Math.max(0, Number(raw.attempts || 0) || 0)
  return {
    id: outboxKey(messageId, targetNodeId),
    messageId,
    targetNodeId,
    topic: String(raw.topic || envelope.topic || '').trim(),
    envelope: safeJsonClone(envelope),
    status: String(raw.status || 'pending'),
    attempts,
    createdAt: Number(raw.createdAt || nowMs()) || nowMs(),
    updatedAt: Number(raw.updatedAt || nowMs()) || nowMs(),
    nextAttemptAt: Number(raw.nextAttemptAt || 0) || 0,
    ackedAt: Number(raw.ackedAt || 0) || 0,
    lastError: String(raw.lastError || '')
  }
}

function shouldPersistEnvelope(envelope = {}) {
  const topic = String(envelope.topic || '').trim()
  const payload = envelope.payload && typeof envelope.payload === 'object' ? envelope.payload : {}
  const manifest = payload.fileManifest && typeof payload.fileManifest === 'object' ? payload.fileManifest : null
  if (manifest) {
    if (manifest.inline === true) return false
    const expiresAt = Number(manifest.expiresAt || 0) || 0
    if (expiresAt > 0 && expiresAt <= nowMs()) return false
  } else if (topic === 'clipboard.image' || topic === 'clipboard.file' || topic === 'file.manifest') {
    return false
  }
  const size = Buffer.byteLength(JSON.stringify(envelope || {}), 'utf8')
  return size > 0 && size <= DEFAULT_MAX_RECORD_BYTES
}

function createBusReliabilityStore(options = {}) {
  const {
    loadState = () => ({}),
    saveState = () => {},
    seenLimit = DEFAULT_SEEN_LIMIT,
    outboxLimit = DEFAULT_OUTBOX_LIMIT,
    seenTtlMs = DEFAULT_SEEN_TTL_MS,
    retryBaseMs = DEFAULT_RETRY_BASE_MS,
    retryMaxMs = DEFAULT_RETRY_MAX_MS,
    maxAttempts = DEFAULT_MAX_ATTEMPTS
  } = options

  const seen = new Map()
  const outbox = new Map()
  let saveTimer = null

  function scheduleSave() {
    if (saveTimer) return
    saveTimer = setTimeout(() => {
      saveTimer = null
      try {
        saveState(exportState())
      } catch (_) {}
    }, 250)
    saveTimer.unref?.()
  }

  function importState(state = {}) {
    seen.clear()
    outbox.clear()
    const now = nowMs()
    const seenEntries = Array.isArray(state.seen) ? state.seen : []
    for (const item of seenEntries) {
      const key = String(item?.key || '').trim()
      const firstSeenAt = Number(item?.firstSeenAt || 0) || 0
      if (key && now - firstSeenAt <= seenTtlMs) seen.set(key, firstSeenAt)
    }
    const outboxEntries = Array.isArray(state.outbox) ? state.outbox : []
    for (const item of outboxEntries) {
      const record = normalizeRecord(item)
      if (!record) continue
      if (record.status === 'acked') continue
      if (record.attempts >= maxAttempts && record.status === 'failed') continue
      outbox.set(record.id, record)
    }
    trimSeen()
    trimOutbox()
  }

  function exportState() {
    return {
      version: 1,
      seen: Array.from(seen.entries()).map(([key, firstSeenAt]) => ({ key, firstSeenAt })),
      outbox: Array.from(outbox.values()).map(record => safeJsonClone(record))
    }
  }

  function flushSave() {
    if (saveTimer) {
      clearTimeout(saveTimer)
      saveTimer = null
    }
    saveState(exportState())
  }

  function trimSeen() {
    const now = nowMs()
    for (const [key, firstSeenAt] of seen) {
      if (now - firstSeenAt > seenTtlMs) seen.delete(key)
    }
    while (seen.size > seenLimit) {
      seen.delete(seen.keys().next().value)
    }
  }

  function trimOutbox() {
    const records = Array.from(outbox.values())
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
    for (const record of records.slice(outboxLimit)) {
      outbox.delete(record.id)
    }
  }

  function rememberInbound(envelope) {
    const key = envelopeKey(envelope)
    if (!key || key.endsWith('|')) return true
    trimSeen()
    if (seen.has(key)) return false
    seen.set(key, nowMs())
    scheduleSave()
    return true
  }

  function rememberOutbound(envelope, targetNodeId) {
    const messageId = String(envelope?.messageId || '').trim()
    const targetId = String(targetNodeId || '').trim()
    if (!messageId || !targetId) return null
    if (!shouldPersistEnvelope(envelope)) return null
    const id = outboxKey(messageId, targetId)
    const existing = outbox.get(id)
    if (existing && existing.status !== 'acked') return existing
    const record = normalizeRecord({
      messageId,
      targetNodeId: targetId,
      topic: envelope.topic,
      envelope,
      status: 'pending',
      attempts: existing?.attempts || 0,
      createdAt: existing?.createdAt || nowMs(),
      updatedAt: nowMs(),
      nextAttemptAt: 0
    })
    if (!record) return null
    outbox.set(id, record)
    trimOutbox()
    scheduleSave()
    return record
  }

  function markDelivered(messageId, targetNodeId) {
    const id = outboxKey(messageId, targetNodeId)
    const record = outbox.get(id)
    if (!record) return
    record.status = 'acked'
    record.ackedAt = nowMs()
    record.updatedAt = record.ackedAt
    outbox.delete(id)
    scheduleSave()
  }

  function markFailed(messageId, targetNodeId, reason = '') {
    const id = outboxKey(messageId, targetNodeId)
    const record = outbox.get(id)
    if (!record) return
    record.attempts += 1
    record.lastError = String(reason || '')
    record.updatedAt = nowMs()
    if (record.attempts >= maxAttempts) {
      record.status = 'failed'
      record.nextAttemptAt = 0
    } else {
      const delay = Math.min(retryMaxMs, retryBaseMs * Math.pow(2, Math.max(0, record.attempts - 1)))
      record.status = 'pending'
      record.nextAttemptAt = record.updatedAt + delay
    }
    scheduleSave()
  }

  function dueRecords(limit = 50) {
    const now = nowMs()
    return Array.from(outbox.values())
      .filter(record => record.status === 'pending' && (!record.nextAttemptAt || record.nextAttemptAt <= now))
      .sort((a, b) => (a.nextAttemptAt || a.createdAt) - (b.nextAttemptAt || b.createdAt))
      .slice(0, limit)
      .map(record => safeJsonClone(record))
  }

  importState(loadState() || {})

  return {
    rememberInbound,
    rememberOutbound,
    markDelivered,
    markFailed,
    dueRecords,
    exportState,
    importState,
    flushSave,
    size: () => ({ seen: seen.size, outbox: outbox.size })
  }
}

module.exports = {
  createBusReliabilityStore,
  envelopeKey,
  outboxKey
}
