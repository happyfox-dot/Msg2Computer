package com.codesync.util

import org.junit.Assert.assertFalse
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class NotificationAppPolicyTest {
    @Test
    fun defaultPolicyAllowsNormalAndBlocksOngoingNotifications() {
        val context = InMemoryContext()
        SettingsStore.setSendNotificationsEnabled(context, true)

        assertTrue(
            SettingsStore.isNotificationPackageAllowed(
                context,
                "com.example.normal",
                ongoing = false
            )
        )
        assertFalse(
            SettingsStore.isNotificationPackageAllowed(
                context,
                "com.example.normal",
                ongoing = true
            )
        )
    }

    @Test
    fun perAppPolicyCanDisableNormalAndEnableOngoingNotifications() {
        val context = InMemoryContext()
        SettingsStore.setSendNotificationsEnabled(context, true)

        SettingsStore.setNotificationAppPolicy(
            context,
            SettingsStore.NotificationAppPolicy(
                packageName = "com.example.monitor",
                allowNormal = false,
                allowOngoing = true
            )
        )

        assertFalse(
            SettingsStore.isNotificationPackageAllowed(
                context,
                "com.example.monitor",
                ongoing = false
            )
        )
        assertTrue(
            SettingsStore.isNotificationPackageAllowed(
                context,
                "com.example.monitor",
                ongoing = true
            )
        )
    }

    @Test
    fun globalNotificationSwitchStillBlocksEveryApp() {
        val context = InMemoryContext()
        SettingsStore.setSendNotificationsEnabled(context, false)
        SettingsStore.setNotificationAppPolicy(
            context,
            SettingsStore.NotificationAppPolicy(
                packageName = "com.example.monitor",
                allowNormal = true,
                allowOngoing = true
            )
        )

        assertFalse(
            SettingsStore.isNotificationPackageAllowed(
                context,
                "com.example.monitor",
                ongoing = false
            )
        )
        assertFalse(
            SettingsStore.isNotificationPackageAllowed(
                context,
                "com.example.monitor",
                ongoing = true
            )
        )
    }

    @Test
    fun notificationRemovalUsesNotificationReceivePolicy() {
        val context = InMemoryContext()

        SettingsStore.setReceiveNotificationsEnabled(context, true)
        assertTrue(SettingsStore.shouldReceiveContent(context, "app_notification_removed"))

        SettingsStore.setReceiveNotificationsEnabled(context, false)
        assertFalse(SettingsStore.shouldReceiveContent(context, "app_notification_removed"))
        assertEquals("app_notification", PolicyManager.normalizeType("app_notification_removed"))
    }
}
