package com.codesync.util

import java.util.regex.Pattern

object CodeExtractor {

    private val CODE_PATTERNS = listOf(
        Pattern.compile("""(?:验证码|校验码|动态码|登录码|安全码|确认码|短信码|一次性密码|OTP)[^\p{Alnum}]{0,10}([A-Za-z0-9]{4,8})""", Pattern.CASE_INSENSITIVE),
        Pattern.compile("""验证码[：:]\s*(\d{4,8})"""),
        Pattern.compile("""验证码是\s*(\d{4,8})"""),
        Pattern.compile("""code[：:]\s*(\d{4,8})""", Pattern.CASE_INSENSITIVE),
        Pattern.compile("""(?:code|otp|pin)[^\p{Alnum}]{0,10}([A-Za-z0-9]{4,8})""", Pattern.CASE_INSENSITIVE),
        Pattern.compile("""(?:verification|verify|auth)\s*code[：:]\s*(\d{4,8})""", Pattern.CASE_INSENSITIVE),
        Pattern.compile("""(?:verification|verify|auth)\s*code[^\p{Alnum}]{0,10}([A-Za-z0-9]{4,8})""", Pattern.CASE_INSENSITIVE),
        Pattern.compile("""(\d{4,8})\s*(?:是|为).*验证码"""),
        Pattern.compile("""【.{2,8}】\s*(\d{4,8})"""),
        Pattern.compile("""(\d{6})\b"""),
        Pattern.compile("""(\d{4})\b"""),
        Pattern.compile("""[\[\(](\d{4,8})[\]\)]"""),
        Pattern.compile("""^\s*(\d{4,8})\s*$"""),
        Pattern.compile("""您的.*码[：:]?\s*(\d{4,8})"""),
        Pattern.compile("""动态码[：:]?\s*(\d{4,8})"""),
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

        val results = mutableListOf<Pair<String, Int>>()

        for (pattern in CODE_PATTERNS) {
            val matcher = pattern.matcher(cleaned)
            if (matcher.find()) {
                val code = matcher.group(1) ?: continue
                if (isLikelyCode(code) && !isNoise(cleaned, code)) {
                    results.add(code to matcher.start())
                }
            }
        }

        val combinedPattern = Pattern.compile("""(\d{4,8})""")
        val combinedMatcher = combinedPattern.matcher(cleaned)
        while (combinedMatcher.find()) {
            val code = combinedMatcher.group(1)
            if (isLikelyCode(code) && !isNoise(cleaned, code)
                && results.none { it.first == code }) {
                results.add(code to combinedMatcher.start())
            }
        }

        if (results.isEmpty()) return null

        results.sortBy { it.second }
        return results.first().first
    }

    private fun isLikelyCode(code: String): Boolean {
        if (code.length !in 4..8) return false
        if (code.all { it == code[0] }) return false
        if (code == "123456" || code == "000000" || code == "111111") return false
        return true
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
