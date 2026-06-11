package com.codesync.util

import org.json.JSONObject
import java.security.MessageDigest

/**
 * TOTP 条目数据类
 * 包含完整的 TOTP 参数，支持 JSON 序列化
 */
data class TotpEntry(
    val id: String = "",
    val label: String,
    val secret: String,
    val issuer: String = "",
    val accountName: String = "",
    val algorithm: String = "SHA1",
    val digits: Int = 6,
    val period: Int = 30,
    // 来源信息（Phase 2）：标注该条目由哪台设备创建，用于多设备流转时的来源展示与权限控制。
    // 注意：这些字段不参与 stableId 计算，新增字段不会改变已存条目的 id。
    val sourceDeviceId: String = "",
    val sourceDeviceName: String = "",
    val sourceDeviceType: String = "ANDROID_PHONE",
    val isLocal: Boolean = true,
    val pinnedAt: Long = 0L
) {
    fun toJson(): String {
        val normalized = withStableId()
        val json = JSONObject()
        json.put("id", normalized.id)
        json.put("label", normalized.label)
        json.put("secret", normalized.secret)
        json.put("issuer", normalized.issuer)
        json.put("accountName", normalized.accountName)
        json.put("algorithm", normalized.algorithm)
        json.put("digits", normalized.digits)
        json.put("period", normalized.period)
        json.put("sourceDeviceId", normalized.sourceDeviceId)
        json.put("sourceDeviceName", normalized.sourceDeviceName)
        json.put("sourceDeviceType", normalized.sourceDeviceType)
        json.put("isLocal", normalized.isLocal)
        json.put("pinnedAt", normalized.pinnedAt)
        return json.toString()
    }

    fun withStableId(): TotpEntry {
        return if (id.isNotBlank()) this else copy(id = stableId(label, secret, issuer, accountName, algorithm, digits, period))
    }

    companion object {
        fun fromJson(jsonStr: String): TotpEntry? {
            return try {
                val json = JSONObject(jsonStr)
                TotpEntry(
                    id = json.optString("id", ""),
                    label = json.getString("label"),
                    secret = json.getString("secret"),
                    issuer = json.optString("issuer", ""),
                    accountName = json.optString("accountName", ""),
                    algorithm = json.optString("algorithm", "SHA1"),
                    digits = json.optInt("digits", 6),
                    period = json.optInt("period", 30),
                    sourceDeviceId = json.optString("sourceDeviceId", ""),
                    sourceDeviceName = json.optString("sourceDeviceName", ""),
                    sourceDeviceType = json.optString("sourceDeviceType", "ANDROID_PHONE"),
                    // 旧数据没有该字段：默认视为本机创建（true）
                    isLocal = json.optBoolean("isLocal", true),
                    pinnedAt = json.optLong("pinnedAt", 0L)
                ).withStableId()
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
                TotpEntry(label = parts[0], secret = parts[1]).withStableId()
            } else {
                null
            }
        }

        fun stableId(
            label: String,
            secret: String,
            issuer: String,
            accountName: String,
            algorithm: String,
            digits: Int,
            period: Int
        ): String {
            val raw = listOf(secret, issuer, accountName, label, algorithm, digits.toString(), period.toString())
                .joinToString("|")
            val digest = MessageDigest.getInstance("SHA-256")
                .digest(raw.toByteArray(Charsets.UTF_8))
                .joinToString("") { "%02x".format(it) }
                .take(20)
            return "totp-$digest"
        }
    }
}
