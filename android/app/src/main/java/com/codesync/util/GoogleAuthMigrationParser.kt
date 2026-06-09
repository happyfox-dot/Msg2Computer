package com.codesync.util

import android.util.Base64
import java.nio.ByteBuffer

/**
 * Google Authenticator 迁移协议解析器
 *
 * 支持解析 otpauth-migration://offline?data=... 格式的批量导出二维码
 */
object GoogleAuthMigrationParser {

    /**
     * 解析 Google Authenticator 迁移 URI
     * @param uri 完整的 otpauth-migration:// URI
     * @return 解析出的 TOTP 账号列表
     */
    fun parse(uri: String): List<MigrationOtpAccount>? {
        if (!uri.startsWith("otpauth-migration://", ignoreCase = true)) {
            return null
        }

        return try {
            // 提取 data 参数
            val dataParam = extractDataParam(uri) ?: return null

            // Base64 解码
            val decodedData = Base64.decode(dataParam, Base64.DEFAULT)

            // 解析 Protobuf
            parseMigrationPayload(decodedData)
        } catch (e: Exception) {
            null
        }
    }

    /**
     * 从 URI 中提取 data 参数
     */
    private fun extractDataParam(uri: String): String? {
        val dataPrefix = "data="
        val startIndex = uri.indexOf(dataPrefix)
        if (startIndex == -1) return null

        val dataStart = startIndex + dataPrefix.length
        val endIndex = uri.indexOf('&', dataStart)

        return if (endIndex == -1) {
            uri.substring(dataStart)
        } else {
            uri.substring(dataStart, endIndex)
        }
    }

    /**
     * 解析 MigrationPayload protobuf 消息
     */
    private fun parseMigrationPayload(data: ByteArray): List<MigrationOtpAccount> {
        val buffer = ByteBuffer.wrap(data)
        val accounts = mutableListOf<MigrationOtpAccount>()

        while (buffer.hasRemaining()) {
            val tag = readVarint(buffer)
            val fieldNumber = tag shr 3
            val wireType = tag and 0x7

            when (fieldNumber) {
                1 -> { // otp_parameters (repeated)
                    if (wireType == 2) { // Length-delimited
                        val length = readVarint(buffer)
                        val paramData = ByteArray(length)
                        buffer.get(paramData)
                        parseOtpParameters(paramData)?.let { accounts.add(it) }
                    }
                }
                2, 3, 4, 5 -> { // version, batch_size, batch_index, batch_id
                    // 跳过这些字段
                    skipField(buffer, wireType)
                }
                else -> {
                    // 未知字段，跳过
                    skipField(buffer, wireType)
                }
            }
        }

        return accounts
    }

    /**
     * 解析单个 OtpParameters
     */
    private fun parseOtpParameters(data: ByteArray): MigrationOtpAccount? {
        val buffer = ByteBuffer.wrap(data)
        var secret: ByteArray? = null
        var name: String? = null
        var issuer: String? = null
        var algorithm = OtpAlgorithm.SHA1
        var digits = OtpDigits.SIX
        var type = OtpType.TOTP

        while (buffer.hasRemaining()) {
            val tag = readVarint(buffer)
            val fieldNumber = tag shr 3
            val wireType = tag and 0x7

            when (fieldNumber) {
                1 -> { // secret
                    if (wireType == 2) {
                        val length = readVarint(buffer)
                        secret = ByteArray(length)
                        buffer.get(secret)
                    }
                }
                2 -> { // name
                    if (wireType == 2) {
                        val length = readVarint(buffer)
                        val bytes = ByteArray(length)
                        buffer.get(bytes)
                        name = String(bytes, Charsets.UTF_8)
                    }
                }
                3 -> { // issuer
                    if (wireType == 2) {
                        val length = readVarint(buffer)
                        val bytes = ByteArray(length)
                        buffer.get(bytes)
                        issuer = String(bytes, Charsets.UTF_8)
                    }
                }
                4 -> { // algorithm
                    if (wireType == 0) {
                        val value = readVarint(buffer)
                        algorithm = when (value) {
                            1 -> OtpAlgorithm.SHA1
                            2 -> OtpAlgorithm.SHA256
                            3 -> OtpAlgorithm.SHA512
                            else -> OtpAlgorithm.SHA1
                        }
                    }
                }
                5 -> { // digits
                    if (wireType == 0) {
                        val value = readVarint(buffer)
                        digits = when (value) {
                            1 -> OtpDigits.SIX
                            2 -> OtpDigits.EIGHT
                            else -> OtpDigits.SIX
                        }
                    }
                }
                6 -> { // type
                    if (wireType == 0) {
                        val value = readVarint(buffer)
                        type = when (value) {
                            1 -> OtpType.HOTP
                            2 -> OtpType.TOTP
                            else -> OtpType.TOTP
                        }
                    }
                }
                7 -> { // counter (for HOTP)
                    skipField(buffer, wireType)
                }
                else -> {
                    skipField(buffer, wireType)
                }
            }
        }

        // 只返回 TOTP 类型的账号
        if (secret == null || type != OtpType.TOTP) {
            return null
        }

        return MigrationOtpAccount(
            secret = base32Encode(secret),
            name = name ?: "Unknown",
            issuer = issuer ?: "",
            algorithm = algorithm,
            digits = digits,
            type = type
        )
    }

