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

$logDir = Join-Path $env:ProgramData "Breeze\logs"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

$serverUrl = Get-CustomActionDataValue -Data $CustomActionData -Key "SERVER_URL" -NextKey "ENROLLMENT_KEY"
$enrollmentKey = Get-CustomActionDataValue -Data $CustomActionData -Key "ENROLLMENT_KEY" -NextKey "ENROLLMENT_SECRET"
$enrollmentSecret = Get-CustomActionDataValue -Data $CustomActionData -Key "ENROLLMENT_SECRET"

# Template MSI sentinels are space-padded to 512 chars; strip trailing padding.
$serverUrl = $serverUrl.Trim()
$enrollmentKey = $enrollmentKey.Trim()
$enrollmentSecret = $enrollmentSecret.Trim()

if ([string]::IsNullOrWhiteSpace($serverUrl) -or [string]::IsNullOrWhiteSpace($enrollmentKey)) {
    # The MSI condition gates EnrollAgent on both properties being non-empty,
    # so reaching this branch means CustomActionData was mangled between MSI
    # and PowerShell (e.g. null bytes in the property value truncated the
    # command-line argument). Write a forensic marker and fail loudly.
    $marker = Join-Path $logDir "enroll-failed.txt"
    @"
Enrollment custom action received empty SERVER_URL or ENROLLMENT_KEY despite
the MSI condition requiring both. This usually means the template MSI was
patched with null bytes instead of spaces, truncating the CustomActionData
command-line argument.

Timestamp: $(Get-Date -Format 'o')
CustomActionData length: $($CustomActionData.Length)
Parsed serverUrl: '$serverUrl'
Parsed enrollmentKey present: $(-not [string]::IsNullOrWhiteSpace($enrollmentKey))
"@ | Out-File -FilePath $marker -Encoding utf8 -Force
    throw "Enrollment skipped: CustomActionData missing SERVER_URL or ENROLLMENT_KEY (see $marker)"
}

$agentExe = Join-Path $env:ProgramFiles "Breeze\breeze-agent.exe"
$configPath = Join-Path $env:ProgramData "Breeze\agent.yaml"
$enrollLog = Join-Path $logDir "enroll.log"

if (-not (Test-Path $agentExe)) {
    throw "breeze-agent.exe not found at expected location: $agentExe"
}

# Avoid failing upgrades/reinstalls if already enrolled.
if (Test-Path $configPath) {
    if (Get-Service -Name "BreezeAgent" -ErrorAction SilentlyContinue) {
        & sc.exe config BreezeAgent start= auto | Out-Null
        # Don't block on service startup here — surface failures as warnings
        # so they land in the MSI log. This script exits immediately after,
        # so there's no later StartServices retry in the upgrade path.
        try {
            Start-Service -Name "BreezeAgent" -ErrorAction Stop
        } catch {
            Write-Warning "Start-Service failed during enrollment custom action: $($_.Exception.Message)"
        }
    }
    exit 0
}

$enrollArgs = @("enroll", $enrollmentKey, "--server", $serverUrl)
if (-not [string]::IsNullOrWhiteSpace($enrollmentSecret)) {
    $enrollArgs += "--enrollment-secret"
    $enrollArgs += $enrollmentSecret
}
"[$(Get-Date -Format 'o')] enrolling against $serverUrl" | Out-File -FilePath $enrollLog -Encoding utf8 -Append
& $agentExe @enrollArgs *>&1 | Tee-Object -FilePath $enrollLog -Append
if ($LASTEXITCODE -ne 0) {
    throw "Enrollment command failed with exit code $LASTEXITCODE — see $enrollLog"
}

if (Get-Service -Name "BreezeAgent" -ErrorAction SilentlyContinue) {
    & sc.exe config BreezeAgent start= auto | Out-Null
    # Don't block on service startup here — if this script is the MSI custom
    # action host, the installer's own StartServices step will wait for
    # Running. Surface failures as warnings so they land in the MSI log.
    try {
        Start-Service -Name "BreezeAgent" -ErrorAction Stop
    } catch {
        Write-Warning "Start-Service failed during enrollment custom action: $($_.Exception.Message). MSI StartServices will retry."
    }
}
