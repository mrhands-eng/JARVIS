$ErrorActionPreference = 'Stop'
$root = Resolve-Path (Join-Path $PSScriptRoot '..')
Write-Host "Stark OS root: $root"

# Dark mode + accent-ish cyan via Personalize (safe HKCU)
$pers = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize'
New-ItemProperty -Path $pers -Name 'AppsUseLightTheme' -Value 0 -PropertyType DWord -Force | Out-Null
New-ItemProperty -Path $pers -Name 'SystemUsesLightTheme' -Value 0 -PropertyType DWord -Force | Out-Null
New-ItemProperty -Path $pers -Name 'EnableTransparency' -Value 1 -PropertyType DWord -Force | Out-Null
Write-Host 'Dark theme enabled.'

# Windows Terminal color scheme merge
$termCandidates = @(
  "$env:LOCALAPPDATA\Packages\Microsoft.WindowsTerminal_8wekyb3d8bbwe\LocalState\settings.json",
  "$env:LOCALAPPDATA\Microsoft\Windows Terminal\settings.json"
)
$scheme = Get-Content (Join-Path $root 'assets\themes\windows-terminal.stark.json') -Raw | ConvertFrom-Json
foreach ($term in $termCandidates) {
  if (-not (Test-Path $term)) { continue }
  Write-Host "Updating Terminal: $term"
  $json = Get-Content $term -Raw -Encoding UTF8 | ConvertFrom-Json
  $existing = @()
  if ($null -ne $json.schemes) { $existing = @($json.schemes | Where-Object { $_.name -ne 'Stark Arc' }) }
  $json.schemes = @($existing + $scheme)
  if ($null -eq $json.profiles) {
    $json | Add-Member -NotePropertyName profiles -NotePropertyValue ([pscustomobject]@{ defaults = [pscustomobject]@{} }) -Force
  }
  if ($null -eq $json.profiles.defaults) {
    $json.profiles | Add-Member -NotePropertyName defaults -NotePropertyValue ([pscustomobject]@{}) -Force
  }
  $json.profiles.defaults | Add-Member -NotePropertyName colorScheme -NotePropertyValue 'Stark Arc' -Force
  $json.profiles.defaults | Add-Member -NotePropertyName cursorColor -NotePropertyValue '#00E5FF' -Force
  $out = $json | ConvertTo-Json -Depth 100
  [System.IO.File]::WriteAllText($term, $out, [System.Text.UTF8Encoding]::new($false))
  Write-Host 'Terminal Stark Arc scheme applied.'
}

# Oh My Posh theme copy (if installed)
$ompTheme = Join-Path $root 'assets\themes\oh-my-posh.stark.omp.json'
$ompDest = Join-Path $env:USERPROFILE '.omp-stark.omp.json'
Copy-Item $ompTheme $ompDest -Force
Write-Host "Oh My Posh theme copied to $ompDest"
Write-Host "Add to PowerShell profile if desired:"
Write-Host "  oh-my-posh init pwsh --config `"$ompDest`" | Invoke-Expression"

# Wallpaper Engine hint
$weHtml = Join-Path $root 'assets\wallpapers\stark-hud.html'
Write-Host ""
Write-Host "Wallpaper Engine: open Web wallpaper and point to:"
Write-Host "  $weHtml"
Write-Host "Or set any dark wallpaper manually — HUD overlay provides the Stark UI."
Write-Host "Done."
