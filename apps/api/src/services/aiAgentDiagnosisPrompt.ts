/**
 * Diagnosis rules and Breeze agent ground truth for the chat system prompt (#7582).
 *
 * The chat once blamed the Breeze agent for WmiPrvSE load with a retry loop
 * that does not exist, then blamed another vendor without resolving the PID.
 * This block gives the model (1) attribution rules and (2) a short list of
 * what the agent really runs on Windows, so it stops inventing agent internals.
 *
 * Each fact carries `anchors`: exact substrings of agent source (Go
 * declarations, and the PowerShell text the agent runs) that the fact relies
 * on. aiAgentDiagnosisPrompt.test.ts reads `agent/` and fails if an anchor
 * disappears or changes, or if an `absent` anchor shows up. That pins only the
 * anchored identifiers and values: it cannot notice a NEW periodic
 * PowerShell/WMI caller. If you add one, change a cadence, or rename a
 * collector on Windows, update the fact text and its anchors in the same PR.
 *
 * Text rule: no lowercase snake_case tokens. Prompt contract tests read those
 * as tool names.
 */

export interface BreezeAgentFactAnchor {
  /** Path relative to the repo's `agent/` directory. */
  file: string;
  /** Exact substrings that must be present in the file. */
  contains: string[];
  /** Exact substrings that must NOT be present (pins a "does not" claim about this file). */
  absent?: string[];
}

export interface BreezeAgentFact {
  /** One prompt bullet, rendered verbatim. */
  text: string;
  anchors: BreezeAgentFactAnchor[];
}

