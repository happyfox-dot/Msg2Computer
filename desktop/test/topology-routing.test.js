'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const {
  computeLinkStateRoutes,
  isRoutingTransportEdge
} = require('../src/main/topology-manager')

const routeTypeCost = {
  lan_direct: 10,
  tailscale_direct: 20,
  legacy_ws: 30,
  relay_route: 40,
  legacy_http: 50
}

test('display-only edges are excluded from SPF routes', () => {
  assert.equal(isRoutingTransportEdge({ type: 'lan_discovered', routable: false, enabled: true }, routeTypeCost), false)
  assert.equal(isRoutingTransportEdge({ type: 'lan_direct', routable: true, enabled: true }, routeTypeCost), true)
  assert.equal(isRoutingTransportEdge({ type: 'lan_direct', routable: true, enabled: false }, routeTypeCost), false)
})

test('SPF treats routable topology links as undirected peer reachability', () => {
  const nodes = [
    { id: 'A', name: 'Phone A', type: 'ANDROID_PHONE' },
    { id: 'B', name: 'Desktop B', type: 'WINDOWS_DESKTOP' },
    { id: 'C', name: 'Phone C', type: 'ANDROID_PHONE' }
  ]
  const edges = [
    { id: 'A-B', from: 'A', to: 'B', type: 'lan_direct', routable: true, enabled: true, active: true },
    { id: 'B-C', from: 'B', to: 'C', type: 'relay_route', routable: true, enabled: true, active: true }
  ]

  const result = computeLinkStateRoutes(nodes, edges, { routeTypeCost })
  const routeAToC = result.routeTables.A.find(route => route.destinationId === 'C')
  const routeCToA = result.routeTables.C.find(route => route.destinationId === 'A')

  assert.deepEqual(routeAToC.path, ['A', 'B', 'C'])
  assert.equal(routeAToC.nextHopId, 'B')
  assert.deepEqual(routeCToA.path, ['C', 'B', 'A'])
  assert.equal(routeCToA.nextHopId, 'B')
})

test('SPF prefers lower metric direct route over relay path', () => {
  const nodes = [
    { id: 'A', name: 'Phone A' },
    { id: 'B', name: 'Desktop B' },
    { id: 'C', name: 'Phone C' }
  ]
  const edges = [
    { id: 'A-B', from: 'A', to: 'B', type: 'relay_route', routable: true, enabled: true, active: true },
    { id: 'B-C', from: 'B', to: 'C', type: 'relay_route', routable: true, enabled: true, active: true },
    { id: 'A-C', from: 'A', to: 'C', type: 'lan_direct', routable: true, enabled: true, active: true }
  ]

  const result = computeLinkStateRoutes(nodes, edges, { routeTypeCost })
  const route = result.routeTables.A.find(item => item.destinationId === 'C')

  assert.deepEqual(route.path, ['A', 'C'])
  assert.equal(route.nextHopId, 'C')
  assert.equal(route.metric, 10)
})
