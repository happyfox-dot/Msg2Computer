package com.codesync.service

import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import java.security.MessageDigest
import java.util.Locale

private const val NODE_FILE_TRANSFER_TIMEOUT_MS = 20_000

data class TransferBlock(val index: Int, val from: Long, val to: Long) {
    val length: Long get() = to - from + 1
}

fun buildTransferBlocks(size: Long, chunkSize: Long): List<TransferBlock> {
    val blocks = mutableListOf<TransferBlock>()
    var offset = 0L
    var index = 0
    while (offset < size) {
        val to = minOf(offset + chunkSize - 1, size - 1)
        blocks.add(TransferBlock(index, offset, to))
        offset = to + 1
        index += 1
    }
    return blocks
}

fun loadTransferSidecar(
    sidecarFile: File,
    manifest: JSONObject,
    size: Long,
    chunkSize: Long
): MutableSet<Int> {
    return runCatching {
        if (!sidecarFile.isFile) return@runCatching mutableSetOf()
        val json = JSONObject(sidecarFile.readText(Charsets.UTF_8))
        if (json.optString("fileId") != manifest.optString("fileId")) return@runCatching mutableSetOf()
        if (json.optString("sha256") != manifest.optString("sha256")) return@runCatching mutableSetOf()
        if (json.optLong("size") != size || json.optLong("chunkSize") != chunkSize) {
            return@runCatching mutableSetOf()
        }
        jsonArrayToList(json.optJSONArray("completedBlocks"))
            .mapNotNull { it.toIntOrNull() }
            .toMutableSet()
    }.getOrElse { mutableSetOf() }
}

fun saveTransferSidecar(
    sidecarFile: File,
    manifest: JSONObject,
    size: Long,
    chunkSize: Long,
    completedBlocks: Set<Int>
) {
    runCatching {
        sidecarFile.parentFile?.mkdirs()
        sidecarFile.writeText(
            JSONObject()
                .put("version", 1)
                .put("fileId", manifest.optString("fileId"))
                .put("sha256", manifest.optString("sha256"))
                .put("size", size)
                .put("chunkSize", chunkSize)
                .put("completedBlocks", JSONArray(completedBlocks.sorted()))
                .put("updatedAt", System.currentTimeMillis())
                .toString(),
            Charsets.UTF_8
        )
    }
}

fun completedBlockBytes(blocks: List<TransferBlock>, completedBlocks: Set<Int>): Long =
    completedBlocks.sumOf { index -> blocks.getOrNull(index)?.length ?: 0L }

fun sha256File(file: File): String {
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

fun relativeSubDir(baseDir: File, relativePath: String): File {
    var dir = baseDir
    relativePath.split('/', '\\')
        .dropLast(1)
        .filter { it.isNotBlank() }
        .map { sanitizeFileName(it) }
        .filter { it != "." && it != ".." }
        .take(8)
        .forEach { dir = File(dir, it) }
    return dir
}

fun httpGetBytes(urlText: String): ByteArray {
    val connection = (URL(urlText).openConnection() as HttpURLConnection).apply {
        connectTimeout = NODE_FILE_TRANSFER_TIMEOUT_MS
        readTimeout = NODE_FILE_TRANSFER_TIMEOUT_MS
        requestMethod = "GET"
        useCaches = false
    }
    return try {
        val status = connection.responseCode
        if (status != HttpURLConnection.HTTP_PARTIAL) {
            throw IllegalStateException("HTTP $status")
        }
        connection.inputStream.use { it.readBytes() }
    } finally {
        connection.disconnect()
    }
}

fun sanitizeFileName(name: String): String {
    val clean = name.substringAfterLast('/').substringAfterLast('\\')
        .replace(Regex("[\\\\/\\x00-\\x1F<>:\"|?*]"), "_")
        .trim()
        .take(180)
    return clean.ifBlank { "file" }
}

fun uniqueFile(dir: File, name: String): File {
    val safe = sanitizeFileName(name)
    var candidate = File(dir, safe)
    if (!candidate.exists()) return candidate
    val dot = safe.lastIndexOf('.')
    val stem = if (dot > 0) safe.substring(0, dot) else safe
    val ext = if (dot > 0) safe.substring(dot) else ""
    for (i in 1..9999) {
        candidate = File(dir, "$stem ($i)$ext")
        if (!candidate.exists()) return candidate
    }
    return File(dir, "$stem-${System.currentTimeMillis()}$ext")
}

fun urlEncode(value: String): String =
    URLEncoder.encode(value, Charsets.UTF_8.name())

fun receivedStatusMessage(type: String, sourceName: String): String {
    if (type == "clipboard_text") return "已同步剪贴板文本：$sourceName"
    if (type == "clipboard_image") return "已同步剪贴板图片：$sourceName"
    if (type == "clipboard_file" || type == "file_transfer") return "已接收文件同步请求：$sourceName"
    return when (type) {
        "sms" -> "收到中继验证码：$sourceName"
        "sms_message" -> "收到中继短信：$sourceName"
        "app_notification" -> "收到中继通知：$sourceName"
        "clipboard" -> "已同步剪贴板：$sourceName"
        else -> "收到中继消息：$sourceName"
    }
}



fun sha256Hex(bytes: ByteArray): String {
    return MessageDigest.getInstance("SHA-256")
        .digest(bytes)
        .joinToString("") { "%02x".format(it) }
}

fun formatBytes(size: Long): String {
    if (size <= 0L) return "0 B"
    val units = arrayOf("B", "KB", "MB", "GB")
    var value = size.toDouble()
    var index = 0
    while (value >= 1024.0 && index < units.lastIndex) {
        value /= 1024.0
        index += 1
    }
    return if (index == 0) {
        "$size ${units[index]}"
    } else {
        String.format(Locale.US, "%.1f %s", value, units[index])
    }
}

// gossip 改写只扩展目标到本机授权邻居，绝不重置 relayTtl：入站 TTL 必须
// 一路衰减（转发在 enqueueRelayPayload 里 -1），否则网状拓扑下 TTL 安全网失效，
// 唯一防线退化为去重表，去重表滚动淘汰后旧版本会被重新处理并再次 gossip → 风暴。

private fun jsonArrayToList(array: JSONArray?): List<String> {
    if (array == null) return emptyList()
    return (0 until array.length()).mapNotNull { index ->
        array.optString(index).takeIf { it.isNotBlank() }
    }
}
