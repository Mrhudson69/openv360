# openv360 agent uninstaller for Windows.
#   & ([scriptblock]::Create((irm https://YOUR-SERVER/uninstall.ps1)))
$ErrorActionPreference = "SilentlyContinue"
function Say($m) { Write-Host "==> $m" -ForegroundColor Cyan }

Say "Removing openv360"
Unregister-ScheduledTask -TaskName "openv360" -Confirm:$false
Get-Process -Name "openv360-agent" | Stop-Process -Force

$uninst = Join-Path $env:LOCALAPPDATA "openv360\uninstall.exe"
if (Test-Path $uninst) {
  Start-Process -FilePath $uninst -ArgumentList "/S" -Wait
} else {
  Remove-Item -Recurse -Force (Join-Path $env:LOCALAPPDATA "openv360")
}
Remove-Item -Recurse -Force (Join-Path $env:APPDATA "org.openv360.agent")
# Autostart registry entry, if the app created one.
Remove-ItemProperty -Path "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run" -Name "org.openv360.agent" -ErrorAction SilentlyContinue
Say "Done."
