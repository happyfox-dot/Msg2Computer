'use strict'

const TRANSPORT_PRIORITY = Object.freeze({
  lan_direct: 10,
  tailscale_direct: 20,
  legacy_ws: 30,
  relay_route: 40,
  legacy_http: 50
})

function isTailscaleAddress(host) {
  const parts = String(host || '').trim().split('.')
  if (parts.length !== 4) return false
  const first = Number(parts[0])
  const second = Number(parts[1])
  return first === 100 && second >= 64 && second <= 127
}

function normalizeHost(host) {
  return String(host || '').trim()
}

function hostCandidates(node = {}) {
  const hosts = []
  const add = value => {
    const host = normalizeHost(value)
    if (host && !hosts.includes(host)) hosts.push(host)
  }
  add(node.host || node.lastIP || node.relayHost)
  add(node.tsHost)
  ;(Array.isArray(node.altHosts) ? node.altHosts : []).forEach(add)
  return hosts
}

function classifyDirectTransport(host) {
  return isTailscaleAddress(host) ? 'tailscale_direct' : 'lan_direct'
}

function buildPeerRoutes({ target = {}, topologyRoutes = [], hasActiveWs = false, preferDirect = true }) {
  const id = String(target.id || target.phoneId || '').trim()
  if (!id) return []
  const routes = []
  if (preferDirect) {
    for (const host of hostCandidates(target)) {
      routes.push({
        targetId: id,
        nextHopId: id,
        transportType: classifyDirectTransport(host),
        host,
        port: Number(target.relayPort || target.joinPort || 19529),
        metric: classifyDirectTransport(host) === 'lan_direct' ? TRANSPORT_PRIORITY.lan_direct : TRANSPORT_PRIORITY.tailscale_direct,
        direct: true
      })
    }
  }
  if (hasActiveWs) {
    routes.push({
      targetId: id,
      nextHopId: id,
      transportType: 'legacy_ws',
      metric: TRANSPORT_PRIORITY.legacy_ws,
      direct: true
    })
  }
  for (const route of Array.isArray(topologyRoutes) ? topologyRoutes : []) {
    if (String(route.destinationId || route.to || '') !== id) continue
    routes.push({
      targetId: id,
      nextHopId: String(route.nextHopId || route.via || route.to || id),
      transportType: 'relay_route',
      metric: TRANSPORT_PRIORITY.relay_route + Number(route.metric || 0),
      path: route.path || [],
      direct: false
    })
  }
  if (routes.length === 0 && target.pairingKey) {
    routes.push({
      targetId: id,
      nextHopId: id,
      transportType: 'legacy_http',
      host: normalizeHost(target.lastIP || target.host),
      port: Number(target.relayPort || target.joinPort || 19529),
      metric: TRANSPORT_PRIORITY.legacy_http,
      direct: false
    })
  }
  return routes
    .filter(route => route.transportType === 'legacy_ws' || route.host || route.nextHopId)
    .sort((a, b) => a.metric - b.metric || String(a.transportType).localeCompare(String(b.transportType)))
}

function chooseBestRoute(input) {
  return buildPeerRoutes(input)[0] || null
}

module.exports = {
  TRANSPORT_PRIORITY,
  isTailscaleAddress,
  hostCandidates,
  buildPeerRoutes,
  chooseBestRoute
}
