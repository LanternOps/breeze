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
| W02 (#6265) | YARA-X engine in the agent (`internal/yarascan`, matcher swap, worker-pool walk, bytecode cache + fetch route, lab benchmark, sidecar go/no-go) — plan not written | — (parallel with W01) |
| W03 (#6266) | Rule sets, compile service and built-in pack (tables + RLS + every registration list, `breeze-yarac`, CRUD routes, YARA Forge pack pipeline, `provider = 'breeze'`) — plan not written | W02 |
| W04 (#6267) | Detection rules UI and IOC import (rule-set editor, compile errors, test upload, IOC paste importer, Security tab rule-set picker, ThreatDetail rule panel) — plan not written | W03 |
| W05 (#6268) | Fleet sweep, AI tool and audit (`sweep` route + batch tracking, AI `security_scan` actions + parity files, audit events, docs + release-notes copy per spec §11) — plan not written | W03 |

W01 and W02 are independent and run in parallel (spec §12). W03 depends on W02 (bytecode format);
W04 and W05 depend on W03.

## Gates

- **Gate B — Todd's approval of this W01 plan before W01 is dispatched.** Nothing in W01 starts until
  that approval is recorded on #6264.
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
