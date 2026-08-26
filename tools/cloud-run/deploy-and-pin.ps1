[CmdletBinding()]
param(
    [string]$ProjectId = 'project-61ee7855-507e-40a3-879',
    [string]$InvokerServiceAccount = 'tkb-cloud-run-invoker@project-61ee7855-507e-40a3-879.iam.gserviceaccount.com',
    [switch]$ConfirmDeployment
)

# 26/08/2026 — MOT LENH KHEP KIN cho ca chuoi deploy Cloud Run.
#
# VI SAO CAN: `deploy.ps1` chuyen 100% traffic sang revision moi TRUOC, con VPS
# van ghim digest CU cho toi khi chay tay `set-cloud-run-profiles.py` +
# `pin-cloud-run-digest.py`. Trong khoang ho do, Rust balancer bo qua moi profile
# (khac digest) va `cloud_run_client.py` tra 409 -> nguoi dung thay
# "khong nhan luot giai". Do that 26/08: gio 14h co 8/22 luot va 15h co 6/10 luot
# khong cham duoc Cloud Run, trong khi cac gio khong deploy gan nhu 0 loi.
#
# Script nay chay lien mach 4 buoc nen khoang ho chi con vai giay:
#   1. deploy.ps1 (build + canary + promote + 2 vung phu)   <- BAT BUOC co -InvokerServiceAccount
#   2. set-cloud-run-profiles.py --apply  (dung DUNG file JSON cua lan build nay)
#   3. pin-cloud-run-digest.py --apply    (2 drop-in systemd + 3 profile kvstore)
#   4. xac minh /health cua CA BA vung tra ve dung digest vua ghim
#
# HAI BAY DA MAC 26/08, script nay chan san:
#   * Thieu -InvokerServiceAccount: `gcloud auth print-identity-token --audiences`
#     doi service account, tai khoan nguoi dung khong dung duoc -> canary hong,
#     deploy tu rollback.
#   * Lay "file JSON moi nhat theo thoi gian": deploy.ps1 ghi file profiles SAU khi
#     promote, nen rat de vo phai file cua lan build TRUOC va ghi de nguoc digest
#     cua 2 vung phu. Script doc thang duong dan tu output.
#
# Chay:
#   powershell -ExecutionPolicy Bypass -File tools\cloud-run\deploy-and-pin.ps1 -ConfirmDeployment

$ErrorActionPreference = 'Stop'
if (-not $ConfirmDeployment) {
    throw 'No changes made. Re-run with -ConfirmDeployment.'
}

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
Set-Location $repoRoot
$python = Join-Path $env:LOCALAPPDATA 'Programs\Python\Python312\python.exe'
if (-not (Test-Path $python)) { $python = 'python' }

$stamp = (Get-Date).ToString('yyyyMMdd-HHmmss')
$log = Join-Path $env:TEMP "tkb-deploy-and-pin-$stamp.log"
function Step([string]$t) { Write-Host ''; Write-Host "==== $t ====" -ForegroundColor Cyan }

Step '1/4 Cloud Run: build + canary + promote (3 vung)'
& powershell -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'deploy.ps1') `
    -ProjectId $ProjectId -ConfirmDeployment -InvokerServiceAccount $InvokerServiceAccount *>&1 |
    Tee-Object -FilePath $log
$deployText = Get-Content $log -Raw

$digest = ([regex]::Matches($deployText, 'Solver digest:\s*([0-9a-f]{64})') |
    ForEach-Object { $_.Groups[1].Value } | Select-Object -Last 1)
if (-not $digest) { throw "Khong doc duoc solver digest tu output deploy. Xem $log" }

$profilesPath = ([regex]::Matches($deployText, 'Profiles written to\s+(.+?\.json)') |
    ForEach-Object { $_.Groups[1].Value.Trim() } | Select-Object -Last 1)

Write-Host ''
Write-Host "Digest moi : $digest"
Write-Host "Profiles   : $(if ($profilesPath) { $profilesPath } else { '(khong co - chi vung chinh)' })"

if ($profilesPath -and (Test-Path $profilesPath)) {
    $inFile = (Get-Content $profilesPath -Raw | Select-String -Pattern '"solverDigest":\s*"([0-9a-f]{64})"' -AllMatches).Matches |
        ForEach-Object { $_.Groups[1].Value } | Select-Object -Unique
    if ($inFile -and ($inFile -notcontains $digest)) {
        throw "File profiles ($profilesPath) mang digest '$inFile' KHAC digest vua build '$digest' - dung lai de khong ghi de nguoc."
    }
    Step '2/4 VPS: upsert profile tung vung'
    & $python (Join-Path $repoRoot 'tools\vps-deploy\set-cloud-run-profiles.py') $profilesPath --apply |
        Select-String 'kvstore|backup' | Select-Object -Last 1
} else {
    Write-Warning 'Khong co file profiles - bo qua buoc 2 (chi ghim digest).'
}

Step '3/4 VPS: ghim digest (2 drop-in systemd + moi profile kvstore)'
& $python (Join-Path $repoRoot 'tools\vps-deploy\pin-cloud-run-digest.py') $digest --apply |
    Select-Object -Last 3

Step '4/4 Xac minh: /health cua ca 3 vung phai tra dung digest vua ghim'
$urls = [ordered]@{
    'asia-southeast2' = 'https://tkb-solver-tys7xrhbca-et.a.run.app'
    'asia-southeast1' = 'https://tkb-solver-tys7xrhbca-as.a.run.app'
    'asia-east1'      = 'https://tkb-solver-tys7xrhbca-de.a.run.app'
}
$bad = 0
foreach ($region in $urls.Keys) {
    $u = $urls[$region]
    $tok = & gcloud auth print-identity-token --impersonate-service-account=$InvokerServiceAccount --audiences=$u --quiet 2>$null
    $tok = ($tok | Where-Object { $_ -and $_.Split('.').Count -eq 3 } | Select-Object -Last 1)
    try {
        $r = Invoke-WebRequest -UseBasicParsing -Uri ($u + '/health') -Headers @{ Authorization = "Bearer $tok" } -TimeoutSec 60
        $served = ($r.Content | Select-String -Pattern '"solverDigest":"([0-9a-f]{64})"').Matches.Groups[1].Value
        if ($served -eq $digest) {
            "{0,-16} OK   {1}" -f $region, $served.Substring(0, 16)
        } else {
            $bad++
            "{0,-16} LECH phuc vu {1} nhung da ghim {2}" -f $region, $served.Substring(0, 16), $digest.Substring(0, 16)
        }
    } catch {
        $bad++
        "{0,-16} LOI  {1}" -f $region, $_.Exception.Message
    }
}

Write-Host ''
if ($bad -gt 0) {
    Write-Warning "$bad vung chua khop digest - nguoi dung se gap 'khong nhan luot giai'. Xem $log"
    exit 1
}
Write-Host 'XONG: ca 3 vung deu phuc vu dung digest da ghim.' -ForegroundColor Green
Write-Host "Nhat ky: $log"
