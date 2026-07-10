package com.codesync.util

import android.content.Context
import android.content.SharedPreferences
import android.util.Log
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import java.util.concurrent.ConcurrentHashMap

/** Central encrypted-preference factory for credentials and private state. */
object SecurePrefs {
    private const val TAG = "SecurePrefs"
    private const val RETRY_AFTER_FAILURE_MS = 5_000L

    private data class CachedPrefs(
        val prefs: SharedPreferences,
        val encryptedAvailable: Boolean,
        val retryAfter: Long = Long.MAX_VALUE
    )

    private val cache = ConcurrentHashMap<String, CachedPrefs>()
    @Volatile
    private var testProvider: ((Context, String) -> SharedPreferences)? = null

    fun setTestProviderForTests(provider: ((Context, String) -> SharedPreferences)?) {
        testProvider = provider
        cache.clear()
    }

    /**
     * Returns encrypted preferences when Keystore is available. On a transient
     * create failure it returns a process-memory-only store: callers keep running,
     * but no secret is ever persisted as plaintext and the encrypted file is left
     * untouched. Creation is retried later in the same process.
     */
    fun get(context: Context, name: String): SharedPreferences {
        testProvider?.let { provider -> return provider(context, name) }
        val now = System.currentTimeMillis()
        cache[name]?.let { cached ->
            if (cached.encryptedAvailable || now < cached.retryAfter) return cached.prefs
        }
        synchronized(cache) {
            val current = cache[name]
            val retryNow = System.currentTimeMillis()
            if (current != null && (current.encryptedAvailable || retryNow < current.retryAfter)) {
                return current.prefs
            }
            val appContext = context.applicationContext
            return runCatching { createEncrypted(appContext, name) }
                .fold(
                    onSuccess = { encrypted ->
                        cache[name] = CachedPrefs(encrypted, encryptedAvailable = true)
                        encrypted
                    },
                    onFailure = { error ->
                        safeStorageLog(
                            TAG,
                            "EncryptedSharedPreferences unavailable ($name); using volatile memory only",
                            error
                        )
                        val volatile = current?.prefs?.takeIf { !current.encryptedAvailable }
                            ?: VolatileSharedPreferences()
                        cache[name] = CachedPrefs(
                            prefs = volatile,
                            encryptedAvailable = false,
                            retryAfter = retryNow + RETRY_AFTER_FAILURE_MS
                        )
                        volatile
                    }
                )
        }
    }

    /** False means writes are volatile/no-op with respect to durable storage. */
    fun isStorageAvailable(prefs: SharedPreferences): Boolean =
        prefs !is VolatileSharedPreferences

    internal fun unavailablePreferencesForTests(): SharedPreferences = VolatileSharedPreferences()

    private fun createEncrypted(context: Context, name: String): SharedPreferences {
        val masterKey = MasterKey.Builder(context)
            .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
            .build()
        val encrypted = EncryptedSharedPreferences.create(
            context,
            "${name}_secure",
            masterKey,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
        )
        // Migration failure must not make a healthy encrypted target unavailable.
        runCatching { migratePlainPrefs(context, name, encrypted) }
            .onFailure { safeStorageLog(TAG, "Plaintext migration deferred for $name", it) }
        return encrypted
    }

    /** Clear legacy plaintext only after the encrypted transaction commits. */
    private fun migratePlainPrefs(
        context: Context,
        plainName: String,
        encrypted: SharedPreferences
    ) {
        val plain = context.getSharedPreferences(plainName, Context.MODE_PRIVATE)
        val entries = plain.all
        if (entries.isEmpty()) return
        val editor = encrypted.edit()
        for ((key, value) in entries) {
            if (encrypted.contains(key)) continue
            when (value) {
                is String -> editor.putString(key, value)
                is Boolean -> editor.putBoolean(key, value)
                is Int -> editor.putInt(key, value)
                is Long -> editor.putLong(key, value)
                is Float -> editor.putFloat(key, value)
                is Set<*> -> {
                    @Suppress("UNCHECKED_CAST")
                    editor.putStringSet(key, value as Set<String>)
                }
                else -> return // Unknown value: preserve the entire legacy file.
            }
        }
        if (!editor.commit()) return
        if (plain.edit().clear().commit()) {
            Log.i(TAG, "Migrated ${entries.size} plaintext entries to encrypted storage: $plainName")
        }
    }

