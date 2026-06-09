@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion

echo ========================================
echo   CodeBridge Android Release 构建脚本
echo ========================================
echo.

REM 检查 keystore.properties 文件
if not exist "%~dp0keystore.properties" (
    echo [错误] 未找到 keystore.properties 文件
    echo 请确保 android/keystore.properties 存在且包含 KEYSTORE_PASSWORD
    pause
    exit /b 1
)

REM 检查签名文件
if not exist "%~dp0release\codebridge-release.jks" (
    echo [错误] 未找到签名密钥库文件
    echo 请确保 android/release/codebridge-release.jks 存在
    pause
    exit /b 1
)

echo [1/4] 清理旧的构建产物...
if exist "%~dp0app\build\outputs\apk\release" (
    rmdir /s /q "%~dp0app\build\outputs\apk\release"
)

echo [2/4] 使用 JDK 17 + Gradle 8.13 构建 Release APK...
set JAVA_HOME=C:\Program Files\Microsoft\jdk-17.0.19.10-hotspot
set PATH=%JAVA_HOME%\bin;%PATH%

cd /d "%~dp0"
call gradle clean assembleRelease

if %ERRORLEVEL% neq 0 (
    echo.
    echo [错误] 构建失败！
    pause
    exit /b %ERRORLEVEL%
)

echo.
echo [3/4] 检查构建产物...
if not exist "%~dp0app\build\outputs\apk\release\app-release.apk" (
    echo [错误] 未找到构建产物 app-release.apk
    pause
    exit /b 1
)

echo [4/4] 复制到 release 目录...
for /f "tokens=2" %%i in ('findstr "versionName" "%~dp0app\build.gradle.kts"') do (
    set VERSION=%%i
    set VERSION=!VERSION:"=!
)

copy /y "%~dp0app\build\outputs\apk\release\app-release.apk" "%~dp0release\CodeBridge-android-!VERSION!-release-signed.apk"

echo.
echo ========================================
echo   ✓ 构建完成！
echo ========================================
echo.
echo 已签名 APK 位置:
echo   %~dp0release\CodeBridge-android-!VERSION!-release-signed.apk
echo.
echo 可用于发布到 GitHub Release
pause
