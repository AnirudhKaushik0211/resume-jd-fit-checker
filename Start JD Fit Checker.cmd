@echo off
setlocal
rem ==========================================================================
rem  JD Fit Checker - Windows launcher. Double-click this file to start the tool.
rem  It runs the local server in THIS window and opens your browser when it is ready.
rem  Close this window (or press Ctrl+C) to stop the tool.
rem  Test switches (not needed for normal use): JDFC_LAUNCHER_TEST=1 = no pause at the end,
rem  JDFC_NO_BROWSER=1 = do not open the browser. PORT=<number> = preferred port (default 4317).
rem ==========================================================================
cd /d "%~dp0"
title JD Fit Checker
echo.
echo  ==================================================
echo    JD Fit Checker
echo    Runs only on this computer. Nothing is uploaded.
echo  ==================================================
echo.

if not exist "server.cjs" goto :notextracted
if not exist "lib\profiles.cjs" goto :notextracted

where node >nul 2>nul
if errorlevel 1 goto :nonode
set "JDFC_NODE_MAJOR="
for /f "tokens=1 delims=." %%v in ('node -v 2^>nul') do set "JDFC_NODE_MAJOR=%%v"
if not defined JDFC_NODE_MAJOR goto :nonode
set "JDFC_NODE_MAJOR=%JDFC_NODE_MAJOR:v=%"
set /a JDFC_NODE_MAJOR=JDFC_NODE_MAJOR+0 >nul 2>nul
if %JDFC_NODE_MAJOR% LSS 22 goto :oldnode

echo Starting JD Fit Checker. Your browser opens by itself in a few seconds.
echo.
set "JDFC_LAUNCHER=1"
node server.cjs
if errorlevel 1 goto :failed
echo.
echo JD Fit Checker has stopped.
if "%JDFC_LAUNCHER_TEST%"=="1" exit /b 0
echo This window closes in 10 seconds.
timeout /t 10 >nul
exit /b 0

:failed
set "JDFC_EXIT=%errorlevel%"
echo.
echo JD Fit Checker stopped with an error (code %JDFC_EXIT%).
echo Read the messages above. The README section "Troubleshooting" explains the usual fixes.
call :hold
exit /b %JDFC_EXIT%

:notextracted
echo This file cannot find the rest of the tool (server.cjs) next to it.
echo.
echo Please extract (unzip) the folder first, then double-click this file inside the extracted folder.
echo   1. Close this window.
echo   2. Right-click the downloaded .zip file and choose "Extract All...", then click Extract.
echo   3. Open the extracted folder and double-click "Start JD Fit Checker.cmd" there.
call :hold
exit /b 3

:nonode
echo Node.js is not installed (or Windows cannot find it yet).
echo JD Fit Checker needs Node.js version 22 or newer. It is free and installs once.
echo.
echo   1. The Node.js download page opens in your browser now.
echo      Download the "LTS" Windows Installer (.msi) and run it with the default options.
echo   2. When it has finished, close this window and double-click "Start JD Fit Checker.cmd" again.
echo      (If it still says Node.js is missing, restart the computer once.)
if not "%JDFC_NO_BROWSER%"=="1" start "" "https://nodejs.org/en/download"
call :hold
exit /b 2

:oldnode
echo Your Node.js is too old (version %JDFC_NODE_MAJOR%). JD Fit Checker needs version 22 or newer.
echo.
echo   1. The Node.js download page opens in your browser now.
echo      Download the "LTS" Windows Installer (.msi) and run it; it replaces the old version.
echo   2. Then close this window and double-click "Start JD Fit Checker.cmd" again.
if not "%JDFC_NO_BROWSER%"=="1" start "" "https://nodejs.org/en/download"
call :hold
exit /b 4

:hold
if "%JDFC_LAUNCHER_TEST%"=="1" exit /b 0
echo.
pause
exit /b 0
