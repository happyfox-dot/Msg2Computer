'use strict'

const {
  normalizeNetworkHost,
  collectNetworkHosts,
  isTailscaleAddress
} = require('./network-utils')

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

function connectionCandidateHosts(node = {}, discovered = {}) {
  const trustedHosts = collectNetworkHosts(
    node.host,
    node.lastIP,
    node.relayHost,
    node.tsHost,
    node.altHosts
  )
  const discoveredHost = String(discovered.id || '') === String(node.id || '')
    ? normalizeNetworkHost(discovered.host)
    : ''
  return collectNetworkHosts(trustedHosts, discoveredHost)
}

// HTTP delivery may try an unauthenticated discovery address, but this helper
// only returns candidates and never mutates trust state. Callers may promote a
// candidate with withAuthenticatedHost only after a cryptographically bound
// handshake (for example, a signed bus ACK); legacy HTTP status alone is not
// proof that the peer at that address owns the pairing key.
function deliveryCandidateHosts(node = {}, discovered = {}, preferredHost = '') {
  return collectNetworkHosts(
    preferredHost,
    connectionCandidateHosts(node, discovered)
  )
}

function withAuthenticatedHost(node = {}, authenticatedHost = '') {
  const host = normalizeNetworkHost(authenticatedHost)
  if (!host) return { ...node }
  const previousHosts = collectNetworkHosts(
    node.host,
    node.lastIP,
    node.relayHost,
    node.tsHost,
    node.altHosts
  )
  const tsHost = isTailscaleAddress(host) ? host : normalizeNetworkHost(node.tsHost)
  return {
    ...node,
    host,
    lastIP: host,
    tsHost,
    altHosts: previousHosts.filter(value => value !== host && value !== tsHost)
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
  withPrimaryTrustedHost,
  connectionCandidateHosts,
  deliveryCandidateHosts,
  withAuthenticatedHost
}
