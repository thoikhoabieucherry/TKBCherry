@echo off
chcp 65001 >nul
cd /d "%~dp0"
if exist .git\index.lock del /f .git\index.lock

echo [1/2] Day ban sach (gh-sach) len GitHub de len main...
git push -f origin gh-sach:main || goto :err

echo [2/2] Don ten nhanh o may (khong bat buoc)...
git branch -M main
git push -u origin main

echo.
echo ============================================================
echo  XONG! Kiem tra: https://github.com/thoikhoabieucherry/TKBCherry
echo  Nho de repo o che do PRIVATE (Settings cua repo tren GitHub)
echo ============================================================
pause
exit /b 0

:err
echo.
echo *** LOI khi push. Neu hien cua so dang nhap GitHub thi dang nhap roi chay lai. ***
echo *** Hoac mo cmd go tay:  git push -f origin gh-sach:main ***
pause
exit /b 1
