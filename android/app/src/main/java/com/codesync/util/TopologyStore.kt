package com.codesync.util

import android.content.Context
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.util.Locale

object TopologyStore {
    private const val TAG = "TopologyStore"
    private const val PREFS_NAME = "topology_lsdb"
    private const val KEY_NODES = "nodes"
    private const val KEY_LINKS = "links"
    private const val KEY_SEEN_SEQ = "seen_seq"
    private const val KEY_DELTA_BACKLOG = "delta_backlog"
    private const val KEY_STORAGE_SCHEMA_VERSION = "storage_schema_version"
    private const val ENTRY_TTL_MS = 24 * 60 * 60 * 1000L
    private const val DEFAULT_DELTA_TTL = 4
    private const val STORAGE_SCHEMA_VERSION = 2
    private const val DELTA_BACKLOG_LIMIT = 12
    private const val DELTA_BACKLOG_PER_SOURCE_LIMIT = 2
    private const val MAX_STORED_NODES = 80
    private const val MAX_STORED_LINKS = 160
    private const val MAX_DELTA_BACKLOG_BYTES = 512 * 1024
    private const val MAX_STORED_ARRAY_BYTES = 768 * 1024
    private val VOLATILE_TOPOLOGY_FIELDS = setOf(
        "seq",
        "updatedAt",
        "lastSeen",
        "expiresAt",
        "connected",
        "status",
        "active"
    )

    fun applyDelta(
        context: Context,
        rawDelta: JSONObject,
        allowNetworkMerge: Boolean = false,
        mergeToNetworkId: String = "",
        mergeFromNetworkIds: List<String> = emptyList()
    ): Boolean {
        var delta = normalizeDelta(rawDelta)
        if (delta.optString("type") != "topology_delta") return false

        val identity = PhoneIdentityStore.get(context)
        val sourceId = delta.optString("sourceDeviceId", delta.optString("originDeviceId")).trim()
        val networkId = delta.optString("networkId").trim()
        if (sourceId.isNotBlank() && sourceId != identity.id && !isTrustedSource(context, sourceId)) {
            return false
        }
        val currentNetworkId = LanTrustStore.getNetworkId(context)
        val deltaMergeFrom = jsonArrayToList(delta.optJSONArray("mergeFromNetworkIds"))
        val requestedMergeFrom = (mergeFromNetworkIds + deltaMergeFrom)
            .map { it.trim() }
            .filter { it.isNotBlank() }
            .distinct()
        var networkChanged = false
        if (networkId.isNotBlank() && networkId != currentNetworkId) {
            val targetNetworkId = mergeToNetworkId.trim().ifBlank { networkId }
            val canImportForeign = allowNetworkMerge && targetNetworkId == currentNetworkId
            val canMigrate = delta.optBoolean("networkMerge", false) && requestedMergeFrom.contains(currentNetworkId)
            if (!canImportForeign && !canMigrate) return false
            if (canMigrate && targetNetworkId != currentNetworkId) {
                LanTrustStore.adoptNetworkId(
                    context = context,
                    networkId = targetNetworkId,
                    allowMerge = true,
                    mergeFromNetworkIds = requestedMergeFrom
                )
                networkChanged = true
            }
            delta = rewriteDeltaNetwork(delta, targetNetworkId, requestedMergeFrom)
        } else if (networkId.isNotBlank() && delta.optBoolean("networkMerge", false) && requestedMergeFrom.isNotEmpty()) {
            LanTrustStore.adoptNetworkId(
                context = context,
                networkId = networkId,
                allowMerge = true,
                mergeFromNetworkIds = requestedMergeFrom
            )
            delta = rewriteDeltaNetwork(delta, networkId, requestedMergeFrom)
            networkChanged = true
        }
        val seq = delta.optLong("seq", 0L)
        val shouldTrackSeq = sourceId.isNotBlank() && sourceId != identity.id && seq > 0L
        if (sourceId.isNotBlank() && sourceId != identity.id && seq > 0L) {
            val seen = loadSeenSeq(context)
            val lastSeq = seen.optLong(sourceId, 0L)
            if (seq <= lastSeq) return false
            seen.put(sourceId, seq)
            saveSeenSeq(context, seen)
        }

        var storageChanged = networkChanged
        var semanticChanged = networkChanged
        val nodes = loadArray(context, KEY_NODES)
        val links = loadArray(context, KEY_LINKS)
        val nodesById = toObjectMap(nodes, "id")
        val linksById = toObjectMap(links, "id")

        val incomingNodes = delta.optJSONArray("nodes") ?: JSONArray()
        for (i in 0 until incomingNodes.length()) {
            val node = normalizeNode(incomingNodes.optJSONObject(i) ?: continue) ?: continue
            if (node.optString("id") == identity.id) continue
            val existing = nodesById[node.optString("id")]
            val missingTrustedDevice = DeviceStore.findDevice(context, node.optString("id")) == null &&
                node.optString("pairingKey").isNotBlank() &&
                node.optBoolean("routable", true) &&
                node.optBoolean("enabled", true) &&
                !node.optBoolean("revoked", false)
            if (isSemanticUpdate(node, existing)) {
                nodesById[node.optString("id")] = node
                upsertDeviceFromNode(context, node)
                storageChanged = true
                semanticChanged = true
            } else if (missingTrustedDevice) {
                upsertDeviceFromNode(context, node)
                semanticChanged = true
            } else if (isVolatileRefresh(node, existing)) {
                nodesById[node.optString("id")] = refreshVolatileFields(existing, node)
                storageChanged = true
            }
        }

        val incomingLinks = delta.optJSONArray("links") ?: JSONArray()
        for (i in 0 until incomingLinks.length()) {
            val link = normalizeLink(incomingLinks.optJSONObject(i) ?: continue) ?: continue
            val existing = linksById[link.optString("id")]
            if (isSemanticUpdate(link, existing)) {
                linksById[link.optString("id")] = link
                storageChanged = true
                semanticChanged = true
            } else if (isVolatileRefresh(link, existing)) {
                linksById[link.optString("id")] = refreshVolatileFields(existing, link)
                storageChanged = true
            }
        }

        if (storageChanged) {
            saveArray(context, KEY_NODES, JSONArray(nodesById.values))
            saveArray(context, KEY_LINKS, JSONArray(linksById.values))
        }
        if (shouldTrackSeq && semanticChanged) {
            rememberDelta(context, delta)
        }
        return semanticChanged
    }

