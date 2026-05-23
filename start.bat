@echo off
chcp 65001 > NUL
title Discord Live Translator - Launcher

:: Set paths
set PATH=C:\Program Files\nodejs;%PATH%
set "NVIDIA_PATH=C:\Users\miyam\AppData\Local\Programs\Python\Python310\lib\site-packages\nvidia"
set PATH=%NVIDIA_PATH%\cublas\bin;%NVIDIA_PATH%\cudnn\bin;%NVIDIA_PATH%\cuda_nvrtc\bin;%PATH%

echo ============================================================
echo   Discord Live Translator - 一括起動ランチャー
echo ============================================================
echo.

echo [1/3] Discord Bot & Webサーバーを起動しています...
start "Discord Live Translator - Bot" cmd /k "cd /d %~dp0bot && node index.js"

echo.
echo [2/3] GPU文字起こしクライアントを起動しています...
start "Discord Live Translator - Transcriber" cmd /k "cd /d %~dp0 && python transcriber\client_transcriber.py"

echo.
echo       システムの準備が整うのを待っています (5秒)...
timeout /t 5 /nobreak > nul

echo.
echo [3/3] ブラウザダッシュボードを開いています...
start http://localhost:3000

echo.
echo ============================================================
echo   起動処理が完了しました！
echo   ダッシュボード: http://localhost:3000
echo ============================================================
echo   この起動ランチャー窓は閉じて構いません。
echo   (BotとTranscriberはそれぞれの別窓で動き続けます)
echo.
pause
