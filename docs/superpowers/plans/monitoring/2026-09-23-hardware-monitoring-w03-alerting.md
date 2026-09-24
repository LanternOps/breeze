# Hardware & RAID Monitoring — W03 Alerting Implementation Plan
> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Raise and independently recover hardware component alerts while running a monitor's device responses only once per open episode.
**Architecture:** W01 supplies component evidence and ingest-counted streaks; a new leaf handler supplies subject evidence to the existing compiled-monitor sweep. PostgreSQL enforces open-alert identity, Redis isolates noise controls by subject, and the episode's first alert owns responses. The editor and four unattached built-ins use the existing monitor compiler.
**Tech Stack:** TypeScript, Hono, Drizzle, PostgreSQL, Redis/BullMQ, Zod, React, react-hook-form, Vitest/jsdom.

**Spec:** `docs/superpowers/specs/monitoring/2026-09-23-hardware-raid-monitoring-design.md`.
**Index:** `docs/superpowers/plans/monitoring/2026-09-23-hardware-monitoring.md`.
**Wave:** W03, branch `feature/<parent#>-hardware-monitoring/wave-<sub#>`.
**Depends on:** W01 merged, including `hardwareHealth.ts`, `freshness.ts`, and the `retire.ts` no-op. W02a/W02b can proceed independently.

## Global Constraints

- Registrations per new `org_id` table (grep, do not judge): `CORE_ORG_CASCADE_DELETE_ORDER`
  (`services/tenantCascade.ts:230`, alphabetical, `organizations` last),
  `CORE_DEVICE_CASCADE_DELETE_TABLES` (`routes/devices/core.ts:514`),
  `CORE_DEVICE_ORG_DENORMALIZED_TABLES` (`routes/devices/core.ts:285`), `REPOINT_TABLES`
  (`services/orgMergeRegistry.ts:655`), `CORE_TENANT_EXPORT_POLICY`
  (`services/tenantExportPolicyRegistry.ts:41`, every column classified; every jsonb column
  `excludedOpen`). `alerts.subject_key` is a new column on a registered table → its export-policy
  entry gains `subject_key` under `included`.
- Any migration that writes rows elects system scope first (`migrationRlsScope.test.ts` baseline
  must not grow).
- Web: `fetchWithAuth` from `apps/web/src/stores/auth.ts`; no react-query; inline pill idiom
  (`bg-success/15 text-success border-success/30` etc.); `data-testid` on everything e2e touches;
  mutation handlers via `runAction` (only the config tab mutates).
- Files stay under ~500 lines; new code goes in new files next to the pattern it copies.
- Run the contract suites before every PR that touches tenancy:
  `DB_CONTEXTLESS_WRITE_STRICT=true pnpm --filter=@breeze/api test:rls-coverage`, the integration
  config (`vitest.integration.config.ts`) for cascade / export / merge, with `pnpm test-stack up`.

## Review Focus

3. A disk that flips `failed → online → failed` across three polls — no alert must fire at
   `consecutiveSnapshots = 2` and no recovery must resolve; W03 handler test. **Pinned by Task 4.**
4. Two physical disks failing in the same sweep on the same device — exactly one automation run,
   two notifications; W03 integration test. **Pinned by Tasks 8, 10, and 11.**

## File Structure

All anchors refer to the inspected base; resolve by symbol after preceding tasks move lines.

| Action | Path | Responsibility |
|---|---|---|
| Modify | `packages/shared/src/validators/monitors.ts:18,53` | Kind enum and hardware leaf schema |
| Modify | `packages/shared/src/validators/monitors.test.ts:15` | Existing exact enum expectation |
| Create | `packages/shared/src/validators/monitors.hardwareHealth.test.ts` | Hardware authoring boundaries/composite exclusion |
| Modify | `apps/api/src/services/alertConditions/types.ts:153,182,200` | Condition and subject contracts |
| Create | `apps/api/migrations/2026-10-27-100200-monitor-kind-hardware-health.sql` | Enum label only |
| Create | `apps/api/migrations/2026-10-27-100300-alert-subject-key.sql` | Subject identity; response admission columns; retirement outbox and RLS |
| Create | `apps/api/src/db/hardwareAlertMigrations.integration.test.ts` | Disposable PostgreSQL replay tests |
| Modify | `apps/api/vitest.integration.config.ts:13` | Discover new co-located database suites |
| Modify | `apps/api/vitest.config.ts:18` | Exclude those suites from unit runner |
| Modify | `apps/api/src/db/schema/monitorDefinitions.ts:33` | Append DB enum label |
| Modify | `apps/api/src/db/schema/alerts.ts:115,151` | Subject column and index/CHECK declarations |
| Modify | `apps/api/src/services/tenantExportPolicyRegistry.ts:130` | Classify subject/admission scalars and outbox JSON |
| Create | `apps/api/src/services/alertConditions/handlers/hardwareHealth.ts` | Fresh component evidence and per-rank streaks |
| Create | `apps/api/src/services/alertConditions/handlers/hardwareHealth.test.ts` | Matrix and flapping regression |
| Modify | `apps/api/src/services/alertConditions/index.ts:32,50,99,187,227` | Registration and root-leaf propagation |
| Create | `apps/api/src/services/alertConditions/subjects.test.ts` | Groups discard subjects |
| Modify | `apps/api/src/services/alertCooldown.ts:43,54,82,416,452` | Four optional subject-key helpers |
| Create | `apps/api/src/services/alertCooldown.subjects.test.ts` | Redis and fallback isolation |
| Modify | `apps/api/src/services/monitors/episodeService.ts:367`, `apps/api/src/services/monitors/episodeService.test.ts` | Atomic first-alert claim; observation-free allocation and final recurrence adoption |
| Modify | `apps/api/src/routes/alerts/alerts.ts:1083`, `apps/api/src/routes/mobile.ts:1249`, their `*.resolveCas.test.ts` suites | Manual-resolution subject cooldown keys |
| Modify | `apps/api/src/db/schema/monitorEpisodes.ts`, `apps/api/src/services/automationRuntime.ts` | Durable response admission/dispatch columns and deferred start event |
| Create | `apps/api/src/services/subjectResponseOutbox.ts` | Atomic episode admission plus commit-then-queue dispatch |
| Create | `apps/api/src/db/schema/hardwareAlertRetirementOutbox.ts`, `apps/api/src/services/hardwareHealth/retirementOutbox.ts` | Recovery outbox surviving device deletion |
| Modify | `apps/api/src/db/schema/index.ts`, `apps/api/src/services/tenantCascade.ts`, `apps/api/src/services/orgMergeRegistry.ts` | Retirement outbox export, org erasure and merge registrations |
| Create | `apps/api/src/services/monitors/episodeService.subjects.test.ts` | Claim winner/loser contract |
| Modify | `apps/api/src/services/alertService.ts:45,167,438,751,791,1095` | Subject identity, publication, resolution, sweep |
| Modify | `apps/api/src/services/alertService.test.ts:18,113` | Adapt existing rule insert mock to execute |
| Modify | `apps/api/src/services/alertService.episodes.test.ts:49,269` | Preserve legacy episode ordering with raw insert mock |
| Modify | `apps/api/src/services/alertService.networkCheck.test.ts:47,259` | Preserve network-check creation with raw insert mock |
| Create | `apps/api/src/services/alertService.subjects.test.ts` | Insert/publication/rollback regressions |
| Create | `apps/api/src/services/alertSubjects.ts` | Per-subject reconciliation and final observation |
| Create | `apps/api/src/services/alertSubjects.test.ts` | Recovery and observation matrix |
| Create | `apps/api/src/services/alertSubjects.integration.test.ts` | Real identity races, commit/outbox failure boundaries, response routing, tenancy |
| Create | `apps/api/src/services/subjectAlertOutbox.ts` | Claim committed pending alerts, publish, compensate failed publication |
| Modify | `apps/api/src/jobs/alertWorker.ts:122,170`, `apps/api/src/jobs/alertWorker.test.ts`, `apps/api/src/jobs/alertQueue.test.ts` | Drain committed subject outbox after device jobs and on the minute tick; prove both context boundaries |
| Modify | `apps/api/src/jobs/automationWorker.ts:576` | Skip non-owner compiled responses |
| Create | `apps/api/src/jobs/automationWorker.subjects.test.ts` | Owner guard through worker seam |
| Modify | `apps/api/src/services/hardwareHealth/retire.ts` | Fill W01 contract function body |
| Create | `apps/api/src/services/hardwareHealth/retire.test.ts` | Explicit retirement resolves only selected open subjects |
| Create | `apps/api/src/services/monitors/kinds/hardwareHealth.ts` | Hardware compiler specification |
| Create | `apps/api/src/services/monitors/kinds/hardwareHealth.test.ts` | Compilation, overrides and templates |
| Modify | `apps/api/src/services/monitors/kinds/index.ts:23,60` | Kind registration |
| Modify | `apps/api/src/services/monitors/kinds/index.test.ts:6,38` | Registry sample and count |
| Modify | `apps/api/src/routes/monitorDefinitions.test.ts:290,297` | Keep the public kinds catalog expectation current |
| Modify | `apps/api/src/services/monitors/builtInMonitors.ts:38,40,99` | Version 3 and four defaults |
| Modify | `apps/api/src/services/monitors/builtInMonitors.test.ts:12` | Version-aware defaults contract |
| Modify | `apps/api/src/__tests__/integration/builtInMonitors.integration.test.ts:113` | Real provisioning upgrade and preservation |
| Modify | `apps/web/src/components/monitoring/monitorKindFields.ts:10,47,254` | Multiselect metadata and default condition |
| Modify | `apps/web/src/components/monitoring/MonitorConditionFields.tsx:15,46,85` | Accessible checkbox group |
| Create | `apps/web/src/components/monitoring/MonitorConditionFields.hardwareHealth.test.tsx` | Form values, reset, validation and translated fields |
| Modify | `apps/web/src/components/monitoring/monitorKindFields.test.ts:125` | Include multiselect option translations |
| Modify | `apps/web/src/locales/{en,de-DE,es-419,fr-CA,fr-FR,it-IT,pt-BR,tr-TR}/monitoring.json` | Hardware labels and option text in every catalog |

Read-only precedents: `alertConditions/registry.ts:10` defines `evaluate(condition: unknown, deviceId: string): Promise<ConditionResult>`; `handlers/service.ts:7` and `handlers/threshold.ts:5` implement it. `monitors/kinds/types.ts:30` defines `MonitorKindSpec<C>`; `disk.ts:7` and `service.ts:9` show compilation. `monitorCompiler.ts:131` already emits a single root and honors `alertCategory`; `packages/shared/src/utils/alertTemplate.ts:35` already accepts arbitrary context keys. `alertWorker.ts:221` still selects online devices and `:463` still schedules the minute sweep; Task 10 adds outbox draining before that selection so offline devices also retry pending publication. `monitorEpisodes.ts:61` has no FK on `alertId`, making explicit failed-publish claim release necessary.

Decisions: `HardwareHealthComponentFilter` is defined here as `Exclude<HardwareComponentType, 'bmc'>` (index §F names it but does not declare it). `RETURNING id` yields `{ id: string }[]`; `createAlert` actually returns `Promise<string | null>` (`alertService.ts:167,296`), so no full-row mapping or hydration is required. `responsesOwner` is computed immediately after `linkEpisodeAlert`, before `alert.triggered` publication. The subject path opens/reuses an episode, atomically stores ownership and a pending publication in the alert context, and records the authoritative post-reconciliation observation under the rule/device lock. Task 10 publishes only after the outer transaction commits. Episode allocation is lazy, after a subject passes cooldown/flapping and wins insertion; allocation records no observation. Only the final observation activates recurrence, so an all-suppressed sweep leaves no episode or pause latch. UI keys remain literally `monitors.fields.hardware_health.*` inside the existing `monitoring` namespace; Task 15 supplies them in all eight catalogs and runs locale parity.

Each step below is a 2–5 minute edit/run unit; commands start at repository root unless a `cd` is shown. Do not execute commits while merely reviewing this document. Implementation commits use shell ANSI-C strings so the two newlines in the attribution are actual commit-message newlines.

### Task 1: Define the authoring and subject evidence contracts

**Files:** Modify `packages/shared/src/validators/monitors.ts:18,53`, `packages/shared/src/validators/monitors.test.ts:15`, `apps/api/src/services/alertConditions/types.ts:153,182,200`. Create/Test `packages/shared/src/validators/monitors.hardwareHealth.test.ts`.
**Interfaces:** Consumes W01 `HardwareComponentType` from `@breeze/shared`. Produces `HardwareHealthComponentFilter`, `HardwareHealthCondition`, `SubjectStatus`, `SubjectEvidence`, `ConditionResult.subjects`, `EvaluationResult.subjects`, and `monitorConditionSchemas.hardware_health`.

- [ ] **Step 1: Write the failing authoring test.**

```ts
import { describe, expect, it } from 'vitest';
import { MONITOR_KINDS, monitorConditionSchemas, compositeConditionSchema } from './monitors';
const base = { componentTypes: ['physical_disk'], minHealth: 'critical' };
describe('hardware health authoring', () => {
  it('is a root kind with defaults', () => {
    expect(MONITOR_KINDS).toContain('hardware_health');
    expect(monitorConditionSchemas.hardware_health.parse(base)).toEqual({
      ...base, includePredictiveFailure: true, consecutiveSnapshots: 2,
    });
  });
  it.each([
    { componentTypes: [] }, { componentTypes: ['bmc'] }, { componentTypes: ['disk'] },
    { minHealth: 'ok' }, { consecutiveSnapshots: 0 }, { consecutiveSnapshots: 11 },
    { consecutiveSnapshots: 1.5 }, { includePredictiveFailure: 'true' },
  ])('rejects %j', patch => {
    expect(monitorConditionSchemas.hardware_health.safeParse({ ...base, ...patch }).success).toBe(false);
  });
  it.each([1, 10])('accepts count boundary %i', consecutiveSnapshots => {
    expect(monitorConditionSchemas.hardware_health.safeParse({ ...base, consecutiveSnapshots }).success).toBe(true);
  });
  it('cannot be a composite child', () => {
    expect(compositeConditionSchema.safeParse({ match: 'all', children: [
      { kind: 'hardware_health', condition: base },
      { kind: 'cpu', condition: { operator: 'gt', value: 90 } },
    ] }).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run red.** `cd packages/shared && npx vitest run src/validators/monitors.hardwareHealth.test.ts` — expect `expected ... to include 'hardware_health'` and missing schema failures.
- [ ] **Step 3: Append the enum value after `composite`; add this entry to `leafConditionSchemas`.** Do not append to `SERVER_EVALUATED_MONITOR_KINDS`. Append `'hardware_health'` to the existing exact enum expectation in `monitors.test.ts`.

```ts
// MONITOR_KINDS, after 'composite':
'hardware_health',
// leafConditionSchemas:
hardware_health: z.object({
  componentTypes: z.array(z.enum(['controller','virtual_disk','physical_disk','cache_battery','enclosure','collector'])).min(1),
  minHealth: z.enum(['warning','critical']),
  includePredictiveFailure: z.boolean().default(true),
  consecutiveSnapshots: z.number().int().min(1).max(10).default(2),
}),
```

- [ ] **Step 4: Add the types; add `| HardwareHealthCondition` to `AlertCondition` and `subjects?: SubjectEvidence[]` to both result interfaces.**

```ts
import type { HardwareComponentType } from '@breeze/shared';
export type HardwareHealthComponentFilter = Exclude<HardwareComponentType, 'bmc'>;
export type SubjectStatus = 'breaching' | 'recovered' | 'unknown';
export interface SubjectEvidence {
  subjectKey: string;
  status: SubjectStatus;
  description: string;
  actualValue?: number;
  context?: Record<string, unknown>;
}
export interface HardwareHealthCondition {
  type: 'hardware_health';
  componentTypes: HardwareHealthComponentFilter[];
  minHealth: 'warning' | 'critical';
  includePredictiveFailure: boolean;
  consecutiveSnapshots: number;
}
```

Replace the three existing declarations with these complete declarations (the remaining condition interfaces stay in place):

```ts
export type AlertCondition =
  | ThresholdCondition | OfflineCondition | EventLogCondition | ServiceCondition
  | ProcessCondition | ProcessResourceCondition | BandwidthHighCondition | DiskIoHighCondition
  | NetworkErrorsCondition | PatchComplianceCondition | CertExpiryCondition | AntivirusCondition
  | SoftwarePresenceCondition | BackupContinuityCondition | ScriptMonitorCondition | NetworkCheckCondition
  | HardwareHealthCondition;
export interface ConditionResult {
  passed: boolean;
  description: string;
  actualValue?: number;
  /** Absent means available, preserving existing handlers. */
  dataAvailable?: boolean;
  subjects?: SubjectEvidence[];
}
export interface EvaluationResult {
  triggered: boolean;
  conditionsMet: string[];
  conditionsNotMet: string[];
  dataState: 'ok' | 'unknown';
  subjects?: SubjectEvidence[];
  context: {
    metric?: string;
    actualValue?: number;
    threshold?: number;
    operator?: string;
    durationMinutes?: number;
    deviceId: string;
    evaluatedAt: string;
  };
}
```

- [ ] **Step 5: Run green and commit.** `cd packages/shared && npx vitest run src/validators/monitors.hardwareHealth.test.ts src/validators/monitors.test.ts` — both files pass.

```bash
git add packages/shared/src/validators/monitors.ts packages/shared/src/validators/monitors.test.ts packages/shared/src/validators/monitors.hardwareHealth.test.ts apps/api/src/services/alertConditions/types.ts
git commit -m $'feat(monitoring): define hardware subject contracts\n\nCo-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>'
```

### Task 2: Append the monitor enum in its own migration

**Files:** Create `apps/api/migrations/2026-10-27-100200-monitor-kind-hardware-health.sql`; Modify `apps/api/src/db/schema/monitorDefinitions.ts:56`, `apps/api/vitest.integration.config.ts:13`, `apps/api/vitest.config.ts:18`; Create/Test `apps/api/src/db/hardwareAlertMigrations.integration.test.ts`.
**Interfaces:** Consumes committed `monitor_kind`; produces its trailing `hardware_health` label. No statement uses the new label to write a row in this migration.

- [ ] **Step 1: Write the real-Postgres test and disposable database helper.** This uses the existing disposable-database pattern from `db/installerBootstrapCredentialGeneration.migration.integration.test.ts:24`.

```ts
import '../__tests__/integration/setup';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import postgres, { type Sql } from 'postgres';
import { expect, it } from 'vitest';
async function isolated(run: (sql: Sql, notices: string[]) => Promise<void>) {
  const url = new URL(process.env.DATABASE_URL!);
  const name = `hardware_alert_${randomUUID().replaceAll('-', '')}`;
  const admin = postgres(url.toString(), { max: 1 });
  let connection: Sql | undefined;
  try {
    await admin.unsafe(`CREATE DATABASE "${name}"`);
    url.pathname = `/${name}`;
    const notices: string[] = [];
    connection = postgres(url.toString(), { max: 1, onnotice: n => notices.push(n.message ?? '') });
    await run(connection, notices);
  } finally {
    await connection?.end();
    await admin`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = ${name}`;
    await admin.unsafe(`DROP DATABASE IF EXISTS "${name}"`);
    await admin.end();
  }
}
it('adds only hardware_health, idempotently and last', async () => {
  const migration = await readFile(new URL('../../migrations/2026-10-27-100200-monitor-kind-hardware-health.sql', import.meta.url), 'utf8');
  expect(migration.replace(/--[^\n]*/g, '').trim()).toBe(
    "ALTER TYPE monitor_kind ADD VALUE IF NOT EXISTS 'hardware_health';",
  );
  await isolated(async sql => {
    await sql.unsafe("CREATE TYPE monitor_kind AS ENUM ('cpu', 'composite')");
    await sql.begin(tx => tx.unsafe(migration));
    await sql.begin(tx => tx.unsafe(migration));
    const labels = await sql`SELECT enumlabel FROM pg_enum WHERE enumtypid = 'monitor_kind'::regtype ORDER BY enumsortorder`;
    expect(labels.map(r => r.enumlabel)).toEqual(['cpu', 'composite', 'hardware_health']);
  });
});
```

Add the exact string below to the integration `include` and unit `exclude` arrays before running:

```ts
'src/db/hardwareAlertMigrations.integration.test.ts',
```

- [ ] **Step 2: Start the test stack; run red.** `pnpm test-stack up`; then `cd apps/api && npx vitest run -c vitest.integration.config.ts src/db/hardwareAlertMigrations.integration.test.ts` — expect `ENOENT` for the reserved migration filename.
- [ ] **Step 3: Create the entire migration, and append the Drizzle enum label after `composite`.**

```sql
ALTER TYPE monitor_kind ADD VALUE IF NOT EXISTS 'hardware_health';
```

```ts
// monitorKindEnum, after 'composite':
'hardware_health',
```

- [ ] **Step 4: Run green.** `cd apps/api && npx vitest run -c vitest.integration.config.ts src/db/hardwareAlertMigrations.integration.test.ts` — one passing test, including two executions of the SQL.
- [ ] **Step 5: Commit.**

```bash
git add apps/api/migrations/2026-10-27-100200-monitor-kind-hardware-health.sql apps/api/src/db/schema/monitorDefinitions.ts apps/api/src/db/hardwareAlertMigrations.integration.test.ts apps/api/vitest.integration.config.ts apps/api/vitest.config.ts
git commit -m $'feat(monitoring): append hardware health monitor kind\n\nCo-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>'
```

### Task 3: Enforce subject identity and classify its export column

**Files:** Create `apps/api/migrations/2026-10-27-100300-alert-subject-key.sql`; Modify `apps/api/src/db/schema/alerts.ts:13,122,151`, `apps/api/src/services/tenantExportPolicyRegistry.ts:130`; Test/Modify `apps/api/src/db/hardwareAlertMigrations.integration.test.ts`.
**Interfaces:** Produces nullable `alerts.subjectKey`, CHECK `alerts_subject_key_nonempty_chk`, unique index `alerts_open_rule_device_subject_uidx`. Existing sourced alerts remain outside the index.

- [ ] **Step 1: Append the migration replay test.**

```ts
it('deduplicates NULL subjects once, keeps newest, and preserves distinct subjects on replay', async () => {
  const migration = await readFile(new URL('../../migrations/2026-10-27-100300-alert-subject-key.sql', import.meta.url), 'utf8');
  expect(migration.trimStart().startsWith("SELECT set_config('breeze.scope', 'system', true);")).toBe(true);
  await isolated(async (sql, notices) => {
    await sql.unsafe(`CREATE TABLE alerts (
      id uuid PRIMARY KEY, rule_id uuid, device_id uuid NOT NULL, status text NOT NULL,
      triggered_at timestamp NOT NULL, resolved_at timestamp, resolution_note text
    )`);
    const rule = randomUUID(), device = randomUUID(), old = randomUUID(), newest = randomUUID();
    await sql`INSERT INTO alerts VALUES
      (${old}, ${rule}, ${device}, 'acknowledged', '2026-09-22', NULL, NULL),
      (${newest}, ${rule}, ${device}, 'suppressed', '2026-09-23', NULL, NULL),
      (${randomUUID()}, NULL, ${device}, 'active', '2026-09-23', NULL, NULL),
      (${randomUUID()}, NULL, ${device}, 'active', '2026-09-23', NULL, NULL)`;
    await sql.begin(tx => tx.unsafe(migration));
    expect((await sql`SELECT status,resolution_note FROM alerts WHERE id=${old}`)[0]).toMatchObject({
      status: 'resolved', resolution_note: 'deduplicated by migration',
    });
    expect((await sql`SELECT status FROM alerts WHERE id=${newest}`)[0]!.status).toBe('suppressed');
    expect(notices).toContain('resolved 1 duplicate open alerts');
    await sql`INSERT INTO alerts (id,rule_id,device_id,status,triggered_at,subject_key) VALUES
      (${randomUUID()},${rule},${device},'active',now(),'storcli:c0:e1:s3'),
      (${randomUUID()},${rule},${device},'active',now(),'storcli:c0:e1:s5')`;
    await sql.begin(tx => tx.unsafe(migration));
    expect(notices).toContain('resolved 0 duplicate open alerts');
    expect((await sql`SELECT count(*)::int n FROM alerts WHERE status <> 'resolved'`)[0]!.n).toBe(5);
    await expect(sql`INSERT INTO alerts (id,rule_id,device_id,status,triggered_at,subject_key)
      VALUES (${randomUUID()},${rule},${device},'active',now(),'')`).rejects.toMatchObject({ code: '23514' });
    await expect(sql`INSERT INTO alerts (id,rule_id,device_id,status,triggered_at,subject_key)
      VALUES (${randomUUID()},${rule},${device},'active',now(),'storcli:c0:e1:s3')`).rejects.toMatchObject({ code: '23505' });
  });
});
```

- [ ] **Step 2: Run red.** `cd apps/api && npx vitest run -c vitest.integration.config.ts src/db/hardwareAlertMigrations.integration.test.ts` — expect missing `100300` file.
- [ ] **Step 3: Create the full migration.** Timestamp ties break on UUID, deterministically. Always log the cleanup count, including zero.

```sql
SELECT set_config('breeze.scope', 'system', true);
ALTER TABLE alerts ADD COLUMN IF NOT EXISTS subject_key text;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'alerts'::regclass AND conname = 'alerts_subject_key_nonempty_chk'
  ) THEN
    ALTER TABLE alerts ADD CONSTRAINT alerts_subject_key_nonempty_chk CHECK (subject_key <> '');
  END IF;
