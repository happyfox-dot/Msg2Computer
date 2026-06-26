package com.codesync.util

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.util.Locale
import kotlin.math.max

object RouteManager {
    private const val ROUTE_STALE_MS = 10 * 60 * 1000L
    const val RECENT_REACHABLE_MS = 2 * 60 * 1000L

    private val ROUTE_TYPE_COST = mapOf(
        "routing_adjacency" to 10,
        "verify_push" to 12,
        "totp_sync" to 12,
        "desktop_pair" to 10,
        "relay_route" to 5,
        "lan_discovery" to 80
    )

    data class RouteInfo(
        val destinationId: String,
        val destinationName: String,
        val destinationType: String,
        val nextHopId: String,
        val nextHopName: String,
        val metric: Int,
        val hopCount: Int,
        val path: List<String>,
        val pathLabels: List<String>,
        val active: Boolean,
        val partiallyActive: Boolean,
        val updatedAt: Long
    )

    data class TargetOption(
        val device: DesktopDevice,
        val deliveryDevice: DesktopDevice,
        val route: RouteInfo?,
        val status: String,
        val reachable: Boolean,
        val allowed: Boolean,
        val reason: String
    )

    private data class RouteNode(
        val id: String,
        val name: String,
        val type: String
    )

    private data class RouteEdge(
        val to: String,
        val metric: Int,
        val label: String,
        val active: Boolean,
        val updatedAt: Long
    )

    fun routeTable(
        context: Context,
        sourceId: String = PhoneIdentityStore.get(context).id,
        connectedDeviceIds: Set<String> = emptySet()
    ): List<RouteInfo> {
        val snapshot = TopologyStore.buildRouteSnapshot(
            context = context,
            connectedDeviceIds = connectedDeviceIds
        )
        return computeRoutes(
            sourceId = sourceId,
            nodes = snapshot.optJSONArray("nodes") ?: JSONArray(),
            links = snapshot.optJSONArray("links") ?: JSONArray(),
            networkId = LanTrustStore.getNetworkId(context)
        )
    }

    fun routeMap(
        context: Context,
        sourceId: String = PhoneIdentityStore.get(context).id,
        connectedDeviceIds: Set<String> = emptySet()
    ): Map<String, RouteInfo> =
        routeTable(context, sourceId, connectedDeviceIds).associateBy { it.destinationId }

    fun refreshStoredRoutes(
        context: Context,
        connectedDeviceIds: Set<String> = emptySet()
    ): Map<String, RouteInfo> {
        val routes = routeMap(context, connectedDeviceIds = connectedDeviceIds)
        val now = System.currentTimeMillis()
        DeviceStore.getDevices(context).forEach { device ->
            if (device.pairingKey.isBlank()) return@forEach
            val route = routes[device.id]
            val nextMetric = route?.metric ?: 0
            val nextHopId = route?.nextHopId.orEmpty()
            val nextHopName = route?.nextHopName.orEmpty()
            val nextPath = route?.path ?: emptyList()
            if (device.routeMetric == nextMetric &&
                device.routeNextHopId == nextHopId &&
                device.routeNextHopName == nextHopName &&
                device.routePath == nextPath
            ) {
                return@forEach
            }
            DeviceStore.upsertDevice(
                context = context,
                host = device.host,
                port = device.port,
                pairingKey = device.pairingKey,
                name = device.name,
                deviceId = device.id,
                deviceType = device.type,
                routeMetric = nextMetric,
                routeNextHopId = nextHopId,
                routeNextHopName = nextHopName,
                routePath = nextPath,
                routeUpdatedAt = now,
                altHosts = device.altHosts,
                networkId = device.networkId,
                autoPaired = device.autoPaired,
                trustSourceId = device.trustSourceId,
                trustLevel = device.trustLevel,
                acceptedAt = device.acceptedAt,
                capabilities = device.capabilities
            )
        }
        return routes
    }

