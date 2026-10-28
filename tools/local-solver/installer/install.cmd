@echo off
rem IExpress chay file nay sau khi giai nen Cherry.exe vao thu muc tam.
powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0install.ps1"
exit /b %errorlevel%
