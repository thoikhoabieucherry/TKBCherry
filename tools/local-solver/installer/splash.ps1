# Cửa sổ cài / khởi động Cherry, hiện NGAY khi mở Cherry.exe (28/10, chủ dự án: "chạy Cherry.exe
# nó ko khởi động phần mềm lên ngay"; "cho thể hiện tiến trình cho phù hợp đúng 20 giây luôn";
# "làm font và giao diện cài đặt chuyên nghiệp đẹp xíu AI xíu").
# install.ps1 chạy file này trong tiến trình riêng và ghi % THẬT (theo dung lượng đã giải nén) vào
# ProgressFile dạng "phần trăm|dòng chữ": 100 = bộ giải đã trả lời -> báo "đã chạy" rồi tự đóng;
# -1 = lỗi. Cửa sổ KHÔNG tự dò bộ giải (lúc mới mở, bản cũ có thể còn chạy vài trăm ms).
# Vẽ tay bằng GDI+ (nền gradient tối, mạng nút kiểu AI, thanh % gradient có vệt sáng chạy).
# -Snapshot <png>: chỉ vẽ ra ảnh để kiểm tra giao diện (không hiện cửa sổ).
param(
    [string]$ProgressFile = (Join-Path $env:TEMP "CherrySplash.progress"),
    [int]$TimeoutSec = 180,
    [string]$Log = (Join-Path $env:TEMP "Cherry-install.log"),
    [string]$Logo = "",
    [string]$Snapshot = "",
    [int]$SnapshotPct = 45,
    [string]$SnapshotMsg = "Đang cài các thành phần (1294/2877 tệp)",
    [string]$SnapshotState = "progress"
)
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

$W = 520
$H = 216
$R = 18

$installedFonts = @((New-Object System.Drawing.Text.InstalledFontCollection).Families | ForEach-Object { $_.Name })
function New-UiFont([string[]]$names, [single]$size, [System.Drawing.FontStyle]$style = [System.Drawing.FontStyle]::Regular) {
    foreach ($n in $names) {
        if ($installedFonts -contains $n) { return New-Object System.Drawing.Font($n, $size, $style, [System.Drawing.GraphicsUnit]::Point) }
    }
    return New-Object System.Drawing.Font("Segoe UI", $size, $style, [System.Drawing.GraphicsUnit]::Point)
}
$fTitle = New-UiFont @("Segoe UI Variable Display Semib", "Segoe UI Semibold") 21
$fBadge = New-UiFont @("Segoe UI Variable Small Semibol", "Segoe UI Semibold") 7.5
$fSub = New-UiFont @("Segoe UI Variable Text", "Segoe UI") 9.5
$fStatus = New-UiFont @("Segoe UI Variable Text", "Segoe UI") 10
$fPct = New-UiFont @("Segoe UI Variable Display Semib", "Segoe UI Semibold") 13
$fFoot = New-UiFont @("Segoe UI Variable Small", "Segoe UI") 8.5
$fBtn = New-UiFont @("Segoe UI Variable Text Semibold", "Segoe UI Semibold") 9.5

function New-Color([string]$hex, [int]$alpha = 255) {
    $c = [System.Drawing.ColorTranslator]::FromHtml($hex)
    return [System.Drawing.Color]::FromArgb($alpha, $c.R, $c.G, $c.B)
}

function New-RoundPath([single]$x, [single]$y, [single]$w, [single]$h, [single]$r) {
    $p = New-Object System.Drawing.Drawing2D.GraphicsPath
    $r = [Math]::Max(0.5, [Math]::Min($r, [Math]::Min($w, $h) / 2))
    $d = $r * 2
    $p.AddArc($x, $y, $d, $d, 180, 90)
    $p.AddArc($x + $w - $d, $y, $d, $d, 270, 90)
    $p.AddArc($x + $w - $d, $y + $h - $d, $d, $d, 0, 90)
    $p.AddArc($x, $y + $h - $d, $d, $d, 90, 90)
    $p.CloseFigure()
    return $p
}

