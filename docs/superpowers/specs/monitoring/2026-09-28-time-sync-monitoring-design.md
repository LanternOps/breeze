---
title: Time sync monitoring and management — Windows time source health, timezone, and domain-aware NTP enforcement
status: design approved in chat (Todd, 2026-09-28, sections 1–3 "looks right"); written spec awaiting owner review
date: 2026-09-28
origin: owner request 2026-09-28 ("spec a feature that manages and monitors the time on computers, starting with Windows")
related: "2026-09-23 hardware & RAID monitoring (the monitor-kind / subject_key / inline-feature pattern this copies); 2026-09-19 alerting consolidation (monitor model); #4044 (offsetless timestamps, unrelated despite the name)"
---

# Time sync monitoring and management

## 1. Product intent

A wrong clock breaks things that look unrelated: Kerberos refuses tickets past 5 minutes of skew, TOTP
codes fail, TLS rejects certificates, and logs from different machines stop lining up. In an AD domain
every member takes its time from the DC hierarchy, so one misconfigured PDC emulator (syncing from its
own CMOS clock, or from the Hyper-V host) moves the whole domain. Breeze collects no time, NTP or
timezone data today: the agent has no time collector on any OS, and the server never compares clocks.

Owner priorities (all four, in this order): catch time problems early; enforce time configuration
through partner-wide policy; produce audit evidence that endpoints sync from designated sources
(PCI-DSS 10.6 is a source/configuration requirement); find and fix wrong timezones.

Success looks like:

1. **The PDC case is one glance.** A forest-root PDC emulator with no external source, or one syncing
   from its local clock or VM host, raises a "Time source problem" finding on that DC within one
   snapshot, and the fleet page shows it at the top of its AD domain group.
2. **Windows' own failure signals surface.** DNS failures for configured NTP servers, unreachable
   peers, no domain time source, stale sync, disabled sync and refused clock corrections each become a
   named finding with a plain-language fix hint, and each can alert on its own through the monitor
   model.
3. **Wrong timezones are visible and fixable.** A device whose timezone differs from its site's (or a
   policy-pinned zone) shows the mismatch and can be fixed singly or in bulk, or automatically when the
   policy opts in. Laptops with Windows automatic timezone are left alone.
4. **One policy sets time for all orgs.** A partner-wide `time_sync` policy points workgroup and
   Entra-only devices and each forest-root PDC at the MSP's NTP servers, keeps every other
   domain-joined machine on the domain hierarchy, and never fights GPO.
5. **Twelve months of evidence.** Per-device daily history (source, type, health, last sync) exports
   as CSV for a date range, with missing days shown as gaps.

### Out of scope

