param(
    [Parameter(Mandatory = $false)]
    [string]$Version = "0.1.0",

    [Parameter(Mandatory = $false)]
    [string]$AgentExePath = "",

    [Parameter(Mandatory = $false)]
    [string]$OutputPath = ""
)

$ErrorActionPreference = "Stop"

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$installerPath = Join-Path $PSScriptRoot "breeze.wxs"
$taskXmlPath = Join-Path $repoRoot "service\\windows\\breeze-agent-user-task.xml"
$installUserHelperScriptPath = Join-Path $repoRoot "scripts\\install\\install-windows.ps1"
$removeUserHelperScriptPath = Join-Path $PSScriptRoot "remove-windows-task.ps1"
$enrollAgentScriptPath = Join-Path $PSScriptRoot "enroll-agent.ps1"

if ([string]::IsNullOrWhiteSpace($AgentExePath)) {
    $AgentExePath = Join-Path $repoRoot "breeze-agent-windows-amd64.exe"
}
if ([string]::IsNullOrWhiteSpace($OutputPath)) {
    $OutputPath = Join-Path $repoRoot "..\\dist\\breeze-agent.msi"
}

if (-not (Get-Command wix -ErrorAction SilentlyContinue)) {
    throw "wix CLI not found. Install WiX v4 first (e.g. 'dotnet tool install --global wix')."
}

if (-not (Test-Path $installerPath)) {
    throw "Installer definition not found: $installerPath"
}
if (-not (Test-Path $AgentExePath)) {
    throw "Agent executable not found: $AgentExePath"
}
if (-not (Test-Path $taskXmlPath)) {
    throw "Task XML not found: $taskXmlPath"
}
if (-not (Test-Path $installUserHelperScriptPath)) {
    throw "User helper install script not found: $installUserHelperScriptPath"
}
if (-not (Test-Path $removeUserHelperScriptPath)) {
    throw "User helper uninstall script not found: $removeUserHelperScriptPath"
}
if (-not (Test-Path $enrollAgentScriptPath)) {
    throw "Enrollment script not found: $enrollAgentScriptPath"
}

$msiVersion = ($Version -replace '-.*$', '')
if ($msiVersion -notmatch '^\d+\.\d+\.\d+(\.\d+)?$') {
    throw "Version '$Version' is not MSI-compatible. Use numeric version like 1.2.3 or 1.2.3.4."
}

$outputDir = Split-Path -Parent $OutputPath
if (-not (Test-Path $outputDir)) {
    New-Item -Path $outputDir -ItemType Directory -Force | Out-Null
}

$wixArgs = @(
    "build",
    "$installerPath",
    "-arch", "x64",
    "-d", "Version=$msiVersion",
    "-d", "AgentExePath=$AgentExePath",
    "-d", "UserTaskXmlPath=$taskXmlPath",
    "-d", "InstallUserHelperScriptPath=$installUserHelperScriptPath",
    "-d", "RemoveUserHelperScriptPath=$removeUserHelperScriptPath",
    "-d", "EnrollAgentScriptPath=$enrollAgentScriptPath",
    "-o", "$OutputPath"
)

& wix @wixArgs
if ($LASTEXITCODE -ne 0) {
    throw "wix build failed with exit code $LASTEXITCODE"
}

Write-Host "Built MSI at: $OutputPath"
