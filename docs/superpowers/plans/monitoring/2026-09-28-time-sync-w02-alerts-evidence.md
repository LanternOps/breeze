# Time Sync W02 Alerts and Evidence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add observation-based time-sync alerts, 400-day daily evidence, and a tenant-scoped fleet report with CSV exports.

**Architecture:** Extend W01a's locked ingest transaction with pure finding streaks and an atomic daily upsert, then evaluate per-finding subjects through the existing monitor pipeline. Serve scoped fleet queries and observed daily evidence through Hono and the existing AI tool registry, with an Astro-hosted React report that keeps its view and filters in the URL hash. Retention uses the existing BullMQ worker lifecycle and batched system-context pruning.

**Tech Stack:** Hono, TypeScript, PostgreSQL, Drizzle, BullMQ, Zod, Vitest, Astro, React, react-i18next.

**Spec:** `docs/superpowers/specs/monitoring/2026-09-28-time-sync-monitoring-design.md`

**Index:** `docs/superpowers/plans/monitoring/2026-09-28-time-sync.md`

## Global Constraints

All constraints in the index's Global constraints section apply.

- W02 depends on W01a; W01b is not a dependency and this PR changes no agent code.
- Migration slots: `2026-11-09-110000-time-sync-daily.sql` and `2026-11-09-110100-monitor-kind-time-sync.sql`.
- `device_time_daily` has RLS enabled and forced, four `breeze_has_org_access(org_id)` policies, and `(device_id, org_id) → devices(id, org_id) ON UPDATE CASCADE ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE`.
- `finding_streaks` is `excludedOpen`; every daily column is `included`.
- Retention is 400 days; history date ranges contain at most 400 inclusive UTC dates.
- Staleness is `TIME_SYNC_STALE_AFTER_MS = 3 * 30 * 60 * 1000`; only accepted observations advance streaks.
- `time_sync` belongs in `MONITOR_KINDS`, never `SERVER_EVALUATED_MONITOR_KINDS`.
- `consecutiveSnapshots` is an integer in `1..10`, default `2`.
- `BUILT_IN_MONITORS_VERSION = 4`; exactly three new `sinceVersion: 4` defaults, provisioned partner-wide and not attached.
- No config feature, command, enforcement, policy attachment, agent dependency, or built-in version 5 in this PR.
- Eight locales: `en`, `de-DE`, `es-419`, `fr-CA`, `fr-FR`, `it-IT`, `pt-BR`, `tr-TR`; new copy is English in all eight.
- Public examples use generic device labels and `example.com`; no lab hostnames or addresses.
- Read-only HTTP exports use `fetchWithAuth`; no POST/PUT/PATCH/DELETE handlers are added to the web.

**Checkout prerequisite:** The inspected checkout does not yet contain W01a's `timeSync.ts`, `ingest.ts`, `view.ts`, shared constants, web `time/types.ts`, or docs page. Their public interfaces are defined by index §§A–E/I and are consumed verbatim below. Existing-file anchors below are verified against this checkout; W01-owned edits are explicitly marked contract anchors, not fabricated current line numbers. Before executing Task 1, incorporate W01a and verify the exported names with `rg -n 'deviceTimeStatus|ingestTimeStatusSnapshot|getDeviceTimeStatusView|resolveExpectedTimezone' apps/api/src`. Do not implement a second W01a inside this PR. See Contract issues.

## Review Focus

The index's five numbered Review focus items are owned by W01a/W01b; none is reassigned to W02. W02 retains their contracts and adds these three cross-cutting cases:

- Input: a duplicate or reset sequence and repeated alert sweeps; expected: duplicates change neither streaks nor daily counts, a permitted reset counts once, and sweeps never advance counters (Tasks 2 and 5).
- Input: two organizations use the same domain DNS name, and a PDC is outside the filtered page; expected: groups remain organization-specific, the visible PDC is pinned as context, and filters do not falsely declare it unenrolled (Tasks 7 and 10).
- Input: UTC boundary observations, a missing calendar day, an edited site timezone, and a 401/500 CSV response; expected: historical evidence stays immutable, gaps are explicit, current views re-resolve timezone, and failed exports produce no download (Tasks 2, 8, and 10).

## File Structure

Paths below are implementation outputs; this planning task writes only this document.

- `apps/api/migrations/2026-11-09-110000-time-sync-daily.sql` — daily evidence, tenancy, and streak column.
- `apps/api/migrations/2026-11-09-110100-monitor-kind-time-sync.sql` — append monitor enum label.
- `apps/api/src/db/schema/timeSync.ts`, `apps/api/src/db/schema/index.ts` — typed daily rows and streak storage export.
- `apps/api/src/db/schema/monitorDefinitions.ts` — enum parity.
- `apps/api/src/services/tenantCascade.ts`, `orgMergeRegistry.ts`, `tenantExportPolicyRegistry.ts` — erasure, merge, and export classification.
- `apps/api/src/routes/devices/core.ts` — device move and deletion coverage.
- `apps/api/vitest.config.ts`, `apps/api/vitest.integration.config.ts` — isolated database-backed time-sync suites.
- `apps/api/src/services/timeSync/migrations.w02.integration.test.ts` — RLS, FK, replay and schema assertions.
- `apps/api/src/services/timeSync/applyStreaks.ts`, `applyStreaks.test.ts` — accepted-observation counters.
- `apps/api/src/services/timeSync/upsertDaily.ts`, `upsertDaily.test.ts`, `testSnapshot.ts` — atomic union/max/count evidence and shared test snapshot.
- `apps/api/src/services/timeSync/ingest.ts`, `ingest.w02.integration.test.ts` — invoke both helpers in the existing transaction.
- `apps/api/src/jobs/timeSyncRetention.ts`, `timeSyncRetention.test.ts` — daily 400-day pruning lifecycle.
- `apps/api/src/jobs/scheduleRegistry.ts`, `jobs/workerReadinessManifest.ts`, `services/workerRegistry.ts`, `services/workerRegistry.test.ts`, `services/workerEntrypointClosure.contract.test.ts` — worker scheduling, readiness, startup and shutdown (relative siblings under `apps/api/src`).
- `packages/shared/src/validators/monitors.ts`, `monitors.test.ts`, `monitors.timeSync.test.ts` — root-only condition schema.
- `apps/api/src/services/alertConditions/types.ts`, `index.ts` — condition type and handler registration.
- `apps/api/src/services/alertConditions/handlers/timeSync.ts`, `timeSync.test.ts` — independent per-finding evidence.
- `apps/api/src/services/alertSubjects.ts`, `alertSubjects.test.ts`, `alertService.ts`, `alertService.episodes.test.ts` — kind-neutral provenance and maintenance recovery.
- `apps/api/src/services/monitors/kinds/timeSync.ts`, `timeSync.test.ts`, `index.ts`, `index.test.ts` — compile and override contracts.
- `apps/api/src/routes/monitorDefinitions.test.ts` — kind discovery count and metadata.
- `apps/api/src/services/monitors/builtInMonitors.ts`, `builtInMonitors.test.ts`, `builtInMonitors.timeSync.test.ts`, `apps/api/src/__tests__/integration/builtInMonitors.integration.test.ts` — version 4 upgrade and three unattached defaults.
- `apps/web/src/components/monitoring/monitorKindFields.ts`, `MonitorConditionFields.tsx`, `MonitorConditionFields.timeSync.test.tsx` — multiselect editor contract.
- `apps/web/src/locales/{en,de-DE,es-419,fr-CA,fr-FR,it-IT,pt-BR,tr-TR}/monitoring.json` — monitor-kind and field copy.
- `apps/api/src/services/timeSync/fleet.ts`, `fleet.test.ts`, `fleet.integration.test.ts` — scoped, paginated current report, domain metadata and live tenancy parity.
- `apps/api/src/services/timeSync/exports.ts`, `exports.test.ts` — bounded streaming CSV and explicit UTC gaps.
- `apps/api/src/routes/timeStatus.ts`, `timeStatus.test.ts`, `apps/api/src/index.ts` — authenticated fleet/export routes and mount.
- `apps/api/src/services/aiToolsDevice.ts`, `aiToolsDevice.timeSync.test.ts`, `aiToolsDevice.timeSync.registry.test.ts` — tier 1 fleet tool and registration tests.
- `apps/api/src/services/aiToolSchemas.ts`, `aiGuardrails.ts`, `aiAgentSdkTools.ts`, `aiTools.ts`, `helperToolFilter.ts`, `scriptBuilderTools.ts`, `mcpCoverage.ts`, `mcpGuidance.ts` — AI/MCP surfaces and helper scoping.
- `apps/api/src/services/aiAgents/agentToolCatalog.ts`, `analysisProfile.ts`, `designProfile.ts`, `patchProfile.ts`, `sweepProfile.ts`, `verdictProfile.ts`, `runLoop.test.ts` — agent read-tool availability.
- `apps/api/src/services/helperToolFilter.test.ts`, `aiGuardrails.agentPrincipal.contract.test.ts`, `llm/toolCapture/surfaces.test.ts` — tool-surface parity.
- `apps/web/src/components/ai-risk/tierConfig.ts` — tool risk/permission metadata.
- `apps/web/src/components/devices/time/fleetTypes.ts`, `fleetState.ts`, `fleetState.test.ts` — DTO mirror and validated hash state.
- `apps/web/src/components/devices/time/FleetTimeSyncReport.tsx`, `DomainGroupView.tsx`, `FleetTimeSyncReport.test.tsx` — filters, evidence, PDC context, loading/errors, authenticated downloads.
- `apps/web/src/pages/devices/time.astro`, `apps/web/src/components/layout/Sidebar.tsx` — page and navigation beside Posture.
- `apps/web/src/locales/{en,de-DE,es-419,fr-CA,fr-FR,it-IT,pt-BR,tr-TR}/{devices,common,pages}.json` — report, navigation, and page-title strings.
- `apps/docs/src/content/docs/features/time-sync.mdx`, `apps/web/src/components/devices/time/timeSyncEvidenceDocs.test.ts` — alert attachment and evidence limits.

### Task 1: Add daily evidence and complete all tenancy registrations

**Files:** Create the daily migration and `services/timeSync/migrations.w02.integration.test.ts`; modify W01a `db/schema/timeSync.ts` and `schema/index.ts` (index §D contract anchors; absent in this checkout); modify `routes/devices/core.ts:319–320,564`, `services/tenantCascade.ts:525–526`, `services/orgMergeRegistry.ts:850–851`, `services/tenantExportPolicyRegistry.ts:307–308`; modify test configurations at `vitest.config.ts:56` and `vitest.integration.config.ts:30` only if W01a has not already registered this directory.

**Interfaces:** Consumes `devices(id, org_id)`, `organizations(id)`, `deviceTimeStatus` (index §D). Produces `deviceTimeDaily`, `typeof deviceTimeDaily.$inferSelect`, and optional-at-rest `deviceTimeStatus.findingStreaks: Partial<Record<TimeSyncFindingCode, { present: number; absent: number }>>`; the computed function in Task 2 always produces the full contract Record.

- [ ] Write the failing database contract test below. It uses separate app-role connections and explicit system/org contexts; no table-owner bypass can make the isolation assertion pass accidentally.

```ts
// apps/api/src/services/timeSync/migrations.w02.integration.test.ts
import '../../__tests__/integration/setup';
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import { devices } from '../../db/schema';
import { pgErrorCode } from '../../utils/pgErrors';
import { createPartner, createOrganization, createSite } from '../../__tests__/integration/db-utils';
import { getTestDb } from '../../__tests__/integration/setup';
import { replayMigration } from '../../__tests__/integration/replayMigration';
const system: DbAccessContext = { scope: 'system', orgId: null, accessibleOrgIds: null, accessiblePartnerIds: null };
async function fixture() {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner!.id });
  const other = await createOrganization({ partnerId: partner!.id });
  const site = await createSite({ orgId: org!.id });
  const [device] = await getTestDb().insert(devices).values({ orgId: org!.id, siteId: site!.id,
    agentId: randomUUID(), hostname: 'Device A', osType: 'windows', osVersion: 'Server', architecture: 'x64', agentVersion: '1.0.0' }).returning();
  return { org: org!.id, other: other!.id, partner: partner!.id, device: device!.id };
}
const insert = (deviceId: string, orgId: string) => db.execute(sql`
  INSERT INTO device_time_daily(device_id,org_id,day,snapshot_count) VALUES(${deviceId},${orgId},'2026-09-28',2)`);
it('forces four organization policies and the immediate deferrable composite FK', async () => {
  const rows = await getTestDb().execute(sql`SELECT c.relrowsecurity,c.relforcerowsecurity,f.condeferrable,f.condeferred,f.confupdtype,f.confdeltype
    FROM pg_class c JOIN pg_constraint f ON f.conrelid=c.oid
    WHERE c.oid=to_regclass('device_time_daily') AND f.conname='device_time_daily_device_org_fkey'`);
  expect(rows[0]).toMatchObject({ relrowsecurity:true, relforcerowsecurity:true, condeferrable:true, condeferred:false, confupdtype:'c', confdeltype:'c' });
  const policies = await getTestDb().execute(sql`SELECT cmd FROM pg_policies WHERE tablename='device_time_daily'`);
  expect(policies.map(p => p.cmd).sort()).toEqual(['DELETE','INSERT','SELECT','UPDATE']);
});
it('denies forged ownership and cross-organization reads as breeze_app', async () => {
  const f = await fixture();
  const other: DbAccessContext = { scope:'organization', orgId:f.other, accessibleOrgIds:[f.other], accessiblePartnerIds:[], currentPartnerId:f.partner };
  await expect(withDbAccessContext(other, () => insert(f.device,f.org))).rejects.toSatisfy((e:unknown) => pgErrorCode(e)==='42501');
  await expect(withDbAccessContext(system, () => insert(f.device,f.other))).rejects.toSatisfy((e:unknown) => pgErrorCode(e)==='23503');
  await withDbAccessContext(system, () => insert(f.device,f.org));
  expect(await withDbAccessContext(other, () => db.execute(sql`SELECT * FROM device_time_daily`))).toHaveLength(0);
});
it('replays without deleting observations', async () => {
  const f = await fixture();
  await withDbAccessContext(system, () => insert(f.device,f.org));
  await replayMigration('2026-11-09-110000-time-sync-daily.sql');
  const rows = await getTestDb().execute(sql`SELECT snapshot_count FROM device_time_daily WHERE device_id=${f.device}`);
  expect(rows[0]!.snapshot_count).toBe(2);
});
```

- [ ] Start the private test stack before the first database test; integration setup applies migrations to that isolated database. Export its generated environment in the executor shell so drift checks also use the isolated database:

```bash
pnpm test-stack up
set -a
source .env.test
set +a
```

Run `cd apps/api && npx vitest run --config vitest.integration.config.ts src/services/timeSync/migrations.w02.integration.test.ts` against W01a. Expected FAIL: missing relation `device_time_daily` or absent catalog row.
- [ ] Create the migration:

```sql
CREATE TABLE IF NOT EXISTS device_time_daily (
  device_id uuid NOT NULL,
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  day date NOT NULL,
  worst_health text NOT NULL DEFAULT 'unknown' CHECK (worst_health IN ('healthy','warning','critical','unknown')),
  finding_codes text[] NOT NULL DEFAULT '{}',
  source text,
  source_kind text,
  sync_type text,
  last_successful_sync_at timestamptz,
  snapshot_count integer NOT NULL DEFAULT 0 CHECK (snapshot_count >= 0),
  expected_timezone text,
  timezone_windows_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (device_id, day)
);
CREATE INDEX IF NOT EXISTS device_time_daily_org_day_idx ON device_time_daily(org_id, day);
ALTER TABLE device_time_daily DROP CONSTRAINT IF EXISTS device_time_daily_device_org_fkey;
ALTER TABLE device_time_daily ADD CONSTRAINT device_time_daily_device_org_fkey
  FOREIGN KEY (device_id, org_id) REFERENCES devices(id, org_id)
  ON UPDATE CASCADE ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE device_time_daily ENABLE ROW LEVEL SECURITY;
ALTER TABLE device_time_daily FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS breeze_org_isolation_select ON device_time_daily;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON device_time_daily;
DROP POLICY IF EXISTS breeze_org_isolation_update ON device_time_daily;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON device_time_daily;
CREATE POLICY breeze_org_isolation_select ON device_time_daily FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON device_time_daily FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON device_time_daily FOR UPDATE USING (public.breeze_has_org_access(org_id)) WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON device_time_daily FOR DELETE USING (public.breeze_has_org_access(org_id));
GRANT SELECT, INSERT, UPDATE, DELETE, REFERENCES ON device_time_daily TO breeze_app;
ALTER TABLE device_time_status ADD COLUMN IF NOT EXISTS finding_streaks jsonb NOT NULL DEFAULT '{}';
```

- [ ] In W01a `schema/timeSync.ts`, extend the existing `pg-core` import with `date, primaryKey` (W01a already imports `check`), retain its existing `sql`, `devices`, `organizations`, `TimeSyncHealth`, and `TimeSyncFindingCode` imports, and add this status field beside `eventMarks`. These are index §D contract anchors; their line numbers require W01a.

```ts
findingStreaks: jsonb('finding_streaks')
  .$type<Partial<Record<TimeSyncFindingCode, { present: number; absent: number }>>>()
  .notNull().default({}),
```

Append this complete declaration and export it through the existing `export * from './timeSync'` barrel (if W01a used a named export, replace `export { deviceTimeStatus } from './timeSync';` with `export { deviceTimeStatus, deviceTimeDaily } from './timeSync';`).

```ts
export const deviceTimeDaily = pgTable('device_time_daily', {
  deviceId: uuid('device_id').notNull(),
  orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  day: date('day', { mode: 'string' }).notNull(),
  worstHealth: text('worst_health').$type<TimeSyncHealth>().notNull().default('unknown'),
  findingCodes: text('finding_codes').array().$type<TimeSyncFindingCode[]>().notNull().default([]),
  source: text('source'), sourceKind: text('source_kind'), syncType: text('sync_type'),
  lastSuccessfulSyncAt: timestamp('last_successful_sync_at', { withTimezone: true }),
  snapshotCount: integer('snapshot_count').notNull().default(0),
  expectedTimezone: text('expected_timezone'), timezoneWindowsId: text('timezone_windows_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [
  primaryKey({ columns: [t.deviceId, t.day] }),
  foreignKey({ columns: [t.deviceId, t.orgId], foreignColumns: [devices.id, devices.orgId], name: 'device_time_daily_device_org_fkey' }).onUpdate('cascade').onDelete('cascade'),
  index('device_time_daily_org_day_idx').on(t.orgId, t.day),
  check('device_time_daily_worst_health_check', sql`${t.worstHealth} IN ('healthy','warning','critical','unknown')`),
  check('device_time_daily_snapshot_count_check', sql`${t.snapshotCount} >= 0`),
]);
```

Drizzle does not expose a deferrability builder here; SQL is authoritative for `DEFERRABLE INITIALLY IMMEDIATE`, as in `schema/hardwareHealth.ts:18` and its migration.

- [ ] Apply these exact registration edits. Preserve W01a's status entries when rebasing. The executable edits assert their source anchors instead of silently succeeding on drift.

```python
from pathlib import Path

def replace(path, old, new):
    p = Path(path)
    text = p.read_text()
    assert text.count(old) == 1, (path, old)
    p.write_text(text.replace(old, new, 1))

# routes/devices/core.ts:319–320; daily precedes status if W01a inserted status.
replace('apps/api/src/routes/devices/core.ts',
        "  'device_reliability', 'device_reliability_history', 'device_sessions', 'device_software_inventory_state',",
        "  'device_reliability', 'device_reliability_history', 'device_sessions', 'device_software_inventory_state',\n  'device_time_daily',")
# core.ts:564, device deletion order.
replace('apps/api/src/routes/devices/core.ts',
        "  'device_hardware_health',", "  'device_hardware_health',\n  'device_time_daily',")
# tenantCascade.ts:525; children before devices and organizations.
replace('apps/api/src/services/tenantCascade.ts',
        "  'device_software_inventory_state',", "  'device_software_inventory_state',\n  'device_time_daily',")
# orgMergeRegistry.ts:850.
replace('apps/api/src/services/orgMergeRegistry.ts',
        '  "device_software_inventory_state",', '  "device_software_inventory_state",\n  "device_time_daily",')

p = Path('apps/api/src/services/tenantExportPolicyRegistry.ts')
text = p.read_text()
anchor = next(line for line in text.splitlines() if '"device_software_inventory_state": tablePolicy' in line)
row = '  "device_time_daily": tablePolicy("org_id", {"included":["device_id","org_id","day","worst_health","finding_codes","source","source_kind","sync_type","last_successful_sync_at","snapshot_count","expected_timezone","timezone_windows_id","created_at","updated_at"],"reviewedIncluded":[],"excludedSensitive":[],"excludedOpen":[]}),'
text = text.replace(anchor, anchor + '\n' + row, 1)
# W01a §D contract anchor: status policy's excludedOpen array.
lines = text.splitlines()
index = next(i for i, line in enumerate(lines) if '"device_time_status": tablePolicy' in line)
import json
line = lines[index]
start = line.index('{'); end = line.rindex('}') + 1
policy = json.loads(line[start:end])
assert 'finding_streaks' not in sum(policy.values(), [])
policy['excludedOpen'].append('finding_streaks')
lines[index] = line[:start] + json.dumps(policy, separators=(',', ':')) + line[end:]
p.write_text('\n'.join(lines) + '\n')

for file in ['apps/api/vitest.config.ts', 'apps/api/vitest.integration.config.ts']:
    p = Path(file); text = p.read_text()
    if "'src/services/timeSync/**/*.integration.test.ts'" not in text:
        anchor = next(line for line in text.splitlines() if "'src/services/hardwareHealth/**/*.integration.test.ts'" in line)
        text = text.replace(anchor, anchor + '\n' + anchor.replace('hardwareHealth', 'timeSync'), 1)
        p.write_text(text)
```

`services/deviceDeletion.ts:18,339` consumes `getDeviceCascadeDeleteTables()` and contains no `device_hardware_health` special case; no extra deviceDeletion mutation is needed. Direct `org_id` policies are auto-discovered; do not add an EXISTS-join allowlist entry.

- [ ] Run `cd apps/api && npx vitest run --config vitest.integration.config.ts src/services/timeSync/migrations.w02.integration.test.ts`; expected PASS, including replay and app-role 42501. Run `cd apps/api && npx vitest run src/routes/devices/cascadeDelete.test.ts src/routes/devices/moveOrg.coverage.test.ts`; expected PASS with daily coverage. Full required tenancy suites are in Task 12.
- [ ] Commit:

