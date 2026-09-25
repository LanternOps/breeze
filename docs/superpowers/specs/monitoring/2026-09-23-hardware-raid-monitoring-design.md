---
title: Hardware & RAID monitoring — in-band controller, array, disk and cache-battery health
status: approved design (Todd, 2026-09-23); advisor quorum (Fable + Codex gpt-6-astra xhigh) recorded in §16
date: 2026-09-23
origin: owner request 2026-09-23 ("hardware monitoring for RAID systems — Dell OMSA, Lenovo, HP, MegaRAID, LSI; iDRAC maybe separate")
related: "#3866 (SMART/battery/thermal failure prediction — PARKED, not built here); #2310 (GPU monitoring, adjacent); #4984 / 2026-09-19 alerting consolidation (the monitor model this rides on); 2026-09-16 network-device-page-truth (SNMP probe path the BMC follow-on will reuse)"
tracking_issue: LanternOps/breeze#6854
follow_on_spec: BMC out-of-band health (Redfish / SNMP polling of iDRAC, iLO, XCC; chassis sensors; SEL) — separate spec, writes into the tables defined here (§8.5)
---

# Hardware & RAID monitoring

## 1. Product intent

The failure this feature exists to catch: a customer's server loses one disk out of a RAID set, nobody
notices, and months later the second disk dies and takes the data with it. Every RMM an MSP evaluates
is expected to catch the first failure. Breeze today collects no physical-disk, RAID, SMART, cache-battery
or sensor state at all — `DiskInfo.Health` is hard-coded to `"healthy"` (`agent/internal/collectors/inventory.go`).

Success looks like:

1. **One-attachment alerting on the common stacks.** Once the MSP attaches the four built-in
   hardware monitors to a configuration policy (built-ins are never attached by default, D9), a
   server running any of the tools in §5 with the vendor CLI installed raises a "virtual disk
   degraded" / "physical disk failed" alert within two RAID-tier polls plus jitter and sweep lag
   (≈ 25 min at the default 10-min interval; disk-tier-only signals such as SMART within two
   60-min polls), and the alert resolves itself once the array is optimal again.
2. **Coverage without vendor tools.** Windows Storage Spaces, Linux md and ZFS, plain Windows disk
   health, and SMART (when smartmontools is installed) work with nothing else on the box.
3. **The tech can see what to order.** The device Hardware tab shows controller → virtual disks →
   physical disks with model, serial, slot, size, state and progress, plus the BMC address.
4. **It rides the existing monitor model.** No new alert-authoring surface: a new monitor kind in the
   existing registry, attachable through configuration policies like every other monitor.

Approved shape (Todd, 2026-09-23, "yes as recommended"):

- **Detect installed vendor CLIs only; never bundle or download them** (Broadcom/Dell/HPE EULAs,
  signed-binary supply chain). The UI says what was probed and links install guidance.
- **Per-component alerts** ("PD 252:3 failed" and "PD 252:5 failed" are two alerts, each resolving on
  its own). This needs one cross-cutting change: an optional `subject_key` on alert dedupe (§9).
- **BMC out-of-band polling is a separate spec.** This spec only reads the BMC's own address and
  firmware from inside the OS so the already-discovered iDRAC/iLO asset auto-links to the server (§12).

### Out of scope

- SMART-based failure *prediction*, health scores, "disk likely to fail in N days" — #3866 is parked
  pending #1908. This spec captures SMART attributes as data and alerts only on what the drive or
  controller itself flags (SMART overall status failed, controller predictive-failure flag).
- Chassis sensors (fans, PSUs, temperatures, DIMM ECC), SEL / IPMI event ingestion, Redfish or SNMP
  polling of the BMC — the follow-on spec. The component table (§8) is designed to take them.
- macOS (no server RAID stack worth supporting; AppleRAID is dead). Agentless hosts (ESXi, TrueNAS).
- Remediation actions (start rebuild, blink LED, clear foreign config). Read-only in v1.
- A fleet-wide "hardware problems" report page. The device list column + filter covers the fleet
  view in v1; a report can come later on top of `device_hardware_health`.
- Per-device tool path configuration in the web UI. Tools are found on `PATH` plus the fixed
  well-known directories in §5.3; an agent-local override exists for the odd box (§6.6).

## 2. Decisions

| # | Decision | Why |
|---|---|---|
| D1 | One generic `device_hardware_components` table with a `component_type` discriminator, not per-type tables | One set of RLS / cascade / export / merge registrations instead of four; chassis sensors and BMC-sourced components (follow-on) land in the same table without another schema wave. Quorum: agree-with-changes — typed columns for anything filtered or exported, `attributes` and `sources` jsonb are `excludedOpen`. |
| D2 | Slot-based identity for physical disks (`<source>:c<N>:e<E>:s<S>`), serial as an attribute | A swapped drive is the same *slot* with a new serial → `disk_replaced` event, no phantom "new disk + missing disk" pair. Sources without slots (smartctl, Windows disks) key on serial or OS device id. |
| D3 | Agent sends the full component set per snapshot; the server diffs | Agent stays stateless beyond a sequence counter; the server owns events, streaks and rollup in one transaction. Payload is small (tens of rows). |
| D4 | Failed, unavailable, disabled or silent collection never deletes, stales or recovers anything | A dead tool must not look like a recovered disk. Only a source that reported `complete: true` may stale its own components. Unknown never auto-resolves. |
| D5 | Streaks are counted at ingest, per accepted snapshot, not per sweep run | The alert sweep runs every minute and would count one ten-minute observation ten times. |
| D6 | Alert dedupe gains a nullable `subject_key`; `NULL` behaves exactly as today | Every existing kind is untouched. Enforced by a partial unique index on open rule-backed alerts, so a race cannot produce duplicates. |
| D7 | Episodes / recurrence / escalation stay per (monitor, device); automation responses fire at most once per (rule, device) while any subject alert is open | The episode uniqueness index is one-open-per-monitor-device; N disk alerts must not run N device remediations. Notifications still go per subject alert. |
| D8 | One `hardware_health` monitor kind with component-type filters, not one kind per component type | Fewer registry entries; the four built-in defaults are four monitors of the same kind with different filters and severities. Excluded from composite children in v1. |
| D9 | Four built-in defaults at `BUILT_IN_MONITORS_VERSION = 3`, provisioned partner-wide and **not attached** to any policy | Owner decision 2026-09-13 (no monitoring assigned by default) stands. |
| D10 | Collection config is an inline config-policy feature `hardware_monitoring` (Pattern B, like `event_log`), on by default with a 10-min RAID tier and a 60-min disk-health tier | A tech needs to silence a misbehaving vendor CLI on one box or one org without touching alerting; inheritance comes free. No standalone policy table. |
| D11 | Collection is capability-detected, not role-gated | Role classification can fall back to `workstation` after a startup failure (`heartbeat.go` ~975); a workstation with a real RAID card must still be covered. Devices with no source detected send one daily "nothing detected" snapshot. |
| D12 | Source precedence within the Broadcom family: storcli > perccli > MegaCli; omreport storage only when none of those exist | Same controller, three CLIs; JSON beats text. ssacli and arcconf are separate controller families and always run when present. |
| D13 | New dedicated `PUT /api/v1/agents/:id/hardware-health` endpoint on its own cadence, not folded into the 15-min inventory fan-out | Inventory already fans out separate PUTs per concern; hardware needs its own interval, jitter and single-flight. |
| D14 | BMC linking reuses the discovery auto-linker with a new `link_source = 'agent_report'`, honours `auto_link_suppressed_at`, and must not propagate asset classification onto the host or merge topology identities | A BMC is a distinct node; the existing auto-link path has side effects (asset approval, classification propagation, alias clusters) that must be gated for this source. |

## 3. Architecture and data flow

```
 agent (Windows / Linux, root/SYSTEM)                       API                                    web
 ─────────────────────────────────────                      ───                                    ───
 hwhealth scheduler (tick gate in heartbeat loop)
   ├─ detect sources (PATH + well-known dirs, cached 1h)
   ├─ RAID tier every pollIntervalMinutes (10):
   │    storcli/perccli | MegaCli | ssacli | arcconf | omreport
   │    mdadm | zpool | Storage Spaces
   ├─ disk tier every diskHealthIntervalMinutes (60):
   │    Get-PhysicalDisk (+reliability counters) | smartctl
   ├─ normalize → []Component, merge by serial
   └─ PUT /agents/:id/hardware-health {snapshot}  ───────►  ingest (one tx, per-device lock)
                                                               ├─ ordering + completeness checks
 heartbeat response.configUpdate.hardware_monitoring ◄──────  ├─ upsert components, stale-mark
   {enabled, poll_interval_minutes, ...}                       ├─ events (transitions), streaks
                                                               ├─ rollup → device_hardware_health
                                                               └─ bmc component → auto-link asset
                                                            alert sweep (alert-evaluation, 1 min)
                                                               └─ hardware_health handler
                                                                    → per-subject evidence
                                                                    → createAlert(subjectKey) /
                                                                      resolveAlert            ───►  Alerts inbox
                                                            GET /devices/:id/hardware-health  ───►  Hardware tab:
                                                            device list projection            ───►  Storage & RAID
                                                            AI tool get_device_hardware_health       + list column
```

## 4. Component model

