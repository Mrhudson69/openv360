# openv360 agent installer for Windows (no administrator rights needed).
#
#   & ([scriptblock]::Create((irm https://YOUR-SERVER/install.ps1))) -Code ABCD-EFGH
#
param(
  [string]$Code = "",
  [string]$Server = "__OPENV360_SERVER_URL__",
  [string]$ReleaseBase = "__OPENV360_RELEASE_BASE__"
)
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"   # makes Invoke-WebRequest much faster
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

function Say($m) { Write-Host "==> $m" -ForegroundColor Cyan }
function Warn($m) { Write-Host "warning: $m" -ForegroundColor Yellow }
function Die($m) { Write-Host "error: $m" -ForegroundColor Red; exit 1 }

if ($Server -like "__OPENV360*" -or -not $Server) { Die "no server address. Use -Server https://your-server -Code ABCD-EFGH" }
$Server = $Server.TrimEnd("/")
if ($ReleaseBase -like "__OPENV360*" -or -not $ReleaseBase) { $ReleaseBase = "$Server/downloads" }
if ($Server -notmatch '^https?://[A-Za-z0-9.:_/-]+$') { Die "invalid server address: $Server" }
if ($Code) {
  $Code = $Code.ToUpper()
  if ($Code -notmatch '^[A-Z0-9]{4}-?[A-Z0-9]{4}$') { Die "enrollment code should look like ABCD-EFGH" }
}
if (-not [Environment]::Is64BitOperatingSystem) { Die "openv360 needs 64-bit Windows" }

$tmp = Join-Path $env:TEMP "openv360-setup-$([guid]::NewGuid()).exe"
Say "Downloading openv360"
Invoke-WebRequest -UseBasicParsing -Uri "$ReleaseBase/openv360-agent_x64-setup.exe" -OutFile $tmp

Get-Process openv360-agent -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Say "Installing"
$p = Start-Process -FilePath $tmp -ArgumentList "/S" -Wait -PassThru
Remove-Item $tmp -Force -ErrorAction SilentlyContinue
if ($p.ExitCode -ne 0) { Die "installer exited with code $($p.ExitCode)" }

if ($Code) {
  $dir = Join-Path $env:APPDATA "org.openv360.agent"
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  $json = '{"serverUrl":"' + $Server + '","code":"' + $Code + '"}'
  [IO.File]::WriteAllText((Join-Path $dir "enroll.json"), $json, (New-Object Text.UTF8Encoding($false)))
}

$exe = Join-Path $env:LOCALAPPDATA "openv360\openv360-agent.exe"
if (-not (Test-Path $exe)) { Die "installed app not found at $exe" }

# Background service: a per-user scheduled task that launches openv360 at logon
# and relaunches it every 2 minutes if it has been closed, so it keeps running.
try {
  $guard = Join-Path $env:LOCALAPPDATA "openv360\openv360-guard.ps1"
  @"
`$exe = '$exe'
if (-not (Get-Process -Name 'openv360-agent' -ErrorAction SilentlyContinue)) {
  Start-Process -FilePath `$exe -ArgumentList '--autostart','--service'
}
"@ | Set-Content -Path $guard -Encoding UTF8

  $action    = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$guard`""
  $atLogon   = New-ScheduledTaskTrigger -AtLogOn
  $repeat    = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 2) -RepetitionDuration ([TimeSpan]::MaxValue)
  $settings  = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew
  Register-ScheduledTask -TaskName "openv360" -Action $action -Trigger @($atLogon, $repeat) -Settings $settings -Force | Out-Null
  Say "Installed background task (starts at logon, restarts if closed)"
} catch {
  Warn "could not register the background task ($($_.Exception.Message)); openv360 will still start now"
}

Say "Starting openv360"
Start-Process -FilePath $exe
if ($Code) { Say "Done. openv360 is connecting to $Server - look for its icon in the system tray." }
else { Say "Done. Open openv360 and enter your server address ($Server) and enrollment code." }
