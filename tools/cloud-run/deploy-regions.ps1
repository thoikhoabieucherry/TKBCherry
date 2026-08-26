[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[a-z][a-z0-9-]{4,28}[a-z0-9]$')]
    [string]$ProjectId,

    # Regions that receive the SAME solver image. Cloud Run CPU quota is
    # granted per project per region (20 vCPU on this project, Google refused
    # to raise it on 25/08/2026), so parallel solves are obtained by spreading
    # one service over several regions instead of one big region.
    # Accepts an array or one comma-separated string (validated below), so the
    # script works both in-process (&) and via `powershell -File`.
    [string[]]$Regions = @('asia-southeast1', 'asia-east1', 'asia-east2', 'asia-northeast1', 'asia-northeast2', 'asia-northeast3', 'asia-south1', 'asia-south2'),

    # Region whose serving revision provides the image, solver digest and
    # runtime service account when -Image / -SolverDigest are not given.
    [ValidatePattern('^[a-z]+(?:-[a-z0-9]+)+[0-9]$')]
    [string]$SourceRegion = 'asia-southeast2',

    [ValidatePattern('^[a-z][a-z0-9-]{0,61}[a-z0-9]$')]
    [string]$ServiceName = 'tkb-solver',

    [string]$Image = '',

    [ValidatePattern('^(?:[0-9a-f]{64})?$')]
    [string]$SolverDigest = '',

    # Per-region shape. Cloud Run counts the serving revision AND the new one
    # during a rollout against the 20 vCPU regional quota, so with
    # MaxInstances > 1 the new revision is deployed with max 1 first
    # (Cpu + Cpu*Max <= quota), promoted, then scaled up (Cpu*Max + Cpu <= quota).
    # 6 vCPU x 2 = 18/18 fits; 8 vCPU x 2 = 24 does not. Keep
    # TKB_CLOUD_RUN_MAX_WORKERS = Cpu.
    [ValidateSet(1, 2, 4, 6, 8)]
    [int]$Cpu = 6,

    [ValidateRange(2, 32)]
    [int]$MemoryGi = 12,

    [ValidateRange(1, 8)]
    [int]$MaxInstances = 2,

    [ValidateRange(1, 1000)]
    [int]$RegionCpuQuota = 20,

    [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9._+-]*@[A-Za-z0-9.-]+\.iam\.gserviceaccount\.com$')]
    [string]$InvokerServiceAccount = "tkb-cloud-run-invoker@$ProjectId.iam.gserviceaccount.com",

    [string]$RuntimeServiceAccount = '',

    # Where to write the profile list for tools/vps-deploy/set-cloud-run-profiles.py
    [string]$ProfilesOut = '',

    [switch]$ConfirmDeployment
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if (Get-Variable -Name PSNativeCommandUseErrorActionPreference -ErrorAction SilentlyContinue) {
    $PSNativeCommandUseErrorActionPreference = $false
}
if (-not $ConfirmDeployment) {
    throw 'No changes made. Re-run with -ConfirmDeployment after reviewing -Regions, -Cpu and -MaxInstances.'
}
$Regions = @($Regions | ForEach-Object { $_ -split ',' } | ForEach-Object { $_.Trim().ToLowerInvariant() } | Where-Object { $_ } | Select-Object -Unique)
if ($Regions.Count -eq 0) { throw 'No regions given.' }
foreach ($r in $Regions) {
    if ($r -notmatch '^[a-z]+(?:-[a-z0-9]+)+[0-9]$') { throw "Invalid region name: '$r'" }
}

$gcloud = Get-Command gcloud -ErrorAction SilentlyContinue
if (-not $gcloud) {
    $candidate = Join-Path $env:LOCALAPPDATA 'Google\Cloud SDK\google-cloud-sdk\bin\gcloud.cmd'
    if (Test-Path -LiteralPath $candidate -PathType Leaf) { $gcloud = Get-Item -LiteralPath $candidate }
}
if (-not $gcloud) { throw 'Google Cloud CLI (gcloud) is required.' }
$sourceProperty = $gcloud.PSObject.Properties['Source']
$script:GcloudPath = if ($sourceProperty -and $sourceProperty.Value) { [string]$sourceProperty.Value } else { [string]$gcloud.FullName }

function Invoke-Gcloud {
    param([Parameter(Mandatory = $true)][string[]]$Arguments, [switch]$Capture)
    $oldPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        if ($Capture) {
            $output = & $script:GcloudPath @Arguments 2>$null
            if ($LASTEXITCODE -ne 0) { throw "gcloud $($Arguments[0]) $($Arguments[1]) failed with exit code $LASTEXITCODE." }
            return (@($output) -join [Environment]::NewLine).Trim()
        }
        & $script:GcloudPath @Arguments
        if ($LASTEXITCODE -ne 0) { throw "gcloud $($Arguments[0]) $($Arguments[1]) failed with exit code $LASTEXITCODE." }
    }
    finally { $ErrorActionPreference = $oldPreference }
}

