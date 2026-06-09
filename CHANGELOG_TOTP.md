# 代码修改摘要

## 修改日期
2026-06-09

## 修改目的
为手机端 TOTP 功能添加双入口支持：扫描二维码 + 手动输入密钥

---

## 修改文件清单

### 1. MainActivity.kt
**文件路径**: `android/app/src/main/java/com/codesync/MainActivity.kt`

**修改位置**: 第 345-404 行

**修改前**:
```kotlin
private fun showAddTotpDialog() {
    // 直接显示手动输入对话框
    val secretInput = ...
    val labelInput = ...
    AlertDialog.Builder(this)
        .setTitle(R.string.add_totp)
        .setView(layout)
        .setPositiveButton(R.string.save) { _, _ ->
            val secret = secretInput.text?.toString()?.trim()?.replace(" ", "") ?: ""
            val label = labelInput.text?.toString()?.trim()?.takeIf { it.isNotEmpty() } ?: "TOTP"
            if (secret.isNotEmpty()) {
                saveTotpSecret(label, secret)
            }
        }
        .setNegativeButton(R.string.cancel, null)
        .show()
}
```

**修改后**:
```kotlin
private fun showAddTotpDialog() {
    // 显示选择对话框：扫描二维码 or 手动输入
    val items = arrayOf(
        getString(R.string.add_totp_scan),      // 📷 扫描二维码
        getString(R.string.add_totp_manual)     // ⌨️ 手动输入密钥
    )
    AlertDialog.Builder(this)
        .setTitle(R.string.add_totp)
        .setItems(items) { _, which ->
            when (which) {
                0 -> {
                    // 扫描二维码，传递参数标记为仅扫 TOTP
                    val intent = Intent(this, QRScannerActivity::class.java).apply {
                        putExtra(QRScannerActivity.EXTRA_SCAN_TOTP_ONLY, true)
                    }
                    startActivity(intent)
                }
                1 -> showManualTotpInputDialog()  // 手动输入
            }
        }
        .setNegativeButton(R.string.cancel, null)
        .show()
}

// 新增方法
private fun showManualTotpInputDialog() {
    val secretInput = com.google.android.material.textfield.TextInputEditText(this).apply {
        hint = getString(R.string.totp_secret_hint)
        inputType = android.text.InputType.TYPE_CLASS_TEXT or
                    android.text.InputType.TYPE_TEXT_FLAG_CAP_CHARACTERS or
                    android.text.InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS
    }
    val labelInput = com.google.android.material.textfield.TextInputEditText(this).apply {
        hint = getString(R.string.totp_label_hint)
        inputType = android.text.InputType.TYPE_CLASS_TEXT or
                    android.text.InputType.TYPE_TEXT_FLAG_CAP_SENTENCES
    }

    val layout = LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL
        setPadding(40, 20, 40, 10)
        addView(labelInput.apply {
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
            ).apply { bottomMargin = 16 }
        })
        addView(secretInput.apply {
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
            )
        })
    }

    AlertDialog.Builder(this)
        .setTitle(R.string.add_totp_manual)
        .setView(layout)
        .setPositiveButton(R.string.save) { _, _ ->
            // 增强的输入处理和验证
            val secret = secretInput.text?.toString()
                ?.trim()
                ?.uppercase()           // 转大写
                ?.replace(" ", "")      // 去空格
                ?.replace("-", "") ?: ""  // 去横杠

            val label = labelInput.text?.toString()?.trim()?.takeIf { it.isNotEmpty() } ?: "TOTP"

            // 空值验证
            if (secret.isEmpty()) {
                Toast.makeText(this, R.string.totp_secret_required, Toast.LENGTH_SHORT).show()
                return@setPositiveButton
            }

            // 格式验证
            if (!TotpUtil.validateSecret(secret)) {
                Toast.makeText(this, R.string.totp_secret_invalid, Toast.LENGTH_LONG).show()
                return@setPositiveButton
            }

            saveTotpSecret(label, secret)
        }
        .setNegativeButton(R.string.cancel, null)
        .show()
}
```

**修改要点**:
1. ✅ 添加选择对话框（扫描 vs 手动）
2. ✅ 新增 `showManualTotpInputDialog()` 方法
3. ✅ 增强输入处理（自动大写、去空格、去横杠）
4. ✅ 添加完整验证（空值 + 格式）
5. ✅ 输入框类型优化（大写模式、无建议词）

---

### 2. QRScannerActivity.kt
**文件路径**: `android/app/src/main/java/com/codesync/QRScannerActivity.kt`

**修改位置**: 第 24-35 行

**修改前**:
```kotlin
override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)

    val options = ScanOptions().apply {
        setDesiredBarcodeFormats(ScanOptions.QR_CODE)
        setPrompt("扫描电脑配对二维码或 TOTP 二维码")
        setBeepEnabled(true)
        setOrientationLocked(true)
    }

    scanLauncher.launch(options)
}
```

