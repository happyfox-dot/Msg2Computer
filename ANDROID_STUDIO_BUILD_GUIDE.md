# Android Studio 构建 APK 完整指南

## 📋 系统信息
- 项目路径：`D:\python_project\2026_code\verifyCode_Sync\CodeBridge1\android`
- 目标版本：v1.0.7
- Android SDK Build-tools：34.0.0, 35.0.0, 36.1.0 ✅

---

## 📥 步骤 1：下载 Android Studio

### 下载地址
```
官网：https://developer.android.com/studio
```

### 下载信息
- **文件大小**：约 1.1 GB
- **版本**：最新稳定版（推荐）
- **文件名**：`android-studio-<版本>-windows.exe`

### 下载方式
1. 访问上述网址
2. 点击 **"Download Android Studio"** 绿色大按钮
3. 同意条款并下载
4. 等待下载完成

---

## 🔧 步骤 2：安装 Android Studio

### 安装流程

1. **运行安装程序**
   - 双击下载的 `.exe` 文件
   - 如果出现 UAC 提示，点击"是"

2. **欢迎界面**
   - 点击 **"Next"**

3. **选择组件**
   - ✅ Android Studio
   - ✅ Android Virtual Device（可选，不需要模拟器可以不勾选）
   - 点击 **"Next"**

4. **选择安装位置**
   - 默认：`C:\Program Files\Android\Android Studio`
   - 或自定义路径
   - 点击 **"Next"**

5. **开始菜单文件夹**
   - 保持默认
   - 点击 **"Install"**

6. **等待安装**
   - 大约 5-10 分钟

7. **完成安装**
   - ✅ 勾选 "Start Android Studio"
   - 点击 **"Finish"**

---

## 🚀 步骤 3：首次启动配置

### 3.1 导入设置
- 选择：**"Do not import settings"**（不导入设置）
- 点击 **"OK"**

### 3.2 数据共享
- 选择你的偏好（建议选 "Don't send"）
- 点击 **"Next"**

### 3.3 设置向导

#### 欢迎页面
- 点击 **"Next"**

#### 安装类型
- 选择：**"Standard"**（标准安装）
- 点击 **"Next"**

#### 选择主题
- Light（浅色）或 Darcula（深色）
- 根据喜好选择
- 点击 **"Next"**

#### 验证设置
- 查看将要下载的组件
- 点击 **"Next"**

#### 下载组件
- 等待下载 Android SDK、Platform-tools 等
- **这一步可能需要 20-30 分钟**（取决于网络速度）
- 下载完成后点击 **"Finish"**

---

## 📂 步骤 4：打开项目

### 4.1 启动 Android Studio

如果刚安装完，应该已经在欢迎界面。如果没有：
- 开始菜单 → Android Studio → 启动

### 4.2 打开项目

在欢迎界面：
- 点击 **"Open"**

在文件浏览器中：
- 导航到：`D:\python_project\2026_code\verifyCode_Sync\CodeBridge1\android`
- 选择 **`android`** 文件夹
- 点击 **"确定"**

### 4.3 信任项目

如果提示 "Trust and Open Project"：
- 点击 **"Trust Project"**

---

## ⏳ 步骤 5：等待 Gradle 同步

### 同步过程

项目打开后，Android Studio 会自动开始 Gradle 同步：

1. **底部显示进度**
   ```
   Gradle sync in progress...
   Downloading dependencies...
   ```

2. **首次同步需要下载**
   - Gradle wrapper
   - 项目依赖（OkHttp、ZXing、Protobuf 等）
   - **预计时间：10-30 分钟**（首次）

3. **查看进度**
   - 底部状态栏显示百分比
   - 点击底部的 "Build" 标签可以看到详细日志

4. **同步完成标志**
   ```
   BUILD SUCCESSFUL in 5m 23s
   ```

### 常见问题

**问题 1：下载速度慢**
- 原因：国内网络访问 Google 服务器较慢
- 解决：耐心等待，或配置国内镜像