    fun buildDelta(
        context: Context,
        reason: String = "stored_topology",
        ttl: Int = DEFAULT_DELTA_TTL,
        mergeFromNetworkIds: List<String> = emptyList(),
        connectedDeviceIds: Set<String> = emptySet()
    ): JSONObject {
        val identity = PhoneIdentityStore.get(context)
        val now = System.currentTimeMillis()
        val pendingMergeFrom = LanTrustStore.consumePendingMergeFrom(context)
        val mergeFrom = (mergeFromNetworkIds + pendingMergeFrom)
            .map { it.trim() }
            .filter { it.isNotBlank() && it != LanTrustStore.getNetworkId(context) }
            .distinct()
        val nodesById = toObjectMap(loadArray(context, KEY_NODES), "id")
        val linksById = toObjectMap(loadArray(context, KEY_LINKS), "id")
        // 重广播前剔除已过期的外部条目，否则离网节点会被本机持续重新泛洪，
        // 复活对端（如桌面）已按 TTL 回收的僵尸节点，破坏全网收敛。本机 identity
        // 与本地 DeviceStore 设备随后会以新的 now 重新写入，不受此过滤影响。
        pruneExpiredEntries(nodesById, now)
        pruneExpiredEntries(linksById, now)
        val localTsHost = LanDiscovery.localTailscaleHost()
        val localHost = LanDiscovery.localLanHost().ifBlank { localTsHost }
        val localAcceptedAt = nodesById[identity.id]?.optLong("acceptedAt", 0L)
            ?.takeIf { it > 0L }
            ?: now
        nodesById[identity.id] = JSONObject()
            .put("type", "ANDROID_PHONE")
            .put("id", identity.id)
            .put("name", identity.name)
            .put("role", "phone")
            .put("host", localHost)
            .put("port", LanDiscovery.NODE_RELAY_PORT)
            .put("relayPort", LanDiscovery.NODE_RELAY_PORT)
            .put("pairingKey", identity.pairingKey)
            .put("tsHost", localTsHost)
            .put("networkId", LanTrustStore.getNetworkId(context))
            .put("autoPaired", false)
            .put("trustSourceId", identity.id)
            .put("trustLevel", "local")
            .put("acceptedAt", localAcceptedAt)
            .put("capabilities", JSONObject()
                .put("topology", true)
                .put("relay", true)
                .put("sms", true)
                .put("totp", true)
                .put("clipboardText", true)
                .put("clipboardImage", true)
                .put("clipboardFile", true)
                .put("fileTransfer", true)
                .put("softBus", true)
                .put("p2pDirect", true)
                .put("joinRequest", true))
            .put("enabled", true)
            .put("connected", true)
            .put("status", "online")
            .put("routable", localHost.isNotBlank() || localTsHost.isNotBlank())
            .put("authority", "local_phone")
            .put("seq", now)
            .put("updatedAt", now)
            .put("lastSeen", now)
            .put("expiresAt", now + ENTRY_TTL_MS)

        DeviceStore.getDevices(context).forEach { device ->
            val isPhone = isPhoneType(device.type)
            val connected = connectedDeviceIds.contains(device.id)
            val stateUpdatedAt = listOf(
                device.updatedAt,
                device.lastSyncAt,
                device.connectionUpdatedAt
            ).maxOrNull()?.takeIf { it > 0L } ?: now
            nodesById[device.id] = JSONObject()
                .put("id", device.id)
                .put("name", device.name)
                .put("type", device.type)
                .put("role", if (isPhone) "phone" else "desktop")
                .put("host", device.host)
                .put("port", normalizedDevicePort(device.type, device.port))
                .put("wsPort", if (isPhone) JSONObject.NULL else normalizedDevicePort(device.type, device.port))
                .put("relayPort", if (isPhone) normalizedDevicePort(device.type, device.port) else LanDiscovery.NODE_RELAY_PORT)
                .put("pairingKey", device.pairingKey)
                .put("altHosts", JSONArray(device.altHosts))
                .put("networkId", device.networkId.ifBlank { LanTrustStore.getNetworkId(context) })
                .put("autoPaired", device.autoPaired)
                .put("trustSourceId", device.trustSourceId)
                .put("trustLevel", device.trustLevel)
                .put("acceptedAt", device.acceptedAt)
                .put("capabilities", JSONObject(device.capabilities.ifBlank { "{}" }))
                .put("enabled", device.enabled)
                .put("allowSmsCodes", device.allowSmsCodes)
                .put("allowSmsMessages", device.allowSmsMessages)
                .put("allowNotifications", device.allowNotifications)
                .put("allowTotp", device.allowTotp)
                .put("allowClipboard", device.allowClipboard)
                .put("allowClipboardText", device.allowClipboard)
                .put("allowClipboardImage", device.allowClipboardImage)
                .put("allowClipboardFile", device.allowClipboardFile)
                .put("allowFileTransfer", device.allowFileTransfer)
                .put("maxFileSizeMb", device.maxFileSizeMb)
                .put("autoAcceptFiles", device.autoAcceptFiles)
                .put("connected", connected)
                .put("status", when {
                    connected -> "online"
                    device.enabled -> "known"
                    else -> "disabled"
                })
                .put("routable", isDeviceRoutable(device))
                .put("authority", "device_store")
                .put("seq", stateUpdatedAt)
                .put("updatedAt", stateUpdatedAt)
                .put("lastSeen", device.lastSyncAt.takeIf { it > 0L }
                    ?: device.connectionUpdatedAt.takeIf { it > 0L }
                    ?: 0L)
                .put("expiresAt", now + ENTRY_TTL_MS)

            val linkType = if (isPhone) "relay_route" else "verify_push"
            val linkId = "${identity.id}->${device.id}:$linkType"
            linksById[linkId] = JSONObject()
                .put("id", linkId)
                .put("from", identity.id)
                .put("to", device.id)
                .put("type", linkType)
                .put("label", if (isPhone) "节点直连 relay" else "验证码推送")
                .put("enabled", device.enabled)
                .put("allowSmsCodes", device.allowSmsCodes)
                .put("allowSmsMessages", device.allowSmsMessages)
                .put("allowNotifications", device.allowNotifications)
                .put("allowTotp", device.allowTotp)
                .put("allowClipboard", device.allowClipboard)
                .put("allowClipboardText", device.allowClipboard)
                .put("allowClipboardImage", device.allowClipboardImage)
                .put("allowClipboardFile", device.allowClipboardFile)
                .put("allowFileTransfer", device.allowFileTransfer)
                .put("maxFileSizeMb", device.maxFileSizeMb)
                .put("autoAcceptFiles", device.autoAcceptFiles)
                .put("active", connected)
                .put("routable", isDeviceRoutable(device))
                .put("authority", "device_store")
                .put("seq", stateUpdatedAt)
                .put("updatedAt", stateUpdatedAt)
                .put("expiresAt", now + ENTRY_TTL_MS)
        }

        val delta = JSONObject()
            .put("type", "topology_delta")
            .put("version", 2)
            .put("routingProtocol", "link-state-spf")
            .put("controlPlane", true)
            .put("messageTypes", JSONArray(listOf("node_advertisement", "link_advertisement")))
            .put("reason", reason)
            .put("sourceDeviceId", identity.id)
            .put("sourceDeviceName", identity.name)
            .put("sourceDeviceType", "ANDROID_PHONE")
            .put("originDeviceId", identity.id)
            .put("networkId", LanTrustStore.getNetworkId(context))
            .put("seq", now)
            .put("ttl", ttl)
            .put("updatedAt", now)
            .put("nodes", JSONArray(nodesById.values))
            .put("links", JSONArray(linksById.values))
        if (mergeFrom.isNotEmpty()) {
            delta
                .put("networkMerge", true)
                .put("mergeFromNetworkIds", JSONArray(mergeFrom))
                .put("mergedAt", now)
        }
        return delta
    }

