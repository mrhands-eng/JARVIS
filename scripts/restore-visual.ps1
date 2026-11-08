$ErrorActionPreference = 'Stop'
$root = Resolve-Path (Join-Path $PSScriptRoot '..')
$snap = Join-Path $root 'snapshots'

$persSnap = Join-Path $snap 'personalize.json'
if (Test-Path $persSnap) {
  $p = Get-Content $persSnap -Raw | ConvertFrom-Json
  $pers = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize'
  foreach ($name in @('AppsUseLightTheme','SystemUsesLightTheme','EnableTransparency')) {
    if ($null -ne $p.$name) {
      New-ItemProperty -Path $pers -Name $name -Value ([int]$p.$name) -PropertyType DWord -Force | Out-Null
    }
  }
  Write-Host 'Restored Personalize snapshot.'
}

$termSnap = Join-Path $snap 'windows-terminal-settings.json'
$term = "$env:LOCALAPPDATA\Packages\Microsoft.WindowsTerminal_8wekyb3d8bbwe\LocalState\settings.json"
if ((Test-Path $termSnap) -and (Test-Path $term)) {
  Copy-Item $termSnap $term -Force
  Write-Host 'Restored Windows Terminal settings.'
}

Write-Host 'Visual restore complete (wallpaper not auto-restored — set manually if needed).'
