package com.codesync.util

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ApkUpdaterTest {

    @Test
    fun `selects only the exact release apk even when debug apk is first`() {
        val assets = JSONArray()
            .put(asset("app-debug.apk", "https://example.test/app-debug.apk"))
            .put(asset("Msg2Computer-Android-1.0.51.apk", "https://example.test/release.apk"))

        assertEquals(
            "https://example.test/release.apk",
            ApkUpdater.findReleaseApkUrl("1.0.51", assets)
        )
    }

    @Test
    fun `rejects debug unsigned and different-version apk assets`() {
        val assets = JSONArray()
            .put(asset("Msg2Computer-Android-1.0.51-debug.apk", "https://example.test/debug.apk"))
            .put(asset("Msg2Computer-Android-1.0.51-unsigned.apk", "https://example.test/unsigned.apk"))
            .put(asset("Msg2Computer-Android-1.0.50.apk", "https://example.test/old.apk"))

        assertNull(ApkUpdater.findReleaseApkUrl("1.0.51", assets))
    }

    @Test
    fun `rejects an exact asset without a download url`() {
        val assets = JSONArray().put(asset("Msg2Computer-Android-1.0.51.apk", "  "))

        assertNull(ApkUpdater.findReleaseApkUrl("1.0.51", assets))
    }

    private fun asset(name: String, url: String): JSONObject =
        JSONObject()
            .put("name", name)
            .put("browser_download_url", url)
}
