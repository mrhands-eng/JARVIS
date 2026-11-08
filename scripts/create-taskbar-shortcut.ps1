# Create JARVIS Start Menu + Desktop shortcuts and pin to the taskbar.
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$electron = Join-Path $root 'node_modules\electron\dist\electron.exe'
$ico = Join-Path $root 'assets\icon.ico'

if (-not (Test-Path $electron)) { throw "Electron not found. Run npm install first." }
if (-not (Test-Path $ico)) { throw "Icon missing: $ico" }

function New-JarvisShortcut([string]$Path) {
  $dir = Split-Path $Path
  if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
  $w = New-Object -ComObject WScript.Shell
  $s = $w.CreateShortcut($Path)
  $s.TargetPath = $electron
  $s.Arguments = "`"$root`""
  $s.WorkingDirectory = $root
  $s.WindowStyle = 1
  $s.Description = 'JARVIS — Stark OS'
  $s.IconLocation = "$ico,0"
  $s.Save()
}

function Try-PinToTaskbar([string]$LnkPath) {
  $folder = Split-Path $LnkPath
  $name = Split-Path $LnkPath -Leaf
  $shell = New-Object -ComObject Shell.Application
  $item = $shell.Namespace($folder).ParseName($name)
  if (-not $item) { return $false }
  foreach ($verb in @($item.Verbs())) {
    $n = ($verb.Name -replace '&', '').Trim()
    if ($n -match '^(Pin to taskbar|Закрепить на панели задач)$') {
      $verb.DoIt()
      return $true
    }
  }
  return $false
}

$programs = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'
$desktop = [Environment]::GetFolderPath('Desktop')
$programsLnk = Join-Path $programs 'JARVIS.lnk'
$desktopLnk = Join-Path $desktop 'JARVIS.lnk'
$pinnedDir = Join-Path $env:APPDATA 'Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar'
$pinnedLnk = Join-Path $pinnedDir 'JARVIS.lnk'

New-JarvisShortcut $programsLnk
New-JarvisShortcut $desktopLnk

$pinned = $false
foreach ($candidate in @($desktopLnk, $programsLnk)) {
  if (Try-PinToTaskbar $candidate) {
    $pinned = $true
    break
  }
}

if (-not $pinned) {
  if (-not (Test-Path $pinnedDir)) {
    New-Item -ItemType Directory -Path $pinnedDir -Force | Out-Null
  }
  Copy-Item -LiteralPath $programsLnk -Destination $pinnedLnk -Force
  # Refresh taskbar without killing Explorer if possible
  $shell = New-Object -ComObject Shell.Application
  $shell.Namespace($pinnedDir).Self.InvokeVerb('refresh') 2>$null
  Stop-Process -Name explorer -Force -ErrorAction SilentlyContinue
  Start-Sleep -Milliseconds 600
  Start-Process explorer
  $pinned = Test-Path $pinnedLnk
}

Write-Host "Shortcut: $programsLnk"
Write-Host "Desktop:  $desktopLnk"
if ($pinned) {
  Write-Host "Taskbar:  pinned (JARVIS)"
} else {
  Write-Host "Taskbar:  pin manually — right-click Desktop\JARVIS → Pin to taskbar"
}
