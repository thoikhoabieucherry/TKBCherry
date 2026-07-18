param(
  [switch]$Status,
  [switch]$Remove,
  [switch]$Gui
)

$ErrorActionPreference = "Stop"
$secretDir = Join-Path $env:LOCALAPPDATA "TKBCherry\secrets"
$secretPath = Join-Path $secretDir "vps-password.dpapi"

if ($Status) {
  if (Test-Path -LiteralPath $secretPath) {
    Write-Output "VPS_CREDENTIAL_PRESENT path=$secretPath"
    exit 0
  }
  Write-Output "VPS_CREDENTIAL_MISSING path=$secretPath"
  exit 1
}

if ($Remove) {
  Remove-Item -LiteralPath $secretPath -Force -ErrorAction SilentlyContinue
  Write-Output "VPS_CREDENTIAL_DELETED path=$secretPath"
  exit 0
}

$securePassword = $null
if ($Gui) {
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -AssemblyName System.Drawing
  $form = New-Object System.Windows.Forms.Form
  $form.Text = "TKBCherry - Luu mat khau VPS"
  $form.StartPosition = "CenterScreen"
  $form.ClientSize = New-Object System.Drawing.Size(420, 150)
  $form.FormBorderStyle = "FixedDialog"
  $form.MaximizeBox = $false
  $form.MinimizeBox = $false
  $form.TopMost = $true

  $label = New-Object System.Windows.Forms.Label
  $label.Text = "Mat khau root cho VPS 165.101.47.133"
  $label.AutoSize = $true
  $label.Location = New-Object System.Drawing.Point(20, 18)
  $form.Controls.Add($label)

  $passwordBox = New-Object System.Windows.Forms.TextBox
  $passwordBox.Location = New-Object System.Drawing.Point(20, 48)
  $passwordBox.Size = New-Object System.Drawing.Size(380, 26)
  $passwordBox.UseSystemPasswordChar = $true
  $form.Controls.Add($passwordBox)

  $saveButton = New-Object System.Windows.Forms.Button
  $saveButton.Text = "Luu"
  $saveButton.DialogResult = [System.Windows.Forms.DialogResult]::OK
  $saveButton.Location = New-Object System.Drawing.Point(244, 96)
  $form.Controls.Add($saveButton)

  $cancelButton = New-Object System.Windows.Forms.Button
  $cancelButton.Text = "Huy"
  $cancelButton.DialogResult = [System.Windows.Forms.DialogResult]::Cancel
  $cancelButton.Location = New-Object System.Drawing.Point(325, 96)
  $form.Controls.Add($cancelButton)

  $form.AcceptButton = $saveButton
  $form.CancelButton = $cancelButton
  $form.Add_Shown({ $passwordBox.Focus() })
  $result = $form.ShowDialog()
  if ($result -ne [System.Windows.Forms.DialogResult]::OK) {
    $form.Dispose()
    Write-Output "VPS_CREDENTIAL_CANCELLED"
    exit 2
  }
  $securePassword = ConvertTo-SecureString $passwordBox.Text -AsPlainText -Force
  $passwordBox.Clear()
  $form.Dispose()
} else {
  $securePassword = Read-Host "VPS password for 165.101.47.133 (root)" -AsSecureString
}
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassword)
$plainBytes = $null
$protectedBytes = $null
try {
  $plainText = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
  if ([string]::IsNullOrWhiteSpace($plainText)) {
    throw "Password cannot be empty."
  }
  $plainBytes = [Text.Encoding]::UTF8.GetBytes($plainText)
  $entropy = [Text.Encoding]::UTF8.GetBytes("TKBCherry/VPS credential v1")
  $protectedBytes = [Security.Cryptography.ProtectedData]::Protect(
    $plainBytes,
    $entropy,
    [Security.Cryptography.DataProtectionScope]::CurrentUser
  )
  New-Item -ItemType Directory -Path $secretDir -Force | Out-Null
  $temporary = "$secretPath.tmp"
  [IO.File]::WriteAllBytes($temporary, $protectedBytes)
  Move-Item -LiteralPath $temporary -Destination $secretPath -Force
  Write-Output "VPS_CREDENTIAL_SAVED path=$secretPath"
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
  if ($plainBytes) { [Array]::Clear($plainBytes, 0, $plainBytes.Length) }
  if ($protectedBytes) { [Array]::Clear($protectedBytes, 0, $protectedBytes.Length) }
}
