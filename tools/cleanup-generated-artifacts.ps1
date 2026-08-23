[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'High')]
param()

$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path

$approvedTargets = @(
  (Join-Path $projectRoot 'rust_api\target'),
  (Join-Path $projectRoot 'mail-server\node_modules'),
  (Join-Path $projectRoot '.pytest_cache'),
  (Join-Path $projectRoot 'scratch'),
  (Join-Path $projectRoot 'rust_server_e2e.log')
)

$cacheTargets = Get-ChildItem -LiteralPath $projectRoot -Recurse -Directory -Force -Filter '__pycache__' -ErrorAction SilentlyContinue |
  ForEach-Object { $_.FullName }
$targets = @($approvedTargets + $cacheTargets) |
  Where-Object { Test-Path -LiteralPath $_ } |
  Sort-Object -Unique

$projectPrefix = $projectRoot + [IO.Path]::DirectorySeparatorChar
$totalBytes = [int64]0
foreach($target in $targets){
  $resolved = (Resolve-Path -LiteralPath $target).Path
  if(-not $resolved.StartsWith($projectPrefix, [StringComparison]::OrdinalIgnoreCase)){
    throw "Refusing path outside project: $resolved"
  }

  $item = Get-Item -LiteralPath $resolved -Force
  if($item.PSIsContainer){
    $bytes = (Get-ChildItem -LiteralPath $resolved -Recurse -Force -File -ErrorAction SilentlyContinue |
      Measure-Object -Property Length -Sum).Sum
  }else{
    $bytes = $item.Length
  }
  if($null -ne $bytes){ $totalBytes += [int64]$bytes }

  if($PSCmdlet.ShouldProcess($resolved, 'Remove generated artifact')){
    if($item.PSIsContainer){
      Get-ChildItem -LiteralPath $resolved -Recurse -Force -Directory -ErrorAction SilentlyContinue |
        ForEach-Object { $_.Attributes = $_.Attributes -band (-bnot [IO.FileAttributes]::ReadOnly) }
      $item.Attributes = $item.Attributes -band (-bnot [IO.FileAttributes]::ReadOnly)
    }
    Remove-Item -LiteralPath $resolved -Recurse -Force
    Write-Host "Removed: $resolved"
  }
}

$totalMiB = [math]::Round($totalBytes / 1MB, 2)
Write-Host "Cleanup target total: $totalMiB MiB"
Write-Host 'Only generated caches, logs, builds, and temporary work folders were selected. Source, .git, .env, and databases were not selected.'
