@echo off
title LiveTranslator - GPU Transcriber Client

:: GPU paths
set "NVIDIA_PATH=C:\Users\miyam\AppData\Local\Programs\Python\Python310\lib\site-packages\nvidia"
set PATH=%NVIDIA_PATH%\cublas\bin;%NVIDIA_PATH%\cudnn\bin;%NVIDIA_PATH%\cuda_nvrtc\bin;%PATH%

echo ============================================================
echo   LiveTranslator - GPU Transcriber Client
echo ============================================================
echo.
echo [1/3] Checking GPU/VRAM requirements...
echo.

python transcriber\client_transcriber.py

if %ERRORLEVEL% NEQ 0 (
    echo.
    echo [Error] Failed to start transcriber client.
    echo Make sure you have at least 5GB free VRAM and NVIDIA CUDA.
    echo.
    pause
    exit /b %ERRORLEVEL%
)

echo.
pause
