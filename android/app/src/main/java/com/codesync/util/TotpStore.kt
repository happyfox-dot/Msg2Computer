package com.codesync.util

import android.content.Context
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey

/**
 * TOTP 加密存储管理器
 * 使用 EncryptedSharedPreferences 加密存储 TOTP 密钥
 */
object TotpStore {
    private const val PREFS_NAME = "totp_secrets_encrypted"
    private const val KEY_ENTRIES = "entries"
    private const val KEY_DELETE_TOMBSTONES = "delete_tombstones"
    private const val LEGACY_PREFS_NAME = "totp_secrets"
    private const val MAX_DELETE_TOMBSTONES = 300

    private var encryptedPrefs: SharedPreferences? = null

    private fun getEncryptedPrefs(context: Context): SharedPreferences {
        if (encryptedPrefs == null) {
            val masterKey = MasterKey.Builder(context)
                .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
                .build()

            encryptedPrefs = EncryptedSharedPreferences.create(
                context,
                PREFS_NAME,
                masterKey,
                EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
                EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
            )
        }
        return encryptedPrefs!!
    }

    /**
     * 从旧格式迁移到新格式（自动执行一次）
     */
    private fun migrateFromLegacy(context: Context) {
        val prefs = getEncryptedPrefs(context)
        if (prefs.contains("migrated")) return

        val legacyPrefs = context.getSharedPreferences(LEGACY_PREFS_NAME, Context.MODE_PRIVATE)
        val legacyEntries = legacyPrefs.getStringSet("entries", emptySet()) ?: emptySet()

        if (legacyEntries.isNotEmpty()) {
            val migratedEntries = legacyEntries.mapNotNull { entry ->
                TotpEntry.fromLegacyString(entry)?.withStableId()
            }
            saveAll(context, migratedEntries)
        }

        prefs.edit().putBoolean("migrated", true).apply()

        // 清除旧数据
        legacyPrefs.edit().clear().apply()
    }

    /**
     * 加载所有 TOTP 条目
     */
    fun loadAll(context: Context): List<TotpEntry> {
        migrateFromLegacy(context)

        val prefs = getEncryptedPrefs(context)
        val jsonSet = prefs.getStringSet(KEY_ENTRIES, emptySet()) ?: emptySet()

        return jsonSet.mapNotNull { json ->
            TotpEntry.fromJson(json)?.withStableId()
        }.sortedWith(
            compareByDescending<TotpEntry> { it.pinnedAt }
                .thenBy { it.label.lowercase() }
        )
    }

    /**
     * 保存所有 TOTP 条目（覆盖）
     */
    private fun saveAll(context: Context, entries: List<TotpEntry>) {
        val prefs = getEncryptedPrefs(context)
        val jsonSet = entries.map { it.withStableId().toJson() }.toSet()
        prefs.edit().putStringSet(KEY_ENTRIES, jsonSet).apply()
    }

    /**
     * 添加单个 TOTP 条目
     */
    fun add(context: Context, entry: TotpEntry) {
        val normalized = entry.withStableId()
        val entries = loadAll(context).toMutableList()
        val existing = entries.firstOrNull { it.id == normalized.id }
        val merged = if (existing != null && normalized.pinnedAt == 0L) {
            normalized.copy(pinnedAt = existing.pinnedAt)
        } else {
            normalized
        }
        entries.removeAll { it.id == normalized.id }
        entries.add(merged)
        saveAll(context, entries)
        if (merged.isLocal) {
            removeDeleteTombstone(context, merged)
        }
    }

    /**
     * 删除单个 TOTP 条目
     */
    fun remove(context: Context, label: String) {
        val entries = loadAll(context).filter { it.label != label }
        saveAll(context, entries)
    }

    fun removeById(context: Context, id: String) {
        val entries = loadAll(context).filter { it.id != id }
        saveAll(context, entries)
    }

    fun setPinned(context: Context, id: String, pinned: Boolean) {
        val now = System.currentTimeMillis()
        val entries = loadAll(context).map {
            if (it.id == id) it.copy(pinnedAt = if (pinned) now else 0L) else it
        }
        saveAll(context, entries)
    }

    fun loadDeleteTombstones(context: Context): List<TotpEntry> {
        migrateFromLegacy(context)

        val prefs = getEncryptedPrefs(context)
        val jsonSet = prefs.getStringSet(KEY_DELETE_TOMBSTONES, emptySet()) ?: emptySet()

        return jsonSet.mapNotNull { json ->
            TotpEntry.fromJson(json)?.withStableId()
        }
    }

    private fun saveDeleteTombstones(context: Context, entries: List<TotpEntry>) {
        val prefs = getEncryptedPrefs(context)
        val jsonSet = entries.takeLast(MAX_DELETE_TOMBSTONES)
            .map { it.withStableId().toJson() }
            .toSet()
        prefs.edit().putStringSet(KEY_DELETE_TOMBSTONES, jsonSet).apply()
    }

    fun addDeleteTombstone(context: Context, entry: TotpEntry) {
        val normalized = entry.withStableId()
        val entries = loadDeleteTombstones(context).toMutableList()
        entries.removeAll {
            it.id == normalized.id &&
                it.sourceDeviceId == normalized.sourceDeviceId
        }
        entries.add(normalized)
        saveDeleteTombstones(context, entries)
    }

    fun removeDeleteTombstone(context: Context, entry: TotpEntry) {
        val normalized = entry.withStableId()
        val entries = loadDeleteTombstones(context).filterNot {
            it.id == normalized.id &&
                it.sourceDeviceId == normalized.sourceDeviceId
        }
        saveDeleteTombstones(context, entries)
    }

    /**
     * 查找单个 TOTP 条目
     */
    fun find(context: Context, label: String): TotpEntry? {
        return loadAll(context).find { it.label == label }
    }

    /**
     * 清空所有 TOTP 条目
     */
    fun clear(context: Context) {
        val prefs = getEncryptedPrefs(context)
        prefs.edit().clear().apply()
    }
}
