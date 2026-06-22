'use strict'

function normalizeNetworkHost(value) {
  const host = String(value || '').trim()
  if (host.startsWith('::ffff:')) return host.slice(7)
  return host
}

function collectNetworkHosts(...values) {
  const hosts = []
  const add = value => {
    if (Array.isArray(value)) {
      value.forEach(add)
      return
    }
    const host = normalizeNetworkHost(value || '')
    if (host && !hosts.includes(host)) hosts.push(host)
  }
  values.forEach(add)
  return hosts
}

function primaryTrustedNodeHost(node = {}) {
  return collectNetworkHosts(
    node.host,
    node.lastIP,
    node.relayHost,
    node.tsHost,
    node.altHosts
  )[0] || ''
}

function hasTrustedNodeAddress(node = {}) {
  return primaryTrustedNodeHost(node) !== ''
}

function hasTrustedNodeAddressOrRoute(node = {}) {
  return hasTrustedNodeAddress(node) ||
    !!String(node.routeNextHopId || '').trim() ||
    Number(node.routeMetric || 0) > 0 ||
    (Array.isArray(node.routePath) && node.routePath.length > 1)
}

function shouldImportTrustedTopologyNode(node = {}) {
  return !!(
    node &&
    node.routable === true &&
    String(node.pairingKey || '').trim() &&
    hasTrustedNodeAddress(node)
  )
}

function shouldRouteTrustedTopologyNode(node = {}) {
  return !!(
    node &&
    node.routable === true &&
    String(node.pairingKey || '').trim() &&
    hasTrustedNodeAddressOrRoute(node)
  )
}

function withPrimaryTrustedHost(node = {}) {
  const primaryHost = primaryTrustedNodeHost(node)
  const allHosts = collectNetworkHosts(
    node.host,
    node.lastIP,
    node.relayHost,
    node.tsHost,
    node.altHosts
  )
  return {
    ...node,
    host: normalizeNetworkHost(node.host) || primaryHost,
    lastIP: normalizeNetworkHost(node.lastIP) || primaryHost,
    altHosts: allHosts.filter(host => host && host !== primaryHost)
  }
}

module.exports = {
  normalizeNetworkHost,
  collectNetworkHosts,
  primaryTrustedNodeHost,
  hasTrustedNodeAddress,
  hasTrustedNodeAddressOrRoute,
  shouldImportTrustedTopologyNode,
  shouldRouteTrustedTopologyNode,
  withPrimaryTrustedHost
}
