package com.codesync.util

import android.content.Context
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey

/** Encrypted TOTP seed store. It never falls back to plaintext storage. */
object TotpStore {
    private const val TAG = "TotpStore"
    private const val PREFS_NAME = "totp_secrets_encrypted"
    private const val KEY_ENTRIES = "entries"
    private const val KEY_DELETE_TOMBSTONES = "delete_tombstones"
    private const val LEGACY_PREFS_NAME = "totp_secrets"
    private const val MAX_DELETE_TOMBSTONES = 300
    private const val META_PREFS_NAME = "totp_store_metadata"
    private const val KEY_MASTER_KEY_ALIAS = "master_key_alias"
    private const val KEY_MIGRATED = "migrated"

    private val storeLock = Any()
    @Volatile private var encryptedPrefs: SharedPreferences? = null
    @Volatile private var testPrefsProvider: ((Context) -> SharedPreferences?)? = null
    private var lastKnownEntries: List<TotpEntry>? = null
    private var lastKnownTombstones: List<TotpEntry>? = null

    internal fun setTestPreferencesProviderForTests(provider: ((Context) -> SharedPreferences?)?) {
        synchronized(storeLock) {
            testPrefsProvider = provider
            encryptedPrefs = null
            lastKnownEntries = null
            lastKnownTombstones = null
        }
    }

    private fun getEncryptedPrefs(context: Context): SharedPreferences? {
        testPrefsProvider?.let { provider ->
            return runCatching { provider(context) }
                .onFailure { safeStorageLog(TAG, "Test encrypted preference provider failed", it) }
                .getOrNull()
        }
        encryptedPrefs?.let { return it }
        synchronized(storeLock) {
            encryptedPrefs?.let { return it }
            val appContext = context.applicationContext
            val configuredAlias = runCatching {
                appContext.getSharedPreferences(META_PREFS_NAME, Context.MODE_PRIVATE)
                    .getString(KEY_MASTER_KEY_ALIAS, MasterKey.DEFAULT_MASTER_KEY_ALIAS)
                    .orEmpty()
                    .ifBlank { MasterKey.DEFAULT_MASTER_KEY_ALIAS }
            }.getOrElse {
                safeStorageLog(TAG, "Unable to read TOTP key metadata; encrypted store left untouched", it)
                return null
            }
            // Never delete/recreate here. A create failure can be a temporarily
            // unavailable Keystore; deleting the preference file would destroy
            // perfectly valid seeds and recovery metadata.
            val created = createEncrypted(appContext, configuredAlias) ?: return null
            encryptedPrefs = created
            return created
        }
    }

    private fun createEncrypted(context: Context, masterKeyAlias: String): SharedPreferences? =
        runCatching {
            val masterKey = MasterKey.Builder(context, masterKeyAlias)
                .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
                .build()
            EncryptedSharedPreferences.create(
                context,
                PREFS_NAME,
                masterKey,
                EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
                EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
            )
        }.onFailure {
            safeStorageLog(TAG, "EncryptedSharedPreferences.create failed; will retry without deleting data", it)
        }.getOrNull()

    /** Migration succeeds only after the encrypted transaction commits. */
    private fun ensureLegacyMigration(context: Context): Boolean {
        val prefs = getEncryptedPrefs(context) ?: return false
        val alreadyMigrated = runCatching { prefs.getBoolean(KEY_MIGRATED, false) }
            .onFailure { safeStorageLog(TAG, "Unable to read TOTP migration state", it) }
            .getOrNull() ?: return false
        if (alreadyMigrated) return true

        val encryptedRaw = runCatching {
            prefs.getStringSet(KEY_ENTRIES, emptySet())?.toSet() ?: emptySet()
        }.onFailure { safeStorageLog(TAG, "Unable to read encrypted TOTP data during migration", it) }
            .getOrNull() ?: return false
        val legacyPrefs = context.getSharedPreferences(LEGACY_PREFS_NAME, Context.MODE_PRIVATE)
        val legacyRaw = runCatching {
            legacyPrefs.getStringSet(KEY_ENTRIES, emptySet())?.toSet() ?: emptySet()
        }.onFailure { safeStorageLog(TAG, "Unable to read legacy TOTP data", it) }
            .getOrNull() ?: return false
        val migratedJson = ArrayList<String>(legacyRaw.size)
        for (legacyEntry in legacyRaw) {
            val parsed = TotpEntry.fromLegacyString(legacyEntry)?.withStableId() ?: run {
                safeStorageLog(TAG, "Malformed legacy TOTP record; migration and cleanup deferred")
                return false
            }
            migratedJson.add(parsed.toJson())
        }
        val merged = encryptedRaw + migratedJson
        val committed = runCatching {
            prefs.edit()
                .putStringSet(KEY_ENTRIES, merged)
                .putBoolean(KEY_MIGRATED, true)
                .commit()
        }.onFailure { safeStorageLog(TAG, "Unable to commit encrypted TOTP migration", it) }
            .getOrDefault(false)
        if (!committed) return false
        if (legacyRaw.isNotEmpty()) {
            runCatching { legacyPrefs.edit().clear().commit() }
                .onFailure { safeStorageLog(TAG, "Encrypted migration succeeded but legacy cleanup failed", it) }
        }
        return true
    }