Every source normalizes to the same record. The agent does no pass/fail judgement beyond mapping
the vendor's own state strings and setting the boolean flags; **the server alone derives `health`**
from state plus the flags (§4.3) — the agent never sends a `health` value, and `collector` rows are
synthesized server-side from the snapshot's `sources` array (§7.4), never sent by the agent.

### 4.1 Record

| Field | Type | Notes |
|---|---|---|
| `componentKey` | text, ≤ 200 | Stable per device. §4.2. Unique per device. |
| `componentType` | enum `controller \| virtual_disk \| physical_disk \| cache_battery \| enclosure \| bmc \| collector` | |
| `parentKey` | text, nullable | Controller for VD / PD / battery / enclosure. VD→PD membership is many-to-many and lives in `attributes.memberKeys` on the VD. |
| `source` | enum `storcli \| perccli \| megacli \| ssacli \| arcconf \| omreport \| mdadm \| zfs \| storage_spaces \| windows_physical_disk \| smartctl \| ipmi \| racadm \| hponcfg \| redfish \| snmp` | `redfish`, `snmp` reserved for the follow-on. |
| `name` | text | Human label: "PERC H730P Mini", "VD 0 (RAID-10)", "Slot 3", "md0", "tank". |
| `model`, `serial`, `firmware` | text, nullable | Serial is what identity merging keys on (§6.5). |
| `sizeBytes` | bigint, nullable | |
| `health` | enum `ok \| warning \| critical \| unknown` | Server-derived (§4.3); absent from the agent payload. |
| `state` | text | Normalized vocabulary per type (§4.3). Validated on ingest. |
| `stateDetail` | text, nullable | The vendor's own string, verbatim ("Interim Recovery Mode"). |
| `progressPercent` | smallint 0–100, nullable | Rebuild / resync / init / scrub progress when the tool reports it. |
| `temperatureC` | smallint, nullable | |
| `predictiveFailure` | boolean | Controller or drive flagged predictive failure / SMART self-assessment failed / NVMe critical warning. |
| `alertExempt` | boolean | Agent-set. True for OS-visible rows that duplicate a vendor-reported virtual disk (§6.5). Excluded by the alert handler (§9.3), still shown in the UI. |
| `attributes` | jsonb, ≤ 8 KB | Vendor extras: `raidLevel`, `stripeSize`, `cachePolicy`, `enclosure`, `slot`, `interface`, `mediaType`, `mediaErrors`, `otherErrors`, `powerOnHours`, `wearPercent`, `smart: { observedAt, … }`, `memberKeys: [...]`, `osDevice`, `learnCycleActive`, `nextLearnAt`, `ip`, `mac`. Agent truncates to the cap. |

### 4.2 Component keys

| Type / source | Key | Example |
|---|---|---|
| controller (vendor CLI) | `<source>:c<index>` (serial in attributes; index is stable across reboots for these tools) | `storcli:c0` |
| controller (synthetic, mdadm / zfs / storage_spaces) | `<source>:ctrl` | `mdadm:ctrl` |
| virtual_disk | `<controllerKey>:v<id>` / `mdadm:md0` / `zfs:pool:<name>` / `storage_spaces:vd:<ObjectId-hash>` | `storcli:c0:v1` |
| physical_disk (slotted) | `<controllerKey>:e<enclosure>:s<slot>` (`e-` when the tool reports no enclosure) | `ssacli:c0:e1:s3` |
| physical_disk (mdadm / zfs member) | `<vdKey>:m:<stable dev id>` (by-id / GUID, never `/dev/sdX`) | `zfs:pool:tank:m:ata-ST4000_Z1Z5` |
| physical_disk (windows_physical_disk) | `winpd:<UniqueId>` | |
| physical_disk (smartctl standalone) | `smart:<serial>` when the serial is non-blank and unique within this scan; otherwise `smart:dev:<scan type>:<device path>` (the `--scan-open` type disambiguates two probes of one path) | |
| cache_battery | `<controllerKey>:bbu` or `:cv` | `perccli:c0:cv` |
| enclosure | `<controllerKey>:enc<id>` | |
| bmc | `bmc:<source>` | `bmc:ipmi` |
| collector | `collector:<source>` | `collector:ssacli` |

### 4.3 State vocabularies and health derivation

Health is `f(state)` from the table, then raised by flags (never lowered): `predictiveFailure` → at
least `warning`; mdadm/zfs member with non-zero read/write/checksum errors → at least `warning`;
Windows `HealthStatus = Warning` → at least `warning`, `Unhealthy` → `critical`; smartctl
`smart_status.passed == false` → `critical`. These flag rules are the complete list; a parser may not
raise health for any other reason. Rank for comparisons and rollups: `critical > warning > ok >
unknown` — `unknown` never outranks an observed value, so a device with all-ok components and one
unknown rolls up `ok`, and rolls up `unknown` only when nothing observed is left.

| Type | State → health |
|---|---|
| controller | `ok`→ok · `degraded`→warning · `failed`→critical · `unknown`→unknown |
| virtual_disk | `optimal`→ok · `rebuilding` `initializing` `checking` `migrating`→warning · `degraded` `partially_degraded`→**critical** · `failed` `offline`→critical · `unknown`→unknown |
| physical_disk | `online` `hotspare` `ready` `jbod` `unconfigured`→ok · `rebuilding` `copyback` `foreign` `shielded` `predictive_failure` `degraded`→warning · `failed` `missing` `offline`→critical · `unknown`→unknown |
| cache_battery | `ok` `charging` `learning`→ok · `degraded`→warning · `failed` `missing`→critical · `unknown`→unknown |
| enclosure | `ok`→ok · `degraded`→warning · `failed`→critical · `unknown`→unknown |
| bmc | `ok`→ok · `unknown`→unknown (informational) |
| collector | `ok`→ok · `failed` `backing_off`→warning (the agent owns this vocabulary; no `unknown`) |

Every vocabulary except `collector` includes `unknown`, and `unknown` is the only legal fallback for an
unrecognized vendor string.

`degraded` on a virtual disk is critical on purpose: the array is one failure from data loss and that
is the actionable moment. Rebuilding is warning so the critical default (§9.5) does not fire during a
rebuild and does not flap when the rebuild finishes.

Vendor → normalized mapping tables are in §5.2; the plan carries them into each parser's tests.

## 5. Sources

### 5.1 Matrix

| Source | OS | Detect | Command(s) | Format | Yields | Tier | Timeout |
|---|---|---|---|---|---|---|---|
| storcli | Win, Linux | `storcli64`/`storcli` on PATH or §5.3 dirs | `/call show all J`; `/call/vall show all J`; `/call/eall/sall show all J`; `/call/cv show all J`; `/call/bbu show all J` | JSON | controllers, VDs, PDs, CV/BBU, enclosures, rebuild/init/CC progress | RAID | 30 s each |
| perccli | Win, Linux | `perccli64`/`perccli` | identical syntax to storcli | JSON | same (source tag `perccli`) | RAID | 30 s |
| megacli | Win, Linux | `MegaCli64`/`MegaCli`/`megacli` | `-AdpAllInfo -aALL`; `-LDInfo -Lall -aALL`; `-PDList -aALL`; `-AdpBbuCmd -GetBbuStatus -aALL`; `-LDPDInfo -aALL` (membership) | text | controllers, VDs, PDs, BBU | RAID | 30 s |
| ssacli | Win, Linux | `ssacli`, legacy `hpssacli`, `hpacucli` | `ctrl all show status`; `ctrl all show config detail` | text | controllers, cache/battery, arrays, logical drives, physical drives (with temps) | RAID | **60 s** (slow on Gen8) |
| arcconf | Win, Linux | `arcconf` | `GETCONFIG <n> AL` for each controller from `GETVERSION` | text | controllers, battery/ZMM, logical devices, physical devices | RAID | 30 s |
| omreport | Win, Linux | `omreport` | `storage controller -fmt ssv`; `storage vdisk -fmt ssv`; `storage pdisk controller=<id> -fmt ssv`; `storage battery -fmt ssv` | ssv | controllers, VDs, PDs (Failure Predicted), batteries | RAID (only when no Broadcom-family CLI, D12) | 60 s |
| mdadm | Linux | `/proc/mdstat` exists and lists an array | `/proc/mdstat`; `mdadm --detail /dev/mdX` | text | synthetic controller, arrays, members, resync/recovery/check progress | RAID | 15 s |
| zfs | Linux | `zpool` present and `zpool list` non-empty | `zpool list -H -o name,health,size,alloc,free`; `zpool status -pP` (or `-j` on OpenZFS ≥ 2.3 when `zpool version` allows) | text / JSON | synthetic controller, pools, vdev members, scrub/resilver progress, error counters | RAID | 30 s |
| storage_spaces | Win | any non-primordial pool | PowerShell `Get-StoragePool -IsPrimordial $false`, `Get-VirtualDisk`, `Get-PhysicalDisk` (pooled), `ConvertTo-Json -Depth 3` | JSON | synthetic controller, pools as enclosures, virtual disks, member disks | RAID | 60 s (one PowerShell) |
| windows_physical_disk | Win | always | PowerShell `Get-PhysicalDisk` + `Get-StorageReliabilityCounter` | JSON | OS-visible disks with HealthStatus / OperationalStatus, temperature, wear, error counters | disk | 60 s |
| smartctl | Win, Linux | `smartctl` | `--scan-open -j`; per device `-a -j <dev> -d <type>` (≤ 64 devices, 15 s each; Linux adds `-d megaraid,N` / `-d cciss,N` entries from `--scan-open`) | JSON | SMART overall status, temperature, power-on hours, key ATA attributes (5, 9, 187, 188, 194, 197, 198, 199), NVMe health log; **enriches** vendor-reported PDs by serial, standalone rows otherwise | disk | 15 s per device, 3 min total |
| ipmi / racadm / hponcfg (W05) | Win, Linux | `ipmitool`, `racadm`, `hponcfg` | `ipmitool lan print 1`, `ipmitool mc info`; `racadm getniccfg`, `racadm getversion`; `hponcfg -w <tmpfile>` (RIBCL config export — `-g` prints host name/serial only, not iLO network settings) | text / XML | one `bmc` component: ip, mac, firmware, vendor | RAID tier, daily | 20 s |