END $$;
DO $$
DECLARE n integer;
BEGIN
  WITH ranked AS (
    SELECT id, row_number() OVER (
      PARTITION BY rule_id, device_id ORDER BY triggered_at DESC, id DESC
    ) AS position
    FROM alerts
    WHERE rule_id IS NOT NULL AND subject_key IS NULL
      AND status IN ('active', 'acknowledged', 'suppressed')
  )
  UPDATE alerts a
  SET status = 'resolved', resolved_at = now(), resolution_note = 'deduplicated by migration'
  FROM ranked r WHERE a.id = r.id AND r.position > 1;
  GET DIAGNOSTICS n = ROW_COUNT;
  RAISE WARNING 'resolved % duplicate open alerts', n;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS alerts_open_rule_device_subject_uidx
  ON alerts (rule_id, device_id, COALESCE(subject_key, ''))
  WHERE rule_id IS NOT NULL AND status IN ('active', 'acknowledged', 'suppressed');
```

- [ ] **Step 4: Declare the column and run the export contract red before registration.** Add `check` to the pg-core import, the column after `deviceId`, and these entries to the alerts table callback.

```ts
subjectKey: text('subject_key'),
// alerts callback entries:
subjectKeyNonempty: check('alerts_subject_key_nonempty_chk', sql`${table.subjectKey} <> ''`),
openRuleDeviceSubjectUidx: uniqueIndex('alerts_open_rule_device_subject_uidx')
  .on(table.ruleId, table.deviceId, sql`COALESCE(${table.subjectKey}, '')`)
  .where(sql`${table.ruleId} IS NOT NULL AND ${table.status} IN ('active', 'acknowledged', 'suppressed')`),
```

`cd apps/api && npx vitest run -c vitest.integration.config.ts src/__tests__/integration/tenant-export-policy.integration.test.ts` — expect unclassified `alerts.subject_key`. Then replace the existing alerts entry with:

```ts
"alerts": tablePolicy("org_id", {"included":["id","rule_id","device_id","org_id","config_policy_id","config_item_name","status","severity","title","message","triggered_at","acknowledged_at","acknowledged_by","resolved_at","resolved_by","resolution_note","suppressed_until","dismissed_at","dismissed_by","created_at","monitor_id","episode_id","requires_human","subject_key"],"reviewedIncluded":[],"excludedSensitive":[],"excludedOpen":["context"]}),
```

- [ ] **Step 5: Run green and commit.**

```bash
cd apps/api && npx vitest run -c vitest.integration.config.ts src/db/hardwareAlertMigrations.integration.test.ts src/__tests__/integration/tenant-export-policy.integration.test.ts
```

```bash
cd apps/api && npx vitest run src/db/migrationRlsScope.test.ts src/db/autoMigrate.test.ts
```

Expected: replay/export pass; no change to the frozen RLS-scope baseline. Check `pnpm db:check-drift` after applying the migrations.

```bash
git add apps/api/migrations/2026-10-27-100300-alert-subject-key.sql apps/api/src/db/schema/alerts.ts apps/api/src/services/tenantExportPolicyRegistry.ts apps/api/src/db/hardwareAlertMigrations.integration.test.ts
git commit -m $'feat(alerts): enforce open alert subject identity\n\nCo-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>'
```

### Task 4: Evaluate hardware subjects from accepted snapshot streaks

**Files:** Create `apps/api/src/services/alertConditions/handlers/hardwareHealth.ts`; Create/Test `apps/api/src/services/alertConditions/handlers/hardwareHealth.test.ts`.
**Interfaces:** Consumes W01 `deviceHardwareComponents`, `deviceHardwareHealth`, `isComponentFresh(c: { source: HardwareSource; lastSeenAt: Date }, health: { pollIntervalMinutes: number | null; diskHealthIntervalMinutes: number | null }, now: Date): boolean`; Task 1 evidence types. Produces `hardwareHealthHandler: ConditionHandler`.

- [ ] **Step 1: Write the handler matrix, using the real freshness helper and schema.**

```ts
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
const mocks = vi.hoisted(() => ({ select: vi.fn(), predicates: [] as unknown[] }));
vi.mock('../../../db', () => ({ db: { select: mocks.select } }));
import { hardwareHealthHandler } from './hardwareHealth';
const now = new Date('2026-09-23T12:00:00Z');
const condition = { type: 'hardware_health', componentTypes: ['physical_disk'],
  minHealth: 'critical', includePredictiveFailure: true, consecutiveSnapshots: 2 };
function component(patch: Record<string, unknown> = {}) {
  return { componentKey: 'storcli:c0:e252:s3', componentType: 'physical_disk', source: 'storcli',
    name: 'Slot 3', model: 'ST4000', serial: 'SERIAL3', parentKey: 'storcli:c0',
    health: 'critical', state: 'failed', stateDetail: 'Failed', attributes: { slot: '252:3' },
    stale: false, alertExempt: false, lastSeenAt: now, predictiveFailure: false,
    unhealthyStreak: 2, criticalStreak: 2, healthyStreak: 0, belowCriticalStreak: 0, predictiveStreak: 0,
    ...patch };
}
function rows(components: unknown[], health: unknown[] = [{ pollIntervalMinutes: 10, diskHealthIntervalMinutes: 60 }]) {
  mocks.select.mockImplementationOnce(() => ({ from: () => ({ where: () => ({ limit: async () => health }) }) }));
  mocks.select.mockImplementationOnce(() => ({ from: () => ({ where: (predicate: unknown) => {
    mocks.predicates.push(predicate); return Promise.resolve(components);
  } }) }));
}
beforeEach(() => { mocks.select.mockReset(); mocks.predicates.length = 0; vi.useFakeTimers(); vi.setSystemTime(now); });
afterEach(() => vi.useRealTimers());
it.each([
  ['critical', { criticalStreak: 1, unhealthyStreak: 5 }, true, 'unknown'],
  ['critical', { criticalStreak: 2 }, true, 'breaching'],
  ['warning', { criticalStreak: 0, unhealthyStreak: 2, health: 'warning' }, false, 'breaching'],
  ['critical', { criticalStreak: 0, belowCriticalStreak: 2, health: 'warning', state: 'rebuilding' }, false, 'recovered'],
  ['warning', { health: 'ok', criticalStreak: 0, unhealthyStreak: 0, healthyStreak: 1 }, false, 'unknown'],
  ['warning', { health: 'ok', criticalStreak: 0, unhealthyStreak: 0, healthyStreak: 2 }, false, 'recovered'],
  ['critical', { health: 'warning', criticalStreak: 0, predictiveFailure: true, predictiveStreak: 2 }, true, 'breaching'],
  ['critical', { health: 'warning', criticalStreak: 0, predictiveFailure: true, predictiveStreak: 2, belowCriticalStreak: 2 }, false, 'unknown'],
  ['critical', { health: 'unknown', criticalStreak: 9 }, true, 'unknown'],
  ['critical', { lastSeenAt: new Date(now.getTime() - 31 * 60_000) }, true, 'unknown'],
  ['critical', { source: 'smartctl', lastSeenAt: new Date(now.getTime() - 179 * 60_000) }, true, 'breaching'],
  ['critical', { source: 'smartctl', lastSeenAt: new Date(now.getTime() - 181 * 60_000) }, true, 'unknown'],
] as const)('%s %j predictive=%s => %s', async (minHealth, patch, includePredictiveFailure, expected) => {
  rows([component(patch)]);
  const result = await hardwareHealthHandler.evaluate({ ...condition, minHealth, includePredictiveFailure }, 'device');
  expect(result.subjects?.[0]?.status).toBe(expected);
  expect(result.passed).toBe(expected === 'breaching');
  expect(result.dataAvailable).toBe(true);
});
it('failed → online → failed never reaches two consecutive observations', async () => {
  for (const patch of [
    { criticalStreak: 1, unhealthyStreak: 1 },
    { health: 'ok', state: 'online', criticalStreak: 0, unhealthyStreak: 0, healthyStreak: 1, belowCriticalStreak: 1 },
    { criticalStreak: 1, unhealthyStreak: 1 },
  ]) {
    rows([component(patch)]);
    expect((await hardwareHealthHandler.evaluate(condition, 'device')).subjects?.[0]?.status).toBe('unknown');
  }
});
it('reports unavailable for no health row or no eligible components', async () => {
  rows([], []);
  expect(await hardwareHealthHandler.evaluate(condition, 'device')).toMatchObject({ passed: false, dataAvailable: false, subjects: [] });
  mocks.select.mockReset(); rows([]);
  expect(await hardwareHealthHandler.evaluate(condition, 'device')).toMatchObject({ passed: false, dataAvailable: false, subjects: [] });
});
it('filters by device, type, non-stale and non-exempt in SQL', async () => {
  rows([component()]);
  const result = await hardwareHealthHandler.evaluate(condition, 'device');
  const query = new PgDialect().sqlToQuery(mocks.predicates[0] as never);
  expect(query.sql).toContain('"device_id"'); expect(query.params).toContain('device');
  expect(query.sql).toContain('"component_type"'); expect(query.params).toContain('physical_disk');
  expect(query.sql).toContain('"stale"'); expect(query.sql).toContain('"alert_exempt"');
  expect(query.params.filter(x => x === false)).toHaveLength(2);
  expect(result.subjects?.[0]?.context).toMatchObject({ source: 'hardware_health', subjectKey: 'storcli:c0:e252:s3',
    componentLabel: 'Physical disk 252:3 (ST4000 SERIAL3)', stateLabel: 'failed', controller: 'storcli:c0' });
});
it.each([['storcli', 30, 'breaching'], ['storcli', 31, 'unknown'], ['smartctl', 180, 'breaching'], ['smartctl', 181, 'unknown']] as const)(
  'fallback freshness %s age=%i', async (source, minutes, expected) => {
    rows([component({ source, lastSeenAt: new Date(now.getTime() - minutes * 60_000) })],
      [{ pollIntervalMinutes: null, diskHealthIntervalMinutes: null }]);
    expect((await hardwareHealthHandler.evaluate(condition, 'device')).subjects?.[0]?.status).toBe(expected);
  },
);
it('validates the same constraints as the shared leaf', () => {
  expect(hardwareHealthHandler.validate(condition, 'condition')).toEqual([]);
  expect(hardwareHealthHandler.validate({ ...condition, componentTypes: ['bmc'] }, 'condition').length).toBeGreaterThan(0);
});
```

- [ ] **Step 2: Run red.** `cd apps/api && npx vitest run src/services/alertConditions/handlers/hardwareHealth.test.ts` — expect missing `./hardwareHealth` module.
- [ ] **Step 3: Implement the complete handler.** No streak arithmetic belongs here. `dataAvailable` describes the existence of eligible rows, while stale-by-age rows explicitly return `unknown` evidence.

```ts
import { and, eq, inArray } from 'drizzle-orm';
import { HARDWARE_HEALTH_RANK, monitorConditionSchemas } from '@breeze/shared';
import { db } from '../../../db';
import { deviceHardwareComponents, deviceHardwareHealth } from '../../../db/schema';
import { isComponentFresh } from '../../hardwareHealth/freshness';
import type { ConditionHandler } from '../registry';
import type { SubjectEvidence, SubjectStatus } from '../types';
const labels: Record<string, string> = {
  controller: 'Controller', virtual_disk: 'Virtual disk', physical_disk: 'Physical disk',
  cache_battery: 'Cache battery', enclosure: 'Enclosure', collector: 'Monitoring tool',
};
export const hardwareHealthHandler: ConditionHandler = {
  type: 'hardware_health',
  async evaluate(condition, deviceId) {
    const cond = monitorConditionSchemas.hardware_health.parse(condition);
    const [health] = await db.select().from(deviceHardwareHealth)
      .where(eq(deviceHardwareHealth.deviceId, deviceId)).limit(1);
    if (!health) return { passed: false, dataAvailable: false, subjects: [], description: 'No hardware health reported' };
    const components = await db.select().from(deviceHardwareComponents).where(and(
      eq(deviceHardwareComponents.deviceId, deviceId), eq(deviceHardwareComponents.stale, false),
      eq(deviceHardwareComponents.alertExempt, false), inArray(deviceHardwareComponents.componentType, cond.componentTypes),
    ));
    const now = new Date();
    const subjects: SubjectEvidence[] = components.map(c => {
      let status: SubjectStatus = 'unknown';
      const n = cond.consecutiveSnapshots;
      if (c.health !== 'unknown' && isComponentFresh(c, health, now)) {
        const breachCount = cond.minHealth === 'warning' ? c.unhealthyStreak : c.criticalStreak;
        const recoveryCount = cond.minHealth === 'warning' ? c.healthyStreak : c.belowCriticalStreak;
        if (breachCount >= n || (cond.includePredictiveFailure && c.predictiveStreak >= n)) status = 'breaching';
        else if (recoveryCount >= n && !c.predictiveFailure) status = 'recovered';
      }
      const attributes = c.attributes as Record<string, unknown>;
      const identity = [c.model, c.serial].filter(Boolean).join(' ');
      const componentLabel = `${labels[c.componentType]} ${attributes.slot ?? c.name}${identity ? ` (${identity})` : ''}`;
      const stateLabel = c.state.replaceAll('_', ' ');
      return { subjectKey: c.componentKey, status, description: `${componentLabel} is ${stateLabel}`,
        actualValue: HARDWARE_HEALTH_RANK[c.health], context: {
          source: 'hardware_health', subjectKey: c.componentKey, componentType: c.componentType,
          componentKey: c.componentKey, componentLabel, stateLabel, name: c.name, model: c.model,
          serial: c.serial, state: c.state, stateDetail: c.stateDetail ?? stateLabel, health: c.health,
          slot: attributes.slot ?? null, controller: c.parentKey, predictiveFailure: c.predictiveFailure,
        } };
    });
    const count = (status: SubjectStatus) => subjects.filter(s => s.status === status).length;
    return { passed: count('breaching') > 0, dataAvailable: components.length > 0, subjects,
      description: `${count('breaching')} breaching, ${count('recovered')} recovered, ${count('unknown')} unknown hardware components` };
  },
  validate(condition, path) {
    const result = monitorConditionSchemas.hardware_health.safeParse(condition);
    return result.success ? [] : result.error.issues.map(i => `${path}.${i.path.join('.')}: ${i.message}`);
  },
};
```

- [ ] **Step 4: Run green.** `cd apps/api && npx vitest run src/services/alertConditions/handlers/hardwareHealth.test.ts` — all cases pass, including the three-poll blip.
- [ ] **Step 5: Commit.**

```bash
git add apps/api/src/services/alertConditions/handlers/hardwareHealth.ts apps/api/src/services/alertConditions/handlers/hardwareHealth.test.ts
git commit -m $'feat(monitoring): evaluate hardware streaks per subject\n\nCo-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>'
```

### Task 5: Register the handler and propagate only root-leaf subjects

**Files:** Modify `apps/api/src/services/alertConditions/index.ts:32,50,84,99,187,227`; Create/Test `apps/api/src/services/alertConditions/subjects.test.ts`.
**Interfaces:** Consumes `hardwareHealthHandler` and `SubjectEvidence[]`; produces optional `EvaluationResult.subjects`. Arrays, including one-element arrays, are groups and discard subjects.

- [ ] **Step 1: Write the failing evaluator test.**

```ts
import { afterEach, expect, it, vi } from 'vitest';
vi.mock('../../db', () => ({ db: {} }));
vi.mock('./utils', async original => ({ ...await original<typeof import('./utils')>(), getLatestMetric: vi.fn().mockResolvedValue(null) }));
import { evaluateConditions, conditionRegistry } from './index';
import { hardwareHealthHandler } from './handlers/hardwareHealth';
afterEach(() => vi.restoreAllMocks());
it('registers the hardware handler', () => expect(conditionRegistry.get('hardware_health')).toBe(hardwareHealthHandler));
it.each(['leaf', 'array', 'and', 'or'])('subjects on %s', async shape => {
  const subjects = [{ subjectKey: 'disk:3', status: 'unknown' as const, description: 'Waiting for evidence' }];
  vi.spyOn(conditionRegistry, 'evaluate').mockResolvedValue({ passed: false, dataAvailable: false, description: 'No data', subjects });
  const leaf = { type: 'hardware_health' };
  const input = shape === 'leaf' ? leaf : shape === 'array' ? [leaf] : { logic: shape, conditions: [leaf] };
  const result = await evaluateConditions(input, 'device');
  expect(result.dataState).toBe('unknown');
  expect(result.subjects).toEqual(shape === 'leaf' ? subjects : undefined);
  expect(conditionRegistry.evaluate).toHaveBeenCalledTimes(1);
});
```

- [ ] **Step 2: Run red.** `cd apps/api && npx vitest run src/services/alertConditions/subjects.test.ts` — missing registry entry and undefined leaf subjects.
- [ ] **Step 3: Add the imports/registration below, then replace both evaluator functions with the complete definitions.** Preserve the existing met/notMet/primary-threshold flow; do not evaluate the leaf twice.

```ts
import { hardwareHealthHandler } from './handlers/hardwareHealth';
import type { SubjectEvidence } from './types';
export type { SubjectEvidence, SubjectStatus, HardwareHealthCondition, HardwareHealthComponentFilter } from './types';
conditionRegistry.register(hardwareHealthHandler);

