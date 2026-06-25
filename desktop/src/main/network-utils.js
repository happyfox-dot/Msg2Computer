'use strict'

function normalizeNetworkHost(value) {
  const host = String(value || '').trim()
  if (host.startsWith('::ffff:')) return host.slice(7)
  return host
}

function formatHttpHost(host) {
  const value = normalizeNetworkHost(host)
  return value.includes(':') && !value.startsWith('[') ? `[${value}]` : value
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

function isTailscaleAddress(address) {
  const parts = String(address || '').trim().split('.').map(Number)
  return parts.length === 4 && parts.every(Number.isFinite) &&
    parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127
}

function is172PrivateIPv4(address) {
  const parts = String(address || '').split('.').map(Number)
  return parts.length === 4 && parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31
}

function isPrivateIPv4(address) {
  const value = String(address || '')
  return value.startsWith('10.') || value.startsWith('192.168.') || is172PrivateIPv4(value)
}

function scoreNetworkAddress(interfaceName, address) {
  let score = 0
  const lowerName = String(interfaceName || '').toLowerCase()
  const value = String(address || '')

  if (isPrivateIPv4(value)) score += 50
  if (value.startsWith('192.168.')) score += 30
  if (value.startsWith('10.')) score += 20
  if (is172PrivateIPv4(value)) score += 20
  if (/wi-?fi|wlan|wireless|ethernet|以太网|无线/.test(lowerName)) score += 20
  if (/vethernet|virtual|docker|wsl|vmware|virtualbox|hyper-v|bluetooth|loopback|tailscale|zerotier|vpn|wireguard/.test(lowerName)) {
    score -= 100
  }
  if (value.startsWith('169.254.')) score -= 50

  return score
}

function getLocalIPCandidates(networkInterfaces = {}) {
  const candidates = []
  for (const [name, addresses] of Object.entries(networkInterfaces || {})) {
    for (const net of addresses || []) {
      if (net.family !== 'IPv4' || net.internal) continue
      candidates.push({
        name,
        address: net.address,
        score: scoreNetworkAddress(name, net.address)
      })
    }
  }
  return candidates.sort((a, b) => b.score - a.score)
}

function getTailscaleIPv4(networkInterfaces = {}) {
  for (const addresses of Object.values(networkInterfaces || {})) {
    for (const net of addresses || []) {
      if (net.family !== 'IPv4' || net.internal) continue
      if (isTailscaleAddress(net.address)) return net.address
    }
  }
  return ''
}

function ipToInt(address) {
  return String(address || '').split('.').reduce((acc, part) => ((acc << 8) + Number(part)) >>> 0, 0)
}

function intToIp(value) {
  return [24, 16, 8, 0].map(shift => (value >>> shift) & 255).join('.')
}

function getBroadcastAddresses(networkInterfaces = {}) {
  const addresses = new Set(['255.255.255.255'])
  for (const iface of Object.values(networkInterfaces || {})) {
    for (const net of iface || []) {
      if (net.family !== 'IPv4' || net.internal || !net.address || !net.netmask) continue
      try {
        const broadcast = (ipToInt(net.address) | (~ipToInt(net.netmask))) >>> 0
        addresses.add(intToIp(broadcast))
      } catch (_) {}
    }
  }
  return Array.from(addresses)
}

module.exports = {
  normalizeNetworkHost,
  formatHttpHost,
  collectNetworkHosts,
  isTailscaleAddress,
  is172PrivateIPv4,
  isPrivateIPv4,
  scoreNetworkAddress,
  getLocalIPCandidates,
  getTailscaleIPv4,
  ipToInt,
  intToIp,
  getBroadcastAddresses
}