function Test-GcloudResource {
    param([Parameter(Mandatory = $true)][string[]]$Arguments)
    $oldPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        & $script:GcloudPath @Arguments *> $null
        return $LASTEXITCODE -eq 0
    }
    finally { $ErrorActionPreference = $oldPreference }
}

function Get-ServiceState {
    param([string]$RegionName)
    $raw = Invoke-Gcloud -Capture -Arguments @('run', 'services', 'describe', $ServiceName, "--region=$RegionName", '--format=json', "--project=$ProjectId")
    if ([string]::IsNullOrWhiteSpace($raw)) { throw "Cloud Run service '$ServiceName' in $RegionName returned no JSON." }
    return ($raw | ConvertFrom-Json)
}

function Get-TrafficSpec {
    param($State)
    $parts = @()
    foreach ($target in @($State.status.traffic)) {
        $rev = $target.PSObject.Properties['revisionName']
        $pct = $target.PSObject.Properties['percent']
        if ($rev -and $pct -and [int]$pct.Value -gt 0) { $parts += ("{0}={1}" -f [string]$rev.Value, [int]$pct.Value) }
    }
    return ($parts -join ',')
}

function Get-IdentityToken {
    param([string]$Audience)
    $tokenArgs = @('auth', 'print-identity-token')
    if (-not [string]::IsNullOrWhiteSpace($InvokerServiceAccount)) { $tokenArgs += "--impersonate-service-account=$InvokerServiceAccount" }
    $tokenArgs += @("--audiences=$Audience", '--quiet')
    $raw = Invoke-Gcloud -Capture -Arguments $tokenArgs
    $lines = @([regex]::Split([string]$raw, '\r?\n') | Where-Object { $_.Trim().Split('.').Count -eq 3 })
    if ($lines.Count -eq 0) { throw 'Google Cloud CLI returned no usable identity token.' }
    return $lines[-1].Trim()
}

function Test-HealthCanary {
    param([string]$Url, [string]$Audience, [string]$ExpectedRevision, [string]$ExpectedDigest, [int]$Attempts = 8)
    # A freshly created service answers 403 for ~1 minute until the invoker IAM
    # binding propagates; retry instead of failing the region.
    for ($attempt = 1; $attempt -le $Attempts; $attempt++) {
        try {
            $token = Get-IdentityToken -Audience $Audience
            $response = Invoke-WebRequest -UseBasicParsing -Method Get -Uri ($Url.TrimEnd('/') + '/health') -Headers @{ Authorization = "Bearer $token"; Accept = 'application/json' } -TimeoutSec 60
            if ([int]$response.StatusCode -ne 200) { throw "Health canary returned HTTP $($response.StatusCode)." }
            $health = [string]$response.Content | ConvertFrom-Json
            if ($health.ok -ne $true) { throw 'Health canary reports not ok.' }
            if ([string]$health.solverDigest -ne $ExpectedDigest) { throw "Health canary digest $($health.solverDigest) != expected $ExpectedDigest." }
            if ([string]$health.revision -ne $ExpectedRevision) { throw "Health canary revision $($health.revision) != expected $ExpectedRevision." }
            Write-Host "  health ok: revision=$($health.revision) digest=$($health.solverDigest)"
            return
        }
        catch {
            if ($attempt -ge $Attempts) { throw }
            Write-Host "  health attempt $attempt/$Attempts failed ($($_.Exception.Message.Trim())); retrying in 15 s..."
            Start-Sleep -Seconds 15
        }
    }
}

