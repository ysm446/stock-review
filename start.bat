@echo off
title Stock Advisor

echo ========================================
echo   Stock Advisor
echo ========================================

set PYTHONIOENCODING=utf-8
set OLLAMA_MODELS=%~dp0models
set PYTHON=D:\miniconda3\conda_envs\main\python.exe

if not exist "%PYTHON%" (
    echo [ERROR] Python not found: %PYTHON%
    pause
    exit /b 1
)

echo [INFO] Python : %PYTHON%
echo [INFO] Models : %OLLAMA_MODELS%
echo.

"%PYTHON%" "%~dp0app.py"

pause