type EvaluationAccumulator = {
  met: string[]; notMet: string[]; primaryActualValue?: number;
  sawUnknown?: boolean; subjects?: SubjectEvidence[];
};
async function evaluateConditionRecursive(
  condition: RootCondition, deviceId: string, results: EvaluationAccumulator,
): Promise<boolean> {
  if (isConditionGroup(condition)) {
    const evaluations = await Promise.all(condition.conditions.map(c => evaluateConditionRecursive(c, deviceId, results)));
    return condition.logic === 'and' ? evaluations.every(Boolean) : evaluations.some(Boolean);
  }
  const result = await conditionRegistry.evaluate(condition as { type: string }, deviceId);
  results.subjects = result.subjects;
  if (result.dataAvailable === false) results.sawUnknown = true;
  if (result.passed) results.met.push(result.description);
  else results.notMet.push(result.description);
  if ((condition.type === 'threshold' || condition.type === 'metric') &&
      results.primaryActualValue === undefined && typeof result.actualValue === 'number') {
    results.primaryActualValue = result.actualValue;
  }
  return result.passed;
}
export async function evaluateConditions(conditions: unknown, deviceId: string): Promise<EvaluationResult> {
  const evaluatedAt = new Date().toISOString();
  if (!conditions) return {
    triggered: false, conditionsMet: [], conditionsNotMet: ['No conditions defined'],
    dataState: 'unknown', context: { deviceId, evaluatedAt },
  };
  let rootCondition: RootCondition;
  if (Array.isArray(conditions)) rootCondition = { logic: 'and', conditions: conditions as AlertCondition[] };
  else if (typeof conditions === 'object') rootCondition = conditions as RootCondition;
  else return {
    triggered: false, conditionsMet: [], conditionsNotMet: ['Invalid conditions format'],
    dataState: 'unknown', context: { deviceId, evaluatedAt },
  };
  const results: EvaluationAccumulator = { met: [], notMet: [] };
  const triggered = await evaluateConditionRecursive(rootCondition, deviceId, results);
  const latestMetric = await getLatestMetric(deviceId);
  const context: EvaluationResult['context'] = { deviceId, evaluatedAt };
  const findFirstThreshold = (cond: RootCondition): ThresholdCondition | undefined => {
    if (isConditionGroup(cond)) {
      for (const c of cond.conditions) {
        const found = findFirstThreshold(c);
        if (found) return found;
      }
      return undefined;
    }
    if (cond.type === 'threshold' || cond.type === 'metric') return cond as ThresholdCondition;
    return undefined;
  };
  const primaryThreshold = findFirstThreshold(rootCondition);
  if (primaryThreshold) {
    const normalizedMetric = normalizeMetricName(primaryThreshold.metric);
    const latestValue = normalizedMetric ? latestMetric?.[normalizedMetric] ?? undefined : undefined;
    context.metric = primaryThreshold.metric;
    context.actualValue = results.primaryActualValue ?? latestValue;
    context.threshold = primaryThreshold.value;
    context.operator = getOperatorDisplay(primaryThreshold.operator);
    context.durationMinutes = primaryThreshold.durationMinutes;
  }
  return {
    triggered, conditionsMet: results.met, conditionsNotMet: results.notMet,
    dataState: results.sawUnknown ? 'unknown' : 'ok', context,
    ...(!isConditionGroup(rootCondition) && results.subjects !== undefined ? { subjects: results.subjects } : {}),
  };
}
```

- [ ] **Step 4: Run green.** `cd apps/api && npx vitest run src/services/alertConditions/subjects.test.ts src/services/alertConditions/index.test.ts` — subjects survive a single leaf only; legacy threshold context stays unchanged.
- [ ] **Step 5: Commit.**

```bash
git add apps/api/src/services/alertConditions/index.ts apps/api/src/services/alertConditions/subjects.test.ts
git commit -m $'feat(alerts): propagate root subject evidence\n\nCo-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>'
```

### Task 6: Isolate cooldown, adaptive state and flapping by subject

**Files:** Modify `apps/api/src/services/alertCooldown.ts:43,54,82,105,416,452`; Create/Test `apps/api/src/services/alertCooldown.subjects.test.ts`.
**Interfaces:** Produces `isCooldownActive(ruleId, deviceId, subjectKey?)`, `setCooldown(ruleId, deviceId, minutes, subjectKey?)`, `recordStateTransition(ruleId, deviceId, state, subjectKey?)`, `isFlapping(ruleId, deviceId, windowMinutes?, threshold?, subjectKey?)`; all optional keys are `string | undefined`.

- [ ] **Step 1: Write the failing isolation test.**

```ts
import { beforeEach, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({ available: true, store: new Map<string, string>(), lists: new Map<string, string[]>() }));
vi.mock('./redis', () => ({ isRedisAvailable: () => m.available, getRedis: () => ({
  exists: async (k: string) => Number(m.store.has(k)), get: async (k: string) => m.store.get(k) ?? null,
  setex: async (k: string, _ttl: number, v: string) => { m.store.set(k, v); },
  rpush: async (k: string, v: string) => { m.lists.set(k, [...(m.lists.get(k) ?? []), v]); },
  ltrim: async () => {}, expire: async () => {}, lrange: async (k: string) => m.lists.get(k) ?? [],
}) }));
import { isCooldownActive, setCooldown, isFlapping, recordStateTransition } from './alertCooldown';
beforeEach(() => { m.available = true; m.store.clear(); m.lists.clear(); });
it.each([true, false])('cooldown identity, Redis=%s', async available => {
  m.available = available;
  const rule = `rule-${available}`;
  await setCooldown(rule, 'device', 5, 'disk:3');
  expect(await isCooldownActive(rule, 'device', 'disk:3')).toBe(true);
  expect(await isCooldownActive(rule, 'device', 'disk:5')).toBe(false);
  expect(await isCooldownActive(rule, 'device')).toBe(false);
});
it('keeps legacy Redis keys and separates adaptive and flap keys', async () => {
  await setCooldown('rule', 'device', 5);
  await setCooldown('rule', 'device', 5, 'disk:3');
  expect(m.store.has('breeze:alerts:cooldown:rule:device')).toBe(true);
  expect(m.store.has('breeze:alerts:cooldown:adaptive:rule:device')).toBe(true);
  await recordStateTransition('rule', 'device', 'resolved');
  expect(m.lists.has('breeze:alerts:flap:rule:device')).toBe(true);
  expect(m.store.has('breeze:alerts:cooldown:adaptive:rule:device:disk:3')).toBe(true);
  for (let i = 0; i < 4; i++) await recordStateTransition('rule', 'device', 'triggered', 'disk:3');
  expect(await isFlapping('rule', 'device', undefined, undefined, 'disk:3')).toBe(true);
  expect(await isFlapping('rule', 'device', undefined, undefined, 'disk:5')).toBe(false);
  expect(await isFlapping('rule', 'device')).toBe(false);
});
```

- [ ] **Step 2: Run red.** `cd apps/api && npx vitest run src/services/alertCooldown.subjects.test.ts` — sibling cooldown/flap assertions fail.
- [ ] **Step 3: Add one local key helper and extend the signatures and key expressions.** Replace these four complete functions and the key builder; keep the other cooldown utilities and existing prefix/map declarations.

```ts
function subjectIdentity(ruleId: string, deviceId: string, subjectKey?: string): string {
  return `${ruleId}:${deviceId}${subjectKey === undefined ? '' : `:${subjectKey}`}`;
}
function buildCooldownKey(ruleId: string, deviceId: string, subjectKey?: string): string {
  return `${COOLDOWN_PREFIX}:${subjectIdentity(ruleId, deviceId, subjectKey)}`;
}
export async function isCooldownActive(ruleId: string, deviceId: string, subjectKey?: string): Promise<boolean> {
  const redis = isRedisAvailable() ? getRedis() : null;
  if (!redis) {
    console.error('[AlertCooldown] Redis unavailable, using in-memory fallback (fail-closed)');
    return memoryHasCooldown(subjectIdentity(ruleId, deviceId, subjectKey));
  }
  return await redis.exists(buildCooldownKey(ruleId, deviceId, subjectKey)) === 1;
}
export async function setCooldown(ruleId: string, deviceId: string, cooldownMinutes: number, subjectKey?: string): Promise<void> {
  const redis = isRedisAvailable() ? getRedis() : null;
  if (!redis) {
    console.error('[AlertCooldown] Redis unavailable, setting in-memory cooldown fallback');
    memorySetCooldown(subjectIdentity(ruleId, deviceId, subjectKey), cooldownMinutes);
    return;
  }
  const key = buildCooldownKey(ruleId, deviceId, subjectKey);
  const adaptiveKey = `${COOLDOWN_PREFIX}:adaptive:${subjectIdentity(ruleId, deviceId, subjectKey)}`;
  let multiplier = 1;
  try {
    const existing = await redis.get(adaptiveKey);
    if (existing) {
      const parsed = JSON.parse(existing);
      if (parsed.multiplier && Date.now() - parsed.setAt < 3600_000) multiplier = Math.min(parsed.multiplier * 2, 4);
    }
  } catch (error) {
    if (error instanceof SyntaxError) console.warn(`[AlertCooldown] Corrupt adaptive state for rule=${ruleId} device=${deviceId}, resetting multiplier`);
    else console.error(`[AlertCooldown] Failed to read adaptive state for rule=${ruleId} device=${deviceId}:`, error);
  }
  const effectiveMinutes = cooldownMinutes * multiplier;
  await redis.setex(key, effectiveMinutes * 60, JSON.stringify({ setAt: Date.now(), multiplier }));
  await redis.setex(adaptiveKey, 3600, JSON.stringify({ setAt: Date.now(), multiplier }));
  console.log(`[AlertCooldown] Set cooldown for rule=${ruleId} device=${deviceId} for ${effectiveMinutes}min (${multiplier}x multiplier)`);
}
export async function recordStateTransition(ruleId: string, deviceId: string, state: 'triggered' | 'resolved', subjectKey?: string): Promise<void> {
  const redis = isRedisAvailable() ? getRedis() : null;
  if (!redis) { console.warn('[AlertCooldown] Redis unavailable, flapping detection disabled — state transition not recorded'); return; }
  const key = `${FLAP_PREFIX}:${subjectIdentity(ruleId, deviceId, subjectKey)}`;
  await redis.rpush(key, JSON.stringify({ state, timestamp: Date.now() }));
  await redis.ltrim(key, -20, -1);
  await redis.expire(key, 1800);
}
export async function isFlapping(ruleId: string, deviceId: string, windowMinutes: number = 10, threshold: number = 4, subjectKey?: string): Promise<boolean> {
  const redis = isRedisAvailable() ? getRedis() : null;
  if (!redis) { console.warn('[AlertCooldown] Redis unavailable, flapping detection disabled'); return false; }
  const key = `${FLAP_PREFIX}:${subjectIdentity(ruleId, deviceId, subjectKey)}`;
  const entries = await redis.lrange(key, 0, -1);
  if (entries.length < threshold) return false;
  const windowStart = Date.now() - windowMinutes * 60 * 1000;
  let transitionCount = 0;
  for (const entry of entries) {
    try { if (JSON.parse(entry).timestamp >= windowStart) transitionCount++; }
    catch (error) {
      if (!(error instanceof SyntaxError)) console.error(`[AlertCooldown] Failed to parse flapping entry for rule=${ruleId} device=${deviceId}:`, error);
    }
  }
  return transitionCount >= threshold;
}
```

- [ ] **Step 4: Run green.** `cd apps/api && npx vitest run src/services/alertCooldown.subjects.test.ts src/services/alertCooldown.rekey.test.ts` — subject keys isolate both Redis and memory fallback; existing absent-subject keys stay byte-identical.
- [ ] **Step 5: Commit.**

```bash
git add apps/api/src/services/alertCooldown.ts apps/api/src/services/alertCooldown.subjects.test.ts
git commit -m $'feat(alerts): scope noise controls to component subjects\n\nCo-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>'
```

### Task 7: Claim response ownership atomically

**Files:** Modify `apps/api/src/services/monitors/episodeService.ts:367`; Create/Test `apps/api/src/services/monitors/episodeService.subjects.test.ts`.
**Interfaces:** Replaces `linkEpisodeAlert(episodeId: string, alertId: string): Promise<void>` with the contract's `Promise<{ owner: boolean }>`; existing callers may ignore the return value.

- [ ] **Step 1: Write the claim test.**

```ts
import { expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
const m = vi.hoisted(() => ({ update: vi.fn(), predicate: undefined as unknown, rows: [] as { id: string }[] }));
vi.mock('../../db', () => ({ db: { update: m.update } }));
import { linkEpisodeAlert } from './episodeService';
it.each([true, false])('reports atomic owner=%s', async owner => {
  m.rows = owner ? [{ id: 'episode' }] : [];
  m.update.mockReturnValue({ set: () => ({ where: (p: unknown) => {
    m.predicate = p; return { returning: async () => m.rows };
  } }) });
  expect(await linkEpisodeAlert('episode', 'alert')).toEqual({ owner });
  const query = new PgDialect().sqlToQuery(m.predicate as never);
  expect(query.sql).toContain('"alert_id" is null');
  expect(query.params).toContain('episode');
});
```

- [ ] **Step 2: Run red.** `cd apps/api && npx vitest run src/services/monitors/episodeService.subjects.test.ts` — expected `{ owner: ... }`, received undefined.
- [ ] **Step 3: Replace the complete function.**

```ts
export async function linkEpisodeAlert(episodeId: string, alertId: string): Promise<{ owner: boolean }> {
  const claimed = await db.update(monitorEpisodes)
    .set({ alertId, updatedAt: new Date() })
    .where(and(eq(monitorEpisodes.id, episodeId), isNull(monitorEpisodes.alertId)))
    .returning({ id: monitorEpisodes.id });
  return { owner: claimed.length === 1 };
}
```

- [ ] **Step 4: Run green.** `cd apps/api && npx vitest run src/services/monitors/episodeService.subjects.test.ts` — both winner and loser pass. Task 11 proves the real database concurrency boundary.
- [ ] **Step 5: Commit.**

```bash
git add apps/api/src/services/monitors/episodeService.ts apps/api/src/services/monitors/episodeService.subjects.test.ts
git commit -m $'fix(monitors): retain the first episode response owner\n\nCo-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>'
```

### Task 8: Insert subjects atomically and publish response ownership

**Files:** Modify `apps/api/src/routes/alerts/alerts.ts:1083`, `apps/api/src/routes/mobile.ts:1249`, `apps/api/src/routes/alerts/alerts.resolveCas.test.ts`, `apps/api/src/routes/mobile.resolveCas.test.ts`, `apps/api/src/services/alertService.ts:45,167,438,751,791`, `apps/api/src/services/alertService.test.ts:18,113`, `apps/api/src/services/alertService.episodes.test.ts:49,269`, `apps/api/src/services/alertService.networkCheck.test.ts:47,259`; Create/Test `apps/api/src/services/alertService.subjects.test.ts`.
**Interfaces:** Consumes Task 6 helpers and Task 7 `linkEpisodeAlert`; produces `CreateAlertParams.subjectKey?: string`, internal lazy `allocateSubjectEpisode?: () => Promise<string>`, the unchanged `createAlert(params: CreateAlertParams): Promise<string | null>`, and `alert.triggered` fields `subjectKey: string | null`, `responsesOwner: boolean`.

- [ ] **Step 1: Write tests for publication ordering, collision, NULL compatibility and rollback.**

```ts
import { beforeEach, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
const m = vi.hoisted(() => ({ select: vi.fn(), execute: vi.fn(), update: vi.fn(), delete: vi.fn(), staged: undefined as any,
  publish: vi.fn(), link: vi.fn(), cooldown: vi.fn(), transition: vi.fn() }));
vi.mock('../db', () => ({ db: m, withDbTransaction: async (fn: () => Promise<unknown>) => fn() }));
vi.mock('./eventBus', () => ({ publishEvent: m.publish }));
vi.mock('./deviceSiteResolver', () => ({ resolveDeviceSiteId: async () => null }));
vi.mock('../jobs/alertCorrelation', () => ({ enqueueAlertCorrelation: vi.fn().mockResolvedValue('correlation-job') }));
vi.mock('./sentry', () => ({ captureException: vi.fn() }));
vi.mock('./monitors/episodeService', () => ({ linkEpisodeAlert: m.link, recordMonitorEvaluation: vi.fn(), detachMonitorFromDevice: vi.fn() }));
vi.mock('./alertCooldown', () => ({ isCooldownActive: async () => false, isFlapping: async () => false,
  setCooldown: m.cooldown, recordStateTransition: m.transition, isConfigPolicyRuleCooling: vi.fn(), markConfigPolicyRuleCooldown: vi.fn() }));
import { createAlert, checkAutoResolve } from './alertService';
const params = { ruleId: '11111111-1111-4111-8111-111111111111', deviceId: '22222222-2222-4222-8222-222222222222',
  orgId: '33333333-3333-4333-8333-333333333333', severity: 'high' as const, title: 'Disk failed', message: 'Slot 3' };
beforeEach(() => {
  vi.clearAllMocks();
  const results = [[{ id: params.ruleId, templateId: 'template', overrideSettings: null }], [{ cooldownMinutes: 5 }], []];
  m.select.mockImplementation(() => ({ from: () => ({ where: () => ({ limit: async () => results.shift() ?? [] }) }) }));
  m.execute.mockResolvedValue([{ id: 'alert' }]); m.publish.mockResolvedValue(undefined);
  m.link.mockResolvedValue({ owner: true });
  m.delete.mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) });
  m.update.mockReturnValue({ set: (value: any) => { m.staged = value; return { where: vi.fn().mockResolvedValue(undefined) }; } });
});
it.each([true, false])('stages subject ownership %s without external effects', async owner => {
  m.link.mockResolvedValue({ owner });
  expect(await createAlert({ ...params, subjectKey: 'disk:3', episodeId: 'episode' })).toBe('alert');
  expect(m.staged.context._subjectDispatch.payload).toMatchObject({ subjectKey: 'disk:3', responsesOwner: owner });
  expect(m.publish).not.toHaveBeenCalled();
  expect(m.cooldown).not.toHaveBeenCalled();
  expect(m.transition).not.toHaveBeenCalled();
  const query = new PgDialect().sqlToQuery(m.execute.mock.calls[0]![0]);
  expect(query.sql).toContain("COALESCE(subject_key, '')");
  expect(query.sql).toContain('DO NOTHING RETURNING id');
});
it('treats a losing insert as dedupe without publishing or burning cooldown', async () => {
  m.execute.mockResolvedValue([]);
  expect(await createAlert({ ...params, subjectKey: 'disk:3' })).toBeNull();
  expect(m.publish).not.toHaveBeenCalled(); expect(m.cooldown).not.toHaveBeenCalled();
  expect(m.transition).not.toHaveBeenCalled();
});
it('legacy identity is NULL and owns responses', async () => {
  await createAlert(params);
  expect(m.publish.mock.calls[0]![2]).toMatchObject({ subjectKey: null, responsesOwner: true });
});
it('subject claim failure aborts before staging or publication', async () => {
  m.link.mockRejectedValueOnce(new Error('claim failed'));
  await expect(createAlert({ ...params, subjectKey: 'disk:3', episodeId: 'episode' })).rejects.toThrow('claim failed');
  expect(m.update).not.toHaveBeenCalled(); expect(m.publish).not.toHaveBeenCalled();
  expect(m.cooldown).not.toHaveBeenCalled();
});
it('NULL-subject creation never requires a prepublication episode claim', async () => {
  m.link.mockRejectedValueOnce(new Error('bookkeeping failed'));
  expect(await createAlert({ ...params, episodeId: 'episode' })).toBe('alert');
  expect(m.link).not.toHaveBeenCalled(); expect(m.delete).not.toHaveBeenCalled();
  expect(m.publish.mock.calls[0]![2]).toMatchObject({ subjectKey: null, responsesOwner: true });
});
it('never invokes device-level auto-resolve for a subject', async () => {
  m.select.mockReturnValue({ from: () => ({ where: () => ({ limit: async () => [{ status: 'active', subjectKey: 'disk:3', ruleId: params.ruleId, requiresHuman: false }] }) }) });
  expect(await checkAutoResolve('alert')).toBe(false);
  expect(m.select).toHaveBeenCalledTimes(1);
});
```

- [ ] **Step 2: Run red.** `cd apps/api && npx vitest run src/services/alertService.subjects.test.ts` — old insert path/ownership and subject early-return assertions fail.
- [ ] **Step 3: Add `subjectKey?: string` to `CreateAlertParams`, import `withDbTransaction` from `../db`, and replace `createAlert` entirely.** The raw result contains only `id`, the only field consumed by this function or its callers. Bound SQL parameters handle subject keys and JSON safely.

The subject row's existing tenant-scoped, export-excluded `context` holds the transactional outbox envelope; no trigger-outbox table or migration slot is needed. Task 10 adds episode response-admission columns and Task 12 adds a retirement outbox to W03's unshipped `100300` migration. Task 10 drains `_subjectDispatch` after the **outer** context commits. A subject ID means a committed-or-pending insert, not a completed notification; NULL-subject publication/return semantics stay synchronous. Add the optional internal member `allocateSubjectEpisode?: () => Promise<string>` to `CreateAlertParams`; it is called only after a subject wins insertion. Add this exported type next to it:

```ts
export interface SubjectAlertDispatch {
  eventId: string;
  eventType: 'alert.triggered' | 'alert.resolved';
  publisher?: string;
  siteId: string | null | undefined;
  cooldownMinutes: number;
  payload: Record<string, unknown>;
  leaseToken?: string;
  leaseUntil?: string;
}
```

```ts
export async function createAlert(params: CreateAlertParams): Promise<string | null> {
  const { ruleId, deviceId, orgId, severity, title, message, context, monitorId,
    episodeId, requiresHuman, subjectKey, allocateSubjectEpisode } = params;
  if (subjectKey === '') throw new Error('subjectKey must not be empty');
  const [rule] = await db.select().from(alertRules).where(eq(alertRules.id, ruleId)).limit(1);
  if (!rule) { console.warn(`[AlertService] Rule ${ruleId} not found`); return null; }
  const [template] = await db.select().from(alertTemplates).where(eq(alertTemplates.id, rule.templateId)).limit(1);
  const overrides = rule.overrideSettings as Record<string, unknown> | null;
  const cooldownMinutes = (overrides?.cooldownMinutes as number) ?? template?.cooldownMinutes ?? 5;
  if (await isCooldownActive(ruleId, deviceId, subjectKey)) return null;
  const [existing] = await db.select().from(alerts).where(and(
    eq(alerts.ruleId, ruleId), eq(alerts.deviceId, deviceId),
    sql`${alerts.subjectKey} IS NOT DISTINCT FROM ${subjectKey ?? null}`,
    inArray(alerts.status, ['active', 'acknowledged', 'suppressed']),
  )).limit(1);
  if (existing) { console.log(`[AlertService] Dedupe rule=${ruleId} device=${deviceId} subject=${subjectKey ?? 'null'}`); return null; }
  if (await isFlapping(ruleId, deviceId, undefined, undefined, subjectKey)) {
    if (subjectKey === undefined) await setCooldown(ruleId, deviceId, cooldownMinutes);
    return null;
  }
  const monitorFields = await monitorEventFields(monitorId ?? rule.managedByMonitorId, params.kind);
  const insert = async () => {
    const [row] = await db.execute<{ id: string }>(sql`
      INSERT INTO alerts (rule_id, device_id, org_id, severity, title, message, context,
        monitor_id, episode_id, requires_human, subject_key, status, triggered_at)
      VALUES (${ruleId}, ${deviceId}, ${orgId}, ${severity}, ${title}, ${message},
        ${JSON.stringify(context ?? {})}::jsonb, ${monitorFields.monitorId}, ${episodeId ?? null},
        ${requiresHuman ?? false}, ${subjectKey ?? null}, 'active', now())
      ON CONFLICT (rule_id, device_id, COALESCE(subject_key, ''))
        WHERE rule_id IS NOT NULL AND status IN ('active', 'acknowledged', 'suppressed')
      DO NOTHING RETURNING id`);
    return row;
  };
  if (subjectKey !== undefined) {
    // All three writes share a savepoint AND the caller's outer commit. No
    // event or Redis write may escape before that outer transaction commits.
    return withDbTransaction(async () => {
      const newAlert = await insert();
      if (!newAlert) return null;
      const subjectEpisodeId = episodeId ?? (allocateSubjectEpisode ? await allocateSubjectEpisode() : null);
      const responsesOwner = subjectEpisodeId ? (await linkEpisodeAlert(subjectEpisodeId, newAlert.id)).owner : false;
      const pending: SubjectAlertDispatch = {
        eventId: newAlert.id, eventType: 'alert.triggered', siteId: await resolveDeviceSiteId(deviceId), cooldownMinutes,
        payload: { alertId: newAlert.id, ruleId, deviceId, severity, title, message,
          ...monitorFields, episodeId: subjectEpisodeId, subjectKey, responsesOwner },
      };
      await db.update(alerts).set({ episodeId: subjectEpisodeId, context: { ...context, _subjectDispatch: pending } })
        .where(eq(alerts.id, newAlert.id));
      return newAlert.id;
    });
  }
  const newAlert = await insert();
  if (!newAlert) return null;
  const published = await publishAlertTriggeredOrRollback({
    alertId: newAlert.id, orgId, deviceId, source: 'alert_rule', publisher: 'alert-service',
    siteId: await resolveDeviceSiteId(deviceId),
    payload: { alertId: newAlert.id, ruleId, deviceId, severity, title, message,
      ...monitorFields, subjectKey: null, responsesOwner: true },
  });
  if (!published) return null;
  await recordStateTransition(ruleId, deviceId, 'triggered');
  await setCooldown(ruleId, deviceId, cooldownMinutes, undefined);
  enqueueAlertCorrelationForDevice(orgId, deviceId);
  return newAlert.id;
}
```

- [ ] **Step 4: Protect recovery and adapt existing mocks.** Add the early return immediately after the initial alert lookup guard. Replace only the rule-backed noise-control calls in `resolveAlert`; config-policy calls retain their current identity.

```ts
// checkAutoResolve:
if (alert.subjectKey) return false;
// resolveAlert, current line 751:
await recordStateTransition(alert.ruleId, alert.deviceId, 'resolved', alert.subjectKey ?? undefined);
// resolveAlert, current line 791, AND the independent manual-resolution writers
// routes/alerts/alerts.ts:1083 and routes/mobile.ts:1249:
await setCooldown(alert.ruleId, alert.deviceId, cooldownMinutes, alert.subjectKey ?? undefined);
// alertService.test.ts dbMock object, alongside insert:
execute: vi.fn(() => Promise.resolve(insertReturnResults.shift() ?? [])),
// Replace the first correlation test's insert-count assertion only:
expect(dbMock.execute).toHaveBeenCalledTimes(1);
```

For subject recovery inside the locked sweep, extend `resolveAlert` with a fourth argument `deferSubjectEffects = false`, import `randomUUID` from `node:crypto`, and insert this branch immediately after its existing `if (!alert) return false` CAS guard. The default preserves legacy callers; Tasks 9 and 12 explicitly opt in for transactional subject recovery. Replace its signature with:

```ts
export async function resolveAlert(
  alertId: string,
  resolutionNote?: string,
  resolvedBy?: string,
  deferSubjectEffects = false,
): Promise<boolean> {
```

Keep its existing body and closing brace, inserting the following branch at the guard described above. A normal subject recovery commits its resolution and pending event together, cancels an undelivered trigger, and performs no Redis writes/publication in that transaction.

```ts
if (deferSubjectEffects && alert.subjectKey) {
  const [rule] = alert.ruleId
    ? await db.select().from(alertRules).where(eq(alertRules.id, alert.ruleId)).limit(1)
    : [];
  const [template] = rule
    ? await db.select().from(alertTemplates).where(eq(alertTemplates.id, rule.templateId)).limit(1)
    : [];
  const overrides = rule?.overrideSettings as Record<string, unknown> | null;
  const pending: SubjectAlertDispatch = {
    eventId: randomUUID(), eventType: 'alert.resolved',
    siteId: await resolveDeviceSiteId(alert.deviceId),
    cooldownMinutes: (overrides?.cooldownMinutes as number) ?? template?.cooldownMinutes ?? 15,
    payload: { alertId, ruleId: alert.ruleId, deviceId: alert.deviceId, subjectKey: alert.subjectKey, resolutionNote,
      resolvedAt: alert.resolvedAt!.toISOString(), resolvedBy: alert.resolvedBy,
      triggeredAt: alert.triggeredAt.toISOString() },
  };
  await db.update(alerts).set({ context: sql`jsonb_set(
    COALESCE(${alerts.context}, '{}'::jsonb) - '_subjectDispatch', '{_subjectResolutionDispatch}', ${JSON.stringify(pending)}::jsonb)` })
    .where(eq(alerts.id, alertId));
  return true;
}
```

Keep sourced-alert tests using `insert`; the raw insert is only the rule-backed path. Replace the existing rule cooldown assertion at `alertService.test.ts:292` with:

```ts
expect(vi.mocked(setCooldown)).toHaveBeenCalledWith('rule-1', 'device-1', 5, undefined);
```

Add this `execute` member to `dbMock` in `alertService.episodes.test.ts` and repeat the exact member in `alertService.networkCheck.test.ts`; their local SQL tag already captures `values`. This preserves their existing order and row-value assertions.

```ts
execute: vi.fn(async (statement: { values: unknown[] }) => {
  callOrder.push('createAlert.insert');
  const [ruleId, deviceId, orgId, severity, title, message, context, monitorId, episodeId, requiresHuman, subjectKey] = statement.values;
  insertedAlerts.push({ ruleId, deviceId, orgId, severity, title, message,
    context: JSON.parse(context as string), monitorId, episodeId, requiresHuman, subjectKey });
  return [{ id: 'alert-1' }];
}),
```

Add this regression inside the existing `alertService.episodes.test.ts` describe block; its fixtures exercise the real NULL-subject sweep and the retained post-publication catch:

```ts
it('keeps a published legacy alert when episode linking fails', async () => {
  pushSweepQueue({ triggered: true });
  linkEpisodeAlertMock.mockRejectedValueOnce(new Error('episode bookkeeping unavailable'));
  expect(await evaluateDeviceAlerts(DEVICE_ID)).toContain('alert-1');
  expect(insertedAlerts).toHaveLength(1);
  expect(linkEpisodeAlertMock).toHaveBeenCalledWith('episode-1', 'alert-1');
});
```

In both suites replace the `beforeEach` ownership mock with:

```ts
linkEpisodeAlertMock.mockResolvedValue({ owner: true });
```

- [ ] **Step 5: Prove both manual-resolution cooldown writers red, then green.** Add these tests before changing the two route calls in Step 4. The existing CAS-loser tests still assert no cooldown; config-policy assertions stay unchanged. Replace the existing web legacy assertion with `expect(setCooldown).toHaveBeenCalledWith('rule-1', 'device-1', 42, undefined)`.

```ts
// routes/alerts/alerts.resolveCas.test.ts, appended at top level:
it.each([null, 'disk:3'])('manual web resolution isolates subject %s', async subjectKey => {
  const row = { ...alertRow, ruleId: 'rule-1', subjectKey, status: 'active' };
  getAlertWithOrgCheck.mockResolvedValue(row);
  selectRows.push([{ id: 'rule-1', templateId: 'tpl-1', overrideSettings: { cooldownMinutes: 42 } }]);
  selectRows.push([{ id: 'tpl-1', cooldownMinutes: 15 }]);
  updateReturns.push([{ ...row, status: 'resolved' }]);
  expect((await resolveRequest()).status).toBe(200);
  expect(setCooldown).toHaveBeenCalledExactlyOnceWith('rule-1', 'device-1', 42, subjectKey ?? undefined);
});
```

```ts
// routes/mobile.resolveCas.test.ts, appended at top level:
it.each([null, 'disk:3'])('manual mobile resolution isolates subject %s', async subjectKey => {
  const row = { ...alertRow, ruleId: 'rule-1', subjectKey, status: 'active' };
  selectReturns[0] = [row];
  selectReturns.push([{ id: 'rule-1', templateId: 'tpl-1', overrideSettings: { cooldownMinutes: 42 } }]);
  selectReturns.push([{ id: 'tpl-1', cooldownMinutes: 15 }]);
  updateReturns.push([{ ...row, status: 'resolved' }]);
  expect((await resolveRequest()).status).toBe(200);
  expect(setCooldown).toHaveBeenCalledExactlyOnceWith('rule-1', 'device-1', 42, subjectKey ?? undefined);
});
```

```bash
rg -n 'setCooldown\(' apps/api/src/routes
cd apps/api && npx vitest run src/routes/alerts/alerts.resolveCas.test.ts src/routes/mobile.resolveCas.test.ts src/services/alertCooldown.subjects.test.ts
```

Expected red: both route calls omit argument four. Apply Step 4's four-argument call in both routes; rerun the same command for green. Task 6's real cooldown test proves the resulting disk key suppresses only that disk and leaves the legacy key unchanged.

- [ ] **Step 6: Run green and commit.** `cd apps/api && npx vitest run src/services/alertService.subjects.test.ts src/services/alertService.test.ts src/services/alertService.episodes.test.ts src/services/alertService.networkCheck.test.ts` — subject and existing sourced paths pass. Task 10 proves commit visibility, outbox rollback and publication compensation against PostgreSQL.

```bash
git add apps/api/src/routes/alerts/alerts.ts apps/api/src/routes/mobile.ts apps/api/src/routes/alerts/alerts.resolveCas.test.ts apps/api/src/routes/mobile.resolveCas.test.ts apps/api/src/services/alertService.ts apps/api/src/services/alertService.test.ts apps/api/src/services/alertService.episodes.test.ts apps/api/src/services/alertService.networkCheck.test.ts apps/api/src/services/alertService.subjects.test.ts
git commit -m $'feat(alerts): atomically insert and publish subject alerts\n\nCo-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>'
```

### Task 9: Reconcile per-subject alerts and derive the final observation

**Files:** Modify `apps/api/src/services/monitors/episodeService.ts`, `apps/api/src/services/monitors/episodeService.test.ts`; Create `apps/api/src/services/alertSubjects.ts`; Create/Test `apps/api/src/services/alertSubjects.test.ts`.
**Interfaces:** Consumes `RuleWithTemplate['rule'/'template'/'monitor']`, device row, and `EvaluationResult`; produces `evaluateSubjectAlerts({ rule, template, device, monitor, evidence }): Promise<MonitorObservation>`. Decision: `evidence` additionally carries `createdAlertIds: string[]`, the caller-owned accumulator preserving `evaluateDeviceAlerts(): Promise<string[]>` without widening the contract's return type.

- [ ] **Step 1: Write the lifecycle matrix.**

```ts
import { beforeEach, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({ open: [] as any[], create: vi.fn(), resolve: vi.fn(), allocate: vi.fn(), record: vi.fn() }));
vi.mock('../db', () => ({ db: { select: () => ({ from: () => ({ where: async () => [...m.open] }) }) } }));
vi.mock('./alertService', () => ({ RESOLVABLE_ALERT_STATUSES: ['active','acknowledged','suppressed'], createAlert: m.create, resolveAlert: m.resolve }));
vi.mock('./monitors/episodeService', () => ({ allocateSubjectEpisode: m.allocate, recordMonitorEvaluation: m.record }));
vi.mock('./monitors/escalationLatch', () => ({ fireEscalationLatch: vi.fn() }));
import { evaluateSubjectAlerts } from './alertSubjects';
const rule = { id: 'rule', name: 'Disk health', overrideSettings: null, managedByMonitorId: 'monitor' };
const template = { id: 'template', severity: 'high', autoResolve: true, cooldownMinutes: 60,
  autoResolveConditions: { type: 'offline' }, titleTemplate: '{{componentLabel}} {{stateLabel}} on {{deviceName}}', messageTemplate: '{{stateDetail}}' };
function input(statuses: Record<string, string>, autoResolve = true) {
  return { rule: { ...rule, overrideSettings: { autoResolve } }, template,
    device: { id: 'device', orgId: 'device-org', hostname: 'server' }, monitor: { id: 'monitor', kind: 'hardware_health' },
    evidence: { dataState: 'ok', subjects: Object.entries(statuses).map(([subjectKey, status]) => ({ subjectKey, status,
      description: status, context: { componentLabel: subjectKey, stateLabel: 'failed', stateDetail: 'Failed' } })), createdAlertIds: [] } } as any;
}
beforeEach(() => {
  vi.clearAllMocks(); m.open = [];
  m.allocate.mockResolvedValue('episode');
  m.create.mockImplementation(async (p: any) => {
    if (m.open.some(a => a.subjectKey === p.subjectKey)) return null;
    if (p.allocateSubjectEpisode) await p.allocateSubjectEpisode();
    m.open.push({ id: p.subjectKey, subjectKey: p.subjectKey, status: 'active', requiresHuman: false }); return p.subjectKey;
  });
  m.resolve.mockImplementation(async (id: string) => { m.open = m.open.filter(a => a.id !== id); return true; });
});
it('creates two subjects; acknowledging one never blocks its sibling', async () => {
  expect(await evaluateSubjectAlerts(input({ a: 'breaching' }))).toBe('breach');
  m.open[0]!.status = 'acknowledged';
  const second = input({ a: 'breaching', b: 'breaching' });
  expect(await evaluateSubjectAlerts(second)).toBe('breach');
  expect(m.open).toHaveLength(2); expect(second.evidence.createdAlertIds).toEqual(['b']);
  expect(m.create).toHaveBeenLastCalledWith(expect.objectContaining({ orgId: 'device-org', subjectKey: 'b', allocateSubjectEpisode: expect.any(Function) }));
});
it.each(['active','acknowledged','suppressed'])('recovers only its own %s alert', async status => {
  m.open = [{ id: 'a', subjectKey: 'a', status }, { id: 'b', subjectKey: 'b', status: 'active' }];
  expect(await evaluateSubjectAlerts(input({ a: 'recovered', b: 'unknown' }))).toBe('breach');
  expect(m.resolve).toHaveBeenCalledWith('a', 'Auto-resolved: recovered', undefined, true); expect(m.open.map(a => a.id)).toEqual(['b']);
});
it.each(['unknown','absent','autoResolveOff','requiresHuman'])('%s preserves open alert and episode', async variant => {
  m.open = [{ id: 'a', subjectKey: 'a', status: 'active', requiresHuman: variant === 'requiresHuman' }];
  const arg = input(variant === 'absent' ? {} : { a: variant === 'unknown' ? 'unknown' : 'recovered' }, variant !== 'autoResolveOff');
  expect(await evaluateSubjectAlerts(arg)).toBe('breach'); expect(m.resolve).not.toHaveBeenCalled();
});
it('no open alerts means unknown for missing evidence; observed recovery means ok', async () => {
  expect(await evaluateSubjectAlerts(input({ a: 'unknown' }))).toBe('unknown');
  const arg = input({}); arg.evidence.dataState = 'unknown';
  expect(await evaluateSubjectAlerts(arg)).toBe('unknown');
  expect(await evaluateSubjectAlerts(input({ a: 'recovered' }))).toBe('ok');
});
```

- [ ] **Step 2: Run red.** `cd apps/api && npx vitest run src/services/alertSubjects.test.ts` — missing module.
- [ ] **Step 3: Implement the complete reconciler.** It must be called under the sweep transaction/lock in Task 10. `autoResolveConditions` is deliberately never read. Open alerts with absent evidence continue the episode.

```ts
import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import { interpolateAlertTemplate } from '@breeze/shared';
import { db } from '../db';
import { alerts, devices } from '../db/schema';
import { createAlert, resolveAlert, RESOLVABLE_ALERT_STATUSES, type RuleWithTemplate } from './alertService';
import type { EvaluationResult } from './alertConditions/types';
import { allocateSubjectEpisode, type MonitorObservation } from './monitors/episodeService';
export interface SubjectAlertInput {
  rule: RuleWithTemplate['rule'];
  template: RuleWithTemplate['template'];
  device: typeof devices.$inferSelect;
  monitor: RuleWithTemplate['monitor'];
  evidence: EvaluationResult & { createdAlertIds: string[] };
}
export async function evaluateSubjectAlerts({ rule, template, device, monitor, evidence }: SubjectAlertInput): Promise<MonitorObservation> {
  const subjects = evidence.subjects ?? [];
  const overrides = rule.overrideSettings as Record<string, unknown> | null;
  const severity = (overrides?.severity as RuleWithTemplate['effectiveSeverity']) ?? template.severity;
  const autoResolve = (overrides?.autoResolve as boolean) ?? template.autoResolve;
  const allocateEpisode = monitor
    ? () => allocateSubjectEpisode({ monitor, deviceId: device.id, orgId: device.orgId })
    : undefined;
  for (const subject of subjects) {
    if (subject.status !== 'breaching') continue;
    const context = { ...evidence.context, ...subject.context, source: 'hardware_health', subjectKey: subject.subjectKey,
      deviceName: device.displayName || device.hostname, hostname: device.hostname, osType: device.osType,
      osVersion: device.osVersion, ruleName: rule.name, severity, actualValue: subject.actualValue,
      templateId: template.id, cooldownMinutes: (overrides?.cooldownMinutes as number) ?? template.cooldownMinutes };
    const id = await createAlert({ ruleId: rule.id, deviceId: device.id, orgId: device.orgId, subjectKey: subject.subjectKey,
      severity, title: interpolateAlertTemplate(template.titleTemplate, context), message: interpolateAlertTemplate(template.messageTemplate, context),
      context, monitorId: rule.managedByMonitorId, kind: monitor?.kind, allocateSubjectEpisode: allocateEpisode });
    if (id) evidence.createdAlertIds.push(id);
  }
  const open = () => db.select().from(alerts).where(and(
    eq(alerts.ruleId, rule.id), eq(alerts.deviceId, device.id), isNotNull(alerts.subjectKey),
    inArray(alerts.status, [...RESOLVABLE_ALERT_STATUSES]),
  ));
  if (autoResolve) {
    const byKey = new Map(subjects.map(s => [s.subjectKey, s]));
    for (const alert of await open()) {
      const subject = byKey.get(alert.subjectKey!);
      if (!alert.requiresHuman && subject?.status === 'recovered') {
        await resolveAlert(alert.id, `Auto-resolved: ${subject.description}`, undefined, true);
      }
    }
  }
  if ((await open()).length > 0) return 'breach';
  if (evidence.dataState === 'unknown' || subjects.some(s => s.status === 'unknown')) return 'unknown';
  return 'ok';
}
```

- [ ] **Step 4: Allocate without observing; adopt the allocation only at the final breach.** Add this helper in `episodeService.ts`. It uses the same state lock and open-episode index as the existing state machine but changes neither `lastState`, the recurrence count, nor the pause latch. Task 8 calls it only after noise admission and successful insertion, under Task 10's outer transaction. A rollback removes both the new alert and allocation.

```ts
export async function allocateSubjectEpisode(
  input: Pick<RecordEvaluationInput, 'monitor' | 'deviceId' | 'orgId' | 'now'>,
): Promise<string> {
  return db.transaction(async tx => {
    await tx.insert(monitorDeviceState).values({
      monitorId: input.monitor.id, deviceId: input.deviceId, orgId: input.orgId,
    }).onConflictDoNothing({ target: [monitorDeviceState.monitorId, monitorDeviceState.deviceId] });
    await tx.select().from(monitorDeviceState).where(and(
      eq(monitorDeviceState.monitorId, input.monitor.id), eq(monitorDeviceState.deviceId, input.deviceId),
    )).for('update');
    const [created] = await tx.insert(monitorEpisodes).values({
      monitorId: input.monitor.id, deviceId: input.deviceId, orgId: input.orgId,
      startedAt: input.now ?? new Date(),
    }).onConflictDoNothing().returning({ id: monitorEpisodes.id });
    if (created) return created.id;
    const [open] = await tx.select({ id: monitorEpisodes.id }).from(monitorEpisodes).where(and(
      eq(monitorEpisodes.monitorId, input.monitor.id), eq(monitorEpisodes.deviceId, input.deviceId),
      isNull(monitorEpisodes.endedAt),
    )).limit(1);
    if (!open) throw new Error('Subject episode allocation lost its open episode');
    return open.id;
  });
}
```

In `recordMonitorEvaluation`, replace the entire block from `let episodeId: string | null = null` through its insertion `try/catch` (ending immediately before `const threshold`) with this code. Remove the now-unused `UNIQUE_VIOLATION` and `isUniqueViolation`. The pre-existing `openEpisodeId` branch stays unchanged: established episodes count once. An allocated episode has no `currentEpisodeId` yet, so the **single final admitted breach** adopts it and runs the existing recurrence-window/reset-floor/latch calculation exactly once.

```ts
    const [inserted] = await tx.insert(monitorEpisodes).values({
      monitorId: input.monitor.id, deviceId: input.deviceId, orgId: input.orgId, startedAt: now,
    }).onConflictDoNothing().returning({ id: monitorEpisodes.id });
    let episodeId: string | null = inserted?.id ?? null;
    if (!episodeId) {
      const [existing] = await tx.select({ id: monitorEpisodes.id }).from(monitorEpisodes).where(and(
        eq(monitorEpisodes.monitorId, input.monitor.id), eq(monitorEpisodes.deviceId, input.deviceId),
        isNull(monitorEpisodes.endedAt),
      )).limit(1);
      episodeId = existing?.id ?? null;
    }
    if (!episodeId) throw new Error('Admitted breach has no open episode');
    const episodeOpened = Boolean(inserted);
```

Update the existing episode-service conflict regression to model `ON CONFLICT DO NOTHING` returning no row rather than throwing `23505`. Replace that complete test with this one; retain the existing connection-error test and every recurrence/reset/pause test.

```ts
it('adopts the existing episode without recording an extra insertion', async () => {
  state.selectRows = [[stateRow()], [{ id: EPISODE }]];
  state.insertRows = [[], []];
  const result = await recordMonitorEvaluation({
    monitor: monitor(), deviceId: DEVICE, orgId: ORG, observation: 'breach',
  });
  expect(result.episodeId).toBe(EPISODE);
  expect(result.episodeOpened).toBe(false);
  expect(state.inserts[1]!.some(call => call.method === 'onConflictDoNothing')).toBe(true);
});
```

Replace the opening service comment's pre-alert/noise-control paragraph with the first block and its obsolete caught-23505 paragraph with the second:

```ts
 * Legacy monitors record their observation before alert creation. Hardware
 * subjects allocate only after an alert passes noise admission and wins its
 * insert; allocation writes no observation. The sweep records one final
 * observation from admitted open alerts, then activates recurrence and pause.
```

```ts
 * State changes serialize under SELECT FOR UPDATE on monitor_device_state.
 * Episode insertion uses ON CONFLICT DO NOTHING against the one-open-episode
 * index; an existing allocation is read back without aborting the transaction.
 * Only the final breach observation activates an allocated subject episode.
```


Append this unit regression before implementing the helper and reconciler; run it red with Step 2, then green with Step 5. Task 10 adds the real recurrence, all-cooldown, all-flapping, partial-admission and rollback proof.

```ts
it('never records a provisional breach when every subject is suppressed', async () => {
  m.create.mockResolvedValue(null);
  const arg = input({ a: 'breaching', b: 'breaching' });
  expect(await evaluateSubjectAlerts(arg)).toBe('ok');
  expect(arg.evidence.createdAlertIds).toEqual([]);
  expect(m.allocate).not.toHaveBeenCalled();
  expect(m.record).not.toHaveBeenCalled();
});
```

- [ ] **Step 5: Run green.** `cd apps/api && npx vitest run src/services/alertSubjects.test.ts src/services/monitors/episodeService.test.ts` — independent creation/recovery and open-alert observation matrix pass.
- [ ] **Step 6: Commit.**

```bash
git add apps/api/src/services/monitors/episodeService.ts apps/api/src/services/monitors/episodeService.test.ts apps/api/src/services/alertSubjects.ts apps/api/src/services/alertSubjects.test.ts
git commit -m $'feat(alerts): reconcile component subjects independently\n\nCo-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>'
```

### Task 10: Commit subject ownership and outbox before publication

**Files:** Modify `apps/api/migrations/2026-10-27-100300-alert-subject-key.sql`, `apps/api/src/db/schema/monitorEpisodes.ts`, `apps/api/src/services/tenantExportPolicyRegistry.ts`, `apps/api/src/services/automationRuntime.ts`, `apps/api/src/jobs/automationWorker.ts`; Create `apps/api/src/services/subjectResponseOutbox.ts`; Modify `apps/api/src/services/alertService.ts:12,1095,1194`, `apps/api/vitest.integration.config.ts:13`, `apps/api/vitest.config.ts:18`; Create `apps/api/src/services/subjectAlertOutbox.ts`; Modify `apps/api/src/jobs/alertWorker.ts:122,170`, `apps/api/src/jobs/alertWorker.test.ts`, `apps/api/src/jobs/alertQueue.test.ts`; Create/Test `apps/api/src/services/alertSubjects.integration.test.ts`.
**Interfaces:** Adds atomic `admitSubjectResponse` and `drainSubjectResponseOutbox`; episode `responsesAdmittedAt` is never reset, and `responseDispatch` stages a committed run for delivery. Consumes `withDbTransaction<T>(fn: () => Promise<T>): Promise<T>` (`db/index.ts:946`), `evaluateSubjectAlerts`, and `recordMonitorEvaluation(input: RecordEvaluationInput): Promise<RecordEvaluationResult>`. Preserves `evaluateDeviceAlerts(deviceId: string): Promise<string[]>`; leaves `evaluateDeviceAlertsFromPolicy` unchanged. Adds `drainSubjectAlertOutbox(deviceId?: string): Promise<void>`, called with no ambient database context. `_subjectDispatch` is durable in the existing RLS-protected alerts row and commits with the episode owner; this is a transactional outbox, not an in-memory callback list. `withDbTransaction` alone is a savepoint, not a commit.

- [ ] **Step 1: Write the real database fixture and failing sweep/race tests.** Only external publication, correlation, policy selection and noise controls are stubbed; alerts, components, episodes, RLS and all lifecycle writes use real PostgreSQL.

```ts
import '../__tests__/integration/setup';
import { getTestDb } from '../__tests__/integration/setup';
import { createPartner, createOrganization, createSite } from '../__tests__/integration/db-utils';
import { randomUUID } from 'node:crypto';
import { beforeEach, expect, it, vi } from 'vitest';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db, hasDbAccessContext, withDbAccessContext, withSystemDbAccessContext } from '../db';
import { alerts, alertRules, alertTemplates, devices, monitorDefinitions, monitorEpisodes, monitorDeviceState,
  deviceHardwareHealth, deviceHardwareComponents, automations, automationRuns } from '../db/schema';
