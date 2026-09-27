/**
 * Windows event-log channels that routinely carry credential-adjacent or
 * high-signal security content: Security (4625 failed-logon Account Name,
 * 4688 process command lines), PowerShell script-block logging (4104, which
 * can include scripts Breeze itself ran), and Sysmon. `devices:read` is
 * enough to browse ordinary application/system logs, but reading these
 * channels' events is equivalent in sensitivity to the file/registry content
 * reads that already require `devices:execute` — see
 * `requireDevicesExecute` in `./helpers`.
 *
 * Matching is case-insensitive and exact on the channel name the caller
 * requests (the agent's `Get-WinEvent -LogName` argument), not a substring
 * or prefix match, so an unrelated channel with a similar-looking name is
 * not swept in by accident.
 */
const SENSITIVE_EVENT_LOG_CHANNELS = new Set(
  [
    'Security',
    'Microsoft-Windows-PowerShell/Operational',
    'Microsoft-Windows-PowerShell/Admin',
    'Windows PowerShell',
    'Microsoft-Windows-Sysmon/Operational',
  ].map((name) => name.toLowerCase())
);

export function isSensitiveEventLogChannel(name: string): boolean {
  return SENSITIVE_EVENT_LOG_CHANNELS.has(name.trim().toLowerCase());
}
