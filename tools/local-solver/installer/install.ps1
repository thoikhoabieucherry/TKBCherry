# Cài "Cherry máy này" cho người dùng hiện tại — không cần quyền admin, không cần cài Python.
# Gọi bởi install.cmd bên trong Cherry.exe (IExpress giải nén payload.zip + file này vào thư mục tạm).
#   %LOCALAPPDATA%\CherryMayNay\python\  Python nhúng + ortools/numpy/scipy
#   %LOCALAPPDATA%\CherryMayNay\app\     cherry_local_solver.py + solver_runtime\
# Tự bật cùng Windows (lối tắt Startup), giao thức cherry-local:// để trang web đánh thức,
# mục gỡ cài đặt trong Settings > Apps.
$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$dest = Join-Path $env:LOCALAPPDATA "CherryMayNay"
$port = 2211
$pyw = Join-Path $dest "python\pythonw.exe"
$appDir = Join-Path $dest "app"
$app = Join-Path $appDir "cherry_local_solver.py"
$log = Join-Path $env:TEMP "CherryMayNay-install.log"

function Write-Log($msg) { Add-Content -Path $log -Value ("{0} {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $msg) -Encoding UTF8 }

function Stop-CherryMayNay {
    Get-CimInstance Win32_Process -Filter "Name='pythonw.exe' OR Name='python.exe'" |
        Where-Object { $_.CommandLine -and $_.CommandLine -like "*\CherryMayNay\*" } |
        ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop } catch {} }
}

try {
    Write-Log "bat dau cai vao $dest"
    Stop-CherryMayNay
    Start-Sleep -Milliseconds 800
    if (Test-Path $dest) { Remove-Item $dest -Recurse -Force }
    New-Item -ItemType Directory -Force -Path $dest | Out-Null
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [System.IO.Compression.ZipFile]::ExtractToDirectory((Join-Path $here "payload.zip"), $dest)
    Write-Log "da giai nen"

    # Tự bật cùng Windows + lối tắt Start Menu: pythonw.exe (không cửa sổ), biểu tượng 🍒 ở khay.
    $icon = Join-Path $appDir "cherry.ico"
    $shell = New-Object -ComObject WScript.Shell
    foreach ($folder in @([Environment]::GetFolderPath("Startup"), [Environment]::GetFolderPath("Programs"))) {
        $lnk = $shell.CreateShortcut((Join-Path $folder "Cherry may nay.lnk"))
        $lnk.TargetPath = $pyw
        $lnk.Arguments = "`"$app`" --background --tray"
        $lnk.WorkingDirectory = $appDir
        $lnk.WindowStyle = 7
        $lnk.IconLocation = "$icon,0"
        $lnk.Description = "Cherry may nay - bo giai thoi khoa bieu chay tren may nay"
        $lnk.Save()
    }

    # cherry-local:// -> trang Sắp xếp đánh thức bộ giải khi nó đang tắt.
    $proto = "HKCU:\Software\Classes\cherry-local"
    New-Item -Path "$proto\shell\open\command" -Force | Out-Null
    Set-ItemProperty -Path $proto -Name "(default)" -Value "URL:Cherry may nay"
    New-ItemProperty -Path $proto -Name "URL Protocol" -Value "" -PropertyType String -Force | Out-Null
    Set-ItemProperty -Path "$proto\shell\open\command" -Name "(default)" -Value "`"$pyw`" `"$app`" --background --tray --wake `"%1`""
    New-Item -Path "$proto\DefaultIcon" -Force | Out-Null
    Set-ItemProperty -Path "$proto\DefaultIcon" -Name "(default)" -Value "$icon,0"

    # Settings > Apps > Cherry máy này > Uninstall
    $un = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\CherryMayNay"
    New-Item -Path $un -Force | Out-Null
    $sizeKb = [int]((Get-ChildItem $dest -Recurse -File | Measure-Object Length -Sum).Sum / 1KB)
    $values = @{
        "DisplayName"     = "Cherry máy này"
        "DisplayVersion"  = "1.0"
        "Publisher"       = "Cherry Software"
        "InstallLocation" = $dest
        "DisplayIcon"     = $icon
        "UninstallString" = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$dest\uninstall.ps1`""
    }
    foreach ($k in $values.Keys) { Set-ItemProperty -Path $un -Name $k -Value $values[$k] }
    New-ItemProperty -Path $un -Name "EstimatedSize" -Value $sizeKb -PropertyType DWord -Force | Out-Null
    New-ItemProperty -Path $un -Name "NoModify" -Value 1 -PropertyType DWord -Force | Out-Null
    New-ItemProperty -Path $un -Name "NoRepair" -Value 1 -PropertyType DWord -Force | Out-Null
    Write-Log "da dang ky startup + cherry-local:// + muc go cai dat"

    # Lần đầu: biểu tượng 🍒 hiện ở khay kèm thông báo; trang TKB đang mở tự nhận ra bộ giải.
    Start-Process -FilePath $pyw -ArgumentList "`"$app`" --background --tray --first-run" -WorkingDirectory $appDir -WindowStyle Hidden
    $ready = $false
    for ($i = 0; $i -lt 60; $i++) {
        try {
            $r = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$port/api/health" -TimeoutSec 2
            if ($r.StatusCode -eq 200) { $ready = $true; break }
        } catch {}
        Start-Sleep -Milliseconds 500
    }
    Write-Log "bo giai san sang: $ready"
    # Không mở thêm tab: thông báo ở khay + trang TKB đang mở tự nhận bộ giải.
    exit 0
} catch {
    Write-Log ("LOI: " + $_.Exception.Message)
    exit 1
}
