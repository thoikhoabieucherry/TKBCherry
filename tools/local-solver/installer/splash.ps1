# Cửa sổ nhỏ "Đang khởi động Cherry…" hiện NGAY khi mở Cherry.exe (28/10, chủ dự án: "chạy
# Cherry.exe nó ko khởi động phần mềm lên ngay"): trước đây suốt ~20 s giải nén không có gì
# hiện ra, biểu tượng 🍒 thì Windows 11 hay giấu sau dấu ^. install.ps1 chạy file này trong tiến
# trình riêng; cửa sổ tự dò http://127.0.0.1:<Port>/api/health, lên thì báo "đã chạy" rồi tự đóng.
param(
    [int]$Port = 2211,
    [int]$TimeoutSec = 150,
    [string]$Log = (Join-Path $env:TEMP "CherryMayNay-install.log")
)
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Net.Http
[System.Windows.Forms.Application]::EnableVisualStyles()

$form = New-Object System.Windows.Forms.Form
$form.Text = "Cherry"
$form.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::FixedDialog
$form.MaximizeBox = $false
$form.MinimizeBox = $false
$form.StartPosition = [System.Windows.Forms.FormStartPosition]::CenterScreen
$form.TopMost = $true
$form.ShowInTaskbar = $true
$form.ClientSize = New-Object System.Drawing.Size(400, 150)
$form.Font = New-Object System.Drawing.Font("Segoe UI", 10)
$icon = Join-Path $env:LOCALAPPDATA "CherryMayNay\app\cherry.ico"
if (Test-Path $icon) { try { $form.Icon = New-Object System.Drawing.Icon($icon) } catch {} }

$label = New-Object System.Windows.Forms.Label
$label.Location = New-Object System.Drawing.Point(16, 14)
$label.Size = New-Object System.Drawing.Size(368, 64)
$label.Text = "Đang khởi động Cherry…`r`nLần đầu hoặc khi có bản mới mất khoảng 20 giây."
$form.Controls.Add($label)

$bar = New-Object System.Windows.Forms.ProgressBar
$bar.Location = New-Object System.Drawing.Point(16, 84)
$bar.Size = New-Object System.Drawing.Size(368, 14)
$bar.Style = [System.Windows.Forms.ProgressBarStyle]::Marquee
$bar.MarqueeAnimationSpeed = 30
$form.Controls.Add($bar)

$close = New-Object System.Windows.Forms.Button
$close.Text = "Đóng"
$close.Size = New-Object System.Drawing.Size(90, 30)
$close.Location = New-Object System.Drawing.Point(294, 108)
$close.Visible = $false
$close.Add_Click({ $form.Close() })
$form.Controls.Add($close)

$client = New-Object System.Net.Http.HttpClient
$client.Timeout = [TimeSpan]::FromSeconds(2)
$script:probe = $null
$script:done = $false
$started = Get-Date

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 500
$timer.Add_Tick({
    if ($script:done) { return }
    if ($null -eq $script:probe) {
        try { $script:probe = $client.GetAsync("http://127.0.0.1:$Port/api/health") } catch { $script:probe = $null }
    } elseif ($script:probe.IsCompleted) {
        $ok = $false
        try { $ok = (-not $script:probe.IsFaulted) -and (-not $script:probe.IsCanceled) -and $script:probe.Result.IsSuccessStatusCode } catch { $ok = $false }
        $script:probe = $null
        if ($ok) {
            $script:done = $true
            $bar.Visible = $false
            $label.Text = "Cherry đã chạy.`r`nQuay lại trang TKB và bấm Cherry — trang tự nhận.`r`n(Biểu tượng Cherry nằm cạnh đồng hồ; không thấy thì bấm dấu ^.)"
            $label.Size = New-Object System.Drawing.Size(368, 84)
            $close.Visible = $true
            $script:auto = New-Object System.Windows.Forms.Timer
            $script:auto.Interval = 8000
            $script:auto.Add_Tick({ $form.Close() })
            $script:auto.Start()
            return
        }
    }
    if (((Get-Date) - $started).TotalSeconds -gt $TimeoutSec) {
        $script:done = $true
        $bar.Visible = $false
        $label.Text = "Chưa khởi động được Cherry.`r`nThử mở lại Cherry.exe; vẫn lỗi thì gửi file:`r`n$Log"
        $label.Size = New-Object System.Drawing.Size(368, 84)
        $close.Visible = $true
    }
})
$form.Add_Shown({ $form.Activate(); $timer.Start() })
[void]$form.ShowDialog()
$timer.Stop()
$client.Dispose()