    fun rewriteNetworkId(context: Context, targetNetworkId: String, mergeFromNetworkIds: List<String>) {
        val target = targetNetworkId.trim()
        if (target.isBlank()) return
        val mergeFrom = mergeFromNetworkIds.map { it.trim() }.filter { it.isNotBlank() && it != target }.toSet()
        fun shouldRewrite(value: String): Boolean {
            val current = value.trim()
            return current.isBlank() || current == target || current in mergeFrom
        }
        fun rewriteArray(key: String) {
            val original = loadArray(context, key)
            val rewritten = JSONArray()
            var changed = false
            for (i in 0 until original.length()) {
                val item = original.optJSONObject(i) ?: continue
                val next = JSONObject(item.toString())
                if (shouldRewrite(next.optString("networkId"))) {
                    next.put("networkId", target)
                    next.put("updatedAt", System.currentTimeMillis())
                    changed = true
                }
                if (next.optString("type") == "topology_delta") {
                    val networkId = next.optString("networkId").trim()
                    if (shouldRewrite(networkId)) {
                        next.put("networkId", target)
                        val nodes = next.optJSONArray("nodes") ?: JSONArray()
                        for (n in 0 until nodes.length()) {
                            val node = nodes.optJSONObject(n) ?: continue
                            if (shouldRewrite(node.optString("networkId"))) node.put("networkId", target)
                        }
                        changed = true
                    }
                }
                rewritten.put(next)
            }
            if (changed) saveArray(context, key, rewritten)
        }
        rewriteArray(KEY_NODES)
        // Old deltas belong to the pre-merge network and can be rebuilt by the
        // next fresh topology broadcast. Rewriting full historical snapshots is
        // expensive and caused OOM on MIUI devices with a 256MB heap.
        prefs(context).edit().remove(KEY_DELTA_BACKLOG).apply()
    }

    fun rememberLocalDelta(context: Context, delta: JSONObject) {
        val identity = PhoneIdentityStore.get(context)
        if (delta.optString("type") != "topology_delta") return
        if (delta.optString("sourceDeviceId") != identity.id) return
        rememberDelta(context, delta)
    }

