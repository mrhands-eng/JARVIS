# Download a local LLM into Stark OS / JARVIS only (not your global Ollama library).
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\pull-jarvis-model.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\pull-jarvis-model.ps1 -Model qwen2.5:14b

param(
  [string]$Model = "qwen2.5:7b"
)

$ErrorActionPreference = "Stop"
$Root = Resolve-Path (Join-Path $PSScriptRoot "..")
$Models = Join-Path $Root "data\ollama"
New-Item -ItemType Directory -Force -Path $Models | Out-Null

$Ollama = Join-Path $env:LOCALAPPDATA "Programs\Ollama\ollama.exe"
if (-not (Test-Path $Ollama)) {
  $Ollama = "C:\Program Files\Ollama\ollama.exe"
}
if (-not (Test-Path $Ollama)) {
  throw "Ollama not found. Install from https://ollama.com/download then re-run this script."
}

$env:OLLAMA_MODELS = $Models
$env:OLLAMA_HOST = "127.0.0.1:11435"

Write-Host "JARVIS models folder: $Models"
Write-Host "Ollama API:          $env:OLLAMA_HOST"
Write-Host "Model:               $Model"
Write-Host ""

# Start a JARVIS-only Ollama on port 11435 if needed
try {
  Invoke-WebRequest -Uri "http://127.0.0.1:11435/api/tags" -UseBasicParsing -TimeoutSec 2 | Out-Null
} catch {
  Write-Host "Starting JARVIS Ollama on 11435…"
  Start-Process -FilePath $Ollama -ArgumentList "serve" -WindowStyle Hidden
  Start-Sleep -Seconds 2
}

Write-Host "Pulling (this can take a while)…"
& $Ollama pull $Model
if ($LASTEXITCODE -ne 0) { throw "ollama pull failed with exit $LASTEXITCODE" }

Write-Host ""
Write-Host "Installed models in JARVIS store:"
& $Ollama list
Write-Host ""
Write-Host "Done. Tell the agent to continue — JARVIS will use this model offline."
