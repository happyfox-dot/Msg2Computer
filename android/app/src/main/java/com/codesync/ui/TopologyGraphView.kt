package com.codesync.ui

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.DashPathEffect
import android.graphics.Paint
import android.graphics.Path
import android.graphics.PathMeasure
import android.graphics.RectF
import android.util.AttributeSet
import android.view.View
import kotlin.math.max
import kotlin.math.min

/**
 * 设备拓扑图。本机节点在左侧居中，远端节点按状态排序后排在右列；
 * 边按类别配色（推送/中继/TOTP/发现），可携带 metric 与文字标签，
 * 非活跃边画虚线。布局与绘制都很轻量，节点数 < 20 时无性能压力。
 */
class TopologyGraphView @JvmOverloads constructor(
    context: Context,
    attrs: AttributeSet? = null,
    defStyleAttr: Int = 0
) : View(context, attrs, defStyleAttr) {

    data class Node(
        val id: String,
        val name: String,
        val type: String,
        val status: String,
        val local: Boolean = false,
        // 第二行说明文字（地址 / 路由信息），为空时回退为「类型 · 状态」
        val meta: String = ""
    )

    data class Edge(
        val from: String,
        val to: String,
        val label: String,
        val active: Boolean = true,
        // push（验证码推送）/ relay（节点中继路由）/ totp（种子同步）/ discovery（仅发现）
        val kind: String = "push",
        // SPF metric，>0 时附加显示在边标签上
        val metric: Int = 0
    )

    private companion object {
        val COLOR_ACTIVE = Color.rgb(92, 219, 139)
        val COLOR_RELAY = Color.rgb(192, 132, 252)
        val COLOR_TOTP = Color.rgb(251, 191, 36)
        val COLOR_IDLE = Color.rgb(110, 110, 122)
        val COLOR_TEXT = Color.rgb(236, 236, 242)
        val COLOR_META = Color.rgb(154, 154, 164)
        val COLOR_NODE_BG = Color.rgb(42, 42, 56)
        val COLOR_LOCAL_BG = Color.rgb(44, 50, 112)
        val COLOR_NODE_STROKE = Color.rgb(58, 58, 72)
        val COLOR_LABEL_BG = Color.argb(225, 26, 27, 38)
    }

    private val nodes = mutableListOf<Node>()
    private val edges = mutableListOf<Edge>()
    private val nodeRects = mutableMapOf<String, RectF>()
    private val dashEffect = DashPathEffect(floatArrayOf(dp(6f), dp(5f)), 0f)

    private val linePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        strokeWidth = dp(2.2f)
        strokeCap = Paint.Cap.ROUND
    }
    private val nodePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.FILL }
    private val strokePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        strokeWidth = dp(1.2f)
    }
    private val textPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = COLOR_TEXT
        textSize = sp(12f)
        isFakeBoldText = true
    }
    private val metaPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = COLOR_META
        textSize = sp(10f)
    }
    private val edgeLabelPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        textSize = sp(9f)
        textAlign = Paint.Align.CENTER
    }
    private val edgeLabelBgPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.FILL
        color = COLOR_LABEL_BG
    }
    private val dotPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.FILL }
    fun setGraph(newNodes: List<Node>, newEdges: List<Edge>) {
        nodes.clear()
        nodes.addAll(newNodes.distinctBy { it.id })
        edges.clear()
        val mergedEdges = linkedMapOf<String, Edge>()
        newEdges.forEach { edge ->
            val endpoints = listOf(edge.from, edge.to).sorted()
            val key = "${endpoints[0]}--${endpoints[1]}:${edge.kind}:${edge.label}"
            val existing = mergedEdges[key]
            mergedEdges[key] = if (existing == null) {
                edge
            } else {
                existing.copy(
                    active = existing.active || edge.active,
                    metric = listOf(existing.metric, edge.metric)
                        .filter { it > 0 }
                        .minOrNull() ?: max(existing.metric, edge.metric)
                )
            }
        }
        edges.addAll(mergedEdges.values)
        requestLayout()
        invalidate()
    }

    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
        val width = MeasureSpec.getSize(widthMeasureSpec)
        val remoteCount = max(1, nodes.count { !it.local })
        val desiredHeight = dp((140 + remoteCount * 66).coerceAtMost(520).toFloat()).toInt()
        setMeasuredDimension(width, resolveSize(desiredHeight, heightMeasureSpec))
    }

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        if (nodes.isEmpty()) {
            metaPaint.textAlign = Paint.Align.CENTER
            canvas.drawText("暂无拓扑节点", width / 2f, height / 2f, metaPaint)
            metaPaint.textAlign = Paint.Align.LEFT
            return
        }

        layoutNodes()
        drawEdges(canvas)
        drawNodes(canvas)
    }

    private fun layoutNodes() {
        nodeRects.clear()
        val nodeWidth = min(dp(140f), width * 0.42f)
        val nodeHeight = dp(54f)
        val local = nodes.firstOrNull { it.local } ?: nodes.first()
        val localX = dp(12f)
        val localY = height / 2f - nodeHeight / 2f
        nodeRects[local.id] = RectF(localX, localY, localX + nodeWidth, localY + nodeHeight)

        // 在线/启用的节点排在上面，离线和仅发现的排在下面
        val remotes = nodes.filter { it.id != local.id }
            .sortedWith(
                compareByDescending<Node> { it.status == "online" || it.status == "enabled" }
                    .thenBy { it.status == "discovered" }
                    .thenBy { it.name.lowercase() }
            )
        if (remotes.isEmpty()) return

        val rightX = width - nodeWidth - dp(12f)
        val topPad = dp(8f)
        val gap = if (remotes.size == 1) 0f else (height - nodeHeight - topPad * 2) / (remotes.size - 1)
        remotes.forEachIndexed { index, node ->
            val y = if (remotes.size == 1) {
                height / 2f - nodeHeight / 2f
            } else {
                topPad + index * gap
            }
            nodeRects[node.id] = RectF(rightX, y, rightX + nodeWidth, y + nodeHeight)
        }
    }

    private fun edgeColor(edge: Edge): Int = when {
        !edge.active -> COLOR_IDLE
        edge.kind == "relay" -> COLOR_RELAY
        edge.kind == "totp" -> COLOR_TOTP
        edge.kind == "discovery" -> COLOR_IDLE
        else -> COLOR_ACTIVE
    }

    private fun drawEdges(canvas: Canvas) {
        edges.forEach { edge ->
            val from = nodeRects[edge.from] ?: return@forEach
            val to = nodeRects[edge.to] ?: return@forEach
            val color = edgeColor(edge)
            val dashed = !edge.active || edge.kind == "discovery"
            linePaint.color = color
            linePaint.alpha = if (edge.active) 215 else 105
            linePaint.pathEffect = if (dashed) dashEffect else null

            // 起止点取左右节点的相向边缘中点，三次贝塞尔画平滑连线
            val fromIsLeft = from.centerX() <= to.centerX()
            val startX = if (fromIsLeft) from.right else from.left
            val endX = if (fromIsLeft) to.left else to.right
            val startY = from.centerY()
            val endY = to.centerY()
            val controlOffset = max(dp(40f), kotlin.math.abs(endX - startX) * 0.42f) *
                (if (fromIsLeft) 1f else -1f)
            val path = Path().apply {
                moveTo(startX, startY)
                cubicTo(startX + controlOffset, startY, endX - controlOffset, endY, endX, endY)
            }
            canvas.drawPath(path, linePaint)
            linePaint.pathEffect = null
            drawEdgeLabel(canvas, path, edge, color)
        }
    }

    private fun drawEdgeLabel(canvas: Canvas, path: Path, edge: Edge, color: Int) {
        val text = buildString {
            append(edge.label)
            if (edge.metric > 0) append("  m=").append(edge.metric)
        }.trim()
        if (text.isEmpty()) return

        // 标签锚在贝塞尔曲线 45% 处（避开两端节点和中点处的交叉重叠）
        val measure = PathMeasure(path, false)
        val pos = FloatArray(2)
        if (!measure.getPosTan(measure.length * 0.45f, pos, null)) return

        val textWidth = edgeLabelPaint.measureText(text)
        val padH = dp(5f)
        val padV = dp(3f)
        val bg = RectF(
            pos[0] - textWidth / 2 - padH,
            pos[1] - sp(9f) / 2 - padV - dp(1.5f),
            pos[0] + textWidth / 2 + padH,
            pos[1] + sp(9f) / 2 + padV
        )
        canvas.drawRoundRect(bg, dp(6f), dp(6f), edgeLabelBgPaint)
        edgeLabelPaint.color = color
        canvas.drawText(text, pos[0], pos[1] + sp(9f) * 0.32f, edgeLabelPaint)
    }

    private fun statusColor(node: Node): Int = when (node.status) {
        "online", "enabled" -> COLOR_ACTIVE
        "synced" -> COLOR_TOTP
        "discovered" -> COLOR_META
        else -> COLOR_IDLE
    }

    private fun statusText(status: String): String = when (status) {
        "online" -> "在线"
        "enabled" -> "已启用"
        "disabled" -> "已禁用"
        "synced" -> "已同步"
        "discovered" -> "已发现"
        else -> "离线"
    }

    private fun drawNodes(canvas: Canvas) {
        nodes.forEach { node ->
            val rect = nodeRects[node.id] ?: return@forEach
            val accent = statusColor(node)
            nodePaint.color = if (node.local) COLOR_LOCAL_BG else COLOR_NODE_BG
            strokePaint.color = if (node.status == "online" || node.status == "enabled" || node.local) {
                accent
            } else {
                COLOR_NODE_STROKE
            }
            canvas.drawRoundRect(rect, dp(14f), dp(14f), nodePaint)
            canvas.drawRoundRect(rect, dp(14f), dp(14f), strokePaint)

            // 右上角状态点
            dotPaint.color = accent
            canvas.drawCircle(rect.right - dp(11f), rect.top + dp(11f), dp(3.5f), dotPaint)

            val icon = if (node.type.uppercase().contains("PHONE")) "📱" else "💻"
            val title = (if (node.local) "$icon ${node.name} · 本机" else "$icon ${node.name}")
            textPaint.color = COLOR_TEXT
            canvas.drawText(ellipsize(title, 14), rect.left + dp(11f), rect.top + dp(20f), textPaint)

            val meta = node.meta.ifBlank {
                "${if (node.type.uppercase().contains("PHONE")) "手机" else "电脑"} · ${statusText(node.status)}"
            }
            metaPaint.color = if (node.status == "online" || node.status == "enabled") accent else COLOR_META
            canvas.drawText(ellipsize(meta, 18), rect.left + dp(11f), rect.top + dp(38f), metaPaint)
        }
    }

    private fun ellipsize(value: String, maxChars: Int): String {
        val clean = value.ifBlank { "Device" }
        return if (clean.length <= maxChars) clean else clean.take(maxChars - 1) + "…"
    }

    private fun dp(value: Float): Float = value * resources.displayMetrics.density
    private fun sp(value: Float): Float = value * resources.displayMetrics.scaledDensity
}
