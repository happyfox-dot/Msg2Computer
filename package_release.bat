@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion

echo ========================================
echo   CodeBridge v1.0.7 打包发布脚本
echo ========================================
echo.

REM 设置版本号
set VERSION=1.0.7

REM 设置路径
set PROJECT_ROOT=%~dp0
set DESKTOP_DIST=%PROJECT_ROOT%desktop\dist
set ANDROID_APK=%PROJECT_ROOT%android\app\build\outputs\apk\release\app-release.apk
set RELEASE_DIR=%PROJECT_ROOT%release_v%VERSION%

echo [1/5] 检查构建产物...
echo.

REM 检查 Windows 桌面端
if not exist "%DESKTOP_DIST%\验证码同步 Setup %VERSION%.exe" (
    echo [错误] Windows 桌面端未找到
    echo 路径: %DESKTOP_DIST%\验证码同步 Setup %VERSION%.exe
    pause
    exit /b 1
)
echo [OK] Windows 桌面端找到

REM 检查 Android APK
if not exist "%ANDROID_APK%" (
    echo [错误] Android APK 未找到
    echo 路径: %ANDROID_APK%
    pause
    exit /b 1
)
echo [OK] Android APK 找到
echo.

echo [2/5] 创建发布目录...
if not exist "%RELEASE_DIR%" (
    mkdir "%RELEASE_DIR%"
)
echo [OK] 发布目录: %RELEASE_DIR%
echo.

echo [3/5] 复制并重命名文件...

REM 复制 Windows 桌面端
copy /Y "%DESKTOP_DIST%\验证码同步 Setup %VERSION%.exe" "%RELEASE_DIR%\Msg2Computer-Setup-%VERSION%.exe"
if !errorlevel! neq 0 (
    echo [错误] Windows 桌面端复制失败
    pause
    exit /b 1
)
echo [OK] Windows 桌面端: Msg2Computer-Setup-%VERSION%.exe

REM 复制 Android APK
copy /Y "%ANDROID_APK%" "%RELEASE_DIR%\Msg2Computer-Android-%VERSION%.apk"
if !errorlevel! neq 0 (
    echo [错误] Android APK 复制失败
    pause
    exit /b 1
)
echo [OK] Android 手机端: Msg2Computer-Android-%VERSION%.apk
echo.

echo [4/5] 生成校验和...
cd /d "%RELEASE_DIR%"

REM 计算 SHA256
certutil -hashfile "Msg2Computer-Setup-%VERSION%.exe" SHA256 > "Msg2Computer-Setup-%VERSION%.exe.sha256"
certutil -hashfile "Msg2Computer-Android-%VERSION%.apk" SHA256 > "Msg2Computer-Android-%VERSION%.apk.sha256"

echo [OK] 校验和生成完成
echo.

echo [5/5] 生成发布说明...

REM 创建 README
(
echo # CodeBridge v%VERSION% 发布包
echo.
echo ## 文件清单
echo.
echo ### Windows 桌面端
echo - 文件名: Msg2Computer-Setup-%VERSION%.exe
echo - 系统要求: Windows 10/11
echo.
echo ### Android 手机端
echo - 文件名: Msg2Computer-Android-%VERSION%.apk
echo - 系统要求: Android 7.0+
echo.
echo ## 更新内容
echo.
echo ### 桌面端
echo - 全新 5 标签页布局
echo - 实时统计信息面板
echo - 手机数量角标
echo.
echo ### Android 端
echo - 修复 TOTP SHA256/SHA512/8位验证码
echo - 添加长按删除 TOTP
echo - 改用加密存储 AES256-GCM
echo - 支持 Google Authenticator 批量迁移
echo.
echo ## 安装方法
echo.
echo ### Windows
echo 1. 下载 Msg2Computer-Setup-%VERSION%.exe
echo 2. 双击运行安装
echo.
echo ### Android
echo 1. 下载 Msg2Computer-Android-%VERSION%.apk
echo 2. 在手机上安装
echo.
echo ## 发布日期
echo %DATE%
) > README.txt

echo [OK] README.txt 生成完成
echo.

echo ========================================
echo   打包完成！
echo ========================================
echo.
echo 发布目录: %RELEASE_DIR%
echo.
dir "%RELEASE_DIR%"
echo.

pause
