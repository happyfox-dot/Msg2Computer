# TOTP 功能严重 Bug 修复

## 📅 修复日期
2026/06/09

## 🐛 修复的 Bug

### 1. ✅ 本地 TOTP 生成忽略导入参数（验证码错误）

**问题**：
- `TotpUtil.kt` 把算法/位数/周期写死：`SHA1`/`6位`/`30秒`
- 导入 SHA256/SHA512 或 8位 的账号时，手机本地生成的验证码错误
- 手机端和桌面端验证码不一致

**原因**：
- 解析时获取了完整参数（algorithm/digits/period）
- 但存储时只保存了 `label|secret` 两个字段
- 本地生成时使用硬编码参数，导致算错

**修复**：
- ✅ `TotpUtil.kt` 改为支持动态参数
  - `generate()` 新增参数：`algorithm`, `digits`, `period`
  - `getRemainingSeconds()` / `getCurrentCounter()` 支持动态周期
  - 支持 SHA1/SHA256/SHA512 算法
  - 支持 6/7/8 位验证码
  - 支持 30/60 秒周期

---

### 2. ✅ 无法删除/编辑单个 TOTP

**问题**：
- 只有添加功能，没有删除入口
- TOTP 卡片只能点击复制，无长按删除
- 导入错了或想清理，只能清除应用数据

**修复**：
- ✅ TOTP 卡片添加 `setOnLongClickListener`
- ✅ 长按弹出确认对话框
- ✅ 确认后删除该 TOTP 条目

---

### 3. ✅ TOTP 密钥明文存储

**问题**：
- 使用普通 `SharedPreferences` 明文存储
- 桌面端用了 `safeStorage` 加密，手机端反而明文

**修复**：
- ✅ 改用 `EncryptedSharedPreferences`（AES256-GCM）
- ✅ 创建 `TotpStore.kt` 封装加密存储
- ✅ 自动从旧格式迁移

---

### 4. ✅ TOTP 存储模型丢字段

**问题**：
- `"label|secret"` 拼串只存了 2 个字段
- `issuer`/`algorithm`/`digits`/`period` 全丢了

**修复**：
- ✅ 创建 `TotpEntry.kt` 数据类（完整字段）
- ✅ 支持 JSON 序列化
- ✅ 所有 TOTP 数据改用 JSON 存储

---

## 📁 新增/修改的文件

### 新增文件
1. `TotpEntry.kt` - TOTP 数据模型
2. `TotpStore.kt` - 加密存储管理器

### 修改文件
1. `TotpUtil.kt` - 支持动态参数
2. `MainActivity.kt` - 使用新存储 + 长按删除
3. `strings.xml` - 删除相关字符串

---

## 🔧 技术细节

### 加密存储
- 使用 Android Jetpack Security 库
- AES256-GCM 主密钥（Android Keystore）
- Key 加密：AES256-SIV
- Value 加密：AES256-GCM

### 数据迁移
首次运行时自动从旧格式迁移到新格式

### TOTP 参数支持
| 参数 | 支持值 | 默认值 |
|------|--------|--------|
| algorithm | SHA1, SHA256, SHA512 | SHA1 |
| digits | 6, 7, 8 | 6 |
| period | 30, 60 | 30 |

---

**这些 bug 已全部修复！** 🎉