    private fun rememberDelta(context: Context, delta: JSONObject) {
        if (delta.optString("type") != "topology_delta") return
        val sourceId = delta.optString("sourceDeviceId", delta.optString("originDeviceId")).trim()
        if (sourceId.isBlank()) return
        val seq = delta.optLong("seq", 0L)
        if (seq <= 0L) return
        val backlog = loadArray(context, KEY_DELTA_BACKLOG)
        val items = mutableListOf<JSONObject>()
        for (i in 0 until backlog.length()) {
            val item = backlog.optJSONObject(i) ?: continue
            val itemSourceId = item.optString("sourceDeviceId", item.optString("originDeviceId")).trim()
            if (itemSourceId != sourceId || item.optLong("seq", 0L) != seq) {
                items.add(item)
            }
        }
        items.add(compactDeltaForBacklog(delta))

        val perSourceCounts = mutableMapOf<String, Int>()
        val kept = items
            .sortedByDescending { it.optLong("seq", it.optLong("updatedAt", 0L)) }
            .filter { item ->
                val itemSource = item.optString("sourceDeviceId", item.optString("originDeviceId")).trim()
                val count = perSourceCounts[itemSource] ?: 0
                if (count >= DELTA_BACKLOG_PER_SOURCE_LIMIT) {
                    false
                } else {
                    perSourceCounts[itemSource] = count + 1
                    true
                }
            }
            .take(DELTA_BACKLOG_LIMIT)
            .asReversed()
        val trimmed = JSONArray()
        kept.forEach { trimmed.put(it) }
        var byteLimited = trimmed
        while (byteLimited.length() > 1 && byteLimited.toString().length > MAX_DELTA_BACKLOG_BYTES) {
            val next = JSONArray()
            for (i in 1 until byteLimited.length()) {
                next.put(byteLimited.optJSONObject(i))
            }
            byteLimited = next
        }
        saveArray(context, KEY_DELTA_BACKLOG, byteLimited)
    }

    fun replayDeltasSince(context: Context, seenSeq: JSONObject?): List<JSONObject> {
        val backlog = loadArray(context, KEY_DELTA_BACKLOG)
        val currentNetworkId = LanTrustStore.getNetworkId(context)
        val result = mutableListOf<JSONObject>()
        for (i in 0 until backlog.length()) {
            val item = backlog.optJSONObject(i) ?: continue
            val networkId = item.optString("networkId").trim()
            if (networkId.isNotBlank() && networkId != currentNetworkId) continue
            val sourceId = item.optString("sourceDeviceId", item.optString("originDeviceId")).trim()
            if (sourceId.isBlank()) continue
            val lastSeen = seenSeq?.optLong(sourceId, 0L) ?: 0L
            if (item.optLong("seq", 0L) > lastSeen) {
                result.add(JSONObject(item.toString()))
            }
        }
        return result.sortedBy { it.optLong("seq", 0L) }
    }

    fun seenSeqSnapshot(context: Context): JSONObject =
        JSONObject(loadSeenSeq(context).toString())

    /**
     * UDP broadcast cannot cross a Tailscale link. Discovery therefore also probes
     * known tailnet addresses learned from trusted topology gossip or local devices.
     */
    fun discoveryProbeHosts(context: Context): List<String> {
        val identity = PhoneIdentityStore.get(context)
        val networkId = LanTrustStore.getNetworkId(context)
        val localHosts = setOf(
            LanDiscovery.localLanHost(),
            LanDiscovery.localTailscaleHost()
        ).filter { it.isNotBlank() }.toSet()
        val hosts = linkedSetOf<String>()

        fun addHost(value: String) {
            val host = normalizeProbeHost(value)
            if (host.isBlank() || host in localHosts) return
            if (!LanDiscovery.isTailscaleAddress(host)) return
            hosts.add(host)
        }

        DeviceStore.getDevices(context)
            .filter { it.id != identity.id && it.enabled && it.pairingKey.isNotBlank() }
            .forEach { device ->
                addHost(device.host)
                device.altHosts.forEach(::addHost)
            }

        val nodes = loadArray(context, KEY_NODES)
        for (i in 0 until nodes.length()) {
            val node = nodes.optJSONObject(i) ?: continue
            val id = node.optString("id", node.optString("deviceId")).trim()
            if (id.isBlank() || id == identity.id) continue
            if (node.optBoolean("revoked", false) || !node.optBoolean("enabled", true)) continue
            val nodeNetworkId = node.optString("networkId").trim()
            if (networkId.isNotBlank() && nodeNetworkId.isNotBlank() && nodeNetworkId != networkId) continue
            addHost(node.optString("host", node.optString("lastIP")))
            addHost(node.optString("relayHost"))
            addHost(node.optString("tsHost"))
            jsonArrayToList(node.optJSONArray("altHosts")).forEach(::addHost)
        }

        return hosts.toList()
    }