# ---------------------------------------------------------------------------
# Resolve image / digest / runtime SA from the source region when not given.
# ---------------------------------------------------------------------------
$sourceState = $null
if ([string]::IsNullOrWhiteSpace($Image) -or [string]::IsNullOrWhiteSpace($SolverDigest) -or [string]::IsNullOrWhiteSpace($RuntimeServiceAccount)) {
    $sourceState = Get-ServiceState -RegionName $SourceRegion
    $container = @($sourceState.spec.template.spec.containers)[0]
    if ([string]::IsNullOrWhiteSpace($Image)) { $Image = [string]$container.image }
    if ([string]::IsNullOrWhiteSpace($SolverDigest)) {
        foreach ($env in @($container.env)) {
            if ([string]$env.name -eq 'TKB_CLOUD_RUN_SOLVER_DIGEST') { $SolverDigest = ([string]$env.value).Trim().ToLowerInvariant() }
        }
    }
    if ([string]::IsNullOrWhiteSpace($RuntimeServiceAccount)) {
        $saProperty = $sourceState.spec.template.spec.PSObject.Properties['serviceAccountName']
        if ($saProperty) { $RuntimeServiceAccount = [string]$saProperty.Value }
    }
}
if ([string]::IsNullOrWhiteSpace($Image)) { throw 'No image resolved; pass -Image.' }
if ($SolverDigest -notmatch '^[0-9a-f]{64}$') { throw 'No 64-hex solver digest resolved; pass -SolverDigest.' }
# Rollout footprint: new revision (max 1 when scaling in two steps) + serving revision.
$deployMax = if ($MaxInstances -gt 1) { 1 } else { $MaxInstances }
$rolloutCpu = $Cpu * $deployMax + $Cpu * $MaxInstances
if ($rolloutCpu -gt $RegionCpuQuota) {
    throw "Shape $Cpu vCPU x $MaxInstances needs $rolloutCpu vCPU during a rollout but the regional quota is $RegionCpuQuota (max for $Cpu vCPU is $([math]::Floor($RegionCpuQuota / $Cpu) - 1) instances)."
}
Write-Host "Image:          $Image"
Write-Host "Solver digest:  $SolverDigest"
Write-Host "Runtime SA:     $(if ($RuntimeServiceAccount) { $RuntimeServiceAccount } else { '(default compute)' })"
Write-Host "Shape/region:   $Cpu vCPU / ${MemoryGi}Gi / concurrency 1 / max $MaxInstances instances / workers $Cpu"
Write-Host "Regions:        $($Regions -join ', ')"

$stamp = (Get-Date).ToUniversalTime().ToString('yyyyMMdd-HHmmss')
$profiles = @()
$failures = @()
$priority = 90