Both tiers run inside the same cycle when both are due; a device with no RAID source and only the
disk tier still reports on the 60-min cadence. A device where nothing but `windows_physical_disk`
is detected is the common workstation case — one PowerShell every 60 min is acceptable and it is the
only universal Windows disk-health signal.

### 5.2 Vendor state mapping

| Source | Vendor value | Normalized |
|---|---|---|
| storcli / perccli VD `State` | `Optl` · `Dgrd` · `Pdgd` · `OfLn` · `Rec` | optimal · degraded · partially_degraded · offline · rebuilding |
| storcli / perccli PD `State` | `Onln` · `GHS` `DHS` · `UGood` · `UBad` · `Rbld` · `CpyBck` · `JBOD` · `Offln` · `Msng` · `UGShld` · `UGUnsp` (unsupported drive) | online · hotspare · ready · failed · rebuilding · copyback · jbod · offline · missing · shielded · unknown |
| storcli / perccli PD flags | `Predictive Failure Count > 0` or `S.M.A.R.T alert flagged by drive: Yes` | `predictiveFailure = true` |
| storcli / perccli CV / BBU `State` | `Optimal` · `Learning` `Learn cycle active` · `Charging` · `Degraded` `Needs Attention` · `Failed` · absent | ok · learning · charging · degraded · failed · missing |
| storcli / perccli controller `Controller Status` | `Optimal` · `Needs Attention` · `Failed` | ok · degraded · failed |
| MegaCli LD `State` | `Optimal` · `Degraded` · `Partially Degraded` · `Offline` (+ `Ongoing Progresses` → rebuilding / checking / initializing with %) | optimal · degraded · partially_degraded · offline |
| MegaCli PD `Firmware state` | `Online, Spun Up` · `Hotspare, Spun Up` · `Unconfigured(good)` · `Unconfigured(bad)` · `Rebuild` · `Copyback` · `Failed` · `Offline` · `JBOD` | online · hotspare · ready · failed · rebuilding · copyback · failed · offline · jbod |
| MegaCli PD flags | `Predictive Failure Count > 0`, `Drive has flagged a S.M.A.R.T alert : Yes` | `predictiveFailure` |
| MegaCli BBU | `Battery State: Optimal` · `Learn Cycle Active: Yes` · `Battery Replacement required: Yes` / `Pack is about to fail` · `Degraded` | ok · learning · failed · degraded |
| ssacli controller | `Controller Status: OK / Failed`; `Cache Status: OK / Temporarily Disabled / Permanently Disabled`; `Battery/Capacitor Status: OK / Recharging / Failed / Not Present` | controller ok/failed (cache disabled → controller `degraded`); battery ok · charging · failed · missing |
| ssacli logicaldrive `Status` | `OK` · `Interim Recovery Mode` · `Failed` · `Recovering` `Rebuilding` `Ready for Rebuild` · `Transforming` `Queued for Expansion` · `Parity Initialization Status: In Progress` | optimal · degraded · failed · rebuilding · migrating · initializing |
| ssacli physicaldrive `Status` | `OK` · `Predictive Failure` · `Failed` · `Rebuilding` · `Erasing`; `Drive Type: Spare Drive` | online · predictive_failure · failed · rebuilding · online; hotspare |
| arcconf logical device | `Optimal` · `Degraded` `Suboptimal, Fault Tolerant` · `Failed` `Impacted` · `Rebuilding` | optimal · degraded · failed · rebuilding |
| arcconf physical device `State` | `Online` · `Hot Spare` · `Ready` · `Failed` · `Rebuilding` · `Raw (Pass Through)`; `S.M.A.R.T. warnings: N>0` | online · hotspare · ready · failed · rebuilding · jbod; predictiveFailure |
| arcconf battery / ZMM | `Optimal` · `Charging` · `Not Installed` · `Failed` | ok · charging · missing · failed |
| omreport vdisk `State` | `Ready` · `Degraded` · `Failed` · `Background Initialization` · `Resynching` `Regenerating` · `Formatting` | optimal · degraded · failed · initializing · rebuilding · initializing |
| omreport pdisk `State` / `Failure Predicted` | `Online` · `Ready` · `Failed` · `Foreign` · `Blocked` · `Non-RAID` · `Rebuilding` · `Removed`; `Failure Predicted: Yes` | online · ready · failed · foreign · offline · jbod · rebuilding · missing; predictiveFailure |
| omreport battery `State` | `Ready` · `Degraded` · `Failed` · `Charging` · `Learning` · `Missing` | ok · degraded · failed · charging · learning · missing |
| mdadm array | `clean` `active` · `degraded` (any) · `recovering` `resyncing` (progress from mdstat) · `checking` · `reshaping` · `inactive` | optimal · degraded · rebuilding · checking · migrating · failed |
| mdadm member | `active sync` · `faulty` · `spare` · `spare rebuilding` · `removed` · `writemostly` | online · failed · hotspare · rebuilding · missing · online |
| zpool pool `health` | `ONLINE` · `DEGRADED` · `FAULTED` · `OFFLINE` · `UNAVAIL` `REMOVED`; scrub/resilver in progress | optimal · degraded · failed · offline · failed; checking / rebuilding with % |
| zpool vdev member | `ONLINE` · `DEGRADED` · `FAULTED` · `OFFLINE` · `UNAVAIL` · `REMOVED`; read/write/cksum > 0 | online · degraded · failed · offline · missing · missing; health ≥ warning |
| Storage Spaces pool (→ `enclosure`) | `HealthStatus` Healthy · Warning · Unhealthy · Unknown | ok · degraded · failed · unknown |
| Storage Spaces virtual disk | `OperationalStatus` `OK` · `InService` · `Degraded` · `Detached` · `Incomplete` · `No Redundancy`; then `HealthStatus` Healthy · Warning · Unhealthy · Unknown | optimal · rebuilding · degraded · offline · degraded · degraded; HealthStatus raises health only (§4.3 flag rules) |
| Storage Spaces / Windows physical disk | `OperationalStatus` `OK` · `Predictive Failure` · `Lost Communication` · `Transient Error` · `Starting`; `Usage: HotSpare` · `Retired`; then `HealthStatus` Healthy · Warning · Unhealthy | online · predictive_failure · missing · degraded · online; hotspare · offline; HealthStatus only raises health (Warning → at least warning, Unhealthy → state `failed`) |
| smartctl | `smart_status.passed: false` or exit bit 3 | state `predictive_failure`, `predictiveFailure = true`, health **critical** |
| smartctl | NVMe `critical_warning != 0` (the drive's own flag) | `predictiveFailure = true` (health warning) |
| smartctl | ATA attributes 5 / 9 / 187 / 188 / 194 / 197 / 198 / 199 raw values, NVMe `percentage_used`, `media_errors`, `unsafe_shutdowns` | **data only** in `attributes.smart` — no health effect in v1 (prediction is #3866's job) |

Anything not in the table maps to `unknown` with `stateDetail` carrying the raw string, and the
parser test suite includes one "unrecognized state" fixture per source.

### 5.3 Well-known tool locations

Detection is `exec.LookPath` first, then these directories, then the agent-local override (§6.6).

- Linux: `/opt/MegaRAID/storcli/`, `/opt/MegaRAID/perccli/`, `/opt/MegaRAID/MegaCli/`, `/usr/sbin`,
  `/usr/local/sbin`, `/opt/smartstorageadmin/ssacli/bin/`, `/usr/Arcconf/`, `/usr/StorMan/`,
  `/opt/dell/srvadmin/bin/`, `/opt/dell/srvadmin/sbin/`, `/usr/bin`.
- Windows: `%ProgramFiles%\Dell\SysMgt\oma\bin\`, `%ProgramFiles%\Dell\SysMgt\iDRAC Tools\`,
  `%ProgramFiles%\Smart Storage Administrator\ssacli\bin\`, `%ProgramFiles%\Compaq\Hpacucli\Bin\`,
  `%ProgramFiles(x86)%\...` equivalents, `%ProgramFiles%\Adaptec\maxView Storage Manager\`,
  `%ProgramFiles%\smartmontools\bin\`, `C:\storcli\`, `C:\perccli\`, `C:\MegaCli\`.

Detection results are cached for one hour; a source whose binary disappears mid-run reports `failed`,
not `unavailable`, until the next detection pass.

## 6. Agent design

Package `agent/internal/collectors/hwhealth/`. One file per source, one fixture directory per source.

### 6.1 Interface

```go
type Source interface {
    Name() Kind                       // storcli, ssacli, …
    Tier() Tier                       // TierRAID | TierDisk
    Detect(ctx context.Context) Availability   // Available{Path, Version} | Unavailable
    Collect(ctx context.Context, avail Availability) (Result, error)
}

type Result struct {
    Components []Component
    Complete   bool          // false when the tool ran but a sub-command failed or output was truncated
    Warnings   []string      // parser notes, surfaced in the sources footer
    ToolVersion string
}
```

`Collect` never returns a partial `Complete: true`. If `/call/eall/sall show all J` fails after
`/call show all J` succeeded, the result is `Complete: false` with the controllers it did parse.
**Contract:** whatever a source did parse is upserted as an observation (it is real state); `Complete:
false` only withholds the right to stale-mark that source's components (§7.3). For smartctl,
`Complete` is false whenever any device from `--scan-open` failed to open or timed out — a disk that
merely went unreadable must not stale its own row.

### 6.2 Runner

`command_limits.go`'s helpers are unexported, create their own background context, and discard stdout
on non-zero exit (`runCollectorBoundedOutput`, ~line 176/209). smartctl and MegaCli use the exit code
as *data* (smartctl bits 3–7 mean "disk failing / attributes tripped / error log has entries", not
"command failed"). The package gets one context-aware runner:

```go
type execResult struct { Stdout, Stderr []byte; ExitCode int; Truncated bool; Duration time.Duration }
func runTool(ctx context.Context, timeout time.Duration, path string, args ...string) (execResult, error)
```

`err` is non-nil only for spawn failure, timeout or output overflow; a non-zero exit returns
`ExitCode` with stdout intact and the source decides. Output cap 4 MB (a 60-bay JBOD `show all J` is
~1 MB). `cmd.WaitDelay` set as the existing helpers do. Extract it into `collectors` so the existing
helpers can move onto it later; do not change their behaviour in this feature.

smartctl exit bits: bit 0 (cmdline), bit 1 (device open failed), bit 2 (SMART command failed /
checksum) → probe failure for that device (no row). Bits 3–7 → parse the JSON as data.

### 6.3 Scheduling

- Two tick gates in the heartbeat loop (`heartbeat.go` `Start`, same shape as `lastHardwareUpdate`):
  `hwRaidDue` (default 10 min) and `hwDiskDue` (default 60 min). Intervals come from
  `applyHardwareMonitoringConfig` (§10); `enabled=false` skips both and sends one `disabled` snapshot
  so the UI can say so.
- Single-flight: a cycle that is still running when the next gate fires is skipped, not queued.
- Jitter: ± 10 % of the interval, seeded per device, so 10 000 agents do not hit the API in lockstep.
- Cycle budget: 4 min total; sources run sequentially (vendor CLIs contend for the controller), each
  under its own timeout from §5.1; the cycle context is cancelled at the budget and remaining sources
  report `failed: budget exceeded`. Fairness: when a cycle hits the budget, the next cycle starts
  from the first source that did not run, so one slow tool cannot starve the same sources every time.
- Tracked for graceful shutdown by explicit `inventoryWg.Add(1)` / `Done()` around the cycle goroutine
  (mirror `sendInventory`, `heartbeat.go` ~2220 — the hardware-identity goroutine at ~2482 is untracked
  and is not the pattern to copy).
- First run: 60 s after start (after the hardware-identity collector), so a freshly enrolled server
  shows RAID state within a minute.

### 6.4 Circuit breaker

Per source: 3 consecutive `failed` results → `backing_off` for 6 h (re-probe once per 6 h; one success
closes the breaker). A source in backoff is still reported in the snapshot's `sources` array with its
status and last error, and its components are left untouched server-side (D4). `unavailable` (not
installed) never trips the breaker.

### 6.5 Identity merging and suppression

- smartctl enrichment attaches to a vendor-reported PD **only** when the serial is non-blank and
  matches exactly one vendor PD in this snapshot; otherwise smartctl emits its own row (§4.2 key).
  Enrichment copies `temperatureC`, `predictiveFailure` (OR), and `attributes.smart` (with
  `observedAt`).
- **Tier replay.** smartctl runs on the 60-min tier but vendor PD rows are re-sent every 10 min. The
  agent caches the last smartctl result per serial for up to 2 × `diskHealthIntervalMinutes` and
  replays it into every RAID-tier snapshot, so a RAID-only snapshot never clears SMART-derived
  fields. Consequence, accepted: a SMART flag observed once reaches `consecutiveSnapshots = 2` on
  the next RAID snapshot — a drive's own failed self-assessment does not need a second observation.
  When the cache expires without a fresh SMART result the enrichment fields are sent as `null` and
  `attributes.smart` is dropped (the server overwrites; SMART evidence is never older than 2 h).
- `windows_physical_disk` rows whose serial matches a vendor PD are dropped (the vendor row wins);
  rows whose model matches a RAID virtual-disk pattern (`PERC`, `LOGICAL VOLUME`, `Virtual Disk`,
  `MR9`, `Smart Array`, `RAID`) when a vendor source reported ≥ 1 VD are sent with `alertExempt:
  true` and `attributes.backedByVd = true`, shown under "OS-visible disks", and skipped by the alert
  handler (§9.3).
- Blank or duplicate serials never merge (Codex: "blank or duplicate serials are insufficient").
- Broadcom-family precedence (D12) is applied at detection: if storcli is available, perccli and
  MegaCli are marked `superseded` and omreport's storage commands are skipped (its battery output is
  not needed — storcli reports the BBU/CV).

### 6.6 Agent-local override

`hardware.tool_dirs: []string` in the agent config file (same mechanism as other agent-local knobs,
not policy-delivered) adds directories to §5.3. Documented for the "admin unzipped storcli to
`D:\tools`" case. No UI.

### 6.7 Snapshot payload

```jsonc
PUT /api/v1/agents/:agentId/hardware-health         // requireAgentRole (main agent only), bodyLimit 2 MB
{
  "snapshotId": "uuid",
  "sequence": 1287,                 // monotonic, persisted in the agent state dir
  "collectedAt": "2026-09-23T18:40:12Z",
  "agentVersion": "0.117.0",
  "pollIntervalMinutes": 10,        // effective RAID-tier interval (policy-resolved) — drives freshness windows server-side
  "diskHealthIntervalMinutes": 60,  // effective disk-tier interval
  "tiersRun": ["raid", "disk"],     // or ["none"] for the daily nothing-detected snapshot, ["disabled"] when policy-disabled
  "sources": [
    { "source": "storcli", "status": "ok", "complete": true, "toolVersion": "007.2807.0000.0000", "path": "/opt/MegaRAID/storcli/storcli64", "durationMs": 812 },
    { "source": "smartctl", "status": "ok", "complete": true, "toolVersion": "7.4", "durationMs": 4102, "warnings": ["/dev/sdc: open failed (exit 2)"] },
    { "source": "ssacli", "status": "unavailable" },
    { "source": "megacli", "status": "superseded" },
    { "source": "omreport", "status": "backing_off", "error": "exit 255: OMSA service not running", "retryAt": "…" }
  ],
  "components": [ { /* §4.1 record, camelCase, WITHOUT `health`; no `collector` rows */ } ]
}
```

`sources[].status ∈ ok | unavailable | superseded | failed | backing_off | disabled`. Limits: ≤ 2 000
components, `attributes` ≤ 8 KB each. Response `200 {accepted: true}`, `409` on ordering rejection
(§7.1), `413` on limits, `422` on schema failure (logged with the offending path, not swallowed).

## 7. Ingest contract

`apps/api/src/routes/agents/hardwareHealth.ts` → `services/hardwareHealth/ingest.ts`. One transaction per
snapshot, `SELECT … FOR UPDATE` on the device's `device_hardware_health` row (created on first
snapshot) as the per-device lock — two concurrent snapshots from a restarted agent serialize instead
of interleaving.

### 7.1 Ordering

Accept when `sequence > last_agent_sequence`. When `sequence <= last_agent_sequence` (agent state dir
wiped): accept **only if** the server's receipt time is more than 1 h after `last_received_at` (server
clock on both sides — the agent's `collectedAt` is stored for display but never trusted for ordering)
and reset the stored sequence; otherwise `409 {error: 'stale_snapshot'}` and the agent discards (no
retry — the next cycle sends a newer one).

### 7.2 Upsert and events

For each component in the snapshot (from every source with `status: ok`, whether or not `complete`):

- Upsert `ON CONFLICT (device_id, component_key)`. Compare against the previous row:
  - first insert → event `first_seen`
  - `health` changed → `health_changed`
  - `state` changed → `state_changed`
  - `physical_disk` serial changed (both non-blank) → `disk_replaced` (detail: old/new serial, model)
  - `predictiveFailure` false→true / true→false → `predictive_failure_set` / `_cleared`
- Streaks (D5) — five counters, each "consecutive accepted snapshots in which the predicate held",
  reset to 0 the first snapshot it does not hold, all left unchanged when `health = unknown`:
  `unhealthy_streak` (health ≥ warning), `critical_streak` (health = critical), `healthy_streak`
  (health = ok), `below_critical_streak` (health < critical, i.e. ok or warning),
  `predictive_streak` (`predictiveFailure`). §9.3 reads them per rule threshold so a warning history
  never satisfies a critical rule's count. `last_seen_at = server receipt time`, `stale = false`,
  `stale_since = NULL`.

### 7.3 Staleness (D4)

For each source with `status: ok` **and** `complete: true`: components of that source not present in
the snapshot → `stale = true`, `stale_since = now` (first time only), event `stale`. Stale rows are
excluded from alert evaluation and rollup, shown greyed in the UI, and deleted by the reaper after
7 days stale (event `removed`). Sources reporting `failed`, `backing_off`, `unavailable`, `superseded`,
`disabled`, or `complete: false` never stale-mark anything; the components a `complete: false` source
did parse are still upserted (§7.2), everything else of that source stays exactly as it was.

**Early retirement (#6895).** A stale row whose health is warning/critical (or predictive) has its
open alerts retired at ingest, through the reaper's retirement path, without waiting 7 days, when a
complete answer from the same source shows the row's `parent_key` component and every live
same-source row beneath that parent healthy (`healthy_streak ≥ 2`, no predictive failure). A stale
row with no parent is never retired early — a standalone disk that vanished is itself a fault.

**Freshness is per component, not per device.** A component whose `last_seen_at` is older than
3 × its tier's effective interval (`poll_interval_minutes` for RAID-tier sources,
`disk_health_interval_minutes` for `windows_physical_disk` / standalone `smartctl`; both stored on
`device_hardware_health` from the payload) is `unknown` to the alert handler (§9.3) and shown as
"not seen since …" in the UI. A failing source therefore goes unknown on its own schedule while the
other sources stay fresh, and a whole device that stops reporting goes unknown without being staled.

### 7.4 Collector components

For each source with status `failed` or `backing_off`, upsert `collector:<source>` with state
`failed` / `backing_off` (health warning), `stateDetail` = error, streaks maintained like any
component. Status `ok` upserts it back to `ok`. `unavailable`, `superseded`, `disabled` delete the
collector row if present (an uninstalled tool is not a fault). The "collector failing" default monitor
(§9.5) reads these rows.

### 7.5 Rollup

`device_hardware_health` gets: `health` = worst (§4.3 rank) of non-stale components **excluding**
`collector` and `bmc` rows; `collector_health` = worst collector row (`ok` when none); `summary` jsonb =
counts by `(componentType, health)` plus controller names, for the device-list tooltip; `sources`
jsonb = the snapshot's `sources` array verbatim (excludedOpen); `last_agent_sequence`,
`last_snapshot_id`, `last_collected_at` (agent clock, display only), `last_received_at` (server
clock), `last_raid_received_at` / `last_disk_received_at` (per tier, from `tiersRun`),
`poll_interval_minutes`, `disk_health_interval_minutes`, `tiers_run`, `agent_version`, `updated_at`.

### 7.6 BMC component

W01 stores `bmc` components like any other. W05 adds the ingest hook that hands a `bmc` component
with `attributes.mac` to §12's auto-link inside the same transaction (idempotent).

## 8. Schema and tenancy

All three tables are **shape 5, hot agent-write, denormalized `org_id`** (CLAUDE.md tenancy table).
Composite FK `(device_id, org_id) → devices(id, org_id)` **`DEFERRABLE INITIALLY IMMEDIATE`**, RLS
enabled + forced with the four `breeze_has_org_access(org_id)` policies (template:
`apps/api/migrations/2026-09-28-100000-agent-health-observations.sql`, but `INITIALLY IMMEDIATE` per
CLAUDE.md, not that file's `INITIALLY DEFERRED`).

### 8.1 Tables

**`device_hardware_components`** — `id uuid pk`, `device_id`, `org_id`, `component_key text`,
`component_type hardware_component_type`, `parent_key text null`, `source hardware_source`, `name text`,
`model text null`, `serial text null`, `firmware text null`, `size_bytes bigint null`,
`health hardware_health`, `state text`, `state_detail text null`, `progress_percent smallint null`,
`temperature_c smallint null`, `predictive_failure boolean not null default false`,
`alert_exempt boolean not null default false`, `attributes jsonb not null default '{}'`,
`unhealthy_streak`, `critical_streak`, `healthy_streak`, `below_critical_streak`,
`predictive_streak` (all `int not null default 0`), `stale boolean not null default false`,
`stale_since timestamptz null`, `first_seen_at`, `last_seen_at`, `created_at`, `updated_at`.
UNIQUE `(device_id, component_key)`; index `(device_id, component_type) WHERE NOT stale`;
index `(org_id, health) WHERE NOT stale AND health IN ('warning','critical')`.

**`device_hardware_events`** — `id uuid pk`, `device_id`, `org_id`, `component_key`, `component_type`,
`event_type hardware_event_type` (`first_seen | health_changed | state_changed | disk_replaced |
predictive_failure_set | predictive_failure_cleared | stale | removed`), `from_health null`,
`to_health null`, `from_state null`, `to_state null`, `detail jsonb not null default '{}'`,
`snapshot_id uuid null`, `occurred_at timestamptz` (= snapshot `collectedAt`), `created_at`.
Index `(device_id, occurred_at desc)`. Not immutability-triggered (ordinary rows; the reaper deletes
past 180 days), so it does **not** join `AUDIT_ADMIN_REQUIRED_TABLES`.

**`device_hardware_health`** — `device_id uuid pk`, `org_id`, `health hardware_health not null default
'unknown'`, `collector_health hardware_health not null default 'ok'`, `summary jsonb`, `sources jsonb`,
`last_agent_sequence bigint not null default 0`, `last_snapshot_id uuid null`, `last_collected_at
timestamptz null`, `last_received_at timestamptz null`, `last_raid_received_at timestamptz null`,
`last_disk_received_at timestamptz null`, `poll_interval_minutes int null`,
`disk_health_interval_minutes int null`, `tiers_run text[] not null default '{}'`, `agent_version
text null`, `created_at`, `updated_at`. Index `(org_id, health)`.

Enums: `hardware_component_type`, `hardware_source`, `hardware_health`, `hardware_event_type` (§4).

### 8.2 Migrations

Named after the committed ceiling (`2026-10-26-160100-…` as of 2026-09-23; re-check before writing):

1. `2026-10-27-100000-hardware-health-enums-and-tables.sql` — enums, three tables, FKs, RLS, indexes.
2. `2026-10-27-100100-hardware-health-config-feature.sql` — `ALTER TYPE config_feature_type ADD VALUE
   'hardware_monitoring'` + `config_policy_hardware_monitoring_settings` (§10). ADD VALUE is safe in
   one file only because nothing in the file writes a row with the new label (pattern:
   `2026-10-16-181300-monitor-coverage-kinds.sql`).
3. `2026-10-27-100200-monitor-kind-hardware-health.sql` — `ALTER TYPE monitor_kind ADD VALUE
   'hardware_health'` only.
4. `2026-10-27-100300-alert-subject-key.sql` — §9.1 (separate file so the enum value above is committed).
5. W05 adds `ALTER TYPE discovered_asset_link_source ADD VALUE 'agent_report'` in its own file, named
   after the ceiling at that time.

Built-in monitor defaults need no migration (provisioning runs from code at boot and on partner
creation). All files idempotent, no inner `BEGIN`, system scope elected before any DML.

### 8.3 Registrations (the step that gets missed)

| Table | `CORE_ORG_CASCADE_DELETE_ORDER` | `CORE_DEVICE_CASCADE_DELETE_TABLES` | `CORE_DEVICE_ORG_DENORMALIZED_TABLES` | `orgMergeRegistry` | `CORE_TENANT_EXPORT_POLICY` |
|---|---|---|---|---|---|
| `device_hardware_components` | yes (`localeCompare` order: `device_hardware_components` < `device_hardware_events` < `device_hardware_health`) | yes | yes | `repoint` | `included` for typed columns; `attributes` **excludedOpen** |
| `device_hardware_events` | yes | yes | yes | `repoint` | `detail` **excludedOpen** |
| `device_hardware_health` | yes | yes | yes | `repoint` | `summary`, `sources` **excludedOpen** |
| `config_policy_hardware_monitoring_settings` | no `org_id` — not in the cascade/export/merge lists (deleted through the feature-link FK cascade, like `config_policy_event_log_settings`) — **but it still needs parent-chain RLS**: enable + force + policies through `config_policy_feature_links → configuration_policies` exactly as `2026-07-26-a-normalized-policy-tenant-integrity.sql` (~302) does for the event-log settings table, and a `['config_policy_hardware_monitoring_settings', ['configuration_policies']]` entry in `PARENT_FK_JOIN_POLICY_TABLES` next to the event-log one in `rls-coverage.integration.test.ts` (~920). The three `device_hardware_*` tables carry a real `org_id` and are auto-discovered as shape 1 — no allowlist entry for them | — | — | — | — |
| `alerts.subject_key` (new column on a registered table) | — | — | — | — | `included` |

No FK between the three new tables (events reference `component_key` textually) so alphabetical order
satisfies children-before-parents trivially; the FK to `devices` is the only edge and `devices` sorts
after all three.

### 8.4 Retention

Extend the existing scheduled retention job (plan locates it; the alert-suppression reaper and
`deviceEventLogs` retention are the precedents) with: events older than 180 days; components
`stale_since < now() - 7 days`.

### 8.5 Follow-on constraint

BMC-sourced components (`source ∈ redfish | snmp`) will be written against the **server** device
(`device_id` = the linked agent device), keyed `redfish:<…>`, by a server-side poller rather than the
agent. The ingest service therefore takes a `writer: 'agent' | 'server'` argument from day one, the
per-source staleness rule already isolates sources from each other, and ordering is per writer: the
agent owns `last_agent_sequence`; the follow-on adds its own `last_server_sequence` column and never
touches the agent's. Nothing else in this spec needs to change for the follow-on.

## 9. Alerting

### 9.1 `subject_key` (D6, D7)

Schema: `ALTER TABLE alerts ADD COLUMN IF NOT EXISTS subject_key text;` and

```sql
CREATE UNIQUE INDEX IF NOT EXISTS alerts_open_rule_device_subject_uidx
  ON alerts (rule_id, device_id, COALESCE(subject_key, ''))
  WHERE rule_id IS NOT NULL AND status IN ('active', 'acknowledged', 'suppressed');
```

`subject_key` carries `CHECK (subject_key <> '')` — empty is never a legal value, so the index's
`COALESCE(subject_key, '')` maps exactly one value (NULL) to `''`, and the dedupe lookup below uses the
same identity.

Before creating the index the migration resolves pre-existing duplicate open alerts per
`(rule_id, device_id)` **among rows with `subject_key IS NULL` only** (keep newest, resolve older with
note `deduplicated by migration`) inside a `DO $$ … GET DIAGNOSTICS … RAISE WARNING 'resolved %
duplicate open alerts' $$` block, system scope elected first. Restricting to NULL subjects keeps the
file idempotent after subject alerts exist. Sourced alerts (`rule_id IS NULL`) are outside the index.

Service changes (`apps/api/src/services/alertService.ts`):

- `createAlert(params)` takes optional `subjectKey`. Dedupe query adds `subject_key IS NOT DISTINCT FROM
  $subjectKey`; the insert uses index inference on the partial index —
  `ON CONFLICT (rule_id, device_id, COALESCE(subject_key, '')) WHERE rule_id IS NOT NULL AND status IN (…) DO NOTHING`
  — and treats "no row inserted" as the dedupe outcome (read-then-insert alone is not enough under
  concurrency). Postgres infers the partial index from that exact expression + predicate; Drizzle's
  `onConflictDoNothing` accepts column targets only, so this one insert is written with the `sql`
  template. Cooldown, flapping and `recordStateTransition` keys become `${ruleId}:${deviceId}` +
  (`:${subjectKey}` when present) — the Redis key helpers gain the optional segment; existing keys
  are unchanged when it is absent.
- `ConditionResult` gains `subjects?: SubjectEvidence[]` with
  `SubjectEvidence = { subjectKey: string; status: 'breaching' | 'recovered' | 'unknown'; description: string; actualValue?: number; context?: Record<string, unknown> }`.
  `evaluateConditions` (`alertConditions/index.ts`) propagates `subjects` **only** when the root is a
  single leaf; a group drops them (and `hardware_health` is not in `SERVER_EVALUATED_MONITOR_KINDS`,
  so it cannot be a composite child).
- In `evaluateDeviceAlerts` (the `alert_rules` sweep — monitors compile into `alert_rules` via
  `managedByMonitorId`, so the config-policy path `evaluateDeviceAlertsFromPolicy` is **not** made
  subject-aware; alerting-consolidation W05d retires it anyway), when `subjects` is present:
  1. for each `breaching` subject → `createAlert({…, subjectKey})`;
  2. for each open alert of `(rule, device)` with `subject_key` set: its subject `recovered` →
     `resolveAlert` when the rule's `autoResolve` is on (the existing override/template flag at
     ~482 is honoured; custom `autoResolveConditions` are ignored for subject alerts — the monitor
     editor does not offer them for this kind), status ∈ `RESOLVABLE_ALERT_STATUSES`, and not
     `requiresHuman`; `unknown` or absent → untouched; `breaching` → untouched;
  3. the **episode observation** is computed after steps 1–2, not from `result.triggered`: `breach`
     when any subject alert for `(rule, device)` is still open; else `unknown` when any in-scope
     subject was `unknown` or `dataAvailable` was false; else `ok`. This is what closes the episode
     (`episodeService.ts` ~144 closes on `ok`), so an episode can never close while a subject alert
     is open.
  `checkAutoResolve(alertId)` returns early for alerts with a `subject_key` (they are resolved only
  by this path), so a device-level `passed: false` can never resolve a subject alert.
- Episodes: the open episode for `(monitor, device)` is reused; `episode.alert_id` is set by the first
  alert and **not overwritten** by later subject alerts (`episodeService.ts` ~367 gains a guard);
  later alerts carry `episode_id` only. Recurrence counting and `requiresHuman` escalation stay
  per episode.
- Responses (D7) are owned by the episode, the one atomic seam that already exists
  (`monitor_episodes_open_uidx`): automations/scripts compiled for the rule run only for the alert
  whose id equals `episode.alert_id`. Two subjects created in the same sweep, or by two concurrent
  sweeps, cannot both own it. Transport: the `alert.triggered` event payload (~272) gains
  `subjectKey` and `responsesOwner: boolean`; `jobs/automationWorker.ts` (~576, where it already
  reads `monitorDeviceState.responsesPaused`) skips a monitor-managed automation when
  `responsesOwner === false`. Notification delivery is unaffected — every subject alert notifies.
- Retirement: while a subject is merely stale or unknown its alert stays open. When the reaper
  removes a component (7 days stale, §7.3) or the device is deleted, open subject alerts for that
  `component_key` are resolved with note `component no longer reported`.
- Alert `context` for subject alerts: `{ source: 'hardware_health', subjectKey, componentType,
  componentKey, componentLabel, stateLabel, name, model, serial, state, stateDetail, health, slot,
  controller, predictiveFailure }` — `componentLabel` ("Physical disk 252:3 (ST4000NM0023
  Z1Z5ABCD)") and `stateLabel` ("failed") are the two the templates in §9.2 use;
  `packages/shared/src/utils/alertTemplate.ts` already resolves arbitrary context keys.

### 9.2 `hardware_health` monitor kind

`packages/shared/src/validators/monitors.ts` — add `'hardware_health'` to `MONITOR_KINDS` (not to
`SERVER_EVALUATED_MONITOR_KINDS`), and

```ts
hardware_health: z.object({
  componentTypes: z.array(z.enum(['controller','virtual_disk','physical_disk','cache_battery','enclosure','collector'])).min(1),
  minHealth: z.enum(['warning', 'critical']),
  includePredictiveFailure: z.boolean().default(true),
  consecutiveSnapshots: z.number().int().min(1).max(10).default(2),
})
```

`apps/api/src/services/monitors/kinds/hardwareHealth.ts` — `MonitorKindSpec`: `overridableKeys:
['minHealth','includePredictiveFailure','consecutiveSnapshots']`, `defaultSeverity: 'high'`,
`agentDelivered: false`, `alertCategory: 'hardware'`, `titleTemplate: '{{componentLabel}} {{stateLabel}} on {{deviceName}}'`,
`messageTemplate: '{{ruleName}}: {{componentLabel}} is {{stateLabel}} ({{stateDetail}})'`,
`toAlertCondition → { type: 'hardware_health', componentTypes, minHealth, includePredictiveFailure, consecutiveSnapshots }`.
Registered in `kinds/index.ts`, the DB enum (§8.2 file 3, labels appended in database order), and
`apps/web/src/components/monitoring/monitorKindFields.ts` + `defaultConditionFor`. `FieldKind` there
has no multi-select today (`number | text | select | operator | script | boolean`); this kind adds a
`multiselect` field kind rendered as a checkbox group for `componentTypes`, plus a select for
`minHealth`, a boolean and a number.

### 9.3 Handler

`apps/api/src/services/alertConditions/handlers/hardwareHealth.ts`, registered in
`alertConditions/index.ts` (~34, where every handler is registered):

1. Load `device_hardware_health`; if absent → `{ passed: false, dataAvailable: false, subjects: [] }`.
2. Load non-stale, non-`alert_exempt` components with `component_type ∈ componentTypes`.
3. Per component, with `N = consecutiveSnapshots` and freshness per §7.3 (a component whose
   `last_seen_at` is older than 3 × its tier's interval is `unknown` regardless of the rest):
   - `minHealth = warning`: `breaching` when `unhealthy_streak ≥ N` or (`includePredictiveFailure`
     and `predictive_streak ≥ N`); `recovered` when `healthy_streak ≥ N` and not `predictive_failure`;
     otherwise `unknown`.
   - `minHealth = critical`: `breaching` when `critical_streak ≥ N` or (`includePredictiveFailure`
     and `predictive_streak ≥ N`); `recovered` when `below_critical_streak ≥ N` and not
     `predictive_failure` — so a degraded array that moved to `rebuilding` resolves the critical alert
     after N snapshots, and a rebuilding array under a critical rule is simply never breaching;
     otherwise `unknown`.
   - `health = unknown` → `unknown`.
   `unknown` therefore also covers "unhealthy but the streak is not there yet" and "healthy but not
   yet for N snapshots", so neither a one-poll blip nor a one-poll recovery moves an alert.
4. `passed = any breaching`; `dataAvailable = false` when there were no components in scope at all;
   `description` summarizes counts; `subjects` lists every component in scope.

### 9.4 Web

- `monitorKindFields.ts` entry (above); the Monitors editor renders it like any kind.
- Alert inbox rows already show title/message; the subject context renders in the existing
  alert-detail context panel with no new component.

### 9.5 Built-in defaults (D9)

`BUILT_IN_MONITORS_VERSION = 3`; `BuiltInMonitorDefault.condition` widens to a per-kind union and
`key` to include the four below; `severity` widens to include `'low'`.

| key | name | componentTypes | minHealth | predictive | consecutive | severity | cooldown |
|---|---|---|---|---|---|---|---|
| `raid_array_degraded` | RAID array degraded or failed | `virtual_disk`, `controller` | critical | false | 2 | critical | 60 |
| `physical_disk_failed` | Physical disk failed or predicted to fail | `physical_disk` | critical | true | 2 | high | 60 |
| `cache_battery_problem` | Controller cache battery problem | `cache_battery` | warning | false | 3 | medium | 240 |
| `hardware_collector_failing` | Hardware monitoring tool failing | `collector` | warning | false | 3 | low | 1440 |

Not attached to any policy. "Rebuild in progress" is deliberately not a default (a tech authors
`virtual_disk` / `warning` if they want it).

## 10. Configuration-policy feature `hardware_monitoring` (D10)

Pattern B, mirroring `event_log` end-to-end:

- `CONFIG_FEATURE_TYPES` + Drizzle `configFeatureTypeEnum` (+ migration §8.2 file 2). Partner-wide
  allowed (not in `ORG_SCOPED_ONLY_FEATURE_TYPES`); not in `PARTNER_LINKABLE_FEATURE_TYPES` (no
  linked table).
- Table `config_policy_hardware_monitoring_settings`: `id`, `feature_link_id` (unique, FK cascade),
  `enabled boolean default true`, `poll_interval_minutes int default 10 CHECK 5..60`,
  `disk_health_interval_minutes int default 60 CHECK 15..1440`, `created_at`, `updated_at`.
- `configurationPolicy.ts`: decompose / assemble / validate branches at each `case 'event_log'` site
  (~875, 1167, 1215, 1422) plus the reference-validation switch (~2973). Shared Zod inline schema
  `hardwareMonitoringInlineSettingsSchema`.
- Agent delivery: `resolveDeviceHardwareMonitoringSettings` + Redis-cached
  `getDeviceHardwareMonitoringSettings` (`hwmon:settings:device:${deviceId}`, same 120 s TTL as
  `EVENT_LOG_CACHE_TTL_SECONDS`; event log has no write-side invalidation and neither does this — a
  change reaches the agent within TTL + one heartbeat and takes effect at its next tick gate, worst
  case ≈ 2 min + one poll interval, accepted) and `buildHardwareMonitoringConfigUpdate` in
  `routes/agents/helpers.ts`, resolved inside the existing post-scoped `withSystemDbAccessContext`
  block in `heartbeat.ts` (~2054, where event-log / monitoring / PAM / patch-source settings are
  built) and merged into the final `configUpdate` assembly (~2150) — **not** into
  `mergedConfigUpdate` (~1702), which deliberately excludes policy readers (#1105 / #2930). No extra
  pool connection per heartbeat (see the 09-22 US pool deadlock). No policy link → defaults are
  still sent (so a removed policy resets the agent); resolver failure → key omitted (agent keeps its
  last config).
- Agent: `applyHardwareMonitoringConfig` under key `hardware_monitoring` in `applyConfigUpdate`
  (snake_case and camelCase accepted like the others).
- Web: `HardwareMonitoringTab.tsx` (`FeatureTabShell` + `useFeatureLink`), `FEATURE_META`,
  `ConfigPolicyDetailPage` wiring, Effective Config tab parity. Three controls: enabled switch, RAID
  poll interval, disk health interval. Copy explains what is probed.

## 11. Web UI, AI tool, docs

### 11.1 Device Hardware tab

New `apps/web/src/components/devices/hardware/StorageHealthSection.tsx` rendered by
`DeviceHardwareInventory.tsx` above the existing disk table (keeps that file under 500 lines), fetching
`GET /devices/:id/hardware-health` (`routes/devices/hardwareHealth.ts` → `{ health, collectorHealth,
lastSnapshotAt, pollIntervalMinutes, sources[], components[], events[] (latest 50) }`) with
`fetchWithAuth`.

- **Header**: rollup pill (inline `success/warning/destructive` pill idiom), "Collected 4 min ago",
  policy state ("disabled by policy" when applicable).
- **Per controller card** (`controller` rows, then the synthetic md/zfs/Storage Spaces ones): name,
  model, serial, firmware, cache-battery pill (from its `cache_battery` child), enclosure count.
  - Virtual disks table: name · RAID level · size · state pill · progress bar when `progressPercent`.
  - Physical disks table: slot · model · serial · media/interface · size · state pill (predictive icon
    when flagged) · temp · media/other errors · power-on hours. Stale rows greyed with "not seen
    since …".
- **OS-visible disks** group: `windows_physical_disk` and standalone `smartctl` rows (`backedByVd`
  rows collapsed under a "backed by RAID virtual disk" note).
- **Management controller** card (W05): vendor, firmware, IP (link to the linked discovered asset
  page when linked), MAC.
- **Sources footer**: one chip per source: `ok 12:31 (v7.4)`, `not installed` (with docs link),
  `failing: <error>`, `backing off until …`, `superseded by storcli`.
- **Events** (collapsible): time · component · transition, from `events`.
- **Empty states**: "No RAID or disk-health tooling detected — probed: storcli, perccli, …" with the
  docs link; "Hardware monitoring is disabled by policy <policy name>".
- `data-testid` on the section, each controller card, each state pill, the sources footer.

### 11.2 Device list

`columnVisibility.ts`: new `hardwareHealth` column (opt-in, hidden by default), rendered as the pill
with `summary` counts in the tooltip; filter `hardwareHealth ∈ warning | critical | unknown`. The
device-list API projection joins `device_hardware_health.health` (plan verifies the list route's
projection and its test).

### 11.3 AI tool and MCP coverage

`aiToolsDevice.ts`: `get_device_hardware_health` (tier 1, `domain: 'devices'`, `deviceArgs:
['deviceId']`, `searchHint`), returns the same shape as the GET route via `verifyDeviceAccess`.
`mcpCoverage.ts`: `'agents/hardwareHealth.ts': { exempt: 'agent_transport' }`,
`'devices/hardwareHealth.ts': { tools: ['get_device_hardware_health'] }`.

### 11.4 Docs

`apps/docs/src/content/docs/features/hardware-monitoring.mdx` (the customer-facing "Monitoring &
Alerting" sidebar group in `apps/docs/astro.config.mjs` ~119–143 — `monitoring/*` slugs are the
self-hosting observability docs, not feature docs): what is monitored, the §5.1 matrix as a
supported-tools table with per-vendor install pointers (perccli/OMSA for Dell, ssacli for HPE, storcli
for Lenovo/Broadcom, arcconf for Adaptec/Microchip, smartmontools), the policy feature, the four
built-in monitors and how to attach them, the alert semantics (per component, resolves on recovery,
rebuild = warning), and the agent-local `tool_dirs` override.

## 12. BMC in-band facts and auto-link (W05, D14)

- Agent source `bmc` (RAID tier, but only once per 24 h): tries `ipmitool lan print 1` + `ipmitool mc
  info` (Linux and Windows when installed), then Dell `racadm getniccfg` + `racadm getversion`, then
  HPE `hponcfg -w <tmpfile>` (RIBCL export; `-g` prints host info only). Emits one `bmc` component: `name` "iDRAC" / "iLO" / "XClarity Controller" /
  "BMC", `firmware`, `source` = `ipmi` / `racadm` / `hponcfg`, `attributes: { ip, mac, vendor }`, health `ok`. No credentials involved
  (in-band IPMI over the KCS interface needs none).
- API (the W05 ingest hook, §7.6): link the `discovered_assets` row in the **same org** whose MAC
  matches and whose `site_id` equals the device's site or is NULL — `jobs/discoveryWorker.ts` ~1077
  clears cross-site links on every scan, so a cross-site link would not survive; the card instead
  says "management controller found in site X". Skip when the asset is already linked to another
  device or `auto_link_suppressed_at` is set. `linkSource = 'agent_report'` (new enum value). When no
  asset exists yet, nothing is stored beyond the component; the auto-linker's existing MAC match
  gains the device's reported BMC MAC as an additional identity so a later discovery reconciles.
- Gates the plan must verify (Codex findings, both passes): (a) `agent_report` links must **not**
  auto-approve the asset — `discoveryWorker.ts` ~1201 approves any already-linked asset on the next
  scan, so that branch must check `link_source`; (b) must **not** propagate the asset's
  classification onto the host device; (c) must **not** feed topology identity merging —
  `services/topology/aliasClusters.ts` ~63 and `services/topology/publish.ts` ~195 both treat a
  linked asset as the device's identity; a BMC is its own node.
- UI: Management controller card (§11.1); the network-device page's existing back-link shows the
  server.

## 13. Testing and lab proof

- **Go** (`go test -race`): fixture-driven parser tests per source under `testdata/<source>/`
  covering optimal, degraded, failed, rebuilding-with-progress, predictive failure, missing member,
  multi-controller, unrecognized state, and truncated output; runner tests for exit-code-as-data and
  timeout; scheduler tests for single-flight, jitter bounds, budget cancellation; breaker tests;
  identity-merge tests (blank / duplicate serial never merge; VD-backed Windows disk flag).
- **API unit**: ingest ordering (sequence, reset rule), completeness/staleness matrix (every source
  status × complete flag), event emission per transition, streak arithmetic, rollup exclusions,
  collector-row lifecycle, payload limits; monitor-kind compile; handler subject evidence (streak
  gating, stale device → unknown); built-in defaults v3 (`builtInMonitors.test.ts`); config feature
  decompose/assemble + parity tests; MCP coverage; column registry.
- **API integration** (real Postgres): RLS cross-tenant forge on all three tables (42501); cascade,
  export-policy, org-merge and roundtrip contracts; **subject-key alerting end-to-end**: two breaching
  subjects → two alerts; acknowledge one → the other still fires; recovery resolves only its own;
  unknown resolves nothing; concurrent createAlert races collapse on the unique index; responses fire
  once per device; episode `alert_id` not overwritten; existing kinds' behaviour unchanged (NULL key).
- **Web**: `StorageHealthSection` state tests (healthy, degraded, no tooling, disabled, stale); e2e
  Playwright spec on the Hardware tab with seeded components (`data-testid` only).
- **Lab proof (required before the feature closes, W06)** — no RAID card needed:
  - Windows: VM `.55` (Server 2022): add two VHDX disks, create a Storage Spaces mirror, dev-push the
    agent, pull one disk → `virtual_disk degraded` + `physical_disk missing` alerts within two polls;
    reattach → both resolve. Also proves `windows_physical_disk` and the policy toggle.
  - Linux: container or VM with two loop devices, `mdadm --create --level=1`, `mdadm --fail` →
    degraded alert; `--remove` / `--add` → rebuilding (warning, no critical alert) → optimal → resolved.
    ZFS mirror on the same box if `zfsutils` installs cleanly.
  - Vendor CLIs: parser fixtures captured from real boxes (`storcli64 /call show all J`,
    `perccli64 …`, `ssacli ctrl all show config detail`, `omreport storage … -fmt ssv`, `arcconf
    GETCONFIG 1 AL`, `MegaCli64 -PDList -aALL`). Todd to supply captures from OliveTech-managed Dell /
    HPE servers where available; the plan ships with the public-domain samples otherwise and marks
    each source `fixture-only` in the docs until a real capture lands.
- Needs an **agent release** (agent-shipped code): note on the feature issue.

## 14. Waves

| Wave | Scope | Notes |
|---|---|---|
| W01 — API contract | Migrations §8.2 files 1–2, schema, all §8.3 registrations, ingest service + `PUT` route, events, streaks, rollup, retention, `GET` route, AI tool, MCP coverage, config feature `hardware_monitoring` end-to-end incl. the web tab (the feature-type parity tests force the web tab into the same PR), heartbeat delivery | Integration Tests must run (cascade/export/merge/RLS) |
| W02a — agent core | `hwhealth` package, runner, scheduler, breaker, payload, config apply, sources: storcli/perccli, mdadm, storage_spaces, windows_physical_disk, smartctl enrichment | Fixture tests; native Windows run on VM `.55` (cross-compile has missed test bugs before) |
| W02b — remaining sources | MegaCli, ssacli, arcconf, omreport, zfs; precedence (D12); `tool_dirs` override | Fixture tests |
| W03 — alerting | §9: subject_key migration + service + evaluator + handler + kind + shared schema + built-in v3 + `monitorKindFields` + episode/response guards | High rigor: touches the shared alert path; full unit suite + integration alert tests |
| W04 — web + docs | `StorageHealthSection`, device list column/filter + projection, docs page, e2e | UI stays in-session (Opus/Fable) |
| W05 — BMC in-band | `bmc` source, `agent_report` link source, auto-link gates, Management controller card | Verify the three D14 gates against the linker |
| W06 — lab proof + release note | §13 lab runs on Windows + Linux, capture evidence on the feature issue, release-notes/docs sweep, agent release request | Feature closes here |

Each wave is one PR (W02a/W02b may stack; dispatch CI per branch when stacked). Plans go in
`docs/superpowers/plans/monitoring/2026-09-23-hardware-monitoring-w0N-<slug>.md`, feature registered
via feature-lifecycle after the plans are written.

## 15. Risks and open items

- **Vendor CLI behaviour on live servers.** `omreport` and `ssacli` can take tens of seconds and spike
  CPU; `MegaCli` can hang on a dead controller. Mitigations: per-source timeouts, sequential
  execution, 4-min budget, breaker, policy toggle, 10-min default. Watch first-week fleet CPU.
- **Controller lock contention** with the vendor's own agent (OMSA, HPE AMS) running at the same time
  → transient `failed`; the breaker and `consecutiveSnapshots ≥ 3` on the collector default absorb it.
- **storcli index stability**: `/cN` indexes are stable per boot; a controller add/remove re-indexes
  and the old key goes stale (7-day reaper). Acceptable.
- **Unique-index migration on `alerts`** resolves any historic duplicate open alerts; the count is
  logged. Verify on a prod dump before the W03 cut.
- **Template interpolation** may not accept arbitrary context keys (§9.2) — small extension if so.
- **Fixtures vs reality**: until real captures exist, ssacli/arcconf/omreport parsers are proven only
  on documentation samples. Marked in the docs; W06 lists which sources have real captures.
- **Open**: Todd to name any OliveTech-managed Dell/HPE box for output captures (fixtures-only
  otherwise, per 2026-09-23).

## 16. Advisor quorum record

Fable position (2026-09-23) as in §2; Codex `gpt-6-astra` `xhigh` read-only review (same day):
AGREE-WITH-CHANGES on all four decisions. Changes adopted:

- D1: `attributes`/`sources`/`summary`/`detail` jsonb → `excludedOpen`; both agent-write tables get
  the composite deferrable FK, RLS, all four cascade lists and an org-merge policy; snapshot ordering
  and per-source completeness made explicit; failed/disabled/silent collection never deletes or
  recovers (D4); slot-vs-drive identity and VD↔PD membership specified (§4.2); predictive-failure
  transitions are events; retention stated; migrations named after the committed ceiling with enum
  `ADD VALUE` files separated from files that use the values.
- D2: `subject_key` confirmed as the right seam (`monitor_id` = configuration, `episode_id` =
  incident, `context.source` = provenance; none identifies the disk); atomic uniqueness via partial
  index with explicit NULL handling; subjects propagated through the evaluator (which discarded extra
  fields); per-subject breaching/recovered/unknown evidence, unknown never resolves; streaks counted
  per accepted snapshot at ingest, not per sweep; episode `alert_id` overwrite guarded, recurrence kept
  per (monitor, device); responses once per device (D7); built-in default types widened.
- D3: inline still needs a normalized settings table and decomposition like `event_log`; register in
  reference validation; cache the resolver; send defaults after policy removal, omit on resolver
  failure; no extra DB context per heartbeat; capability detection instead of role gating (D11).
- D4: separate PUT confirmed; jitter, single-flight, cancellation, shutdown tracking, cycle budget
  added; agent auth, main-agent role restriction and body limits kept; runner extracted so stdout and
  exit status survive non-zero exit (smartctl exit bits are data); merge only on unambiguous serial;
  unavailable vs failed distinguished, breaker visible; BMC linking gated (D14).

Second Codex pass (same model/effort, 2026-09-23 evening) on the committed spec: 17 findings, all
folded in — parent-chain RLS for the settings table; partial-snapshot upsert vs stale contract;
SMART tier replay; episode observation computed from open subject alerts (not `result.triggered`);
response ownership = `episode.alert_id` with `responsesOwner` on the `alert.triggered` payload;
BMC link gates against the cross-site clear (~1077) and auto-approve (~1201) branches; `autoResolve`
honoured; five per-rank streak counters; vocabulary closure (pools are enclosures, `UGUnsp` →
unknown, Windows HealthStatus as a flag rule); `alert_exempt` typed column; per-component freshness
from a payload-carried interval; migration dedupe restricted to NULL subjects + non-empty CHECK;
Drizzle `onConflict` needs raw SQL for an expression target; heartbeat insertion point corrected to
the post-scoped block; per-writer sequence; success criteria reworded (one attachment, ≈ 25 min);
SMART raw attributes demoted to data-only; `hponcfg -w` export instead of `-g`; handler registration
in `alertConditions/index.ts`; `multiselect` field kind; templates use `componentLabel`/`stateLabel`.

Rejected: none. Owner approvals: Q1 detect-only, Q2 per-component, Q3 BMC separate spec, and the
defaults list — Todd, 2026-09-23 ("Yes as recommended"); design sections — Todd, 2026-09-23 ("approve").
