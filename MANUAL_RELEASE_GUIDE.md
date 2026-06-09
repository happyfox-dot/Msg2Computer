# v1.0.7 手动发布指南

## ✅ 构建完成

### 📦 构建产物
- **Windows**: `release_temp/Msg2Computer-Setup-1.0.7.exe` (67 MB)
- **Android**: `release_temp/Msg2Computer-Android-1.0.7.apk` (6.3 MB)

## 🚀 发布步骤

### 方式一：使用 GitHub CLI (推荐)

```bash
gh release create v1.0.7 \
  release_temp/Msg2Computer-Setup-1.0.7.exe \
  release_temp/Msg2Computer-Android-1.0.7.apk \
  --repo happyfox-dot/Msg2Computer \
  --title "v1.0.7 - UI 重构 + TOTP Bug 修复" \
  --notes-file RELEASE_NOTES_v1.0.7.md
```

### 方式二：GitHub 网页手动发布

1. **打开 GitHub Release 页面**
   ```
   https://github.com/happyfox-dot/Msg2Computer/releases/new
   ```

2. **填写信息**
   - **Tag**: `v1.0.7`
   - **Target**: `master` (默认)
   - **Title**: `v1.0.7 - UI 重构 + TOTP Bug 修复`

3. **上传文件**
   - 拖拽 `release_temp/Msg2Computer-Setup-1.0.7.exe` 到上传区
   - 拖拽 `release_temp/Msg2Computer-Android-1.0.7.apk` 到上传区

4. **填写 Release Notes**
   
   复制以下内容到描述框：

```markdown
# CodeBridge v1.0.7 发布说明

## 🎉 重大更新

### 🖥️ 桌面端 UI 重构

全新标签页布局，信息组织更清晰！

#### 5 个独立标签页
1. **📋 短信验证码** - 默认首页
2. **⏱️ 动态验证码** - TOTP 专属页面
3. **📲 已授权手机** - 设备管理（带实时数量角标）
4. **🔗 配对** - 扫码配对
5. **⚙️ 设置** - 统计信息、版本信息

#### 新增功能
- ✨ 实时统计面板
- ✨ 数量角标显示
- ✨ 外部链接支持
- ✨ 独立滚动区

### 🔒 Android TOTP 严重 Bug 修复

修复了 4 个严重的 TOTP 功能 Bug！

#### Bug 1: TOTP 参数错误 ✅
- 修复 SHA256/SHA512/8位验证码计算错误
- 手机端和桌面端验证码现在完全一致

#### Bug 2: 无法删除 TOTP ✅
- 长按 TOTP 卡片可以删除
- 不再需要清除应用数据

#### Bug 3: 密钥明文存储 ✅
- 改用 AES256-GCM 加密存储
- 使用 Android Keystore 保护

#### Bug 4: 存储丢失参数 ✅
- 使用 JSON 完整存储所有参数
- 支持从旧格式自动迁移

---

## 📦 下载

### Windows 桌面端
- **文件**: `Msg2Computer-Setup-1.0.7.exe`
- **大小**: 67 MB
- **系统要求**: Windows 10/11

### Android 手机端
- **文件**: `Msg2Computer-Android-1.0.7.apk`
- **大小**: 6.3 MB
- **系统要求**: Android 7.0+

---

## ⚠️ 重要提示

### Android 用户
1. **首次升级会自动迁移 TOTP 数据**
   - 无需手动操作，自动完成
   - 旧数据会被加密保存

2. **SHA256/SHA512 TOTP 现在会显示正确验证码**
   - 之前显示错误的 TOTP 现在会修复

3. **长按 TOTP 卡片可以删除**

### Windows 用户
1. **全新标签页布局**
   - 建议升级后重启应用

2. **统计信息实时更新**
   - 在"设置"标签页查看

---

## 🐛 已知问题
- 无

---

**祝使用愉快！** 🎉
```

5. **点击 "Publish release"** 发布

---

## 📊 发布后

### 检查清单
- [ ] Release 页面正常显示
- [ ] Windows 安装包可以下载
- [ ] Android APK 可以下载
- [ ] Release Notes 正确显示

### 清理临时文件
```bash
# 发布成功后清理
rm -rf release_temp/
```

---

## 🎯 下一步

1. **通知用户**
   - 在项目 README 更新版本号
   - 发布公告（如果有社区）

2. **测试验证**
   - 下载并测试 Windows 安装包
   - 下载并测试 Android APK
   - 验证 TOTP 功能正常

---

**发布准备完成！** 🚀
