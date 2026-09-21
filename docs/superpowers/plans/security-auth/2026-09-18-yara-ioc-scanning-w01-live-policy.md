---
tracking_issue: LanternOps/breeze#6263
---
# YARA IOC Scanning W01: Live security policy — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the malware-scan feature that already ships actually run: one canonical
`SecurityScanSettings` contract, a server-driven scheduler that dispatches scans for every device a
`security` config-policy feature link governs, those settings (exclusions, size cap, timeout,
auto-quarantine) actually delivered to and honoured by the agent, a Security tab that only shows
controls with an engine behind them, a `/security/scans` page that finally mounts the three built-but-
unreachable components, and quarantine that neutralizes the file instead of renaming live malware.

**Architecture:** The single home for scan configuration is the Config Policy **Security tab**, whose
values live in `config_policy_feature_links.inline_settings` (`feature_type = 'security'`, `jsonb`) and
reach a device through the existing closest-wins assignment hierarchy. W01 adds no table and no column.
A new BullMQ worker `apps/api/src/jobs/securityScanJobs.ts` — a deliberate clone of
`apps/api/src/jobs/sensitiveDataJobs.ts` — ticks every 60 s, asks
`featureConfigResolver` which devices a scheduled `security` link governs, checks each policy's cron
against the owning org's timezone, inserts `security_scans` rows taking the **device's** org, and
queues one `security_scan` command per device with the resolved settings in the payload. The agent
grows a context-aware walk that honours exclusions, a file-size cap and a deadline, reports partial
results, and quarantines by XOR-0x5A-encoding the file to `<name>.bqz` beside a JSON manifest so a
second AV cannot rescan it and so restore is exact. The legacy four-signature table remains the matcher
— W02 swaps in YARA-X behind the same call site.

**Tech Stack:** TypeScript (Hono, Drizzle ORM, BullMQ, Zod v4), Go 1.x (agent, `CGO_ENABLED=0`),
Astro + React islands (web), Vitest (API/web/shared), Go `testing` with `-race`.

**Spec:** `docs/superpowers/specs/security-auth/2026-09-18-yara-ioc-scanning-design.md`.
This wave ships the **W01 row of §12** in full: §6's exclusions / size cap / timeout / partial results
and D6 quarantine, §7's `jobs/securityScanJobs.ts` and the settings-resolving `POST /security/scan/:deviceId`,
§8's Scans page, and D4's Security-tab cleanup **minus** the rule-set picker (W04). It ships **none** of
D1, D2, D3, D5's rule delivery, D7, D9, §4, §5, §9's rule-specific controls, or §11's docs pass.
Where this plan is more specific than the spec — and in the three places where it **contradicts** the
spec because the spec describes code that does not exist — the plan wins, and every such point is
marked **DECISION** inline.

**Cross-wave names (from the plan index — do not rename):** `SecurityScanSettings`,
`SECURITY_SCAN_SETTINGS_DEFAULTS`, `parseSecurityScanSettings`, `securityScanCron`,
`resolveSecurityScanSettingsForDevice`, `resolveAllSecurityScanScheduledDevices`,
`SecurityScanSchedulable`, queue `security-scan`, job names `schedule-policies` / `dispatch-scan`,
`securityScanWorker`, payload keys `exclusions` / `maxFileSizeMb` / `timeoutMinutes` / `autoQuarantine`,
result keys `filesScanned` / `timedOut` / `partial` / `quarantinedTo`, scan status `timed_out`,
`ScanOutcome`, `RestoreQuarantined`, `QuarantineManifest`, `.bqz` / `.bqz.json`, `/security/scans`,
`titles.securityScans`, `nav.securityScans`.

---

## Global Constraints

- **No migration in this wave. None. Do not create a file in `apps/api/migrations/`.** Verified, not
  assumed:
  - The settings live in `config_policy_feature_links.inline_settings`, already `jsonb`
    (`apps/api/src/db/schema/configurationPolicies.ts`, read through the view
    `configPolicyEffectiveFeatureLinks` at `:157`). Adding keys to a jsonb blob is not DDL.
  - `security_scans.status` is `character varying(20) NOT NULL` with **no CHECK constraint**
    (`apps/api/migrations/0001-baseline.sql:5322-5333`; the only status object is the index
    `security_scans_status_idx` at `:10219`). `'timed_out'` is 9 characters and needs no DDL.
  - `security_threats.status` uses the existing `threat_status` enum and W01 only writes values that
    already exist (`'detected'`, `'quarantined'` — both already written by
    `apps/api/src/routes/agents/helpers.ts:566` and `:663`).
  - Because there is no migration, there is **no** new entry in `CORE_ORG_CASCADE_DELETE_ORDER`,
    `CORE_TENANT_EXPORT_POLICY`, `DUAL_AXIS_TENANT_TABLES`, `CORE_DEVICE_CASCADE_DELETE_TABLES`, or any
    other registration list, and nothing may be added to the frozen baseline in
    `apps/api/src/db/migrationRlsScope.test.ts`. If an executor finds themselves reaching for a
    migration, **stop and escalate** — it means the task has drifted into W03.
- **Partner-Wide First still applies even with no new table.** The thing being scheduled is a
  *config policy*, and `configuration_policies` is already org-XOR-partner with the SELECT-only
  partner-wide branch (`apps/api/migrations/2026-10-05-110000-config-policy-partner-wide-select.sql`;
  gate documented at `apps/api/src/services/configurationPolicy.ts:234` `policyAccessCondition`). Two
  consequences that are non-negotiable in this wave:
  1. **Fan-out goes by the device's org, never by the policy's org.** A partner-wide config policy has
     `org_id NULL`; `eq(x.orgId, policy.orgId)` silently no-ops on it. The resolver walks assignments
     to devices (the `resolveDeviceIdsForSoftwarePolicy` shape at
     `apps/api/src/services/featureConfigResolver.ts:1096-1215`), and every row the worker creates —
     the `security_scans` row, the `security_threats` rows — takes the **device's** org
     (`sensitiveDataJobs.ts:664-668` says exactly this in a comment; copy the behaviour, not the comment).
  2. **The worker runs in system DB context, the routes do not.** The worker body is wrapped in
     `withSystemDbAccessContext` exactly as `sensitiveDataJobs.ts:22-25` / `:769` does
     (`runWithSystemDbAccess`). Route handlers keep the ambient request `withDbAccessContext` opened by
     `authMiddleware` and must never call `runOutsideDbContext(() => withSystemDbAccessContext(...))`.
- **Settings — one concept, one home (CLAUDE.md).** The scan schedule, exclusions, auto-quarantine,
  size cap and timeout are configured in **exactly one** place: Config Policies → a policy → Security
  tab. The count of places the concept is configured goes from 2 to 1 (see DECISION 1) and must be
  stated in the PR description, per the settings rule's point 9.
- **Web mutation handlers must surface outcome via `runAction`** (`apps/web/src/lib/runAction.ts`).
  Task 11 converts the three components this wave makes reachable and registers them in `TARGET_GLOBS`
  in `apps/web/src/lib/__tests__/no-silent-mutations.test.ts` (an explicit array at `:35`, not a glob —
  so nothing reds until you add them, and the repo contract says add them).
- **Run one test file as `cd apps/api && npx vitest run <path>`** (web: `cd apps/web && npx vitest run <path>`).
  Never `pnpm --filter <pkg> test -- --run <path>`: pnpm forwards the literal `--`, vitest stops parsing
  flags there, `--run` is swallowed as a positional filter, and the entire suite runs in watch mode.
  The vitest path filter is a plain substring match, not a glob — always check the reported file count.
- **Go tests run with `-race`**: `cd agent && go test -race ./internal/security/... ./internal/heartbeat/...`.
  `make test` omits `-race`; do not use it for this wave.
- **The agent's AV-evasion convention is load-bearing in tests.** Distinctive malware tokens appear only
  as a single string literal with `|` laced through it and are stripped by `deobf`
  (`agent/internal/security/threats_test.go:33`, rationale at `:11-31`). Never concatenate fragments —
  it re-materializes contiguous bytes in the test binary and gets the test binary quarantined. Any new
  test that calls `detectThreats` must use `scanOptionsForTest()` (`threats_test.go:129-135`), which has
  **no** ExcludePaths, because the darwin defaults exclude `/private/var/folders` — i.e. exactly where
  `t.TempDir()` lives.
- **Payload additions are optional on the wire.** An agent from before this wave ignores unknown payload
  keys (`tools.GetPayloadStringSlice` / `GetPayloadBool` return zero values for absent keys), and the API
  result handler must treat every new result key as absent-tolerant. No agent release is a prerequisite
  for the API/web half of this wave to be safe to ship.
- **Locale parity.** Any new i18n key must be added to all 8 locale directories
  (`apps/web/src/locales/{de-DE,en,es-419,fr-CA,fr-FR,it-IT,pt-BR,tr-TR}`), or
  `localeParity.test.ts` / `translationCoverage.test.ts` / `titleKeyUsage.test.ts` go red. A new nav entry
  additionally needs its `nav.*` key present in **both** `en` and `pt-BR` or
  `Sidebar.nav.test.tsx:288,:302` fails.
- Branch `feature/6263-yara-ioc-scanning/wave-6264`; PR body contains `Closes #6264`.
- Commit messages end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Keep files under ~500 lines. `securityScanJobs.ts` is the one file allowed to approach that; if it
  crosses, split the due-evaluation helpers into `apps/api/src/services/securityScanSchedule.ts` rather
  than growing it.
- This wave's PR targets `main`, so it gets a normal `pull_request` CI run — do **not** hand-dispatch CI.
  W02 runs in parallel on its own branch off `main`, not stacked on this one.

---

## Decisions that override or correct the spec

**DECISION 1 — the Security tab's settings live in the feature link's `inline_settings`, not in
`security_policies.settings`. The spec's §2 table is wrong about this.**
Verified: `apps/web/src/components/configurationPolicies/featureTabs/SecurityTab.tsx:158-166` calls
`save(existingLink?.id ?? null, { featureType: 'security', featurePolicyId: null, inlineSettings: settings })`
through `featureTabs/useFeatureLink.ts` → `POST/PATCH /configuration-policies/:id/features`. It never
touches `security_policies`. The `security_policies` table is written only by
`apps/api/src/routes/security/policies.ts`, whose client `SecurityPolicyEditor.tsx` is **mounted on no
page** (its only importers are `components/security/index.ts:11` and two test files) — so there is no
live second editor to reconcile, which is why the "one concept, one home" count goes 2 → 1 by simply
naming the tab as the home. W01 leaves `security_policies` and its routes untouched. **W03 must put
`ruleSetIds` in the feature link's `inlineSettings`, not in `security_policies.settings` as spec §4
says**; the index's cross-wave contract records that.

**DECISION 2 — occurrence idempotency uses a deterministic job id plus a device-level DB guard, not a
`lastRunAt` claim.** `sensitiveDataJobs.ts` claims an occurrence by writing
`schedule.lastRunAt` back into its own policy row under an advisory lock
(`sensitiveDataJobs.ts:554-586`). W01 cannot do that: the equivalent store is the tech's own
`inline_settings` blob, and a worker writing into it would race the Security tab's PATCH and silently
revert a tech's edit. Instead: the dispatch job id is `security-scan-${scanId}`, and before creating a
scan row for a device the scheduler refuses if that device already has a `security_scans` row with
status `queued` or `running`, or a `completed`/`timed_out` row started within the current cron minute.
Both halves are proven by tests in Task 4. This is strictly weaker than an advisory-lock claim under
multi-process scheduling, which is why the device guard — not the job id — is the real defence.

**DECISION 3 — `notifyUser` is removed from the Security tab, contradicting spec D4's "kept" list.**
D4 keeps "notify user", but there is no engine: `agent/internal/remote/tools/types.go` defines no
notification command (`grep -n 'Cmd[A-Za-z]*Notif' agent/internal/remote/tools/types.go` returns
nothing), and `agent/internal/userhelper/notify.go:18 showNotification` is reachable only from inside
the user-helper process over IPC, with no service-side caller. Shipping it would reproduce exactly the
defect §1 of the spec complains about — a toggle with nothing behind it. It is removed with the other
four, and a follow-up issue is filed in Task 12 for W04 to add it properly if wanted.

**DECISION 4 — a deadline produces `status: 'timed_out'` with the threats found so far ingested, not a
failure.** A 2-hour full scan that hits its deadline has usually done useful work; discarding it would
make the timeout setting user-hostile. The agent returns success with `timedOut: true` and the partial
threat list; the API writes `security_scans.status = 'timed_out'` and inserts the threats. No DDL
(see Global Constraints).

**DECISION 5 — no audit events in W01.** Spec §7's audit requirement is scoped to rule/set changes and
sweeps, both W03/W05. A scheduled scan dispatch is already traceable through `device_commands` and the
`security_scans` row; adding a bespoke audit type here would have to be reconciled with W05's. Recorded
so a reviewer does not read the omission as an oversight.

---

## File structure

| Path | Responsibility | Owner wave |
|---|---|---|
| `packages/shared/src/types/securityScan.ts` | `SecurityScanType`, `SECURITY_SCAN_TYPES`, `SecurityScanSettings` | W01 (new) |
| `packages/shared/src/utils/securityScanSettings.ts` (+ `.test.ts`) | defaults, `parseSecurityScanSettings`, `securityScanCron`, the two range consts | W01 (new) |
| `packages/shared/src/types/index.ts`, `packages/shared/src/utils/index.ts` | barrel exports (one line each) | W01 (edit) |
| `apps/api/src/services/featureConfigResolver.ts` | `resolveSecurityScanSettingsForDevice`, `resolveAllSecurityScanScheduledDevices`, `SecurityScanSchedulable` — appended at the end, nothing existing touched | W01 (edit) |
| `apps/api/src/services/featureConfigResolver.security.test.ts` | unit tests for the two new resolvers | W01 (new) |
| `apps/api/src/jobs/queueSchemas.ts` | `securityScanQueueJobDataSchema`, `SecurityScanQueueJobData` (appended beside the sensitive-data union) | W01 (edit) |
| `apps/api/src/jobs/securityScanJobs.ts` (+ `.test.ts`) | queue, dispatch, tick, due evaluation, fan-out, worker lifecycle | W01 (new) |
| `apps/api/src/services/workerRegistry.ts` | one `securityScanWorker` entry, `placement: 'socket-owner'` | W01 (edit) |
| `apps/api/src/jobs/workerReadinessManifest.ts` | one `consumers('securityScanWorker')` line | W01 (edit) |
| `apps/api/src/routes/security/scans.ts` (+ `.test.ts`) | manual scan attaches the device's resolved settings | W01 (edit) |
| `apps/api/src/routes/security/schemas.ts` | `listScansQuerySchema.status` gains `timed_out` | W01 (edit) |
| `apps/api/src/routes/agents/helpers.ts` (+ `helpers.test.ts`) | scan-result block only: `timed_out`, `filesScanned`, auto-quarantine status | W01 (edit) |
| `agent/internal/security/scanner.go` (+ `scanner_test.go`) | `ScanOutcome`, `ScanWithContext`, settings fields | W01 (edit/new test) |
| `agent/internal/security/threats.go` (+ `threats_test.go`) | ctx-aware walk, caller exclusions, file counter, partial results | W01 (edit) |
| `agent/internal/security/quarantine.go` (+ `quarantine_test.go`) | `.bqz` encode/decode, `QuarantineManifest`, `RestoreQuarantined` | W01 (new) |
| `agent/internal/heartbeat/handlers_security.go` (+ `handlers_security_test.go`) | read the new payload keys; restore via `RestoreQuarantined` | W01 (edit/new test) |
| `apps/web/src/components/configurationPolicies/featureTabs/SecurityTab.tsx` (+ `.test.tsx`) | D4 field set, backed by the shared contract | W01 (edit) |
| `apps/web/src/pages/security/scans.astro` | the page that mounts the three components | W01 (new) |
| `apps/web/src/components/security/SecurityScansPage.tsx` (+ `.test.tsx`) | island: hash-routed Scans / Threats tabs | W01 (new) |
| `apps/web/src/components/security/index.ts` | export the new island | W01 (edit) |
| `apps/web/src/components/layout/Sidebar.tsx` | one nav entry under the `security` section | W01 (edit) |
| `apps/web/src/locales/*/pages.json`, `apps/web/src/locales/*/common.json`, `apps/web/src/locales/*/security.json` | `titles.securityScans`, `nav.securityScans`, the Scans-page strings, SecurityTab key removals | W01 (edit, 8 locales) |
| `apps/web/src/components/security/{SecurityScanManager,ThreatList,ThreatDetail}.tsx` | mutations converted to `runAction` | W01 (edit) |
| `apps/web/src/lib/__tests__/no-silent-mutations.test.ts` | three `TARGET_GLOBS` entries | W01 (edit) |

