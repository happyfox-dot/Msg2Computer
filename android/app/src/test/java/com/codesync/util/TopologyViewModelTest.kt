package com.codesync.util

import android.content.Context
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

class TopologyViewModelTest {
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
    fun buildsTopologyFromRouteSnapshotAndDiscoveryNodes() {
        DeviceStore.upsertDevice(
            context = context,
            host = "192.0.2.10",
            port = 19527,
            pairingKey = "desktop-key",
            name = "Desktop B",
            deviceId = "desktop-b",
            deviceType = "WINDOWS_DESKTOP",
            networkId = "net-1",
            trustSourceId = "phone-a",
            trustLevel = "trusted_lan",
            acceptedAt = 1_000L,
            policyAllowSmsCodes = true,
            policyAllowNotifications = true,
            policyAllowClipboard = true
        )

        val model = TopologyViewModel.build(
            context = context,
            connectedDeviceIds = setOf("desktop-b"),
            discoveredLanNodes = listOf(
                LanDiscoveredDevice(
                    id = "phone-c",
                    name = "Phone C",
                    type = "ANDROID_PHONE",
                    host = "192.0.2.20",
                    port = 19529,
                    pairingKey = ""
                )
            )
        )

        assertEquals("phone-a", model.localNodeId)
        assertEquals("online", model.nodeMap.getValue("phone-a").status)
        assertEquals("online", model.nodeMap.getValue("desktop-b").status)
        assertEquals("discovered", model.nodeMap.getValue("phone-c").status)
        assertTrue(model.nodeMap.getValue("desktop-b").detailLines.any { it.contains("networkId：net-1") })
        assertTrue(model.nodeMap.getValue("desktop-b").detailLines.any { it.startsWith("允许内容：") })

        val trustedEdge = model.edges.firstOrNull { edge ->
            setOf(edge.from, edge.to) == setOf("phone-a", "desktop-b")
        }
        assertNotNull(trustedEdge)
        assertTrue(trustedEdge!!.active)
        assertTrue(trustedEdge.routable)

        val discoveryEdge = model.edges.firstOrNull { edge ->
            setOf(edge.from, edge.to) == setOf("phone-a", "phone-c")
        }
        assertNotNull(discoveryEdge)
        assertEquals("discovery", discoveryEdge!!.kind)
        assertTrue(!discoveryEdge.routable)
    }
}
