# JDK 17 配置指南 - Android 打包专用

## 📋 当前环境
- 系统：Windows 11
- 当前 JDK：JDK 25（不兼容 Gradle 8.5）
- 已安装：JDK 24, JDK 25
- **需要**：JDK 17（Gradle 8.5 要求）

---

## 🎯 方案选择

### 方案一：下载安装 JDK 17（推荐）✨

#### 步骤 1：下载 JDK 17

**Oracle JDK 17** (推荐)
```
下载地址：https://www.oracle.com/java/technologies/downloads/#java17

选择：Windows x64 Installer (jdk-17_windows-x64_bin.exe)
大小：约 160 MB
```

**或者使用 OpenJDK 17** (免费开源)
```
下载地址：https://adoptium.net/temurin/releases/?version=17

选择：Windows x64 JDK (.msi 安装包)
```

#### 步骤 2：安装 JDK 17

1. 运行下载的安装包
2. 安装路径建议：`C:\Program Files\Java\jdk-17`
3. 完成安装

#### 步骤 3：配置（两种方式任选其一）

**方式 A：修改系统环境变量（永久生效）**

1. 按 `Win + X`，选择"系统"
2. 点击"高级系统设置"
3. 点击"环境变量"
4. 在"系统变量"中：
   - 找到 `JAVA_HOME`，编辑为：`C:\Program Files\Java\jdk-17`
   - 找到 `Path`，确保包含：`%JAVA_HOME%\bin`
5. 点击"确定"保存
6. **重启终端**验证

**方式 B：仅为 Gradle 指定 JDK 17（推荐）**

在项目中创建/修改 `gradle.properties`：

```properties
# android/gradle.properties
org.gradle.java.home=C:\\Program Files\\Java\\jdk-17
```

或者在命令行中临时指定：
```powershell
$env:JAVA_HOME="C:\Program Files\Java\jdk-17"
cd android
.\gradlew.bat assembleRelease
```

#### 步骤 4：验证安装

```powershell
# 检查 Java 版本
java -version

# 应该显示：
# java version "17.0.x"
```

---

### 方案二：使用 Android Studio（最简单）✨✨✨

**优势**：
- 无需手动安装 JDK
- Android Studio 自带 JDK
- 自动处理所有依赖

**步骤**：

1. **下载 Android Studio**
   ```
   地址：https://developer.android.com/studio
   ```

2. **打开项目**
   - 启动 Android Studio
   - File → Open → 选择 `android` 目录
   - 等待 Gradle 同步完成（首次可能需要 10-20 分钟下载依赖）

3. **构建 APK**
   - Build → Build Bundle(s) / APK(s) → Build APK(s)
   - 等待构建完成
   - 点击通知中的 "locate" 找到 APK

4. **签名 APK**（可选）
   - Build → Generate Signed Bundle / APK
   - 选择 APK
   - 选择 keystore：`../release/codebridge-release.jks`
   - 输入密码（在 `release/codebridge-release-passwords.txt`）
   - 完成

---

## 🛠️ 方案三：使用便携式 JDK（无需安装）

#### 步骤 1：下载 JDK 17 压缩包

```
下载地址：https://adoptium.net/temurin/releases/?version=17

选择：Windows x64 JDK (.zip 压缩包)
```

#### 步骤 2：解压到项目目录

```powershell
# 解压到项目根目录
# 例如：D:\python_project\2026_code\verifyCode_Sync\CodeBridge1\jdk-17
```

#### 步骤 3：配置 gradle.properties

在 `android/gradle.properties` 中添加：

```properties
# 使用相对路径（推荐）
org.gradle.java.home=../jdk-17

# 或使用绝对路径
# org.gradle.java.home=D:\\python_project\\2026_code\\verifyCode_Sync\\CodeBridge1\\jdk-17
```

#### 步骤 4：构建

```powershell
cd android
.\gradlew.bat assembleRelease
```