- **Measuring clock offset against Breeze** (owner decision 2026-09-28, option A over "events + a coarse
  offset check"). v1 trusts Windows' own time-service signals. Two known blind spots follow and are
  accepted: a domain whose PDC is not enrolled in Breeze (members sync to a wrong PDC and report
  healthy), and a source that answers with the wrong time. A follow-on can add an offset check from the
  existing 30 s WebSocket ping (`apps/api/src/routes/agentWs.ts` ~2858 sends `timestamp`; the agent's
  pong carries its clock, `agent/internal/websocket/client.go` ~483) without touching anything here.
- **Setting the clock directly** ("step clock to Breeze time"). Deferred: stepping a clock safely needs
  its own design (authenticated time source, replay, DC effects, recovery when the clock is already
  outside the TLS validity window).
- **Automatic resync on failure.** v1 resyncs after applying policy and on demand only.
- **macOS and Linux.** The data model is OS-neutral (§6); collectors are later waves.
- **Compliance-rule integration** (`COMPLIANCE_RULE_TYPES`). The compliance evaluator has no "unknown"
  state (`services/policyEvaluationService.ts` ~28), so a device with no time data would read as
  failing. Evidence lives on the fleet Time page instead.
- **Clock-change forensics** (Kernel-General event 1, Security 4616). Not needed for the four goals.

## 2. Decisions

| # | Decision | Why |
|---|---|---|
| D1 | Truth = Windows' own time-service state and events, not a Breeze-measured offset | Owner decision. Covers the failures that occur in practice, including the PDC (event 12, local-clock source). No server-side time reference to operate. |
| D2 | Dedicated always-on Windows time collector, not the generic `event_log` feature | The event-log collector pulls System-log **errors** only (`agent/internal/collectors/eventlogs_windows.go` ~129, level 2, 50 per query); most Time-Service events are warnings. The `event_log` monitor matches source/message patterns, not event IDs. |
| D3 | No parsing of translated text. Status source is chosen by a spike at the start of W01 (§4.2) | `w32tm` output is localized. Anything the chosen method cannot read reports `unknown`, never a guess. |
| D4 | The server alone derives findings and health from the snapshot, through one resolver | One place to change rules; UI, monitor handler, fleet page and daily rollup all read its output. The agent reports facts only. |
| D5 | Findings are named codes (§5.2); each can raise its own alert via the existing `alerts.subject_key` | "NTP server doesn't resolve" and "sync stale" resolve independently. `subject_key` and its partial unique index already exist (hardware & RAID spec §9.1). |
| D6 | Expected timezone = policy-pinned zone, else the site's zone unless it is `UTC`/`Etc/UTC`, else none. Never org or partner timezone | Owner decision (site tz, detect-first; sites still at the `UTC` default are unset). A deliberately-UTC device is expressed with a pinned zone. Considered and rejected: a `sites.timezone_confirmed_at` provenance column (extra site-write-path change for a case the pinned zone already covers); the org-settings fallback (not what the owner chose). |
| D7 | Enforcement is agent-side reconciliation from an inline config-policy feature `time_sync`, domain-aware | Owner decision. The agent has the role facts and the GPO state at write time and can re-check them immediately before writing. |
| D8 | Role rule: workgroup, Entra-only and forest-root PDC emulator get the policy's servers; every other domain-joined machine gets NT5DS | Standard AD time hierarchy. A child-domain PDC syncs from the domain hierarchy, not from the policy's servers. |
| D9 | Unknown role or GPO/MDM-managed W32Time → the agent never writes | Fail closed. GPO wins by design; Breeze reports the conflict instead of fighting it. |
| D10 | `time_sync` trust tier = `protective` | The feature delivers an NTP peer list and a timezone — nothing the device lacks on itself — under the taxonomy in `packages/shared/src/constants/configFeatureTypes.ts` ~68. The tier governs self-selected device groups only; it is not a claim that a hostile NTP server is harmless. Who may set it is governed by config-policy write permissions and `canManagePartnerWidePolicies`. |
| D11 | Three commands only: `time_resync`, `time_set_timezone`, `time_apply_policy`; all in `GATED_COMMAND_TYPES` | They reuse the device-command chokepoint (permission, MFA, trust gate, audit). Clock stepping is out of scope. |
| D12 | Evidence = one row per device per UTC day, retained 400 days | 12 months of PCI evidence plus margin. A missing day is an explicit gap, never a pass. Evidence is "observed synchronization" from agent reports, not tamper-proof attestation; exports say so. |
| D13 | Built-in monitors are provisioned partner-wide and not attached to any policy | Standing owner decision (2026-09-13): no monitoring assigned by default. |

## 3. Architecture and data flow

```
 agent (Windows, SYSTEM)                                    API                                        web
 ───────────────────────                                    ───                                        ───
 timesync collector (tick gate in heartbeat loop, 30 min ± jitter)
   ├─ W32Time config (registry) + Policies keys + service
   ├─ status (method chosen by W01 spike, §4.2)
   ├─ domain role (mgmtdetect identity + DsRole/DsGetDcName)
   ├─ Time-Service events since last run (all levels)
   ├─ timezone + tzautoupdate
   ├─ [W03] reconcile against time_sync settings
   └─ PUT /agents/:id/time-status {snapshot}  ────────►  ingest (one tx, per-device)
                                                            ├─ ordering check (sequence)
 heartbeat response                                         ├─ resolveTimeFindings(snapshot, ctx)
   .configUpdate.time_sync_settings  ◄────────────────────  ├─ upsert device_time_status
   {enforce_ntp, ntp_servers, poll, expected_tz_windows,…}  ├─ upsert device_time_daily (today)
                                                            └─ [W03] audit entry per new enforcement result
                                                         alert sweep (alertWorker, 60 s)
                                                            └─ time_sync handler → per-finding
                                                               subject alerts                 ─────►  Alerts inbox
                                                         GET /devices/:id/time-status          ─────►  Info tab → Time
                                                         GET /time-status (fleet) + CSV        ─────►  /devices/time
                                                         POST /devices/:id/commands (time_*)   ◄─────  actions / bulk
                                                         AI: get_device_time_status,
                                                             list_time_sync_issues
```

## 4. Agent collector (Windows)

New package `agent/internal/collectors/timesync/` (next to `collectors/hwhealth/`), with every OS read
behind a `System` interface whose Windows implementation lives in `system_windows.go` and whose
non-Windows constructor returns nil, so non-Windows agents send nothing. The file layout is fixed in
the plan index (§H). Collection runs inside `collectors.Guard`
(`agent/internal/collectors/safe.go` ~124); any exec uses `runCollectorOutput` with a timeout
(`collectors/command_limits.go` ~17–41).

### 4.1 Facts and sources

| Fact | Source |
|---|---|
| `type` (`NT5DS`/`NTP`/`NoSync`/`AllSync`) | `HKLM\SYSTEM\CurrentControlSet\Services\W32Time\Parameters\Type` |
| `ntpServer` (raw value, e.g. `a,0x9 b,0x9`) | `…\W32Time\Parameters\NtpServer` |
| `specialPollIntervalSeconds` | `…\W32Time\TimeProviders\NtpClient\SpecialPollInterval` |
| `policyManaged`, `policyManagedValues[]` | presence of values under `HKLM\SOFTWARE\Policies\Microsoft\W32Time\Parameters` and `…\TimeProviders\NtpClient` |
| `serviceState`, `serviceStartType` | `svcquery.GetStatus("W32Time")` (`agent/internal/svcquery/svcquery_windows.go` ~25) |
| `hostTimeProviderEnabled` | `…\W32Time\TimeProviders\VMICTimeProvider\Enabled` (null when absent); VMware Tools time sync is not detected in v1 |
| status: `source`, `sourceKind`, `lastSuccessfulSyncAt`, `lastSyncError`, `stratum`, `pollIntervalSeconds` | method chosen in §4.2 |
| domain: `joinType`, `domainDns` | `mgmtdetect` identity (`agent/internal/mgmtdetect/deep_identity_windows.go` ~13) — reused, not re-implemented |
| domain: `role`, `forestDns`, `pdcName` | §4.3 |
| timezone | §4.5 |
| events | §4.4 |

### 4.2 Status source — W01 spike (task 0)

`w32tm /query /status` labels are translated, and the one documented structured API
(`W32TimeQueryNTPProviderStatus`, w32time.dll) could not be confirmed to be a stable export on the
agent's floor (Windows 10 / Server 2016, `agent/installer/breeze.wxs` ~137). The first task of W01 is a
spike on the Windows lab VM that evaluates, in this order:

1. `W32TimeQueryNTPProviderStatus` via `syscall.NewLazyDLL("w32time.dll")` — per-peer
   `u64LastSuccessfulSync`, `ulLastSyncError`, `ulStratum`, `wszUniqueName`.
2. Locale-independent tokens from `w32tm /query /status /verbose`. Only values that are not
   translated: the `0x`-prefixed ReferenceId and its four-character source tag (`LOCL`, `VMIC`, …),
   plus numeric fields located by position rather than by label.
3. Time-Service events 35/37 insertion strings (source name + event time) as the source and
   last-known-good fallback.

Acceptance: identical results on an English and a non-English display language; works on Windows 10
and Server 2016 or newer; `sourceKind` distinguishes as many of `local_clock`, `free_running`,
`vm_host`, `domain_peer`, `ntp_peer` as the chosen method can prove, and reports `unknown` for the
rest. Method 1 ships only if its prototype and buffer-ownership rules are confirmed from the Windows
SDK `w32time.h`; otherwise the fallback ladder ships (plan index R7). The spike records the chosen method(s) in the W01 plan. The snapshot carries
`status.method` (`provider_api` | `w32tm_tokens` | `events` | `unavailable`, the first one that produced
`source`) so the UI can say how a value was read. A field no method can read is `null` and
`sourceKind` is `unknown`.

### 4.3 Domain role

- `joinType` from `mgmtdetect`: `none` or `workplace` → `workgroup`; `azure_ad` → `entra_only`;
  `on_prem_ad` or `hybrid_azure_ad` → domain-joined, refined below.
- Domain-joined: `DsRoleGetPrimaryDomainInformation(DsRolePrimaryDomainInfoBasic)` gives `MachineRole`,
  `DomainNameDns`, `DomainForestName`.
  - Member workstation or server → `member`.
  - A domain controller → `DsGetDcNameW(NULL, domain, NULL, NULL, DS_PDC_REQUIRED | DS_RETURN_DNS_NAME)`.
    If the returned DC is this machine, the role is `pdc_emulator`; if also `DomainNameDns ==
    DomainForestName` (case-insensitive), it is `forest_root_pdc_emulator`. Otherwise `dc`.
  - Any API failure → `unknown` (D9: no enforcement). `pdcName` is reported whenever it resolved.

### 4.4 Time-Service events

Query the System log for `ProviderName = Microsoft-Windows-Time-Service`, all levels, since the last
successful run (first run: last 24 h), max 100, newest first. Each event carries `recordId`,
`eventId`, `level`, `occurredAt`, `message` (truncated to 1000 chars, display only) and `properties`
(insertion strings, used by the resolver instead of the translated message).

| ID | Meaning | Used for |
|---|---|---|
| 12 | Forest-root PDC is set to the domain hierarchy, nothing above it | `pdc_no_external_source` |
| 24 | No valid response from a domain controller | `ntp_peer_unreachable` |
| 29 | None of the configured sources are reachable | `ntp_peer_unreachable` |
| 36 | No sync for 86400 s | `sync_stale` |
| 47 | No valid response from a manual peer | `ntp_peer_unreachable` |
| 52 | Correction exceeded the allowed phase correction; refused | `correction_refused` |
| 129 | Unable to set a domain peer (discovery error) | `domain_source_unavailable` |
| 134 | Unable to set a manual peer (DNS resolution) | `ntp_server_unresolvable` |
| 35, 37 | Now syncing with / receiving valid data from a source | **success signal** (clears the above, §5.3) |

The collector also sends the most recent 20 Time-Service events of any ID for display. Lab runs L1–L4
(§12) confirm each ID's meaning and level; if Windows disagrees, the W01 plan corrects this table
before the resolver is written.

### 4.5 Timezone

`GetDynamicTimeZoneInformation` → `TimeZoneKeyName` (Windows zone ID), `Bias`,
`DynamicDaylightTimeDisabled`. Automatic timezone = `HKLM\SYSTEM\CurrentControlSet\Services\tzautoupdate\Start`:
`3` → `on`, `4` → `off`, anything else or missing → `unknown`. This is configured intent, not the
service's running state.

### 4.6 Scheduling and payload

- A `lastTimeSyncUpdate` gate in the heartbeat ticker (`agent/internal/heartbeat/heartbeat.go` ~2013–2138),
  interval 30 min with ±10 % jitter, first run 2–5 min after start. It sends via
  `sendInventoryData("time-status", snapshot, "time sync")` (~2328), the `sendManagementPosture` pattern (~4002).
- A monotonically increasing `sequence` persisted in the agent state dir (the server drops stale
  snapshots).
- W03 adds an immediate run after a `time_sync_settings` change and after each command.

```json
{
  "schemaVersion": 1,
  "sequence": 42,
  "collectedAt": "2026-09-28T12:00:00Z",
  "config": {
    "type": "NTP", "ntpServer": "time.cloudflare.com,0x9 pool.ntp.org,0x9",
    "specialPollIntervalSeconds": 3600, "policyManaged": false, "policyManagedValues": [],
    "serviceState": "running", "serviceStartType": "auto", "hostTimeProviderEnabled": null
  },
  "status": {
    "method": "provider_api", "source": "time.cloudflare.com", "sourceKind": "ntp_peer",
    "lastSuccessfulSyncAt": "2026-09-28T11:41:07Z", "lastSyncError": null,
    "stratum": 4, "pollIntervalSeconds": 1024
  },
  "domain": {
    "joinType": "none", "role": "workgroup",
    "domainDns": null, "forestDns": null, "pdcName": null
  },
  "timezone": { "windowsId": "Eastern Standard Time", "biasMinutes": 300, "dynamicDstDisabled": false, "autoUpdate": "off" },
  "events": [
    { "recordId": 81234, "eventId": 37, "level": 4, "occurredAt": "2026-09-28T11:41:07Z",
      "message": "The time provider NtpClient is currently receiving valid time data from …",
      "properties": ["time.cloudflare.com,0x9 (ntp.m|0x9|0.0.0.0:123->1.2.3.4:123)"] }
  ],
  "enforcement": null
}
```

`enforcement` is populated from W03 (§8.3). Unknown values are `null`, never an empty string.

## 5. Ingest and findings

### 5.1 Endpoint

`PUT /api/v1/agents/:id/time-status` in a new `apps/api/src/routes/agents/timeStatus.ts`, agent-auth
like the other inventory PUTs. Validated by `timeStatusSnapshotSchema` in
`packages/shared/src/validators/timeSync.ts`. Hostname-like fields are length-capped; `events` ≤ 100;
`message` ≤ 1000 chars; `properties` ≤ 10 × 500 chars. One transaction, run in the device's org
context:

1. If `sequence ≤ device_time_status.last_sequence`, return `200 { accepted: false }` (stale).
2. Build the resolver context (expected timezone §5.4, effective `time_sync` settings in W03).
3. `resolveTimeFindings(snapshot, ctx)` → `{ health, findings[], findingDetails }`.
4. Upsert `device_time_status`; upsert today's `device_time_daily` (§5.6).
5. W03: for each enforcement kind whose `resultId` differs from the stored one, write an audit entry (§8.5).

### 5.2 Finding catalogue

Resolver: `apps/api/src/services/timeSync/findings.ts`, a pure function (no DB access) with table-driven
tests. `severity` drives `health`. `fixHint` is the UI copy template.

| Code | Severity | Raised when | Fix hint |
|---|---|---|---|
| `pdc_no_external_source` | critical | role `forest_root_pdc_emulator` and (type `NT5DS`, or event 12 active) | "Set NTP servers on {device} — it is the forest root PDC and every domain member follows it." |
| `source_local_clock` | critical | `sourceKind ∈ {local_clock, free_running}` | "Syncing from its own clock. Configure an NTP source (or, if domain-joined, check its DC)." |
| `dc_vm_host_sync` | warning | role ∈ {dc, pdc_emulator, forest_root_pdc_emulator} and (`hostTimeProviderEnabled = true` or `sourceKind = vm_host`) | "Disable the VM host time provider on this DC." |
| `ntp_server_unresolvable` | warning | event 134 active, or (type ∈ {`NTP`, `AllSync`} and any `ntpServer` host fails hostname/IP syntax) | "NTP server {host} does not resolve or is not a valid name — fix it or DNS." |
| `ntp_peer_unreachable` | warning | events 24/29/47 active | "No response from {source} — check UDP 123 outbound." |
| `domain_source_unavailable` | warning | event 129 active | "Cannot find a domain time source — check DC reachability." |
| `member_not_on_hierarchy` | warning | role ∈ {member, dc, pdc_emulator} (not forest root) and type ∉ {`NT5DS`, `AllSync`} and not `policyManaged` | "Domain-joined but not using the domain hierarchy." |
| `sync_disabled` | critical | type `NoSync`, or `serviceStartType = disabled` | "Windows Time is disabled." |
| `sync_stale` | warning | not `sync_disabled`, and (`now − lastSuccessfulSyncAt > max(3 × effectivePoll, 24 h)` or event 36 active); effectivePoll = `status.pollIntervalSeconds ?? specialPollIntervalSeconds ?? 604800` | "No successful sync since {lastSuccessfulSyncAt}." |
| `correction_refused` | warning | event 52 active | "The clock is too far off for Windows to correct itself; resync or fix manually." |
| `timezone_mismatch` | info | expected zone known, `autoUpdate ≠ on`, and `windowsId ≠ expected` | "Timezone is {actual}, expected {expected} (from {site or policy})." |
| `policy_not_applied` (W03) | warning | enforcement enabled and the last result failed, or role `unknown` | "Time policy could not be applied: {error}." |
| `policy_conflict_gpo` (W03) | info | enforcement enabled and `policyManaged` | "W32Time is managed by Group Policy; Breeze is not changing it." |

`health` = the worst severity present (`critical` > `warning` > `info` → `healthy`), or `unknown` when
there is no snapshot or `status.method = unavailable` and no other finding applies. `info` findings do
not change health from `healthy`, but they are shown and are alertable.

### 5.3 Event activity rule

An event-derived finding is **active** when its latest occurrence (in this snapshot's `events`, or
carried forward in `device_time_status.event_marks`) is within the last 24 h **and** later than the
latest success signal (35/37) or a `lastSuccessfulSyncAt` newer than it. `event_marks` stores, per event
ID, the latest `occurredAt` seen, so a failure event sent once stays active across snapshots until a
success clears it or it ages out.

### 5.4 Expected timezone

`resolveExpectedTimezone(device, settings)` in `services/timeSync/expectedTimezone.ts`, the single
resolver used by ingest, the device view, the fleet page and heartbeat delivery:

1. W03 policy `timezone.expected = 'pinned'` → `pinnedTimezone`, provenance `policy:<policyId>`.
2. The device's site `timezone`, unless it is `UTC` or `Etc/UTC` → provenance `site:<siteId>`.
3. Otherwise none (no `timezone_mismatch` is possible).

IANA → Windows mapping: `packages/shared/src/data/windowsZones.json`, generated from CLDR
`windowsZones.xml` (`territory="001"` rows, plus aliases), pinned to a CLDR version recorded in the
file's header, with a generator script and a test that every IANA zone offered by the site timezone
picker maps to exactly one Windows ID. Comparison happens in Windows-ID space, because many IANA zones
map to one Windows zone (`America/Detroit` → `Eastern Standard Time`). The resolved expected zone and
its provenance are stored on the status row, so later site edits do not rewrite past daily rows.

### 5.5 Freshness

The device view and fleet page show `lastReceivedAt`. A status older than 3 × 30 min is shown as
**stale** and its findings are not alertable (the handler returns `dataAvailable: false`, §7.2).
Offline devices are covered by the existing `offline` monitor.

### 5.6 Daily rollup

Upsert on `(device_id, day)` where `day = (collectedAt AT TIME ZONE 'UTC')::date`: `worst_health`
(order `critical > warning > unknown > healthy`), `finding_codes` (union), `source`, `source_kind`,
`sync_type` (latest), `last_successful_sync_at` (max), `snapshot_count` (+1), `expected_timezone`,
`timezone_windows_id` (latest). "Latest" is the latest accepted snapshot in ingest order. A day with no
row is a gap.

## 6. Schema and tenancy

### 6.1 Tables

Both tables are tenancy shape 5 (device-scoped, denormalized `org_id`, hot agent-write), policy
`breeze_has_org_access(org_id)`, RLS enabled and forced. Drizzle schema in
`apps/api/src/db/schema/timeSync.ts`, modelled on `apps/api/src/db/schema/hardwareHealth.ts`.

**`device_time_status`**: `device_id uuid PK`, `org_id uuid NOT NULL → organizations ON DELETE CASCADE`,
`last_sequence bigint`, `collected_at`, `received_at`, `agent_version text`, `health text CHECK
(health IN ('healthy','warning','critical','unknown'))`, `findings text[] NOT NULL DEFAULT '{}'`,
`finding_details jsonb`, `sync_type text`, `ntp_server text`, `special_poll_interval_seconds int`,
`policy_managed boolean`, `service_state text`, `service_start_type text`,
`host_time_provider_enabled boolean`, `status_method text`, `source text`, `source_kind text`,
`last_successful_sync_at timestamptz`, `last_sync_error text`, `stratum int`,
`poll_interval_seconds int`, `join_type text`, `domain_role text`, `domain_dns text`,
`forest_dns text`, `pdc_name text`, `timezone_windows_id text`, `timezone_bias_minutes int`,
`timezone_auto_update text`, `expected_timezone text` (IANA), `expected_timezone_windows_id text`,
`expected_timezone_source text`, `event_marks jsonb`, `finding_streaks jsonb` (W02, §7.2),
`recent_events jsonb`, `policy_managed_values text[]`, and (W03) `enforcement jsonb` (the latest
report per kind; its `resultId`s are what ingest compares to decide whether to audit), `created_at`,
`updated_at`.
Indexes: `(org_id, health)`, `(org_id, domain_dns, domain_role)`, GIN on `findings`.

**`device_time_daily`**: `device_id`, `org_id`, `day date`, PK `(device_id, day)`, `worst_health`,
`finding_codes text[]`, `source`, `source_kind`, `sync_type`, `last_successful_sync_at`,
`snapshot_count int`, `expected_timezone`, `timezone_windows_id`, `created_at`, `updated_at`.
Index `(org_id, day)`.

Both carry the composite FK `(device_id, org_id) → devices(id, org_id) ON UPDATE CASCADE ON DELETE
CASCADE DEFERRABLE INITIALLY IMMEDIATE`, exactly as
`apps/api/migrations/2026-10-30-110000-hardware-health-tables.sql` ~36 does.

### 6.2 Migrations

Hand-written, idempotent, no inner `BEGIN`, elect system scope before any write. Filenames use
`YYYY-MM-DD-HHMMSS-<slug>.sql` and must sort after the newest committed migration at authoring time
(currently `2026-11-08-170200-alert-resolution-reason.sql` — check again when writing, the ceiling
moves).

- W01: `…-time-sync-tables.sql` — `device_time_status` + RLS + FK.
- W02: `…-time-sync-daily.sql` — `device_time_daily` + RLS + FK, and `ADD COLUMN IF NOT EXISTS
  finding_streaks` on `device_time_status`; `…-monitor-kind-time-sync.sql` — `monitorKindEnum` value.
- W03: `…-time-sync-config-feature.sql` — `enforcement` on `device_time_status`,
  `configFeatureTypeEnum` value, `config_policy_time_sync_settings`
  (keyed by `feature_link_id`, parent-predicate RLS copied from
  `2026-10-30-110100-hardware-monitoring-config-feature.sql`, plus the SELECT-only partner-wide branch
  from `2026-10-05-110000-config-policy-partner-wide-select.sql`).

### 6.3 Registrations (the step that gets missed)

Each new `org_id` table is added, in the same PR as the table, to:

| List | File | Both tables |
|---|---|---|
| `CORE_ORG_CASCADE_DELETE_ORDER` (alphabetical, children first) | `services/tenantCascade.ts` | yes |
| `CORE_DEVICE_CASCADE_DELETE_TABLES` | `routes/devices/core.ts` | yes |
| `CORE_DEVICE_ORG_DENORMALIZED_TABLES` | `routes/devices/core.ts` | yes |
| merge policy `repoint` | `services/orgMergeRegistry.ts` | yes |
| `CORE_TENANT_EXPORT_POLICY` | `services/tenantExportPolicyRegistry.ts` | yes — every jsonb column (`finding_details`, `event_marks`, `finding_streaks`, `recent_events`, `enforcement`) is `excludedOpen`; `ntp_server`, `pdc_name` and `last_sync_error` are `included`. Adding a column in a later wave (`finding_streaks` in W02, `enforcement*` in W03) needs its classification in that wave's PR |
| RLS coverage | `rls-coverage.integration.test.ts` | no allowlist entry: a direct `org_id` policy is auto-discovered (the table is not an EXISTS-join `DEVICE_ID_JOIN_POLICY_TABLES` case) |

`config_policy_time_sync_settings` follows whatever `config_policy_hardware_monitoring_settings` is
registered in (no `org_id` column → no cascade/export entry). Run the Integration Tests contract suites
locally before each PR (`tenantCascade`, `tenant-export-policy`, `orgMergeRegistry`, `rls-coverage`).

### 6.4 Retention

`apps/api/src/jobs/timeSyncRetention.ts`, daily, modelled on `jobs/hardwareHealthRetention.ts`:
`pruneInCtidBatches` on `device_time_daily WHERE day < current_date - 400`. `device_time_status` is one
row per device and is removed by the device cascade.

## 7. Alerting (W02)

### 7.1 `time_sync` monitor kind

- `packages/shared/src/validators/monitors.ts`: add `'time_sync'` to `MONITOR_KINDS`, **not** to
  `SERVER_EVALUATED_MONITOR_KINDS` (per-subject alerts, root-only, like `hardware_health`). Condition:

  ```ts
  time_sync: z.object({
    findings: z.array(z.enum(TIME_SYNC_FINDING_CODES)).min(1),
    consecutiveSnapshots: z.number().int().min(1).max(10).default(2),
  }).strict()
  ```

- `apps/api/src/services/monitors/kinds/timeSync.ts`: `overridableKeys: ['consecutiveSnapshots']`,
  `defaultSeverity: 'medium'`, `agentDelivered: false`, `alertCategory: 'system'`,
  `titleTemplate: '{{findingLabel}} on {{deviceName}}'`,
  `messageTemplate: '{{ruleName}}: {{findingDetail}}'`. Registered in `kinds/index.ts`, the DB enum and
  `apps/web/src/components/monitoring/monitorKindFields.ts` (reusing the `multiselect` field kind the
  hardware kind added).

### 7.2 Handler

`apps/api/src/services/alertConditions/handlers/timeSync.ts`, registered in `alertConditions/index.ts`:

1. Load `device_time_status`. Missing → every selected code gets `unknown` evidence, `dataAvailable: false`.
2. Stale (§5.5) → every in-scope subject `unknown`, `dataAvailable: false`.
3. For each selected finding code: `breaching` when present in `findings` for ≥ `consecutiveSnapshots`
   accepted snapshots, `recovered` when absent for ≥ `consecutiveSnapshots`, otherwise `unknown`.
   Streaks are counted at ingest per accepted snapshot (`finding_streaks jsonb` on the status row, kept
   next to `event_marks`), never per sweep, because the sweep runs every 60 s against a 30-min snapshot.
4. `subjectKey = finding code`. Alert context: `{ source: 'time_sync', findingCode, findingLabel,
   findingDetail, domainRole, timeSource, lastSuccessfulSyncAt }`.

Subject alerts ride the existing `subject_key` path in `alertService.ts` (dedupe, auto-resolve on
`recovered`, one automation-response owner per episode). Two narrow fixes are needed where that path
still assumes hardware (plan index R11): `services/alertSubjects.ts` stamps every subject as
`hardware_health`, and the maintenance-suppression recovery check in `services/alertService.ts` only
admits hardware subjects.

### 7.3 Built-in defaults

`BUILT_IN_MONITORS_VERSION` 3 → 4 (`apps/api/src/services/monitors/builtInMonitors.ts` ~40). Provisioned
partner-wide, not attached.

| key | name | findings | consecutive | severity |
|---|---|---|---|---|
| `time_source_problem` | Time source problem | `pdc_no_external_source`, `source_local_clock`, `dc_vm_host_sync`, `ntp_server_unresolvable`, `ntp_peer_unreachable`, `domain_source_unavailable`, `member_not_on_hierarchy`, `correction_refused` | 2 | high |
| `time_sync_stale` | Time sync stale or disabled | `sync_stale`, `sync_disabled` | 2 | medium |
| `timezone_mismatch` | Timezone mismatch | `timezone_mismatch` | 2 | low |
| `time_policy_not_applied` (W03, version 5) | Time policy not applied | `policy_not_applied` | 2 | low |

## 8. Management (W03)

### 8.1 Config-policy feature `time_sync`

Inline feature (Pattern B), mirroring `hardware_monitoring` end-to-end:

- `CONFIG_FEATURE_TYPES` + `configFeatureTypeEnum` (appended at the end of both; a parity test checks
  them), `CONFIG_POLICY_FEATURE_TRUST_TIER.time_sync = 'protective'` (D10), the inline-only branch of
  `validateFeaturePolicyExists` (`services/configurationPolicy.ts` ~2962–2982), and the
  decompose/assemble/validate `case` sites (~854/863, ~1127, ~1172, ~1326/1343). Partner-wide allowed;
  not in `ORG_SCOPED_ONLY_FEATURE_TYPES`.
- Table `config_policy_time_sync_settings` with typed columns, like
  `config_policy_hardware_monitoring_settings`: `id`, `feature_link_id` (unique, FK cascade),
  `enforce_ntp boolean NOT NULL DEFAULT false`, `ntp_servers text[] NOT NULL DEFAULT '{}'`
  (`CHECK cardinality ≤ 5`), `poll_interval_minutes int NOT NULL DEFAULT 60 CHECK 15..1440`,
  `timezone_expected text NOT NULL DEFAULT 'site' CHECK IN ('site','pinned')`, `pinned_timezone text`,
  `timezone_auto_fix boolean NOT NULL DEFAULT false`, `created_at`, `updated_at`, with
  `CHECK (timezone_expected = 'site' OR pinned_timezone IS NOT NULL)` and
  `CHECK (NOT enforce_ntp OR cardinality(ntp_servers) ≥ 1)`.
- Shared schema `timeSyncInlineSettingsSchema` (`packages/shared/src/validators/timeSync.ts`):

  ```ts
  {
    enforceNtp: boolean,                        // default false
    ntpServers: string[],                       // 0–5; required (≥1) when enforceNtp
    pollIntervalMinutes: number,                // int 15..1440, default 60
    timezone: {
      expected: 'site' | 'pinned',              // default 'site'
      pinnedTimezone: string | null,            // IANA, must exist in windowsZones.json; required when pinned
      autoFix: boolean,                         // default false
    },
  }
  ```

  Each `ntpServers` entry must be an IPv4 literal, an IPv6 literal, or a hostname matching
  `^(?=.{1,253}$)([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$`.
  No commas, spaces, flags or ports: the agent appends `,0x9` itself. The agent re-validates with the
  same rule before any exec.
- **Settings statement (CLAUDE.md rule 9).** Home: Configuration Policies → Time sync tab. Level:
  partner-wide or org policy through normal policy inheritance. Resolver: `resolveDeviceTimeSyncSettings`.
  NTP configuration is configured in 0 places before and 1 after. The expected timezone is configured
  in 1 place before (site) and 2 after (site, and policy `pinned`). This is a stated exception: the pin
  exists for devices that should not follow their site (UTC servers), and both the policy tab and the
  device Time section say "overrides the site timezone" wherever it applies. No removal plan: the two
  are different concepts (where a site is vs. what a device should run).

### 8.2 Delivery

`resolveDeviceTimeSyncSettings` → Redis-cached `getDeviceTimeSyncSettings`
(`timesync:settings:device:${deviceId}`, 120 s TTL, the hardware-monitoring value) →
`buildTimeSyncConfigUpdate` in `apps/api/src/routes/agents/helpers.ts`. It is resolved inside the
existing system-context block in `heartbeat.ts` (~2267–2359, one try/catch per resolver) and merged into
the final `configUpdate` as `time_sync_settings` (~2369–2400). It must not go into `mergedConfigUpdate`
(policy readers are excluded there, #1105 / #2930), and must not open an extra pool connection (the
09-22 US pool deadlock). Payload:

```json
{ "enforce_ntp": true, "ntp_servers": ["time.cloudflare.com"], "poll_interval_minutes": 60,
  "timezone": { "expected_windows_id": "Eastern Standard Time", "auto_fix": false },
  "fingerprint": "sha256:…" }
```

With no policy link, the defaults are sent (enforcement off), so removing a policy stops enforcement.
If the resolver fails, the key is omitted and the agent keeps its last settings. The agent dispatches
`time_sync_settings` in `applyConfigUpdate` above the policy-probe early return
(`agent/internal/heartbeat/heartbeat.go` ~3182–3185), accepting snake_case and camelCase like the others.

### 8.3 Agent reconciliation

Runs after each collection when `enforce_ntp` or `timezone.auto_fix` is set, and on `time_apply_policy`.

1. **Desired source** from the role (D8): `workgroup`, `entra_only`, `forest_root_pdc_emulator` →
   manual peers; `member`, `dc`, `pdc_emulator` → domain hierarchy; `unknown` → skip and report
   `policy_not_applied` (reason `role_unknown`).
2. **Guards**, re-read immediately before any write: role unchanged, and `policyManaged = false`.
   If `policyManaged`, skip and report `conflict_gpo`.
3. **Compare** desired with current. Manual-peer roles: `Type`, the normalized `NtpServer` host
   list, `SpecialPollInterval`, service start type. Domain-hierarchy roles: `Type` (`NT5DS` or
   `AllSync` is compliant) and service start type only. Equal → nothing to do.
4. **Apply** with `exec.Command` argument arrays (never a shell):
   (Order amended by plan index R20: service start type and start come first, because
   `w32tm /config … /update` fails while W32Time is stopped.)
   - Manual peers: `w32tm /config /manualpeerlist:"<h1>,0x9 <h2>,0x9" /syncfromflags:manual /update`,
     and `/reliable:yes` added on the forest-root PDC. Then set `SpecialPollInterval =
     pollIntervalMinutes × 60` in the registry and `w32tm /config /update`.
   - Domain hierarchy: `w32tm /config /syncfromflags:domhier /update`.
   - Service: start type Automatic (`sc.exe config W32Time start= auto`, the precedent at
     `agent/internal/collectors/boot_performance_windows.go` ~519), then start it if stopped.
   - `w32tm /resync /rediscover`. A non-zero exit here is recorded but does not fail the apply,
     because the next snapshot's findings report the sync outcome.
5. **Read back** the registry values. Result `ok` only if they equal the desired values.
6. **Rate limit**: at most one apply per hour for the same `fingerprint`; on failure back off
   1 h → 2 h → 4 h … capped at 24 h; a new fingerprint resets both. `time_apply_policy` bypasses them.
7. **Report** `enforcement = { ntp, timezone }`, each `{ resultId, fingerprint, at, outcome:
   'ok'|'failed'|'skipped', reason, before, after, error }` or null, in the next snapshot (sent
   immediately after an apply). The latest result per kind is resent in every snapshot; a
   rate-limited run produces no new result. Exact schema: plan index §F.3.

Turning enforcement off, or removing the policy, leaves the configuration as it is. The before and after
values are in the audit log.

### 8.4 Timezone auto-fix

When `auto_fix` is on, `expected_windows_id` is set, `autoUpdate ≠ on` and `windowsId ≠ expected`: run
`tzutil /s "<expected_windows_id>"`, after checking that
`HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Time Zones\<id>` exists on the device (the
installed catalog is authoritative; no embedded list). It shares the rate limits above, and its result goes in `enforcement.timezone`.

### 8.5 Audit

On ingest, each `enforcement.ntp.resultId` / `enforcement.timezone.resultId` not equal to the stored
one writes one audit entry `time_sync.enforced` (system actor,
device resource) with `outcome`, `before` and `after`. Commands are audited by the existing
`device.command.queue` path.

## 9. Commands (W03)

| Type | Payload | Agent action | Offline |
|---|---|---|---|
| `time_resync` | — | Start W32Time if stopped; `w32tm /resync /rediscover`; return exit code plus `lastSuccessfulSyncAt` before/after; trigger a snapshot | expire after 1 h |
| `time_set_timezone` | `{ windowsId }` (server-resolved expected zone; validated by `isKnownWindowsZone` on the server and the Time Zones registry key on the device) | `tzutil /s`; return before/after; trigger a snapshot | expire after 1 h |
| `time_apply_policy` | — | Run §8.3 now, ignoring rate limits; return the enforcement result | expire after 1 h |

Registered in `apps/api/src/services/commandTypes.ts`, `commandOfflinePolicy.ts`, `commandTimeouts.ts`
(60 s), `GATED_COMMAND_TYPES` (`services/partnerTrust.ts` ~57), `createCommandSchema`
(`routes/devices/schemas.ts` ~284); agent constants in `agent/internal/remote/tools/types.go`, handlers in
a new `agent/internal/heartbeat/handlers_timesync.go` (the `handlers_audit_policy.go` pattern), and
`agent/internal/privilege/check.go` (elevated). They are issued through `POST /devices/:id/commands` (DEVICES_EXECUTE,
MFA, `assertDeviceExecuteAllowed`, audit). Bulk actions on the fleet page call that route once per
device and show each device's outcome. The web handlers use `runAction`.

## 10. Web UI

- **Device → Info tab, "Time" section** (`apps/web/src/components/devices/time/DeviceTimeSection.tsx`,
  rendered by `DeviceInfoTab.tsx` next to Operating System ~874). It shows:
  - the health badge and findings with fix hints (§5.2);
  - source and source kind, sync type, role (PDC emulator names the domain), last successful sync,
    poll interval, service state, a "Managed by Group Policy" badge, and how status was read;
  - timezone: current, expected, and its provenance ("from site Main Office" or "from policy X —
    overrides the site timezone");
  - recent Time-Service events;
  - freshness (§5.5);
  - "No time data yet — this needs an agent update that includes time sync" when a Windows device has
    never sent a snapshot; "Not supported on this OS yet" for macOS and Linux.

  W03 adds Resync, Set timezone to expected and Apply time policy now.
- **Fleet page `/devices/time`** (`pages/devices/time.astro` → `FleetTimeSyncReport`, the
  `posture.astro` / `FleetPostureReport` pattern), fed by `GET /api/v1/time-status` (org/partner
  scoped, paginated). It has:
  - filters: health, finding, role, org, site;
  - a **by AD domain** view: one group per `domain_dns` with its forest-root PDC (or domain PDC) row
    pinned first, marked with a warning when that PDC is not enrolled (no device reports
    `pdc_emulator` for a domain whose members report `pdcName`);
  - bulk resync and set-timezone (W03);
  - CSV export of current status, and of `device_time_daily` for a chosen date range, with a header
    line "Observed synchronization reported by the Breeze agent; days without a report are listed as
    gaps."

  The nav entry sits next to Fleet Posture under Reporting. Selected view and filters use
  `window.location.hash`.
- **Configuration policy → Time sync tab** (`TimeSyncTab.tsx`, `FeatureTabShell` + `useFeatureLink`,
  `FEATURE_META`, `ConfigPolicyDetailPage` wiring, Effective Config parity). It contains:
  - the enforcement switch;
  - the NTP server list with inline validation;
  - the poll interval;
  - timezone expected (site/pinned) with a zone picker and the auto-fix switch;
  - copy that explains the domain-aware rule and that GPO wins.
- The monitor editor gets the `time_sync` kind via `monitorKindFields.ts`.

## 11. AI tools, MCP coverage, docs

- `get_device_time_status` (tier 1) in `services/aiToolsDevice.ts` (template `get_device_hardware_health`
  ~317) and `list_time_sync_issues` (tier 1, org/partner scoped, filter by finding/role/domain). Also
  update `aiToolSchemas.ts`, `aiGuardrails.ts`, `aiAgentSdkTools.ts`, `HELPER_TOOL_SCOPING`,
  `helperToolFilter.ts` and `aiAgents/agentToolCatalog.ts` as the hardware tool did.
- `get_device_time_status` ships in W01 with the device route; `list_time_sync_issues` ships in W02
  with the fleet route.
- `MCP_COVERAGE` (`services/mcpCoverage.ts`): an entry for each new route file in the wave that adds
  it — `devices/timeStatus.ts` (W01, `get_device_time_status`) and `timeStatus.ts` (W02,
  `list_time_sync_issues`).
- Docs (`apps/docs`): "Time sync" page covering what is checked, each finding and its fix, the
  domain-aware rule, GPO precedence, and the evidence export and its limits.

## 12. Testing and lab proof

**Unit / contract (per wave):**

- `findings.test.ts`: table-driven over every finding, role and event-activity case (§5.3), including
  "failure then success clears", "success then failure is active", 24 h age-out, and `unknown` health.
- `expectedTimezone.test.ts` and the `windowsZones.json` coverage test (every picker zone maps).
- Ingest route: stale sequence rejected, upserts, daily rollup union/max, RLS context.
- Validators: `ntpServers` accepts hostnames and IP literals and rejects `a,0x9`, `a b`, `a;b`, `-flag`,
  ports and quotes. The Go validator runs the same table (a shared JSON fixture under
  `packages/shared/src/validators/__fixtures__/ntpServers.json`, read by the Go test through a relative
  path).
- Go: role derivation from fake DsRole/DsGetDcName results; reconciliation over a fake `w32tm`/registry
  seam (desired-by-role, GPO skip, unknown-role skip, read-back mismatch → failed, rate limit and
  back-off, fingerprint reset); payload has `null` for unknowns.
- Handler: streaks, stale → unknown, per-finding subjects, built-in provisioning at version 4 (and 5).
- Contract suites with a real DB: `tenantCascade`, `tenant-export-policy`,
  `tenantExportErasureRoundtrip`, `orgMergeRegistry`, `rls-coverage`, `moveOrg.coverage`,
  `cascadeDelete`.

**Lab (Windows lab VM + nested brzlab VMs; never a second agent on a host with the installed agent):**

| # | Setup | Proves |
|---|---|---|
| L1 | Workgroup Server 2022, default config | collection, `sync_stale` math, timezone fields |
| L2 | Workgroup, `NtpServer` set to an unresolvable name | event 134 → `ntp_server_unresolvable`, clears after fixing |
| L3 | AD lab: forest-root PDC on NT5DS | event 12 / `pdc_no_external_source`; fleet page pins the PDC |
| L4 | Same PDC with VMIC provider enabled | `dc_vm_host_sync` |
| L5 | Member server | role `member`, source is a DC, no findings |
| L6 | GPO sets W32Time on the member | `policyManaged`, `policy_conflict_gpo`, no write (W03) |
| L7 | Policy enforcement across L1/L3/L5 | manual peers on workgroup and PDC (`/reliable:yes`), NT5DS on member, read-back ok, audit entry |
| L8 | Timezone auto-fix, auto-timezone on vs off | fix only when off |
| L9 | One VM with a non-English display language | identical snapshot values (§4.2 acceptance) |

## 13. Waves

| Wave | Contents | Ships to customers |
|---|---|---|
| **W01 — Visibility** | §4.2 spike; Windows collector; `device_time_status` + registrations; ingest + findings resolver + expected-timezone resolver + CLDR table; device Time section; `get_device_time_status` + MCP; docs page (visibility) | API + web + **agent release** |
| **W02 — Alerts and evidence** | `time_sync` monitor kind + handler + streaks + built-ins (v4); `device_time_daily` + retention job; fleet page with AD-domain grouping; CSV exports; `list_time_sync_issues` + MCP; docs (alerts, evidence) | API + web |
| **W03 — Management** | `time_sync` config-policy feature + delivery; agent reconciliation + timezone auto-fix; three commands; policy tab; device and bulk actions; `policy_*` findings + built-in (v5); lab L6–L8 | API + web + **agent release** |

W01 and W03 need the Windows lab proof before their agent releases.

## 14. Risks and open items

- **Status method (§4.2).** If no locale-independent method yields `lastSuccessfulSyncAt`, `sync_stale`
  falls back to event 36 only, and the UI shows "last sync unknown". The spike decides; the W01 plan
  records the outcome.
- **Unenrolled PDC blind spot** (accepted, §1 out of scope). Mitigated only by the fleet page's
  "PDC not enrolled" marker.
- **Event 12 without NT5DS.** Event 12 can linger from an earlier misconfiguration. It is only active if
  no success signal followed (§5.3), which is the intended behaviour.
- **Evidence is observational.** A compromised agent can report anything. Exports say so, and the
  evidence claim is limited to "observed".
- **Device move / delete.** Daily history follows the device to its new org (the standard denormalized
  contract), and is deleted with the device. Exported CSVs are the durable artifact.

## 15. Advisor quorum record

Fable's original position was a Breeze-measured offset (server-side from the WebSocket ping) plus
agent-side enforcement. Codex (gpt-6-astra, xhigh, read-only) reviewed it on 2026-09-28. Its findings
that still apply after the owner chose events-only (D1):

- **W32TimeQueryNTPProviderStatus is unverified** as a stable export on the agent's OS floor → the §4.2
  spike with a locale acceptance test. Adopted.
- **Clock stepping needs its own design** → out of scope. Adopted.
- **Timezone: no org fallback** (the owner chose site-based) → D6. Adopted. Codex's alternative, a site
  timezone provenance column, was rejected in favour of the owner's "UTC = unset" rule plus the pinned
  zone.
- **Auto-timezone is the `tzautoupdate` Start value (3), not service state** → §4.5. Adopted.
- **Fail closed on unknown role or management; re-check before writes; read back** → D9, §8.3. Adopted.
- **`protective` is defensible under the narrow self-selection taxonomy, but is not authorization** →
  D10 wording. Adopted.
- **Count streaks per accepted observation, not per sweep; make staleness cadence-aware** → §7.2,
  §5.2 `sync_stale`. Adopted.
- **Compliance has no unknown state** → compliance-rule integration deferred. Adopted.
- **Evidence must show gaps and is observation, not attestation** → D12, §10 export header. Adopted.
- **Offset-measurement concerns** (ping/pong pairing, server reference health, write volume): moot for
  v1 (D1); they carry over to any follow-on offset check.
