@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion

echo ========================================
echo   CodeBridge Desktop 构建脚本 (Windows)
echo ========================================
echo.

cd /d "%~dp0"

echo [1/3] 检查依赖...
if not exist "node_modules" (
    echo 首次构建，正在安装依赖...
    call npm install
    if !ERRORLEVEL! neq 0 (
        echo [错误] npm install 失败
        pause
        exit /b !ERRORLEVEL!
    )
)

echo [2/3] 清理旧的构建产物...
if exist "dist" (
    rmdir /s /q "dist"
)

echo [3/3] 构建 Windows 安装包...
call npm run build:win

if !ERRORLEVEL! neq 0 (
    echo.
    echo [错误] 构建失败！
    pause
    exit /b !ERRORLEVEL!
)

echo.
echo ========================================
echo   ✓ 构建完成！
echo ========================================
echo.
echo 安装包位置:
dir /b "dist\*.exe" 2>nul
echo.
echo 完整路径:
for %%f in (dist\*.exe) do echo   %~dp0%%f
echo.
echo 可用于发布到 GitHub Release
echo 建议重命名为: Msg2Computer-Setup-1.0.7.exe
pause
