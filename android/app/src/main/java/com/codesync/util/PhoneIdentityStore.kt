package com.codesync.util

import android.content.Context
import android.os.Build
import java.util.Locale
import java.util.UUID

data class PhoneIdentity(
    val id: String,
    val name: String,
    val pairingKey: String
)

object PhoneIdentityStore {
    private const val PREFS_NAME = "phone_identity"
    private const val KEY_PHONE_ID = "phone_id"
    private const val KEY_PHONE_NAME = "phone_name"
    private const val KEY_PAIRING_KEY = "pairing_key"

    fun get(context: Context): PhoneIdentity {
        // pairingKey 是本机中继鉴权的根密钥，走加密存储（SecurePrefs 自动迁移旧明文数据）
        val prefs = SecurePrefs.get(context, PREFS_NAME)
        var id = prefs.getString(KEY_PHONE_ID, null)
        var name = prefs.getString(KEY_PHONE_NAME, null)
        var pairingKey = prefs.getString(KEY_PAIRING_KEY, null)

        if (id.isNullOrBlank()) {
            id = UUID.randomUUID().toString()
        }
        if (name.isNullOrBlank()) {
            name = defaultPhoneName()
        }
        if (pairingKey.isNullOrBlank()) {
            pairingKey = CryptoUtil.generateRandomKey()
        }

        prefs.edit()
            .putString(KEY_PHONE_ID, id)
            .putString(KEY_PHONE_NAME, name)
            .putString(KEY_PAIRING_KEY, pairingKey)
            .apply()

        return PhoneIdentity(id = id, name = name, pairingKey = pairingKey)
    }

    private fun defaultPhoneName(): String {
        val manufacturer = Build.MANUFACTURER.orEmpty().trim()
        val model = Build.MODEL.orEmpty().trim()

        val raw = when {
            manufacturer.isBlank() && model.isBlank() -> "Android Phone"
            manufacturer.isBlank() -> model
            model.isBlank() -> manufacturer
            model.lowercase(Locale.US).startsWith(manufacturer.lowercase(Locale.US)) -> model
            else -> "$manufacturer $model"
        }

        return raw.replaceFirstChar {
            if (it.isLowerCase()) it.titlecase(Locale.US) else it.toString()
        }
    }
}