const m = vi.hoisted(() => ({ publish: vi.fn(), monitorId: '', notify: vi.fn(), queue: vi.fn(), flap: vi.fn(), cooling: vi.fn(), cooldown: vi.fn(), failAck: false, processor: null as null | ((job: any) => Promise<any>) }));
vi.mock('./eventBus', async original => ({ ...await original<typeof import('./eventBus')>(), publishEvent: m.publish }));
vi.mock('../jobs/alertCorrelation', () => ({ enqueueAlertCorrelation: vi.fn().mockResolvedValue('correlation-job') }));
vi.mock('./alertCooldown', async original => ({ ...await original<typeof import('./alertCooldown')>(),
  isCooldownActive: m.cooling, isFlapping: m.flap, setCooldown: m.cooldown, recordStateTransition: async () => {} }));
vi.mock('./monitors/monitorResolver', () => ({ resolveMonitorsForDevice: async () => ({ kind: 'resolved', monitors: [
  { monitorId: m.monitorId, enabled: true, overrides: null, sourcePolicyId: 'test', sourceLevel: 'device', inheritedFromParent: false },
] }) }));
import { createAlert, evaluateDeviceAlerts } from './alertService';
import { drainSubjectAlertOutbox } from './subjectAlertOutbox';
import { recordMonitorEvaluation } from './monitors/episodeService';
beforeEach(() => { vi.clearAllMocks(); m.failAck = false; m.queue.mockReset().mockResolvedValue({ id: 'queued' }); m.cooling.mockReset().mockResolvedValue(false); m.publish.mockResolvedValue(undefined); m.flap.mockReset().mockResolvedValue(false); m.cooldown.mockReset().mockResolvedValue(undefined); });
async function fixture() {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const site = await createSite({ orgId: org.id });
  return withSystemDbAccessContext(async () => {
    const [device] = await db.insert(devices).values({ orgId: org.id, siteId: site.id, agentId: randomUUID(),
      hostname: 'hardware-test', osType: 'windows', osVersion: '1', architecture: 'amd64', agentVersion: '1', status: 'online' }).returning();
    if (!device) throw new Error('Device seed failed');
    const condition = { componentTypes: ['physical_disk'], minHealth: 'critical', includePredictiveFailure: true, consecutiveSnapshots: 2 };
    const [monitor] = await db.insert(monitorDefinitions).values({ partnerId: partner.id, name: 'Hardware test', kind: 'hardware_health',
      condition, severity: 'high', autoResolve: true, deliveryMode: 'none' }).returning();
    if (!monitor) throw new Error('Monitor seed failed');
    m.monitorId = monitor.id;
    const [template] = await db.insert(alertTemplates).values({ partnerId: partner.id, name: 'Hardware test',
      conditions: { type: 'hardware_health', ...condition }, severity: 'high', autoResolve: true,
      titleTemplate: '{{componentLabel}} {{stateLabel}} on {{deviceName}}', messageTemplate: '{{stateDetail}}', managedByMonitorId: monitor.id }).returning();
    if (!template) throw new Error('Template seed failed');
    const [rule] = await db.insert(alertRules).values({ partnerId: partner.id, templateId: template.id, name: 'Hardware test',
      targetType: 'monitor', targetId: monitor.id, managedByMonitorId: monitor.id }).returning();
    if (!rule) throw new Error('Rule seed failed');
    await db.insert(deviceHardwareHealth).values({ deviceId: device.id, orgId: org.id, pollIntervalMinutes: 10, diskHealthIntervalMinutes: 60 });
    await db.insert(deviceHardwareComponents).values(['a','b'].map(key => ({ deviceId: device.id, orgId: org.id, componentKey: key,
      componentType: 'physical_disk' as const, source: 'storcli' as const, name: key, health: 'critical' as const,
      state: 'failed', criticalStreak: 2, unhealthyStreak: 2, firstSeenAt: new Date(), lastSeenAt: new Date() })));
    return { partner, org, device, monitor, rule, template };
  });
}
async function alertRows(deviceId: string) {
  return withSystemDbAccessContext(() => db.select().from(alerts).where(eq(alerts.deviceId, deviceId)));
}
it('sweep creates two alerts, keeps acknowledged sibling, and resolves only recovered subject', async () => {
  const f = await fixture();
  const ids = await withSystemDbAccessContext(() => evaluateDeviceAlerts(f.device.id));
  expect(ids).toHaveLength(2);
  const first = (await alertRows(f.device.id)).find(a => a.subjectKey === 'a')!;
  await withSystemDbAccessContext(async () => {
    await db.update(alerts).set({ status: 'acknowledged' }).where(eq(alerts.id, first.id));
    await db.update(deviceHardwareComponents).set({ health: 'ok', state: 'online', criticalStreak: 0, unhealthyStreak: 0,
      healthyStreak: 2, belowCriticalStreak: 2 }).where(and(eq(deviceHardwareComponents.deviceId, f.device.id), eq(deviceHardwareComponents.componentKey, 'b')));
    await evaluateDeviceAlerts(f.device.id);
  });
  expect((await alertRows(f.device.id)).map(a => [a.subjectKey,a.status]).sort()).toEqual([['a','acknowledged'],['b','resolved']]);
  const [episode] = await withSystemDbAccessContext(() => db.select().from(monitorEpisodes).where(eq(monitorEpisodes.monitorId, f.monitor.id)));
  expect(episode!.endedAt).toBeNull();
  await withSystemDbAccessContext(async () => {
    await db.update(deviceHardwareComponents).set({ health: 'unknown' }).where(eq(deviceHardwareComponents.deviceId, f.device.id));
    await evaluateDeviceAlerts(f.device.id);
  });
  expect((await alertRows(f.device.id)).find(a => a.subjectKey === 'a')?.status).toBe('acknowledged');
});
it('autoResolve off preserves recovered subjects, and exempt/stale rows never alert', async () => {
  const f = await fixture();
  await withSystemDbAccessContext(async () => {
    await db.update(deviceHardwareComponents).set({ alertExempt: true }).where(and(
      eq(deviceHardwareComponents.deviceId, f.device.id), eq(deviceHardwareComponents.componentKey, 'b')));
    expect(await evaluateDeviceAlerts(f.device.id)).toHaveLength(1);
    await db.update(alertRules).set({ overrideSettings: { autoResolve: false } }).where(eq(alertRules.id, f.rule.id));
    await db.update(deviceHardwareComponents).set({ health: 'ok', state: 'online', criticalStreak: 0,
      unhealthyStreak: 0, healthyStreak: 2, belowCriticalStreak: 2 }).where(eq(deviceHardwareComponents.deviceId, f.device.id));
    await evaluateDeviceAlerts(f.device.id);
  });
  expect((await alertRows(f.device.id)).map(a => a.status)).toEqual(['active']);
  await withSystemDbAccessContext(async () => {
    await db.update(alertRules).set({ overrideSettings: { autoResolve: true } }).where(eq(alertRules.id, f.rule.id));
    await db.update(deviceHardwareComponents).set({ stale: true }).where(eq(deviceHardwareComponents.deviceId, f.device.id));
    await evaluateDeviceAlerts(f.device.id);
  });
  expect((await alertRows(f.device.id)).map(a => a.status)).toEqual(['active']);
});
it.each(['disk:race', undefined])('concurrent createAlert collapses subject %s to one row', async subjectKey => {
  const f = await fixture();
  const args = { ruleId: f.rule.id, deviceId: f.device.id, orgId: f.org.id, monitorId: f.monitor.id,
    kind: 'hardware_health' as const, severity: 'high' as const, title: 'Failure', message: 'Failure', subjectKey };
  let arrivals = 0; let release!: () => void;
  const bothPassedDedupe = new Promise<void>(resolve => { release = resolve; });
  m.flap.mockImplementation(async () => {
    if (++arrivals === 2) release();
    await bothPassedDedupe; return false;
  });
  const ids = await Promise.all([withSystemDbAccessContext(() => createAlert(args)), withSystemDbAccessContext(() => createAlert(args))]);
  expect(ids.filter(Boolean)).toHaveLength(1);
  expect(await alertRows(f.device.id)).toHaveLength(1);
  await drainSubjectAlertOutbox(f.device.id);
  expect(m.publish.mock.calls.filter(c => c[0] === 'alert.triggered')).toHaveLength(1);
});
it('publishes only after commit and subscribers can read the owner', async () => {
  const f = await fixture();
  await withSystemDbAccessContext(async () => {
    expect(await evaluateDeviceAlerts(f.device.id)).toHaveLength(2);
    expect(m.publish).not.toHaveBeenCalled(); expect(m.cooldown).not.toHaveBeenCalled();
    await expect(drainSubjectAlertOutbox(f.device.id)).rejects.toThrow('must run after commit');
  });
  m.publish.mockImplementation(async (_type, _orgId, payload) => {
    // The dispatcher has no ambient transaction: this opens another connection.
    const row = (await alertRows(f.device.id)).find(a => a.id === payload.alertId);
    expect(row).toBeDefined();
    const [episode] = await withSystemDbAccessContext(() => db.select().from(monitorEpisodes)
      .where(eq(monitorEpisodes.id, row!.episodeId!)));
    expect(payload.responsesOwner).toBe(episode!.alertId === row!.id);
  });
  await Promise.all([drainSubjectAlertOutbox(f.device.id), drainSubjectAlertOutbox(f.device.id)]);
  expect(m.publish).toHaveBeenCalledTimes(2);
  expect(m.cooldown).toHaveBeenCalledTimes(2);
});
it('outer rollback discards alerts, ownership and pending publication together', async () => {
  const f = await fixture();
  await expect(withSystemDbAccessContext(async () => {
    await evaluateDeviceAlerts(f.device.id);
    throw new Error('later transaction failure');
  })).rejects.toThrow('later transaction failure');
  await drainSubjectAlertOutbox(f.device.id);
  expect(await alertRows(f.device.id)).toEqual([]);
  const episodes = await withSystemDbAccessContext(() => db.select().from(monitorEpisodes)
    .where(eq(monitorEpisodes.monitorId, f.monitor.id)));
  expect(episodes).toEqual([]);
  expect(m.publish).not.toHaveBeenCalled(); expect(m.cooldown).not.toHaveBeenCalled();
});
it('failed publication deletes only its alert and releases only its ownership claim', async () => {
  const f = await fixture();
  await withSystemDbAccessContext(() => evaluateDeviceAlerts(f.device.id));
  const rows = await alertRows(f.device.id);
  const [episode] = await withSystemDbAccessContext(() => db.select().from(monitorEpisodes)
    .where(eq(monitorEpisodes.monitorId, f.monitor.id)));
  const failedId = episode!.alertId;
  m.publish.mockImplementation(async (_type, _orgId, payload) => {
    if (payload.alertId === failedId) throw new Error('transport unavailable');
  });
  await drainSubjectAlertOutbox(f.device.id);
  expect((await alertRows(f.device.id)).map(a => a.id)).toEqual(rows.filter(a => a.id !== failedId).map(a => a.id));
  const [after] = await withSystemDbAccessContext(() => db.select().from(monitorEpisodes)
    .where(eq(monitorEpisodes.id, episode!.id)));
  expect(after!.alertId).toBeNull(); expect(m.cooldown).toHaveBeenCalledTimes(1);
});
it('a Redis failure after publication cannot undo alerts or ownership', async () => {
  const f = await fixture();
  await withSystemDbAccessContext(() => evaluateDeviceAlerts(f.device.id));
  const before = await alertRows(f.device.id);
  m.cooldown.mockRejectedValue(new Error('Redis unavailable'));
  await drainSubjectAlertOutbox(f.device.id);
  expect((await alertRows(f.device.id)).map(a => a.id).sort()).toEqual(before.map(a => a.id).sort());
  const [episode] = await withSystemDbAccessContext(() => db.select().from(monitorEpisodes)
    .where(eq(monitorEpisodes.monitorId, f.monitor.id)));
  expect(before.map(a => a.id)).toContain(episode!.alertId);
  await drainSubjectAlertOutbox(f.device.id);
  expect(m.publish).toHaveBeenCalledTimes(2);
});
it('recovery before dispatch cancels triggers and retries only committed resolved events', async () => {
  const f = await fixture();
  await withSystemDbAccessContext(() => evaluateDeviceAlerts(f.device.id));
  await withSystemDbAccessContext(async () => {
    await db.update(deviceHardwareComponents).set({ health: 'ok', state: 'online', criticalStreak: 0,
      unhealthyStreak: 0, healthyStreak: 2, belowCriticalStreak: 2 }).where(eq(deviceHardwareComponents.deviceId, f.device.id));
    await evaluateDeviceAlerts(f.device.id);
    expect(m.publish).not.toHaveBeenCalled(); expect(m.cooldown).not.toHaveBeenCalled();
  });
  m.publish.mockRejectedValue(new Error('transport unavailable'));
  await drainSubjectAlertOutbox(f.device.id);
  expect(m.publish.mock.calls.every(call => call[0] === 'alert.resolved')).toBe(true);
  expect((await alertRows(f.device.id)).map(a => a.status)).toEqual(['resolved', 'resolved']);
  expect(m.cooldown).not.toHaveBeenCalled();
  m.publish.mockClear().mockResolvedValue(undefined);
  await drainSubjectAlertOutbox(f.device.id);
  expect(m.publish).toHaveBeenCalledTimes(2);
  expect(m.cooldown).toHaveBeenCalledTimes(2);
});
it.each([false, true])('hardware recurrence never publishes before commit; rollback=%s', async rollback => {
  const f = await fixture();
  await withSystemDbAccessContext(async () => {
    await db.update(monitorDefinitions).set({ recurrenceThreshold: 2, recurrenceWindowHours: 24 })
      .where(eq(monitorDefinitions.id, f.monitor.id));
    await db.insert(monitorEpisodes).values({ monitorId: f.monitor.id, deviceId: f.device.id, orgId: f.org.id,
      startedAt: new Date(Date.now() - 3600_000), endedAt: new Date(Date.now() - 1800_000), endReason: 'recovered' });
  });
  const transaction = withSystemDbAccessContext(async () => {
    await evaluateDeviceAlerts(f.device.id);
    expect(m.publish).not.toHaveBeenCalled();
    if (rollback) throw new Error('rollback recurrence');
  });
  if (rollback) await expect(transaction).rejects.toThrow('rollback recurrence');
  else await transaction;
  await drainSubjectAlertOutbox(f.device.id);
  const events = m.publish.mock.calls.filter(call => call[0] === 'alert.triggered').map(call => call[2]);
  expect(events).toHaveLength(rollback ? 0 : 3);
  if (!rollback) {
    const escalation = events.filter(payload => payload.requiresHuman === true);
    expect(escalation).toHaveLength(1);
    const [state] = await withSystemDbAccessContext(() => db.select().from(monitorDeviceState)
      .where(and(eq(monitorDeviceState.monitorId, f.monitor.id), eq(monitorDeviceState.deviceId, f.device.id))));
    expect(state!.escalationAlertId).toBe(escalation[0]!.alertId);
    expect(state!.responsesPaused).toBe(true);
  }
  await drainSubjectAlertOutbox(f.device.id);
  expect(m.publish).toHaveBeenCalledTimes(rollback ? 0 : 3);
});
it.each(['cooldown', 'flapping'])('suppressed %s sweeps never create recurrence or pause', async gate => {
  const f = await fixture();
  await withSystemDbAccessContext(() => db.update(monitorDefinitions)
    .set({ recurrenceThreshold: 2, recurrenceWindowHours: 24, pauseResponsesOnEscalation: true })
    .where(eq(monitorDefinitions.id, f.monitor.id)));
  (gate === 'cooldown' ? m.cooling : m.flap).mockResolvedValue(true);
  for (let i = 0; i < 4; i++) {
    expect(await withSystemDbAccessContext(() => evaluateDeviceAlerts(f.device.id))).toEqual([]);
  }
  await withSystemDbAccessContext(async () => {
    expect(await db.select().from(monitorEpisodes).where(eq(monitorEpisodes.monitorId, f.monitor.id))).toEqual([]);
    const [state] = await db.select().from(monitorDeviceState).where(eq(monitorDeviceState.monitorId, f.monitor.id));
    expect(state).toMatchObject({ currentEpisodeId: null, episodesInWindow: 0, escalatedAt: null,
      responsesPaused: false, lastState: 'ok' });
  });
  await drainSubjectAlertOutbox(f.device.id);
  expect(m.publish).not.toHaveBeenCalled();
  m.cooling.mockResolvedValue(false); m.flap.mockResolvedValue(false);
  expect(await withSystemDbAccessContext(() => evaluateDeviceAlerts(f.device.id))).toHaveLength(2);
  await withSystemDbAccessContext(async () => {
    const episodes = await db.select().from(monitorEpisodes).where(eq(monitorEpisodes.monitorId, f.monitor.id));
    expect(episodes).toHaveLength(1);
    const [state] = await db.select().from(monitorDeviceState).where(eq(monitorDeviceState.monitorId, f.monitor.id));
    expect(state).toMatchObject({ episodesInWindow: 1, responsesPaused: false, lastState: 'breach' });
  });
});
it('partial admission counts one episode; suppressed siblings and repeated sweeps add none', async () => {
  const f = await fixture();
  await withSystemDbAccessContext(() => db.update(monitorDefinitions)
    .set({ recurrenceThreshold: 2, recurrenceWindowHours: 24, pauseResponsesOnEscalation: true })
    .where(eq(monitorDefinitions.id, f.monitor.id)));
  m.cooling.mockImplementation(async (_rule, _device, subject) => subject === 'b');
  expect(await withSystemDbAccessContext(() => evaluateDeviceAlerts(f.device.id))).toHaveLength(1);
  await withSystemDbAccessContext(() => evaluateDeviceAlerts(f.device.id));
  m.cooling.mockResolvedValue(false);
  expect(await withSystemDbAccessContext(() => evaluateDeviceAlerts(f.device.id))).toHaveLength(1);
  await withSystemDbAccessContext(async () => {
    expect(await db.select().from(monitorEpisodes).where(eq(monitorEpisodes.monitorId, f.monitor.id))).toHaveLength(1);
    const [state] = await db.select().from(monitorDeviceState).where(eq(monitorDeviceState.monitorId, f.monitor.id));
    expect(state).toMatchObject({ episodesInWindow: 1, responsesPaused: false, lastState: 'breach' });
  });
});
it('subject queries cannot read another organization under app RLS', async () => {
  const f = await fixture();
  await withSystemDbAccessContext(() => evaluateDeviceAlerts(f.device.id));
  const outsider = await createOrganization({ partnerId: f.partner.id });
  const rows = await withDbAccessContext({ scope: 'organization', orgId: outsider.id, accessibleOrgIds: [outsider.id],
    accessiblePartnerIds: [], currentPartnerId: f.partner.id, userId: null }, () => db.select().from(alerts).where(eq(alerts.deviceId, f.device.id)));
  expect(rows).toEqual([]);
});
```

Add this exact string to integration `include` and unit `exclude`:

```ts
'src/services/alertSubjects.integration.test.ts',
```

- [ ] **Step 2: Run red.** `cd apps/api && npx vitest run -c vitest.integration.config.ts src/services/alertSubjects.integration.test.ts` — first fails on the missing outbox module; after adding it, the unwired sweep creates one NULL-subject alert instead of two. The commit-boundary tests must fail against immediate publication. Race tests also exercise Task 8's real raw SQL.
- [ ] **Step 3: Wire the subject branch immediately after evaluation at line 1095, before the existing episode block.** Import `withDbTransaction` from `../db` and `evaluateSubjectAlerts` from `./alertSubjects`. Take a transaction advisory lock before re-reading evidence so concurrent sweeps cannot close an episode between another sweep's creation and ownership claim. The lock namespace is internal, not a Redis key or public contract.

```ts
if (result.subjects !== undefined) {
  if (rule.managedByMonitorId) evaluatedMonitorIds.add(rule.managedByMonitorId);
  const subjectAlertIds: string[] = [];
  await withDbTransaction(async () => {
    await db.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`hardware-subject:${rule.id}:${deviceId}`}, 0))`);
    const evidence = await evaluateConditions(effectiveConditions, deviceId);
    if (evidence.subjects === undefined) throw new Error('Subject evidence disappeared during evaluation');
    const observation = await evaluateSubjectAlerts({
      rule: { ...rule, overrideSettings: { ...(rule.overrideSettings as Record<string, unknown> | null),
        severity: effectiveSeverity, cooldownMinutes: effectiveCooldownMinutes } },
      template, device, monitor, evidence: { ...evidence, createdAlertIds: subjectAlertIds },
    });
    if (monitor) {
      await recordMonitorEvaluation({ monitor, deviceId, orgId: device.orgId, observation });
    }
  });
  createdAlerts.push(...subjectAlertIds);
  continue;
}
```

