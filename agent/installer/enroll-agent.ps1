#Requires -RunAsAdministrator
param(
    [Parameter(Mandatory = $false)]
    [string]$CustomActionData
)

$ErrorActionPreference = "Stop"

function Get-CustomActionDataValue {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Data,

        [Parameter(Mandatory = $true)]
        [string]$Key,

        [Parameter(Mandatory = $false)]
        [string]$NextKey = ""
    )

    if ([string]::IsNullOrWhiteSpace($Data)) {
        return ""
    }

    $escapedKey = [Regex]::Escape($Key)
    if ([string]::IsNullOrWhiteSpace($NextKey)) {
        $pattern = "(?:^|;)$escapedKey=(?<value>.*)$"
    } else {
        $escapedNextKey = [Regex]::Escape($NextKey)
        $pattern = "(?:^|;)$escapedKey=(?<value>.*?)(?=;$escapedNextKey=|$)"
    }

    $match = [Regex]::Match($Data, $pattern)
    if (-not $match.Success) {
        return ""
    }

    return $match.Groups["value"].Value
}

$serverUrl = Get-CustomActionDataValue -Data $CustomActionData -Key "SERVER_URL" -NextKey "ENROLLMENT_KEY"
$enrollmentKey = Get-CustomActionDataValue -Data $CustomActionData -Key "ENROLLMENT_KEY"

if ([string]::IsNullOrWhiteSpace($serverUrl) -or [string]::IsNullOrWhiteSpace($enrollmentKey)) {
    exit 0
}

$agentExe = Join-Path $env:ProgramFiles "Breeze\\breeze-agent.exe"
$configPath = Join-Path $env:ProgramData "Breeze\\agent.yaml"

if (-not (Test-Path $agentExe)) {
    throw "breeze-agent.exe not found at expected location: $agentExe"
}

# Avoid failing upgrades/reinstalls if already enrolled.
if (Test-Path $configPath) {
    if (Get-Service -Name "BreezeAgent" -ErrorAction SilentlyContinue) {
        & sc.exe config BreezeAgent start= auto | Out-Null
        Start-Service -Name "BreezeAgent" -ErrorAction SilentlyContinue
    }
    exit 0
}

& $agentExe enroll $enrollmentKey --server $serverUrl
if ($LASTEXITCODE -ne 0) {
    throw "Enrollment command failed with exit code $LASTEXITCODE"
}

if (Get-Service -Name "BreezeAgent" -ErrorAction SilentlyContinue) {
    & sc.exe config BreezeAgent start= auto | Out-Null
    Start-Service -Name "BreezeAgent" -ErrorAction Stop
}
