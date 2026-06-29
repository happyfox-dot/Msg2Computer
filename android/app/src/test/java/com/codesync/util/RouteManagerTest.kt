package com.codesync.util

import android.content.Context
import com.codesync.service.WebSocketService
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.After
import org.junit.Before
import org.junit.Test

class RouteManagerTest {
    private lateinit var context: InMemoryContext

    @Before
    fun setUp() {
        context = InMemoryContext()
        SecurePrefs.setTestProviderForTests { ctx, name ->
            ctx.getSharedPreferences(name, Context.MODE_PRIVATE)
        }
        context.getSharedPreferences("phone_identity", Context.MODE_PRIVATE)
            .edit()
            .putString("phone_id", "phone-a")
            .putString("phone_name", "Phone A")
            .putString("pairing_key", "phone-key")
            .apply()
        context.getSharedPreferences("lan_trust", Context.MODE_PRIVATE)
            .edit()
            .putString("network_id", "net-1")
            .apply()
    }

    @After
    fun tearDown() {
        SecurePrefs.setTestProviderForTests(null)
    }

    @Test
    fun computesSpfNextHopFromLsdbLinks() {
        val nodes = JSONArray()
            .put(node("phone-a", "Phone A", "ANDROID_PHONE"))
            .put(node("desktop-b", "Desktop B", "WINDOWS_DESKTOP"))
            .put(node("phone-c", "Phone C", "ANDROID_PHONE"))
        val links = JSONArray()
            .put(link("phone-a", "desktop-b", "routing_adjacency", active = true))
            .put(link("desktop-b", "phone-c", "relay_route", active = true))

        val routes = RouteManager.computeRoutes(
            sourceId = "phone-a",
            nodes = nodes,
            links = links,
            networkId = "net-1",
            now = 1_000L
        )
        val routeToC = routes.first { it.destinationId == "phone-c" }

        assertEquals("desktop-b", routeToC.nextHopId)
        assertEquals(listOf("phone-a", "desktop-b", "phone-c"), routeToC.path)
        assertEquals(15, routeToC.metric)
        assertTrue(routeToC.active)
    }

    @Test
    fun ignoresDisplayOnlyOrForeignLinksForRouting() {
        val nodes = JSONArray()
            .put(node("phone-a", "Phone A", "ANDROID_PHONE"))
            .put(node("desktop-b", "Desktop B", "WINDOWS_DESKTOP"))
            .put(node("phone-c", "Phone C", "ANDROID_PHONE"))
            .put(node("phone-d", "Phone D", "ANDROID_PHONE", networkId = "other-net"))
        val links = JSONArray()
            .put(link("phone-a", "desktop-b", "lan_discovery", routable = false))
            .put(link("desktop-b", "phone-c", "relay_route", active = true))
            .put(link("phone-a", "phone-d", "relay_route", active = true))

        val routes = RouteManager.computeRoutes(
            sourceId = "phone-a",
            nodes = nodes,
            links = links,
            networkId = "net-1",
            now = 1_000L
        )

        assertTrue(routes.none { it.destinationId == "desktop-b" })
        assertTrue(routes.none { it.destinationId == "phone-c" })
        assertTrue(routes.none { it.destinationId == "phone-d" })
    }

    @Test
    fun snapshotForDeviceDistinguishesOnlineReachableAndKnown() {
        val now = 1_000_000L
        val online = trustedDevice(connectionUpdatedAt = now - 1_000L)
        val reachable = trustedDevice(
            id = "node-c",
            host = "192.0.2.30",
            lastSyncAt = now - 20_000L
        )
        val known = trustedDevice(
            id = "node-d",
            host = "192.0.2.40",
            lastSyncAt = now - 10 * 60 * 1000L
        )

        assertEquals(
            "online",
            RouteManager.snapshotForDevice(online, connectedDeviceIds = setOf("node-b"), now = now).status
        )
        assertEquals(
            "reachable",
            RouteManager.snapshotForDevice(reachable, connectedDeviceIds = emptySet(), now = now).status
        )
        val knownSnapshot = RouteManager.snapshotForDevice(known, connectedDeviceIds = emptySet(), now = now)
        assertEquals("known", knownSnapshot.status)
        assertFalse(knownSnapshot.sendable)
    }

    @Test
    fun targetsForTypeCanExposeUnavailableNodesForUiButNotForSenders() {
        SettingsStore.setSendAllSmsEnabled(context, true)
        DeviceStore.upsertDevice(
            context = context,
            host = "192.0.2.10",
            port = 19529,
            pairingKey = "desktop-key",
            name = "Desktop B",
            deviceId = "desktop-b",
            deviceType = "WINDOWS_DESKTOP",
            networkId = "net-1",
            policyAllowSmsCodes = true
        )
        DeviceStore.upsertDevice(
            context = context,
            host = "192.0.2.20",
            port = 19529,
            pairingKey = "desktop-key-2",
            name = "Desktop C",
            deviceId = "desktop-c",
            deviceType = "WINDOWS_DESKTOP",
            networkId = "net-1",
            policyAllowSmsCodes = false
        )
        DeviceStore.markDeviceSynced(context, "desktop-b", System.currentTimeMillis())
        DeviceStore.setDeviceEnabled(context, "desktop-c", false)

        val senderTargets = RouteManager.targetsForType(
            context = context,
            type = "sms",
            connectedDeviceIds = emptySet()
        )
        val uiTargets = RouteManager.targetsForType(
            context = context,
            type = "sms",
            connectedDeviceIds = emptySet(),
            includeDisallowed = true,
            includeUnavailable = true,
            reachableOnly = false
        )

        assertEquals(listOf("desktop-b"), senderTargets.map { it.device.id })
        assertTrue(uiTargets.any { it.device.id == "desktop-b" && it.status == "reachable" && it.allowed })
        assertTrue(uiTargets.any { it.device.id == "desktop-c" && it.status == "disabled" && !it.allowed })
    }

