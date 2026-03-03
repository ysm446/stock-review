@echo off
chcp 65001 >nul
title Stock Review

echo ========================================
echo   Stock Review (Electron)
echo ========================================

set PYTHONIOENCODING=utf-8
set PYTHONUTF8=1
set STOCK_REVIEW_ROOT=%~dp0
set CONDA_BAT=
set PYTHON_EXECUTABLE=python

for /f "delims=" %%C in ('where conda.bat 2^>nul') do (
  set CONDA_BAT=%%C
  goto :conda_found
)

:conda_found
if "%CONDA_BAT%"=="" (
  echo [ERROR] conda.bat not found in PATH.
  echo [ERROR] Add Conda to PATH or run from Anaconda Prompt.
  pause
  exit /b 1
)

call "%CONDA_BAT%" activate main
if errorlevel 1 (
  echo [ERROR] Failed to activate conda env: main
  pause
  exit /b 1
)

where %PYTHON_EXECUTABLE% >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Python executable not found in PATH.
  pause
  exit /b 1
)

where npm >nul 2>&1
if errorlevel 1 (
  echo [ERROR] npm not found. Please install Node.js first.
  pause
  exit /b 1
)

echo [INFO] Python : %PYTHON_EXECUTABLE%
echo [INFO] Root   : %STOCK_REVIEW_ROOT%
echo.

cd /d "%STOCK_REVIEW_ROOT%"
if not exist "node_modules\electron\*" (
  echo [INFO] Installing Node dependencies...
  npm install
  if errorlevel 1 (
    echo [ERROR] npm install failed.
    pause
    exit /b 1
  )
)

npx electron .
if errorlevel 1 (
  echo [ERROR] Electron failed to start.
  pause
  exit /b 1
)

pause

