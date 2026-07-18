# Thiết lập Cloudflare Tunnel lần đầu (chạy 1 lần sau khi có domain trên Cloudflare)
param(
    [Parameter(Mandatory = $true)]
    [string]$Domain
)

$ErrorActionPreference = "Stop"
$bin = Join-Path $PSScriptRoot "bin\cloudflared.exe"
if (-not (Test-Path $bin)) {
    & (Join-Path $PSScriptRoot "install-cloudflared.ps1")
}

$configPath = Join-Path $PSScriptRoot "cloudflared-config.yml"
$example = Join-Path $PSScriptRoot "cloudflared-config.example.yml"
if (-not (Test-Path $configPath)) {
    Copy-Item $example $configPath
    (Get-Content $configPath -Raw).Replace("YOUR_DOMAIN.com", $Domain) | Set-Content $configPath -Encoding UTF8
}

Write-Host "=== Bước 1: Đăng nhập Cloudflare ===" -ForegroundColor Cyan
Write-Host "Trình duyệt sẽ mở — đăng nhập tài khoản Cloudflare và chọn domain $Domain"
& $bin tunnel login

Write-Host ""
Write-Host "=== Buoc 2: Tao tunnel ===" -ForegroundColor Cyan
& $bin tunnel create cherry-scheduler

$credDir = Join-Path $env:USERPROFILE ".cloudflared"
$credFile = Get-ChildItem -Path $credDir -Filter "*.json" | Where-Object { $_.Name -ne "cert.pem" } | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $credFile) {
    Write-Host "Khong tim thay file credentials trong $credDir" -ForegroundColor Red
    exit 1
}

$configText = (Get-Content $configPath -Raw).Replace("YOUR_DOMAIN.com", $Domain)
$configText = $configText -replace "credentials-file:.*", "credentials-file: $($credFile.FullName)"
Set-Content $configPath $configText -Encoding UTF8

Write-Host ""
Write-Host "=== Buoc 3: Gan DNS ===" -ForegroundColor Cyan
& $bin tunnel route dns cherry-scheduler $Domain

Write-Host ""
Write-Host "Hoàn tất. Kiểm tra file: $configPath"
Write-Host "Chạy server: .\tools\home-deploy\start-public.ps1 -WithTunnel"
