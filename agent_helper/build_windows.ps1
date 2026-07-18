[CmdletBinding()]
param(
    [string]$Python = "python",
    [string]$OutputDirectory = "",
    [string]$TclRuntimeRoot = "",
    [switch]$Clean,
    [switch]$SkipDependencyInstall
)

$ErrorActionPreference = "Stop"
$AgentRoot = (Resolve-Path -LiteralPath $PSScriptRoot).Path
$RepositoryRoot = (Resolve-Path -LiteralPath (Join-Path $AgentRoot "..")).Path
$SolverRoot = Join-Path $RepositoryRoot "solver_runtime"
$BuildRoot = Join-Path $AgentRoot ".build-windows"
if ([string]::IsNullOrWhiteSpace($OutputDirectory)) {
    $OutputDirectory = Join-Path $AgentRoot "dist"
}
$OutputDirectory = [System.IO.Path]::GetFullPath($OutputDirectory)

function Test-PackagedSolverChild {
    param([string]$Executable)
    $StartInfo = [System.Diagnostics.ProcessStartInfo]::new()
    $StartInfo.FileName = $Executable
    $StartInfo.Arguments = "--solver-child"
    $StartInfo.UseShellExecute = $false
    $StartInfo.CreateNoWindow = $true
    $StartInfo.RedirectStandardInput = $true
    $StartInfo.RedirectStandardOutput = $true
    $StartInfo.RedirectStandardError = $true
    $Process = [System.Diagnostics.Process]::new()
    $Process.StartInfo = $StartInfo
    if (-not $Process.Start()) { throw "Could not start packaged solver-child smoke test." }
    try {
        $StdoutTask = $Process.StandardOutput.ReadToEndAsync()
        $StderrTask = $Process.StandardError.ReadToEndAsync()
        $Process.StandardInput.Write('{"data":{},"settings":{"overall_time_limit_seconds":1}}')
        $Process.StandardInput.Close()
        if (-not $Process.WaitForExit(120000)) {
            try { $Process.Kill() } catch { }
            throw "Packaged solver-child smoke test exceeded 120 seconds."
        }
        $Stdout = $StdoutTask.Result.Trim()
        $Stderr = $StderrTask.Result
        if ($Process.ExitCode -ne 0) {
            throw "Packaged solver-child exited with code $($Process.ExitCode)."
        }
        try { $Frame = $Stdout | ConvertFrom-Json } catch {
            throw "Packaged solver-child did not return a valid JSON frame. stderr length=$($Stderr.Length)"
        }
        if ($Frame.protocol -cne "tkb-reference-solver-stdio-v1") {
            throw "Packaged solver-child returned the wrong protocol."
        }
    }
    finally {
        $Process.Dispose()
    }
}

function Test-PackagedGui {
    param([string]$Executable)
    $StartInfo = [System.Diagnostics.ProcessStartInfo]::new()
    $StartInfo.FileName = $Executable
    $StartInfo.Arguments = "--gui-smoke"
    $StartInfo.UseShellExecute = $false
    $StartInfo.CreateNoWindow = $true
    $StartInfo.RedirectStandardOutput = $true
    $StartInfo.RedirectStandardError = $true
    # The build Python intentionally points at a normalized Tcl/Tk tree. A
    # packaged smoke must not inherit those paths or it could pass while the
    # archive itself is missing or carrying a broken runtime.
    $StartInfo.EnvironmentVariables.Remove("TCL_LIBRARY")
    $StartInfo.EnvironmentVariables.Remove("TK_LIBRARY")
    $Process = [System.Diagnostics.Process]::new()
    $Process.StartInfo = $StartInfo
    if (-not $Process.Start()) { throw "Could not start packaged GUI smoke test." }
    try {
        $StdoutTask = $Process.StandardOutput.ReadToEndAsync()
        $StderrTask = $Process.StandardError.ReadToEndAsync()
        if (-not $Process.WaitForExit(120000)) {
            try { $Process.Kill() } catch { }
            throw "Packaged GUI smoke test exceeded 120 seconds."
        }
        $Stdout = $StdoutTask.Result.Trim()
        $Stderr = $StderrTask.Result.Trim()
        if ($Process.ExitCode -ne 0) {
            throw "Packaged GUI smoke exited with code $($Process.ExitCode). stdout=$Stdout stderr=$Stderr"
        }
        if ($Stdout -notmatch '^TKBCherryAgent GUI smoke OK ') {
            throw "Packaged GUI smoke returned an unexpected response. stdout=$Stdout stderr=$Stderr"
        }
        Write-Host $Stdout
    }
    finally {
        $Process.Dispose()
    }
}

