package com.codesync.service

import android.util.Log
import org.json.JSONObject
import java.net.Socket

private const val RESPONSE_TAG = "NodeHttpResponses"

fun writeHttpResponse(socket: Socket, code: Int) {
    try {
        val text = if (code in 200..299) "OK" else "ERR"
        val status = when (code) {
            200 -> "200 OK"
            202 -> "202 Accepted"
            400 -> "400 Bad Request"
            403 -> "403 Forbidden"
            else -> "500 Internal Server Error"
        }
        val bytes = text.toByteArray(Charsets.UTF_8)
        val response = "HTTP/1.1 $status\r\n" +
            "Content-Type: text/plain; charset=utf-8\r\n" +
            "Content-Length: ${bytes.size}\r\n" +
            "Connection: close\r\n\r\n"
        socket.getOutputStream().write(response.toByteArray(Charsets.UTF_8))
        socket.getOutputStream().write(bytes)
        socket.getOutputStream().flush()
    } catch (e: Exception) {
        Log.w(RESPONSE_TAG, "Relay response write skipped: ${e.message}")
    }
}

fun writeJsonHttpResponse(socket: Socket, code: Int, body: JSONObject) {
    try {
        val status = when (code) {
            200 -> "200 OK"
            202 -> "202 Accepted"
            400 -> "400 Bad Request"
            403 -> "403 Forbidden"
            404 -> "404 Not Found"
            409 -> "409 Conflict"
            410 -> "410 Gone"
            416 -> "416 Range Not Satisfiable"
            else -> "500 Internal Server Error"
        }
        val bytes = body.toString().toByteArray(Charsets.UTF_8)
        val response = "HTTP/1.1 $status\r\n" +
            "Content-Type: application/json; charset=utf-8\r\n" +
            "Content-Length: ${bytes.size}\r\n" +
            "Connection: close\r\n\r\n"
        socket.getOutputStream().write(response.toByteArray(Charsets.UTF_8))
        socket.getOutputStream().write(bytes)
        socket.getOutputStream().flush()
    } catch (e: Exception) {
        Log.w(RESPONSE_TAG, "JSON response write skipped: ${e.message}")
    }
}

fun writeBinaryHttpResponse(
    socket: Socket,
    code: Int,
    body: ByteArray,
    contentRange: String,
    totalSize: Long
) {
    try {
        val status = when (code) {
            206 -> "206 Partial Content"
            200 -> "200 OK"
            else -> "$code OK"
        }
        val response = "HTTP/1.1 $status\r\n" +
            "Content-Type: application/octet-stream\r\n" +
            "Content-Length: ${body.size}\r\n" +
            "Accept-Ranges: bytes\r\n" +
            "Content-Range: $contentRange\r\n" +
            "X-CodeBridge-File-Size: $totalSize\r\n" +
            "Cache-Control: no-store\r\n" +
            "Connection: close\r\n\r\n"
        socket.getOutputStream().write(response.toByteArray(Charsets.UTF_8))
        socket.getOutputStream().write(body)
        socket.getOutputStream().flush()
    } catch (e: Exception) {
        Log.w(RESPONSE_TAG, "Binary response write skipped: ${e.message}")
    }
}
