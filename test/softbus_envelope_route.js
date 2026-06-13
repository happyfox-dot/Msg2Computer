const { TOPICS, fromLegacyPayload, toLegacyPayload } = require('../desktop/src/main/bus-envelope')
const routeManager = require('../desktop/src/main/route-manager')
const { createContentBus } = require('../desktop/src/main/content-bus')

let pass = 0
let fail = 0
function ok(condition, message) {
  if (condition) pass += 1
  else {
    fail += 1
    console.error('FAIL:', message)
  }
}

async function main() {
  const identity = { id: 'desktop-a', name: 'Desktop A', type: 'WINDOWS_DESKTOP' }
  const legacy = {
    type: 'clipboard_text',
    rawMessage: 'hello',
    originMessageId: 'clip-phone-b-1',
    sourceDeviceId: 'phone-b',
    targetDeviceIds: ['desktop-a', 'phone-c'],
    relayTtl: 4
  }
  const envelope = fromLegacyPayload(legacy, { identity, networkId: 'net-1' })
  ok(envelope.busVersion === 1, 'bus version')
  ok(envelope.topic === TOPICS.CLIPBOARD_TEXT, 'legacy type maps to topic')
  ok(envelope.messageId === 'clip-phone-b-1', 'stable message id preserved')
  ok(envelope.targetNodeIds.length === 2, 'target ids preserved')

  const roundTrip = toLegacyPayload(envelope)
  ok(roundTrip.type === 'clipboard_text', 'topic maps back to legacy type')
  ok(roundTrip.originMessageId === 'clip-phone-b-1', 'legacy origin id preserved')
  ok(roundTrip.relayTtl === 4, 'ttl preserved')
  ok(toLegacyPayload(fromLegacyPayload({ type: 'clipboard_image' }, { identity })).type === 'clipboard_image', 'clipboard image topic round trips')
  ok(toLegacyPayload(fromLegacyPayload({ type: 'clipboard_file' }, { identity })).type === 'clipboard_file', 'clipboard file topic round trips')
  ok(toLegacyPayload(fromLegacyPayload({ type: 'file_transfer' }, { identity })).type === 'file_transfer', 'file transfer topic round trips')

  const routes = routeManager.buildPeerRoutes({
    target: {
      id: 'phone-c',
      host: '192.168.1.9',
      tsHost: '100.100.10.2',
      port: 19529,
      pairingKey: 'k'
    },
    topologyRoutes: [{ destinationId: 'phone-c', nextHopId: 'desktop-b', metric: 10 }],
    hasActiveWs: true
  })
  ok(routes[0].transportType === 'lan_direct', 'LAN direct is first route')
  ok(routes.some(route => route.transportType === 'tailscale_direct'), 'tailscale route present')
  ok(routes.some(route => route.transportType === 'relay_route'), 'relay route present')
  ok(routes.some(route => route.transportType === 'legacy_http'), 'legacy http fallback present')

  const sent = []
  const bus = createContentBus({
    getIdentity: () => identity,
    getNetworkId: () => 'net-1',
    getTargetNode: id => ({ id, host: '192.168.1.9', port: 19529, pairingKey: 'k', capabilities: { softBus: true } }),
    getTopologyRoutes: () => [],
    hasActiveWs: () => false,
    canPush: () => true,
    canReceive: () => true,
    sendDirect: async (_target, outboundEnvelope, route) => {
      sent.push({ topic: outboundEnvelope.topic, transportType: route.transportType })
      return true
    },
    sendWs: () => false,
    sendRelay: async () => false
  })
  const result = await bus.publish(TOPICS.SMS_CODE, { type: 'sms', code: '123456', targetDeviceIds: ['phone-c'] })
  ok(result.delivered === 1, 'content bus delivered via direct route')
  ok(sent[0].topic === TOPICS.SMS_CODE, 'content bus sent expected topic')

  const relayRoutes = []
  const relayBus = createContentBus({
    getIdentity: () => identity,
    getNetworkId: () => 'net-1',
    getTargetNode: id => ({ id, pairingKey: 'k' }),
    getTopologyRoutes: () => [{ destinationId: 'phone-c', nextHopId: 'desktop-b', metric: 1 }],
    hasActiveWs: () => false,
    canPush: () => true,
    canReceive: () => true,
    sendDirect: async () => false,
    sendWs: () => false,
    sendRelay: async (_target, _outboundEnvelope, route) => {
      relayRoutes.push(route)
      return true
    }
  })
  const relayResult = await relayBus.publish(TOPICS.CLIPBOARD_IMAGE, {
    type: 'clipboard_image',
    targetDeviceIds: ['phone-c']
  })
  ok(relayResult.delivered === 1, 'content bus delivered via relay route')
  ok(relayRoutes[0].nextHopId === 'desktop-b', 'relay route exposes next hop')

  console.log(`softbus envelope/route: ${pass} passed, ${fail} failed`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
