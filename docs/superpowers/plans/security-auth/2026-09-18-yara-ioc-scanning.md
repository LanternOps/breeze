---
tracking_issue: LanternOps/breeze#6263
---
# YARA IOC scanning and live security policy — Plan Index

**Spec:** `docs/superpowers/specs/security-auth/2026-09-18-yara-ioc-scanning-design.md` (drafted 2026-09-18).

One plan document per wave. Each wave is one PR on its own branch
`feature/6263-yara-ioc-scanning/wave-<sub-issue#>` with `Closes #<sub-issue#>` in the PR body.
State lives on GitHub (feature-lifecycle); the wave sub-issue is the source of truth for status,
never this index.

| Wave | Plan | Depends on |
|---|---|---|
| W01 (#6264) | [Live security policy: scheduler, settings delivery, Security tab cleanup, Scans page, neutralized quarantine](2026-09-18-yara-ioc-scanning-w01-live-policy.md) | — |
| W02 (#6265) | [YARA-X engine in the agent: on-device compile (`breeze-yarac`), source-bundle contract §C1–C5, fetch client + compiled cache, worker-pool walk, `provider = 'breeze'`, lab benchmark](2026-10-13-yara-ioc-scanning-w02-agent-engine.md) | W01 (merged) |
| W03 (#6266) | [Rule sets, pre-check, CRUD, agent fetch route, payload `ruleSets` (Part A) + built-in YARA Forge pack pipeline (Part B)](2026-10-13-yara-ioc-scanning-w03-rule-sets.md) | W02 (bundle format) |
| W04 (#6267) | Detection rules UI and IOC import (rule-set editor, compile errors, test upload, IOC paste importer, Security tab rule-set picker, ThreatDetail rule panel) — plan not written | W03 |
| W05 (#6268) | Fleet sweep, AI tool and audit (`sweep` route + batch tracking, AI `security_scan` actions + parity files, audit events, docs + release-notes copy per spec §11) — plan not written | W03 |

W01 shipped (PR #6573); W02 builds on its scanner code. W03 depends on W02's source-bundle format
(W02 plan §C1–C5); W04 and W05 depend on W03.

## Gates

- **Gate B — Todd's approval of this W01 plan before W01 is dispatched.** Nothing in W01 starts until
  that approval is recorded on #6264.
- **Quorum: done 2026-10-13** (spec §14.2), together with the owner decision on compile location
  (spec §14.1). The paragraph below is the original gate text, kept for history.
- **The Codex `gpt-6-astra` xhigh read-only quorum is still owed, and it is a W02 gate, not a W01 gate**
  (spec §14: the subscription was rate-limited when the spec was written). Expected challenge areas:
  D1 (wasm vs a native sidecar now), D3 (riding the `security` feature type vs a new one), §5 step 1
  (where rules are compiled). W01 touches none of those three, which is why it is cleared to run first.
- **W02 publishes the wasm-vs-native benchmark on the Windows lab rig** (spec §10). The sidecar
  decision is made on those numbers and recorded in spec §14 before W03 starts.

## Migration slots reserved

**None. W01 ships no migration at all** — see the W01 plan's Global Constraints for the proof that
every field it needs already exists (`config_policy_feature_links.inline_settings` is `jsonb`, and
`security_scans.status` is a bare `varchar(20)` with no CHECK constraint). The first migration in this
feature is W03's, which creates `yara_rule_sets` and `yara_rules` and carries their RLS, both
allowlists and every cascade/export registration in the same PR.

**Amended 2026-10-13:** W02 carries one migration (`ALTER TYPE security_provider ADD VALUE IF NOT EXISTS
'breeze'`), so the first migration is W02's. W03 Part A carries one migration (both tables, RLS, the
owner-inheritance triggers, and `security_scans.engine` / `rule_set_errors`). Names are chosen at
implementation time to sort after the newest committed migration.

## Open Decisions for W02/W03 (2026-10-13)

Each has a recommendation; the plans are written to the recommendation and change in one place if
Todd picks otherwise.

1. **What "server-side validator = fallback/pre-check" means.** Recommend: pre-check only; the server
   never compiles to or ships bytecode, and "fallback" is the agent falling back to the legacy
   signatures per scan with an explicit degraded outcome recorded. Alternative (server-compiled
   bytecode as a fallback when an agent's compile fails) rejected: serialized-rule portability across
   arch/engine versions is unproven and it resurrects `compiled bytea`.
2. **Pre-check runtime in the API.** Recommend: build `breeze-yarac` in a Go stage of the API
   Dockerfile (same code as the agent ⇒ errors match). Alternative: TS-only lint (bans/caps/name), API
   image stays Node-only, real compile errors surface only when agents report them — choose this if
   the API image must not gain a Go binary. No official YARA-X Node binding exists.
3. **W02 lands dark (no fetch route until W03).** Recommend yes: the route needs W03's tables; W02 is
   proven by Go tests against an httptest server.
4. **Split W03 into W03a (tables, pre-check, CRUD, fetch, payload) and W03b (built-in pack pipeline,
   clean-corpus CI, boot upsert).** Recommend yes — add a sub-issue for W03b; the W03 plan is already
   in Part A / Part B form.
5. **Built-in pack lives in `yara_rule_sets` as an `is_builtin` row** (alert_templates precedent,
   with the quorum's corrected CHECK `built-in ⇔ both owners NULL`). Recommend yes over a separate
   platform table: one id space for `ruleSetIds`, one fetch route.
6. **`yara_rules` owner columns.** Recommend denormalized `org_id`/`partner_id`/`is_builtin` kept equal
   to the parent by triggers, so rule source rides the org export/erasure path. Alternative: no owner
   columns + parent-join RLS (access_review_items precedent) — simpler RLS, but rule text drops out of
   tenant export.
7. **If W02's spike finds `pe`/`elf`/`hash`/`math` missing from yaraxwasm** (spec Q1). Recommend the
   W03b pack filter drops rules importing a missing module and the sidecar decision moves up to
   right after W02; decided on W02 Task 1's recorded outcome.
8. **Every `security_scan` threat is attributed `provider = 'breeze'`**, legacy-signature hits
   included (today they inherit the device's AV product name). Recommend yes.
9. **Pre-check unavailable in production** (binary missing / timeout). Recommend: refuse to publish,
   mark the set stale; lint-only publishing only in dev behind `BREEZE_YARA_LINT_ONLY=1`.
10. **Do new policies default to the built-in pack?** Recommend: no implicit attachment (empty
    `ruleSetIds` = legacy scan); W04's picker preselects the built-in pack for newly created policies
    only.
11. **macOS background-priority scanning.** Recommend: logged no-op in W02 (per-thread I/O policy
    needs cgo `setiopolicy_np`); file a follow-up.

## Cross-wave names that must not drift

Defined in W01 and consumed verbatim by later waves:

### Shared (`packages/shared/src/types/securityScan.ts`, `packages/shared/src/utils/securityScanSettings.ts`)
- `type SecurityScanType = 'quick' | 'full'` and `SECURITY_SCAN_TYPES` (readonly tuple, same order).
- `interface SecurityScanSettings { scheduledScans: boolean; scanType: SecurityScanType; scanMinute: string; scanHour: string; scanDayOfMonth: string; scanDayOfWeek: string; autoQuarantine: boolean; exclusions: string[]; maxFileSizeMb: number; scanTimeoutMinutes: number }`.
- `SECURITY_SCAN_SETTINGS_DEFAULTS: SecurityScanSettings`.
- `parseSecurityScanSettings(raw: unknown): SecurityScanSettings` — total, never throws, unknown keys dropped.
- `securityScanCron(settings: SecurityScanSettings): string | null` — five-field cron, `null` when `scheduledScans` is false.
- `SECURITY_SCAN_MAX_FILE_SIZE_MB_RANGE = [1, 512] as const`, `SECURITY_SCAN_TIMEOUT_MINUTES_RANGE = [5, 720] as const`.
- W03 adds `ruleSetIds: string[]` to `SecurityScanSettings` and to the defaults — it is the **only**
  wave allowed to widen that interface, and it must widen `parseSecurityScanSettings` in the same commit.

### API resolver (`apps/api/src/services/featureConfigResolver.ts`)
- `resolveSecurityScanSettingsForDevice(deviceId: string): Promise<SecurityScanSettings | null>` — `null`
  means "no `security` feature link wins for this device", which is NOT the same as "defaults apply".
- `resolveAllSecurityScanScheduledDevices(): Promise<SecurityScanSchedulable[]>` where
  `interface SecurityScanSchedulable { configPolicyId: string; orgId: string | null; partnerId: string | null; settings: SecurityScanSettings; deviceIds: string[] }`.

### Scheduler (`apps/api/src/jobs/securityScanJobs.ts`)
- Queue `security-scan`; job names `schedule-policies` (repeatable, every 60 s) and `dispatch-scan`.
- `getSecurityScanQueue()`, `enqueueSecurityScan(scanId: string): Promise<string | null>`,
  `processDispatchScan(data)`, `schedulePolicyScans(entry, now)`, `shouldScheduleSecurityScan(settings, timezone, now)`,
  `createSecurityScanWorker()`, `initializeSecurityScanWorkers()`, `shutdownSecurityScanWorkers()`.
- Deterministic dispatch job id: `security-scan-${scanId}`.
- Worker registry entry name `securityScanWorker`, `placement: 'socket-owner'` (its closure reaches
  `services/commandQueue`).
- Zod schema `securityScanQueueJobDataSchema` / type `SecurityScanQueueJobData` in `apps/api/src/jobs/queueSchemas.ts`.

### Command payload (API → agent, `CommandTypes.SECURITY_SCAN` / `tools.CmdSecurityScan = "security_scan"`)
Existing keys keep their names and meaning: `scanRecordId`, `scanType`, `paths`, `triggerDefender`.
W01 adds, all optional so an old agent ignores them:
`exclusions: string[]`, `maxFileSizeMb: number`, `timeoutMinutes: number`, `autoQuarantine: boolean`.
W02 adds `ruleSets: [{ id, version, sha256, url }]` to the same payload and must not rename any of the above.

### Scan result (agent → API, keys inside `NewSuccessResult`)
Existing: `scanRecordId`, `scanType`, `durationMs`, `threatsFound`, `threats`, `status`.
W01 adds: `filesScanned: number`, `timedOut: boolean`, `partial: boolean`; and per threat object
`quarantinedTo: string` (empty when not quarantined). W02 adds `ruleName`, `ruleSetId`, `tags`,
`matchedStrings`, `sha256` to each threat object.

### Scan row status values (`security_scans.status`, `varchar(20)`, no CHECK)
`queued | running | completed | failed | timed_out`. `timed_out` is introduced by W01 and is a real
outcome, not an error: threats found before the deadline are still ingested.

### Agent (`agent/internal/security/`)
- `SecurityScanner` gains fields `Exclusions []string`, `Timeout time.Duration`, `AutoQuarantine bool`.
- `type ScanOutcome struct { Threats []Threat; Status SecurityStatus; Duration time.Duration; FilesScanned int; TimedOut bool; Partial bool }` —
  returned by a new `ScanWithContext`; the existing `ScanResult` and `QuickScan`/`FullScan`/`CustomScan`
  stay for back-compat.
- `Threat` gains `QuarantinedTo string \`json:"quarantinedTo,omitempty"\``.
- Quarantine: `QuarantineThreat(threat Threat, quarantineDir string) (string, error)` keeps its signature
  but now writes `<base>-<unixnano>.bqz` (XOR-0x5A, streamed) plus `<same>.bqz.json`;
  new `RestoreQuarantined(quarantinedPath, originalPath string) (string, error)` and
  `type QuarantineManifest struct` live in a new file `agent/internal/security/quarantine.go`.
- Manifest extension `.bqz.json`; payload extension `.bqz`; manifest version field `"v": 1`.
  W02/W03 add `ruleName` / `ruleSetId` to the manifest and must bump `"v"` to 2 while still reading 1.

### Web
- Page `apps/web/src/pages/security/scans.astro` at `/security/scans`, title key `titles.securityScans`
  (`locales/<lang>/pages.json`), nav label key `nav.securityScans` (`locales/<lang>/common.json`) —
  both in all 8 locale directories.
- Tab state on that page uses `window.location.hash` (`#scans` / `#threats`), never a query param.
- `SecurityTab.tsx` settings keys are exactly `SecurityScanSettings` above; the removed keys
  (`realTimeProtection`, `behavioralMonitoring`, `cloudLookup`, `blockUntrustedUsb`, `notifyUser`)
  are never re-introduced by a later wave.
