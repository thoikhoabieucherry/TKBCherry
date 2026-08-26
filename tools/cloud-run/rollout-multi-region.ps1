[CmdletBinding()]
param(
    [string]$ProjectId = 'project-61ee7855-507e-40a3-879',
    # Primary first (it is re-shaped to the same Cpu/MaxInstances), then the
    # secondary regions. Each region has its own 20 vCPU Cloud Run quota.
    # Cloud Run quota MaxRegionsPerProject = 3 on this project (Google refused
    # 10 on 25/08/2026): Jakarta (primary) + Singapore + Taiwan -> 3 x 2 = 6
    # parallel solves. Add regions here only after that quota is raised.
    [string[]]$Regions = @('asia-southeast2', 'asia-southeast1', 'asia-east1'),
    # 6 vCPU is the largest shape that still allows 2 instances per region
    # within the 20 vCPU quota (two-step rollout 6+12 / 12+6 <= 20).
    [int]$Cpu = 6,
    [int]$MemoryGi = 12,
    [int]$MaxInstances = 2,
    [switch]$SkipCloudRun,   # regions already deployed; only do the VPS part
    [switch]$SkipVps,        # only deploy Cloud Run regions + write profiles JSON
    [switch]$ConfirmDeployment
)
# One-shot rollout of the multi-region Cloud Run solver (25/08/2026):
#   1. deploy-regions.ps1  : same image -> every region (canary + promote), profiles JSON
#   2. deploy-files.py     : Rust balancer + client failover sources -> VPS (backup + restart)
#   3. build-rust.py       : cargo build --release on the VPS, swap binary when idle
#   4. set-cloud-run-profiles.py : upsert one profile per region into the kvstore
#   5. cherry-canary.ps1   : authenticated Cherry solve against each region
# Run in a normal PowerShell window (the `!` prefix of the Claude session is cut at 120 s):
#   powershell -ExecutionPolicy Bypass -File tools\cloud-run\rollout-multi-region.ps1 -ConfirmDeployment
$ErrorActionPreference = 'Stop'
if (-not $ConfirmDeployment) { throw 'Re-run with -ConfirmDeployment.' }
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
Set-Location $repoRoot
$python = Join-Path $env:LOCALAPPDATA 'Programs\Python\Python312\python.exe'
if (-not (Test-Path $python)) { $python = 'python' }
$profilesPath = Join-Path $env:LOCALAPPDATA 'TKBCherry\cloud-run-profiles-multi-region.json'
New-Item -ItemType Directory -Force (Split-Path $profilesPath) | Out-Null

function Step([string]$title) { Write-Host ''; Write-Host "==== $title ====" -ForegroundColor Cyan }

if (-not $SkipCloudRun) {
    Step "1/5 Cloud Run: deploy current image to $($Regions -join ', ') ($Cpu vCPU x $MaxInstances)"
    # Call in-process: `powershell -File` would flatten the -Regions array into
    # separate positional arguments (25/08: "asia-east2" landed in -SolverDigest).
    $global:LASTEXITCODE = 0
    & (Join-Path $PSScriptRoot 'deploy-regions.ps1') `
        -ProjectId $ProjectId -Regions $Regions -SourceRegion 'asia-southeast2' `
        -Cpu $Cpu -MemoryGi $MemoryGi -MaxInstances $MaxInstances `
        -ProfilesOut $profilesPath -ConfirmDeployment
    if ($LASTEXITCODE -ne 0) {
        $deployed = 0
        if (Test-Path $profilesPath) { $deployed = @((Get-Content -Raw -Encoding UTF8 $profilesPath | ConvertFrom-Json)).Count }
        if ($deployed -eq 0) { throw "deploy-regions.ps1 failed (exit $LASTEXITCODE) and no region was deployed." }
        Write-Warning "deploy-regions.ps1 reported failures; continuing with the $deployed region(s) that succeeded (see warnings above)."
    }
}
if (-not (Test-Path $profilesPath)) { throw "Profiles JSON missing: $profilesPath (run without -SkipCloudRun first)." }

if (-not $SkipVps) {
    Step '2/5 VPS: upload Rust balancer + Cloud Run client sources (backup multi-region-20260825)'
    # --no-restart: build-rust.py restarts later, after waiting for an idle solver.
    & $python tools\vps-deploy\deploy-files.py deploy multi-region-20260825 --no-restart `
        rust_api/src/main.rs rust_api/src/serverless.rs solver_runtime/scripts/cloud_run_client.py
    if ($LASTEXITCODE -ne 0) { throw "deploy-files.py failed (exit $LASTEXITCODE)" }

    Step '3/5 VPS: cargo build --release and swap the binary when the solver is idle'
    & $python tools\vps-deploy\build-rust.py --apply
    if ($LASTEXITCODE -ne 0) { throw "build-rust.py failed (exit $LASTEXITCODE)" }

    Step '4/5 VPS: upsert one Cloud Run profile per region (kvstore, no restart needed)'
    & $python tools\vps-deploy\set-cloud-run-profiles.py $profilesPath --apply
    if ($LASTEXITCODE -ne 0) { throw "set-cloud-run-profiles.py failed (exit $LASTEXITCODE)" }
}

Step '5/5 Canary: authenticated Cherry solve on every region'
$profiles = Get-Content -Raw -Encoding UTF8 $profilesPath | ConvertFrom-Json
foreach ($p in @($profiles)) {
    Write-Host "-- $($p.region): $($p.url)"
    try {
        & powershell -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'cherry-canary.ps1') -ServiceUrl $p.url -ExpectedDigest $p.solverDigest
    }
    catch { Write-Warning "canary failed for $($p.region): $($_.Exception.Message)" }
}
Write-Host ''
Write-Host 'Done. Watch: gcloud logging read for 429s per region, and solver_telemetry_events on the VPS.' -ForegroundColor Green