Preserve the existing NULL-subject `if (alertId)` block at `alertService.ts:1192–1210` verbatim. Its `linkEpisodeAlert(...).catch(...)` runs after publication and remains best-effort: it logs/captures bookkeeping errors without deleting the published alert, dropping its ID, or changing `responsesOwner: true`. Only subject alerts require the prepublication claim in Task 8.

- [ ] **Step 4: Implement the committed-outbox dispatcher.** Create the complete file below. This mirrors `publishAlertTriggeredOrRollback`'s ordering: the row is committed before publication, publication failure compensates in a **new** transaction, and cooldown/correlation follow successful publication. Compensation clears only an exact matching episode owner and deletes the failed alert atomically. It never runs because a later cooldown or acknowledgement write failed. The outbox lease prevents two sweep workers from claiming one pending alert; process death leaves a durable envelope eligible again after five minutes. Subject recoveries use a second envelope and never delete their resolved row on transport failure. Pending trigger publication is canceled when recovery wins first. Hardware recurrence alerts are staged from the committed latch with their exact existing message and pause semantics; the NULL-subject legacy escalation path stays unchanged. Event IDs stay stable on retries; delivery remains at-least-once across a crash after publish but before acknowledgement.

```ts
import { randomUUID } from 'node:crypto';
import { and, eq, inArray, isNull, isNotNull, sql } from 'drizzle-orm';
import { db, hasDbAccessContext, withSystemDbAccessContext } from '../db';
import { alerts, monitorEpisodes, monitorDeviceState, monitorDefinitions, devices } from '../db/schema';
import { publishEvent } from './eventBus';
import { recordStateTransition, setCooldown } from './alertCooldown';
import { enqueueAlertCorrelation } from '../jobs/alertCorrelation';
import { captureException } from './sentry';
import type { SubjectAlertDispatch } from './alertService';
import { escalationSeverityFor } from './monitors/escalationLatch';

type Claimed = {
  id: string; orgId: string; deviceId: string; ruleId: string | null;
  episodeId: string | null; subjectKey: string | null; pending: SubjectAlertDispatch;
};
export async function drainSubjectAlertOutbox(deviceId?: string): Promise<void> {
  if (hasDbAccessContext()) throw new Error('Subject outbox must run after commit');
  await stagePendingHardwareEscalations(deviceId);
  // System scope belongs only to this background cross-tenant dispatcher.
  for (const slot of ['_subjectDispatch', '_subjectResolutionDispatch'] as const) {
    const triggering = slot === '_subjectDispatch';
    const statuses = triggering ? ['active', 'acknowledged', 'suppressed'] as const : ['resolved'] as const;
    const claimed = await withSystemDbAccessContext(async () => {
      const token = randomUUID();
      return db.execute<Claimed>(sql`
        WITH candidates AS (
          SELECT id FROM alerts
          WHERE context ? ${slot}
            AND status IN (${sql.join(statuses.map(status => sql`${status}`), sql`, `)})
            AND (${deviceId ?? null}::uuid IS NULL OR device_id = ${deviceId ?? null}::uuid)
            AND COALESCE((context->${slot}->>'leaseUntil')::timestamptz, '-infinity') < now()
          ORDER BY created_at, id FOR UPDATE SKIP LOCKED LIMIT 100
        )
        UPDATE alerts a SET context = jsonb_set(a.context, ARRAY[${slot}::text],
          (a.context->${slot}) || jsonb_build_object(
            'leaseToken', ${token}::text, 'leaseUntil', now() + interval '5 minutes'))
        FROM candidates c WHERE a.id = c.id
        RETURNING a.id, a.org_id AS "orgId", a.device_id AS "deviceId", a.rule_id AS "ruleId",
          a.episode_id AS "episodeId", a.subject_key AS "subjectKey", a.context->${slot} AS pending`);
    });
    for (const row of claimed) {
      const ownsLease = and(eq(alerts.id, row.id),
        sql`${alerts.context}->${slot}->>'leaseToken' = ${row.pending.leaseToken}`);
      // Renew just before each send; skip a trigger canceled by recovery while
      // this batch was waiting. A send racing a later recovery is at-least-once.
      const live = await withSystemDbAccessContext(() => db.update(alerts).set({
        context: sql`jsonb_set(${alerts.context}, ARRAY[${slot}::text, 'leaseUntil'], to_jsonb(now() + interval '5 minutes'))`,
      }).where(and(ownsLease, inArray(alerts.status, [...statuses]))).returning({ id: alerts.id }));
      if (live.length === 0) continue;
      try {
        await publishEvent(row.pending.eventType, row.orgId, row.pending.payload, row.pending.publisher ?? 'alert-service',
          { siteId: row.pending.siteId, eventId: row.pending.eventId });
      } catch (error) {
        captureException(error, undefined, { errorId: 'subject-alert-publish-failed', alertId: row.id });
        console.error('[SubjectAlertOutbox] Publication failed', row.id, error);
        try {
          await withSystemDbAccessContext(async () => {
            if (!triggering) {
              await db.update(alerts).set({ context: sql`jsonb_set(${alerts.context}, ARRAY[${slot}::text],
                (${alerts.context}->${slot}) - 'leaseToken' - 'leaseUntil')` }).where(ownsLease);
              return; // A resolved alert survives transport failure and retries next tick.
            }
            const [locked] = await db.select({ id: alerts.id }).from(alerts).where(ownsLease).for('update');
            if (!locked) return;
            if (row.episodeId) await db.update(monitorEpisodes).set({ alertId: null, updatedAt: new Date() })
              .where(and(eq(monitorEpisodes.id, row.episodeId), eq(monitorEpisodes.alertId, row.id)));
            await db.update(monitorDeviceState).set({ escalationAlertId: null, updatedAt: new Date() })
              .where(eq(monitorDeviceState.escalationAlertId, row.id));
            await db.delete(alerts).where(ownsLease);
          });
        } catch (cleanupError) {
          captureException(cleanupError, undefined, { errorId: 'subject-alert-compensation-failed', alertId: row.id });
          console.error('[SubjectAlertOutbox] Compensation failed; durable envelope will retry', row.id, cleanupError);
        }
        continue;
      }
      // No failure after a successful publish may delete an alert or its owner.
      try {
        await withSystemDbAccessContext(() => db.update(alerts)
          .set({ context: sql`${alerts.context} - ${slot}` }).where(ownsLease), 'subject-alert-outbox.ack');
      } catch (error) {
        console.error('[SubjectAlertOutbox] Acknowledgement failed; stable event ID will retry', row.id, error);
      }
      const effects: Array<() => Promise<unknown>> = [];
      const { ruleId, subjectKey } = row;
      if (ruleId && subjectKey) effects.push(
        () => recordStateTransition(ruleId, row.deviceId, triggering ? 'triggered' : 'resolved', subjectKey),
        () => setCooldown(ruleId, row.deviceId, row.pending.cooldownMinutes, subjectKey),
      );
      if (triggering) effects.push(() => enqueueAlertCorrelation({ orgId: row.orgId, deviceId: row.deviceId }));
      for (const effect of effects) {
        try { await effect(); }
        catch (error) { console.error('[SubjectAlertOutbox] Post-publication effect failed', row.id, error); }
      }
    }
  }
}

async function stagePendingHardwareEscalations(deviceId?: string): Promise<void> {
  await withSystemDbAccessContext(async () => {
    const candidates = await db.select({ state: monitorDeviceState, monitor: monitorDefinitions, device: devices })
      .from(monitorDeviceState)
      .innerJoin(monitorDefinitions, eq(monitorDefinitions.id, monitorDeviceState.monitorId))
      .innerJoin(devices, eq(devices.id, monitorDeviceState.deviceId))
      .where(and(eq(monitorDefinitions.kind, 'hardware_health'),
        isNotNull(monitorDeviceState.escalatedAt), isNull(monitorDeviceState.escalationAlertId),
        isNotNull(monitorDeviceState.currentEpisodeId), eq(monitorDeviceState.lastState, 'breach'),
        deviceId ? eq(monitorDeviceState.deviceId, deviceId) : undefined))
      .orderBy(monitorDeviceState.updatedAt).limit(100)
      .for('update', { of: monitorDeviceState, skipLocked: true });
    for (const { state, monitor, device } of candidates) {
      const id = randomUUID();
      const episodeId = state.currentEpisodeId!;
      const n = state.episodesInWindow;
      const occurrences = `${n} ${n === 1 ? 'time' : 'times'}`;
      const hours = monitor.recurrenceWindowHours;
      const days = hours ? Math.round(hours / 24) : 0;
      const window = !hours ? 'the recurrence window' : hours < 24
        ? `${hours} ${hours === 1 ? 'hour' : 'hours'}` : `${days} ${days === 1 ? 'day' : 'days'}`;
      const name = device.displayName || device.hostname || device.id;
      const severity = escalationSeverityFor(monitor.severity);
      const title = `${monitor.name} recurred ${occurrences} in ${window} on ${name}`;
      const message = `${monitor.name} has opened ${occurrences} on ${name} within ${window}. Automatic responses for this device are held until a human resets the escalation.`;
      const pending: SubjectAlertDispatch = { eventId: id, eventType: 'alert.triggered',
        siteId: device.siteId, cooldownMinutes: 0, publisher: 'monitor-escalation',
        payload: { alertId: id, ruleId: null, deviceId: device.id, severity, title, message,
          monitorId: monitor.id, kind: 'hardware_health', episodeId, requiresHuman: true,
          subjectKey: null, responsesOwner: true, source: 'monitor_recurrence' } };
      await db.insert(alerts).values({ id, ruleId: null, deviceId: device.id, orgId: device.orgId,
        severity, title, message, monitorId: monitor.id, episodeId, requiresHuman: true,
        status: 'active', context: { source: 'monitor_recurrence', monitorId: monitor.id, episodeId,
          episodesInWindow: n, recurrenceThreshold: monitor.recurrenceThreshold,
          recurrenceWindowHours: hours, recurrenceActionsPending: monitor.recurrenceActions.length,
          _subjectDispatch: pending } });
      await db.update(monitorDeviceState).set({ escalationAlertId: id, updatedAt: new Date() })
        .where(and(eq(monitorDeviceState.monitorId, monitor.id), eq(monitorDeviceState.deviceId, device.id)));
    }
  });
}

```

- [ ] **Step 5: Drain only after the worker's outer commit, and retry on the minute tick.** Import `drainSubjectAlertOutbox` into `alertWorker.ts`. Replace its `evaluate-device` case with this complete case; add the second block at the start of `processEvaluateAll`, immediately after `const startTime = Date.now()`. The tick drains even when no online device is selected, so a crash between commit and dispatch does not strand alerts. Keep the current selection and schedule unchanged.

```ts
case 'evaluate-device': {
  const result = await runWithSystemDbAccess(() => processEvaluateDevice(data));
  await drainSubjectAlertOutbox(data.deviceId);
  return result;
}
```

```ts
try {
  await drainSubjectAlertOutbox();
} catch (error) {
  captureException(error, undefined, { errorId: 'subject-alert-outbox-drain-failed' });
  console.error('[AlertWorker] Subject outbox drain failed', error);
}
```

Add this mock alongside the other top-level worker mocks in `alertWorker.test.ts`, and add the test to its existing worker-context describe block. It uses the real worker processor and the existing `ctx.depth` instrumentation to catch a drain accidentally moved inside the transaction. Add it before the worker edit for red, then rerun for green.

```ts
const subjectOutbox = vi.hoisted(() => ({ depths: [] as number[] }));
vi.mock('../services/subjectAlertOutbox', () => ({
  drainSubjectAlertOutbox: vi.fn(async () => { subjectOutbox.depths.push(ctx.depth); }),
}));

it('drains subject events after device commit and outside the fleet context', async () => {
  subjectOutbox.depths.length = 0;
  createAlertWorker();
  const { evaluateDeviceAlerts, evaluateDeviceAlertsFromPolicy } = await import('../services/alertService');
  vi.mocked(evaluateDeviceAlerts).mockResolvedValue([]);
  vi.mocked(evaluateDeviceAlertsFromPolicy).mockResolvedValue([]);
  await workerState.processor!({ data: { type: 'evaluate-device', deviceId: 'device-1', orgId: 'org-1' } });
  expect(subjectOutbox.depths).toEqual([0]);
  fleetState.fleet = [];
  await workerState.processor!({ data: { type: 'evaluate-all' } });
  expect(subjectOutbox.depths).toEqual([0, 0]);
});
```

The queue-only suite also imports `alertWorker`; keep its existing narrow mocks by adding this top-level mock to `alertQueue.test.ts`:

```ts
vi.mock('../services/subjectAlertOutbox', () => ({
  drainSubjectAlertOutbox: vi.fn(async () => undefined),
}));
```

```bash
cd apps/api && npx vitest run src/jobs/alertWorker.test.ts src/jobs/alertQueue.test.ts
```

- [ ] **Step 6: Add durable response admission and its dispatch envelope.** Stable event IDs and BullMQ's 200-job retention do not deduplicate local redelivery. Add these columns to the **unshipped W03** `100300` migration (no new slot and no change to W01/W05 migrations), and to `monitorEpisodes` immediately after `responseRunId`; add `jsonb` to its pg-core imports. Admission never resets, including on publication compensation, response completion, human escalation reset, or queue eviction.

```sql
ALTER TABLE monitor_episodes ADD COLUMN IF NOT EXISTS responses_admitted_at timestamptz;
ALTER TABLE monitor_episodes ADD COLUMN IF NOT EXISTS response_dispatch jsonb;
```

```ts
responsesAdmittedAt: timestamp('responses_admitted_at', { withTimezone: true }),
responseDispatch: jsonb('response_dispatch'),
```

In `tenantExportPolicyRegistry.ts`, replace the `monitor_episodes` entry with:

```ts
"monitor_episodes": tablePolicy("org_id", {"included":["id","monitor_id","device_id","org_id","started_at","ended_at","end_reason","alert_id","response_run_id","responses_admitted_at","response_outcome","created_at","updated_at"],"reviewedIncluded":[],"excludedSensitive":[],"excludedOpen":["response_dispatch"]}),
```

In Task 3's disposable database test, create the following skeletal existing table immediately before applying `100300`; after its second application assert both columns exist. This is required because the migration now also extends an existing episode table.