    fun markDeviceState(
        context: Context,
        device: DesktopDevice,
        enabled: Boolean = device.enabled,
        revoked: Boolean = false
    ) {
        val identity = PhoneIdentityStore.get(context)
        val now = System.currentTimeMillis()
        val nodesById = toObjectMap(loadArray(context, KEY_NODES), "id")
        val linksById = toObjectMap(loadArray(context, KEY_LINKS), "id")
        val isPhone = isPhoneType(device.type)
        val routable = isDeviceRoutable(device, enabled, revoked)

        nodesById[device.id] = JSONObject()
            .put("id", device.id)
            .put("name", device.name)
            .put("type", normalizeDeviceType(device.type))
            .put("role", if (isPhone) "phone" else "desktop")
            .put("host", device.host)
            .put("port", device.port)
            .put("pairingKey", device.pairingKey)
            .put("altHosts", JSONArray(device.altHosts))
            .put("networkId", device.networkId.ifBlank { LanTrustStore.getNetworkId(context) })
            .put("autoPaired", device.autoPaired)
            .put("trustSourceId", device.trustSourceId)
            .put("trustLevel", device.trustLevel)
            .put("acceptedAt", device.acceptedAt)
            .put("capabilities", JSONObject(device.capabilities.ifBlank { "{}" }))
            .put("enabled", enabled)
            .put("allowSmsCodes", device.allowSmsCodes)
            .put("allowSmsMessages", device.allowSmsMessages)
            .put("allowNotifications", device.allowNotifications)
            .put("allowTotp", device.allowTotp)
            .put("allowClipboard", device.allowClipboard)
            .put("allowClipboardText", device.allowClipboard)
            .put("allowClipboardImage", device.allowClipboardImage)
            .put("allowClipboardFile", device.allowClipboardFile)
            .put("allowFileTransfer", device.allowFileTransfer)
            .put("maxFileSizeMb", device.maxFileSizeMb)
            .put("autoAcceptFiles", device.autoAcceptFiles)
            .put("revoked", revoked)
            .put("connected", false)
            .put("status", when {
                revoked -> "revoked"
                enabled -> "known"
                else -> "disabled"
            })
            .put("routable", routable)
            .put("authority", "local_device_store")
            .put("seq", now)
            .put("updatedAt", now)
            .put("lastSeen", device.lastSyncAt.takeIf { it > 0L }
                ?: device.connectionUpdatedAt.takeIf { it > 0L }
                ?: 0L)
            .put("expiresAt", now + ENTRY_TTL_MS)

        val linkType = if (isPhone) "relay_route" else "verify_push"
        val linkId = "${identity.id}->${device.id}:$linkType"
        linksById[linkId] = JSONObject()
            .put("id", linkId)
            .put("from", identity.id)
            .put("to", device.id)
            .put("type", linkType)
            .put("label", if (isPhone) "节点直连 relay" else "验证码推送")
            .put("enabled", enabled)
            .put("allowSmsCodes", device.allowSmsCodes)
            .put("allowSmsMessages", device.allowSmsMessages)
            .put("allowNotifications", device.allowNotifications)
            .put("allowTotp", device.allowTotp)
            .put("allowClipboard", device.allowClipboard)
            .put("allowClipboardText", device.allowClipboard)
            .put("allowClipboardImage", device.allowClipboardImage)
            .put("allowClipboardFile", device.allowClipboardFile)
            .put("allowFileTransfer", device.allowFileTransfer)
            .put("maxFileSizeMb", device.maxFileSizeMb)
            .put("autoAcceptFiles", device.autoAcceptFiles)
            .put("revoked", revoked)
            .put("active", false)
            .put("routable", routable)
            .put("authority", "local_device_store")
            .put("seq", now)
            .put("updatedAt", now)
            .put("expiresAt", now + ENTRY_TTL_MS)

        saveArray(context, KEY_NODES, JSONArray(nodesById.values))
        saveArray(context, KEY_LINKS, JSONArray(linksById.values))
    }

    private fun normalizeDelta(raw: JSONObject): JSONObject {
        return when (raw.optString("type")) {
            "node_advertisement" -> JSONObject()
                .put("type", "topology_delta")
                .put("sourceDeviceId", raw.optString("sourceDeviceId", raw.optString("id")))
                .put("seq", raw.optLong("seq", raw.optLong("updatedAt", 0L)))
                .put("ttl", raw.optInt("ttl", DEFAULT_DELTA_TTL))
                .put("nodes", JSONArray().put(raw))
                .put("links", JSONArray())
            "link_advertisement" -> JSONObject()
                .put("type", "topology_delta")
                .put("sourceDeviceId", raw.optString("sourceDeviceId", raw.optString("from")))
                .put("seq", raw.optLong("seq", raw.optLong("updatedAt", 0L)))
                .put("ttl", raw.optInt("ttl", DEFAULT_DELTA_TTL))
                .put("nodes", JSONArray())
                .put("links", JSONArray().put(raw))
            else -> raw
        }
    }

    private fun rewriteDeltaNetwork(raw: JSONObject, targetNetworkId: String, mergeFromNetworkIds: List<String>): JSONObject {
        val target = targetNetworkId.trim()
        if (target.isBlank()) return raw
        val mergeFrom = (listOf(raw.optString("networkId")) + mergeFromNetworkIds)
            .map { it.trim() }
            .filter { it.isNotBlank() && it != target }
            .distinct()
        val delta = JSONObject(raw.toString())
            .put("networkId", target)
        if (mergeFrom.isNotEmpty()) {
            delta
                .put("networkMerge", true)
                .put("mergeFromNetworkIds", JSONArray(mergeFrom))
                .put("mergedAt", System.currentTimeMillis())
        }
        val nodes = delta.optJSONArray("nodes") ?: JSONArray()
        for (i in 0 until nodes.length()) {
            val node = nodes.optJSONObject(i) ?: continue
            node.put("networkId", target)
            if (node.optString("trustLevel").isBlank()) node.put("trustLevel", "trusted_lan")
        }
        return delta
    }

    private fun normalizeNode(raw: JSONObject): JSONObject? {
        val id = raw.optString("id", raw.optString("deviceId")).trim()
        if (id.isBlank()) return null
        val type = normalizeDeviceType(raw.optString("type", raw.optString("deviceType", "UNKNOWN_DEVICE")))
        val isPhone = isPhoneType(type)
        val host = raw.optString("host", raw.optString("lastIP")).trim()
        val now = System.currentTimeMillis()
        val updatedAt = raw.optLong("updatedAt", raw.optLong("lastSeen", now)).takeIf { it > 0L } ?: now
        val lastSeen = if (raw.has("lastSeen")) {
            raw.optLong("lastSeen", 0L).takeIf { it > 0L } ?: 0L
        } else {
            0L
        }
        return JSONObject(raw.toString())
            .put("id", id)
            .put("name", raw.optString("name", raw.optString("deviceName", id)).ifBlank { id })
            .put("type", type)
            .put("host", host)
            .put("port", normalizedDevicePort(
                type,
                raw.optInt("wsPort", raw.optInt("port", if (isPhone) LanDiscovery.NODE_RELAY_PORT else 19527))
            ))
            .put("wsPort", raw.optInt("wsPort", if (isPhone) 0 else normalizedDevicePort(type, raw.optInt("port", 19527))))
            .put("relayPort", raw.optInt("relayPort", raw.optInt("joinPort", if (isPhone) raw.optInt("port", LanDiscovery.NODE_RELAY_PORT) else LanDiscovery.NODE_RELAY_PORT)))
            .put("pairingKey", raw.optString("pairingKey", raw.optString("pk")).trim())
            .put("enabled", raw.optBoolean("enabled", true))
            .put("revoked", raw.optBoolean("revoked", false))
            .put("routable", raw.optBoolean(
                "routable",
                rawNodeHasAddressOrRoute(raw, host) &&
                    raw.optString("pairingKey", raw.optString("pk")).isNotBlank() &&
                    raw.optBoolean("enabled", true) &&
                    !raw.optBoolean("revoked", false)
            ))
            .put("seq", raw.optLong("seq", updatedAt))
            .put("updatedAt", updatedAt)
            .put("lastSeen", lastSeen)
            .put("expiresAt", raw.optLong("expiresAt", updatedAt + ENTRY_TTL_MS))
    }