$logoImage = $null
foreach ($candidate in @($Logo, (Join-Path $env:LOCALAPPDATA "CherryMayNay\app\cherry.png"))) {
    if ($candidate -and (Test-Path $candidate)) {
        try { $logoImage = [System.Drawing.Image]::FromFile($candidate); break } catch {}
    }
}

# Nền tĩnh (gradient + quầng sáng + mạng nút) vẽ một lần ra bitmap.
$background = New-Object System.Drawing.Bitmap($W, $H)
$bg = [System.Drawing.Graphics]::FromImage($background)
$bg.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$rect = New-Object System.Drawing.Rectangle(0, 0, $W, $H)
$base = New-Object System.Drawing.Drawing2D.LinearGradientBrush($rect, (New-Color "#0B1022"), (New-Color "#271A57"), 32.0)
$bg.FillRectangle($base, $rect)
foreach ($glow in @(@(($W - 250), -170, 430, 330, "#EC4899", 70), @(-160, ($H - 120), 380, 300, "#6366F1", 60))) {
    $gp = New-Object System.Drawing.Drawing2D.GraphicsPath
    $gp.AddEllipse([single]$glow[0], [single]$glow[1], [single]$glow[2], [single]$glow[3])
    $pgb = New-Object System.Drawing.Drawing2D.PathGradientBrush($gp)
    $pgb.CenterColor = New-Color $glow[4] $glow[5]
    $pgb.SurroundColors = [System.Drawing.Color[]]@((New-Color $glow[4] 0))
    $bg.FillPath($pgb, $gp)
    $pgb.Dispose(); $gp.Dispose()
}
$rnd = New-Object System.Random(11)
$nodes = @()
for ($i = 0; $i -lt 15; $i++) { $nodes += , @((330 + $rnd.NextDouble() * 175), (8 + $rnd.NextDouble() * 46)) }
$linePen = New-Object System.Drawing.Pen((New-Color "#A5B4FC" 34), 1)
for ($i = 0; $i -lt $nodes.Count; $i++) {
    for ($j = $i + 1; $j -lt $nodes.Count; $j++) {
        $dx = $nodes[$i][0] - $nodes[$j][0]; $dy = $nodes[$i][1] - $nodes[$j][1]
        if (($dx * $dx + $dy * $dy) -lt 3600) { $bg.DrawLine($linePen, [single]$nodes[$i][0], [single]$nodes[$i][1], [single]$nodes[$j][0], [single]$nodes[$j][1]) }
    }
}
$dot = New-Object System.Drawing.SolidBrush((New-Color "#C7D2FE" 90))
foreach ($n in $nodes) { $bg.FillEllipse($dot, [single]($n[0] - 1.8), [single]($n[1] - 1.8), 3.6, 3.6) }
$linePen.Dispose(); $dot.Dispose(); $base.Dispose(); $bg.Dispose()

$script:S = @{
    mode = "progress"; target = 0.0; shown = 0.0; msg = "Đang chuẩn bị…"
    shimmer = 0.0; started = Get-Date; closeAt = $null; tick = 0
}
$btnRect = New-Object System.Drawing.RectangleF(($W - 116), ($H - 46), 88, 30)

