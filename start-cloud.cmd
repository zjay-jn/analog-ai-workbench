@echo off
setlocal
cd /d "%~dp0"
call npm run start:cloud %*
if errorlevel 1 pause
endlocal
