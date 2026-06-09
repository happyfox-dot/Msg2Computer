# CodeBridge 快速构建发布指南

快速上手：三个脚本完成从构建到发布的全流程。

---

## 📦 一键构建

### Android 端

```bash
cd android
build-release.bat
```

**产物**: `android/release/CodeBridge-android-1.0.7-release-signed.apk`（已签名）

### Windows 桌面端

```bash
cd desktop
build-release.bat
```

**产物**: `desktop/dist/验证码同步 Setup 1.0.7.exe`

---

## 🚀 一键发布

确保两端都已构建完成后：

```bash
release.bat
```

脚本会自动：
1. ✓ 检查构建产物
2. ✓ 重命名为 ASCII 文件名
3. ✓ 确认后发布到 GitHub Release
4. ✓ 清理临时文件

**发布到**: `happyfox-dot/Msg2Computer`  
**版本标签**: `v1.0.7`

---

## 📋 配置检查清单

### ✅ Android 签名配置（已完成）

- [x] `android/release/codebridge-release.jks` - 签名密钥库
- [x] `android/keystore.properties` - 签名密码
- [x] `android/app/build.gradle.kts` - 签名配置
- [x] `.gitignore` - 已屏蔽敏感文件

### ✅ 桌面端构建配置（已完成）

- [x] `desktop/package.json` - 版本 1.0.7
- [x] `desktop/assets/icon.ico` - Windows 图标
- [x] 构建目标：NSIS 安装包
- [x] 语言包优化：仅中英文

### ✅ 版本号统一（已完成）

- [x] Android: `versionCode=8`, `versionName="1.0.7"`
- [x] Desktop: `"version": "1.0.7"`

---

## 🔧 手动构建（不推荐）

### Android

```bash
cd android
set JAVA_HOME=C:\Program Files\Microsoft\jdk-17.0.19.10-hotspot
gradle clean assembleRelease
```

产物：`android/app/build/outputs/apk/release/app-release.apk`

### Desktop

```bash
cd desktop
npm install
npm run build:win
```

产物：`desktop/dist/验证码同步 Setup 1.0.7.exe`

---

## 📝 发布后检查

访问 Release 页面确认：
```
https://github.com/happyfox-dot/Msg2Computer/releases/tag/v1.0.7
```

应包含两个文件：
- `Msg2Computer-Setup-1.0.7.exe` (~66MB)
- `Msg2Computer-Android-1.0.7.apk` (~6MB)

---

## ⚠️ 安全提醒

**绝不提交到仓库**（已在 `.gitignore` 中屏蔽）：
- `android/release/*.jks`
- `android/keystore.properties`
- `android/release/*-passwords.txt`
- `android/release/*.apk`
- `desktop/dist/`
- `release_temp/`

---

## 🆘 常见问题

### Android 构建失败

**错误**: `Unsupported class file major version 68`  
**解决**: 使用 JDK 17（已在 `gradle.properties` 配置）

**错误**: `signing config is not available`  
**解决**: 确保 `android/keystore.properties` 存在

### 发布失败

**错误**: `release already exists`  
**解决**: 使用追加命令：
```bash
gh release upload v1.0.7 file.apk --repo happyfox-dot/Msg2Computer
```

**错误**: `push permission denied`  
**解决**: 检查 gh 登录状态：
```bash
gh auth status
```

---

## 📚 详细文档

- **构建指南**: `BUILD_GUIDE.md`
- **功能说明**: `README.md`
- **TOTP 升级**: `TOTP_COMPLETE_UPGRADE_V1.0.7.md`