**问题 2：Gradle sync failed**
- 检查网络连接
- 查看错误信息
- 点击 "Try Again" 重试

---

## 🔨 步骤 6：构建 APK

### 6.1 选择构建类型

顶部菜单栏：
- **Build** → **Build Bundle(s) / APK(s)** → **Build APK(s)**

或者使用快捷方式：
- **Build** → **Make Project** （Ctrl + F9）

### 6.2 等待构建

底部会显示构建进度：
```
Building 'app'...
Executing tasks: [:app:assembleRelease]
```

**构建时间**：
- 首次构建：约 2-5 分钟
- 后续构建：约 30 秒 - 2 分钟

### 6.3 构建完成

右下角会弹出通知：
```
APK(s) generated successfully
Build: app-release-unsigned.apk
```

点击通知中的 **"locate"** 链接，会打开文件管理器到 APK 位置：
```
D:\python_project\2026_code\verifyCode_Sync\CodeBridge1\android\app\build\outputs\apk\release\
```

---

## 🔐 步骤 7：签名 APK（必需）

### 方式 A：使用 Android Studio 签名（推荐）

#### 7.1 启动签名向导

顶部菜单：
- **Build** → **Generate Signed Bundle / APK**

#### 7.2 选择 APK
- 选择：**APK**
- 点击 **"Next"**

#### 7.3 配置 Key Store

**Key store path**:
- 点击 "Choose existing..."
- 导航到：`D:\python_project\2026_code\verifyCode_Sync\CodeBridge1\release\codebridge-release.jks`
- 选择该文件

**Key store password**:
- 打开 `release\codebridge-release-passwords.txt` 查看密码
- 输入 `storePassword` 的值

**Key alias**:
- 输入：`codebridge`

**Key password**:
- 输入：`keyPassword` 的值（通常与 storePassword 相同）

#### 7.4 选择目标

- 勾选：**Remember passwords**（可选，方便下次使用）
- 点击 **"Next"**

#### 7.5 配置输出

**Destination Folder**:
- 选择输出位置：`D:\python_project\2026_code\verifyCode_Sync\CodeBridge1\release\`

**Build Variants**:
- 选择：**release**

**Signature Versions**:
- ✅ V1 (Jar Signature)
- ✅ V2 (Full APK Signature)

点击 **"Create"** 或 **"Finish"**

#### 7.6 等待完成

底部显示：
```
Generate Signed APK
Building 'app'...
APK(s) generated successfully
```

完成后，在 `release` 目录下会有：
```
app-release.apk  （已签名）
```

---

### 方式 B：使用命令行签名

如果需要手动签名：

```powershell
# 设置路径
cd D:\python_project\2026_code\verifyCode_Sync\CodeBridge1\android
$buildTools = "$env:LOCALAPPDATA\Android\Sdk\build-tools\34.0.0"

# 1. 对齐 APK
& "$buildTools\zipalign.exe" -p -f 4 `
  app\build\outputs\apk\release\app-release-unsigned.apk `
  app\build\outputs\apk\release\app-release-aligned.apk

# 2. 签名（替换 <password> 为实际密码）
& "$buildTools\apksigner.bat" sign `
  --ks ..\release\codebridge-release.jks `
  --ks-key-alias codebridge `
  --ks-pass pass:<storePassword> `
  --key-pass pass:<keyPassword> `
  --out ..\release\CodeBridge-android-1.0.7-release-signed.apk `
  app\build\outputs\apk\release\app-release-aligned.apk

# 3. 验证签名
& "$buildTools\apksigner.bat" verify --print-certs `
  ..\release\CodeBridge-android-1.0.7-release-signed.apk
```

---

## 📱 步骤 8：安装测试

### 8.1 重命名 APK（可选）

将生成的 APK 重命名为：
```
CodeBridge-android-1.0.7-release-signed.apk
```

### 8.2 传输到手机

