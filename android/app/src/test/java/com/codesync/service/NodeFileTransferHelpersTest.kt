package com.codesync.service

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.util.Collections
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

class NodeFileTransferHelpersTest {
    @get:Rule
    val temporaryFolder = TemporaryFolder()

    @Test
    fun concurrentPublishesWithSameNameKeepEveryFile() {
        val dir = temporaryFolder.newFolder("downloads")
        val existing = File(dir, "report.txt").apply { writeText("existing") }
        val count = 24
        val parts = (0 until count).map { index ->
            File(dir, "transfer-$index.part").apply { writeText("payload-$index") }
        }
        val start = CountDownLatch(1)
        val pool = Executors.newFixedThreadPool(8)
        val published = Collections.synchronizedList(mutableListOf<File>())
        val failures = Collections.synchronizedList(mutableListOf<Throwable>())

        parts.forEach { part ->
            pool.execute {
                try {
                    start.await()
                    published += publishReceivedFile(part, dir, "report.txt")
                } catch (error: Throwable) {
                    failures += error
                }
            }
        }

        start.countDown()
        pool.shutdown()

        assertTrue("publish workers timed out", pool.awaitTermination(10, TimeUnit.SECONDS))
        assertTrue("publish failed: $failures", failures.isEmpty())
        assertEquals(count, published.size)
        assertEquals(count, published.map { it.canonicalPath }.toSet().size)
        assertEquals("existing", existing.readText())
        assertEquals(
            (0 until count).map { "payload-$it" }.toSet(),
            published.map { it.readText() }.toSet()
        )
        assertTrue(published.all { it.isFile })
        assertTrue(parts.all { !it.exists() })
    }

    @Test
    fun publishDoesNotReplaceAnExistingDestination() {
        val dir = temporaryFolder.newFolder("existing-destination")
        val existing = File(dir, "photo.jpg").apply { writeText("original") }
        val part = File(dir, "incoming.part").apply { writeText("incoming") }

        val published = publishReceivedFile(part, dir, "photo.jpg")

        assertEquals("original", existing.readText())
        assertEquals("photo (1).jpg", published.name)
        assertEquals("incoming", published.readText())
        assertFalse(part.exists())
    }
}