```bash
git add apps/api/migrations/2026-11-09-110000-time-sync-daily.sql apps/api/src/db/schema/timeSync.ts apps/api/src/db/schema/index.ts apps/api/src/services/timeSync/migrations.w02.integration.test.ts apps/api/src/routes/devices/core.ts apps/api/src/services/tenantCascade.ts apps/api/src/services/orgMergeRegistry.ts apps/api/src/services/tenantExportPolicyRegistry.ts apps/api/vitest.config.ts apps/api/vitest.integration.config.ts
git commit -m "feat(time-sync): add tenant-scoped daily evidence" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 2: Count accepted findings and aggregate UTC evidence atomically

**Files:** Create `services/timeSync/applyStreaks.ts`, `applyStreaks.test.ts`, `upsertDaily.ts`, `upsertDaily.test.ts`, `testSnapshot.ts`, `ingest.w02.integration.test.ts`; modify W01a `services/timeSync/ingest.ts` at index §C.5's locked transaction seam. Existing transaction primitive: `apps/api/src/db/index.ts:1033–1037`; hardware ingest model: `services/hardwareHealth/ingest.ts:139–142`.

**Interfaces:** Consumes index §§B/C `TimeStatusSnapshot`, `TimeFindingsResult`, `ExpectedTimezone`, `ingestTimeStatusSnapshot(args): Promise<IngestTimeStatusResult>`. Produces `applyStreaks(previous: Partial<FindingStreaks> | null | undefined, findings: readonly TimeSyncFindingCode[]): FindingStreaks`, where `FindingStreaks = Record<TimeSyncFindingCode, { present: number; absent: number }>`, and `upsertDaily(input: UpsertDailyInput): Promise<void>`; input fields are explicitly declared below. Both helpers run only after sequence acceptance; `upsertDaily` consumes the ambient transaction while the status row is locked.

- [ ] Write the failing pure-counter test:

```ts
// services/timeSync/applyStreaks.test.ts
import { expect, it } from 'vitest';
import { TIME_SYNC_FINDING_CODES } from '@breeze/shared';
import { applyStreaks } from './applyStreaks';
it('initializes every code including the reserved policy findings', () => {
  const result = applyStreaks({}, ['sync_stale']);
  expect(Object.keys(result)).toEqual([...TIME_SYNC_FINDING_CODES]);
  for (const code of TIME_SYNC_FINDING_CODES) expect(result[code]).toEqual(
    code === 'sync_stale' ? { present:1, absent:0 } : { present:0, absent:1 });
});
it('counts observations once, resets the opposite counter, and preserves input', () => {
  const first = applyStreaks(null, ['sync_stale','sync_stale']);
  const before = structuredClone(first);
  const second = applyStreaks(first, ['sync_stale']);
  expect(first).toEqual(before);
  expect(second.sync_stale).toEqual({ present:2, absent:0 });
  const clear = applyStreaks(second, []);
  expect(clear.sync_stale).toEqual({ present:0, absent:1 });
  expect(applyStreaks(clear, []).sync_stale).toEqual({ present:0, absent:2 });
  expect(applyStreaks(clear, ['sync_stale']).sync_stale).toEqual({ present:1, absent:0 });
});
it('uses the ingest-time timezone result', () => {
  expect(applyStreaks(applyStreaks(undefined,['timezone_mismatch']),[]).timezone_mismatch)
    .toEqual({ present:0, absent:1 });
});
```

Create the complete test fixture:

```ts
// services/timeSync/testSnapshot.ts
import type { TimeStatusSnapshot } from '@breeze/shared';
export function timeSnapshot(overrides: Partial<TimeStatusSnapshot> = {}): TimeStatusSnapshot {
  return {
    schemaVersion:1, sequence:1, collectedAt:'2026-09-28T12:00:00Z',
    config:{ type:'NTP', ntpServer:null, specialPollIntervalSeconds:3600,
      policyManaged:false, policyManagedValues:[], serviceState:'running', serviceStartType:'auto', hostTimeProviderEnabled:false },
    status:{ method:'events', source:null, sourceKind:'ntp_peer', lastSuccessfulSyncAt:'2026-09-28T11:59:00Z',
      lastSyncError:null, stratum:null, pollIntervalSeconds:3600 },
    domain:{ joinType:'none', role:'workgroup', domainDns:null, forestDns:null, pdcName:null },
    timezone:{ windowsId:'UTC', biasMinutes:0, dynamicDstDisabled:false, autoUpdate:'off' },
    events:[], enforcement:null, ...overrides,
  };
}
```

```ts
// services/timeSync/upsertDaily.test.ts
import { beforeEach, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({ rows:[] as unknown[], insert:vi.fn() }));
vi.mock('../../db', () => ({ db:{
  select:() => ({ from:() => ({ where:() => ({ for:async () => m.rows }) }) }),
  insert:() => ({ values:(values:unknown) => ({ onConflictDoUpdate:async () => { m.insert(values); } }) }),
} }));
import { upsertDaily } from './upsertDaily';
import { timeSnapshot } from './testSnapshot';
beforeEach(() => { m.rows=[]; m.insert.mockReset(); });
it('uses the UTC collected date rather than the received date', async () => {
  await upsertDaily({ deviceId:'device', orgId:'org', snapshot:timeSnapshot({ collectedAt:'2026-09-28T23:30:00-06:00' }),
    result:{ health:'healthy', findings:[], eventMarks:{} }, expectedTimezone:null, receivedAt:new Date('2026-09-30T00:00:00Z') });
  expect(m.insert).toHaveBeenCalledWith(expect.objectContaining({ day:'2026-09-29', snapshotCount:1, findingCodes:[] }));
});
it('unions codes, retains worst health and max sync, and replaces latest accepted fields', async () => {
  m.rows=[{ findingCodes:['sync_stale'], worstHealth:'critical', snapshotCount:5, lastSuccessfulSyncAt:new Date('2026-09-28T12:00:00Z') }];
  await upsertDaily({ deviceId:'device', orgId:'org', snapshot:timeSnapshot(),
    result:{ health:'critical', findings:[{ code:'sync_disabled', severity:'critical', detail:{ reason:'no_sync' } }], eventMarks:{} },
    expectedTimezone:{ iana:'America/Denver', windowsId:'Mountain Standard Time', source:'site', sourceId:'site', sourceName:'Office' },
    receivedAt:new Date('2026-09-28T12:01:00Z') });
  expect(m.insert).toHaveBeenCalledWith(expect.objectContaining({ snapshotCount:6, worstHealth:'critical', findingCodes:['sync_disabled','sync_stale'],
    lastSuccessfulSyncAt:new Date('2026-09-28T12:00:00Z'), source:null, sourceKind:'ntp_peer', syncType:'NTP', expectedTimezone:'America/Denver', timezoneWindowsId:'UTC' }));
});
it.each([['healthy','unknown','unknown'],['unknown','healthy','unknown'],['unknown','warning','warning'],['warning','critical','critical']] as const)
  ('folds %s and %s to %s', async (prior,incoming,expected) => {
    m.rows=[{ findingCodes:[], worstHealth:prior, snapshotCount:1, lastSuccessfulSyncAt:null }];
    await upsertDaily({ deviceId:'device', orgId:'org', snapshot:timeSnapshot(), result:{ health:incoming, findings:[], eventMarks:{} }, expectedTimezone:null, receivedAt:new Date() });
    expect(m.insert).toHaveBeenCalledWith(expect.objectContaining({ worstHealth:expected, snapshotCount:2 }));
  });
```

- [ ] Run `cd apps/api && npx vitest run src/services/timeSync/applyStreaks.test.ts src/services/timeSync/upsertDaily.test.ts`. Expected FAIL: cannot load `./applyStreaks` and `./upsertDaily`.
- [ ] Implement both helpers:

```ts
// services/timeSync/applyStreaks.ts
import { TIME_SYNC_FINDING_CODES, type TimeSyncFindingCode } from '@breeze/shared';
export type FindingStreaks = Record<TimeSyncFindingCode, { present:number; absent:number }>;
export function applyStreaks(previous:Partial<FindingStreaks>|null|undefined, findings:readonly TimeSyncFindingCode[]):FindingStreaks {
  const present = new Set(findings);
  return Object.fromEntries(TIME_SYNC_FINDING_CODES.map(code => [code, present.has(code)
    ? { present:(previous?.[code]?.present ?? 0)+1, absent:0 }
    : { present:0, absent:(previous?.[code]?.absent ?? 0)+1 }])) as FindingStreaks;
}
```

```ts
// services/timeSync/upsertDaily.ts
import { and, eq } from 'drizzle-orm';
import { TIME_SYNC_FINDING_CODES, type TimeStatusSnapshot, type TimeSyncHealth } from '@breeze/shared';
import { db } from '../../db';
import { deviceTimeDaily } from '../../db/schema';
import type { TimeFindingsResult } from './findings';
import type { ExpectedTimezone } from './expectedTimezone';
const rank:Record<TimeSyncHealth,number> = { healthy:0, unknown:1, warning:2, critical:3 };
export interface UpsertDailyInput {
  deviceId:string; orgId:string; snapshot:TimeStatusSnapshot; result:TimeFindingsResult;
  expectedTimezone:ExpectedTimezone|null; receivedAt:Date;
}
export async function upsertDaily(input:UpsertDailyInput):Promise<void> {
  const { deviceId,orgId,snapshot,result,expectedTimezone,receivedAt }=input;
  const day=new Date(snapshot.collectedAt).toISOString().slice(0,10);
  const [previous]=await db.select().from(deviceTimeDaily)
    .where(and(eq(deviceTimeDaily.deviceId,deviceId),eq(deviceTimeDaily.day,day))).for('update');
  const codes=new Set([...(previous?.findingCodes ?? []),...result.findings.map(f=>f.code)]);
  const reportedSync=snapshot.status.lastSuccessfulSyncAt ? new Date(snapshot.status.lastSuccessfulSyncAt) : null;
  const lastSuccessfulSyncAt=previous?.lastSuccessfulSyncAt && (!reportedSync || previous.lastSuccessfulSyncAt>reportedSync)
    ? previous.lastSuccessfulSyncAt : reportedSync;
  const values={ deviceId,orgId,day,
    worstHealth:previous && rank[previous.worstHealth]>rank[result.health] ? previous.worstHealth : result.health,
    findingCodes:TIME_SYNC_FINDING_CODES.filter(code=>codes.has(code)),
    source:snapshot.status.source,sourceKind:snapshot.status.sourceKind,syncType:snapshot.config.type,
    lastSuccessfulSyncAt,snapshotCount:(previous?.snapshotCount ?? 0)+1,
    expectedTimezone:expectedTimezone?.iana ?? null,timezoneWindowsId:snapshot.timezone.windowsId,updatedAt:receivedAt };
  await db.insert(deviceTimeDaily).values({ ...values,createdAt:receivedAt })
    .onConflictDoUpdate({ target:[deviceTimeDaily.deviceId,deviceTimeDaily.day],set:values });
}
```

`unknown` ranks above `healthy` for daily evidence, below warning/critical; an unreadable observation must not turn a mixed day into an unqualified healthy day. “Latest” here is latest accepted observation, consistent with the row shape; see Contract issues before choosing event-time ordering.

- [ ] Add the end-to-end ingest regression before modifying ingest. This uses real transactions, exercises the accepted reset and first-insert race, and checks history and counters together.

```ts
// services/timeSync/ingest.w02.integration.test.ts
import '../../__tests__/integration/setup';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { expect, it } from 'vitest';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import { devices, deviceTimeDaily, deviceTimeStatus } from '../../db/schema';
import { createPartner, createOrganization, createSite } from '../../__tests__/integration/db-utils';
import { getTestDb } from '../../__tests__/integration/setup';
import { ingestTimeStatusSnapshot } from './ingest';
import { timeSnapshot } from './testSnapshot';
const system:DbAccessContext={scope:'system',orgId:null,accessibleOrgIds:null,accessiblePartnerIds:null};
async function fixture() {
  const partner=await createPartner(); const org=await createOrganization({partnerId:partner!.id});
  const site=await createSite({orgId:org!.id});
  const [device]=await getTestDb().insert(devices).values({orgId:org!.id,siteId:site!.id,agentId:randomUUID(),hostname:'Device A',osType:'windows',osVersion:'Server',architecture:'x64',agentVersion:'1.0.0'}).returning();
  return {deviceId:device!.id,orgId:org!.id,agentVersion:null,receivedAt:new Date('2026-09-28T12:00:00Z')};
}
it('duplicates and concurrent first delivery count once; accepted reset counts once', async () => {
  const args=await fixture(); const base=timeSnapshot();
  base.config.type='NoSync';
  const results=await Promise.all([1,2].map(()=>withDbAccessContext(system,()=>ingestTimeStatusSnapshot({...args,snapshot:base}))));
  expect(results.filter(r=>r.accepted)).toHaveLength(1);
  await withDbAccessContext(system,async()=>{
    const [status]=await db.select().from(deviceTimeStatus).where(eq(deviceTimeStatus.deviceId,args.deviceId));
    const [daily]=await db.select().from(deviceTimeDaily).where(eq(deviceTimeDaily.deviceId,args.deviceId));
    expect(status!.findingStreaks.sync_disabled).toEqual({present:1,absent:0}); expect(daily!.snapshotCount).toBe(1);
  });
  expect(await withDbAccessContext(system,()=>ingestTimeStatusSnapshot({...args,snapshot:{...base,sequence:0,collectedAt:'2026-09-28T13:00:00Z'}})))
    .toMatchObject({accepted:false,reason:'stale_sequence'});
  expect(await withDbAccessContext(system,()=>ingestTimeStatusSnapshot({...args,snapshot:{...base,sequence:0,collectedAt:'2026-09-28T13:00:00.001Z'}})))
    .toMatchObject({accepted:true});
  await withDbAccessContext(system,async()=>{
    const [status]=await db.select().from(deviceTimeStatus).where(eq(deviceTimeStatus.deviceId,args.deviceId));
    const [daily]=await db.select().from(deviceTimeDaily).where(eq(deviceTimeDaily.deviceId,args.deviceId));
    expect(status!.findingStreaks.sync_disabled).toEqual({present:2,absent:0}); expect(daily!.snapshotCount).toBe(2);
  });
});
it('rolls status and daily back together when the enclosing transaction aborts', async () => {
  const args=await fixture();
  await expect(withDbAccessContext(system,async()=>{
    await ingestTimeStatusSnapshot({...args,snapshot:timeSnapshot()});
    await db.execute(sql`SELECT 1 / 0`);
  })).rejects.toBeDefined();
  await withDbAccessContext(system,async()=>{
    expect(await db.select().from(deviceTimeStatus).where(eq(deviceTimeStatus.deviceId,args.deviceId))).toHaveLength(0);
    expect(await db.select().from(deviceTimeDaily).where(eq(deviceTimeDaily.deviceId,args.deviceId))).toHaveLength(0);
  });
});
```

- [ ] Run `cd apps/api && npx vitest run --config vitest.integration.config.ts src/services/timeSync/ingest.w02.integration.test.ts`. Expected FAIL: daily row missing or streak absent before W02 integration.
- [ ] Add the two helper imports and two calls to W01a ingest. The concurrently authored W01a draft now supplies concrete planned anchors: `docs/superpowers/plans/monitoring/2026-09-28-time-sync-w01a-api-web-visibility.md:1430` is `findingDetails: Object.fromEntries(resolved.findings.map(f => [f.code, f.detail])),`; append the streak field below it. Its line 1468 is `await db.insert(deviceTimeStatus).values(row).onConflictDoUpdate({ target: deviceTimeStatus.deviceId, set: row });`; append the daily call below it. These are **draft-plan line numbers**, not nonexistent implementation line numbers. Verify the merged source before applying this three-site edit; preserve the parent lock and event-history merge. The complete resulting file is:

```ts
import { and, eq } from 'drizzle-orm';
import { TIME_SYNC_RECENT_EVENTS_MAX, type TimeStatusSnapshot, type TimeSyncHealth } from '@breeze/shared';
import { db, withDbTransaction } from '../../db';
import { deviceTimeStatus, devices, sites } from '../../db/schema';
import { resolveExpectedTimezone, type ExpectedTimezone } from './expectedTimezone';
import { resolveTimeFindings, type TimeFindingsResult } from './findings';
import { applyStreaks } from './applyStreaks';
import { upsertDaily } from './upsertDaily';
type StatusRow = typeof deviceTimeStatus.$inferSelect;
export interface IngestTimeStatusResult { accepted: boolean; reason?: 'stale_sequence'; health?: TimeSyncHealth }
type IngestArgs = {
  deviceId: string; orgId: string; agentVersion: string | null; snapshot: TimeStatusSnapshot; receivedAt: Date;
};
export function buildTimeStatusRow(args: IngestArgs, previous: StatusRow | undefined,
  expected: ExpectedTimezone | null, resolved: TimeFindingsResult): StatusRow {
  const { snapshot: s, receivedAt } = args;
  const events = new Map<number, StatusRow['recentEvents'][number]>();
  for (const e of [...(previous?.recentEvents ?? []), ...s.events]) {
    const existing = events.get(e.recordId);
    if (!existing || Date.parse(e.occurredAt) >= Date.parse(existing.occurredAt))
      events.set(e.recordId, { recordId: e.recordId, eventId: e.eventId, level: e.level,
        occurredAt: e.occurredAt, message: e.message });
  }
  return {
    deviceId: args.deviceId, orgId: args.orgId, lastSequence: s.sequence,
    collectedAt: new Date(s.collectedAt), receivedAt, agentVersion: args.agentVersion,
    health: resolved.health, findings: resolved.findings.map(f => f.code),
    findingDetails: Object.fromEntries(resolved.findings.map(f => [f.code, f.detail])),
    findingStreaks: applyStreaks(previous?.findingStreaks, resolved.findings.map(f => f.code)),
    syncType: s.config.type, ntpServer: s.config.ntpServer,
    specialPollIntervalSeconds: s.config.specialPollIntervalSeconds,
    policyManaged: s.config.policyManaged, policyManagedValues: s.config.policyManagedValues,
    serviceState: s.config.serviceState, serviceStartType: s.config.serviceStartType,
    hostTimeProviderEnabled: s.config.hostTimeProviderEnabled,
    statusMethod: s.status.method, source: s.status.source, sourceKind: s.status.sourceKind,
    lastSuccessfulSyncAt: s.status.lastSuccessfulSyncAt ? new Date(s.status.lastSuccessfulSyncAt) : null,
    lastSyncError: s.status.lastSyncError, stratum: s.status.stratum, pollIntervalSeconds: s.status.pollIntervalSeconds,
    joinType: s.domain.joinType, domainRole: s.domain.role, domainDns: s.domain.domainDns,
    forestDns: s.domain.forestDns, pdcName: s.domain.pdcName,
    timezoneWindowsId: s.timezone.windowsId, timezoneBiasMinutes: s.timezone.biasMinutes,
    timezoneAutoUpdate: s.timezone.autoUpdate, expectedTimezone: expected?.iana ?? null,
    expectedTimezoneWindowsId: expected?.windowsId ?? null,
    expectedTimezoneSource: expected ? `${expected.source}:${expected.sourceId}` : null,
    eventMarks: resolved.eventMarks,
    recentEvents: [...events.values()].sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt) || b.recordId - a.recordId)
      .slice(0, TIME_SYNC_RECENT_EVENTS_MAX),
    createdAt: previous?.createdAt ?? receivedAt, updatedAt: receivedAt,
  };
}
export async function ingestTimeStatusSnapshot(args: IngestArgs): Promise<IngestTimeStatusResult> {
  return withDbTransaction(async () => {
    // Parent first: serializes the empty-row case and matches device deletion lock order.
    const [owner] = await db.select({ id: devices.id, siteId: devices.siteId }).from(devices)
      .where(and(eq(devices.id, args.deviceId), eq(devices.orgId, args.orgId))).for('update');
    if (!owner) throw new Error('Time status device missing or ownership changed');
    const [previous] = await db.select().from(deviceTimeStatus)
      .where(and(eq(deviceTimeStatus.deviceId, args.deviceId), eq(deviceTimeStatus.orgId, args.orgId))).for('update');
    if (previous && args.snapshot.sequence <= previous.lastSequence &&
      Date.parse(args.snapshot.collectedAt) <= previous.collectedAt.getTime() + 3_600_000)
      return { accepted: false, reason: 'stale_sequence' };
    const [site] = await db.select({ id: sites.id, name: sites.name, timezone: sites.timezone }).from(sites)
      .where(and(eq(sites.id, owner.siteId), eq(sites.orgId, args.orgId))).limit(1);
    const expected = resolveExpectedTimezone({ site: site ?? null });
    const resolved = resolveTimeFindings(args.snapshot, { now: args.receivedAt,
      expectedTimezone: expected, previousEventMarks: previous?.eventMarks ?? {} });
    const row = buildTimeStatusRow(args, previous, expected, resolved);
    await db.insert(deviceTimeStatus).values(row).onConflictDoUpdate({ target: deviceTimeStatus.deviceId, set: row });
    await upsertDaily({ deviceId: args.deviceId, orgId: args.orgId, snapshot: args.snapshot,
      result: resolved, expectedTimezone: expected, receivedAt: args.receivedAt });
    return { accepted: true, health: resolved.health };
  });
}
```

The prerequisite's first-row serialization must be retained: the draft's exclusive parent-device lock precedes `SELECT ... FOR UPDATE` on status and sequence evaluation. A `FOR UPDATE` on a nonexistent status row alone does not serialize the first two deliveries; the new race test pins this prerequisite requirement. No helper may open a separate transaction or swallow its failure.

- [ ] Rerun the two unit files and the ingest integration file; expected PASS. Existing W01a `ingest.integration.test.ts` must remain green under `cd apps/api && npx vitest run --config vitest.integration.config.ts src/services/timeSync/ingest.integration.test.ts`.
- [ ] Commit:

```bash
git add apps/api/src/services/timeSync/applyStreaks.ts apps/api/src/services/timeSync/applyStreaks.test.ts apps/api/src/services/timeSync/upsertDaily.ts apps/api/src/services/timeSync/upsertDaily.test.ts apps/api/src/services/timeSync/testSnapshot.ts apps/api/src/services/timeSync/ingest.ts apps/api/src/services/timeSync/ingest.w02.integration.test.ts
git commit -m "feat(time-sync): aggregate accepted snapshot evidence" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 3: Schedule bounded 400-day retention

**Files:** Create `apps/api/src/jobs/timeSyncRetention.ts` and `.test.ts`; modify `jobs/scheduleRegistry.ts:105`, `jobs/workerReadinessManifest.ts:85`, `services/workerRegistry.ts:438–445`, `services/workerRegistry.test.ts:48`, `services/workerEntrypointClosure.contract.test.ts:288`.

**Interfaces:** Consumes `pruneInCtidBatches` and `warnOnRetentionBacklog` from `jobs/retentionBatch.ts` (per-batch system context at lines 119–157), `jobSchedule(key)`, `attachWorkerObservability(worker,name)`. Produces `runTimeSyncRetention()`, `initializeTimeSyncRetention(): Promise<void>`, `shutdownTimeSyncRetention(): Promise<void>`; queue `time-sync-retention`, worker `timeSyncRetention`, cron `18 7 * * *`.

- [ ] Write the failing test:

```ts
// jobs/timeSyncRetention.test.ts
import { beforeEach, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
const m=vi.hoisted(()=>({prune:vi.fn(),warn:vi.fn(),add:vi.fn(),close:vi.fn(),remove:vi.fn(),observe:vi.fn()}));
vi.mock('./retentionBatch',()=>({pruneInCtidBatches:m.prune,warnOnRetentionBacklog:m.warn}));
vi.mock('../services/redis',()=>({getBullMQConnection:()=>({})}));
vi.mock('./workerObservability',()=>({attachWorkerObservability:m.observe}));
vi.mock('bullmq',()=>({
  Queue:class {add=m.add;close=m.close;removeRepeatableByKey=m.remove;getRepeatableJobs=async()=>[{key:'old'}];},
  Worker:class {close=m.close;on=vi.fn();},
}));
import {runTimeSyncRetention,initializeTimeSyncRetention,shutdownTimeSyncRetention} from './timeSyncRetention';
beforeEach(()=>{vi.clearAllMocks();m.prune.mockResolvedValue({deleted:3,batches:1,hasMore:false});});
it('uses bounded batches and strictly older than 400 days',async()=>{
  expect(await runTimeSyncRetention()).toEqual({deleted:3,batches:1,hasMore:false});
  const options=m.prune.mock.calls[0]![0];
  expect(options).toMatchObject({table:'device_time_daily',batchSize:10000,maxBatches:100,label:'timeSyncRetention.daily'});
  expect(new PgDialect().sqlToQuery(options.where).sql).toBe('day < current_date - 400');
});
it('reports backlog and propagates errors',async()=>{
  const capped={deleted:1000000,batches:100,hasMore:true};m.prune.mockResolvedValueOnce(capped);
  await runTimeSyncRetention();expect(m.warn).toHaveBeenCalledWith('[time-sync]','device_time_daily',capped);
  m.prune.mockRejectedValueOnce(new Error('database unavailable'));
  await expect(runTimeSyncRetention()).rejects.toThrow('database unavailable');
});
it('replaces repeat registration and closes both resources once',async()=>{
  await initializeTimeSyncRetention();expect(m.remove).toHaveBeenCalledWith('old');
  expect(m.observe).toHaveBeenCalledWith(expect.anything(),'timeSyncRetention');
  expect(m.add).toHaveBeenCalledWith('cleanup',{}, {repeat:{pattern:'18 7 * * *'},removeOnComplete:{count:5},removeOnFail:{count:10}});
  await shutdownTimeSyncRetention();await shutdownTimeSyncRetention();expect(m.close).toHaveBeenCalledTimes(2);
});
```

