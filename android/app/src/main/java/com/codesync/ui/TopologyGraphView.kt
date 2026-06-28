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
import android.view.MotionEvent
import android.view.ViewConfiguration
import android.view.View
import kotlin.math.max
import kotlin.math.min

/**
 * 设备拓扑图。按本机到其它节点的链路距离分层展示，边按类别配色
 * （推送/中继/TOTP/发现），可携带 metric 与文字标签。点击节点由
 * Activity 展示完整详情。
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
        val discoveredOnly: Boolean = false,
        val local: Boolean = false,
        // 第二行说明文字（地址 / 路由信息），为空时回退为「类型 · 状态」
        val meta: String = ""
    )

    data class Edge(
        val from: String,
        val to: String,
        val label: String,
        val active: Boolean = true,
        // push（验证码推送）/ relay（节点中继路由）/ route（可路由候选）/ totp（种子同步）/ discovery（仅发现）
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
    private var onNodeClick: ((String) -> Unit)? = null
    private var downX = 0f
    private var downY = 0f
    private val touchSlop = ViewConfiguration.get(context).scaledTouchSlop

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

    fun setOnNodeClickListener(listener: ((String) -> Unit)?) {
        onNodeClick = listener
    }

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
        val layers = buildLayers()
        val maxLayerSize = layers.values.maxOfOrNull { it.size } ?: max(1, nodes.size)
        val desiredHeight = dp((72 + maxLayerSize * 76).coerceIn(180, 720).toFloat()).toInt()
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
        val layers = buildLayers()
        if (layers.isEmpty()) return
        val layerKeys = layers.keys.sorted()
        val layerCount = layerKeys.size
        val horizontalPad = dp(12f)
        val columnGap = dp(10f)
        val nodeHeight = dp(58f)
        val availableWidth = (width - horizontalPad * 2 - columnGap * max(0, layerCount - 1)).coerceAtLeast(dp(120f))
        val nodeWidth = min(dp(150f), availableWidth / max(1, layerCount))
        val topPad = dp(8f)
        val rowGap = dp(12f)

        layerKeys.forEachIndexed { layerIndex, layer ->
            val columnNodes = layers[layer].orEmpty()
            val x = if (layerCount == 1) {
                width / 2f - nodeWidth / 2f
            } else {
                horizontalPad + layerIndex * (nodeWidth + columnGap)
            }
            val contentHeight = columnNodes.size * nodeHeight + max(0, columnNodes.size - 1) * rowGap
            val startY = max(topPad, height / 2f - contentHeight / 2f)
            columnNodes.forEachIndexed { rowIndex, node ->
                val y = startY + rowIndex * (nodeHeight + rowGap)
                nodeRects[node.id] = RectF(x, y, x + nodeWidth, y + nodeHeight)
            }
        }
    }

    private fun buildLayers(): Map<Int, List<Node>> {
        if (nodes.isEmpty()) return emptyMap()
        val local = nodes.firstOrNull { it.local } ?: nodes.first()
        val byId = nodes.associateBy { it.id }
        val adjacency = linkedMapOf<String, MutableSet<String>>()
        nodes.forEach { adjacency[it.id] = linkedSetOf() }
        edges
            .filter { it.kind != "discovery" }
            .forEach { edge ->
                if (byId.containsKey(edge.from) && byId.containsKey(edge.to)) {
                    adjacency[edge.from]?.add(edge.to)
                    adjacency[edge.to]?.add(edge.from)
                }
            }

        val distance = linkedMapOf(local.id to 0)
        val queue = ArrayDeque<String>()
        queue.add(local.id)
        while (queue.isNotEmpty()) {
            val current = queue.removeFirst()
            val nextDistance = (distance[current] ?: 0) + 1
            adjacency[current].orEmpty().forEach { next ->
                if (!distance.containsKey(next)) {
                    distance[next] = nextDistance
                    queue.add(next)
                }
            }
        }

        val fallbackLayer = (distance.values.maxOrNull() ?: 0) + 1
        return nodes
            .groupBy { node ->
                when {
                    node.local -> 0
                    node.discoveredOnly -> fallbackLayer
                    else -> distance[node.id] ?: fallbackLayer
                }
            }
            .mapValues { (_, layerNodes) ->
                layerNodes.sortedWith(compareBy<Node> { statusRank(it) }.thenBy { it.name.lowercase() })
            }
    }

    private fun edgeColor(edge: Edge): Int = when {
        edge.kind == "discovery" -> COLOR_IDLE
        edge.kind == "totp" -> COLOR_TOTP
        edge.kind == "route" -> Color.rgb(96, 165, 250)
        !edge.active -> COLOR_IDLE
        edge.kind == "relay" -> COLOR_RELAY
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
        "online" -> COLOR_ACTIVE
        "reachable" -> Color.rgb(96, 165, 250)
        "known" -> if (node.discoveredOnly) COLOR_META else Color.rgb(224, 176, 96)
        "revoked" -> Color.rgb(180, 84, 84)
        "synced" -> COLOR_TOTP
        else -> COLOR_IDLE
    }

    private fun statusText(node: Node): String = when {
        node.status == "known" && node.discoveredOnly -> "仅发现未授权"
        node.status == "online" -> "在线直连"
        node.status == "reachable" -> "近期可达"
        node.status == "known" -> "已知节点"
        node.status == "revoked" -> "已撤销"
        node.status == "enabled" -> "已启用"
        node.status == "disabled" -> "已禁用"
        node.status == "synced" -> "已同步"
        else -> "离线"
    }

    private fun statusRank(node: Node): Int = when {
        node.status == "online" -> 0
        node.status == "reachable" -> 1
        node.status == "known" && !node.discoveredOnly -> 2
        node.status == "synced" -> 3
        node.status == "known" && node.discoveredOnly -> 4
        node.status == "disabled" || node.status == "revoked" -> 5
        else -> 6
    }

    private fun drawNodes(canvas: Canvas) {
        nodes.forEach { node ->
            val rect = nodeRects[node.id] ?: return@forEach
            val accent = statusColor(node)
            nodePaint.color = if (node.local) COLOR_LOCAL_BG else COLOR_NODE_BG
            strokePaint.color = if (node.status == "online" || node.status == "reachable" || node.local) {
                accent
            } else {
                COLOR_NODE_STROKE
            }
            canvas.drawRoundRect(rect, dp(12f), dp(12f), nodePaint)
            canvas.drawRoundRect(rect, dp(12f), dp(12f), strokePaint)

            // 右上角状态点
            dotPaint.color = accent
            canvas.drawCircle(rect.right - dp(11f), rect.top + dp(11f), dp(3.5f), dotPaint)

            val icon = if (node.type.uppercase().contains("PHONE")) "📱" else "💻"
            val title = (if (node.local) "$icon ${node.name} · 本机" else "$icon ${node.name}")
            textPaint.color = COLOR_TEXT
            canvas.drawText(ellipsize(title, 13), rect.left + dp(10f), rect.top + dp(21f), textPaint)

            val meta = node.meta.ifBlank {
                "${if (node.type.uppercase().contains("PHONE")) "手机" else "电脑"} · ${statusText(node)}"
            }
            metaPaint.color = if (node.status == "online" || node.status == "reachable") accent else COLOR_META
            canvas.drawText(ellipsize(meta, 18), rect.left + dp(10f), rect.top + dp(40f), metaPaint)
        }
    }

    override fun onTouchEvent(event: MotionEvent): Boolean {
        when (event.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                downX = event.x
                downY = event.y
                return nodeRects.values.any { it.contains(event.x, event.y) }
            }
            MotionEvent.ACTION_UP -> {
                val moved = kotlin.math.abs(event.x - downX) > touchSlop ||
                    kotlin.math.abs(event.y - downY) > touchSlop
                if (!moved) {
                    val hit = nodeRects.entries.firstOrNull { it.value.contains(event.x, event.y) }?.key
                    if (hit != null) {
                        performClick()
                        onNodeClick?.invoke(hit)
                        return true
                    }
                }
            }
        }
        return super.onTouchEvent(event)
    }

    override fun performClick(): Boolean {
        super.performClick()
        return true
    }

    private fun ellipsize(value: String, maxChars: Int): String {
        val clean = value.ifBlank { "Device" }
        return if (clean.length <= maxChars) clean else clean.take(maxChars - 1) + "…"
    }

    private fun dp(value: Float): Float = value * resources.displayMetrics.density
    private fun sp(value: Float): Float = value * resources.displayMetrics.scaledDensity
}
