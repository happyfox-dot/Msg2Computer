package com.codesync.util

import java.util.regex.Pattern

object CodeExtractor {

    /**
     * Context patterns deliberately capture a token that contains at least one digit.
     * Requiring a digit still supports the usual mixed alpha-numeric codes while avoiding
     * English prose such as "OTP code" -> "code" and "OTP expires" -> "expires".
     */
    private val CODE_PATTERNS = listOf(
        Pattern.compile(
            """(?:验证码|校验码|动态码|登录码|安全码|确认码|短信码|一次性密码)\s*(?:是|为|[：:\-])?\s*([A-Za-z0-9]{4,8})(?![A-Za-z0-9])""",
            Pattern.CASE_INSENSITIVE
        ),
        Pattern.compile(
            """(?:verification|security|auth(?:entication)?)\s*(?:code|pin)\s*(?:is|[：:\-])?\s*([A-Za-z0-9]{4,8})(?![A-Za-z0-9])""",
            Pattern.CASE_INSENSITIVE
        ),
        Pattern.compile(
            """(?:OTP|PIN|code)\s*(?:code)?\s*(?:is|[：:\-])?\s*([A-Za-z0-9]{4,8})(?![A-Za-z0-9])""",
            Pattern.CASE_INSENSITIVE
        ),
        Pattern.compile("""([A-Za-z0-9]{4,8})\s*(?:是|为).*?(?:验证码|校验码|动态码)""", Pattern.CASE_INSENSITIVE),
        Pattern.compile("""【.{2,8}】\s*([A-Za-z0-9]{4,8})(?![A-Za-z0-9])"""),
        Pattern.compile("""[\[\(]([A-Za-z0-9]{4,8})[\]\)]"""),
        Pattern.compile("""^\s*([A-Za-z0-9]{4,8})\s*$"""),
    )

    private val NOISE_PATTERNS = listOf(
        Pattern.compile("""\d{4}-\d{2}-\d{2}"""),
        Pattern.compile("""\d{2}:\d{2}"""),
        Pattern.compile("""\d{11,}"""),
        Pattern.compile("""\d{4}\s*\d{4}\s*\d{4}\s*\d{4}"""),
        Pattern.compile("""\d+\.\d+"""),
    )

    fun extract(text: String): String? {
        if (text.isBlank()) return null

        val cleaned = text.trim()
        if (cleaned.length > 500) return null

        for (pattern in CODE_PATTERNS) {
            val matcher = pattern.matcher(cleaned)
            while (matcher.find()) {
                val code = matcher.group(1) ?: continue
                if (isLikelyCode(code) && !isNoise(cleaned, code)) return code
            }
        }

        // Without a code-related context, accept only one unambiguous numeric candidate.
        val fallbackCandidates = mutableListOf<String>()
        val combinedMatcher = Pattern.compile("""(?<!\d)(\d{4,8})(?!\d)""").matcher(cleaned)
        while (combinedMatcher.find()) {
            val code = combinedMatcher.group(1) ?: continue
            if (isLikelyCode(code) && !isNoise(cleaned, code) && code !in fallbackCandidates) {
                fallbackCandidates.add(code)
            }
        }
        return fallbackCandidates.singleOrNull()
    }

    private fun isLikelyCode(code: String): Boolean {
        if (code.length !in 4..8) return false
        // Pure words are much more likely to be surrounding prose. Repeated digits (000000,
        // 111111, etc.) are valid OTP values and must not be discarded.
        return code.any(Char::isDigit)
    }

    private fun isNoise(text: String, code: String): Boolean {
        for (pattern in NOISE_PATTERNS) {
            val matcher = pattern.matcher(text)
            while (matcher.find()) {
                if (matcher.group().contains(code)) return true
            }
        }
        return false
    }
}
