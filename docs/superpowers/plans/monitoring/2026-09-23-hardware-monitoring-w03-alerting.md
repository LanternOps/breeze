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
| Create | `apps/api/migrations/2026-10-27-100300-alert-subject-key.sql` | Subject column, dedupe, CHECK, partial unique |
| Create | `apps/api/src/db/hardwareAlertMigrations.integration.test.ts` | Disposable PostgreSQL replay tests |
| Modify | `apps/api/vitest.integration.config.ts:13` | Discover new co-located database suites |
| Modify | `apps/api/vitest.config.ts:18` | Exclude those suites from unit runner |
| Modify | `apps/api/src/db/schema/monitorDefinitions.ts:33` | Append DB enum label |
| Modify | `apps/api/src/db/schema/alerts.ts:115,151` | Subject column and index/CHECK declarations |
| Modify | `apps/api/src/services/tenantExportPolicyRegistry.ts:130` | Classify new scalar export column |
| Create | `apps/api/src/services/alertConditions/handlers/hardwareHealth.ts` | Fresh component evidence and per-rank streaks |
| Create | `apps/api/src/services/alertConditions/handlers/hardwareHealth.test.ts` | Matrix and flapping regression |
| Modify | `apps/api/src/services/alertConditions/index.ts:32,50,99,187,227` | Registration and root-leaf propagation |
| Create | `apps/api/src/services/alertConditions/subjects.test.ts` | Groups discard subjects |
| Modify | `apps/api/src/services/alertCooldown.ts:43,54,82,416,452` | Four optional subject-key helpers |
| Create | `apps/api/src/services/alertCooldown.subjects.test.ts` | Redis and fallback isolation |
| Modify | `apps/api/src/services/monitors/episodeService.ts:367` | Atomic first-alert claim |
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

Decisions: `HardwareHealthComponentFilter` is defined here as `Exclude<HardwareComponentType, 'bmc'>` (index §F names it but does not declare it). `RETURNING id` yields `{ id: string }[]`; `createAlert` actually returns `Promise<string | null>` (`alertService.ts:167,296`), so no full-row mapping or hydration is required. `responsesOwner` is computed immediately after `linkEpisodeAlert`, before `alert.triggered` publication. The subject path opens/reuses an episode, atomically stores ownership and a pending publication in the alert context, and records the authoritative post-reconciliation observation under the rule/device lock. Task 10 publishes only after the outer transaction commits. An all-cooldown-suppressed sweep may provisionally open then close an episode, following §9.1's explicit final observation rule. UI keys remain literally `monitors.fields.hardware_health.*` inside the existing `monitoring` namespace; Task 15 supplies them in all eight catalogs and runs locale parity.

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

**Files:** Modify `apps/api/src/services/alertService.ts:45,167,438,751,791`, `apps/api/src/services/alertService.test.ts:18,113`, `apps/api/src/services/alertService.episodes.test.ts:49,269`, `apps/api/src/services/alertService.networkCheck.test.ts:47,259`; Create/Test `apps/api/src/services/alertService.subjects.test.ts`.
**Interfaces:** Consumes Task 6 helpers and Task 7 `linkEpisodeAlert`; produces `CreateAlertParams.subjectKey?: string`, the unchanged `createAlert(params: CreateAlertParams): Promise<string | null>`, and `alert.triggered` fields `subjectKey: string | null`, `responsesOwner: boolean`.

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

