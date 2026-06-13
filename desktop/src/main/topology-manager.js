function isRoutingTransportEdge(edge, routeTypeCost = {}) {
  if (!edge || edge.enabled === false || edge.routable !== true) return false
  const type = String(edge.type || '')
  return Object.prototype.hasOwnProperty.call(routeTypeCost, type)
}

function getRouteEdgeMetric(edge, options = {}) {
  const routeTypeCost = options.routeTypeCost || {}
  const routeStaleMs = Number(options.routeStaleMs) || 0
  const base = routeTypeCost[edge.type] || 50
  const stalePenalty = edge.updatedAt && routeStaleMs > 0 && Date.now() - edge.updatedAt > routeStaleMs ? 20 : 0
  const inactivePenalty = edge.active ? 0 : 15
  const disabledPenalty = edge.enabled === false ? 9999 : 0
  return Math.max(1, Math.round(Number(edge.metric || 0) || base) + stalePenalty + inactivePenalty + disabledPenalty)
}

function buildLinkStateDatabase(nodes, edges, options = {}) {
  const routeTypeCost = options.routeTypeCost || {}
  const nodeMap = new Map()
  nodes.forEach(node => {
    if (node?.id) nodeMap.set(String(node.id), node)
  })

  const adjacency = new Map()
  nodeMap.forEach((_node, id) => adjacency.set(id, []))

  edges.filter(edge => isRoutingTransportEdge(edge, routeTypeCost)).forEach(edge => {
    const from = String(edge.from)
    const to = String(edge.to)
    if (!nodeMap.has(from) || !nodeMap.has(to)) return
    const routeEdge = {
      to,
      metric: getRouteEdgeMetric(edge, options),
      edgeId: edge.id,
      edgeType: edge.type,
      label: edge.label || 'link',
      active: edge.active === true,
      updatedAt: edge.updatedAt || 0
    }
    adjacency.get(from).push(routeEdge)
    adjacency.get(to).push({
      ...routeEdge,
      to: from
    })
  })

  return { nodeMap, adjacency }
}

function computeShortestRoutesFrom(sourceId, lsdb) {
  const { nodeMap, adjacency } = lsdb
  const source = String(sourceId || '')
  if (!source || !nodeMap.has(source)) return []

  const distance = new Map()
  const previous = new Map()
  const previousEdge = new Map()
  const visited = new Set()
  nodeMap.forEach((_node, id) => distance.set(id, Infinity))
  distance.set(source, 0)

  while (visited.size < nodeMap.size) {
    let current = ''
    let best = Infinity
    for (const [id, metric] of distance.entries()) {
      if (!visited.has(id) && metric < best) {
        current = id
        best = metric
      }
    }
    if (!current) break
    visited.add(current)

    for (const edge of adjacency.get(current) || []) {
      if (visited.has(edge.to)) continue
      const nextMetric = best + edge.metric
      if (nextMetric < (distance.get(edge.to) || Infinity)) {
        distance.set(edge.to, nextMetric)
        previous.set(edge.to, current)
        previousEdge.set(edge.to, edge)
      }
    }
  }

  const routes = []
  for (const [destination, metric] of distance.entries()) {
    if (destination === source || !Number.isFinite(metric)) continue
    const path = [destination]
    const edgePath = []
    let cursor = destination
    while (previous.has(cursor)) {
      const edge = previousEdge.get(cursor)
      if (edge) edgePath.unshift(edge)
      cursor = previous.get(cursor)
      path.unshift(cursor)
      if (cursor === source) break
    }
    if (path[0] !== source || path.length < 2) continue
    const nextHopId = path[1]
    const destinationNode = nodeMap.get(destination) || {}
    const activeEdgeCount = edgePath.filter(edge => edge.active).length
    const fullyActive = edgePath.length > 0 && activeEdgeCount === edgePath.length
    routes.push({
      id: `${source}->${destination}:spf`,
      from: source,
      to: destination,
      destinationId: destination,
      destinationName: destinationNode.name || destination,
      destinationType: destinationNode.type || '',
      nextHopId,
      nextHopName: nodeMap.get(nextHopId)?.name || nextHopId,
      metric,
      hopCount: path.length - 1,
      path,
      pathLabels: edgePath.map(edge => edge.label),
      via: nextHopId,
      type: 'spf_route',
      label: `SPF route metric ${metric}`,
      enabled: true,
      active: fullyActive,
      partiallyActive: activeEdgeCount > 0 && !fullyActive,
      activeEdgeCount,
      totalEdgeCount: edgePath.length,
      authority: 'link_state',
      updatedAt: Math.max(0, ...edgePath.map(edge => edge.updatedAt || 0))
    })
  }

  return routes.sort((a, b) => a.metric - b.metric || a.hopCount - b.hopCount || a.destinationName.localeCompare(b.destinationName))
}

function computeLinkStateRoutes(nodes, edges, options = {}) {
  const lsdb = buildLinkStateDatabase(nodes, edges, options)
  const routeTables = {}
  const routes = []
  for (const nodeId of lsdb.nodeMap.keys()) {
    const table = computeShortestRoutesFrom(nodeId, lsdb)
    routeTables[nodeId] = table
    routes.push(...table)
  }
  return {
    protocol: 'link-state-spf',
    version: options.protocolVersion || 1,
    routeTables,
    routes,
    updatedAt: Date.now()
  }
}

module.exports = {
  isRoutingTransportEdge,
  getRouteEdgeMetric,
  buildLinkStateDatabase,
  computeShortestRoutesFrom,
  computeLinkStateRoutes
}
