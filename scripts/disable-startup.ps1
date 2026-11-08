Remove-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name 'StarkOS-JARVIS' -ErrorAction SilentlyContinue
Write-Host 'Removed StarkOS-JARVIS from startup (if it was present).'
