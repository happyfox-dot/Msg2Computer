'use strict'

const busEnvelope = require('./bus-envelope')
const routeManager = require('./route-manager')

const noopReliabilityStore = Object.freeze({
  rememberInbound: () => true,
  rememberOutbound: () => null,
  markDelivered: () => {},
  markFailed: () => {},
  dueRecords: () => []
})

const noopRouteHealth = Object.freeze({
  recordResult: () => {},
  rankRoutes: (_targetId, routes) => routes
})

function createContentBus(deps = {}) {
  const {
    getIdentity,
    getNetworkId,
    getTargetNode,
    getTopologyRoutes = () => [],
    hasActiveWs = () => false,
    canPush = () => true,
    canReceive = () => true,
    sendDirect = async () => false,
    sendWs = () => false,
    sendRelay = async () => false,
    onReceive = () => {},
    log = () => {},
    reliabilityStore = noopReliabilityStore,
    routeHealth = noopRouteHealth
  } = deps

  async function deliverEnvelopeToTarget(targetId, envelope, options = {}) {
    const target = getTargetNode(targetId)
    if (!target || !canPush(target, envelope.topic)) return false
    if (!options.retrying) reliabilityStore.rememberOutbound(envelope, targetId)

    const baseRoutes = routeManager.buildPeerRoutes({
      target,
      topologyRoutes: getTopologyRoutes(getIdentity().id),
      hasActiveWs: hasActiveWs(targetId),
      preferDirect: true
    })
    const routes = routeHealth.rankRoutes
      ? routeHealth.rankRoutes(targetId, baseRoutes)
      : baseRoutes

    let ok = false
    let lastRoute = null
    for (const route of routes) {
      lastRoute = route
      if (route.transportType === 'lan_direct' || route.transportType === 'tailscale_direct') {
        ok = await sendDirect(target, envelope, route)
      } else if (route.transportType === 'legacy_ws') {
        ok = await Promise.resolve(sendWs(target, envelope, route))
      } else {
        ok = await sendRelay(target, envelope, route)
      }
      routeHealth.recordResult?.(targetId, route, ok)
      if (ok) break
    }

    if (ok) {
      reliabilityStore.markDelivered(envelope.messageId, targetId)
    } else {
      reliabilityStore.markFailed(envelope.messageId, targetId, lastRoute ? `route_failed:${lastRoute.transportType}` : 'no_route')
    }
    return ok
  }

  async function publish(topic, payload = {}, options = {}) {
    const identity = getIdentity()
    const targetNodeIds = Array.isArray(options.targetNodeIds)
      ? options.targetNodeIds
      : Array.isArray(payload.targetDeviceIds) ? payload.targetDeviceIds : []
    const envelope = busEnvelope.createEnvelope({
      identity,
      networkId: getNetworkId(),
      topic,
      payload,
      targetNodeIds,
      ttl: options.ttl,
      qos: options.qos,
      routePath: options.routePath
    })

    let delivered = 0
    const deliveredTargetIds = []
    for (const targetId of envelope.targetNodeIds) {
      const ok = await deliverEnvelopeToTarget(targetId, envelope)
      if (ok) {
        delivered += 1
        deliveredTargetIds.push(targetId)
      }
    }
    log(`bus publish ${topic} delivered=${delivered}/${envelope.targetNodeIds.length}`)
    return { envelope, delivered, deliveredTargetIds }
  }

  async function flushOutbox(limit = 20) {
    const due = reliabilityStore.dueRecords(limit)
    let delivered = 0
    for (const record of due) {
      const envelope = record.envelope
      const targetId = record.targetNodeId
      if (!busEnvelope.isEnvelope(envelope) || !targetId) continue
      const ok = await deliverEnvelopeToTarget(targetId, envelope, { retrying: true })
      if (ok) delivered += 1
    }
    if (due.length > 0) log(`bus outbox flush delivered=${delivered}/${due.length}`)
    return { scanned: due.length, delivered }
  }

  function receiveEnvelope(envelope, context = {}) {
    if (!busEnvelope.isEnvelope(envelope)) return false
    if (reliabilityStore.rememberInbound(envelope) === false) return true
    if (!canReceive(envelope.topic, envelope, context)) return false
    return onReceive(envelope, context) !== false
  }

  function receiveLegacyPayload(payload, context = {}) {
    const envelope = busEnvelope.fromLegacyPayload(payload, {
      identity: getIdentity(),
      networkId: getNetworkId()
    })
    return receiveEnvelope(envelope, context)
  }

  return {
    publish,
    flushOutbox,
    receiveEnvelope,
    receiveLegacyPayload,
    fromLegacyPayload: payload => busEnvelope.fromLegacyPayload(payload, {
      identity: getIdentity(),
      networkId: getNetworkId()
    }),
    toLegacyPayload: busEnvelope.toLegacyPayload
  }
}

module.exports = {
  createContentBus
}
