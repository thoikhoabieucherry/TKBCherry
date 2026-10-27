@echo off
rem Cherry tren may nay: chay bo giai engine v3 bang CPU cua may nay cho nut gat "May nay"
rem tren trang Sap xep (tkbcherry.com). Can Python 3.10+ (python.org, tick "Add to PATH").
chcp 65001 >nul
cd /d "%~dp0"

set "PY=python"
where py >nul 2>nul && set "PY=py -3"

set "REQ=solver_runtime\requirements.txt"
if not exist "%REQ%" set "REQ=..\..\solver_runtime\requirements.txt"

%PY% -c "import ortools, numpy, scipy" 1>nul 2>nul
if errorlevel 1 (
  echo Lan dau chay: dang cai thu vien bo giai ^(ortools, numpy, scipy^)...
  %PY% -m pip install --user -r "%REQ%"
  if errorlevel 1 (
    echo Khong cai duoc thu vien. Kiem tra Python va ket noi mang roi chay lai.
    pause
    exit /b 1
  )
)

%PY% cherry_local_solver.py %*
pause