if (-not (Test-Path -LiteralPath (Join-Path $SolverRoot "scripts\solve_stdio.py") -PathType Leaf)) {
    throw "solver_runtime/scripts/solve_stdio.py was not found."
}
if (-not (Test-Path -LiteralPath (Join-Path $SolverRoot "src") -PathType Container)) {
    throw "solver_runtime/src was not found."
}

if ($Clean) {
    $resolvedAgentRoot = [System.IO.Path]::GetFullPath($AgentRoot).TrimEnd('\') + '\'
    $resolvedBuildRoot = [System.IO.Path]::GetFullPath($BuildRoot)
    if (-not $resolvedBuildRoot.StartsWith($resolvedAgentRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to clean a build path outside agent_helper."
    }
    if (Test-Path -LiteralPath $resolvedBuildRoot) {
        Remove-Item -LiteralPath $resolvedBuildRoot -Recurse -Force
    }
}

New-Item -ItemType Directory -Force -Path $BuildRoot | Out-Null
New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null
$VirtualEnvironment = Join-Path $BuildRoot "venv"
$VirtualPython = Join-Path $VirtualEnvironment "Scripts\python.exe"
if (-not (Test-Path -LiteralPath $VirtualPython -PathType Leaf)) {
    & $Python -m venv $VirtualEnvironment
    if ($LASTEXITCODE -ne 0) { throw "Could not create the build environment." }
}

if ($SkipDependencyInstall) {
    & $VirtualPython -c "import cryptography, numpy, openpyxl, ortools, PIL, PyInstaller, pystray, scipy; print('Offline build dependencies OK')"
    if ($LASTEXITCODE -ne 0) {
        throw "The existing build environment is incomplete; rerun without -SkipDependencyInstall when package access is available."
    }
}
else {
    & $VirtualPython -m pip install --upgrade pip
    if ($LASTEXITCODE -ne 0) { throw "Could not update pip." }
    & $VirtualPython -m pip install -r (Join-Path $SolverRoot "requirements.txt")
    if ($LASTEXITCODE -ne 0) { throw "Could not install solver dependencies." }
    & $VirtualPython -m pip install -r (Join-Path $AgentRoot "requirements-build.txt")
    if ($LASTEXITCODE -ne 0) { throw "Could not install build dependencies." }
}

$PythonBase = (& $VirtualPython -c "import sys; print(sys.base_prefix)").Trim()
if (-not $PythonBase) { throw "Could not locate the Python runtime root." }
$TclSourceRoot = Join-Path $PythonBase "tcl"
if (-not (Test-Path -LiteralPath (Join-Path $TclSourceRoot "tcl8.6\init.tcl") -PathType Leaf)) {
    throw "The build Python does not contain a usable Tcl 8.6 library. Use an official Windows Python runtime."
}
if (-not (Test-Path -LiteralPath (Join-Path $TclSourceRoot "tk8.6\tk.tcl") -PathType Leaf)) {
    throw "The build Python does not contain a usable Tk 8.6 library. Use an official Windows Python runtime."
}
$DefaultTclRuntimeRoot = Join-Path $BuildRoot "tcl-runtime"
if ([string]::IsNullOrWhiteSpace($TclRuntimeRoot)) {
    $TclRuntimeRoot = $DefaultTclRuntimeRoot
}
$TclRuntimeRoot = [System.IO.Path]::GetFullPath($TclRuntimeRoot)
$ResolvedAgentPrefix = [System.IO.Path]::GetFullPath($AgentRoot).TrimEnd('\') + '\'
$ExternalTclPrefix = [System.IO.Path]::GetFullPath("C:\TKBCherryAgent").TrimEnd('\') + '\'
if (
    -not $TclRuntimeRoot.StartsWith($ResolvedAgentPrefix, [System.StringComparison]::OrdinalIgnoreCase) -and
    -not $TclRuntimeRoot.StartsWith($ExternalTclPrefix, [System.StringComparison]::OrdinalIgnoreCase)
) {
    throw "TclRuntimeRoot must stay under agent_helper or C:\TKBCherryAgent."
}
if (Test-Path -LiteralPath $TclRuntimeRoot) {
    Remove-Item -LiteralPath $TclRuntimeRoot -Recurse -Force
}
Copy-Item -LiteralPath $TclSourceRoot -Destination $TclRuntimeRoot -Recurse

function Replace-TclExactRequirement {
    param([string]$Path, [string]$Pattern, [string]$Replacement)
    $Resolved = (Resolve-Path -LiteralPath $Path).Path
    $Original = [System.IO.File]::ReadAllText($Resolved)
    $Updated = [System.Text.RegularExpressions.Regex]::Replace($Original, $Pattern, $Replacement)
    if ($Updated -eq $Original) {
        throw "Expected Tcl/Tk version requirement was not found in $Resolved"
    }
    [System.IO.File]::WriteAllText(
        $Resolved,
        $Updated,
        [System.Text.UTF8Encoding]::new($false)
    )
}

Replace-TclExactRequirement `
    -Path (Join-Path $TclRuntimeRoot "tcl8.6\init.tcl") `
    -Pattern 'package require -exact Tcl 8\.6\.\d+' `
    -Replacement 'package require Tcl 8.6'
Replace-TclExactRequirement `
    -Path (Join-Path $TclRuntimeRoot "tk8.6\tk.tcl") `
    -Pattern 'package require -exact Tk\s+8\.6\.\d+' `
    -Replacement 'package require Tk 8.6'

$env:TCL_LIBRARY = (Join-Path $TclRuntimeRoot "tcl8.6")
$env:TK_LIBRARY = (Join-Path $TclRuntimeRoot "tk8.6")
& $VirtualPython -c "import tkinter as tk; root=tk.Tk(); root.withdraw(); root.update_idletasks(); root.destroy(); print('Build Python Tk smoke OK')"
if ($LASTEXITCODE -ne 0) {
    throw "The build Python cannot create a real hidden Tk window. Refusing to package a broken GUI."
}

# Ship optimized sourceless bytecode for the runtime data tree. PyInstaller is
# the deployment container and UPX is only a compressor; neither is presented
# as strong protection against a determined reverse engineer.
$ProtectedSolverRoot = Join-Path $BuildRoot "solver-runtime-bytecode"
if (Test-Path -LiteralPath $ProtectedSolverRoot) {
    Remove-Item -LiteralPath $ProtectedSolverRoot -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $ProtectedSolverRoot | Out-Null
Copy-Item -LiteralPath (Join-Path $SolverRoot "scripts") -Destination $ProtectedSolverRoot -Recurse
Copy-Item -LiteralPath (Join-Path $SolverRoot "src") -Destination $ProtectedSolverRoot -Recurse
& $VirtualPython -m compileall -b -f -q -o 2 $ProtectedSolverRoot
if ($LASTEXITCODE -ne 0) { throw "Could not compile the protected solver runtime." }
$ProtectedSources = @(Get-ChildItem -LiteralPath $ProtectedSolverRoot -Filter "*.py" -File -Recurse)
foreach ($SourceFile in $ProtectedSources) {
    Remove-Item -LiteralPath $SourceFile.FullName -Force
}
if (-not (Test-Path -LiteralPath (Join-Path $ProtectedSolverRoot "scripts\solve_stdio.pyc") -PathType Leaf)) {
    throw "The protected solver entry point was not compiled."
}
if (Get-ChildItem -LiteralPath $ProtectedSolverRoot -Filter "*.py" -File -Recurse) {
    throw "Raw solver Python source remained in the protected runtime."
}

$WorkPath = Join-Path $BuildRoot "work"
$SpecPath = Join-Path $BuildRoot "spec"
$Launcher = Join-Path $AgentRoot "launcher.py"
$SolverScriptsData = "$(Join-Path $ProtectedSolverRoot 'scripts');solver_runtime\scripts"
$SolverSourceData = "$(Join-Path $ProtectedSolverRoot 'src');solver_runtime\src"
$AgentIconData = "$(Join-Path $RepositoryRoot 'web\assets\favicon-cherry.png');agent_helper\assets"
$TclData = "$(Join-Path $TclRuntimeRoot 'tcl8.6');_tcl_data"
$TkData = "$(Join-Path $TclRuntimeRoot 'tk8.6');_tk_data"

$PyInstallerArguments = @(
    "-m", "PyInstaller",
    "--noconfirm",
    "--clean",
    "--onedir",
    "--windowed",
    "--noupx",
    "--icon", (Join-Path $RepositoryRoot "web\assets\favicon-cherry.png"),
    "--version-file", (Join-Path $AgentRoot "windows_version_info.txt"),
    "--name", "TKBCherryAgent",
    "--distpath", $OutputDirectory,
    "--workpath", $WorkPath,
    "--specpath", $SpecPath,
    "--paths", $RepositoryRoot,
    "--paths", (Join-Path $SolverRoot "src"),
    "--add-data", $SolverScriptsData,
    "--add-data", $SolverSourceData,
    "--add-data", $AgentIconData,
    "--add-data", $TclData,
    "--add-data", $TkData,
    "--collect-submodules", "tkb_new",
    "--collect-submodules", "tkb_optimizer_ref",
    # Keep the release self-contained without collecting every test, example,
    # optional solver backend and image codec shipped by these large packages.
    # PyInstaller hooks still collect the native dependencies of the imports
    # below, while OR-Tools' DLL bundle must be included explicitly.
    "--hidden-import", "numpy",
    "--hidden-import", "scipy.optimize",
    "--hidden-import", "scipy.sparse",
    "--hidden-import", "ortools.sat.python.cp_model",
    "--hidden-import", "ortools.sat.python.cp_model_helper",
    "--hidden-import", "ortools.util.python.sorted_interval_list",
    "--collect-binaries", "ortools",
    "--hidden-import", "openpyxl",
    "--hidden-import", "pystray",
    "--hidden-import", "pystray._win32",
    "--hidden-import", "tkinter",
    "--hidden-import", "tkinter.ttk",
    "--hidden-import", "_tkinter",
    "--hidden-import", "PIL.Image",
    "--hidden-import", "PIL.PngImagePlugin",
    $Launcher
)
& $VirtualPython @PyInstallerArguments
if ($LASTEXITCODE -ne 0) { throw "PyInstaller failed." }

$StandaloneWorkPath = Join-Path $BuildRoot "work-standalone"
$StandaloneSpecPath = Join-Path $BuildRoot "spec-standalone"
$StandaloneArguments = @(
    "-m", "PyInstaller",
    "--noconfirm",
    "--clean",
    "--onefile",
    "--windowed",
    "--noupx",
    "--icon", (Join-Path $RepositoryRoot "web\assets\favicon-cherry.png"),
    "--version-file", (Join-Path $AgentRoot "windows_version_info.txt"),
    "--name", "TKBCherryAgent",
    "--distpath", $OutputDirectory,
    "--workpath", $StandaloneWorkPath,
    "--specpath", $StandaloneSpecPath,
    "--paths", $RepositoryRoot,
    "--paths", (Join-Path $SolverRoot "src"),
    "--add-data", $SolverScriptsData,
    "--add-data", $SolverSourceData,
    "--add-data", $AgentIconData,
    "--add-data", $TclData,
    "--add-data", $TkData,
    "--collect-submodules", "tkb_new",
    "--collect-submodules", "tkb_optimizer_ref",
    "--hidden-import", "numpy",
    "--hidden-import", "scipy.optimize",
    "--hidden-import", "scipy.sparse",
    "--hidden-import", "ortools.sat.python.cp_model",
    "--hidden-import", "ortools.sat.python.cp_model_helper",
    "--hidden-import", "ortools.util.python.sorted_interval_list",
    "--collect-binaries", "ortools",
    "--hidden-import", "openpyxl",
    "--hidden-import", "pystray",
    "--hidden-import", "pystray._win32",
    "--hidden-import", "tkinter",
    "--hidden-import", "tkinter.ttk",
    "--hidden-import", "_tkinter",
    "--hidden-import", "PIL.Image",
    "--hidden-import", "PIL.PngImagePlugin",
    $Launcher
)
& $VirtualPython @StandaloneArguments
if ($LASTEXITCODE -ne 0) { throw "PyInstaller standalone build failed." }

$Bundle = Join-Path $OutputDirectory "TKBCherryAgent"
Copy-Item -LiteralPath (Join-Path $AgentRoot "config.example.json") -Destination $Bundle -Force
Copy-Item -LiteralPath (Join-Path $AgentRoot "README.md") -Destination $Bundle -Force
Copy-Item -LiteralPath (Join-Path $AgentRoot "PROTOCOL.md") -Destination $Bundle -Force

$StandaloneExecutable = Join-Path $OutputDirectory "TKBCherryAgent.exe"
if (-not (Test-Path -LiteralPath $StandaloneExecutable -PathType Leaf)) {
    throw "The standalone TKBCherryAgent.exe was not created."
}

$OnedirExecutable = Join-Path $Bundle "TKBCherryAgent.exe"
$BundledRawSources = @(Get-ChildItem -LiteralPath $Bundle -Filter "*.py" -File -Recurse | Where-Object {
    $_.FullName -like "*\solver_runtime\*"
})
if ($BundledRawSources.Count -gt 0) {
    throw "The onedir Agent contains raw solver Python source."
}
Test-PackagedGui -Executable $OnedirExecutable
$UpxCandidate = Join-Path $BuildRoot "TKBCherryAgent-packed.exe"
if (Test-Path -LiteralPath $UpxCandidate) {
    Remove-Item -LiteralPath $UpxCandidate -Force
}
Copy-Item -LiteralPath $StandaloneExecutable -Destination $UpxCandidate -Force
Test-PackagedGui -Executable $StandaloneExecutable

$UpxExecutable = Join-Path $RepositoryRoot "upx-5.2.0-win64\upx.exe"
if (-not (Test-Path -LiteralPath $UpxExecutable -PathType Leaf)) {
    throw "UPX 5.2.0 was not found at $UpxExecutable"
}
$UpxPacked = $false
for ($Attempt = 1; $Attempt -le 4; $Attempt++) {
    & $UpxExecutable --best --lzma --force $UpxCandidate
    if ($LASTEXITCODE -eq 0) {
        $UpxPacked = $true
        break
    }
    if ($Attempt -lt 4) { Start-Sleep -Seconds (2 * $Attempt) }
}
if (-not $UpxPacked) { throw "UPX failed to pack the standalone Agent." }
& $UpxExecutable -t $UpxCandidate
if ($LASTEXITCODE -ne 0) { throw "UPX integrity validation failed for the standalone Agent." }
Test-PackagedGui -Executable $UpxCandidate
Test-PackagedSolverChild -Executable $UpxCandidate
Copy-Item -LiteralPath $UpxCandidate -Destination $StandaloneExecutable -Force

# The public download is intentionally a one-entry ZIP. Keeping the executable
# at the archive root makes the user flow unambiguous: extract, then run it.
$Archive = Join-Path $OutputDirectory "TKBCherryAgent-Windows.zip"
if (Test-Path -LiteralPath $Archive) {
    Remove-Item -LiteralPath $Archive -Force
}
Compress-Archive -LiteralPath $StandaloneExecutable -DestinationPath $Archive -CompressionLevel Optimal

# Retain the larger onedir bundle for diagnostics, but never publish it under
# the public release archive name.
$OnedirArchive = Join-Path $OutputDirectory "TKBCherryAgent-Windows-onedir.zip"
if (Test-Path -LiteralPath $OnedirArchive) {
    Remove-Item -LiteralPath $OnedirArchive -Force
}
Compress-Archive -LiteralPath $Bundle -DestinationPath $OnedirArchive -CompressionLevel Optimal

Add-Type -AssemblyName System.IO.Compression.FileSystem
$ReleaseZip = [System.IO.Compression.ZipFile]::OpenRead($Archive)
try {
    if ($ReleaseZip.Entries.Count -ne 1) {
        throw "Release ZIP must contain exactly one entry."
    }
    $ReleaseEntry = $ReleaseZip.Entries[0]
    if ($ReleaseEntry.FullName -cne "TKBCherryAgent.exe" -or $ReleaseEntry.Length -le 0) {
        throw "Release ZIP must contain only TKBCherryAgent.exe at its root."
    }
}
finally {
    $ReleaseZip.Dispose()
}

$VersionSource = Join-Path $AgentRoot "__init__.py"
$AgentVersion = (& $VirtualPython -c "import runpy, sys; print(runpy.run_path(sys.argv[1])['VERSION'])" $VersionSource).Trim()
if ($LASTEXITCODE -ne 0 -or $AgentVersion -notmatch '^\d+\.\d+\.\d+$') {
    throw "Could not read the Agent semantic version."
}
$ReleaseManifest = Join-Path $OutputDirectory "TKBCherryAgent-release.json"
$SignReleaseScript = Join-Path $RepositoryRoot "tools\agent-release\sign_release.py"
& $VirtualPython $SignReleaseScript `
    --version $AgentVersion `
    --archive $Archive `
    --executable $StandaloneExecutable `
    --output $ReleaseManifest
if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $ReleaseManifest -PathType Leaf)) {
    throw "Could not create the signed Agent release manifest."
}

Write-Host "Windows onedir bundle created at: $Bundle"
Write-Host "Onedir diagnostics archive created at: $OnedirArchive"
Write-Host "Standalone executable created at: $StandaloneExecutable"
Write-Host "One-file release ZIP created at: $Archive"
Write-Host "Signed release manifest created at: $ReleaseManifest"
Write-Host "Release files contain no password, bearer credential, CMD, PowerShell, or obfuscated installer."
