package com.codesync.util

import org.junit.Assert.assertTrue
import org.junit.Test
import java.lang.reflect.InvocationTargetException
import java.util.LinkedHashMap
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

class FileTransferRegistryTest {
    @Test
    fun pruneExpiredSynchronizesRecentNonceBuckets() {
        val field = FileTransferRegistry::class.java.getDeclaredField("recentNonces")
        field.isAccessible = true
        @Suppress("UNCHECKED_CAST")
        val recentNonces = field.get(FileTransferRegistry) as ConcurrentHashMap<String, LinkedHashMap<String, Long>>
        recentNonces.clear()

        val bucket = LinkedHashMap<String, Long>(512, 0.75f, true)
        synchronized(bucket) {
            repeat(256) { index -> bucket["expired-$index"] = 0L }
        }
        recentNonces["sender-a"] = bucket

        val prune = FileTransferRegistry::class.java.getDeclaredMethod("pruneExpired")
        prune.isAccessible = true
        val start = CountDownLatch(1)
        val error = AtomicReference<Throwable?>(null)
        val pool = Executors.newFixedThreadPool(4)

        repeat(4) { worker ->
            pool.execute {
                start.await()
                repeat(200) { index ->
                    try {
                        synchronized(bucket) {
                            bucket["live-$worker-$index"] = System.currentTimeMillis()
                        }
                        prune.invoke(FileTransferRegistry)
                    } catch (e: InvocationTargetException) {
                        error.compareAndSet(null, e.targetException)
                    } catch (e: Throwable) {
                        error.compareAndSet(null, e)
                    }
                }
            }
        }

        start.countDown()
        pool.shutdown()

        assertTrue(pool.awaitTermination(5, TimeUnit.SECONDS))
        error.get()?.let { throw AssertionError("pruneExpired threw under concurrent nonce updates", it) }
        recentNonces.clear()
    }
}
