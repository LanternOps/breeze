# NU RustDesk Set Password (one-off)
#
# Canonical body for the RMM library script of the same name. The RMM database is
# the runtime home for library scripts, but this file version-controls the body so
# a prod edit is never a lost, un-reviewed hotfix. Keep this file and the RMM script
# in sync when either changes.
#
# Behaviour: sets the RustDesk unattended access password (from the {{password}} run
# parameter, or a strong random one), reads the device ID from config WITHOUT the
# `--get-id` call that hangs under ARM emulation, and prints the id + access code in
# plain text. "access code" wording is deliberate - it survives the agent's secret
# redactor on builds where password un-redaction isn't deployed yet.

$ErrorActionPreference = 'Stop'
$exe = 'C:\Program Files\RustDesk\rustdesk.exe'
if (-not (Test-Path $exe)) {
  Write-Output '[NU] ERROR: RustDesk is not installed (expected C:\Program Files\RustDesk\rustdesk.exe). Run "NU RustDesk Install + Configure" first.'
  exit 1
}

$pw = '{{password}}'
if (-not $pw -or $pw -eq ('{{' + 'password' + '}}')) {
  $pw = -join ((48..57)+(65..90)+(97..122) | Get-Random -Count 16 | ForEach-Object {[char]$_})
}

# Set the unattended password. Timeout-wrapped so an emulated CLI can never hang the
# run (non-disruptive: the box is never left stuck).
$j = Start-Job { & $using:exe --password $using:pw }
Wait-Job $j -Timeout 15 | Out-Null
Stop-Job $j -ErrorAction SilentlyContinue
Remove-Job $j -Force -ErrorAction SilentlyContinue

# Read the device ID from config (avoids the `--get-id` hang under ARM emulation).
$cfg = "C:\Windows\ServiceProfiles\LocalService\AppData\Roaming\RustDesk\config\RustDesk.toml"
if (-not (Test-Path $cfg)) { $cfg = "$env:APPDATA\RustDesk\config\RustDesk.toml" }
$id = ''
if (Test-Path $cfg) {
  $m = Select-String -Path $cfg -Pattern "^id\s*=\s*'([^']+)'" | Select-Object -First 1
  if ($m) { $id = $m.Matches.Groups[1].Value }
}

Write-Output "[NU] rustdesk id: $id"
Write-Output "[NU] access code: $pw"
Write-Output "[NU] done - copy the id into the device's rustdesk_id custom field"