**方式 1：USB 连接**
- 用数据线连接手机和电脑
- 打开手机的 USB 文件传输模式
- 复制 APK 到手机
- 在手机上打开文件管理器找到 APK 并安装

**方式 2：云盘/微信等**
- 上传 APK 到云盘或发送到微信文件传输助手
- 在手机上下载并安装

### 8.3 安装 APK

在手机上：
1. 打开 APK 文件
2. 如果是更新，会提示覆盖安装
3. 如果是首次安装，允许安装未知来源应用
4. 点击"安装"
5. 等待安装完成

---

## ✅ 步骤 9：测试功能

### 重点测试项目

#### 1. 三种添加方式
- [ ] 📷 扫描二维码
- [ ] 🖼️ 从相册导入
- [ ] ⌨️ 手动输入

#### 2. Google 批量导入
- [ ] 扫描 Google Authenticator 批量导出二维码
- [ ] 显示批量导入对话框
- [ ] 选择性导入
- [ ] 全部导入
- [ ] 成功导入所有账号

#### 3. 同步功能
- [ ] 添加后自动同步到电脑
- [ ] 电脑端正常显示
- [ ] TOTP 验证码正常生成

#### 4. 权限测试
- [ ] 相册权限请求
- [ ] 相机权限请求
- [ ] 短信权限（如果需要）

---

## 🎯 快速参考

### Android Studio 常用快捷键

| 功能 | Windows 快捷键 |
|-----|---------------|
| 构建项目 | Ctrl + F9 |
| 清理项目 | Build → Clean Project |
| 重新构建 | Build → Rebuild Project |
| 同步 Gradle | File → Sync Project with Gradle Files |
| 运行 | Shift + F10 |

### 项目路径

```
项目根目录：D:\python_project\2026_code\verifyCode_Sync\CodeBridge1\
Android 项目：D:\python_project\2026_code\verifyCode_Sync\CodeBridge1\android\
APK 输出：   android\app\build\outputs\apk\release\
签名密钥：   release\codebridge-release.jks
密码文件：   release\codebridge-release-passwords.txt
```

---

## ⚠️ 常见问题排查

### 问题 1：Gradle sync 卡住

**解决**：
1. File → Invalidate Caches / Restart
2. 重启 Android Studio
3. 删除 `.gradle` 文件夹后重新同步

### 问题 2：依赖下载失败

**错误**：`Could not resolve com.google.protobuf:protobuf-javalite:3.21.12`

**解决**：
1. 检查网络连接
2. 配置国内镜像（阿里云）
3. 在 `build.gradle` 中添加：
```gradle
allprojects {
    repositories {
        maven { url 'https://maven.aliyun.com/repository/public/' }
        maven { url 'https://maven.aliyun.com/repository/google/' }
        google()
        mavenCentral()
    }
}
```

### 问题 3：签名失败

**错误**：`apksigner: command not found`

**解决**：
- 确认 Android SDK Build-tools 已安装
- 在 Android Studio 中：SDK Manager → SDK Tools → Android SDK Build-Tools

### 问题 4：内存不足

**错误**：`OutOfMemoryError: Java heap space`

**解决**：
在 `gradle.properties` 中添加：
```properties
org.gradle.jvmargs=-Xmx4096m -XX:MaxMetaspaceSize=512m
```

---

## 🎉 完成！

构建并签名完成后，你应该得到：

```
CodeBridge-android-1.0.7-release-signed.apk
```

这个 APK 包含了所有新功能：
- ✅ 三种 TOTP 添加方式
- ✅ 从相册导入
- ✅ Google Authenticator 批量导入
- ✅ 完整的输入验证
- ✅ 友好的用户界面

---

## 📞 需要帮助？

如果在任何步骤遇到问题：
1. 查看 Android Studio 底部的 "Build" 输出
2. 查看错误信息
3. 检查网络连接
4. 参考上面的"常见问题排查"

祝你构建顺利！🚀
