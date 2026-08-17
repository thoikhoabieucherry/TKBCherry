[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'High')]
param(
  # This target is created only by the local telemetry Rust test command. It
  # lives outside the repository, so require an explicit opt-in.
  [switch]$IncludeTelemetryTestTarget
)

$ErrorActionPreference = 'Stop'

$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$approvedProjectTargets = @(
  (Join-Path $projectRoot 'rust_api\target'),
  (Join-Path $projectRoot 'solver_runtime\logs'),
  (Join-Path $projectRoot '.pytest_cache')
)
$telemetryTestTarget = Join-Path $env:LOCALAPPDATA 'Temp\codex-tkb-telemetry-test-20260816'

$cacheTargets = Get-ChildItem -LiteralPath $projectRoot -Recurse -Directory -Force -Filter '__pycache__' -ErrorAction SilentlyContinue |
  ForEach-Object { $_.FullName }

$targets = @($approvedProjectTargets + $cacheTargets)
if($IncludeTelemetryTestTarget){
  $targets += $telemetryTestTarget
}

$targets = $targets |
  Where-Object { Test-Path -LiteralPath $_ } |
  Sort-Object -Unique

function Test-ApprovedCleanupTarget {
  param([Parameter(Mandatory = $true)][string]$ResolvedPath)

  if($approvedProjectTargets -contains $ResolvedPath){
    return $true
  }

  $projectPrefix = $projectRoot + [IO.Path]::DirectorySeparatorChar
  if($ResolvedPath.StartsWith($projectPrefix, [StringComparison]::OrdinalIgnoreCase) -and
     [IO.Path]::GetFileName($ResolvedPath) -eq '__pycache__'){
    return $true
  }

  return $IncludeTelemetryTestTarget -and $ResolvedPath -eq $telemetryTestTarget
}

$totalBytes = [int64]0
foreach($target in $targets){
  $resolved = (Resolve-Path -LiteralPath $target).Path
  if(-not (Test-ApprovedCleanupTarget -ResolvedPath $resolved)){
    throw "Refusing unexpected cleanup target: $resolved"
  }
  $bytes = (Get-ChildItem -LiteralPath $resolved -Recurse -Force -File -ErrorAction SilentlyContinue |
    Measure-Object -Property Length -Sum).Sum
  if($null -ne $bytes){
    $totalBytes += [int64]$bytes
  }
  if($PSCmdlet.ShouldProcess($resolved, 'Remove generated artifact')){
    Remove-Item -LiteralPath $resolved -Recurse -Force
    Write-Host "Removed: $resolved"
  }
}

$totalMiB = [math]::Round($totalBytes / 1MB, 2)
Write-Host "Cleanup target total: $totalMiB MiB"
Write-Host 'Only generated build/cache/log targets were selected. Source, .git, databases, deploy assets, and backups were not selected.'
