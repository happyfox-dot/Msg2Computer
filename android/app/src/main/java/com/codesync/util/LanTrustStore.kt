package com.codesync.util

import android.content.Context
import org.json.JSONArray
import java.security.SecureRandom

object LanTrustStore {
    private const val PREFS_NAME = "lan_trust"
    private const val KEY_NETWORK_ID = "network_id"
    private const val KEY_ALLOW_JOIN = "allow_join_requests"
    private const val KEY_PENDING_MERGE_FROM = "pending_merge_from"

    fun getNetworkId(context: Context): String {
        val prefs = SecurePrefs.get(context, PREFS_NAME)
        var id = prefs.getString(KEY_NETWORK_ID, "").orEmpty()
        if (id.isBlank()) {
            id = generateNetworkId()
            prefs.edit().putString(KEY_NETWORK_ID, id).apply()
        }
        return id
    }

    fun adoptNetworkId(
        context: Context,
        networkId: String,
        allowMerge: Boolean = false,
        mergeFromNetworkIds: List<String> = emptyList()
    ) {
        val incoming = networkId.trim()
        if (incoming.isBlank()) return
        val prefs = SecurePrefs.get(context, PREFS_NAME)
        val current = prefs.getString(KEY_NETWORK_ID, "").orEmpty()
        if (current.isNotBlank() && current != incoming && DeviceStore.getDevices(context).isNotEmpty() && !allowMerge) {
            throw IllegalStateException("network_id_mismatch")
        }
        val mergeFrom = (listOf(current) + mergeFromNetworkIds)
            .map { it.trim() }
            .filter { it.isNotBlank() && it != incoming }
            .distinct()
        prefs.edit().putString(KEY_NETWORK_ID, incoming).apply()
        if (mergeFrom.isNotEmpty()) {
            DeviceStore.rewriteNetworkId(context, incoming, mergeFrom)
            TopologyStore.rewriteNetworkId(context, incoming, mergeFrom)
            rememberPendingMergeFrom(context, mergeFrom)
        }
    }

    fun rollbackNetworkIdAdoption(
        context: Context,
        previousNetworkId: String,
        adoptedNetworkId: String
    ) {
        val previous = previousNetworkId.trim()
        val adopted = adoptedNetworkId.trim()
        if (previous.isBlank() || adopted.isBlank() || previous == adopted) return
        val prefs = SecurePrefs.get(context, PREFS_NAME)
        prefs.edit().putString(KEY_NETWORK_ID, previous).apply()
        DeviceStore.rewriteNetworkId(context, previous, listOf(adopted))
        TopologyStore.rewriteNetworkId(context, previous, listOf(adopted))
    }

    fun consumePendingMergeFrom(context: Context): List<String> {
        val prefs = SecurePrefs.get(context, PREFS_NAME)
        val raw = prefs.getString(KEY_PENDING_MERGE_FROM, "[]").orEmpty()
        prefs.edit().remove(KEY_PENDING_MERGE_FROM).apply()
        return jsonArrayToList(runCatching { JSONArray(raw) }.getOrNull())
    }

    private fun rememberPendingMergeFrom(context: Context, mergeFromNetworkIds: List<String>) {
        val prefs = SecurePrefs.get(context, PREFS_NAME)
        val existing = jsonArrayToList(runCatching {
            JSONArray(prefs.getString(KEY_PENDING_MERGE_FROM, "[]").orEmpty())
        }.getOrNull())
        val merged = (existing + mergeFromNetworkIds)
            .map { it.trim() }
            .filter { it.isNotBlank() }
            .distinct()
        prefs.edit().putString(KEY_PENDING_MERGE_FROM, JSONArray(merged).toString()).apply()
    }

    private fun jsonArrayToList(array: JSONArray?): List<String> {
        if (array == null) return emptyList()
        return (0 until array.length()).mapNotNull {
            array.optString(it).trim().takeIf { value -> value.isNotBlank() }
        }
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