    /** Stable process-local fallback. It never writes a filesystem preference. */
    private class VolatileSharedPreferences : SharedPreferences {
        private val lock = Any()
        private val values = mutableMapOf<String, Any?>()
        private val listeners = mutableSetOf<SharedPreferences.OnSharedPreferenceChangeListener>()

        override fun getAll(): MutableMap<String, *> = synchronized(lock) { HashMap(values) }
        override fun getString(key: String?, defValue: String?): String? =
            synchronized(lock) { values[key] as? String ?: defValue }

        override fun getStringSet(key: String?, defValues: MutableSet<String>?): MutableSet<String>? =
            synchronized(lock) {
                @Suppress("UNCHECKED_CAST")
                (values[key] as? Set<String>)?.toMutableSet() ?: defValues
            }

        override fun getInt(key: String?, defValue: Int): Int =
            synchronized(lock) { values[key] as? Int ?: defValue }

        override fun getLong(key: String?, defValue: Long): Long =
            synchronized(lock) { values[key] as? Long ?: defValue }

        override fun getFloat(key: String?, defValue: Float): Float =
            synchronized(lock) { values[key] as? Float ?: defValue }

        override fun getBoolean(key: String?, defValue: Boolean): Boolean =
            synchronized(lock) { values[key] as? Boolean ?: defValue }

        override fun contains(key: String?): Boolean = synchronized(lock) { values.containsKey(key) }
        override fun edit(): SharedPreferences.Editor = Editor()

        override fun registerOnSharedPreferenceChangeListener(
            listener: SharedPreferences.OnSharedPreferenceChangeListener?
        ) {
            if (listener != null) synchronized(lock) { listeners.add(listener) }
        }

        override fun unregisterOnSharedPreferenceChangeListener(
            listener: SharedPreferences.OnSharedPreferenceChangeListener?
        ) {
            if (listener != null) synchronized(lock) { listeners.remove(listener) }
        }

        private inner class Editor : SharedPreferences.Editor {
            private val pending = mutableMapOf<String, Any?>()
            private var clearAll = false

            override fun putString(key: String?, value: String?) = apply {
                if (key != null) pending[key] = value
            }

            override fun putStringSet(key: String?, values: MutableSet<String>?) = apply {
                if (key != null) pending[key] = values?.toSet()
            }

            override fun putInt(key: String?, value: Int) = apply { if (key != null) pending[key] = value }
            override fun putLong(key: String?, value: Long) = apply { if (key != null) pending[key] = value }
            override fun putFloat(key: String?, value: Float) = apply { if (key != null) pending[key] = value }
            override fun putBoolean(key: String?, value: Boolean) = apply {
                if (key != null) pending[key] = value
            }

            override fun remove(key: String?) = apply { if (key != null) pending[key] = null }
            override fun clear() = apply { clearAll = true }
            override fun apply() { commit() }

            override fun commit(): Boolean {
                val changed = mutableSetOf<String>()
                val snapshot: List<SharedPreferences.OnSharedPreferenceChangeListener>
                synchronized(lock) {
                    if (clearAll) {
                        changed.addAll(values.keys)
                        values.clear()
                    }
                    for ((key, value) in pending) {
                        changed.add(key)
                        if (value == null) values.remove(key) else values[key] = value
                    }
                    snapshot = listeners.toList()
                }
                changed.forEach { key ->
                    snapshot.forEach { it.onSharedPreferenceChanged(this@VolatileSharedPreferences, key) }
                }
                return true
            }
        }
    }
}

internal fun safeStorageLog(tag: String, message: String, error: Throwable? = null) {
    // android.jar logging methods throw in local JVM tests; diagnostics must never
    // turn a handled storage failure back into an application crash.
    runCatching {
        if (error == null) Log.e(tag, message) else Log.e(tag, message, error)
    }
}
