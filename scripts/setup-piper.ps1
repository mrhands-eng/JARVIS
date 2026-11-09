# Offline neural TTS for JARVIS (British male + Russian) — Piper + ONNX models.
# Run from repo root:  powershell -ExecutionPolicy Bypass -File scripts/setup-piper.ps1

$ErrorActionPreference = "Stop"
$Root = Split-Path $PSScriptRoot -Parent
$Dest = Join-Path $Root "data\voice\piper"
$PiperDir = Join-Path $Dest "piper"
$ProgressFile = Join-Path $Dest "setup-progress.json"
New-Item -ItemType Directory -Force -Path $Dest | Out-Null

function Write-SetupProgress {
  param(
    [string]$Label,
    [int]$Pct,
    [string]$Detail
  )
  $obj = @{
    label  = $Label
    pct    = [Math]::Max(0, [Math]::Min(100, $Pct))
    detail = $Detail
    at     = (Get-Date).ToString("o")
  }
  $obj | ConvertTo-Json -Compress | Set-Content -Path $ProgressFile -Encoding UTF8
}

function File-Mb($Path) {
  if (-not (Test-Path $Path)) { return 0 }
  return [math]::Round((Get-Item $Path).Length / 1MB, 1)
}

$Release = "2023.11.14-2"
$ZipUrl = "https://github.com/rhasspy/piper/releases/download/$Release/piper_windows_amd64.zip"
$Zip = Join-Path $env:TEMP "piper_windows_amd64.zip"

if (-not (Test-Path (Join-Path $PiperDir "piper.exe"))) {
  Write-SetupProgress -Label "Piper" -Pct 2 -Detail "Качаю движок…"
  Write-Host "Downloading Piper $Release..."
  Invoke-WebRequest -Uri $ZipUrl -OutFile $Zip -UseBasicParsing
  Write-SetupProgress -Label "Piper" -Pct 8 -Detail "Распаковка…"
  Expand-Archive -Path $Zip -DestinationPath $Dest -Force
  $inner = Get-ChildItem $Dest -Directory | Where-Object { Test-Path (Join-Path $_.FullName "piper.exe") } | Select-Object -First 1
  if ($inner) { Move-Item $inner.FullName $PiperDir -Force -ErrorAction SilentlyContinue }
  Write-SetupProgress -Label "Piper" -Pct 12 -Detail "Движок готов"
}

# Hugging Face rhasspy/piper-voices (medium quality, ~60–80 MB each)
$models = @(
  @{
    Name = "en_GB-northern_english_male-medium"
    Url  = "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_GB/northern_english_male/medium/en_GB-northern_english_male-medium.onnx"
    Json = "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_GB/northern_english_male/medium/en_GB-northern_english_male-medium.onnx.json"
    Slot = 0
  },
  @{
    Name = "ru_RU-ruslan-medium"
    Url  = "https://huggingface.co/rhasspy/piper-voices/resolve/main/ru/ru_RU/ruslan/medium/ru_RU-ruslan-medium.onnx"
    Json = "https://huggingface.co/rhasspy/piper-voices/resolve/main/ru/ru_RU/ruslan/medium/ru_RU-ruslan-medium.onnx.json"
    Slot = 1
  }
)

$idx = 0
foreach ($m in $models) {
  $idx++
  $onnx = Join-Path $Dest "$($m.Name).onnx"
  $json = Join-Path $Dest "$($m.Name).onnx.json"
  $basePct = 15 + ($idx - 1) * 40
  if (-not (Test-Path $onnx)) {
    Write-SetupProgress -Label "Голос $($m.Name)" -Pct $basePct -Detail "Старт загрузки…"
    Write-Host "Downloading $($m.Name)..."
    $done = $false
    $timer = New-Object System.Timers.Timer
    $timer.Interval = 2000
    $timer.AutoReset = $true
    $timer.Add_Elapsed({
      if ($done) { return }
      $mb = File-Mb $onnx
      $pct = [Math]::Min($basePct + 38, 14 + $idx * 40)
      Write-SetupProgress -Label "Голос $($m.Name)" -Pct $pct -Detail "$mb МБ…"
    })
    $timer.Start()
    try {
      Invoke-WebRequest -Uri $m.Url -OutFile $onnx -UseBasicParsing
    } finally {
      $done = $true
      $timer.Stop()
      $timer.Dispose()
    }
    Write-SetupProgress -Label "Голос $($m.Name)" -Pct (14 + $idx * 40) -Detail "$(File-Mb $onnx) МБ"
    Invoke-WebRequest -Uri $m.Json -OutFile $json -UseBasicParsing
  } else {
    Write-SetupProgress -Label "Голос $($m.Name)" -Pct (14 + $idx * 40) -Detail "Уже на диске"
  }
}

Write-SetupProgress -Label "Piper" -Pct 100 -Detail "Готово"
Write-Host ""
Write-Host "Done. Set in config/voice.json:"
Write-Host '  "provider": "piper"'
Write-Host "Then rebuild JARVIS (rebuild_jarvis)."
if (Test-Path $ProgressFile) { Remove-Item $ProgressFile -Force -ErrorAction SilentlyContinue }