The subject row's existing tenant-scoped, export-excluded `context` holds the transactional outbox envelope; no new table or migration slot is needed. Task 10 drains `_subjectDispatch` after the **outer** context commits. A subject ID means a committed-or-pending insert, not a completed notification; NULL-subject publication/return semantics stay synchronous. Add this exported type next to `CreateAlertParams`:

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
    episodeId, requiresHuman, subjectKey } = params;
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
      const responsesOwner = episodeId ? (await linkEpisodeAlert(episodeId, newAlert.id)).owner : false;
      const pending: SubjectAlertDispatch = {
        eventId: newAlert.id, eventType: 'alert.triggered', siteId: await resolveDeviceSiteId(deviceId), cooldownMinutes,
        payload: { alertId: newAlert.id, ruleId, deviceId, severity, title, message,
          ...monitorFields, subjectKey, responsesOwner },
      };
      await db.update(alerts).set({ context: { ...context, _subjectDispatch: pending } })
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
// resolveAlert, current line 791:
await setCooldown(alert.ruleId, alert.deviceId, cooldownMinutes, alert.subjectKey ?? undefined);
// alertService.test.ts dbMock object, alongside insert:
execute: vi.fn(() => Promise.resolve(insertReturnResults.shift() ?? [])),
// Replace the first correlation test's insert-count assertion only:
expect(dbMock.execute).toHaveBeenCalledTimes(1);
```

For subject recovery inside the locked sweep, extend `resolveAlert` with a fourth argument `deferSubjectEffects = false`, import `randomUUID` from `node:crypto`, and insert this branch immediately after its existing `if (!alert) return false` CAS guard. The default preserves existing callers, including Task 12's retirement-before-cascade path; only Task 9 opts in. Replace its signature with:

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
if (deferSubjectEffects && alert.subjectKey && alert.ruleId) {
  const [rule] = await db.select().from(alertRules).where(eq(alertRules.id, alert.ruleId)).limit(1);
  const [template] = rule
    ? await db.select().from(alertTemplates).where(eq(alertTemplates.id, rule.templateId)).limit(1)
    : [];
  const overrides = rule?.overrideSettings as Record<string, unknown> | null;
  const pending: SubjectAlertDispatch = {
    eventId: randomUUID(), eventType: 'alert.resolved',
    siteId: await resolveDeviceSiteId(alert.deviceId),
    cooldownMinutes: (overrides?.cooldownMinutes as number) ?? template?.cooldownMinutes ?? 15,
    payload: { alertId, ruleId: alert.ruleId, deviceId: alert.deviceId, resolutionNote,
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

- [ ] **Step 5: Run green and commit.** `cd apps/api && npx vitest run src/services/alertService.subjects.test.ts src/services/alertService.test.ts src/services/alertService.episodes.test.ts src/services/alertService.networkCheck.test.ts` — subject and existing sourced paths pass. Task 10 proves commit visibility, outbox rollback and publication compensation against PostgreSQL.

```bash
git add apps/api/src/services/alertService.ts apps/api/src/services/alertService.test.ts apps/api/src/services/alertService.episodes.test.ts apps/api/src/services/alertService.networkCheck.test.ts apps/api/src/services/alertService.subjects.test.ts
git commit -m $'feat(alerts): atomically insert and publish subject alerts\n\nCo-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>'
```

### Task 9: Reconcile per-subject alerts and derive the final observation

**Files:** Create `apps/api/src/services/alertSubjects.ts`; Create/Test `apps/api/src/services/alertSubjects.test.ts`.
**Interfaces:** Consumes `RuleWithTemplate['rule'/'template'/'monitor']`, device row, and `EvaluationResult`; produces `evaluateSubjectAlerts({ rule, template, device, monitor, evidence }): Promise<MonitorObservation>`. Decision: `evidence` additionally carries `createdAlertIds: string[]`, the caller-owned accumulator preserving `evaluateDeviceAlerts(): Promise<string[]>` without widening the contract's return type.

- [ ] **Step 1: Write the lifecycle matrix.**

```ts
import { beforeEach, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({ open: [] as any[], create: vi.fn(), resolve: vi.fn(), record: vi.fn() }));
vi.mock('../db', () => ({ db: { select: () => ({ from: () => ({ where: async () => [...m.open] }) }) } }));
vi.mock('./alertService', () => ({ RESOLVABLE_ALERT_STATUSES: ['active','acknowledged','suppressed'], createAlert: m.create, resolveAlert: m.resolve }));
vi.mock('./monitors/episodeService', () => ({ recordMonitorEvaluation: m.record }));
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
  m.record.mockResolvedValue({ episodeId: 'episode', latched: false, needsEscalationAlert: false });
  m.create.mockImplementation(async (p: any) => {
    if (m.open.some(a => a.subjectKey === p.subjectKey)) return null;
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
  expect(m.create).toHaveBeenLastCalledWith(expect.objectContaining({ orgId: 'device-org', subjectKey: 'b', episodeId: 'episode' }));
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
import { recordMonitorEvaluation, type MonitorObservation } from './monitors/episodeService';
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
  let episodeId: string | null = null;
  if (monitor && subjects.some(s => s.status === 'breaching')) {
    const outcome = await recordMonitorEvaluation({ monitor, deviceId: device.id, orgId: device.orgId, observation: 'breach' });
    episodeId = outcome.episodeId;
    // The committed latch is drained by Task 10, after the outer commit.
  }
  for (const subject of subjects) {
    if (subject.status !== 'breaching') continue;
    const context = { ...evidence.context, ...subject.context, source: 'hardware_health', subjectKey: subject.subjectKey,
      deviceName: device.displayName || device.hostname, hostname: device.hostname, osType: device.osType,
      osVersion: device.osVersion, ruleName: rule.name, severity, actualValue: subject.actualValue,
      templateId: template.id, cooldownMinutes: (overrides?.cooldownMinutes as number) ?? template.cooldownMinutes };
    const id = await createAlert({ ruleId: rule.id, deviceId: device.id, orgId: device.orgId, subjectKey: subject.subjectKey,
      severity, title: interpolateAlertTemplate(template.titleTemplate, context), message: interpolateAlertTemplate(template.messageTemplate, context),
      context, monitorId: rule.managedByMonitorId, kind: monitor?.kind, episodeId });
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

- [ ] **Step 4: Run green.** `cd apps/api && npx vitest run src/services/alertSubjects.test.ts` — independent creation/recovery and open-alert observation matrix pass.
- [ ] **Step 5: Commit.**

```bash
git add apps/api/src/services/alertSubjects.ts apps/api/src/services/alertSubjects.test.ts
git commit -m $'feat(alerts): reconcile component subjects independently\n\nCo-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>'
```

### Task 10: Commit subject ownership and outbox before publication

**Files:** Modify `apps/api/src/services/alertService.ts:12,1095,1194`, `apps/api/vitest.integration.config.ts:13`, `apps/api/vitest.config.ts:18`; Create `apps/api/src/services/subjectAlertOutbox.ts`; Modify `apps/api/src/jobs/alertWorker.ts:122,170`, `apps/api/src/jobs/alertWorker.test.ts`, `apps/api/src/jobs/alertQueue.test.ts`; Create/Test `apps/api/src/services/alertSubjects.integration.test.ts`.
**Interfaces:** Consumes `withDbTransaction<T>(fn: () => Promise<T>): Promise<T>` (`db/index.ts:946`), `evaluateSubjectAlerts`, and `recordMonitorEvaluation(input: RecordEvaluationInput): Promise<RecordEvaluationResult>`. Preserves `evaluateDeviceAlerts(deviceId: string): Promise<string[]>`; leaves `evaluateDeviceAlertsFromPolicy` unchanged. Adds `drainSubjectAlertOutbox(deviceId?: string): Promise<void>`, called with no ambient database context. `_subjectDispatch` is durable in the existing RLS-protected alerts row and commits with the episode owner; this is a transactional outbox, not an in-memory callback list. `withDbTransaction` alone is a savepoint, not a commit.

- [ ] **Step 1: Write the real database fixture and failing sweep/race tests.** Only external publication, correlation, policy selection and noise controls are stubbed; alerts, components, episodes, RLS and all lifecycle writes use real PostgreSQL.

```ts
import '../__tests__/integration/setup';
import { getTestDb } from '../__tests__/integration/setup';
import { createPartner, createOrganization, createSite } from '../__tests__/integration/db-utils';
import { randomUUID } from 'node:crypto';
import { beforeEach, expect, it, vi } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext } from '../db';
import { alerts, alertRules, alertTemplates, devices, monitorDefinitions, monitorEpisodes, monitorDeviceState,
  deviceHardwareHealth, deviceHardwareComponents, automations, automationRuns } from '../db/schema';
const m = vi.hoisted(() => ({ publish: vi.fn(), monitorId: '', notify: vi.fn(), queue: vi.fn(), flap: vi.fn(), cooldown: vi.fn() }));
vi.mock('./eventBus', async original => ({ ...await original<typeof import('./eventBus')>(), publishEvent: m.publish }));
vi.mock('../jobs/alertCorrelation', () => ({ enqueueAlertCorrelation: vi.fn().mockResolvedValue('correlation-job') }));
vi.mock('./alertCooldown', async original => ({ ...await original<typeof import('./alertCooldown')>(),
  isCooldownActive: async () => false, isFlapping: m.flap, setCooldown: m.cooldown, recordStateTransition: async () => {} }));
vi.mock('./monitors/monitorResolver', () => ({ resolveMonitorsForDevice: async () => ({ kind: 'resolved', monitors: [
  { monitorId: m.monitorId, enabled: true, overrides: null, sourcePolicyId: 'test', sourceLevel: 'device', inheritedFromParent: false },
] }) }));
import { createAlert, evaluateDeviceAlerts } from './alertService';
import { drainSubjectAlertOutbox } from './subjectAlertOutbox';
import { recordMonitorEvaluation } from './monitors/episodeService';
beforeEach(() => { vi.clearAllMocks(); m.publish.mockResolvedValue(undefined); m.flap.mockReset().mockResolvedValue(false); m.cooldown.mockReset().mockResolvedValue(undefined); });
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
          .set({ context: sql`${alerts.context} - ${slot}` }).where(ownsLease));
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

- [ ] **Step 6: Run green.** `cd apps/api && npx vitest run -c vitest.integration.config.ts src/services/alertSubjects.integration.test.ts` — two subjects, own recovery, stable episode, both race variants and RLS isolation pass.
- [ ] **Step 7: Commit.**

```bash
git add apps/api/src/services/alertService.ts apps/api/src/services/alertSubjects.integration.test.ts apps/api/vitest.integration.config.ts apps/api/vitest.config.ts apps/api/src/services/subjectAlertOutbox.ts apps/api/src/jobs/alertWorker.ts apps/api/src/jobs/alertWorker.test.ts apps/api/src/jobs/alertQueue.test.ts
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
  Worker: class { on() {} }, Job: class {}, UnrecoverableError: class extends Error {},
}));
vi.mock('./redis', async original => ({ ...await original<typeof import('./redis')>(),
  isRedisAvailable: () => true, getRedisConnection: () => ({}), getBullMQConnection: () => ({}) }));
