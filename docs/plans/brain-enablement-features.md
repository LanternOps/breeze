# Brain Enablement Features — AI-Agent-Centric RMM

> Last Updated: 2026-02-08
> Philosophy: Every feature exists to give the brain more context, better reasoning, and autonomous action capability.
> Related: `brain-connector-roadmap.md`, `phase1-brain-connector-implementation.md`

---

## The Shift

Traditional RMM: Build features → show humans dashboards → humans decide.
Brain-centric RMM: Build **data pipelines** → feed structured context to AI → brain reasons and acts.

The question for every feature isn't "does the user need a UI for this?" — it's **"does the brain need this data to make better decisions?"**

---

## What the Agent Already Collects

| Data | Frequency | Depth |
|------|-----------|-------|
| CPU/RAM/disk/network metrics | 60s | Good — aggregate percentages |
| Hardware inventory | 15min | Good — CPU, RAM, disk, GPU, serial |
| Software inventory | 15min | Good — name, version, publisher |
| Patch inventory | 15min | Good — available + installed |
| Network adapters | 15min | Good — IPs, MACs, interfaces |
| Disk mounts | 15min | Basic — total/used/free per mount |
| Active connections | On-demand | Good — protocol, ports, PIDs |
| Event logs | Periodic | Good — incremental, max 100/batch |
| Security status | Periodic | Good — AV, firewall, Defender |
| Process list | On-demand | Good — CPU, RAM, user, status |

## What the Brain Still Lacks

The brain can see **what** a machine looks like right now. It can't see **why** things are the way they are, **what changed**, **what's trending**, or **what's about to go wrong**.

---

## BE-1: Deep File System Intelligence

**What exists**: Disk usage (total/used/free per mount), file list/read/write commands.
**What's missing**: The brain knows disk is 90% full but can't tell you *why*.

### New Agent Collector: `filesystem_analysis`

Runs on-demand (brain-triggered) or when disk exceeds configurable threshold (default 85%).

**Data collected:**
- Top 50 largest files (path, size, modified date, owner)
- Top 30 largest directories (path, total size, file count)
- Temp file accumulation (`/tmp`, `%TEMP%`, browser caches, package caches)
- Old downloads (files in Downloads older than 30 days)
- Unrotated log files (single log files > 100MB)
- Recycle bin / Trash size
- Duplicate file candidates (same size + name pattern)

**New AI Tool**: `analyze_disk_usage`
- Tier 1 (read-only): Scan and report
- Returns structured breakdown the brain can reason about

**New AI Tool**: `disk_cleanup`
- Tier 3 (requires approval): Clean temp files, empty trash, clear package caches
- Pre-action: Calculate space to be freed, show what will be deleted
- Post-action: Report space recovered

**Why this matters for the brain:**
> "Device DESKTOP-042 is at 94% disk. 18GB is browser cache, 12GB is old Windows Update cleanup files, 7GB is unrotated IIS logs. I can recover 37GB without touching user data. Should I proceed?"

---

## BE-2: Startup & Boot Performance

**What exists**: Nothing on boot time or startup impact.
**What's missing**: The brain can't diagnose slow machines at a root-cause level.

### New Agent Collector: `boot_performance`

Runs after each boot (detected via uptime reset) and on-demand.

**Data collected:**
- **Boot time**: BIOS/firmware → OS loader → desktop ready (total seconds)
- **Startup items inventory**: What runs at boot with classification
  - Windows: `HKLM\...\Run`, `HKCU\...\Run`, Startup folder, scheduled tasks (at logon), services (auto-start)
  - macOS: Login Items, LaunchAgents, LaunchDaemons
  - Linux: systemd units (enabled), `/etc/init.d/`, cron `@reboot`
- **Startup impact**: Per-item CPU time and disk I/O during first 60s after login
- **Boot time history**: Trend over last 30 boots

**New DB table**: `deviceBootMetrics`
```
deviceId, bootTimestamp, biosSeconds, osLoaderSeconds, desktopReadySeconds,
totalBootSeconds, startupItemCount, startupItems (jsonb)
```

**New AI Tool**: `analyze_boot_performance`
- Tier 1: Read boot history, identify slowest startup items
- Returns: boot time trend, top 10 startup items by impact, recommendations

**New AI Tool**: `manage_startup_items`
- Tier 3: Disable/enable startup items
- Pre-action: Show what the item does, risk assessment
- Post-action: Verify change, suggest reboot to measure impact

**Why this matters for the brain:**
> "This machine takes 4m12s to boot (was 1m30s 2 months ago). Three new startup items were added: Dropbox updater (+45s), HP printer service (+30s), and a malware-like 'svchost-helper.exe' (+90s). The last one is suspicious — want me to disable it and scan?"

---

## BE-3: System Reliability Scoring

**What exists**: Event logs with levels (info/warning/error/critical). Basic uptime via `lastSeenAt`.
**What's missing**: No composite reliability view. The brain can't rank "which devices need attention most."

### New Agent Collector: `reliability_metrics`

Runs daily + on crash/BSOD detection.

**Data collected:**
- **Uptime tracking**: Current uptime, uptime percentage (7d/30d/90d), unexpected restarts
- **Crash history**: BSODs (Windows minidump analysis), kernel panics (macOS/Linux dmesg), application crashes (WER / CrashReporter / coredump)
- **Application hangs**: Not-responding events, forced kills
- **Service failures**: Services that crashed and auto-restarted, failure count
- **Hardware errors**: MCE (machine check exceptions), disk errors, memory errors from event logs

**Computed fields:**
- **Reliability score**: 0-100, weighted composite:
  - Uptime percentage (30%)
  - Crash frequency (25%)
  - App hang frequency (15%)
  - Service failure rate (15%)
  - Hardware error rate (15%)
- **MTBF**: Mean time between failures (crashes + unexpected reboots)
- **Trend direction**: Improving / stable / degrading

**New DB table**: `deviceReliability`
```
deviceId, date, reliabilityScore, uptimePercent, crashCount, hangCount,
serviceFailureCount, hardwareErrorCount, mtbfHours, trendDirection,
topIssues (jsonb), details (jsonb)
```

**New AI Tool**: `get_fleet_health`
- Tier 1: Query reliability scores across fleet, rank by severity
- Supports: grouping by site/org, filtering by score range, trending

**Why this matters for the brain:**
> "3 devices have reliability scores below 30. DESKTOP-019 has crashed 7 times in 14 days — all BSOD DRIVER_IRQL_NOT_LESS_OR_EQUAL pointing to `realtek.sys`. Recommend driver update. SERVER-005 has had 12 service failures on `sqlservr.exe` — likely memory pressure (32GB, averaging 95% usage). Recommend RAM upgrade or workload redistribution."

---

## BE-4: Network Diagnostics Toolkit

**What exists**: Network adapters, active connections, SNMP polling, ICMP/TCP/HTTP/DNS monitors.
**What's missing**: No path diagnostics, no WiFi quality, no speed testing, no "why is the network slow" analysis.

### New Agent Commands

**`network_diagnostics`** — On-demand comprehensive network health check:
- **Traceroute** to configurable targets (default: gateway, DNS, internet endpoint)
- **DNS diagnostics**: Resolution time for key domains, comparison across DNS servers, failed lookup log
- **Latency baseline**: RTT to gateway, to DNS, to internet (store history for trending)
- **MTU discovery**: Path MTU to key endpoints
- **WiFi diagnostics** (when applicable): Signal strength (dBm), noise floor, channel, channel width, connected BSSID, roaming events, disconnection count
- **Speed test** (lightweight): Download/upload throughput to configurable endpoint (not iperf-level, more like curl-based)
- **Network change detection**: Compare current network config to last known — IP changed? Gateway changed? DNS changed? New adapter?

**New DB table**: `deviceNetworkDiagnostics`
```
deviceId, timestamp, gatewayLatencyMs, dnsLatencyMs, internetLatencyMs,
wifiSignalDbm, wifiChannel, wifiSsid, downloadMbps, uploadMbps,
tracerouteHops (jsonb), dnsResults (jsonb), changes (jsonb)
```

**New AI Tool**: `run_network_diagnostics`
- Tier 1: Run diagnostics, return structured results
- Tier 2: Run speed test (generates network traffic)

**Why this matters for the brain:**
> "User reports slow internet on LAPTOP-077. WiFi signal is -78dBm (poor), connected to 2.4GHz channel 6 (3 competing APs). DNS resolution is 340ms (should be <50ms, using ISP DNS). Recommendations: (1) Move closer to AP or add AP near desk, (2) Switch to 5GHz band, (3) Switch DNS to 1.1.1.1. Want me to change the DNS configuration?"

---

## BE-5: Auto-Discovery → Auto-Monitoring Pipeline

**What exists**: Network discovery (ARP/ping/port/SNMP) and network monitors (ICMP/TCP/HTTP/DNS) as separate, manual features.
**What's missing**: No connection between "I found something" and "I should watch it." The brain has to be told to set up monitoring.

### New Brain Capability: Intelligent Monitor Provisioning

When the brain receives discovery results, it should automatically:

1. **Classify discovered assets** by role:
   - Web server (ports 80/443 open) → HTTP monitor
   - Database (port 3306/5432/1433 open) → TCP port monitor
   - DNS server (port 53 open) → DNS check monitor
   - Printer (port 9100/631 open) → ICMP ping monitor
   - Router/switch (SNMP responds) → SNMP polling + ICMP monitor
   - Generic host → ICMP ping monitor

2. **Set baselines automatically**:
   - Observe response times for 48 hours
   - Set warning threshold at p95 + 20%
   - Set critical threshold at p95 + 50%
   - Adjust after 7 days with more data

3. **Create smart alert rules**:
   - Don't alert on first failure (could be transient)
   - Alert after N consecutive failures (configurable, default 3)
   - Auto-resolve when device recovers
   - Correlate: if gateway is down, suppress downstream alerts