    fun targetsForType(
        context: Context,
        type: String,
        connectedDeviceIds: Set<String> = emptySet(),
        requestedTargetIds: Set<String> = emptySet(),
        excludedDeviceIds: Set<String> = emptySet(),
        respectLocalSendSettings: Boolean = true
    ): List<TargetOption> {
        val routes = refreshStoredRoutes(context, connectedDeviceIds)
        val devices = DeviceStore.getEnabledDevices(context)
            .filter { it.id !in excludedDeviceIds }
            .filter { requestedTargetIds.isEmpty() || it.id in requestedTargetIds }
            .distinctBy { it.id }
        val byId = devices.associateBy { it.id }
        return devices
            .mapNotNull { device ->
                val allowed = if (respectLocalSendSettings) {
                    PolicyManager.canSendTo(context, type, device)
                } else {
                    PolicyManager.canForwardTo(type, device)
                }
                if (!allowed) return@mapNotNull null
                val route = routes[device.id]
                val delivery = deliveryDeviceForTarget(device, route, byId, emptySet(), emptySet())
                val status = statusForDevice(device, route, connectedDeviceIds)
                TargetOption(
                    device = device,
                    deliveryDevice = delivery,
                    route = route,
                    status = status,
                    reachable = isReachableStatus(status),
                    allowed = true,
                    reason = routeReason(device, route, status)
                )
            }
            .sortedWith(
                compareBy<TargetOption> { metricForOption(it) }
                    .thenByDescending { it.device.lastSyncAt }
                    .thenBy { it.device.name.lowercase(Locale.ROOT) }
            )
    }

    fun deliveryDevicesForTargets(
        context: Context,
        type: String,
        targets: List<DesktopDevice>,
        connectedDeviceIds: Set<String> = emptySet()
    ): List<DesktopDevice> {
        val routes = refreshStoredRoutes(context, connectedDeviceIds)
        val allTrusted = DeviceStore.getEnabledDevices(context)
            .filter { PolicyManager.canRelay(type, it) }
            .associateBy { it.id }
        val selected = linkedMapOf<String, Pair<DesktopDevice, Int>>()
        targets.distinctBy { it.id }.forEach { target ->
            val route = routes[target.id]
            val delivery = deliveryDeviceForTarget(
                target = target,
                route = route,
                candidatesById = allTrusted,
                blockedIds = emptySet(),
                terminalIds = emptySet()
            )
            val metric = route?.metric ?: legacyMetric(target)
            val previous = selected[delivery.id]
            if (previous == null || metric < previous.second) {
                selected[delivery.id] = delivery to metric
            }
        }
        return selected.values
            .sortedWith(
                compareBy<Pair<DesktopDevice, Int>> { it.second }
                    .thenByDescending { it.first.lastSyncAt }
                    .thenBy { it.first.name.lowercase(Locale.ROOT) }
            )
            .map { it.first }
    }

    fun selectRelayNextTargets(
        context: Context,
        type: String,
        allowedTargetIds: Set<String>,
        pathIds: Set<String>,
        excludeDeviceId: String,
        originId: String,
        connectedDeviceIds: Set<String> = emptySet()
    ): List<DesktopDevice> {
        val blocked = (pathIds + setOf(excludeDeviceId, originId)).filter { it.isNotBlank() }.toSet()
        val routes = refreshStoredRoutes(context, connectedDeviceIds)
        val devices = DeviceStore.getEnabledDevices(context)
            .filter { it.id !in blocked }
            .distinctBy { it.id }
        val finalTargets = devices
            .filter { PolicyManager.canForwardTo(type, it) }
            .filter { allowedTargetIds.isEmpty() || it.id in allowedTargetIds }
        val relayCandidates = devices
            .filter { PolicyManager.canRelay(type, it) }
            .associateBy { it.id }
        val selected = linkedMapOf<String, Pair<DesktopDevice, Int>>()
        finalTargets.forEach { target ->
            val route = routes[target.id]
            val delivery = deliveryDeviceForTarget(
                target = target,
                route = route,
                candidatesById = relayCandidates,
                blockedIds = blocked,
                terminalIds = setOf(PhoneIdentityStore.get(context).id)
            )
            if (delivery.id in blocked) return@forEach
            val metric = route?.metric ?: legacyMetric(target)
            val previous = selected[delivery.id]
            if (previous == null || metric < previous.second) {
                selected[delivery.id] = delivery to metric
            }
        }
        return selected.values
            .sortedWith(
                compareBy<Pair<DesktopDevice, Int>> { it.second }
                    .thenByDescending { it.first.lastSyncAt }
                    .thenBy { it.first.name.lowercase(Locale.ROOT) }
            )
            .map { it.first }
    }