    /**
     * 读取 Varint（变长整数）
     */
    private fun readVarint(buffer: ByteBuffer): Int {
        var result = 0
        var shift = 0

        while (buffer.hasRemaining()) {
            val b = buffer.get().toInt() and 0xFF
            result = result or ((b and 0x7F) shl shift)

            if ((b and 0x80) == 0) {
                return result
            }

            shift += 7
            if (shift >= 32) {
                throw IllegalArgumentException("Varint too long")
            }
        }

        throw IllegalArgumentException("Unexpected end of buffer")
    }

    /**
     * 跳过字段
     */
    private fun skipField(buffer: ByteBuffer, wireType: Int) {
        when (wireType) {
            0 -> readVarint(buffer) // Varint
            1 -> buffer.position(buffer.position() + 8) // Fixed64
            2 -> { // Length-delimited
                val length = readVarint(buffer)
                buffer.position(buffer.position() + length)
            }
            5 -> buffer.position(buffer.position() + 4) // Fixed32
            else -> throw IllegalArgumentException("Unknown wire type: $wireType")
        }
    }

    /**
     * Base32 编码（标准 RFC 4648）
     */
    private fun base32Encode(data: ByteArray): String {
        val alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"
        val result = StringBuilder()
        var buffer = 0
        var bitsLeft = 0

        for (byte in data) {
            buffer = (buffer shl 8) or (byte.toInt() and 0xFF)
            bitsLeft += 8

            while (bitsLeft >= 5) {
                bitsLeft -= 5
                val index = (buffer shr bitsLeft) and 0x1F
                result.append(alphabet[index])
            }
        }

        if (bitsLeft > 0) {
            buffer = buffer shl (5 - bitsLeft)
            val index = buffer and 0x1F
            result.append(alphabet[index])
        }

        return result.toString()
    }
}

/**
 * 迁移的 OTP 账号信息
 */
data class MigrationOtpAccount(
    val secret: String,           // Base32 编码的密钥
    val name: String,             // 账号名称（如 Google:user@gmail.com）
    val issuer: String,           // 发行者（如 Google）
    val algorithm: OtpAlgorithm,  // 算法
    val digits: OtpDigits,        // 位数
    val type: OtpType             // 类型
) {
    /**
     * 获取显示标签
     */
    fun getDisplayLabel(): String {
        return if (issuer.isNotBlank() && !name.startsWith("$issuer:", ignoreCase = true)) {
            "$issuer: $name"
        } else if (name.contains(':')) {
            name
        } else if (issuer.isNotBlank()) {
            "$issuer: $name"
        } else {
            name
        }
    }

    /**
     * 获取账号名（去除 issuer 前缀）
     */
    fun getAccountName(): String {
        if (name.contains(':')) {
            val parts = name.split(':', limit = 2)
            return parts.getOrNull(1)?.trim() ?: name
        }
        return name
    }

    /**
     * 获取算法字符串
     */
    fun getAlgorithmString(): String {
        return when (algorithm) {
            OtpAlgorithm.SHA1 -> "SHA1"
            OtpAlgorithm.SHA256 -> "SHA256"
            OtpAlgorithm.SHA512 -> "SHA512"
        }
    }

    /**
     * 获取位数整数
     */
    fun getDigitsInt(): Int {
        return when (digits) {
            OtpDigits.SIX -> 6
            OtpDigits.EIGHT -> 8
        }
    }
}

/**
 * OTP 算法枚举
 */
enum class OtpAlgorithm {
    SHA1,
    SHA256,
    SHA512
}

/**
 * OTP 位数枚举
 */
enum class OtpDigits {
    SIX,
    EIGHT
}

/**
 * OTP 类型枚举
 */
enum class OtpType {
    HOTP,
    TOTP
}