function Draw-Splash([System.Drawing.Graphics]$g) {
    $S = $script:S
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.DrawImage($background, 0, 0, $W, $H)

    # logo trong vòng sáng
    $halo = New-Object System.Drawing.SolidBrush((New-Color "#FFFFFF" 22))
    $g.FillEllipse($halo, 24, 22, 60, 60); $halo.Dispose()
    if ($logoImage) { $g.DrawImage($logoImage, 31, 29, 46, 46) }

    $white = New-Object System.Drawing.SolidBrush((New-Color "#FFFFFF"))
    $g.DrawString("Cherry", $fTitle, $white, 94, 18)
    $tw = $g.MeasureString("Cherry", $fTitle).Width
    # huy hiệu "AI" (28/10: chủ dự án bỏ chữ "CP-SAT" / "chạy bằng sức của chính máy này" — "kì")
    $badgeText = "AI"
    $bw = $g.MeasureString($badgeText, $fBadge).Width + 14
    $bx = 94 + $tw + 4; $by = 31
    $badge = New-RoundPath $bx $by $bw 19 9.5
    $bb = New-Object System.Drawing.Drawing2D.LinearGradientBrush((New-Object System.Drawing.RectangleF($bx, $by, $bw, 19)), (New-Color "#F43F5E" 210), (New-Color "#8B5CF6" 210), 0.0)
    $g.FillPath($bb, $badge); $bb.Dispose(); $badge.Dispose()
    $g.DrawString($badgeText, $fBadge, $white, [single]($bx + 7), [single]($by + 2.5))
    $sub = New-Object System.Drawing.SolidBrush((New-Color "#C7D2FE"))
    $g.DrawString("Xếp thời khóa biểu thông minh", $fSub, $sub, 96, 62)
    $sub.Dispose()

    # dòng trạng thái + phần trăm
    $statusColor = switch ($S.mode) { "done" { "#A7F3D0" } "error" { "#FCA5A5" } default { "#E2E8F0" } }
    $status = New-Object System.Drawing.SolidBrush((New-Color $statusColor))
    $fmt = New-Object System.Drawing.StringFormat
    $fmt.Trimming = [System.Drawing.StringTrimming]::EllipsisCharacter
    $fmt.FormatFlags = [System.Drawing.StringFormatFlags]::NoWrap
    $statusText = switch ($S.mode) {
        "done" { "Cherry đã chạy — quay lại trang TKB và bấm Cherry." }
        "error" { "Chưa khởi động được Cherry." }
        default { $S.msg }
    }
    $g.DrawString($statusText, $fStatus, $status, (New-Object System.Drawing.RectangleF(28, 108, ($W - 120), 22)), $fmt)
    $status.Dispose()
    $pctText = if ($S.mode -eq "error") { "" } else { "{0}%" -f [int][Math]::Round($S.shown) }
    $right = New-Object System.Drawing.StringFormat
    $right.Alignment = [System.Drawing.StringAlignment]::Far
    $g.DrawString($pctText, $fPct, $white, (New-Object System.Drawing.RectangleF(($W - 128), 104, 100, 26)), $right)

    # thanh tiến trình
    $tx = 28; $ty = 138; $tw2 = $W - 56; $th = 8
    $track = New-RoundPath $tx $ty $tw2 $th 4
    $trackBrush = New-Object System.Drawing.SolidBrush((New-Color "#FFFFFF" 30))
    $g.FillPath($trackBrush, $track); $trackBrush.Dispose(); $track.Dispose()
    $fw = [single]($tw2 * [Math]::Max(0, [Math]::Min(100, $S.shown)) / 100)
    if ($fw -ge 8) {
        $fill = New-RoundPath $tx $ty $fw $th 4
        $fillRect = New-Object System.Drawing.RectangleF($tx, $ty, $tw2, $th)
        $fb = New-Object System.Drawing.Drawing2D.LinearGradientBrush($fillRect, (New-Color "#F43F5E"), (New-Color "#6366F1"), 0.0)
        $blend = New-Object System.Drawing.Drawing2D.ColorBlend(3)
        if ($S.mode -eq "done") {
            $blend.Colors = [System.Drawing.Color[]]@((New-Color "#10B981"), (New-Color "#22D3EE"), (New-Color "#818CF8"))
        } else {
            $blend.Colors = [System.Drawing.Color[]]@((New-Color "#F43F5E"), (New-Color "#D946EF"), (New-Color "#6366F1"))
        }
        $blend.Positions = [single[]]@(0.0, 0.5, 1.0)
        $fb.InterpolationColors = $blend
        $g.FillPath($fb, $fill); $fb.Dispose()
        if ($S.mode -eq "progress") {
            # vệt sáng chạy trên phần đã xong
            $state = $g.Save()
            $g.SetClip($fill)
            $sx = [single]($tx - 70 + ($S.shimmer % ($fw + 70)))
            $shine = New-Object System.Drawing.Drawing2D.LinearGradientBrush((New-Object System.Drawing.RectangleF($sx, $ty, 70, $th)), (New-Color "#FFFFFF" 0), (New-Color "#FFFFFF" 0), 0.0)
            $sb = New-Object System.Drawing.Drawing2D.ColorBlend(3)
            $sb.Colors = [System.Drawing.Color[]]@((New-Color "#FFFFFF" 0), (New-Color "#FFFFFF" 120), (New-Color "#FFFFFF" 0))
            $sb.Positions = [single[]]@(0.0, 0.5, 1.0)
            $shine.InterpolationColors = $sb
            $g.FillRectangle($shine, $sx, [single]$ty, 70, [single]$th)
            $shine.Dispose()
            $g.Restore($state)
        }
        $fill.Dispose()
    }

    # chân trang
    $foot = New-Object System.Drawing.SolidBrush((New-Color "#94A3B8"))
    $footText = switch ($S.mode) {
        "done" {
            $left = if ($S.closeAt) { [Math]::Max(0, [int][Math]::Ceiling(($S.closeAt - (Get-Date)).TotalSeconds)) } else { 0 }
            "Biểu tượng Cherry ở cạnh đồng hồ (không thấy thì bấm ^) · tự đóng sau $left giây"
        }
        "error" { "$($S.msg) Gửi file log nếu vẫn lỗi: $Log" }
        default { "Lần đầu mất khoảng 10 giây · các lần sau mở ngay" }
    }
    $footRect = if ($S.mode -eq "progress") { New-Object System.Drawing.RectangleF(28, 164, ($W - 56), 34) } else { New-Object System.Drawing.RectangleF(28, 158, ($W - 160), 44) }
    $wrap = New-Object System.Drawing.StringFormat
    $wrap.Trimming = [System.Drawing.StringTrimming]::EllipsisPath
    $g.DrawString($footText, $fFoot, $foot, $footRect, $wrap)
    $foot.Dispose()

    if ($S.mode -ne "progress") {
        $btn = New-RoundPath $btnRect.X $btnRect.Y $btnRect.Width $btnRect.Height 15
        $btnBrush = New-Object System.Drawing.SolidBrush((New-Color "#FFFFFF" 34))
        $g.FillPath($btnBrush, $btn); $btnBrush.Dispose()
        $btnPen = New-Object System.Drawing.Pen((New-Color "#FFFFFF" 70), 1)
        $g.DrawPath($btnPen, $btn); $btnPen.Dispose(); $btn.Dispose()
        $center = New-Object System.Drawing.StringFormat
        $center.Alignment = [System.Drawing.StringAlignment]::Center
        $center.LineAlignment = [System.Drawing.StringAlignment]::Center
        $g.DrawString("Đóng", $fBtn, $white, $btnRect, $center)
    }
    $white.Dispose()

    $edge = New-RoundPath 0.5 0.5 ($W - 1) ($H - 1) $R
    $edgePen = New-Object System.Drawing.Pen((New-Color "#FFFFFF" 40), 1)
    $g.DrawPath($edgePen, $edge); $edgePen.Dispose(); $edge.Dispose()
}

