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

echo [0/3] Updating to the latest version from GitHub...
git pull origin main
echo.

:: Check if GEMINI_API_KEY is configured in bot/.env
set "USE_GEMINI="
if exist "%~dp0bot\.env" (
    for /f "usebackq tokens=1,2 delims==" %%A in ("%~dp0bot\.env") do (
        if "%%A"=="GEMINI_API_KEY" (
            if not "%%B"=="" if not "%%B"=="your-gemini-api-key-here" (
                set "USE_GEMINI=true"
            )
        )
    )
)

echo [1/3] Starting Discord Bot and Web Server...
start "Discord Live Translator - Bot" cmd /k "cd /d %~dp0bot && node index.js"

echo.
if "%USE_GEMINI%"=="true" (
    echo [2/3] Gemini Cloud Mode is active (GEMINI_API_KEY detected).
    echo       Skipping GPU Transcriber Client startup...
) else (
    echo [2/3] Starting GPU Transcriber Client...
    start "Discord Live Translator - Transcriber" cmd /k "cd /d %~dp0 && python transcriber\client_transcriber.py"
)

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
echo   (Bot and Transcriber will continue running in other windows)
echo.
pause
