package com.codesync.util

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import kotlin.math.max

object TopologyViewModel {
    data class Node(
        val id: String,
        val name: String,
        val type: String,
        val status: String,
        val local: Boolean = false,
        val meta: String = "",
        val detailLines: List<String> = emptyList(),
        val networkId: String = "",
        val trustSourceId: String = "",
        val trustLevel: String = "",
        val acceptedAt: Long = 0L,
        val lastSeen: Long = 0L
    )

    data class Edge(
        val from: String,
        val to: String,
        val label: String,
        val active: Boolean,
        val kind: String,
        val metric: Int = 0,
        val routable: Boolean = false,
        val updatedAt: Long = 0L
    )

    data class Model(
        val localNodeId: String,
        val nodes: List<Node>,
        val edges: List<Edge>
    ) {
        val nodeMap: Map<String, Node> = nodes.associateBy { it.id }
    }

    fun build(
        context: Context,
        discoveredLanNodes: List<LanDiscoveredDevice> = emptyList(),
        remoteTotps: List<TotpEntry> = emptyList(),
        connectedDeviceIds: Set<String> = emptySet()
    ): Model {
        val identity = PhoneIdentityStore.get(context)
        val routes = RouteManager.routeMap(context, connectedDeviceIds = connectedDeviceIds)
        val devices = DeviceStore.getDevices(context)
        val deviceById = devices.associateBy { it.id }
        val snapshot = TopologyStore.buildRouteSnapshot(context, connectedDeviceIds = connectedDeviceIds)
        val rawNodes = snapshot.optJSONArray("nodes") ?: JSONArray()
        val rawLinks = snapshot.optJSONArray("links") ?: JSONArray()
        val now = System.currentTimeMillis()

        val nodes = linkedMapOf<String, Node>()
        for (i in 0 until rawNodes.length()) {
            val raw = rawNodes.optJSONObject(i) ?: continue
            val id = raw.optString("id", raw.optString("deviceId")).trim()
            if (id.isBlank()) continue
            val device = deviceById[id]
            val route = routes[id]
            nodes[id] = buildNode(
                raw = raw,
                device = device,
                route = route,
                localId = identity.id,
                connectedDeviceIds = connectedDeviceIds,
                now = now
            )
        }

        if (!nodes.containsKey(identity.id)) {
            nodes[identity.id] = Node(
                id = identity.id,
                name = identity.name,
                type = "ANDROID_PHONE",
                status = "online",
                local = true,
                meta = "本机手机 · 在线",
                networkId = LanTrustStore.getNetworkId(context),
                trustSourceId = identity.id,
                trustLevel = "local",
                lastSeen = now,
                detailLines = listOf(
                    "设备：${identity.name}",
                    "类型：ANDROID_PHONE",
                    "networkId：${LanTrustStore.getNetworkId(context).ifBlank { "未建立" }}",
                    "信任级别：local",
                    "路由角色：本机源节点"
                )
            )
        }

        val pairedIds = nodes.keys + devices.map { it.id }.toSet()
        val discovered = discoveredLanNodes
            .filter { it.id.isNotBlank() && it.id != identity.id && it.id !in pairedIds }
            .distinctBy { it.id }
        discovered.forEach { peer ->
            nodes[peer.id] = Node(
                id = peer.id,
                name = peer.name.ifBlank { peer.id },
                type = peer.type.ifBlank { "UNKNOWN_DEVICE" },
                status = "discovered",
                meta = "${peer.host}:${peer.port} · 未确认",
                lastSeen = now,
                detailLines = listOf(
                    "节点：${peer.name.ifBlank { peer.id }}",
                    "类型：${peer.type.ifBlank { "UNKNOWN_DEVICE" }}",
                    "地址：${peer.host}:${peer.port}",
                    "状态：仅局域网发现，未进入可路由可信网络",
                    "说明：未确认节点不会参与 SPF 路由，也不会接收业务消息"
                )
            )
        }

        val edges = linkedMapOf<String, Edge>()
        fun addEdge(edge: Edge) {
            if (edge.from.isBlank() || edge.to.isBlank()) return
            if (!nodes.containsKey(edge.from) || !nodes.containsKey(edge.to)) return
            val endpoints = listOf(edge.from, edge.to).sorted()
            val key = "${endpoints[0]}--${endpoints[1]}:${edge.kind}:${edge.label}"
            val existing = edges[key]
            edges[key] = if (existing == null) {
                edge
            } else {
                existing.copy(
                    active = existing.active || edge.active,
                    routable = existing.routable || edge.routable,
                    metric = minPositive(existing.metric, edge.metric),
                    updatedAt = max(existing.updatedAt, edge.updatedAt)
                )
            }
        }

        for (i in 0 until rawLinks.length()) {
            val raw = rawLinks.optJSONObject(i) ?: continue
            val type = raw.optString("type", "routing_adjacency")
            addEdge(
                Edge(
                    from = raw.optString("from", raw.optString("source")).trim(),
                    to = raw.optString("to", raw.optString("target")).trim(),
                    label = raw.optString("label").ifBlank { linkLabel(type) },
                    active = raw.optBoolean("active", false),
                    kind = graphKind(type),
                    metric = raw.optInt("metric", 0),
                    routable = raw.optBoolean("routable", false),
                    updatedAt = raw.optLong("updatedAt", 0L)
                )
            )
        }

        routes.values.forEach { route ->
            route.path.zipWithNext().forEachIndexed { index, pair ->
                addEdge(
                    Edge(
                        from = pair.first,
                        to = pair.second,
                        label = route.pathLabels.getOrNull(index).orEmpty().ifBlank { "SPF" },
                        active = route.active,
                        kind = if (route.hopCount > 1) "relay" else "route",
                        metric = route.metric,
                        routable = true,
                        updatedAt = route.updatedAt
                    )
                )
            }
        }

        remoteTotps
            .filter { !it.isLocal && it.sourceDeviceId.isNotBlank() }
            .groupBy { it.sourceDeviceId }
            .forEach { (sourceId, entries) ->
                val first = entries.first()
                if (!nodes.containsKey(sourceId)) {
                    nodes[sourceId] = Node(
                        id = sourceId,
                        name = first.sourceDeviceName.ifBlank { "远端节点" },
                        type = first.sourceDeviceType.ifBlank { "UNKNOWN_DEVICE" },
                        status = "synced",
                        meta = "TOTP 来源 · ${entries.size} 个",
                        detailLines = listOf(
                            "来源：${first.sourceDeviceName.ifBlank { "远端节点" }}",
                            "类型：${first.sourceDeviceType.ifBlank { "UNKNOWN_DEVICE" }}",
                            "同步内容：${entries.size} 个 TOTP 种子",
                            "权限：远端来源只读"
                        )
                    )
                }
                addEdge(
                    Edge(
                        from = sourceId,
                        to = identity.id,
                        label = "TOTP",
                        active = false,
                        kind = "totp"
                    )
                )
            }

        discovered.forEach { peer ->
            addEdge(
                Edge(
                    from = identity.id,
                    to = peer.id,
                    label = "发现",
                    active = false,
                    kind = "discovery"
                )
            )
        }

        return Model(
            localNodeId = identity.id,
            nodes = nodes.values.sortedWith(compareBy<Node> { nodeRank(it) }.thenBy { it.name.lowercase(Locale.ROOT) }),
            edges = edges.values.sortedWith(compareBy<Edge> { edgeRank(it) }.thenBy { it.label })
        )
    }