- [ ] Run `cd apps/api && npx vitest run src/jobs/timeSyncRetention.test.ts`; expected FAIL: cannot load `./timeSyncRetention`.
- [ ] Create the worker:

```ts
import { Queue, Worker } from 'bullmq';
import { sql } from 'drizzle-orm';
import { getBullMQConnection } from '../services/redis';
import { pruneInCtidBatches, warnOnRetentionBacklog } from './retentionBatch';
import { jobSchedule } from './scheduleRegistry';
import { attachWorkerObservability } from './workerObservability';
const QUEUE_NAME='time-sync-retention';
let queue:Queue|null=null;
let worker:Worker|null=null;
export async function runTimeSyncRetention() {
  const result=await pruneInCtidBatches({table:'device_time_daily',where:sql`day < current_date - 400`,batchSize:10000,maxBatches:100,label:'timeSyncRetention.daily'});
  warnOnRetentionBacklog('[time-sync]','device_time_daily',result);
  return result;
}
export async function initializeTimeSyncRetention():Promise<void> {
  queue=new Queue(QUEUE_NAME,{connection:getBullMQConnection()});
  worker=new Worker(QUEUE_NAME,()=>runTimeSyncRetention(),{connection:getBullMQConnection(),concurrency:1});
  attachWorkerObservability(worker,'timeSyncRetention');
  worker.on('error',error=>console.error('[time-sync] retention worker failed',error));
  for(const job of await queue.getRepeatableJobs())await queue.removeRepeatableByKey(job.key);
  await queue.add('cleanup',{}, {repeat:{pattern:jobSchedule('time-sync-retention')},removeOnComplete:{count:5},removeOnFail:{count:10}});
}
export async function shutdownTimeSyncRetention():Promise<void> {
  if(worker){await worker.close();worker=null;}
  if(queue){await queue.close();queue=null;}
}
```

- [ ] Replace `scheduleRegistry.ts:105` anchor `'hardware-health-retention': '8 7 * * *',` with itself followed by `'time-sync-retention': '18 7 * * *',`. Replace `workerReadinessManifest.ts:85` anchor `consumers('hardwareHealthRetention'),` with itself followed by `consumers('timeSyncRetention'),`.
- [ ] Append this exact sibling after the hardware worker block at `services/workerRegistry.ts:438–445`:

```ts
  {
    name: 'timeSyncRetention',
    placement: 'socket-owner',
    load: async () => {
      const m = await import('../jobs/timeSyncRetention');
      return { init: m.initializeTimeSyncRetention, shutdown: m.shutdownTimeSyncRetention };
    },
  },
```

In `workerRegistry.test.ts:48` and `workerEntrypointClosure.contract.test.ts:288`, replace:

```ts
'backupVerificationJobs', 'eventLogRetention', 'hardwareHealthRetention', 'logCorrelationWorker', 'agentLogRetention',
```

with:

```ts
'backupVerificationJobs', 'eventLogRetention', 'hardwareHealthRetention', 'timeSyncRetention', 'logCorrelationWorker', 'agentLogRetention',
```

- [ ] Run `cd apps/api && npx vitest run src/jobs/timeSyncRetention.test.ts src/jobs/scheduleRegistry.contract.test.ts src/jobs/workerReadinessManifest.test.ts src/services/workerRegistry.test.ts src/services/workerEntrypointClosure.contract.test.ts`; expected PASS, including transitive worker imports and readiness.
- [ ] Commit:

```bash
git add apps/api/src/jobs/timeSyncRetention.ts apps/api/src/jobs/timeSyncRetention.test.ts apps/api/src/jobs/scheduleRegistry.ts apps/api/src/jobs/workerReadinessManifest.ts apps/api/src/services/workerRegistry.ts apps/api/src/services/workerRegistry.test.ts apps/api/src/services/workerEntrypointClosure.contract.test.ts
git commit -m "feat(time-sync): prune daily evidence after 400 days" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 4: Register the root-only time-sync monitor kind

**Files:** Create `packages/shared/src/validators/monitors.timeSync.test.ts`, `apps/api/src/services/monitors/kinds/timeSync.ts` and `.test.ts`, and the enum migration; modify `packages/shared/src/validators/monitors.ts:1–2,33,240–241`, `monitors.test.ts:35`, `apps/api/src/db/schema/monitorDefinitions.ts:59`, `services/alertConditions/types.ts:161,185,205`, `services/monitors/kinds/index.ts:25,63`, `kinds/index.test.ts:37,41–42`, `routes/monitorDefinitions.test.ts:294,301,309–312`.

**Interfaces:** Produces `TimeSyncCondition { type:'time_sync'; findings:TimeSyncFindingCode[]; consecutiveSnapshots:number }`, `monitorConditionSchemas.time_sync`, `timeSyncKind: MonitorKindSpec<Omit<TimeSyncCondition,'type'>>`. Consumes `MonitorKindSpec.toAlertCondition(condition,ctx): RootCondition` (`kinds/types.ts:30–61`), index §G constants and shape.

- [ ] Write the failing schema and compiler tests:

```ts
// packages/shared/src/validators/monitors.timeSync.test.ts
import { expect, it } from 'vitest';
import { TIME_SYNC_FINDING_CODES } from '../constants/timeSync';
import { MONITOR_KINDS, SERVER_EVALUATED_MONITOR_KINDS, monitorConditionSchemas, compositeConditionSchema } from './monitors';
it('accepts each finding with two observations by default and remains root-only',()=>{
  expect(MONITOR_KINDS).toContain('time_sync');expect(SERVER_EVALUATED_MONITOR_KINDS).not.toContain('time_sync');
  for(const code of TIME_SYNC_FINDING_CODES)expect(monitorConditionSchemas.time_sync.parse({findings:[code]})).toEqual({findings:[code],consecutiveSnapshots:2});
});
it.each([{findings:[]},{findings:['other']},{findings:'sync_stale'},{consecutiveSnapshots:0},{consecutiveSnapshots:11},{consecutiveSnapshots:1.5},{consecutiveSnapshots:'2'},{extra:true}])
 ('rejects %j',patch=>expect(monitorConditionSchemas.time_sync.safeParse({findings:['sync_stale'],...patch}).success).toBe(false));
it.each([1,10])('accepts streak boundary %i',consecutiveSnapshots=>{
  expect(monitorConditionSchemas.time_sync.safeParse({findings:['sync_stale'],consecutiveSnapshots}).success).toBe(true);
});
it('rejects time subjects inside composites',()=>{
  expect(compositeConditionSchema.safeParse({match:'all',children:[
    {kind:'time_sync',condition:{findings:['sync_stale']}},
    {kind:'cpu',condition:{operator:'gt',value:90}},
  ]}).success).toBe(false);
});
```

```ts
// apps/api/src/services/monitors/kinds/timeSync.test.ts
import { expect, it } from 'vitest';
import { interpolateAlertTemplate } from '@breeze/shared';
import { getMonitorKindSpec, applyOverrides } from './index';
const condition={findings:['sync_stale'],consecutiveSnapshots:2};
it('compiles subjects with exact category, templates and delivery metadata',()=>{
  const spec=getMonitorKindSpec('time_sync');
  expect(spec.toAlertCondition(condition,{monitorId:'11111111-1111-4111-8111-111111111111'})).toEqual({type:'time_sync',...condition});
  expect(spec).toMatchObject({alertCategory:'system',agentDelivered:false,defaultSeverity:'medium',titleTemplate:'{{findingLabel}} on {{deviceName}}',messageTemplate:'{{ruleName}}: {{findingDetail}}'});
  expect(interpolateAlertTemplate(spec.titleTemplate,{findingLabel:'Time sync stale',deviceName:'Device A'})).toBe('Time sync stale on Device A');
  expect(interpolateAlertTemplate(spec.messageTemplate,{ruleName:'Time',findingDetail:'Last sync exceeded 24 hours'})).toBe('Time: Last sync exceeded 24 hours');
});
it('overrides count but never changes findings',()=>{
  const spec=getMonitorKindSpec('time_sync');
  expect(applyOverrides(spec,condition,{findings:['sync_disabled'],consecutiveSnapshots:3})).toEqual({findings:['sync_stale'],consecutiveSnapshots:3});
  expect(()=>applyOverrides(spec,condition,{consecutiveSnapshots:11})).toThrow();
});
```

- [ ] Run `cd packages/shared && npx vitest run src/validators/monitors.timeSync.test.ts`, then `cd apps/api && npx vitest run src/services/monitors/kinds/timeSync.test.ts` from the repository root in separate shells. Expected FAIL: undefined `time_sync` schema / unknown monitor kind.
- [ ] Implement the schema and enum:

```sql
-- apps/api/migrations/2026-11-09-110100-monitor-kind-time-sync.sql
ALTER TYPE monitor_kind ADD VALUE IF NOT EXISTS 'time_sync';
```

In shared `monitors.ts:1–2` add:

```ts
import { TIME_SYNC_FINDING_CODES } from '../constants/timeSync';
```

At `monitors.ts:33`, replace `'hardware_health',` with:

```ts
  'hardware_health',
  'time_sync',
```

At `monitors.ts:240–241`, immediately before `} satisfies Record<Exclude<MonitorKind, 'composite'>, z.ZodTypeAny>;`, insert:

```ts
  time_sync: z.object({
    findings: z.array(z.enum(TIME_SYNC_FINDING_CODES)).min(1),
    consecutiveSnapshots: z.number().int().min(1).max(10).default(2),
  }).strict(),
```

Append `'time_sync',` after `'hardware_health',` in `db/schema/monitorDefinitions.ts:59`. Do not modify the server-evaluated kinds list.

At `alertConditions/types.ts:161`, include `TimeSyncFindingCode` in the existing shared type import. After the `HardwareHealthCondition` closing brace at 185, insert:

```ts
export interface TimeSyncCondition {
  type: 'time_sync';
  findings: TimeSyncFindingCode[];
  consecutiveSnapshots: number;
}
```

Replace the union tail `| HardwareHealthCondition;` at 205 with:

```ts
  | HardwareHealthCondition
  | TimeSyncCondition;
```

Create the compiler:

```ts
import { monitorConditionSchemas } from '@breeze/shared';
import type { TimeSyncCondition } from '../../alertConditions/types';
import type { MonitorKindSpec } from './types';
type C=Omit<TimeSyncCondition,'type'>;
export const timeSyncKind:MonitorKindSpec<C>={
  kind:'time_sync',conditionSchema:monitorConditionSchemas.time_sync,
  overridableKeys:['consecutiveSnapshots'],defaultSeverity:'medium',agentDelivered:false,
  alertCategory:'system',titleTemplate:'{{findingLabel}} on {{deviceName}}',messageTemplate:'{{ruleName}}: {{findingDetail}}',
  toAlertCondition:condition=>({type:'time_sync',...condition}),
};
```

In `kinds/index.ts:25`, after the hardware import, add `import { timeSyncKind } from './timeSync';`. At 63 after `hardware_health: hardwareHealthKind,`, add `time_sync: timeSyncKind,`.

- [ ] Update fixed parity expectations with these exact edits:

```python
from pathlib import Path
p=Path('packages/shared/src/validators/monitors.test.ts');s=p.read_text();s=s.replace("'hardware_health',", "'hardware_health', 'time_sync',");p.write_text(s)
p=Path('apps/api/src/services/monitors/kinds/index.test.ts');s=p.read_text()
a=next(line for line in s.splitlines() if 'hardware_health:' in line)
s=s.replace(a,a+"\n  time_sync: { findings: ['sync_stale'], consecutiveSnapshots: 2 },",1)
s=s.replace('twenty kinds','twenty-one kinds').replace('twenty monitor kinds','twenty-one monitor kinds').replace('toHaveLength(20)','toHaveLength(21)');p.write_text(s)
p=Path('apps/api/src/routes/monitorDefinitions.test.ts');s=p.read_text()
s=s.replace('twenty kinds','twenty-one kinds').replace('twenty monitor kinds','twenty-one monitor kinds').replace('toHaveLength(20)','toHaveLength(21)');p.write_text(s)
```

The existing discovery test already checks each schema metadata entry. The new dedicated kind test pins the time-specific templates/overrides. This wave changes the kinds count from 20 to 21; W01a did not add a monitor kind.

- [ ] Run `cd packages/shared && npx vitest run src/validators/monitors.timeSync.test.ts src/validators/monitors.test.ts`; expected PASS. Run `cd apps/api && npx vitest run src/services/monitors/kinds/timeSync.test.ts src/routes/monitorDefinitions.test.ts`; expected PASS; the all-kinds validation test runs in Task 5 after the handler is registered. Apply enum migration before provisioning tests.
- [ ] Commit:

```bash
git add packages/shared/src/validators/monitors.ts packages/shared/src/validators/monitors.test.ts packages/shared/src/validators/monitors.timeSync.test.ts apps/api/migrations/2026-11-09-110100-monitor-kind-time-sync.sql apps/api/src/db/schema/monitorDefinitions.ts apps/api/src/services/alertConditions/types.ts apps/api/src/services/monitors/kinds/timeSync.ts apps/api/src/services/monitors/kinds/timeSync.test.ts apps/api/src/services/monitors/kinds/index.ts apps/api/src/services/monitors/kinds/index.test.ts apps/api/src/routes/monitorDefinitions.test.ts
git commit -m "feat(monitors): register time synchronization conditions" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 5: Evaluate per-finding subjects and preserve recovery semantics

**Files:** Create `services/alertConditions/handlers/timeSync.ts` and `.test.ts`; modify `services/alertConditions/index.ts:33,52,58`, `services/alertSubjects.ts:50`, `services/alertSubjects.test.ts:88`, `services/alertService.ts:1190–1192`, `services/alertService.episodes.test.ts:494,503`.

**Interfaces:** Consumes `ConditionHandler.evaluate(condition:unknown,deviceId:string):Promise<ConditionResult>` (`alertConditions/registry.ts:10–14`), `SubjectEvidence` (`types.ts:168–173`), and `FindingStreaks` from Task 2. Produces `timeSyncHandler` with `subjectKey=code`, independent breaching/recovered/unknown evidence, and `context.source='time_sync'`, `context.timeSource` for the observed peer. Missing/stale rows return selected unknown subjects and `dataAvailable:false`, following binding index §G.

- [ ] Write the failing handler test:

```ts
import { afterEach,beforeEach,expect,it,vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
const mocks=vi.hoisted(()=>({select:vi.fn(),predicates:[] as unknown[]}));
vi.mock('../../../db',()=>({db:{select:mocks.select}}));
import { timeSyncHandler } from './timeSync';
const now=new Date('2026-09-28T12:00:00Z');
const deviceId='11111111-1111-4111-8111-111111111111';
const condition={type:'time_sync',findings:['sync_stale','sync_disabled'],consecutiveSnapshots:2};
function rows(patch:Record<string,unknown>|null={}) {
  const result=patch===null?[]:[{receivedAt:now,findings:['sync_stale'],findingStreaks:{sync_stale:{present:2,absent:0},sync_disabled:{present:0,absent:2}},findingDetails:{sync_stale:{thresholdHours:24}},domainRole:'member',source:'time.example.com',lastSuccessfulSyncAt:now,...patch}];
  mocks.select.mockImplementationOnce(()=>({from:()=>({where:(p:unknown)=>{mocks.predicates.push(p);return {limit:async()=>result};}})}));
}
beforeEach(()=>{mocks.select.mockReset();mocks.predicates=[];vi.useFakeTimers();vi.setSystemTime(now);});
afterEach(()=>vi.useRealTimers());
it('emits independent subjects and complete template context',async()=>{
  rows();const result=await timeSyncHandler.evaluate(condition,deviceId);
  expect(result).toMatchObject({passed:true,dataAvailable:true,subjects:[{subjectKey:'sync_stale',status:'breaching'},{subjectKey:'sync_disabled',status:'recovered'}]});
  expect(result.subjects?.[0]?.context).toEqual({source:'time_sync',subjectKey:'sync_stale',findingCode:'sync_stale',findingLabel:'Time sync is stale',findingDetail:'thresholdHours: 24',domainRole:'member',timeSource:'time.example.com',lastSuccessfulSyncAt:now.toISOString()});
  const query=new PgDialect().sqlToQuery(mocks.predicates[0] as never);
  expect(query.sql).toContain('"device_id"');expect(query.params).toContain(deviceId);
});
it.each([[1,0,'unknown'],[2,0,'breaching'],[0,1,'unknown'],[0,2,'recovered']] as const)('streak %i/%i -> %s',async(present,absent,status)=>{
  rows({findingStreaks:{sync_stale:{present,absent}}});const result=await timeSyncHandler.evaluate(condition,deviceId);
  expect(result.subjects?.[0]?.status).toBe(status);expect(result.subjects?.[1]?.status).toBe('unknown');
});
it.each([null,{receivedAt:new Date(+now-90*60_000-1)}])('missing/stale row stays unknown',async patch=>{
  rows(patch);expect(await timeSyncHandler.evaluate(condition,deviceId)).toMatchObject({passed:false,dataAvailable:false,subjects:[{subjectKey:'sync_stale',status:'unknown'},{subjectKey:'sync_disabled',status:'unknown'}]});
});
it('keeps the exact 90-minute boundary fresh and never counts sweeps',async()=>{
  for(let sweep=0;sweep<3;sweep++){
    rows({receivedAt:new Date(+now-90*60_000),findingStreaks:{sync_stale:{present:1,absent:0}}});
    const result=await timeSyncHandler.evaluate(condition,deviceId);
    expect(result.dataAvailable).toBe(true);expect(result.subjects?.[0]?.status).toBe('unknown');
  }
});
it('deduplicates selected findings and validates the shared shape',async()=>{
  rows();expect((await timeSyncHandler.evaluate({...condition,findings:['sync_stale','sync_stale']},deviceId)).subjects).toHaveLength(1);
  expect(timeSyncHandler.validate(condition,'condition')).toEqual([]);
  expect(timeSyncHandler.validate({...condition,findings:[]},'condition')[0]).toContain('condition.findings');
});
```

- [ ] Append this regression to `alertSubjects.test.ts` (its `input`, `template`, and `m.create` are defined at lines 3–31):

```ts
it('preserves time-finding provenance and interpolates its text',async()=>{
  const arg=input({sync_stale:'breaching'});arg.monitor.kind='time_sync';
  arg.template={...template,titleTemplate:'{{findingLabel}} on {{deviceName}}',messageTemplate:'{{findingDetail}}'};
  arg.evidence.subjects[0].context={source:'time_sync',findingLabel:'Time sync is stale',findingDetail:'No successful synchronization',timeSource:'time.example.com'};
  await evaluateSubjectAlerts(arg);
  expect(m.create).toHaveBeenCalledWith(expect.objectContaining({subjectKey:'sync_stale',kind:'time_sync',title:'Time sync is stale on server',message:'No successful synchronization',context:expect.objectContaining({source:'time_sync',timeSource:'time.example.com'})}));
});
```

Change the existing complete maintenance test at `alertService.episodes.test.ts:494` from:

```ts
it('preserves component recovery under the subject lock without admitting breaches or episode side effects', async () => {
```

to:

```ts
it.each(['hardware_health', 'time_sync'] as const)('preserves %s subject recovery under the subject lock without admitting breaches or episode side effects', async kind => {
```

and replace its line 503:

```ts
pushSweepQueue({ triggered: false, monitorRow: { id: MONITOR_ID, kind: 'hardware_health' } });
```

with:

```ts
pushSweepQueue({ triggered: false, monitorRow: { id: MONITOR_ID, kind } });
```

- [ ] Run `cd apps/api && npx vitest run src/services/alertConditions/handlers/timeSync.test.ts src/services/alertSubjects.test.ts src/services/alertService.episodes.test.ts`. Expected FAIL: module missing; expected `source:time_sync`, received hardware; time maintenance test expected evaluation call, received zero.
- [ ] Implement the handler:

```ts
import { eq } from 'drizzle-orm';
import { monitorConditionSchemas,TIME_SYNC_STALE_AFTER_MS,type TimeSyncFindingCode } from '@breeze/shared';
import { db } from '../../../db';
import { deviceTimeStatus } from '../../../db/schema';
import type { ConditionHandler } from '../registry';
import type { SubjectEvidence,SubjectStatus } from '../types';
const labels:Record<TimeSyncFindingCode,string>={
  pdc_no_external_source:'PDC has no external time source',source_local_clock:'Local clock is the time source',
  dc_vm_host_sync:'Domain controller uses host time',ntp_server_unresolvable:'Time server name cannot be resolved',
  ntp_peer_unreachable:'Time peer is unreachable',domain_source_unavailable:'Domain time source is unavailable',
  member_not_on_hierarchy:'Domain member bypasses the time hierarchy',sync_disabled:'Time synchronization is disabled',
  sync_stale:'Time sync is stale',correction_refused:'Time correction was refused',timezone_mismatch:'Timezone mismatch',
  policy_not_applied:'Time policy was not applied',policy_conflict_gpo:'Group Policy manages time settings',
};
export const timeSyncHandler:ConditionHandler={
  type:'time_sync',
  async evaluate(condition,deviceId){
    const {type:_type,...rest}=condition as Record<string,unknown>;
    const cond=monitorConditionSchemas.time_sync.parse(rest);
    const [row]=await db.select().from(deviceTimeStatus).where(eq(deviceTimeStatus.deviceId,deviceId)).limit(1);
    const age=row?Date.now()-row.receivedAt.getTime():Number.NaN;
    const available=Boolean(row&&Number.isFinite(age)&&age<=TIME_SYNC_STALE_AFTER_MS);
    const subjects:SubjectEvidence[]=[...new Set(cond.findings)].map(code=>{
      let status:SubjectStatus='unknown';const streak=row?.findingStreaks[code];
      if(available&&streak){
        if(streak.present>=cond.consecutiveSnapshots)status='breaching';
        else if(streak.absent>=cond.consecutiveSnapshots)status='recovered';
      }
      const detail=row?.findingDetails[code]??{};
      const findingDetail=Object.entries(detail).map(([key,value])=>`${key}: ${value??'unknown'}`).join('; ')||labels[code];
      return {subjectKey:code,status,description:findingDetail,context:{source:'time_sync',subjectKey:code,findingCode:code,
        findingLabel:labels[code],findingDetail,domainRole:row?.domainRole??'unknown',timeSource:row?.source??null,
        lastSuccessfulSyncAt:row?.lastSuccessfulSyncAt?.toISOString()??null}};
    });
    const count=(status:SubjectStatus)=>subjects.filter(s=>s.status===status).length;
    return {passed:count('breaching')>0,dataAvailable:available,subjects,
      description:`${count('breaching')} breaching, ${count('recovered')} recovered, ${count('unknown')} unknown time findings`};
  },
  validate(condition,path){
    const {type:_type,...rest}=(condition??{}) as Record<string,unknown>;
    const result=monitorConditionSchemas.time_sync.safeParse(rest);
    return result.success?[]:result.error.issues.map(i=>`${path}.${i.path.join('.')}: ${i.message}`);
  },
};
```

In `alertConditions/index.ts:33`, append `import { timeSyncHandler } from './handlers/timeSync';` after the hardware handler import. After `conditionRegistry.register(hardwareHealthHandler);` at 52, add `conditionRegistry.register(timeSyncHandler);`. Add `TimeSyncCondition` to the type re-export list at 58.

Replace `alertSubjects.ts:50`:

```ts
...evidence.context, ...subject.context, source: 'hardware_health', subjectKey: subject.subjectKey,
```

with:

```ts
...evidence.context, ...subject.context,
source: monitor?.kind ?? (typeof subject.context?.source === 'string' ? subject.context.source : 'hardware_health'),
subjectKey: subject.subjectKey,
```

Replace the suppression condition at `alertService.ts:1192`:

```ts
if (suppressAlerts && monitor?.kind !== 'hardware_health') continue;
```

with:

```ts
if (suppressAlerts && monitor?.kind !== 'hardware_health' && monitor?.kind !== 'time_sync') continue;
```

Replace its preceding hardware-only comment with `// Subject monitors still evaluate recovery during maintenance; new breaches remain suppressed.` Preserve the existing subject advisory-lock key and episode ownership logic.

- [ ] Rerun the three focused files plus `cd apps/api && npx vitest run src/services/monitors/kinds/index.test.ts`; expected PASS, including hardware regressions, maintenance recovery, and unknown evidence preserving open alerts.
- [ ] Commit:

```bash
git add apps/api/src/services/alertConditions/handlers/timeSync.ts apps/api/src/services/alertConditions/handlers/timeSync.test.ts apps/api/src/services/alertConditions/index.ts apps/api/src/services/alertSubjects.ts apps/api/src/services/alertSubjects.test.ts apps/api/src/services/alertService.ts apps/api/src/services/alertService.episodes.test.ts
git commit -m "feat(alerts): evaluate time findings as independent subjects" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 6: Provision version 4 defaults and expose monitor editor fields

**Files:** Modify `services/monitors/builtInMonitors.ts:32,40,48,59,63,177`, `builtInMonitors.test.ts:12–41`, `src/__tests__/integration/builtInMonitors.integration.test.ts:145,179–195,248`; create `builtInMonitors.timeSync.test.ts`; modify `apps/web/src/components/monitoring/monitorKindFields.ts:1,281,364`, `MonitorConditionFields.tsx:30`; create `MonitorConditionFields.timeSync.test.tsx`; modify all eight `locales/*/monitoring.json:194,573–590`.

**Interfaces:** Consumes `defaultsToProvision(version:number|null)` and `ensureBuiltInMonitorsForPartner` from the existing seeder; produces three `sinceVersion:4` defaults and editor `findings` multiselect / bounded number. Existing `MonitorConditionFields` multiselect serializes enum order and uses `SELECT_OPTION_NAMESPACE` for localized option text.

- [ ] Write the failing built-in assertions:

```ts
// services/monitors/builtInMonitors.timeSync.test.ts
import { expect,it } from 'vitest';
import { BUILT_IN_MONITORS_VERSION,BUILT_IN_MONITOR_DEFAULTS,defaultsToProvision } from './builtInMonitors';
it('adds exactly the three approved v4 defaults and no v5 policy default',()=>{
  expect(BUILT_IN_MONITORS_VERSION).toBe(4);
  expect(defaultsToProvision(3).map(d=>[d.key,d.name,d.condition,d.severity,d.sinceVersion])).toEqual([
    ['time_source_problem','Time source problem',{findings:['pdc_no_external_source','source_local_clock','dc_vm_host_sync','ntp_server_unresolvable','ntp_peer_unreachable','domain_source_unavailable','member_not_on_hierarchy','correction_refused'],consecutiveSnapshots:2},'high',4],
    ['time_sync_stale','Time sync stale or disabled',{findings:['sync_stale','sync_disabled'],consecutiveSnapshots:2},'medium',4],
    ['timezone_mismatch','Timezone mismatch',{findings:['timezone_mismatch'],consecutiveSnapshots:2},'low',4],
  ]);
  expect(defaultsToProvision(4)).toEqual([]);
  expect(BUILT_IN_MONITOR_DEFAULTS.some(d=>String(d.key)==='time_policy_not_applied')).toBe(false);
});
```

Append this full test to the existing database seeder suite; its `newPartner`, `builtInsFor`, `marker`, `SYSTEM_CTX`, `db`, and schema imports already exist:

```ts
it('upgrades version 3 once without restoring deleted defaults or overwriting edits',async()=>{
  const partner=await newPartner();
  await withDbAccessContext(SYSTEM_CTX,()=>ensureBuiltInMonitorsForPartner(partner.id));
  const timeKeys=['time_source_problem','time_sync_stale','timezone_mismatch'];
  await withDbAccessContext(SYSTEM_CTX,async()=>{
    await db.delete(monitorDefinitions).where(and(eq(monitorDefinitions.partnerId,partner.id),inArray(monitorDefinitions.builtinKey,[...timeKeys,'physical_disk_failed'])));
    await db.update(monitorDefinitions).set({enabled:false,cooldownMinutes:321}).where(and(eq(monitorDefinitions.partnerId,partner.id),eq(monitorDefinitions.builtinKey,'raid_array_degraded')));
    await db.update(partners).set({settings:sql`jsonb_build_object('builtInMonitors',jsonb_build_object('version',3,'provisionedAt','2026-01-01T00:00:00.000Z'))`}).where(eq(partners.id,partner.id));
  });
  const before=await builtInsFor(partner.id);
  const result=await withDbAccessContext(SYSTEM_CTX,()=>ensureBuiltInMonitorsForPartner(partner.id));
  expect(result.monitorIds).toHaveLength(3);
  const after=await builtInsFor(partner.id);
  expect(after.filter(r=>timeKeys.includes(r.builtinKey!))).toHaveLength(3);
  expect(after.some(r=>r.builtinKey==='physical_disk_failed')).toBe(false);
  for(const row of before)expect(after.find(r=>r.id===row.id)).toEqual(row);
  expect(await marker(partner.id)).toMatchObject({version:4,provisionedAt:'2026-01-01T00:00:00.000Z'});
  expect(await withDbAccessContext(SYSTEM_CTX,()=>ensureBuiltInMonitorsForPartner(partner.id))).toEqual({provisioned:false,monitorIds:[]});
});
```

```tsx
// apps/web/src/components/monitoring/MonitorConditionFields.timeSync.test.tsx
import '@/lib/i18n';
import { fireEvent,render,screen,waitFor } from '@testing-library/react';
import { FormProvider,useForm } from 'react-hook-form';
import { expect,it,vi } from 'vitest';
import { TIME_SYNC_FINDING_CODES } from '@breeze/shared';
import MonitorConditionFields from './MonitorConditionFields';
import { defaultConditionFor } from './monitorKindFields';
function Harness({submit}:{submit:(value:unknown)=>void}) {
  const form=useForm({defaultValues:{condition:defaultConditionFor('time_sync')}});
  return <FormProvider {...form}><form onSubmit={form.handleSubmit(submit)}>
    <MonitorConditionFields kind="time_sync" name="condition" />
    <button type="submit" data-testid="save">Save</button>
    <button type="button" data-testid="reset" onClick={()=>form.reset({condition:{...defaultConditionFor('time_sync'),findings:['timezone_mismatch']}})}>Reset</button>
    <button type="button" data-testid="error" onClick={()=>form.setError('condition.findings',{message:'Select at least one finding'})}>Error</button>
  </form></FormProvider>;
}
it('selects, clears, resets, localizes and exposes validation errors',async()=>{
  const submit=vi.fn();render(<Harness submit={submit}/>);
  const checkbox=(key:string)=>screen.getByTestId(`condition-field-findings-${key}`) as HTMLInputElement;
  for(const code of TIME_SYNC_FINDING_CODES)expect(checkbox(code)).toBeTruthy();
  expect(checkbox('sync_stale').checked).toBe(true);expect(checkbox('sync_disabled').checked).toBe(true);
  expect(screen.getByText('Time sync is stale')).toBeTruthy();
  fireEvent.click(checkbox('timezone_mismatch'));fireEvent.click(screen.getByTestId('save'));
  await waitFor(()=>expect(submit).toHaveBeenCalledTimes(1));
  expect(submit.mock.calls[0]![0].condition).toEqual({findings:['sync_disabled','sync_stale','timezone_mismatch'],consecutiveSnapshots:2});
  for(const key of ['sync_disabled','sync_stale','timezone_mismatch'])fireEvent.click(checkbox(key));
  fireEvent.click(screen.getByTestId('save'));await waitFor(()=>expect(submit).toHaveBeenCalledTimes(2));
  expect(submit.mock.calls[1]![0].condition.findings).toEqual([]);
  fireEvent.click(screen.getByTestId('reset'));expect(checkbox('timezone_mismatch').checked).toBe(true);expect(checkbox('sync_stale').checked).toBe(false);
  fireEvent.click(screen.getByTestId('error'));expect(screen.getByText('Select at least one finding')).toBeTruthy();
});
```

- [ ] Run `cd apps/api && npx vitest run src/services/monitors/builtInMonitors.timeSync.test.ts`; expected FAIL version 3 vs 4. Run `cd apps/web && npx vitest run src/components/monitoring/MonitorConditionFields.timeSync.test.tsx`; expected FAIL missing time finding controls.
- [ ] Implement exact seeder replacements: shared type import at 32 adds `TimeSyncCondition`; line 40 becomes `export const BUILT_IN_MONITORS_VERSION = 4;`; after line 48 add `export type TimeSyncDefaultCondition = Omit<TimeSyncCondition, 'type'>;`. Replace key union tail `| 'hardware_collector_failing';` at 59 with `| 'hardware_collector_failing' | 'time_source_problem' | 'time_sync_stale' | 'timezone_mismatch';`. Add `| TimeSyncDefaultCondition` to `condition`'s union at 63. Before the defaults array closes at 177 insert:

```ts
  {
    key:'time_source_problem',name:'Time source problem',
    description:'Alerts after two accepted snapshots reporting a time source problem.',
    kind:'time_sync',condition:{findings:['pdc_no_external_source','source_local_clock','dc_vm_host_sync','ntp_server_unresolvable','ntp_peer_unreachable','domain_source_unavailable','member_not_on_hierarchy','correction_refused'],consecutiveSnapshots:2},
    severity:'high',cooldownMinutes:60,sinceVersion:4,
  },
  {
    key:'time_sync_stale',name:'Time sync stale or disabled',
    description:'Alerts after two accepted snapshots reporting stale or disabled synchronization.',
    kind:'time_sync',condition:{findings:['sync_stale','sync_disabled'],consecutiveSnapshots:2},
    severity:'medium',cooldownMinutes:60,sinceVersion:4,
  },
  {
    key:'timezone_mismatch',name:'Timezone mismatch',
    description:'Alerts after two accepted snapshots reporting a timezone mismatch.',
    kind:'time_sync',condition:{findings:['timezone_mismatch'],consecutiveSnapshots:2},
    severity:'low',cooldownMinutes:1440,sinceVersion:4,
  },
```

The existing seeder sets partner ownership, compiles templates, and leaves attachment creation untouched. Existing integration assertions at 107–146 assert no attachments across all defaults.

- [ ] Apply the existing assertion updates, retaining version 1/2/3 meaning:

```python
from pathlib import Path
p=Path('apps/api/src/services/monitors/builtInMonitors.test.ts');s=p.read_text()
s=s.replace("describe('version 3 hardware defaults'", "describe('version 4 time and historical hardware defaults'")
a="  const keys = ['raid_array_degraded', 'physical_disk_failed', 'cache_battery_problem', 'hardware_collector_failing'];"
s=s.replace(a,a+"\n  const timeKeys = ['time_source_problem', 'time_sync_stale', 'timezone_mismatch'];")
s=s.replace('has eight valid defaults, four introduced at version 3','has eleven valid defaults with preserved version gates')
s=s.replace('expect(BUILT_IN_MONITORS_VERSION).toBe(3)','expect(BUILT_IN_MONITORS_VERSION).toBe(4)')
s=s.replace('toHaveLength(8)','toHaveLength(11)')
s=s.replace('expect(defaultsToProvision(2).map((d) => d.key)).toEqual(keys)', 'expect(defaultsToProvision(2).map((d) => d.key)).toEqual([...keys, ...timeKeys])')
s=s.replace("['patch_compliance_low', ...keys]", "['patch_compliance_low', ...keys, ...timeKeys]")
s=s.replace('expect(defaultsToProvision(3)).toEqual([])', 'expect(defaultsToProvision(3).map(d => d.key)).toEqual(timeKeys);\n    expect(defaultsToProvision(4)).toEqual([])')
s=s.replace('defaultsToProvision(2).map((d) => [d.key, d.name', 'defaultsToProvision(2).filter(d => d.sinceVersion === 3).map((d) => [d.key, d.name')
p.write_text(s)
```

Apply these exact existing integration-test edits before appending the new version-3 test (verified anchors at lines 145,179–195,248):

```python
from pathlib import Path
p=Path('apps/api/src/__tests__/integration/builtInMonitors.integration.test.ts')
s=p.read_text().replace('version: 3','version: 4')
start=s.index("  it('upgrades version 2 without restoring deleted defaults or overwriting edits'")
end=s.index("  it('refuses an org-owned row",start)
block=s[start:end]
a="    const hardwareKeys = ['raid_array_degraded', 'physical_disk_failed', 'cache_battery_problem', 'hardware_collector_failing'];"
assert a in block
block=block.replace(a,a+"\n    const timeKeys = ['time_source_problem', 'time_sync_stale', 'timezone_mismatch'];",1)
block=block.replace("[...hardwareKeys, 'cpu_high']","[...hardwareKeys, ...timeKeys, 'cpu_high']")
block=block.replace('expect(result.monitorIds).toHaveLength(4);','expect(result.monitorIds).toHaveLength(7);')
a='    expect(after.filter((row) => hardwareKeys.includes(row.builtinKey!))).toHaveLength(4);'
block=block.replace(a,a+"\n    expect(after.filter(row => timeKeys.includes(row.builtinKey!))).toHaveLength(3);",1)
p.write_text(s[:start]+block+s[end:])
```

- [ ] Implement editor fields. Replace the type-only import at `monitorKindFields.ts:1` with `import { TIME_SYNC_FINDING_CODES, type MonitorKind } from '@breeze/shared';`. Before the map closing brace at 282 insert:

```ts
  time_sync: [
    { key:'findings',labelKey:'monitoring:monitors.fields.time_sync.findings',kind:'multiselect',options:TIME_SYNC_FINDING_CODES },
    { key:'consecutiveSnapshots',labelKey:'monitoring:monitors.fields.time_sync.consecutiveSnapshots',kind:'number',min:1,max:10 },
  ],
```

Before the default-condition switch closes at 364 insert:

```ts
case 'time_sync': return { findings:['sync_stale','sync_disabled'],consecutiveSnapshots:2 };
```

After `MonitorConditionFields.tsx:30` anchor `'hardware_health:minHealth': 'monitors.fields.hardware_health.minHealthOptions',` insert:

```ts
'time_sync:findings': 'monitors.fields.time_sync.findingOptions',
```

Apply this exact payload to the eight locale files, under existing root `kinds` and nested `monitors.fields` objects:

```python
import json
from pathlib import Path
labels={
 'pdc_no_external_source':'PDC has no external time source','source_local_clock':'Local clock is the time source',
 'dc_vm_host_sync':'Domain controller uses host time','ntp_server_unresolvable':'Time server name cannot be resolved',
 'ntp_peer_unreachable':'Time peer is unreachable','domain_source_unavailable':'Domain time source is unavailable',
 'member_not_on_hierarchy':'Domain member bypasses the time hierarchy','sync_disabled':'Time synchronization is disabled',
 'sync_stale':'Time sync is stale','correction_refused':'Time correction was refused','timezone_mismatch':'Timezone mismatch',
 'policy_not_applied':'Time policy was not applied','policy_conflict_gpo':'Group Policy manages time settings'
}
for locale in ['en','de-DE','es-419','fr-CA','fr-FR','it-IT','pt-BR','tr-TR']:
 p=Path(f'apps/web/src/locales/{locale}/monitoring.json');data=json.loads(p.read_text())
 data['kinds']['time_sync']='Time synchronization'
 data['monitors']['fields']['time_sync']={'findings':'Findings','consecutiveSnapshots':'Consecutive snapshots','findingOptions':labels}
 p.write_text(json.dumps(data,ensure_ascii=False,indent=2)+'\n')
```

- [ ] Run `cd apps/api && npx vitest run src/services/monitors/builtInMonitors.timeSync.test.ts src/services/monitors/builtInMonitors.test.ts`; then `cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/builtInMonitors.integration.test.ts`; expected PASS with idempotent upgrade and no attachments. Run `cd apps/web && npx vitest run src/components/monitoring/MonitorConditionFields.timeSync.test.tsx src/components/monitoring/monitorKindFields.test.ts`; expected PASS, including locale/default parity.
- [ ] Commit:

```bash
git add apps/api/src/services/monitors/builtInMonitors.ts apps/api/src/services/monitors/builtInMonitors.test.ts apps/api/src/services/monitors/builtInMonitors.timeSync.test.ts apps/api/src/__tests__/integration/builtInMonitors.integration.test.ts apps/web/src/components/monitoring/monitorKindFields.ts apps/web/src/components/monitoring/MonitorConditionFields.tsx apps/web/src/components/monitoring/MonitorConditionFields.timeSync.test.tsx apps/web/src/locales/{en,de-DE,es-419,fr-CA,fr-FR,it-IT,pt-BR,tr-TR}/monitoring.json
git commit -m "feat(monitors): provision time defaults and editor fields" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 7: Query scoped fleet status and complete domain context

**Files:** Create `apps/api/src/services/timeSync/fleet.ts`, `fleet.test.ts`. Read existing auth predicates at `services/aiToolsSiteScope.ts:66,85`, W01 `view.ts` contract §C.6, and CLDR map contract §C.1.

**Interfaces:** Produces `listFleetTimeStatus(filters:FleetTimeFilters,auth:AuthContext):Promise<FleetTimeResult>` and exact DTOs below. Consumes `getDeviceTimeStatusView(deviceId:string):Promise<DeviceTimeStatusView|null>`, `AuthContext.orgCondition`, `canAccessOrg`, `siteScopeCondition`, and `deviceScopeCondition`. Optional `deviceId` makes the same service safe for Helper's pinned-device execution. Display filters do not hide a PDC from domain metadata; authorization restrictions always apply.

- [ ] Write the failing test:

```ts
import { beforeEach,expect,it,vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { AuthContext } from '../../middleware/auth';
const m=vi.hoisted(()=>({select:vi.fn(),view:vi.fn(),queue:[] as unknown[][]}));
vi.mock('../../db',()=>({db:{select:m.select}}));
vi.mock('./view',()=>({getDeviceTimeStatusView:m.view}));
import {fleetScope,fleetTimeFiltersSchema,listFleetTimeStatus,FleetTimeForbidden} from './fleet';
const org='11111111-1111-4111-8111-111111111111',site='22222222-2222-4222-8222-222222222222';
const device='33333333-3333-4333-8333-333333333333',pdc='44444444-4444-4444-8444-444444444444';
function auth(overrides:Partial<AuthContext>={}):AuthContext {
  return {scope:'organization',orgId:org,accessibleOrgIds:[org],orgCondition:column=>eq(column,org),canAccessOrg:id=>id===org,...overrides} as AuthContext;
}
const header=(id:string)=>({deviceId:id,hostname:id===pdc?'PDC':'Member',orgId:org,orgName:'Customer',siteId:site,siteName:'Main'});
const view=(id:string)=>({deviceId:id,state:'reported',stale:false,receivedAt:'2026-09-28T12:00:00Z',collectedAt:'2026-09-28T12:00:00Z',health:'healthy',findings:[],config:null,status:null,domain:{joinType:'on_prem_ad',role:id===pdc?'pdc_emulator':'member',domainDns:'example.com',forestDns:'example.com',pdcName:'PDC'},timezone:null,recentEvents:[],enforcement:null});
beforeEach(()=>{
  m.queue=[];m.select.mockReset();m.view.mockReset().mockImplementation(async(id:string)=>view(id));
  m.select.mockImplementation(()=>{
    const rows=m.queue.shift()??[];const chain:any={then:(resolve:(value:unknown)=>unknown)=>Promise.resolve(rows).then(resolve)};
    for(const key of ['from','innerJoin','leftJoin','where','orderBy','limit','offset','groupBy'])chain[key]=vi.fn(()=>chain);
    return chain;
  });
});
it('intersects organization, site, device and explicit filters',()=>{
  const query=new PgDialect().sqlToQuery(fleetScope({siteId:site,deviceId:device},auth({allowedSiteIds:[site],allowedDeviceIds:[device]}))!);
  expect(query.params).toContain(org);expect(query.params.filter(p=>p===site)).toHaveLength(2);expect(query.params.filter(p=>p===device)).toHaveLength(2);
  expect(query.sql).toContain('"devices"."org_id"');
  expect(new PgDialect().sqlToQuery(fleetScope({},auth({allowedSiteIds:[]}))!).sql).toContain('false');
  expect(new PgDialect().sqlToQuery(fleetScope({},auth({allowedDeviceIds:[]}))!).sql).toContain('false');
  expect(()=>fleetScope({orgId:pdc},auth())).toThrow(FleetTimeForbidden);
});
it('validates vocabulary and bounded pages',()=>{
  for(const q of [{health:'bad'},{finding:'invented'},{role:'administrator'},{page:0},{limit:101},{orgId:'invalid'}])expect(fleetTimeFiltersSchema.safeParse(q).success).toBe(false);
  expect(fleetTimeFiltersSchema.parse({})).toMatchObject({page:1,limit:50});
});
it('finds a PDC beyond the filtered page',async()=>{
  m.queue.push([{total:20}],[header(device)],[{orgId:org,domainDns:'example.com',pdcExpected:true,pdcId:pdc}],[header(pdc)]);
  expect(await listFleetTimeStatus({finding:'sync_stale',role:'member',page:2,limit:1},auth())).toMatchObject({total:20,page:2,limit:1,data:[{deviceId:device}],domains:[{orgId:org,domainDns:'example.com',pdcExpected:true,pdcEnrolled:true,pdc:{deviceId:pdc}}]});
  const query=new PgDialect().sqlToQuery(m.select.mock.results[2]!.value.where.mock.calls[0][0]);
  expect(query.params).toContain(org);expect(query.params).not.toContain('sync_stale');expect(query.params).not.toContain('member');
  expect(m.view.mock.calls).toEqual([[device],[pdc]]);
});
it('keeps equal DNS names in different organizations separate',async()=>{
  const other=pdc;
  m.queue.push([{total:2}],[header(device),{...header(site),orgId:other}],
    [{orgId:org,domainDns:'example.com',pdcExpected:true,pdcId:null},{orgId:other,domainDns:'example.com',pdcExpected:true,pdcId:null}]);
  const result=await listFleetTimeStatus({},auth({scope:'partner',orgCondition:()=>undefined,canAccessOrg:()=>true}));
  expect(result.domains.map(d=>d.orgId)).toEqual([org,other]);
});
it('reports an expected missing PDC without inventing a device',async()=>{
  m.queue.push([{total:1}],[header(device)],[{orgId:org,domainDns:'example.com',pdcExpected:true,pdcId:null}]);
  expect((await listFleetTimeStatus({},auth())).domains).toEqual([{orgId:org,domainDns:'example.com',pdcExpected:true,pdcEnrolled:false,pdc:null}]);
});
it('recomputes timezone filtering from the live site mapping',()=>{
  const query=new PgDialect().sqlToQuery(fleetScope({finding:'timezone_mismatch'},auth())!);
  expect(query.sql).toContain('array_remove');expect(query.sql).toContain('IS DISTINCT FROM');expect(query.sql).toContain('"sites"."timezone"');
  expect(query.params.some(p=>typeof p==='string'&&p.includes('Eastern Standard Time'))).toBe(true);
});
it('returns an empty report with no visible devices',async()=>{
  m.queue.push([{total:0}],[]);
  expect(await listFleetTimeStatus({},auth({allowedSiteIds:[]}))).toEqual({data:[],total:0,page:1,limit:50,domains:[]});
  expect(m.view).not.toHaveBeenCalled();
});
```

- [ ] Run `cd apps/api && npx vitest run src/services/timeSync/fleet.test.ts`; expected FAIL: missing `./fleet`.
- [ ] Implement the service. Count and filtering operate in SQL; expected-zone lookup values are generated through the W01 pure resolver, and W01's view hydrates only the bounded page and PDC context rows. The current mismatch predicate mirrors spec §5.2 exactly, including `autoUpdate != on`. No policy input is consumed until W03a.

```ts
import { z } from 'zod';
import { and,asc,eq,inArray,or,sql,type SQL } from 'drizzle-orm';
import { TIME_SYNC_DOMAIN_ROLES,TIME_SYNC_FINDING_CODES,TIME_SYNC_FINDING_SEVERITY,TIME_SYNC_HEALTH } from '@breeze/shared';
import windowsZones from '../../../../../packages/shared/src/data/windowsZones.json';
import { db } from '../../db';
import { devices,organizations,sites,deviceTimeStatus } from '../../db/schema';
import type { AuthContext } from '../../middleware/auth';
import { deviceScopeCondition,siteScopeCondition } from '../aiToolsSiteScope';
import { getDeviceTimeStatusView,type DeviceTimeStatusView } from './view';
import { resolveExpectedTimezone } from './expectedTimezone';
export const fleetTimeFiltersSchema=z.object({
  health:z.enum(TIME_SYNC_HEALTH).optional(),finding:z.enum(TIME_SYNC_FINDING_CODES).optional(),
  role:z.enum(TIME_SYNC_DOMAIN_ROLES).optional(),orgId:z.string().uuid().optional(),
  siteId:z.string().uuid().optional(),deviceId:z.string().uuid().optional(),domain:z.string().min(1).max(255).optional(),
  page:z.coerce.number().int().min(1).default(1),limit:z.coerce.number().int().min(1).max(100).default(50),
}).strict();
export type FleetTimeFilters=z.input<typeof fleetTimeFiltersSchema>;
export interface FleetTimeRow {
  deviceId:string;hostname:string;orgId:string;orgName:string;siteId:string|null;siteName:string|null;view:DeviceTimeStatusView;
}
export interface FleetTimeDomain {orgId:string;domainDns:string;pdcEnrolled:boolean;pdcExpected:boolean;pdc:FleetTimeRow|null}
export interface FleetTimeResult {data:FleetTimeRow[];total:number;page:number;limit:number;domains:FleetTimeDomain[]}
export class FleetTimeForbidden extends Error {constructor(){super('Access to this organization denied');}}
const t=deviceTimeStatus;
const projection={deviceId:devices.id,hostname:devices.hostname,orgId:devices.orgId,orgName:organizations.name,siteId:devices.siteId,siteName:sites.name};
const pdcRank=sql<number>`CASE WHEN ${t.domainRole}='forest_root_pdc_emulator' THEN 0 WHEN ${t.domainRole}='pdc_emulator' THEN 1 ELSE 2 END`;
// Build the SQL lookup through the same pure resolver as ingest and the view.
// Source id/name affect provenance only; this synthetic site is never persisted.
const expectedWindowsByIana=Object.fromEntries(Object.keys(windowsZones.ianaToWindows).map(timezone=>[
  timezone,resolveExpectedTimezone({site:{id:'00000000-0000-4000-8000-000000000000',name:null,timezone}})?.windowsId??null,
]));
const expectedWindows=sql<string|null>`${JSON.stringify(expectedWindowsByIana)}::jsonb ->> ${sites.timezone}`;
export const fleetFindingCodes=sql<string[]>`array_remove(coalesce(${t.findings},'{}'::text[]),'timezone_mismatch') || CASE WHEN ${t.deviceId} IS NOT NULL AND ${expectedWindows} IS NOT NULL AND ${t.timezoneAutoUpdate}<>'on' AND ${t.timezoneWindowsId} IS DISTINCT FROM ${expectedWindows} THEN ARRAY['timezone_mismatch']::text[] ELSE '{}'::text[] END`;
const critical=TIME_SYNC_FINDING_CODES.filter(c=>TIME_SYNC_FINDING_SEVERITY[c]==='critical');
const warning=TIME_SYNC_FINDING_CODES.filter(c=>TIME_SYNC_FINDING_SEVERITY[c]==='warning');
export const fleetHealth=sql<string>`CASE WHEN ${fleetFindingCodes} && ARRAY[${sql.join(critical.map(c=>sql`${c}`),sql`, `)}]::text[] THEN 'critical' WHEN ${fleetFindingCodes} && ARRAY[${sql.join(warning.map(c=>sql`${c}`),sql`, `)}]::text[] THEN 'warning' WHEN ${t.deviceId} IS NULL OR (${t.statusMethod}='unavailable' AND cardinality(${fleetFindingCodes})=0) THEN 'unknown' ELSE 'healthy' END`;
export function fleetScope(filters:FleetTimeFilters,auth:AuthContext,displayFilters=true):SQL|undefined {
  if(filters.orgId&&!auth.canAccessOrg(filters.orgId))throw new FleetTimeForbidden();
  return and(auth.orgCondition(devices.orgId),siteScopeCondition(auth,devices.siteId),deviceScopeCondition(auth,devices.id),
    eq(devices.osType,'windows'),eq(devices.isEphemeral,false),
    filters.orgId?eq(devices.orgId,filters.orgId):undefined,
    filters.deviceId?eq(devices.id,filters.deviceId):undefined,
    displayFilters&&filters.siteId?eq(devices.siteId,filters.siteId):undefined,
    displayFilters&&filters.role?eq(t.domainRole,filters.role):undefined,
    displayFilters&&filters.domain?eq(t.domainDns,filters.domain):undefined,
    displayFilters&&filters.health?sql`${fleetHealth}=${filters.health}`:undefined,
    displayFilters&&filters.finding?sql`${filters.finding}=ANY(${fleetFindingCodes})`:undefined);
}
export function fleetRowsQuery(){
  return db.select(projection).from(devices).innerJoin(organizations,eq(organizations.id,devices.orgId))
    .leftJoin(sites,eq(sites.id,devices.siteId)).leftJoin(t,eq(t.deviceId,devices.id));
}
async function hydrate(rows:Array<Omit<FleetTimeRow,'view'>>):Promise<FleetTimeRow[]> {
  const result:FleetTimeRow[]=[];
  for(const row of rows){const view=await getDeviceTimeStatusView(row.deviceId);if(view)result.push({...row,view});}
  return result;
}
export async function listFleetTimeStatus(filters:FleetTimeFilters,auth:AuthContext):Promise<FleetTimeResult> {
  const q=fleetTimeFiltersSchema.parse(filters),where=fleetScope(q,auth);
  const [count]=await db.select({total:sql<number>`count(*)::int`}).from(devices)
    .leftJoin(t,eq(t.deviceId,devices.id)).leftJoin(sites,eq(sites.id,devices.siteId)).where(where);
  const data=await hydrate(await fleetRowsQuery().where(where)
    .orderBy(asc(devices.orgId),asc(t.domainDns),pdcRank,asc(devices.hostname),asc(devices.id))
    .limit(q.limit).offset((q.page-1)*q.limit));
  const domains:FleetTimeDomain[]=[];
  const keys=[...new Map(data.filter(r=>r.view.domain?.domainDns).map(r=>[
    `${r.orgId}:${r.view.domain!.domainDns}`,{orgId:r.orgId,domainDns:r.view.domain!.domainDns!},
  ])).values()];
  if(keys.length){
    const domainRows=await db.select({orgId:devices.orgId,domainDns:t.domainDns,
      pdcExpected:sql<boolean>`bool_or(${t.pdcName} IS NOT NULL)`,
      pdcId:sql<string|null>`(array_agg(${devices.id} ORDER BY ${pdcRank},${devices.id}) FILTER (WHERE ${t.domainRole} IN ('forest_root_pdc_emulator','pdc_emulator')))[1]`,
    }).from(devices).innerJoin(t,eq(t.deviceId,devices.id)).where(and(fleetScope(q,auth,false),
      or(...keys.map(k=>and(eq(devices.orgId,k.orgId),eq(t.domainDns,k.domainDns)))))).groupBy(devices.orgId,t.domainDns);
    const ids=domainRows.flatMap(r=>r.pdcId?[r.pdcId]:[]);
    const pdcs=ids.length?await hydrate(await fleetRowsQuery().where(and(fleetScope(q,auth,false),inArray(devices.id,ids)))):[];
    for(const row of domainRows){
      const pdc=pdcs.find(p=>p.deviceId===row.pdcId)??null;
      domains.push({orgId:row.orgId,domainDns:row.domainDns!,pdcExpected:row.pdcExpected,pdcEnrolled:pdc!==null,pdc});
    }
  }
  return {data,total:count?.total??0,page:q.page,limit:q.limit,domains};
}
```

- [ ] Rerun the fleet test; expected PASS. Task 12 adds real-DB parity against W01 `getDeviceTimeStatusView`, preventing the SQL filter from drifting from the resolver.
- [ ] Commit:

```bash
git add apps/api/src/services/timeSync/fleet.ts apps/api/src/services/timeSync/fleet.test.ts
git commit -m "feat(time-sync): query scoped fleet and domain context" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 8: Export observed current and daily evidence through authenticated routes

**Files:** Create `services/timeSync/exports.ts`, `exports.test.ts`, `routes/timeStatus.ts`, `timeStatus.test.ts`; modify `apps/api/src/index.ts:27,850`. Shared CSV escaping is `services/spreadsheetExport.ts:8–15`. Request-context lifetime APIs are `db/index.ts:746,1049,1065`.

**Interfaces:** Produces `exportCurrentTimeCsv(filters,auth):AsyncGenerator<string>`, `exportHistoryTimeCsv(filters,{from,to},auth):AsyncGenerator<string>`, `historyTimeQuerySchema`, and `timeStatusRoutes`. Consumes Task 7 DTOs and scope. Routes: `GET /api/v1/time-status`, `/export`, `/history/export?from&to`; permission `devices:read`. CSV's first line is exactly the spec text below. History selects the current filtered device population, then emits each requested UTC date; it does not filter historical rows by today's findings.

- [ ] Write the failing export test:

```ts
import { afterEach,beforeEach,expect,it,vi } from 'vitest';
import type { AuthContext } from '../../middleware/auth';
const m=vi.hoisted(()=>({list:vi.fn(),where:vi.fn()}));
vi.mock('../../db',()=>({db:{select:()=>({from:()=>({innerJoin:()=>({where:m.where})})})}}));
vi.mock('./fleet',async original=>({...await original<typeof import('./fleet')>(),listFleetTimeStatus:m.list}));
import { evidenceDays,exportCurrentTimeCsv,exportHistoryTimeCsv,historyTimeQuerySchema,TIME_EVIDENCE_HEADER } from './exports';
const org='11111111-1111-4111-8111-111111111111',device='22222222-2222-4222-8222-222222222222';
const auth={orgCondition:()=>undefined,canAccessOrg:()=>true} as unknown as AuthContext;
const row={deviceId:device,hostname:'=SUM(1,2)',orgId:org,orgName:'Customer',siteId:null,siteName:null,
  view:{state:'not_reported',health:'unknown',stale:false,receivedAt:null,collectedAt:null,findings:[],domain:null,status:null,config:null,timezone:null}};
async function collect(generator:AsyncGenerator<string>){let text='';for await(const chunk of generator)text+=chunk;return text;}
beforeEach(()=>{vi.useFakeTimers();vi.setSystemTime(new Date('2026-09-28T12:00:00Z'));m.list.mockReset().mockResolvedValue({data:[row],total:1,page:1,limit:100,domains:[]});m.where.mockReset().mockResolvedValue([]);});
afterEach(()=>vi.useRealTimers());
it('accepts 400 inclusive UTC dates; rejects invalid, inverted, expired, future or 401-day ranges',()=>{
  expect(historyTimeQuerySchema.safeParse({from:'2025-08-25',to:'2026-09-28'}).success).toBe(true);
  for(const range of [{from:'2025-08-24',to:'2026-09-28'},{from:'2026-09-29',to:'2026-09-29'},{from:'2026-09-28',to:'2026-09-27'},{from:'2026-02-30',to:'2026-09-28'},{from:'2025-08-23',to:'2025-08-23'}])expect(historyTimeQuerySchema.safeParse(range).success).toBe(false);
  expect(evidenceDays('2026-09-27','2026-09-28')).toEqual(['2026-09-27','2026-09-28']);
});
it('states observation limits and neutralizes spreadsheet formulas',async()=>{
  const text=await collect(exportCurrentTimeCsv({},auth));expect(text.split('\r\n')[0]).toBe(TIME_EVIDENCE_HEADER);
  expect(text).toContain(`"'=SUM(1,2)"`);expect(text).toContain('"not_reported"');
});
it('lists gaps and preserves historical timezone and source',async()=>{
  m.where.mockResolvedValue([{row:{deviceId:device,day:'2026-09-28',worstHealth:'warning',findingCodes:['sync_stale'],source:'time.example.com',sourceKind:'ntp_peer',syncType:'NTP',lastSuccessfulSyncAt:new Date('2026-09-28T01:00:00Z'),snapshotCount:4,expectedTimezone:'America/New_York',timezoneWindowsId:'Eastern Standard Time'}}]);
  const text=await collect(exportHistoryTimeCsv({orgId:org},{from:'2026-09-27',to:'2026-09-28'},auth));
  expect(text).toContain('"2026-09-27","gap"');expect(text).toContain('"2026-09-28","observed","warning","sync_stale"');
  expect(text).toContain('America/New_York');expect(text).toContain('Eastern Standard Time');
});
it('exports all pages rather than the currently displayed page',async()=>{
  m.list.mockResolvedValueOnce({data:[row],total:101,limit:100}).mockResolvedValueOnce({data:[{...row,deviceId:org}],total:101,limit:100});
  const text=await collect(exportCurrentTimeCsv({page:8,limit:1},auth));
  expect(m.list.mock.calls.map(call=>call[0].page)).toEqual([1,2]);expect(text).toContain(`"${device}"`);
});
it('does not invent devices or gaps for an empty accessible fleet',async()=>{
  m.list.mockResolvedValue({data:[],total:0,page:1,limit:100,domains:[]});
  const text=await collect(exportHistoryTimeCsv({},{from:'2026-09-28',to:'2026-09-28'},auth));
  expect(text.trim().split('\r\n')).toHaveLength(2);expect(m.where).not.toHaveBeenCalled();
});
```

- [ ] Run `cd apps/api && npx vitest run src/services/timeSync/exports.test.ts`; expected FAIL missing module.
- [ ] Create `exports.ts`:

```ts
import { z } from 'zod';
import { and,eq,gte,inArray,lte } from 'drizzle-orm';
import { db } from '../../db';
import { deviceTimeDaily,devices } from '../../db/schema';
import type { AuthContext } from '../../middleware/auth';
import { csvRow } from '../spreadsheetExport';
import { deviceScopeCondition,siteScopeCondition } from '../aiToolsSiteScope';
import { fleetTimeFiltersSchema,listFleetTimeStatus,type FleetTimeFilters } from './fleet';
export const TIME_EVIDENCE_HEADER='Observed synchronization reported by the Breeze agent; days without a report are listed as gaps.';
const DAY_MS=86_400_000;
const daySchema=z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value=>{
  const date=new Date(`${value}T00:00:00Z`);return Number.isFinite(date.getTime())&&date.toISOString().slice(0,10)===value;
},'Invalid UTC date');
export const historyTimeQuerySchema=fleetTimeFiltersSchema.extend({from:daySchema,to:daySchema}).superRefine((q,ctx)=>{
  const from=Date.parse(`${q.from}T00:00:00Z`),to=Date.parse(`${q.to}T00:00:00Z`);
  const today=Date.parse(`${new Date().toISOString().slice(0,10)}T00:00:00Z`);
  if(to<from||to-from>399*DAY_MS||from<today-400*DAY_MS||to>today)
    ctx.addIssue({code:'custom',path:['from'],message:'Choose 1–400 UTC days within the retained window, ending no later than today'});
});
export function evidenceDays(from:string,to:string):string[]{
  const result:string[]=[];
  for(let time=Date.parse(`${from}T00:00:00Z`);time<=Date.parse(`${to}T00:00:00Z`);time+=DAY_MS)result.push(new Date(time).toISOString().slice(0,10));
  return result;
}
export async function* exportCurrentTimeCsv(filters:FleetTimeFilters,auth:AuthContext):AsyncGenerator<string>{
  yield `${TIME_EVIDENCE_HEADER}\r\n${csvRow(['device_id','hostname','org_id','organization','site','state','health','stale','received_at','collected_at','finding_codes','domain_dns','domain_role','source','source_kind','sync_type','last_successful_sync_at','expected_timezone','timezone_windows_id'])}\r\n`;
  for(let page=1;;page++){
    const result=await listFleetTimeStatus({...filters,page,limit:100},auth);if(!result.data.length)break;
    yield result.data.map(r=>{const v=r.view;return csvRow([r.deviceId,r.hostname,r.orgId,r.orgName,r.siteName,v.state,v.health,v.stale,v.receivedAt,v.collectedAt,v.findings.map(f=>f.code).join(';'),v.domain?.domainDns,v.domain?.role,v.status?.source,v.status?.sourceKind,v.config?.syncType,v.status?.lastSuccessfulSyncAt,v.timezone?.expected?.iana,v.timezone?.windowsId]);}).join('\r\n')+'\r\n';
    if(page*result.limit>=result.total)break;
  }
}
export async function* exportHistoryTimeCsv(filters:FleetTimeFilters,range:{from:string;to:string},auth:AuthContext):AsyncGenerator<string>{
  const q=historyTimeQuerySchema.parse({...filters,...range}),days=evidenceDays(q.from,q.to);
  yield `${TIME_EVIDENCE_HEADER}\r\n${csvRow(['device_id','hostname','org_id','organization','site','day','evidence_state','worst_health','finding_codes','source','source_kind','sync_type','last_successful_sync_at','snapshot_count','expected_timezone','timezone_windows_id'])}\r\n`;
  for(let page=1;;page++){
    const result=await listFleetTimeStatus({...filters,page,limit:100},auth);if(!result.data.length)break;
    const daily=await db.select({row:deviceTimeDaily}).from(deviceTimeDaily).innerJoin(devices,eq(devices.id,deviceTimeDaily.deviceId))
      .where(and(auth.orgCondition(deviceTimeDaily.orgId),siteScopeCondition(auth,devices.siteId),deviceScopeCondition(auth,devices.id),
        inArray(deviceTimeDaily.deviceId,result.data.map(r=>r.deviceId)),gte(deviceTimeDaily.day,q.from),lte(deviceTimeDaily.day,q.to)));
    const byKey=new Map(daily.map(({row})=>[`${row.deviceId}:${row.day}`,row])),lines:string[]=[];
    for(const device of result.data)for(const day of days){
      const row=byKey.get(`${device.deviceId}:${day}`);
      lines.push(csvRow([device.deviceId,device.hostname,device.orgId,device.orgName,device.siteName,day,row?'observed':'gap',
        row?.worstHealth,row?.findingCodes.join(';'),row?.source,row?.sourceKind,row?.syncType,row?.lastSuccessfulSyncAt?.toISOString(),
        row?.snapshotCount??0,row?.expectedTimezone,row?.timezoneWindowsId]));
    }
    yield lines.join('\r\n')+'\r\n';if(page*result.limit>=result.total)break;
  }
}
```

The retention predicate keeps the boundary date `today-400`; the range validator permits that date but still caps each export at 400 inclusive dates. It does not silently change the specified retention SQL. Each streamed chunk holds at most 100 devices × 400 dates; exports are live observations, not a transactionally frozen fleet snapshot.

- [ ] Write route tests before mounting the routes:

```ts
// routes/timeStatus.test.ts
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {Hono} from 'hono';
const m=vi.hoisted(()=>({authorized:true,permitted:true,list:vi.fn(),current:vi.fn(),history:vi.fn(),context:vi.fn(),org:'11111111-1111-4111-8111-111111111111'}));
vi.mock('../middleware/auth',()=>({
  authMiddleware:async(c:any,next:any)=>{if(!m.authorized)return c.json({error:'Unauthorized'},401);c.set('auth',{scope:'organization',orgId:m.org,orgCondition:()=>undefined,canAccessOrg:(id:string)=>id===m.org});await next();},
  requireScope:()=>async(_c:any,next:any)=>next(),requirePermission:()=>async(c:any,next:any)=>m.permitted?next():c.json({error:'Forbidden'},403),
}));
vi.mock('../db',()=>({db:{select:vi.fn()},getCurrentDbAccessContext:()=>({scope:'organization',orgId:m.org}),runOutsideDbContext:(fn:any)=>fn(),withDbAccessContext:m.context}));
vi.mock('../services/timeSync/fleet',async original=>({...await original<typeof import('../services/timeSync/fleet')>(),listFleetTimeStatus:m.list}));
vi.mock('../services/timeSync/exports',async original=>({...await original<typeof import('../services/timeSync/exports')>(),exportCurrentTimeCsv:m.current,exportHistoryTimeCsv:m.history}));
import {timeStatusRoutes} from './timeStatus';
const app=new Hono().route('/time-status',timeStatusRoutes);
beforeEach(()=>{
  vi.useFakeTimers();vi.setSystemTime(new Date('2026-09-28T12:00:00Z'));m.authorized=true;m.permitted=true;
  m.list.mockReset().mockResolvedValue({data:[],total:0,page:1,limit:50,domains:[]});m.context.mockReset().mockImplementation(async(_context:any,fn:any)=>fn());
  m.current.mockReset().mockImplementation(async function*(){yield 'current\r\n';});m.history.mockReset().mockImplementation(async function*(){yield 'history\r\n';});
});
afterEach(()=>vi.useRealTimers());
it('requires authentication and device read for all three routes',async()=>{
  for(const path of ['/time-status','/time-status/export','/time-status/history/export?from=2026-09-28&to=2026-09-28']){
    m.authorized=false;expect((await app.request(path)).status).toBe(401);m.authorized=true;m.permitted=false;expect((await app.request(path)).status).toBe(403);m.permitted=true;
  }
  expect(m.list).not.toHaveBeenCalled();expect(m.current).not.toHaveBeenCalled();expect(m.history).not.toHaveBeenCalled();
});
it('returns a paginated result and rejects invalid filters',async()=>{
  expect((await app.request('/time-status?finding=sync_stale&role=member&page=2&limit=10')).status).toBe(200);
  expect(m.list.mock.calls[0]![0]).toMatchObject({finding:'sync_stale',role:'member',page:2,limit:10});
  expect(m.list.mock.calls[0]![1]).toMatchObject({scope:'organization',orgId:m.org});
  for(const query of ['limit=101','page=0','finding=bad','orgId=invalid','role=bad'])expect((await app.request(`/time-status?${query}`)).status).toBe(400);
});
it('denies foreign organization exports before creating the iterator',async()=>{
  expect((await app.request('/time-status/export?orgId=22222222-2222-4222-8222-222222222222')).status).toBe(403);expect(m.current).not.toHaveBeenCalled();
});
it('streams both exports inside fresh caller contexts',async()=>{
  for(const [path,text,file] of [['/time-status/export','current\r\n','time-status.csv'],['/time-status/history/export?from=2026-09-27&to=2026-09-28','history\r\n','time-status-history.csv']]){
    const response=await app.request(path!);expect(response.status).toBe(200);expect(response.headers.get('Content-Type')).toContain('text/csv');expect(response.headers.get('Content-Disposition')).toContain(file!);expect(await response.text()).toBe(text);
  }
  expect(m.context).toHaveBeenCalled();for(const [context] of m.context.mock.calls)expect(context).toEqual({scope:'organization',orgId:m.org});
});
it('rejects missing dates and overlong/future ranges',async()=>{
  for(const query of ['','?from=2026-09-28','?from=2025-08-24&to=2026-09-28','?from=2026-09-29&to=2026-09-29'])expect((await app.request(`/time-status/history/export${query}`)).status).toBe(400);
  expect(m.history).not.toHaveBeenCalled();
});
it('surfaces a service error as HTTP 500',async()=>{
  const log=vi.spyOn(console,'error').mockImplementation(()=>{});m.list.mockRejectedValueOnce(new Error('database unavailable'));
  const response=await app.request('/time-status');expect(response.status).toBe(500);expect(await response.json()).toEqual({error:'Failed to read time synchronization data'});log.mockRestore();
});
```

- [ ] Run `cd apps/api && npx vitest run src/routes/timeStatus.test.ts`; expected FAIL missing routes module.
- [ ] Create the route module:

```ts
import { Hono,type Context } from 'hono';
import { zValidator } from '../lib/validation';
import { authMiddleware,requirePermission,requireScope } from '../middleware/auth';
import { PERMISSIONS } from '../services/permissions';
import { getCurrentDbAccessContext,runOutsideDbContext,withDbAccessContext } from '../db';
import { fleetScope,fleetTimeFiltersSchema,listFleetTimeStatus,FleetTimeForbidden } from '../services/timeSync/fleet';
import { exportCurrentTimeCsv,exportHistoryTimeCsv,historyTimeQuerySchema } from '../services/timeSync/exports';
export const timeStatusRoutes=new Hono();
timeStatusRoutes.use('*',authMiddleware,requireScope('organization','partner','system'),requirePermission(PERMISSIONS.DEVICES_READ.resource,PERMISSIONS.DEVICES_READ.action));
timeStatusRoutes.onError((error,c)=>{
  if(error instanceof FleetTimeForbidden)return c.json({error:error.message},403);
  console.error('[time-status] request failed',error);return c.json({error:'Failed to read time synchronization data'},500);
});
function csvResponse(c:Context,iterator:AsyncGenerator<string>,filename:string):Response {
  const context=getCurrentDbAccessContext();if(!context)throw new Error('Time export requires a database access context');
  const encoder=new TextEncoder();let cancelled=false;
  const body=new ReadableStream<Uint8Array>({
    async pull(controller){
      try{
        const next=await runOutsideDbContext(()=>withDbAccessContext(context,()=>iterator.next()));
        if(cancelled)return;
        if(next.done){controller.close();return;}controller.enqueue(encoder.encode(next.value));
      }catch(error){if(!cancelled)controller.error(error);await iterator.return(undefined);}
    },
    async cancel(){cancelled=true;await iterator.return(undefined);},
  });
  return c.newResponse(body,200,{'Content-Type':'text/csv; charset=utf-8','Content-Disposition':`attachment; filename="${filename}"`,'Cache-Control':'no-store'});
}
timeStatusRoutes.get('/',zValidator('query',fleetTimeFiltersSchema),async c=>c.json(await listFleetTimeStatus(c.req.valid('query'),c.get('auth'))));
timeStatusRoutes.get('/export',zValidator('query',fleetTimeFiltersSchema),c=>{
  const q=c.req.valid('query'),auth=c.get('auth');fleetScope(q,auth);
  return csvResponse(c,exportCurrentTimeCsv(q,auth),'time-status.csv');
});
timeStatusRoutes.get('/history/export',zValidator('query',historyTimeQuerySchema),c=>{
  const {from,to,...filters}=c.req.valid('query'),auth=c.get('auth');fleetScope(filters,auth);
  return csvResponse(c,exportHistoryTimeCsv(filters,{from,to},auth),'time-status-history.csv');
});
```

The generator is resumed in a fresh caller context per chunk because the original auth middleware transaction can finish before the response body is consumed. No system-context escalation is used. Errors after headers abort the stream; the web awaits the complete blob and reports failure instead of downloading partial data.

Replace `index.ts:27` anchor `import { deviceRoutes } from './routes/devices';` with itself followed by `import { timeStatusRoutes } from './routes/timeStatus';`. Replace line 850 `api.route('/devices', deviceRoutes);` with itself followed by `api.route('/time-status', timeStatusRoutes);`.

- [ ] Run `cd apps/api && npx vitest run src/services/timeSync/exports.test.ts src/routes/timeStatus.test.ts`; expected PASS.
- [ ] Commit:

```bash
git add apps/api/src/services/timeSync/exports.ts apps/api/src/services/timeSync/exports.test.ts apps/api/src/routes/timeStatus.ts apps/api/src/routes/timeStatus.test.ts apps/api/src/index.ts
git commit -m "feat(time-sync): export scoped current and daily evidence" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 9: Expose the fleet tool on every approved AI and MCP surface

**Files:** Modify `services/aiToolsDevice.ts:32,320`, `aiToolSchemas.ts:217`, `aiGuardrails.ts:831`, `aiAgentSdkTools.ts:177,1570–1575`, `aiTools.ts:516`, `helperToolFilter.ts:24`, `scriptBuilderTools.ts:46,312–317`, `mcpCoverage.ts:574`, `mcpGuidance.ts:56,59`; `aiAgents/agentToolCatalog.ts:310`, `analysisProfile.ts:31`, `designProfile.ts:24`, `patchProfile.ts:28`, `sweepProfile.ts:36`, `verdictProfile.ts:23`; `apps/web/src/components/ai-risk/tierConfig.ts:66,484`; corresponding test sites `helperToolFilter.test.ts:32,36`, `aiGuardrails.agentPrincipal.contract.test.ts:208`, `aiAgents/runLoop.test.ts:2750,2771`, `llm/toolCapture/surfaces.test.ts:16,20`. Create `aiToolsDevice.timeSync.test.ts`, `aiToolsDevice.timeSync.registry.test.ts`.

**Interfaces:** Produces `list_time_sync_issues`, tier `1`, domain `devices`, permission `devices:read`, `deviceArgs:['deviceId']`; schema is Task 7 `fleetTimeFiltersSchema`. Handler returns `JSON.stringify(FleetTimeResult)`. Helper forcibly injects its own `deviceId`, intersecting the complete list and domain context scope. MCP route coverage is `'timeStatus.ts': {tools:['list_time_sync_issues']}`.

- [ ] Write complete execution and registry tests:

```ts
// services/aiToolsDevice.timeSync.test.ts
import { expect,it,vi } from 'vitest';
const m=vi.hoisted(()=>({list:vi.fn()}));
vi.mock('../db',()=>({db:{select:vi.fn(),insert:vi.fn(),update:vi.fn(),delete:vi.fn(),execute:vi.fn()},runOutsideDbContext:(fn:any)=>fn(),withSystemDbAccessContext:(fn:any)=>fn(),withDbAccessContext:(_ctx:any,fn:any)=>fn()}));
vi.mock('./brainDeviceContext',()=>({getActiveDeviceContext:vi.fn(),getAllDeviceContext:vi.fn(),createDeviceContext:vi.fn(),resolveDeviceContext:vi.fn()}));
vi.mock('./aiTools',()=>({verifyDeviceAccess:vi.fn()}));
vi.mock('./timeSync/fleet',async original=>({...await original<typeof import('./timeSync/fleet')>(),listFleetTimeStatus:m.list}));
import { registerDeviceTools } from './aiToolsDevice';
import type { AiTool } from './aiTools';
import type { AuthContext } from '../middleware/auth';
it('uses the shared bounded query and the exact caller authorization',async()=>{
  const tools=new Map<string,AiTool>();registerDeviceTools(tools);const tool=tools.get('list_time_sync_issues')!;
  const auth={scope:'organization'} as AuthContext;
  const value={data:[],total:0,page:1,limit:50,domains:[]};m.list.mockResolvedValue(value);
  expect(JSON.parse(await tool.handler({finding:'sync_stale',role:'member',domain:'example.com'},auth))).toEqual(value);
  expect(m.list).toHaveBeenCalledWith({finding:'sync_stale',role:'member',domain:'example.com',page:1,limit:50},auth);
  m.list.mockRejectedValueOnce(new Error('database unavailable'));
  await expect(tool.handler({},auth)).rejects.toThrow('database unavailable');
});
```

```ts
// services/aiToolsDevice.timeSync.registry.test.ts
import {expect,it} from 'vitest';
import {aiTools,HELPER_TOOL_SCOPING,applyHelperDeviceScope} from './aiTools';
import {toolInputSchemas} from './aiToolSchemas';
import {TOOL_PERMISSIONS,checkGuardrails} from './aiGuardrails';
import {TOOL_TIERS,buildBreezeSdkTools} from './aiAgentSdkTools';
import {SCRIPT_BUILDER_TOOL_TIERS,buildScriptBuilderTools} from './scriptBuilderTools';
import {getHelperAllowedTools} from './helperToolFilter';
import {TOOL_CAPABILITY} from './aiAgents/agentToolCatalog';
import {ANALYSIS_TOOL_ALLOWLIST} from './aiAgents/analysisProfile';
import {SWEEP_TOOL_ALLOWLIST} from './aiAgents/sweepProfile';
import {VERDICT_TOOL_ALLOWLIST} from './aiAgents/verdictProfile';
import {DESIGN_TOOL_ALLOWLIST} from './aiAgents/designProfile';
import {PATCH_TOOL_ALLOWLIST} from './aiAgents/patchProfile';
import {MCP_PROMPTS} from './mcpGuidance';
const name='list_time_sync_issues',deviceId='11111111-1111-4111-8111-111111111111';
it('registers validated tier-one reads on every execution surface',()=>{
  expect(aiTools.get(name)).toMatchObject({tier:1,domain:'devices',deviceArgs:['deviceId']});
  expect(TOOL_TIERS[name]).toBe(1);expect(checkGuardrails(name,{}).tier).toBe(1);expect(TOOL_PERMISSIONS[name]).toEqual({resource:'devices',action:'read'});
  const schema=toolInputSchemas[name]!;expect(schema.safeParse({}).success).toBe(true);
  expect(schema.safeParse({deviceId,finding:'sync_stale',role:'member',domain:'example.com',page:2,limit:100}).success).toBe(true);
  for(const input of [{deviceId:'invalid'},{finding:'invented'},{role:'admin'},{page:0},{limit:101}])expect(schema.safeParse(input).success).toBe(false);
  const auth=()=>{throw new Error('Declaration inspection cannot execute handlers');};
  for(const tools of [buildBreezeSdkTools(auth),buildScriptBuilderTools(auth)]){
    const tool=tools.find(t=>t.name===name);expect(tool).toBeDefined();expect(typeof tool!.handler).toBe('function');
    expect(Object.keys(tool!.inputSchema).sort()).toEqual(['deviceId','domain','finding','health','limit','orgId','page','role','siteId']);
  }
  expect(SCRIPT_BUILDER_TOOL_TIERS[name]).toBe(1);
});
it('pins Helper enumeration and domain context to its own device',()=>{
  expect(getHelperAllowedTools('basic')).toContain(name);expect(HELPER_TOOL_SCOPING[name]).toBe('deviceId');
  expect(applyHelperDeviceScope(name,{deviceId:'other',role:'member'},deviceId)).toEqual({input:{deviceId,role:'member'}});
  for(const list of [ANALYSIS_TOOL_ALLOWLIST,SWEEP_TOOL_ALLOWLIST,VERDICT_TOOL_ALLOWLIST,DESIGN_TOOL_ALLOWLIST,PATCH_TOOL_ALLOWLIST])expect(list).toContain(name);
  expect(TOOL_CAPABILITY[name]).toBe('automations_reports');
  expect(MCP_PROMPTS.find(p=>p.name==='breeze-device-investigate')!.referencedTools).toContain(name);
});
```

- [ ] Run `cd apps/api && npx vitest run src/services/aiToolsDevice.timeSync.test.ts src/services/aiToolsDevice.timeSync.registry.test.ts`. Expected FAIL: missing registered tool/schema/tier.
- [ ] Add shared constants and fleet imports to `aiToolsDevice.ts` beside line 32:

```ts
import { TIME_SYNC_DOMAIN_ROLES,TIME_SYNC_FINDING_CODES,TIME_SYNC_HEALTH } from '@breeze/shared';
import { fleetTimeFiltersSchema,listFleetTimeStatus } from './timeSync/fleet';
```

Insert this registration immediately before the existing `get_device_hardware_health` block at 320:

```ts
registerTool({
  tier:1,domain:'devices',deviceArgs:['deviceId'],
  searchHint:'time synchronization, NTP source, domain PDC, time service findings, timezone mismatch',
  definition:{
    name:'list_time_sync_issues',
    description:'List current observed time synchronization status in the accessible Windows fleet. Filter by finding, role, domain, health, organization or site. Page and limit bound the result. Domain PDC context respects caller access. Optional deviceId restricts the whole result, including domain context, to one device.',
    input_schema:{type:'object' as const,properties:{
      health:{type:'string',enum:[...TIME_SYNC_HEALTH]},finding:{type:'string',enum:[...TIME_SYNC_FINDING_CODES]},
      role:{type:'string',enum:[...TIME_SYNC_DOMAIN_ROLES]},orgId:{type:'string',format:'uuid'},siteId:{type:'string',format:'uuid'},
      deviceId:{type:'string',format:'uuid'},domain:{type:'string',minLength:1,maxLength:255},
      page:{type:'integer',minimum:1,default:1},limit:{type:'integer',minimum:1,maximum:100,default:50},
    }},
  },
  handler:async(input,auth)=>JSON.stringify(await listFleetTimeStatus(fleetTimeFiltersSchema.parse(input),auth)),
});
```

- [ ] Apply the exact data-registration edits below. Each listed line's hardware entry remains in place; the appended entry is the full replacement addition. This script handles the complete lists, including prefixed tool names in agent tests.

```python
from pathlib import Path
name='list_time_sync_issues'
# Each anchor below exists exactly once in its named registry (verified lines in Files).
entries={
 'aiGuardrails.ts':("  get_device_hardware_health: { resource: 'devices', action: 'read' },", "  list_time_sync_issues: { resource: 'devices', action: 'read' },"),
 'aiAgentSdkTools.ts':('  get_device_hardware_health: 1,','  list_time_sync_issues: 1,'),
 'scriptBuilderTools.ts':('  get_device_hardware_health: 1,','  list_time_sync_issues: 1,'),
 'aiTools.ts':("  get_device_hardware_health: 'deviceId',","  list_time_sync_issues: 'deviceId',"),
 'helperToolFilter.ts':("  'get_device_hardware_health',","  'list_time_sync_issues',"),
 'aiAgents/agentToolCatalog.ts':("  get_device_hardware_health: 'automations_reports',","  list_time_sync_issues: 'automations_reports',"),
 'mcpCoverage.ts':("  'tickets/tickets.ts': { tools: ['manage_tickets'] },","  'timeStatus.ts': { tools: ['list_time_sync_issues'] },"),
}
root=Path('apps/api/src/services')
for file,(old,addition) in entries.items():
 p=root/file;s=p.read_text();assert s.count(old)==1,(file,old);p.write_text(s.replace(old,old+'\n'+addition,1))
for file in ['aiAgents/analysisProfile.ts','aiAgents/designProfile.ts','aiAgents/patchProfile.ts','aiAgents/sweepProfile.ts','aiAgents/verdictProfile.ts',
             'helperToolFilter.test.ts','aiAgents/runLoop.test.ts']:
 p=root/file;s=p.read_text()
 s=s.replace("'get_device_hardware_health',", "'get_device_hardware_health', 'list_time_sync_issues',")
 s=s.replace("'mcp__breeze__get_device_hardware_health',", "'mcp__breeze__get_device_hardware_health', 'mcp__breeze__list_time_sync_issues',")
 s=s.replace('the 9 read-only device-scoped tools','the read-only device-scoped tools')
 p.write_text(s)
p=root/'aiGuardrails.agentPrincipal.contract.test.ts';s=p.read_text()
a="  'list_time_entries', // A-W06 Tier-1 read"
assert s.count(a)==1
s=s.replace(a,a+"\n  'list_time_sync_issues',",1);p.write_text(s)
p=root/'mcpGuidance.ts';s=p.read_text()
s=s.replace("'get_device_hardware_health',", "'get_device_hardware_health', 'list_time_sync_issues',",1)
anchor='never guess a cause the tool output doesn\'t support.'
assert anchor in s
s=s.replace(anchor,anchor+' For time findings, call list_time_sync_issues with the resolved deviceId; use its domain context only within the caller\'s scope.',1);p.write_text(s)
p=Path('apps/web/src/components/ai-risk/tierConfig.ts');s=p.read_text()
a="      { name: 'get_device_hardware_health', description: 'Get RAID, disk and hardware collector health', category: 'Devices & Hardware' },"
s=s.replace(a,a+"\n      { name: 'list_time_sync_issues', description: 'List observed time synchronization findings', category: 'Devices & Hardware' },",1)
a="  get_device_hardware_health: 'devices.read',";s=s.replace(a,a+"\n  list_time_sync_issues: 'devices.read',",1);p.write_text(s)
p=root/'llm/toolCapture/surfaces.test.ts';s=p.read_text()
s=s.replace(' (basic = 9 tools)','').replace(' (basic = 10 tools)','')
import re
s=re.sub(r"expect\(CAPTURE_SURFACES\['helper-basic'\]\.allowedTools\)\.toHaveLength\(\d+\);",
         "expect(CAPTURE_SURFACES['helper-basic'].allowedTools).toContain('mcp__breeze__list_time_sync_issues');",s)
p.write_text(s)
```

In `aiToolSchemas.ts`, add `import { fleetTimeFiltersSchema } from './timeSync/fleet';` and immediately before the `get_device_hardware_health:` schema at 217 insert:

```ts
list_time_sync_issues: fleetTimeFiltersSchema,
```

In `aiAgentSdkTools.ts`, immediately after the complete hardware `tool(...)` entry at 1570–1575 insert:

```ts
tool('list_time_sync_issues',registryDescription('list_time_sync_issues'),inputShape('list_time_sync_issues'),
  makeHandler('list_time_sync_issues',getAuth,onPreToolUse,onPostToolUse)),
```

`inputShape` already exists at `aiAgentSdkTools.ts:630`; do not create another schema conversion function. In `scriptBuilderTools.ts`, add the same fleet schema import; after its hardware `tool(...)` entry at 312–317 insert:

```ts
tool('list_time_sync_issues','List observed time synchronization findings in the accessible fleet.',fleetTimeFiltersSchema.shape,
  makeExistingHandler('list_time_sync_issues',getAuth,onPreToolUse,onPostToolUse)),
```

- [ ] Run `cd apps/api && npx vitest run src/services/aiToolsDevice.timeSync.test.ts src/services/aiToolsDevice.timeSync.registry.test.ts src/services/helperToolFilter.test.ts src/services/aiGuardrails.agentPrincipal.contract.test.ts src/services/llm/toolCapture/surfaces.test.ts src/services/aiAgents/runLoop.test.ts src/services/aiAgentSdkTools.mcpCoverage.test.ts`; expected PASS. Run `rg -n 'get_device_hardware_health|list_time_sync_issues' apps/api/src/services apps/web/src/components/ai-risk/tierConfig.ts` and check the exact sites above; hardware-specific execution tests remain hardware-specific.
- [ ] Commit:

```bash
git add apps/api/src/services/aiToolsDevice.ts apps/api/src/services/aiToolsDevice.timeSync.test.ts apps/api/src/services/aiToolsDevice.timeSync.registry.test.ts apps/api/src/services/aiToolSchemas.ts apps/api/src/services/aiGuardrails.ts apps/api/src/services/aiAgentSdkTools.ts apps/api/src/services/aiTools.ts apps/api/src/services/helperToolFilter.ts apps/api/src/services/scriptBuilderTools.ts apps/api/src/services/mcpCoverage.ts apps/api/src/services/mcpGuidance.ts apps/api/src/services/aiAgents/{agentToolCatalog,analysisProfile,designProfile,patchProfile,sweepProfile,verdictProfile}.ts apps/api/src/services/helperToolFilter.test.ts apps/api/src/services/aiGuardrails.agentPrincipal.contract.test.ts apps/api/src/services/aiAgents/runLoop.test.ts apps/api/src/services/llm/toolCapture/surfaces.test.ts apps/web/src/components/ai-risk/tierConfig.ts
git commit -m "feat(ai): expose scoped time synchronization findings" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 10: Build the fleet report, domain view, hash state and downloads

**Files:** Create `apps/web/src/components/devices/time/fleetTypes.ts`, `fleetState.ts`, `fleetState.test.ts`, `FleetTimeSyncReport.tsx`, `DomainGroupView.tsx`, `FleetTimeSyncReport.test.tsx`, `apps/web/src/pages/devices/time.astro`; modify `components/layout/Sidebar.tsx:366` and all eight locale `devices.json` root objects, `common.json:15`, `pages.json:2`. Existing reusable APIs: `lib/useHashState.ts:47–70`, `lib/downloadBlob.ts:10`, `lib/fetchAllSites.ts:27`, `stores/orgStore.ts:141`; W01 web view type is index §I.

**Interfaces:** Consumes Task 7 `FleetTimeResult` JSON and W01 `DeviceTimeStatusView` mirrored in `time/types.ts`. Produces `FleetTimeSyncReport():JSX.Element`, `DomainGroupView({result}:{result:FleetTimeResult})`, and `readFleetHash(raw:string):FleetState`. API request query strings are transport filters; browser UI state is exclusively `window.location.hash`. Global selected organization remains the outer scope; page organization filtering is available in All-organizations mode.

- [ ] Create these tests first:

```ts
// components/devices/time/fleetState.test.ts
import {expect,it} from 'vitest';
import {readFleetHash,fleetQuery,INITIAL_FLEET_STATE} from './fleetState';
it('round-trips view, filters and page without query-string UI state',()=>{
  const state=readFleetHash('view=domain&health=warning&finding=sync_stale&role=member&orgId=11111111-1111-4111-8111-111111111111&page=2');
  expect(state).toMatchObject({view:'domain',health:'warning',finding:'sync_stale',role:'member',page:2});
  expect(fleetQuery(state,null).get('finding')).toBe('sync_stale');expect(fleetQuery(state,null).has('view')).toBe(false);
});
it('rejects invalid vocabularies, inherited keys, UUIDs and pages',()=>{
  expect(readFleetHash('view=toString&health=bad&finding=bad&role=bad&orgId=bad&siteId=bad&page=-2')).toEqual(INITIAL_FLEET_STATE);
  expect(readFleetHash('page=1.5').page).toBe(1);
});
it('intersects page filtering with the global organization selection',()=>{
  const state=readFleetHash('orgId=11111111-1111-4111-8111-111111111111');
  expect(fleetQuery(state,'22222222-2222-4222-8222-222222222222').get('orgId')).toBe('22222222-2222-4222-8222-222222222222');
});
```

```tsx
// components/devices/time/FleetTimeSyncReport.test.tsx
import '@/lib/i18n';
import {beforeEach,expect,it,vi} from 'vitest';
import {fireEvent,render,screen,waitFor} from '@testing-library/react';
import FleetTimeSyncReport from './FleetTimeSyncReport';
import DomainGroupView from './DomainGroupView';
import type {FleetTimeResult,FleetTimeRow} from './fleetTypes';
const m=vi.hoisted(()=>({fetch:vi.fn(),download:vi.fn(),sites:vi.fn(),currentOrgId:null as string|null}));
vi.mock('../../../stores/auth',()=>({fetchWithAuth:m.fetch,registerOrgIdProvider:vi.fn()}));
vi.mock('../../../lib/downloadBlob',()=>({downloadBlob:m.download}));
vi.mock('../../../lib/fetchAllSites',()=>({fetchAllSites:m.sites}));
vi.mock('../../../stores/orgStore',()=>({useOrgStore:(selector:any)=>selector({currentOrgId:m.currentOrgId,organizations:[{id:'11111111-1111-4111-8111-111111111111',name:'Customer'}]})}));
const org='11111111-1111-4111-8111-111111111111';
function row(id:string,role:'member'|'pdc_emulator'='member'):FleetTimeRow {
  return {deviceId:id,hostname:id,orgId:org,orgName:'Customer',siteId:null,siteName:null,view:{
    deviceId:id,state:'reported',stale:false,receivedAt:'2026-09-28T12:00:00Z',collectedAt:'2026-09-28T12:00:00Z',health:'healthy',findings:[],
    config:null,status:null,domain:{joinType:'on_prem_ad',role,domainDns:'example.com',forestDns:'example.com',pdcName:'PDC'},
    timezone:null,recentEvents:[],enforcement:null,
  }};
}
const result=(data:FleetTimeRow[]=[]):FleetTimeResult=>({data,total:data.length,page:1,limit:50,domains:[]});
const response=(value:unknown,ok=true)=>({ok,status:ok?200:500,json:async()=>value,blob:async()=>new Blob(['csv'])}) as Response;
beforeEach(()=>{window.location.hash='';m.currentOrgId=null;m.fetch.mockReset().mockResolvedValue(response(result([row('Member')])));m.download.mockReset();m.sites.mockReset().mockResolvedValue([]);});
it('keeps filters and view in the hash and sends scoped transport filters',async()=>{
  render(<FleetTimeSyncReport/>);await screen.findByTestId('time-row-Member');
  fireEvent.change(screen.getByTestId('time-filter-health'),{target:{value:'warning'}});
  fireEvent.change(screen.getByTestId('time-view'),{target:{value:'domain'}});
  await waitFor(()=>expect(window.location.hash).toContain('view=domain'));
  expect(window.location.search).toBe('');
  await waitFor(()=>expect(m.fetch.mock.calls.some(([url])=>String(url).includes('health=warning'))).toBe(true));
});
it('pins the context PDC once and marks an unenrolled PDC within caller visibility',()=>{
  const pdc=row('PDC','pdc_emulator');
  const value={...result([row('Member'),pdc]),domains:[{orgId:org,domainDns:'example.com',pdcEnrolled:true,pdcExpected:true,pdc}]};
  const {rerender}=render(<DomainGroupView result={value}/>);
  expect(screen.getAllByTestId(/^time-row-/).map(e=>e.getAttribute('data-testid'))).toEqual(['time-row-PDC','time-row-Member']);
  rerender(<DomainGroupView result={{...value,data:[row('Member')],domains:[{...value.domains[0]!,pdcEnrolled:false,pdc:null}]}}/>);
  expect(screen.getByTestId('time-pdc-warning')).toBeTruthy();
});
it('shows no-data and stale observations explicitly',async()=>{
  const empty=row('NoData');empty.view={...empty.view,state:'not_reported',health:'unknown',receivedAt:null};
  const old=row('Old');old.view.stale=true;
  m.fetch.mockResolvedValue(response(result([empty,old])));render(<FleetTimeSyncReport/>);
  await screen.findByTestId('time-row-NoData');expect(screen.getByText('No time data yet')).toBeTruthy();expect(screen.getByText('Stale')).toBeTruthy();
});
it('does not let an older response replace a new filter result',async()=>{
  let finish!:(value:Response)=>void;
  m.fetch.mockImplementationOnce(()=>new Promise<Response>(resolve=>{finish=resolve;})).mockResolvedValue(response(result([row('New')])));
  render(<FleetTimeSyncReport/>);fireEvent.change(screen.getByTestId('time-filter-health'),{target:{value:'critical'}});
  await screen.findByTestId('time-row-New');finish(response(result([row('Old')])));
  await waitFor(()=>expect(screen.queryByTestId('time-row-Old')).toBeNull());
});
it('downloads complete authenticated CSV and reports HTTP failures without a download',async()=>{
  render(<FleetTimeSyncReport/>);await screen.findByTestId('time-row-Member');
  fireEvent.click(screen.getByTestId('time-export-current'));
  await waitFor(()=>expect(m.download).toHaveBeenCalledWith(expect.any(Blob),'time-status.csv'));
  m.download.mockClear();m.fetch.mockResolvedValueOnce(response({},false));
  fireEvent.click(screen.getByTestId('time-export-current'));
  await screen.findByTestId('time-export-error');expect(m.download).not.toHaveBeenCalled();
});
it('reports 401 and network failures without a successful download',async()=>{
  render(<FleetTimeSyncReport/>);await screen.findByTestId('time-row-Member');
  m.fetch.mockResolvedValueOnce({...response({},false),status:401});
  fireEvent.click(screen.getByTestId('time-export-current'));await screen.findByTestId('time-export-error');expect(m.download).not.toHaveBeenCalled();
  m.fetch.mockRejectedValueOnce(new Error('network unavailable'));
  fireEvent.click(screen.getByTestId('time-export-current'));await screen.findByTestId('time-export-error');expect(m.download).not.toHaveBeenCalled();
});
it('does not download a partial body when the CSV stream fails',async()=>{
  render(<FleetTimeSyncReport/>);await screen.findByTestId('time-row-Member');
  m.fetch.mockResolvedValueOnce({...response({}),blob:async()=>{throw new Error('stream interrupted');}});
  fireEvent.click(screen.getByTestId('time-export-current'));await screen.findByTestId('time-export-error');
  expect(m.download).not.toHaveBeenCalled();
});
it('clears hidden site and page filters when the global organization changes',async()=>{
  window.location.hash='siteId=22222222-2222-4222-8222-222222222222&page=3';
  const {rerender}=render(<FleetTimeSyncReport/>);await screen.findByTestId('time-row-Member');
  m.currentOrgId=org;rerender(<FleetTimeSyncReport/>);
  await waitFor(()=>{
    const hash=new URLSearchParams(window.location.hash.slice(1));
    expect(hash.get('siteId')).toBeNull();expect(hash.get('page')).toBe('1');expect(hash.get('orgId')).toBe(org);
  });
  await waitFor(()=>{
    const url=String(m.fetch.mock.calls.at(-1)![0]);expect(url).not.toContain('siteId=');expect(url).toContain('page=1');
  });
});
it('offers retry after load failure and distinguishes an empty report',async()=>{
  m.fetch.mockResolvedValueOnce(response({},false)).mockResolvedValue(response(result()));
  render(<FleetTimeSyncReport/>);await screen.findByTestId('time-load-error');fireEvent.click(screen.getByTestId('time-retry'));
  await screen.findByTestId('time-empty');
});
```

- [ ] Run `cd apps/web && npx vitest run src/components/devices/time/fleetState.test.ts src/components/devices/time/FleetTimeSyncReport.test.tsx`; expected FAIL missing modules.
- [ ] Create DTO and hash helpers:

```ts
// components/devices/time/fleetTypes.ts
import type {DeviceTimeStatusView} from './types';
export interface FleetTimeRow {deviceId:string;hostname:string;orgId:string;orgName:string;siteId:string|null;siteName:string|null;view:DeviceTimeStatusView}
export interface FleetTimeDomain {orgId:string;domainDns:string;pdcEnrolled:boolean;pdcExpected:boolean;pdc:FleetTimeRow|null}
export interface FleetTimeResult {data:FleetTimeRow[];total:number;page:number;limit:number;domains:FleetTimeDomain[]}
```

```ts
// components/devices/time/fleetState.ts
import {TIME_SYNC_HEALTH,TIME_SYNC_FINDING_CODES,TIME_SYNC_DOMAIN_ROLES} from '@breeze/shared';
export interface FleetState {view:'list'|'domain';health:string;finding:string;role:string;orgId:string;siteId:string;page:number}
export const INITIAL_FLEET_STATE:FleetState={view:'list',health:'',finding:'',role:'',orgId:'',siteId:'',page:1};
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function readFleetHash(raw:string):FleetState {
  const p=new URLSearchParams(raw),pick=(key:string,values:readonly string[])=>values.includes(p.get(key)??'')?p.get(key)!:'';
  const page=Number(p.get('page')??1);
  return {view:p.get('view')==='domain'?'domain':'list',health:pick('health',TIME_SYNC_HEALTH),finding:pick('finding',TIME_SYNC_FINDING_CODES),
    role:pick('role',TIME_SYNC_DOMAIN_ROLES),orgId:uuid.test(p.get('orgId')??'')?p.get('orgId')!:'',siteId:uuid.test(p.get('siteId')??'')?p.get('siteId')!:'',
    page:Number.isSafeInteger(page)&&page>=1?page:1};
}
export function fleetQuery(state:FleetState,currentOrgId:string|null):URLSearchParams {
  const params=new URLSearchParams({page:String(state.page),limit:'50'});
  for(const key of ['health','finding','role','siteId'] as const)if(state[key])params.set(key,state[key]);
  const org=currentOrgId||state.orgId;if(org)params.set('orgId',org);
  return params;
}
```

Create the domain/table component. PDC context is displayed even when outside the filtered page, but is never counted as an additional result or included in filtered exports. The warning makes its caller-visibility limit explicit.

```tsx
// components/devices/time/DomainGroupView.tsx
import {useTranslation} from 'react-i18next';
import {formatDateTime} from '../../../lib/dateTimeFormat';
import type {FleetTimeResult,FleetTimeRow} from './fleetTypes';
const colors={healthy:'bg-success/15 text-success border-success/30',warning:'bg-warning/15 text-warning border-warning/30',critical:'bg-destructive/15 text-destructive border-destructive/30',unknown:'bg-muted text-muted-foreground border-border'};
export function TimeRows({rows}:{rows:FleetTimeRow[]}) {
  const {t}=useTranslation('devices');
  return <div className="overflow-x-auto"><table className="w-full text-sm">
    <thead><tr>{['device','organization','health','findings','role','source','received'].map(key=><th key={key} className="p-3 text-left font-medium">{t(`timeFleet.${key}`)}</th>)}</tr></thead>
    <tbody>{rows.map(r=><tr key={r.deviceId} data-testid={`time-row-${r.deviceId}`} className="border-t border-border">
      <td className="p-3"><a className="text-primary underline" href={`/devices/${r.deviceId}`}>{r.hostname}</a></td>
      <td className="p-3">{r.orgName}<div className="text-xs text-muted-foreground">{r.siteName}</div></td>
      <td className="p-3"><span className={`rounded border px-2 py-0.5 ${colors[r.view.health]}`}>{t(`timeFleet.healthLabels.${r.view.health}`)}</span>
        {r.view.stale&&<div className="mt-1 text-warning">{t('timeFleet.stale')}</div>}
        {r.view.state==='not_reported'&&<div className="mt-1 text-muted-foreground">{t('timeFleet.noData')}</div>}</td>
      <td className="p-3">{r.view.findings.length?r.view.findings.map(f=><div key={f.code}>{t(`timeSync.findings.${f.code}.label`)}</div>):t('timeFleet.none')}</td>
      <td className="p-3">{t(`timeFleet.roles.${r.view.domain?.role??'unknown'}`)}</td>
      <td className="p-3">{r.view.status?.source??t('timeFleet.unknown')}</td>
      <td className="p-3 whitespace-nowrap">{r.view.receivedAt?formatDateTime(r.view.receivedAt):t('timeFleet.never')}</td>
    </tr>)}</tbody>
  </table></div>;
}
export default function DomainGroupView({result}:{result:FleetTimeResult}) {
  const {t}=useTranslation('devices');
  const groups=new Map<string,{orgId:string;dns:string|null;rows:FleetTimeRow[]}>();
  for(const row of result.data){const dns=row.view.domain?.domainDns??null,key=`${row.orgId}:${dns??''}`;
    const group=groups.get(key)??{orgId:row.orgId,dns,rows:[]};group.rows.push(row);groups.set(key,group);}
  return <div className="space-y-4">{[...groups.entries()].map(([key,group])=>{
    const domain=result.domains.find(d=>d.orgId===group.orgId&&d.domainDns===group.dns);
    const rows=domain?.pdc?[domain.pdc,...group.rows.filter(r=>r.deviceId!==domain.pdc!.deviceId)]:group.rows;
    return <section key={key} className="rounded-md border border-border" data-testid="time-domain-group">
      <div className="border-b border-border p-3"><h2 className="font-medium">{group.dns??t('timeFleet.noDomain')} · {group.rows[0]!.orgName}</h2>
        {domain?.pdc&&<p className="text-xs text-muted-foreground">{t('timeFleet.pdcContext')}</p>}
        {domain?.pdcExpected&&!domain.pdcEnrolled&&<p className="text-sm text-warning" data-testid="time-pdc-warning">{t('timeFleet.pdcMissing')}</p>}
      </div><TimeRows rows={rows}/>
    </section>;
  })}</div>;
}
```

Create the report:

```tsx
// components/devices/time/FleetTimeSyncReport.tsx
import {useEffect,useMemo,useRef,useState} from 'react';
import {useTranslation} from 'react-i18next';
import {TIME_SYNC_HEALTH,TIME_SYNC_FINDING_CODES,TIME_SYNC_DOMAIN_ROLES} from '@breeze/shared';
import '../../../lib/i18n';
import {fetchWithAuth} from '../../../stores/auth';
import {useOrgStore} from '../../../stores/orgStore';
import {useHashState} from '../../../lib/useHashState';
import {fetchAllSites} from '../../../lib/fetchAllSites';
import {downloadBlob} from '../../../lib/downloadBlob';
import {fleetQuery,INITIAL_FLEET_STATE,readFleetHash,type FleetState} from './fleetState';
import type {FleetTimeResult} from './fleetTypes';
import DomainGroupView,{TimeRows} from './DomainGroupView';
export default function FleetTimeSyncReport(){
  const {t}=useTranslation('devices');
  const currentOrgId=useOrgStore(s=>s.currentOrgId),organizations=useOrgStore(s=>s.organizations);
  const [state,setState]=useHashState(INITIAL_FLEET_STATE,readFleetHash);
  const [result,setResult]=useState<FleetTimeResult|null>(null),[loading,setLoading]=useState(true),[error,setError]=useState(false);
  const [sites,setSites]=useState<Array<{id:string;name:string}>>([]),[siteError,setSiteError]=useState(false);
  const [refresh,setRefresh]=useState(0),[exporting,setExporting]=useState(false),[exportError,setExportError]=useState(false);
  const [from,setFrom]=useState(''),[to,setTo]=useState('');
  const query=useMemo(()=>fleetQuery(state,currentOrgId).toString(),[state,currentOrgId]);
  const org=currentOrgId||state.orgId;
  const previousOrg=useRef(currentOrgId);
  const change=(patch:Partial<FleetState>)=>{
    const next={...state,...patch};setState(next);
    const hash=new URLSearchParams();for(const [key,value] of Object.entries(next))if(value!=='')hash.set(key,String(value));
    window.location.hash=hash.toString();
  };
  useEffect(()=>{
    if(previousOrg.current===currentOrgId)return;
    previousOrg.current=currentOrgId;
    const next={...state,orgId:currentOrgId??'',siteId:'',page:1};
    setState(next);
    const hash=new URLSearchParams();for(const [key,value] of Object.entries(next))if(value!=='')hash.set(key,String(value));
    window.location.hash=hash.toString();
  },[currentOrgId,state,setState]);
  useEffect(()=>{
    const end=new Date();setTo(end.toISOString().slice(0,10));setFrom(new Date(+end-6*86_400_000).toISOString().slice(0,10));
  },[]);
  useEffect(()=>{
    const controller=new AbortController();let active=true;setLoading(true);setError(false);setResult(null);
    void (async()=>{
      try{const response=await fetchWithAuth(`/time-status?${query}`,{signal:controller.signal});if(!response.ok)throw new Error('load failed');
        const value=await response.json() as FleetTimeResult;if(active)setResult(value);
      }catch{if(active)setError(true);}finally{if(active)setLoading(false);}
    })();return()=>{active=false;controller.abort();};
  },[query,refresh]);
  useEffect(()=>{
    const controller=new AbortController();let active=true;setSites([]);setSiteError(false);
    void fetchAllSites<{id:string;name:string}>(org?`/orgs/sites?organizationId=${encodeURIComponent(org)}`:'/orgs/sites',{signal:controller.signal})
      .then(value=>{if(active)setSites(value);}).catch(()=>{if(active)setSiteError(true);});
    return()=>{active=false;controller.abort();};
  },[org,refresh]);
  const rangeDays=(Date.parse(`${to}T00:00:00Z`)-Date.parse(`${from}T00:00:00Z`))/86_400_000+1;
  const validRange=Boolean(from&&to&&Number.isInteger(rangeDays)&&rangeDays>=1&&rangeDays<=400);
  async function download(history:boolean){
    setExporting(true);setExportError(false);
    try{
      const params=new URLSearchParams(query);params.delete('page');params.delete('limit');
      if(history){params.set('from',from);params.set('to',to);}
      const response=await fetchWithAuth(`/time-status/${history?'history/export':'export'}?${params}`);
      if(!response.ok)throw new Error('export failed');
      const blob=await response.blob();downloadBlob(blob,history?'time-status-history.csv':'time-status.csv');
    }catch{setExportError(true);}finally{setExporting(false);}
  }
  return <div className="space-y-4" data-testid="fleet-time-sync">
    <div><h1 className="text-2xl font-semibold">{t('timeFleet.title')}</h1><p className="text-sm text-muted-foreground">{t('timeFleet.subtitle')}</p></div>
    <div className="flex flex-wrap items-end gap-3">
      <label className="text-sm">{t('timeFleet.view')}<select className="ml-2 rounded border border-border bg-background p-2" value={state.view} data-testid="time-view" onChange={e=>change({view:e.target.value==='domain'?'domain':'list',page:1})}>
        <option value="list">{t('timeFleet.list')}</option><option value="domain">{t('timeFleet.byDomain')}</option></select></label>
      {(['health','finding','role'] as const).map(key=><label key={key} className="text-sm">{t(`timeFleet.${key}`)}
        <select className="ml-2 max-w-72 rounded border border-border bg-background p-2" value={state[key]} data-testid={`time-filter-${key}`} onChange={e=>change({[key]:e.target.value,page:1})}>
          <option value="">{t('timeFleet.all')}</option>
          {(key==='health'?TIME_SYNC_HEALTH:key==='role'?TIME_SYNC_DOMAIN_ROLES:TIME_SYNC_FINDING_CODES).map(value=><option key={value} value={value}>
            {key==='finding'?t(`timeSync.findings.${value}.label`):t(`timeFleet.${key==='health'?'healthLabels':'roles'}.${value}`)}</option>)}
        </select></label>)}
      <label className="text-sm">{t('timeFleet.organization')}<select className="ml-2 rounded border border-border bg-background p-2" value={org} disabled={Boolean(currentOrgId)} data-testid="time-filter-org" onChange={e=>change({orgId:e.target.value,siteId:'',page:1})}>
        <option value="">{t('timeFleet.all')}</option>{organizations.map(o=><option key={o.id} value={o.id}>{o.name}</option>)}</select></label>
      <label className="text-sm">{t('timeFleet.site')}<select className="ml-2 rounded border border-border bg-background p-2" value={state.siteId} data-testid="time-filter-site" onChange={e=>change({siteId:e.target.value,page:1})}>
        <option value="">{t('timeFleet.all')}</option>{sites.map(s=><option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
      <button type="button" className="rounded border border-border px-3 py-2 text-sm" data-testid="time-refresh" onClick={()=>setRefresh(n=>n+1)}>{t('timeFleet.refresh')}</button>
    </div>
    {siteError&&<p role="alert" className="text-sm text-destructive">{t('timeFleet.siteError')}</p>}
    <div className="flex flex-wrap items-end gap-3 rounded-md border border-border p-3">
      <button type="button" className="rounded border border-border px-3 py-2 text-sm disabled:opacity-50" data-testid="time-export-current" disabled={exporting} onClick={()=>void download(false)}>{t('timeFleet.exportCurrent')}</button>
      <label className="text-sm">{t('timeFleet.from')}<input type="date" value={from} data-testid="time-from" className="ml-2 rounded border border-border bg-background p-2" onChange={e=>setFrom(e.target.value)}/></label>
      <label className="text-sm">{t('timeFleet.to')}<input type="date" value={to} data-testid="time-to" className="ml-2 rounded border border-border bg-background p-2" onChange={e=>setTo(e.target.value)}/></label>
      <button type="button" className="rounded border border-border px-3 py-2 text-sm disabled:opacity-50" data-testid="time-export-history" disabled={exporting||!validRange} onClick={()=>void download(true)}>{t('timeFleet.exportHistory')}</button>
      <p className="basis-full text-xs text-muted-foreground">{t('timeFleet.evidence')}</p>
      {!validRange&&<p className="text-xs text-destructive">{t('timeFleet.rangeError')}</p>}
      {exportError&&<p role="alert" data-testid="time-export-error" className="text-sm text-destructive">{t('timeFleet.exportError')}</p>}
    </div>
    {loading&&<p role="status" data-testid="time-loading">{t('timeFleet.loading')}</p>}
    {error&&<div role="alert" data-testid="time-load-error"><p>{t('timeFleet.loadError')}</p><button type="button" data-testid="time-retry" onClick={()=>setRefresh(n=>n+1)}>{t('timeFleet.retry')}</button></div>}
    {!loading&&!error&&result&&<>
      <p className="text-sm text-muted-foreground">{t('timeFleet.count',{count:result.total})}</p>
      {result.data.length===0?<p data-testid="time-empty">{t('timeFleet.empty')}</p>:state.view==='domain'?<DomainGroupView result={result}/>:<TimeRows rows={result.data}/>}
      <div className="flex items-center gap-3">
        <button type="button" data-testid="time-previous" disabled={state.page<=1} onClick={()=>change({page:state.page-1})}>{t('timeFleet.previous')}</button>
        <span>{t('timeFleet.page',{page:result.page})}</span>
        <button type="button" data-testid="time-next" disabled={result.page*result.limit>=result.total} onClick={()=>change({page:state.page+1})}>{t('timeFleet.next')}</button>
      </div>
    </>}
  </div>;
}
```

- [ ] Add the Astro shell (same layout as `pages/devices/posture.astro:1–13`; the React heading owns localized visible page copy):

```astro
---
import DashboardLayout from '../../layouts/DashboardLayout.astro';
import FleetTimeSyncReport from '../../components/devices/time/FleetTimeSyncReport';
---
<DashboardLayout titleKey="titles.devicesTime">
  <FleetTimeSyncReport client:load />
</DashboardLayout>
```

After the exact Posture nav row at `Sidebar.tsx:366`:

```ts
{ name: 'Fleet Posture', labelKey: 'nav.fleetPosture', href: '/devices/posture', icon: Radar, requiredPermission: { resource: 'devices', action: 'read' } },
```

insert:

```ts
{ name: 'Time Sync', labelKey: 'nav.timeSync', href: '/devices/time', icon: Radar, requiredPermission: { resource: 'devices', action: 'read' } },
```

Posture currently lives in the Reporting section, despite the spec saying Devices nav; this uses the task's explicit “next to Posture” instruction. `/devices/time` is covered by the existing `/devices` org-or-all route-scope entry; do not add a redundant exception.

- [ ] Add the complete English locale payload to all eight locales. W01a's `timeSync.findings` labels remain the source for finding names.

```python
import json
from pathlib import Path
copy={
 'title':'Time synchronization','subtitle':'Observed Windows time configuration and synchronization findings.',
 'view':'View','list':'Devices','byDomain':'By AD domain','health':'Health','finding':'Finding','findings':'Findings','role':'Role',
 'organization':'Organization','site':'Site','all':'All','refresh':'Refresh','device':'Device','source':'Source','received':'Last received',
 'stale':'Stale','noData':'No time data yet','unknown':'Unknown','never':'Never','none':'None','noDomain':'No reported AD domain',
 'pdcContext':'The PDC is pinned for context and may be outside the selected filters or page.',
 'pdcMissing':'PDC not enrolled in your accessible inventory. It may be outside your access.',
 'exportCurrent':'Export current CSV','exportHistory':'Export daily CSV','from':'From (UTC)','to':'To (UTC)',
 'evidence':'Observed synchronization reported by the Breeze agent; days without a report are listed as gaps. Export up to 400 UTC days. Filters select the current device population.',
 'rangeError':'Choose between 1 and 400 UTC dates.','exportError':'The evidence export failed. Try again.',
 'siteError':'Sites could not be loaded. Refresh to try again.','loading':'Loading time synchronization data…',
 'loadError':'Time synchronization data could not be loaded.','retry':'Retry','empty':'No accessible Windows devices match these filters.',
 'count':'{{count}} matching device','count_other':'{{count}} matching devices','previous':'Previous','next':'Next','page':'Page {{page}}',
 'healthLabels':{'healthy':'Healthy','warning':'Warning','critical':'Critical','unknown':'Unknown'},
 'roles':{'workgroup':'Workgroup','entra_only':'Entra only','member':'Domain member','dc':'Domain controller','pdc_emulator':'Domain PDC emulator','forest_root_pdc_emulator':'Forest-root PDC emulator','unknown':'Unknown'}
}
for locale in ['en','de-DE','es-419','fr-CA','fr-FR','it-IT','pt-BR','tr-TR']:
 root=Path('apps/web/src/locales')/locale
 for filename,key,value in [('devices.json','timeFleet',copy),('common.json','nav',{'timeSync':'Time Sync'}),('pages.json','titles',{'devicesTime':'Time synchronization'})]:
  p=root/filename;data=json.loads(p.read_text())
  if key=='timeFleet':data[key]=value
  else:data[key].update(value)
  p.write_text(json.dumps(data,ensure_ascii=False,indent=2)+'\n')
```

- [ ] Rerun both new web tests; expected PASS. Run `cd apps/web && npx vitest run src/lib/routeScope.test.ts`; expected PASS for `/devices/time` classification. The local report remains read-only, so it introduces no `runAction` exception.
- [ ] Commit:

```bash
git add apps/web/src/components/devices/time/fleetTypes.ts apps/web/src/components/devices/time/fleetState.ts apps/web/src/components/devices/time/fleetState.test.ts apps/web/src/components/devices/time/FleetTimeSyncReport.tsx apps/web/src/components/devices/time/DomainGroupView.tsx apps/web/src/components/devices/time/FleetTimeSyncReport.test.tsx apps/web/src/pages/devices/time.astro apps/web/src/components/layout/Sidebar.tsx apps/web/src/locales/{en,de-DE,es-419,fr-CA,fr-FR,it-IT,pt-BR,tr-TR}/{devices,common,pages}.json
git commit -m "feat(web): add time synchronization fleet report" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 11: Explain alert attachment and observational evidence limits

**Files:** Modify W01a `apps/docs/src/content/docs/features/time-sync.mdx` (absent implementation; index §I/§11 prerequisite); create `apps/web/src/components/devices/time/timeSyncEvidenceDocs.test.ts`. Existing model is `components/devices/hardware/hardwareMonitoringDocs.test.ts:1–22`; retain W01a's `timeSyncDocs.test.ts` and sidebar entry.

**Interfaces:** Consumes the three v4 built-in keys, Task 8's exact header and range semantics; produces user documentation, not a compliance claim or a new API.

- [ ] Write the failing documentation test:

```ts
import {readFileSync} from 'node:fs';
import {expect,it} from 'vitest';
const path=new URL('../../../../../docs/src/content/docs/features/time-sync.mdx',import.meta.url);
it('explains opt-in attachment, independent subjects, freshness and evidence limits',()=>{
  const doc=readFileSync(path,'utf8');
  for(const text of ['## Alerts','time_source_problem','time_sync_stale','timezone_mismatch','not attached by default',
    'accepted snapshots','unknown does not resolve','90 minutes','## Evidence exports','400','UTC',
    'Observed synchronization reported by the Breeze agent; days without a report are listed as gaps.',
    'not an attestation','current device population','deleted with the device'])expect(doc).toContain(text);
});
```

- [ ] Run `cd apps/web && npx vitest run src/components/devices/time/timeSyncEvidenceDocs.test.ts`; expected FAIL missing Alerts/Evidence text on W01a.
- [ ] Append this complete MDX section to the W01 page, preserving existing findings, timezone, and freshness documentation:

```mdx
## Alerts

Three built-in monitors are provisioned for each partner. They are **not attached by default**.
Attach a monitor to a configuration policy to enable its evaluation for that policy's devices.

| Monitor | Built-in key | Default severity | Findings |
| --- | --- | --- | --- |
| Time source problem | `time_source_problem` | High | Missing external PDC source, local clock, DC host-time synchronization, unresolvable or unreachable peers, unavailable domain source, member bypassing hierarchy, refused correction |
| Time sync stale or disabled | `time_sync_stale` | Medium | Stale synchronization or synchronization disabled |
| Timezone mismatch | `timezone_mismatch` | Low | Reported timezone differs from the expected timezone while automatic timezone is not on |

Each default requires two consecutive accepted snapshots. Alert sweeps do not count as
new observations. A rejected duplicate does not advance the counters. You can override
the required count from 1 to 10 in the monitor attachment.

Each finding is an independent subject. A device can have more than one time alert;
acknowledging one does not acknowledge the others. Recovery requires the same number
of accepted snapshots without that finding. Missing data, incomplete streaks and stale
observations produce unknown evidence; unknown does not resolve an existing alert.
Observations older than 90 minutes are stale. Use the existing offline monitor for
unreachable devices. Timezone mismatch is informational for device health but remains
alertable through its monitor.

## Evidence exports

Open **Time Sync**, next to **Fleet Posture**, for the Windows fleet report. Filter by
health, finding, role, organization or site. The AD-domain view pins an accessible PDC
first. A missing-PDC warning means no PDC is present in your accessible inventory; it
may be unenrolled or outside your access. A pinned PDC is context and can be outside
the selected filters or page.

**Export current CSV** includes all matching devices, not just the visible page.
Current expected timezone is recalculated from the site's current setting.
**Export daily CSV** accepts an inclusive range of at most 400 UTC dates within the
retained window, ending no later than today. Filters select the current device population;
the export then lists every requested day for each selected device. Days without a
row have `evidence_state=gap`, an empty health value and `snapshot_count=0`.

Both exports begin with:

> Observed synchronization reported by the Breeze agent; days without a report are listed as gaps.

Daily summaries retain the worst observed health, union of finding codes, maximum
successful-sync timestamp, observation count and the source/timezone from the latest
accepted observation that day. An unknown observation keeps a day from being labeled
entirely healthy. Site timezone edits do not rewrite past daily evidence.

This is observational evidence, **not an attestation** that the clock was correct all
day. Breeze does not measure an offset in this feature, and an agent's report is not
independently verified. Exports are live reads; fleet membership may change during a
large download. Historical rows follow a device when it moves organizations and are
deleted with the device. Downloaded CSVs are the durable artifact. Retention removes
rows older than 400 days; the cutoff date itself remains eligible until the next day.
```

- [ ] Run the new docs test and W01a's existing `timeSyncDocs.test.ts`; expected PASS. Run `pnpm --filter @breeze/docs check` and `pnpm --filter @breeze/docs build`; expected PASS and `/features/time-sync/` output.
- [ ] Commit:

```bash
git add apps/docs/src/content/docs/features/time-sync.mdx apps/web/src/components/devices/time/timeSyncEvidenceDocs.test.ts
git commit -m "docs(time-sync): explain alerts and evidence exports" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 12: Verify live tenancy, timezone parity, lifecycle contracts and types

**Files:** Create `apps/api/src/services/timeSync/fleet.integration.test.ts`. Test existing contract suites; no production changes in this final verification task.

**Interfaces:** Consumes all Task 1–11 interfaces and real PostgreSQL as `breeze_app`. Produces proof that scoped list/domain/export results agree with W01's view and that live site edits leave past daily evidence unchanged. Integration test helpers are verified at `services/hardwareHealth/migrations.integration.test.ts:1–20`; database context is `withDbAccessContext(context,fn)` from `db/index.ts`.

- [ ] Add this real-database acceptance test. Its red baseline is W01a alone: imports `fleet`/`exports` and relation `device_time_daily` are absent; after Tasks 1–11 it must pass without changing assertions.

```ts
import '../../__tests__/integration/setup';
import {randomUUID} from 'node:crypto';
import {eq,inArray} from 'drizzle-orm';
import {expect,it} from 'vitest';
import {db,withDbAccessContext,type DbAccessContext} from '../../db';
import {devices,sites,deviceTimeDaily} from '../../db/schema';
import type {AuthContext} from '../../middleware/auth';
import {createPartner,createOrganization,createSite} from '../../__tests__/integration/db-utils';
import {getTestDb} from '../../__tests__/integration/setup';
import {ingestTimeStatusSnapshot} from './ingest';
import {getDeviceTimeStatusView} from './view';
import {timeSnapshot} from './testSnapshot';
import {listFleetTimeStatus} from './fleet';
import {exportHistoryTimeCsv} from './exports';
const system:DbAccessContext={scope:'system',orgId:null,accessibleOrgIds:null,accessiblePartnerIds:null};
async function fixture(){
  const partner=await createPartner();
  const a=await createOrganization({partnerId:partner!.id}),b=await createOrganization({partnerId:partner!.id});
  const sa=await createSite({orgId:a!.id}),sb=await createSite({orgId:b!.id});
  const add=async(orgId:string,siteId:string,hostname:string)=>{
    const [row]=await getTestDb().insert(devices).values({orgId,siteId,agentId:randomUUID(),hostname,osType:'windows',osVersion:'Server',architecture:'x64',agentVersion:'1.0.0'}).returning();return row!;
  };
  const member=await add(a!.id,sa!.id,'Member A'),pdc=await add(a!.id,sa!.id,'PDC A'),other=await add(b!.id,sb!.id,'Member B');
  const today=new Date().toISOString().slice(0,10),receivedAt=new Date();
  for(const device of [member,pdc,other]){
    const snapshot=timeSnapshot({collectedAt:`${today}T00:00:00Z`});
    snapshot.domain={joinType:'on_prem_ad',role:device.id===pdc.id?'pdc_emulator':'member',domainDns:'example.com',forestDns:'example.com',pdcName:'PDC'};
    snapshot.config.type='NT5DS';snapshot.status.lastSuccessfulSyncAt=receivedAt.toISOString();
    await withDbAccessContext(system,()=>ingestTimeStatusSnapshot({deviceId:device.id,orgId:device.orgId,agentVersion:null,snapshot,receivedAt}));
  }
  const context:DbAccessContext={scope:'organization',orgId:a!.id,accessibleOrgIds:[a!.id],accessiblePartnerIds:[],currentPartnerId:partner!.id};
  const auth={scope:'organization',orgId:a!.id,accessibleOrgIds:[a!.id],orgCondition:(column:any)=>eq(column,a!.id),canAccessOrg:(id:string)=>id===a!.id} as AuthContext;
  return {partner:partner!,a:a!,b:b!,sa:sa!,sb:sb!,member,pdc,other,today,context,auth};
}
it('separates tenants with equal domains and preserves site/device authorization in metadata',async()=>{
  const f=await fixture();
  await withDbAccessContext(f.context,async()=>{
    const value=await listFleetTimeStatus({role:'member',limit:1},f.auth);
    expect(value.data.map(r=>r.deviceId)).toEqual([f.member.id]);
    expect(value.domains).toMatchObject([{orgId:f.a.id,domainDns:'example.com',pdcEnrolled:true,pdc:{deviceId:f.pdc.id}}]);
    const pinned=await listFleetTimeStatus({deviceId:f.member.id},{...f.auth,allowedDeviceIds:[f.member.id]});
    expect(pinned.domains).toMatchObject([{pdcEnrolled:false,pdc:null}]);
    expect(await listFleetTimeStatus({},{...f.auth,allowedSiteIds:[]})).toMatchObject({total:0,data:[],domains:[]});
  });
  const partnerContext:DbAccessContext={scope:'partner',orgId:null,accessibleOrgIds:[f.a.id,f.b.id],accessiblePartnerIds:[f.partner.id],currentPartnerId:f.partner.id};
  const partnerAuth={...f.auth,scope:'partner',orgId:null,orgCondition:(column:any)=>inArray(column,[f.a.id,f.b.id]),canAccessOrg:(id:string)=>[f.a.id,f.b.id].includes(id)} as AuthContext;
  await withDbAccessContext(partnerContext,async()=>{
    const value=await listFleetTimeStatus({role:'member'},partnerAuth);
    expect(new Set(value.domains.map(d=>d.orgId))).toEqual(new Set([f.a.id,f.b.id]));
    expect(value.domains.find(d=>d.orgId===f.a.id)?.pdcEnrolled).toBe(true);
    expect(value.domains.find(d=>d.orgId===f.b.id)?.pdcEnrolled).toBe(false);
  });
});
it('matches the current view after both directions of a site edit without rewriting daily evidence',async()=>{
  const f=await fixture();
  await withDbAccessContext(f.context,async()=>{
    const [before]=await db.select().from(deviceTimeDaily).where(eq(deviceTimeDaily.deviceId,f.member.id));
    await db.update(sites).set({timezone:'America/New_York'}).where(eq(sites.id,f.sa.id));
    const view=await getDeviceTimeStatusView(f.member.id);
    const mismatch=await listFleetTimeStatus({deviceId:f.member.id,finding:'timezone_mismatch'},f.auth);
    expect(mismatch.total).toBe(1);expect(mismatch.data[0]!.view).toEqual(view);
    await db.update(sites).set({timezone:'UTC'}).where(eq(sites.id,f.sa.id));
    expect((await listFleetTimeStatus({deviceId:f.member.id,finding:'timezone_mismatch'},f.auth)).total).toBe(0);
    const [after]=await db.select().from(deviceTimeDaily).where(eq(deviceTimeDaily.deviceId,f.member.id));
    expect(after).toEqual(before);
  });
});
it('exports only authorized devices and explicit missing days',async()=>{
  const f=await fixture();
  const yesterday=new Date(Date.parse(`${f.today}T00:00:00Z`)-86_400_000).toISOString().slice(0,10);
  await withDbAccessContext(f.context,async()=>{
    let csv='';for await(const chunk of exportHistoryTimeCsv({deviceId:f.member.id},{from:yesterday,to:f.today},f.auth))csv+=chunk;
    expect(csv).toContain(f.member.id);expect(csv).not.toContain(f.other.id);expect(csv).not.toContain(f.pdc.id);
    expect(csv).toContain(`"${yesterday}","gap"`);expect(csv).toContain(`"${f.today}","observed"`);
  });
});
```

- [ ] Run the acceptance file: `cd apps/api && npx vitest run --config vitest.integration.config.ts src/services/timeSync/fleet.integration.test.ts`. Expected PASS after the implementation. Do not weaken SQL scope or assertions to obtain a green result.
- [ ] Complete the following explicit final verification, each command from repository root unless it begins `cd`. Start/stop the stack once; an existing author-owned stack is reused, not leaked. These are executor instructions, not commands run while writing this plan.

```bash
pnpm test-stack up
set -a
source .env.test
set +a
DB_CONTEXTLESS_WRITE_STRICT=true pnpm --filter=@breeze/api test:rls-coverage
```

Run each integration file separately:

```bash
cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/tenantCascade.integration.test.ts
cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/tenant-export-policy.integration.test.ts
cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts
cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/orgMergeRegistry.integration.test.ts
cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/orgLifecycleFoundations.integration.test.ts
cd apps/api && npx vitest run --config vitest.integration.config.ts src/services/timeSync/migrations.w02.integration.test.ts
cd apps/api && npx vitest run --config vitest.integration.config.ts src/services/timeSync/ingest.w02.integration.test.ts
cd apps/api && npx vitest run --config vitest.integration.config.ts src/services/timeSync/fleet.integration.test.ts
cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/builtInMonitors.integration.test.ts
```

Expected PASS: RLS app-role forgery fails with 42501, mismatched ownership fails with 23503, org merge can defer the composite FK, erasure/export policy cover all daily columns and `finding_streaks`, and moved-device history follows the device.

```bash
cd apps/api && npx vitest run src/routes/devices/cascadeDelete.test.ts
cd apps/api && npx vitest run src/routes/devices/moveOrg.coverage.test.ts
cd apps/api && npx vitest run src/services/orgMerge.test.ts
cd apps/api && npx vitest run src/db/autoMigrate.test.ts
cd apps/api && npx vitest run src/db/migrationRlsScope.test.ts
cd apps/api && npx vitest run src/services/workerEntrypointClosure.contract.test.ts
cd apps/api && npx vitest run src/services/aiToolsDevice.timeSync.registry.test.ts
cd apps/api && npx vitest run src/services/mcpGuidancePromptTools.test.ts
pnpm db:check-drift
cd packages/shared && npx tsc --noEmit
cd apps/api && NODE_OPTIONS=--max-old-space-size=12288 npx tsc --noEmit
cd apps/web && npx tsc --noEmit
cd apps/web && npx astro check
pnpm --filter @breeze/docs check
pnpm --filter @breeze/docs build
pnpm test-stack down
```

Expected PASS; no Go command is needed because this wave ships no agent change. Recheck migration ordering with `ls apps/api/migrations | sort | tail -1` and `scripts/check-migration-naming.sh --against-ref origin/main`; if reserved names are behind the merge base, coordinate the index slot change explicitly and update every path reference rather than silently diverging.

- [ ] Commit the final acceptance test after verification:

```bash
git add apps/api/src/services/timeSync/fleet.integration.test.ts
git commit -m "test(time-sync): verify fleet isolation and evidence parity" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

## Self-Review

| Owned spec requirement | Implementing task(s) |
| --- | --- |
| §5.5 90-minute freshness; stale findings are not alertable | 5, 10 |
| §5.6 UTC daily rollup, union/max/count and gaps | 2, 8, 12 |
| §6.1 daily schema and streak column | 1, 2 |
| §6.2 idempotent reserved migrations; enum transaction separation | 1, 4, 12 |
| §6.3 composite FK, forced RLS, cascade/move/merge/export classification | 1, 12 |
| §6.4 bounded 400-day retention and complete worker lifecycle | 3 |
| §7.1 root-only kind, override keys, category and templates | 4, 6 |
| §7.2 accepted-observation streaks, per-finding subjects, unknown and recovery | 2, 5 |
| §7.3 three v4 defaults, partner-wide, unattached, upgrade preservation | 6 |
| §10 scoped paginated fleet; current timezone re-resolution | 7, 10, 12 |
| §10 domain PDC first, missing PDC flag, organization boundaries | 7, 10, 12 |
| §10 health/finding/role/org/site filters and hash state | 7, 10 |
| §10 current/daily CSV, exact header, 400-day limits and gaps | 8, 10, 11, 12 |
| §10 monitor editor multiselect and eight locales | 6 |
| §11 fleet AI tool, MCP and every execution/risk/profile registration | 9 |
| §11 docs: attachment, evidence limits and durable exports | 11 |
| §12 route validation/auth, live tenancy and final contract/type checks | 1–12 |
| §14 history follows device moves and is deleted with devices | 1, 11, 12 |
| W02 excludes config, commands, enforcement and version 5 | All tasks preserve boundary |

**Placeholder scan:** The authoring scan found zero unfinished-marker matches and no unbalanced Markdown fences; every Python edit block parsed successfully. New files contain complete code. W01a source edits are the one explicitly identified prerequisite limitation: current implementation line numbers cannot be verified while those files are absent. Every mechanical registry update quotes its current anchor; W01 draft anchors are labeled explicitly. Production tests and typechecks were not run during plan authoring because the request permits only the plan output.

**Template-site audit:** The four cited commit stats were inspected. W02 mirrors the hardware schema/cascade/export, retention/worker, monitor/subject/built-in, editor/locale, AI/profile/MCP, and docs sites. Existing subject-key SQL and episode/outbox machinery are reused, not duplicated; the two hardware-only runtime assumptions are fixed in Task 5. Agent collectors and heartbeat settings are W01b/W03 work; hardware configuration-feature UI is W03 work; the hardware DeviceList column is replaced by this task's explicitly requested standalone fleet report, not added as another W02 requirement.

**Type consistency:** Index §§A/B finding enums and snapshot fields are consumed unchanged. Index §C.5 public ingest signature and §C.6 device view stay unchanged. Index §G full computed streak Record is distinguished from a partial legacy/default JSON storage row. `time_sync` stays root-only, `consecutiveSnapshots=2` by default, v4 owns exactly three defaults, and the fleet tool/route names and migration slots match the index. Fleet DTOs and `deviceId` filtering are W02-local additions where the index supplies no narrower shape.

**Review Focus coverage:** Tasks 2/5 pin duplicates, accepted resets and sweep independence. Tasks 7/10/12 pin same-DNS cross-org groups and a PDC outside the filtered page. Tasks 2/8/10/12 pin UTC dates, gaps, immutable history, current-site re-resolution and failed downloads. The index's five named focus cases remain W01-owned; its existing tests are retained.

## Contract issues

1. **W01a is described as merged but its implementation is absent in this checkout.** Index `2026-09-28-time-sync.md:14,345–365,433` declares the dependency, ingest and schema; `rg --files apps/api/src packages/shared/src apps/web/src | rg 'timeSync|timeStatus|DeviceTimeSection'` found no implementation at the initial inspection. `apps/api/src/db/schema/index.ts:16` exports hardware health; no time-sync export exists in the inspected implementation. A concurrently authored W01a plan is a draft, not implementation evidence. Proposed fix: execute this plan on the merged W01a base, verify its actual anchors, and preserve its public contracts and tests. This document never claims nonexistent source line numbers.
2. **Missing-row subjects conflict between spec and binding index.** Spec `2026-09-28-time-sync-monitoring-design.md:409` says `subjects: []`; index `2026-09-28-time-sync.md:541` says stale or missing rows make all subjects unknown. Task 5 follows the index: selected codes each produce unknown evidence, `dataAvailable:false`. Proposed fix: align spec §7.2.1 with index §G.
3. **The alert context has duplicate `source` keys.** Spec `2026-09-28-time-sync-monitoring-design.md:415–416` names both the discriminator and observed peer `source`; one JavaScript object cannot retain both. Task 5 keeps `source:'time_sync'` and names the peer `timeSource`. Proposed fix: correct the spec context shape to `{ source:'time_sync', findingCode, findingLabel, findingDetail, domainRole, timeSource, lastSuccessfulSyncAt }`.
4. **The existing subject pipeline is not fully kind-neutral.** Spec `2026-09-28-time-sync-monitoring-design.md:418–419` expects no alert-service changes, but `services/alertSubjects.ts:50` overwrites all sources with `hardware_health`, and `services/alertService.ts:1190–1192` only permits hardware recovery evaluation under maintenance suppression. Task 5 narrowly corrects both and preserves the existing lock and episode path. Proposed fix: update the implementation assumption to include these two regression-tested sites.
5. **Daily latest-value ordering is not representable by event time in the fixed schema.** Spec `2026-09-28-time-sync-monitoring-design.md:307–310` says “latest”; its daily columns at 336–339 have no `latest_collected_at`, while index §C.5 permits higher sequences with older collection times. Task 2 interprets latest as latest accepted observation in the serialized ingest transaction. Proposed fix: explicitly confirm acceptance ordering in §5.6; if collection-time ordering is required, add `latest_collected_at` to the binding schema, migration and export classification before changing the upsert.
6. **Daily worst-health order leaves `unknown` unspecified.** Spec `2026-09-28-time-sync-monitoring-design.md:271–273,307–310` defines severity order and unknown status but does not order unknown in a daily max. Task 2 uses `critical > warning > unknown > healthy`, tested in both directions and documented in Task 11. Proposed fix: add this daily-only order to §5.6; it does not change current-view health or alert severity.
7. **Posture's actual navigation home differs from the spec description.** Spec `2026-09-28-time-sync-monitoring-design.md:587` requests Devices nav; index §I and this task request adjacency to Posture. `apps/web/src/components/layout/Sidebar.tsx:357–366` places Posture under Reporting. Task 10 follows the explicit adjacency instruction while retaining `/devices/time`. Proposed fix: describe the entry as “Time Sync beside Fleet Posture” or separately relocate both entries in a navigation change.