    private fun normalizeLink(raw: JSONObject): JSONObject? {
        val from = raw.optString("from", raw.optString("source")).trim()
        val to = raw.optString("to", raw.optString("target")).trim()
        if (from.isBlank() || to.isBlank()) return null
        val type = raw.optString("type", "routing_adjacency").ifBlank { "routing_adjacency" }
        val now = System.currentTimeMillis()
        val updatedAt = raw.optLong("updatedAt", now).takeIf { it > 0L } ?: now
        return JSONObject(raw.toString())
            .put("id", raw.optString("id", "$from->$to:$type"))
            .put("from", from)
            .put("to", to)
            .put("type", type)
            .put("enabled", raw.optBoolean("enabled", true))
            .put("active", raw.optBoolean("active", false))
            .put("routable", raw.optBoolean("routable", false))
            .put("seq", raw.optLong("seq", updatedAt))
            .put("updatedAt", updatedAt)
            .put("expiresAt", raw.optLong("expiresAt", updatedAt + ENTRY_TTL_MS))
    }

    private fun upsertDeviceFromNode(context: Context, node: JSONObject) {
        val id = node.optString("id").trim()
        val type = node.optString("type").trim()
        val directHost = node.optString("host").trim()
        val nodeAltHosts = (jsonArrayToList(node.optJSONArray("altHosts")) +
            listOfNotNull(node.optString("tsHost").takeIf { it.isNotBlank() }))
            .map { it.trim() }
            .filter { it.isNotBlank() }
            .distinct()
        val host = directHost.ifBlank { nodeAltHosts.firstOrNull().orEmpty() }
        val pairingKey = node.optString("pairingKey").trim()
        if (id.isBlank() || pairingKey.isBlank()) return
        if (!isDeviceType(type)) return
        // gossip 视角的可用性只决定「是否值得为它新建条目」；对已存在的设备
        // 不改写本地 enabled 开关（归本机用户所有，见 DeviceStore.upsertDevice）
        val gossipUsable = node.optBoolean("enabled", true) &&
            !node.optBoolean("revoked", false) &&
            node.optBoolean("routable", true)
        if (!gossipUsable && DeviceStore.findDevice(context, id) == null) return
        DeviceStore.upsertDevice(
            context = context,
            host = host,
            port = normalizedDevicePort(type, node.optInt("wsPort", node.optInt("port", if (isPhoneType(type)) LanDiscovery.NODE_RELAY_PORT else 19527))),
            pairingKey = pairingKey,
            name = node.optString("name", "Device ${host.ifBlank { id }}").ifBlank { "Device ${host.ifBlank { id }}" },
            deviceId = id,
            deviceType = type,
            routeUpdatedAt = node.optLong("updatedAt", 0L),
            altHosts = nodeAltHosts.filter { it != host },
            networkId = node.optString("networkId"),
            autoPaired = node.optBoolean("autoPaired", false),
            trustSourceId = node.optString("trustSourceId"),
            trustLevel = node.optString("trustLevel"),
            acceptedAt = node.optLong("acceptedAt", 0L),
            capabilities = node.optJSONObject("capabilities")?.toString().orEmpty(),
            policyAllowSmsCodes = node.optBoolean("allowSmsCodes", true),
            policyAllowSmsMessages = node.optBoolean("allowSmsMessages", true),
            policyAllowNotifications = node.optBoolean("allowNotifications", true),
            policyAllowTotp = node.optBoolean("allowTotp", true),
            // 缺字段时默认 true，与 DeviceStore 新建默认一致（局域网可信环境下
            // 剪贴板默认放行，由两端全局总开关把关）。避免同一设备经 gossip 学习
            // 得到 false、经扫码新建得到 true 的分叉（剪贴板"有时同步有时不同步"根因）
            policyAllowClipboard = node.optBoolean(
                "allowClipboardText",
                node.optBoolean("allowClipboard", true)
            ),
            policyAllowClipboardImage = node.optBoolean(
                "allowClipboardImage",
                node.optBoolean("allowImages", node.optBoolean("allowClipboard", true))
            ),
            policyAllowClipboardFile = node.optBoolean("allowClipboardFile", false),
            policyAllowFileTransfer = node.optBoolean("allowFileTransfer", false),
            policyMaxFileSizeMb = node.optInt("maxFileSizeMb", 50),
            policyAutoAcceptFiles = node.optBoolean("autoAcceptFiles", false)
        )
    }

    private fun isSemanticUpdate(incoming: JSONObject, existing: JSONObject?): Boolean {
        if (existing == null) return true
        val incomingSeq = incoming.optLong("seq", incoming.optLong("updatedAt", 0L))
        val existingSeq = existing.optLong("seq", existing.optLong("updatedAt", 0L))
        if (existingSeq > 0L && incomingSeq > 0L && incomingSeq < existingSeq) return false
        return semanticFingerprint(incoming) != semanticFingerprint(existing)
    }

