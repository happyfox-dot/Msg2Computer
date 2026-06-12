'use strict'

const busEnvelope = require('./bus-envelope')
const routeManager = require('./route-manager')

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
    log = () => {}
  } = deps

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
    for (const targetId of envelope.targetNodeIds) {
      const target = getTargetNode(targetId)
      if (!target || !canPush(target, topic)) continue
      const routes = routeManager.buildPeerRoutes({
        target,
        topologyRoutes: getTopologyRoutes(identity.id),
        hasActiveWs: hasActiveWs(targetId),
        preferDirect: true
      })
      let ok = false
      for (const route of routes) {
        if (route.transportType === 'lan_direct' || route.transportType === 'tailscale_direct') {
          ok = await sendDirect(target, envelope, route)
        } else if (route.transportType === 'legacy_ws') {
          ok = sendWs(target, envelope, route)
        } else {
          ok = await sendRelay(target, envelope, route)
        }
        if (ok) break
      }
      if (ok) delivered += 1
    }
    log(`bus publish ${topic} delivered=${delivered}/${envelope.targetNodeIds.length}`)
    return { envelope, delivered }
  }

  function receiveEnvelope(envelope, context = {}) {
    if (!busEnvelope.isEnvelope(envelope)) return false
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
