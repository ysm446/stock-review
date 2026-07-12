@echo off
setlocal

cd /d "%~dp0"

set "PYTHON_EXE=.venv\Scripts\python.exe"
set "REQUIREMENTS_MARKER=.venv\.requirements-installed.txt"
set "INSTALL_DEPENDENCIES=0"

if not exist "%PYTHON_EXE%" (
  echo Python virtual environment was not found. Creating .venv...
  py -3 -m venv .venv
  if errorlevel 1 (
    python -m venv .venv
    if errorlevel 1 (
      echo Failed to create Python virtual environment.
      pause
      exit /b 1
    )
  )
  set "INSTALL_DEPENDENCIES=1"
)

if not exist "%REQUIREMENTS_MARKER%" (
  set "INSTALL_DEPENDENCIES=1"
) else (
  fc /b "requirements.txt" "%REQUIREMENTS_MARKER%" >nul
  if errorlevel 1 set "INSTALL_DEPENDENCIES=1"
)

if "%INSTALL_DEPENDENCIES%"=="1" (
  echo Installing Python dependencies...
  call "%PYTHON_EXE%" -m pip install -r requirements.txt
  if errorlevel 1 (
    echo Python dependency installation failed.
    pause
    exit /b 1
  )
  copy /y "requirements.txt" "%REQUIREMENTS_MARKER%" >nul
)

if not exist "node_modules\electron" (
  echo Electron is not installed yet. Running npm install...
  call npm install
  if errorlevel 1 (
    echo npm install failed.
    pause
    exit /b 1
  )
)

call npm start
if errorlevel 1 (
  echo App failed to start.
  pause
  exit /b 1
)
