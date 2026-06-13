package com.codesync.util

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.util.Locale

object TopologyStore {
    private const val PREFS_NAME = "topology_lsdb"
    private const val KEY_NODES = "nodes"
    private const val KEY_LINKS = "links"
    private const val KEY_SEEN_SEQ = "seen_seq"
    private const val KEY_DELTA_BACKLOG = "delta_backlog"
    private const val ENTRY_TTL_MS = 24 * 60 * 60 * 1000L
    private const val DEFAULT_DELTA_TTL = 4
    private const val DELTA_BACKLOG_LIMIT = 80

    fun applyDelta(context: Context, rawDelta: JSONObject): Boolean {
        val delta = normalizeDelta(rawDelta)
        if (delta.optString("type") != "topology_delta") return false

        val identity = PhoneIdentityStore.get(context)
        val sourceId = delta.optString("sourceDeviceId", delta.optString("originDeviceId")).trim()
        val networkId = delta.optString("networkId").trim()
        if (networkId.isNotBlank() && networkId != LanTrustStore.getNetworkId(context)) return false
        if (sourceId.isNotBlank() && sourceId != identity.id && !isTrustedSource(context, sourceId)) {
            return false
        }
        val seq = delta.optLong("seq", 0L)
        if (sourceId.isNotBlank() && sourceId != identity.id && seq > 0L) {
            val seen = loadSeenSeq(context)
            val lastSeq = seen.optLong(sourceId, 0L)
            if (seq <= lastSeq) return false
            seen.put(sourceId, seq)
            saveSeenSeq(context, seen)
            rememberDelta(context, delta)
        }

        var changed = false
        val nodes = loadArray(context, KEY_NODES)
        val links = loadArray(context, KEY_LINKS)
        val nodesById = toObjectMap(nodes, "id")
        val linksById = toObjectMap(links, "id")

        val incomingNodes = delta.optJSONArray("nodes") ?: JSONArray()
        for (i in 0 until incomingNodes.length()) {
            val node = normalizeNode(incomingNodes.optJSONObject(i) ?: continue) ?: continue
            if (node.optString("id") == identity.id) continue
            val existing = nodesById[node.optString("id")]
            if (isNewer(node, existing)) {
                nodesById[node.optString("id")] = node
                upsertDeviceFromNode(context, node)
                changed = true
            }
        }

        val incomingLinks = delta.optJSONArray("links") ?: JSONArray()
        for (i in 0 until incomingLinks.length()) {
            val link = normalizeLink(incomingLinks.optJSONObject(i) ?: continue) ?: continue
            val existing = linksById[link.optString("id")]
            if (isNewer(link, existing)) {
                linksById[link.optString("id")] = link
                changed = true
            }
        }

        if (changed) {
            saveArray(context, KEY_NODES, JSONArray(nodesById.values))
            saveArray(context, KEY_LINKS, JSONArray(linksById.values))
        }
        return changed
    }

