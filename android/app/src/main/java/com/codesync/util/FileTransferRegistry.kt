package com.codesync.util

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.RandomAccessFile
import java.security.MessageDigest
import java.util.LinkedHashMap
import java.util.Locale
import java.util.concurrent.ConcurrentHashMap

object FileTransferRegistry {
    private const val CHUNK_BYTES = 1024 * 1024
    private const val OFFER_TTL_MS = 30 * 60 * 1000L
    private const val NONCE_TTL_MS = 5 * 60 * 1000L
    private const val NONCE_LIMIT = 500

    data class ChunkResponse(
        val status: Int,
        val body: ByteArray? = null,
        val contentRange: String = "",
        val totalSize: Long = 0L
    )

    private data class OutgoingTransfer(
        val file: File,
        val name: String,
        val mime: String,
        val size: Long,
        val sha256: String,
        val chunkSize: Int,
        val expiresAt: Long,
        val targetDeviceIds: Set<String>
    )

    private val outgoingTransfers = ConcurrentHashMap<String, OutgoingTransfer>()
    private val recentNonces = ConcurrentHashMap<String, LinkedHashMap<String, Long>>()

    fun registerOutgoingFile(
        file: File,
        name: String,
        mime: String,
        identity: PhoneIdentity,
        targetDeviceIds: List<String>,
        host: String,
        relayPort: Int,
        tsHost: String = "",
        altHosts: List<String> = emptyList(),
        relativePath: String = ""
    ): JSONObject {
        pruneExpired()
        require(file.isFile && file.length() > 0L) { "invalid_file" }
        val now = System.currentTimeMillis()
        val sha256 = sha256File(file)
        val fileId = "file-${identity.id}-$now-${sha256.take(24)}"
        val targets = targetDeviceIds.map { it.trim() }.filter { it.isNotBlank() }.toSet()
        val record = OutgoingTransfer(
            file = file,
            name = sanitizeFileName(name.ifBlank { file.name }),
            mime = mime.ifBlank { "application/octet-stream" },
            size = file.length(),
            sha256 = sha256,
            chunkSize = CHUNK_BYTES,
            expiresAt = now + OFFER_TTL_MS,
            targetDeviceIds = targets
        )
        outgoingTransfers[fileId] = record
        return JSONObject()
            .put("fileId", fileId)
            .put("name", record.name)
            .put("mime", record.mime)
            .put("size", record.size)
            .put("sha256", record.sha256)
            .put("chunkSize", record.chunkSize)
            .put("originDeviceId", identity.id)
            .put("originDeviceName", identity.name)
            .put("host", host)
            .put("tsHost", tsHost)
            .put("altHosts", JSONArray(altHosts.map { it.trim() }.filter { it.isNotBlank() && it != host }.distinct()))
            .put("relayPort", relayPort)
            .put("targetDeviceIds", JSONArray(targets.toList()))
            .put("expiresAt", record.expiresAt)
            .put("inline", false)
            .apply {
                // 目录分享：相对路径（含文件名）随 manifest 下发，接收端消毒后重建目录树
                if (relativePath.isNotBlank()) put("relativePath", relativePath)
            }
    }

