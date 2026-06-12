'use strict'

const BUS_VERSION = 1

const TOPICS = Object.freeze({
  TOPOLOGY_DELTA: 'topology.delta',
  SMS_CODE: 'sms.code',
  SMS_RAW: 'sms.raw',
  APP_NOTIFICATION: 'notification.app',
  TOTP_SEED: 'totp.seed',
  TOTP_REVOKE: 'totp.revoke',
  CLIPBOARD_TEXT: 'clipboard.text',
  CLIPBOARD_IMAGE: 'clipboard.image',
  CLIPBOARD_FILE: 'clipboard.file',
  FILE_MANIFEST: 'file.manifest'
})

const LEGACY_TYPE_TO_TOPIC = Object.freeze({
  topology_delta: TOPICS.TOPOLOGY_DELTA,
  node_advertisement: TOPICS.TOPOLOGY_DELTA,
  link_advertisement: TOPICS.TOPOLOGY_DELTA,
  sms: TOPICS.SMS_CODE,
  sms_message: TOPICS.SMS_RAW,
  app_notification: TOPICS.APP_NOTIFICATION,
  totp_seed: TOPICS.TOTP_SEED,
  totp_revoke: TOPICS.TOTP_REVOKE,
  clipboard: TOPICS.CLIPBOARD_TEXT,
  clipboard_text: TOPICS.CLIPBOARD_TEXT,
  clipboard_image: TOPICS.CLIPBOARD_IMAGE,
  clipboard_file: TOPICS.CLIPBOARD_FILE,
  file_transfer: TOPICS.FILE_MANIFEST
})

const TOPIC_TO_LEGACY_TYPE = Object.freeze({
  [TOPICS.TOPOLOGY_DELTA]: 'topology_delta',
  [TOPICS.SMS_CODE]: 'sms',
  [TOPICS.SMS_RAW]: 'sms_message',
  [TOPICS.APP_NOTIFICATION]: 'app_notification',
  [TOPICS.TOTP_SEED]: 'totp_seed',
  [TOPICS.TOTP_REVOKE]: 'totp_revoke',
  [TOPICS.CLIPBOARD_TEXT]: 'clipboard_text',
  [TOPICS.CLIPBOARD_IMAGE]: 'clipboard_image',
  [TOPICS.CLIPBOARD_FILE]: 'clipboard_file',
  [TOPICS.FILE_MANIFEST]: 'file_transfer'
})

function stringList(value) {
  return Array.isArray(value)
    ? Array.from(new Set(value.map(item => String(item || '').trim()).filter(Boolean)))
    : []
}

function stableMessageId(identity, topic, payload = {}) {
  const existing = payload.originMessageId || payload.relayMessageId || payload.msgId || payload.fileManifest?.fileId
  if (existing) return String(existing)
  const nodeId = identity?.id || payload.sourceDeviceId || payload.phoneId || 'node'
  return `bus-${nodeId}-${topic}-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`
}

function topicForLegacyType(type) {
  return LEGACY_TYPE_TO_TOPIC[String(type || '')] || String(type || 'message.custom').replace(/_/g, '.')
}

function legacyTypeForTopic(topic) {
  return TOPIC_TO_LEGACY_TYPE[String(topic || '')] || String(topic || '').replace(/\./g, '_')
}

function createEnvelope({
  identity,
  networkId = '',
  topic,
  payload = {},
  targetNodeIds,
  ttl,
  seq,
  qos = 'at_least_once',
  routePath
}) {
  const normalizedTopic = topic || topicForLegacyType(payload.type)
  const now = Date.now()
  const sourceNodeId = String(identity?.id || payload.sourceDeviceId || payload.phoneId || '').trim()
  const originNodeId = String(payload.originDeviceId || sourceNodeId).trim()
  const messageId = stableMessageId(identity, normalizedTopic, payload)
  return {
    busVersion: BUS_VERSION,
    messageId,
    networkId: String(networkId || payload.networkId || '').trim(),
    topic: normalizedTopic,
    sourceNodeId,
    sourceNodeName: identity?.name || payload.sourceDeviceName || payload.phoneName || '',
    sourceNodeType: identity?.type || payload.sourceDeviceType || '',
    originNodeId,
    targetNodeIds: stringList(targetNodeIds || payload.targetDeviceIds),
    ttl: Number.isFinite(Number(ttl ?? payload.relayTtl ?? payload.ttl))
      ? Math.max(0, Number(ttl ?? payload.relayTtl ?? payload.ttl))
      : 4,
    seq: Number.isFinite(Number(seq || payload.seq)) ? Number(seq || payload.seq) : now,
    qos,
    routePath: stringList(routePath || payload.relayPath),
    timestamp: Number(payload.timestamp || now),
    payload: JSON.parse(JSON.stringify(payload || {}))
  }
}

function fromLegacyPayload(payload = {}, options = {}) {
  const identity = options.identity || {}
  return createEnvelope({
    identity,
    networkId: options.networkId,
    topic: options.topic || topicForLegacyType(payload.type),
    payload,
    targetNodeIds: options.targetNodeIds,
    ttl: options.ttl,
    seq: options.seq,
    qos: options.qos,
    routePath: options.routePath
  })
}

function toLegacyPayload(envelope = {}) {
  const payload = JSON.parse(JSON.stringify(envelope.payload || {}))
  const type = payload.type || legacyTypeForTopic(envelope.topic)
  payload.type = type
  payload.contentType = payload.contentType || type
  payload.originMessageId = payload.originMessageId || envelope.messageId
  payload.relayMessageId = payload.relayMessageId || envelope.messageId
  payload.msgId = payload.msgId || envelope.messageId
  payload.networkId = payload.networkId || envelope.networkId || ''
  payload.sourceDeviceId = payload.sourceDeviceId || envelope.sourceNodeId || ''
  payload.originDeviceId = payload.originDeviceId || envelope.originNodeId || payload.sourceDeviceId || ''
  payload.timestamp = payload.timestamp || envelope.timestamp || Date.now()
  payload.targetDeviceIds = stringList(payload.targetDeviceIds || envelope.targetNodeIds)
  payload.relayPath = stringList(payload.relayPath || envelope.routePath)
  payload.relayTtl = Number.isFinite(Number(payload.relayTtl)) ? Number(payload.relayTtl) : Number(envelope.ttl || 0)
  return payload
}

function isEnvelope(value) {
  return !!value && Number(value.busVersion) >= 1 && typeof value.topic === 'string' && typeof value.messageId === 'string'
}

module.exports = {
  BUS_VERSION,
  TOPICS,
  LEGACY_TYPE_TO_TOPIC,
  TOPIC_TO_LEGACY_TYPE,
  topicForLegacyType,
  legacyTypeForTopic,
  createEnvelope,
  fromLegacyPayload,
  toLegacyPayload,
  isEnvelope
}