vi.mock('./notificationSenders', async original => ({ ...await original<typeof import('./notificationSenders')>(), sendInAppNotification: m.notify }));
import { __testOnly as automationWorker } from '../jobs/automationWorker';
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

- [ ] **Step 3: Run red, then add the guard.** `cd apps/api && npx vitest run src/jobs/automationWorker.subjects.test.ts` — expected owner skip, received a second database read/run path. The integration command from Step 4 should show two runs before the fix. Insert inside `if (isMonitorManaged)` before reading `monitorDeviceState`:

```ts
if (payload.responsesOwner === false) {
  return { skipped: 'subject_alert_not_response_owner' };
}
```

Do not write `recordEpisodeResponse` for this skip: that would overwrite the owner's response outcome. Missing/true ownership retains legacy behavior.

- [ ] **Step 4: Run green.**

```bash
cd apps/api && npx vitest run src/jobs/automationWorker.subjects.test.ts src/jobs/automationWorker.monitorBinding.test.ts src/jobs/automationWorker.monitorPause.test.ts
```

```bash
cd apps/api && npx vitest run -c vitest.integration.config.ts src/services/alertSubjects.integration.test.ts
```

Expected: one actual automation run, two in-app delivery calls with distinct IDs, unchanged owner, and existing legacy binding/pause tests pass.
- [ ] **Step 5: Commit.**

