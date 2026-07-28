#Requires -RunAsAdministrator
$ErrorActionPreference = "Stop"

$taskName = "AgentUserHelper"
# Single backslashes: PowerShell does NOT escape "\", so "\\Breeze\\" was the
# literal string \\Breeze\\ — it never matched the task registered at \Breeze\
# by install-windows.ps1, making uninstall cleanup a silent no-op
# (Get-ScheduledTask -ErrorAction SilentlyContinue returned nothing, so the
# if ($existing) guard skipped the unregister — no error was ever raised).
# Must match Register-ScheduledTask -TaskPath "\Breeze\".
$taskPath = "\Breeze\"

try {
    $existing = Get-ScheduledTask -TaskName $taskName -TaskPath $taskPath -ErrorAction SilentlyContinue
    if ($existing) {
        Unregister-ScheduledTask -TaskName $taskName -TaskPath $taskPath -Confirm:$false
    }
} catch {
    # Swallow-and-exit-0 is deliberate: task cleanup must never block
    # removal/rollback. But leave a discoverable trail — the doubled-backslash
    # bug above survived its entire lifetime precisely because failures here
    # produced no evidence anywhere. Best-effort only.
    try {
        Write-EventLog -LogName Application -Source BreezeAgent -EntryType Warning -EventId 9003 -Message "user-helper task unregistration failed during uninstall: $_" -ErrorAction SilentlyContinue
    } catch {
        # Ignore — diagnostic is auxiliary
    }
}