---

## 📝 我的推荐顺序

### 对于你的情况，推荐顺序：

1. **首选：Android Studio** ⭐⭐⭐⭐⭐
   - 理由：最简单，零配置，功能完整
   - 适合：所有人

2. **次选：便携式 JDK** ⭐⭐⭐⭐
   - 理由：无需安装，不影响现有环境
   - 适合：不想改变系统配置的用户

3. **备选：安装 JDK 17** ⭐⭐⭐
   - 理由：需要手动配置
   - 适合：熟悉环境变量配置的用户

---

## 🚀 快速开始（使用 Android Studio）

### 完整流程：

```
1. 下载 Android Studio
   ↓
2. 安装并启动
   ↓
3. File → Open → 选择 android 目录
   ↓
4. 等待 Gradle 同步（自动下载依赖）
   ↓
5. Build → Build APK(s)
   ↓
6. 点击通知中的 locate
   ↓
7. 找到 APK 文件
   ↓
8. 签名（可选）
   ↓
9. 安装测试
```

---

## 🔧 手动打包完整流程

### 前提：已配置 JDK 17

```powershell
# 1. 进入 Android 目录
cd D:\python_project\2026_code\verifyCode_Sync\CodeBridge1\android

# 2. 清理旧的构建（可选）
.\gradlew.bat clean

# 3. 构建 Release APK
.\gradlew.bat assembleRelease

# 4. 查找生成的 APK
ls app\build\outputs\apk\release\

# 应该看到：
# app-release-unsigned.apk
```

### 签名 APK

```powershell
# 确认 Android SDK 路径（需要 build-tools）
# 通常在：C:\Users\<用户名>\AppData\Local\Android\Sdk\build-tools\<版本>\

# 设置 build-tools 路径
$buildTools = "C:\Users\jising\AppData\Local\Android\Sdk\build-tools\34.0.0"

# 1. 对齐 APK
& "$buildTools\zipalign.exe" -p -f 4 `
  app\build\outputs\apk\release\app-release-unsigned.apk `
  app\build\outputs\apk\release\app-release-aligned.apk

# 2. 签名 APK
& "$buildTools\apksigner.bat" sign `
  --ks ..\release\codebridge-release.jks `
  --ks-key-alias codebridge `
  --ks-pass pass:<从密码文件读取> `
  --key-pass pass:<从密码文件读取> `
  --out app\build\outputs\apk\release\app-release-signed.apk `
  app\build\outputs\apk\release\app-release-aligned.apk

# 3. 验证签名
& "$buildTools\apksigner.bat" verify --print-certs `
  app\build\outputs\apk\release\app-release-signed.apk

# 4. 复制到 release 目录
Copy-Item app\build\outputs\apk\release\app-release-signed.apk `
  ..\release\CodeBridge-android-1.0.7-release-signed.apk
```

---

## ⚠️ 常见问题

### 问题 1：gradlew.bat 找不到

**解决**：
```powershell
# 检查是否存在
Test-Path .\gradlew.bat

# 如果不存在，使用之前创建的
# 或者直接使用 Gradle（如果已安装）
gradle assembleRelease
```

### 问题 2：Gradle 下载依赖失败

**原因**：网络问题或防火墙

**解决**：
```properties
# 在 android/gradle.properties 中添加代理（如果需要）
systemProp.http.proxyHost=127.0.0.1
systemProp.http.proxyPort=7890
systemProp.https.proxyHost=127.0.0.1
systemProp.https.proxyPort=7890
```

### 问题 3：构建时内存不足

**解决**：
```properties
# 在 android/gradle.properties 中添加
org.gradle.jvmargs=-Xmx4096m -XX:MaxMetaspaceSize=512m
```

### 问题 4：签名时找不到 apksigner

