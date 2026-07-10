package com.codesync.util

import org.junit.After
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

class SmsForwardDedupStoreTest {

    @Before
    @After
    fun reset() {
        SmsForwardDedupStore.clearForTests()
    }

    @Test
    fun suppressesOnlyRecentMatchingMessage() {
        assertTrue(SmsForwardDedupStore.shouldForwardAt("bank", "code 123456", "sms", 1_000L))
        assertFalse(SmsForwardDedupStore.shouldForwardAt("bank", "code 123456", "sms", 1_100L))
        assertTrue(SmsForwardDedupStore.shouldForwardAt("bank", "code 123456", "sms", 121_000L))
    }

    @Test
    fun senderAndContentTypeRemainPartOfIdentity() {
        assertTrue(SmsForwardDedupStore.shouldForwardAt("bank-a", "same", "sms", 1_000L))
        assertTrue(SmsForwardDedupStore.shouldForwardAt("bank-b", "same", "sms", 1_001L))
        assertTrue(SmsForwardDedupStore.shouldForwardAt("bank-a", "same", "sms_message", 1_002L))
    }
}
