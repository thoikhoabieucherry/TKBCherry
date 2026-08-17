@echo off
chcp 65001 >nul
cd /d "%~dp0"
if exist .git\index.lock del /f .git\index.lock
echo Doi ten commit va day lai len GitHub...
git commit --amend -m "TKBCherry v1.69" || goto :err
git push -f origin HEAD:main || goto :err
echo.
echo XONG! Ten commit tren GitHub gio la: TKBCherry v1.69
pause
exit /b 0
:err
echo *** LOI - chup man hinh gui Claude. ***
pause
exit /b 1