if ($Snapshot) {
    $script:S.mode = $SnapshotState
    $script:S.shown = [double]$SnapshotPct
    $script:S.msg = $SnapshotMsg
    $script:S.shimmer = 160
    if ($SnapshotState -eq "done") { $script:S.closeAt = (Get-Date).AddSeconds(5.5); $script:S.shown = 100 }
    $shot = New-Object System.Drawing.Bitmap($W, $H)
    $sg = [System.Drawing.Graphics]::FromImage($shot)
    Draw-Splash $sg
    $sg.Dispose()
    $shot.Save($Snapshot, [System.Drawing.Imaging.ImageFormat]::Png)
    $shot.Dispose()
    exit 0
}

function Read-CherryProgress {
    try {
        if (-not (Test-Path $ProgressFile)) { return $null }
        $raw = [System.IO.File]::ReadAllText($ProgressFile, [System.Text.Encoding]::UTF8)
        $cut = $raw.IndexOf("|")
        if ($cut -lt 0) { return $null }
        return @{ pct = [int]$raw.Substring(0, $cut); msg = $raw.Substring($cut + 1).Trim() }
    } catch { return $null }   # install.ps1 đang ghi dở -> đọc lại ở nhịp sau
}

$form = New-Object System.Windows.Forms.Form
$form.Text = "Cherry"
$form.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::None
$form.StartPosition = [System.Windows.Forms.FormStartPosition]::CenterScreen
$form.ClientSize = New-Object System.Drawing.Size($W, $H)
$form.ShowInTaskbar = $true
$form.TopMost = $true
$form.BackColor = New-Color "#0B1022"
$form.KeyPreview = $true
$form.GetType().GetProperty("DoubleBuffered", [System.Reflection.BindingFlags]"Instance,NonPublic").SetValue($form, $true, $null)
$form.Region = New-Object System.Drawing.Region((New-RoundPath 0 0 $W $H $R))
if ($logoImage) {
    try { $form.Icon = [System.Drawing.Icon]::FromHandle(([System.Drawing.Bitmap]$logoImage).GetHicon()) } catch {}
}
$form.Add_Paint({ param($sender, $e) Draw-Splash $e.Graphics })

