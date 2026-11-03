@echo off
setlocal
cd /d "%~dp0"
set "PATH=%~dp0.local\toolchains\node-v24.20.0-win-x64;%PATH%"
call npm run start:cloud
if errorlevel 1 pause
endlocal
