# v1.0.7 发布清单

## 📅 发布日期
2026/06/09

## ✨ 本次更新

### 桌面端 UI 重构
- ✅ 5 个独立标签页：短信验证码、动态验证码、已授权手机、配对、设置
- ✅ 手机数量实时角标
- ✅ 统计信息面板
- ✅ 外部链接支持（GitHub）

### Android TOTP 严重 Bug 修复
- ✅ 修复 SHA256/SHA512/8位验证码计算错误
- ✅ 添加长按删除 TOTP 功能
- ✅ 改用加密存储（AES256-GCM）
- ✅ 完整参数存储（algorithm/digits/period）

## 📦 构建产物

### Windows 桌面端
- **文件**: `验证码同步 Setup 1.0.7.exe` (67MB)
- **状态**: ✅ 已构建完成
- **位置**: `desktop/dist/`

### Android 端
- **文件**: `CodeBridge-android-1.0.7-release-signed.apk` (~6MB)
- **状态**: 🔄 构建中...
- **位置**: `android/app/build/outputs/apk/release/`

## 🚀 发布步骤

### 1. 等待 Android 构建完成
```bash
# 检查构建状态
ls -lh android/app/build/outputs/apk/release/app-release.apk
```

### 2. 复制并重命名
```bash
# Windows
copy "desktop\dist\验证码同步 Setup 1.0.7.exe" Msg2Computer-Setup-1.0.7.exe

# Android
copy "android\app\build\outputs\apk\release\app-release.apk" "android\release\CodeBridge-android-1.0.7-release-signed.apk"
copy "android\release\CodeBridge-android-1.0.7-release-signed.apk" Msg2Computer-Android-1.0.7.apk
```

### 3. 创建 Release Notes
```bash
# 创建 v1.0.7 Release Notes
cat TOTP_BUGS_FIX.md UI_REFACTOR_TABS.md > RELEASE_NOTES_v1.0.7.md
```

### 4. 发布到 GitHub
```bash
gh release create v1.0.7 \
  Msg2Computer-Setup-1.0.7.exe \
  Msg2Computer-Android-1.0.7.apk \
  --repo happyfox-dot/Msg2Computer \
  --title "v1.0.7 - UI 重构 + TOTP Bug 修复" \
  --notes-file RELEASE_NOTES_v1.0.7.md
```

## ⚠️ 重要提醒

### Android 端
- **首次升级会自动迁移 TOTP 数据**
- **迁移后旧数据会被清除**（已加密保存）
- **SHA256/SHA512 TOTP 现在会显示正确验证码**

### 桌面端
- **标签页布局全新改版**
- **所有原有功能保持兼容**
- **建议用户重启桌面端应用**

## ✅ 测试清单

### 桌面端
- [ ] 标签页切换正常
- [ ] 手机数量角标正确显示
- [ ] 统计信息实时更新
- [ ] GitHub 链接可以打开

### Android 端
- [ ] TOTP 数据自动迁移
- [ ] SHA256 验证码正确
- [ ] 长按删除 TOTP 正常
- [ ] 与桌面端验证码一致

## 📊 文件清单

### 文档
- ✅ `TOTP_BUGS_FIX.md` - TOTP Bug 修复文档
- ✅ `UI_REFACTOR_TABS.md` - UI 重构文档
- ✅ `BUILD_CONFIG_REPORT.md` - 构建配置报告
- ✅ `QUICK_BUILD.md` - 快速构建指南

### 新增代码
- ✅ `TotpEntry.kt` - TOTP 数据模型
- ✅ `TotpStore.kt` - 加密存储管理器
- ✅ 桌面端标签页 UI

---

**等待 Android 构建完成后即可发布！**
