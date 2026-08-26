param(
    [string]$ServiceUrl = 'https://tkb-solver-tys7xrhbca-et.a.run.app',
    [string]$ExpectedDigest = '',
    # 22/08: tai khoan gcloud tren may dev la tai khoan NGUOI DUNG -> khong
    # mint duoc ID token co --audiences; phai muon danh SA invoker (cung SA ma
    # deploy.ps1 -InvokerServiceAccount dung).
    [string]$InvokerServiceAccount = 'tkb-cloud-run-invoker@project-61ee7855-507e-40a3-879.iam.gserviceaccount.com'
)
# Authenticated canary of the CHERRY engine (settings.engine="cherry") on the
# Cloud Run service. Token stays in memory only.
$ErrorActionPreference = 'Stop'
$gcloud = Join-Path $env:LOCALAPPDATA 'Google\Cloud SDK\google-cloud-sdk\bin\gcloud.cmd'
$tokenArgs = @('auth', 'print-identity-token')
if (-not [string]::IsNullOrWhiteSpace($InvokerServiceAccount)) {
    $tokenArgs += "--impersonate-service-account=$InvokerServiceAccount"
}
$tokenArgs += @("--audiences=$ServiceUrl", '--quiet')
# gcloud in canh bao "using service account impersonation" ra stderr; voi
# $ErrorActionPreference='Stop' PowerShell 5.1 bien no thanh loi dung -> tam
# ha xuong Continue quanh loi goi (token van chi nam trong bien $raw).
$prevEap = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
$raw = & $gcloud @tokenArgs 2>$null
$ErrorActionPreference = $prevEap
$token = @([regex]::Split([string]($raw -join "`n"), '\r?\n') | Where-Object { $_.Trim().Split('.').Count -eq 3 })
$token = $token[-1].Trim()
if (-not $token) { throw 'no identity token' }

$health = Invoke-WebRequest -UseBasicParsing -Method Get -Uri ($ServiceUrl.TrimEnd('/') + '/health') -Headers @{ Authorization = "Bearer $token"; Accept = 'application/json' } -TimeoutSec 30
Write-Host "health: $($health.StatusCode) $($health.Content)"

$classes = @()
$pccm = [ordered]@{}
$pccmTiet = [ordered]@{}
$subjectRules = [ordered]@{}
$subjects = @(@('Toan',4,2),@('Van',4,2),@('Anh',3,2),@('Su',2,1),@('Dia',2,1),@('GDCD',1,1))
foreach ($i in 1..6) {
    $cid = "L$i"
    $classes += [ordered]@{ id = $cid; ten = "6/$i"; khoi = '6' }
    foreach ($s in $subjects) {
        $pccm["$cid|$($s[0])"] = "GV_$($s[0])"
        $pccmTiet["$cid|$($s[0])"] = $s[1]
    }
}
foreach ($s in @('Toan','Van')) {
    $byClass = [ordered]@{}
    foreach ($i in 1..6) { $byClass["L$i"] = [ordered]@{ lessonBlocks = [ordered]@{ '2' = [ordered]@{ min = 1; max = 0 } } } }
    $subjectRules[$s] = [ordered]@{ byClass = $byClass }
}
$request = [ordered]@{
    data = [ordered]@{
        lop = $classes
        giaovien = @($subjects | ForEach-Object { [ordered]@{ magv = "GV_$($_[0])"; ten = "GV $($_[0])" } })
        monhoc = @($subjects | ForEach-Object { [ordered]@{ ten = $_[0]; ma = $_[0].Substring(0,2).ToUpper() } })
        mon = @($subjects | ForEach-Object { [ordered]@{ khoi = '6'; ten = $_[0]; sotiet = $_[1]; gioihan = $_[2] } })
        pccmMatrix = $pccm
        pccmTietMatrix = $pccmTiet
        tkbConstraints = [ordered]@{ subject = $subjectRules }
        tkb = [ordered]@{}
    }
    settings = [ordered]@{
        engine = 'cherry'
        overall_time_limit_seconds = 20
        backend_deadline_ms = 20000
        num_workers = 2
        random_seed = 5
        require_complete_schedule = $false
    }
} | ConvertTo-Json -Depth 14 -Compress
$headers = @{ Authorization = "Bearer $token"; Accept = 'application/x-ndjson'; 'X-TKB-Cloud-Protocol' = 'tkb-cloud-solver-v1' }
if ($ExpectedDigest) { $headers['X-TKB-Expected-Solver-Digest'] = $ExpectedDigest }
$resp = Invoke-WebRequest -UseBasicParsing -Method Post -Uri ($ServiceUrl.TrimEnd('/') + '/solve') -Headers $headers -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($request)) -TimeoutSec 120
$text = if ($resp.Content -is [byte[]]) { [Text.Encoding]::UTF8.GetString($resp.Content) } else { [string]$resp.Content }
$line = @([regex]::Split($text, '\r?\n') | Where-Object { $_.Trim().StartsWith('@@TKB_RESULT@@') })[0]
$wrapper = $line.Trim().Substring('@@TKB_RESULT@@'.Length) | ConvertFrom-Json
$p = $wrapper.payload
$m = $p.metrics
$rs = $p.solver.runtime_settings
$v3 = $p.solver.engine_v3
Write-Host ("status={0} ok={1} route={2} requested={3} digest={4} revision={5}" -f $wrapper.status, $p.ok, $rs.engine_route, $rs.engine_requested, $rs.cloud_solver_digest, $rs.cloud_revision)
Write-Host ("scheduled={0}/{1} hard_ok={2} violations={3} one_period={4} sessions={5}" -f $m.scheduled_periods, $m.expected_periods, $m.hard_ok, $m.app_constraint_violation_count, $m.one_period_teacher_sessions, $m.teacher_sessions)
Write-Host ("engine_v3.objective={0} stages={1} locks={2}" -f (($v3.objective) -join ','), ($v3.stages | ConvertTo-Json -Compress), ($v3.locks | ConvertTo-Json -Compress))
