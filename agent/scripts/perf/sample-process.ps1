# Samples one process every 10 seconds into a CSV: ts,workingSetBytes,privateBytes,cpuSeconds,handles.
# -Path picks one binary when several processes share -Name (for example an installed agent beside a test build).
param(
    [string]$Name = 'breeze-agent',
    [string]$Path,
    [Parameter(Mandatory)][int]$Seconds,
    [Parameter(Mandatory)][string]$Out
)
$ErrorActionPreference = 'Stop'
'ts,workingSetBytes,privateBytes,cpuSeconds,handles' | Set-Content -Encoding ascii $Out
$end = (Get-Date).AddSeconds($Seconds)
while ((Get-Date) -lt $end) {
    $p = Get-Process -Name $Name -ErrorAction SilentlyContinue | Where-Object { -not $Path -or $_.Path -eq $Path } | Select-Object -First 1
    if (-not $p) { throw "process $Name $Path not running" }
    [string]::Format([cultureinfo]::InvariantCulture, '{0:o},{1},{2},{3:F3},{4}',
        (Get-Date).ToUniversalTime(), $p.WorkingSet64, $p.PrivateMemorySize64, $p.TotalProcessorTime.TotalSeconds, $p.HandleCount) |
        Add-Content -Encoding ascii $Out
    Start-Sleep -Seconds 10
}