```ts
await sql.unsafe('CREATE TABLE monitor_episodes (id uuid PRIMARY KEY)');
// After the second sql.begin(tx => tx.unsafe(migration)):
const columns = await sql`SELECT column_name FROM information_schema.columns
  WHERE table_name = 'monitor_episodes' ORDER BY column_name`;
expect(columns.map(row => row.column_name)).toEqual(['id', 'response_dispatch', 'responses_admitted_at']);
```

`createAutomationRunRecord` currently publishes `automation.started` before its caller commits. Add this optional member to its options and this early return immediately after the run-creation transaction, before computing `eventOrgIds`. The default path remains byte-for-byte unchanged; the subject response outbox owns this event when deferred.

```ts
// createAutomationRunRecord options:
deferStartedEvent?: boolean;
// Immediately after `const run = await db.transaction(...)`:
if (options.deferStartedEvent) return { run, targetDeviceIds };
```

Create the complete `subjectResponseOutbox.ts` below. The CAS, validated runtime run creation, episode run pointer and dispatch envelope share one savepoint and outer commit. A loser creates no run and queues nothing. The dispatcher cannot run under an ambient transaction. Failed enqueue retains the envelope; successful enqueue clears only the envelope, never the admission marker. The execution job retains its stable run identity even if the triggering event's queue job has been evicted.

```ts
import { randomUUID } from 'node:crypto';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { db, hasDbAccessContext, withDbTransaction, withSystemDbAccessContext } from '../db';
import { automations, monitorEpisodes } from '../db/schema';
import { createAutomationRunRecord, type AutomationTriggerContext } from './automationRuntime';
import { publishEvent } from './eventBus';

type Dispatch = {
  runId: string; automationId: string; deviceId: string; triggeredBy: string;
  triggerContext: AutomationTriggerContext; leaseToken?: string; leaseUntil?: string;
};
export async function admitSubjectResponse(input: {
  automation: typeof automations.$inferSelect; episodeId: string; alertId: string;
  deviceId: string; eventType: string; eventId?: string; eventTimestamp: string;
  triggerContext: AutomationTriggerContext;
}): Promise<{ runId?: string; skipped?: string }> {
  return withDbTransaction(async () => {
    const [episode] = await db.update(monitorEpisodes).set({ responsesAdmittedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(monitorEpisodes.id, input.episodeId),
        eq(monitorEpisodes.monitorId, input.automation.managedByMonitorId!),
        eq(monitorEpisodes.deviceId, input.deviceId), eq(monitorEpisodes.alertId, input.alertId),
        isNull(monitorEpisodes.endedAt), isNull(monitorEpisodes.responsesAdmittedAt)))
      .returning({ id: monitorEpisodes.id });
    if (!episode) return { skipped: 'subject_episode_response_already_admitted_or_ineligible' };
    const triggeredBy = `event:${input.eventType}`;
    const { run } = await createAutomationRunRecord({ automation: input.automation, triggeredBy,
      boundDeviceIds: [input.deviceId], deferStartedEvent: true,
      details: { eventId: input.eventId, eventType: input.eventType, eventTimestamp: input.eventTimestamp },
    });
    const pending: Dispatch = { runId: run.id, automationId: input.automation.id,
      deviceId: input.deviceId, triggeredBy, triggerContext: input.triggerContext };
    await db.update(monitorEpisodes).set({ responseRunId: run.id,
      responseOutcome: Array.isArray(input.automation.actions) && input.automation.actions.length === 0 ? 'skipped_no_response' : 'queued',
      responseDispatch: pending, updatedAt: new Date() }).where(eq(monitorEpisodes.id, episode.id));
    return { runId: run.id };
  });
}
export async function drainSubjectResponseOutbox(
  enqueue: (pending: Dispatch) => Promise<unknown>,
): Promise<void> {
  if (hasDbAccessContext()) throw new Error('Subject response outbox must run after commit');
  const token = randomUUID();
  const rows = await withSystemDbAccessContext(() => db.execute<{
    id: string; orgId: string; pending: Dispatch;
  }>(sql`
    WITH candidates AS (
      SELECT id FROM monitor_episodes WHERE response_dispatch IS NOT NULL
        AND COALESCE((response_dispatch->>'leaseUntil')::timestamptz, '-infinity') < now()
      ORDER BY created_at, id FOR UPDATE SKIP LOCKED LIMIT 100
    )
    UPDATE monitor_episodes e SET response_dispatch = e.response_dispatch || jsonb_build_object(
      'leaseToken', ${token}::text, 'leaseUntil', now() + interval '5 minutes')
    FROM candidates c WHERE e.id = c.id
    RETURNING e.id, e.org_id AS "orgId", e.response_dispatch AS pending`));
  for (const row of rows) {
    const ownsLease = and(eq(monitorEpisodes.id, row.id),
      sql`${monitorEpisodes.responseDispatch}->>'leaseToken' = ${token}`);
    try {
      const p = row.pending;
      await publishEvent('automation.started', row.orgId, { automationId: p.automationId,
        runId: p.runId, triggeredBy: p.triggeredBy, devicesTargeted: 1 },
      'automation-runtime', { eventId: p.runId });
      await enqueue(p);
      await withSystemDbAccessContext(() => db.update(monitorEpisodes)
        .set({ responseDispatch: null, updatedAt: new Date() }).where(ownsLease));
    } catch (error) {
      console.error('[SubjectResponseOutbox] Dispatch failed; admission remains committed', row.id, error);
      await withSystemDbAccessContext(() => db.update(monitorEpisodes).set({
        responseDispatch: sql`${monitorEpisodes.responseDispatch} - 'leaseToken' - 'leaseUntil'`,
      }).where(ownsLease));
    }
  }
}
```

- [ ] **Step 7: Route admitted responses through the outbox after commit.** Import both helpers into `automationWorker.ts`. Immediately before its existing `const { run, targetDeviceIds } = await createAutomationRunRecord(...)` in `processTriggerEvent`, insert this branch. This is after trigger matching, managed-device binding and the existing pause check; Task 11's false-owner guard remains before the pause read. Missing/NULL subject events retain their existing path, including recurrence actions.

```ts
import { admitSubjectResponse, drainSubjectResponseOutbox } from '../services/subjectResponseOutbox';
// processTriggerEvent, before its legacy run creation:
if (isMonitorManaged && typeof payload.subjectKey === 'string') {
  if (payload.responsesOwner !== true || typeof payload.episodeId !== 'string' ||
      typeof payload.alertId !== 'string' || !boundDeviceIds?.[0] || !triggerContext) {
    return { skipped: 'subject_response_identity_missing' };
  }
  return admitSubjectResponse({ automation, episodeId: payload.episodeId, alertId: payload.alertId,
    deviceId: boundDeviceIds[0], eventType: data.eventType, eventId: data.eventId,
    eventTimestamp: data.eventTimestamp, triggerContext });
}
```

Add this worker helper. Use the queue directly: `enqueueAutomationRun` can swallow an enqueue failure and schedule an in-memory fallback, which cannot acknowledge a durable outbox. Retain these subject execution jobs so an enqueue-success/ack-failure retry still finds the same execution job; ordinary trigger jobs retain their existing 200-job policy. The database admission marker, not either retention policy, prevents creating another response run for the episode.

```ts
async function drainCommittedSubjectResponses(): Promise<void> {
  await drainSubjectResponseOutbox(pending => getAutomationQueue().add('execute-run', {
    type: 'execute-run', runId: pending.runId, targetDeviceIds: [pending.deviceId],
    triggerContext: pending.triggerContext,
  }, { jobId: `automation-run-${pending.runId}`, removeOnComplete: false, removeOnFail: false }));
}
```

Insert this block in `createAutomationWorker` immediately before its existing `return runWithSystemDbAccess(async () => ...)`; delete the now-unreachable `case 'trigger-event'` from that switch. The `scan-schedules` drain is outside the subsequent schedule transaction, so a process crash after admission retries on the next minute even without another alert event.

```ts
if (data.type === 'trigger-event') {
  assertQueueJobName(AUTOMATION_QUEUE, job, 'trigger-event');
  const result = await runWithSystemDbAccess(() => processTriggerEvent(data));
  await drainCommittedSubjectResponses();
  return result;
}
if (data.type === 'scan-schedules') await drainCommittedSubjectResponses();
```

- [ ] **Step 8: Run red/green replay and transaction tests.** Add Task 11's replay tests before implementing Steps 6–7. Red: concurrent/replayed owner events create multiple runs or publish/queue before commit. Green: a single admitted run survives replay after queue eviction; outer rollback leaves neither marker nor run; failed dispatch retries the same run after commit. Run the migration, export, legacy episode and worker regressions as well.

```bash
cd apps/api && npx vitest run -c vitest.integration.config.ts src/db/hardwareAlertMigrations.integration.test.ts src/services/alertSubjects.integration.test.ts src/__tests__/integration/monitorEpisodes.integration.test.ts src/__tests__/integration/tenant-export-policy.integration.test.ts
```

```bash
cd apps/api && npx vitest run src/jobs/automationWorker.subjects.test.ts src/jobs/automationWorker.monitorBinding.test.ts src/jobs/automationWorker.monitorPause.test.ts src/services/automationRuntime.boundTargets.test.ts
```

- [ ] **Step 9: Run green.** `cd apps/api && npx vitest run -c vitest.integration.config.ts src/services/alertSubjects.integration.test.ts` — two subjects, own recovery, stable episode, both race variants and RLS isolation pass.
- [ ] **Step 10: Commit.**

```bash
git add apps/api/migrations/2026-10-27-100300-alert-subject-key.sql apps/api/src/db/hardwareAlertMigrations.integration.test.ts apps/api/src/db/schema/monitorEpisodes.ts apps/api/src/services/tenantExportPolicyRegistry.ts apps/api/src/services/automationRuntime.ts apps/api/src/services/subjectResponseOutbox.ts apps/api/src/jobs/automationWorker.ts apps/api/src/services/alertService.ts apps/api/src/services/alertSubjects.integration.test.ts apps/api/vitest.integration.config.ts apps/api/vitest.config.ts apps/api/src/services/subjectAlertOutbox.ts apps/api/src/jobs/alertWorker.ts apps/api/src/jobs/alertWorker.test.ts apps/api/src/jobs/alertQueue.test.ts
git commit -m $'feat(alerts): reconcile subject observations in the device sweep\n\nCo-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>'
```

### Task 11: Run one device response while delivering both subject notifications

**Files:** Modify `apps/api/src/jobs/automationWorker.ts:576`; Create/Test `apps/api/src/jobs/automationWorker.subjects.test.ts`; Extend/Test `apps/api/src/services/alertSubjects.integration.test.ts`.
**Interfaces:** Consumes `payload.responsesOwner`; produces `{ skipped: 'subject_alert_not_response_owner' }` only for a monitor-managed automation. `__testOnly.processTriggerEvent` is the existing worker test seam (`automationWorker.ts:1358`); notification dispatcher is unchanged.

- [ ] **Step 1: Add the small worker regression.** Keep the real trigger normalizer; return before any run/queue creation for false ownership.

```ts
import { expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({ select: vi.fn() }));
vi.mock('../db', () => ({ db: { select: m.select } }));
vi.mock('../services/eventBus', () => ({ getEventBus: () => ({ subscribe: vi.fn() }) }));
import { __testOnly } from './automationWorker';
it('does not query pause state or create a run for the second subject', async () => {
  m.select.mockReturnValue({ from: () => ({ where: () => ({ limit: async () => [{ id: 'automation',
    managedByMonitorId: 'monitor', enabled: true, trigger: { type: 'event', event: 'alert.triggered' } }] }) }) });
  expect(await __testOnly.processTriggerEvent({ type: 'trigger-event', automationId: 'automation', eventType: 'alert.triggered',
    eventPayload: { deviceId: 'device', responsesOwner: false }, eventTimestamp: '2026-09-23T12:00:00Z' })).toEqual({ skipped: 'subject_alert_not_response_owner' });
  expect(m.select).toHaveBeenCalledTimes(1);
});
```

- [ ] **Step 2: Add real response/notification proof to the integration suite.** These module mocks belong with its existing top-level mocks; keep database and `createAutomationRunRecord` real. The sender stub is the delivery boundary, not a replacement for the dispatcher.

```ts
vi.mock('bullmq', () => ({
  Queue: class { add = m.queue; getJob = async () => null; close = async () => {}; },
  Worker: class { constructor(_name: string, processor: (job: any) => Promise<any>) { m.processor = processor; } on() {} }, Job: class {}, UnrecoverableError: class extends Error {},
}));
vi.mock('./redis', async original => ({ ...await original<typeof import('./redis')>(),
  isRedisAvailable: () => true, getRedisConnection: () => ({}), getBullMQConnection: () => ({}) }));
vi.mock('./notificationSenders', async original => ({ ...await original<typeof import('./notificationSenders')>(), sendInAppNotification: m.notify }));
import { __testOnly as automationWorker, createAutomationWorker } from '../jobs/automationWorker';
import { processAlertNotifications } from './notificationDispatcher';
it('two failing disks notify twice, but only their atomic episode owner runs responses', async () => {
  const f = await fixture();
  m.queue.mockResolvedValue({ id: 'queued' }); m.notify.mockResolvedValue({ success: true, notificationCount: 1 });
  await Promise.all([
    withSystemDbAccessContext(() => evaluateDeviceAlerts(f.device.id)),
    withSystemDbAccessContext(() => evaluateDeviceAlerts(f.device.id)),
  ]);
  await drainSubjectAlertOutbox(f.device.id);
  const events = m.publish.mock.calls.filter(c => c[0] === 'alert.triggered').map(c => c[2]);
  expect(events).toHaveLength(2); expect(events.filter(p => p.responsesOwner)).toHaveLength(1);
  const [automation] = await getTestDb().insert(automations).values({ orgId: f.org.id, name: 'Hardware response',
    managedByMonitorId: f.monitor.id, trigger: { type: 'event', event: 'alert.triggered', filter: { ruleId: f.rule.id } },
    actions: [{ type: 'execute_command', command: 'echo hardware-response', shell: 'bash' }] }).returning();
  const outcomes = [];
  for (const payload of events) {
    outcomes.push(await withSystemDbAccessContext(() => automationWorker.processTriggerEvent({
      type: 'trigger-event', automationId: automation!.id, eventType: 'alert.triggered', eventPayload: payload,
      eventId: randomUUID(), eventTimestamp: new Date().toISOString(),
    })));
    await withSystemDbAccessContext(() => processAlertNotifications({ type: 'process-alert', alertId: payload.alertId }));
  }
  expect(outcomes.filter(o => o.runId)).toHaveLength(1);
  expect(outcomes).toContainEqual({ skipped: 'subject_alert_not_response_owner' });
  const runs = await getTestDb().select().from(automationRuns).where(eq(automationRuns.automationId, automation!.id));
  expect(runs).toHaveLength(1);
  expect(m.notify).toHaveBeenCalledTimes(2);
  expect(new Set(m.notify.mock.calls.map(c => c[0].alertId)).size).toBe(2);
  const [episode] = await getTestDb().select().from(monitorEpisodes).where(eq(monitorEpisodes.monitorId, f.monitor.id));
  expect(episode!.alertId).toBe(events.find(p => p.responsesOwner).alertId);
});
```

- [ ] **Step 3: Prove owner replay cannot re-admit after acknowledgement failure and queue eviction.** Extend the integration suite's top-level mocks with this fault wrapper; every successful database operation still delegates to the real context/transaction helper. The label is supplied only by Task 10's alert-outbox acknowledgement, so the initial claim and response admission really commit. Add the imports, helper and tests below. `Queue.getJob` in this suite always returns `null`: replay therefore receives no BullMQ job-retention protection, exactly as after eviction.

```ts
vi.mock('../db', async original => {
  const actual = await original<typeof import('../db')>();
  return { ...actual, withSystemDbAccessContext: ((...args: Parameters<typeof actual.withSystemDbAccessContext>) => {
    if (m.failAck && args[1] === 'subject-alert-outbox.ack') throw new Error('outbox acknowledgement failed');
    return actual.withSystemDbAccessContext(...args);
  }) as typeof actual.withSystemDbAccessContext };
});
import { drainSubjectResponseOutbox } from './subjectResponseOutbox';
async function responseFixture() {
  const f = await fixture();
  await withSystemDbAccessContext(() => evaluateDeviceAlerts(f.device.id));
  m.failAck = true;
  await drainSubjectAlertOutbox(f.device.id);
  m.failAck = false;
  const payload = m.publish.mock.calls.filter(c => c[0] === 'alert.triggered').map(c => c[2])
    .find(p => p.responsesOwner === true)!;
  const [automation] = await getTestDb().insert(automations).values({ orgId: f.org.id,
    name: 'Replay-safe hardware response', managedByMonitorId: f.monitor.id,
    trigger: { type: 'event', event: 'alert.triggered', filter: { ruleId: f.rule.id } },
    actions: [{ type: 'execute_command', command: 'echo hardware-response', shell: 'bash' }],
  }).returning();
  const job = { type: 'trigger-event' as const, automationId: automation!.id, eventType: 'alert.triggered',
    eventPayload: payload, eventId: payload.alertId, eventTimestamp: new Date().toISOString() };
  return { ...f, automation: automation!, payload, job };
}
it('replayed owner after alert-outbox ack failure and queue eviction admits one response', async () => {
  const f = await responseFixture();
  m.publish.mockClear(); m.queue.mockClear();
  const outcomes = await Promise.all([1, 2].map(() => withSystemDbAccessContext(async () => {
    const result = await automationWorker.processTriggerEvent(f.job);
    expect(m.queue).not.toHaveBeenCalled(); expect(m.publish).not.toHaveBeenCalled();
    return result;
  })));
  expect(outcomes.filter(result => result.runId)).toHaveLength(1);
  await drainSubjectResponseOutbox(async pending => {
    const [committed] = await getTestDb().select().from(automationRuns).where(eq(automationRuns.id, pending.runId));
    expect(committed).toBeDefined();
    await m.queue('execute-run', pending);
  });
  expect(m.queue).toHaveBeenCalledTimes(1);
  const [before] = await getTestDb().select().from(monitorEpisodes).where(eq(monitorEpisodes.id, f.payload.episodeId));
  expect(before!.responsesAdmittedAt).toBeInstanceOf(Date);
  expect(before!.responseDispatch).toBeNull();
  // Evict all simulated transport history, then let the unacknowledged alert replay.
  m.queue.mockClear(); m.publish.mockClear();
  await withSystemDbAccessContext(() => db.update(alerts).set({ context: sql`jsonb_set(
    ${alerts.context}, '{_subjectDispatch}', (${alerts.context}->'_subjectDispatch') - 'leaseToken' - 'leaseUntil')`
  }).where(and(eq(alerts.deviceId, f.device.id), sql`${alerts.context} ? '_subjectDispatch'`)));
  await drainSubjectAlertOutbox(f.device.id);
  const replay = m.publish.mock.calls.filter(c => c[0] === 'alert.triggered').map(c => c[2])
    .find(p => p.responsesOwner === true)!;
  expect(replay).toEqual(f.payload);
  expect(await withSystemDbAccessContext(() => automationWorker.processTriggerEvent({ ...f.job, eventPayload: replay })))
    .toEqual({ skipped: 'subject_episode_response_already_admitted_or_ineligible' });
  await drainSubjectResponseOutbox(async pending => { await m.queue('execute-run', pending); });
  expect(m.queue).not.toHaveBeenCalled();
  expect(await getTestDb().select().from(automationRuns).where(eq(automationRuns.automationId, f.automation.id))).toHaveLength(1);
  const [after] = await getTestDb().select().from(monitorEpisodes).where(eq(monitorEpisodes.id, f.payload.episodeId));
  expect(after!.responseRunId).toBe(before!.responseRunId);
  expect(after!.responsesAdmittedAt).toEqual(before!.responsesAdmittedAt);
});
it('the real worker queues a response only after its admission transaction commits', async () => {
  const f = await responseFixture();
  createAutomationWorker();
  m.queue.mockClear().mockImplementation(async (_name, data, options) => {
    expect(hasDbAccessContext()).toBe(false);
    const [run] = await getTestDb().select().from(automationRuns).where(eq(automationRuns.id, data.runId));
    expect(run).toBeDefined();
    expect(options).toMatchObject({ jobId: `automation-run-${data.runId}`, removeOnComplete: false });
    return { id: options.jobId };
  });
  const result = await m.processor!({ name: 'trigger-event', data: f.job });
  expect(result.runId).toBeDefined(); expect(m.queue).toHaveBeenCalledTimes(1);
});
it('response admission and envelope roll back together, then failed enqueue retries the same run', async () => {
  const f = await responseFixture();
  m.publish.mockClear(); m.queue.mockClear();
  await expect(withSystemDbAccessContext(async () => {
    await automationWorker.processTriggerEvent(f.job);
    await expect(drainSubjectResponseOutbox(m.queue)).rejects.toThrow('must run after commit');
    throw new Error('rollback response');
  })).rejects.toThrow('rollback response');
  const [rolledBack] = await getTestDb().select().from(monitorEpisodes).where(eq(monitorEpisodes.id, f.payload.episodeId));
  expect(rolledBack!.responsesAdmittedAt).toBeNull(); expect(rolledBack!.responseDispatch).toBeNull();
  expect(await getTestDb().select().from(automationRuns).where(eq(automationRuns.automationId, f.automation.id))).toEqual([]);
  expect(m.publish).not.toHaveBeenCalled(); expect(m.queue).not.toHaveBeenCalled();
  const admitted = await withSystemDbAccessContext(() => automationWorker.processTriggerEvent(f.job));
  m.queue.mockRejectedValueOnce(new Error('queue unavailable')).mockResolvedValue({ id: 'queued' });
  await drainSubjectResponseOutbox(m.queue);
  await drainSubjectResponseOutbox(m.queue);
  expect(m.queue).toHaveBeenCalledTimes(2);
  expect(m.queue.mock.calls.map(c => c[0].runId)).toEqual([admitted.runId, admitted.runId]);
  expect(await getTestDb().select().from(automationRuns).where(eq(automationRuns.automationId, f.automation.id))).toHaveLength(1);
});
```

Run the integration command in Step 5 before applying Task 10 Steps 6–7 (red: repeated admission or precommit publication), then again after those edits and Step 4 below (green). These tests exercise the real worker seam and database CAS, with no transport deduplication.

- [ ] **Step 4: Run red, then add the guard.** `cd apps/api && npx vitest run src/jobs/automationWorker.subjects.test.ts` — expected owner skip, received a second database read/run path. The integration command from Step 5 should show two runs before the fix. Insert inside `if (isMonitorManaged)` before reading `monitorDeviceState`:

```ts
if (payload.responsesOwner === false) {
  return { skipped: 'subject_alert_not_response_owner' };
}
```

Do not write `recordEpisodeResponse` for this skip: that would overwrite the owner's response outcome. Missing/true ownership retains legacy behavior.

- [ ] **Step 5: Run green.**

```bash
cd apps/api && npx vitest run src/jobs/automationWorker.subjects.test.ts src/jobs/automationWorker.monitorBinding.test.ts src/jobs/automationWorker.monitorPause.test.ts
```

```bash
cd apps/api && npx vitest run -c vitest.integration.config.ts src/services/alertSubjects.integration.test.ts
```

Expected: one actual automation run, two in-app delivery calls with distinct IDs, unchanged owner, and existing legacy binding/pause tests pass.
- [ ] **Step 6: Commit.**

```bash
git add apps/api/src/jobs/automationWorker.ts apps/api/src/jobs/automationWorker.subjects.test.ts apps/api/src/services/alertSubjects.integration.test.ts
git commit -m $'fix(automations): run hardware responses only for the episode owner\n\nCo-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>'
```

### Task 12: Commit retirement recovery before publishing, including device deletion

**Files:** Modify `apps/api/src/services/hardwareHealth/retire.ts` (W01 seam), `apps/api/src/services/subjectAlertOutbox.ts`, `apps/api/migrations/2026-10-27-100300-alert-subject-key.sql`, `apps/api/src/db/schema/index.ts`, `apps/api/src/services/tenantCascade.ts`, `apps/api/src/services/orgMergeRegistry.ts`, `apps/api/src/services/tenantExportPolicyRegistry.ts`; Create `apps/api/src/db/schema/hardwareAlertRetirementOutbox.ts`, `apps/api/src/services/hardwareHealth/retirementOutbox.ts`; Create/Test `apps/api/src/services/hardwareHealth/retire.test.ts`; Extend/Test `apps/api/src/services/alertSubjects.integration.test.ts`, `apps/api/src/db/hardwareAlertMigrations.integration.test.ts`.
**Interfaces:** Keeps `resolveAlertsForRemovedComponents(deviceId: string, componentKeys: string[]): Promise<number>` from index §D. Retirement resolves all selected open subjects regardless of autoResolve/requiresHuman. W01's existing ingest, reaper and device-delete callers remain untouched. Adds `stageRetiredSubjectResolution(alertId: string): Promise<void>` inside the ambient transaction and `drainRetirementOutbox(deviceId?: string): Promise<void>` outside it. Device deletion removes alerts; retirement envelopes therefore live in an org-scoped outbox with no device/alert FK, surviving that cascade until delivered. The envelope carries historical IDs, not authority to execute a device action.

- [ ] **Step 1: Write the failing retirement test.**

