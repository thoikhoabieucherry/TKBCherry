[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[a-z][a-z0-9-]{4,28}[a-z0-9]$')]
    [string]$ProjectId,

    [ValidatePattern('^[a-z]+(?:-[a-z0-9]+)+[0-9]$')]
    [string]$Region = 'asia-southeast2',

    [ValidatePattern('^[a-z][a-z0-9-]{0,61}[a-z0-9]$')]
    [string]$ServiceName = 'tkb-solver',

    [ValidatePattern('^[a-z][a-z0-9-]{0,61}[a-z0-9]$')]
    [string]$Repository = 'tkb-cloud-run',

    [ValidateRange(1, 50)]
    [int]$MaxInstances = 3,

    [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9._+-]*@[A-Za-z0-9.-]+\.iam\.gserviceaccount\.com$')]
    [string]$InvokerServiceAccount,

    [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9._+-]*@[A-Za-z0-9.-]+\.iam\.gserviceaccount\.com$')]
    [string]$RuntimeServiceAccount,

    [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$')]
    [string]$ProfileId,

    [ValidateRange(0, 1000000)]
    [double]$ProfileBudgetUsd = 300,

    [ValidateRange(0.0001, 1000)]
    [double]$EstimatedCostUsd = 0.06,

    [switch]$ConfirmDeployment,

    [switch]$ValidateBuildContext
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# PowerShell 7 can turn a non-zero native exit code into a terminating error.
# The helpers below inspect LASTEXITCODE themselves so error messages never need
# to echo command output (which could contain environment-specific details).
if (Get-Variable -Name PSNativeCommandUseErrorActionPreference -ErrorAction SilentlyContinue) {
    $PSNativeCommandUseErrorActionPreference = $false
}

if (-not $ConfirmDeployment) {
    throw 'No changes made. Re-run with -ConfirmDeployment after reviewing the target project and billing account.'
}

$gcloud = Get-Command gcloud -ErrorAction SilentlyContinue
if (-not $gcloud) {
    $knownGcloudPaths = @(
        (Join-Path $env:LOCALAPPDATA 'Google\Cloud SDK\google-cloud-sdk\bin\gcloud.cmd'),
        (Join-Path ${env:ProgramFiles(x86)} 'Google\Cloud SDK\google-cloud-sdk\bin\gcloud.cmd'),
        (Join-Path $env:ProgramFiles 'Google\Cloud SDK\google-cloud-sdk\bin\gcloud.cmd')
    ) | Where-Object { $_ -and (Test-Path -LiteralPath $_ -PathType Leaf) }
    if (@($knownGcloudPaths).Count -gt 0) {
        $gcloud = Get-Item -LiteralPath @($knownGcloudPaths)[0]
    }
}
if (-not $gcloud) {
    throw 'Google Cloud CLI (gcloud) is required. Install it, run gcloud auth login interactively, then retry.'
}
$sourceProperty = $gcloud.PSObject.Properties['Source']
$script:GcloudPath = if ($sourceProperty -and $sourceProperty.Value) {
    [string]$sourceProperty.Value
} else {
    [string]$gcloud.FullName
}

function Copy-CloudBuildFile {
    param(
        [Parameter(Mandatory = $true)][string]$Source,
        [Parameter(Mandatory = $true)][string]$Destination
    )
    $parent = Split-Path -Parent $Destination
    New-Item -ItemType Directory -Force -Path $parent | Out-Null
    Copy-Item -LiteralPath $Source -Destination $Destination -Force
}

function New-MinimalCloudBuildContext {
    param([Parameter(Mandatory = $true)][string]$RepositoryRoot)

    $context = Join-Path ([IO.Path]::GetTempPath()) (
        'tkb-cloud-run-build-' + [Guid]::NewGuid().ToString('N')
    )
    New-Item -ItemType Directory -Force -Path $context | Out-Null
    try {
        $files = @(
            'solver_runtime\requirements.txt',
            'solver_runtime\scripts\solve_stdio.py',
            'solver_runtime\scripts\cloud_run_service.py',
            'tools\cloud-run\Dockerfile',
            'tools\cloud-run\cloudbuild.yaml',
            'tools\cloud-run\.gcloudignore'
        )
        foreach ($relative in $files) {
            Copy-CloudBuildFile `
                -Source (Join-Path $RepositoryRoot $relative) `
                -Destination (Join-Path $context $relative)
        }
        $solverSourceRoot = (Resolve-Path (Join-Path $RepositoryRoot 'solver_runtime\src')).Path
        Get-ChildItem -LiteralPath $solverSourceRoot -Recurse -File |
            Where-Object { $_.Extension -in @('.py', '.json') } |
            ForEach-Object {
                $relative = $_.FullName.Substring($solverSourceRoot.Length).TrimStart('\', '/')
                Copy-CloudBuildFile `
                    -Source $_.FullName `
                    -Destination (Join-Path (Join-Path $context 'solver_runtime\src') $relative)
            }

        # Fail closed if the explicit context ever grows beyond solver code and
        # build metadata.  School workbooks, databases and credentials are never
        # submitted to Cloud Build, even when the repository worktree is dirty.
        $forbidden = Get-ChildItem -LiteralPath $context -Recurse -File | Where-Object {
            $_.Extension -match '^\.(?:db|sqlite|sqlite3|xls|xlsx|key|pem|p12|pfx)$' -or
            $_.Name -match '(?i)(?:credential|service-account|secret)'
        }
        if ($forbidden) {
            throw 'Minimal Cloud Build context contains a forbidden file.'
        }
        return $context
    }
    catch {
        Remove-Item -LiteralPath $context -Recurse -Force -ErrorAction SilentlyContinue
        throw
    }
}

function Get-SolverSourceDigest {
    param([Parameter(Mandatory = $true)][string]$BuildContext)

    $root = (Resolve-Path (Join-Path $BuildContext 'solver_runtime')).Path
    $lines = Get-ChildItem -LiteralPath $root -Recurse -File |
        Sort-Object FullName |
        ForEach-Object {
            $relative = $_.FullName.Substring($root.Length).TrimStart('\', '/').Replace('\', '/')
            $hash = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
            "$relative`:$hash"
        }
    $bytes = [Text.Encoding]::UTF8.GetBytes((($lines -join "`n") + "`n"))
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
        return ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant()
    }
    finally {
        $sha.Dispose()
    }
}

if ($ValidateBuildContext) {
    $validationRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
    $validationContext = New-MinimalCloudBuildContext -RepositoryRoot $validationRoot
    try {
        $validationFiles = @(Get-ChildItem -LiteralPath $validationContext -Recurse -File)
        [PSCustomObject]@{
            ok = $true
            files = $validationFiles.Count
            bytes = ($validationFiles | Measure-Object Length -Sum).Sum
            solverDigest = Get-SolverSourceDigest -BuildContext $validationContext
            includesTests = @($validationFiles | Where-Object { $_.FullName -match '[\\/]tests[\\/]' }).Count -gt 0
        } | ConvertTo-Json -Compress
    }
    finally {
        Remove-Item -LiteralPath $validationContext -Recurse -Force -ErrorAction SilentlyContinue
    }
    return
}

function Invoke-Gcloud {
    param(
        [Parameter(Mandatory = $true)]
        [string[]]$Arguments,
        [switch]$Capture
    )

    if ($Capture) {
        $output = & $script:GcloudPath @Arguments 2>$null
        $exitCode = $LASTEXITCODE
        if ($exitCode -ne 0) {
            throw "gcloud $($Arguments[0]) failed with exit code $exitCode."
        }
        return (@($output) -join [Environment]::NewLine).Trim()
    }

    & $script:GcloudPath @Arguments
    $exitCode = $LASTEXITCODE
    if ($exitCode -ne 0) {
        throw "gcloud $($Arguments[0]) failed with exit code $exitCode."
    }
}

function Test-GcloudResource {
    param(
        [Parameter(Mandatory = $true)]
        [string[]]$Arguments
    )

    $oldPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        & $script:GcloudPath @Arguments *> $null
        return $LASTEXITCODE -eq 0
    }
    finally {
        $ErrorActionPreference = $oldPreference
    }
}

function ConvertFrom-GcloudJson {
    param(
        [Parameter(Mandatory = $true)][string]$Json,
        [Parameter(Mandatory = $true)][string]$ResourceName
    )

    if ([string]::IsNullOrWhiteSpace($Json)) {
        throw "$ResourceName returned no JSON."
    }
    try {
        return $Json | ConvertFrom-Json
    }
    catch {
        throw "$ResourceName returned invalid JSON."
    }
}

function Get-CloudRunServiceState {
    param(
        [Parameter(Mandatory = $true)][string]$Project,
        [Parameter(Mandatory = $true)][string]$RegionName,
        [Parameter(Mandatory = $true)][string]$Name
    )

    $raw = Invoke-Gcloud -Capture -Arguments @(
        'run', 'services', 'describe', $Name,
        "--region=$RegionName",
        '--format=json',
        "--project=$Project"
    )
    return ConvertFrom-GcloudJson -Json $raw -ResourceName "Cloud Run service '$Name'"
}

function Get-CloudRunRevisionState {
    param(
        [Parameter(Mandatory = $true)][string]$Project,
        [Parameter(Mandatory = $true)][string]$RegionName,
        [Parameter(Mandatory = $true)][string]$Revision
    )

    $raw = Invoke-Gcloud -Capture -Arguments @(
        'run', 'revisions', 'describe', $Revision,
        "--region=$RegionName",
        '--format=json',
        "--project=$Project"
    )
    return ConvertFrom-GcloudJson -Json $raw -ResourceName "Cloud Run revision '$Revision'"
}

function Get-RevisionTrafficSpec {
    param([Parameter(Mandatory = $true)][object]$ServiceState)

    $assignments = @()
    foreach ($target in @($ServiceState.status.traffic)) {
        $revisionProperty = $target.PSObject.Properties['revisionName']
        $percentProperty = $target.PSObject.Properties['percent']
        if (-not $revisionProperty -or -not $percentProperty) {
            continue
        }
        $revision = [string]$revisionProperty.Value
        $percent = [int]$percentProperty.Value
        if (-not [string]::IsNullOrWhiteSpace($revision) -and $percent -gt 0) {
            $assignments += "$revision=$percent"
        }
    }
    if ($assignments.Count -eq 0) {
        $readyRevision = [string]$ServiceState.status.latestReadyRevisionName
        if (-not [string]::IsNullOrWhiteSpace($readyRevision)) {
            $assignments += "$readyRevision=100"
        }
    }
    return ($assignments -join ',')
}

function Assert-CloudRunRevision {
    param(
        [Parameter(Mandatory = $true)][object]$RevisionState,
        [Parameter(Mandatory = $true)][string]$ExpectedRevision,
        [Parameter(Mandatory = $true)][string]$ExpectedDigest
    )

    if ([string]$RevisionState.metadata.name -ne $ExpectedRevision) {
        throw 'Cloud Run revision identity does not match the newly created revision.'
    }
    $ready = @($RevisionState.status.conditions) | Where-Object {
        [string]$_.type -eq 'Ready' -and [string]$_.status -eq 'True'
    }
    if (@($ready).Count -ne 1) {
        throw 'New Cloud Run revision is not Ready.'
    }
    $environment = @{}
    $containers = @($RevisionState.spec.containers)
    if ($containers.Count -ne 1) {
        throw 'Cloud Run revision must contain exactly one solver container.'
    }
    foreach ($item in @($containers[0].env)) {
        $name = [string]$item.name
        if (-not [string]::IsNullOrWhiteSpace($name)) {
            $environment[$name] = [string]$item.value
        }
    }
    if ($environment['TKB_CLOUD_RUN_SOLVER_DIGEST'] -ne $ExpectedDigest) {
        throw 'Cloud Run revision advertises an unexpected solver digest.'
    }
    if ($environment['TKB_CLOUD_RUN_MAX_SOLVE_SECONDS'] -ne '285') {
        throw 'Cloud Run revision does not enforce the 285-second solver ceiling.'
    }
}

function Invoke-AuthenticatedCloudRunCanary {
    param(
        [Parameter(Mandatory = $true)][string]$CanaryUrl,
        [Parameter(Mandatory = $true)][string]$Audience,
        [Parameter(Mandatory = $true)][string]$ExpectedRevision,
        [Parameter(Mandatory = $true)][string]$ExpectedDigest
    )

    # Keep the short-lived ID token only in PowerShell memory. It is never
    # printed, stored, passed to another process, or added to a build log.
    $identityToken = Invoke-Gcloud -Capture -Arguments @(
        'auth', 'print-identity-token',
        "--audiences=$Audience",
        '--quiet'
    )
    if ([string]::IsNullOrWhiteSpace($identityToken) -or $identityToken.Split('.').Count -ne 3) {
        throw 'Google Cloud CLI returned no usable short-lived identity token.'
    }
    try {
        $response = Invoke-WebRequest `
            -UseBasicParsing `
            -Method Get `
            -Uri ($CanaryUrl.TrimEnd('/') + '/health') `
            -Headers @{
                Authorization = "Bearer $identityToken"
                Accept = 'application/json'
            } `
            -TimeoutSec 30
        if ([int]$response.StatusCode -ne 200) {
            throw 'Authenticated Cloud Run canary returned a non-200 status.'
        }
        $health = ConvertFrom-GcloudJson `
            -Json ([string]$response.Content) `
            -ResourceName 'Cloud Run canary health'
        if ($health.ok -ne $true) {
            throw 'Authenticated Cloud Run canary is unhealthy.'
        }
        if ([string]$health.solverDigest -ne $ExpectedDigest) {
            throw 'Authenticated Cloud Run canary returned an unexpected solver digest.'
        }
        if ([string]$health.revision -ne $ExpectedRevision) {
            throw 'Authenticated Cloud Run canary returned an unexpected revision.'
        }
        if ([string]$response.Headers['X-TKB-Solver-Digest'] -ne $ExpectedDigest) {
            throw 'Authenticated Cloud Run canary digest header is missing or stale.'
        }
        if ([string]$response.Headers['X-TKB-Solver-Revision'] -ne $ExpectedRevision) {
            throw 'Authenticated Cloud Run canary revision header is missing or stale.'
        }

        $smokeRequest = [ordered]@{
            data = [ordered]@{
                lop = @([ordered]@{ id = '6A'; ten = '6A'; khoi = '6' })
                monhoc = @([ordered]@{ id = 'math'; ten = 'Math' })
                mon = @([ordered]@{ khoi = '6'; ten = 'Math'; sotiet = 2; gioihan = 2 })
                pccmMatrix = [ordered]@{ '6A|Math' = 'Teacher 1' }
                pccmTietMatrix = [ordered]@{ '6A|Math' = 2 }
                tkb = [ordered]@{}
            }
            settings = [ordered]@{
                solver_mode = 'auto'
                auto_sort_mode = 'fast'
                require_complete_schedule = $true
                overall_time_limit_seconds = 15
                backend_deadline_ms = 15000
                native_global_deadline_ms = 15000
                num_workers = 1
            }
        } | ConvertTo-Json -Depth 12 -Compress
        $solveResponse = Invoke-WebRequest `
            -UseBasicParsing `
            -Method Post `
            -Uri ($CanaryUrl.TrimEnd('/') + '/solve') `
            -Headers @{
                Authorization = "Bearer $identityToken"
                Accept = 'application/x-ndjson'
                'X-TKB-Cloud-Protocol' = 'tkb-cloud-solver-v1'
                'X-TKB-Expected-Solver-Digest' = $ExpectedDigest
            } `
            -ContentType 'application/json; charset=utf-8' `
            -Body ([Text.Encoding]::UTF8.GetBytes($smokeRequest)) `
            -TimeoutSec 60
        $terminalLines = @(
            [regex]::Split([string]$solveResponse.Content, '\r?\n') |
                Where-Object { $_.Trim().StartsWith('@@TKB_RESULT@@') }
        )
        if ($terminalLines.Count -ne 1) {
            throw 'Authenticated Cloud Run solve canary returned no unique terminal wrapper.'
        }
        $terminalJson = $terminalLines[0].Trim().Substring('@@TKB_RESULT@@'.Length)
        $wrapper = ConvertFrom-GcloudJson `
            -Json $terminalJson `
            -ResourceName 'Cloud Run solve canary'
        $payload = $wrapper.payload
        $metrics = $payload.metrics
        if ([int]$wrapper.status -ne 200 -or $payload.ok -ne $true) {
            throw 'Authenticated Cloud Run solve canary did not return success.'
        }
        if (
            [int]$metrics.scheduled_periods -ne 2 `
            -or [int]$metrics.expected_periods -ne 2 `
            -or [int]$metrics.unassigned_periods -ne 0 `
            -or $metrics.hard_ok -ne $true `
            -or $metrics.core_hard_ok -ne $true `
            -or [int]$metrics.app_constraint_violation_count -ne 0 `
            -or [int]$metrics.one_period_teacher_sessions -ne 0
        ) {
            throw 'Authenticated Cloud Run solve canary failed canonical completeness or hard validation.'
        }
        $gap2 = 0
        $gap2Property = $metrics.PSObject.Properties['teacher_gap2_sessions']
        if ($gap2Property) {
            $gap2 = [int]$gap2Property.Value
        }
        $gapDistributionProperty = $metrics.PSObject.Properties['gap_distribution']
        if ($gapDistributionProperty -and $gapDistributionProperty.Value) {
            foreach ($gap in $gapDistributionProperty.Value.PSObject.Properties) {
                $gapSize = 0
                if ([int]::TryParse([string]$gap.Name, [ref]$gapSize) -and $gapSize -ge 2) {
                    $gap2 += [int]$gap.Value
                }
            }
        }
        if ($gap2 -ne 0) {
            throw 'Authenticated Cloud Run solve canary returned Gap2 debt.'
        }
        $runtime = $payload.solver.runtime_settings
        if (
            [string]$runtime.cloud_solver_digest -ne $ExpectedDigest `
            -or [string]$runtime.cloud_revision -ne $ExpectedRevision
        ) {
            throw 'Authenticated Cloud Run solve canary provenance is missing or stale.'
        }
    }
    finally {
        $identityToken = $null
    }
}

$activeAccount = Invoke-Gcloud -Capture -Arguments @(
    'auth', 'list',
    '--filter=status:ACTIVE',
    '--format=value(account)'
)
if ([string]::IsNullOrWhiteSpace($activeAccount)) {
    throw 'No active gcloud account. Run gcloud auth login interactively; never paste credentials into this script or chat.'
}

Invoke-Gcloud -Capture -Arguments @(
    'projects', 'describe', $ProjectId,
    '--format=value(projectId)',
    '--quiet'
) | Out-Null

try {
    $billingEnabled = Invoke-Gcloud -Capture -Arguments @(
        'billing', 'projects', 'describe', $ProjectId,
        '--format=value(billingEnabled)'
    )
}
catch {
    throw 'Unable to verify billing for the selected project. Confirm billing access and link an active billing account in Google Cloud Console before retrying.'
}
if ($billingEnabled.Trim().ToLowerInvariant() -ne 'true') {
    throw 'Billing is not enabled for this project. No changes were made; link an active billing account and retry.'
}

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$cloudBuildFile = Join-Path $PSScriptRoot 'cloudbuild.yaml'
$ignoreFile = Join-Path $PSScriptRoot '.gcloudignore'
if (-not (Test-Path -LiteralPath $cloudBuildFile -PathType Leaf)) {
    throw "Missing Cloud Build config: $cloudBuildFile"
}
if (-not (Test-Path -LiteralPath $ignoreFile -PathType Leaf)) {
    throw "Missing Cloud Build ignore file: $ignoreFile"
}

Write-Host 'Enabling the Google Cloud APIs required by the private solver service...'
Invoke-Gcloud -Arguments @(
    'services', 'enable',
    'artifactregistry.googleapis.com',
    'cloudbuild.googleapis.com',
    'iam.googleapis.com',
    'iamcredentials.googleapis.com',
    'logging.googleapis.com',
    'monitoring.googleapis.com',
    'run.googleapis.com',
    "--project=$ProjectId",
    '--quiet'
)

$repositoryExists = Test-GcloudResource -Arguments @(
    'artifacts', 'repositories', 'describe', $Repository,
    "--location=$Region",
    "--project=$ProjectId"
)
if (-not $repositoryExists) {
    Write-Host "Creating Artifact Registry repository '$Repository' in $Region..."
    Invoke-Gcloud -Arguments @(
        'artifacts', 'repositories', 'create', $Repository,
        '--repository-format=docker',
        "--location=$Region",
        '--description=Private images for the TKB Cherry solver',
        "--project=$ProjectId",
        '--quiet'
    )
}

$tag = (Get-Date).ToUniversalTime().ToString('yyyyMMdd-HHmmss')
$image = "$Region-docker.pkg.dev/$ProjectId/$Repository/tkb-solver:$tag"

Write-Host 'Submitting the solver image to Google Cloud Build (no local Docker installation is needed)...'
$buildContext = New-MinimalCloudBuildContext -RepositoryRoot $repoRoot
try {
    $solverDigest = Get-SolverSourceDigest -BuildContext $buildContext
    $buildConfigFile = Join-Path $buildContext 'tools\cloud-run\cloudbuild.yaml'
    $buildIgnoreFile = Join-Path $buildContext 'tools\cloud-run\.gcloudignore'
    Invoke-Gcloud -Arguments @(
        'builds', 'submit', $buildContext,
        "--config=$buildConfigFile",
        "--ignore-file=$buildIgnoreFile",
        "--substitutions=_IMAGE=$image,_SOLVER_DIGEST=$solverDigest",
        "--project=$ProjectId",
        '--quiet'
    )
}
finally {
    Remove-Item -LiteralPath $buildContext -Recurse -Force -ErrorAction SilentlyContinue
}

$serviceExistedBefore = Test-GcloudResource -Arguments @(
    'run', 'services', 'describe', $ServiceName,
    "--region=$Region",
    "--project=$ProjectId"
)
$serviceStateBefore = $null
$oldTrafficSpec = ''
$oldReadyRevision = ''
if ($serviceExistedBefore) {
    $serviceStateBefore = Get-CloudRunServiceState `
        -Project $ProjectId `
        -RegionName $Region `
        -Name $ServiceName
    $oldTrafficSpec = Get-RevisionTrafficSpec -ServiceState $serviceStateBefore
    $oldReadyRevision = [string]$serviceStateBefore.status.latestReadyRevisionName
    if ([string]::IsNullOrWhiteSpace($oldTrafficSpec)) {
        throw 'Existing Cloud Run service has no restorable revision traffic.'
    }
}

$canaryTag = "canary-$tag".ToLowerInvariant()
$newRevision = ''
$serviceUrl = ''
$deploymentStarted = $false
$canaryTagObserved = $false
try {
    Write-Host "Deploying private Cloud Run revision for '$ServiceName' with no canonical traffic..."
    $deployArguments = @(
        'run', 'deploy', $ServiceName,
        "--image=$image",
        "--region=$Region",
        '--platform=managed',
        '--execution-environment=gen2',
        '--cpu=6',
        '--memory=4Gi',
        '--concurrency=1',
        '--timeout=300',
        '--min-instances=0',
        "--max-instances=$MaxInstances",
        '--cpu-boost',
        '--no-traffic',
        "--tag=$canaryTag",
        '--no-allow-unauthenticated',
        '--labels=app=tkb-cherry,component=solver,runtime=cloud-run',
        "--set-env-vars=TKB_CLOUD_RUN_QUIET=1,TKB_CLOUD_RUN_MAX_WORKERS=6,TKB_CLOUD_RUN_MAX_SOLVE_SECONDS=285,TKB_CLOUD_RUN_SOLVER_DIGEST=$solverDigest",
        "--project=$ProjectId",
        '--quiet'
    )
    if (-not [string]::IsNullOrWhiteSpace($RuntimeServiceAccount)) {
        $deployArguments += "--service-account=$RuntimeServiceAccount"
    }
    $deploymentStarted = $true
    Invoke-Gcloud -Arguments $deployArguments

    $serviceStateAfterDeploy = Get-CloudRunServiceState `
        -Project $ProjectId `
        -RegionName $Region `
        -Name $ServiceName
    $newRevision = [string]$serviceStateAfterDeploy.status.latestCreatedRevisionName
    $latestReadyRevision = [string]$serviceStateAfterDeploy.status.latestReadyRevisionName
    $serviceUrl = [string]$serviceStateAfterDeploy.status.url
    if ([string]::IsNullOrWhiteSpace($newRevision)) {
        throw 'Cloud Run deployment returned no created revision.'
    }
    if ($newRevision -eq $oldReadyRevision) {
        throw 'Cloud Run deployment did not create a distinct revision.'
    }
    if ($latestReadyRevision -ne $newRevision) {
        throw 'New Cloud Run revision did not become the latest Ready revision.'
    }
    if ([string]::IsNullOrWhiteSpace($serviceUrl)) {
        throw 'Cloud Run deployment returned no canonical service URL.'
    }

    $revisionState = Get-CloudRunRevisionState `
        -Project $ProjectId `
        -RegionName $Region `
        -Revision $newRevision
    Assert-CloudRunRevision `
        -RevisionState $revisionState `
        -ExpectedRevision $newRevision `
        -ExpectedDigest $solverDigest

    $canaryTargets = @()
    foreach ($target in @($serviceStateAfterDeploy.status.traffic)) {
        $targetTag = $target.PSObject.Properties['tag']
        $targetRevision = $target.PSObject.Properties['revisionName']
        if (
            $targetTag `
            -and $targetRevision `
            -and [string]$targetTag.Value -eq $canaryTag `
            -and [string]$targetRevision.Value -eq $newRevision
        ) {
            $canaryTargets += $target
        }
    }
    if ($canaryTargets.Count -ne 1) {
        throw 'Cloud Run did not bind the canary tag to exactly one new revision.'
    }
    $canaryTagObserved = $true
    $canaryUrlProperty = $canaryTargets[0].PSObject.Properties['url']
    $canaryUrl = if ($canaryUrlProperty) { [string]$canaryUrlProperty.Value } else { '' }
    if ([string]::IsNullOrWhiteSpace($canaryUrl)) {
        throw 'Cloud Run returned no tagged canary URL.'
    }

    Write-Host 'Running authenticated tagged health canary before traffic promotion...'
    Invoke-AuthenticatedCloudRunCanary `
        -CanaryUrl $canaryUrl `
        -Audience $serviceUrl `
        -ExpectedRevision $newRevision `
        -ExpectedDigest $solverDigest

    if (-not [string]::IsNullOrWhiteSpace($InvokerServiceAccount)) {
        Write-Host 'Granting the selected service account permission to invoke this service...'
        Invoke-Gcloud -Arguments @(
            'run', 'services', 'add-iam-policy-binding', $ServiceName,
            "--region=$Region",
            "--member=serviceAccount:$InvokerServiceAccount",
            '--role=roles/run.invoker',
            "--project=$ProjectId",
            '--quiet'
        )
        Write-Host 'Granting read-only Cloud Monitoring access for the Super Admin dashboard...'
        Invoke-Gcloud -Arguments @(
            'projects', 'add-iam-policy-binding', $ProjectId,
            "--member=serviceAccount:$InvokerServiceAccount",
            '--role=roles/monitoring.viewer',
            '--condition=None',
            '--quiet'
        )
        Write-Host 'Granting read-only Cloud Run service metadata access for capacity reporting...'
        Invoke-Gcloud -Arguments @(
            'projects', 'add-iam-policy-binding', $ProjectId,
            "--member=serviceAccount:$InvokerServiceAccount",
            '--role=roles/run.viewer',
            '--condition=None',
            '--quiet'
        )
    }

    Write-Host "Promoting verified revision '$newRevision' to 100% canonical traffic..."
    Invoke-Gcloud -Arguments @(
        'run', 'services', 'update-traffic', $ServiceName,
        "--to-revisions=$newRevision=100",
        "--region=$Region",
        "--project=$ProjectId",
        '--quiet'
    )
    $promotedState = Get-CloudRunServiceState `
        -Project $ProjectId `
        -RegionName $Region `
        -Name $ServiceName
    $newRevisionPercent = 0
    $otherRevisionPercent = 0
    foreach ($target in @($promotedState.status.traffic)) {
        $revisionProperty = $target.PSObject.Properties['revisionName']
        $percentProperty = $target.PSObject.Properties['percent']
        if (-not $revisionProperty -or -not $percentProperty) {
            continue
        }
        $percent = [int]$percentProperty.Value
        if ([string]$revisionProperty.Value -eq $newRevision) {
            $newRevisionPercent += $percent
        }
        else {
            $otherRevisionPercent += $percent
        }
    }
    if ($newRevisionPercent -ne 100 -or $otherRevisionPercent -ne 0) {
        throw 'Cloud Run traffic did not settle at 100% on the verified revision.'
    }
    Invoke-Gcloud -Arguments @(
        'run', 'services', 'update-traffic', $ServiceName,
        "--remove-tags=$canaryTag",
        "--region=$Region",
        "--project=$ProjectId",
        '--quiet'
    )
}
catch {
    $deploymentError = $_
    $rollbackError = $null
    if ($deploymentStarted -and $serviceExistedBefore -and -not [string]::IsNullOrWhiteSpace($oldTrafficSpec)) {
        try {
            Write-Warning 'Cloud Run release failed; restoring previous revision traffic.'
            Invoke-Gcloud -Arguments @(
                'run', 'services', 'update-traffic', $ServiceName,
                "--to-revisions=$oldTrafficSpec",
                "--region=$Region",
                "--project=$ProjectId",
                '--quiet'
            )
        }
        catch {
            $rollbackError = $_
        }
    }
    if ($canaryTagObserved) {
        try {
            Invoke-Gcloud -Arguments @(
                'run', 'services', 'update-traffic', $ServiceName,
                "--remove-tags=$canaryTag",
                "--region=$Region",
                "--project=$ProjectId",
                '--quiet'
            )
        }
        catch {
            Write-Warning 'Cloud Run canary tag cleanup failed; the revision remains unrouted.'
        }
    }
    if ($null -ne $rollbackError) {
        throw "Cloud Run release failed and traffic rollback also failed: $($rollbackError.Exception.Message)"
    }
    throw $deploymentError
}

Write-Host ''
Write-Host 'Cloud Run deployment completed.'
Write-Host "Service URL: $serviceUrl"
Write-Host "Solver digest: $solverDigest"
Write-Host 'The service is private; no access token or credential was printed or stored.'
Write-Host 'Configure these non-secret values on the VPS after its ADC identity has roles/run.invoker:'
Write-Host "  TKB_CLOUD_RUN_URL=$serviceUrl"
Write-Host "  TKB_CLOUD_RUN_AUDIENCE=$serviceUrl"
Write-Host "  TKB_CLOUD_RUN_SOLVER_DIGEST=$solverDigest"
$resolvedProfileId = if ([string]::IsNullOrWhiteSpace($ProfileId)) {
    "cloud-run-$ProjectId"
} else {
    $ProfileId.Trim()
}
$profileBundle = [ordered]@{
    id = $resolvedProfileId
    projectId = $ProjectId
    region = $Region
    url = $serviceUrl.Trim()
    solverDigest = $solverDigest
    budgetUsd = $ProfileBudgetUsd
    infrastructureBudgetUsd = $ProfileBudgetUsd
    estimatedCostUsd = $EstimatedCostUsd
}
Write-Host ''
Write-Host 'Copy the next safe line into Super Admin -> Doi tai khoan Google Cloud:'
Write-Host ("TKB_CLOUD_PROFILE=" + ($profileBundle | ConvertTo-Json -Compress))
