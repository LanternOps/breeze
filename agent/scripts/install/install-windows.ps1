#Requires -RunAsAdministrator
<#
.SYNOPSIS
    Install Breeze Agent user helper as a Windows Scheduled Task.
.DESCRIPTION
    Registers the user helper scheduled task so it auto-starts for each user at login.
#>

$ErrorActionPreference = "Stop"

$BinaryPath = "C:\Program Files\Breeze\breeze-agent.exe"
$TaskXmlPath = Join-Path $PSScriptRoot "..\..\service\windows\breeze-agent-user-task.xml"
$TaskName = "\Breeze\AgentUserHelper"

Write-Host "Installing Breeze Agent User Helper..."

# Verify binary exists
if (-not (Test-Path $BinaryPath)) {
    Write-Error "breeze-agent.exe not found at $BinaryPath. Install the agent first."
    exit 1
}

# Find task XML
if (-not (Test-Path $TaskXmlPath)) {
    $TaskXmlPath = Join-Path $PSScriptRoot "..\..\service\windows\breeze-agent-user-task.xml"
}
if (-not (Test-Path $TaskXmlPath)) {
    Write-Error "Task XML template not found"
    exit 1
}

# Register scheduled task
try {
    # Remove existing task if present
    $existing = Get-ScheduledTask -TaskName "AgentUserHelper" -TaskPath "\Breeze\" -ErrorAction SilentlyContinue
    if ($existing) {
        Unregister-ScheduledTask -TaskName "AgentUserHelper" -TaskPath "\Breeze\" -Confirm:$false
        Write-Host "  Removed existing scheduled task"
    }

    Register-ScheduledTask -Xml (Get-Content $TaskXmlPath -Raw) -TaskName "AgentUserHelper" -TaskPath "\Breeze\"
    Write-Host "  Scheduled task registered: $TaskName"
} catch {
    Write-Error "Failed to register scheduled task: $_"
    exit 1
}

Write-Host ""
Write-Host "Breeze Agent User Helper installed."
Write-Host "The helper will start automatically at next user login."
Write-Host "To start now: schtasks /run /tn `"$TaskName`""
