package com.codesync.util

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class CodeExtractorTest {

    @Test
    fun extractsCodeWithEnglishContext() {
        assertEquals("839201", CodeExtractor.extract("Your code: 839201. Do not share it."))
        assertEquals("A7B9C2", CodeExtractor.extract("OTP A7B9C2 for login"))
    }

    @Test
    fun extractsOnlySingleFallbackCandidate() {
        assertEquals("482913", CodeExtractor.extract("482913"))
        assertNull(CodeExtractor.extract("Order 12345, login 482913"))
    }

    @Test
    fun rejectsCommonNoiseAndWeakCodes() {
        assertNull(CodeExtractor.extract("The date is 2026-06-17 and time is 10:12"))
        assertNull(CodeExtractor.extract("Your code is 111111"))
        assertNull(CodeExtractor.extract("This is a very long message ".repeat(40) + "code: 482913"))
    }
}
