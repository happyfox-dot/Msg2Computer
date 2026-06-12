package com.codesync.util

import android.content.Context
import java.security.SecureRandom

object LanTrustStore {
    private const val PREFS_NAME = "lan_trust"
    private const val KEY_NETWORK_ID = "network_id"
    private const val KEY_ALLOW_JOIN = "allow_join_requests"

    fun getNetworkId(context: Context): String {
        val prefs = SecurePrefs.get(context, PREFS_NAME)
        var id = prefs.getString(KEY_NETWORK_ID, "").orEmpty()
        if (id.isBlank()) {
            id = generateNetworkId()
            prefs.edit().putString(KEY_NETWORK_ID, id).apply()
        }
        return id
    }

    fun adoptNetworkId(context: Context, networkId: String) {
        val incoming = networkId.trim()
        if (incoming.isBlank()) return
        val current = SecurePrefs.get(context, PREFS_NAME).getString(KEY_NETWORK_ID, "").orEmpty()
        if (current.isNotBlank() && current != incoming && DeviceStore.getDevices(context).isNotEmpty()) {
            throw IllegalStateException("network_id_mismatch")
        }
        SecurePrefs.get(context, PREFS_NAME).edit().putString(KEY_NETWORK_ID, incoming).apply()
    }

    fun isJoinRequestAllowed(context: Context): Boolean =
        SecurePrefs.get(context, PREFS_NAME).getBoolean(KEY_ALLOW_JOIN, true)

    fun setJoinRequestAllowed(context: Context, allowed: Boolean) {
        SecurePrefs.get(context, PREFS_NAME).edit().putBoolean(KEY_ALLOW_JOIN, allowed).apply()
    }

    private fun generateNetworkId(): String {
        val bytes = ByteArray(16)
        SecureRandom().nextBytes(bytes)
        return "net-" + bytes.joinToString("") { "%02x".format(it) }
    }
}
