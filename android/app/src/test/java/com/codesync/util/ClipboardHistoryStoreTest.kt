package com.codesync.util

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

class ClipboardHistoryStoreTest {
    @Test
    fun historyUsesSecurePrefsInsteadOfLegacyPlaintextStore() {
        val context = InMemoryContext()
        SecurePrefs.setTestProviderForTests { ctx, name ->
            ctx.getSharedPreferences("encrypted_$name", 0)
        }
        try {
            ClipboardHistoryStore.addText(
                context = context,
                text = "sensitive clipboard value",
                direction = "incoming",
                sourceDeviceId = "node-a",
                sourceDeviceName = "Node A",
                createdAt = 100L
            )

            assertTrue(context.getSharedPreferences("clipboard_history", 0).all.isEmpty())
            assertFalse(context.getSharedPreferences("encrypted_clipboard_history", 0).all.isEmpty())
            assertEquals("sensitive clipboard value", ClipboardHistoryStore.get(context).single().text)
        } finally {
            SecurePrefs.setTestProviderForTests(null)
        }
    }

    @Test
    fun concurrentAddsAreAtomicAndRespectHistoryLimit() {
        val context = InMemoryContext()
        SecurePrefs.setTestProviderForTests { ctx, name ->
            ctx.getSharedPreferences("encrypted_$name", 0)
        }
        try {
            val pool = Executors.newFixedThreadPool(8)
            repeat(80) { index ->
                pool.execute {
                    ClipboardHistoryStore.addText(
                        context = context,
                        text = "clipboard-$index",
                        direction = "incoming",
                        sourceDeviceId = "node-$index",
                        sourceDeviceName = "Node $index",
                        createdAt = index.toLong() + 1L
                    )
                }
            }
            pool.shutdown()

            assertTrue(pool.awaitTermination(5, TimeUnit.SECONDS))
            val history = ClipboardHistoryStore.get(context)
            assertEquals(50, history.size)
            assertEquals(50, history.map { it.contentKey }.toSet().size)
        } finally {
            SecurePrefs.setTestProviderForTests(null)
        }
    }
}
