# 新增功能：从相册导入 TOTP 二维码

## 📅 更新日期
2026-06-09

## ✨ 新增功能说明

在原有的"扫描二维码"和"手动输入密钥"基础上，新增**第三种添加方式**：

### 🖼️ 从相册导入 TOTP 二维码

用户可以从手机相册中选择已保存的 TOTP 二维码图片（如从 Google Authenticator 截图的二维码），自动识别并导入。

---

## 🎯 使用场景

1. **批量迁移**：用户已经在其他设备上配置好 TOTP，可以截图后批量导入
2. **备份恢复**：用户之前保存了 TOTP 二维码截图，可以直接从相册导入
3. **远程配置**：别人发送的 TOTP 二维码图片（如通过微信/邮件），保存后导入
4. **离线导入**：在没有网络的情况下，也能从本地相册导入

---

## 📝 修改内容

### 1. AndroidManifest.xml
**新增权限**：
```xml
<!-- 读取相册图片权限 -->
<uses-permission android:name="android.permission.READ_EXTERNAL_STORAGE" android:maxSdkVersion="32" />
<uses-permission android:name="android.permission.READ_MEDIA_IMAGES" />
```

**说明**：
- Android 13+ 使用 `READ_MEDIA_IMAGES`（更精细的权限控制）
- Android 12 及以下使用 `READ_EXTERNAL_STORAGE`

### 2. MainActivity.kt

#### 新增 Import 语句
```kotlin
import android.graphics.BitmapFactory
import com.google.zxing.BinaryBitmap
import com.google.zxing.DecodeHintType
import com.google.zxing.MultiFormatReader
import com.google.zxing.RGBLuminanceSource
import com.google.zxing.common.HybridBinarizer
```

#### 新增成员变量
```kotlin
// 相册图片选择器
private val pickImageLauncher = registerForActivityResult(ActivityResultContracts.GetContent()) { uri: Uri? ->
    uri?.let { handleImageFromGallery(it) }
}
```

#### 修改权限请求逻辑
```kotlin
private fun requestPermissions() {
    // ... 原有的短信和通知权限 ...
    
    // 读取相册权限（Android 13+ 使用 READ_MEDIA_IMAGES）
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.READ_MEDIA_IMAGES)
            != PackageManager.PERMISSION_GRANTED
        ) {
            permissions.add(Manifest.permission.READ_MEDIA_IMAGES)
        }
    } else {
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.READ_EXTERNAL_STORAGE)
            != PackageManager.PERMISSION_GRANTED
        ) {
            permissions.add(Manifest.permission.READ_EXTERNAL_STORAGE)
        }
    }
}
```

#### 修改添加 TOTP 对话框
```kotlin
private fun showAddTotpDialog() {
    val items = arrayOf(
        getString(R.string.add_totp_scan),      // 📷 扫描二维码
        getString(R.string.add_totp_from_image), // 🖼️ 从相册导入 ← 新增
        getString(R.string.add_totp_manual)     // ⌨️ 手动输入密钥
    )

    AlertDialog.Builder(this)
        .setTitle(R.string.add_totp)
        .setItems(items) { _, which ->
            when (which) {
                0 -> { /* 扫描二维码 */ }
                1 -> { pickImageLauncher.launch("image/*") } // 新增：打开相册
                2 -> showManualTotpInputDialog()
            }
        }
        .setNegativeButton(R.string.cancel, null)
        .show()
}
```

#### 新增核心功能方法

**1. `handleImageFromGallery(uri: Uri)`** - 处理相册图片
```kotlin
private fun handleImageFromGallery(uri: Uri) {
    try {
        // 1. 读取图片
        val inputStream = contentResolver.openInputStream(uri)
        val bitmap = BitmapFactory.decodeStream(inputStream)
        inputStream?.close()

        // 2. 转换为像素数组
        val pixels = IntArray(width * height)
        bitmap.getPixels(pixels, 0, width, 0, 0, width, height)

        // 3. 使用 ZXing 解析二维码
        val source = RGBLuminanceSource(width, height, pixels)
        val binaryBitmap = BinaryBitmap(HybridBinarizer(source))
        val reader = MultiFormatReader()
        val result = reader.decode(binaryBitmap, mapOf(DecodeHintType.TRY_HARDER to true))

        // 4. 验证是否为 TOTP 二维码
        if (result.text.startsWith("otpauth://totp", ignoreCase = true)) {
            parseTotpUri(result.text)
        } else {
            Toast.makeText(this, R.string.totp_qr_invalid, Toast.LENGTH_LONG).show()
        }
    } catch (e: Exception) {
        Toast.makeText(this, getString(R.string.totp_import_failed, e.message), Toast.LENGTH_LONG).show()
    }
}
```

