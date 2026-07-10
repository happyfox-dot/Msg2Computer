package com.codesync.service

import org.junit.Assert.assertEquals
import org.junit.Test

class WebSocketServiceHelpersTest {

    @Test
    fun clipboardTimestampRemainsMonotonicWhenWallClockMovesBackwards() {
        assertEquals(5_001L, nextClipboardTimestamp(now = 4_000L, appliedTs = 5_000L))
        assertEquals(6_000L, nextClipboardTimestamp(now = 6_000L, appliedTs = 5_000L))
    }

    @Test
    fun everyFileInEncodedClipboardBatchUsesSameCaptureTimestamp() {
        val batchId = "clip-files-1720000123456-550e8400-e29b-41d4-a716-446655440000"
        assertEquals(1_720_000_123_456L, clipboardBatchTimestamp(batchId))
        assertEquals(0L, clipboardBatchTimestamp("batch-legacy"))
    }
}
