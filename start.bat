@echo off
chcp 65001 > NUL
title Discord Live Translator

:: Set paths
set PATH=C:\Program Files\nodejs;%PATH%
set "NVIDIA_PATH=C:\Users\miyam\AppData\Local\Programs\Python\Python310\lib\site-packages\nvidia"
set PATH=%NVIDIA_PATH%\cublas\bin;%NVIDIA_PATH%\cudnn\bin;%NVIDIA_PATH%\cuda_nvrtc\bin;%PATH%

:: Load .env variables (DISCORD_TOKEN, GEMINI_API_KEY, etc.)
for /f "usebackq tokens=1,* delims==" %%a in ("bot\.env") do (
    set "%%a=%%b"
)

echo ============================================
echo   Discord Live Translator - Starting...
echo ============================================
echo.

echo [1/3] Starting Python Transcriber Server...
start "Transcriber Server" cmd /k "cd /d %~dp0transcriber && python server.py"

echo       Waiting for model load...
timeout /t 10 /nobreak > nul

echo [2/3] Starting Discord Bot...
start "Discord Bot" cmd /k "cd /d %~dp0bot && node index.js"

timeout /t 3 /nobreak > nul

echo [3/3] Opening Dashboard...
start http://localhost:3000

echo.
echo ============================================
echo   All started! Dashboard: http://localhost:3000
echo ============================================
echo   Close this window anytime.
echo   (Bot and Transcriber will keep running)
echo.
pause