**New AI Tool**: `auto_provision_monitoring`
- Tier 2: Present proposed monitors for approval before creating
- Shows: what was discovered, what monitors would be created, what thresholds
- Brain explains reasoning for each monitor

**New AI Tool**: `get_monitoring_gaps`
- Tier 1: Analyze what's discovered vs what's monitored, identify gaps
- Returns: unmonitored critical assets, monitors without alert rules, stale monitors

**Why this matters for the brain:**
> "I completed a network scan of 10.0.1.0/24. Found 47 devices. 12 are already monitored. Here's what I recommend adding:
> - 3 web servers (HTTP checks, 30s interval)
> - 1 SQL Server (TCP 1433, 60s interval)
> - 2 printers (ICMP ping, 120s interval)
> - 1 unmanaged switch with SNMP (interface monitoring)
> I'll set alert thresholds based on 48-hour baselines. Approve?"

---

## BE-6: Change Tracking & Configuration Drift

**What exists**: Software inventory snapshots (current state only), event logs.
**What's missing**: No history. The brain can't answer "what changed before this problem started?"

### New Agent Collector: `change_tracker`

Runs every 15 minutes (diffing against last snapshot).

**Changes tracked:**
- **Software changes**: Installed, uninstalled, updated (with before/after version)
- **Service changes**: New service, removed service, startup type changed, account changed
- **Startup item changes**: Added, removed, modified
- **Network config changes**: IP changed, DNS changed, gateway changed, adapter added/removed
- **Scheduled task changes**: Created, deleted, modified, enabled/disabled
- **Windows registry key changes**: Monitor critical keys (Run, Services, Policies)
- **User account changes**: New local account, account locked, password changed (date only)

**New DB table**: `deviceChangeLog`
```
deviceId, timestamp, changeType (software|service|startup|network|task|registry|account),
changeAction (added|removed|modified), subject, beforeValue (jsonb),
afterValue (jsonb), details (jsonb)
```

**New AI Tool**: `query_change_log`
- Tier 1: Search changes by device, time range, type
- Correlate: "Show me everything that changed on DESKTOP-019 in the 24 hours before it started crashing"

**Why this matters for the brain:**
> "DESKTOP-019 started BSODing 3 days ago. Change log shows: (1) `realtek_wifi.sys` driver updated from 2.1.3 to 2.2.0 via Windows Update on Tuesday, (2) New service 'RealtekWiFiService' added same day. The crashes started Wednesday. This is almost certainly the driver update. Want me to roll back the driver?"

---

## BE-7: Hardware Health Prediction

**What exists**: Basic hardware inventory (model, serial, cores, RAM).
**What's missing**: No health data. The brain can't predict failures.

### New Agent Collector: `hardware_health`

Runs every hour + on-demand.

**Data collected:**
- **SMART disk health** (SSD/HDD):
  - Temperature, power-on hours, reallocated sectors, wear leveling count
  - SSD life remaining percentage
  - Pending sector count, uncorrectable error count
  - Read/write error rates
- **Battery health** (laptops):
  - Design capacity vs current full-charge capacity
  - Cycle count, charge rate, health percentage
  - Estimated remaining useful life
- **Thermal data**:
  - CPU temperature, GPU temperature
  - Fan speed (RPM)
  - Thermal throttling events
- **Memory diagnostics**:
  - ECC error counts (servers)
  - Last memory test result and date

**New DB table**: `deviceHardwareHealth`
```
deviceId, timestamp, diskSmartData (jsonb), batteryHealth (jsonb),
thermalData (jsonb), memoryHealth (jsonb), overallHealthScore (int)
```

**Computed**: Hardware health score (0-100) based on:
- Disk health (SMART predictions)
- Battery degradation rate
- Thermal headroom
- Memory error rate

**New AI Tool**: `get_hardware_health`
- Tier 1: Query hardware health across fleet, predict failures
- Returns: devices at risk, estimated time to failure, recommended actions

**Why this matters for the brain:**
> "3 devices need hardware attention:
> - LAPTOP-012: Battery at 62% health (412 cycles), will likely need replacement within 3 months
> - SERVER-003: Disk sda SMART warning — 14 reallocated sectors, increasing at 2/week. Recommend scheduling replacement within 30 days
> - DESKTOP-044: CPU hitting 95°C under load (throttling detected). Fan running at max RPM. Likely needs thermal paste or fan cleaning"

---

## BE-8: User Session & Experience Intelligence

**What exists**: `lastUser` field on device, basic user/session from OS.
**What's missing**: The brain doesn't know who's using what, or whether it's safe to act.

### New Agent Collector: `session_tracker`

Runs on session events (login/logout/lock/unlock) + periodic (5 min).

**Data collected:**
- **Active sessions**: Username, session type (console/RDP/SSH), login time, idle duration
- **Session history**: Login/logout events with duration
- **User activity state**: Active / idle / locked / away
- **Login performance**: Time from credentials entered to desktop ready

**New DB table**: `deviceSessions`
```
deviceId, username, sessionType, loginAt, logoutAt, duration,
idleMinutes, loginPerformanceSeconds, isActive
```

**New AI Tool**: `get_active_users`
- Tier 1: Query who's on what, current activity state
- Used by brain for safety: "Is anyone using this machine before I reboot?"

**New AI Tool**: `get_user_experience_metrics`
- Tier 1: Login time trends, idle patterns, session duration

**Why this matters for the brain:**
> Before rebooting for patches: "DESKTOP-019 has an active user session (jsmith, logged in 2h ago, currently active — not idle). I'll wait until after hours or ask for permission."
>
> For proactive support: "jsmith's login time has degraded from 30s to 2m15s over the past month. Startup items analysis shows 4 new items. Want me to optimize?"

---

## BE-9: Security Posture Scoring

**What exists**: AV status, firewall, Defender, threat scans, patch inventory.
**What's missing**: No composite security view. The brain can't prioritize security work across a fleet.

### Computed from Existing Data (no new collectors needed!)

**Security score** (0-100) computed from:

| Factor | Weight | Source |
|--------|--------|--------|
| Patch compliance | 25% | Patch inventory — % critical patches applied |
| Encryption status | 15% | BitLocker/FileVault/LUKS status per volume |
| AV health | 15% | AV running, definitions current (<24h) |
| Firewall status | 10% | Firewall enabled on all profiles |
| Open ports | 10% | Unexpected listening ports vs baseline |
| Password policy | 10% | Local accounts, password age, complexity |
| OS currency | 10% | Running supported OS version |
| Admin exposure | 5% | Number of local admin accounts |

**New AI Tool**: `get_security_posture`
- Tier 1: Fleet-wide security scores with per-device breakdown
- Returns: overall score, per-factor breakdown, worst devices, improvement recommendations

**New agent data needed** (minor additions to existing collectors):
- Encryption status per volume (BitLocker `manage-bde`, FileVault `fdesetup`, LUKS `cryptsetup`)
- Local admin account enumeration
- Listening port baseline comparison

**Why this matters for the brain:**
> "Fleet security score: 71/100. Top issues:
> 1. 12 devices missing critical patches (avg 15 days behind) — score impact: -8
> 2. 5 laptops with unencrypted drives — score impact: -7
> 3. 3 devices with AV definitions >72h old — score impact: -5
> I can auto-deploy patches to the 12 devices during tonight's maintenance window. The 5 unencrypted laptops need BitLocker enabled — want me to schedule that?"

---

## BE-10: Fleet Anomaly Detection

**What exists**: Per-device metrics, no cross-device comparison.
**What's missing**: The brain can see each tree but can't see the forest.

### New API Service: `anomaly_detector`

Runs as a scheduled job (every 15 minutes).

**Detection methods:**
- **Peer comparison**: Group devices by role/site/OS. Flag devices that deviate >2 standard deviations from peer average
- **Self-baseline deviation**: Compare current metrics to device's own 7-day rolling average. Flag deviations >50%
- **Fleet-wide correlation**: If >30% of devices at a site show same metric spike, flag as site-level issue (not individual device)
- **Change correlation**: When anomaly detected, auto-query change log for recent changes on affected device(s)

**New DB table**: `anomalyEvents`
```
id, orgId, deviceId, detectedAt, anomalyType (peer_deviation|self_deviation|fleet_pattern),
metric, currentValue, expectedValue, deviationPercent, severity,
correlatedChanges (jsonb), resolved, resolvedAt
```

**New AI Tool**: `get_anomalies`
- Tier 1: Query current anomalies with correlation data
- Brain uses this proactively: "Here's what looks unusual across your fleet today"

**Why this matters for the brain:**
> "Anomaly detected: 8 devices at the Downtown Office site are showing 3x normal DNS latency since 2pm. This started after the gateway (10.0.1.1) was rebooted at 1:55pm. Likely a DNS configuration issue on the gateway. Recommend checking gateway DNS forwarding settings."

---

## BE-11: Conversation Context & Device Pinning

**What exists**: AI chat with tool calls, per-session context.
**What's missing**: The brain starts every conversation cold. No memory of past interactions per device.

### New Capability: Device Context Memory

**Per-device context file** (stored in DB, not just chat):
- Last 5 issues discussed about this device
- Known quirks ("this device runs a legacy app that needs Java 8")
- Pending follow-ups ("check if disk cleanup helped after 48 hours")
- User preferences for this device ("owner prefers after-hours maintenance")

**New DB table**: `brainDeviceContext`
```
deviceId, orgId, contextType (issue|quirk|followup|preference),
summary, details (jsonb), createdAt, expiresAt, resolvedAt
```

**New AI Tool**: `get_device_context` / `set_device_context`
- Tier 1: Read context
- Tier 2: Write context
- Automatically loaded when brain is asked about a specific device

**Why this matters for the brain:**
> User: "Hey, how's DESKTOP-019 doing?"
> Brain: "Last time we talked about DESKTOP-019 (3 days ago), I rolled back the Realtek WiFi driver from 2.2.0 to 2.1.3 to fix BSODs. Since then: 0 crashes, reliability score improved from 28 to 85. The fix worked. Also — disk is now at 88%, I had recommended a cleanup last week. Want me to run that?"

