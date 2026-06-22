package com.codesync.util

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ClipboardSyncStateTest {
    @Test
    fun globalClipboardVersionRejectsOlderCrossTypePayload() {
        val context = InMemoryContext()

        ClipboardSyncState.rememberHash(
            context = context,
            ts = 2000L,
            origin = "desktop-a",
            hash = "text-hash",
            kind = "text"
        )

        assertFalse(ClipboardSyncState.isNewer(context, 1500L, "phone-b"))
        assertEquals("text", ClipboardSyncState.appliedKind(context))
        assertEquals("text-hash", ClipboardSyncState.appliedHash(context))
    }

    @Test
    fun globalClipboardVersionUsesOriginTieBreaker() {
        val context = InMemoryContext()
        ClipboardSyncState.rememberHash(context, 2000L, "node-b", "hash-b", "image")

        assertFalse(ClipboardSyncState.isNewer(context, 2000L, "node-a"))
        assertTrue(ClipboardSyncState.isNewer(context, 2000L, "node-c"))
    }
}
