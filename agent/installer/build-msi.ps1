param(
    [Parameter(Mandatory = $false)]
    [string]$Version = "0.1.0",

    # Installer identity to build. "Hosted" (default) reproduces today's MSI
    # identity byte-for-byte (ProductName "Breeze Agent", the original
    # UpgradeCode) so existing callers that pass nothing get an unchanged
    # package and existing hosted fleets keep upgrading in place.
    # "SelfHost" builds the self-hosted edition under its own permanent
    # UpgradeCode. See breeze.wxs's preprocessor block and the cross-edition
    # Upgrade/Launch guard near MajorUpgrade for why the two must never
    # share an UpgradeCode.
    [Parameter(Mandatory = $false)]
    [ValidateSet("Hosted", "SelfHost")]
    [string]$Edition = "Hosted",

    [Parameter(Mandatory = $false)]
    [string]$AgentExePath = "",

    [Parameter(Mandatory = $false)]
    [string]$BackupExePath = "",

    [Parameter(Mandatory = $false)]
    [string]$WatchdogExePath = "",

    [Parameter(Mandatory = $false)]
    [string]$UserHelperExePath = "",

    [Parameter(Mandatory = $false)]
    [string]$OutputPath = ""
)

$ErrorActionPreference = "Stop"

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$installerPath = Join-Path $PSScriptRoot "breeze.wxs"
$taskXmlPath = Join-Path $repoRoot "service\\windows\\breeze-agent-user-task.xml"
$installUserHelperScriptPath = Join-Path $repoRoot "scripts\\install\\install-windows.ps1"
$removeUserHelperScriptPath = Join-Path $PSScriptRoot "remove-windows-task.ps1"

if ([string]::IsNullOrWhiteSpace($AgentExePath)) {
    $AgentExePath = Join-Path $repoRoot "breeze-agent-windows-amd64.exe"
}
if ([string]::IsNullOrWhiteSpace($BackupExePath)) {
    $BackupExePath = Join-Path $repoRoot "breeze-backup-windows-amd64.exe"
}
if ([string]::IsNullOrWhiteSpace($WatchdogExePath)) {
    $WatchdogExePath = Join-Path $repoRoot "breeze-watchdog-windows-amd64.exe"
}
if ([string]::IsNullOrWhiteSpace($UserHelperExePath)) {
    $UserHelperExePath = Join-Path $repoRoot "breeze-user-helper-windows-amd64.exe"
}
if ([string]::IsNullOrWhiteSpace($OutputPath)) {
    $OutputPath = Join-Path $repoRoot "..\\dist\\breeze-agent.msi"
}

if (-not (Get-Command wix -ErrorAction SilentlyContinue)) {
    throw "wix CLI not found. Install the WiX CLI first (e.g. 'dotnet tool install --global wix')."
}

