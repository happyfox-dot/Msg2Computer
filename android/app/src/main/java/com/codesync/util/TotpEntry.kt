package com.codesync.util

import org.json.JSONObject

/**
 * TOTP 条目数据类
 * 包含完整的 TOTP 参数，支持 JSON 序列化
 */
data class TotpEntry(
    val label: String,
    val secret: String,
    val issuer: String = "",
    val accountName: String = "",
    val algorithm: String = "SHA1",
    val digits: Int = 6,
    val period: Int = 30
) {
    fun toJson(): String {
        val json = JSONObject()
        json.put("label", label)
        json.put("secret", secret)
        json.put("issuer", issuer)
        json.put("accountName", accountName)
        json.put("algorithm", algorithm)
        json.put("digits", digits)
        json.put("period", period)
        return json.toString()
    }

    companion object {
        fun fromJson(jsonStr: String): TotpEntry? {
            return try {
                val json = JSONObject(jsonStr)
                TotpEntry(
                    label = json.getString("label"),
                    secret = json.getString("secret"),
                    issuer = json.optString("issuer", ""),
                    accountName = json.optString("accountName", ""),
                    algorithm = json.optString("algorithm", "SHA1"),
                    digits = json.optInt("digits", 6),
                    period = json.optInt("period", 30)
                )
            } catch (e: Exception) {
                null
            }
        }

        /**
         * 从旧格式 "label|secret" 迁移
         */
        fun fromLegacyString(str: String): TotpEntry? {
            val parts = str.split("|")
            return if (parts.size == 2) {
                TotpEntry(label = parts[0], secret = parts[1])
            } else {
                null
            }
        }
    }
}
