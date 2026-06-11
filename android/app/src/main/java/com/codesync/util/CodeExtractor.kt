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

        // 第一优先级：带上下文关键词（验证码/code/OTP 等）的专用模式。
        // 这些模式的捕获组就是关键词之后的那串数字，命中即为高置信验证码。
        // 关键：按「模式优先级」选，而不是按出现位置——验证码常在提示词之后，
        // 旧实现用 matcher.start() 排序会让句首无关数字（金额、订单号）压过真正的码。
        // 同一优先级内若一条模式命中多处，取最靠前的。
        for (pattern in CODE_PATTERNS) {
            val matcher = pattern.matcher(cleaned)
            while (matcher.find()) {
                val code = matcher.group(1) ?: continue
                if (isLikelyCode(code) && !isNoise(cleaned, code)) {
                    return code
                }
            }
        }

        // 第二优先级（兜底）：无任何上下文关键词命中时，才退回裸数字串匹配。
        // 仅在「整条短信内有且仅有一个候选数字」时采用，避免在多段数字
        // （金额 + 验证码、订单号 + 验证码）里误选。
        val fallbackCandidates = mutableListOf<String>()
        val combinedMatcher = Pattern.compile("""(\d{4,8})""").matcher(cleaned)
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