    private fun isVolatileRefresh(incoming: JSONObject, existing: JSONObject?): Boolean {
        if (existing == null) return false
        if (semanticFingerprint(incoming) != semanticFingerprint(existing)) return false
        val incomingSeq = incoming.optLong("seq", incoming.optLong("updatedAt", 0L))
        val existingSeq = existing.optLong("seq", existing.optLong("updatedAt", 0L))
        return incomingSeq > existingSeq
    }

    private fun refreshVolatileFields(existing: JSONObject?, incoming: JSONObject): JSONObject {
        val result = JSONObject(existing?.toString() ?: "{}")
        VOLATILE_TOPOLOGY_FIELDS.forEach { key ->
            if (incoming.has(key)) result.put(key, incoming.opt(key))
        }
        return result
    }

    private fun semanticFingerprint(obj: JSONObject): String =
        canonicalJson(obj, VOLATILE_TOPOLOGY_FIELDS)

    private fun canonicalJson(value: Any?, ignoredKeys: Set<String> = emptySet()): String {
        return when (value) {
            is JSONObject -> {
                val keys = mutableListOf<String>()
                val iterator = value.keys()
                while (iterator.hasNext()) {
                    val key = iterator.next()
                    if (key !in ignoredKeys) keys.add(key)
                }
                keys.sorted().joinToString(prefix = "{", postfix = "}") { key ->
                    "$key:${canonicalJson(value.opt(key), ignoredKeys)}"
                }
            }
            is JSONArray -> {
                val values = (0 until value.length()).map { canonicalJson(value.opt(it), ignoredKeys) }
                values.joinToString(prefix = "[", postfix = "]")
            }
            JSONObject.NULL, null -> "null"
            else -> value.toString()
        }
    }

    private fun normalizeDeviceType(type: String): String {
        val value = type.trim().uppercase(Locale.ROOT)
        return when {
            value.contains("PHONE") || value.contains("ANDROID") -> "ANDROID_PHONE"
            value.contains("MAC") -> "MAC_DESKTOP"
            value.contains("LINUX") -> "LINUX_DESKTOP"
            value.contains("WINDOWS") || value.contains("DESKTOP") -> "WINDOWS_DESKTOP"
            else -> value.ifBlank { "UNKNOWN_DEVICE" }
        }
    }

    private fun isPhoneType(type: String): Boolean =
        type.uppercase(Locale.ROOT).contains("PHONE")

    private fun normalizedDevicePort(type: String, port: Int): Int {
        val isPhone = isPhoneType(type)
        if (isPhone) return if (port > 0) port else LanDiscovery.NODE_RELAY_PORT
        return when {
            port <= 0 -> 19527
            port == LanDiscovery.NODE_RELAY_PORT -> 19527
            else -> port
        }
    }

    private fun isDeviceType(type: String): Boolean {
        val value = type.uppercase(Locale.ROOT)
        return value.contains("PHONE") || value.contains("DESKTOP")
    }

    private fun isDeviceRoutable(
        device: DesktopDevice,
        enabled: Boolean = device.enabled,
        revoked: Boolean = false
    ): Boolean {
        if (!enabled || revoked || device.pairingKey.isBlank()) return false
        if (device.host.isNotBlank() || device.altHosts.any { it.isNotBlank() }) return true
        return device.routeNextHopId.isNotBlank() ||
            device.routeMetric > 0 ||
            device.routePath.size > 1
    }

    private fun rawNodeHasAddressOrRoute(raw: JSONObject, host: String): Boolean {
        if (host.isNotBlank()) return true
        if (raw.optString("tsHost").isNotBlank() || raw.optString("relayHost").isNotBlank()) return true
        if (jsonArrayToList(raw.optJSONArray("altHosts")).any { it.isNotBlank() }) return true
        if (raw.optString("routeNextHopId").isNotBlank() || raw.optInt("routeMetric", 0) > 0) return true
        return jsonArrayToList(raw.optJSONArray("routePath")).size > 1
    }

    private fun isTrustedSource(context: Context, sourceId: String): Boolean {
        val identity = PhoneIdentityStore.get(context)
        if (sourceId == identity.id) return true
        return DeviceStore.findDevice(context, sourceId)?.let {
            it.enabled && it.pairingKey.isNotBlank() &&
                (it.networkId.isBlank() || it.networkId == LanTrustStore.getNetworkId(context))
        } == true
    }

    private fun toObjectMap(array: JSONArray, key: String): LinkedHashMap<String, JSONObject> {
        val map = linkedMapOf<String, JSONObject>()
        for (i in 0 until array.length()) {
            val obj = array.optJSONObject(i) ?: continue
            val id = obj.optString(key).trim()
            if (id.isNotBlank()) map[id] = obj
        }
        return map
    }

    private fun pruneExpiredEntries(items: MutableMap<String, JSONObject>, now: Long) {
        val iterator = items.iterator()
        while (iterator.hasNext()) {
            val item = iterator.next().value
            val expiresAt = item.optLong("expiresAt", 0L)
            if (expiresAt > 0L && expiresAt < now) {
                iterator.remove()
            }
        }
    }

    private fun jsonArrayToList(array: JSONArray?): List<String> {
        if (array == null) return emptyList()
        return (0 until array.length()).mapNotNull {
            array.optString(it).takeIf { value -> value.isNotBlank() }
        }
    }

    private fun normalizeProbeHost(value: String): String {
        return value.trim()
            .removePrefix("http://")
            .removePrefix("https://")
            .removePrefix("[")
            .substringBefore("]")
            .substringBefore("/")
            .substringBefore(":")
            .trim()
    }

    private fun loadSeenSeq(context: Context): JSONObject =
        runCatching { JSONObject(prefs(context).getString(KEY_SEEN_SEQ, "{}").orEmpty()) }
            .getOrElse { JSONObject() }

