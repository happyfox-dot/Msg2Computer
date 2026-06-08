package com.codesync.util

import android.content.Context
import android.os.Build
import java.util.Locale
import java.util.UUID

data class PhoneIdentity(
    val id: String,
    val name: String
)

object PhoneIdentityStore {
    private const val PREFS_NAME = "phone_identity"
    private const val KEY_PHONE_ID = "phone_id"
    private const val KEY_PHONE_NAME = "phone_name"

    fun get(context: Context): PhoneIdentity {
        val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        var id = prefs.getString(KEY_PHONE_ID, null)
        var name = prefs.getString(KEY_PHONE_NAME, null)

        if (id.isNullOrBlank()) {
            id = UUID.randomUUID().toString()
        }
        if (name.isNullOrBlank()) {
            name = defaultPhoneName()
        }

        prefs.edit()
            .putString(KEY_PHONE_ID, id)
            .putString(KEY_PHONE_NAME, name)
            .apply()

        return PhoneIdentity(id = id, name = name)
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
