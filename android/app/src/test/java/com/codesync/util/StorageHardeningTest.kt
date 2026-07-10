package com.codesync.util

import android.content.Context
import android.content.SharedPreferences
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class StorageHardeningTest {
    private class ReadFailingPreferences(
        private val delegate: SharedPreferences
    ) : SharedPreferences by delegate {
        var editCalls: Int = 0

        private fun fail(): Nothing = throw SecurityException("simulated decrypt failure")
        override fun getAll(): MutableMap<String, *> = fail()
        override fun getString(key: String?, defValue: String?): String? = fail()
        override fun getStringSet(key: String?, defValues: MutableSet<String>?): MutableSet<String>? = fail()
        override fun getInt(key: String?, defValue: Int): Int = fail()
        override fun getLong(key: String?, defValue: Long): Long = fail()
        override fun getFloat(key: String?, defValue: Float): Float = fail()
        override fun getBoolean(key: String?, defValue: Boolean): Boolean = fail()
        override fun contains(key: String?): Boolean = fail()
        override fun edit(): SharedPreferences.Editor {
            editCalls += 1
            return delegate.edit()
        }
    }

    @Test
    fun unavailableSecurePrefsAreMemoryOnlyAndMarkedUnavailable() {
        val context = InMemoryContext()
        val volatile = SecurePrefs.unavailablePreferencesForTests()

        assertFalse(SecurePrefs.isStorageAvailable(volatile))
        volatile.edit().putString("secret", "value").commit()
        assertEquals("value", volatile.getString("secret", ""))
        assertTrue(context.getSharedPreferences("sensitive", Context.MODE_PRIVATE).all.isEmpty())
    }

    @Test
    fun totpCreateFailureDoesNotDeleteOrEmptyOverwriteExistingSeeds() {
        val context = InMemoryContext()
        val encrypted = InMemorySharedPreferences()
        val original = TotpEntry(label = "Existing", secret = "JBSWY3DPEHPK3PXP").withStableId()
        TotpStore.setTestPreferencesProviderForTests { encrypted }
        try {
            TotpStore.add(context, original)
            assertEquals(listOf(original.id), TotpStore.loadAll(context).map { it.id })

            TotpStore.setTestPreferencesProviderForTests { null }
            TotpStore.add(context, TotpEntry(label = "New", secret = "GEZDGNBVGY3TQOJQ"))
            TotpStore.removeById(context, original.id)

            TotpStore.setTestPreferencesProviderForTests { encrypted }
            assertEquals(listOf(original.id), TotpStore.loadAll(context).map { it.id })
        } finally {
            TotpStore.setTestPreferencesProviderForTests(null)
        }
    }

    @Test
    fun totpLegacyDataIsClearedOnlyAfterEncryptedTargetBecomesAvailable() {
        val context = InMemoryContext()
        val legacy = context.getSharedPreferences("totp_secrets", Context.MODE_PRIVATE)
        legacy.edit().putStringSet("entries", setOf("Legacy|JBSWY3DPEHPK3PXP")).commit()

        TotpStore.setTestPreferencesProviderForTests { null }
        try {
            assertTrue(TotpStore.loadAll(context).isEmpty())
            assertTrue(legacy.getStringSet("entries", emptySet())!!.isNotEmpty())

            val encrypted = InMemorySharedPreferences()
            TotpStore.setTestPreferencesProviderForTests { encrypted }
            assertEquals("Legacy", TotpStore.loadAll(context).single().label)
            assertTrue(legacy.all.isEmpty())
        } finally {
            TotpStore.setTestPreferencesProviderForTests(null)
        }
    }

    @Test
    fun deviceMutationDoesNotOverwriteTableWhileEncryptedStoreUnavailable() {
        val context = InMemoryContext()
        val durable = InMemorySharedPreferences()
        SecurePrefs.setTestProviderForTests { _, _ -> durable }
        try {
            val device = DeviceStore.upsertDevice(
                context = context,
                host = "192.0.2.10",
                port = 19527,
                pairingKey = "pair-key",
                name = "Desktop",
                deviceId = "desktop-a",
                enabled = true
            )
            assertTrue(device.enabled)

            val unavailable = SecurePrefs.unavailablePreferencesForTests()
            SecurePrefs.setTestProviderForTests { _, _ -> unavailable }
            DeviceStore.setDeviceEnabled(context, device.id, false)

            SecurePrefs.setTestProviderForTests { _, _ -> durable }
            assertTrue(DeviceStore.findDevice(context, device.id)!!.enabled)
        } finally {
            SecurePrefs.setTestProviderForTests(null)
        }
    }

    @Test
    fun clipboardAndOutboxDoNotEmptyOverwriteWhileEncryptedStoreUnavailable() {
        val context = InMemoryContext()
        val stores = mutableMapOf<String, InMemorySharedPreferences>()
        SecurePrefs.setTestProviderForTests { _, name -> stores.getOrPut(name) { InMemorySharedPreferences() } }
        try {
            ClipboardHistoryStore.addText(context, "existing", "incoming", "node-a", "Node A", 1L)
            val envelope = JSONObject()
                .put("busVersion", 1)
                .put("messageId", "msg-storage")
                .put("networkId", "net-a")
                .put("topic", ContentBus.Topic.SMS_CODE)
                .put("sourceNodeId", "node-a")
                .put("originNodeId", "node-a")
                .put("payload", JSONObject().put("type", "sms").put("code", "123456"))
            BusReliabilityStore.rememberOutbound(context, envelope, "node-b")
            assertEquals(1, BusReliabilityStore.dueOutbound(context).size)

            val unavailable = SecurePrefs.unavailablePreferencesForTests()
            SecurePrefs.setTestProviderForTests { _, _ -> unavailable }
            ClipboardHistoryStore.addText(context, "replacement", "incoming", "node-b", "Node B", 2L)
            BusReliabilityStore.markDelivered(context, "msg-storage", "node-b")

            SecurePrefs.setTestProviderForTests { _, name -> stores.getOrPut(name) { InMemorySharedPreferences() } }
            assertEquals(listOf("existing"), ClipboardHistoryStore.get(context).map { it.text })
            assertEquals(1, BusReliabilityStore.dueOutbound(context).size)
        } finally {
            SecurePrefs.setTestProviderForTests(null)
        }
    }

    @Test
    fun decryptReadFailureDoesNotTriggerAnyReplacementWrite() {
        val context = InMemoryContext()

        val totpDurable = InMemorySharedPreferences()
        val original = TotpEntry(label = "Existing", secret = "JBSWY3DPEHPK3PXP").withStableId()
        TotpStore.setTestPreferencesProviderForTests { totpDurable }
        TotpStore.add(context, original)
        val failingTotp = ReadFailingPreferences(totpDurable)
        TotpStore.setTestPreferencesProviderForTests { failingTotp }
        TotpStore.add(context, TotpEntry(label = "Replacement", secret = "GEZDGNBVGY3TQOJQ"))
        TotpStore.removeById(context, original.id)
        assertEquals(0, failingTotp.editCalls)
        TotpStore.setTestPreferencesProviderForTests { totpDurable }
        assertEquals(listOf(original.id), TotpStore.loadAll(context).map { it.id })

        val stores = mutableMapOf<String, InMemorySharedPreferences>()
        SecurePrefs.setTestProviderForTests { _, name -> stores.getOrPut(name) { InMemorySharedPreferences() } }
        val device = DeviceStore.upsertDevice(
            context, "192.0.2.30", 19527, "key", "Desktop", "desktop-read-failure", enabled = true
        )
        ClipboardHistoryStore.addText(context, "existing", "incoming", "node-a", "Node A", 1L)
        val envelope = JSONObject()
            .put("busVersion", 1)
            .put("messageId", "msg-read-failure")
            .put("networkId", "net-a")
            .put("topic", ContentBus.Topic.SMS_CODE)
            .put("sourceNodeId", "node-a")
            .put("originNodeId", "node-a")
            .put("payload", JSONObject().put("type", "sms").put("code", "123456"))
        BusReliabilityStore.rememberOutbound(context, envelope, "node-b")
        val deviceFailing = ReadFailingPreferences(stores.getValue("paired_desktop_devices"))
        val historyFailing = ReadFailingPreferences(stores.getValue("clipboard_history"))
        val busFailing = ReadFailingPreferences(stores.getValue("bus_reliability"))
        SecurePrefs.setTestProviderForTests { _, name ->
            when (name) {
                "paired_desktop_devices" -> deviceFailing
                "clipboard_history" -> historyFailing
                "bus_reliability" -> busFailing
                else -> stores.getOrPut(name) { InMemorySharedPreferences() }
            }
        }
        DeviceStore.setDeviceEnabled(context, device.id, false)
        ClipboardHistoryStore.addText(context, "replacement", "incoming", "node-b", "Node B", 2L)
        BusReliabilityStore.markDelivered(context, "msg-read-failure", "node-b")
        assertEquals(0, deviceFailing.editCalls)
        assertEquals(0, historyFailing.editCalls)
        assertEquals(0, busFailing.editCalls)

        SecurePrefs.setTestProviderForTests { _, name -> stores.getOrPut(name) { InMemorySharedPreferences() } }
        assertTrue(DeviceStore.findDevice(context, device.id)!!.enabled)
        assertEquals(listOf("existing"), ClipboardHistoryStore.get(context).map { it.text })
        assertEquals(1, BusReliabilityStore.dueOutbound(context).size)

        TotpStore.setTestPreferencesProviderForTests(null)
        SecurePrefs.setTestProviderForTests(null)
    }
}
