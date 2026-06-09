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
    private const val LEGACY_PREFS_NAME = "totp_secrets"

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
                TotpEntry.fromLegacyString(entry)
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
            TotpEntry.fromJson(json)
        }.sortedBy { it.label.lowercase() }
    }

    /**
     * 保存所有 TOTP 条目（覆盖）
     */
    private fun saveAll(context: Context, entries: List<TotpEntry>) {
        val prefs = getEncryptedPrefs(context)
        val jsonSet = entries.map { it.toJson() }.toSet()
        prefs.edit().putStringSet(KEY_ENTRIES, jsonSet).apply()
    }

    /**
     * 添加单个 TOTP 条目
     */
    fun add(context: Context, entry: TotpEntry) {
        val entries = loadAll(context).toMutableList()
        // 去重：相同 label 的只保留最新的
        entries.removeAll { it.label == entry.label }
        entries.add(entry)
        saveAll(context, entries)
    }

    /**
     * 删除单个 TOTP 条目
     */
    fun remove(context: Context, label: String) {
        val entries = loadAll(context).filter { it.label != label }
        saveAll(context, entries)
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
