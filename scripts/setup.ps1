# TKB DEMO setup (Windows PowerShell)
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

Write-Host "TKB DEMO setup" -ForegroundColor Cyan
Write-Host "Root: $Root"

function Test-MsvcLinker {
    $vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
    if (Test-Path $vswhere) {
        $installPath = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath 2>$null
        if ($installPath) {
            $link = Get-ChildItem -Path "$installPath\VC\Tools\MSVC\*\bin\Hostx64\x64\link.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
            if ($link) { return $true }
        }
    }
    return [bool](Get-Command link.exe -ErrorAction SilentlyContinue)
}

function Copy-PrebuiltRustApi {
    $prebuilt = Join-Path $Root "rust_api\prebuilt\tkb_rust_api.exe"
    $target = Join-Path $Root "rust_api\target\release\tkb_rust_api.exe"
    if ((Test-Path $prebuilt) -and -not (Test-Path $target)) {
        New-Item -ItemType Directory -Force -Path (Split-Path $target) | Out-Null
        Copy-Item $prebuilt $target -Force
        Write-Host "Copied prebuilt Rust API -> $target" -ForegroundColor Green
        return $true
    }
    return $false
}

Write-Host "`n[1/3] Python solver dependencies..." -ForegroundColor Yellow
python -m pip install -r "$Root\solver_runtime\requirements.txt"
if ($LASTEXITCODE -ne 0) {
    Write-Host "pip install failed. Check Python is on PATH." -ForegroundColor Red
    exit 1
}

Write-Host "`n[2/3] Environment file..." -ForegroundColor Yellow
$envExample = Join-Path $Root ".env.example"
$envFile = Join-Path $Root ".env"
if ((Test-Path $envExample) -and -not (Test-Path $envFile)) {
    Copy-Item $envExample $envFile
    Write-Host "Created .env from .env.example — set TKB_SUPER_PASSWORD before production use." -ForegroundColor DarkYellow
}

Write-Host "`n[3/3] Rust API..." -ForegroundColor Yellow
$usedPrebuilt = Copy-PrebuiltRustApi
if ($usedPrebuilt) {
    Write-Host "Using prebuilt binary (skip cargo build)." -ForegroundColor Green
} elseif (Get-Command cargo -ErrorAction SilentlyContinue) {
    if (-not (Test-MsvcLinker)) {
        Write-Host "MSVC linker (link.exe) not found." -ForegroundColor Red
        Write-Host "Install: winget install Microsoft.VisualStudio.2022.BuildTools" -ForegroundColor Yellow
        Write-Host "Or place tkb_rust_api.exe in rust_api\prebuilt\" -ForegroundColor Gray
    } else {
        Push-Location "$Root\rust_api"
        cargo build --release
        $buildOk = ($LASTEXITCODE -eq 0)
        Pop-Location
        if (-not $buildOk) {
            Push-Location "$Root\rust_api"
            cargo build
            Pop-Location
        }
    }
} else {
    Write-Host "cargo not found — place tkb_rust_api.exe in rust_api\prebuilt\ or install Rust." -ForegroundColor DarkYellow
}

Write-Host "`nDone. Run: python .\start.py" -ForegroundColor Green
Write-Host "Set TKB_SUPER_PASSWORD in .env for super admin login." -ForegroundColor DarkYellow
