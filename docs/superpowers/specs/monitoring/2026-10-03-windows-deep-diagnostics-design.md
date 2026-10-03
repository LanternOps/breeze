---
title: Windows deep diagnostics — crashes, memory leaks, permission failures and hangs for the in-product AI
status: design agreed in chat (Todd, 2026-10-03, four product decisions answered); written spec awaiting owner review
date: 2026-10-03
origin: owner request 2026-10-03 ("give AI the ability for deeper Windows diagnostics, like being able to analyze mini dump, use WDK, system monitor for program issues" → "what about memory leaks, or crashes related to permissions")
related: "2026-09-23 hardware & RAID monitoring + 2026-09-28 time sync (device status table / monitor kind / inline config feature pattern this copies); 2026-08-07 fleet hygiene findings (cluster findings); 2026-06-07 process-level resource drilldown (top-N samples, unchanged here); 2026-09-23 AI full control #6754 (tool exposure contracts); 2026-09-11 AI script authoring #5612 (script lane); PAM (elevation_requests)"
---

# Windows deep diagnostics

## 1. Product intent

An MSP technician chasing a misbehaving Windows program reaches for four tools: WinDbg for a crash
dump, Performance Monitor for a leak, Process Monitor for an "access denied", and Task Manager's
"Analyze wait chain" for a hang. Breeze's AI can do none of this today. The agent collects crash
signals from the event log only, and it labels unexpected shutdowns as blue screens. It parses no
bugcheck code, ignores application crashes (event 1000), and its cleanup feature deletes the dumps a
technician would want. Process sampling keeps the top 8 processes by working set every three minutes,
which can't see a slow leak. Nothing in the product looks at permission failures or hangs.

The goal is that the AI answers four questions with evidence, without a technician remoting in:

1. **Why did this machine blue-screen, and is it happening elsewhere?** The answer comes from the
   confirmed bugcheck code, the faulting driver and version from a debugger run on the device, and the
   same signature across the partner's fleet, set against recent driver and patch changes.
2. **Why does this app keep crashing or freezing?** The answer comes from the faulting module, the
   exception code, the repeat count, and for a hang, what the frozen threads are waiting on.
3. **Is something leaking?** Sustained growth in private bytes, handles or GDI objects, per process and
   version, with the evidence window, detected on the device and confirmed across the fleet.
4. **Is this a permissions problem, and what is the narrowest fix?** Logged blocks (Defender
   Controlled Folder Access and ASR, AppLocker, WDAC, .NET `UnauthorizedAccessException`, service logon
   rights) are surfaced, a traced reproduction shows the exact denied file and registry operations, and
   the AI proposes a least-privilege permission grant instead of making the user a local admin.

Success looks like:

- A confirmed blue screen raises a "Bugcheck" signal with code and name within one hour of the reboot,
  and an AI chat can name the faulting driver and version after a dump analysis run on the device.
- "Outlook keeps crashing" gets a grouped answer in one tool call: faulting module, exception, count,
  first and last seen, and whether other devices share the signature.
- A process whose private bytes grow 40 MB/h for 8 hours raises a "Sustained memory growth" signal. The
  same executable and version growing on several devices becomes one fleet finding.
- A technician can run a five-minute access trace while the user reproduces a failure, and gets a
  list of denied operations plus a proposed permission grant with rollback.
- No process memory dump ever leaves the device. Only allowlisted structured fields are uploaded by
  default.

### Out of scope

- **Sysmon management.** Deploying Sysmon and managing its config is security telemetry with its own
  compatibility and ownership questions. It is a separate project (Codex quorum, §17).
- **Server-side dump analysis.** The API's sandboxes are Linux, and app dumps contain memory. Analysis
  runs on the endpoint (D1). Small kernel minidumps can be downloaded by a technician (D2), and nothing
  analyzes them server-side.
- **Uploading user-mode process dumps,** in any form.
- **Live kernel debugging, Driver Verifier, and arbitrary debugger commands or extensions.** These are
  blocked outright (D12).
- **Allocation-stack attribution for leaks** (UMDH, heap tracing). That is developer tooling, and it is
  invasive (it needs a flag set on the image and an app restart). It is a possible follow-on after W06.
- **macOS and Linux.** The signal model is OS-neutral (§4). All collectors in this spec are Windows-only.
- **Breeze-wide (cross-partner) correlation** (owner decision, 2026-10-03). Correlation stops at the
  partner's fleet (D15).

## 2. Decisions