```bash
git add apps/api/src/jobs/automationWorker.ts apps/api/src/jobs/automationWorker.subjects.test.ts apps/api/src/services/alertSubjects.integration.test.ts
git commit -m $'fix(automations): run hardware responses only for the episode owner\n\nCo-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>'
```

### Task 12: Resolve explicitly retired component subjects

**Files:** Modify `apps/api/src/services/hardwareHealth/retire.ts` (W01 contract no-op; absent on the inspected pre-W01 base, so no invented line anchor); Create/Test `apps/api/src/services/hardwareHealth/retire.test.ts`.
**Interfaces:** Fills `resolveAlertsForRemovedComponents(deviceId: string, componentKeys: string[]): Promise<number>` from index §D. Retirement is explicit, so it resolves all open selected subjects regardless of autoResolve/requiresHuman; unknown/stale evidence alone never invokes this function.

- [ ] **Step 1: Write the failing retirement test.**

```ts
import { expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
const m = vi.hoisted(() => ({ select: vi.fn(), resolve: vi.fn(), predicate: undefined as unknown }));
vi.mock('../../db', () => ({ db: { select: m.select } }));
vi.mock('../alertService', () => ({ RESOLVABLE_ALERT_STATUSES: ['active','acknowledged','suppressed'], resolveAlert: m.resolve }));
import { resolveAlertsForRemovedComponents } from './retire';
it('uses device AND selected keys AND open statuses and counts only CAS winners', async () => {
  m.select.mockReturnValue({ from: () => ({ where: (p: unknown) => { m.predicate = p; return [{ id: 'a' },{ id: 'b' }]; } }) });
  m.resolve.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
  expect(await resolveAlertsForRemovedComponents('device', ['disk:3','disk:5'])).toBe(1);
  expect(m.resolve).toHaveBeenCalledWith('a', 'component no longer reported');
  const query = new PgDialect().sqlToQuery(m.predicate as never);
  expect(query.sql).toContain(' and ');
  expect(query.params).toEqual(expect.arrayContaining(['device','disk:3','disk:5','active','acknowledged','suppressed']));
  expect(query.params).not.toContain('resolved');
});
it('empty retirement does no work', async () => {
  m.select.mockClear(); expect(await resolveAlertsForRemovedComponents('device', [])).toBe(0);
  expect(m.select).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run red.** `cd apps/api && npx vitest run src/services/hardwareHealth/retire.test.ts` — W01 no-op returns 0 instead of 1.
- [ ] **Step 3: Replace the W01 no-op with the complete implementation.** Reaper/device-delete call sites remain owned by W01.

```ts
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../../db';
import { alerts } from '../../db/schema';
import { resolveAlert, RESOLVABLE_ALERT_STATUSES } from '../alertService';
export async function resolveAlertsForRemovedComponents(deviceId: string, componentKeys: string[]): Promise<number> {
  if (componentKeys.length === 0) return 0;
  const open = await db.select({ id: alerts.id }).from(alerts).where(and(
    eq(alerts.deviceId, deviceId), inArray(alerts.subjectKey, componentKeys),
    inArray(alerts.status, [...RESOLVABLE_ALERT_STATUSES]),
  ));
  let count = 0;
  for (const alert of open) if (await resolveAlert(alert.id, 'component no longer reported')) count++;
  return count;
}
```

- [ ] **Step 4: Run green.** `cd apps/api && npx vitest run src/services/hardwareHealth/retire.test.ts` — both tests pass.
- [ ] **Step 5: Commit.**

```bash
git add apps/api/src/services/hardwareHealth/retire.ts apps/api/src/services/hardwareHealth/retire.test.ts
git commit -m $'feat(alerts): resolve removed hardware component subjects\n\nCo-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>'
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
- Spec §7.3 retirement: Task 12 fills W01's declared resolver; W01 owns stale marking, reaper/device-delete invocation, storage and freshness implementation.
- W02a/W02b own agent collection and ingest streak inputs; W04 owns device storage UI/list/docs; W05 owns BMC facts/linking; W06 owns hardware lab proof.
- Index §F ambiguities resolved: define HardwareHealthComponentFilter locally; preserve createAlert's actual ID return, use pre-publish atomic ownership, and retain the literal i18n key path within the existing namespace.
- Index §F sweep-order ambiguity resolved: provisional episode creation and outbox staging precede the locked final observation; publication follows the outer commit, and the created-ID accumulator preserves the existing sweep return type.