    fun serveChunk(
        context: Context,
        fileId: String,
        fromRaw: String?,
        toRaw: String?,
        senderId: String?,
        nonce: String?,
        authToken: String?
    ): ChunkResponse {
        pruneExpired()
        val transfer = outgoingTransfers[fileId] ?: return ChunkResponse(404)
        if (System.currentTimeMillis() > transfer.expiresAt) {
            outgoingTransfers.remove(fileId)
            return ChunkResponse(410)
        }
        val requester = senderId.orEmpty().trim()
        if (requester.isBlank()) return ChunkResponse(403)
        if (transfer.targetDeviceIds.isNotEmpty() && requester !in transfer.targetDeviceIds) {
            return ChunkResponse(403)
        }
        if (DeviceStore.findDevice(context, requester) == null) return ChunkResponse(403)
        val sourceKey = PhoneIdentityStore.get(context).pairingKey

        val from = fromRaw?.toLongOrNull() ?: return ChunkResponse(400)
        val to = toRaw?.toLongOrNull() ?: return ChunkResponse(400)
        if (from < 0L || to < from || from >= transfer.size) return ChunkResponse(416)
        val clampedTo = minOf(to, transfer.size - 1)
        val length = clampedTo - from + 1
        if (length <= 0L || length > transfer.chunkSize) return ChunkResponse(400)

        val safeNonce = nonce.orEmpty()
        val expected = CryptoUtil.hmacSha256Base64(sourceKey, "$requester|$safeNonce|$fileId|$from-$clampedTo")
        if (!MessageDigest.isEqual(
                expected.toByteArray(Charsets.UTF_8),
                authToken.orEmpty().toByteArray(Charsets.UTF_8)
            )
        ) {
            return ChunkResponse(403)
        }
        if (isReplayNonce(requester, safeNonce)) return ChunkResponse(409)

        val plain = ByteArray(length.toInt())
        RandomAccessFile(transfer.file, "r").use { raf ->
            raf.seek(from)
            raf.readFully(plain)
        }
        val encrypted = CryptoUtil.encryptBytes(plain, sourceKey)
        return ChunkResponse(
            status = 206,
            body = encrypted,
            contentRange = "bytes $from-$clampedTo/${transfer.size}",
            totalSize = transfer.size
        )
    }

    private fun pruneExpired() {
        val now = System.currentTimeMillis()
        outgoingTransfers.entries.removeIf { now > it.value.expiresAt }
        recentNonces.values.forEach { seen ->
            val iterator = seen.entries.iterator()
            while (iterator.hasNext()) {
                if (now - iterator.next().value > NONCE_TTL_MS) iterator.remove()
            }
        }
    }

    private fun isReplayNonce(senderId: String, nonce: String): Boolean {
        if (nonce.isBlank()) return true
        val now = System.currentTimeMillis()
        val seen = recentNonces.getOrPut(senderId) {
            object : LinkedHashMap<String, Long>(NONCE_LIMIT + 1, 0.75f, true) {
                override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, Long>?): Boolean {
                    return size > NONCE_LIMIT
                }
            }
        }
        synchronized(seen) {
            val iterator = seen.entries.iterator()
            while (iterator.hasNext()) {
                if (now - iterator.next().value > NONCE_TTL_MS) iterator.remove()
            }
            if (seen.containsKey(nonce)) return true
            seen[nonce] = now
            return false
        }
    }

    private fun sha256File(file: File): String {
        val digest = MessageDigest.getInstance("SHA-256")
        file.inputStream().use { input ->
            val buffer = ByteArray(128 * 1024)
            while (true) {
                val read = input.read(buffer)
                if (read <= 0) break
                digest.update(buffer, 0, read)
            }
        }
        return digest.digest().joinToString("") { "%02x".format(it) }
    }

    private fun sanitizeFileName(name: String): String {
        val base = name.substringAfterLast('/').substringAfterLast('\\')
        return base
            .replace(Regex("[\\\\/\\x00-\\x1F<>:\"|?*]"), "_")
            .trim()
            .take(180)
            .ifBlank { "file" }
    }

    fun guessMime(name: String): String {
        return when (name.substringAfterLast('.', "").lowercase(Locale.ROOT)) {
            "png" -> "image/png"
            "jpg", "jpeg" -> "image/jpeg"
            "gif" -> "image/gif"
            "webp" -> "image/webp"
            "pdf" -> "application/pdf"
            "txt", "md" -> "text/plain"
            "zip" -> "application/zip"
            "json" -> "application/json"
            "mp4" -> "video/mp4"
            "mp3" -> "audio/mpeg"
            "doc" -> "application/msword"
            "docx" -> "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
            "xls" -> "application/vnd.ms-excel"
            "xlsx" -> "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            else -> "application/octet-stream"
        }
    }
}