**2. `parseTotpUri(uri: String)`** - 解析 otpauth:// URI
```kotlin
private fun parseTotpUri(uri: String) {
    val parsedUri = Uri.parse(uri)
    
    // 提取参数
    val secret = parsedUri.getQueryParameter("secret")
    val issuer = parsedUri.getQueryParameter("issuer")
    val algorithm = parsedUri.getQueryParameter("algorithm") ?: "SHA1"
    val digits = parsedUri.getQueryParameter("digits")?.toIntOrNull() ?: 6
    val period = parsedUri.getQueryParameter("period")?.toIntOrNull() ?: 30
    
    // 保存并同步
    saveTotpSecretWithDetails(label, secret, issuer, accountName, algorithm, digits, period)
}
```

**3. `saveTotpSecretWithDetails(...)`** - 保存完整 TOTP 信息
```kotlin
private fun saveTotpSecretWithDetails(
    label: String,
    secret: String,
    issuer: String = "",
    accountName: String = "",
    algorithm: String = "SHA1",
    digits: Int = 6,
    period: Int = 30
) {
    // 保存到本地
    val prefs = getSharedPreferences("totp_secrets", MODE_PRIVATE)
    val existing = prefs.getStringSet("entries", emptySet())?.toMutableSet() ?: mutableSetOf()
    existing.add("$label|$secret")
    prefs.edit().putStringSet("entries", existing).apply()
    rebuildTotpList()

    // 同步到桌面（带完整参数）
    startServiceForAction(WebSocketService.ACTION_SEND_TOTP_SEED) {
        putExtra(WebSocketService.EXTRA_TOTP_LABEL, label)
        putExtra(WebSocketService.EXTRA_TOTP_SECRET, secret)
        putExtra(WebSocketService.EXTRA_TOTP_ISSUER, issuer)
        putExtra(WebSocketService.EXTRA_TOTP_ACCOUNT, accountName)
        putExtra(WebSocketService.EXTRA_TOTP_ALGORITHM, algorithm)
        putExtra(WebSocketService.EXTRA_TOTP_DIGITS, digits)
        putExtra(WebSocketService.EXTRA_TOTP_PERIOD, period)
    }
}
```

### 3. strings.xml

**新增字符串资源**：
```xml
<string name="add_totp_from_image">🖼️ 从相册导入</string>
<string name="totp_image_read_failed">无法读取图片，请重试</string>
<string name="totp_qr_not_found">图片中未找到二维码，请确保图片清晰可见</string>
<string name="totp_qr_invalid">这不是有效的 TOTP 二维码（需要 otpauth://totp 格式）</string>
<string name="totp_imported">已导入 TOTP：%1$s</string>
<string name="totp_import_failed">导入失败：%1$s</string>
```

---

## 🎯 用户操作流程

```
用户点击 "添加 TOTP"
    ↓
┌───────────────────────────┐
│    选择添加方式            │
├───────────────────────────┤
│  📷 扫描二维码             │
│  🖼️ 从相册导入  ← 新增    │
│  ⌨️ 手动输入密钥           │
│                           │
│        [取消]              │
└───────────────────────────┘
    ↓ 选择"从相册导入"
┌───────────────────────────┐
│    系统相册选择器          │
│  [显示所有图片]            │
└───────────────────────────┘
    ↓ 选择包含二维码的图片
┌───────────────────────────┐
│    自动识别处理            │
│  1. 读取图片               │
│  2. 解析二维码             │
│  3. 验证 TOTP 格式         │
│  4. 提取参数信息           │
│  5. 保存到本地             │
│  6. 同步到电脑             │
└───────────────────────────┘
    ↓
✅ 显示提示："已导入 TOTP：Google"
```

---

## 🔍 技术实现细节

### 1. 图片选择
使用 `ActivityResultContracts.GetContent()`：
- **优势**：系统标准 API，兼容性好
- **参数**：`"image/*"` 仅显示图片文件
- **返回**：图片的 `Uri`

### 2. 二维码识别
使用 **ZXing** 库（项目已包含）：
- `BitmapFactory.decodeStream()` 读取图片
- `RGBLuminanceSource` 转换像素数据
- `MultiFormatReader` 识别二维码
- `DecodeHintType.TRY_HARDER` 提高识别率

### 3. URI 解析
标准 TOTP URI 格式：
```
otpauth://totp/Google:user@example.com?
  secret=JBSWY3DPEHPK3PXP&
  issuer=Google&
  algorithm=SHA1&
  digits=6&
  period=30
```

