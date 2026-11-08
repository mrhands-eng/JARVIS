# Optional: register JARVIS in HKCU Run (user must confirm by running this script)
$ErrorActionPreference = 'Stop'
$root = Resolve-Path (Join-Path $PSScriptRoot '..')
$electron = Join-Path $root 'node_modules\electron\dist\electron.exe'
if (-not (Test-Path $electron)) { throw "Electron not found. Run npm install first." }
$cmd = "`"$electron`" `"$root`""
New-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name 'StarkOS-JARVIS' -Value $cmd -PropertyType String -Force | Out-Null
Write-Host "Registered StarkOS-JARVIS startup: $cmd"
Write-Host "To remove: .\scripts\disable-startup.ps1"
