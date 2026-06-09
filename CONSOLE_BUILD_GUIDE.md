# 命令行打包完整方案 - JDK 17 配置

## 🎯 推荐方案：便携式 JDK 17

### 步骤 1：下载 JDK 17

**请手动下载以下文件（任选其一）**：

#### 选项 A：Eclipse Temurin 17（推荐，开源免费）
```
下载地址：
https://github.com/adoptium/temurin17-binaries/releases/download/jdk-17.0.13%2B11/OpenJDK17U-jdk_x64_windows_hotspot_17.0.13_11.zip

文件名：OpenJDK17U-jdk_x64_windows_hotspot_17.0.13_11.zip
大小：约 190 MB
```

#### 选项 B：Oracle JDK 17
```
下载地址：
https://download.oracle.com/java/17/latest/jdk-17_windows-x64_bin.zip

文件名：jdk-17_windows-x64_bin.zip
大小：约 180 MB
```

---

### 步骤 2：解压到项目目录

**下载完成后，请在 PowerShell 中执行：**

```powershell
# 切换到项目根目录
cd D:\python_project\2026_code\verifyCode_Sync\CodeBridge1

# 解压 JDK（假设下载到了 Downloads 目录）
# 方式 A：如果下载的是 Temurin
Expand-Archive -Path "$env:USERPROFILE\Downloads\OpenJDK17U-jdk_x64_windows_hotspot_17.0.13_11.zip" -DestinationPath . -Force

# 方式 B：如果下载的是 Oracle JDK
# Expand-Archive -Path "$env:USERPROFILE\Downloads\jdk-17_windows-x64_bin.zip" -DestinationPath . -Force

# 重命名为 jdk-17（方便使用）
# Temurin 解压后的目录名类似：jdk-17.0.13+11
Move-Item -Path "jdk-17.0.13+11" -Destination "jdk-17" -Force

# 或者 Oracle JDK 解压后：
# Move-Item -Path "jdk-17" -Destination "jdk-17" -Force

# 验证
.\jdk-17\bin\java.exe -version
```

---

### 步骤 3：配置 Gradle 使用 JDK 17

```powershell
# 在 android 目录下创建/修改 gradle.properties
cd android

# 添加 JDK 路径配置
@"
# JDK 17 配置
org.gradle.java.home=../jdk-17

# 内存优化
org.gradle.jvmargs=-Xmx4096m -XX:MaxMetaspaceSize=512m
org.gradle.daemon=true
"@ | Out-File -FilePath gradle.properties -Encoding UTF8 -Append

Write-Host "✓ 配置完成！" -ForegroundColor Green
```

---

### 步骤 4：构建 APK

```powershell
# 确保在 android 目录
cd D:\python_project\2026_code\verifyCode_Sync\CodeBridge1\android

# 清理旧构建（可选）
.\gradlew.bat clean

# 构建 Release APK
.\gradlew.bat assembleRelease

# 等待构建完成...
# 成功后会显示：BUILD SUCCESSFUL
```

**构建产物位置**：
```
android\app\build\outputs\apk\release\app-release-unsigned.apk
```

---

### 步骤 5：签名 APK

```powershell
# 设置变量
$buildTools = "$env:LOCALAPPDATA\Android\Sdk\build-tools\34.0.0"
$keystorePath = "..\release\codebridge-release.jks"
$keystoreAlias = "codebridge"

# 读取密码（从密码文件）
$passwordFile = "..\release\codebridge-release-passwords.txt"
$storePassword = (Get-Content $passwordFile | Select-String "storePassword" | ForEach-Object { $_.ToString().Split('=')[1].Trim() })

# 1. 对齐 APK
& "$buildTools\zipalign.exe" -p -f 4 `
  app\build\outputs\apk\release\app-release-unsigned.apk `
  app\build\outputs\apk\release\app-release-aligned.apk

Write-Host "✓ APK 对齐完成" -ForegroundColor Green

# 2. 签名 APK
& "$buildTools\apksigner.bat" sign `
  --ks $keystorePath `
  --ks-key-alias $keystoreAlias `
  --ks-pass pass:$storePassword `
  --key-pass pass:$storePassword `
  --out app\build\outputs\apk\release\app-release-signed.apk `
  app\build\outputs\apk\release\app-release-aligned.apk

Write-Host "✓ APK 签名完成" -ForegroundColor Green

# 3. 验证签名
& "$buildTools\apksigner.bat" verify --print-certs `
  app\build\outputs\apk\release\app-release-signed.apk

