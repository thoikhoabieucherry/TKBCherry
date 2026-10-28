# Cài "Cherry máy này" cho người dùng hiện tại — không cần quyền admin, không cần cài Python.
# Gọi bởi install.cmd bên trong Cherry.exe (IExpress giải nén python.zip + app.zip + file này vào thư mục tạm).
#   %LOCALAPPDATA%\CherryMayNay\python\  Python nhúng + ortools/numpy/scipy (python.zip, ít khi đổi)
#   %LOCALAPPDATA%\CherryMayNay\app\     cherry_local_solver.py + solver_runtime\ (app.zip, ~1 MB)
# Tự bật cùng Windows (lối tắt Startup), giao thức cherry-local:// để trang web đánh thức,
# mục gỡ cài đặt trong Settings > Apps.
# 28/10 (chủ dự án: "mở luôn chứ sao đợi 20 giây"; "cho thể hiện tiến trình cho phù hợp đúng
# 20 giây"): splash.ps1 hiện NGAY và chạy theo % THẬT mà file này ghi vào CherrySplash.progress
# ("phần trăm|dòng chữ"; 100 = bộ giải đã trả lời, -1 = lỗi). Cùng bản đã cài -> chỉ bật bộ giải;
# bản mới cùng bộ Python (runtime-id) -> chỉ thay app (< 1 s); còn lại giải nén Python theo từng tệp.
$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$dest = Join-Path $env:LOCALAPPDATA "CherryMayNay"
$port = 2211
$pyw = Join-Path $dest "python\pythonw.exe"
$appDir = Join-Path $dest "app"
$app = Join-Path $appDir "cherry_local_solver.py"
$log = Join-Path $env:TEMP "CherryMayNay-install.log"
$progressFile = Join-Path $env:TEMP "CherrySplash.progress"

function Write-Log($msg) { Add-Content -Path $log -Value ("{0} {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $msg) -Encoding UTF8 }

function Set-CherryProgress([int]$pct, [string]$msg) {
    try { [System.IO.File]::WriteAllText($progressFile, "$pct|$msg", [System.Text.Encoding]::UTF8) } catch {}
}

function Test-CherryHealth {
    try {
        $r = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$port/api/health" -TimeoutSec 2
        return ($r.StatusCode -eq 200)
    } catch { return $false }
}

function Read-Id([string]$path) {
    if (Test-Path $path) { return (Get-Content $path -Raw).Trim() }
    return ""
}

# Mở lại Cherry.exe đúng bản đã cài -> không giải nén lại, chỉ bật bộ giải.
$buildNew = Read-Id (Join-Path $here "build-id.txt")
$buildOld = Read-Id (Join-Path $appDir "build-id.txt")
$sameBuild = ($buildNew -ne "") -and ($buildNew -eq $buildOld) -and (Test-Path $pyw) -and (Test-Path $app)
# Bản mới nhưng cùng bộ Python + thư viện (runtime-id) -> chỉ thay app (engine ~1 MB, < 1 s).
$runtimeNew = Read-Id (Join-Path $here "runtime-id.txt")
$runtimeOld = Read-Id (Join-Path $dest "python\runtime-id.txt")
$sameRuntime = ($runtimeNew -ne "") -and ($runtimeNew -eq $runtimeOld) -and (Test-Path $pyw)

function Stop-CherryMayNay {
    Get-CimInstance Win32_Process -Filter "Name='pythonw.exe' OR Name='python.exe'" |
        Where-Object { $_.CommandLine -and $_.CommandLine -like "*\CherryMayNay\*" } |
        ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop } catch {} }
}

