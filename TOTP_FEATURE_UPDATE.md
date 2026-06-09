# TOTP 功能优化 - 双入口添加方式

## 📝 更新内容

### ✅ 已完成的修改

#### 1. MainActivity.kt
**位置**: `android/app/src/main/java/com/codesync/MainActivity.kt`

**修改内容**:
- **优化 `showAddTotpDialog()`**: 点击"添加 TOTP"时显示选择对话框
  - 📷 扫描二维码
  - ⌨️ 手动输入密钥

- **新增 `showManualTotpInputDialog()`**: 手动输入对话框
  - 标签输入框（自动首字母大写）
  - 密钥输入框（自动大写、无建议词）
  - 完整的输入验证：
    - 空值检查 → 提示"请输入 TOTP 密钥"
    - Base32 格式验证 → 提示"密钥格式无效..."
  - 自动规范化：去除空格、横杠，转为大写

#### 2. QRScannerActivity.kt
**位置**: `android/app/src/main/java/com/codesync/QRScannerActivity.kt`

**修改内容**:
- 新增 `EXTRA_SCAN_TOTP_ONLY` 常量
- 根据来源显示不同的扫描提示：
  - 从 TOTP 添加入口: "扫描 TOTP 二维码（Google Authenticator 格式）"
  - 从配对入口: "扫描电脑配对二维码或 TOTP 二维码"

#### 3. strings.xml
**位置**: `android/app/src/main/res/values/strings.xml`

**新增字符串**:
```xml
<string name="add_totp_scan">📷 扫描二维码</string>
<string name="add_totp_manual">⌨️ 手动输入密钥</string>
<string name="totp_secret_required">请输入 TOTP 密钥</string>
<string name="totp_secret_invalid">密钥格式无效，请输入有效的 Base32 密钥（16位以上，仅包含 A-Z 和 2-7）</string>
```

---

## 🎯 用户体验流程

### 方式一：扫描二维码 📷
```
点击"添加 TOTP" 
  ↓
选择"📷 扫描二维码"
  ↓
打开相机扫描 Google Authenticator 格式的二维码
  ↓
自动解析 otpauth:// 链接
  ↓
保存到本地并同步到所有已启用的电脑
```

### 方式二：手动输入 ⌨️
```
点击"添加 TOTP"
  ↓
选择"⌨️ 手动输入密钥"
  ↓
输入标签（如：Google、GitHub）
输入 Base32 密钥（如：JBSWY3DPEHPK3PXP）
  ↓
点击"保存"（自动验证格式）
  ↓
保存到本地并同步到所有已启用的电脑
```

---

## 🔒 安全特性

- ✅ **格式验证**: 密钥必须是 16 位以上的有效 Base32 字符串（A-Z, 2-7）
- ✅ **自动规范化**: 自动去除空格、横杠，统一转为大写
- ✅ **输入保护**: 密钥输入框禁用自动建议，防止泄露
- ✅ **清晰提示**: 每种错误都有友好的中文提示

---

## 📱 界面优化

- ✅ 选择对话框使用图标（📷 和 ⌨️）更直观
- ✅ 扫描界面显示针对性提示文字
- ✅ 输入框支持自动大写转换
- ✅ 标签输入支持首字母自动大写
- ✅ 友好的错误提示信息

---

## 🛠️ 构建说明

### 环境要求
- **JDK**: 17 (必须！Gradle 8.5 不支持 JDK 24/25)
- **Gradle**: 8.5+ (项目使用 8.13)
- **Android SDK**: compileSdk 34, minSdk 23

### 构建步骤

#### 方法一：使用 Gradle Wrapper（推荐）

**Windows**:
```batch
cd android
gradlew.bat assembleRelease
```

**Linux/Mac**:
```bash
cd android
./gradlew assembleRelease
```

产物位置: `android/app/build/outputs/apk/release/app-release-unsigned.apk`

#### 方法二：使用系统 Gradle

