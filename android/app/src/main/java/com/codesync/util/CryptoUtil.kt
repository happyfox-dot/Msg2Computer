package com.codesync.util

import android.util.Base64
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

object CryptoUtil {
    private const val GCM_TAG_LENGTH = 128
    private const val GCM_IV_LENGTH = 12
    private const val ALGORITHM = "AES/GCM/NoPadding"

    fun encrypt(plaintext: String, keyBase64: String): String {
        val keyBytes = Base64.decode(keyBase64, Base64.DEFAULT)
        val key = SecretKeySpec(keyBytes, "AES")

        val iv = ByteArray(GCM_IV_LENGTH)
        SecureRandom().nextBytes(iv)

        val cipher = Cipher.getInstance(ALGORITHM)
        val spec = GCMParameterSpec(GCM_TAG_LENGTH, iv)
        cipher.init(Cipher.ENCRYPT_MODE, key, spec)

        val ciphertext = cipher.doFinal(plaintext.toByteArray(Charsets.UTF_8))

        val combined = iv + ciphertext
        return Base64.encodeToString(combined, Base64.NO_WRAP)
    }

    fun decrypt(encryptedBase64: String, keyBase64: String): String {
        val keyBytes = Base64.decode(keyBase64, Base64.DEFAULT)
        val key = SecretKeySpec(keyBytes, "AES")

        val combined = Base64.decode(encryptedBase64, Base64.DEFAULT)
        val iv = combined.copyOfRange(0, GCM_IV_LENGTH)
        val ciphertext = combined.copyOfRange(GCM_IV_LENGTH, combined.size)

        val cipher = Cipher.getInstance(ALGORITHM)
        val spec = GCMParameterSpec(GCM_TAG_LENGTH, iv)
        cipher.init(Cipher.DECRYPT_MODE, key, spec)

        val plaintext = cipher.doFinal(ciphertext)
        return String(plaintext, Charsets.UTF_8)
    }

    fun generateRandomKey(): String {
        val key = ByteArray(32)
        SecureRandom().nextBytes(key)
        return Base64.encodeToString(key, Base64.NO_WRAP)
    }

    fun generateNonce(): String {
        val nonce = ByteArray(16)
        SecureRandom().nextBytes(nonce)
        return Base64.encodeToString(nonce, Base64.NO_WRAP)
    }

    fun hmacSha256Base64(keyBase64: String, message: String): String {
        val keyBytes = Base64.decode(keyBase64, Base64.DEFAULT)
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(keyBytes, "HmacSHA256"))
        return Base64.encodeToString(mac.doFinal(message.toByteArray(Charsets.UTF_8)), Base64.NO_WRAP)
    }

    fun deriveSessionKey(pairingKeyBase64: String, phoneNonce: String, serverNonce: String): String {
        return hmacSha256Base64(pairingKeyBase64, "session|$phoneNonce|$serverNonce")
    }
}
