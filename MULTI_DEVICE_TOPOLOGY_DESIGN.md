# 多设备互联拓扑网络设计方案

## 📋 需求分析

### 当前架构
- **单向推送**: 手机 → 桌面
- **固定角色**: 手机是发送者，桌面是接收者
- **点对点**: 每个手机只能连接单个桌面

### 目标架构
- **双向推送**: 任意设备 ↔ 任意设备
- **灵活角色**: 每个设备既可以是发送者，也可以是接收者
- **拓扑网络**: 设备之间形成网状拓扑结构
- **智能路由**: 消息可以通过中继节点转发

---

## 🏗️ 架构设计

### 1. 设备模型扩展

```kotlin
data class Device(
    val id: String,                    // 设备唯一 ID
    val name: String,                  // 设备名称
    val type: DeviceType,              // 设备类型
    val role: DeviceRole,              // 设备角色
    val host: String,                  // WebSocket 地址
    val port: Int,                     // WebSocket 端口
    val pairingKey: String,            // 配对密钥
    val capabilities: Set<Capability>, // 设备能力
    val lastSeen: Long,                // 最后在线时间
    val isOnline: Boolean              // 在线状态
)

enum class DeviceType {
    ANDROID_PHONE,    // Android 手机
    IOS_PHONE,        // iOS 手机
    WINDOWS_DESKTOP,  // Windows 桌面
    MAC_DESKTOP,      // Mac 桌面
    LINUX_DESKTOP,    // Linux 桌面
    TABLET,           // 平板
    WEB_BROWSER       // 浏览器
}

enum class DeviceRole {
    SOURCE,           // 仅作为数据源（只发送）
    SINK,             // 仅作为接收端（只接收）
    RELAY,            // 中继节点（转发消息）
    PEER              // 对等节点（发送+接收+转发）
}

enum class Capability {
    SMS_RECEIVE,      // 接收短信
    SMS_SEND,         // 发送短信
    TOTP_GENERATE,    // 生成 TOTP
    TOTP_DISPLAY,     // 显示 TOTP
    MESSAGE_RELAY,    // 消息转发
    QR_SCAN,          // 扫描二维码
    QR_GENERATE       // 生成二维码
}
```

### 2. 拓扑图数据结构

```kotlin
data class TopologyGraph(
    val nodes: Map<String, Device>,           // 设备节点
    val edges: Map<String, Set<String>>,      // 连接关系
    val routes: Map<Pair<String, String>, List<String>> // 路由表
)

class TopologyManager {
    // 添加设备节点
    fun addNode(device: Device)
    
    // 添加设备连接
    fun addEdge(deviceId1: String, deviceId2: String)
    
    // 查找路由路径（BFS/Dijkstra）
    fun findRoute(fromId: String, toId: String): List<String>?
    
    // 获取所有可达设备
    fun getReachableDevices(fromId: String): Set<Device>
    
    // 导出拓扑图
    fun exportGraph(): String
}
```

### 3. 消息路由协议

```kotlin
data class RoutedMessage(
    val id: String,              // 消息 ID
    val type: MessageType,       // 消息类型
    val source: String,          // 源设备 ID
    val destination: String,     // 目标设备 ID
    val path: List<String>,      // 路由路径
    val currentHop: Int,         // 当前跳数
    val maxHops: Int = 10,       // 最大跳数
    val timestamp: Long,         // 时间戳
    val payload: String,         // 消息内容
    val ttl: Int = 300           // 生存时间（秒）
)

enum class MessageType {
    SMS_VERIFICATION,    // 短信验证码
    TOTP_SEED,          // TOTP 密钥
    TOTP_CODE,          // TOTP 验证码
    DEVICE_DISCOVERY,   // 设备发现
    TOPOLOGY_UPDATE,    // 拓扑更新
    HEARTBEAT,          // 心跳
    ACK,                // 确认
    RELAY_REQUEST       // 转发请求
}
```

---

## 🔧 核心功能实现

### 1. 拓扑图管理

```kotlin
class TopologyManagerImpl : TopologyManager {
    
    // 使用 BFS 查找最短路径
    override fun findRoute(fromId: String, toId: String): List<String>? {
        if (fromId == toId) return listOf(fromId)
        
        val visited = mutableSetOf<String>()
        val queue = ArrayDeque<Pair<String, List<String>>>()
        queue.add(fromId to listOf(fromId))
        
        while (queue.isNotEmpty()) {
            val (current, path) = queue.removeFirst()
            if (current in visited) continue
            visited.add(current)
            
            if (current == toId) return path
            
            graph.value.edges[current]?.forEach { neighbor ->
                if (neighbor !in visited) {
                    queue.add(neighbor to path + neighbor)
                }
            }
        }
        
        return null // 无路径
    }
}
```

### 2. 消息路由器

