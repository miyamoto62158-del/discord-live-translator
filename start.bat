@echo off
title Discord Live Translator - Launcher
chcp 65001 > nul

:: Set paths
set PATH=C:\Program Files\nodejs;%PATH%

echo ============================================================
echo   Discord Live Translator - Startup Launcher
echo ============================================================
echo.

echo [1/3] Updating to the latest version from GitHub...
git pull origin main
echo.

echo [2/3] Starting Discord Bot and Web Server...
start "Discord Live Translator - Bot" cmd /k "cd /d %~dp0bot && node index.js"

echo.
echo       Waiting for services to initialize (5 seconds)...
timeout /t 5 /nobreak > nul

echo.
echo ------------------------------------------------------------
echo 🌐 [Dashboard Sharing Option]
echo    Dashboard sharing is handled natively in the background.
echo    The Bot will automatically post the public URL and password
echo    directly in your Discord text channel when it joins!
echo ------------------------------------------------------------

echo.
echo [3/3] Opening Browser Dashboard...
start http://localhost:3000

for /f "tokens=4 delims= " %%i in ('route print ^| findstr "0.0.0.0" ^| findstr /v "127.0.0.1"') do (
    set LOCAL_IP=%%i
)

echo.
echo ============================================================
echo   Startup completed!
echo   Local Dashboard:   http://localhost:3000
if not "%LOCAL_IP%"=="" (
    echo   LAN/Wi-Fi Share:   http://%LOCAL_IP%:3000
)
echo ============================================================
echo   You can close this launcher window now.
echo   (Bot will continue running in another window)
echo.
pause