---

## BE-12: Self-Healing Playbooks

**What exists**: Script execution, service management, individual commands.
**What's missing**: No multi-step remediation with verification. The brain acts, but can't confirm it worked.

### New Brain Capability: Action → Verify → Report

Not a new agent feature — this is a **brain pattern** built on existing tools:

**Playbook structure:**
```
1. Diagnose (gather data)
2. Act (execute fix)
3. Wait (configurable delay)
4. Verify (check if fix worked)
5. Report (structured outcome)
6. Rollback (if verification failed)
```

**Pre-built playbooks the brain learns:**

| Playbook | Diagnose | Act | Verify |
|----------|----------|-----|--------|
| Disk cleanup | `analyze_disk_usage` | `disk_cleanup` | Re-check disk percent |
| Service restart | Check service status + error logs | `restart_service` | Check status + test connectivity |
| DNS fix | `run_network_diagnostics` | Change DNS config via script | Re-run DNS diagnostics |
| Startup optimization | `analyze_boot_performance` | `manage_startup_items` | Wait for reboot, check new boot time |
| Patch deployment | Check compliance | `install_patches` | Verify patch installed, check stability |
| Memory pressure | Check top processes | Restart memory-hungry service | Monitor RAM for 5 min |

**These aren't hard-coded** — they're patterns the brain follows. The tool catalog gives it the building blocks. The playbooks give it the *strategy*.

**Why this matters for the brain:**
> "High memory on SERVER-005 (95%). Top consumer: `w3wp.exe` (IIS) at 18GB. Running playbook:
> 1. Recycling IIS app pool 'DefaultAppPool'...
> 2. Waiting 30 seconds for restart...
> 3. Verifying: IIS responding on port 443 ✓, RAM now at 62% ✓
> 4. Setting follow-up: check again in 2 hours to confirm stability."

---

## BE-13: End-User Diagnostic Chat

**What exists**: AI chat for technicians. Agent can show desktop notifications and tray UI.
**What's missing**: End users can't talk to the brain. Every ticket starts with a human playing 20 questions.

### New Capability: User-Facing Brain Interface

A lightweight chat widget accessible from the system tray agent UI. The end user describes their problem, the brain diagnoses autonomously.

**User-side features:**
- **Chat interface** via system tray → "Get Help" → opens local browser chat or native window
- **Screenshot capture**: User clicks "attach screenshot" → agent captures screen, annotates, sends to brain
- **System snapshot**: On chat start, agent auto-collects and attaches:
  - Current CPU/RAM/disk status
  - Top 10 processes by resource usage
  - Recent event log errors (last 1 hour)
  - Network connectivity status
  - Last 5 changes from change tracker (BE-6)
  - Uptime, last reboot, pending patches

