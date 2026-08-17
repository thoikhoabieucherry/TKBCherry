@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo Deploy 5 file web (engine + worker + phanmon + css + sapxep) len VPS...
py deploy_web_quick.py || python deploy_web_quick.py
pause
