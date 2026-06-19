package com.codesync.util

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Test

class ContentBusTest {

    @Test
    fun businessDedupeKeyIgnoresTransportSourceForSameBusinessMessage() {
        val directEnvelope = JSONObject()
            .put("busVersion", 1)
            .put("messageId", "clip-phone-a-1000")
            .put("networkId", "net-main")
            .put("topic", ContentBus.Topic.CLIPBOARD_TEXT)
            .put("sourceNodeId", "phone-a")
            .put("originNodeId", "phone-a")

        val relayedEnvelope = JSONObject()
            .put("busVersion", 1)
            .put("messageId", "clip-phone-a-1000")
            .put("networkId", "net-main")
            .put("topic", ContentBus.Topic.CLIPBOARD_TEXT)
            .put("sourceNodeId", "relay-b")
            .put("originNodeId", "phone-a")

        assertEquals(
            ContentBus.businessDedupeKey(directEnvelope),
            ContentBus.businessDedupeKey(relayedEnvelope)
        )
    }
}