**Brain-side behavior:**
- Receives user message + system snapshot + optional screenshot
- Diagnoses with full device context (not just what the user says)
- Can ask follow-up questions to user
- Can run diagnostics autonomously (with user's implicit consent — they initiated the chat)
- Creates a ticket/case if it can't resolve, with full diagnostic context attached

**Auth model:**
- User authenticates via device enrollment (agent is already authenticated)
- Brain tools scoped to Tier 1 + Tier 2 only (no destructive actions without tech approval)
- Escalation path: brain can't fix it → creates ticket for technician with full context

**New DB tables:**
```
endUserSessions: id, deviceId, orgId, userId, startedAt, endedAt, status,
  summary, resolution, escalatedToTicketId
endUserMessages: id, sessionId, role (user|brain), content, attachments (jsonb),
  timestamp
```

**New AI Tool**: `get_user_diagnostic_session`
- Tier 1: Technician can view user chat history and brain's diagnostic findings

**Why this matters for the brain:**
> User (from tray): "My computer is really slow today"
> Brain (with system snapshot already loaded): "I can see your CPU is at 92% — OneDrive is syncing 4,200 files (using 67% CPU). Your disk is also at 91%, which is slowing things down. I can:
> 1. Pause OneDrive sync for 2 hours so you can work
> 2. Clean up 8GB of temp files to free disk space
> Which would you like, or both?"

---

## BE-14: Agent Diagnostic Log Shipping

**What exists**: Agent logs locally to disk. No central visibility.
**What's missing**: When an agent misbehaves, the only option is to remote in and read log files manually.

### New Agent Capability: Centralized Log Pipeline

**Agent-side:**
- Ship agent logs (not OS event logs — *agent operational logs*) to API
- Configurable log level per-agent (debug/info/warn/error)
- Default: ship warn+error. Debug mode enabled on-demand by brain or tech
- Buffer logs locally, batch-ship every 60s or on error
- Include: timestamp, level, component (collector/executor/heartbeat/websocket), message, structured fields

**API-side:**
- New ingest endpoint: `POST /agents/:id/logs` (batched)
- Storage: `agentLogs` table with TTL (default 7 days, configurable)
- Indexed by: deviceId, level, component, timestamp

**New DB table:**
```
agentLogs: id, deviceId, orgId, timestamp, level, component, message,
  fields (jsonb), agentVersion, createdAt
```

**New AI Tools:**
- `search_agent_logs` — Tier 1: Query agent logs across fleet, filter by level/component/time
- `set_agent_log_level` — Tier 2: Temporarily increase log level on specific agent (auto-revert after N hours)

**Why this matters for the brain:**
> "Agent on SERVER-003 hasn't sent a heartbeat in 15 minutes but the device is online (ICMP responds). Checking agent logs... Last log entry: `[ERROR] websocket: connection refused, retry 5/10, backoff 32s`. The WebSocket endpoint is unreachable from this agent. Likely a firewall rule changed. Agent REST heartbeat is also failing — API returned 502. This is an API-side issue, not agent-side."

---

## BE-15: Application Whitelisting & Control

**What exists**: Software inventory (name, version, publisher). No enforcement.
**What's missing**: The brain knows what's installed but can't enforce what *should* be installed. CIS Control 2.

### New Compliance Feature: Software Allow/Block Lists

**Policy definition:**
- **Allowlist mode**: Only approved software may run. Unapproved triggers alert + optional block.
- **Blocklist mode**: Specific software is prohibited. Presence triggers alert + optional removal.
- **Audit-only mode**: Log violations without enforcement (recommended first step).

**Policy structure:**
```
softwarePolicies: id, orgId, name, mode (allowlist|blocklist|audit),
  rules (jsonb), targetType, targetIds, isActive, createdAt
```

Rules JSONB:
```json
[
  { "match": "name", "pattern": "TeamViewer*", "action": "block", "reason": "Unauthorized remote access" },
  { "match": "publisher", "pattern": "Piriform*", "action": "allow" },
  { "match": "name", "pattern": "*.exe", "location": "/Users/*/Downloads/*", "action": "alert" }
]
```

**Agent-side:**
- Compare software inventory against policy on each inventory cycle (15min)
- Optional: Real-time process monitoring — detect new process launches, compare against policy
- Actions: alert-only, prevent-launch (Windows AppLocker / macOS app management profiles), or auto-uninstall

**New AI Tools:**
- `get_software_compliance` — Tier 1: Fleet-wide compliance status, violations by device
- `manage_software_policy` — Tier 3: Create/modify software policies
- `remediate_software_violation` — Tier 3: Uninstall unauthorized software

**CIS Control mapping**: CIS 2.5 (Allowlist authorized software), 2.6 (Allowlist authorized libraries), 2.7 (Allowlist authorized scripts)

**Why this matters for the brain:**
> "Software compliance scan complete. 4 violations detected:
> 1. DESKTOP-033: 'AnyDesk' installed (blocklisted — unauthorized remote access tool)
> 2. DESKTOP-044: 'uTorrent' installed (blocklisted — P2P software)
> 3. LAPTOP-019: 'Wireshark' installed (not on allowlist — needs approval)
> 4. SERVER-002: 'FileZilla Server' installed (blocklisted on servers)
> AnyDesk and uTorrent are high-risk. Want me to uninstall them and notify the users?"

---

## BE-16: Vulnerability Management

**What exists**: Patch inventory with severity levels. No CVE correlation.
**What's missing**: Patches tell you "update available." Vulnerabilities tell you "you're exposed to attack X." CIS Control 7.

### New Capability: CVE-Based Vulnerability Scanning

**Data pipeline:**
1. **Software inventory** (already collected) → match against vulnerability database
2. **Vulnerability database**: Ingest from NVD (National Vulnerability Database) API, refreshed daily
3. **Correlation engine**: Map `(software name, version)` → known CVEs with CVSS scores
4. **Risk scoring**: Per-device vulnerability score based on count + severity + exploitability

**Storage:**
```
vulnerabilityDatabase: cveId, description, cvssScore, cvssVector, severity,
  affectedSoftware (jsonb), publishedDate, modifiedDate, exploitAvailable,
  patchAvailable, references (jsonb)

deviceVulnerabilities: id, deviceId, orgId, cveId, softwareName, softwareVersion,
  detectedAt, status (open|patched|mitigated|accepted), mitigationNote,
  resolvedAt
```

**New AI Tools:**
- `get_vulnerability_report` — Tier 1: Fleet-wide vulnerability summary, sorted by CVSS, filterable
- `get_device_vulnerabilities` — Tier 1: Per-device CVE list with remediation options
- `remediate_vulnerability` — Tier 3: Apply patch or mitigation for specific CVE

**CIS Control mapping**: CIS 7.1 (Establish vulnerability management process), 7.2 (Establish remediation process), 7.4 (Perform automated application patch management)

**Why this matters for the brain:**
> "Critical vulnerability alert: CVE-2026-1234 (CVSS 9.8) affects Apache Log4j 2.17.0. 6 servers in your fleet are running affected versions. Exploit is publicly available. Patch exists (2.21.0). This is actively exploited in the wild.
> Recommended: Emergency patch deployment to all 6 servers. I can schedule this for the next maintenance window (tonight 2am) or deploy immediately. Given the severity, I recommend immediate deployment."

---

## BE-17: Privileged Access Management (PAM)

**What exists**: Script execution with `runAs` support. RBAC on API. No elevation request workflow.
**What's missing**: Techs can't request temporary admin access on a device. No audit trail for privilege escalation. CIS Control 5/6.

### New Capability: Just-In-Time Privilege Elevation

**Workflow:**
1. Technician (or brain) requests elevated access on a device
2. Request specifies: reason, duration (15min to 8hr), scope (local admin / specific action)
3. Approval required from: org admin, or auto-approved if within policy
4. Agent grants temporary local admin (or runs specific command as admin)
5. Access auto-revokes after duration expires
6. Full audit trail: who requested, who approved, what was done, when it expired

**Agent-side:**
- `elevation_grant`: Add user to local Administrators group (Windows) / admin group (macOS/Linux)
- `elevation_revoke`: Remove from admin group
- `elevation_execute`: Run single command with elevated privileges, return result
- Auto-revocation timer (failsafe — even if API is unreachable)

**Storage:**
```
elevationRequests: id, orgId, deviceId, requestedBy, requestedAt,
  reason, scope (admin|specific_command), command (nullable),
  duration, status (pending|approved|active|expired|denied|revoked),
  approvedBy, approvedAt, activatedAt, expiresAt, revokedAt,
  revokedReason, auditLog (jsonb)
```

**New AI Tools:**
- `request_elevation` — Tier 3: Request temporary admin access with reason
- `get_elevation_history` — Tier 1: Audit trail of all elevation requests
- `revoke_elevation` — Tier 2: Immediately revoke active elevation

**CIS Control mapping**: CIS 5.4 (Restrict administrator privileges), 6.1 (Establish access granting process), 6.2 (Establish access revoking process)

**Why this matters for the brain:**
> Tech: "I need to install a custom driver on DESKTOP-019"
> Brain: "That requires local admin access. I'll request a 30-minute elevation for you.
> Request submitted → Auto-approved (within policy: <1hr elevation for Tier 2+ techs).
> You now have local admin on DESKTOP-019 for 30 minutes. I'll revoke automatically at 3:45pm.
> Need me to run the driver installation command for you instead?"

---

## BE-18: New Device Alerting (Network Change Detection)

**What exists**: Network discovery with ARP/ping/port scanning. Discovered assets table.
**What's missing**: Discovery is point-in-time. No continuous monitoring for new devices appearing. CIS Control 1.

### New Capability: Continuous Network Awareness

**Scheduled discovery:**
- Run lightweight discovery scans on a schedule (default: every 4 hours per subnet)
- Compare results against known asset baseline
- Flag: new devices, disappeared devices, changed devices (IP changed, new ports opened)

**Alert types:**
- `network.new_device`: Unknown device appeared on network
- `network.device_disappeared`: Known device no longer responds
- `network.device_changed`: Device IP, MAC, or open ports changed
- `network.rogue_device`: Device doesn't match any known inventory (no agent, not in discovered assets)

**Storage:**
```
networkBaseline: id, orgId, siteId, subnet, lastScanAt, knownDevices (jsonb)

networkChangeEvents: id, orgId, siteId, eventType, ipAddress, macAddress,
  hostname, previousState (jsonb), currentState (jsonb), detectedAt,
  acknowledged, acknowledgedBy, acknowledgedAt
```

**New AI Tools:**
- `get_network_changes` — Tier 1: Recent network changes, new devices, disappeared devices
- `acknowledge_network_device` — Tier 2: Mark device as known/expected
- `configure_network_baseline` — Tier 2: Set up scheduled scans for subnets

**CIS Control mapping**: CIS 1.1 (Establish asset inventory), 1.2 (Address unauthorized assets), 13.3 (Deploy network intrusion detection)

**Why this matters for the brain:**
> "Network scan detected 2 new devices on the 10.0.1.0/24 subnet at Downtown Office:
> 1. 10.0.1.47 (MAC: AA:BB:CC:DD:EE:FF, Manufacturer: Raspberry Pi Foundation) — no agent, ports 22 and 80 open. **This is suspicious** — not in any inventory.
> 2. 10.0.1.112 (MAC: 00:11:22:33:44:55, Manufacturer: HP Inc.) — matches expected printer model, port 9100 open. Likely a new printer.
> Recommend investigating device 1 immediately. Want me to set up monitoring for device 2?"

---

## BE-19: IP History & Network Identity Tracking

**What exists**: Current network adapters with IPs. No history.
**What's missing**: The brain can't answer "what IP did this device have last week?" or "which device had IP 10.0.1.50 on Tuesday?" CIS Control 1.

### New Capability: IP Address Timeline

**Agent-side:**
- On every network inventory update (15min), detect IP changes
- Record: timestamp, interface, old IP, new IP, DHCP/static, lease info

**API-side:**
- Maintain IP history per device
- Reverse lookup: given an IP + time range, find which device had it
- Track: DHCP lease events, static assignments, VPN connections

**Storage:**
```
deviceIpHistory: id, deviceId, orgId, interfaceName, ipAddress, ipType,
  assignmentType (dhcp|static|vpn), firstSeen, lastSeen, isActive
```

**New AI Tools:**
- `get_ip_history` — Tier 1: IP timeline for a device, or reverse-lookup (IP → device at time T)
- Used by brain for: correlating firewall logs, investigating security events, tracking DHCP issues

**Why this matters for the brain:**
> Security team: "Our firewall logged suspicious traffic from 10.0.1.47 at 2:30am last night"
> Brain: "Looking up IP history... 10.0.1.47 was assigned to DESKTOP-033 (jsmith) from 6pm to 8am via DHCP. However, that device was offline at 2:30am (last heartbeat at 11:15pm). This IP may have been reassigned by DHCP to another device — possibly the unidentified Raspberry Pi detected in the last network scan. Recommend investigating the Raspberry Pi immediately."

---

## BE-20: Central Log Search & Aggregation

**What exists**: Event logs collected per-device (incremental, stored in `deviceEventLogs`). No cross-device search.
**What's missing**: The brain can't grep across all devices for a specific error. CIS Control 8.

### New Capability: Fleet-Wide Log Search

**Enhancement to existing event log pipeline:**
- Already collecting: Windows Event Logs, macOS system.log, Linux syslog/journald
- Need: Efficient cross-device search with full-text indexing

**API-side:**
- New search endpoint with filters: time range, level, category, source, message text, device(s), site(s)
- Full-text search on message field (PostgreSQL `tsvector` or dedicated search — start with PG, graduate to Loki/Elastic if volume demands)
- Aggregation: count by level, by source, by device, over time
- Correlation: same error message across multiple devices = fleet-wide issue

**New AI Tools:**
- `search_logs` — Tier 1: Full-text search across all device event logs
  - Params: query, devices, sites, levels, categories, timeRange, limit
  - Returns: matching entries with device context, aggregation stats
- `get_log_trends` — Tier 1: Error/warning frequency over time, top sources, spikes

**CIS Control mapping**: CIS 8.2 (Collect audit logs), 8.5 (Collect detailed audit logs), 8.9 (Centralize audit logs), 8.11 (Conduct audit log reviews)

**Why this matters for the brain:**
> "Searching fleet logs for 'Application Error' in the last 24 hours...
> Found 47 events across 12 devices. Pattern detected: 38 of them reference `outlook.exe` with exception code `0xc0000005`. This started at 2pm yesterday across all devices — correlates with Office update KB5034567 deployed at 1:45pm. This update is likely causing Outlook crashes.
> Recommend: Pause deployment of KB5034567 and roll back on affected devices."

---

## BE-21: Event Log Audit Baseline (CIS Hardening)

**What exists**: Event log collection with levels and categories. No policy enforcement on what *should* be logged.
**What's missing**: Many Windows machines ship with inadequate audit policies. The brain can't verify logging is comprehensive enough. CIS Control 8.

### New Compliance Feature: Audit Policy Baselines

**What this enforces:**
- Windows: Advanced Audit Policy configuration (what events Windows generates)
  - Account Logon events, Object Access, Policy Changes, Privilege Use, System events
  - CIS Benchmark Level 1 and Level 2 profiles
- macOS: OpenBSM audit configuration
- Linux: auditd rules

**Agent-side:**
- New collector: `audit_policy` — reads current audit configuration
  - Windows: `auditpol /get /category:*` or registry
  - macOS: `/etc/security/audit_control`
  - Linux: `auditctl -l` or `/etc/audit/audit.rules`
- Compare against baseline (CIS Benchmark settings)
- Report deviations

**Policy storage:**
```
auditBaselines: id, orgId, name, osType, profile (cis_l1|cis_l2|custom),
  settings (jsonb), isActive, createdAt

auditBaselineResults: id, deviceId, baselineId, lastChecked, compliant,
  deviations (jsonb), score
```

**New AI Tools:**
- `get_audit_compliance` — Tier 1: Fleet-wide audit policy compliance status
- `apply_audit_baseline` — Tier 3: Apply CIS audit policy to device(s)

**CIS Control mapping**: CIS 8.1 (Establish audit log management process), 8.2-8.5 (Configure audit log collection)

**Why this matters for the brain:**
> "Audit policy compliance check: 23 of 40 Windows devices are not logging Account Logon failures (CIS 8.5 violation). 15 devices have 'Object Access' auditing disabled — we won't see file access events. 8 devices have Event Log maximum size set to 1MB (will overwrite quickly).
> I can apply the CIS Level 1 audit baseline to all non-compliant devices. This won't affect performance but will significantly improve our forensic capability. Approve?"

---

## BE-22: Huntress Integration

**What exists**: Security status collection (AV/firewall), threat scanning, Defender integration.
**What's missing**: No integration with managed EDR/threat-hunting platforms. Huntress is the MSP standard.

### New Integration: Huntress API Connector

**Huntress provides:**
- Persistent foothold detection (scheduled tasks, services, WMI, autoruns)
- Managed threat hunting (human analysts reviewing suspicious activity)
- Incident reports with remediation recommendations
- Process activity monitoring
- Ransomware canary detection

**Integration points:**
- **Ingest**: Pull Huntress incidents, agents, and summary data via Huntress REST API
- **Correlate**: Match Huntress agent → Breeze device (by hostname or Huntress agent ID stored in device custom fields)
- **Enrich**: Brain sees Huntress findings alongside its own data
- **Act**: Brain can reference Huntress recommendations when deciding remediation

**Data synced from Huntress:**
```
huntressAgents: deviceId, huntressAgentId, huntressOrgId, status, lastSeen,
  version, platform

huntressIncidents: id, orgId, deviceId, huntressIncidentId, severity,
  category, title, description, recommendation, status, reportedAt,
  resolvedAt, details (jsonb)
```

**New AI Tools:**
- `get_huntress_status` — Tier 1: Fleet Huntress coverage, agent health, active incidents
- `get_huntress_incidents` — Tier 1: Query incidents with device correlation

**API integration pattern:**
- Huntress API key stored per-org in encrypted integration settings
- Sync job runs every 15 minutes (BullMQ scheduled)
- Webhook receiver for real-time incident notifications (if Huntress supports)

**Why this matters for the brain:**
> "Huntress alert on SERVER-002: Persistent foothold detected — new scheduled task 'WindowsUpdateCheck' running `powershell.exe -enc [base64]` every 4 hours. Huntress severity: Critical. Their analyst notes this matches a known CobaltStrike beacon pattern.
> Immediate actions: (1) I've isolated SERVER-002 from the network via firewall rules, (2) Captured the encoded command for analysis, (3) Created a P1 ticket. This device should not be touched until incident response is complete."

---

## BE-23: SentinelOne Integration

**What exists**: Listed as a P2 item. No implementation.
**What's missing**: Same as Huntress — deep EDR data feeding the brain.

### New Integration: SentinelOne API Connector

**SentinelOne provides:**
- Real-time endpoint detection and response
- Threat intelligence with MITRE ATT&CK mapping
- Automated threat remediation (kill, quarantine, rollback)
- Deep visibility (process trees, network connections, file activity)
- Device control (USB, Bluetooth, network)

**Integration points:**
- **Ingest**: Pull S1 threats, agents, applications, and policies via S1 REST API
- **Correlate**: Match S1 agent → Breeze device
- **Enrich**: Brain sees S1 threat data, MITRE mappings, risk scores
- **Bidirectional**: Brain can trigger S1 actions (isolate, scan, rollback) via API

**Data synced from SentinelOne:**
```
s1Agents: deviceId, s1AgentId, s1GroupId, status, infected, threatCount,
  lastScan, policyName, s1Version

s1Threats: id, orgId, deviceId, s1ThreatId, classification, severity,
  mitreTactics (jsonb), mitreDescription, threatName, filePath,
  processName, status, detectedAt, resolvedAt, details (jsonb)
```

**New AI Tools:**
- `get_s1_status` — Tier 1: Fleet S1 coverage, threat summary, agent health
- `get_s1_threats` — Tier 1: Query threats with MITRE context
- `s1_isolate_device` — Tier 3: Network-isolate device via S1
- `s1_threat_action` — Tier 3: Kill/quarantine/rollback via S1

**Why this matters for the brain:**
> "SentinelOne detected a threat on LAPTOP-055: 'Emotet.Trojan' (MITRE: T1566.001 Phishing, T1055 Process Injection). S1 has already killed the malicious process and quarantined the file.
> Cross-referencing with Breeze data: This user (mwilson) received 3 phishing emails this week (from Huntress email module). Change log shows a suspicious `invoice.pdf.exe` was downloaded 20 minutes ago.
> Recommended: (1) Full S1 scan (already triggered), (2) Force password reset for mwilson, (3) Review other devices mwilson accessed today, (4) Send security awareness reminder."

---

## BE-24: Sensitive Data Discovery

**What exists**: File system access (list/read). Encryption status planned (BE-9).
**What's missing**: The brain can't find unprotected sensitive data sitting on endpoints. CIS Control 3.

### New Agent Command: `sensitive_data_scan`

On-demand scan triggered by brain or scheduled policy. Scans user-accessible file paths.

**Detection patterns:**
- **PII**: SSN patterns (`\d{3}-\d{2}-\d{4}`), email addresses, phone numbers, names + addresses
- **PCI**: Credit card numbers (Luhn-validated), CVVs near card patterns
- **PHI**: Medical record numbers, ICD codes, prescription patterns
- **Credentials**: Private keys (`-----BEGIN.*PRIVATE KEY-----`), `.env` files, `password=`, API keys (`sk_live_`, `AKIA`, `ghp_`)
- **Financial**: Bank account/routing numbers, tax IDs

**Scan scope** (configurable per policy):
- Default: User profiles, Desktop, Documents, Downloads, shared drives
- Exclude: System directories, application data, binaries
- Max file size: 10MB (skip large binaries)
- File types: `.txt`, `.csv`, `.xlsx`, `.docx`, `.pdf`, `.json`, `.xml`, `.log`, `.env`, `.cfg`, `.ini`

**Storage:**
```
sensitiveDataFindings: id, deviceId, orgId, scanId, filePath, dataType
  (pii|pci|phi|credential|financial), pattern, matchCount, fileOwner,
  fileModified, risk (critical|high|medium), detectedAt, status
  (open|remediated|accepted|false_positive), remediatedAt
```

**New AI Tools:**
- `scan_sensitive_data` — Tier 2: Initiate scan on device(s), requires justification
- `get_sensitive_data_report` — Tier 1: Fleet-wide exposure summary
- `remediate_sensitive_data` — Tier 3: Encrypt, move to vault, or securely delete

**Privacy safeguard**: Tool returns file paths, match types, and counts — never returns the actual sensitive data values.

**CIS Control mapping**: CIS 3.1 (Establish data management process), 3.2 (Establish data inventory), 3.7 (Establish data classification scheme), 3.9 (Encrypt data on removable media), 3.11 (Encrypt sensitive data at rest)

**Why this matters for the brain:**
> "Sensitive data scan of Finance department (8 devices) complete:
> - DESKTOP-012 (jsmith): 3 Excel files in Downloads contain credit card numbers (PCI violation). Files are unencrypted on an unencrypted drive.
> - LAPTOP-009 (mwilson): `.env` file in /Projects/ contains production database credentials and an AWS secret key.
> - SERVER-005: 12 CSV files in /exports/ contain SSNs for 4,200 records.
> Critical risk: The AWS key on LAPTOP-009 is the most urgent — if this device is compromised, the attacker gets cloud access. Want me to rotate that key and move creds to a vault?"

---

## BE-25: USB & Peripheral Device Control

**What exists**: Nothing. No visibility into what's plugged into endpoints.
**What's missing**: The brain can't see USB drives, can't prevent data exfiltration via removable media. CIS Control 3.

### New Agent Collector: `peripheral_monitor`

Runs on device-connect events + periodic scan (5 min).

**Data collected:**
- **USB devices**: Vendor, product, serial number, device class (storage/HID/printer/network/audio)
- **Removable storage**: Drive letter/mount, capacity, filesystem, files written count
- **Bluetooth devices**: Paired devices, connected devices, device types
- **Thunderbolt/USB-C**: External displays, docks, eGPUs

**Policy enforcement:**
```
peripheralPolicies: id, orgId, name, deviceClass (storage|all_usb|bluetooth),
  action (allow|block|read_only|alert), exceptions (jsonb),
  targetType, targetIds, isActive
```

**Agent-side:**
- Windows: WMI device events + Group Policy USB restrictions
- macOS: IOKit device notifications + configuration profiles
- Linux: udev rules + udisks2 monitoring
- **Read-only mode**: Mount removable storage as read-only (prevents data exfiltration while allowing access)

**Storage:**
```
peripheralEvents: id, deviceId, orgId, eventType (connected|disconnected|blocked),
  peripheralType, vendor, product, serialNumber, details (jsonb), timestamp
```

**New AI Tools:**
- `get_peripheral_activity` — Tier 1: USB/Bluetooth activity across fleet
- `manage_peripheral_policy` — Tier 3: Create/modify device control policies

**CIS Control mapping**: CIS 3.9 (Encrypt data on removable media), 3.10 (Encrypt sensitive data in transit)

**Why this matters for the brain:**
> "USB activity alert: Unknown USB mass storage device connected to SERVER-002 at 2:15am. Vendor: 'Generic', Serial: 'A1B2C3'. This server has a policy of no removable storage. I've blocked the device and logged the event. The only active session on this server is 'admin_temp' (logged in via RDP from 10.0.1.99 at 2:10am). This session was created via an elevation request that expired 3 hours ago. Flagging as suspicious — possible unauthorized access."

---

## BE-26: Configuration Hardening Baselines

**What exists**: BE-21 covers audit policy baselines. BE-9 covers security posture scoring.
**What's missing**: No comprehensive OS hardening checks against CIS Benchmarks. Audit policies are just one slice. CIS Control 4.

### New Compliance Feature: Full CIS Benchmark Assessment

**What this checks** (beyond audit policies):

**Windows CIS Benchmark (200+ checks):**
- Account policies: Password length/complexity/history/age, lockout threshold/duration
- Local policies: User rights assignments, security options
- Event log settings: Maximum sizes, retention
- System services: Disabled services list (Telnet, FTP, SNMP, Remote Registry)
- Registry hardening: SMBv1 disabled, NTLMv2 enforced, anonymous access blocked
- Windows Firewall: Profiles enabled, default deny inbound
- BitLocker: Encryption required, recovery key escrowed
- Windows Defender: Real-time protection, cloud protection, PUA detection
- Network: LLMNR/NetBIOS disabled, WPAD disabled
- Browser: SmartScreen enabled, certificate error override blocked

**macOS CIS Benchmark (100+ checks):**
- FileVault enabled, firmware password set
- Gatekeeper enabled, SIP enabled
- Remote login (SSH) disabled, screen sharing disabled
- Firewall enabled in stealth mode
- Auto-updates enabled, app auto-updates enabled
- Guest account disabled, root login disabled
- AirDrop restrictions, Bluetooth discoverability

**Linux CIS Benchmark (150+ checks):**
- Filesystem: Separate /tmp /var /var/log partitions, noexec on /tmp
- SSH: Protocol 2 only, root login disabled, MaxAuthTries, idle timeout
- PAM: Password quality (pam_pwquality), failed login lockout
- File permissions: SUID/SGID audit, world-writable files, unowned files
- Network: IP forwarding disabled, ICMP redirects blocked, TCP SYN cookies
- Logging: rsyslog/journald configured, remote logging

**Agent-side:**
- New collector: `cis_benchmark` — runs on-demand or scheduled (daily)
- Reads system configuration via OS-native APIs (registry, plist, sysctl, config files)
- Compares against stored CIS Benchmark profile
- Reports: pass/fail per check, overall compliance percentage, remediation commands

**Storage:**
```
cisBaselines: id, orgId, name, osType, benchmarkVersion, level (l1|l2),
  customExclusions (jsonb), isActive

cisBaselineResults: id, deviceId, baselineId, checkedAt, totalChecks,
  passedChecks, failedChecks, score, findings (jsonb)
```

**New AI Tools:**
- `get_cis_compliance` — Tier 1: Fleet-wide CIS benchmark compliance dashboard
- `get_cis_device_report` — Tier 1: Per-device detailed findings with remediation steps
- `apply_cis_remediation` — Tier 3: Apply hardening fix for specific CIS check(s)

**CIS Control mapping**: CIS 4.1 (Establish secure configuration process), 4.2-4.12 (all configuration sub-controls)

**Why this matters for the brain:**
> "CIS Benchmark assessment for Downtown Office (25 Windows devices):
> Average compliance: 67% (CIS Level 1). Top failures:
> 1. 25/25 devices: SMBv1 still enabled (CVE attack surface)
> 2. 22/25 devices: Password minimum length is 8 (CIS requires 14)
> 3. 20/25 devices: Account lockout threshold not configured
> 4. 18/25 devices: LLMNR not disabled (poisoning attack vector)
> 5. 15/25 devices: Remote Registry service running
> I can remediate items 1, 4, and 5 immediately via registry changes (low risk, no reboot). Items 2 and 3 require Group Policy changes — want me to generate the remediation script?"

---

## BE-27: Browser Security & Extension Control

**What exists**: Software inventory includes browsers. Nothing on extensions or browser config.
**What's missing**: Browser extensions are a top malware vector. The brain has zero visibility. CIS Control 9.

### New Agent Collector: `browser_inventory`

Runs every 15 minutes (alongside software inventory).

**Data collected per browser (Chrome, Edge, Firefox, Safari, Brave):**
- **Extensions**: Name, ID, version, permissions requested, source (web store / sideloaded / enterprise), enabled/disabled
- **Browser settings**: Default search engine, homepage, proxy config, certificate stores
- **Saved passwords**: Count only (never exfiltrate actual passwords), password manager in use
- **Autofill data**: Presence of credit card data, address data in browser profile

**Extension risk classification:**
- **High risk**: Extensions requesting `<all_urls>`, `webRequest`, `cookies`, `tabs`, `history`
- **Medium risk**: Extensions with `storage`, `notifications`, `activeTab`
- **Low risk**: Extensions with minimal permissions
- **Sideloaded**: Extensions not from official web store (always flagged)

**Policy enforcement:**
```
browserPolicies: id, orgId, name, allowedExtensions (jsonb),
  blockedExtensions (jsonb), requiredExtensions (jsonb),
  settings (jsonb), targetType, targetIds, isActive
```

**New AI Tools:**
- `get_browser_security` — Tier 1: Fleet browser extension inventory, risk scoring, policy violations
- `manage_browser_policy` — Tier 3: Push browser policy (via enterprise management: Chrome ADMX, Edge policy, Firefox enterprise)

**CIS Control mapping**: CIS 9.1 (Ensure only fully supported browsers), 9.2 (Use DNS filtering), 9.4 (Restrict unnecessary browser extensions), 9.5 (Implement DMARC)

**Why this matters for the brain:**
> "Browser extension audit: 14 high-risk extensions found across fleet:
> - 'PDF Converter Pro' on 8 devices — requests `<all_urls>` + `webRequest` (can read all browsing data). Not in any known web store. Sideloaded. **This is likely malware.**
> - 'Grammarly' on 22 devices — high permissions but legitimate, approved by policy.
> - 'Honey' on 15 devices — medium risk, known extension, but was acquired by PayPal and now tracks shopping activity.
> Recommend: Immediately remove 'PDF Converter Pro' from all 8 devices and run a security scan. Flag 'Honey' for admin review."

---

## BE-28: DNS Security & Filtering Integration

**What exists**: DNS check monitors (resolve a hostname, check response). No DNS-layer security.
**What's missing**: No integration with DNS filtering services that block malicious domains. CIS Control 9.

### New Integration: DNS Filtering Connectors

**Supported services:**
- Cisco Umbrella (OpenDNS)
- Cloudflare Gateway (Zero Trust)
- DNSFilter
- Pi-hole (self-hosted)

**Integration provides:**
- **Query logs**: Which devices queried which domains, blocked queries
- **Block stats**: How many threats blocked per device/site/org
- **Policy management**: Push DNS policies from brain (block categories, custom blocklists)
- **Threat intelligence**: Domains flagged as malicious, phishing, C2

**Storage:**
```
dnsFilterIntegrations: id, orgId, provider, apiKey (encrypted), config (jsonb),
  isActive, lastSync

dnsSecurityEvents: id, orgId, deviceId, domain, queryType, action
  (allowed|blocked), category, threatType, timestamp
```

**New AI Tools:**
- `get_dns_security` — Tier 1: DNS blocking stats, top blocked domains, devices hitting blocked domains
- `manage_dns_policy` — Tier 2: Add domains to blocklist/allowlist via filtering provider API

**CIS Control mapping**: CIS 9.2 (Use DNS filtering services)

**Why this matters for the brain:**
> "DNS security report: 847 malicious domain requests blocked this week across your fleet.
> Concerning pattern: DESKTOP-033 attempted to reach `evil-payload.tk` 47 times in the last 24 hours. This domain is flagged as a known C2 server. The requests are coming from `svchost-helper.exe` (the suspicious startup item I flagged in the boot performance analysis).
> This device is likely compromised. Recommend: Network isolation, full security scan, incident response."

---

## BE-29: Backup Verification & Recovery Testing

**What exists**: Backup agent module (filesystem, S3/Azure/GCP), job scheduling, snapshot listing.
**What's missing**: No proof backups actually work. "Schrodinger's backup: it's both working and broken until you try to restore." CIS Control 11.

### New Capability: Automated Backup Testing

**Test types:**
- **Integrity check**: Verify backup file checksums, verify encryption, verify completeness
- **Test restore**: Restore to temporary location, verify file integrity, measure restore time, cleanup
- **Recovery time measurement**: Track how long full restore takes (for RTO calculations)

**Scheduling:**
- Auto-test after each backup completion (integrity check — lightweight)
- Weekly test restore of random backup set (configurable)
- Monthly full recovery test (optional, configurable scope)

**Storage:**
```
backupVerifications: id, orgId, deviceId, backupJobId, snapshotId,
  verificationType (integrity|test_restore|full_recovery), status
  (passed|failed|partial), startedAt, completedAt, restoreTimeSeconds,
  filesVerified, filesFailed, sizeBytes, details (jsonb)
```

**New AI Tools:**
- `get_backup_health` — Tier 1: Fleet backup status — last successful backup, last test, recovery time estimates
- `run_backup_verification` — Tier 2: Trigger integrity check or test restore
- `get_recovery_readiness` — Tier 1: RTO/RPO analysis per device — "how fast can we recover?"

**CIS Control mapping**: CIS 11.1 (Establish data recovery process), 11.2 (Perform automated backups), 11.3 (Protect recovery data), 11.4 (Establish and maintain an isolated instance of recovery data), 11.5 (Test data recovery)

**Why this matters for the brain:**
> "Backup health report — 3 issues found:
> 1. SERVER-005: Last backup was 9 days ago (policy: daily). Backup job is failing with 'disk full on backup target.' Critical — this is the SQL server.
> 2. DESKTOP-019: Backup succeeds but last test restore failed — 3 files corrupted (checksums mismatch). Backup integrity compromised.
> 3. Fleet-wide: Average recovery time is 4.2 hours. Your SLA promises 2-hour RTO. 12 of 40 devices would exceed RTO based on test restore timing.
> Immediate action on SERVER-005: Backup target disk is 98% full. I can clean old snapshots (retention policy says keep 30 days, we have 90 days of data). That would free 180GB. Approve?"

---

## BE-30: Network Device Configuration Management

**What exists**: SNMP polling for network devices. Discovery finds routers/switches.
**What's missing**: No config backup, no firmware tracking, no hardening checks for network infrastructure. CIS Control 12.

### New Capability: Network Infrastructure Management

**Via SNMP + SSH/API to managed network devices:**

**Data collected:**
- **Configuration backup**: Running config, startup config (via SSH `show run` or SNMP)
- **Firmware versions**: IOS/firmware version per device, EOL status
- **Config diff**: Track changes between config snapshots
- **Interface status**: Up/down, errors, utilization, speed/duplex
- **Security config**: ACLs, port security, 802.1X status, management access restrictions

**Device support:**
- Cisco IOS/IOS-XE (SSH + SNMP)
- Ubiquiti UniFi (API)
- Meraki (Dashboard API)
- Generic SNMP-managed devices
- Fortinet, SonicWall, pfSense (API where available)

**Storage:**
```
networkDeviceConfigs: id, orgId, assetId, configType (running|startup),
  config (text, encrypted), capturedAt, hash, changedFromPrevious

networkDeviceFirmware: id, orgId, assetId, currentVersion, latestVersion,
  eolDate, cveCount, lastChecked
```

**New AI Tools:**
- `get_network_device_configs` — Tier 1: Config backup status, last change, diff
- `get_network_firmware_status` — Tier 1: Firmware currency, EOL devices, vulnerable versions
- `backup_network_config` — Tier 2: Trigger config backup on demand

**CIS Control mapping**: CIS 12.1 (Ensure network infrastructure is up to date), 12.2 (Establish secure network architecture), 12.6 (Use secure network management)

**Why this matters for the brain:**
> "Network infrastructure audit:
> - Core switch (10.0.1.1): Config changed 2 hours ago — diff shows: ACL 101 was modified, 3 new permit rules added allowing inbound traffic on ports 8080-8090. This was not a scheduled change. Last SSH login was from 10.0.1.33 (DESKTOP-admin).
> - Firewall (10.0.1.254): Firmware is FortiOS 7.0.3 — EOL'd 6 months ago, 4 known CVEs. Latest is 7.4.2.
> - 2 access points running UniFi 6.5.21 — 2 versions behind, security patch available.
> The ACL change is suspicious. Want me to revert to the previous config?"

---

## BE-31: User Risk Scoring

**What exists**: BE-8 (session tracking), software inventory, event logs.
**What's missing**: No per-user risk profile. The brain treats all users the same. CIS Control 14.

### New Computed Feature: User Behavioral Risk Score

**Composite score (0-100, higher = riskier) based on:**

| Factor | Weight | Data Source |
|--------|--------|------------|
| Phishing click rate | 25% | Huntress/email security integration, or internal simulation results |
| Software violations | 20% | BE-15 (unauthorized software installed by this user) |
| Sensitive data exposure | 15% | BE-24 (PII/creds found in user's profile) |
| Security training completion | 15% | Integration with training platforms (KnowBe4, etc.) or manual tracking |
| Elevation request frequency | 10% | BE-17 (how often does this user request admin?) |
| USB/peripheral violations | 10% | BE-25 (unauthorized device connections) |
| Login anomalies | 5% | Unusual login times, failed attempts, new locations |

**Not a new agent collector** — computed API-side from existing data sources.

**Storage:**
```
userRiskScores: id, orgId, userId, score, factors (jsonb),
  trendDirection, calculatedAt

userRiskEvents: id, orgId, userId, eventType, severity, description,
  details (jsonb), timestamp
```

**New AI Tools:**
- `get_user_risk_scores` — Tier 1: Ranked list of highest-risk users
- `get_user_risk_detail` — Tier 1: Per-user breakdown with contributing factors
- `assign_security_training` — Tier 2: Flag user for training, send notification

**CIS Control mapping**: CIS 14.1 (Establish security awareness program), 14.2 (Train workforce on recognizing social engineering), 14.6 (Train workforce on recognizing phishing)

**Why this matters for the brain:**
> "Top 5 highest-risk users this month:
> 1. mwilson (score: 82) — Clicked 3 phishing simulations, has an AWS key in plaintext on desktop, installed uTorrent
> 2. jsmith (score: 71) — 12 elevation requests in 30 days (average is 2), failed security training quiz
> 3. admin_temp (score: 68) — Shared service account, logged in from 3 unusual IPs, no MFA configured
> Recommendation: Immediate MFA enforcement for admin_temp. Security awareness training for mwilson and jsmith. Consider revoking mwilson's local admin privileges."

---

## BE-32: Incident Response Automation

**What exists**: Alert system, threat scanning, device isolation (planned via S1). Playbooks (BE-12).
**What's missing**: No structured IR workflow. No evidence preservation. No containment-to-recovery pipeline. CIS Control 17.

### New Capability: Brain-Driven Incident Response

**IR workflow phases (NIST 800-61):**

**1. Detection & Analysis:**
- Brain correlates multiple signals into an "incident" (vs isolated alerts)
- Auto-classification: Malware, unauthorized access, data exfiltration, policy violation, insider threat
- Severity assignment: P1 (critical) through P4 (informational)

**2. Containment:**
- **Network isolation**: Via S1 agent isolation, or firewall rules via script
- **Account disable**: Disable AD/local account via script
- **Process kill**: Terminate malicious process
- **USB block**: Engage device control policy (BE-25)
- Brain selects containment actions based on incident type and severity

**3. Evidence Collection:**
- **Memory snapshot**: Process list, network connections, loaded DLLs (on Windows)
- **File preservation**: Copy suspicious files to secure evidence storage before deletion
- **Log capture**: Collect relevant event logs, agent logs, change log (BE-6) for timeline
- **Network capture**: Recent connections, DNS queries
- **Screenshot**: Capture desktop state (if user session active)
- Evidence stored with chain-of-custody metadata (who collected, when, hash)

**4. Recovery:**
- Verify containment actions effective
- Restore from known-good backup (BE-29)
- Re-enable network access
- Reset compromised credentials
- Verify device health post-recovery

**5. Post-Incident:**
- Auto-generate incident report with full timeline
- Lessons learned (brain suggests: policy changes, training, hardening)
- Update detection rules based on incident

**Storage:**
```
incidents: id, orgId, title, classification, severity, status
  (detected|analyzing|contained|eradicating|recovering|closed),
  detectedAt, containedAt, resolvedAt, closedAt, assignedTo,
  relatedAlerts (jsonb), affectedDevices (jsonb), summary, timeline (jsonb)

incidentEvidence: id, incidentId, evidenceType (file|log|screenshot|memory|network),
  description, collectedAt, collectedBy, hash, storagePath, metadata (jsonb)

incidentActions: id, incidentId, actionType, description, executedAt,
  executedBy, result, reversible, reversed, details (jsonb)
```

**New AI Tools:**
- `create_incident` — Tier 2: Escalate correlated alerts into formal incident
- `execute_containment` — Tier 3: Run containment action (isolate, disable, kill)
- `collect_evidence` — Tier 2: Gather forensic data from device
- `get_incident_timeline` — Tier 1: Full timeline reconstruction with all signals
- `generate_incident_report` — Tier 1: Auto-generate IR report for stakeholders

**CIS Control mapping**: CIS 17.1 (Designate IR personnel), 17.2 (Establish IR process), 17.3 (Establish IR reporting), 17.4 (Establish IR communication), 17.6 (Define IR containment), 17.7 (Conduct routine IR exercises), 17.8 (Conduct post-incident reviews), 17.9 (Establish IR thresholds)

**Why this matters for the brain:**
> "INCIDENT IR-2026-0042 — Severity: P1 (Critical)
> Classification: Malware + Possible Data Exfiltration
>
> Timeline:
> - 02:10 — RDP login to SERVER-002 from 10.0.1.99 (session: admin_temp)
> - 02:12 — Huntress alert: Scheduled task created running encoded PowerShell
> - 02:15 — USB storage device connected (blocked by policy — BE-25)
> - 02:18 — DNS query for evil-payload.tk (blocked by DNS filter — BE-28)
> - 02:20 — SentinelOne: Process injection detected in svchost.exe
>
> Containment actions taken:
> 1. Network isolated SERVER-002 via SentinelOne
> 2. Disabled admin_temp account
> 3. Blocked source IP 10.0.1.99 at firewall
>
> Evidence collected:
> - Process dump, network connections, scheduled task details, RDP session log
>
> Next steps: Need human IR lead to review before recovery. Incident report generated."

---

## Priority Order for Implementation (Updated)

Features ordered by **brain impact** vs **effort**.

| Priority | Feature | Brain Impact | Effort | CIS Control |
|----------|---------|-------------|--------|-------------|
| **BE-1** | File System Intelligence | High | Low | — |
| **BE-6** | Change Tracking | Very High | Medium | — |
| **BE-3** | Reliability Scoring | High | Medium | — |
| **BE-9** | Security Posture Scoring | High | Low | 4 |
| **BE-8** | User Session Intelligence | High | Low | — |
| **BE-11** | Device Context Memory | Very High | Low | — |
| **BE-12** | Self-Healing Playbooks | Very High | Low | — |
| **BE-13** | End-User Diagnostic Chat | Very High | High | — |
| **BE-14** | Agent Log Shipping | High | Low-Med | 8 |
| **BE-15** | Application Whitelisting | Very High | Medium | 2 |
| **BE-16** | Vulnerability Management | Very High | High | 7 |
| **BE-17** | Privileged Access Management | Very High | Medium | 5, 6 |
| **BE-18** | New Device Alerting | High | Low-Med | 1, 13 |
| **BE-19** | IP History Tracking | Medium-High | Low | 1 |
| **BE-20** | Central Log Search | Very High | Medium | 8 |
| **BE-2** | Boot Performance | Medium-High | Medium | — |
| **BE-5** | Auto-Discovery → Auto-Monitoring | Very High | Medium | 1 |
| **BE-4** | Network Diagnostics | High | Medium | — |
| **BE-7** | Hardware Health (SMART/Battery) | High | Medium | — |
| **BE-21** | Event Log Audit Baselines | High | Medium | 8 |
| **BE-22** | Huntress Integration | Very High | Medium | 10, 13 |
| **BE-23** | SentinelOne Integration | Very High | Medium | 10, 13 |
| **BE-24** | Sensitive Data Discovery | Very High | Medium | 3 |
| **BE-25** | USB & Peripheral Control | High | Medium | 3 |
| **BE-26** | Configuration Hardening Baselines | Very High | High | 4 |
| **BE-27** | Browser Extension Control | High | Medium | 9 |
| **BE-28** | DNS Security Integration | High | Low-Med | 9 |
| **BE-29** | Backup Verification | High | Medium | 11 |
| **BE-30** | Network Device Config Mgmt | High | Medium-High | 12 |
| **BE-31** | User Risk Scoring | Very High | Medium | 14 |
| **BE-32** | Incident Response Automation | Very High | High | 17 |
| **BE-10** | Fleet Anomaly Detection | Very High | High | — |

### Suggested Implementation Waves

**Wave 1 — Quick Wins (brain gets smarter fast)**
- BE-1: File System Intelligence
- BE-9: Security Posture Scoring
- BE-8: User Session Intelligence
- BE-11: Device Context Memory
- BE-12: Self-Healing Playbooks (brain patterns, no agent work)
- BE-14: Agent Log Shipping
- BE-18: New Device Alerting
- BE-19: IP History Tracking

**Wave 2 — Deep Context (brain understands causation)**
- BE-6: Change Tracking
- BE-3: Reliability Scoring
- BE-2: Boot Performance
- BE-20: Central Log Search
- BE-15: Application Whitelisting
- BE-28: DNS Security Integration

**Wave 3 — Security & Compliance (brain becomes a SOC analyst)**
- BE-17: Privileged Access Management
- BE-16: Vulnerability Management
- BE-21: Event Log Audit Baselines
- BE-22: Huntress Integration
- BE-23: SentinelOne Integration
- BE-24: Sensitive Data Discovery
- BE-25: USB & Peripheral Control

**Wave 4 — Deep Compliance (brain audits like a pro)**
- BE-26: Configuration Hardening Baselines (CIS Benchmarks)
- BE-27: Browser Extension Control
- BE-29: Backup Verification
- BE-30: Network Device Config Management
- BE-31: User Risk Scoring
- BE-32: Incident Response Automation

**Wave 5 — Proactive Intelligence (brain anticipates problems)**
- BE-5: Auto-Discovery → Auto-Monitoring
- BE-4: Network Diagnostics
- BE-7: Hardware Health Prediction
- BE-10: Fleet Anomaly Detection
- BE-13: End-User Diagnostic Chat

---

## How These Feed the Brain Connector

Each BE feature maps to the brain connector architecture:

| BE Feature | Brain Tool(s) | Risk Tier | Event Stream |
|------------|--------------|-----------|-------------|
| BE-1: File System | `analyze_disk_usage`, `disk_cleanup` | T1 read, T3 cleanup | `disk.threshold_exceeded` |
| BE-2: Boot Performance | `analyze_boot_performance`, `manage_startup_items` | T1 read, T3 modify | `boot.slow_detected` |
| BE-3: Reliability | `get_fleet_health` | T1 | `reliability.score_dropped` |
| BE-4: Network Diagnostics | `run_network_diagnostics` | T1/T2 | `network.degraded` |
| BE-5: Auto-Monitoring | `auto_provision_monitoring`, `get_monitoring_gaps` | T2 | `discovery.scan_complete` |
| BE-6: Change Tracking | `query_change_log` | T1 | `change.detected` |
| BE-7: Hardware Health | `get_hardware_health` | T1 | `hardware.health_warning` |
| BE-8: User Sessions | `get_active_users` | T1 | `session.login`, `session.logout` |
| BE-9: Security Posture | `get_security_posture` | T1 | `security.score_changed` |
| BE-10: Anomalies | `get_anomalies` | T1 | `anomaly.detected` |
| BE-11: Device Context | `get_device_context`, `set_device_context` | T1/T2 | — |
| BE-12: Playbooks | (orchestration pattern) | Varies | `playbook.completed` |
| BE-13: End-User Chat | `get_user_diagnostic_session` | T1/T2 | `enduser.session_started`, `enduser.escalated` |
| BE-14: Agent Logs | `search_agent_logs`, `set_agent_log_level` | T1/T2 | `agent.error_spike` |
| BE-15: App Whitelisting | `get_software_compliance`, `remediate_software_violation` | T1/T3 | `compliance.software_violation` |
| BE-16: Vuln Management | `get_vulnerability_report`, `remediate_vulnerability` | T1/T3 | `vulnerability.critical_detected` |
| BE-17: PAM | `request_elevation`, `revoke_elevation` | T1/T2/T3 | `elevation.requested`, `elevation.expired` |
| BE-18: New Device Alert | `get_network_changes`, `acknowledge_network_device` | T1/T2 | `network.new_device`, `network.rogue_device` |
| BE-19: IP History | `get_ip_history` | T1 | `network.ip_changed` |
| BE-20: Central Logs | `search_logs`, `get_log_trends` | T1 | `logs.error_spike` |
| BE-21: Audit Baselines | `get_audit_compliance`, `apply_audit_baseline` | T1/T3 | `compliance.audit_deviation` |
| BE-22: Huntress | `get_huntress_status`, `get_huntress_incidents` | T1 | `huntress.incident_created` |
| BE-23: SentinelOne | `get_s1_status`, `s1_threat_action`, `s1_isolate_device` | T1/T3 | `s1.threat_detected` |
| BE-24: Sensitive Data | `scan_sensitive_data`, `get_sensitive_data_report` | T1/T2/T3 | `compliance.sensitive_data_found` |
| BE-25: USB Control | `get_peripheral_activity`, `manage_peripheral_policy` | T1/T3 | `peripheral.unauthorized_device` |
| BE-26: CIS Hardening | `get_cis_compliance`, `apply_cis_remediation` | T1/T3 | `compliance.cis_deviation` |
| BE-27: Browser Security | `get_browser_security`, `manage_browser_policy` | T1/T3 | `compliance.risky_extension` |
| BE-28: DNS Security | `get_dns_security`, `manage_dns_policy` | T1/T2 | `dns.malicious_query_blocked` |
| BE-29: Backup Verify | `get_backup_health`, `run_backup_verification` | T1/T2 | `backup.verification_failed` |
| BE-30: Network Config | `get_network_device_configs`, `get_network_firmware_status` | T1/T2 | `network.config_changed` |
| BE-31: User Risk | `get_user_risk_scores`, `assign_security_training` | T1/T2 | `user.risk_score_high` |
| BE-32: Incident Response | `create_incident`, `execute_containment`, `collect_evidence` | T1/T2/T3 | `incident.created`, `incident.contained` |

Every feature emits **events** the brain can subscribe to. Every feature exposes **tools** the brain can call. The brain connector Phase 1 (tool catalog + risk engine + events) is the foundation these plug into.

---

## New P2 Reframing

The original roadmap P2 was "NinjaOne Parity Gaps." In an AI-centric model, some of those gaps matter *less* because the brain replaces the need for manual UIs, and some matter *more* because they feed the brain context:

| Original P2 Item | Brain-Centric Value | New Priority |
|-------------------|-------------------|-------------|
| IT Documentation / Wiki | Low — brain IS the documentation (BE-11 context memory) | Deprioritize |
| Credential Vault | High — brain needs creds to access managed services, PAM needs it | Keep (feeds BE-17) |
| Visual Workflow Builder | Low — brain IS the workflow engine (BE-12 playbooks) | Deprioritize |
| Third-Party Patching | High — more things the brain can patch = more autonomous | Keep |
| Backup Enhancements | Medium — brain can manage backup jobs | Keep |
| Mobile App | Medium — brain can send notifications/summaries to phone | Keep but lower |
| Third-Party AV Integration | Replaced — now BE-22 (Huntress) and BE-23 (SentinelOne) | Superseded |

### CIS Critical Security Controls v8 — Full Coverage Matrix

| CIS Control | Coverage | BE Features |
|-------------|----------|-------------|
| 1. Asset Inventory | **Strong** | BE-18 (new device alerting), BE-19 (IP history), BE-5 (auto-discovery) |
| 2. Software Inventory | **Strong** | BE-15 (app whitelisting), BE-27 (browser extensions), existing software inventory |
| 3. Data Protection | **Strong** | BE-24 (sensitive data discovery), BE-25 (USB control), BE-9 (encryption status) |
| 4. Secure Configuration | **Strong** | BE-26 (CIS Benchmark hardening), BE-21 (audit baselines), BE-9 (security scoring) |
| 5. Account Management | **Strong** | BE-17 (PAM), BE-8 (session tracking), BE-31 (user risk scoring) |
| 6. Access Control | **Strong** | BE-17 (elevation requests), existing RBAC |
| 7. Vulnerability Management | **Strong** | BE-16 (CVE scanning), existing patch management |
| 8. Audit Log Management | **Strong** | BE-20 (central search), BE-21 (audit baselines), BE-14 (agent logs) |
| 9. Email/Browser Protection | **Strong** | BE-27 (browser extensions), BE-28 (DNS filtering), BE-22 (Huntress email) |
| 10. Malware Defenses | **Strong** | BE-22 (Huntress), BE-23 (S1), BE-15 (app control), existing AV |
| 11. Data Recovery | **Strong** | BE-29 (backup verification), existing backup system |
| 12. Network Infrastructure | **Strong** | BE-30 (network device config mgmt), BE-4 (diagnostics) |
| 13. Network Monitoring | **Strong** | BE-18 (new device alerting), BE-4 (diagnostics), BE-5 (auto-monitoring), BE-28 (DNS) |
| 14. Security Awareness | **Medium** | BE-31 (user risk scoring), training platform integration (partial) |
| 15. Service Provider Mgmt | **Medium** | Multi-tenant architecture, integration audit trails |
| 16. Application Security | **Medium** | BE-15 (whitelisting), BE-16 (vuln scanning), BE-27 (browser control) |
| 17. Incident Response | **Strong** | BE-32 (IR automation), BE-22/23 (EDR integration) |
| 18. Penetration Testing | N/A | Out of scope for RMM (complementary service) |

**Coverage summary**: 13 of 18 controls at Strong, 3 at Medium, 1 N/A. The remaining Medium gaps (14, 15, 16) require integrations with specialized platforms (training, GRC, SAST) rather than RMM-native features.
