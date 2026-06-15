'use strict'

const TRANSPORT_PRIORITY = Object.freeze({
  lan_direct: 10,
  tailscale_direct: 20,
  legacy_ws: 30,
  relay_route: 40,
  legacy_http: 50
})

const DEFAULT_ROUTE_FAILURE_PENALTY = 25
const DEFAULT_ROUTE_COOLDOWN_MS = 30 * 1000
const DEFAULT_ROUTE_HEALTH_TTL_MS = 10 * 60 * 1000

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
  if (target.pairingKey) {
    const legacyHost = normalizeHost(target.lastIP || target.host || target.relayHost)
    if (legacyHost) {
      routes.push({
        targetId: id,
        nextHopId: id,
        transportType: 'legacy_http',
        host: legacyHost,
        port: Number(target.relayPort || target.joinPort || 19529),
        metric: TRANSPORT_PRIORITY.legacy_http,
        direct: false
      })
    }
  }
  return routes
    .filter(route => route.transportType === 'legacy_ws' || route.host || route.nextHopId)
    .sort((a, b) => a.metric - b.metric || String(a.transportType).localeCompare(String(b.transportType)))
}

function chooseBestRoute(input) {
  return buildPeerRoutes(input)[0] || null
}

function routeHealthKey(targetId, route = {}) {
  return [
    String(targetId || route.targetId || '').trim(),
    String(route.transportType || '').trim(),
    String(route.nextHopId || '').trim(),
    String(route.host || '').trim(),
    String(route.port || '').trim()
  ].join('|')
}

function createRouteHealthTracker(options = {}) {
  const {
    failurePenalty = DEFAULT_ROUTE_FAILURE_PENALTY,
    cooldownMs = DEFAULT_ROUTE_COOLDOWN_MS,
    ttlMs = DEFAULT_ROUTE_HEALTH_TTL_MS
  } = options
  const states = new Map()

  function prune(now = Date.now()) {
    for (const [key, state] of states) {
      const updatedAt = Math.max(Number(state.lastSuccessAt || 0), Number(state.lastFailureAt || 0))
      if (updatedAt && now - updatedAt > ttlMs) states.delete(key)
    }
  }

  function recordResult(targetId, route, ok) {
    const key = routeHealthKey(targetId, route)
    if (!key.trim()) return
    const now = Date.now()
    const existing = states.get(key) || { failures: 0, successes: 0, lastSuccessAt: 0, lastFailureAt: 0 }
    if (ok) {
      states.set(key, {
        ...existing,
        failures: 0,
        successes: existing.successes + 1,
        lastSuccessAt: now,
        lastFailureAt: existing.lastFailureAt || 0
      })
    } else {
      states.set(key, {
        ...existing,
        failures: existing.failures + 1,
        lastFailureAt: now
      })
    }
    prune(now)
  }

  function scoreRoute(targetId, route) {
    const state = states.get(routeHealthKey(targetId, route))
    if (!state) return Number(route.metric || 0)
    const now = Date.now()
    const coolingDown = state.lastFailureAt && now - state.lastFailureAt < cooldownMs
    const penalty = (state.failures || 0) * failurePenalty + (coolingDown ? failurePenalty : 0)
    const successBonus = state.lastSuccessAt && !coolingDown ? Math.min(5, state.successes || 0) : 0
    return Number(route.metric || 0) + penalty - successBonus
  }

  function rankRoutes(targetId, routes = []) {
    prune()
    return routes
      .map(route => ({ ...route, healthMetric: scoreRoute(targetId, route) }))
      .sort((a, b) =>
        a.healthMetric - b.healthMetric ||
        Number(a.metric || 0) - Number(b.metric || 0) ||
        String(a.transportType).localeCompare(String(b.transportType))
      )
  }

  function snapshot() {
    prune()
    return Array.from(states.entries()).map(([key, value]) => ({ key, ...value }))
  }

  return {
    recordResult,
    rankRoutes,
    snapshot
  }
}

module.exports = {
  TRANSPORT_PRIORITY,
  isTailscaleAddress,
  hostCandidates,
  buildPeerRoutes,
  chooseBestRoute,
  routeHealthKey,
  createRouteHealthTracker
}
