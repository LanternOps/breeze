# Change Tracking Agent Overhead

Technical reference for the BE-6 change tracker's resource footprint per collection
cycle. Captured from live observation on Kit (Windows 11 Pro, dev/local docker deploy,
2026-02-21). Intended to inform future decisions about configurable schedule intervals.

---

## How the collector runs

`sendConfigurationChanges` is called as part of `sendInventory`, which fires once on
agent startup and then every 15 minutes. All six sub-collectors run **concurrently**;
wall time is dominated by the slowest one.

The relevant code path:

```
heartbeat.go: sendInventory()
  └─ sendConfigurationChanges()        (goroutine, every 15 min)
       └─ ChangeTrackerCollector.CollectChanges()
            └─ gatherCurrentSnapshot() (6 collectors, all concurrent)
                 ├─ SoftwareCollector.Collect()
                 ├─ ServiceCollector.Collect()
                 ├─ InventoryCollector.CollectNetworkAdapters()
                 ├─ collectStartupItems()
                 ├─ collectScheduledTasks()
                 └─ collectUserAccounts()
```

Each sub-collector runs inside `collectWithTimeout` with an 8-second hard cap
(overridable via `BREEZE_CHANGE_TRACKER_COLLECTOR_TIMEOUT_SECONDS`). If a collector
times out, its previous snapshot data is reused and no changes are emitted for that
category.

---

## Per-collector cost (Windows)

| Collector | Mechanism | Typical wall time |
|-----------|-----------|-------------------|
| Software | Registry API scan — 3 paths (`HKLM\...\Uninstall`, `WOW6432Node`, `HKCU`) × ~200 subkeys each | 5–20 ms |
| Startup items | Registry `Run`/`RunOnce` keys + `ReadDir` on 2 startup folders | 2–5 ms |
| Network adapters | Go stdlib `net.Interfaces()` | ~1 ms |
| Services | Spawns `powershell -NoProfile -NonInteractive` → `Get-CimInstance Win32_Service` | 300–800 ms |
| Scheduled tasks | Spawns `powershell -NoProfile -NonInteractive` → `Get-ScheduledTask` | 500–2000 ms |
| User accounts | Spawns `powershell -NoProfile -NonInteractive` → `Get-CimInstance Win32_UserAccount` | 100–300 ms |

**Dominant cost**: the three PowerShell processes. PowerShell startup alone is
~300–500 ms per instance; WMI and task scheduler queries add more on top. On a
machine with many scheduled tasks (>200), `Get-ScheduledTask` has been observed to
take 3–5 seconds before hitting the timeout.

---

## Aggregate overhead per 15-minute cycle

| Resource | Impact |
|----------|--------|
| CPU | ~1–3 s burst while PowerShell processes are running; negligible otherwise |
| Memory | ~50–100 MB per PowerShell process × 3 concurrent = 150–300 MB peak for ~1–3 s, then drops to zero |
| Disk I/O | One atomic JSON write of the snapshot file (~50–200 KB) per cycle |
| Network | Zero bytes sent when the diff is empty; small JSON payload (proportional to number of changes) only when changes are detected |

On a typical lightly-loaded workstation or server the overhead is imperceptible. On
constrained endpoints (thin clients with ≤4 GB RAM, or servers with hundreds of
scheduled tasks) the memory spike and PowerShell latency may be noticeable.

---

## Linux / macOS

Significantly lighter — no PowerShell spawns:

| Collector | Mechanism |
|-----------|-----------|
| Services | `systemctl list-units --type=service` (Linux) / `launchctl list` (macOS) |
| Scheduled tasks | `crontab -l` parse |
| User accounts | `dscl . -list /Users` (macOS) / `/etc/passwd` parse (Linux) |
| Startup items | Glob over `/Library/Launch{Daemons,Agents}` plist files (macOS) / systemd user unit files (Linux) |

Typical total wall time on Linux/macOS: **50–200 ms** per cycle.

---

## Known redundancy

`sendInventory` runs `sendSoftwareInventory` and `sendNetworkInventory` concurrently
with `sendConfigurationChanges`. This means **software** (registry scan) and **network
adapters** are each collected twice per cycle — once for the inventory pipeline, once
for the change tracker. At 15-minute intervals this is harmless, but it is wasted work
and a reason not to reduce the interval too aggressively without also deduplicating the
collection.

---

## Considerations for a configurable schedule

The 15-minute default is a reasonable starting point for most endpoints. Scenarios
where tuning would matter:

| Scenario | Suggested direction |
|----------|---------------------|
| Thin client / low-RAM device | Longer interval (e.g. 60 min) to reduce memory spikes |
| Server with 500+ scheduled tasks | Longer interval, or disable `scheduled_task` collector for that device |
| High-sensitivity environment (SOC, compliance) | Shorter interval (e.g. 5 min), accepting higher CPU cost |
| Linux/macOS fleet | Shorter interval is low-risk given the lightweight collection path |

### Implementation notes for when this gets built

- The heartbeat already delivers `configUpdate` patches to the agent on each response.
  Adding a `changeTrackerIntervalMinutes` key there is the natural delivery mechanism —
  no separate channel needed.
- `BREEZE_CHANGE_TRACKER_COLLECTOR_TIMEOUT_SECONDS` already establishes the pattern for
  runtime-tunable collector settings via environment variable; a similar override for the
  interval would be consistent.
- Per-collector enable/disable flags (e.g. `changeTrackerDisabledCollectors: ["scheduled_task"]`)
  would let constrained devices skip the expensive PowerShell queries selectively.
- Changing the interval does not require a snapshot reset — the diff logic is
  timestamp-agnostic.