    @Test
    fun deferredMessagesCanTargetKnownTrustedNodes() {
        DeviceStore.upsertDevice(
            context = context,
            host = "192.0.2.50",
            port = 19529,
            pairingKey = "desktop-key",
            name = "Desktop Known",
            deviceId = "desktop-known",
            deviceType = "WINDOWS_DESKTOP",
            networkId = "net-1",
            policyAllowSmsCodes = true
        )

        val targets = RouteManager.targetsForType(
            context = context,
            type = "sms",
            connectedDeviceIds = emptySet(),
            reachableOnly = false
        )

        assertEquals(listOf("desktop-known"), targets.map { it.device.id })
        assertEquals("known", targets.single().status)
        assertTrue(targets.single().allowed)
    }

    @Test
    fun phoneToDesktopSyncSimulationAllowsDeferredInfoButKeepsFilesLiveOnly() {
        SettingsStore.setSyncClipboardEnabled(context, true)
        SettingsStore.setSyncClipboardImageEnabled(context, true)
        SettingsStore.setSyncClipboardFileEnabled(context, true)

        DeviceStore.upsertDevice(
            context = context,
            host = "192.0.2.60",
            port = 19529,
            pairingKey = "desktop-key",
            name = "Desktop Sync Target",
            deviceId = "desktop-sync",
            deviceType = "WINDOWS_DESKTOP",
            networkId = "net-1",
            policyAllowSmsCodes = true,
            policyAllowSmsMessages = true,
            policyAllowNotifications = true,
            policyAllowTotp = true,
            policyAllowClipboard = true,
            policyAllowClipboardImage = true,
            policyAllowClipboardFile = true,
            policyAllowFileTransfer = true
        )
        DeviceStore.markDeviceSynced(
            context = context,
            id = "desktop-sync",
            timestamp = System.currentTimeMillis() - RouteManager.RECENT_REACHABLE_MS - 10_000L
        )

        val deferredTypes = listOf(
            "sms",
            "sms_message",
            "app_notification",
            "clipboard_text",
            "clipboard_image",
            "totp_seed"
        )
        deferredTypes.forEach { type ->
            val targets = RouteManager.targetsForType(
                context = context,
                type = type,
                connectedDeviceIds = emptySet(),
                reachableOnly = WebSocketService.requiresLiveDeliveryTarget(type)
            )

            assertEquals(
                "$type should still target known trusted desktop nodes",
                listOf("desktop-sync"),
                targets.map { it.device.id }
            )
            assertEquals("known", targets.single().status)
            assertFalse(targets.single().reachable)
            assertTrue(targets.single().allowed)
        }

        val liveOnlyTypes = listOf("file_transfer", "clipboard_file")
        liveOnlyTypes.forEach { type ->
            val offlineTargets = RouteManager.targetsForType(
                context = context,
                type = type,
                connectedDeviceIds = emptySet(),
                reachableOnly = WebSocketService.requiresLiveDeliveryTarget(type)
            )

            assertTrue("$type should wait until the desktop node is reachable", offlineTargets.isEmpty())

            val onlineTargets = RouteManager.targetsForType(
                context = context,
                type = type,
                connectedDeviceIds = setOf("desktop-sync"),
                reachableOnly = WebSocketService.requiresLiveDeliveryTarget(type)
            )

            assertEquals(listOf("desktop-sync"), onlineTargets.map { it.device.id })
            assertEquals("online", onlineTargets.single().status)
            assertTrue(onlineTargets.single().reachable)
        }
    }

    @Test
    fun discoverySnapshotUsesKnownStatusWithDiscoveryMarker() {
        val snapshot = RouteManager.snapshotForDiscoveryNode(hasAddress = true, now = 1_000L)

        assertEquals("known", snapshot.status)
        assertTrue(snapshot.discoveredOnly)
        assertFalse(snapshot.sendable)
    }

    private fun node(
        id: String,
        name: String,
        type: String,
        networkId: String = "net-1",
        pairingKey: String = "pair-key"
    ): JSONObject =
        JSONObject()
            .put("id", id)
            .put("name", name)
            .put("type", type)
            .put("networkId", networkId)
            .put("pairingKey", pairingKey)
            .put("enabled", true)
            .put("routable", true)

    private fun link(
        from: String,
        to: String,
        type: String,
        routable: Boolean = true,
        active: Boolean = false
    ): JSONObject =
        JSONObject()
            .put("id", "$from->$to:$type")
            .put("from", from)
            .put("to", to)
            .put("type", type)
            .put("enabled", true)
            .put("routable", routable)
            .put("active", active)
            .put("updatedAt", 1_000L)

    private fun trustedDevice(
        id: String = "node-b",
        host: String = "192.0.2.10",
        lastSyncAt: Long = 0L,
        connectionUpdatedAt: Long = 0L
    ): DesktopDevice =
        DesktopDevice(
            id = id,
            name = id,
            type = "WINDOWS_DESKTOP",
            host = host,
            port = 19529,
            pairingKey = "pair-key",
            enabled = true,
            lastSyncAt = lastSyncAt,
            connectionUpdatedAt = connectionUpdatedAt,
            updatedAt = 0L,
            routeMetric = 0,
            routeNextHopId = "",
            routeNextHopName = "",
            routePath = emptyList(),
            routeUpdatedAt = 0L
        )
}
