@echo off
cmd /k "set PYTHONIOENCODING=utf-8 & set OLLAMA_MODELS=%~dp0models & D:\miniconda3\conda_envs\main\python.exe D:\GitHub\stock-advisor\app.py"
