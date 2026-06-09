# 扫码解析修复说明

## 📅 修复日期
2026/06/09

## 🐛 问题描述

### 问题 1：扫码后 TOTP 无法正确解码
**原因**：`QRScannerActivity` 在保存 TOTP 时使用了旧的明文存储方式，没有使用新的 `TotpStore` 和 `TotpEntry`。

### 问题 2：Google Authenticator 批量迁移二维码无法解析
**原因**：缺少对 `otpauth-migration://` 格式的支持，只能解析标准的 `otpauth://totp/` 格式。

## ✅ 修复内容

### 1. 使用 TotpStore 加密存储
**修改文件**: `QRScannerActivity.kt`

**之前**:
```kotlin
private fun saveTotpLocally(label: String, secret: String) {
    val prefs = getSharedPreferences("totp_secrets", MODE_PRIVATE)
    val existing = prefs.getStringSet("entries", emptySet())?.toMutableSet() ?: mutableSetOf()
    existing.add("$label|$secret")  // 明文存储，只有 label 和 secret
    prefs.edit().putStringSet("entries", existing).apply()
}
```

**修复后**:
```kotlin
private fun saveTotpLocally(
    label: String,
    secret: String,
    issuer: String = "",
    accountName: String = "",
    algorithm: String = "SHA1",
    digits: Int = 6,
    period: Int = 30
) {
    val entry = TotpEntry(
        label = label,
        secret = secret,
        issuer = issuer,
        accountName = accountName,
        algorithm = algorithm,
        digits = digits,
        period = period
    )
    TotpStore.add(this, entry)  // 加密存储，完整参数
}
```

### 2. 添加 Google Authenticator 批量迁移支持

**新增方法**: `handleGoogleMigration()`

```kotlin
private fun handleScanResult(content: String) {
    // Google Authenticator 批量迁移格式
    if (content.startsWith("otpauth-migration://", ignoreCase = true)) {
        handleGoogleMigration(content)
        return
    }

    // 标准 TOTP 格式
    if (content.startsWith("otpauth://", ignoreCase = true)) {
        handleTotpQr(content)
        return
    }

    // 配对二维码
    handlePairingQr(content)
}
```

### 3. 批量导入逻辑

```kotlin
private fun handleGoogleMigration(content: String) {
    try {
        val accounts = GoogleAuthMigrationParser.parse(content) ?: emptyList()

        if (accounts.isEmpty()) {
            Toast.makeText(this, "未能解析出任何账号", Toast.LENGTH_SHORT).show()
            return
        }

        // 批量导入所有账号
        var successCount = 0
        var failCount = 0

        accounts.forEach { account ->
            try {
                if (TotpUtil.validateSecret(account.secret)) {
                    saveTotpLocally(
                        label = account.getDisplayLabel(),
                        secret = account.secret,
                        issuer = account.issuer,
                        accountName = account.getAccountName(),
                        algorithm = account.getAlgorithmString(),
                        digits = account.getDigitsInt(),
                        period = 30
                    )
                    sendTotpSeedToDesktop(...)
                    successCount++
                } else {
                    failCount++
                }
            } catch (e: Exception) {
                failCount++
            }
        }

        val message = if (failCount == 0) {
            "成功导入 $successCount 个 TOTP 账号"
        } else {
            "成功导入 $successCount 个，失败 $failCount 个"
        }
        Toast.makeText(this, message, Toast.LENGTH_LONG).show()
    } catch (e: Exception) {
        Toast.makeText(this, "Google Authenticator 迁移数据解析失败: ${e.message}", Toast.LENGTH_LONG).show()
    }
}
```

## 📋 测试清单

### 扫描测试
- [ ] 扫描标准 TOTP 二维码（`otpauth://totp/...`）
  - [ ] SHA1 算法 6 位 30 秒
  - [ ] SHA256 算法
  - [ ] SHA512 算法
  - [ ] 8 位验证码
  - [ ] 60 秒周期

- [ ] 扫描 Google Authenticator 批量导出
  - [ ] 单个账号
  - [ ] 多个账号（2-10个）
  - [ ] 不同算法混合

- [ ] 扫描配对二维码（桌面端）

### 验证测试
- [ ] TOTP 保存到加密存储
- [ ] 完整参数（algorithm/digits/period）正确保存
- [ ] 手机端验证码与桌面端一致
- [ ] 批量导入成功提示正确

### 数据迁移测试
- [ ] 旧版本升级后 TOTP 数据自动迁移
- [ ] 迁移后验证码显示正确

## 🎯 预期效果

### 扫描标准 TOTP
1. 扫描二维码
2. 自动识别算法、位数、周期
3. 保存到加密存储
4. 同步到桌面端
5. 提示"已保存并同步 TOTP：XXX"

### 扫描 Google Authenticator 批量导出
1. 扫描迁移二维码
2. 自动解析所有账号
3. 批量保存到加密存储
4. 批量同步到桌面端
5. 提示"成功导入 N 个 TOTP 账号"

## 📝 注意事项

1. **设备需要在线**：批量导入需要网络连接（如果要同步到桌面端）
2. **密钥验证**：无效的密钥会被跳过，不影响其他账号导入
3. **重复处理**：相同 label 的 TOTP 会覆盖旧的

---

**修复完成！现在扫码功能应该可以正常工作了。** 🎉