# 4. 复制到 release 目录
Copy-Item app\build\outputs\apk\release\app-release-signed.apk `
  ..\release\CodeBridge-android-1.0.7-release-signed.apk

Write-Host "`n✓ 完成！APK 位置：" -ForegroundColor Green
Write-Host "release\CodeBridge-android-1.0.7-release-signed.apk" -ForegroundColor Cyan
```

---

## 📝 完整的一键脚本

将以下内容保存为 `build.ps1`：

```powershell
# build.ps1 - 完整构建脚本
param(
    [string]$Version = "1.0.7"
)

$ErrorActionPreference = "Stop"

Write-Host "=== CodeBridge Android 构建脚本 v$Version ===" -ForegroundColor Green

# 检查 JDK 17
$jdkPath = "..\jdk-17\bin\java.exe"
if (-not (Test-Path $jdkPath)) {
    Write-Host "✗ 未找到 JDK 17，请先下载并解压到项目根目录" -ForegroundColor Red
    Write-Host "位置应为：D:\python_project\2026_code\verifyCode_Sync\CodeBridge1\jdk-17\" -ForegroundColor Yellow
    exit 1
}

Write-Host "✓ JDK 17 已就绪" -ForegroundColor Green
& $jdkPath -version

# 进入 Android 目录
cd D:\python_project\2026_code\verifyCode_Sync\CodeBridge1\android

# 清理
Write-Host "`n📦 清理旧构建..." -ForegroundColor Yellow
.\gradlew.bat clean

# 构建
Write-Host "`n🔨 构建 Release APK..." -ForegroundColor Yellow
.\gradlew.bat assembleRelease

if ($LASTEXITCODE -ne 0) {
    Write-Host "✗ 构建失败！" -ForegroundColor Red
    exit 1
}

Write-Host "✓ 构建成功！" -ForegroundColor Green

# 签名
$buildTools = "$env:LOCALAPPDATA\Android\Sdk\build-tools\34.0.0"
$keystorePath = "..\release\codebridge-release.jks"
$passwordFile = "..\release\codebridge-release-passwords.txt"

if (Test-Path $passwordFile) {
    Write-Host "`n🔐 签名 APK..." -ForegroundColor Yellow
    
    $storePassword = (Get-Content $passwordFile | Select-String "storePassword" | ForEach-Object { $_.ToString().Split('=')[1].Trim() })
    
    # 对齐
    & "$buildTools\zipalign.exe" -p -f 4 `
      app\build\outputs\apk\release\app-release-unsigned.apk `
      app\build\outputs\apk\release\app-release-aligned.apk
    
    # 签名
    & "$buildTools\apksigner.bat" sign `
      --ks $keystorePath `
      --ks-key-alias codebridge `
      --ks-pass pass:$storePassword `
      --key-pass pass:$storePassword `
      --out app\build\outputs\apk\release\app-release-signed.apk `
      app\build\outputs\apk\release\app-release-aligned.apk
    
    # 复制
    $outputName = "CodeBridge-android-$Version-release-signed.apk"
    Copy-Item app\build\outputs\apk\release\app-release-signed.apk ..\release\$outputName
    
    Write-Host "`n✅ 完成！" -ForegroundColor Green
    Write-Host "📁 输出文件：release\$outputName" -ForegroundColor Cyan
    
    # 显示文件信息
    $apk = Get-Item "..\release\$outputName"
    Write-Host "📦 文件大小：$([math]::Round($apk.Length / 1MB, 2)) MB" -ForegroundColor Cyan
} else {
    Write-Host "`n⚠️  未找到密码文件，跳过签名" -ForegroundColor Yellow
}

cd ..
Write-Host "`n🎉 构建完成！" -ForegroundColor Green
```

---

## 🚀 使用方法

### 方式一：逐步执行（推荐新手）

按照上面的步骤 1-5 逐步执行

### 方式二：使用一键脚本（推荐熟手）

```powershell
# 1. 下载并解压 JDK 17 到项目根目录（手动）

# 2. 运行构建脚本
cd D:\python_project\2026_code\verifyCode_Sync\CodeBridge1
.\build.ps1 -Version "1.0.7"
```

---

## ✅ 总结

**你需要做的只有 3 步**：

1. **下载 JDK 17 ZIP**（任选一个链接）
2. **解压到项目根目录，重命名为 `jdk-17`**
3. **运行构建命令**

**整个过程约 10-15 分钟**（首次构建需下载依赖）

---

**准备好了吗？告诉我你下载了哪个 JDK，我继续指导！** 😊
