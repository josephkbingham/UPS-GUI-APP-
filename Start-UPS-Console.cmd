@echo off
setlocal
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0Start-UPS-Console.ps1"
if errorlevel 1 pause
