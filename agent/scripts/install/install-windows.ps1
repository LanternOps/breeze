#Requires -RunAsAdministrator
<#
.SYNOPSIS
    Install Breeze Agent user helper as a Windows Scheduled Task.
.DESCRIPTION
    Registers the user helper scheduled task so it auto-starts for each user at login.

    Failure diagnostics: when this script fails, the MSI rolls back with
    "installer rolled back" and no actionable text in the default MSI log.
    To preserve the cause, every error path writes a single-line timestamped
    record to C:\ProgramData\Breeze\logs\user-helper-install-last-error.txt
    (survives the rollback because CA-written files are opaque to MSI) and
    emits an Event Viewer entry under Application/BreezeAgent. This mirrors
    the enrollment CA's diagnostic trail.
#>

$ErrorActionPreference = "Stop"

$BinaryPath = "C:\Program Files\Breeze\breeze-agent.exe"
$UserHelperBinaryPath = "C:\Program Files\Breeze\breeze-user-helper.exe"
$TaskXmlPath = Join-Path $PSScriptRoot "..\..\service\windows\breeze-agent-user-task.xml"
$TaskName = "\Breeze\AgentUserHelper"
$LogDir = "C:\ProgramData\Breeze\logs"
$SentinelPath = Join-Path $LogDir "user-helper-install-last-error.txt"

function Write-FailureDiagnostic {
    param([string]$Message)
    $ts = (Get-Date).ToUniversalTime().ToString("o")
    $line = "$ts $Message"
    # Sentinel file: best-effort. The MSI CA may be running before the logs
    # directory exists, so create it first. Suppress write failures so a
    # broken sentinel never masks the original error.
    try {
        if (-not (Test-Path $LogDir)) {
            New-Item -ItemType Directory -Path $LogDir -Force | Out-Null
        }
        Set-Content -Path $SentinelPath -Value $line -Encoding UTF8 -Force -ErrorAction SilentlyContinue
    } catch {
        # Ignore — sentinel is auxiliary
    }
    # Event Viewer: register the BreezeAgent source on first use, then write.
    try {
        if (-not [System.Diagnostics.EventLog]::SourceExists("BreezeAgent")) {
            New-EventLog -LogName Application -Source BreezeAgent -ErrorAction SilentlyContinue
        }
        Write-EventLog -LogName Application -Source BreezeAgent -EntryType Error -EventId 9001 -Message "user-helper task registration: $Message" -ErrorAction SilentlyContinue
    } catch {
        # Ignore — diagnostic is auxiliary
    }
    Write-Error $Message
}

Write-Host "Installing Breeze Agent User Helper..."

# Verify binaries exist. breeze-agent.exe is the console-subsystem CLI binary
# used by the SCM service. breeze-user-helper.exe is the GUI-subsystem sibling
# that the scheduled task launches at user logon — same Go source, built with
# -H windowsgui so no console window is allocated in the interactive session.
if (-not (Test-Path $BinaryPath)) {
    Write-FailureDiagnostic "breeze-agent.exe not found at $BinaryPath. Install the agent first."
    exit 1
}
if (-not (Test-Path $UserHelperBinaryPath)) {
    Write-FailureDiagnostic "breeze-user-helper.exe not found at $UserHelperBinaryPath. Install the agent first."
    exit 1
}

# Find task XML
if (-not (Test-Path $TaskXmlPath)) {
    $TaskXmlPath = Join-Path $PSScriptRoot "..\..\service\windows\breeze-agent-user-task.xml"
}
if (-not (Test-Path $TaskXmlPath)) {
    Write-FailureDiagnostic "Task XML template not found at $TaskXmlPath."
    exit 1
}

# Register scheduled task. Register-ScheduledTask -Force is idempotent —
# safe to invoke on first install, major upgrade, and msiexec /fa repair.
# Retried because the RegisterUserHelperTask CA is Return="check": a single
# transient Task Scheduler hiccup (service busy, momentary lock on the
# existing task from the previous version) would otherwise roll back an
# entire, otherwise-good upgrade. (The upgrade-backstop caller,
# ReRegisterUserHelperTaskAfterUpgrade, is Return="ignore".)
try {
    $taskXml = Get-Content $TaskXmlPath -Raw
} catch {
    Write-FailureDiagnostic "Failed to read task XML at ${TaskXmlPath}: $_"
    exit 1
}
$maxAttempts = 3
$registered = $false
$attemptErrors = @()
for ($attempt = 1; $attempt -le $maxAttempts; $attempt++) {
    try {
        Register-ScheduledTask -Xml $taskXml -TaskName "AgentUserHelper" -TaskPath "\Breeze\" -Force | Out-Null
        $registered = $true
        break
    } catch {
        $attemptErrors += "attempt ${attempt}: $_"
        # Best-effort Warning per failed attempt (Event ID 9002) so a fleet
        # whose registrations only ever succeed on retry is distinguishable
        # from a healthy one — without this, the retry being load-bearing is
        # invisible until the day all attempts fail.
        try {
            Write-EventLog -LogName Application -Source BreezeAgent -EntryType Warning -EventId 9002 -Message "user-helper task registration attempt $attempt/$maxAttempts failed: $_" -ErrorAction SilentlyContinue
        } catch {
            # Ignore — diagnostic is auxiliary
        }
        if ($attempt -lt $maxAttempts) {
            Start-Sleep -Seconds 2
        }
    }
}
if ($registered) {
    Write-Host "  Scheduled task registered: $TaskName"
    # Clear the sentinel from any prior failed install so support staff can
    # tell a fresh failure from a stale record.
    if (Test-Path $SentinelPath) {
        Remove-Item -Path $SentinelPath -Force -ErrorAction SilentlyContinue
    }
} else {
    # Report every distinct attempt error, not just the last — attempt 1 may
    # carry the real root cause (e.g. malformed XML) while later attempts
    # fail differently.
    Write-FailureDiagnostic "Failed to register scheduled task after $maxAttempts attempts: $($attemptErrors -join ' | ')"
    exit 1
}

Write-Host ""
Write-Host "Breeze Agent User Helper installed."
Write-Host "The helper will start automatically at next user login."
Write-Host "To start now: schtasks /run /tn `"$TaskName`""