    private fun saveSeenSeq(context: Context, seen: JSONObject) {
        prefs(context).edit().putString(KEY_SEEN_SEQ, seen.toString()).apply()
    }

    private fun loadArray(context: Context, key: String): JSONArray {
        ensureStorageSchema(context)
        val raw = try {
            prefs(context).getString(key, "[]").orEmpty()
        } catch (e: OutOfMemoryError) {
            clearOversizedArray(context, key, e)
            return JSONArray()
        } catch (e: Throwable) {
            Log.e(TAG, "Failed to read topology array: $key", e)
            return JSONArray()
        }
        if (key == KEY_DELTA_BACKLOG && raw.length > MAX_DELTA_BACKLOG_BYTES) {
            Log.w(TAG, "Drop oversized topology delta backlog: ${raw.length} bytes")
            prefs(context).edit().remove(key).apply()
            return JSONArray()
        }
        return runCatching { JSONArray(raw) }
            .getOrElse {
                Log.e(TAG, "Failed to parse topology array: $key", it)
                prefs(context).edit().remove(key).apply()
                JSONArray()
            }
    }

    private fun saveArray(context: Context, key: String, array: JSONArray) {
        ensureStorageSchema(context)
        val compacted = compactArrayForKey(key, array)
        try {
            prefs(context).edit().putString(key, compacted.toString()).apply()
        } catch (e: OutOfMemoryError) {
            clearOversizedArray(context, key, e)
        } catch (e: Throwable) {
            Log.e(TAG, "Failed to save topology array: $key", e)
        }
    }

    private fun ensureStorageSchema(context: Context) {
        val prefs = prefs(context)
        val version = prefs.getInt(KEY_STORAGE_SCHEMA_VERSION, 0)
        if (version >= STORAGE_SCHEMA_VERSION) return
        prefs.edit()
            .remove(KEY_DELTA_BACKLOG)
            .putInt(KEY_STORAGE_SCHEMA_VERSION, STORAGE_SCHEMA_VERSION)
            .apply()
    }

    private fun compactArrayForKey(key: String, array: JSONArray): JSONArray {
        val compacted = when (key) {
            KEY_NODES -> compactObjectArray(array, MAX_STORED_NODES)
            KEY_LINKS -> compactObjectArray(array, MAX_STORED_LINKS)
            KEY_DELTA_BACKLOG -> compactBacklogArray(array)
            else -> array
        }
        val limit = if (key == KEY_DELTA_BACKLOG) MAX_DELTA_BACKLOG_BYTES else MAX_STORED_ARRAY_BYTES
        return trimArrayToByteLimit(compacted, limit)
    }

    private fun compactObjectArray(array: JSONArray, maxItems: Int): JSONArray {
        val now = System.currentTimeMillis()
        val items = mutableListOf<JSONObject>()
        for (i in 0 until array.length()) {
            val item = array.optJSONObject(i) ?: continue
            // expiresAt 写入时已是 now+ENTRY_TTL_MS，故过期判定就是 expiresAt < now。
            // 旧实现用 now - ENTRY_TTL_MS 作阈值，等价于让条目存活 2×TTL（48h）才回收，
            // 且离网节点会被持续重新广播击穿对端的 GC。
            val expiresAt = item.optLong("expiresAt", 0L)
            if (expiresAt > 0L && expiresAt < now) continue
            items.add(item)
        }
        val compacted = JSONArray()
        items
            .sortedByDescending { it.optLong("updatedAt", it.optLong("seq", 0L)) }
            .take(maxItems)
            .forEach { compacted.put(it) }
        return compacted
    }

    private fun compactBacklogArray(array: JSONArray): JSONArray {
        val perSourceCounts = mutableMapOf<String, Int>()
        val items = mutableListOf<JSONObject>()
        for (i in 0 until array.length()) {
            val item = array.optJSONObject(i) ?: continue
            items.add(compactDeltaForBacklog(item))
        }
        val compacted = JSONArray()
        items
            .sortedByDescending { it.optLong("seq", it.optLong("updatedAt", 0L)) }
            .filter { item ->
                val source = item.optString("sourceDeviceId", item.optString("originDeviceId")).trim()
                val count = perSourceCounts[source] ?: 0
                if (count >= DELTA_BACKLOG_PER_SOURCE_LIMIT) {
                    false
                } else {
                    perSourceCounts[source] = count + 1
                    true
                }
            }
            .take(DELTA_BACKLOG_LIMIT)
            .asReversed()
            .forEach { compacted.put(it) }
        return compacted
    }

    private fun compactDeltaForBacklog(delta: JSONObject): JSONObject {
        val compact = JSONObject(delta.toString())
        compact.put("nodes", compactObjectArray(compact.optJSONArray("nodes") ?: JSONArray(), MAX_STORED_NODES))
        compact.put("links", compactObjectArray(compact.optJSONArray("links") ?: JSONArray(), MAX_STORED_LINKS))
        return compact
    }

    private fun trimArrayToByteLimit(array: JSONArray, maxBytes: Int): JSONArray {
        var current = array
        while (current.length() > 1 && current.toString().length > maxBytes) {
            val next = JSONArray()
            for (i in 1 until current.length()) {
                next.put(current.optJSONObject(i))
            }
            current = next
        }
        if (current.length() == 1 && current.toString().length > maxBytes) {
            return JSONArray()
        }
        return current
    }

    private fun clearOversizedArray(context: Context, key: String, error: Throwable) {
        Log.e(TAG, "Drop oversized topology array after memory pressure: $key", error)
        runCatching {
            prefs(context).edit().remove(key).apply()
            System.gc()
        }
    }

    private fun prefs(context: Context) = SecurePrefs.get(context, PREFS_NAME)
}