    private fun buildNode(
        raw: JSONObject,
        device: DesktopDevice?,
        route: RouteManager.RouteInfo?,
        localId: String,
        connectedDeviceIds: Set<String>,
        now: Long
    ): Node {
        val id = raw.optString("id", raw.optString("deviceId")).trim()
        val type = raw.optString("type", raw.optString("deviceType", "UNKNOWN_DEVICE"))
        val name = raw.optString("name", raw.optString("deviceName", id)).ifBlank { id }
        val local = id == localId
        val status = when {
            local -> "online"
            device != null -> RouteManager.statusForDevice(device, route, connectedDeviceIds, now)
            raw.optBoolean("revoked", false) -> "offline"
            !raw.optBoolean("enabled", true) -> "disabled"
            id in connectedDeviceIds || raw.optBoolean("connected", false) -> "online"
            route != null && isRecent(route.updatedAt, now) -> "reachable"
            hasRoutableAddress(raw) || raw.optBoolean("routable", false) -> "known"
            else -> raw.optString("status").ifBlank { "offline" }
        }
        val networkId = raw.optString("networkId", device?.networkId.orEmpty())
        val trustSourceId = raw.optString("trustSourceId", device?.trustSourceId.orEmpty())
        val trustLevel = raw.optString("trustLevel", device?.trustLevel.orEmpty())
        val acceptedAt = raw.optLong("acceptedAt", device?.acceptedAt ?: 0L)
        val lastSeen = listOf(
            raw.optLong("lastSeen", 0L),
            raw.optLong("updatedAt", 0L),
            device?.lastSyncAt ?: 0L,
            device?.connectionUpdatedAt ?: 0L
        ).maxOrNull() ?: 0L
        val meta = buildList {
            add(deviceTypeLabel(type))
            add(statusLabel(status))
            route?.let {
                if (it.hopCount > 1) add("经 ${it.nextHopName.ifBlank { it.nextHopId }}")
                if (it.metric > 0) add("m=${it.metric}")
            }
            val host = device?.host?.takeIf { it.isNotBlank() } ?: raw.optString("host").takeIf { it.isNotBlank() }
            if (host != null) add(host)
        }.joinToString(" · ")

        return Node(
            id = id,
            name = name,
            type = type,
            status = status,
            local = local,
            meta = meta,
            networkId = networkId,
            trustSourceId = trustSourceId,
            trustLevel = trustLevel,
            acceptedAt = acceptedAt,
            lastSeen = lastSeen,
            detailLines = buildDetailLines(raw, device, route, status, networkId, trustSourceId, trustLevel, acceptedAt, lastSeen)
        )
    }

