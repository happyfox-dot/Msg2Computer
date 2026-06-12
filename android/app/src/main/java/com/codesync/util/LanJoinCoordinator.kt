package com.codesync.util

import android.content.Context
import android.content.Intent
import com.codesync.MainActivity
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.withTimeoutOrNull
import org.json.JSONObject
import java.util.concurrent.ConcurrentHashMap

data class LanJoinDecision(
    val accepted: Boolean,
    val template: String = "basic"
)

data class PendingLanJoinRequest(
    val requestId: String,
    val nodeId: String,
    val nodeName: String,
    val nodeType: String,
    val host: String,
    val port: Int,
    val joinPort: Int,
    val fingerprint: String,
    val capabilities: JSONObject,
    val networkId: String,
    val requestedContentPolicy: JSONObject
)

object LanJoinCoordinator {
    const val ACTION_JOIN_REQUEST = "com.codesync.LAN_JOIN_REQUEST"
    const val EXTRA_REQUEST_ID = "request_id"

    private val pending = ConcurrentHashMap<String, Pair<PendingLanJoinRequest, CompletableDeferred<LanJoinDecision>>>()

    suspend fun requestApproval(context: Context, request: PendingLanJoinRequest): LanJoinDecision {
        val deferred = CompletableDeferred<LanJoinDecision>()
        pending[request.requestId] = request to deferred
        val intent = Intent(context, MainActivity::class.java).apply {
            action = ACTION_JOIN_REQUEST
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
            putExtra(EXTRA_REQUEST_ID, request.requestId)
        }
        context.startActivity(intent)
        context.sendBroadcast(Intent(ACTION_JOIN_REQUEST).apply {
            setPackage(context.packageName)
            putExtra(EXTRA_REQUEST_ID, request.requestId)
        })
        val decision = withTimeoutOrNull(120000L) { deferred.await() } ?: LanJoinDecision(false)
        pending.remove(request.requestId)
        return decision
    }

    fun getPending(requestId: String): PendingLanJoinRequest? =
        pending[requestId]?.first

    fun respond(requestId: String, accepted: Boolean, template: String = "basic"): Boolean {
        val entry = pending.remove(requestId) ?: return false
        entry.second.complete(LanJoinDecision(accepted, template))
        return true
    }
}