    fun buildDelta(context: Context, reason: String = "stored_topology", ttl: Int = DEFAULT_DELTA_TTL): JSONObject {
        val identity = PhoneIdentityStore.get(context)
        val now = System.currentTimeMillis()
        val nodesById = toObjectMap(loadArray(context, KEY_NODES), "id")
        val linksById = toObjectMap(loadArray(context, KEY_LINKS), "id")

        val localTsHost = LanDiscovery.localTailscaleHost()
        val localHost = LanDiscovery.localLanHost().ifBlank { localTsHost }
        nodesById[identity.id] = JSONObject()
            .put("type", "ANDROID_PHONE")
            .put("id", identity.id)
            .put("name", identity.name)
            .put("role", "phone")
            .put("host", localHost)
            .put("port", LanDiscovery.NODE_RELAY_PORT)
            .put("pairingKey", identity.pairingKey)
            .put("tsHost", localTsHost)
            .put("networkId", LanTrustStore.getNetworkId(context))
            .put("autoPaired", false)
            .put("trustSourceId", identity.id)
            .put("trustLevel", "local")
            .put("acceptedAt", now)
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
            .put("routable", localHost.isNotBlank())
            .put("authority", "local_phone")
            .put("seq", now)
            .put("updatedAt", now)
            .put("lastSeen", now)
            .put("expiresAt", now + ENTRY_TTL_MS)

        DeviceStore.getDevices(context).forEach { device ->
            val isPhone = isPhoneType(device.type)
            nodesById[device.id] = JSONObject()
                .put("id", device.id)
                .put("name", device.name)
                .put("type", device.type)
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
                .put("connected", false)
                .put("status", if (device.enabled) "known" else "disabled")
                .put("routable", device.enabled && device.host.isNotBlank() && device.pairingKey.isNotBlank())
                .put("authority", "device_store")
                .put("seq", device.updatedAt)
                .put("updatedAt", device.updatedAt)
                .put("lastSeen", device.lastSyncAt.takeIf { it > 0L } ?: device.updatedAt)
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
                .put("active", false)
                .put("routable", device.enabled && device.host.isNotBlank() && device.pairingKey.isNotBlank())
                .put("authority", "device_store")
                .put("seq", device.updatedAt)
                .put("updatedAt", device.updatedAt)
                .put("expiresAt", now + ENTRY_TTL_MS)
        }

        return JSONObject()
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
        val filtered = JSONArray()
        for (i in 0 until backlog.length()) {
            val item = backlog.optJSONObject(i) ?: continue
            val itemSourceId = item.optString("sourceDeviceId", item.optString("originDeviceId")).trim()
            if (itemSourceId != sourceId || item.optLong("seq", 0L) != seq) {
                filtered.put(item)
            }
        }
        filtered.put(JSONObject(delta.toString()))
        val trimmed = JSONArray()
        val start = (filtered.length() - DELTA_BACKLOG_LIMIT).coerceAtLeast(0)
        for (i in start until filtered.length()) {
            trimmed.put(filtered.optJSONObject(i))
        }
        saveArray(context, KEY_DELTA_BACKLOG, trimmed)
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
        val routable = enabled && !revoked && device.host.isNotBlank() && device.pairingKey.isNotBlank()

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
            .put("lastSeen", device.lastSyncAt.takeIf { it > 0L } ?: now)
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

    private fun normalizeNode(raw: JSONObject): JSONObject? {
        val id = raw.optString("id", raw.optString("deviceId")).trim()
        if (id.isBlank()) return null
        val type = normalizeDeviceType(raw.optString("type", raw.optString("deviceType", "UNKNOWN_DEVICE")))
        val isPhone = isPhoneType(type)
        val host = raw.optString("host", raw.optString("lastIP")).trim()
        val now = System.currentTimeMillis()
        val updatedAt = raw.optLong("updatedAt", raw.optLong("lastSeen", now)).takeIf { it > 0L } ?: now
        return JSONObject(raw.toString())
            .put("id", id)
            .put("name", raw.optString("name", raw.optString("deviceName", id)).ifBlank { id })
            .put("type", type)
            .put("host", host)
            .put("port", raw.optInt("port", if (isPhone) LanDiscovery.NODE_RELAY_PORT else 19527))
            .put("pairingKey", raw.optString("pairingKey", raw.optString("pk")).trim())
            .put("enabled", raw.optBoolean("enabled", true))
            .put("revoked", raw.optBoolean("revoked", false))
            .put("routable", raw.optBoolean("routable", host.isNotBlank() && raw.optString("pairingKey", raw.optString("pk")).isNotBlank()))
            .put("seq", raw.optLong("seq", updatedAt))
            .put("updatedAt", updatedAt)
            .put("lastSeen", raw.optLong("lastSeen", updatedAt))
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
        val host = node.optString("host").trim()
        val pairingKey = node.optString("pairingKey").trim()
        if (id.isBlank() || host.isBlank() || pairingKey.isBlank()) return
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
            port = node.optInt("port", if (isPhoneType(type)) LanDiscovery.NODE_RELAY_PORT else 19527),
            pairingKey = pairingKey,
            name = node.optString("name", "Device $host").ifBlank { "Device $host" },
            deviceId = id,
            deviceType = type,
            routeUpdatedAt = node.optLong("updatedAt", 0L),
            altHosts = jsonArrayToList(node.optJSONArray("altHosts")) +
                listOfNotNull(node.optString("tsHost").takeIf { it.isNotBlank() }),
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

    private fun isNewer(incoming: JSONObject, existing: JSONObject?): Boolean {
        if (existing == null) return true
        return incoming.optLong("seq", incoming.optLong("updatedAt", 0L)) >
            existing.optLong("seq", existing.optLong("updatedAt", 0L))
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

    private fun isDeviceType(type: String): Boolean {
        val value = type.uppercase(Locale.ROOT)
        return value.contains("PHONE") || value.contains("DESKTOP")
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

    private fun loadArray(context: Context, key: String): JSONArray =
        runCatching { JSONArray(prefs(context).getString(key, "[]").orEmpty()) }
            .getOrElse { JSONArray() }

    private fun saveArray(context: Context, key: String, array: JSONArray) {
        prefs(context).edit().putString(key, array.toString()).apply()
    }

    private fun prefs(context: Context) = SecurePrefs.get(context, PREFS_NAME)
}
