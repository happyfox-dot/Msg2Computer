package com.codesync.util

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class CodeExtractorTest {

    @Test
    fun extractsCodeWithEnglishContext() {
        assertEquals("839201", CodeExtractor.extract("Your code: 839201. Do not share it."))
        assertEquals("839201", CodeExtractor.extract("OTP code: 839201"))
        assertEquals("A7B9C2", CodeExtractor.extract("OTP A7B9C2 for login"))
        assertEquals("9XZ20A", CodeExtractor.extract("Your verification code is 9XZ20A"))
    }

    @Test
    fun doesNotExtractEnglishPromptWords() {
        assertNull(CodeExtractor.extract("Your OTP expires in 10 minutes"))
        assertNull(CodeExtractor.extract("OTP code expires soon"))
    }

    @Test
    fun extractsOnlySingleFallbackCandidate() {
        assertEquals("482913", CodeExtractor.extract("482913"))
        assertNull(CodeExtractor.extract("Order 12345, login 482913"))
    }

    @Test
    fun rejectsCommonNoiseAndAcceptsRepeatedDigitCodes() {
        assertNull(CodeExtractor.extract("The date is 2026-06-17 and time is 10:12"))
        assertEquals("111111", CodeExtractor.extract("Your code is 111111"))
        assertEquals("000000", CodeExtractor.extract("验证码：000000"))
        assertNull(CodeExtractor.extract("This is a very long message ".repeat(40) + "code: 482913"))
    }
}
