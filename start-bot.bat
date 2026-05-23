@echo off
chcp 65001 > NUL
title LiveTranslator - Cloud Bot Server

:: Node.js path
set PATH=C:\Program Files\nodejs;%PATH%

echo ============================================================
echo   LiveTranslator - Cloud Bot Server
echo ============================================================
echo.
echo [1/1] Starting Discord Bot and Web Server...
echo.

cd /d %~dp0bot
node index.js

if %ERRORLEVEL% NEQ 0 (
    echo.
    echo [Error] Failed to start Bot.
    echo Please check DISCORD_TOKEN in bot/.env.
    echo.
    pause
    exit /b %ERRORLEVEL%
)

echo.
pause