export const BREEZE_AGENT_WINDOWS_FACTS: readonly BreezeAgentFact[] = [
  {
    text: 'Identity: service BreezeAgent, process breeze-agent.exe, LocalSystem (installer sets no account). It queries WMI in-process (CPU info) and spawns powershell, wmic, w32tm, dsregcmd and winget as children: parent breeze-agent.exe, user SYSTEM. A WMI client running as NETWORK SERVICE, or a PowerShell with another parent, is not one of them.',
    anchors: [
      { file: 'installer/breeze.wxs', contains: ['Name="breeze-agent.exe"', 'Name="BreezeAgent"'] },
      { file: 'internal/agentapp/service_cmd_windows.go', contains: ['windowsServiceName = "BreezeAgent"'] },
      { file: 'internal/collectors/command_limits.go', contains: ['cmd := exec.CommandContext(ctx, name, args...)'] },
      { file: 'internal/collectors/hardware.go', contains: ['cpuInfo, err := cpu.Info()'] },
      { file: 'internal/collectors/classify_windows.go', contains: ['exec.Command("wmic", "systemenclosure"'] },
    ],
  },
  {
    text: 'Every heartbeat (default 60 s): one powershell Get-NetIPInterface per adapter IP that is not VPN or link-local (DHCP check, 2 s timeout, not cached).',
    anchors: [
      { file: 'internal/config/config.go', contains: ['DefaultHeartbeatIntervalSeconds = 60'] },
      { file: 'internal/heartbeat/ip_tracking.go', contains: ['commandOutput(2*time.Second, "powershell"', 'Get-NetIPInterface -AddressFamily IPv4', 'AssignmentType: determineAssignmentType('] },
    ],
  },
  {
    text: 'Link speed: powershell Get-NetAdapter per interface when its 5 min cache expires; on error a second Get-NetAdapter runs at once, then the result (0 on failure) is cached 5 min.',
    anchors: [
      { file: 'internal/collectors/metrics.go', contains: ['speedCacheTTL = 5 * time.Minute', 'c.speedCache[ifaceName] = cachedSpeed{speed: speed, at: time.Now()}'] },
      { file: 'internal/collectors/bandwidth_windows.go', contains: ['Get-NetAdapter -Name', 'Get-NetAdapter -InterfaceDescription'] },
    ],
  },
  {
    text: 'Every 5 min: security status, about seven serial PowerShell calls (SecurityCenter2 AntiVirusProduct, Get-MpComputerStatus, Get-NetFirewallProfile, Get-BitLockerVolume twice, Get-LocalGroupMember, Win32_AccountPolicy), plus a concurrent Get-BitLockerVolume for recovery keys.',
    anchors: [
      { file: 'internal/heartbeat/heartbeat.go', contains: ['shouldSendSecurity := now.Sub(h.lastSecurityUpdate) > 5*time.Minute', 'go h.sendRecoveryKeys()'] },
      { file: 'internal/security/windows_security_center_windows.go', contains: ['root/SecurityCenter2 -ClassName AntiVirusProduct'] },
      { file: 'internal/security/defender_windows.go', contains: ['Get-MpComputerStatus'] },
      { file: 'internal/security/status.go', contains: ['Get-NetFirewallProfile', 'Get-BitLockerVolume -MountPoint $env:SystemDrive', 'Get-BitLockerVolume | Select-Object MountPoint', 'Get-LocalGroupMember', 'Win32_AccountPolicy'] },
      { file: 'internal/security/recoverykeys.go', contains: ['Get-BitLockerVolume'] },
    ],
  },
  {
    text: 'Every 15 min and at startup: inventory. Collectors run in parallel, so several powershell.exe can overlap (each up to 30 s): Get-ScheduledTask, Win32_UserAccount, Win32_Service, Get-Service (VPN check), the hardware batch (Get-WmiSafe on Win32_BIOS, Win32_BaseBoard, Win32_ComputerSystem, Win32_VideoController; SilentlyContinue; no storage-pool query) and wmic systemenclosure. Hardware upload: startup and every 24 h.',
    anchors: [
      { file: 'internal/heartbeat/heartbeat.go', contains: ['now.Sub(h.lastInventoryUpdate) > 15*time.Minute', 'dueForRun(now, h.lastHardwareUpdate, 24*time.Hour)', 'h.sendNetworkInventory,'] },
      { file: 'internal/collectors/change_tracker.go', contains: ['hwCollector.CollectHardware()'] },
      { file: 'internal/collectors/command_limits.go', contains: ['collectorLongCommandTimeout  = 30 * time.Second'] },
      { file: 'internal/collectors/change_tracker_windows.go', contains: ['Get-ScheduledTask', 'Win32_UserAccount'] },
      { file: 'internal/collectors/services_windows.go', contains: ['Win32_Service'] },
      { file: 'internal/collectors/vpn_windows.go', contains: ['Get-Service'] },
      {
        file: 'internal/collectors/hardware_windows.go',
        contains: ["$ErrorActionPreference = 'SilentlyContinue'", 'function Get-WmiSafe($ClassName)', "Get-WmiSafe 'Win32_BIOS'", "Get-WmiSafe 'Win32_BaseBoard'", "Get-WmiSafe 'Win32_ComputerSystem'", "Get-WmiSafe 'Win32_VideoController'"],
        absent: ['StoragePool'],
      },
    ],
  },
  {
    text: 'Every 15 min (server can set 1 to 60): event logs, up to four concurrent Get-WinEvent queries. Every 15 min: dsregcmd /status.',
    anchors: [
      { file: 'internal/collectors/eventlogs.go', contains: ['intervalMinutes: 15', 'intervalMinutes >= 1 && intervalMinutes <= 60'] },
      { file: 'internal/collectors/eventlogs_windows.go', contains: ['Get-WinEvent', 'wg.Add(len(active))'] },
      { file: 'internal/heartbeat/heartbeat.go', contains: ['shouldSendPosture := now.Sub(h.lastPostureUpdate) > 15*time.Minute'] },
      { file: 'internal/mgmtdetect/deep_identity_windows.go', contains: ['"dsregcmd", "/status"'] },
    ],
  },
  {
    text: 'About every 30 min, and right after the server changes time settings: w32tm /query /status and Get-WinEvent.',
    anchors: [
      { file: 'internal/heartbeat/time_sync.go', contains: ['const interval = 30 * time.Minute'] },
      { file: 'internal/collectors/timesync/system_windows.go', contains: ['"w32tm.exe", "/query", "/status", "/verbose"'] },
    ],
  },
  {
    text: 'Hardware health (server can change the defaults): RAID tier about 10 min, disk tier about 1 h (Get-PhysicalDisk, Get-StorageReliabilityCounter). Detection is cached 1 h; the Storage Spaces probe is itself a powershell Get-StoragePool, and no pools (ObjectNotFound) means zero pools, not a failure. A source failing 3 times in a row is skipped 6 h, and each later failure re-blocks it 6 h.',
    anchors: [
      { file: 'internal/collectors/hwhealth/detect.go', contains: ['now.Sub(d.checked) >= time.Hour'] },
      { file: 'internal/heartbeat/heartbeat.go', contains: ['hwhealth.Config{Enabled: true, PollInterval: 10 * time.Minute, DiskHealthInterval: time.Hour}'] },
      { file: 'internal/heartbeat/hardware_health.go', contains: ['offset := int64(hash.Sum64()%20001) - 10000'] },
      { file: 'internal/collectors/hwhealth/winpd_windows.go', contains: ['Get-PhysicalDisk', 'Get-StorageReliabilityCounter'] },
      { file: 'internal/collectors/hwhealth/storagespaces_windows.go', contains: ['Get-StoragePool -IsPrimordial $false', "-ne 'ObjectNotFound'"] },
      { file: 'internal/collectors/hwhealth/breaker.go', contains: ['if b.failures >= 3 {', 'b.retryAt = now.Add(6 * time.Hour)'] },
    ],
  },
  {
    text: 'Patch scan at startup and every 24 h by default: Windows Update through the in-process COM API (not PowerShell), plus winget and, if installed, choco. A failed patch report re-runs the scan up to 4 times at about 5, 10, 20 and 40 min.',
    anchors: [
      { file: 'internal/config/config.go', contains: ['DefaultPatchScanIntervalHours = 24'] },
      { file: 'internal/heartbeat/heartbeat.go', contains: ['maxPatchSendRetries  = 4', 'patchRetryBaseDelay  = 5 * time.Minute', '// Register winget provider'] },
      { file: 'internal/patching/defaults_windows.go', contains: ['exec.LookPath("choco")'] },
    ],
  },
  {
    text: 'Boot performance: once per agent start, if uptime is 2 to 10 min: four PowerShell scripts (Get-WinEvent, Get-ItemProperty, Win32_Service, Get-Process).',
    anchors: [
      { file: 'internal/collectors/boot_performance.go', contains: ['if uptimeSeconds > 600 {', 'if uptimeSeconds < 120 {'] },
      { file: 'internal/collectors/boot_performance_windows.go', contains: ['Get-WinEvent', 'Get-ItemProperty', 'Win32_Service', 'Get-Process'] },
    ],
  },
  {
    text: 'No collector loops on failure. Exceptions: uploads retry up to 3 times (1 s backoff, 30 s cap) without re-collecting, plus the link-speed and patch cases above. Otherwise a failed collection waits for its next scheduled run.',
    anchors: [
      { file: 'internal/collectors/command_limits.go', contains: ['cmd.WaitDelay = collectorWaitDelay'], absent: ['retry', 'Retry'] },
      { file: 'internal/httputil/retry.go', contains: ['MaxRetries:    3,', 'InitialDelay:  1 * time.Second,', 'MaxDelay:      30 * time.Second,'] },
    ],
  },
];

export const AI_SYSTEM_PROMPT_DIAGNOSIS = `## Diagnosing load: attribution before blame
- Before naming a process, vendor or the Breeze agent as a root cause, resolve the evidence to its source: PID to image, service and account (tasklist /svc /fi "PID eq <pid>", Win32_Process ParentProcessId and CommandLine); WMI load to Microsoft-Windows-WMI-Activity/Operational event 5858 ClientProcessId (failed queries only; healthy ones need the WMI-Activity Trace log). If you did not resolve it, call the cause unattributed.
- Timing overlap, a shared SYSTEM account or similar script text is correlation, not attribution. Other RMM, EDR and OEM agents also run PowerShell and WMI as SYSTEM.
- Label each claim in a diagnosis verified (seen in a tool result) or inferred.
- Describe the Breeze agent's own behavior only from the list below. Never state a Breeze agent behavior (retry loop, cadence, query) that is not listed; say it is not documented, which does not mean the agent never does it. Send the user to Breeze support only when attribution to the Breeze agent is verified.

### What the Breeze agent runs on Windows (main periodic callers, not exhaustive)
${BREEZE_AGENT_WINDOWS_FACTS.map((f) => `- ${f.text}`).join('\n')}`;