```ts
import { beforeEach, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
const m = vi.hoisted(() => ({ select: vi.fn(), resolve: vi.fn(), stage: vi.fn(), predicate: undefined as unknown }));
vi.mock('../../db', () => ({ db: { select: m.select }, withDbTransaction: async (fn: () => Promise<unknown>) => fn() }));
vi.mock('../alertService', () => ({ RESOLVABLE_ALERT_STATUSES: ['active','acknowledged','suppressed'], resolveAlert: m.resolve }));
vi.mock('./retirementOutbox', () => ({ stageRetiredSubjectResolution: m.stage }));
import { resolveAlertsForRemovedComponents } from './retire';
beforeEach(() => { vi.clearAllMocks(); m.stage.mockResolvedValue(undefined); });
it('defers selected open subjects and stages only CAS winners', async () => {
  m.select.mockReturnValue({ from: () => ({ where: (p: unknown) => { m.predicate = p; return [{ id: 'a' }, { id: 'b' }]; } }) });
  m.resolve.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
  expect(await resolveAlertsForRemovedComponents('device', ['disk:3','disk:5'])).toBe(1);
  expect(m.resolve).toHaveBeenCalledWith('a', 'component no longer reported', undefined, true);
  expect(m.stage).toHaveBeenCalledExactlyOnceWith('a');
  const query = new PgDialect().sqlToQuery(m.predicate as never);
  expect(query.sql).toContain(' and ');
  expect(query.params).toEqual(expect.arrayContaining(['device','disk:3','disk:5','active','acknowledged','suppressed']));
  expect(query.params).not.toContain('resolved');
});
it('empty retirement does no work', async () => {
  expect(await resolveAlertsForRemovedComponents('device', [])).toBe(0);
  expect(m.select).not.toHaveBeenCalled(); expect(m.stage).not.toHaveBeenCalled();
});
it('staging failure rejects the caller transaction', async () => {
  m.select.mockReturnValue({ from: () => ({ where: () => [{ id: 'a' }] }) });
  m.resolve.mockResolvedValue(true); m.stage.mockRejectedValueOnce(new Error('outbox unavailable'));
  await expect(resolveAlertsForRemovedComponents('device', ['disk:3'])).rejects.toThrow('outbox unavailable');
});
```

- [ ] **Step 2: Run red.** `cd apps/api && npx vitest run src/services/hardwareHealth/retire.test.ts` — W01 no-op returns 0; the old W03 implementation would call synchronous resolution without argument four and never stage an outbox row.
- [ ] **Step 3: Add the durable retirement table in W03's unshipped migration and schema.** Append this SQL to `100300`, whose first statement already elects system scope. Four policies are idempotent, enabled and forced in the same migration. No later wave supplies storage or dispatch for this fix.

```sql
CREATE TABLE IF NOT EXISTS hardware_alert_retirement_outbox (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  envelope jsonb NOT NULL,
  lease_token uuid,
  lease_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS hardware_alert_retirement_outbox_org_idx
  ON hardware_alert_retirement_outbox(org_id);
ALTER TABLE hardware_alert_retirement_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE hardware_alert_retirement_outbox FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS breeze_org_isolation_select ON hardware_alert_retirement_outbox;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON hardware_alert_retirement_outbox;
DROP POLICY IF EXISTS breeze_org_isolation_update ON hardware_alert_retirement_outbox;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON hardware_alert_retirement_outbox;
CREATE POLICY breeze_org_isolation_select ON hardware_alert_retirement_outbox
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON hardware_alert_retirement_outbox
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON hardware_alert_retirement_outbox
  FOR UPDATE USING (public.breeze_has_org_access(org_id)) WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON hardware_alert_retirement_outbox
  FOR DELETE USING (public.breeze_has_org_access(org_id));
GRANT SELECT, INSERT, UPDATE, DELETE ON hardware_alert_retirement_outbox TO breeze_app;
```

```ts
// db/schema/hardwareAlertRetirementOutbox.ts
import { index, jsonb, pgTable, timestamp, uuid } from 'drizzle-orm/pg-core';
import { organizations } from './orgs';
export const hardwareAlertRetirementOutbox = pgTable('hardware_alert_retirement_outbox', {
  id: uuid('id').primaryKey(),
  orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  envelope: jsonb('envelope').notNull(),
  leaseToken: uuid('lease_token'),
  leaseUntil: timestamp('lease_until', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [index('hardware_alert_retirement_outbox_org_idx').on(table.orgId)]);
// Append to db/schema/index.ts:
export * from './hardwareAlertRetirementOutbox';
```

Insert the exact entry `'hardware_alert_retirement_outbox',` alphabetically in `CORE_ORG_CASCADE_DELETE_ORDER` and the exact entry `"hardware_alert_retirement_outbox",` in `REPOINT_TABLES`. Add this export entry:

```ts
"hardware_alert_retirement_outbox": tablePolicy("org_id", {"included":["id","org_id","lease_token","lease_until","created_at"],"reviewedIncluded":[],"excludedSensitive":[],"excludedOpen":["envelope"]}),
```

This is direct-org shape 1, auto-discovered by the RLS suite. It has **no `device_id` column**: neither device cascade nor device-org-denormalization registries apply. Adding it to the device cascade would erase the event being delivered. Organization erasure still deletes it and organization merge repoints it through the registrations above.

In Task 3's disposable migration fixture, add these prerequisites before applying `100300`, and these assertions after its second application. The test cluster already supplies the `breeze_app` role; the disposable database needs its own stub access function and organization relation.

```ts
await sql.unsafe('CREATE TABLE organizations (id uuid PRIMARY KEY)');
await sql.unsafe("CREATE FUNCTION public.breeze_has_org_access(uuid) RETURNS boolean LANGUAGE sql AS 'SELECT true'");
// After the second application:
expect((await sql`SELECT relrowsecurity, relforcerowsecurity FROM pg_class
  WHERE oid = 'hardware_alert_retirement_outbox'::regclass`)[0])
  .toMatchObject({ relrowsecurity: true, relforcerowsecurity: true });
expect(await sql`SELECT policyname FROM pg_policies WHERE tablename = 'hardware_alert_retirement_outbox'`).toHaveLength(4);
```

- [ ] **Step 4: Stage retirement under the caller's transaction.** Replace the W01 no-op with the complete implementation. The savepoint rolls back resolution and staging together if called outside a broader ingest savepoint; it never escapes the ambient RLS/outer commit. Orphaned rule-backed subject alerts (`ruleId = null` after rule deletion) also use Task 8's deferred subject branch and stage recovery without a rule cooldown.

```ts
import { and, eq, inArray } from 'drizzle-orm';
import { db, withDbTransaction } from '../../db';
import { alerts } from '../../db/schema';
import { resolveAlert, RESOLVABLE_ALERT_STATUSES } from '../alertService';
import { stageRetiredSubjectResolution } from './retirementOutbox';
export async function resolveAlertsForRemovedComponents(deviceId: string, componentKeys: string[]): Promise<number> {
  if (componentKeys.length === 0) return 0;
  return withDbTransaction(async () => {
    const open = await db.select({ id: alerts.id }).from(alerts).where(and(
      eq(alerts.deviceId, deviceId), inArray(alerts.subjectKey, componentKeys),
      inArray(alerts.status, [...RESOLVABLE_ALERT_STATUSES]),
    ));
    let count = 0;
    for (const alert of open) {
      if (!await resolveAlert(alert.id, 'component no longer reported', undefined, true)) continue;
      await stageRetiredSubjectResolution(alert.id);
      count++;
    }
    return count;
  });
}
```

Create `retirementOutbox.ts`. Copy the recovery envelope out of the alert before the device cascade can delete it, then remove the alert-local envelope in the same transaction to prevent two dispatch paths. The event payload and site attribution are snapshots; dispatch does not re-read a deleted device or alert.

```ts
import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { db, assertInTransaction, hasDbAccessContext, withSystemDbAccessContext } from '../../db';
import { alerts, hardwareAlertRetirementOutbox } from '../../db/schema';
import type { SubjectAlertDispatch } from '../alertService';
import { publishEvent } from '../eventBus';
import { recordStateTransition, setCooldown } from '../alertCooldown';
export async function stageRetiredSubjectResolution(alertId: string): Promise<void> {
  assertInTransaction('stageRetiredSubjectResolution');
  const inserted = await db.execute<{ id: string }>(sql`
    INSERT INTO hardware_alert_retirement_outbox (id, org_id, envelope)
    SELECT (context->'_subjectResolutionDispatch'->>'eventId')::uuid, org_id,
      context->'_subjectResolutionDispatch' FROM alerts
    WHERE id = ${alertId} AND status = 'resolved' AND context ? '_subjectResolutionDispatch'
    RETURNING id`);
  if (inserted.length !== 1) throw new Error('Retired subject has no recovery envelope');
  await db.update(alerts).set({ context: sql`${alerts.context} - '_subjectResolutionDispatch'` })
    .where(eq(alerts.id, alertId));
}
export async function drainRetirementOutbox(deviceId?: string): Promise<void> {
  if (hasDbAccessContext()) throw new Error('Retirement outbox must run after commit');
  const token = randomUUID();
  const rows = await withSystemDbAccessContext(() => db.execute<{
    id: string; orgId: string; envelope: SubjectAlertDispatch;
  }>(sql`
    WITH candidates AS (
      SELECT id FROM hardware_alert_retirement_outbox
      WHERE COALESCE(lease_until, '-infinity') < now()
        AND (${deviceId ?? null}::text IS NULL OR envelope->'payload'->>'deviceId' = ${deviceId ?? null})
      ORDER BY created_at, id FOR UPDATE SKIP LOCKED LIMIT 100
    )
    UPDATE hardware_alert_retirement_outbox o SET lease_token = ${token}, lease_until = now() + interval '5 minutes'
    FROM candidates c WHERE o.id = c.id RETURNING o.id, o.org_id AS "orgId", o.envelope`));
  for (const row of rows) {
    const owned = and(eq(hardwareAlertRetirementOutbox.id, row.id), eq(hardwareAlertRetirementOutbox.leaseToken, token));
    try {
      const p = row.envelope;
      await publishEvent('alert.resolved', row.orgId, p.payload, 'alert-service',
        { eventId: p.eventId, siteId: p.siteId });
      const { ruleId, deviceId: retiredDeviceId, subjectKey } = p.payload;
      if (typeof ruleId === 'string' && typeof retiredDeviceId === 'string' && typeof subjectKey === 'string') {
        await recordStateTransition(ruleId, retiredDeviceId, 'resolved', subjectKey);
        await setCooldown(ruleId, retiredDeviceId, p.cooldownMinutes, subjectKey);
      }
      await withSystemDbAccessContext(() => db.delete(hardwareAlertRetirementOutbox).where(owned));
    } catch (error) {
      console.error('[RetirementOutbox] Committed recovery will retry', row.id, error);
      await withSystemDbAccessContext(() => db.update(hardwareAlertRetirementOutbox)
        .set({ leaseToken: null, leaseUntil: null }).where(owned));
    }
  }
}
```

In `subjectAlertOutbox.ts`, add the import and call below immediately after its ambient-context guard, before `stagePendingHardwareEscalations`. Task 10's minute drain guarantees retry even when the device was deleted or is offline; W01's workers and request paths never publish or acquire another database context.

```ts
import { drainRetirementOutbox } from './hardwareHealth/retirementOutbox';
// drainSubjectAlertOutbox, after hasDbAccessContext guard:
await drainRetirementOutbox(deviceId);
```

- [ ] **Step 5: Add real rollback, deletion, retry and tenant-isolation tests.** Append to `alertSubjects.integration.test.ts`, importing the new schema export and retirement function. Add these tests before Step 4; run the command in Step 6 red against synchronous retirement, then green. Deleting components after the call matches the ingest/reaper boundary; deleting alerts and the device matches the relevant shared-cascade boundary without requiring unrelated inventory fixtures.

```ts
import { hardwareAlertRetirementOutbox } from '../db/schema';
import { resolveAlertsForRemovedComponents } from './hardwareHealth/retire';
it('retirement rollback leaves alerts open and emits no recovery or cooldown', async () => {
  const f = await fixture();
  await withSystemDbAccessContext(() => evaluateDeviceAlerts(f.device.id));
  await drainSubjectAlertOutbox(f.device.id);
  m.publish.mockClear(); m.cooldown.mockClear();
  await expect(withSystemDbAccessContext(async () => {
    expect(await resolveAlertsForRemovedComponents(f.device.id, ['a'])).toBe(1);
    await db.delete(deviceHardwareComponents).where(and(eq(deviceHardwareComponents.deviceId, f.device.id),
      eq(deviceHardwareComponents.componentKey, 'a')));
    expect(m.publish).not.toHaveBeenCalled(); expect(m.cooldown).not.toHaveBeenCalled();
    throw new Error('later ingest or reaper failure');
  })).rejects.toThrow('later ingest or reaper failure');
  await drainSubjectAlertOutbox(f.device.id);
  expect((await alertRows(f.device.id)).every(a => a.status === 'active')).toBe(true);
  expect(await getTestDb().select().from(hardwareAlertRetirementOutbox)
    .where(eq(hardwareAlertRetirementOutbox.orgId, f.org.id))).toEqual([]);
  expect(m.publish).not.toHaveBeenCalled(); expect(m.cooldown).not.toHaveBeenCalled();
});
it('committed retirement survives deleting alert and device rows; transport failure retries', async () => {
  const f = await fixture();
  await withSystemDbAccessContext(() => evaluateDeviceAlerts(f.device.id));
  await drainSubjectAlertOutbox(f.device.id);
  m.publish.mockClear(); m.cooldown.mockClear();
  const rows = await alertRows(f.device.id);
  await withSystemDbAccessContext(async () => {
    await db.update(alerts).set({ requiresHuman: true }).where(eq(alerts.deviceId, f.device.id));
    expect(await resolveAlertsForRemovedComponents(f.device.id, ['a', 'b'])).toBe(2);
    expect(await resolveAlertsForRemovedComponents(f.device.id, ['a', 'b'])).toBe(0);
    await db.delete(alerts).where(eq(alerts.deviceId, f.device.id));
    await db.delete(devices).where(eq(devices.id, f.device.id));
    expect(m.publish).not.toHaveBeenCalled(); expect(m.cooldown).not.toHaveBeenCalled();
  });
  const queued = await getTestDb().select().from(hardwareAlertRetirementOutbox)
    .where(eq(hardwareAlertRetirementOutbox.orgId, f.org.id));
  expect(queued).toHaveLength(2);
  m.publish.mockRejectedValueOnce(new Error('recovery transport unavailable'));
  await drainSubjectAlertOutbox(f.device.id);
  expect(await getTestDb().select().from(hardwareAlertRetirementOutbox)
    .where(eq(hardwareAlertRetirementOutbox.orgId, f.org.id))).toHaveLength(1);
  await drainSubjectAlertOutbox(f.device.id);
  expect(await getTestDb().select().from(hardwareAlertRetirementOutbox)
    .where(eq(hardwareAlertRetirementOutbox.orgId, f.org.id))).toEqual([]);
  const events = m.publish.mock.calls.map(call => call[2]);
  expect(new Set(events.map(event => event.alertId))).toEqual(new Set(rows.map(row => row.id)));
  expect(events.every(event => event.resolutionNote === 'component no longer reported')).toBe(true);
  expect(m.publish.mock.calls.every(call => call[0] === 'alert.resolved')).toBe(true);
  expect(m.cooldown).toHaveBeenCalledTimes(2);
  expect(m.cooldown.mock.calls.map(call => call[3]).sort()).toEqual(['a', 'b']);
});
it('retirement outbox enforces app-role cross-org read and insert isolation', async () => {
  const f = await fixture();
  await withSystemDbAccessContext(() => evaluateDeviceAlerts(f.device.id));
  await withSystemDbAccessContext(() => resolveAlertsForRemovedComponents(f.device.id, ['a']));
  const outsider = await createOrganization({ partnerId: f.partner.id });
  const context = { scope: 'organization' as const, orgId: outsider.id, accessibleOrgIds: [outsider.id],
    accessiblePartnerIds: [], currentPartnerId: f.partner.id, userId: null };
  expect(await withDbAccessContext(context, () => db.select().from(hardwareAlertRetirementOutbox)
    .where(eq(hardwareAlertRetirementOutbox.orgId, f.org.id)))).toEqual([]);
  await expect(withDbAccessContext(context, () => db.insert(hardwareAlertRetirementOutbox)
    .values({ id: randomUUID(), orgId: f.org.id, envelope: {} }))).rejects.toMatchObject({ cause: { code: '42501' } });
});
```

- [ ] **Step 6: Run green and the registration contracts.**

```bash
cd apps/api && npx vitest run src/services/hardwareHealth/retire.test.ts src/jobs/hardwareHealthRetention.test.ts src/services/deviceDeletion.hardwareHealth.test.ts src/services/hardwareHealth/ingest.test.ts src/db/migrationRlsScope.test.ts src/db/autoMigrate.test.ts
```

```bash
cd apps/api && npx vitest run -c vitest.integration.config.ts src/db/hardwareAlertMigrations.integration.test.ts src/services/alertSubjects.integration.test.ts src/__tests__/integration/tenant-export-policy.integration.test.ts src/__tests__/integration/tenantCascade.integration.test.ts src/__tests__/integration/orgMergeRegistry.integration.test.ts src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts
```

```bash
DB_CONTEXTLESS_WRITE_STRICT=true pnpm --filter=@breeze/api test:rls-coverage
pnpm db:check-drift
```

Expected: rollback has zero external side effects; committed recovery retries after device deletion; foreign-org inserts fail under `breeze_app`; schema replay and all tenancy registrations pass. Existing W01 ordering tests continue to exercise the unchanged seam.
- [ ] **Step 7: Commit.**

```bash
git add apps/api/src/services/hardwareHealth/retire.ts apps/api/src/services/hardwareHealth/retire.test.ts apps/api/src/services/hardwareHealth/retirementOutbox.ts apps/api/src/services/subjectAlertOutbox.ts apps/api/migrations/2026-10-27-100300-alert-subject-key.sql apps/api/src/db/schema/hardwareAlertRetirementOutbox.ts apps/api/src/db/schema/index.ts apps/api/src/services/tenantCascade.ts apps/api/src/services/orgMergeRegistry.ts apps/api/src/services/tenantExportPolicyRegistry.ts apps/api/src/services/alertSubjects.integration.test.ts apps/api/src/db/hardwareAlertMigrations.integration.test.ts
git commit -m $'fix(alerts): publish retired subject recovery after commit\n\nCo-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>'
```

### Task 13: Register the hardware monitor compiler specification

**Files:** Create `apps/api/src/services/monitors/kinds/hardwareHealth.ts`; Create/Test `apps/api/src/services/monitors/kinds/hardwareHealth.test.ts`; Modify `apps/api/src/services/monitors/kinds/index.ts:23,60`, `apps/api/src/services/monitors/kinds/index.test.ts:6,38`, `apps/api/src/routes/monitorDefinitions.test.ts:290,297`.
**Interfaces:** Consumes `MonitorKindSpec<C>` and `HardwareHealthCondition`; produces `hardwareHealthKind`. `monitorCompiler.ts:131` and `alertTemplate.ts:35` already support the required category, single-leaf condition and arbitrary context keys, so neither requires production changes.

- [ ] **Step 1: Write the failing kind and template tests.**

```ts
import { expect, it } from 'vitest';
import { interpolateAlertTemplate } from '@breeze/shared';
import { getMonitorKindSpec, applyOverrides } from './index';
const condition = { componentTypes: ['physical_disk'], minHealth: 'critical', includePredictiveFailure: true, consecutiveSnapshots: 2 };
it('compiles a hardware root with exact templates and category', () => {
  const spec = getMonitorKindSpec('hardware_health');
  expect(spec.toAlertCondition(condition, { monitorId: 'monitor' })).toEqual({ type: 'hardware_health', ...condition });
  expect(spec.alertCategory).toBe('hardware'); expect(spec.agentDelivered).toBe(false); expect(spec.defaultSeverity).toBe('high');
  expect(spec.titleTemplate).toBe('{{componentLabel}} {{stateLabel}} on {{deviceName}}');
  expect(spec.messageTemplate).toBe('{{ruleName}}: {{componentLabel}} is {{stateLabel}} ({{stateDetail}})');
  const context = { componentLabel: 'Physical disk 252:3', stateLabel: 'failed', deviceName: 'server', ruleName: 'Disks', stateDetail: 'Failed' };
  expect(interpolateAlertTemplate(spec.titleTemplate, context)).toBe('Physical disk 252:3 failed on server');
  expect(interpolateAlertTemplate(spec.messageTemplate, context)).toBe('Disks: Physical disk 252:3 is failed (Failed)');
});
it('overrides threshold, predictive inclusion and streak length but not component identity', () => {
  const spec = getMonitorKindSpec('hardware_health');
  expect(applyOverrides(spec, condition, { componentTypes: ['collector'], minHealth: 'warning',
    includePredictiveFailure: false, consecutiveSnapshots: 3 })).toEqual({ ...condition,
    minHealth: 'warning', includePredictiveFailure: false, consecutiveSnapshots: 3 });
  expect(() => applyOverrides(spec, condition, { consecutiveSnapshots: 11 })).toThrow();
});
```

- [ ] **Step 2: Run red.** `cd apps/api && npx vitest run src/services/monitors/kinds/hardwareHealth.test.ts` — `unknown monitor kind: hardware_health`.
- [ ] **Step 3: Create and register the complete kind.**

```ts
import { monitorConditionSchemas } from '@breeze/shared';
import type { HardwareHealthCondition } from '../../alertConditions/types';
import type { MonitorKindSpec } from './types';
type C = Omit<HardwareHealthCondition, 'type'>;
export const hardwareHealthKind: MonitorKindSpec<C> = {
  kind: 'hardware_health', conditionSchema: monitorConditionSchemas.hardware_health,
  overridableKeys: ['minHealth', 'includePredictiveFailure', 'consecutiveSnapshots'],
  defaultSeverity: 'high', agentDelivered: false, alertCategory: 'hardware',
  titleTemplate: '{{componentLabel}} {{stateLabel}} on {{deviceName}}',
  messageTemplate: '{{ruleName}}: {{componentLabel}} is {{stateLabel}} ({{stateDetail}})',
  toAlertCondition: condition => ({ type: 'hardware_health', ...condition }),
};
```

```ts
// kinds/index.ts import and registry entry:
import { hardwareHealthKind } from './hardwareHealth';
// MONITOR_KIND_SPECS:
hardware_health: hardwareHealthKind,
// kinds/index.test.ts SAMPLES:
hardware_health: { componentTypes: ['physical_disk'], minHealth: 'critical', includePredictiveFailure: true, consecutiveSnapshots: 2 },
// Replace existing exact count assertion and its test title:
it('ships twenty kinds with hardware health', () => {
  expect(MONITOR_KINDS).toHaveLength(20);
});
```

Replace the hard-coded route catalog assertion at `routes/monitorDefinitions.test.ts:297` with the following and change its test title to “returns twenty monitor kinds with kind/overridableKeys/defaultSeverity/agentDelivered”. Its existing dynamic kind-set and auth tests remain in place.

```ts
expect(body.data).toHaveLength(20);
expect(body.data.find(entry => entry.kind === 'hardware_health')).toMatchObject({
  overridableKeys: ['minHealth', 'includePredictiveFailure', 'consecutiveSnapshots'],
  defaultSeverity: 'high', agentDelivered: false,
});
```

- [ ] **Step 4: Run green.** `cd apps/api && npx vitest run src/services/monitors/kinds/hardwareHealth.test.ts src/services/monitors/kinds/index.test.ts src/routes/monitorDefinitions.test.ts` — registry, compilation and allowed overrides pass.
- [ ] **Step 5: Commit.**

```bash
git add apps/api/src/services/monitors/kinds/hardwareHealth.ts apps/api/src/services/monitors/kinds/hardwareHealth.test.ts apps/api/src/services/monitors/kinds/index.ts apps/api/src/services/monitors/kinds/index.test.ts apps/api/src/routes/monitorDefinitions.test.ts
git commit -m $'feat(monitors): compile hardware health monitors\n\nCo-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>'
```

### Task 14: Provision four unattached version-3 defaults

**Files:** Modify `apps/api/src/services/monitors/builtInMonitors.ts:38,40,99`, Test/Modify `apps/api/src/services/monitors/builtInMonitors.test.ts:12`, `apps/api/src/__tests__/integration/builtInMonitors.integration.test.ts:113,173,253`.
**Interfaces:** Produces `BUILT_IN_MONITORS_VERSION = 3`, `ThresholdDefaultCondition`, `HardwareHealthDefaultCondition`, widened `BuiltInMonitorDefault`, and the four exact §9.5 defaults. Existing `ensureBuiltInMonitorsForPartner(partnerId, opts?)` preserves version markers, edits and deletions.

- [ ] **Step 1: Replace the first three describe blocks of the unit suite, preserving the category tests below them.**

```ts
describe('version 3 hardware defaults', () => {
  const keys = ['raid_array_degraded','physical_disk_failed','cache_battery_problem','hardware_collector_failing'];
  it('has eight valid defaults, four introduced at version 3', () => {
    expect(BUILT_IN_MONITORS_VERSION).toBe(3); expect(BUILT_IN_MONITOR_DEFAULTS).toHaveLength(8);
    expect(defaultsToProvision(2).map(d => d.key)).toEqual(keys);
    for (const d of BUILT_IN_MONITOR_DEFAULTS) expect(getMonitorKindSpec(d.kind).conditionSchema.safeParse(d.condition).success).toBe(true);
  });
  it('preserves historical version gates', () => {
    expect(defaultsToProvision(null)).toHaveLength(8);
    expect(defaultsToProvision(1).map(d => d.key)).toEqual(['patch_compliance_low', ...keys]);
    expect(defaultsToProvision(3)).toEqual([]);
    expect(BUILT_IN_MONITOR_DEFAULTS.filter(d => d.sinceVersion === 1).map(d => d.key)).toEqual(['cpu_high','memory_high','disk_full']);
    expect(BUILT_IN_MONITOR_DEFAULTS.find(d => d.key === 'patch_compliance_low')?.condition).toEqual({ operator: 'lt', value: 80 });
  });
  it('matches the four approved settings exactly', () => {
    expect(defaultsToProvision(2).map(d => [d.key,d.name,d.condition,d.severity,d.cooldownMinutes,d.sinceVersion])).toEqual([
      ['raid_array_degraded','RAID array degraded or failed',{ componentTypes: ['virtual_disk','controller'], minHealth: 'critical', includePredictiveFailure: false, consecutiveSnapshots: 2 },'critical',60,3],
      ['physical_disk_failed','Physical disk failed or predicted to fail',{ componentTypes: ['physical_disk'], minHealth: 'critical', includePredictiveFailure: true, consecutiveSnapshots: 2 },'high',60,3],
      ['cache_battery_problem','Controller cache battery problem',{ componentTypes: ['cache_battery'], minHealth: 'warning', includePredictiveFailure: false, consecutiveSnapshots: 3 },'medium',240,3],
      ['hardware_collector_failing','Hardware monitoring tool failing',{ componentTypes: ['collector'], minHealth: 'warning', includePredictiveFailure: false, consecutiveSnapshots: 3 },'low',1440,3],
    ]);
  });
});
```

