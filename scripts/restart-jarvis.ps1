# Relaunch Stark OS Electron after the current process exits.
param(
  [Parameter(Mandatory = $true)][int]$WaitPid,
  [Parameter(Mandatory = $true)][string]$Root
)

$ErrorActionPreference = "SilentlyContinue"
if ($WaitPid -gt 0) {
  try { Wait-Process -Id $WaitPid -Timeout 60 } catch { Start-Sleep -Seconds 2 }
}
Start-Sleep -Milliseconds 800

$electron = Join-Path $Root "node_modules\electron\dist\electron.exe"
if (-not (Test-Path $electron)) {
  $electron = Join-Path $Root "node_modules\electron\cli.js"
  Start-Process -FilePath "node" -ArgumentList @($electron, $Root) -WorkingDirectory $Root
  exit 0
}
Start-Process -FilePath $electron -ArgumentList @($Root) -WorkingDirectory $Root