if (-not (Test-Path $installerPath)) {
    throw "Installer definition not found: $installerPath"
}
if (-not (Test-Path $AgentExePath)) {
    throw "Agent executable not found: $AgentExePath"
}
if (-not (Test-Path $BackupExePath)) {
    throw "Backup executable not found: $BackupExePath"
}
if (-not (Test-Path $WatchdogExePath)) {
    throw "Watchdog executable not found: $WatchdogExePath"
}
if (-not (Test-Path $UserHelperExePath)) {
    throw "User-helper executable not found: $UserHelperExePath"
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

$msiVersion = ($Version -replace '-.*$', '')
if ($msiVersion -notmatch '^\d+\.\d+\.\d+(\.\d+)?$') {
    throw "Version '$Version' is not MSI-compatible. Use numeric version like 1.2.3 or 1.2.3.4."
}

$outputDir = Split-Path -Parent $OutputPath
if (-not (Test-Path $outputDir)) {
    New-Item -Path $outputDir -ItemType Directory -Force | Out-Null
}

# Edition identity map. These UpgradeCodes are the SAME literals hardcoded
# as the ifndef defaults in breeze.wxs (Hosted) and its cross-edition guard
# comment (SelfHost) — duplicated here only because build-msi.ps1 must pass
# the "other" edition's code explicitly (a bare `wix build breeze.wxs` with
# no -d overrides can only ever default to Hosted-vs-SelfHost, never the
# reverse). Do not change either GUID; the SelfHost UpgradeCode in
# particular is permanent — self-hosted fleets identify their upgrade
# lineage by it.
$hostedProductName = "Breeze Agent"
$hostedUpgradeCode = "{70A57B7A-4F72-4E18-B8D3-7D2783C2C1A9}"
$selfHostProductName = "Breeze Agent (Self-Hosted)"
$selfHostUpgradeCode = "{787838E2-1A3E-4B61-8514-75DD922A6B1B}"

if ($Edition -eq "SelfHost") {
    $editionProductName = $selfHostProductName
    $editionUpgradeCode = $selfHostUpgradeCode
    $editionOtherUpgradeCode = $hostedUpgradeCode
}
else {
    $editionProductName = $hostedProductName
    $editionUpgradeCode = $hostedUpgradeCode
    $editionOtherUpgradeCode = $selfHostUpgradeCode
}

# breeze.wxs runs KillBreezeProcesses through WixQuietExec (no console
# window on the user's desktop, #3624), whose CA DLL (Wix4UtilCA_*) ships in
# the WiX Util extension. An extension must match the wix CLI's version, so
# pin it to the CLI's own version rather than floating to the newest one.
# Installing it here (idempotent) means every caller of this script, including
# the release and signing pipelines in other repos, needs no extra setup step.
# Capture all output before picking a line: piping a native command into
# Select-Object -First stops the pipeline early and can leave $LASTEXITCODE -1.
$wixVersionOutput = @(& wix --version)
$wixVersionExit = $LASTEXITCODE
$wixVersionLine = ($wixVersionOutput | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | Select-Object -First 1)
if ($wixVersionExit -ne 0 -or [string]::IsNullOrWhiteSpace($wixVersionLine)) {
    throw "could not read the wix CLI version (wix --version exit code $wixVersionExit, output: $($wixVersionOutput -join ' '))"
}
$wixVersion = ([string]$wixVersionLine).Trim() -replace '\+.*$', ''
if ($wixVersion -notmatch '^\d+\.\d+\.\d+') {
    throw "unexpected wix --version output '$wixVersionLine'; cannot pick a matching WixToolset.Util.wixext version"
}
$utilExtension = "WixToolset.Util.wixext/$wixVersion"
& wix extension add -g $utilExtension
if ($LASTEXITCODE -ne 0) {
    throw "wix extension add $utilExtension failed with exit code $LASTEXITCODE"
}

$wixArgs = @(
    "build",
    "$installerPath",
    "-arch", "x64",
    "-ext", "$utilExtension",
    "-d", "Version=$msiVersion",
    "-d", "ProductName=$editionProductName",
    "-d", "UpgradeCode=$editionUpgradeCode",
    "-d", "OtherUpgradeCode=$editionOtherUpgradeCode",
    "-d", "AgentExePath=$AgentExePath",
    "-d", "BackupExePath=$BackupExePath",
    "-d", "WatchdogExePath=$WatchdogExePath",
    "-d", "UserHelperExePath=$UserHelperExePath",
    "-d", "UserTaskXmlPath=$taskXmlPath",
    "-d", "InstallUserHelperScriptPath=$installUserHelperScriptPath",
    "-d", "RemoveUserHelperScriptPath=$removeUserHelperScriptPath",
    "-o", "$OutputPath"
)

& wix @wixArgs
if ($LASTEXITCODE -ne 0) {
    throw "wix build failed with exit code $LASTEXITCODE"
}

Write-Host "Built MSI at: $OutputPath"