    fun statusForDevice(
        device: DesktopDevice,
        route: RouteInfo? = null,
        connectedDeviceIds: Set<String> = emptySet(),
        now: Long = System.currentTimeMillis()
    ): String {
        if (!device.enabled) return "disabled"
        if (device.revoked || device.pairingKey.isBlank()) return "offline"
        if (device.id in connectedDeviceIds) return "online"
        val directFreshnessAt = maxOf(
            device.connectionUpdatedAt,
            device.lastSyncAt
        )
        val activeRouteFreshnessAt = if (route?.active == true || route?.partiallyActive == true) {
            route.updatedAt
        } else {
            0L
        }
        val hasRoute = route != null || device.routeNextHopId.isNotBlank() || device.routeMetric > 0 || device.routePath.size > 1
        val hasAddress = device.host.isNotBlank() || device.altHosts.any { it.isNotBlank() }
        return when {
            hasRoute && isRecent(activeRouteFreshnessAt, now) -> "reachable"
            hasAddress && isRecent(directFreshnessAt, now) -> "reachable"
            hasRoute || hasAddress -> "known"
            else -> "offline"
        }
    }

    fun isReachableStatus(status: String): Boolean =
        status == "online" || status == "reachable"

    fun computeRoutes(
        sourceId: String,
        nodes: JSONArray,
        links: JSONArray,
        networkId: String = "",
        now: Long = System.currentTimeMillis()
    ): List<RouteInfo> {
        val nodeMap = linkedMapOf<String, RouteNode>()
        for (i in 0 until nodes.length()) {
            val raw = nodes.optJSONObject(i) ?: continue
            if (!isRoutableNode(raw, networkId)) continue
            val id = raw.optString("id").trim()
            nodeMap[id] = RouteNode(
                id = id,
                name = raw.optString("name", id).ifBlank { id },
                type = raw.optString("type")
            )
        }
        val source = sourceId.trim()
        if (source.isBlank() || !nodeMap.containsKey(source)) return emptyList()

        val adjacency = linkedMapOf<String, MutableList<RouteEdge>>()
        nodeMap.keys.forEach { adjacency[it] = mutableListOf() }
        for (i in 0 until links.length()) {
            val raw = links.optJSONObject(i) ?: continue
            if (!isRoutingEdge(raw)) continue
            val from = raw.optString("from").trim()
            val to = raw.optString("to").trim()
            if (!nodeMap.containsKey(from) || !nodeMap.containsKey(to)) continue
            val edge = RouteEdge(
                to = to,
                metric = edgeMetric(raw, now),
                label = raw.optString("label", "link").ifBlank { "link" },
                active = raw.optBoolean("active", false),
                updatedAt = raw.optLong("updatedAt", 0L)
            )
            adjacency[from]?.add(edge)
            adjacency[to]?.add(edge.copy(to = from))
        }

        val distances = linkedMapOf<String, Int>()
        val previous = mutableMapOf<String, String>()
        val previousEdge = mutableMapOf<String, RouteEdge>()
        val visited = mutableSetOf<String>()
        nodeMap.keys.forEach { distances[it] = Int.MAX_VALUE }
        distances[source] = 0

        while (visited.size < nodeMap.size) {
            val current = distances
                .filter { it.key !in visited }
                .minByOrNull { it.value }
                ?.takeIf { it.value < Int.MAX_VALUE }
                ?.key ?: break
            val best = distances[current] ?: break
            visited.add(current)
            adjacency[current].orEmpty().forEach { edge ->
                if (edge.to in visited) return@forEach
                val nextMetric = best + edge.metric
                if (nextMetric < (distances[edge.to] ?: Int.MAX_VALUE)) {
                    distances[edge.to] = nextMetric
                    previous[edge.to] = current
                    previousEdge[edge.to] = edge
                }
            }
        }

        return distances.mapNotNull { (destination, metric) ->
            if (destination == source || metric == Int.MAX_VALUE) return@mapNotNull null
            val path = mutableListOf(destination)
            val edgePath = mutableListOf<RouteEdge>()
            var cursor = destination
            while (previous.containsKey(cursor)) {
                previousEdge[cursor]?.let { edgePath.add(0, it) }
                cursor = previous[cursor] ?: break
                path.add(0, cursor)
                if (cursor == source) break
            }
            if (path.firstOrNull() != source || path.size < 2) return@mapNotNull null
            val nextHop = path[1]
            val destinationNode = nodeMap[destination]
            val nextHopNode = nodeMap[nextHop]
            val activeCount = edgePath.count { it.active }
            val fullyActive = edgePath.isNotEmpty() && activeCount == edgePath.size
            RouteInfo(
                destinationId = destination,
                destinationName = destinationNode?.name ?: destination,
                destinationType = destinationNode?.type.orEmpty(),
                nextHopId = nextHop,
                nextHopName = nextHopNode?.name ?: nextHop,
                metric = metric,
                hopCount = path.size - 1,
                path = path,
                pathLabels = edgePath.map { it.label },
                active = fullyActive,
                partiallyActive = activeCount > 0 && !fullyActive,
                updatedAt = edgePath.map { it.updatedAt }.fold(0L) { acc, value -> max(acc, value) }
            )
        }.sortedWith(
            compareBy<RouteInfo> { it.metric }
                .thenBy { it.hopCount }
                .thenBy { it.destinationName.lowercase(Locale.ROOT) }
        )
    }

