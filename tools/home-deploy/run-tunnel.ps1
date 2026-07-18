$ErrorActionPreference = "Stop"
$bin = Join-Path $PSScriptRoot "bin\cloudflared.exe"
$config = Join-Path $PSScriptRoot "cloudflared-config.yml"

if (-not (Test-Path $bin)) {
    & (Join-Path $PSScriptRoot "install-cloudflared.ps1")
}
if (-not (Test-Path $config)) {
    Write-Host "Chưa có cloudflared-config.yml — chạy setup-tunnel.ps1 -Domain tenmien.com trước." -ForegroundColor Red
    exit 1
}

Write-Host "Cloudflare Tunnel đang chạy (Ctrl+C để dừng)..." -ForegroundColor Cyan
& $bin tunnel --config $config run cherry-scheduler
