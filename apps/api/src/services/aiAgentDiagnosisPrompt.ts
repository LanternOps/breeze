/**
 * Diagnosis rules and Breeze agent ground truth for the chat system prompt (#7582).
 *
 * The chat once blamed the Breeze agent for WmiPrvSE load with a retry loop
 * that does not exist, then blamed another vendor without resolving the PID.
 * This block gives the model (1) attribution rules and (2) a short list of
 * what the agent really runs on Windows, so it stops inventing agent internals.
 *
 * Each fact carries `anchors`: Go declarations under `agent/` that make the
 * fact true, identifier AND value. aiAgentDiagnosisPrompt.test.ts reads the
 * agent source and fails if any anchor disappears. If you change a cadence,
 * rename a collector, or add a periodic PowerShell/WMI caller on Windows,
 * update the fact text and its anchors in the same PR.
 *
 * Text rule: no lowercase snake_case tokens. Prompt contract tests read those
 * as tool names.
 */

export interface BreezeAgentFactAnchor {
  /** Path relative to the repo's `agent/` directory. */
  file: string;
  /** Exact substrings that must be present in the file. */
  contains: string[];
  /** Exact substrings that must NOT be present (pins a "does not" claim). */
  absent?: string[];
}

export interface BreezeAgentFact {
  /** One prompt bullet, rendered verbatim. */
  text: string;
  anchors: BreezeAgentFactAnchor[];
}