    private fun buildDetailLines(
        raw: JSONObject,
        device: DesktopDevice?,
        route: RouteManager.RouteInfo?,
        status: String,
        networkId: String,
        trustSourceId: String,
        trustLevel: String,
        acceptedAt: Long,
        lastSeen: Long
    ): List<String> {
        val host = device?.host?.takeIf { it.isNotBlank() } ?: raw.optString("host")
        val port = device?.port ?: raw.optInt("port", 0)
        return buildList {
            add("设备：${raw.optString("name", device?.name.orEmpty()).ifBlank { device?.name ?: raw.optString("id") }}")
            add("类型：${raw.optString("type", device?.type ?: "UNKNOWN_DEVICE")}")
            add("状态：${statusLabel(status)}")
            if (host.isNotBlank()) add("地址：$host${if (port > 0) ":$port" else ""}")
            val altHosts = device?.altHosts?.takeIf { it.isNotEmpty() } ?: jsonArrayToList(raw.optJSONArray("altHosts"))
            if (altHosts.isNotEmpty()) add("备用地址：${altHosts.joinToString("、")}")
            add("networkId：${networkId.ifBlank { "未设置" }}")
            add("信任来源：${trustSourceId.ifBlank { "未知" }}")
            add("信任级别：${trustLevel.ifBlank { "未知" }}")
            add("入网时间：${formatTime(acceptedAt)}")
            route?.let {
                add("路由：${it.path.joinToString(" → ")}")
                add("下一跳：${it.nextHopName.ifBlank { it.nextHopId }}")
                add("metric：${it.metric}")
            } ?: add("路由：暂无 SPF 可达路径")
            device?.let { add("允许内容：${contentPolicySummary(it)}") }
            add("上次同步：${formatTime(lastSeen)}")
        }
    }

    private fun contentPolicySummary(device: DesktopDevice): String {
        val items = buildList {
            if (device.allowSmsCodes) add("验证码")
            if (device.allowSmsMessages) add("短信")
            if (device.allowNotifications) add("通知")
            if (device.allowTotp) add("TOTP")
            if (device.allowClipboard) add("剪贴板文本")
            if (device.allowClipboardImage) add("剪贴板图片")
            if (device.allowClipboardFile || device.allowFileTransfer) add("文件")
        }
        return items.ifEmpty { listOf("无业务内容") }.joinToString("、")
    }

    private fun jsonArrayToList(array: JSONArray?): List<String> {
        if (array == null) return emptyList()
        return (0 until array.length()).mapNotNull { array.optString(it).takeIf { value -> value.isNotBlank() } }
    }

    private fun hasRoutableAddress(raw: JSONObject): Boolean =
        raw.optString("host").isNotBlank() ||
            raw.optString("tsHost").isNotBlank() ||
            raw.optString("relayHost").isNotBlank() ||
            jsonArrayToList(raw.optJSONArray("altHosts")).isNotEmpty()

    private fun isRecent(timestamp: Long, now: Long): Boolean =
        timestamp > 0L && now - timestamp <= RouteManager.RECENT_REACHABLE_MS

    private fun graphKind(type: String): String = when (type) {
        "relay_route" -> "relay"
        "spf_route", "routing_adjacency", "desktop_pair" -> "route"
        "totp_sync" -> "totp"
        "lan_discovery" -> "discovery"
        else -> "push"
    }

    private fun linkLabel(type: String): String = when (type) {
        "relay_route" -> "Relay"
        "routing_adjacency" -> "邻接"
        "desktop_pair" -> "电脑互配"
        "totp_sync" -> "TOTP"
        "lan_discovery" -> "发现"
        else -> "同步"
    }

    private fun deviceTypeLabel(type: String): String =
        if (type.uppercase(Locale.ROOT).contains("PHONE")) "手机" else if (type.uppercase(Locale.ROOT).contains("DESKTOP")) "电脑" else "节点"

    fun statusLabel(status: String): String = when (status) {
        "online" -> "在线直连"
        "reachable" -> "近期可达"
        "known" -> "已知离线"
        "enabled" -> "已启用"
        "disabled" -> "已禁用"
        "synced" -> "已同步"
        "discovered" -> "仅发现"
        else -> "离线"
    }

    private fun nodeRank(node: Node): Int = when {
        node.local -> 0
        node.status == "online" -> 1
        node.status == "reachable" -> 2
        node.status == "known" -> 3
        node.status == "synced" -> 4
        node.status == "discovered" -> 5
        node.status == "disabled" -> 6
        else -> 7
    }

    private fun edgeRank(edge: Edge): Int = when {
        edge.active -> 0
        edge.routable -> 1
        edge.kind == "discovery" -> 3
        else -> 2
    }

    private fun minPositive(a: Int, b: Int): Int {
        val positives = listOf(a, b).filter { it > 0 }
        return positives.minOrNull() ?: max(a, b)
    }

    private fun formatTime(value: Long): String {
        if (value <= 0L) return "暂无记录"
        return SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.getDefault()).format(Date(value))
    }
}