| # | Decision | Why |
|---|---|---|
| D1 | Analyze on the endpoint. Upload only allowlisted structured fields by default. Raw debugger output is a separately authorized artifact | Owner decision. App dumps hold memory (passwords, documents, tokens). "Ship text" alone is not a privacy boundary, because stacks, paths and event strings can carry secrets (Codex). |
| D2 | Kernel small minidumps (≤ 16 MiB) can be downloaded by a technician. User-mode dumps never leave the device | Owner decision. A technician can open a small kernel dump in WinDbg; these contain kernel stacks and driver lists, not user documents. |
| D3 | Third-party tools are fetched on demand through a **separate, purpose-specific signed tool catalog**, not the agent-update manifest | A compromised tool-catalog publishing path must not be able to authorize agent updates (Codex). The verification code is reused; the key, schema, expiry and rollback protection are new. |
| D4 | Breeze never hosts Sysinternals binaries. Debugging Tools for Windows may be mirrored only as the whole MSI | Licensing: Sysinternals forbids redistribution; the Debugging Tools licence allows only the full MSI. |
| D5 | Sysinternals EULA acceptance follows the HP CMSL precedent: stamped out of band by the HTTP route on the policy's inline settings, MFA-gated; the AI can never accept it | Owner decision (partner accepts). Reuses `services/configurationPolicy.ts` ~1627 (`WarrantyConsentActor`) and `routes/configurationPolicies/hpCmslGate.ts`. Rejected alternative: a `partners.settings` key (Codex). It would create a second consent pattern with no gain. |
| D6 | One new inline config-policy feature, `diagnostics`, trust tier `execution_gated`, partner-wide first | It enables tool download and execution, and later capture, which grants the device a capability (`packages/shared/src/constants/configFeatureTypes.ts` ~87). Modelled on `hardware_monitoring` and `time_sync`. |
| D7 | Crash taxonomy separates **confirmed bugcheck**, **unexpected shutdown**, **app crash** and **app hang**. Records are deduplicated across event, WER and dump evidence | Event 41 with `BugcheckCode = 0` and event 6008 do not prove a blue screen (`agent/internal/collectors/reliability.go` ~347 treats them as one today). |
| D8 | Evidence is read from event **EventData fields and WER report fields**, never from localized message text | Event messages are localized. EventData `param` fields, Kernel-Power 41 `BugcheckCode` and `Report.wer` keys are not. |
| D9 | Leak detection is hybrid. The agent samples every process and keeps the series locally; it uploads candidates with bounded evidence windows plus a daily coverage summary. The server alone decides signals | At 10k agents × ~200 processes, raw series can't go to Postgres. Healthy coverage summaries allow fleet calibration (Codex). The server-side resolver follows the time-sync D4 pattern. |
| D10 | Leak thresholds are delivered in config, not compiled into the agent. Signals say "sustained growth", never "leak" | Thresholds can be tuned without an agent release. A positive slope is evidence of growth, not proof of a leak (Codex). |
| D11 | Long operations are **diagnostic runs**: start, then fetch. New table `device_diagnostic_runs`, with `device_commands` as the transport. Never hold a DB transaction while waiting | This is the start/fetch pattern from topology diagnostics, but topology's table requires topology subjects (Codex). It also avoids the `run_script` idle-in-transaction failure (§16). |
| D12 | The debugger runs a **fixed command set** per dump type, under a restricted token in a job object. No arbitrary commands or extensions | dbgeng parsing an attacker-crafted dump as SYSTEM is a code-execution surface. A fixed command set also keeps output parseable. |
| D13 | Access tracing ships **Procmon-first** for supervised runs. An ETW-native tracer replaces it only after a coverage spike passes | Procmon is proven. ETW can report file-operation status but needs correlation, and coverage across Windows builds is unproven (Codex). |
| D14 | Policy blocks (CFA, ASR, AppLocker, WDAC) are **never** turned into ACL grants. Permission fixes are proposals with exact rights, a precondition hash and a rollback record | A blocked write under Controlled Folder Access is a policy decision, not a missing ACL (Codex). |
| D15 | Correlation is partner-fleet scoped and limited to orgs the caller can access. Per-org clusters become `fleet_findings`; cross-org views are computed at read time. Language is "co-occurs", not "causes" | Owner decision. `fleet_findings` is org-owned (shape 1), so cross-org rows would break tenancy. |
| D16 | Headless AI agents may run reads and analysis unattended: signals, trends, wait chains, effective-access reads, analysis of an existing dump. Traces, captures and permission changes need a human | Owner decision. Codex would have made dump analysis supervised; recorded in §17. |
| D17 | Built-in monitors are provisioned partner-wide and attached to no policy | Standing owner decision (2026-09-13): no monitoring assigned by default. |
| D18 | Diagnostic artifacts (redacted debugger transcripts, kernel minidumps, trace summaries) live in a new device-owned table, deleted with the device, not in `ai_run_artifacts` | `ai_run_artifacts` rows intentionally outlive device deletion (`apps/api/src/db/schema/aiWorkspace.ts` ~40) and need an AI-run anchor. Kernel memory should not outlive the device. The blob storage and paging code is reused. |

## 3. Architecture and data flow

```
 agent (Windows, SYSTEM)                                   API                                      web / AI
 ───────────────────────                                   ───                                      ────────
 diagnostics collector (heartbeat tick: at start, hourly, and after an unexpected-shutdown boot)
   ├─ crash evidence: System 1001 BugCheck, Kernel-Power 41, 6008,
   │    Application 1000/1001/1002, Report.wer, minidump headers
   ├─ dump inventory + dump readiness (CrashControl, pagefile, free space)
   ├─ access-block events (Defender, AppLocker, WDAC, .NET 1026, SCM)
   ├─ resource sampler (every process, 5 min, 72 h local ring buffer)
   │    └─ candidate detection (thresholds from config)
   └─ PUT /agents/:id/diagnostic-evidence {seq, …}  ───────►  ingest (one tx per device)
                                                              ├─ ordering check (sequence)
 heartbeat response                                           ├─ resolveDiagnosticSignals()
   .configUpdate.diagnostics_settings  ◄──────────────────────├─ upsert device_diagnostic_signals
                                                              └─ reliability history (taxonomy fixed)
                                                           fleet findings scan (existing job)
                                                              └─ diagnostic_signal_cluster producer ──► Fleet findings feed
                                                           alert sweep (60 s)
                                                              └─ diagnostics monitor kind ──────────► Alerts inbox
 diag_* command  ◄── device_commands ◄──  start run (AI tool / UI) → device_diagnostic_runs
   ├─ tool catalog fetch + verify (cdb/kd, Procmon)
   ├─ run under restricted token / job object
   ├─ parse on device → allowlisted fields
   └─ result (+ presigned PUT of artifact) ─────────────────► result ingest → run row + artifacts ─► AI get_diagnostic_run
                                                           run sweeper (expire past deadline)
```

## 4. Signal model

A **signal** is a deduplicated, current diagnostic fact about one device, keyed by
`(device_id, kind, subject_key)`. Signals are the AI's primary read surface, and they are what monitors
and fleet clusters build on.

### 4.1 Kinds

| Kind | Source | `subject_key` (normalized) | Cleared when |
|---|---|---|---|
| `bugcheck` | 1001 BugCheck EventData, Kernel-Power 41 with `BugcheckCode ≠ 0`, kernel dump header | `bugcheck:<code>` then, after analysis, `bugcheck:<code>:<module>:<module_version>` | No recurrence in 30 days |
| `unexpected_shutdown` | 41 with `BugcheckCode = 0`, 6008 | `shutdown:unexpected` | No recurrence in 30 days |
| `app_crash` | Application 1000 EventData, `Report.wer` | `app_crash:<image>:<image_version>:<fault_module>:<fault_module_version>:<exception_code>` | No recurrence in 14 days |
| `app_hang` | Application 1002 EventData | `app_hang:<image>:<image_version>` | No recurrence in 14 days |
| `resource_growth` | Agent candidate (§5.3) | `growth:<metric>:<image>:<image_version>` (metric ∈ private_bytes, handles, gdi, user, threads) | No candidate for that key in 24 h of covered samples, or the process exited |
| `access_block` | Event channels in §5.2 | `access_block:<source>:<image>:<normalized_target>` | No recurrence in 14 days |

Normalization: image names are lower-cased basenames plus a normalized full path in the evidence.
User-profile segments in paths become `%USERPROFILE%`, so `subject_key` carries no usernames. Versions
are the file version string as reported.

### 4.2 Interpretation table (the "knowledge pack")