foreach ($region in $Regions) {
    Write-Host ''
    Write-Host "=== $region ==="
    $existed = Test-GcloudResource -Arguments @('run', 'services', 'describe', $ServiceName, "--region=$region", "--project=$ProjectId")
    $oldTraffic = ''
    $oldReady = ''
    if ($existed) {
        $before = Get-ServiceState -RegionName $region
        $oldTraffic = Get-TrafficSpec -State $before
        $oldReady = [string]$before.status.latestReadyRevisionName
        if ([string]::IsNullOrWhiteSpace($oldReady)) {
            # Shell left behind by a failed first deployment (e.g. "Project failed
            # to initialize in this region due to quota exceeded"): remove it and
            # treat the region as new.
            Write-Warning "$region has a service without any Ready revision; deleting the failed shell first."
            Invoke-Gcloud -Arguments @('run', 'services', 'delete', $ServiceName, "--region=$region", "--project=$ProjectId", '--quiet') | Out-Null
            $existed = $false
            $oldTraffic = ''
        }
    }
    # A new service has no serving revision to count against the quota, so it
    # can start with the full instance count; an existing one rolls out in
    # two steps (max 1 first, scale after promotion).
    $regionDeployMax = if ($existed) { $deployMax } else { $MaxInstances }
    $canaryTag = "canary-$stamp".ToLowerInvariant()
    $deployArgs = @(
        'run', 'deploy', $ServiceName,
        "--image=$Image",
        "--region=$region",
        '--platform=managed',
        '--execution-environment=gen2',
        "--cpu=$Cpu",
        "--memory=${MemoryGi}Gi",
        '--concurrency=1',
        '--timeout=300',
        '--min-instances=0',
        "--max-instances=$regionDeployMax",
        '--cpu-boost',
        '--no-allow-unauthenticated',
        '--labels=app=tkb-cherry,component=solver,runtime=cloud-run',
        "--set-env-vars=TKB_CLOUD_RUN_QUIET=1,TKB_CLOUD_RUN_MAX_WORKERS=$Cpu,TKB_CPSAT_THREADS=$Cpu,TKB_CLOUD_RUN_MAX_SOLVE_SECONDS=285,TKB_CLOUD_RUN_SOLVER_DIGEST=$SolverDigest",
        "--project=$ProjectId",
        '--quiet'
    )
    if ($existed) { $deployArgs += @('--no-traffic', "--tag=$canaryTag") }
    if (-not [string]::IsNullOrWhiteSpace($RuntimeServiceAccount)) { $deployArgs += "--service-account=$RuntimeServiceAccount" }

    $tagBound = $false
    try {
        Write-Host "Deploying $(if ($existed) { 'private revision (no traffic)' } else { 'NEW service' }) in $region..."
        Invoke-Gcloud -Arguments $deployArgs
        $after = Get-ServiceState -RegionName $region
        $newRevision = [string]$after.status.latestCreatedRevisionName
        $serviceUrl = [string]$after.status.url
        if ([string]::IsNullOrWhiteSpace($newRevision) -or [string]::IsNullOrWhiteSpace($serviceUrl)) { throw 'Deployment returned no revision/url.' }
        if ($existed -and $newRevision -eq $oldReady) { throw 'Deployment did not create a distinct revision.' }
        if ([string]$after.status.latestReadyRevisionName -ne $newRevision) { throw 'New revision did not become Ready.' }

        # The invoker SA must be allowed per service per region.
        Invoke-Gcloud -Arguments @('run', 'services', 'add-iam-policy-binding', $ServiceName, "--region=$region", "--member=serviceAccount:$InvokerServiceAccount", '--role=roles/run.invoker', "--project=$ProjectId", '--quiet') | Out-Null

        $canaryUrl = $serviceUrl
        if ($existed) {
            foreach ($target in @($after.status.traffic)) {
                $t = $target.PSObject.Properties['tag']; $r = $target.PSObject.Properties['revisionName']; $u = $target.PSObject.Properties['url']
                if ($t -and $r -and $u -and [string]$t.Value -eq $canaryTag -and [string]$r.Value -eq $newRevision) { $canaryUrl = [string]$u.Value; $tagBound = $true }
            }
            if (-not $tagBound) { throw 'Canary tag was not bound to the new revision.' }
        }
        Write-Host "Health canary on $canaryUrl ..."
        Test-HealthCanary -Url $canaryUrl -Audience $serviceUrl -ExpectedRevision $newRevision -ExpectedDigest $SolverDigest

        if ($existed) {
            Write-Host "Promoting $newRevision to 100% traffic..."
            Invoke-Gcloud -Arguments @('run', 'services', 'update-traffic', $ServiceName, "--to-revisions=$newRevision=100", "--region=$region", "--project=$ProjectId", '--quiet') | Out-Null
            Invoke-Gcloud -Arguments @('run', 'services', 'update-traffic', $ServiceName, "--remove-tags=$canaryTag", "--region=$region", "--project=$ProjectId", '--quiet') | Out-Null
            $tagBound = $false
        }

        # Second step of the quota-safe rollout: the promoted max-1 revision is
        # the only serving one, so a revision with the full instance count now
        # fits (Cpu*Max + Cpu <= quota). If it fails the region keeps serving
        # the verified max-1 revision and its profile says so.
        $finalRevision = $newRevision
        $effectiveMax = $regionDeployMax
        if ($MaxInstances -gt $regionDeployMax) {
            try {
                Write-Host "Scaling $region to max $MaxInstances instances..."
                Invoke-Gcloud -Arguments @('run', 'services', 'update', $ServiceName, "--max-instances=$MaxInstances", "--region=$region", "--project=$ProjectId", '--quiet') | Out-Null
                # `services update` creates a new revision but returns while
                # traffic is still pinned to the old one, and latestReady lags
                # a few seconds behind latestCreated (25/08: a single check here
                # retired three good max-2 revisions). Poll until they agree.
                $scaled = $null
                $scaledRevision = ''
                for ($wait = 0; $wait -lt 24; $wait++) {
                    $scaled = Get-ServiceState -RegionName $region
                    $scaledRevision = [string]$scaled.status.latestReadyRevisionName
                    if (-not [string]::IsNullOrWhiteSpace($scaledRevision) -and $scaledRevision -eq [string]$scaled.status.latestCreatedRevisionName) { break }
                    Start-Sleep -Seconds 5
                }
                if ([string]::IsNullOrWhiteSpace($scaledRevision) -or $scaledRevision -ne [string]$scaled.status.latestCreatedRevisionName) { throw "Scaled revision $($scaled.status.latestCreatedRevisionName) did not become Ready within 2 minutes." }
                $scaledMax = [int]$scaled.spec.template.metadata.annotations.'autoscaling.knative.dev/maxScale'
                if ($scaledMax -ne $MaxInstances) { throw "Ready revision reports max $scaledMax instead of $MaxInstances." }
                if ($scaledRevision -ne $newRevision) {
                    Invoke-Gcloud -Arguments @('run', 'services', 'update-traffic', $ServiceName, "--to-revisions=$scaledRevision=100", "--region=$region", "--project=$ProjectId", '--quiet') | Out-Null
                }
                Test-HealthCanary -Url $serviceUrl -Audience $serviceUrl -ExpectedRevision $scaledRevision -ExpectedDigest $SolverDigest
                $finalRevision = $scaledRevision
                $effectiveMax = $MaxInstances
            }
            catch {
                Write-Warning "$region stays at max $regionDeployMax instance(s): $($_.Exception.Message)"
                $failures += "$region : scale-up to $MaxInstances failed ($($_.Exception.Message)); serving $newRevision at max $regionDeployMax"
                try { Invoke-Gcloud -Arguments @('run', 'services', 'update-traffic', $ServiceName, "--to-revisions=$newRevision=100", "--region=$region", "--project=$ProjectId", '--quiet') | Out-Null } catch {}
            }
        }
        $profiles += [ordered]@{
            id = "cloud-run-$ProjectId-$region"
            projectId = $ProjectId
            region = $region
            url = $serviceUrl.Trim()
            solverDigest = $SolverDigest
            vcpu = $Cpu
            memoryGiB = $MemoryGi
            maxConcurrency = $effectiveMax
            priority = $priority
            enabled = $true
            revision = $finalRevision
        }
        $priority -= 1
        Write-Host "OK $region -> $serviceUrl ($finalRevision, max $effectiveMax)"
    }
    catch {
        $failures += "$region : $($_.Exception.Message)"
        Write-Warning "$region failed: $($_.Exception.Message)"
        if (-not $existed) {
            # First deployment failed (typically MaxRegionsPerProject — 3 on this
            # project, Google refused to raise it 25/08): remove the shell so the
            # next run does not treat the region as an existing service.
            Write-Warning "$region : if gcloud said 'quota exceeded' this is the Cloud Run quota MaxRegionsPerProject; removing the empty service."
            try { Invoke-Gcloud -Arguments @('run', 'services', 'delete', $ServiceName, "--region=$region", "--project=$ProjectId", '--quiet') | Out-Null } catch {}
        }
        if ($existed -and $oldTraffic) {
            try {
                Invoke-Gcloud -Arguments @('run', 'services', 'update-traffic', $ServiceName, "--to-revisions=$oldTraffic", "--region=$region", "--project=$ProjectId", '--quiet') | Out-Null
                Write-Warning "$region traffic restored to $oldTraffic"
            }
            catch { Write-Warning "$region traffic restore failed: $($_.Exception.Message)" }
        }
        if ($tagBound) {
            try { Invoke-Gcloud -Arguments @('run', 'services', 'update-traffic', $ServiceName, "--remove-tags=$canaryTag", "--region=$region", "--project=$ProjectId", '--quiet') | Out-Null } catch {}
        }
    }
}

Write-Host ''
Write-Host "Solver digest: $SolverDigest"
$json = ConvertTo-Json -InputObject @($profiles) -Depth 5
if (-not [string]::IsNullOrWhiteSpace($ProfilesOut)) {
    [System.IO.File]::WriteAllText($ProfilesOut, $json, (New-Object System.Text.UTF8Encoding($false)))
    Write-Host "Profiles written to $ProfilesOut (feed to tools/vps-deploy/set-cloud-run-profiles.py)"
}
else {
    Write-Host 'Profiles (feed to tools/vps-deploy/set-cloud-run-profiles.py):'
    Write-Host $json
}
if ($failures.Count -gt 0) {
    Write-Host ''
    Write-Warning ("Regions that failed:`n  " + ($failures -join "`n  "))
    exit 1
}