**修改后**:
```kotlin
override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)

    // 根据来源显示不同的提示
    val prompt = if (intent.getBooleanExtra(EXTRA_SCAN_TOTP_ONLY, false)) {
        "扫描 TOTP 二维码\n（Google Authenticator 格式）"
    } else {
        "扫描电脑配对二维码或 TOTP 二维码"
    }

    val options = ScanOptions().apply {
        setDesiredBarcodeFormats(ScanOptions.QR_CODE)
        setPrompt(prompt)  // 使用动态提示
        setBeepEnabled(true)
        setOrientationLocked(true)
    }

    scanLauncher.launch(options)
}

companion object {
    const val EXTRA_SCAN_TOTP_ONLY = "scan_totp_only"
}
```

**修改要点**:
1. ✅ 新增 `EXTRA_SCAN_TOTP_ONLY` 常量
2. ✅ 根据 Intent 参数显示不同的扫描提示
3. ✅ TOTP 专用扫描显示更明确的提示文字

---

### 3. strings.xml
**文件路径**: `android/app/src/main/res/values/strings.xml`

**修改位置**: 第 10-14 行

**修改前**:
```xml
<string name="add_totp">添加 TOTP</string>
<string name="totp_secret_hint">输入 Base32 密钥</string>
<string name="totp_label_hint">标签（如 Google、GitHub）</string>
<string name="save">保存</string>
<string name="cancel">取消</string>
```

**修改后**:
```xml
<string name="add_totp">添加 TOTP</string>
<string name="add_totp_scan">📷 扫描二维码</string>
<string name="add_totp_manual">⌨️ 手动输入密钥</string>
<string name="totp_secret_hint">输入 Base32 密钥（如：JBSWY3DPEHPK3PXP）</string>
<string name="totp_label_hint">标签（如 Google、GitHub）</string>
<string name="totp_secret_required">请输入 TOTP 密钥</string>
<string name="totp_secret_invalid">密钥格式无效，请输入有效的 Base32 密钥（16位以上，仅包含 A-Z 和 2-7）</string>
<string name="save">保存</string>
<string name="cancel">取消</string>
```

**修改要点**:
1. ✅ 新增 `add_totp_scan` - 扫描选项文字
2. ✅ 新增 `add_totp_manual` - 手动输入选项文字
3. ✅ 新增 `totp_secret_required` - 空值错误提示
4. ✅ 新增 `totp_secret_invalid` - 格式错误提示
5. ✅ 优化 `totp_secret_hint` - 添加示例密钥

---

## 功能改进说明

### 改进前的问题
1. ❌ 用户只能通过手动输入添加 TOTP（虽然代码支持扫描，但入口不明确）
2. ❌ 没有输入验证，可能保存无效密钥
3. ❌ 输入提示不够友好
4. ❌ 扫描界面提示笼统

### 改进后的优势
1. ✅ **双入口清晰**：用户明确看到两种添加方式
2. ✅ **完整验证**：空值检查 + Base32 格式验证
3. ✅ **智能输入**：自动大写、去空格、去横杠
4. ✅ **友好提示**：每种情况都有清晰的中文提示
5. ✅ **安全保护**：密钥输入框禁用自动建议
6. ✅ **体验优化**：标签输入支持首字母自动大写

---

## 测试建议

### 测试场景 1：手动输入正常流程
1. 点击"添加 TOTP"
2. 选择"⌨️ 手动输入密钥"
3. 输入标签：`GitHub`
4. 输入密钥：`JBSWY3DPEHPK3PXP`
5. 点击"保存"
6. **预期**：显示"已保存 TOTP「GitHub」"，列表中出现新条目

### 测试场景 2：格式验证
1. 点击"添加 TOTP" → "⌨️ 手动输入密钥"
2. 输入标签：`Test`
3. 输入密钥：`123456`（无效格式）
4. 点击"保存"
5. **预期**：显示错误提示"密钥格式无效..."

### 测试场景 3：空值验证
1. 点击"添加 TOTP" → "⌨️ 手动输入密钥"
2. 输入标签：`Test`
3. 密钥留空
4. 点击"保存"
5. **预期**：显示"请输入 TOTP 密钥"

### 测试场景 4：扫描二维码
1. 点击"添加 TOTP" → "📷 扫描二维码"
2. **预期**：显示"扫描 TOTP 二维码（Google Authenticator 格式）"
3. 扫描有效的 TOTP 二维码
4. **预期**：自动保存并同步

### 测试场景 5：配对扫描（不受影响）
1. 点击"扫描配对二维码"按钮
2. **预期**：显示"扫描电脑配对二维码或 TOTP 二维码"
3. **预期**：扫描电脑二维码正常配对

---

## 兼容性说明

- ✅ **向后兼容**：不影响现有功能
- ✅ **API Level**：无新增 API 要求（minSdk 23）
- ✅ **依赖**：无新增依赖
- ✅ **数据格式**：保持不变，现有 TOTP 数据仍可正常使用

---

## 构建要求

- JDK 17（必须）
- Gradle 8.5+
- Android SDK 34

---

## 版本信息

- **当前版本**: v1.0.5
- **下一版本**: v1.0.6（包含此修改）

---

最后更新: 2026-06-09 17:50
