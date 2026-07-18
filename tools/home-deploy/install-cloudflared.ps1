# Tải cloudflared cho Windows (Cloudflare Tunnel)
$ErrorActionPreference = "Stop"
$destDir = Join-Path $PSScriptRoot "bin"
$exe = Join-Path $destDir "cloudflared.exe"

if (Test-Path $exe) {
    Write-Host "cloudflared đã có: $exe"
    & $exe --version
    exit 0
}

New-Item -ItemType Directory -Force -Path $destDir | Out-Null
$url = "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe"
Write-Host "Đang tải cloudflared..."
Invoke-WebRequest -Uri $url -OutFile $exe -UseBasicParsing
Write-Host "Đã cài: $exe"
& $exe --version
