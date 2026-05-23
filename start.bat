@echo off
title Discord Live Translator - Launcher
chcp 65001 > nul

:: Set paths
set PATH=C:\Program Files\nodejs;%PATH%
set "NVIDIA_PATH=C:\Users\miyam\AppData\Local\Programs\Python\Python310\lib\site-packages\nvidia"
set PATH=%NVIDIA_PATH%\cublas\bin;%NVIDIA_PATH%\cudnn\bin;%NVIDIA_PATH%\cuda_nvrtc\bin;%PATH%

echo ============================================================
echo   Discord Live Translator - Startup Launcher
echo ============================================================
echo.

echo [1/3] Starting Discord Bot and Web Server...
start "Discord Live Translator - Bot" cmd /k "cd /d %~dp0bot && node index.js"

echo.
echo [2/3] Starting GPU Transcriber Client...
start "Discord Live Translator - Transcriber" cmd /k "cd /d %~dp0 && python transcriber\client_transcriber.py"

echo.
echo       Waiting for services to initialize (5 seconds)...
timeout /t 5 /nobreak > nul

echo.
echo ------------------------------------------------------------
echo 🌐 [Dashboard Sharing Option]
echo    Would you like to share the dashboard with remote friends?
echo    (This generates a public link so they can view it directly)
echo ------------------------------------------------------------
set /p SHARE_CHOICE="Enable public URL (localtunnel) in a new window? [Y/N]: "
if /i "%SHARE_CHOICE%"=="Y" (
    echo.
    echo [INFO] Starting tunnel in a new window...
    echo        Remote members might be asked for your Public IP.
    echo        Check your Public IP at: https://ipv4.icanhazip.com/
    echo.
    start "Discord Live Translator - Share Tunnel" cmd /k "npx localtunnel --port 3000"
)

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
echo   (Bot and Transcriber will continue running in other windows)
echo.
pause
