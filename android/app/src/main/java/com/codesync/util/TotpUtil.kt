package com.codesync.util

import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

object TotpUtil {
    private const val DIGITS = 6
    private const val PERIOD = 30
    private const val ALGORITHM = "HmacSHA1"

    fun generate(secretBase32: String, timestamp: Long = System.currentTimeMillis() / 1000): String {
        val time = timestamp
        val counter = time / PERIOD

        val counterBytes = ByteArray(8)
        var c = counter
        for (i in 7 downTo 0) {
            counterBytes[i] = (c and 0xff).toByte()
            c = c shr 8
        }

        val keyBytes = base32Decode(secretBase32)
        val hmac = computeHmac(keyBytes, counterBytes)
        val otp = dynamicTruncate(hmac)

        return otp.toString().padStart(DIGITS, '0')
    }

    fun getRemainingSeconds(): Int {
        val elapsed = (System.currentTimeMillis() / 1000) % PERIOD
        return (PERIOD - elapsed).toInt()
    }

    /** 当前 30 秒周期的序号，周期切换时该值 +1，用于判断是否需要重新推送。 */
    fun getCurrentCounter(): Long {
        return (System.currentTimeMillis() / 1000) / PERIOD
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

    private fun computeHmac(key: ByteArray, message: ByteArray): ByteArray {
        val mac = Mac.getInstance(ALGORITHM)
        val keySpec = SecretKeySpec(key, ALGORITHM)
        mac.init(keySpec)
        return mac.doFinal(message)
    }

    private fun dynamicTruncate(hmac: ByteArray): Int {
        val offset = hmac[hmac.size - 1].toInt() and 0x0f
        val binary = (
            ((hmac[offset].toInt() and 0x7f) shl 24) or
            ((hmac[offset + 1].toInt() and 0xff) shl 16) or
            ((hmac[offset + 2].toInt() and 0xff) shl 8) or
            (hmac[offset + 3].toInt() and 0xff)
        )
        return binary % Math.pow(10.0, DIGITS.toDouble()).toInt()
    }

    fun validateSecret(secret: String): Boolean {
        if (secret.length < 16) return false
        val cleaned = secret.uppercase().replace(" ", "")
        return cleaned.all { it in "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567" }
    }
}
