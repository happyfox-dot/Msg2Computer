package com.codesync.util

import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

object TotpUtil {
    // 默认值，用于向后兼容旧数据
    private const val DEFAULT_DIGITS = 6
    private const val DEFAULT_PERIOD = 30
    private const val DEFAULT_ALGORITHM = "HmacSHA1"

    /**
     * 生成 TOTP 验证码
     * @param secretBase32 Base32 编码的密钥
     * @param timestamp 时间戳（秒）
     * @param algorithm 算法：SHA1/SHA256/SHA512
     * @param digits 验证码位数：6/7/8
     * @param period 周期（秒）：30/60
     */
    fun generate(
        secretBase32: String,
        timestamp: Long = System.currentTimeMillis() / 1000,
        algorithm: String = DEFAULT_ALGORITHM,
        digits: Int = DEFAULT_DIGITS,
        period: Int = DEFAULT_PERIOD
    ): String {
        val counter = timestamp / period

        val counterBytes = ByteArray(8)
        var c = counter
        for (i in 7 downTo 0) {
            counterBytes[i] = (c and 0xff).toByte()
            c = c shr 8
        }

        val keyBytes = base32Decode(secretBase32)
        val hmacAlgorithm = when (algorithm.uppercase()) {
            "SHA256" -> "HmacSHA256"
            "SHA512" -> "HmacSHA512"
            else -> "HmacSHA1"
        }
        val hmac = computeHmac(keyBytes, counterBytes, hmacAlgorithm)
        val otp = dynamicTruncate(hmac, digits)

        return otp.toString().padStart(digits, '0')
    }

    fun getRemainingSeconds(period: Int = DEFAULT_PERIOD): Int {
        val elapsed = (System.currentTimeMillis() / 1000) % period
        return (period - elapsed).toInt()
    }

    /** 当前周期的序号，周期切换时该值 +1，用于判断是否需要重新推送。 */
    fun getCurrentCounter(period: Int = DEFAULT_PERIOD): Long {
        return (System.currentTimeMillis() / 1000) / period
    }

    private fun base32Decode(base32: String): ByteArray {
        val alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"
        val cleaned = base32.uppercase().replace(" ", "").replace("-", "")

        var bits = 0L
        var bitsCount = 0
        val result = mutableListOf<Byte>()

        for (ch in cleaned) {
            val value = alphabet.indexOf(ch)
            if (value == -1) continue

            bits = (bits shl 5) or value.toLong()
            bitsCount += 5

            if (bitsCount >= 8) {
                bitsCount -= 8
                result.add(((bits shr bitsCount) and 0xff).toByte())
            }
        }

        return result.toByteArray()
    }

    private fun computeHmac(key: ByteArray, message: ByteArray, algorithm: String): ByteArray {
        val mac = Mac.getInstance(algorithm)
        val keySpec = SecretKeySpec(key, algorithm)
        mac.init(keySpec)
        return mac.doFinal(message)
    }

    private fun dynamicTruncate(hmac: ByteArray, digits: Int): Int {
        val offset = hmac[hmac.size - 1].toInt() and 0x0f
        val binary = (
            ((hmac[offset].toInt() and 0x7f) shl 24) or
            ((hmac[offset + 1].toInt() and 0xff) shl 16) or
            ((hmac[offset + 2].toInt() and 0xff) shl 8) or
            (hmac[offset + 3].toInt() and 0xff)
        )
        return binary % Math.pow(10.0, digits.toDouble()).toInt()
    }

    fun validateSecret(secret: String): Boolean {
        if (secret.length < 16) return false
        val cleaned = secret.uppercase().replace(" ", "")
        return cleaned.all { it in "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567" }
    }
}