    private fun readEntries(context: Context, key: String): List<TotpEntry>? {
        if (!ensureLegacyMigration(context)) return null
        val prefs = getEncryptedPrefs(context) ?: return null
        val raw = runCatching { prefs.getStringSet(key, emptySet())?.toSet() ?: emptySet() }
            .onFailure { safeStorageLog(TAG, "Unable to decrypt TOTP key $key", it) }
            .getOrNull() ?: return null
        val parsed = ArrayList<TotpEntry>(raw.size)
        for (json in raw) {
            val entry = TotpEntry.fromJson(json)?.withStableId() ?: run {
                safeStorageLog(TAG, "Malformed encrypted TOTP record; refusing destructive rewrite")
                return null
            }
            parsed.add(entry)
        }
        return parsed
    }

    fun loadAll(context: Context): List<TotpEntry> = synchronized(storeLock) {
        val loaded = readEntries(context, KEY_ENTRIES)
        if (loaded != null) lastKnownEntries = loaded
        (loaded ?: lastKnownEntries ?: emptyList()).sortedWith(
            compareByDescending<TotpEntry> { it.pinnedAt }.thenBy { it.label.lowercase() }
        )
    }

    private fun saveAll(context: Context, entries: List<TotpEntry>): Boolean {
        val prefs = getEncryptedPrefs(context) ?: return false
        val normalized = entries.map { it.withStableId() }
        val jsonSet = normalized.map { it.toJson() }.toSet()
        val committed = runCatching { prefs.edit().putStringSet(KEY_ENTRIES, jsonSet).commit() }
            .onFailure { safeStorageLog(TAG, "Unable to save TOTP entries", it) }
            .getOrDefault(false)
        if (committed) lastKnownEntries = normalized
        return committed
    }

    fun add(context: Context, entry: TotpEntry) = synchronized(storeLock) {
        val normalized = entry.withStableId()
        val entries = readEntries(context, KEY_ENTRIES)?.toMutableList() ?: return@synchronized
        val existing = entries.firstOrNull { it.id == normalized.id }
        val merged = if (existing != null && normalized.pinnedAt == 0L) {
            normalized.copy(pinnedAt = existing.pinnedAt)
        } else normalized
        entries.removeAll { it.id == normalized.id }
        entries.add(merged)
        if (saveAll(context, entries) && merged.isLocal) removeDeleteTombstone(context, merged)
    }

    fun remove(context: Context, label: String) = synchronized(storeLock) {
        val entries = readEntries(context, KEY_ENTRIES) ?: return@synchronized
        saveAll(context, entries.filter { it.label != label })
    }

    fun removeById(context: Context, id: String) = synchronized(storeLock) {
        val entries = readEntries(context, KEY_ENTRIES) ?: return@synchronized
        saveAll(context, entries.filter { it.id != id })
    }

    fun setPinned(context: Context, id: String, pinned: Boolean) = synchronized(storeLock) {
        val entries = readEntries(context, KEY_ENTRIES) ?: return@synchronized
        val now = System.currentTimeMillis()
        saveAll(context, entries.map { if (it.id == id) it.copy(pinnedAt = if (pinned) now else 0L) else it })
    }

    fun loadDeleteTombstones(context: Context): List<TotpEntry> = synchronized(storeLock) {
        val loaded = readEntries(context, KEY_DELETE_TOMBSTONES)
        if (loaded != null) lastKnownTombstones = loaded
        loaded ?: lastKnownTombstones ?: emptyList()
    }

    private fun saveDeleteTombstones(context: Context, entries: List<TotpEntry>): Boolean {
        val prefs = getEncryptedPrefs(context) ?: return false
        val normalized = entries.takeLast(MAX_DELETE_TOMBSTONES).map { it.withStableId() }
        val committed = runCatching {
            prefs.edit().putStringSet(KEY_DELETE_TOMBSTONES, normalized.map { it.toJson() }.toSet()).commit()
        }.onFailure { safeStorageLog(TAG, "Unable to save TOTP delete tombstones", it) }
            .getOrDefault(false)
        if (committed) lastKnownTombstones = normalized
        return committed
    }

    fun addDeleteTombstone(context: Context, entry: TotpEntry) = synchronized(storeLock) {
        val normalized = entry.withStableId()
        val entries = readEntries(context, KEY_DELETE_TOMBSTONES)?.toMutableList() ?: return@synchronized
        entries.removeAll { it.id == normalized.id && it.sourceDeviceId == normalized.sourceDeviceId }
        entries.add(normalized)
        saveDeleteTombstones(context, entries)
    }

    fun removeDeleteTombstone(context: Context, entry: TotpEntry) = synchronized(storeLock) {
        val normalized = entry.withStableId()
        val entries = readEntries(context, KEY_DELETE_TOMBSTONES) ?: return@synchronized
        saveDeleteTombstones(
            context,
            entries.filterNot { it.id == normalized.id && it.sourceDeviceId == normalized.sourceDeviceId }
        )
    }

    fun find(context: Context, label: String): TotpEntry? = loadAll(context).find { it.label == label }

    /** Explicit user clear only; automatic recovery paths never call this. */
    fun clear(context: Context) = synchronized(storeLock) {
        val prefs = getEncryptedPrefs(context) ?: return@synchronized
        val committed = runCatching { prefs.edit().clear().commit() }
            .onFailure { safeStorageLog(TAG, "Unable to clear TOTP store", it) }
            .getOrDefault(false)
        if (committed) {
            lastKnownEntries = emptyList()
            lastKnownTombstones = emptyList()
        }
    }
}
