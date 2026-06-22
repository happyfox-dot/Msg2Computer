package com.codesync.util

import android.content.Context
import android.content.ContextWrapper
import android.content.SharedPreferences

class InMemoryContext : ContextWrapper(null) {
    private val stores = mutableMapOf<String, SharedPreferences>()

    override fun getSharedPreferences(name: String?, mode: Int): SharedPreferences {
        val key = name.orEmpty()
        return synchronized(stores) {
            stores.getOrPut(key) { InMemorySharedPreferences() }
        }
    }
}

private class InMemorySharedPreferences : SharedPreferences {
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

    override fun contains(key: String?): Boolean =
        synchronized(lock) { values.containsKey(key) }

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

        override fun putString(key: String?, value: String?): SharedPreferences.Editor =
            apply { if (key != null) pending[key] = value }

        override fun putStringSet(key: String?, values: MutableSet<String>?): SharedPreferences.Editor =
            apply { if (key != null) pending[key] = values?.toSet() }

        override fun putInt(key: String?, value: Int): SharedPreferences.Editor =
            apply { if (key != null) pending[key] = value }

        override fun putLong(key: String?, value: Long): SharedPreferences.Editor =
            apply { if (key != null) pending[key] = value }

        override fun putFloat(key: String?, value: Float): SharedPreferences.Editor =
            apply { if (key != null) pending[key] = value }

        override fun putBoolean(key: String?, value: Boolean): SharedPreferences.Editor =
            apply { if (key != null) pending[key] = value }

        override fun remove(key: String?): SharedPreferences.Editor =
            apply { if (key != null) pending[key] = null }

        override fun clear(): SharedPreferences.Editor = apply { clearAll = true }

        override fun commit(): Boolean {
            val changed = mutableSetOf<String>()
            val snapshotListeners: List<SharedPreferences.OnSharedPreferenceChangeListener>
            synchronized(lock) {
                if (clearAll) {
                    changed.addAll(values.keys)
                    values.clear()
                }
                for ((key, value) in pending) {
                    changed.add(key)
                    if (value == null) values.remove(key) else values[key] = value
                }
                snapshotListeners = listeners.toList()
            }
            changed.forEach { key ->
                snapshotListeners.forEach { listener ->
                    listener.onSharedPreferenceChanged(this@InMemorySharedPreferences, key)
                }
            }
            return true
        }

        override fun apply() {
            commit()
        }
    }
}