```kotlin
class MessageRouter(
    private val topologyManager: TopologyManager,
    private val deviceId: String
) {
    
    // 发送消息（自动路由）
    suspend fun sendMessage(
        destination: String,
        type: MessageType,
        payload: String
    ): Boolean {
        val route = topologyManager.findRoute(deviceId, destination)
            ?: return false
        
        val message = RoutedMessage(
            id = UUID.randomUUID().toString(),
            type = type,
            source = deviceId,
            destination = destination,
            path = route,
            currentHop = 0,
            timestamp = System.currentTimeMillis(),
            payload = payload
        )
        
        return forwardMessage(message)
    }
    
    // 转发消息
    private suspend fun forwardMessage(message: RoutedMessage): Boolean {
        // 检查 TTL
        if (message.currentHop >= message.maxHops) return false
        
        // 到达目标
        if (message.destination == deviceId) {
            handleMessage(message)
            return true
        }
        
        // 获取下一跳并转发
        val nextHop = message.path.getOrNull(message.currentHop + 1) ?: return false
        val connection = getConnection(nextHop) ?: return false
        val updatedMessage = message.copy(currentHop = message.currentHop + 1)
        
        connection.send(updatedMessage.toJson())
        return true
    }
}
```

### 3. 设备选择 UI

```kotlin
// 显示设备选择对话框
private fun showDeviceSelectionDialog(messageType: MessageType, data: String) {
    val reachableDevices = topologyManager.getReachableDevices(currentDeviceId)
    
    if (reachableDevices.isEmpty()) {
        Toast.makeText(this, "暂无可用设备", Toast.LENGTH_SHORT).show()
        return
    }
    
    val deviceNames = reachableDevices.map { device ->
        "${device.name} (${device.type})" + if (device.isOnline) " ●" else " ○"
    }.toTypedArray()
    
    val selectedDevices = BooleanArray(reachableDevices.size) { false }
    
    AlertDialog.Builder(this)
        .setTitle("选择目标设备")
        .setMultiChoiceItems(deviceNames, selectedDevices) { _, which, isChecked ->
            selectedDevices[which] = isChecked
        }
        .setPositiveButton("发送") { _, _ ->
            val targets = reachableDevices.filterIndexed { index, _ -> 
                selectedDevices[index] 
            }
            sendToMultipleDevices(targets, messageType, data)
        }
        .setNegativeButton("取消", null)
        .show()
}
```

---

## 🎨 UI 设计

### 拓扑图可视化界面

```
┌─────────────────────────────┐
│     设备拓扑                  │
├─────────────────────────────┤
│                             │
│    ┌──────┐                 │
│    │小米13 │──┐              │
│    └──────┘  │              │
│              ▼              │
│         ┌─────────┐         │
│         │桌面电脑  │         │
│         └─────────┘         │
│              │              │
│              ▼              │
│         ┌─────────┐         │
│         │平板设备  │         │
│         └─────────┘         │
│                             │
├─────────────────────────────┤
│ 已连接设备 (3)               │
├─────────────────────────────┤
│ ┌─┬──────────────┬────┬──┐ │
│ │●│ 小米 13      │发送│⋯ │ │
│ │ │ Android 手机  │    │  │ │
│ │ │ 在线・刚刚    │    │  │ │
│ └─┴──────────────┴────┴──┘ │
│ ┌─┬──────────────┬────┬──┐ │
│ │●│ Windows PC   │发送│⋯ │ │
│ │ │ 桌面电脑      │    │  │ │
│ │ │ 在线・刚刚    │    │  │ │
│ └─┴──────────────┴────┴──┘ │
│ ┌─┬──────────────┬────┬──┐ │
│ │○│ iPad Pro     │发送│⋯ │ │
│ │ │ 平板设备      │    │  │ │
│ │ │ 离线・5分钟前 │    │  │ │
│ └─┴──────────────┴────┴──┘ │
├─────────────────────────────┤
│ [添加设备] [刷新] [导出]     │
└─────────────────────────────┘
```

---

## 🚀 实施计划

### Phase 1: 基础架构（1-2周）
- [ ] 扩展 Device 数据模型
- [ ] 实现 TopologyGraph 和 TopologyManager
- [ ] 实现路由算法（BFS）

### Phase 2: 核心功能（2-3周）
- [ ] 实现 MessageRouter
- [ ] 实现设备发现（mDNS）
- [ ] 实现消息转发逻辑

### Phase 3: UI 开发（1-2周）
- [ ] 设备选择对话框
- [ ] 拓扑图可视化
- [ ] 设备管理界面

### Phase 4: 测试与优化（1-2周）
- [ ] 单元测试
- [ ] 多设备集成测试
- [ ] 性能优化

---

**总工时估计: 6-9 周**

需要立即开始实现吗？