    private fun deliveryDeviceForTarget(
        target: DesktopDevice,
        route: RouteInfo?,
        candidatesById: Map<String, DesktopDevice>,
        blockedIds: Set<String>,
        terminalIds: Set<String>
    ): DesktopDevice {
        val nextHopId = route?.nextHopId.orEmpty()
        if (nextHopId.isBlank() ||
            nextHopId == target.id ||
            nextHopId in blockedIds ||
            nextHopId in terminalIds
        ) {
            return target
        }
        return candidatesById[nextHopId] ?: target
    }

    private fun routeReason(device: DesktopDevice, route: RouteInfo?, status: String): String {
        val parts = mutableListOf<String>()
        if (!isReachableStatus(status)) parts.add(status)
        if (route != null && route.nextHopId.isNotBlank() && route.nextHopId != device.id) {
            parts.add("via ${route.nextHopName.ifBlank { route.nextHopId }}")
            parts.add("SPF ${route.metric}")
        } else if (route != null) {
            parts.add("SPF ${route.metric}")
        } else if (device.routeMetric > 0) {
            parts.add("legacy SPF ${device.routeMetric}")
        }
        return parts.joinToString(" / ")
    }

    private fun metricForOption(option: TargetOption): Int =
        option.route?.metric ?: legacyMetric(option.device)

    private fun legacyMetric(device: DesktopDevice): Int =
        if (device.routeMetric > 0) device.routeMetric else Int.MAX_VALUE / 2

    private fun isRecent(timestamp: Long, now: Long): Boolean =
        timestamp > 0L && now - timestamp <= RECENT_REACHABLE_MS

    private fun isRoutableNode(node: JSONObject, currentNetworkId: String): Boolean {
        val id = node.optString("id").trim()
        if (id.isBlank()) return false
        val nodeNetworkId = node.optString("networkId").trim()
        if (currentNetworkId.isNotBlank() && nodeNetworkId.isNotBlank() && nodeNetworkId != currentNetworkId) {
            return false
        }
        if (!node.optBoolean("enabled", true) || node.optBoolean("revoked", false)) return false
        if (!node.optBoolean("routable", false)) return false
        return node.optString("pairingKey", node.optString("pk")).trim().isNotBlank()
    }

    private fun isRoutingEdge(edge: JSONObject): Boolean {
        if (!edge.optBoolean("enabled", true) || !edge.optBoolean("routable", false)) return false
        return ROUTE_TYPE_COST.containsKey(edge.optString("type"))
    }

    private fun edgeMetric(edge: JSONObject, now: Long): Int {
        val type = edge.optString("type")
        val base = edge.optInt("metric", 0).takeIf { it > 0 } ?: ROUTE_TYPE_COST[type] ?: 50
        val updatedAt = edge.optLong("updatedAt", 0L)
        val stalePenalty = if (updatedAt > 0L && now - updatedAt > ROUTE_STALE_MS) 20 else 0
        val inactivePenalty = if (edge.optBoolean("active", false)) 0 else 15
        val disabledPenalty = if (edge.optBoolean("enabled", true)) 0 else 9999
        return max(1, base + stalePenalty + inactivePenalty + disabledPenalty)
    }
}
