# Cherry Scheduler - chay public tu may nha (Cloudflare Tunnel)
# Usage:
#   .\tools\home-deploy\start-public.ps1
#   .\tools\home-deploy\start-public.ps1 -WithTunnel

param(
    [switch]$WithTunnel,
    [string]$HostBinding = "127.0.0.1",
    [int]$AppPort = 1010,
    [int]$MailPort = 8787
)

$ErrorActionPreference = "Stop"
$Root = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
Set-Location $Root

function Stop-CherryListeners {
    param([int[]]$Ports)
    foreach ($port in $Ports) {
        $lines = netstat -ano -p tcp | Select-String ":$port\s"
        foreach ($line in $lines) {
            $parts = ($line -replace '\s+', ' ').Trim().Split(' ')
            if ($parts.Length -lt 5) { continue }
            if ($parts[3] -ne 'LISTENING') { continue }
            $listenerPid = [int]$parts[-1]
            if ($listenerPid -gt 0) {
                Write-Host "Dung process PID $listenerPid tren port $port..."
                taskkill /PID $listenerPid /T /F 2>$null | Out-Null
            }
        }
    }
}

Write-Host "=== Cherry Scheduler - Home Public Server ===" -ForegroundColor Cyan
Write-Host "Thu muc: $Root"

Stop-CherryListeners -Ports @($AppPort, $MailPort)
Start-Sleep -Milliseconds 400

$mailDir = Join-Path $Root "mail-server"
if (-not (Test-Path (Join-Path $mailDir "node_modules"))) {
    Write-Host "Cai mail-server dependencies..."
    Push-Location $mailDir
    npm install --omit=dev
    Pop-Location
}

Write-Host "Khoi dong mail-server :$MailPort ..."
$env:PORT = "$MailPort"
$mailProc = Start-Process -FilePath "node" `
    -ArgumentList "server.js" `
    -WorkingDirectory $mailDir `
    -WindowStyle Hidden `
    -PassThru

Start-Sleep -Seconds 1

Write-Host "Khoi dong Cherry Scheduler :$AppPort ..."
$env:TKB_RUST_HOST = $HostBinding
$env:TKB_RUST_PORT = "$AppPort"
$appProc = Start-Process -FilePath "python" `
    -ArgumentList @("start.py", "--host", $HostBinding, "--port", "$AppPort", "--no-browser", "--no-launcher") `
    -WorkingDirectory $Root `
    -WindowStyle Hidden `
    -PassThru

Start-Sleep -Seconds 3

try {
    $health = Invoke-RestMethod -Uri "http://${HostBinding}:${AppPort}/api/health" -TimeoutSec 15
    Write-Host "App OK: api=$($health.api)" -ForegroundColor Green
} catch {
    Write-Host "Canh bao: chua kiem tra duoc /api/health - $($_.Exception.Message)" -ForegroundColor Yellow
}

try {
    $mailHealth = Invoke-RestMethod -Uri "http://127.0.0.1:${MailPort}/api/health" -TimeoutSec 8
    Write-Host "Mail OK: configured=$($mailHealth.configured)" -ForegroundColor Green
} catch {
    Write-Host "Canh bao: mail-server chua san sang - $($_.Exception.Message)" -ForegroundColor Yellow
}

if ($WithTunnel) {
    $tunnel = Join-Path $PSScriptRoot "run-tunnel.ps1"
    if (-not (Test-Path $tunnel)) {
        Write-Host "Thieu run-tunnel.ps1" -ForegroundColor Red
    } else {
        Write-Host "Khoi dong Cloudflare Tunnel..."
        & $tunnel
    }
} else {
    Write-Host ""
    Write-Host "Local:" -ForegroundColor Cyan
    Write-Host "  App : http://${HostBinding}:${AppPort}/"
    Write-Host "  Mail: http://127.0.0.1:${MailPort}/api/health"
    Write-Host ""
    Write-Host "De public ra internet qua ten mien:" -ForegroundColor Cyan
    Write-Host "  1. Cai cloudflared: .\tools\home-deploy\install-cloudflared.ps1"
    Write-Host "  2. Chay: .\tools\home-deploy\setup-tunnel.ps1 -Domain tenmien.com"
    Write-Host "  3. Chay: .\tools\home-deploy\start-public.ps1 -WithTunnel"
    Write-Host ""
    Write-Host "PID app=$($appProc.Id) mail=$($mailProc.Id)"
}
