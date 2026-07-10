package com.codesync.util

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Collections
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

class BusReliabilityStoreTest {
    @Test
    fun rememberInboundIsAtomicUnderConcurrentDelivery() {
        val context = InMemoryContext()
        SecurePrefs.setTestProviderForTests { ctx, name ->
            ctx.getSharedPreferences(name, android.content.Context.MODE_PRIVATE)
        }
        val envelope = JSONObject()
            .put("busVersion", 1)
            .put("messageId", "msg-1")
            .put("networkId", "net-a")
            .put("topic", "clipboard.image")
            .put("sourceNodeId", "node-a")
            .put("originNodeId", "node-a")

        val workers = 32
        val start = CountDownLatch(1)
        val pool = Executors.newFixedThreadPool(workers)
        val accepted = Collections.synchronizedList(mutableListOf<Boolean>())

        try {
            repeat(workers) {
                pool.execute {
                    start.await()
                    accepted.add(BusReliabilityStore.rememberInbound(context, envelope))
                }
            }

            start.countDown()
            pool.shutdown()

            assertTrue(pool.awaitTermination(5, TimeUnit.SECONDS))
            assertEquals(1, accepted.count { it })
            assertEquals(workers - 1, accepted.count { !it })
        } finally {
            SecurePrefs.setTestProviderForTests(null)
            pool.shutdownNow()
        }
    }

    @Test
    fun maintenanceScanPrunesExpiredVerificationCodeOutboxRecords() {
        val context = InMemoryContext()
        val preferences = context.getSharedPreferences("bus_reliability", 0)
        SecurePrefs.setTestProviderForTests { _, _ -> preferences }
        try {
            val envelope = JSONObject()
                .put("busVersion", 1)
                .put("messageId", "expired-code")
                .put("networkId", "net-a")
                .put("topic", ContentBus.Topic.SMS_CODE)
                .put("expiresAt", 1L)
                .put("payload", JSONObject().put("type", "sms").put("expiresAt", 1L))
            val record = JSONObject()
                .put("messageId", "expired-code")
                .put("targetNodeId", "desktop-a")
                .put("status", "pending")
                .put("createdAt", 1L)
                .put("updatedAt", 1L)
                .put("nextAttemptAt", 0L)
                .put("envelope", envelope)
            preferences.edit()
                .putString("outbox", JSONObject().put("expired-code|desktop-a", record).toString())
                .commit()

            assertTrue(BusReliabilityStore.dueOutbound(context).isEmpty())
            assertEquals(0, JSONObject(preferences.getString("outbox", "{}")!!).length())

            BusReliabilityStore.rememberOutbound(context, envelope, "desktop-a")
            assertTrue(BusReliabilityStore.dueOutbound(context).isEmpty())
        } finally {
            SecurePrefs.setTestProviderForTests(null)
        }
    }
}
