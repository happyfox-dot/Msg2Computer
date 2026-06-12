package com.codesync.util

import android.content.Context
import android.util.Base64
import java.security.KeyFactory
import java.security.KeyPair
import java.security.KeyPairGenerator
import java.security.MessageDigest
import java.security.PrivateKey
import java.security.PublicKey
import java.security.spec.PKCS8EncodedKeySpec
import java.security.spec.X509EncodedKeySpec
import javax.crypto.KeyAgreement

object LanJoinCrypto {
    private const val PREFS_NAME = "lan_join_crypto"
    private const val KEY_PRIVATE = "private_key"
    private const val KEY_PUBLIC = "public_key"

    data class RequestKey(
        val ephemeralPublicKey: String,
        val sessionKey: String
    )

    fun publicKeyBase64(context: Context): String =
        getOrCreateKeyPair(context).public.encoded.toBase64()

    fun fingerprint(context: Context): String {
        val identity = PhoneIdentityStore.get(context)
        val networkId = LanTrustStore.getNetworkId(context)
        return MessageDigest.getInstance("SHA-256")
            .digest("${identity.id}|${identity.name}|ANDROID_PHONE|$networkId".toByteArray(Charsets.UTF_8))
            .joinToString("") { "%02x".format(it) }
            .take(16)
            .chunked(4)
            .joinToString("-")
    }

    fun createRequestKey(peerPublicKeyBase64: String): RequestKey {
        val pair = generateKeyPair()
        return RequestKey(
            ephemeralPublicKey = pair.public.encoded.toBase64(),
            sessionKey = deriveSessionKey(pair.private, peerPublicKeyBase64)
        )
    }

    fun createAcceptKey(context: Context, requesterPublicKeyBase64: String): String =
        deriveSessionKey(getOrCreateKeyPair(context).private, requesterPublicKeyBase64)

    private fun deriveSessionKey(privateKey: PrivateKey, peerPublicKeyBase64: String): String {
        val peerPublicKey = decodePublicKey(peerPublicKeyBase64)
        val agreement = KeyAgreement.getInstance("ECDH")
        agreement.init(privateKey)
        agreement.doPhase(peerPublicKey, true)
        val shared = agreement.generateSecret()
        val digest = MessageDigest.getInstance("SHA-256")
        digest.update(shared)
        digest.update("codebridge-lan-join-v1".toByteArray(Charsets.UTF_8))
        return digest.digest().toBase64()
    }

    private fun getOrCreateKeyPair(context: Context): KeyPair {
        val prefs = SecurePrefs.get(context, PREFS_NAME)
        val privateRaw = prefs.getString(KEY_PRIVATE, "").orEmpty()
        val publicRaw = prefs.getString(KEY_PUBLIC, "").orEmpty()
        if (privateRaw.isNotBlank() && publicRaw.isNotBlank()) {
            runCatching {
                val factory = KeyFactory.getInstance("EC")
                val privateKey = factory.generatePrivate(PKCS8EncodedKeySpec(privateRaw.fromBase64()))
                val publicKey = factory.generatePublic(X509EncodedKeySpec(publicRaw.fromBase64()))
                return KeyPair(publicKey, privateKey)
            }
        }
        val pair = generateKeyPair()
        prefs.edit()
            .putString(KEY_PRIVATE, pair.private.encoded.toBase64())
            .putString(KEY_PUBLIC, pair.public.encoded.toBase64())
            .apply()
        return pair
    }

    private fun generateKeyPair(): KeyPair {
        val generator = KeyPairGenerator.getInstance("EC")
        generator.initialize(java.security.spec.ECGenParameterSpec("secp256r1"))
        return generator.generateKeyPair()
    }

    private fun decodePublicKey(publicKeyBase64: String): PublicKey {
        val spec = X509EncodedKeySpec(publicKeyBase64.fromBase64())
        return KeyFactory.getInstance("EC").generatePublic(spec)
    }

    private fun ByteArray.toBase64(): String = Base64.encodeToString(this, Base64.NO_WRAP)

    private fun String.fromBase64(): ByteArray = Base64.decode(this, Base64.DEFAULT)
}
