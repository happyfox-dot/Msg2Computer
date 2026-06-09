@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion

echo ========================================
echo   CodeBridge 发布准备脚本
echo ========================================
echo.

set VERSION=1.0.7
set REPO=happyfox-dot/Msg2Computer

REM 检查 gh CLI
gh --version >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo [错误] 未安装 gh CLI
    echo 请访问: https://cli.github.com/
    pause
    exit /b 1
)

echo [1/5] 检查构建产物...
echo.

REM 检查 Android APK
set ANDROID_APK=android\release\CodeBridge-android-%VERSION%-release-signed.apk
if not exist "%ANDROID_APK%" (
    echo [错误] 未找到 Android APK: %ANDROID_APK%
    echo 请先运行: android\build-release.bat
    pause
    exit /b 1
)
echo ✓ Android APK: %ANDROID_APK%

REM 检查 Windows 安装包
set WIN_SETUP=desktop\dist\验证码同步 Setup %VERSION%.exe
if not exist "%WIN_SETUP%" (
    echo [错误] 未找到 Windows 安装包
    echo 请先运行: desktop\build-release.bat
    pause
    exit /b 1
)
echo ✓ Windows 安装包: %WIN_SETUP%

echo.
echo [2/5] 重命名为 ASCII 文件名...

REM 创建临时目录
if not exist "release_temp" mkdir release_temp

REM 复制并重命名
set ANDROID_RELEASE=release_temp\Msg2Computer-Android-%VERSION%.apk
set WIN_RELEASE=release_temp\Msg2Computer-Setup-%VERSION%.exe

copy /y "%ANDROID_APK%" "%ANDROID_RELEASE%" >nul
copy /y "%WIN_SETUP%" "%WIN_RELEASE%" >nul

echo ✓ %ANDROID_RELEASE%
echo ✓ %WIN_RELEASE%

echo.
echo [3/5] 计算文件大小...
for %%f in ("%ANDROID_RELEASE%") do set ANDROID_SIZE=%%~zf
for %%f in ("%WIN_RELEASE%") do set WIN_SIZE=%%~zf
set /a ANDROID_MB=!ANDROID_SIZE! / 1048576
set /a WIN_MB=!WIN_SIZE! / 1048576
echo   Android APK: !ANDROID_MB! MB
echo   Windows 安装包: !WIN_MB! MB

echo.
echo [4/5] 准备发布...
echo.
echo 即将发布到: %REPO%
echo 版本标签: v%VERSION%
echo.

set /p CONFIRM="确认发布？(y/n): "
if /i not "%CONFIRM%"=="y" (
    echo 已取消
    pause
    exit /b 0
)

echo.
echo [5/5] 发布到 GitHub Release...
echo.

gh release create v%VERSION% ^
  "%ANDROID_RELEASE%" ^
  "%WIN_RELEASE%" ^
  --repo %REPO% ^
  --title "v%VERSION% - TOTP 完整升级版" ^
  --notes-file TOTP_COMPLETE_UPGRADE_V%VERSION%.md

if %ERRORLEVEL% neq 0 (
    echo.
    echo [错误] 发布失败！
    echo.
    echo 如果 Release 已存在，可以用以下命令追加文件:
    echo gh release upload v%VERSION% "%ANDROID_RELEASE%" "%WIN_RELEASE%" --repo %REPO%
    pause
    exit /b %ERRORLEVEL%
)

echo.
echo ========================================
echo   ✓ 发布成功！
echo ========================================
echo.
echo Release 地址:
echo https://github.com/%REPO%/releases/tag/v%VERSION%
echo.

REM 清理临时文件
rmdir /s /q release_temp

echo 临时文件已清理
pause
