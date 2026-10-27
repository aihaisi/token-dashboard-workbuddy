@echo off
chcp 65001 >nul
setlocal EnableExtensions
title WorkBuddy Token Dashboard

rem ===================================================================
rem  WorkBuddy Token Dashboard - local launcher
rem  Starts server.py, which reads the WorkBuddy session logs on this
rem  machine and serves the dashboard at http://127.0.0.1:<port>/
rem  Content of this file is intentionally ASCII-only so that cmd.exe
rem  never garbles it regardless of the active code page.
rem ===================================================================

set "HERE=%~dp0"
set "PY="

rem ---- pick the first usable Python ----
if exist "%USERPROFILE%\.workbuddy\binaries\python\versions\3.13.12\python.exe" set "PY=%USERPROFILE%\.workbuddy\binaries\python\versions\3.13.12\python.exe"
if not defined PY if exist "%LOCALAPPDATA%\Programs\Python\Python313\python.exe" set "PY=%LOCALAPPDATA%\Programs\Python\Python313\python.exe"
if not defined PY if exist "%LOCALAPPDATA%\Programs\Python\Python314\python.exe" set "PY=%LOCALAPPDATA%\Programs\Python\Python314\python.exe"
if not defined PY if exist "%LOCALAPPDATA%\Programs\Python\Python312\python.exe" set "PY=%LOCALAPPDATA%\Programs\Python\Python312\python.exe"
if not defined PY if exist "%LOCALAPPDATA%\Programs\Python\Python311\python.exe" set "PY=%LOCALAPPDATA%\Programs\Python\Python311\python.exe"
if not defined PY (
  for /f "delims=" %%I in ('where python 2^>nul') do (
    if not defined PY set "PY=%%I"
  )
)

if not defined PY (
  echo.
  echo   [x] Python not found.
  echo.
  echo   This dashboard needs a local Python to read the logs. Two options:
  echo     1^) Install Python 3.10+ : https://www.python.org/downloads/
  echo     2^) Just double-click index.html and use the "choose log folder"
  echo        fallback ^(no Python needed, but the first parse of 100+
  echo        log files takes a dozen seconds^).
  echo.
  pause
  exit /b 1
)

echo.
echo   Starting WorkBuddy Token Dashboard ...
echo   Python : %PY%
echo   Logs   : %USERPROFILE%\.workbuddy\projects
echo.

"%PY%" "%HERE%server.py" %*
set "RC=%ERRORLEVEL%"

if not "%RC%"=="0" (
  echo.
  echo   [x] server exited with code %RC%
  pause
)
endlocal