export const BREEZE_AGENT_WINDOWS_FACTS: readonly BreezeAgentFact[] = [
  {
    text: 'Identity: service BreezeAgent, process breeze-agent.exe, LocalSystem (installer sets no account). Collectors start powershell.exe directly: parent breeze-agent.exe, user SYSTEM. A WMI client running as NETWORK SERVICE, or a PowerShell with another parent, is not one of them.',
    anchors: [
      { file: 'installer/breeze.wxs', contains: ['Name="breeze-agent.exe"', 'Name="BreezeAgent"'] },
      { file: 'internal/agentapp/service_cmd_windows.go', contains: ['windowsServiceName = "BreezeAgent"'] },
      { file: 'internal/collectors/command_limits.go', contains: ['cmd := exec.CommandContext(ctx, name, args...)'] },
    ],
  },
  {
    text: 'Every heartbeat (default 60 s): one powershell Get-NetIPInterface per non-VPN adapter IP for the DHCP check (2 s timeout, not cached).',
    anchors: [
      { file: 'internal/config/config.go', contains: ['DefaultHeartbeatIntervalSeconds = 60'] },
      { file: 'internal/heartbeat/ip_tracking.go', contains: ['commandOutput(2*time.Second, "powershell"', 'Get-NetIPInterface -AddressFamily IPv4'] },
    ],
  },
  {
    text: 'Link speed: powershell Get-NetAdapter per interface when its 5 min cache entry expires.',
    anchors: [
      { file: 'internal/collectors/metrics.go', contains: ['speedCacheTTL = 5 * time.Minute'] },
      { file: 'internal/collectors/bandwidth_windows.go', contains: ['Get-NetAdapter'] },
    ],
  },
  {
    text: 'Every 5 min: security status as serial PowerShell calls (SecurityCenter2 AntiVirusProduct, Get-MpComputerStatus, Get-NetFirewallProfile, Get-BitLockerVolume, Get-LocalGroupMember, Win32_AccountPolicy).',
    anchors: [
      { file: 'internal/heartbeat/heartbeat.go', contains: ['shouldSendSecurity := now.Sub(h.lastSecurityUpdate) > 5*time.Minute'] },
      { file: 'internal/security/windows_security_center_windows.go', contains: ['root/SecurityCenter2 -ClassName AntiVirusProduct'] },
      { file: 'internal/security/defender_windows.go', contains: ['Get-MpComputerStatus'] },
      { file: 'internal/security/status.go', contains: ['Get-NetFirewallProfile', 'Get-BitLockerVolume', 'Get-LocalGroupMember', 'Win32_AccountPolicy'] },
    ],
  },
  {
    text: 'Every 15 min and at startup: inventory via PowerShell: Get-ScheduledTask, Win32_UserAccount, Win32_Service, and the hardware batch (Get-WmiSafe on Win32_BIOS, Win32_BaseBoard, Win32_ComputerSystem, Win32_VideoController; ErrorActionPreference SilentlyContinue; no storage-pool query). Hardware upload: startup and every 24 h.',
    anchors: [
      { file: 'internal/heartbeat/heartbeat.go', contains: ['now.Sub(h.lastInventoryUpdate) > 15*time.Minute', 'dueForRun(now, h.lastHardwareUpdate, 24*time.Hour)'] },
      { file: 'internal/collectors/change_tracker.go', contains: ['hwCollector.CollectHardware()'] },
      { file: 'internal/collectors/change_tracker_windows.go', contains: ['Get-ScheduledTask', 'Win32_UserAccount'] },
      { file: 'internal/collectors/services_windows.go', contains: ['Win32_Service'] },
      {
        file: 'internal/collectors/hardware_windows.go',
        contains: ["$ErrorActionPreference = 'SilentlyContinue'", 'function Get-WmiSafe($ClassName)', "Get-WmiSafe 'Win32_BIOS'", "Get-WmiSafe 'Win32_BaseBoard'", "Get-WmiSafe 'Win32_ComputerSystem'", "Get-WmiSafe 'Win32_VideoController'"],
        absent: ['StoragePool'],
      },
    ],
  },
  {
    text: 'Every 15 min (server can set 1 to 60): event logs, up to four Get-WinEvent queries. Every 15 min: management posture via dsregcmd /status.',
    anchors: [
      { file: 'internal/collectors/eventlogs.go', contains: ['intervalMinutes: 15', 'intervalMinutes >= 1 && intervalMinutes <= 60'] },
      { file: 'internal/collectors/eventlogs_windows.go', contains: ['Get-WinEvent'] },
      { file: 'internal/heartbeat/heartbeat.go', contains: ['shouldSendPosture := now.Sub(h.lastPostureUpdate) > 15*time.Minute'] },
      { file: 'internal/mgmtdetect/deep_identity_windows.go', contains: ['"dsregcmd", "/status"'] },
    ],
  },
  {
    text: 'About every 30 min: time sync check (w32tm /query /status and Get-WinEvent).',
    anchors: [
      { file: 'internal/heartbeat/time_sync.go', contains: ['const interval = 30 * time.Minute'] },
      { file: 'internal/collectors/timesync/system_windows.go', contains: ['"w32tm.exe", "/query", "/status", "/verbose"'] },
    ],
  },
  {
    text: 'Hardware health: detection cached 1 h; RAID tier every 10 min, disk tier hourly (Get-PhysicalDisk, Get-StorageReliabilityCounter), both with up to 10% jitter. No Storage Spaces pools (ObjectNotFound) means zero pools, not a failure. A source failing 3 times in a row is skipped for 6 h.',
    anchors: [
      { file: 'internal/collectors/hwhealth/detect.go', contains: ['now.Sub(d.checked) >= time.Hour'] },
      { file: 'internal/heartbeat/heartbeat.go', contains: ['hwhealth.Config{Enabled: true, PollInterval: 10 * time.Minute, DiskHealthInterval: time.Hour}'] },
      { file: 'internal/heartbeat/hardware_health.go', contains: ['offset := int64(hash.Sum64()%20001) - 10000'] },
      { file: 'internal/collectors/hwhealth/winpd_windows.go', contains: ['Get-PhysicalDisk', 'Get-StorageReliabilityCounter'] },
      { file: 'internal/collectors/hwhealth/storagespaces_windows.go', contains: ["-ne 'ObjectNotFound'"] },
      { file: 'internal/collectors/hwhealth/breaker.go', contains: ['if b.failures >= 3 {', 'b.retryAt = now.Add(6 * time.Hour)'] },
    ],
  },
  {
    text: 'Patch scan: at startup and every 24 h by default, through the Windows Update COM API, not PowerShell. A failed patch upload retries at most 4 times, 5 min doubling to a 2 h cap.',
    anchors: [
      { file: 'internal/config/config.go', contains: ['DefaultPatchScanIntervalHours = 24'] },
      { file: 'internal/heartbeat/heartbeat.go', contains: ['maxPatchSendRetries  = 4', 'patchRetryBaseDelay  = 5 * time.Minute', 'patchRetryMaxDelay   = 2 * time.Hour'] },
    ],
  },
  {
    text: 'Boot performance: once per boot, between 2 and 10 min of uptime.',
    anchors: [
      { file: 'internal/collectors/boot_performance.go', contains: ['if uptimeSeconds > 600 {', 'if uptimeSeconds < 120 {'] },
    ],
  },
  {
    text: 'Collector commands have a timeout and no retry loop; nothing above retries immediately on failure.',
    anchors: [
      { file: 'internal/collectors/command_limits.go', contains: ['collectorLongCommandTimeout  = 30 * time.Second'], absent: ['retry', 'Retry'] },
    ],
  },
];

export const AI_SYSTEM_PROMPT_DIAGNOSIS = `## Diagnosing load: attribution before blame
- Before naming a process, vendor or the Breeze agent as a root cause, resolve the evidence to its source: PID to image, service and account (tasklist /svc /fi "PID eq <pid>", Win32_Process ParentProcessId and CommandLine); WMI load to Microsoft-Windows-WMI-Activity/Operational events 5857/5858 ClientProcessId. If you did not resolve it, call the cause unattributed.
- Timing overlap, a shared SYSTEM account or similar script text is correlation, not attribution. Other RMM, EDR and OEM agents also run PowerShell and WMI as SYSTEM.
- Label each claim in a diagnosis verified (seen in a tool result) or inferred.
- Describe the Breeze agent's own behavior only from the list below. Never state a Breeze agent behavior (retry loop, cadence, query) that is not listed; say it is not documented. Send the user to Breeze support only when attribution to the Breeze agent is verified.

### What the Breeze agent runs on Windows
${BREEZE_AGENT_WINDOWS_FACTS.map((f) => `- ${f.text}`).join('\n')}`;
