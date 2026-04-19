@echo off
setlocal

cd /d "%~dp0"

set "CONDA_BAT=%UserProfile%\miniconda3\condabin\conda.bat"
if not exist "%CONDA_BAT%" (
  echo Conda was not found at:
  echo   %CONDA_BAT%
  echo Please update start.bat to match your Conda install path.
  pause
  exit /b 1
)

call "%CONDA_BAT%" activate main
if errorlevel 1 (
  echo Failed to activate Conda environment: main
  pause
  exit /b 1
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
