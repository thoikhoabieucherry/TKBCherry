# Gỡ "Cherry máy này": dừng bộ giải, xoá lối tắt Startup, giao thức cherry-local://,
# mục trong Settings > Apps và thư mục %LOCALAPPDATA%\CherryMayNay.
$ErrorActionPreference = "SilentlyContinue"
$dest = Join-Path $env:LOCALAPPDATA "CherryMayNay"
Set-Location $env:TEMP

Get-CimInstance Win32_Process -Filter "Name='pythonw.exe' OR Name='python.exe'" |
    Where-Object { $_.CommandLine -and $_.CommandLine -like "*\CherryMayNay\*" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Start-Sleep -Milliseconds 800

Remove-Item (Join-Path ([Environment]::GetFolderPath("Startup")) "Cherry may nay.lnk") -Force
Remove-Item "HKCU:\Software\Classes\cherry-local" -Recurse -Force
Remove-Item "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\CherryMayNay" -Recurse -Force
Remove-Item $dest -Recurse -Force