### Do NOT touch (other waves own these, or they are out of scope)

- `apps/api/migrations/**` — nothing, at all (see Global Constraints).
- `apps/api/src/db/schema/**` — no schema change in this wave.
- `apps/api/src/routes/security/policies.ts`, `apps/api/src/routes/security/threats.ts`,
  `apps/api/src/routes/security/{dashboard,posture,compliance,recommendations,recoveryKeys,status}.ts`.
- `apps/web/src/components/security/SecurityPolicyEditor.tsx` and `SecurityDashboard.tsx`
  (DECISION 1 leaves the legacy editor alone; the dashboard's card grid is not the nav home for this page).
- `apps/web/src/components/security/EdrPage.tsx` — spec §8's "Looking for Breeze IOC scans? →" link is
  W04's, together with the Detection rules page it points at.
- `agent/internal/remote/tools/sensitive_data_scan.go` — W01 **copies its shape** into
  `internal/security`; it does not refactor it, share code with it, or move it. Two scanners with
  different threat models are the intended state until W02.
- `agent/internal/security/{status.go,defender_*.go,recoverykeys.go,windows_security_center_*.go}`.
- `apps/api/src/jobs/sensitiveDataJobs.ts` — the template. Read it; change nothing in it.
- Anything named `yara*` — W02/W03.
- `apps/api/src/services/configurationPolicy.ts` — `'security'` is already in `configFeatureTypeEnum`
  (`apps/api/src/db/schema/configurationPolicies.ts:36`) and already in
  `PARTNER_LINKABLE_FEATURE_TYPES` (`configurationPolicy.ts:2720`). Nothing to register.

### Parallelism

Tasks 1–6 (API + shared), 7–8 (agent, Go only), 9–11 (web) touch disjoint files and may be executed by
three workers in parallel after Task 1 lands, with two ordering edges: Task 2 consumes Task 1's exports,
and Tasks 9/11 both edit files under `apps/web/src/components/security/` (Task 9 edits `featureTabs/`,
Task 11 edits `components/security/` — disjoint, but Task 10 adds `index.ts` exports that Task 11 must
rebase on). W02 runs in a separate worktree on a separate branch and touches only
`agent/internal/yarascan/**` plus one call site in `threats.go` — coordinate that single line if both
waves are live at once.

---

### Task 1: Shared `SecurityScanSettings` contract

**Files:**
- Create: `packages/shared/src/types/securityScan.ts`
- Create: `packages/shared/src/utils/securityScanSettings.ts`
- Create: `packages/shared/src/utils/securityScanSettings.test.ts`
- Modify: `packages/shared/src/types/index.ts`, `packages/shared/src/utils/index.ts` (one export line each)
- Read first (do not modify): `apps/web/src/components/configurationPolicies/featureTabs/SecurityTab.tsx:9-36`
  (the current `SecuritySettings` type and defaults this replaces), `apps/api/src/services/cronDue.ts:149`
  (`isCronDue(cronExpression, timeZone, date)` — the consumer of `securityScanCron`'s output)

**Interfaces:**
- Produces `SECURITY_SCAN_TYPES = ['quick', 'full'] as const`, `type SecurityScanType`,
  `interface SecurityScanSettings`, `SECURITY_SCAN_SETTINGS_DEFAULTS`,
  `parseSecurityScanSettings(raw: unknown): SecurityScanSettings`,
  `securityScanCron(settings: SecurityScanSettings): string | null`,
  `SECURITY_SCAN_MAX_FILE_SIZE_MB_RANGE`, `SECURITY_SCAN_TIMEOUT_MINUTES_RANGE`.
- Consumed by Task 2 (resolver), Task 3/4 (scheduler), Task 5 (manual scan route), Task 9 (Security tab).
- Imported **from the package root** (`@breeze/shared`) everywhere. Deep paths are absent from the
  package `exports` map and break the integration runner.

- [ ] **Step 1: Write the failing test**

Create `packages/shared/src/utils/securityScanSettings.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  SECURITY_SCAN_SETTINGS_DEFAULTS,
  parseSecurityScanSettings,
  securityScanCron,
} from './securityScanSettings';

describe('parseSecurityScanSettings', () => {
  it('returns defaults for a non-object', () => {
    expect(parseSecurityScanSettings(null)).toEqual(SECURITY_SCAN_SETTINGS_DEFAULTS);
    expect(parseSecurityScanSettings('nope')).toEqual(SECURITY_SCAN_SETTINGS_DEFAULTS);
  });

  it('drops the five removed toggles instead of carrying them through', () => {
    const parsed = parseSecurityScanSettings({
      realTimeProtection: true,
      behavioralMonitoring: true,
      cloudLookup: true,
      blockUntrustedUsb: true,
      notifyUser: true,
      autoQuarantine: false,
    });
    expect(parsed).not.toHaveProperty('realTimeProtection');
    expect(parsed).not.toHaveProperty('behavioralMonitoring');
    expect(parsed).not.toHaveProperty('cloudLookup');
    expect(parsed).not.toHaveProperty('blockUntrustedUsb');
    expect(parsed).not.toHaveProperty('notifyUser');
    expect(parsed.autoQuarantine).toBe(false);
  });

  it('clamps the numeric fields into range and coerces strings', () => {
    expect(parseSecurityScanSettings({ maxFileSizeMb: 0 }).maxFileSizeMb).toBe(1);
    expect(parseSecurityScanSettings({ maxFileSizeMb: 9999 }).maxFileSizeMb).toBe(512);
    expect(parseSecurityScanSettings({ maxFileSizeMb: '64' }).maxFileSizeMb).toBe(64);
    expect(parseSecurityScanSettings({ maxFileSizeMb: 'abc' }).maxFileSizeMb)
      .toBe(SECURITY_SCAN_SETTINGS_DEFAULTS.maxFileSizeMb);
    expect(parseSecurityScanSettings({ scanTimeoutMinutes: 1 }).scanTimeoutMinutes).toBe(5);
    expect(parseSecurityScanSettings({ scanTimeoutMinutes: 5000 }).scanTimeoutMinutes).toBe(720);
  });

  it('keeps only string exclusions, trims them, and drops blanks and duplicates', () => {
    expect(parseSecurityScanSettings({
      exclusions: ['C:\\Backups', ' C:\\Backups ', '', 7, null, 'D:\\VMs'],
    }).exclusions).toEqual(['C:\\Backups', 'D:\\VMs']);
  });

  it('falls back to the default scan type for an unknown value', () => {
    expect(parseSecurityScanSettings({ scanType: 'custom' }).scanType).toBe('quick');
    expect(parseSecurityScanSettings({ scanType: 'full' }).scanType).toBe('full');
  });

  it('rejects cron field values it did not offer', () => {
    const parsed = parseSecurityScanSettings({ scanMinute: '7', scanHour: '23', scanDayOfWeek: 'Tue' });
    expect(parsed.scanMinute).toBe(SECURITY_SCAN_SETTINGS_DEFAULTS.scanMinute);
    expect(parsed.scanHour).toBe(SECURITY_SCAN_SETTINGS_DEFAULTS.scanHour);
    expect(parsed.scanDayOfWeek).toBe(SECURITY_SCAN_SETTINGS_DEFAULTS.scanDayOfWeek);
  });
});

describe('securityScanCron', () => {
  it('is null when scheduling is off', () => {
    expect(securityScanCron({ ...SECURITY_SCAN_SETTINGS_DEFAULTS, scheduledScans: false })).toBeNull();
  });

  it('emits five fields in minute hour dom month dow order', () => {
    expect(securityScanCron({
      ...SECURITY_SCAN_SETTINGS_DEFAULTS,
      scheduledScans: true,
      scanMinute: '30',
      scanHour: '2',
      scanDayOfMonth: '*',
      scanDayOfWeek: '1',
    })).toBe('30 2 * * 1');
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `cd packages/shared && npx vitest run src/utils/securityScanSettings.test.ts`
Expected: FAIL — `Failed to resolve import "./securityScanSettings"`.

- [ ] **Step 3: Write the type module**

Create `packages/shared/src/types/securityScan.ts`:

```ts
/**
 * The single contract for Breeze IOC scan configuration (#6263 W01).
 *
 * Home: Config Policies -> Security tab, stored in
 * `config_policy_feature_links.inline_settings` with `feature_type = 'security'`.
 * There is no other writer and no other reader — the API resolver, the
 * scheduler, the manual scan route and the web tab all go through
 * `parseSecurityScanSettings`.
 *
 * Deliberately NOT here: real-time protection, behavioural monitoring, cloud
 * lookup, USB blocking and user notification. None has an engine behind it
 * (see the W01 plan, DECISION 3); USB belongs to `peripheral_control`.
 */
export const SECURITY_SCAN_TYPES = ['quick', 'full'] as const;
export type SecurityScanType = (typeof SECURITY_SCAN_TYPES)[number];

export interface SecurityScanSettings {
  /** Master switch for the server-driven scheduler. */
  scheduledScans: boolean;
  scanType: SecurityScanType;
  /** Cron fields, restricted to the values the Security tab offers. */
  scanMinute: string;
  scanHour: string;
  scanDayOfMonth: string;
  scanDayOfWeek: string;
  /** Agent quarantines a detection the moment it is found. */
  autoQuarantine: boolean;
  /** Absolute paths skipped by the walk, in addition to the agent's built-ins. */
  exclusions: string[];
  /** Files larger than this are counted as skipped, never read. */
  maxFileSizeMb: number;
  /** Wall-clock deadline for one scan; a hit deadline yields partial results. */
  scanTimeoutMinutes: number;
}
```

Create `packages/shared/src/utils/securityScanSettings.ts`:

```ts
import {
  SECURITY_SCAN_TYPES,
  type SecurityScanSettings,
  type SecurityScanType,
} from '../types/securityScan';

export const SECURITY_SCAN_MAX_FILE_SIZE_MB_RANGE = [1, 512] as const;
export const SECURITY_SCAN_TIMEOUT_MINUTES_RANGE = [5, 720] as const;

/** The exact option sets the Security tab renders; anything else is rejected. */
export const SECURITY_SCAN_MINUTE_OPTIONS = ['0', '15', '30', '45'] as const;
export const SECURITY_SCAN_HOUR_OPTIONS = ['0', '2', '6', '12', '18'] as const;
export const SECURITY_SCAN_DAY_OF_MONTH_OPTIONS = ['*', '1', '15'] as const;
export const SECURITY_SCAN_DAY_OF_WEEK_OPTIONS = ['*', '0', '1', '2', '3', '4', '5', '6'] as const;

export const SECURITY_SCAN_SETTINGS_DEFAULTS: SecurityScanSettings = {
  scheduledScans: true,
  scanType: 'quick',
  scanMinute: '0',
  scanHour: '2',
  scanDayOfMonth: '*',
  scanDayOfWeek: '*',
  autoQuarantine: true,
  exclusions: [],
  maxFileSizeMb: 50,
  scanTimeoutMinutes: 120,
};

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const boolOr = (v: unknown, fallback: boolean): boolean =>
  typeof v === 'boolean' ? v : fallback;

const clampedIntOr = (v: unknown, [min, max]: readonly [number, number], fallback: number): number => {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number.parseInt(v, 10) : Number.NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
};

const oneOfOr = <T extends string>(v: unknown, options: readonly T[], fallback: T): T =>
  typeof v === 'string' && (options as readonly string[]).includes(v) ? (v as T) : fallback;

/**
 * Total: never throws, never returns an unknown key. A blob written by an older
 * build (or by a tech's hand-edited API call) degrades to the defaults field by
 * field rather than poisoning a scan command.
 */
export function parseSecurityScanSettings(raw: unknown): SecurityScanSettings {
  if (!isRecord(raw)) return { ...SECURITY_SCAN_SETTINGS_DEFAULTS };
  const d = SECURITY_SCAN_SETTINGS_DEFAULTS;

  const exclusions: string[] = [];
  if (Array.isArray(raw.exclusions)) {
    for (const item of raw.exclusions) {
      if (typeof item !== 'string') continue;
      const trimmed = item.trim();
      if (!trimmed || exclusions.includes(trimmed)) continue;
      exclusions.push(trimmed);
    }
  }

  return {
    scheduledScans: boolOr(raw.scheduledScans, d.scheduledScans),
    scanType: oneOfOr<SecurityScanType>(raw.scanType, SECURITY_SCAN_TYPES, d.scanType),
    scanMinute: oneOfOr(raw.scanMinute, SECURITY_SCAN_MINUTE_OPTIONS, d.scanMinute),
    scanHour: oneOfOr(raw.scanHour, SECURITY_SCAN_HOUR_OPTIONS, d.scanHour),
    scanDayOfMonth: oneOfOr(raw.scanDayOfMonth, SECURITY_SCAN_DAY_OF_MONTH_OPTIONS, d.scanDayOfMonth),
    scanDayOfWeek: oneOfOr(raw.scanDayOfWeek, SECURITY_SCAN_DAY_OF_WEEK_OPTIONS, d.scanDayOfWeek),
    autoQuarantine: boolOr(raw.autoQuarantine, d.autoQuarantine),
    exclusions,
    maxFileSizeMb: clampedIntOr(raw.maxFileSizeMb, SECURITY_SCAN_MAX_FILE_SIZE_MB_RANGE, d.maxFileSizeMb),
    scanTimeoutMinutes: clampedIntOr(
      raw.scanTimeoutMinutes, SECURITY_SCAN_TIMEOUT_MINUTES_RANGE, d.scanTimeoutMinutes,
    ),
  };
}

/**
 * Five-field cron for `isCronDue(expr, timeZone, date)`
 * (apps/api/src/services/cronDue.ts:149), which rejects anything that is not
 * exactly five whitespace-separated fields.
 */
export function securityScanCron(settings: SecurityScanSettings): string | null {
  if (!settings.scheduledScans) return null;
  return [
    settings.scanMinute,
    settings.scanHour,
    settings.scanDayOfMonth,
    '*',
    settings.scanDayOfWeek,
  ].join(' ');
}
```

- [ ] **Step 4: Export from the barrels**

Append to `packages/shared/src/types/index.ts`:
```ts
export * from './securityScan';
```
Append to `packages/shared/src/utils/index.ts`:
```ts
export * from './securityScanSettings';
```
Check for an existing `SECURITY_*` or `SecurityScan*` symbol collision first:
`grep -rn "SecurityScanSettings\|SECURITY_SCAN" packages/shared/src | grep -v securityScan` must be empty.

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd packages/shared && npx vitest run src/utils/securityScanSettings.test.ts`
Expected: PASS, 1 file, 8 tests.

- [ ] **Step 6: Typecheck the package**

Run: `cd packages/shared && npx tsc --noEmit -p tsconfig.json`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add packages/shared/src/types/securityScan.ts packages/shared/src/utils/securityScanSettings.ts \
        packages/shared/src/utils/securityScanSettings.test.ts \
        packages/shared/src/types/index.ts packages/shared/src/utils/index.ts
git commit -m "feat(shared): canonical SecurityScanSettings contract (#6264)"
```

---

### Task 2: Resolve the winning `security` feature link for a device, and for the fleet

**Files:**
- Modify: `apps/api/src/services/featureConfigResolver.ts` (append at end of file; touch nothing above)
- Create: `apps/api/src/services/featureConfigResolver.security.test.ts`
- Read first (do not modify): `apps/api/src/services/featureConfigResolver.ts:1240-1287`
  (`resolveVulnerabilityEnabledForDevice` — the inline-settings closest-wins shape to copy) and
  `:1096-1215` (`resolveDeviceIdsForSoftwarePolicy` — the assignment→devices fan-out to copy),
  plus `:1302-1414` (`resolveAllVulnerabilityEnabledDevices` — the batch shape)

**Interfaces:**
- Consumes `parseSecurityScanSettings`, `SecurityScanSettings` from `@breeze/shared` (Task 1).
- Produces:
  ```ts
  export interface SecurityScanSchedulable {
    configPolicyId: string;
    orgId: string | null;      // the config policy's own org, NULL when partner-wide
    partnerId: string | null;  // the config policy's own partner, NULL when org-owned
    settings: SecurityScanSettings;
    deviceIds: string[];       // devices whose WINNING security link is this policy's
  }
  export async function resolveSecurityScanSettingsForDevice(deviceId: string): Promise<SecurityScanSettings | null>;
  export async function resolveAllSecurityScanScheduledDevices(): Promise<SecurityScanSchedulable[]>;
  ```
- Consumed by Task 4 (tick/fan-out) and Task 5 (manual scan route).

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/services/featureConfigResolver.security.test.ts`. Mock Drizzle the way the sibling
resolver tests in this directory do — read `apps/api/src/services/featureConfigResolver.test.ts` first
and copy its `vi.mock('../db', ...)` factory verbatim (`vi.mock` factories are hoisted: use literal
values inside, never module-level consts).

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

// NOTE: copy the exact db mock factory from featureConfigResolver.test.ts.
// The assertions below are what matters; the harness must match the sibling file.
import {
  resolveSecurityScanSettingsForDevice,
  resolveAllSecurityScanScheduledDevices,
} from './featureConfigResolver';

describe('resolveSecurityScanSettingsForDevice', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns null when no security feature link reaches the device', async () => {
    // arrange: hierarchy resolves, zero assignment rows
    await expect(resolveSecurityScanSettingsForDevice(
      '11111111-1111-4111-8111-111111111111',
    )).resolves.toBeNull();
  });

  it('returns null for an unknown device rather than defaults', async () => {
    // arrange: loadDeviceHierarchy -> null
    await expect(resolveSecurityScanSettingsForDevice(
      '22222222-2222-4222-8222-222222222222',
    )).resolves.toBeNull();
  });

  it('closest assignment wins: a device-level link overrides an org-level one', async () => {
    // arrange: two rows, level 'organization' (autoQuarantine true) and level 'device'
    // (autoQuarantine false); sortByHierarchy must pick the device row.
    const settings = await resolveSecurityScanSettingsForDevice(
      '33333333-3333-4333-8333-333333333333',
    );
    expect(settings?.autoQuarantine).toBe(false);
  });

  it('parses the winning blob through parseSecurityScanSettings (removed toggles dropped)', async () => {
    // arrange: winning inlineSettings carries realTimeProtection:true and maxFileSizeMb:'9999'
    const settings = await resolveSecurityScanSettingsForDevice(
      '44444444-4444-4444-8444-444444444444',
    );
    expect(settings).not.toHaveProperty('realTimeProtection');
    expect(settings?.maxFileSizeMb).toBe(512);
  });
});

