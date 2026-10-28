# Gỡ "Cherry máy này": dừng bộ giải, xoá lối tắt Startup, giao thức cherry-local://,
# mục trong Settings > Apps và thư mục %LOCALAPPDATA%\CherryMayNay.
$ErrorActionPreference = "SilentlyContinue"
$dest = Join-Path $env:LOCALAPPDATA "Cherry"
$legacy = Join-Path $env:LOCALAPPDATA "CherryMayNay"
Set-Location $env:TEMP

# Chỉ dừng Python chạy từ thư mục cài (hồ sơ người dùng có thể tên "Cherry").
$roots = @(($dest.TrimEnd('\') + '\'), ($legacy.TrimEnd('\') + '\'))
Get-CimInstance Win32_Process -Filter "Name='pythonw.exe' OR Name='python.exe'" |
    Where-Object { $cmd = $_.CommandLine; $cmd -and ($roots | Where-Object { $cmd.IndexOf($_, [System.StringComparison]::OrdinalIgnoreCase) -ge 0 }) } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Start-Sleep -Milliseconds 800

foreach ($name in @("Cherry.lnk", "Cherry may nay.lnk")) {
    Remove-Item (Join-Path ([Environment]::GetFolderPath("Startup")) $name) -Force
    Remove-Item (Join-Path ([Environment]::GetFolderPath("Programs")) $name) -Force
}
Remove-Item "HKCU:\Software\Classes\cherry-local" -Recurse -Force
Remove-Item "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Cherry" -Recurse -Force
Remove-Item "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\CherryMayNay" -Recurse -Force
Remove-Item $legacy -Recurse -Force
Remove-Item $dest -Recurse -Force