**解决**：
```powershell
# 查找 build-tools
Get-ChildItem "$env:LOCALAPPDATA\Android\Sdk\build-tools" -ErrorAction SilentlyContinue

# 或者安装 Android SDK
# 通过 Android Studio → SDK Manager → SDK Tools → Android SDK Build-Tools
```

---

## 📦 完整打包脚本

创建一个自动化脚本 `build-and-sign.ps1`：

```powershell
# build-and-sign.ps1
param(
    [string]$Version = "1.0.7"
)

$ErrorActionPreference = "Stop"

Write-Host "🚀 开始构建 CodeBridge Android v$Version" -ForegroundColor Green

# 设置 JDK 17（如果需要）
$env:JAVA_HOME = "C:\Program Files\Java\jdk-17"

# 进入 Android 目录
cd android

# 清理旧构建
Write-Host "`n📦 清理旧构建..." -ForegroundColor Yellow
.\gradlew.bat clean

# 构建 Release
Write-Host "`n🔨 构建 Release APK..." -ForegroundColor Yellow
.\gradlew.bat assembleRelease

if ($LASTEXITCODE -ne 0) {
    Write-Host "❌ 构建失败！" -ForegroundColor Red
    exit 1
}

Write-Host "`n✅ 构建成功！" -ForegroundColor Green

# 签名 APK
$buildTools = "C:\Users\jising\AppData\Local\Android\Sdk\build-tools\34.0.0"
$keystorePath = "..\release\codebridge-release.jks"
$passwordFile = "..\release\codebridge-release-passwords.txt"

if (Test-Path $passwordFile) {
    $password = (Get-Content $passwordFile | Select-String "storePassword" | ForEach-Object { $_.ToString().Split('=')[1].Trim() })
    
    Write-Host "`n🔐 签名 APK..." -ForegroundColor Yellow
    
    # 对齐
    & "$buildTools\zipalign.exe" -p -f 4 `
      app\build\outputs\apk\release\app-release-unsigned.apk `
      app\build\outputs\apk\release\app-release-aligned.apk
    
    # 签名
    & "$buildTools\apksigner.bat" sign `
      --ks $keystorePath `
      --ks-key-alias codebridge `
      --ks-pass pass:$password `
      --key-pass pass:$password `
      --out app\build\outputs\apk\release\app-release-signed.apk `
      app\build\outputs\apk\release\app-release-aligned.apk
    
    # 验证
    & "$buildTools\apksigner.bat" verify `
      app\build\outputs\apk\release\app-release-signed.apk
    
    # 复制到 release 目录
    $outputName = "CodeBridge-android-$Version-release-signed.apk"
    Copy-Item app\build\outputs\apk\release\app-release-signed.apk `
      ..\release\$outputName
    
    Write-Host "`n✅ 签名完成！" -ForegroundColor Green
    Write-Host "📁 输出文件：release\$outputName" -ForegroundColor Cyan
} else {
    Write-Host "`n⚠️  未找到密码文件，跳过签名" -ForegroundColor Yellow
    $outputName = "app-release-unsigned.apk"
    Write-Host "📁 未签名文件：app\build\outputs\apk\release\$outputName" -ForegroundColor Cyan
}

cd ..
Write-Host "`n🎉 完成！" -ForegroundColor Green
```

**使用方法**：
```powershell
.\build-and-sign.ps1 -Version "1.0.7"
```

---

## 🎯 推荐行动方案

基于你的情况，我推荐：

### 方案：使用 Android Studio（零配置）

1. **下载 Android Studio**
   - 官网：https://developer.android.com/studio
   - 大小：约 1GB

2. **安装**（默认选项即可）

3. **打开项目**
   - File → Open
   - 选择：`D:\python_project\2026_code\verifyCode_Sync\CodeBridge1\android`

4. **等待同步**（首次约 10-20 分钟）

5. **构建**
   - Build → Build APK(s)

6. **完成** 🎉

---

你想用哪种方案？我可以继续指导具体步骤！
