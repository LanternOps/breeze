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
$enrollLog = Join-Path $logDir "enroll.log"

"[$(Get-Date -Format 'o')] === MSI enrollment custom action started ===" |
    Out-File -FilePath $enrollLog -Encoding utf8 -Append
"[$(Get-Date -Format 'o')] CustomActionData length: $($CustomActionData.Length)" |
    Out-File -FilePath $enrollLog -Encoding utf8 -Append

$serverUrl = Get-CustomActionDataValue -Data $CustomActionData -Key "SERVER_URL" -NextKey "ENROLLMENT_KEY"
$enrollmentKey = Get-CustomActionDataValue -Data $CustomActionData -Key "ENROLLMENT_KEY" -NextKey "ENROLLMENT_SECRET"
$enrollmentSecret = Get-CustomActionDataValue -Data $CustomActionData -Key "ENROLLMENT_SECRET"

# Template MSI sentinels are space-padded to 512 chars; strip trailing padding.
$serverUrl = $serverUrl.Trim()
$enrollmentKey = $enrollmentKey.Trim()
$enrollmentSecret = $enrollmentSecret.Trim()

"[$(Get-Date -Format 'o')] Parsed: serverUrl='$serverUrl' enrollmentKey present=$(-not [string]::IsNullOrWhiteSpace($enrollmentKey)) enrollmentSecret present=$(-not [string]::IsNullOrWhiteSpace($enrollmentSecret))" |
    Out-File -FilePath $enrollLog -Encoding utf8 -Append

if ([string]::IsNullOrWhiteSpace($serverUrl) -or [string]::IsNullOrWhiteSpace($enrollmentKey)) {
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
    "[$(Get-Date -Format 'o')] FATAL: CustomActionData missing SERVER_URL or ENROLLMENT_KEY (see $marker)" |
        Out-File -FilePath $enrollLog -Encoding utf8 -Append
    # Exit 0 so the MSI install completes — agent is installed but not enrolled.
    # The user can re-enroll manually: breeze-agent.exe enroll <key> --server <url>
    exit 0
}

$agentExe = Join-Path $env:ProgramFiles "Breeze\breeze-agent.exe"
$configPath = Join-Path $env:ProgramData "Breeze\agent.yaml"

if (-not (Test-Path $agentExe)) {
    "[$(Get-Date -Format 'o')] FATAL: breeze-agent.exe not found at $agentExe" |
        Out-File -FilePath $enrollLog -Encoding utf8 -Append
    exit 0
}

# Config from a previous install may linger after uninstall (ProgramData is
# Permanent). Back it up and re-enroll so the agent gets a fresh token.
$backupPath = "$configPath.bak"
$hadExistingConfig = $false
if (Test-Path $configPath) {
    $hadExistingConfig = $true
    try {
        if (Get-Service -Name "BreezeAgent" -ErrorAction SilentlyContinue) {
            Stop-Service -Name "BreezeAgent" -Force -ErrorAction SilentlyContinue
        }
        Copy-Item -Path $configPath -Destination $backupPath -Force
        Remove-Item -Path $configPath -Force
        "[$(Get-Date -Format 'o')] Found stale config from prior install, backed up to $backupPath and re-enrolling" |
            Out-File -FilePath $enrollLog -Encoding utf8 -Append
    } catch {
        "[$(Get-Date -Format 'o')] ERROR: Failed to back up/remove stale config: $($_.Exception.Message)" |
            Out-File -FilePath $enrollLog -Encoding utf8 -Append
        # Continue anyway — enrollment may still succeed if agent handles existing config
    }
}

$enrollArgs = @("enroll", $enrollmentKey, "--server", $serverUrl)
if (-not [string]::IsNullOrWhiteSpace($enrollmentSecret)) {
    $enrollArgs += "--enrollment-secret"
    $enrollArgs += $enrollmentSecret
}

# Retry enrollment up to 3 times with increasing delays. The first attempt
# can fail due to DNS propagation, transient network issues, or the server
# not being ready yet (e.g. during initial deployment).
$maxAttempts = 3
$enrollSuccess = $false