# Giải nén từng tệp để báo % theo dung lượng đã giải nén (from..to trên thanh tiến trình).
function Expand-WithProgress([string]$zipPath, [string]$destDir, [int]$from, [int]$to, [string]$label) {
    $zip = [System.IO.Compression.ZipFile]::OpenRead($zipPath)
    try {
        $total = [double]0
        foreach ($e in $zip.Entries) { $total += $e.Length }
        if ($total -le 0) { $total = 1 }
        $root = [System.IO.Path]::GetFullPath($destDir).TrimEnd('\') + '\'
        $dirs = New-Object 'System.Collections.Generic.HashSet[string]'
        $n = $zip.Entries.Count
        $done = [double]0
        $i = 0
        $last = -1
        foreach ($e in $zip.Entries) {
            $i++
            if ($e.FullName.EndsWith("/")) { continue }
            $target = [System.IO.Path]::GetFullPath((Join-Path $destDir ($e.FullName -replace '/', '\')))
            if (-not $target.StartsWith($root, [System.StringComparison]::OrdinalIgnoreCase)) { continue }
            $dir = [System.IO.Path]::GetDirectoryName($target)
            if ($dirs.Add($dir)) { [void][System.IO.Directory]::CreateDirectory($dir) }
            [System.IO.Compression.ZipFileExtensions]::ExtractToFile($e, $target, $true)
            $done += $e.Length
            $pct = $from + [int][Math]::Floor(($to - $from) * $done / $total)
            if ($pct -ne $last) {
                $last = $pct
                Set-CherryProgress $pct ("{0} ({1}/{2} tệp)" -f $label, $i, $n)
            }
        }
        return [long]$total
    } finally { $zip.Dispose() }
}

try {
    Set-CherryProgress 0 "Đang chuẩn bị…"
    try {
        $splashSrc = Join-Path $here "splash.ps1"
        if (Test-Path $splashSrc) {
            $splash = Join-Path $env:TEMP "CherrySplash.ps1"
            Copy-Item $splashSrc $splash -Force
            # logo đi kèm gói: lần cài đầu thư mục app chưa có ảnh
            $logo = Join-Path $env:TEMP "CherrySplash.png"
            $logoSrc = Join-Path $here "cherry.png"
            if (Test-Path $logoSrc) { Copy-Item $logoSrc $logo -Force }
            Start-Process powershell.exe -ArgumentList "-NoProfile -ExecutionPolicy Bypass -STA -WindowStyle Hidden -File `"$splash`" -ProgressFile `"$progressFile`" -Logo `"$logo`"" -WindowStyle Hidden
        }
    } catch {}

    $installedBytes = $null
    if ($sameBuild) {
        Write-Log "da co dung ban $buildNew - khong giai nen lai"
        if (Test-CherryHealth) {
            Write-Log "bo giai dang chay"
            Set-CherryProgress 100 "Cherry đang chạy."
            exit 0
        }
    } else {
        Write-Log "bat dau cai vao $dest (ban $buildNew, giu python: $sameRuntime)"
        Set-CherryProgress 2 "Đang tắt bản cũ…"
        Stop-CherryMayNay
        Start-Sleep -Milliseconds 800
        Add-Type -AssemblyName System.IO.Compression.FileSystem
        if ($sameRuntime) {
            Set-CherryProgress 10 "Đang thay bộ giải mới…"
            foreach ($old in @($appDir, (Join-Path $dest "uninstall.ps1"))) {
                if (Test-Path $old) { Remove-Item $old -Recurse -Force }
            }
            [void](Expand-WithProgress (Join-Path $here "app.zip") $dest 20 85 "Đang chép bộ giải")
        } else {
            if (Test-Path $dest) {
                Set-CherryProgress 3 "Đang dọn bản cũ…"
                Remove-Item $dest -Recurse -Force
            }
            New-Item -ItemType Directory -Force -Path $dest | Out-Null
            $pyBytes = Expand-WithProgress (Join-Path $here "python.zip") $dest 5 84 "Đang giải nén Python và thư viện"
            Write-Log "da giai nen python"
            $appBytes = Expand-WithProgress (Join-Path $here "app.zip") $dest 84 88 "Đang chép bộ giải"
            $installedBytes = $pyBytes + $appBytes
            # Lần đầu nạp thư viện gốc (ortools ~80 MB, scipy, numpy) mất ~16 s vì Windows quét
            # tệp mới -> nạp sẵn ở tiến trình ẩn ngay bây giờ, lượt Cherry đầu tiên khỏi chờ.
            try {
                Start-Process -FilePath $pyw -ArgumentList "-c `"import ortools.sat.python.cp_model, numpy, scipy.optimize, scipy.sparse, pandas, openpyxl`"" -WorkingDirectory $dest -WindowStyle Hidden
                Write-Log "nap san thu vien o nen"
            } catch {}
        }
        Write-Log "da giai nen"
    }

    Set-CherryProgress 89 "Đang đăng ký khởi động cùng Windows…"
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
    $values = @{
        "DisplayName"     = "Cherry máy này"
        "DisplayVersion"  = "1.0"
        "Publisher"       = "Cherry Software"
        "InstallLocation" = $dest
        "DisplayIcon"     = $icon
        "UninstallString" = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$dest\uninstall.ps1`""
    }
    foreach ($k in $values.Keys) { Set-ItemProperty -Path $un -Name $k -Value $values[$k] }
    if ($null -ne $installedBytes) {
        New-ItemProperty -Path $un -Name "EstimatedSize" -Value ([int]($installedBytes / 1KB)) -PropertyType DWord -Force | Out-Null
    }
    New-ItemProperty -Path $un -Name "NoModify" -Value 1 -PropertyType DWord -Force | Out-Null
    New-ItemProperty -Path $un -Name "NoRepair" -Value 1 -PropertyType DWord -Force | Out-Null
    Write-Log "da dang ky startup + cherry-local:// + muc go cai dat"

    # Lần đầu: biểu tượng 🍒 hiện ở khay kèm thông báo; trang TKB đang mở tự nhận ra bộ giải.
    Set-CherryProgress 92 "Đang bật bộ giải…"
    Start-Process -FilePath $pyw -ArgumentList "`"$app`" --background --tray --first-run" -WorkingDirectory $appDir -WindowStyle Hidden
    $ready = $false
    for ($i = 0; $i -lt 60; $i++) {
        if (Test-CherryHealth) { $ready = $true; break }
        Set-CherryProgress ([Math]::Min(99, 92 + [int]($i / 2))) "Đang bật bộ giải…"
        Start-Sleep -Milliseconds 500
    }
    Write-Log "bo giai san sang: $ready"
    if ($ready) { Set-CherryProgress 100 "Cherry đã chạy." }
    else { Set-CherryProgress -1 "Bộ giải chưa trả lời sau 30 giây." }
    # Không mở thêm tab: thông báo ở khay + trang TKB đang mở tự nhận bộ giải.
    exit 0
} catch {
    Write-Log ("LOI: " + $_.Exception.Message)
    Set-CherryProgress -1 ("Lỗi khi cài: " + $_.Exception.Message)
    exit 1
}
