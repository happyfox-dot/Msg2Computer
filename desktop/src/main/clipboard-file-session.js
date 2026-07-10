'use strict'

function firstString(...values) {
  for (const value of values) {
    const normalized = String(value || '').trim()
    if (normalized) return normalized
  }
  return ''
}

function incomingClipboardFileKey(codeInfo = {}, codeData = {}, manifest = {}) {
  const version = (codeData && codeData.clipVersion) || codeInfo.clipVersion || {}
  const origin = firstString(
    version.origin,
    codeInfo.originDeviceId,
    codeInfo.sourceDeviceId,
    manifest.originDeviceId
  )
  const batchId = firstString(
    codeData && codeData.clipboardBatchId,
    codeInfo.clipboardBatchId,
    codeData && codeData.batchId,
    codeInfo.batchId
  )

  // Android may assign a separate clipVersion timestamp to every file in one
  // clipboard operation. A shared batch id is therefore the authoritative
  // session identity and must win over the per-file version.
  if (batchId) return ['batch', origin, batchId].join('|')

  const ts = Number(version.ts) || Number(codeInfo.timestamp) || 0
  const hash = String(version.hash || version.signature || '').trim()
  if (ts > 0 && origin) return ['version', ts, origin, hash].join('|')
  return ['file', origin, String(manifest.fileId || Date.now())].join('|')
}

module.exports = { incomingClipboardFileKey }