describe('resolveAllSecurityScanScheduledDevices', () => {
  it('returns [] when no active config policy carries a security link', async () => {
    await expect(resolveAllSecurityScanScheduledDevices()).resolves.toEqual([]);
  });

  it('omits policies whose settings have scheduledScans false', async () => {
    // arrange: one link with { scheduledScans: false }
    await expect(resolveAllSecurityScanScheduledDevices()).resolves.toEqual([]);
  });

  it('excludes a candidate device whose winning link belongs to a different policy', async () => {
    // arrange: policy A assigned at org level, policy B at device level for device D.
    // Only B may list D.
    const entries = await resolveAllSecurityScanScheduledDevices();
    const a = entries.find((e) => e.configPolicyId === 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    expect(a?.deviceIds ?? []).not.toContain('dddddddd-dddd-4ddd-8ddd-dddddddddddd');
  });

  it('carries the policy ownership axes through so the caller can resolve a timezone', async () => {
    const entries = await resolveAllSecurityScanScheduledDevices();
    expect(entries[0]).toHaveProperty('orgId');
    expect(entries[0]).toHaveProperty('partnerId');
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `cd apps/api && npx vitest run src/services/featureConfigResolver.security.test.ts`
Expected: FAIL — `resolveSecurityScanSettingsForDevice is not a function`.

- [ ] **Step 3: Implement the per-device resolver**

Append to `apps/api/src/services/featureConfigResolver.ts`. Import at the top of the file (with the
other `@breeze/shared` imports if one exists, otherwise a new line beside the existing imports):

```ts
import { parseSecurityScanSettings, type SecurityScanSettings } from '@breeze/shared';
```

Then, at the end of the file:

```ts
// ============================================
// Security IOC scan settings (#6263 W01)
// ============================================

/**
 * The winning `security` feature link's inline settings for a device, or null
 * when no active config policy in the device's hierarchy carries one.
 *
 * `null` is NOT "use the defaults" — a device nobody configured must not be
 * scanned on a default schedule. The scheduler treats null as "skip".
 *
 * Shape copied from {@link resolveVulnerabilityEnabledForDevice}: closest level
 * wins, then assignment priority, then age. Runs in the CALLER'S OWN RLS
 * context; it is self-tenanted by the device's own hierarchy.
 */
export async function resolveSecurityScanSettingsForDevice(
  deviceId: string,
): Promise<SecurityScanSettings | null> {
  const hierarchy = await loadDeviceHierarchy(deviceId);
  if (!hierarchy) return null;

  const targetConditions = buildTargetConditions(hierarchy);
  const roleOsConditions = buildRoleOsFilterConditions(hierarchy);

  const rows = await db
    .select({
      inlineSettings: configPolicyEffectiveFeatureLinks.inlineSettings,
      assignmentLevel: configPolicyAssignments.level,
      assignmentPriority: configPolicyAssignments.priority,
      assignmentCreatedAt: configPolicyAssignments.createdAt,
    })
    .from(configPolicyAssignments)
    .innerJoin(
      configurationPolicies,
      and(
        eq(configPolicyAssignments.configPolicyId, configurationPolicies.id),
        eq(configurationPolicies.status, 'active'),
        policyOwnershipCondition(hierarchy),
      ),
    )
    .innerJoin(
      configPolicyEffectiveFeatureLinks,
      and(
        eq(configPolicyEffectiveFeatureLinks.configPolicyId, configurationPolicies.id),
        eq(configPolicyEffectiveFeatureLinks.featureType, 'security'),
      ),
    )
    .where(and(sql`(${sql.join(targetConditions, sql` OR `)})`, ...roleOsConditions))
    .orderBy(
      configPolicyAssignments.level,
      configPolicyAssignments.priority,
      configPolicyAssignments.createdAt,
    );

  if (rows.length === 0) return null;
  return parseSecurityScanSettings(sortByHierarchy(rows)[0]!.inlineSettings);
}
```

- [ ] **Step 4: Implement the fleet resolver**

Still at the end of `featureConfigResolver.ts`:

```ts
export interface SecurityScanSchedulable {
  configPolicyId: string;
  /** The POLICY's org — NULL for a partner-wide policy. Never a device's org. */
  orgId: string | null;
  partnerId: string | null;
  settings: SecurityScanSettings;
  deviceIds: string[];
}

/**
 * Every device whose WINNING `security` link has `scheduledScans: true`,
 * grouped by the config policy that won.
 *
 * Mirrors {@link resolveAllVulnerabilityEnabledDevices}: gather candidates from
 * every active policy carrying a `security` link, then verify per device that
 * the winner is this policy — so a device- or group-level policy with
 * `scheduledScans:false` suppresses a broader org-wide opt-in.
 *
 * Partner-wide policies (`org_id NULL`) reach devices only through their
 * assignments, which is why the fan-out below never filters on the policy's own
 * org. Run inside `withSystemDbAccessContext` — config-policy tables are RLS-scoped.
 */
export async function resolveAllSecurityScanScheduledDevices(): Promise<SecurityScanSchedulable[]> {
  const links = await db
    .select({
      configPolicyId: configPolicyEffectiveFeatureLinks.configPolicyId,
      inlineSettings: configPolicyEffectiveFeatureLinks.inlineSettings,
      orgId: configurationPolicies.orgId,
      partnerId: configurationPolicies.partnerId,
    })
    .from(configPolicyEffectiveFeatureLinks)
    .innerJoin(
      configurationPolicies,
      and(
        eq(configPolicyEffectiveFeatureLinks.configPolicyId, configurationPolicies.id),
        eq(configurationPolicies.status, 'active'),
      ),
    )
    .where(eq(configPolicyEffectiveFeatureLinks.featureType, 'security'));

  const scheduled = links
    .map((l) => ({ ...l, settings: parseSecurityScanSettings(l.inlineSettings) }))
    .filter((l) => l.settings.scheduledScans);
  if (scheduled.length === 0) return [];

  const assignments = await db
    .select({
      configPolicyId: configPolicyAssignments.configPolicyId,
      level: configPolicyAssignments.level,
      targetId: configPolicyAssignments.targetId,
    })
    .from(configPolicyAssignments)
    .where(inArray(configPolicyAssignments.configPolicyId, scheduled.map((l) => l.configPolicyId)));
  if (assignments.length === 0) return [];

  // Candidate devices per policy. `resolveAssignmentDeviceIds` is the switch on
  // level already used by resolveDeviceIdsForSoftwarePolicy — extract it there
  // into a module-private helper in THIS task rather than copying the switch a
  // third time, and leave resolveDeviceIdsForSoftwarePolicy calling it.
  const candidatesByPolicy = new Map<string, Set<string>>();
  for (const assignment of assignments) {
    const ids = await resolveAssignmentDeviceIds(assignment.level, assignment.targetId);
    const set = candidatesByPolicy.get(assignment.configPolicyId) ?? new Set<string>();
    for (const id of ids) set.add(id);
    candidatesByPolicy.set(assignment.configPolicyId, set);
  }

  // Verify the winner per candidate device, batched like the software resolver.
  const out: SecurityScanSchedulable[] = [];
  for (const link of scheduled) {
    const candidates = Array.from(candidatesByPolicy.get(link.configPolicyId) ?? []);
    const verified: string[] = [];
    const BATCH_SIZE = 50;
    for (let i = 0; i < candidates.length; i += BATCH_SIZE) {
      const batch = candidates.slice(i, i + BATCH_SIZE);
      const results = await Promise.all(
        batch.map(async (deviceId) => ({
          deviceId,
          winner: await resolveSecurityScanConfigPolicyIdForDevice(deviceId),
        })),
      );
      for (const { deviceId, winner } of results) {
        if (winner === link.configPolicyId) verified.push(deviceId);
      }
    }
    if (verified.length === 0) continue;
    out.push({
      configPolicyId: link.configPolicyId,
      orgId: link.orgId,
      partnerId: link.partnerId,
      settings: link.settings,
      deviceIds: verified,
    });
  }
  return out;
}
```

Add the module-private `resolveSecurityScanConfigPolicyIdForDevice(deviceId)` — identical to
`resolveSecurityScanSettingsForDevice` but selecting
`configPolicyEffectiveFeatureLinks.configPolicyId` and returning the winner's id (or `null`) — and the
extracted `resolveAssignmentDeviceIds(level, targetId)` helper. **Both fan-outs must keep
`eq(devices.isEphemeral, false)` on the site/organization/partner branches and
`ne(organizations.type, 'quick_support')` on the partner branch** — those exclusions are why a
stranger's Quick Support machine is never a policy target (`featureConfigResolver.ts:1155-1188`).

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd apps/api && npx vitest run src/services/featureConfigResolver.security.test.ts`
Expected: PASS, 1 file, 8 tests.

Then prove the extraction broke nothing:
Run: `cd apps/api && npx vitest run src/services/featureConfigResolver.test.ts`
Expected: PASS, unchanged count.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/featureConfigResolver.ts \
        apps/api/src/services/featureConfigResolver.security.test.ts
git commit -m "feat(api): resolve the winning security feature link per device and fleet-wide (#6264)"
```

---

### Task 3: `securityScanJobs.ts` — queue, schema, and the dispatch half

**Files:**
- Create: `apps/api/src/jobs/securityScanJobs.ts`
- Create: `apps/api/src/jobs/securityScanJobs.test.ts`
- Modify: `apps/api/src/jobs/queueSchemas.ts` (append one union + type, beside `sensitiveDataQueueJobDataSchema` at `:393-518`)
- Read first (do not modify): `apps/api/src/jobs/sensitiveDataJobs.ts` **in full** — this task is a
  deliberate clone of `:58-95` (queue + unique job id), `:190-262` (concurrency/backpressure reads and
  the throttled requeue), `:263-542` (dispatch) and `:767-833` (worker lifecycle)

**Interfaces:**
- Consumes `resolveSecurityScanSettingsForDevice` (Task 2), `parseSecurityScanSettings` /
  `SecurityScanSettings` (Task 1).
- Produces `getSecurityScanQueue()`, `enqueueSecurityScan(scanId: string): Promise<string | null>`,
  `processDispatchScan(data: DispatchScanJobData): Promise<{ dispatched: boolean; commandId: string | null }>`,
  `createSecurityScanWorker()`, `initializeSecurityScanWorkers()`, `shutdownSecurityScanWorkers()`,
  and the env-tunable caps below. Task 4 appends the tick to the same file.

- [ ] **Step 1: Add the queue job schema**

In `apps/api/src/jobs/queueSchemas.ts`, immediately after `SensitiveDataQueueJobData` (`:518`):

```ts
/**
 * #6263 W01. `origin` distinguishes a tech pressing "Scan now" from the 60 s
 * policy tick; only the scheduler variant carries the occurrence it was created
 * for, which is what makes a duplicate tick a no-op.
 */
export const securityScanQueueJobDataSchema = z.union([
  z.object({
    type: z.literal('dispatch-scan'),
    scanId: z.string().uuid(),
    origin: z.literal('manual'),
  }).strict(),
  z.object({
    type: z.literal('dispatch-scan'),
    scanId: z.string().uuid(),
    origin: z.literal('policy_scheduler'),
    configPolicyId: z.string().uuid(),
    occurrenceIso: z.string().min(1),
  }).strict(),
  z.object({
    type: z.literal('schedule-policies'),
    scanAt: z.string().min(1),
  }).strict(),
]);

export type SecurityScanQueueJobData = z.infer<typeof securityScanQueueJobDataSchema>;
```

- [ ] **Step 2: Write the failing dispatch test**

Create `apps/api/src/jobs/securityScanJobs.test.ts`. Copy the mock harness from
`apps/api/src/jobs/sensitiveDataJobs.test.ts` (read it first — it already mocks `../db`,
`../services/commandQueue`, `../services/redis` and BullMQ).

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { processDispatchScan } from './securityScanJobs';

// Harness: copy verbatim from sensitiveDataJobs.test.ts, then add
// vi.mock('../services/featureConfigResolver', () => ({
//   resolveSecurityScanSettingsForDevice: vi.fn(),
// }));

describe('processDispatchScan', () => {
  beforeEach(() => vi.clearAllMocks());

  it('does nothing when the scan row has vanished', async () => {
    await expect(processDispatchScan({
      type: 'dispatch-scan', scanId: '11111111-1111-4111-8111-111111111111', origin: 'manual',
    })).resolves.toEqual({ dispatched: false, commandId: null });
  });

  it('queues a security_scan command carrying the resolved settings', async () => {
    // arrange: scan row queued, device exists, resolver returns
    // { exclusions:['C:\\Backups'], maxFileSizeMb:64, scanTimeoutMinutes:30, autoQuarantine:false, scanType:'full' }
    const result = await processDispatchScan({
      type: 'dispatch-scan', scanId: '22222222-2222-4222-8222-222222222222', origin: 'manual',
    });
    expect(result.dispatched).toBe(true);
    expect(queueCommandForExecutionMock).toHaveBeenCalledWith(
      'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      'security_scan',
      expect.objectContaining({
        scanRecordId: '22222222-2222-4222-8222-222222222222',
        scanType: 'full',
        exclusions: ['C:\\Backups'],
        maxFileSizeMb: 64,
        timeoutMinutes: 30,
        autoQuarantine: false,
      }),
      expect.anything(),
    );
  });

  it('refuses to dispatch a scan whose row is no longer queued (concurrent claim)', async () => {
    // arrange: the claiming UPDATE ... WHERE status = 'queued' returns zero rows
    await expect(processDispatchScan({
      type: 'dispatch-scan', scanId: '33333333-3333-4333-8333-333333333333', origin: 'manual',
    })).resolves.toEqual({ dispatched: false, commandId: null });
  });

  it('requeues instead of dispatching when the org is at its running-scan cap', async () => {
    // arrange: getOrgRunningScans -> SECURITY_SCAN_ORG_CONCURRENCY_CAP
    const result = await processDispatchScan({
      type: 'dispatch-scan', scanId: '44444444-4444-4444-8444-444444444444', origin: 'manual',
    });
    expect(result.dispatched).toBe(false);
    expect(queueAddMock).toHaveBeenCalled(); // throttled requeue
    expect(queueCommandForExecutionMock).not.toHaveBeenCalled();
  });

  it('marks a scheduled scan failed when the device has moved org since it was created', async () => {
    // arrange: scan.orgId !== device.orgId
    const result = await processDispatchScan({
      type: 'dispatch-scan', scanId: '55555555-5555-4555-8555-555555555555',
      origin: 'policy_scheduler',
      configPolicyId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      occurrenceIso: '2026-09-18T02:00:00.000Z',
    });
    expect(result.dispatched).toBe(false);
    expect(dbUpdateSetMock).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed' }));
  });
});
```

- [ ] **Step 3: Run it and watch it fail**

Run: `cd apps/api && npx vitest run src/jobs/securityScanJobs.test.ts`
Expected: FAIL — `Failed to resolve import "./securityScanJobs"`.

- [ ] **Step 4: Write the queue + dispatch half**

Create `apps/api/src/jobs/securityScanJobs.ts`:

```ts
import { Job, Queue, Worker, type JobsOptions } from 'bullmq';
import { and, eq, inArray, ne, sql } from 'drizzle-orm';

import * as dbModule from '../db';
import { deviceCommands, devices, organizations, securityScans } from '../db/schema';
import { CommandTypes, queueCommandForExecution } from '../services/commandQueue';
import { isCronDue } from '../services/cronDue';
import { getBullMQConnection } from '../services/redis';
import { isReusableState } from '../services/bullmqUtils';
import { assertQueueJobName, parseQueueJobData } from '../services/bullmqValidation';
import { attachWorkerObservability } from './workerObservability';
import { securityScanQueueJobDataSchema, type SecurityScanQueueJobData } from './queueSchemas';
import {
  resolveAllSecurityScanScheduledDevices,
  resolveSecurityScanSettingsForDevice,
  resolvePartnerTimezoneForOrg,
} from '../services/featureConfigResolver';
import { securityScanCron, type SecurityScanSettings } from '@breeze/shared';

const { db } = dbModule;
const runWithSystemDbAccess = async <T>(fn: () => Promise<T>): Promise<T> => {
  const withSystem = dbModule.withSystemDbAccessContext;
  return typeof withSystem === 'function' ? withSystem(fn) : fn();
};

const SECURITY_SCAN_QUEUE = 'security-scan';
const POLICY_SCAN_INTERVAL_MS = 60 * 1000;

function parsePositiveIntEnv(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (!raw) return defaultValue;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return defaultValue;
  return parsed;
}

const SECURITY_SCAN_WORKER_CONCURRENCY = parsePositiveIntEnv('SECURITY_SCAN_WORKER_CONCURRENCY', 6);
const SECURITY_SCAN_ORG_CONCURRENCY_CAP = parsePositiveIntEnv('SECURITY_SCAN_ORG_CONCURRENCY_CAP', 40);
const SECURITY_SCAN_DEVICE_CONCURRENCY_CAP = parsePositiveIntEnv('SECURITY_SCAN_DEVICE_CONCURRENCY_CAP', 1);
const SECURITY_SCAN_ORG_QUEUE_BACKPRESSURE_LIMIT =
  parsePositiveIntEnv('SECURITY_SCAN_ORG_QUEUE_BACKPRESSURE_LIMIT', 500);
const SECURITY_SCAN_THROTTLE_REQUEUE_SECONDS =
  parsePositiveIntEnv('SECURITY_SCAN_THROTTLE_REQUEUE_SECONDS', 20);

type DispatchScanJobData = Extract<SecurityScanQueueJobData, { type: 'dispatch-scan' }>;
type SchedulePoliciesJobData = Extract<SecurityScanQueueJobData, { type: 'schedule-policies' }>;

let securityScanQueue: Queue<SecurityScanQueueJobData> | null = null;
let securityScanWorker: Worker<SecurityScanQueueJobData> | null = null;

export function getSecurityScanQueue(): Queue<SecurityScanQueueJobData> {
  if (!securityScanQueue) {
    securityScanQueue = new Queue<SecurityScanQueueJobData>(SECURITY_SCAN_QUEUE, {
      connection: getBullMQConnection(),
    });
  }
  return securityScanQueue;
}

const dispatchJobId = (scanId: string) => `security-scan-${scanId}`;

async function addUniqueDispatchJob(
  data: DispatchScanJobData,
  opts: Omit<JobsOptions, 'jobId'> = {},
) {
  const queue = getSecurityScanQueue();
  const stableJobId = dispatchJobId(data.scanId);
  const existing = await queue.getJob(stableJobId);
  if (existing) {
    const state = await existing.getState();
    if (isReusableState(state)) return existing;
    await existing.remove().catch((error) => {
      console.error('[SecurityScanJobs] Failed to remove stale job:', error);
    });
  }
  return queue.add('dispatch-scan', data, {
    removeOnComplete: { count: 200 },
    removeOnFail: { count: 500 },
    jobId: stableJobId,
    ...opts,
  });
}

export async function enqueueSecurityScan(scanId: string): Promise<string | null> {
  const job = await addUniqueDispatchJob({ type: 'dispatch-scan', scanId, origin: 'manual' });
  return typeof job.id === 'string' ? job.id : job.id ? String(job.id) : null;
}
```

Then the counters and the dispatch, each a direct translation of the sensitive-data original
(`sensitiveDataJobs.ts:190-262` and `:263-542`) with `sensitiveDataScans` → `securityScans`:

```ts
async function getOrgRunningScans(orgId: string): Promise<number> { /* COUNT status='running' */ }
async function getOrgQueuedScans(orgId: string): Promise<number> { /* COUNT status='queued' */ }
async function getDeviceRunningScans(deviceId: string): Promise<number> { /* COUNT status='running' */ }
async function getDevicePendingCommands(deviceId: string): Promise<number> {
  // COUNT device_commands WHERE device_id = $1 AND type = CommandTypes.SECURITY_SCAN
  //   AND status IN ('pending','sent')
}
async function requeueThrottledScan(data: DispatchScanJobData, reason: string): Promise<void> {
  await addUniqueDispatchJob(data, { delay: SECURITY_SCAN_THROTTLE_REQUEUE_SECONDS * 1000 });
  console.warn(`[SecurityScanJobs] scan ${data.scanId} throttled: ${reason}`);
}

export async function processDispatchScan(data: DispatchScanJobData): Promise<{
  dispatched: boolean;
  commandId: string | null;
}> {
  const [scan] = await db
    .select({
      id: securityScans.id,
      orgId: securityScans.orgId,
      deviceId: securityScans.deviceId,
      scanType: securityScans.scanType,
      status: securityScans.status,
      deviceOrgId: devices.orgId,
    })
    .from(securityScans)
    .innerJoin(devices, eq(devices.id, securityScans.deviceId))
    .where(eq(securityScans.id, data.scanId))
    .limit(1);
  if (!scan || scan.status !== 'queued') return { dispatched: false, commandId: null };

  // The device may have moved org between creation and dispatch. A scan row
  // pointing at a stranger's org is a tenancy defect, not a retryable one.
  if (scan.deviceOrgId !== scan.orgId) {
    await db.update(securityScans)
      .set({ status: 'failed', completedAt: new Date() })
      .where(eq(securityScans.id, scan.id));
    return { dispatched: false, commandId: null };
  }

  if (await getOrgRunningScans(scan.orgId) >= SECURITY_SCAN_ORG_CONCURRENCY_CAP) {
    await requeueThrottledScan(data, `org cap ${SECURITY_SCAN_ORG_CONCURRENCY_CAP}`);
    return { dispatched: false, commandId: null };
  }
  if (await getDeviceRunningScans(scan.deviceId) >= SECURITY_SCAN_DEVICE_CONCURRENCY_CAP) {
    await requeueThrottledScan(data, `device cap ${SECURITY_SCAN_DEVICE_CONCURRENCY_CAP}`);
    return { dispatched: false, commandId: null };
  }
  if (await getDevicePendingCommands(scan.deviceId) >= SECURITY_SCAN_DEVICE_CONCURRENCY_CAP) {
    await requeueThrottledScan(data, 'device queue busy');
    return { dispatched: false, commandId: null };
  }

  const settings = await resolveSecurityScanSettingsForDevice(scan.deviceId);
  const payload = buildSecurityScanPayload(scan.id, scan.scanType, settings);

  // Claim before dispatching: two workers must never both queue a command.
  const claimed = await db.update(securityScans)
    .set({ status: 'running', startedAt: new Date() })
    .where(and(eq(securityScans.id, scan.id), eq(securityScans.status, 'queued')))
    .returning({ id: securityScans.id });
  if (claimed.length !== 1) return { dispatched: false, commandId: null };

  const queued = await queueCommandForExecution(
    scan.deviceId,
    CommandTypes.SECURITY_SCAN,
    payload,
    { expectedOrgId: scan.orgId },
  );
  if ('error' in queued || !queued.command) {
    await db.update(securityScans)
      .set({ status: 'failed', completedAt: new Date() })
      .where(eq(securityScans.id, scan.id));
    return { dispatched: false, commandId: null };
  }
  return { dispatched: true, commandId: queued.command.id };
}
```

And the payload builder, exported for the route in Task 5:

```ts
/**
 * The ONLY place a security_scan command payload is built. `settings === null`
 * means no policy governs the device: the agent's built-in defaults apply and
 * nothing is auto-quarantined.
 */
export function buildSecurityScanPayload(
  scanRecordId: string,
  scanType: string,
  settings: SecurityScanSettings | null,
  paths?: string[],
): Record<string, unknown> {
  return {
    scanRecordId,
    scanType,
    ...(paths && paths.length > 0 ? { paths } : {}),
    triggerDefender: true,
    ...(settings
      ? {
          exclusions: settings.exclusions,
          maxFileSizeMb: settings.maxFileSizeMb,
          timeoutMinutes: settings.scanTimeoutMinutes,
          autoQuarantine: settings.autoQuarantine,
        }
      : {}),
  };
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd apps/api && npx vitest run src/jobs/securityScanJobs.test.ts`
Expected: PASS, 1 file, 5 tests.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/jobs/securityScanJobs.ts apps/api/src/jobs/securityScanJobs.test.ts \
        apps/api/src/jobs/queueSchemas.ts
git commit -m "feat(api): security scan queue and dispatch with resolved policy settings (#6264)"
```

---

### Task 4: The 60-second tick, cron due-evaluation, fan-out, and worker registration

**Files:**
- Modify: `apps/api/src/jobs/securityScanJobs.ts` (append)
- Modify: `apps/api/src/jobs/securityScanJobs.test.ts` (append)
- Modify: `apps/api/src/services/workerRegistry.ts` (one entry, beside `sensitiveDataWorker` at `:930-937`)
- Modify: `apps/api/src/jobs/workerReadinessManifest.ts` (one line, beside `consumers('sensitiveDataWorker')` at `:150`)
- Read first (do not modify): `apps/api/src/jobs/sensitiveDataJobs.ts:594-720` (fan-out + insert +
  `addBulk`) and `:790-833` (repeatable tick + lifecycle)

**Interfaces:**
- Consumes `resolveAllSecurityScanScheduledDevices` + `SecurityScanSchedulable` (Task 2),
  `securityScanCron` (Task 1), `isCronDue` (`apps/api/src/services/cronDue.ts:149`),
  `resolvePartnerTimezoneForOrg` (`featureConfigResolver.ts:614`).
- Produces `shouldScheduleSecurityScan(settings, timezone, now): boolean`,
  `schedulePolicyScans(entry: SecurityScanSchedulable, now: Date): Promise<number>`,
  `createSecurityScanWorker()`, `initializeSecurityScanWorkers()`, `shutdownSecurityScanWorkers()`.

- [ ] **Step 1: Write the failing tests**

Append to `apps/api/src/jobs/securityScanJobs.test.ts`:

```ts
import { shouldScheduleSecurityScan, schedulePolicyScans } from './securityScanJobs';
import { SECURITY_SCAN_SETTINGS_DEFAULTS } from '@breeze/shared';

describe('shouldScheduleSecurityScan', () => {
  it('is false when scheduling is off', () => {
    expect(shouldScheduleSecurityScan(
      { ...SECURITY_SCAN_SETTINGS_DEFAULTS, scheduledScans: false },
      'UTC',
      new Date('2026-09-18T02:00:00Z'),
    )).toBe(false);
  });

  it('is true exactly on the cron minute in the policy timezone', () => {
    const settings = { ...SECURITY_SCAN_SETTINGS_DEFAULTS, scanMinute: '0', scanHour: '2' };
    expect(shouldScheduleSecurityScan(settings, 'UTC', new Date('2026-09-18T02:00:30Z'))).toBe(true);
    expect(shouldScheduleSecurityScan(settings, 'UTC', new Date('2026-09-18T02:01:00Z'))).toBe(false);
    // 02:00 America/New_York is 06:00Z in September (EDT)
    expect(shouldScheduleSecurityScan(settings, 'America/New_York',
      new Date('2026-09-18T06:00:00Z'))).toBe(true);
    expect(shouldScheduleSecurityScan(settings, 'America/New_York',
      new Date('2026-09-18T02:00:00Z'))).toBe(false);
  });
});

describe('schedulePolicyScans', () => {
  beforeEach(() => vi.clearAllMocks());

  it('creates one scan row per device, each taking the DEVICE org, not the policy org', async () => {
    // arrange: partner-wide policy (orgId null) with two devices in two different orgs
    const created = await schedulePolicyScans({
      configPolicyId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      orgId: null,
      partnerId: 'pppppppp-pppp-4ppp-8ppp-pppppppppppp',
      settings: { ...SECURITY_SCAN_SETTINGS_DEFAULTS },
      deviceIds: ['d1...', 'd2...'],
    }, new Date('2026-09-18T02:00:00Z'));

    expect(created).toBe(2);
    expect(dbInsertValuesMock).toHaveBeenCalledWith([
      expect.objectContaining({ deviceId: 'd1...', orgId: 'org-of-d1', initiatedBy: null }),
      expect.objectContaining({ deviceId: 'd2...', orgId: 'org-of-d2', initiatedBy: null }),
    ]);
  });

  it('skips a device that already has a queued or running scan', async () => {
    // arrange: d1 has a running security_scans row
    const created = await schedulePolicyScans({ /* … deviceIds: ['d1...'] */ } as never,
      new Date('2026-09-18T02:00:00Z'));
    expect(created).toBe(0);
    expect(dbInsertValuesMock).not.toHaveBeenCalled();
  });

  it('skips a device already scanned within this cron minute (double tick)', async () => {
    // arrange: d1 has a completed row with startedAt 2026-09-18T02:00:10Z
    const created = await schedulePolicyScans({ /* … */ } as never,
      new Date('2026-09-18T02:00:45Z'));
    expect(created).toBe(0);
  });

  it('skips backpressured orgs but still schedules the rest', async () => {
    // arrange: org A over SECURITY_SCAN_ORG_QUEUE_BACKPRESSURE_LIMIT, org B under
    const created = await schedulePolicyScans({ /* two devices, one per org */ } as never,
      new Date('2026-09-18T02:00:00Z'));
    expect(created).toBe(1);
  });

  it('enqueues one dispatch job per created scan, tagged policy_scheduler', async () => {
    await schedulePolicyScans({ /* one device */ } as never, new Date('2026-09-18T02:00:00Z'));
    expect(queueAddBulkMock).toHaveBeenCalledWith([
      expect.objectContaining({
        name: 'dispatch-scan',
        data: expect.objectContaining({ origin: 'policy_scheduler', occurrenceIso: '2026-09-18T02:00:00.000Z' }),
      }),
    ]);
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `cd apps/api && npx vitest run src/jobs/securityScanJobs.test.ts`
Expected: FAIL — `shouldScheduleSecurityScan is not a function`.

- [ ] **Step 3: Implement due-evaluation and fan-out**

Append to `apps/api/src/jobs/securityScanJobs.ts`:

```ts
/** Truncate to the minute — the occurrence identity for idempotency. */
function occurrenceStart(now: Date): Date {
  const d = new Date(now);
  d.setSeconds(0, 0);
  return d;
}

export function shouldScheduleSecurityScan(
  settings: SecurityScanSettings,
  timezone: string,
  now: Date,
): boolean {
  const cron = securityScanCron(settings);
  if (!cron) return false;
  return isCronDue(cron, timezone || 'UTC', now);
}

/**
 * Create + enqueue scans for ONE due policy. Exported so an integration test can
 * prove the partner-wide device fan-out against real Postgres.
 *
 * Every row takes the DEVICE's org: identical to the policy's org for an
 * org-owned policy, and the only correct org for a partner-wide one.
 * `initiated_by` is NULL — a scheduled scan has no human actor, and NULL is
 * already allowed (`security_scans.initiated_by` is nullable).
 */
export async function schedulePolicyScans(
  entry: SecurityScanSchedulable,
  now: Date,
): Promise<number> {
  if (entry.deviceIds.length === 0) return 0;
  const occurrence = occurrenceStart(now);

  const deviceRows = await db
    .select({ id: devices.id, orgId: devices.orgId })
    .from(devices)
    .where(and(
      inArray(devices.id, entry.deviceIds),
      eq(devices.isEphemeral, false),
      ne(devices.status, 'decommissioned'),
    ));
  if (deviceRows.length === 0) return 0;

  // Per-org backpressure, evaluated per member org so one saturated org under a
  // partner-wide policy cannot starve the rest.
  const admittedOrgIds = new Set<string>();
  const backpressured: string[] = [];
  for (const orgId of new Set(deviceRows.map((d) => d.orgId))) {
    if (await getOrgQueuedScans(orgId) < SECURITY_SCAN_ORG_QUEUE_BACKPRESSURE_LIMIT) {
      admittedOrgIds.add(orgId);
    } else {
      backpressured.push(orgId);
    }
  }
  if (backpressured.length > 0) {
    console.warn(
      `[SecurityScanJobs] policy ${entry.configPolicyId}: skipped ${backpressured.length} `
      + `backpressured org(s) this cycle: ${backpressured.join(', ')}`,
    );
  }

  // Occurrence idempotency (plan DECISION 2): skip a device that is already
  // queued/running, or that already started a scan inside this cron minute.
  const busy = await db
    .select({ deviceId: securityScans.deviceId })
    .from(securityScans)
    .where(and(
      inArray(securityScans.deviceId, deviceRows.map((d) => d.id)),
      sql`(${securityScans.status} IN ('queued','running') OR ${securityScans.startedAt} >= ${occurrence})`,
    ));
  const busyIds = new Set(busy.map((b) => b.deviceId));

  const targets = deviceRows.filter((d) => admittedOrgIds.has(d.orgId) && !busyIds.has(d.id));
  if (targets.length === 0) return 0;

  const created = await db
    .insert(securityScans)
    .values(targets.map((device) => ({
      orgId: device.orgId,
      deviceId: device.id,
      scanType: entry.settings.scanType,
      status: 'queued',
      startedAt: occurrence,
      initiatedBy: null,
    })))
    .returning({ id: securityScans.id });

  await getSecurityScanQueue().addBulk(created.map((scan) => ({
    name: 'dispatch-scan',
    data: {
      type: 'dispatch-scan' as const,
      scanId: scan.id,
      origin: 'policy_scheduler' as const,
      configPolicyId: entry.configPolicyId,
      occurrenceIso: occurrence.toISOString(),
    },
    opts: {
      jobId: dispatchJobId(scan.id),
      removeOnComplete: { count: 200 },
      removeOnFail: { count: 500 },
    },
  })));

  return created.length;
}

async function processSchedulePolicies(data: SchedulePoliciesJobData): Promise<{
  scheduledPolicies: number;
  scansQueued: number;
}> {
  const parsed = new Date(data.scanAt);
  const now = Number.isFinite(parsed.getTime()) ? parsed : new Date();

  const entries = await resolveAllSecurityScanScheduledDevices();
  let scheduledPolicies = 0;
  let scansQueued = 0;
  const timezoneByOrg = new Map<string, string>();

  for (const entry of entries) {
    // Timezone: the owning org's partner timezone, else UTC. A partner-wide
    // policy (orgId NULL) has no org of its own, so it falls back to UTC rather
    // than silently borrowing one member org's clock.
    let timezone = 'UTC';
    if (entry.orgId) {
      if (!timezoneByOrg.has(entry.orgId)) {
        timezoneByOrg.set(entry.orgId, (await resolvePartnerTimezoneForOrg(entry.orgId)) ?? 'UTC');
      }
      timezone = timezoneByOrg.get(entry.orgId)!;
    }
    if (!shouldScheduleSecurityScan(entry.settings, timezone, now)) continue;

    const queued = await schedulePolicyScans(entry, now);
    if (queued > 0) {
      scansQueued += queued;
      scheduledPolicies++;
    }
  }

  return { scheduledPolicies, scansQueued };
}
```

- [ ] **Step 4: Implement the worker lifecycle**

Still in `securityScanJobs.ts` — an exact translation of `sensitiveDataJobs.ts:767-833`:

```ts
export function createSecurityScanWorker(): Worker<SecurityScanQueueJobData> {
  return new Worker<SecurityScanQueueJobData>(
    SECURITY_SCAN_QUEUE,
    async (job: Job<SecurityScanQueueJobData>) => runWithSystemDbAccess(async () => {
      const data = parseQueueJobData(SECURITY_SCAN_QUEUE, job, securityScanQueueJobDataSchema);
      if (data.type === 'dispatch-scan') {
        assertQueueJobName(SECURITY_SCAN_QUEUE, job, 'dispatch-scan');
        return processDispatchScan(data);
      }
      assertQueueJobName(SECURITY_SCAN_QUEUE, job, 'schedule-policies');
      return processSchedulePolicies(data);
    }),
    {
      connection: getBullMQConnection(),
      concurrency: SECURITY_SCAN_WORKER_CONCURRENCY,
      lockDuration: 120_000,
      lockRenewTime: 60_000,
    },
  );
}

async function schedulePolicyTick(): Promise<void> {
  const queue = getSecurityScanQueue();
  for (const job of await queue.getRepeatableJobs()) {
    if (job.name === 'schedule-policies') await queue.removeRepeatableByKey(job.key);
  }
  await queue.add(
    'schedule-policies',
    { type: 'schedule-policies', scanAt: new Date().toISOString() },
    { repeat: { every: POLICY_SCAN_INTERVAL_MS }, removeOnComplete: { count: 20 }, removeOnFail: { count: 100 } },
  );
}

export async function initializeSecurityScanWorkers(): Promise<void> {
  securityScanWorker = createSecurityScanWorker();
  attachWorkerObservability(securityScanWorker, 'securityScanWorker');
  securityScanWorker.on('error', (error) => {
    console.error('[SecurityScanWorker] Worker error:', error);
  });
  securityScanWorker.on('failed', (job, error) => {
    console.error(`[SecurityScanWorker] Job ${job?.id} failed:`, error);
  });
  await schedulePolicyTick();
  console.log('[SecurityScanWorker] Security scan workers initialized');
}

export async function shutdownSecurityScanWorkers(): Promise<void> {
  if (securityScanWorker) { await securityScanWorker.close(); securityScanWorker = null; }
  if (securityScanQueue) { await securityScanQueue.close(); securityScanQueue = null; }
}
```

- [ ] **Step 5: Register the worker**

In `apps/api/src/services/workerRegistry.ts`, immediately after the `sensitiveDataWorker` entry
(`:930-937`):

```ts
  {
    // #6263 W01. socket-owner, not global: the dispatch path imports
    // services/commandQueue, whose closure reaches routes/agentWs.ts — the same
    // reason sensitiveDataWorker above is socket-owner. Verified by
    // workerEntrypointClosure.contract.test.ts, not by guessing.
    name: 'securityScanWorker',
    placement: 'socket-owner',
    load: async () => {
      const m = await import('../jobs/securityScanJobs');
      return { init: m.initializeSecurityScanWorkers, shutdown: m.shutdownSecurityScanWorkers };
    },
  },
```

In `apps/api/src/jobs/workerReadinessManifest.ts`, immediately after
`consumers('sensitiveDataWorker'),` (`:150`):

```ts
  consumers('securityScanWorker'),
```

- [ ] **Step 6: Run the tests to verify they pass**

```bash
cd apps/api && npx vitest run src/jobs/securityScanJobs.test.ts
cd apps/api && npx vitest run src/jobs/workerReadinessCoverage.test.ts src/jobs/workerReadinessManifest.test.ts
cd apps/api && npx vitest run src/jobs/scheduleRegistry.contract.test.ts
```
Expected: all PASS. If `workerEntrypointClosure.contract.test.ts` exists in the matched set, run it too —
a wrong `placement` fails exactly there:
`cd apps/api && npx vitest run src/__tests__/workerEntrypointClosure.contract.test.ts`

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/jobs/securityScanJobs.ts apps/api/src/jobs/securityScanJobs.test.ts \
        apps/api/src/services/workerRegistry.ts apps/api/src/jobs/workerReadinessManifest.ts
git commit -m "feat(api): 60s security scan policy tick with device-org fan-out (#6264)"
```

---

### Task 5: The manual scan route ships the device's resolved settings

**Files:**
- Modify: `apps/api/src/routes/security/scans.ts:41-108` (the `POST /scan/:deviceId` handler body)
- Modify: `apps/api/src/routes/security/schemas.ts:154-161` (`listScansQuerySchema.status`)
- Modify: `apps/api/src/routes/security/scans.test.ts`
- Read first (do not modify): `apps/api/src/routes/security/scans.ts` in full (the site-scope gate at
  `:22-38` and the `requirePermission('devices','execute')` rationale at `:44-47` must survive untouched)

**Interfaces:**
- Consumes `resolveSecurityScanSettingsForDevice` (Task 2) and `buildSecurityScanPayload` (Task 3).
- Produces no new export; the route's 202 response body is unchanged.

- [ ] **Step 1: Write the failing test**

Append to `apps/api/src/routes/security/scans.test.ts` (match the existing harness in that file):

```ts
it('attaches the device\'s resolved policy settings to the queued command', async () => {
  resolveSecurityScanSettingsForDeviceMock.mockResolvedValue({
    ...SECURITY_SCAN_SETTINGS_DEFAULTS,
    exclusions: ['C:\\Backups'],
    maxFileSizeMb: 64,
    scanTimeoutMinutes: 30,
    autoQuarantine: false,
  });

  const res = await app.request('/security/scan/dddddddd-dddd-4ddd-8ddd-dddddddddddd', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scanType: 'quick' }),
  });

  expect(res.status).toBe(202);
  expect(queueCommandMock).toHaveBeenCalledWith(
    'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    'security_scan',
    expect.objectContaining({
      exclusions: ['C:\\Backups'],
      maxFileSizeMb: 64,
      timeoutMinutes: 30,
      autoQuarantine: false,
    }),
    expect.any(String),
  );
});

it('omits the settings keys entirely when no policy governs the device', async () => {
  resolveSecurityScanSettingsForDeviceMock.mockResolvedValue(null);
  await app.request('/security/scan/dddddddd-dddd-4ddd-8ddd-dddddddddddd', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scanType: 'quick' }),
  });
  const payload = queueCommandMock.mock.calls.at(-1)![2];
  expect(payload).not.toHaveProperty('exclusions');
  expect(payload).not.toHaveProperty('autoQuarantine');
});

it('accepts timed_out as a scan list filter', async () => {
  const res = await app.request(
    '/security/scans/dddddddd-dddd-4ddd-8ddd-dddddddddddd?status=timed_out',
  );
  expect(res.status).toBe(200);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/api && npx vitest run src/routes/security/scans.test.ts`
Expected: FAIL — the payload lacks `exclusions`; the `timed_out` query is rejected with 400.

- [ ] **Step 3: Widen the list filter**

In `apps/api/src/routes/security/schemas.ts`, `listScansQuerySchema` (`:154`):

```ts
  // 'timed_out' (#6263 W01): a scan that hit its policy deadline. Threats found
  // before the deadline are still ingested, so it is an outcome, not a failure.
  status: z.enum(['queued', 'running', 'completed', 'failed', 'timed_out']).optional(),
```

- [ ] **Step 4: Resolve and attach the settings in the route**

In `apps/api/src/routes/security/scans.ts`, replace the `queueCommand(...)` call (`:86-95`) with:

```ts
    // #6263 W01: the effective security policy — resolved in the CALLER'S OWN
    // RLS context, self-tenanted by the device's hierarchy. `null` means no
    // policy governs this device, and the agent then uses its own defaults.
    const settings = await resolveSecurityScanSettingsForDevice(device.id);

    await queueCommand(
      device.id,
      CommandTypes.SECURITY_SCAN,
      buildSecurityScanPayload(scanId, payload.scanType, settings, payload.paths),
      auth.user.id,
    );
```

with the two imports added at the top:

```ts
import { resolveSecurityScanSettingsForDevice } from '../../services/featureConfigResolver';
import { buildSecurityScanPayload } from '../../jobs/securityScanJobs';
```

**Do not** change `queueCommand` to `queueCommandForExecution` here — the route's existing delivery
semantics are out of scope for this wave.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd apps/api && npx vitest run src/routes/security/scans.test.ts`
Expected: PASS, including the file's pre-existing cases.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/security/scans.ts apps/api/src/routes/security/schemas.ts \
        apps/api/src/routes/security/scans.test.ts
git commit -m "feat(api): manual security scan ships the device's effective policy settings (#6264)"
```

---

### Task 6: Ingest partial results, timeouts, and agent-side auto-quarantine

**Files:**
- Modify: `apps/api/src/routes/agents/helpers.ts:607-682` (the `securityCommandTypes.scan` branch **only**)
- Modify: `apps/api/src/routes/agents/helpers.test.ts`
- Read first (do not modify): `apps/api/src/routes/agents/helpers.ts:588-700` in full — in particular the
  `#2434` redaction note at `:668-671` (`details: redactSecretsDeep(threat)`), which stays exactly as is

**Interfaces:**
- Consumes the agent result keys `filesScanned`, `timedOut`, `partial`, and per-threat `quarantinedTo`
  (Tasks 7–8).
- Produces no new export. Writes `security_scans.status ∈ {completed, failed, timed_out}`,
  `security_scans.items_scanned`, and `security_threats.status ∈ {detected, quarantined}`.

- [ ] **Step 1: Write the failing test**

Append to `apps/api/src/routes/agents/helpers.test.ts`:

```ts
it('records a timed-out scan as timed_out and still ingests its partial threats', async () => {
  await handleSecurityCommandResult(scanCommand, {
    status: 'completed',
    durationMs: 7_200_000,
    stdout: JSON.stringify({
      scanRecordId: SCAN_ID,
      scanType: 'full',
      threatsFound: 1,
      filesScanned: 41_233,
      timedOut: true,
      partial: true,
      threats: [{ name: 'Test-Threat', path: 'C:\\tmp\\x', severity: 'high', quarantinedTo: '' }],
    }),
  } as never);

  expect(scanUpdateSetMock).toHaveBeenCalledWith(expect.objectContaining({
    status: 'timed_out',
    itemsScanned: 41_233,
  }));
  expect(threatInsertValuesMock).toHaveBeenCalledWith([
    expect.objectContaining({ status: 'detected' }),
  ]);
});

it('records a threat the agent already quarantined as quarantined, not detected', async () => {
  await handleSecurityCommandResult(scanCommand, {
    status: 'completed',
    durationMs: 1000,
    stdout: JSON.stringify({
      scanRecordId: SCAN_ID,
      scanType: 'quick',
      threatsFound: 1,
      filesScanned: 12,
      threats: [{
        name: 'Test-Threat', path: 'C:\\tmp\\x', severity: 'high',
        quarantinedTo: 'C:\\ProgramData\\Breeze\\quarantine\\x-1758000000.bqz',
      }],
    }),
  } as never);

  expect(threatInsertValuesMock).toHaveBeenCalledWith([
    expect.objectContaining({ status: 'quarantined' }),
  ]);
});

it('still ingests a result from an agent that sends none of the new keys', async () => {
  await handleSecurityCommandResult(scanCommand, {
    status: 'completed',
    durationMs: 1000,
    stdout: JSON.stringify({ scanRecordId: SCAN_ID, scanType: 'quick', threatsFound: 0, threats: [] }),
  } as never);

  expect(scanUpdateSetMock).toHaveBeenCalledWith(expect.objectContaining({
    status: 'completed', itemsScanned: null,
  }));
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/api && npx vitest run src/routes/agents/helpers.test.ts`
Expected: FAIL — status is `completed`, `itemsScanned` is absent, threat status is `detected`.

- [ ] **Step 3: Implement**

In the `securityCommandTypes.scan` branch of `handleSecurityCommandResult`:

```ts
    const timedOut = resultJson?.timedOut === true;
    const filesScannedRaw = resultJson?.filesScanned;
    const itemsScanned = typeof filesScannedRaw === 'number' && Number.isFinite(filesScannedRaw)
      ? Math.max(0, Math.floor(filesScannedRaw))
      : null;
    // #6263 W01: a scan that hit its policy deadline is an outcome, not an
    // error — the threats it did find are real and are ingested below.
    const scanStatus = resultData.status !== 'completed'
      ? 'failed'
      : timedOut ? 'timed_out' : 'completed';
```

Use `scanStatus` and `itemsScanned` in both the UPDATE (`:633-640`) and the INSERT (`:642-654`) arms —
the INSERT arm must also carry `itemsScanned`. Then widen the threat-status decision and keep the
threat ingest running for a timed-out scan:

```ts
    if (resultData.status === 'completed' && threatsValue.length > 0) {
      …
        const quarantinedTo = asString(threat.quarantinedTo) ?? '';
        inserts.push({
          …
          // The agent auto-quarantined this one during the walk (payload
          // autoQuarantine). Recording it as 'detected' would show the tech a
          // live threat and offer them a Quarantine button for a file that is
          // already encoded away.
          status: quarantinedTo ? 'quarantined' : 'detected',
          …
        });
```

Leave `details: redactSecretsDeep(threat)` untouched — `quarantinedTo` is a local path and belongs in
the details blob too.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/api && npx vitest run src/routes/agents/helpers.test.ts`
Expected: PASS, including the file's pre-existing security cases.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/agents/helpers.ts apps/api/src/routes/agents/helpers.test.ts
git commit -m "feat(api): ingest partial, timed-out and auto-quarantined scan results (#6264)"
```

---

### Task 7: Agent — honour exclusions, size cap and deadline; report partial results

**Files:**
- Modify: `agent/internal/security/threats.go:130-253` (`threatScanOptions`, `detectThreats`)
- Modify: `agent/internal/security/scanner.go:15-76` (`SecurityScanner`, `ScanResult`, `scanPaths`)
- Modify: `agent/internal/security/threats_test.go` (append)
- Create: `agent/internal/security/scanner_test.go`
- Modify: `agent/internal/heartbeat/handlers_security.go:39-84` (`handleSecurityScan`)
- Create: `agent/internal/heartbeat/handlers_security_test.go`
- Read first (do not modify): `agent/internal/remote/tools/sensitive_data_scan.go:778-1003`
  (`ScanSensitiveData` — the ctx + anonymous-goroutine pool + `markTimedOut` shape being copied) and
  `agent/internal/security/threats_test.go:11-53` (the `deobf` convention, which is mandatory)

**Interfaces:**
- Consumes payload keys `exclusions`, `maxFileSizeMb`, `timeoutMinutes`, `autoQuarantine` (Task 3/5).
- Produces:
  ```go
  type ScanOutcome struct {
      Threats      []Threat
      Status       SecurityStatus
      Duration     time.Duration
      FilesScanned int
      TimedOut     bool
      Partial      bool
  }
  func (s *SecurityScanner) ScanWithContext(ctx context.Context, scanType string, paths []string) (ScanOutcome, error)
  ```
  plus `SecurityScanner.Exclusions []string`, `.Timeout time.Duration`, `.AutoQuarantine bool`, and
  `Threat.QuarantinedTo string` (json `quarantinedTo,omitempty`). `QuickScan`/`FullScan`/`CustomScan`
  and `ScanResult` keep their current signatures and are implemented on top of `ScanWithContext`.

- [ ] **Step 1: Write the failing tests**

Append to `agent/internal/security/threats_test.go`:

```go
func TestDetectThreatsHonoursCallerExclusions(t *testing.T) {
	root := t.TempDir()
	skipped := filepath.Join(root, "skipme")
	if err := os.MkdirAll(skipped, 0o700); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(skipped, avTestToken()+".com"), []byte(avTestContent()), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}

	options := scanOptionsForTest()
	options.ExcludePaths = []string{skipped}
	threats, _, err := detectThreatsCtx(context.Background(), []string{root}, options)
	if err != nil {
		t.Fatalf("detectThreatsCtx: %v", err)
	}
	if len(threats) != 0 {
		t.Fatalf("expected the excluded directory to be skipped, got %d threat(s)", len(threats))
	}
}

func TestDetectThreatsCountsFilesScanned(t *testing.T) {
	root := t.TempDir()
	for _, name := range []string{"a.txt", "b.txt", "c.txt"} {
		if err := os.WriteFile(filepath.Join(root, name), []byte("clean"), 0o600); err != nil {
			t.Fatalf("write: %v", err)
		}
	}
	_, scanned, err := detectThreatsCtx(context.Background(), []string{root}, scanOptionsForTest())
	if err != nil {
		t.Fatalf("detectThreatsCtx: %v", err)
	}
	if scanned != 3 {
		t.Fatalf("filesScanned = %d, want 3", scanned)
	}
}

func TestDetectThreatsStopsOnCancelledContext(t *testing.T) {
	root := t.TempDir()
	for i := 0; i < 50; i++ {
		if err := os.WriteFile(filepath.Join(root, fmt.Sprintf("f%d.txt", i)), []byte("clean"), 0o600); err != nil {
			t.Fatalf("write: %v", err)
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, scanned, err := detectThreatsCtx(ctx, []string{root}, scanOptionsForTest())
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("err = %v, want context.Canceled", err)
	}
	if scanned > 1 {
		t.Fatalf("filesScanned = %d, want the walk to stop immediately", scanned)
	}
}

func TestDetectThreatsSkipsOversizeFilesWithoutReading(t *testing.T) {
	root := t.TempDir()
	big := filepath.Join(root, avTestToken()+".com")
	if err := os.WriteFile(big, []byte(avTestContent()), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}
	options := scanOptionsForTest()
	options.MaxFileSize = 1 // every file is oversize
	threats, _, err := detectThreatsCtx(context.Background(), []string{root}, options)
	if err != nil {
		t.Fatalf("detectThreatsCtx: %v", err)
	}
	// The filename signature still matches — only the CONTENT read is skipped.
	for _, th := range threats {
		if th.Type == "content" {
			t.Fatalf("content signature matched on an oversize file: %+v", th)
		}
	}
}
```

Create `agent/internal/security/scanner_test.go`:

```go
package security

import (
	"context"
	"testing"
	"time"
)

func TestScanWithContextReportsTimeout(t *testing.T) {
	s := &SecurityScanner{Timeout: time.Nanosecond}
	out, err := s.ScanWithContext(context.Background(), "custom", []string{t.TempDir()})
	if err != nil {
		t.Fatalf("ScanWithContext returned err %v; a deadline is an outcome, not an error", err)
	}
	if !out.TimedOut || !out.Partial {
		t.Fatalf("TimedOut=%v Partial=%v, want both true", out.TimedOut, out.Partial)
	}
}

func TestScanWithContextRejectsUnknownScanType(t *testing.T) {
	s := &SecurityScanner{}
	if _, err := s.ScanWithContext(context.Background(), "sideways", nil); err == nil {
		t.Fatal("expected an error for an unsupported scanType")
	}
}

func TestScanWithContextCustomRequiresPaths(t *testing.T) {
	s := &SecurityScanner{}
	if _, err := s.ScanWithContext(context.Background(), "custom", nil); err == nil {
		t.Fatal("expected an error for a custom scan with no paths")
	}
}
```

Create `agent/internal/heartbeat/handlers_security_test.go` asserting that `handleSecurityScan` reads
the four new payload keys onto the scanner (construct a `Heartbeat` the way the existing heartbeat
tests in this package do — read one first):

```go
func TestHandleSecurityScanAppliesPayloadSettings(t *testing.T) {
	// payload: {"scanType":"quick","scanRecordId":"…","exclusions":["/tmp/skip"],
	//           "maxFileSizeMb":64,"timeoutMinutes":30,"autoQuarantine":true}
	// assert: the scanner used carries Exclusions=["/tmp/skip"],
	//         MaxFileSize=64<<20, Timeout=30*time.Minute, AutoQuarantine=true,
	//         and the result map carries filesScanned/timedOut/partial keys.
}

func TestHandleSecurityScanDefaultsWhenPayloadOmitsSettings(t *testing.T) {
	// payload: {"scanType":"quick"} — no panic, zero-value settings, agent defaults apply.
}
```

- [ ] **Step 2: Run them and watch them fail**

Run: `cd agent && go test -race ./internal/security/... ./internal/heartbeat/...`
Expected: FAIL to compile — `undefined: detectThreatsCtx`, `undefined: ScanOutcome`.

- [ ] **Step 3: Make the walk context-aware and caller-configurable**

In `agent/internal/security/threats.go`:

```go
// detectThreatsCtx is detectThreats with a deadline and a scanned-file counter.
// A cancelled context returns what was found so far plus ctx.Err(); callers
// decide whether that is a timeout (partial results, reported) or a real error.
//
// Deliberately still single-goroutine: the legacy signature table is cheap and
// the walk is IO-bound. W02 replaces the matcher with YARA-X and lifts the
// worker pool from tools.ScanSensitiveData at the same time — splitting those
// two changes keeps this wave's blast radius on scheduling, not throughput.
func detectThreatsCtx(ctx context.Context, paths []string, options threatScanOptions) ([]Threat, int, error) {
	// ... existing detectThreats body, plus, as the first statement inside the
	// WalkDir callback:
	//     select {
	//     case <-ctx.Done():
	//         return ctx.Err()
	//     default:
	//     }
	// ... and `filesScanned++` for every regular file actually considered.
}

// detectThreats keeps its signature for the existing callers and tests.
func detectThreats(paths []string, options threatScanOptions) ([]Threat, error) {
	threats, _, err := detectThreatsCtx(context.Background(), paths, options)
	return threats, err
}
```

`threatScanOptions.ExcludePaths` already exists (`threats.go:130-134`) and is already honoured by
`isExcludedPath` (`:438`) for both directories (`fs.SkipDir`) and files — the caller exclusions arrive
by appending to it, no new mechanism.

- [ ] **Step 4: Add the settings fields and `ScanWithContext`**

In `agent/internal/security/scanner.go`:

```go
type SecurityScanner struct {
	QuarantineDir string
	MaxFileSize   int64
	MaxReadBytes  int64
	Config        *config.Config

	// #6263 W01 — delivered per scan in the command payload, resolved from the
	// device's effective security config policy. Zero values mean "agent
	// defaults", which is what an unmanaged device gets.
	Exclusions     []string
	Timeout        time.Duration
	AutoQuarantine bool
}

type ScanOutcome struct {
	Threats      []Threat
	Status       SecurityStatus
	Duration     time.Duration
	FilesScanned int
	TimedOut     bool
	Partial      bool
}

func (s *SecurityScanner) ScanWithContext(ctx context.Context, scanType string, paths []string) (ScanOutcome, error) {
	var targets []string
	switch strings.ToLower(scanType) {
	case "quick":
		targets = defaultQuickPaths()
	case "full":
		targets = defaultFullPaths()
	case "custom":
		if len(paths) == 0 {
			return ScanOutcome{}, fmt.Errorf("custom scan requires one or more paths")
		}
		targets = filterExistingPaths(paths)
	default:
		return ScanOutcome{}, fmt.Errorf("unsupported scanType: %s", scanType)
	}

	options := defaultThreatScanOptions()
	if s.MaxFileSize > 0 {
		options.MaxFileSize = s.MaxFileSize
	}
	if s.MaxReadBytes > 0 {
		options.MaxReadBytes = s.MaxReadBytes
	}
	if dir := s.quarantineDir(); dir != "" {
		options.ExcludePaths = append(options.ExcludePaths, dir)
	}
	// Caller exclusions are ADDITIVE to the agent's built-ins: a policy may
	// widen the skip set, never narrow it. /proc, /sys and the Defender
	// quarantine stay excluded whatever the policy says.
	options.ExcludePaths = append(options.ExcludePaths, s.Exclusions...)

	scanCtx := ctx
	var cancel context.CancelFunc = func() {}
	if s.Timeout > 0 {
		scanCtx, cancel = context.WithTimeout(ctx, s.Timeout)
	}
	defer cancel()

	started := time.Now()
	threats, filesScanned, scanErr := detectThreatsCtx(scanCtx, targets, options)
	timedOut := errors.Is(scanErr, context.DeadlineExceeded) || errors.Is(scanErr, context.Canceled)
	if timedOut {
		scanErr = nil // a deadline is an outcome, reported through TimedOut
	}
	// ... quarantine loop goes here in Task 8 ...
	status, statusErr := CollectStatus(s.Config)
	// ... existing ThreatCount / LastScanAt / LastScanType assignment ...

	return ScanOutcome{
		Threats:      threats,
		Status:       status,
		Duration:     time.Since(started),
		FilesScanned: filesScanned,
		TimedOut:     timedOut,
		Partial:      timedOut,
	}, errors.Join(scanErr, statusErr)
}
```

Reimplement `QuickScan`/`FullScan`/`CustomScan` as one-line wrappers over `ScanWithContext` that project
`ScanOutcome` into the existing `ScanResult`, so nothing outside this package changes shape.

- [ ] **Step 5: Read the payload in the handler**

In `agent/internal/heartbeat/handlers_security.go`, `handleSecurityScan` (`:39-84`):

```go
	exclusions := tools.GetPayloadStringSlice(cmd.Payload, "exclusions")
	maxFileSizeMb := tools.GetPayloadInt(cmd.Payload, "maxFileSizeMb", 0)
	timeoutMinutes := tools.GetPayloadInt(cmd.Payload, "timeoutMinutes", 0)
	autoQuarantine := tools.GetPayloadBool(cmd.Payload, "autoQuarantine", false)

	scanner := *h.securityScanner // shallow copy: per-scan settings never mutate the shared scanner
	scanner.Exclusions = exclusions
	scanner.AutoQuarantine = autoQuarantine
	if maxFileSizeMb > 0 {
		scanner.MaxFileSize = int64(maxFileSizeMb) << 20
	}
	if timeoutMinutes > 0 {
		scanner.Timeout = time.Duration(timeoutMinutes) * time.Minute
	}

	outcome, err := scanner.ScanWithContext(context.Background(), scanType, paths)
```

If `tools.GetPayloadInt` does not exist beside `GetPayloadString`/`GetPayloadBool`/`GetPayloadStringSlice`
(`agent/internal/remote/tools/types.go:675-810`), add it there in the same shape and unit-test it in
`types_test.go` — JSON numbers arrive as `float64`, so it must accept `float64`, `int` and a numeric
`string`.

Extend the result map (`:76-83`) with, and only with:

```go
		"filesScanned": outcome.FilesScanned,
		"timedOut":     outcome.TimedOut,
		"partial":      outcome.Partial,
```

Keep `triggerDefender` behaviour and the `scanType == "custom"` skip exactly as they are.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd agent && go test -race ./internal/security/... ./internal/heartbeat/... ./internal/remote/tools/...`
Expected: PASS. Then `cd agent && go vet ./internal/security/... ./internal/heartbeat/...`

- [ ] **Step 7: Commit**

```bash
git add agent/internal/security/threats.go agent/internal/security/threats_test.go \
        agent/internal/security/scanner.go agent/internal/security/scanner_test.go \
        agent/internal/heartbeat/handlers_security.go agent/internal/heartbeat/handlers_security_test.go \
        agent/internal/remote/tools/types.go agent/internal/remote/tools/types_test.go
git commit -m "feat(agent): honour policy exclusions, size cap and scan deadline (#6264)"
```

---

### Task 8: Agent — neutralizing quarantine (`.bqz` + manifest) and exact restore

**Files:**
- Create: `agent/internal/security/quarantine.go`
- Create: `agent/internal/security/quarantine_test.go`
- Modify: `agent/internal/security/threats.go:256-293` (`QuarantineThreat`, `RemoveThreat` stays as is)
- Modify: `agent/internal/security/scanner.go` (the auto-quarantine loop inside `ScanWithContext`)
- Modify: `agent/internal/heartbeat/handlers_security.go:159-196` (`handleSecurityThreatRestore`)
- Read first (do not modify): `agent/internal/obfuscate/obfuscate.go` (`Key = 0x5A` at `:39`,
  `DecodeBytes` at `:43` — XOR is its own inverse, so the same function encodes) and
  `agent/internal/remote/tools/fileops.go:348` (`EnforcePathContainment(verb, cleanPath string) error`)

**Interfaces:**
- Produces, in `agent/internal/security/quarantine.go`:
  ```go
  const (
      quarantinePayloadExt  = ".bqz"
      quarantineManifestExt = ".bqz.json"
      quarantineManifestVersion = 1
  )
  type QuarantineManifest struct {
      V             int    `json:"v"`
      OriginalPath  string `json:"originalPath"`
      SHA256        string `json:"sha256"`
      Name          string `json:"name"`
      Type          string `json:"type"`
      Severity      string `json:"severity"`
      QuarantinedAt string `json:"quarantinedAt"`
  }
  func RestoreQuarantined(quarantinedPath, originalPath string) (string, error)
  ```
- `QuarantineThreat(threat Threat, quarantineDir string) (string, error)` keeps its exact signature
  (called from `handlers_security.go:112`) but changes behaviour.

- [ ] **Step 1: Write the failing tests**

Create `agent/internal/security/quarantine_test.go`:

```go
package security

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestQuarantineNeutralizesTheFileOnDisk(t *testing.T) {
	root := t.TempDir()
	victim := filepath.Join(root, "sample.bin")
	// A byte pattern with no meaning to any AV: the point is that the bytes on
	// disk after quarantine are NOT these bytes.
	original := []byte{0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77}
	if err := os.WriteFile(victim, original, 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}

	qdir := filepath.Join(root, "quarantine")
	dest, err := QuarantineThreat(Threat{Name: "T", Type: "malware", Severity: "high", Path: victim}, qdir)
	if err != nil {
		t.Fatalf("QuarantineThreat: %v", err)
	}
	if !strings.HasSuffix(dest, ".bqz") {
		t.Fatalf("dest = %q, want a .bqz payload", dest)
	}
	if _, err := os.Stat(victim); !os.IsNotExist(err) {
		t.Fatalf("original still on disk: %v", err)
	}

	stored, err := os.ReadFile(dest)
	if err != nil {
		t.Fatalf("read payload: %v", err)
	}
	if string(stored) == string(original) {
		t.Fatal("quarantined bytes are identical to the original — not neutralized")
	}
	for i := range original {
		if stored[i] != original[i]^0x5A {
			t.Fatalf("byte %d = %#x, want %#x", i, stored[i], original[i]^0x5A)
		}
	}
}

func TestQuarantineWritesAManifestWithTheOriginalDigest(t *testing.T) {
	root := t.TempDir()
	victim := filepath.Join(root, "sample.bin")
	original := []byte("hello quarantine")
	if err := os.WriteFile(victim, original, 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}
	dest, err := QuarantineThreat(Threat{Name: "T", Path: victim}, filepath.Join(root, "q"))
	if err != nil {
		t.Fatalf("QuarantineThreat: %v", err)
	}

	raw, err := os.ReadFile(dest + ".json")
	if err != nil {
		t.Fatalf("read manifest: %v", err)
	}
	var m QuarantineManifest
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Fatalf("unmarshal manifest: %v", err)
	}
	sum := sha256.Sum256(original)
	if m.SHA256 != hex.EncodeToString(sum[:]) {
		t.Fatalf("manifest sha256 = %q, want the ORIGINAL digest", m.SHA256)
	}
	if m.OriginalPath != victim || m.V != 1 {
		t.Fatalf("manifest = %+v", m)
	}
}

func TestRestoreRoundTripsTheOriginalBytes(t *testing.T) {
	root := t.TempDir()
	victim := filepath.Join(root, "sample.bin")
	original := []byte("round trip me exactly")
	if err := os.WriteFile(victim, original, 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}
	dest, err := QuarantineThreat(Threat{Name: "T", Path: victim}, filepath.Join(root, "q"))
	if err != nil {
		t.Fatalf("QuarantineThreat: %v", err)
	}

	restored, err := RestoreQuarantined(dest, "")
	if err != nil {
		t.Fatalf("RestoreQuarantined: %v", err)
	}
	if restored != victim {
		t.Fatalf("restored to %q, want the manifest's originalPath %q", restored, victim)
	}
	got, err := os.ReadFile(victim)
	if err != nil {
		t.Fatalf("read restored: %v", err)
	}
	if string(got) != string(original) {
		t.Fatalf("restored bytes = %q, want %q", got, original)
	}
	if _, err := os.Stat(dest + ".json"); !os.IsNotExist(err) {
		t.Fatal("manifest survived a successful restore")
	}
}

func TestRestoreFallsBackToPlainRenameForLegacyEntries(t *testing.T) {
	// A pre-W01 quarantine entry: a plain renamed file, no .bqz, no manifest.
	root := t.TempDir()
	legacy := filepath.Join(root, "q", "sample.bin-1750000000")
	if err := os.MkdirAll(filepath.Dir(legacy), 0o700); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(legacy, []byte("legacy bytes"), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}
	target := filepath.Join(root, "restored.bin")

	restored, err := RestoreQuarantined(legacy, target)
	if err != nil {
		t.Fatalf("RestoreQuarantined: %v", err)
	}
	got, err := os.ReadFile(restored)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if string(got) != "legacy bytes" {
		t.Fatalf("legacy restore corrupted the file: %q", got)
	}
}

func TestRestoreRefusesWithoutATarget(t *testing.T) {
	root := t.TempDir()
	legacy := filepath.Join(root, "orphan")
	if err := os.WriteFile(legacy, []byte("x"), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}
	if _, err := RestoreQuarantined(legacy, ""); err == nil {
		t.Fatal("expected an error: no manifest and no explicit originalPath")
	}
}
```

Append to `agent/internal/security/scanner_test.go`:

```go
func TestScanWithContextAutoQuarantinesWhenEnabled(t *testing.T) {
	// arrange: a temp dir holding one file matching the FILENAME signature
	// (use the deobf token helpers from threats_test.go — never a raw literal),
	// scanner with AutoQuarantine:true and QuarantineDir under t.TempDir().
	// assert: out.Threats[0].QuarantinedTo is non-empty, ends in .bqz, and the
	// original path no longer exists.
}

func TestScanWithContextLeavesThreatsInPlaceWhenDisabled(t *testing.T) {
	// same arrangement, AutoQuarantine:false
	// assert: QuarantinedTo == "" and the file is still on disk.
}
```

- [ ] **Step 2: Run them and watch them fail**

Run: `cd agent && go test -race ./internal/security/...`
Expected: FAIL — `undefined: QuarantineManifest`, `undefined: RestoreQuarantined`; the neutralization
test fails because today's `QuarantineThreat` is `os.Rename` (`threats.go:271`) and the bytes are
unchanged.

- [ ] **Step 3: Implement `quarantine.go`**

```go
package security

// Quarantine neutralizes: a quarantined file is XOR-0x5A encoded (the same
// trivial transform internal/obfuscate uses for the shipped signature table) and
// written as <name>-<unixnano>.bqz beside a .bqz.json manifest. A plain rename —
// what this replaced — leaves live malware on disk, which a second AV product
// rescans and re-alerts on forever, and which an EDR may then delete out from
// under us. XOR is not security: it is an AV-recognition break plus an exact,
// reversible transform. #6263 W01 / spec D6.

// encodeStream copies src -> dst XOR-ing every byte, in 64 KiB chunks so a
// multi-gigabyte file never lands in memory, hashing the ORIGINAL bytes as it
// goes.
func encodeStream(dst io.Writer, src io.Reader) (string, error) { /* sha256 of plaintext + XOR copy */ }

func RestoreQuarantined(quarantinedPath, originalPath string) (string, error) {
	// 1. filepath.Clean both; tools.EnforcePathContainment("restore", …) on the
	//    source and ("write", …) on the resolved target — same guard the current
	//    handler applies at handlers_security.go:178,:181.
	// 2. If <quarantinedPath>.json parses as a QuarantineManifest, the target is
	//    its OriginalPath unless the caller passed an explicit originalPath.
	//    Decode (XOR again), verify the sha256 matches the manifest, MkdirAll the
	//    parent, write, then remove the payload and the manifest.
	// 3. No manifest (a pre-W01 plain-rename entry): require a non-empty
	//    originalPath and os.Rename, with the copy+remove fallback for a
	//    cross-device move. Never guess a destination.
}
```

Rules the implementation must obey, each of which a test above pins:
- The manifest's `sha256` is of the **original plaintext**, computed while encoding — never of the
  encoded payload.
- A digest mismatch on restore is an error and leaves both files in place.
- Write the payload first, then the manifest; remove the manifest first, then the payload. A crash
  leaves a decodable payload, never a manifest pointing at nothing.
- File modes `0o700` for the quarantine directory (as today, `threats.go:264`) and `0o600` for both files.

- [ ] **Step 4: Rewrite `QuarantineThreat` and wire auto-quarantine**

`QuarantineThreat` keeps its signature and its `EnforcePathContainment` call sites, and changes from
`os.Rename` to: open source → create `<base>-<unixnano>.bqz` → `encodeStream` → write manifest →
`os.Remove(threat.Path)`. The copy+remove fallback disappears because the encode is already a copy.
On any error after the payload is created, remove the partial payload before returning.

In `ScanWithContext`, after the walk and before `CollectStatus`:

```go
	if s.AutoQuarantine && len(threats) > 0 {
		dir := s.quarantineDir()
		for i := range threats {
			dest, qErr := QuarantineThreat(threats[i], dir)
			if qErr != nil {
				// A file we could not quarantine is still a real detection: report
				// it undecorated rather than dropping it or failing the scan.
				continue
			}
			threats[i].QuarantinedTo = dest
		}
	}
```

Add `QuarantinedTo string \`json:"quarantinedTo,omitempty"\`` to `Threat` (`threats.go:20-25`).

In `handleSecurityThreatRestore` (`handlers_security.go:159-196`), replace the inline
`os.MkdirAll`/`os.Rename` with a call to `security.RestoreQuarantined(quarantinedPath, originalPath)`,
keeping the existing payload keys and the `status: "restored"` result key.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd agent && go test -race ./internal/security/... ./internal/heartbeat/...`
Expected: PASS, 8+ new tests.

Then prove the shipped-binary guard still passes — this task adds byte-level malware handling near the
code that guard watches:
Run: `bash scripts/security/check-agent-binary-signatures.sh`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add agent/internal/security/quarantine.go agent/internal/security/quarantine_test.go \
        agent/internal/security/threats.go agent/internal/security/scanner.go \
        agent/internal/security/scanner_test.go agent/internal/heartbeat/handlers_security.go
git commit -m "feat(agent): neutralizing quarantine with manifest and exact restore (#6264)"
```

---

### Task 9: Security tab — only controls that have an engine

**Files:**
- Modify: `apps/web/src/components/configurationPolicies/featureTabs/SecurityTab.tsx`
- Modify: `apps/web/src/components/configurationPolicies/featureTabs/SecurityTab.test.tsx`
- Modify: `apps/web/src/locales/*/security.json` (8 files — remove the five dead toggles' strings,
  add strings for scan type, size cap and timeout)
- Read first (do not modify): `apps/web/src/components/configurationPolicies/featureTabs/types.ts:38-57`
  (`FeatureTabProps`) and `:68` (`FEATURE_META.security`), `featureTabs/useFeatureLink.ts`,
  `featureTabs/legacyTabs.freeze.test.tsx` (confirm `SecurityTab` is **not** frozen before editing)

**Interfaces:**
- Consumes `SecurityScanSettings`, `SECURITY_SCAN_SETTINGS_DEFAULTS`, `parseSecurityScanSettings`,
  the four option-list consts, and the two range consts from `@breeze/shared` (Task 1).
- Produces no new export. `save(...)` payload becomes
  `{ featureType: 'security', featurePolicyId: null, inlineSettings: <SecurityScanSettings> }` — the same
  call shape as today (`SecurityTab.tsx:158-166`), with a narrower object.

- [ ] **Step 1: Write the failing test**

Append to `SecurityTab.test.tsx` (its harness mocks `./useFeatureLink`, not fetch — keep that):

```tsx
it('saves only the SecurityScanSettings keys', async () => {
  render(<SecurityTab {...baseProps} />);
  fireEvent.click(screen.getByRole('button', { name: /save/i }));
  await waitFor(() => expect(saveMock).toHaveBeenCalled());

  const inlineSettings = saveMock.mock.calls.at(-1)![1].inlineSettings;
  expect(Object.keys(inlineSettings).sort()).toEqual([
    'autoQuarantine', 'exclusions', 'maxFileSizeMb', 'scanDayOfMonth', 'scanDayOfWeek',
    'scanHour', 'scanMinute', 'scanTimeoutMinutes', 'scanType', 'scheduledScans',
  ]);
});

it('renders no control for the five removed toggles', () => {
  render(<SecurityTab {...baseProps} />);
  // Asserted on the visible labels, not on testids: the ToggleRows being
  // deleted carry no data-testid today, so a testid assertion would pass
  // vacuously both before and after the change.
  for (const label of [
    'Real-time protection', 'Behavioral monitoring', 'Cloud lookup',
    'Block untrusted USB devices', 'Notify user',
  ]) {
    expect(screen.queryByText(label)).toBeNull();
  }
});

it('drops values an older policy saved for the removed toggles', async () => {
  render(<SecurityTab {...baseProps} existingLink={{
    id: 'link-1', featureType: 'security', featurePolicyId: null,
    inlineSettings: { realTimeProtection: true, blockUntrustedUsb: true, autoQuarantine: false },
  } as never} />);
  fireEvent.click(screen.getByRole('button', { name: /save/i }));
  await waitFor(() => expect(saveMock).toHaveBeenCalled());

  const inlineSettings = saveMock.mock.calls.at(-1)![1].inlineSettings;
  expect(inlineSettings).not.toHaveProperty('realTimeProtection');
  expect(inlineSettings).not.toHaveProperty('blockUntrustedUsb');
  expect(inlineSettings.autoQuarantine).toBe(false); // a kept value survives
});

it('offers scan type, size cap and timeout', () => {
  render(<SecurityTab {...baseProps} />);
  expect(screen.getByTestId('security-scan-type')).toBeTruthy();
  expect(screen.getByTestId('security-max-file-size-mb')).toBeTruthy();
  expect(screen.getByTestId('security-scan-timeout-minutes')).toBeTruthy();
});
```

**The four tests already in this file must be rewritten, not left alone.** `SecurityTab.test.tsx:47`
and `:57-70` both use `blockUntrustedUsb` as their "distinctive override" for the inheritance
assertions (`parentLinkWith({ blockUntrustedUsb: true })`, then reading the toggle's
`bg-emerald-500/80` class). That toggle is being deleted, so those tests would assert on a control
that no longer exists. Re-point them at a surviving distinctive field — `autoQuarantine: false`
against a default of `true` — keeping the same inheritance behaviour under test. Deleting them
instead would remove the only coverage of #5080's inherited-parent seeding.

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/web && npx vitest run src/components/configurationPolicies/featureTabs/SecurityTab.test.tsx`
Expected: FAIL — the saved object still contains `realTimeProtection` and the three new controls are absent.

- [ ] **Step 3: Rewrite the tab's state on the shared contract**

- Delete the local `SecuritySettings` type and `defaults` (`:9-36`) and the local `minuteOptions` /
  `hourOptions` / `dayOfMonthOptions` (`:66-68`); import them all from `@breeze/shared`.
- Seed state with `parseSecurityScanSettings(existingLink?.inlineSettings ?? parentLink?.inlineSettings)`
  — the parse is what drops legacy keys, so there is no migration step and no data rewrite
  (spec D4: values already saved are ignored, not migrated).
- Delete the four `ToggleRow`s at `:211-240` and `:268-277` and the `notifyUser` row at `:258-267`.
- Keep `scheduledScans` (`:289-297`), the four cron selects (`:308-364`), `autoQuarantine` (`:248-257`)
  and the exclusions list (`:147-157`, `:411-425`) exactly as they render today.
- Add three controls with the `data-testid`s the test pins: `security-scan-type`
  (`quick` / `full` select), `security-max-file-size-mb` and `security-scan-timeout-minutes`
  (number inputs clamped to the shared ranges, clamped again on change, not only on save).
- Add a one-line description under the schedule explaining what the policy now does, e.g.
  `"Breeze dispatches this scan from the server — the device does not need a local schedule."` — new
  i18n key, all 8 locales.
- The tab must **not** claim protection it does not provide (spec §11): no string anywhere in it may
  contain "EDR", "antivirus", "real-time" or "prevention".

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd apps/web && npx vitest run src/components/configurationPolicies/featureTabs/SecurityTab.test.tsx
cd apps/web && npx vitest run src/components/configurationPolicies/featureTabs/featureTypeParity.test.ts \
                              src/components/configurationPolicies/featureTabs/legacyTabs.freeze.test.tsx
cd apps/web && npx vitest run src/lib/i18n
```
Expected: all PASS. The i18n run covers `localeParity` / `translationCoverage` / `extractionQuality`.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/configurationPolicies/featureTabs/SecurityTab.tsx \
        apps/web/src/components/configurationPolicies/featureTabs/SecurityTab.test.tsx \
        apps/web/src/locales
git commit -m "feat(web): Security tab shows only scan controls with an engine (#6264)"
```

---

### Task 10: The `/security/scans` page

**Files:**
- Create: `apps/web/src/pages/security/scans.astro`
- Create: `apps/web/src/components/security/SecurityScansPage.tsx`
- Create: `apps/web/src/components/security/SecurityScansPage.test.tsx`
- Modify: `apps/web/src/components/security/index.ts` (one export)
- Modify: `apps/web/src/components/layout/Sidebar.tsx` (one nav entry inside the `security` section's
  `items` array, `:287-299`)
- Modify: `apps/web/src/locales/*/pages.json` (`titles.securityScans`) and
  `apps/web/src/locales/*/common.json` (`nav.securityScans`) — 8 directories each
- Read first (do not modify): `apps/web/src/pages/security/edr.astro` and
  `apps/web/src/pages/security/vulnerabilities.astro` (the exact page template),
  `apps/web/src/components/layout/Sidebar.tsx:154` (`NavItem`) and `:288` (an entry),
  `apps/web/src/components/security/SecurityPageHeader.tsx`

**Interfaces:**
- Produces `export default function SecurityScansPage()` — no props — mounting
  `SecurityScanManager` and `ThreatList`, with tab state in `window.location.hash`.
- Consumes nothing new from earlier tasks; this task is independently shippable.

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/components/security/SecurityScansPage.test.tsx` — model the mock harness on
`apps/web/src/components/security/securitySmoke.test.tsx:9-21` (it mocks `@/stores/auth` wholesale and
uses a `makeJsonResponse` helper):

```tsx
describe('SecurityScansPage', () => {
  it('shows the Scans tab by default', async () => {
    window.location.hash = '';
    render(<SecurityScansPage />);
    expect(await screen.findByTestId('security-scans-tab-scans')).toBeTruthy();
    expect(screen.getByTestId('security-scan-manager')).toBeTruthy();
  });

  it('opens the Threats tab from the hash', async () => {
    window.location.hash = '#threats';
    render(<SecurityScansPage />);
    expect(await screen.findByTestId('security-threat-list')).toBeTruthy();
  });

  it('writes the hash when the tab changes, and never a query param', async () => {
    window.location.hash = '';
    render(<SecurityScansPage />);
    fireEvent.click(screen.getByTestId('security-scans-tab-threats'));
    await waitFor(() => expect(window.location.hash).toBe('#threats'));
    expect(window.location.search).toBe('');
  });

  it('uses no prohibited positioning language', () => {
    render(<SecurityScansPage />);
    const text = document.body.textContent ?? '';
    for (const banned of ['EDR', 'antivirus', 'Antivirus', 'real-time', 'Real-time', 'prevention']) {
      expect(text).not.toContain(banned);
    }
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/web && npx vitest run src/components/security/SecurityScansPage.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Build the island**

`SecurityScansPage.tsx`: a `SecurityPageHeader`, two tab buttons
(`data-testid="security-scans-tab-scans"` / `…-threats`), `SecurityScanManager` in the first,
`ThreatList` in the second. Hash handling per CLAUDE.md's URL-state rule — `window.location.hash`,
never a query param — initialised from `window.location.hash` on mount and kept in sync with a
`hashchange` listener. Wrap the two testids the test pins (`security-scan-manager`,
`security-threat-list`) around the mounted children if the components do not already expose them.

Copy required (spec §11): the page is titled **"IOC scans"** with a one-line subtitle such as
*"Signature-based malware and IOC sweeps across your fleet. Breeze is not an antivirus or EDR product."* —
the subtitle is the one place the word "antivirus" may appear, as a **disclaimer**. If that trips the
banned-word test above, keep the disclaimer and narrow the test's list to the affirmative uses; do not
delete the disclaimer.

- [ ] **Step 4: Add the page, the export and the nav entry**

`apps/web/src/pages/security/scans.astro`:

```astro
---
import DashboardLayout from '../../layouts/DashboardLayout.astro';
import SecurityScansPage from '../../components/security/SecurityScansPage';
import Breadcrumbs from '../../components/layout/Breadcrumbs';
---

<DashboardLayout titleKey="titles.securityScans">
  <Breadcrumbs client:load items={[{ label: 'Security', href: '/security' }, { label: 'IOC Scans' }]} />
  <SecurityScansPage client:load />
</DashboardLayout>
```

`apps/web/src/components/security/index.ts` — add the alphabetically-correct export line.

`Sidebar.tsx`, inside the `security` section's `items` array, directly after the Overview entry:

```ts
      { name: 'IOC Scans', labelKey: 'nav.securityScans', href: '/security/scans', icon: ScanSearch, requiredPermission: { resource: 'devices', action: 'read' } },
```

`ScanSearch` is already imported in this file (it is the Sensitive Data icon at `:295`) — verify with
`grep -n 'ScanSearch' apps/web/src/components/layout/Sidebar.tsx` before adding an import.

Add `"securityScans": "IOC Scans"` under `titles` in `apps/web/src/locales/<lang>/pages.json` and
`"securityScans": "IOC Scans"` under `nav` in `apps/web/src/locales/<lang>/common.json`, **for all
8 locale directories** (translated where the rest of the file is translated).

- [ ] **Step 5: Run the tests to verify they pass**

```bash
cd apps/web && npx vitest run src/components/security/SecurityScansPage.test.tsx
cd apps/web && npx vitest run src/components/layout/Sidebar.nav.test.tsx
cd apps/web && npx vitest run src/lib/i18n
cd apps/web && npx vitest run src/lib/__tests__/settingsPageRegistry.test.ts
```
Expected: all PASS. `settingsPageRegistry` walks only `pages/settings` and should be unaffected — run it
to prove that, rather than assuming.

- [ ] **Step 6: Build the web app**

Run: `cd apps/web && npx astro check`
Expected: 0 errors. An unresolved `titleKey` or a bad import surfaces here, not in vitest.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/pages/security/scans.astro \
        apps/web/src/components/security/SecurityScansPage.tsx \
        apps/web/src/components/security/SecurityScansPage.test.tsx \
        apps/web/src/components/security/index.ts \
        apps/web/src/components/layout/Sidebar.tsx apps/web/src/locales
git commit -m "feat(web): mount the IOC scans page and add it to the Security nav (#6264)"
```

---

### Task 11: Route the newly-reachable mutations through `runAction`

**Files:**
- Modify: `apps/web/src/components/security/SecurityScanManager.tsx:215-231` (the POST)
- Modify: `apps/web/src/components/security/ThreatList.tsx:142` (the bulk quarantine/remove)
- Modify: `apps/web/src/components/security/ThreatDetail.tsx:106-114` (the local function named
  `runAction` — **rename it**; it is NOT the library one)
- Modify: `apps/web/src/lib/__tests__/no-silent-mutations.test.ts` (three `TARGET_GLOBS` entries)
- Modify: `apps/web/src/components/security/ThreatList.test.tsx`
- Read first (do not modify): `apps/web/src/lib/runAction.ts:6-21` (`ActionError`), `:23-78`
  (`RunActionOptions`), `:79` (`runAction`), and
  `apps/web/src/components/security/S1ThreatList.tsx` (a sibling in this directory that is already in
  the adopted set — copy its call shape)

**Interfaces:** no new exports. Behaviour change only: every mutation toasts on success and failure.

- [ ] **Step 1: Write the failing test**

Append to `ThreatList.test.tsx`:

```tsx
it('toasts when a quarantine action fails', async () => {
  fetchWithAuthMock.mockResolvedValueOnce(makeJsonResponse({ data: [threatFixture] }));
  fetchWithAuthMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'device offline' }), { status: 409 }));

  render(<ThreatList />);
  fireEvent.click(await screen.findByTestId('threat-row-select-t1'));
  fireEvent.click(screen.getByTestId('threat-bulk-quarantine'));

  await waitFor(() => expect(showToastMock).toHaveBeenCalledWith(
    expect.objectContaining({ type: 'error' }),
  ));
});

it('toasts on success', async () => {
  // both responses ok
  await waitFor(() => expect(showToastMock).toHaveBeenCalledWith(
    expect.objectContaining({ type: 'success' }),
  ));
});
```

And add the three paths to `TARGET_GLOBS` in `no-silent-mutations.test.ts` (near `:197`, beside
`'src/components/security/S1ThreatList.tsx'`):

```ts
  // #6263 W01: these three were built but mounted on no page. /security/scans
  // makes them reachable, so their mutations join the adopted set.
  'src/components/security/SecurityScanManager.tsx',
  'src/components/security/ThreatList.tsx',
  'src/components/security/ThreatDetail.tsx',
```

- [ ] **Step 2: Run both and watch them fail**

```bash
cd apps/web && npx vitest run src/components/security/ThreatList.test.tsx
cd apps/web && npx vitest run src/lib/__tests__/no-silent-mutations.test.ts
```
Expected: the first FAILs (no toast), the second FAILs naming the three files' bare mutations.

- [ ] **Step 3: Convert the three mutation sites**

In each, wrap the mutating `fetchWithAuth` in `runAction` and keep the existing load-error handling
(`throwIfNotOk` / `errorKind` / `<AccessDenied>`) for the **GET** paths — `runAction` is for mutations
only. The catch shape is the documented one:

```ts
try {
  await runAction({
    request: () => fetchWithAuth(`/security/threats/${id}/${action}`, { method: 'POST' }),
    errorFallback: t('securityThreatList.actionFailed'),
    successMessage: t('securityThreatList.actionQueued'),
  });
} catch (err) {
  if (err instanceof ActionError && err.status === 401) return; // let the auth redirect handle it
  if (!(err instanceof ActionError)) showToast({ type: 'error', message: String(err) });
}
```

`ThreatList`'s bulk action is a `Promise.all` over selected ids: either wrap each element and use a
`// runaction-exempt:` marker on the aggregate with inline per-row error UI, or — preferred — run them
sequentially through `runAction` and toast once with the aggregate count. Pick one and say which in the
PR description; the guard accepts either, the user-visible outcome is what matters.

In `ThreatDetail.tsx`, **rename the local `runAction` (`:106`) to `performThreatAction`** before
importing the library function, or the import shadows a name already in use and the guard's AST walk
sees a call to something that is not `runAction`.

New i18n keys for every toast string, all 8 locales.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd apps/web && npx vitest run src/components/security/ThreatList.test.tsx \
                              src/components/security/securitySmoke.test.tsx \
                              src/components/security/security403Sweep.test.tsx
cd apps/web && npx vitest run src/lib/__tests__/no-silent-mutations.test.ts
cd apps/web && npx vitest run src/lib/i18n
```
Expected: all PASS. `security403Sweep.test.tsx` already enumerates all three components
(`:64-81`) — its 403 assertions must still hold, which is why it is in this run.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/security/SecurityScanManager.tsx \
        apps/web/src/components/security/ThreatList.tsx \
        apps/web/src/components/security/ThreatList.test.tsx \
        apps/web/src/components/security/ThreatDetail.tsx \
        apps/web/src/lib/__tests__/no-silent-mutations.test.ts apps/web/src/locales
git commit -m "feat(web): surface every IOC scan and threat mutation through runAction (#6264)"
```

---

### Task 12: Whole-wave verification sweep and hand-off

**Files:**
- Modify: none by default. Any fix this task finds is committed with the task it belongs to.

- [ ] **Step 1: Sweep every reader of the things this wave changed**

The repo's own lesson is that features get missed through a second, hidden reader. Run each of these and
account for **every** hit — a hit outside this wave's file list is either already correct or a defect
to fix now:

```bash
grep -rn "CommandTypes.SECURITY_SCAN\|'security_scan'\|\"security_scan\"" apps/api/src agent --include=*.ts --include=*.go
grep -rn "securityScans" apps/api/src | grep -v "db/schema"
grep -rn "featureType: 'security'\|'security'" apps/api/src/services/configurationPolicy.ts
grep -rn "realTimeProtection\|behavioralMonitoring\|cloudLookup\|blockUntrustedUsb\|notifyUser" apps/web/src apps/api/src
grep -rn "QuarantineThreat\|RestoreQuarantined\|quarantine" agent/internal --include=*.go
```

Known and expected: `security_status.real_time_protection` (a *reported* AV fact from Windows Security
Center, `apps/api/src/routes/agents/helpers.ts:507`) and `routes/security/policies.ts`'s
`realTimeProtection` setting (the legacy unmounted editor, DECISION 1) both survive — they are not the
tab's dead toggle. Anything else still writing the five removed keys is a defect.

- [ ] **Step 2: Run the full affected test matrix**

```bash
cd apps/api && npx vitest run src/jobs/securityScanJobs src/routes/security src/routes/agents/helpers \
                              src/services/featureConfigResolver src/jobs/workerReadiness
cd apps/web && npx vitest run src/components/security src/components/configurationPolicies/featureTabs \
                              src/lib/__tests__/no-silent-mutations.test.ts src/lib/i18n
cd packages/shared && npx vitest run src/utils/securityScanSettings.test.ts
cd agent && go test -race ./internal/security/... ./internal/heartbeat/... ./internal/remote/tools/...
cd apps/web && npx astro check
```
Check the reported **file count** on each vitest line — a substring filter that matched zero files
reads as a pass.

- [ ] **Step 3: Confirm the no-migration claim mechanically**

```bash
git diff --stat origin/main...HEAD -- apps/api/migrations
git diff --stat origin/main...HEAD -- apps/api/src/db/schema
```
Expected: both empty. If either is non-empty, the wave has drifted into W03 — stop and escalate.

- [ ] **Step 4: Integration suites — only if step 3 was not empty**

This wave adds no table, so `rls-coverage`, `tenantCascade`, `tenant-export-policy` and
`orgLifecycleFoundations` cannot be affected and do not need a local stack. If step 3 surprised you,
stand one up and run them before doing anything else:
`pnpm test-stack up`, then
`cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/rls-coverage`,
and `pnpm test-stack down` when finished — nothing reaps it for you.

- [ ] **Step 5: File the deferred follow-ups**

Open one issue each, linked to #6263:
1. **"Security tab: notify user on threat detection"** — DECISION 3's deferral. Needs a service→user-helper
   notification command; `agent/internal/userhelper/notify.go:18` exists but has no service-side caller.
2. **"Scheduled security scans have no execution-authority fingerprint"** — `sensitive_data_policies`
   carries `execution_authority_*` columns and `authorityAdmitsDevice`
   (`apps/api/src/jobs/sensitiveDataJobs.ts:400-420`) so a revoked tech's policy stops firing. Config
   policies have no equivalent, and adding one needs columns, i.e. a migration. W01 dispatches scheduled
   scans with `initiated_by = NULL` (system) instead. Worth closing before IOC sweeps go fleet-wide in W05.
3. **"Legacy `security_policies` / SecurityPolicyEditor are unreachable"** — decide in W04 whether to
   delete them or wire them up; leaving a second, invisible home for the same concept contradicts the
   settings rule even while nothing can reach it.

- [ ] **Step 6: Open the PR**

Body must state, per the settings rule's point 9: the concept (**IOC scan configuration**), its home
(**Config Policies → Security tab**), its level (**partner default → org override via the config-policy
hierarchy; closest assignment wins**), its resolver (**`resolveSecurityScanSettingsForDevice`, the single
reader**), and the count of places it is configured **before: 2 (Security tab + the unmounted
`/security/policies` editor) → after: 1**. Include `Closes #6264`.

---

## Self-review

**Spec coverage (W01 row of §12, plus the §6/§7/§8 bullets it names):**

| Spec requirement | Task |
|---|---|
| `securityScanJobs.ts` scheduler (D5, clone of `sensitiveDataJobs.ts`) | 3, 4 |
| Partner-wide fan-out by the device's org (§Partner-Wide First step 5) | 2, 4 |
| Exclusions shipped to the agent (§6) | 1, 3, 5, 7 |
| `maxFileSizeMb` / `timeoutMinutes` shipped and honoured (§6) | 1, 5, 7 |
| `autoQuarantine` shipped and honoured, per-policy (§6, D7's default-off is W03's rule-set concern) | 1, 7, 8 |
| Partial results with a timeout signal (§6) | 6, 7 |
| Security tab per D4, minus the rule-set picker (W04) | 9 |
| Scans page mounting the existing components (§8) | 10 |
| D6 neutralized quarantine + restore | 8 |
| Legacy signatures remain the matcher | 7 (explicit comment in `detectThreatsCtx`) |
| Positioning copy rules (§11) | 9, 10 (banned-word tests) |
| `POST /security/scan/:deviceId` resolves the effective policy (§7) | 5 |

Deliberately **not** in W01, each named in the spec as a later wave: the YARA-X engine and bytecode
delivery (W02), rule-set tables/RLS/registration/`breeze-yarac`/the built-in pack/`provider='breeze'`
(W03), the Detection rules UI, IOC import, the rule-set picker and the ThreatDetail rule panel (W04),
fleet sweep, AI tool actions, audit events and the docs pass (W05).

**Placeholders:** none. Every code step carries the code. Four places carry a `// arrange:` comment
inside a test rather than a fixture: those are the Drizzle-mock arrangements in Tasks 2, 3, 4 and the
Go heartbeat harness in Task 7, and each names the sibling file whose harness must be copied verbatim —
inventing a fresh mock shape there is how these tests go vacuous.

**Type consistency:** `SecurityScanSettings` is spelled identically in Tasks 1, 2, 3, 5, 9;
`resolveSecurityScanSettingsForDevice` in 2, 3, 5; `buildSecurityScanPayload` in 3, 5;
`ScanOutcome` / `ScanWithContext` in 7, 8; `QuarantinedTo` (Go) ↔ `quarantinedTo` (JSON) ↔ the API's
`asString(threat.quarantinedTo)` in 6, 8; `timed_out` (DB value) ↔ `timedOut` (wire key) are
deliberately different spellings and are used consistently in 5, 6, 7.