`packages/shared/src/diagnostics/reference.ts` holds a static table: bugcheck codes (name, plain
meaning, usual cause class such as driver, hardware, memory, storage or power, and next steps),
exception codes and NTSTATUS values (for example `0xC0000005` = access violation, a memory bug that is
**not** a permissions problem), and the event IDs used here. The resolver attaches `interpretation`
and `next_steps` to every signal it returns, so the AI gets the meaning with the data and no
system-prompt budget is spent. `get_diagnostic_reference` (§10) answers ad hoc lookups ("what is
0x133?"). Triage trees ship as diagnose-only built-in playbooks (§10.3).

## 5. Agent design

New package `agent/internal/diagnostics/` with Windows implementations behind interfaces
(`*_windows.go`). Non-Windows constructors return nil, so non-Windows agents send nothing. Every
collector runs inside `collectors.Guard`.

### 5.1 Crash evidence (W02)

- **Sources:**
  - System 1001 from source `BugCheck`: EventData `param1` is the bugcheck string, `param2` the dump
    path, `param3` the report id.
  - Kernel-Power 41: `BugcheckCode` and `BugcheckParameter1..4`.
  - System 6008.
  - Application 1000, 1001 (WER) and 1002: EventData fields for app name and version, fault module
    and version, exception code and offset.
  - `Report.wer` files under `%ProgramData%\Microsoft\Windows\WER\ReportArchive` and `ReportQueue`.
    These are UTF-16 key=value files (`Sig[n].Name` / `Sig[n].Value`).
- **Kernel dump header:** a Go-native, bounded, read-only parse of `DUMP_HEADER64` (signature
  `PAGEDU64`). It reads bugcheck code and parameters, dump type, OS build and crash time. It does no
  stack walking and makes no module guess. Module attribution comes only from the debugger (§5.5).
- **Deduplication:** one record per crash, keyed by WER report id when present, else by bugcheck code
  plus crash time within ±120 s. Each record lists the sources that saw it.
- **Dump inventory:** files in `%SystemRoot%\Minidump`, the `CrashControl\DumpFile` path,
  ReportArchive `*.dmp`/`*.hdmp`, and configured WER LocalDumps folders. Each entry carries id
  (`sha256(path|mtime|size)`), kind (`kernel_mini|kernel_full|user_mini|user_full`), size and mtime.
  Kernel minidumps also get a SHA-256 of their contents.
- **Readiness facts:** `CrashDumpEnabled`, `MinidumpDir`, pagefile size against RAM, free space on the
  dump volume, and WER LocalDumps config. These let the AI say "there are no dumps because dumps are
  disabled".
- **Cadence:** at agent start (which also covers the boot after an unexpected shutdown), then hourly,
  using event bookmarks. This replaces the 24 h reliability cadence for crash evidence only.
- **Reliability taxonomy fix (W01):** the existing reliability collector stops labelling 41/6008 as
  `bsod`. It uses `system_crash` for unexpected shutdowns and adds `app_crash` for event 1000. **This
  changes reliability score inputs.** The W01 plan must measure the score shift on a sample of real
  history and ship a release note.
- **Cleanup preservation (W01):** `system_cleanup` (`agent/internal/syscleanup/windows.go` ~112)
  stops deleting dumps and WER reports newer than `preserveDumpsDays` (default 30) unless the request
  explicitly includes them. Disk cleanup v2 category wording is updated to match.

### 5.2 Access-block events (W02)

Enforcement events only; audit-mode events are ignored in v1.

| Source | Channel / IDs | Extracted fields |
|---|---|---|
| Defender Controlled Folder Access | `Microsoft-Windows-Windows Defender/Operational` 1123 | process path, blocked target path |
| Defender ASR | same channel, 1121 | rule id, process path, target |
| AppLocker | `Microsoft-Windows-AppLocker/*` 8004, 8007, 8022 | blocked file, rule, user SID |
| WDAC | `Microsoft-Windows-CodeIntegrity/Operational` 3077 | blocked file, policy |
| .NET | Application `.NET Runtime` 1026 where the exception type is `System.UnauthorizedAccessException` or `System.Security.SecurityException` (type names are not localized) | app, exception type, top frame |
| Service accounts | System 7038, 7041, and 7000 with error 1069 | service, account, missing right |
| UAC virtualization | `Microsoft-Windows-UAC-FileVirtualization/Operational` | process, virtualized path. IDs are fixed by the W02 lab capture |

Policy blocks (the first four rows) carry `block_class = 'policy'`. The rest carry
`block_class = 'permission'`. Only `permission` signals can lead to ACL proposals (D14).

### 5.3 Resource-growth sampler (W03)

- **What:** for every process, every `intervalSeconds` (default 300, range 60–900):
  - private bytes (`PROCESS_MEMORY_COUNTERS_EX.PrivateUsage`)
  - handle count (`GetProcessHandleCount`)
  - GDI and USER objects (`GetGuiResources`)
  - thread count

  System-wide: commit total and limit, and paged and non-paged kernel pool (`GetPerformanceInfo`,
  which is documented). Processes the agent can't open (protected/PPL) are counted, not sampled.
- **Identity:** `(boot_id, pid, create_time)`. A restarted process is a new series. Each series also
  records image path, file version and session id.
- **Storage:** an in-memory ring buffer of 72 h, persisted hourly to
  `%ProgramData%\Breeze\diag\trends.bin` (capped at 8 MiB, SYSTEM/Administrators ACL) so agent updates
  don't reset it.
- **Candidate rule (`algorithm_version = 1`):**
  - The window must be at least `minWindowHours` (default 6) of covered samples.
  - The Theil–Sen slope must exceed the metric threshold: private bytes ≥ 20 MB/h **and** ≥ 25 %
    growth over the window; handles ≥ 200/h; GDI or USER ≥ 100/h or within 20 % of the 10,000
    per-process quota.
  - Kendall τ ≥ 0.6, so steady growth counts and spiky noise doesn't.
  - All thresholds come from config (D10).
- **Payload:** at most 20 candidates per upload. Each carries identity, metric, slope, τ, window,
  coverage, and a downsampled series of ≤ 48 points. A daily coverage summary reports processes
  tracked, sample coverage %, samples dropped, unopenable process count, and the sampler's own CPU
  time.
- **Budget:** the lab gate (§14) requires average sampler CPU < 0.1 % of one core and resident memory
  < 16 MiB.

The existing top-N process samples (`device_process_samples`) and anomaly episodes are unchanged. They
answer "what was busy at 14:05", not "what grows".

### 5.4 On-demand commands

All are new command types in `agent/internal/remote/tools/types.go`. Each is registered across
`commandTypes.ts`, `commandOfflinePolicy.ts` and `commandTimeouts.ts`, and in `partnerTrust.ts`
`GATED_COMMAND_TYPES`.

| Command | Wave | What it does | Bound |
|---|---|---|---|
| `diag_wait_chain` | W02 | Wait Chain Traversal (`OpenThreadWaitChainSession` / `GetThreadWaitChain`, synchronous) for each thread of a target process. Reports each chain's lock types and owners, deadlock cycles, and `incomplete` flags | 256 threads, 10 s. "No cycle" is reported as "no cycle found", never "healthy" |
| `diag_effective_access` | W02 | DACL, owner, integrity label and effective rights for a file, directory or registry key. Uses the logged-on user's real token (`WTSQueryUserToken` → `AuthzInitializeContextFromToken`) when the user is logged on, else SID-based with a "group membership may be incomplete" flag | 20 paths per call |
| `diag_fetch_kernel_minidump` | W04 | Reads one kernel minidump from the inventory and PUTs it to a presigned URL | ≤ 16 MiB, kernel minidumps only (by header) |
| `diag_analyze_dump` | W04 | Debugger analysis (§5.5) | 15 min, one at a time per device |
| `diag_access_trace` | W05 | Procmon capture while the user reproduces (§5.6) | 30–300 s, one at a time per device |
| `diag_apply_access_fix` | W05 | Applies one approved ACL change with compare-and-set on the current descriptor hash; stores the prior SDDL for rollback | One object per call |
| `diag_pool_tags`, `diag_capture_process_dump`, `diag_arm_local_dumps` | W06 | Kernel pool by tag, process dump capture, WER LocalDumps arming (§5.7) | §5.7 |

Long commands use `command_progress` frames with new stages (`provisioning`, `running`, `parsing`).

### 5.5 Tool catalog, cache and debugger execution (W04)

- **Catalog:** JSON signed with a new Ed25519 key, purpose `diagnostic-tools`. The public keys are
  embedded in the agent with a rotation list, and verified using the updater's code path.
  - Fields: `catalogVersion` (monotonic), `issuedAt`, `expiresAt` (≤ 90 days), and
    `tools[]: {id, version, url, sha256?, size, signer: {subject, minFileVersion}, licence: 'msi-redistributable' | 'sysinternals-eula', install: 'msi-admin-extract' | 'single-exe', entrypoints}`.
  - The agent rejects a catalog that is expired, has a lower `catalogVersion` than the last one seen,
    or lists a tool that is absent (revoked).
  - The API serves the catalog. A release-tooling job publishes it. No customer-facing route can
    write it.
- **Verification:**
  - Debugging Tools: the MSI must match the pinned SHA-256 **and** pass `WinVerifyTrust` with the
    pinned Microsoft signer.
  - Sysinternals: Microsoft-hosted URLs change content in place, so they are verified by signer pin
    plus `minFileVersion`. The observed hash is reported to the server for the catalog.
  - Every entrypoint is re-hashed against its cache-time hash **at each launch**, to close the
    time-of-check/time-of-use gap.
- **Cache:** `%ProgramData%\Breeze\diag\tools\<id>\<version>\`, with an explicit ACL of SYSTEM and
  Administrators (full control) and no inheritance. The agent recreates the directory if the ACL has
  drifted. A user-writable cache would be a privilege escalation, because the agent runs as SYSTEM.
- **Debugger run:**
  - `kd.exe -z` for kernel dumps and `cdb.exe -z` for user dumps.
  - The command set is fixed per dump type: `!analyze -v`, `lmv m <faulting module>`, `q`.
  - It runs on a copy of the dump in a per-run temp directory. The child process runs under a
    restricted token (privileges dropped, low integrity) inside a job object with CPU, memory
    (2 GiB), wall-clock and kill-on-close limits.
- **Symbols:** `srv*<cache>*<symbolServer>`. The default is `https://msdl.microsoft.com/download/symbols`;
  policy can set a partner's own HTTPS symbol proxy. The cache is capped (default 1 GiB, LRU).
  Without symbol access the run still completes with `symbols: 'unavailable'`, and the result falls
  back to header facts.
- **Parsing on the device**, to these allowlisted fields only: `BUGCHECK_CODE`, `BUGCHECK_P1..P4`,
  `PROCESS_NAME`, `MODULE_NAME`, `IMAGE_NAME`, `IMAGE_VERSION`, `FAILURE_BUCKET_ID`,
  `EXCEPTION_CODE`, and the top 10 stack frames as `module!symbol+offset` with arguments stripped. The
  full transcript is uploaded as a `debugger_transcript` artifact (D18), with access rules in §10.

### 5.6 Access trace (W05)

- `Procmon64.exe /AcceptEula /Quiet /Minimized /BackingFile <run>.pml /LoadConfig <run>.pmc /Runtime <n>`.
  The `/Terminate` fallback runs at the deadline.
- The filter config limits capture to the target process tree and to failure results: ACCESS DENIED,
  PRIVILEGE NOT HELD, SHARING VIOLATION, and NAME/PATH NOT FOUND for the target only.
- **Spike S2 (start of W05):** generate the `.pmc` and parse the `.pml` natively in Go, using the
  publicly documented formats (e.g. the `procmon-parser` project). Fallback: Procmon `/SaveAs` CSV,
  streamed and filtered on the device.
- **Output:** grouped denials, each with process, user, elevated or not, integrity level, operation,
  normalized path or key, requested access mask, result and count.
- **Fix proposal:** for each `permission` group, the deepest directory or key covering the denied
  objects, the minimal right set implied by the requested mask, and the principal (the user, or
  `Users` when several users are affected).
  - Never proposed for `%SystemRoot%`, `System32`, the `Program Files` roots, drive roots or `HKLM\SYSTEM`.
  - Never proposed for `policy` blocks. Those get an advisory recommendation instead, such as adding an
    exclusion in the Defender or AppLocker policy, which is managed by GPO or MDM.
- **ETW spike S3 (parallel to W05, gates W06):** prove that ETW kernel file and registry providers
  report failure status, the requesting process and the user, with event-loss accounting, on the
  supported Windows builds.

### 5.7 Capture and kernel pool (W06)

- **`diag_capture_process_dump`:** `MiniDumpWriteDump` (inbox `dbghelp`) with hang, crash or threshold
  triggers, in the style of ProcDump.
  - Target eligibility is an **allowlist**: the target must be the subject of an active `app_crash`,
    `app_hang` or `resource_growth` signal on that device.
  - Never: LSASS, csrss, wininit, services, PPL processes, or the credential-class list in
    `packages/shared/src/diagnostics/captureDenylist.ts` (browsers, password managers, credential
    providers).
  - The dump stays on the device (D2), is analyzed there, and is deleted after `retainHours`
    (default 24).
- **`diag_arm_local_dumps`:** writes WER `LocalDumps\<image>` for one image with `DumpType=1`
  (mini), `DumpCount=3`, and an expiry the agent enforces (default 7 days, then the key is removed).
- **`diag_pool_tags`:** kernel pool usage by tag via `NtQuerySystemInformation(SystemPoolTagInformation)`,
  enabled only on OS builds that pass the lab check. Tags are mapped to drivers with the Debugging
  Tools `pooltag.txt` when the catalog has it.

### 5.8 Cross-cutting agent rules

- At most one heavy diagnostic run (`analyze_dump`, `access_trace`, `capture_*`) per device at a time.
- Free-space floor before any write: twice the expected output, and never below 2 GiB free.
- Runs are cancelled on cancel command, deadline, agent shutdown or device org move. Temp directories
  are always cleaned up.
- Unsupported targets (PPL, missing token, OS build) return a typed `unsupported` result, never a
  failure presented as a finding.
- The agent never disables, pauses or excludes security software to get evidence.

## 6. Ingest, signals and findings

- **Route:** `PUT /agents/:id/diagnostic-evidence`, modelled on the time-status ingest: sequence
  ordering, one transaction per device, and a body cap of 512 KiB.
- **Resolver:** `services/diagnostics/resolveSignals.ts` is the single resolver. It upserts
  `device_diagnostic_signals`, updates counts and last-seen, clears signals by the rules in §4.1, and
  attaches interpretations (§4.2). It is used by ingest, the AI tools and the monitor handler.
- **Reliability:** crash records also flow into `device_reliability_history.crash_events` with the
  fixed taxonomy, so scoring keeps one source. Signals are the deduplicated diagnostic index over the
  same payload.
- **Fleet clusters:** a new `fleet_findings` kind, `diagnostic_signal_cluster`. It is created when the
  same `(kind, subject_key)` is active on ≥ 2 devices in one org (`semantic_key = kind:subject_key`).
  The producer is added to `services/fleetFindings/producers.ts`. The kind also goes into the CHECK
  constraint, the type union and `findingLabels.ts`.
- **Partner correlation:** `find_similar_diagnostic_signals` (§10) aggregates across the orgs the
  caller can access, at read time. It joins with patch installs and software inventory changes in a
  ±7-day window before first-seen, and reports them as co-occurring changes.

## 7. Diagnostic runs and artifacts

- **Start:** the AI tool or UI route validates parameters and authority, then in **one short
  transaction** inserts `device_diagnostic_runs` (`queued`) and the `device_commands` row. It commits
  and returns `runId`.
  - Fast kinds (`wait_chain`, `effective_access`) may wait up to 20 s inline, **outside** any DB
    context, for an immediate answer.
  - Start tools declare `selfManagedDbContext`.
  - W02 ships the two fast kinds before this table exists. Their tools queue the command and wait
    inline (≤ 20 s, outside any DB context), with the command row as the only record. From W03 they
    also write a run row, so every diagnostic has one audit trail.
- **Result:** command result ingest updates the run (`running` → `completed|failed|cancelled`). It
  stores the bounded structured result (≤ 32 KiB) and links artifacts.
- **Sweeper:** a BullMQ repeatable job expires runs past `deadline_at` (`expired`) and deletes
  artifacts past `expires_at`.
- **Artifacts:**
  - Per-run upload grant: a presigned single PUT with content-length bound and SHA-256, issued in the
    command payload. This reuses `services/artifacts/blobStorage.ts`.
  - Kinds: `debugger_transcript` (≤ 4 MiB, 30-day TTL), `kernel_minidump` (≤ 16 MiB, 7-day TTL),
    `trace_summary` (≤ 4 MiB, 30-day TTL).
  - Paging reuses the artifact pager's internals.
- **Device move:** queued and running runs are cancelled. Rows repoint with the device (the standard
  denormalized contract).

## 8. Schema and tenancy

### 8.1 Tables

All three are tenancy shape 5 (device-scoped, denormalized `org_id`), with policy
`breeze_has_org_access(org_id)` and RLS enabled and forced. Each carries the composite FK
`(device_id, org_id) → devices(id, org_id) ON UPDATE CASCADE ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE`,
as `2026-10-30-110000-hardware-health-tables.sql` does. Drizzle schema lives in
`apps/api/src/db/schema/diagnostics.ts`.

**`device_diagnostic_signals`** (W02)
- Keys and classification: `id uuid PK`, `org_id`, `device_id`, `kind text CHECK (…§4.1)`,
  `subject_key text`, `algorithm_version int`, `state text CHECK (state IN ('active','cleared'))`.
- Typed signature fields: `code bigint`, `image_name text`, `image_version text`, `module_name text`,
  `module_version text`, `block_class text`.
- Counters and lifecycle: `occurrence_count int`, `first_seen_at`, `last_seen_at`, `cleared_at`,
  `evidence jsonb` (bounded latest evidence), `created_at`, `updated_at`.
- Indexes: a unique live index on `(device_id, kind, subject_key) WHERE state = 'active'`;
  `(org_id, kind, subject_key)` for clusters and correlation; `(org_id, state, last_seen_at)`.

**`device_diagnostic_runs`** (W03)
- Identity: `id`, `org_id`, `device_id`, `kind text CHECK (…§5.4)`,
  `state text CHECK (state IN ('queued','dispatched','running','completed','failed','cancelled','expired'))`.
- Who started it: `requested_by_user_id uuid NULL`, `ai_session_id uuid NULL`, `ai_agent_run_id uuid NULL`,
  `action_intent_id uuid NULL`. These are plain audit references with no FK.
- What was asked: `params jsonb`, `authority jsonb`,
  `command_id uuid NULL → device_commands ON DELETE SET NULL` (`device_commands` sorts before this
  table in the cascade order, so the FK must not block its deletion), `idempotency_key text`.
- Timing: `deadline_at`, `started_at`, `completed_at`.
- Outcome: `result jsonb`, `error_code text`, `tool_versions jsonb`, `created_at`, `updated_at`.
- Indexes: unique `(org_id, idempotency_key)`; `(device_id, state)`.

**`device_diagnostic_artifacts`** (W03)
- `id`, `org_id`, `device_id`, `run_id → device_diagnostic_runs ON DELETE CASCADE`,
  `kind text CHECK (kind IN ('debugger_transcript','kernel_minidump','trace_summary'))`.
- Blob and lifecycle: `blob_key text`, `size_bytes bigint`, `sha256 text`, `expires_at`, `created_at`.

`fleet_findings` gets a CHECK-constraint migration for the new kind (W02).

### 8.2 Migrations

Migrations are hand-written and idempotent, with no inner `BEGIN`. Elect system scope before any
write. Filenames are `YYYY-MM-DD-HHMMSS-<slug>.sql` and must sort after the newest committed
migration at authoring time (currently `2026-12-05-100000-device-live-session-indexes.sql`; re-check
when writing, because the ceiling moves).

- W02: `…-diagnostic-signals.sql` creates the signals table with RLS and FK, and updates the
  `fleet_findings` kind CHECK.
- W02: `…-monitor-kind-diagnostics.sql` adds the `monitorKindEnum` value.
- W03: `…-diagnostic-runs.sql` creates the runs and artifacts tables with RLS and FKs.
- W03: `…-diagnostics-config-feature.sql` adds the `configFeatureTypeEnum` value and
  `config_policy_diagnostics_settings`, keyed by `feature_link_id`. Its RLS copies the parent-predicate
  policy from `2026-10-30-110100-hardware-monitoring-config-feature.sql`, plus the SELECT-only
  partner-wide branch from `2026-10-05-110000-config-policy-partner-wide-select.sql`.

### 8.3 Registrations (the step that gets missed)

| List | File | All three device tables |
|---|---|---|
| `CORE_ORG_CASCADE_DELETE_ORDER` (alphabetical; artifacts are FK children of runs, and `…_artifacts` sorts before `…_runs`) | `services/tenantCascade.ts` | yes |
| `CORE_DEVICE_CASCADE_DELETE_TABLES` | `routes/devices/core.ts` | yes |
| `CORE_DEVICE_ORG_DENORMALIZED_TABLES` | `routes/devices/core.ts` | yes |
| merge policy `repoint` | `services/orgMergeRegistry.ts` | yes |
| `CORE_TENANT_EXPORT_POLICY` | `services/tenantExportPolicyRegistry.ts` | yes. Every jsonb column (`evidence`, `params`, `authority`, `result`, `tool_versions`) is `excludedOpen`. Text columns whose names match `SUSPICIOUS_NAME_PARTS` (`subject_key`, `idempotency_key`, `blob_key`) are classified the same way as the matching columns already registered for `ai_run_artifacts` and existing idempotency keys |
| RLS coverage | `rls-coverage.integration.test.ts` | no allowlist entry; a direct `org_id` policy is auto-discovered |

Org erasure must also delete artifact **blobs**. The W03 plan copies whatever hook `ai_run_artifacts`
uses and adds an integration test proving the blob is gone. Run `tenantCascade`,
`tenant-export-policy`, `orgMergeRegistry` and `rls-coverage` locally before each PR.

### 8.4 Retention

`jobs/diagnosticsRetention.ts` runs daily:
- deletes cleared signals older than 90 days
- deletes runs older than 90 days
- deletes artifacts past `expires_at` (blob first, then row), using `pruneInCtidBatches`

## 9. Configuration-policy feature `diagnostics` (W03)

Inline settings (strict Zod in `packages/shared/src/validators/diagnosticsInlineSettings.ts`):

```ts
{
  resourceSampler: { enabled: boolean /* default false at launch, §16 */, intervalSeconds: 300,
                     windowHours: 72, minWindowHours: 6,
                     thresholds: { privateBytesMbPerHour: 20, privateBytesGrowthPct: 25,
                                   handlesPerHour: 200, guiObjectsPerHour: 100, kendallTau: 0.6 } },
  crashEvidence:   { preserveDumpsDays: 30 },
  debuggingTools:  { enabled: boolean /* default false */, symbolServer: 'microsoft' | { url: string /* https only */ },
                     symbolCacheMb: 1024 },
  sysinternals:    { enabled: boolean /* request: flag only; stored: + consent {acceptedByUserId, acceptedAt, eulaId} */ },
  kernelMinidumpDownload: { enabled: boolean /* default true */ },
  capture:         { processDumps: false, localDumpsArming: false, retainHours: 24 }   // W06
}
```

- **Delivery:** `configUpdate.diagnostics_settings` via `routes/agents/helpers.ts` (~2193), the same
  path as `time_sync`.
- **Consent:** follows `routes/configurationPolicies/hpCmslGate.ts`. Enabling Sysinternals requires
  `devices.execute` plus MFA. The route stamps consent from the authenticated user. A client-supplied
  `consent` key throws. `manage_policy_feature_link` can never set it. Disabling clears the stored
  consent.
- **Partner-wide first:**
  - Add the feature to `PARTNER_LINKABLE_FEATURE_TYPES`, with a tab in the policy editor.
  - Trust tier `execution_gated` (D6). A self-selected device group therefore cannot pull in tool
    execution.
- **Settings rule 9 statement:** home = Configuration Policy › Diagnostics tab; level = partner-wide
  or org policy through the standard policy hierarchy; resolver = the existing feature-link resolution;
  places configured before → after: 0 → 1 (new concept).

## 10. AI surface

### 10.1 Tools

Tier semantics as enforced in chat: T1 runs automatically; T2 asks for approval unless the session is
`auto_approve` (`apps/api/src/services/aiAgentSdk.ts` ~851, ~1045); T3 creates a durable approval
intent, with four-eyes as a separate class; T4 is blocked. (The header comment in `aiGuardrails.ts`
still says T2 runs automatically; the W02 plan fixes that comment.)

| Tool | Tier | Headless | Purpose |
|---|---|---|---|
| `get_device_diagnostic_signals` | 1 | yes | Active or cleared signals, with interpretation and next steps |
| `find_similar_diagnostic_signals` | 1 | yes | Partner-fleet correlation plus co-occurring changes (§6) |
| `get_diagnostic_reference` | 1 | yes | Bugcheck, exception, NTSTATUS and event ID lookup |
| `get_resource_trends` | 1 | yes | Growth candidates and the coverage summary for a device or process |
| `get_diagnostic_run` | 1 | yes, structured result only | Run status and parsed result. `includeTranscript` is a separate T2 path that headless agents are always denied (`AGENT_DENIED_READ_TOOLS`-style parameter gate) |
| `get_wait_chain` | 2 | yes (D16) | Starts `diag_wait_chain` |
| `get_effective_access` | 2 | yes (D16) | Starts `diag_effective_access` |
| `start_dump_analysis` | 2 | yes (D16), only when `debuggingTools.enabled` | Starts `diag_analyze_dump` on a dump from the inventory |
| `cancel_diagnostic_run` | 2 | yes | Cancels a run |
| `start_access_trace` | 3 supervised | proposes only | Needs `sysinternals.enabled` with consent |
| `apply_access_fix` | 3 four-eyes | never | Applies one proposed fix from a completed trace |
| `capture_process_dump`, `arm_crash_capture` | 3 four-eyes | never | W06 |
| `get_kernel_pool_usage` | 2 | yes | W06 |
| arbitrary debugger commands, capture of denylisted processes, disabling protections | 4 | — | Not exposed |

Each tool is wired across every registry together: `aiToolNames.ts`, the `aiTools.ts` hub,
`TOOL_TIERS`, `buildBreezeSdkTools`, `TOOL_PERMISSIONS`, `aiToolSchemas.ts`, device and site scope, and
the action classifications. The contract suites listed in the 2026-09-23 full-control spec must pass.
Outputs stay within the 8,000-character output budget. Larger results go through runs and artifacts.

### 10.2 Untrusted content

Process names, window titles, event strings, file paths and debugger output are attacker-controlled.
Tool results wrap them as data fields, never as prose. The system-prompt guidance for diagnostics
tools says to treat them as untrusted, matching the existing tool-result handling.

### 10.3 Script pack and triage playbooks (W01)

- **Script pack:** read-only scripts added to `SYSTEM_LIBRARY_SCRIPTS`
  (`services/systemScriptLibrary.ts` ~233), so they reach every install. `seed.ts` only runs on dev.
  Each emits compact JSON of 6,000 characters or less. They cover the long tail that the native
  waves won't build:
  - Windows component health: `DISM /CheckHealth`, `sfc /verifyonly`, CBS.log errors, pending reboot
    reasons.
  - Driver audit: third-party drivers with signer, date and version; problem devices
    (`pnputil /enum-devices /problem`).
  - Boot and shutdown degradation: Diagnostics-Performance events 100–110 and 200–203.
  - Power and sleep: `powercfg /requests`, `/lastwake`, and sleep-study summaries.
  - A one-shot resource snapshot: top processes by private bytes, handles and GDI, plus commit and
    pool.
  - A one-shot permission-block event sweep (until W02 ships native signals).
  - A one-shot dump readiness and inventory check (until W02).

  Scripts that the native waves supersede carry a `supersededBy` note and are retired one release
  after the native wave ships.
- **Triage playbooks:** diagnose-only built-ins in `services/builtInPlaybooks.ts`: "Blue screen
  triage", "App crash triage", "Slow or leaking machine" and "Access denied triage". They start as
  ordered tool calls over the W01 scripts, and later waves rewire them to native tools.

## 11. Alerting (W02, W03)

- **Monitor kind:** new kind `diagnostics` (added to `MONITOR_KINDS` and `MONITOR_KIND_SPECS`), with a
  handler in `services/alertConditions/handlers/`. It is per subject (added to `SUBJECT_MONITOR_KINDS`),
  with one alert per signal `subject_key`, and an alert resolves when its signal clears.
- **Conditions:**
  - `bugcheck` (any new active signal; default severity high)
  - `app_crash_repeat` (≥ N occurrences in 24 h)
  - `app_hang_repeat`
  - `resource_growth` (W03)
  - `access_block_repeat`
  - `unexpected_shutdown` (off by default)
- **Built-ins:** provisioned partner-wide and attached to no policy (D17).

## 12. Web UI

- **Device page:** a Diagnostics section with the tab in the URL hash (`#diagnostics`).
  - Active signals with their interpretation.
  - The dump inventory, with a readiness warning when dumps are disabled.
  - Runs with status and parsed results; transcript view needs `devices.execute`.
  - Actions: analyze a dump, wait chain, effective access, access trace, download a kernel minidump.
    Each goes through `runAction`, and downloads are audited.
- **Fleet findings feed:** labels and a drawer for `diagnostic_signal_cluster`.
- **Policy editor:** the Diagnostics tab, including the Sysinternals consent control with the EULA link.
- **PAM:** on an elevation request, an "Investigate access instead" action starts an access trace
  proposal for that executable. The UI detail is settled in the W05 plan.

## 13. Security and privacy summary

| Risk | Control |
|---|---|
| Dumps hold credentials and documents | User-mode dumps never leave the device; capture is allowlisted by eligibility, denies credential-class processes, needs four-eyes, and the dump is deleted after 24 h (§5.7) |
| Malicious dump exploits the debugger as SYSTEM | Restricted token, low integrity, job object, fixed command set, copy-in temp directory (D12) |
| Tool supply chain | Purpose-separated signed catalog with expiry and rollback protection, Microsoft signer pin, hash pin where stable, re-hash at launch, admin-only cache ACL (§5.5) |
| Licence | No Sysinternals hosting; MSI-only mirror for Debugging Tools; consent captured out of band, never by the AI (D4, D5) |
| EDR alerts on tracing, dumping or debugging | Signed agent, documented behaviour list in the docs page, no protection tampering (§5.8). Procmon and capture are supervised or four-eyes, so a human started them |
| Prompt injection via event, dump or path strings | Typed data fields, never prose; existing untrusted-content handling (§10.2) |
| Usernames in paths | `%USERPROFILE%` normalization in `subject_key`; raw paths only in bounded `evidence` (`excludedOpen`) |
| Disk exhaustion | Free-space floor, bounded caches, circular and time-boxed traces, TTLs (§5.8, §8.4) |
| Locked-down networks | Symbol proxy setting; header-only fallback; typed `unsupported` and `symbols: unavailable` results |
| Cross-tenant correlation | Read-time aggregation over the caller's accessible orgs only; per-org clusters only (D15) |
| Permission fixes widen access | Proposals only from `permission` blocks, protected-path exclusions, compare-and-set, stored rollback, four-eyes (D14) |

## 14. Testing and lab proof

- **Unit:**
  - Go parsers for `DUMP_HEADER64`, `Report.wer` and EventData. Fixtures are captured in the lab and
    committed header-only (first 8 KiB of each dump), with truncated, corrupt and oversized cases.
  - Candidate rule: table-driven series covering a leak, a sawtooth cache, a restart and a coverage gap.
  - The resolver.
  - Catalog verification (expired, rolled back, revoked, signer mismatch, hash mismatch, ACL drift).
  - Allowlisted field extraction from captured `!analyze -v` transcripts.
- **Contract:** AI tool registry suites; command-type parity (`partnerTrust.test.ts`); the
  config-feature trust-tier record; settings registry.
- **Integration (real Postgres):**
  - The tenancy suites in §8.3.
  - Ingest ordering.
  - Cluster producer.
  - Run lifecycle, including expiry and device move.
  - Blob deletion on org erasure.
  - Cross-org correlation isolation: a caller without access to org B never sees B's devices.
- **Windows lab (the standard Windows Server lab VM):**
  - L1: forced bugcheck (`NotMyFault`), with signal ≤ 1 h after reboot.
  - L2: kd analysis names the faulting driver, both with and without symbol access.
  - L3: a test app that crashes repeatedly produces a grouped `app_crash`.
  - L4: a test app that leaks 50 MB/h is flagged within the window, and a sawtooth cache is not.
  - L5: CFA and AppLocker blocks produce `policy` signals.
  - L6: an access trace on a write denied to a standard user yields a correct grant proposal, which
    applies and rolls back.
  - L7: wait chain on a deliberately deadlocked app shows the cycle.
  - L8: sampler CPU and memory budget over 24 h.
  - L9: Defender for Endpoint (or the lab's EDR) alert inventory for every heavy command.

## 15. Waves

| Wave | Contents | Ships |
|---|---|---|
| **W01 — Quick wins** | Reliability taxonomy fix + score-shift measurement; cleanup preserves recent dumps; script pack + triage playbooks (§10.3); knowledge reference table + `get_diagnostic_reference` | API + **agent release** |
| **W02 — Crash, hang and access evidence** | Crash evidence collector, dump inventory and readiness; access-block events; `diagnostic-evidence` ingest + resolver; `device_diagnostic_signals` + registrations; `diagnostic_signal_cluster` finding; `diagnostics` monitor kind + built-ins; `diag_wait_chain`, `diag_effective_access`; AI signal, reference, wait-chain and effective-access tools; device Diagnostics section | API + web + **agent release** |
| **W03 — Runs, policy and resource growth** | `device_diagnostic_runs` + artifacts + registrations + sweeper + retention; `diagnostics` config feature + delivery; resource sampler + candidates + `resource_growth` signals and monitor condition; `get_resource_trends`; overhead and false-positive measurement on a pilot partner before the default changes | API + web + **agent release** |
| **W04 — Dump analysis** | Tool catalog (key, publisher job, API route); agent fetcher and cache; `diag_analyze_dump` with restricted execution; symbol settings; kernel minidump download; `start_dump_analysis`; `find_similar_diagnostic_signals` with change correlation | API + web + **agent release** + release tooling |
| **W05 — Access tracing** | Spike S2 (PMC/PML); Procmon access trace; fix proposals; `diag_apply_access_fix` (four-eyes, rollback); PAM "Investigate access instead"; Sysinternals consent UI. Spike S3 (ETW) runs in parallel | API + web + **agent release** |
| **W06 — Deep capture** | ETW-native access trace if S3 passed (replaces Procmon as the default); kernel pool tags; process dump capture; LocalDumps arming | API + web + **agent release** |

Waves run in order. W04 and W05 can run in parallel once W03 has merged. Every agent wave needs its
Windows lab rows passed before release.

## 16. Risks and open items

- **Reliability score shift (W01).** Reclassifying 41 and 6008 changes scoring inputs. Measure on real
  history first; the release note explains the change.
- **Sampler default.** The resource sampler ships off. Turning it on by default depends on W03 pilot
  numbers (CPU, false-positive rate). That is an owner decision at the end of W03.
- **`run_script` idle-in-transaction failure.** On managed Postgres (1-minute idle-in-transaction
  timeout), chat `run_script` fails whenever a script runs past about 60 s, even though the script
  completes. It affects the W01 script pack. It is filed as a separate prerequisite issue, and the fix
  is the `selfManagedDbContext` pattern. No W01 script may need more than 45 s until it lands.
- **Sysinternals content churn.** Signer-plus-version verification accepts any Microsoft-signed build at
  or above the minimum. Re-evaluate if Microsoft ships versioned URLs.
- **Debugging Tools URL stability.** If Microsoft's MSI URL moves, the catalog falls back to the
  allowed full-MSI mirror.
- **Spikes S2 and S3** can fail. S2's fallback is CSV export. If S3 fails, Procmon stays the tracer and
  the W06 ETW item drops.
- **App-compatibility preflight for PAM** (running traces before removing admin rights) is a natural
  follow-on. It is not designed here: while the user is still an admin, denials often don't occur.

## 17. Advisor quorum record

Fable's position was the layered design as first presented in chat. Codex (gpt-6-astra, xhigh,
read-only) reviewed it on 2026-10-03.

**Adopted:**
- "Ship text" is not a privacy boundary → allowlisted fields plus a separately authorized transcript
  (D1).
- Separate signing authority for the tool catalog, with expiry, revocation and rollback protection
  (D3).
- Hybrid leak detection with process identity `(boot, pid, create_time)` and healthy coverage
  summaries; slope is not proof (D9, D10).
- Procmon-first for a supervised pilot, with ETW gated on a coverage experiment (D13).
- Reuse the start/fetch pattern but not the topology table; keep `device_commands` as transport
  (D11).
- `fleet_findings` for clusters (D15).
- Config as an inline config-policy feature, partner-wide first (D6).
- Crash taxonomy separation: event 41 alone is not a bugcheck (D7).
- Policy blocks never become ACL grants; reproduce under the actual user token (D14, §5.4).
- WCT needs debug privilege and returns incomplete chains (§5.4).
- `kd` for kernel dumps (§5.5).
- Operational budgets, PPL and unsupported reporting, and gating undocumented pool queries by tested
  builds (§5.7, §5.8).
- Untrusted strings (§10.2).
- Run cancellation on device move (§7).
- Wave ordering: native crash work before runs, tooling and capture.
- Sysmon split out as a separate project.
- Explicit target eligibility for capture rather than a short denylist (§5.7).

**Corrected after verification:**
- Codex described T2 as "automatic execution + audit", citing the `aiGuardrails.ts` header comment.
  The enforced behaviour asks for approval at T2+ unless the session is `auto_approve`
  (`aiAgentSdk.ts` ~851, ~1045). §10.1 uses the enforced semantics.
- Codex said the downloader allows verified cross-origin downloads; confirmed
  (`agent/internal/updater/updater.go` ~1499). It doesn't change the design.

**Not adopted:**
- Sysinternals consent in `partners.settings`. The HP CMSL inline-consent precedent already exists
  and keeps one consent pattern (D5).
- Dump analysis as T3 supervised. The owner chose to let headless agents analyze existing dumps
  (D16). The risk is bounded by the fixed command set, restricted execution, structured-only results
  for agents, one run per device, and the `debuggingTools.enabled` policy gate.
- Reuse `ai_run_artifacts` for transcripts. Those rows outlive device deletion and need an AI-run
  anchor, while diagnostic runs can start from the UI and kernel memory should not outlive the device.
  The blob storage and paging code is reused instead (D18).
- Crash storage only in `crash_events` with a normalized index "when measured". Partner-fleet
  correlation is a v1 requirement (D15) and needs an indexed `subject_key` from the start, so the
  signals table carries it. `crash_events` stays the scoring input.
