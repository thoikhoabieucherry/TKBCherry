@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ============================================================
echo  TKBCherry: dua TOAN BO du an len GitHub (lich su moi, sach)
echo ============================================================
echo.

if exist .git\index.lock del /f .git\index.lock

echo [1/4] Tao nhanh moi (khong mang lich su cu)...
git checkout --orphan gh-sach || goto :err
git add -A || goto :err
git commit -m "TKBCherry - toan bo du an (lich su moi, don sach 2026-08-17)" || goto :err

echo [2/4] Doi ten thanh main (de len main cu)...
git branch -M main || goto :err

echo [3/4] Day len GitHub, ghi de lich su cu...
git push -f origin main || goto :err

echo [4/4] Don cac branch cu tren GitHub...
for %%b in (codex/agent-1.6.33-ci codex/v169-first-clean-backup codex/v169-two-stage-optimizer codex/v171-progressive-stop-flush codex/v172-live-progress-stop-checkpoints dependabot/cargo/rust_api/rust-dependencies-c9971bf3aa dependabot/github_actions/github-actions-0db7e86f54 dependabot/npm_and_yarn/mail-server/mail-server-dependencies-6ebc6f6bfd) do git push origin --delete %%b

echo.
echo ============================================================
echo  XONG! Kiem tra: https://github.com/thoikhoabieucherry/TKBCherry
echo  NHO: Settings cua repo phai de PRIVATE (co du lieu truong hoc)
echo ============================================================
pause
exit /b 0

:err
echo.
echo *** LOI - dung lai. Chup man hinh loi gui Claude xu ly. ***
pause
exit /b 1