# kéo cửa sổ bằng chuột; bấm "Đóng" / Esc khi đã xong hoặc lỗi
$script:drag = $null
$form.Add_MouseDown({ param($sender, $e) if ($e.Button -eq [System.Windows.Forms.MouseButtons]::Left) { $script:drag = $e.Location } })
$form.Add_MouseMove({ param($sender, $e)
    if ($script:drag -and $e.Button -eq [System.Windows.Forms.MouseButtons]::Left) {
        $form.Location = New-Object System.Drawing.Point(($form.Location.X + $e.X - $script:drag.X), ($form.Location.Y + $e.Y - $script:drag.Y))
    } })
$form.Add_MouseUp({ $script:drag = $null })
$form.Add_MouseClick({ param($sender, $e)
    if ($script:S.mode -ne "progress" -and $btnRect.Contains([single]$e.X, [single]$e.Y)) { $form.Close() } })
$form.Add_KeyDown({ param($sender, $e)
    if ($e.KeyCode -eq [System.Windows.Forms.Keys]::Escape -and $script:S.mode -ne "progress") { $form.Close() } })

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 33
$timer.Add_Tick({
    $S = $script:S
    $S.tick++
    if ($S.mode -eq "progress" -and ($S.tick % 6) -eq 0) {
        $p = Read-CherryProgress
        if ($null -ne $p) {
            if ($p.pct -ge 100) {
                $S.mode = "done"; $S.target = 100.0
                $S.closeAt = (Get-Date).AddSeconds(6)
            } elseif ($p.pct -lt 0) {
                $S.mode = "error"; $S.msg = $p.msg
            } else {
                $S.target = [double][Math]::Max($S.target, [Math]::Min(99, $p.pct))
                if ($p.msg) { $S.msg = $p.msg }
            }
        }
        if ($S.mode -eq "progress" -and ((Get-Date) - $S.started).TotalSeconds -gt $TimeoutSec) {
            $S.mode = "error"; $S.msg = "Quá $TimeoutSec giây mà Cherry chưa chạy."
        }
    }
    # % hiển thị đuổi mượt theo % thật
    $gap = $S.target - $S.shown
    if ($gap -gt 0) { $S.shown = [Math]::Min($S.target, $S.shown + [Math]::Max(0.35, $gap * 0.18)) }
    $S.shimmer += 7
    if ($S.mode -eq "done" -and $S.closeAt -and (Get-Date) -ge $S.closeAt) { $form.Close(); return }
    $form.Invalidate()
})
$form.Add_Shown({ $form.Activate(); $timer.Start() })
[void]$form.ShowDialog()
$timer.Stop()