- [ ] **Step 2: Replace the old version-1 rewind integration test with this version-2 upgrade proof.** It uses real helpers already defined at `:60,91,100`; unit tests above retain version-1 coverage.

```ts
it('upgrades version 2 without restoring deleted defaults or overwriting edits', async () => {
  const partner = await newPartner();
  await withDbAccessContext(SYSTEM_CTX, () => ensureBuiltInMonitorsForPartner(partner.id));
  const hardwareKeys = ['raid_array_degraded','physical_disk_failed','cache_battery_problem','hardware_collector_failing'];
  await withDbAccessContext(SYSTEM_CTX, async () => {
    await db.delete(monitorDefinitions).where(and(eq(monitorDefinitions.partnerId, partner.id),
      inArray(monitorDefinitions.builtinKey, [...hardwareKeys, 'cpu_high'])));
    await db.update(monitorDefinitions).set({ enabled: false, cooldownMinutes: 321 })
      .where(and(eq(monitorDefinitions.partnerId, partner.id), eq(monitorDefinitions.builtinKey, 'memory_high')));
    await db.update(partners).set({ settings: sql`jsonb_build_object('builtInMonitors', jsonb_build_object(
      'version', 2, 'provisionedAt', '2026-01-01T00:00:00.000Z'))` }).where(eq(partners.id, partner.id));
  });
  const before = await builtInsFor(partner.id);
  const result = await withDbAccessContext(SYSTEM_CTX, () => ensureBuiltInMonitorsForPartner(partner.id));
  expect(result.monitorIds).toHaveLength(4);
  const after = await builtInsFor(partner.id);
  expect(after.filter(row => hardwareKeys.includes(row.builtinKey!))).toHaveLength(4);
  expect(after.some(row => row.builtinKey === 'cpu_high')).toBe(false);
  for (const row of before) expect(after.find(next => next.id === row.id)).toEqual(row);
  expect(await marker(partner.id)).toMatchObject({ version: 3, provisionedAt: '2026-01-01T00:00:00.000Z' });
  expect(await withDbAccessContext(SYSTEM_CTX, () => ensureBuiltInMonitorsForPartner(partner.id))).toEqual({ provisioned: false, monitorIds: [] });
});
```

Replace the other assertions at their inspected anchors with this exact code; leave the setup's deliberate `version: 2` untouched. Keep the existing actual `resolveMonitorsForDevice` empty-list assertion, which proves no attachments.

```ts
// builtInMonitors.integration.test.ts:120, first provisioning test:
expect(rows.map(r => r.builtinKey).sort()).toEqual(BUILT_IN_MONITOR_DEFAULTS.map(d => d.key).sort());
// :145, first provisioning marker:
expect(await marker(partner.id)).toMatchObject({ version: 3 });
// :153, second-call row count:
expect(await builtInsFor(partner.id)).toHaveLength(BUILT_IN_MONITOR_DEFAULTS.length);
// :166, deleted CPU row:
expect((await builtInsFor(partner.id)).map(r => r.builtinKey).sort()).toEqual(
  BUILT_IN_MONITOR_DEFAULTS.filter(d => d.key !== 'cpu_high').map(d => d.key).sort(),
);
// :253, real partner-creation service:
expect(rows).toHaveLength(BUILT_IN_MONITOR_DEFAULTS.length);
// :255:
expect(await marker(created.partnerId)).toMatchObject({ version: 3 });
// :274–275, boot backfill:
expect(await builtInsFor(fresh.id)).toHaveLength(BUILT_IN_MONITOR_DEFAULTS.length);
expect(await builtInsFor(done.id)).toHaveLength(BUILT_IN_MONITOR_DEFAULTS.length - 1);
```

- [ ] **Step 3: Run red.** `cd apps/api && npx vitest run src/services/monitors/builtInMonitors.test.ts` — expected version 3/eight defaults; received version 2/four. `cd apps/api && npx vitest run -c vitest.integration.config.ts src/__tests__/integration/builtInMonitors.integration.test.ts` — expected four upgrade IDs; received none.
- [ ] **Step 4: Replace the version/interface, import the hardware condition type, and append these defaults.**

```ts
import type { HardwareHealthCondition } from '../alertConditions/types';
export const BUILT_IN_MONITORS_VERSION = 3;
export interface ThresholdDefaultCondition {
  operator: 'gt' | 'gte' | 'lt' | 'lte'; value: number; durationMinutes?: number;
}
export type HardwareHealthDefaultCondition = Omit<HardwareHealthCondition, 'type'>;
export interface BuiltInMonitorDefault {
  key: 'cpu_high' | 'memory_high' | 'disk_full' | 'patch_compliance_low'
    | 'raid_array_degraded' | 'physical_disk_failed' | 'cache_battery_problem' | 'hardware_collector_failing';
  name: string; description: string; kind: MonitorKind;
  condition: ThresholdDefaultCondition | HardwareHealthDefaultCondition;
  severity: 'critical' | 'high' | 'medium' | 'low'; cooldownMinutes: number; sinceVersion: number;
}
// Append inside BUILT_IN_MONITOR_DEFAULTS, preserving the four existing entries:
{
  key: 'raid_array_degraded', name: 'RAID array degraded or failed',
  description: 'Alerts after two critical array or controller snapshots.', kind: 'hardware_health',
  condition: { componentTypes: ['virtual_disk','controller'], minHealth: 'critical', includePredictiveFailure: false, consecutiveSnapshots: 2 },
  severity: 'critical', cooldownMinutes: 60, sinceVersion: 3,
},
{
  key: 'physical_disk_failed', name: 'Physical disk failed or predicted to fail',
  description: 'Alerts after two critical or predictive-failure disk snapshots.', kind: 'hardware_health',
  condition: { componentTypes: ['physical_disk'], minHealth: 'critical', includePredictiveFailure: true, consecutiveSnapshots: 2 },
  severity: 'high', cooldownMinutes: 60, sinceVersion: 3,
},
{
  key: 'cache_battery_problem', name: 'Controller cache battery problem',
  description: 'Alerts after three unhealthy controller cache battery snapshots.', kind: 'hardware_health',
  condition: { componentTypes: ['cache_battery'], minHealth: 'warning', includePredictiveFailure: false, consecutiveSnapshots: 3 },
  severity: 'medium', cooldownMinutes: 240, sinceVersion: 3,
},
{
  key: 'hardware_collector_failing', name: 'Hardware monitoring tool failing',
  description: 'Alerts after three failed or backing-off collector snapshots.', kind: 'hardware_health',
  condition: { componentTypes: ['collector'], minHealth: 'warning', includePredictiveFailure: false, consecutiveSnapshots: 3 },
  severity: 'low', cooldownMinutes: 1440, sinceVersion: 3,
},
```

Update the file header to say eight defaults. Provisioning itself needs no new branch: it already uses `sinceVersion`, compiles every new monitor and attaches none.

- [ ] **Step 5: Run green and commit.** Unit settings, real compiled rows, no attachments, edits/deletions and v2→v3 idempotence all pass.

```bash
cd apps/api && npx vitest run src/services/monitors/builtInMonitors.test.ts
```

```bash
cd apps/api && npx vitest run -c vitest.integration.config.ts src/__tests__/integration/builtInMonitors.integration.test.ts
```

```bash
git add apps/api/src/services/monitors/builtInMonitors.ts apps/api/src/services/monitors/builtInMonitors.test.ts apps/api/src/__tests__/integration/builtInMonitors.integration.test.ts
git commit -m $'feat(monitors): provision hardware defaults at version three\n\nCo-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>'
```

### Task 15: Author hardware monitors with an accessible component multiselect

**Files:** Modify `apps/web/src/components/monitoring/monitorKindFields.ts:10,47,254`, `apps/web/src/components/monitoring/MonitorConditionFields.tsx:15,85`, `apps/web/src/components/monitoring/monitorKindFields.test.ts:125`, `apps/web/src/locales/{en,de-DE,es-419,fr-CA,fr-FR,it-IT,pt-BR,tr-TR}/monitoring.json`; Create/Test `apps/web/src/components/monitoring/MonitorConditionFields.hardwareHealth.test.tsx`.
**Interfaces:** Adds `'multiselect'` to `FieldKind`, reuses `KindField.options`, renders an array of component strings through react-hook-form. Produces the exact `defaultConditionFor('hardware_health')` contract. No new mutation or fetching path.

- [ ] **Step 1: Write the jsdom form test.**

```tsx
import '@/lib/i18n';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { FormProvider, useForm } from 'react-hook-form';
import { expect, it, vi } from 'vitest';
import MonitorConditionFields from './MonitorConditionFields';
import { defaultConditionFor } from './monitorKindFields';
function Harness({ submit }: { submit: (value: unknown) => void }) {
  const form = useForm({ defaultValues: { condition: defaultConditionFor('hardware_health') } });
  return <FormProvider {...form}><form onSubmit={form.handleSubmit(submit)}>
    <MonitorConditionFields kind="hardware_health" name="condition" />
    <button type="submit" data-testid="save">Save</button>
    <button type="button" data-testid="reset" onClick={() => form.reset({ condition: {
      ...defaultConditionFor('hardware_health'), componentTypes: ['collector'],
    } })}>Reset</button>
    <button type="button" data-testid="error" onClick={() => form.setError('condition.componentTypes', {
      message: 'Select at least one component',
    })}>Error</button>
  </form></FormProvider>;
}
it('submits a string array, clears it, resets from saved values and shows validation', async () => {
  const submit = vi.fn(); render(<Harness submit={submit} />);
  const checkbox = (key: string) => screen.getByTestId(`condition-field-componentTypes-${key}`) as HTMLInputElement;
  expect(checkbox('virtual_disk').checked).toBe(true); expect(checkbox('physical_disk').checked).toBe(true);
  expect(screen.queryByTestId('condition-field-componentTypes-bmc')).toBeNull();
  expect(screen.getByText('Components')).toBeTruthy(); expect(screen.getByText('Monitoring tools')).toBeTruthy();
  fireEvent.click(checkbox('controller')); fireEvent.click(screen.getByTestId('save'));
  await waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
  expect(submit.mock.calls[0]![0].condition).toEqual({ componentTypes: ['controller','virtual_disk','physical_disk'],
    minHealth: 'critical', includePredictiveFailure: true, consecutiveSnapshots: 2 });
  for (const key of ['controller','virtual_disk','physical_disk']) fireEvent.click(checkbox(key));
  fireEvent.click(screen.getByTestId('save'));
  await waitFor(() => expect(submit).toHaveBeenCalledTimes(2));
  expect(submit.mock.calls[1]![0].condition.componentTypes).toEqual([]);
  fireEvent.click(screen.getByTestId('reset'));
  expect(checkbox('collector').checked).toBe(true); expect(checkbox('virtual_disk').checked).toBe(false);
  fireEvent.click(screen.getByTestId('error'));
  expect(screen.getByText('Select at least one component')).toBeTruthy();
});
```

- [ ] **Step 2: Run red.** `cd apps/web && npx vitest run src/components/monitoring/MonitorConditionFields.hardwareHealth.test.tsx` — missing field map/default or checkbox test IDs.
- [ ] **Step 3: Add field metadata and the default seed.** Add `'multiselect'` to the `FieldKind` union at line 10.

```ts
// MONITOR_KIND_FIELDS entry:
hardware_health: [
  { key: 'componentTypes', labelKey: 'monitoring:monitors.fields.hardware_health.componentTypes', kind: 'multiselect',
    options: ['controller','virtual_disk','physical_disk','cache_battery','enclosure','collector'] },
  { key: 'minHealth', labelKey: 'monitoring:monitors.fields.hardware_health.minHealth', kind: 'select', options: ['warning','critical'] },
  { key: 'includePredictiveFailure', labelKey: 'monitoring:monitors.fields.hardware_health.includePredictiveFailure', kind: 'boolean' },
  { key: 'consecutiveSnapshots', labelKey: 'monitoring:monitors.fields.hardware_health.consecutiveSnapshots', kind: 'number', min: 1, max: 10 },
],
// defaultConditionFor switch:
case 'hardware_health':
  return { componentTypes: ['virtual_disk','physical_disk'], minHealth: 'critical', includePredictiveFailure: true, consecutiveSnapshots: 2 };
// SELECT_OPTION_NAMESPACE entries:
'hardware_health:componentTypes': 'monitors.fields.hardware_health.componentTypeOptions',
'hardware_health:minHealth': 'monitors.fields.hardware_health.minHealthOptions',
```

- [ ] **Step 4: Insert the checkbox group before the boolean branch.** Native registered checkboxes share the same path and preserve array values on submit/reset. Fieldset/legend supplies a group label; every checkbox has its own label and test ID.

```tsx
if (field.kind === 'multiselect') {
  const ns = SELECT_OPTION_NAMESPACE[`${kind}:${field.key}`] ?? SELECT_OPTION_NAMESPACE[field.key];
  return (
    <fieldset key={field.key} data-testid={`condition-field-${field.key}`} className="space-y-2 sm:col-span-2"
      aria-describedby={fieldError ? `condition-error-${field.key}` : undefined}>
      <legend className="text-xs font-medium text-muted-foreground">{label}</legend>
      <div className="grid gap-2 sm:grid-cols-2">
        {(field.options ?? []).map(option => {
          const id = `condition-field-${field.key}-${option}`;
          return <label key={option} htmlFor={id} className="flex items-center gap-2 text-sm">
            <input id={id} data-testid={id} type="checkbox" value={option}
              className="h-4 w-4 rounded border" {...register(path)} />
            {t(/* i18n-dynamic */ `${ns}.${option}`, { defaultValue: option })}
          </label>;
        })}
      </div>
      {fieldError && <p id={`condition-error-${field.key}`} className="text-xs text-destructive">{fieldError}</p>}
    </fieldset>
  );
}
```

- [ ] **Step 5: Add English first, demonstrate the parity failure, then supply every locale.** Save this complete merge script from the repository root, then run the explicit red/green commands below. It changes only the new keys and preserves every existing translation. Then run `cd apps/web && npx vitest run src/lib/i18n/localeParity.test.ts` — red: seven catalogs lack `kinds.hardware_health` and `monitors.fields.hardware_health.*`. Re-run the same script with `HW_MONITOR_LOCALES=all` to add the translated values to all eight catalogs; W03 does not wait for W04 translations.

```bash
cat > /tmp/breeze-hardware-monitor-locales.py <<'PY_LOCALES'
import json
import os
from pathlib import Path

translations = {
    'en': ['Hardware health', 'Components', 'Minimum health', 'Include predictive failure', 'Consecutive snapshots', 'Controllers', 'Virtual disks', 'Physical disks', 'Cache batteries', 'Enclosures', 'Monitoring tools', 'Warning', 'Critical'],
    'de-DE': ['Hardwarezustand', 'Komponenten', 'Mindestzustand', 'Vorhergesagte Ausfälle einbeziehen', 'Aufeinanderfolgende Momentaufnahmen', 'Controller', 'Virtuelle Datenträger', 'Physische Datenträger', 'Cache-Batterien', 'Gehäuse', 'Überwachungstools', 'Warnung', 'Kritisch'],
    'es-419': ['Estado del hardware', 'Componentes', 'Estado mínimo', 'Incluir fallas previstas', 'Instantáneas consecutivas', 'Controladoras', 'Discos virtuales', 'Discos físicos', 'Baterías de caché', 'Gabinetes', 'Herramientas de monitoreo', 'Advertencia', 'Crítico'],
    'fr-CA': ['État du matériel', 'Composants', 'État minimal', 'Inclure les défaillances prédites', 'Instantanés consécutifs', 'Contrôleurs', 'Disques virtuels', 'Disques physiques', 'Batteries de cache', 'Boîtiers', 'Outils de surveillance', 'Avertissement', 'Critique'],
    'fr-FR': ['État du matériel', 'Composants', 'État minimal', 'Inclure les défaillances prédites', 'Instantanés consécutifs', 'Contrôleurs', 'Disques virtuels', 'Disques physiques', 'Batteries de cache', 'Boîtiers', 'Outils de surveillance', 'Avertissement', 'Critique'],
    'it-IT': ['Stato hardware', 'Componenti', 'Stato minimo', 'Includi guasti previsti', 'Istantanee consecutive', 'Controller', 'Dischi virtuali', 'Dischi fisici', 'Batterie della cache', 'Alloggiamenti', 'Strumenti di monitoraggio', 'Avviso', 'Critico'],
    'pt-BR': ['Integridade do hardware', 'Componentes', 'Integridade mínima', 'Incluir falhas previstas', 'Instantâneos consecutivos', 'Controladoras', 'Discos virtuais', 'Discos físicos', 'Baterias de cache', 'Gabinetes', 'Ferramentas de monitoramento', 'Aviso', 'Crítico'],
    'tr-TR': ['Donanım sağlığı', 'Bileşenler', 'En düşük sağlık düzeyi', 'Öngörülen arızaları dahil et', 'Ardışık anlık görüntüler', 'Denetleyiciler', 'Sanal diskler', 'Fiziksel diskler', 'Önbellek pilleri', 'Kasalar', 'İzleme araçları', 'Uyarı', 'Kritik'],
}
selected = translations if os.environ['HW_MONITOR_LOCALES'] == 'all' else {'en': translations['en']}
for locale, values in selected.items():
    path = Path('apps/web/src/locales') / locale / 'monitoring.json'
    catalog = json.loads(path.read_text())
    catalog['kinds']['hardware_health'] = values[0]
    fields = catalog.setdefault('monitors', {}).setdefault('fields', {}).setdefault('hardware_health', {})
    fields.update(dict(zip(['componentTypes', 'minHealth', 'includePredictiveFailure', 'consecutiveSnapshots'], values[1:5])))
    fields['componentTypeOptions'] = dict(zip(['controller', 'virtual_disk', 'physical_disk', 'cache_battery', 'enclosure', 'collector'], values[5:11]))
    fields['minHealthOptions'] = dict(zip(['warning', 'critical'], values[11:13]))
    path.write_text(json.dumps(catalog, ensure_ascii=False, indent=2) + '\n')
PY_LOCALES
```

```bash
HW_MONITOR_LOCALES=en python3 /tmp/breeze-hardware-monitor-locales.py
(cd apps/web && npx vitest run src/lib/i18n/localeParity.test.ts)
# Expected red: new English keys are missing from the seven other catalogs.
HW_MONITOR_LOCALES=all python3 /tmp/breeze-hardware-monitor-locales.py
```

Extend the existing field-option translation contract at `monitorKindFields.test.ts:125` to include the new renderer:

```ts
if (field.kind !== 'select' && field.kind !== 'multiselect') continue;
```

- [ ] **Step 6: Run green and commit.** `cd apps/web && npx vitest run src/components/monitoring/MonitorConditionFields.hardwareHealth.test.tsx src/components/monitoring/monitorKindFields.test.ts src/lib/i18n/localeParity.test.ts` — array/reset/error test and exhaustive schema/translation checks pass.

```bash
git add apps/web/src/components/monitoring/monitorKindFields.ts apps/web/src/components/monitoring/MonitorConditionFields.tsx apps/web/src/components/monitoring/monitorKindFields.test.ts apps/web/src/components/monitoring/MonitorConditionFields.hardwareHealth.test.tsx apps/web/src/locales/{en,de-DE,es-419,fr-CA,fr-FR,it-IT,pt-BR,tr-TR}/monitoring.json
git commit -m $'feat(web): add hardware monitor component selection\n\nCo-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>'
```

Run these wave acceptance commands after the final task; every command must exit zero. Start the stack only if Task 2 did not leave this worktree's stack running; tear it down afterward. Do not treat a truncated TypeScript log as success.

```bash
cd apps/api && npx vitest run
```

```bash
NODE_OPTIONS=--max-old-space-size=12288 pnpm --filter @breeze/api exec tsc --noEmit
```

```bash
cd apps/api && npx vitest run -c vitest.integration.config.ts src/db/hardwareAlertMigrations.integration.test.ts src/services/alertSubjects.integration.test.ts src/__tests__/integration/builtInMonitors.integration.test.ts src/__tests__/integration/monitorEpisodes.integration.test.ts src/__tests__/integration/tenant-export-policy.integration.test.ts src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts src/__tests__/integration/tenantCascade.integration.test.ts src/__tests__/integration/orgMergeRegistry.integration.test.ts
```

```bash
DB_CONTEXTLESS_WRITE_STRICT=true pnpm --filter=@breeze/api test:rls-coverage
```

```bash
pnpm db:check-drift
pnpm test-stack down
```

Before implementation commits, re-check the committed migration ceiling with `ls apps/api/migrations | sort | tail -1` per index migration slots. If `origin/main` moved beyond the reserved names, apply the index's rename-upward rule and update every test path/reference together. No agent code changes belong to this wave; agent race/vet and native Windows execution remain W02a/W02b/W05 gates.

## Self-review

- Spec §9.1: nullable subject identity, nonempty CHECK, NULL-only historic dedupe, atomic insert and subject noise controls are pinned by Tasks 3, 6 and 8.
- Spec §9.1/D7: Tasks 7–11 retain one episode owner, commit ownership and its outbox envelope before publication, compensate failed-publication claims and prove two notifications with one real automation run.
- Spec §9.1: Tasks 9–10 honor autoResolve, ignore custom autoResolveConditions for subjects, preserve unknown/absent subjects and derive observation from remaining open alerts.
- Spec §9.2–§9.4: Tasks 1, 4, 5, 13 and 15 implement the exact leaf, streak/freshness evidence, compiler templates, registration and checkbox editor.
- Spec §9.5/D9: Task 14 provisions exactly four version-3 defaults partner-wide without attachments, preserving earlier edits/deletions.
- Spec §7.3 retirement: Task 12 fills W01's declared resolver; W01 owns stale marking, ingest/reaper/device-delete invocation, component storage and freshness; W03 owns retirement recovery storage and dispatch.
- W02a/W02b own agent collection and ingest streak inputs; W04 owns device storage UI/list/docs; W05 owns BMC facts/linking; W06 owns hardware lab proof.
- Index §F ambiguities resolved: define HardwareHealthComponentFilter locally; preserve createAlert's actual ID return, use pre-publish atomic ownership, and retain the literal i18n key path within the existing namespace.
- Index §F sweep-order correction (Tasks 8–10): lazy allocation follows successful subject insertion, writes no observation, and is adopted by the single final observation derived from admitted open alerts. Suppressed sweeps create no episodes; partial admission counts once; recurrence windows and human-reset floors retain their existing calculation.

- Cross-plan review: Task 6 runs the real `alertCooldown.rekey.test.ts` regression suite and explicitly pins legacy cooldown, adaptive and flapping keys.
- D6 compatibility: Tasks 8/10 keep NULL-subject episode linking after publication with the existing best-effort catch; a bookkeeping failure never deletes a legacy alert.
- Locale boundary: Task 15 supplies the kind, field and option keys in all eight monitoring catalogs and runs `localeParity.test.ts`; no W04 translation dependency remains.
- Retirement correction (Task 12): the unchanged W01 seam now resolves and stages in the ambient transaction. W03 supplies a forced-RLS org-scoped retirement outbox that survives device/alert deletion, with org cascade/merge/export registrations and minute dispatch. W01 retains ingest/reaper/delete call sites; no other wave is assigned new work.

- Publication boundary: Tasks 8/10 store the subject event envelope and atomic ownership claim in one transaction, drain only after the outer worker commit, compensate publication failures in a new transaction, and keep post-publication Redis failures from rolling back ownership. Integration tests cover commit visibility, outer rollback, parallel drain claims, publish failure and cooldown failure. The minute tick retries durable pending events even for offline devices.

- The publication fix covers subject recovery and hardware recurrence: Task 9 stages recovery, Task 10 cancels pending triggers and stages requires-human alerts only from committed admitted breaches, and Task 12 explicitly opts retirement into deferred recovery. Legacy NULL-subject resolution retains its default path.
- Manual-resolution correction (Task 8): both real web/mobile `setCooldown` writers pass `alert.subjectKey ?? undefined`; route CAS tests cover subject and NULL keys alongside the Redis/fallback isolation tests.
- D7 replay correction (Tasks 10–11): `responses_admitted_at IS NULL` is an atomic episode admission gate; claim, run and response envelope commit together. `automation.started` and queue writes follow commit. Replay after alert-outbox acknowledgement failure and trigger-job eviction cannot create a second run; failed response dispatch retries the committed run. This adds only W03-owned columns to the reserved, unshipped `100300` migration.
- Verification: read `episodeService.ts` fully, both route cooldown writers, `resolveAlert`, `eventBus.publish`, the automation worker/runtime and shared device cascade. Added red/green recurrence, manual-resolution, retirement rollback/deletion/RLS and response replay/outer-commit tests to this implementation plan; no application tests were executed while editing documentation.