如果你已经安装了 Gradle 8.5+:
```bash
cd android
gradle assembleRelease
```

### 签名 APK

构建完成后需要签名（使用项目中的 keystore）:

```bash
# 1. 对齐
zipalign -p -f 4 app-release-unsigned.apk app-release-aligned.apk

# 2. 签名（密码在 release/codebridge-release-passwords.txt）
apksigner sign --ks ../release/codebridge-release.jks \
  --ks-key-alias codebridge \
  --ks-pass pass:<从密码文件读取> \
  --key-pass pass:<从密码文件读取> \
  --out app-release-signed.apk \
  app-release-aligned.apk

# 3. 验证
apksigner verify --print-certs app-release-signed.apk
```

---

## ⚠️ 当前问题

你的系统目前存在以下问题：

1. **JDK 版本过高**: 当前使用 JDK 25，但项目需要 JDK 17
   - 解决方案: 安装 JDK 17 并设置 `JAVA_HOME`

2. **缺少 gradlew 脚本**: 项目缺少 Gradle Wrapper 启动脚本
   - 解决方案: 需要重新生成或手动创建

3. **缺少系统 Gradle**: 系统未安装 Gradle
   - 解决方案: 安装 Gradle 8.5+ 或使用 Gradle Wrapper

### 快速解决方案

**推荐**: 使用 Android Studio 打开项目并构建
1. 用 Android Studio 打开 `android` 目录
2. 等待 Gradle 同步完成
3. 点击 Build → Build Bundle(s) / APK(s) → Build APK(s)
4. 构建完成后会弹出通知，点击 "locate" 找到 APK

---

## 📦 版本历史

- **v1.0.5** (2026-06-09 17:17): 最后构建版本（修改前）
- **v1.0.6** (待构建): 包含 TOTP 双入口功能的新版本

---

## 🧪 测试要点

构建完成后，测试以下功能：

### 测试用例 1: 手动输入
1. 打开 App，点击"添加 TOTP"
2. 选择"⌨️ 手动输入密钥"
3. 输入标签: `Test Account`
4. 输入密钥: `JBSWY3DPEHPK3PXP`（示例密钥）
5. 点击"保存"
6. ✅ 应该显示"已保存 TOTP「Test Account」"
7. ✅ TOTP 列表中应该出现该条目
8. ✅ 电脑端应该收到同步（如果有启用的电脑）

### 测试用例 2: 格式验证
1. 点击"添加 TOTP" → "⌨️ 手动输入密钥"
2. 输入标签: `Invalid Test`
3. 输入密钥: `123456`（无效格式）
4. 点击"保存"
5. ✅ 应该显示错误提示"密钥格式无效..."

### 测试用例 3: 扫描二维码
1. 点击"添加 TOTP" → "📷 扫描二维码"
2. ✅ 应该显示提示"扫描 TOTP 二维码（Google Authenticator 格式）"
3. 扫描一个有效的 TOTP 二维码
4. ✅ 自动保存并同步到电脑

### 测试用例 4: 配对扫描（保持原有功能）
1. 点击"扫描配对二维码"按钮
2. ✅ 应该显示"扫描电脑配对二维码或 TOTP 二维码"
3. ✅ 扫描电脑二维码应该能正常配对

---

## 📞 技术支持

如果在构建过程中遇到问题：

1. 检查 JDK 版本: `java -version`（必须是 17）
2. 检查 Gradle 版本: `gradlew -v` 或 `gradle -v`
3. 清理构建缓存: `gradlew clean`
4. 检查网络连接（首次构建需要下载依赖）

---

## 🎉 功能亮点

- ✅ **双模式输入**: 同时支持扫码和手动输入，灵活应对各种场景
- ✅ **智能验证**: 自动检测并提示格式错误
- ✅ **用户友好**: 清晰的图标和提示文字
- ✅ **安全可靠**: 完整的输入保护和验证机制
- ✅ **无缝同步**: 添加后自动同步到所有已启用的电脑

---

最后更新: 2026-06-09
