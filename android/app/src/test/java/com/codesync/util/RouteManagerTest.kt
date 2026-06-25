package com.codesync.util

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class RouteManagerTest {
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
}