- Cross-plan review: Task 6 runs the real `alertCooldown.rekey.test.ts` regression suite and explicitly pins legacy cooldown, adaptive and flapping keys.
- D6 compatibility: Tasks 8/10 keep NULL-subject episode linking after publication with the existing best-effort catch; a bookkeeping failure never deletes a legacy alert.
- Locale boundary: Task 15 supplies the kind, field and option keys in all eight monitoring catalogs and runs `localeParity.test.ts`; no W04 translation dependency remains.
- Retirement finding superseded by the supplied W01 prerequisite: W01 invokes the seam from both retention and shared device deletion before the cascade. Task 12 remains body-only; no duplicate W01 call-site work is planned here.

- Publication boundary: Tasks 8/10 store the subject event envelope and atomic response claim in one transaction, drain only after the outer worker commit, compensate publication failures in a new transaction, and keep post-publication Redis failures from rolling back ownership. Integration tests cover commit visibility, outer rollback, parallel drain claims, publish failure and cooldown failure. The minute tick retries durable pending events even for offline devices.

- The same publication fix covers subject recovery and hardware recurrence: Task 9 stages recovery side effects, Task 10 cancels pending triggers on recovery and stages requires-human alerts from committed latches. Legacy resolution and W01 retirement-before-cascade calls retain their default path; Task 12 remains unchanged.