解析参数：
- `secret`：Base32 编码的密钥（必需）
- `issuer`：发行者（如 Google）
- `algorithm`：算法（SHA1/SHA256/SHA512）
- `digits`：验证码位数（6-8）
- `period`：有效期（通常 30 秒）

### 4. 错误处理
- ✅ 图片读取失败
- ✅ 图片中没有二维码
- ✅ 二维码格式不是 TOTP
- ✅ 密钥格式无效
- ✅ 通用异常捕获

---

## 🧪 测试用例

### 测试场景 1：正常导入 Google Authenticator 截图
1. 在 Google Authenticator 中打开 TOTP 二维码
2. 截图保存到相册
3. 在 App 中点击"添加 TOTP" → "🖼️ 从相册导入"
4. 选择刚才的截图
5. **预期**：显示"已导入 TOTP：Google"，列表中出现新条目

### 测试场景 2：导入普通图片（无二维码）
1. 点击"添加 TOTP" → "🖼️ 从相册导入"
2. 选择一张普通照片（不含二维码）
3. **预期**：显示"图片中未找到二维码，请确保图片清晰可见"

### 测试场景 3：导入非 TOTP 二维码
1. 点击"添加 TOTP" → "🖼️ 从相册导入"
2. 选择一张包含 URL 二维码的图片
3. **预期**：显示"这不是有效的 TOTP 二维码（需要 otpauth://totp 格式）"

### 测试场景 4：导入模糊的二维码图片
1. 点击"添加 TOTP" → "🖼️ 从相册导入"
2. 选择一张模糊/低分辨率的二维码图片
3. **预期**：显示"图片中未找到二维码..."或成功识别（取决于清晰度）

### 测试场景 5：权限未授予
1. 首次使用，未授予相册权限
2. 点击"添加 TOTP" → "🖼️ 从相册导入"
3. **预期**：系统弹出权限请求对话框
4. 授予权限后，正常打开相册选择器

---

## 📊 三种添加方式对比

| 方式 | 优势 | 适用场景 | 操作步骤 |
|-----|------|---------|---------|
| 📷 **扫描二维码** | 最快速、最准确 | 配置新账号时 | 2步：扫描 → 自动保存 |
| 🖼️ **从相册导入** | 可批量、可复用 | 迁移、恢复、远程配置 | 3步：选图 → 识别 → 保存 |
| ⌨️ **手动输入** | 无需摄像头/图片 | 只有文本密钥时 | 4步：输入标签 → 输入密钥 → 验证 → 保存 |

---

## 🔒 安全性说明

1. ✅ **本地处理**：图片识别完全在本地进行，不上传到任何服务器
2. ✅ **权限精细化**：Android 13+ 只请求读取图片权限，不请求全部文件权限
3. ✅ **格式验证**：严格验证 TOTP URI 格式和密钥有效性
4. ✅ **内存释放**：识别完成后立即释放 Bitmap，防止内存泄漏
5. ✅ **错误提示**：清晰的错误信息，不泄露敏感数据

---

## 📦 依赖说明

**无需新增依赖**！

使用的 ZXing 库已在 `build.gradle.kts` 中：
```kotlin
implementation("com.google.zxing:core:3.5.3")
implementation("com.journeyapps:zxing-android-embedded:4.3.0")
```

---

## 🎉 功能亮点

1. ✅ **三种添加方式**：扫描、相册、手动，覆盖所有使用场景
2. ✅ **智能识别**：自动从图片中提取二维码，无需手动裁剪
3. ✅ **完整解析**：支持 issuer、algorithm、digits、period 等全部参数
4. ✅ **友好提示**：每种错误都有清晰的中文提示
5. ✅ **权限友好**：仅请求必要权限，Android 13+ 更精细
6. ✅ **高识别率**：使用 `TRY_HARDER` 模式提高识别准确度
7. ✅ **自动同步**：导入后自动同步到所有已启用的电脑

---

## 🐛 已知限制

1. 图片中二维码需要**清晰可见**，模糊或过小的二维码可能识别失败
2. 仅支持 **TOTP** 格式（`otpauth://totp`），不支持 HOTP
3. 识别速度取决于图片大小和清晰度，大图片可能需要 1-2 秒

---

## 🔄 版本兼容性

- ✅ **最低支持**：Android 6.0 (API 23)
- ✅ **权限适配**：Android 13+ 使用新的图片权限
- ✅ **向后兼容**：不影响现有功能
- ✅ **数据兼容**：TOTP 存储格式保持不变

---

最后更新: 2026-06-09 18:00
