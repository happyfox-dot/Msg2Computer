# CodeBridge 构建指南

本文档说明如何构建 Android 和桌面端的发布版本。

---

## 前置准备

### Android 构建环境
- **JDK**: 17（必须，Gradle 8.13 不支持 JDK 24/25）
- **Gradle**: 8.13（已在 `gradle.properties` 中配置）
- **Android SDK**: Build Tools 35.0.0
- **签名密钥**: `android/release/codebridge-release.jks` + `android/keystore.properties`

### 桌面端构建环境
- **Node.js**: 18+
- **npm**: 9+

---

## Android 构建

### 方式一：使用构建脚本（推荐）

```bash
cd android
build-release.bat
```

脚本会自动：
1. 检查签名文件和配置
2. 清理旧构建产物
3. 使用 JDK 17 + Gradle 8.13 构建
4. 自动签名
5. 复制到 `android/release/CodeBridge-android-{version}-release-signed.apk`

### 方式二：手动构建

```bash
cd android

# 1. 设置 JDK 17
set JAVA_HOME=C:\Program Files\Microsoft\jdk-17.0.19.10-hotspot
set PATH=%JAVA_HOME%\bin;%PATH%

# 2. 构建 Release（自动签名）
gradle clean assembleRelease

# 3. 产物位置
# android/app/build/outputs/apk/release/app-release.apk（已签名）
```

### 签名配置说明

签名密码从以下位置按优先级读取：
1. **环境变量** `KEYSTORE_PASSWORD`
2. **配置文件** `android/keystore.properties`
3. **Gradle 属性** `gradle.properties`

`keystore.properties` 内容（已在 `.gitignore` 中）：
```properties
KEYSTORE_PASSWORD=aDoP3NSpvG5H4ElcY2ibeWhI
```

**⚠️ 注意**：该密钥库是 PKCS12 格式，keyPassword 必须等于 storePassword。

---

## 桌面端构建

### Windows 安装包

```bash
cd desktop
npm install
npm run build:win
```

产物：`desktop/dist/验证码同步 Setup 1.0.8.exe`（约 66MB）

### macOS 安装包（需在 macOS 上执行）

```bash
cd desktop
npm install
npm run build:mac
```

产物：`desktop/dist/验证码同步-1.0.8.dmg`

---

## 发布到 GitHub Release

### 准备发布文件

1. **Android**: `android/release/CodeBridge-android-1.0.8-release-signed.apk`
2. **Windows**: `desktop/dist/验证码同步 Setup 1.0.8.exe`

### 重命名为 ASCII 文件名

```bash
# Android APK
copy "android\release\CodeBridge-android-1.0.8-release-signed.apk" "Msg2Computer-Android-1.0.8.apk"

# Windows 安装包
copy "desktop\dist\验证码同步 Setup 1.0.8.exe" "Msg2Computer-Setup-1.0.8.exe"
```

### 使用 gh CLI 发布

```bash
# 创建 Release 并上传文件
gh release create v1.0.8 ^
  Msg2Computer-Setup-1.0.8.exe ^
  Msg2Computer-Android-1.0.8.apk ^
  --repo happyfox-dot/Msg2Computer ^
  --title "v1.0.8" ^
  --notes "修复与改进"

# 或对已存在的 Release 追加文件
gh release upload v1.0.8 Msg2Computer-Android-1.0.8.apk ^
  --repo happyfox-dot/Msg2Computer
```

**⚠️ 重要**：必须带 `--repo happyfox-dot/Msg2Computer`，否则会推送到错误的仓库！

---

## 版本号管理

### Android
编辑 `android/app/build.gradle.kts`：
```kotlin
versionCode = 9      // 每次发布递增
versionName = "1.0.8"
```

### 桌面端
编辑 `desktop/package.json`：
```json
"version": "1.0.8"
```

---

## 常见问题

### Android 构建失败

**问题**: `Unsupported class file major version 68`
- **原因**: 使用了 JDK 24/25
- **解决**: 切换到 JDK 17

**问题**: `signing config is not available`
- **原因**: `keystore.properties` 不存在或密码错误
- **解决**: 确保 `android/keystore.properties` 存在且包含正确的 `KEYSTORE_PASSWORD`

### 桌面端构建体积大

- **正常现象**: Electron 应用包含 Chromium 内核，约 60-70MB
- **已优化**: `electronLanguages: ["zh-CN", "en-US"]` 仅保留中英文语言包

### 无法推送到 GitHub

- **检查登录**: `gh auth status`
- **检查仓库权限**: 确认当前账号对 `happyfox-dot/Msg2Computer` 有写权限
- **SSH 密钥**: 推送代码走 SSH，发布 Release 走 gh CLI 的 token

---

## 安全提醒

⚠️ **不要提交到仓库的文件**（已在 `.gitignore` 中屏蔽）：
- `android/release/*.jks`（签名密钥库）
- `android/keystore.properties`（签名密码）
- `android/release/*-passwords.txt`（密码文本文件）
- `android/release/*.apk`（构建产物）
- `desktop/dist/`（构建产物）

这些文件泄露后，他人可以冒充你的身份发布更新！请离线妥善保管。