for ($attempt = 1; $attempt -le $maxAttempts; $attempt++) {
    "[$(Get-Date -Format 'o')] Enrollment attempt $attempt/$maxAttempts against $serverUrl" |
        Out-File -FilePath $enrollLog -Encoding utf8 -Append

    # Remove any partial config from a failed prior attempt in this loop
    if ($attempt -gt 1 -and (Test-Path $configPath)) {
        Remove-Item -Path $configPath -Force -ErrorAction SilentlyContinue
    }

    # Temporarily relax ErrorActionPreference so that stderr output from the
    # native command (e.g. "Warning: Failed to collect system info") doesn't
    # get promoted to a terminating error by PowerShell's Stop preference.
    # This was the root cause of the original MSI error 1722 — PS killed the
    # script the moment breeze-agent.exe wrote a warning to stderr.
    $savedEAP = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    & $agentExe @enrollArgs *>&1 | Out-File -FilePath $enrollLog -Encoding utf8 -Append
    $exitCode = $LASTEXITCODE
    $ErrorActionPreference = $savedEAP
    if ($exitCode -eq 0) {
        $enrollSuccess = $true
        "[$(Get-Date -Format 'o')] Enrollment succeeded on attempt $attempt" |
            Out-File -FilePath $enrollLog -Encoding utf8 -Append
        break
    }

    "[$(Get-Date -Format 'o')] Enrollment attempt $attempt failed with exit code $exitCode" |
        Out-File -FilePath $enrollLog -Encoding utf8 -Append

    if ($attempt -lt $maxAttempts) {
        $delay = $attempt * 2
        "[$(Get-Date -Format 'o')] Retrying in ${delay}s..." |
            Out-File -FilePath $enrollLog -Encoding utf8 -Append
        Start-Sleep -Seconds $delay
    }
}

if (-not $enrollSuccess) {
    "[$(Get-Date -Format 'o')] All $maxAttempts enrollment attempts failed" |
        Out-File -FilePath $enrollLog -Encoding utf8 -Append

    if ($hadExistingConfig -and (Test-Path $backupPath)) {
        Copy-Item -Path $backupPath -Destination $configPath -Force
        "[$(Get-Date -Format 'o')] Restored backup config from $backupPath" |
            Out-File -FilePath $enrollLog -Encoding utf8 -Append
    }

    # Write a pending enrollment file so the user knows enrollment is needed.
    # They can re-run: breeze-agent.exe enroll <key> --server <url>
    $pendingPath = Join-Path $env:ProgramData "Breeze\enrollment-pending.json"
    @{
        serverUrl = $serverUrl
        enrollmentKey = $enrollmentKey
        timestamp = (Get-Date -Format 'o')
        error = "Enrollment failed after $maxAttempts attempts. See $enrollLog for details."
    } | ConvertTo-Json | Out-File -FilePath $pendingPath -Encoding utf8 -Force
    "[$(Get-Date -Format 'o')] Wrote pending enrollment file: $pendingPath" |
        Out-File -FilePath $enrollLog -Encoding utf8 -Append

    # Exit 0 so the MSI install completes. The agent is installed but not
    # enrolled. The BreezeAgent service will start but won't connect until
    # enrollment succeeds. Re-enroll manually or retry via:
    #   & "C:\Program Files\Breeze\breeze-agent.exe" enroll <KEY> --server <URL>
    "[$(Get-Date -Format 'o')] Exiting with code 0 — install will complete without enrollment" |
        Out-File -FilePath $enrollLog -Encoding utf8 -Append
    exit 0
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

# Clean up pending enrollment file from a prior failed install if we succeeded now
$pendingPath = Join-Path $env:ProgramData "Breeze\enrollment-pending.json"
if (Test-Path $pendingPath) {
    Remove-Item -Path $pendingPath -Force -ErrorAction SilentlyContinue
}

"[$(Get-Date -Format 'o')] === MSI enrollment custom action completed successfully ===" |
    Out-File -FilePath $enrollLog -Encoding utf8 -Append
