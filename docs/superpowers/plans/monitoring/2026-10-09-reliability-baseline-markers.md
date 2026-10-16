---
title: Reliability baseline markers — reset after reimage, mark remediation work
tracking_issue: LanternOps/breeze#8310  # feature parent; originating request #5876
spec: docs/superpowers/specs/monitoring/2026-10-08-reliability-baseline-markers-design.md
status: approved design 2026-10-08 — advisor quorum complete (Fable + Codex gpt-6-astra xhigh, AGREE-WITH-CHANGES folded in)
waves: W1 (API — table, scorer, routes, auto-marker, consumers), W2 (web — panel, dialog, list, feed)
---

# Reliability Baseline Markers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a tech place a baseline marker on a device (reimaged / remediated / hardware replaced). After it, the reliability score ignores everything before the marker, is labelled provisional until 14 reported days exist, and shows a frozen "before" snapshot so the tech can tell whether the work helped. A completed bare-metal recovery places the marker automatically.

**Architecture:**
- **Storage:** a new shape-1 (direct `org_id`) table `device_reliability_baselines` holds the marker history.
- **Scoring:** the stateless scorer in `reliabilityScoring.ts` is refactored into a pure `scoreDeviceReliability` that takes an explicit `windowEnd` and an optional baseline, and cuts events by their own timestamps.
- **Concurrent writes:** the `device_reliability` upsert becomes compare-and-set on the active marker id, so a worker run that started under an old marker can't overwrite a fresh score.
- **API:** the routes live in `routes/reliability.ts`.
- **Web (W2):** the device reliability panel gains the action, banner, before/after view and history.

**Tech Stack:** Hono, Drizzle 0.45 + PostgreSQL (forced RLS), BullMQ, Zod, React + Vitest/jsdom, i18next (8 locales).

**Spec:** `docs/superpowers/specs/monitoring/2026-10-08-reliability-baseline-markers-design.md` (**S§**). Read it first, including its "Concurrency" and "Considered and rejected" sections. This plan follows the spec's final (code-survey) revision.

## Global Constraints

**Domain rules**
- Reasons: exactly `reimaged`, `remediated`, `hardware_replaced`. Sources: exactly `manual`, `bare_metal_recovery`.
- Marker time: at most **30 days** back. A time up to **5 minutes** in the future (to absorb clock skew) is clamped to now, and anything later is rejected. Stored `baseline_at` is therefore never in the future.
- Note: required (non-blank after trim) when `reason='remediated' AND source='manual'`. Maximum 2000 characters.
- Provisional: the active marker has **fewer than 14 distinct UTC days with ≥1 agent sample at or after `baseline_at`**. Boot-span extrapolation never counts toward this.
- Active marker: the latest non-cleared marker, ordered by `baseline_at DESC, created_at DESC, id DESC`. Every query that picks it uses exactly this order.
- Raw reliability history is never deleted or rewritten by this feature.

**Permissions and audit**
- Writes require `PERMISSIONS.DEVICES_WRITE` plus device site access. Reads require `PERMISSIONS.DEVICES_READ`.
- Audit action names: `device.reliability.baseline_set`, `device.reliability.baseline_cleared`. Use `resourceType: 'device'` and `resourceId: <deviceId>`.
- Never call the awaited `createAuditLog` inside a request or heartbeat transaction, because it opens a second pooled connection (#1105). Use `writeRouteAudit` / `writeAuditEvent`.

**Repo traps**
- Migration name: `apps/api/migrations/2026-12-19-100000-device-reliability-baselines.sql`. The newest on `origin/main` at plan time is `2026-12-18-100000-…`. Re-check with `git fetch origin main && LC_ALL=C ls apps/api/migrations | grep -E '^[0-9]{4}-' | tail -1` before committing, and rename to sort after it if needed.
- `grep` on `apps/api/src/services/reliabilityScoring.ts` reports "Binary file matches" because the file contains Unicode. Use `grep -a`.
- Run one API test file with `cd apps/api && npx vitest run <path>`. Never `pnpm … test -- --run`.

## Review Focus

These failure modes are implied by the spec but easy to leave untested. Each one has a pinned test in the task named.

1. **A pre-marker event delivered in a post-marker row** (the agent posts about every 24h). The tech expects it not to count. Pinned in Task 2.
2. **A worker scoring run that started before the marker commits and finishes after.** The tech expects the score shown after the click to stay marker-aware. Pinned in Task 4 (unit guard SQL) and Task 5 (integration race).
3. **An agent that goes silent right after the fix.** The tech expects the score to stay provisional rather than mature into 100. Pinned in Task 3 (`reportedDaysSinceBaseline` ignores boot-span credit).
4. **The heartbeat re-acking a recovery whose automatic marker the tech already cleared.** The tech expects the cleared marker not to come back. Pinned in Task 7.
5. **A backdated marker earlier than the current active marker.** The tech expects it to show in history but not change the score, and the before-snapshot to use the correct predecessor. Pinned in Task 5.

---

# Wave W1 — API

Branch: `feature/5876-reliability-baselines/wave-8311` (created by `feature-lifecycle` `start_wave`).

### Task 1: Table, migration, schema, registrations, RLS contract

**Files:**
- Create: `apps/api/migrations/2026-12-19-100000-device-reliability-baselines.sql`
- Modify: `apps/api/src/db/schema/reliability.ts`
- Modify: `apps/api/src/services/tenantCascade.ts` (`CORE_ORG_CASCADE_DELETE_ORDER`, between `'device_reliability'` and `'device_reliability_history'`)
- Modify: `apps/api/src/routes/devices/core.ts` (`CORE_DEVICE_ORG_DENORMALIZED_TABLES` ~L327; `CORE_DEVICE_CASCADE_DELETE_TABLES` ~L657)
- Modify: `apps/api/src/services/orgMergeRegistry.ts` (`REPOINT_TABLES`, between `"device_reliability"` and `"device_reliability_history"`)
- Modify: `apps/api/src/services/tenantExportPolicyRegistry.ts` (between the `device_reliability` and `device_reliability_history` entries)
- Test: `apps/api/src/__tests__/integration/deviceReliabilityBaselinesRls.integration.test.ts`

**Interfaces:**
- Produces: Drizzle table `deviceReliabilityBaselines` (exported from `apps/api/src/db/schema/reliability.ts`, re-exported by `schema/index.ts` via the existing `export * from './reliability'`), with columns `id, orgId, deviceId, baselineAt, reason, source, sourceRef, note, beforeSnapshot, createdBy, createdAt, clearedAt, clearedBy`. Also produces type `DeviceReliabilityBaselineRow = typeof deviceReliabilityBaselines.$inferSelect`.

- [ ] **Step 1: Write the failing RLS/shape integration test**

```ts
// apps/api/src/__tests__/integration/deviceReliabilityBaselinesRls.integration.test.ts
import './setup';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import { devices } from '../../db/schema';
import { pgErrorCode } from '../../utils/pgErrors';
import { createOrganization, createPartner, createSite } from './db-utils';
import { getTestDb } from './setup';
import { replayMigration } from './replayMigration';

const MIGRATION = '2026-12-19-100000-device-reliability-baselines.sql';
const system: DbAccessContext = { scope: 'system', orgId: null, accessibleOrgIds: null, accessiblePartnerIds: null };

async function fixture() {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner!.id });
  const other = await createOrganization({ partnerId: partner!.id });
  const site = await createSite({ orgId: org!.id });
  const [device] = await getTestDb().insert(devices).values({
    orgId: org!.id, siteId: site!.id, agentId: randomUUID(), hostname: 'baseline-a',
    osType: 'windows', osVersion: '11', architecture: 'x64', agentVersion: '1.0.0',
  }).returning();
  return { partner: partner!.id, org: org!.id, other: other!.id, device: device!.id };
}

const insertMarker = (deviceId: string, orgId: string, reason = 'reimaged', note: string | null = null) =>
  db.execute(sql`INSERT INTO device_reliability_baselines (org_id, device_id, baseline_at, reason, source, note)
                 VALUES (${orgId}, ${deviceId}, now(), ${reason}, 'manual', ${note})`);

describe('device_reliability_baselines tenancy', () => {
  it('forces four org policies and an immediate deferrable cascading composite FK', async () => {
    const rows = await getTestDb().execute(sql`
      SELECT c.relrowsecurity, c.relforcerowsecurity, f.condeferrable, f.condeferred, f.confupdtype, f.confdeltype
      FROM pg_class c JOIN pg_constraint f ON f.conrelid = c.oid
      WHERE c.oid = to_regclass('device_reliability_baselines')
        AND f.conname = 'device_reliability_baselines_device_org_fkey'`);
    expect(rows[0]).toMatchObject({
      relrowsecurity: true, relforcerowsecurity: true, condeferrable: true, condeferred: false,
      confupdtype: 'c', confdeltype: 'c',
    });
    const policies = await getTestDb().execute(sql`SELECT cmd FROM pg_policies WHERE tablename = 'device_reliability_baselines'`);
    expect(policies.map((p) => p.cmd).sort()).toEqual(['DELETE', 'INSERT', 'SELECT', 'UPDATE']);
  });

  it('denies forged cross-org writes and reads as breeze_app', async () => {
    const f = await fixture();
    const otherCtx: DbAccessContext = {
      scope: 'organization', orgId: f.other, accessibleOrgIds: [f.other], accessiblePartnerIds: [], currentPartnerId: f.partner,
    };
    await expect(withDbAccessContext(otherCtx, () => insertMarker(f.device, f.org)))
      .rejects.toSatisfy((e: unknown) => pgErrorCode(e) === '42501');
    await expect(withDbAccessContext(system, () => insertMarker(f.device, f.other)))
      .rejects.toSatisfy((e: unknown) => pgErrorCode(e) === '23503');
    await withDbAccessContext(system, () => insertMarker(f.device, f.org));
    expect(await withDbAccessContext(otherCtx, () => db.execute(sql`SELECT * FROM device_reliability_baselines`))).toHaveLength(0);
  });

  it('requires a non-blank note for a manual remediated marker and rejects unknown reasons', async () => {
    const f = await fixture();
    await expect(withDbAccessContext(system, () => insertMarker(f.device, f.org, 'remediated', '   ')))
      .rejects.toSatisfy((e: unknown) => pgErrorCode(e) === '23514');
    await expect(withDbAccessContext(system, () => insertMarker(f.device, f.org, 'rebooted', null)))
      .rejects.toSatisfy((e: unknown) => pgErrorCode(e) === '23514');
    await withDbAccessContext(system, () => insertMarker(f.device, f.org, 'remediated', 'Replaced failing NIC driver'));
  });

  it('keeps automatic markers unique per recovery, including cleared rows', async () => {
    const f = await fixture();
    const recoveryId = randomUUID();
    const insertAuto = () => db.execute(sql`
      INSERT INTO device_reliability_baselines (org_id, device_id, baseline_at, reason, source, source_ref, cleared_at)
      VALUES (${f.org}, ${f.device}, now(), 'reimaged', 'bare_metal_recovery', ${recoveryId}, now())`);
    await withDbAccessContext(system, insertAuto);
    await expect(withDbAccessContext(system, insertAuto)).rejects.toSatisfy((e: unknown) => pgErrorCode(e) === '23505');
  });

  it('replays idempotently without deleting markers', async () => {
    const f = await fixture();
    await withDbAccessContext(system, () => insertMarker(f.device, f.org));
    await replayMigration(MIGRATION);
    const rows = await withDbAccessContext(system, () => db.execute(sql`SELECT id FROM device_reliability_baselines WHERE device_id = ${f.device}`));
    expect(rows).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

`pnpm test-stack up` (if not already up). Then run: `cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/deviceReliabilityBaselinesRls.integration.test.ts`
Expected: FAIL. The relation `device_reliability_baselines` does not exist.

- [ ] **Step 3: Write the migration**

```sql
-- Reliability baseline markers (#5876). A tech (or a completed bare-metal
-- recovery) marks a point in time; reliability scoring ignores everything
-- before the latest active marker. Direct org_id tenancy (shape 1) with a
-- DEFERRABLE INITIALLY IMMEDIATE composite (device_id, org_id) FK so org
-- merge/move can re-point both sides. source_ref is a soft reference to
-- bare_metal_recoveries.id (no FK: see spec "Data model"). Idempotent; writes no rows.
CREATE TABLE IF NOT EXISTS device_reliability_baselines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  device_id uuid NOT NULL,
  baseline_at timestamptz NOT NULL,
  reason text NOT NULL,
  source text NOT NULL DEFAULT 'manual',
  source_ref uuid,
  note text,
  before_snapshot jsonb,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  cleared_at timestamptz,
  cleared_by uuid REFERENCES users(id) ON DELETE SET NULL
);

ALTER TABLE device_reliability_baselines DROP CONSTRAINT IF EXISTS device_reliability_baselines_reason_check;
ALTER TABLE device_reliability_baselines ADD CONSTRAINT device_reliability_baselines_reason_check
  CHECK (reason IN ('reimaged', 'remediated', 'hardware_replaced'));
ALTER TABLE device_reliability_baselines DROP CONSTRAINT IF EXISTS device_reliability_baselines_source_check;
ALTER TABLE device_reliability_baselines ADD CONSTRAINT device_reliability_baselines_source_check
  CHECK (source IN ('manual', 'bare_metal_recovery'));
ALTER TABLE device_reliability_baselines DROP CONSTRAINT IF EXISTS device_reliability_baselines_note_check;
ALTER TABLE device_reliability_baselines ADD CONSTRAINT device_reliability_baselines_note_check
  CHECK (NOT (reason = 'remediated' AND source = 'manual') OR (note IS NOT NULL AND length(btrim(note)) > 0));

ALTER TABLE device_reliability_baselines DROP CONSTRAINT IF EXISTS device_reliability_baselines_device_org_fkey;
ALTER TABLE device_reliability_baselines ADD CONSTRAINT device_reliability_baselines_device_org_fkey
  FOREIGN KEY (device_id, org_id) REFERENCES devices(id, org_id)
  ON UPDATE CASCADE ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE;

CREATE INDEX IF NOT EXISTS device_reliability_baselines_active_idx
  ON device_reliability_baselines (device_id, baseline_at DESC, created_at DESC) WHERE cleared_at IS NULL;
CREATE INDEX IF NOT EXISTS device_reliability_baselines_org_idx ON device_reliability_baselines (org_id);
CREATE UNIQUE INDEX IF NOT EXISTS device_reliability_baselines_source_ref_uq
  ON device_reliability_baselines (device_id, source_ref) WHERE source_ref IS NOT NULL;

ALTER TABLE device_reliability_baselines ENABLE ROW LEVEL SECURITY;
ALTER TABLE device_reliability_baselines FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS breeze_org_isolation_select ON device_reliability_baselines;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON device_reliability_baselines;
DROP POLICY IF EXISTS breeze_org_isolation_update ON device_reliability_baselines;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON device_reliability_baselines;
CREATE POLICY breeze_org_isolation_select ON device_reliability_baselines FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON device_reliability_baselines FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON device_reliability_baselines FOR UPDATE USING (public.breeze_has_org_access(org_id)) WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON device_reliability_baselines FOR DELETE USING (public.breeze_has_org_access(org_id));
GRANT SELECT, INSERT, UPDATE, DELETE, REFERENCES ON device_reliability_baselines TO breeze_app;
```

- [ ] **Step 4: Add the Drizzle schema**

In `apps/api/src/db/schema/reliability.ts`, add these imports:
- `text`, `foreignKey`, `check`, `uniqueIndex` to the existing `drizzle-orm/pg-core` import
- `import { sql } from 'drizzle-orm';`
- `import { users } from './users';`

Then append:

```ts
export const RELIABILITY_BASELINE_REASON_VALUES = ['reimaged', 'remediated', 'hardware_replaced'] as const;
export const RELIABILITY_BASELINE_SOURCE_VALUES = ['manual', 'bare_metal_recovery'] as const;

// #5876 baseline markers. SQL migration is authoritative for DEFERRABLE INITIALLY
// IMMEDIATE (Drizzle has no deferrability builder — same as device_time_daily).
export const deviceReliabilityBaselines = pgTable(
  'device_reliability_baselines',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    deviceId: uuid('device_id').notNull(),
    baselineAt: timestamp('baseline_at', { withTimezone: true }).notNull(),
    reason: text('reason').$type<(typeof RELIABILITY_BASELINE_REASON_VALUES)[number]>().notNull(),
    source: text('source').$type<(typeof RELIABILITY_BASELINE_SOURCE_VALUES)[number]>().notNull().default('manual'),
    sourceRef: uuid('source_ref'),
    note: text('note'),
    beforeSnapshot: jsonb('before_snapshot').$type<Record<string, unknown>>(),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    clearedAt: timestamp('cleared_at', { withTimezone: true }),
    clearedBy: uuid('cleared_by').references(() => users.id, { onDelete: 'set null' }),
  },
  (t) => [
    foreignKey({
      columns: [t.deviceId, t.orgId],
      foreignColumns: [devices.id, devices.orgId],
      name: 'device_reliability_baselines_device_org_fkey',
    }).onUpdate('cascade').onDelete('cascade'),
    index('device_reliability_baselines_active_idx')
      .on(t.deviceId, t.baselineAt.desc(), t.createdAt.desc())
      .where(sql`${t.clearedAt} IS NULL`),
    index('device_reliability_baselines_org_idx').on(t.orgId),
    uniqueIndex('device_reliability_baselines_source_ref_uq')
      .on(t.deviceId, t.sourceRef)
      .where(sql`${t.sourceRef} IS NOT NULL`),
    check('device_reliability_baselines_reason_check', sql`${t.reason} IN ('reimaged', 'remediated', 'hardware_replaced')`),
    check('device_reliability_baselines_source_check', sql`${t.source} IN ('manual', 'bare_metal_recovery')`),
    check(
      'device_reliability_baselines_note_check',
      sql`NOT (${t.reason} = 'remediated' AND ${t.source} = 'manual') OR (${t.note} IS NOT NULL AND length(btrim(${t.note})) > 0)`,
    ),
  ],
);

export type DeviceReliabilityBaselineRow = typeof deviceReliabilityBaselines.$inferSelect;
```

The existing tables in this file use the object-style `(table) => ({...})` callback. The array form above matches `timeSync.ts` and is valid in Drizzle 0.45. Keep both styles in the file and don't rewrite the existing tables.

- [ ] **Step 5: Register the table in all five lists**

1. `tenantCascade.ts` `CORE_ORG_CASCADE_DELETE_ORDER`: insert `'device_reliability_baselines',` between `'device_reliability',` and `'device_reliability_history',`.
2. `core.ts` `CORE_DEVICE_ORG_DENORMALIZED_TABLES`: change `'device_reliability', 'device_reliability_history',` to `'device_reliability', 'device_reliability_baselines', 'device_reliability_history',`.
3. `core.ts` `CORE_DEVICE_CASCADE_DELETE_TABLES`: change the `// Analytics & reliability` line to `'device_reliability_history', 'device_reliability_baselines', 'device_reliability',`.
4. `orgMergeRegistry.ts` `REPOINT_TABLES`: insert `"device_reliability_baselines",` between `"device_reliability",` and `"device_reliability_history",`.
5. `tenantExportPolicyRegistry.ts`: insert after the `"device_reliability"` entry:

```ts
  "device_reliability_baselines": tablePolicy("org_id", {"included":["id","org_id","device_id","baseline_at","reason","source","source_ref","note","created_by","created_at","cleared_at","cleared_by"],"reviewedIncluded":[],"excludedSensitive":[],"excludedOpen":["before_snapshot"]}),
```

Do **not** add the table to `DEVICE_ORG_FK_CASCADE_TABLES`. That list is pinned to four entries.

- [ ] **Step 6: Apply the migration and run the contract tests**

Run:
```bash
cd apps/api && DATABASE_URL=<test-stack url from .env.test> pnpm db:migrate && pnpm db:check-drift
npx vitest run --config vitest.integration.config.ts src/__tests__/integration/deviceReliabilityBaselinesRls.integration.test.ts src/__tests__/integration/tenantCascade.integration.test.ts
npx vitest run src/routes/devices/cascadeDelete.test.ts src/routes/devices/moveOrg.coverage.test.ts src/db/autoMigrate.test.ts src/db/migrationRlsScope.test.ts
cd .. && DB_CONTEXTLESS_WRITE_STRICT=true pnpm --filter=@breeze/api test:rls-coverage
```
Expected: all PASS.

If `db:check-drift` reports a difference on the partial or `DESC` index, keep the SQL shape. Adjust the Drizzle `index(...)` builder until the drift check is clean, and don't change the SQL to match Drizzle.

- [ ] **Step 7: Commit**

```bash
git add apps/api/migrations/2026-12-19-100000-device-reliability-baselines.sql apps/api/src/db/schema/reliability.ts \
  apps/api/src/services/tenantCascade.ts apps/api/src/routes/devices/core.ts apps/api/src/services/orgMergeRegistry.ts \
  apps/api/src/services/tenantExportPolicyRegistry.ts apps/api/src/__tests__/integration/deviceReliabilityBaselinesRls.integration.test.ts
git commit -m "feat(api): device_reliability_baselines table with RLS and cascade registration (#5876)"
```

---

### Task 2: Baseline policy module and the event-granularity cut

**Files:**
- Create: `apps/api/src/services/reliabilityBaselinePolicy.ts` (pure: no `db` import)
- Create: `apps/api/src/services/reliabilityBaselinePolicy.test.ts`
- Modify: `apps/api/src/services/reliabilityScoring.ts` (add `applyBaselineToRows`, expose via `reliabilityScoringInternals`)
- Test: `apps/api/src/services/reliabilityScoring.test.ts` (new `describe('applyBaselineToRows (#5876)')`)

**Interfaces:**
- Produces, from `reliabilityBaselinePolicy.ts`:
  - `RELIABILITY_BASELINE_REASONS`, `RELIABILITY_BASELINE_SOURCES`, plus the types `ReliabilityBaselineReason` and `ReliabilityBaselineSource`
  - Constants: `BASELINE_MAX_BACKDATE_DAYS = 30`, `BASELINE_FUTURE_SKEW_MS = 300000`, `BASELINE_PROVISIONAL_REPORTED_DAYS = 14`, `BASELINE_NOTE_MAX_LENGTH = 2000`, `RELIABILITY_SCORER_VERSION`
  - Types: `ActiveReliabilityBaseline = { id: string; baselineAt: Date; reason: ReliabilityBaselineReason; source: ReliabilityBaselineSource }`, `ReliabilityBaselineDetails`, `ReliabilityBeforeSnapshot`
  - Functions: `resolveBaselineAt(requested: Date | undefined, now: Date)`, `isNoteRequired(reason, source): boolean`, `readBaselineDetails(details: unknown): ReliabilityBaselineDetails | null`
  - `reliabilityBeforeSnapshotSchema` (zod)
- Produces, from `reliabilityScoring.ts` (internal): `applyBaselineToRows<T extends ScoringHistoryRow>(rows: T[], baselineAt: Date | null): T[]`

- [ ] **Step 1: Write the failing policy tests**

```ts
// apps/api/src/services/reliabilityBaselinePolicy.test.ts
import { describe, expect, it } from 'vitest';
import {
  BASELINE_FUTURE_SKEW_MS, isNoteRequired, readBaselineDetails, reliabilityBeforeSnapshotSchema, resolveBaselineAt,
} from './reliabilityBaselinePolicy';

const NOW = new Date('2026-10-09T12:00:00.000Z');
const DAY = 86_400_000;

describe('resolveBaselineAt', () => {
  it('defaults to now', () => {
    expect(resolveBaselineAt(undefined, NOW)).toEqual({ ok: true, baselineAt: NOW });
  });
  it('accepts exactly 30 days back and rejects one ms more', () => {
    expect(resolveBaselineAt(new Date(NOW.getTime() - 30 * DAY), NOW)).toEqual({ ok: true, baselineAt: new Date(NOW.getTime() - 30 * DAY) });
    expect(resolveBaselineAt(new Date(NOW.getTime() - 30 * DAY - 1), NOW)).toEqual({ ok: false, error: 'baseline_too_old' });
  });
  it('clamps small future skew to now and rejects beyond it', () => {
    expect(resolveBaselineAt(new Date(NOW.getTime() + BASELINE_FUTURE_SKEW_MS), NOW)).toEqual({ ok: true, baselineAt: NOW });
    expect(resolveBaselineAt(new Date(NOW.getTime() + BASELINE_FUTURE_SKEW_MS + 1), NOW)).toEqual({ ok: false, error: 'baseline_in_future' });
  });
});

describe('isNoteRequired', () => {
  it('only for manual remediated markers', () => {
    expect(isNoteRequired('remediated', 'manual')).toBe(true);
    expect(isNoteRequired('remediated', 'bare_metal_recovery')).toBe(false);
    expect(isNoteRequired('reimaged', 'manual')).toBe(false);
    expect(isNoteRequired('hardware_replaced', 'manual')).toBe(false);
  });
});

describe('readBaselineDetails', () => {
  it('parses a well-formed details.baseline block', () => {
    const parsed = readBaselineDetails({ baseline: {
      id: '7f4b1c9e-0000-4000-8000-000000000001', baselineAt: '2026-10-01T00:00:00.000Z', reason: 'remediated',
      source: 'manual', reportedDaysSinceBaseline: 4, provisional: true,
    } });
    expect(parsed).toEqual({
      id: '7f4b1c9e-0000-4000-8000-000000000001', baselineAt: '2026-10-01T00:00:00.000Z', reason: 'remediated',
      source: 'manual', reportedDaysSinceBaseline: 4, provisional: true,
    });
  });
  it('returns null for missing or malformed blocks', () => {
    expect(readBaselineDetails({})).toBeNull();
    expect(readBaselineDetails(null)).toBeNull();
    expect(readBaselineDetails({ baseline: { id: 'x', reason: 'bogus' } })).toBeNull();
  });
});

describe('reliabilityBeforeSnapshotSchema', () => {
  it('accepts the v1 shape', () => {
    expect(reliabilityBeforeSnapshotSchema.safeParse({
      version: 1, scorerVersion: '2026-10-09.1', asOf: '2026-10-01T00:00:00.000Z', coverageDays: 42,
      reliabilityScore: 41, weightProfile: 'workstation',
      factors: { uptime: { score: 100 }, crashes: { score: 20 }, hangs: { score: 90 }, serviceFailures: { score: 60 }, hardwareErrors: { score: 100 } },
      counts30d: { crashes: 6, hangs: 1, serviceFailures: 4, hardwareErrors: 0 },
    }).success).toBe(true);
  });
});
```

- [ ] **Step 2: Write the failing cut test** (append to `reliabilityScoring.test.ts`, reusing its existing `makeHistoryRow`)

```ts
describe('applyBaselineToRows (#5876)', () => {
  const baselineAt = new Date('2026-02-20T12:00:00.000Z');
  it('drops rows collected before the marker entirely', () => {
    const rows = [
      makeHistoryRow({ collectedAt: new Date('2026-02-20T11:59:59.000Z'), crashEvents: [{ type: 'bsod', timestamp: '2026-02-20T11:00:00.000Z' }] }),
      makeHistoryRow({ collectedAt: new Date('2026-02-21T10:00:00.000Z') }),
    ];
    const out = reliabilityScoringInternals.applyBaselineToRows(rows as any, baselineAt);
    expect(out).toHaveLength(1);
    expect(out[0]!.collectedAt.toISOString()).toBe('2026-02-21T10:00:00.000Z');
  });
  it('drops pre-marker events carried in a post-marker row and keeps post-marker events', () => {
    const rows = [makeHistoryRow({
      collectedAt: new Date('2026-02-21T10:00:00.000Z'),
      crashEvents: [
        { type: 'bsod', timestamp: '2026-02-20T09:00:00.000Z' },
        { type: 'bsod', timestamp: '2026-02-21T09:00:00.000Z' },
      ],
      appHangs: [{ processName: 'a', timestamp: '2026-02-20T11:00:00.000Z', duration: 5, resolved: true }],
      serviceFailures: [{ serviceName: 's', timestamp: '2026-02-20T13:00:00.000Z', recovered: false }],
      hardwareErrors: [{ type: 'disk', severity: 'error', source: 'disk', timestamp: '2026-02-19T00:00:00.000Z' }],
    })];
    const [row] = reliabilityScoringInternals.applyBaselineToRows(rows as any, baselineAt);
    expect(row!.crashEvents.map((e: any) => e.timestamp)).toEqual(['2026-02-21T09:00:00.000Z']);
    expect(row!.appHangs).toEqual([]);
    expect(row!.serviceFailures).toHaveLength(1);
    expect(row!.hardwareErrors).toEqual([]);
  });
  it('falls back to collectedAt for events with a missing or unparseable timestamp', () => {
    const rows = [makeHistoryRow({ collectedAt: new Date('2026-02-21T10:00:00.000Z'), crashEvents: [{ type: 'bsod' }, { type: 'bsod', timestamp: 'garbage' }] })];
    const [row] = reliabilityScoringInternals.applyBaselineToRows(rows as any, baselineAt);
    expect(row!.crashEvents).toHaveLength(2);
  });
  it('is the identity when there is no marker', () => {
    const rows = [makeHistoryRow({})];
    expect(reliabilityScoringInternals.applyBaselineToRows(rows as any, null)).toBe(rows);
  });
});
```

- [ ] **Step 3: Run both test files to verify they fail**

Run: `cd apps/api && npx vitest run src/services/reliabilityBaselinePolicy.test.ts src/services/reliabilityScoring.test.ts`
Expected: FAIL. The module is not found, and `applyBaselineToRows` is undefined.

- [ ] **Step 4: Implement `reliabilityBaselinePolicy.ts`**

```ts
import { z } from 'zod';

// #5876 reliability baseline markers — pure policy (no db import; shared by the
// scorer, the baseline service and the routes without import cycles).
export const RELIABILITY_BASELINE_REASONS = ['reimaged', 'remediated', 'hardware_replaced'] as const;
export type ReliabilityBaselineReason = (typeof RELIABILITY_BASELINE_REASONS)[number];
export const RELIABILITY_BASELINE_SOURCES = ['manual', 'bare_metal_recovery'] as const;
export type ReliabilityBaselineSource = (typeof RELIABILITY_BASELINE_SOURCES)[number];

export const BASELINE_MAX_BACKDATE_DAYS = 30;
export const BASELINE_FUTURE_SKEW_MS = 5 * 60 * 1000;
export const BASELINE_PROVISIONAL_REPORTED_DAYS = 14;
export const BASELINE_NOTE_MAX_LENGTH = 2000;
/** Bump whenever the scoring math changes so frozen before-snapshots stay interpretable. */
export const RELIABILITY_SCORER_VERSION = '2026-10-09.1';

const DAY_MS = 24 * 60 * 60 * 1000;

export interface ActiveReliabilityBaseline {
  id: string;
  baselineAt: Date;
  reason: ReliabilityBaselineReason;
  source: ReliabilityBaselineSource;
}

/** Persisted on device_reliability.details.baseline by the scorer. */
export interface ReliabilityBaselineDetails {
  id: string;
  baselineAt: string;
  reason: ReliabilityBaselineReason;
  source: ReliabilityBaselineSource;
  reportedDaysSinceBaseline: number;
  provisional: boolean;
}

export type ResolveBaselineAtResult =
  | { ok: true; baselineAt: Date }
  | { ok: false; error: 'baseline_in_future' | 'baseline_too_old' };

/** Server-side marker time: default now, ≤30d back, ≤5min skew forward (clamped to now). */
export function resolveBaselineAt(requested: Date | undefined, now: Date): ResolveBaselineAtResult {
  if (!requested) return { ok: true, baselineAt: now };
  const ms = requested.getTime();
  if (ms > now.getTime() + BASELINE_FUTURE_SKEW_MS) return { ok: false, error: 'baseline_in_future' };
  if (ms < now.getTime() - BASELINE_MAX_BACKDATE_DAYS * DAY_MS) return { ok: false, error: 'baseline_too_old' };
  return { ok: true, baselineAt: new Date(Math.min(ms, now.getTime())) };
}

export function isNoteRequired(reason: ReliabilityBaselineReason, source: ReliabilityBaselineSource): boolean {
  return reason === 'remediated' && source === 'manual';
}

const baselineDetailsSchema = z.object({
  id: z.string().min(1),
  baselineAt: z.string().datetime(),
  reason: z.enum(RELIABILITY_BASELINE_REASONS),
  source: z.enum(RELIABILITY_BASELINE_SOURCES),
  reportedDaysSinceBaseline: z.number().int().min(0),
  provisional: z.boolean(),
});

export function readBaselineDetails(details: unknown): ReliabilityBaselineDetails | null {
  if (!details || typeof details !== 'object') return null;
  const parsed = baselineDetailsSchema.safeParse((details as Record<string, unknown>).baseline);
  return parsed.success ? parsed.data : null;
}

const factorScore = z.object({ score: z.number() });
export const reliabilityBeforeSnapshotSchema = z.object({
  version: z.literal(1),
  scorerVersion: z.string(),
  asOf: z.string().datetime(),
  coverageDays: z.number().int().min(0).max(90),
  reliabilityScore: z.number(),
  weightProfile: z.enum(['workstation', 'infra']),
  factors: z.object({
    uptime: factorScore, crashes: factorScore, hangs: factorScore, serviceFailures: factorScore, hardwareErrors: factorScore,
  }),
  counts30d: z.object({
    crashes: z.number().int(), hangs: z.number().int(), serviceFailures: z.number().int(), hardwareErrors: z.number().int(),
  }),
});
export type ReliabilityBeforeSnapshot = z.infer<typeof reliabilityBeforeSnapshotSchema>;
```

Check the weight-profile names before relying on the enum: `grep -an "name: '" apps/api/src/services/reliabilityScoring.ts` near `resolveWeightProfile` (L85). If they differ from `'workstation' | 'infra'`, use the real names in the enum.

- [ ] **Step 5: Implement `applyBaselineToRows` in `reliabilityScoring.ts`**

Add it next to `eventDayKey` (~L928), then add `applyBaselineToRows,` to `reliabilityScoringInternals`.

```ts
function eventTimestampMs(eventTimestamp: string | undefined, fallback: Date): number {
  if (eventTimestamp) {
    const ms = Date.parse(eventTimestamp);
    if (!Number.isNaN(ms)) return ms;
  }
  return fallback.getTime();
}

/**
 * #5876 baseline cut, at EVENT granularity. Rows collected before the marker are
 * dropped whole (their samples must not count as observed days). Inside rows
 * collected at/after it, events whose own timestamp precedes the marker are
 * dropped — the agent posts ~every 24h, so a post-marker row can carry
 * pre-marker events. Events without a parseable timestamp fall back to the
 * row's collectedAt, matching eventDayKey().
 */
function applyBaselineToRows<T extends ScoringHistoryRow>(rows: T[], baselineAt: Date | null): T[] {
  if (!baselineAt) return rows;
  const cutMs = baselineAt.getTime();
  return rows
    .filter((row) => row.collectedAt.getTime() >= cutMs)
    .map((row) => {
      const keep = <E extends { timestamp?: string }>(events: E[]): E[] =>
        events.filter((event) => eventTimestampMs(event.timestamp, row.collectedAt) >= cutMs);
      return {
        ...row,
        crashEvents: keep(row.crashEvents),
        appHangs: keep(row.appHangs),
        serviceFailures: keep(row.serviceFailures),
        hardwareErrors: keep(row.hardwareErrors),
      };
    });
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd apps/api && npx vitest run src/services/reliabilityBaselinePolicy.test.ts src/services/reliabilityScoring.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/services/reliabilityBaselinePolicy.ts apps/api/src/services/reliabilityBaselinePolicy.test.ts \
  apps/api/src/services/reliabilityScoring.ts apps/api/src/services/reliabilityScoring.test.ts
git commit -m "feat(api): reliability baseline policy and event-granularity cut (#5876)"
```

---

### Task 3: Pure scorer `scoreDeviceReliability` (windowEnd + baseline)

**Files:**
- Modify: `apps/api/src/services/reliabilityScoring.ts`
- Test: `apps/api/src/services/reliabilityScoring.baseline.test.ts` (new file)

**Interfaces:**
- Consumes: `applyBaselineToRows` (Task 2), and `ActiveReliabilityBaseline`, `BASELINE_PROVISIONAL_REPORTED_DAYS`, `ReliabilityBaselineDetails` (Task 2).
- Produces:
  ```ts
  export type ReliabilityScoreValues = Omit<typeof deviceReliability.$inferInsert, 'deviceId' | 'orgId'>;
  export interface ReliabilityScoringInput {
    rows: ScoringHistoryRow[];               // bounded to [windowEnd-90d, windowEnd]
    latest: LatestHistorySnapshot | null;    // latest sample with collectedAt <= windowEnd
    deviceRole: string | null;
    enrolledAt: Date | null;
    windowEnd: Date;
    baseline: ActiveReliabilityBaseline | null;
  }
  export interface ReliabilityScoringResult { values: ReliabilityScoreValues; coverageDays: number; weightProfile: string }
  export function scoreDeviceReliability(input: ReliabilityScoringInput): ReliabilityScoringResult;
  export async function scoreDeviceReliabilityAsOf(
    device: { id: string; deviceRole: string | null; enrolledAt: Date | null },
    windowEnd: Date,
    baseline: ActiveReliabilityBaseline | null,
  ): Promise<ReliabilityScoringResult>;
  ```
  Also exports the `ScoringHistoryRow` and `LatestHistorySnapshot` types. Changes `getHistoryForDevice(deviceId, days, windowEnd = new Date())` and `getLatestHistoryForDevice(deviceId, windowEnd = new Date())` to be upper-bounded.

- [ ] **Step 1: Write the failing tests**

```ts
// apps/api/src/services/reliabilityScoring.baseline.test.ts
import { describe, expect, it, vi } from 'vitest';

vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: {},
}));

import { reliabilityScoringInternals as I, scoreDeviceReliability } from './reliabilityScoring';

const DAY = 86_400_000;
const windowEnd = new Date('2026-03-31T12:00:00.000Z');
const at = (daysAgo: number, hour = 10) => new Date(windowEnd.getTime() - daysAgo * DAY - (12 - hour) * 3_600_000);

/** One sample per day for `days` days ending at windowEnd; boot = 1h before each sample. */
function dailyRows(days: number, extra: (daysAgo: number) => Record<string, unknown> = () => ({})) {
  return Array.from({ length: days }, (_, i) => {
    const daysAgo = days - 1 - i;
    const collectedAt = at(daysAgo);
    return {
      collectedAt, uptimeSeconds: 3600, bootTime: new Date(collectedAt.getTime() - 3_600_000),
      crashEvents: [], appHangs: [], serviceFailures: [], hardwareErrors: [], ...extra(daysAgo),
    };
  });
}
const crashAt = (daysAgo: number) => ({ crashEvents: [{ type: 'bsod', timestamp: at(daysAgo, 9).toISOString() }] });
const baseInput = { latest: null, deviceRole: 'workstation', enrolledAt: new Date('2025-01-01T00:00:00.000Z'), windowEnd };
const marker = (daysAgo: number) => ({ id: 'b-1', baselineAt: at(daysAgo, 0), reason: 'remediated' as const, source: 'manual' as const });

describe('scoreDeviceReliability (#5876)', () => {
  it('without a marker scores a crash exactly as the factor scorer does', () => {
    const rows = dailyRows(30, (d) => (d === 3 ? crashAt(3) : {}));
    const { values } = scoreDeviceReliability({ ...baseInput, rows: rows as any, baseline: null });
    expect(values.crashCount30d).toBe(1);
    expect(values.crashScore).toBe(I.scoreCrashes(I.effectiveCrashLoad(1, 0), I.effectiveCrashLoad(1, 0), 30));
    expect(values.computedAt).toEqual(windowEnd);
    expect((values.details as any).baseline).toBeUndefined();
  });

  it('ignores a crash before the marker and reports provisional, stable trend, no MTBF', () => {
    const rows = dailyRows(30, (d) => (d === 10 ? crashAt(10) : {}));
    const { values } = scoreDeviceReliability({ ...baseInput, rows: rows as any, baseline: marker(5) });
    expect(values.crashCount30d).toBe(0);
    expect(values.crashScore).toBe(100);
    expect(values.trendDirection).toBe('stable');
    expect(values.trendConfidence).toBe(0);
    expect(values.mtbfHours).toBeNull();
    expect((values.details as any).baseline).toMatchObject({ id: 'b-1', provisional: true, reportedDaysSinceBaseline: 6 });
  });

  it('counts a post-marker crash against the 14-day rate floor, not the full 30 days', () => {
    const rows = dailyRows(30, (d) => (d === 2 ? crashAt(2) : {}));
    const { values } = scoreDeviceReliability({ ...baseInput, rows: rows as any, baseline: marker(5) });
    expect(values.crashCount30d).toBe(1);
    expect(values.crashScore).toBe(I.scoreCrashes(1, 1, 6)); // floor lifts denom 6 → 14 inside the scorer
    expect(values.crashScore).toBeLessThan(I.scoreCrashes(1, 1, 30));
  });

  it('matures after 14 reported days since the marker', () => {
    const rows = dailyRows(30);
    const { values } = scoreDeviceReliability({ ...baseInput, rows: rows as any, baseline: marker(20) });
    expect((values.details as any).baseline).toMatchObject({ provisional: false, reportedDaysSinceBaseline: 21 });
  });

  it('does not mature a device that went silent after the fix, even inside a long boot span', () => {
    // Two samples right after the marker; the second claims a boot 25 days ago that spans "now".
    const rows = [
      { collectedAt: at(19), uptimeSeconds: 3600, bootTime: at(25), crashEvents: [], appHangs: [], serviceFailures: [], hardwareErrors: [] },
      { collectedAt: at(18), uptimeSeconds: 7200, bootTime: at(25), crashEvents: [], appHangs: [], serviceFailures: [], hardwareErrors: [] },
    ];
    const latest = { collectedAt: at(18), uptimeSeconds: 7200, bootTime: at(25) };
    const { values } = scoreDeviceReliability({ ...baseInput, latest, rows: rows as any, baseline: marker(20) });
    expect((values.details as any).baseline).toMatchObject({ provisional: true, reportedDaysSinceBaseline: 2 });
  });

  it('bounds coverageDays by the rows actually available', () => {
    const { coverageDays } = scoreDeviceReliability({ ...baseInput, rows: dailyRows(10) as any, baseline: null });
    expect(coverageDays).toBe(10);
    expect(scoreDeviceReliability({ ...baseInput, rows: [], baseline: null }).coverageDays).toBe(0);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/api && npx vitest run src/services/reliabilityScoring.baseline.test.ts`
Expected: FAIL. `scoreDeviceReliability` is not exported.

- [ ] **Step 3: Extract the pure scorer**

In `reliabilityScoring.ts`:

1. Export the types: change `type ScoringHistoryRow` to `export type ScoringHistoryRow`, and `type LatestHistorySnapshot` to `export type LatestHistorySnapshot`.
2. Bound the two history queries:

```ts
async function getHistoryForDevice(deviceId: string, days: number, windowEnd: Date = new Date()): Promise<ScoringHistoryRow[]> {
  const since = new Date(windowEnd.getTime() - days * DAY_MS);
  // (keep the existing #event-loop-hardening comment block verbatim here)
  return db
    .select(SCORING_HISTORY_COLUMNS)
    .from(deviceReliabilityHistory)
    .where(and(
      eq(deviceReliabilityHistory.deviceId, deviceId),
      gte(deviceReliabilityHistory.collectedAt, since),
      lte(deviceReliabilityHistory.collectedAt, windowEnd),
    ))
    .orderBy(asc(deviceReliabilityHistory.collectedAt));
}

async function getLatestHistoryForDevice(deviceId: string, windowEnd: Date = new Date()): Promise<LatestHistorySnapshot | null> {
  const [row] = await db
    .select({
      collectedAt: deviceReliabilityHistory.collectedAt,
      uptimeSeconds: deviceReliabilityHistory.uptimeSeconds,
      bootTime: deviceReliabilityHistory.bootTime,
    })
    .from(deviceReliabilityHistory)
    .where(and(eq(deviceReliabilityHistory.deviceId, deviceId), lte(deviceReliabilityHistory.collectedAt, windowEnd)))
    .orderBy(desc(deviceReliabilityHistory.collectedAt))
    .limit(1);
  return row ?? null;
}
```

   Add `lte` to the `drizzle-orm` import.

3. Add the types and `scoreDeviceReliability`, made of the body of today's `computeAndPersistDeviceReliability` from `const now = new Date()` (L1416) through `detailsPayload` (L1561), with these exact substitutions:
   - `now` becomes `input.windowEnd`.
   - `lookbackStart = getSince(90)` becomes `new Date(windowEnd.getTime() - 90 * DAY_MS)`.
   - `allRows` becomes `applyBaselineToRows(input.rows, baselineAt)`.
   - The `enrolledAt` argument of every `computeUptimePercent` / `computeUptimeAvailability` call becomes `windowFloor` (below).
   - `bootSpanUpDayKeys(allRows, lookbackStart, now)` becomes `bootSpanUpDayKeys(rows, spanStart, windowEnd)`.

```ts
export type ReliabilityScoreValues = Omit<typeof deviceReliability.$inferInsert, 'deviceId' | 'orgId'>;

export interface ReliabilityScoringInput {
  rows: ScoringHistoryRow[];
  latest: LatestHistorySnapshot | null;
  deviceRole: string | null;
  enrolledAt: Date | null;
  windowEnd: Date;
  baseline: ActiveReliabilityBaseline | null;
}

export interface ReliabilityScoringResult {
  values: ReliabilityScoreValues;
  /** Whole days between the earliest scored sample and windowEnd (0–90). */
  coverageDays: number;
  weightProfile: string;
}

function laterOf(a: Date | null, b: Date | null): Date | null {
  if (!a) return b;
  if (!b) return a;
  return a.getTime() >= b.getTime() ? a : b;
}

/**
 * Pure reliability scorer (#5876). Everything time-relative keys off
 * `windowEnd` (no wall clock), so the same function produces the live score
 * (windowEnd = now) and a frozen as-of snapshot (windowEnd = baseline_at).
 * A baseline cuts events at event granularity (applyBaselineToRows) and
 * clamps every window start, generalising the #1738 enrolledAt clamp.
 */
export function scoreDeviceReliability(input: ReliabilityScoringInput): ReliabilityScoringResult {
  const { windowEnd, baseline } = input;
  const baselineAt = baseline?.baselineAt ?? null;
  const lookbackStart = new Date(windowEnd.getTime() - 90 * DAY_MS);
  const rows = applyBaselineToRows(input.rows, baselineAt);
  const windowFloor = laterOf(input.enrolledAt, baselineAt);
  const spanStart = laterOf(lookbackStart, baselineAt)!;

  const dailyBucketMap = new Map<string, DailyAggregateBucket>();
  mergeRowsIntoDailyBuckets(dailyBucketMap, rows);
  pruneDailyBuckets(dailyBucketMap, lookbackStart, windowEnd);
  const dailyBuckets = sortDailyBuckets(dailyBucketMap);

  const observedDays = observedUpDayKeys(dailyBuckets);
  for (const key of bootSpanUpDayKeys(rows, spanStart, windowEnd)) observedDays.add(key);
  const observedUpDays30 = countObservedUpDaysInWindow(dailyBuckets, 30, windowEnd);
  // A latest sample collected before the marker would credit pre-marker boot days as up.
  const latest = baselineAt && input.latest && input.latest.collectedAt.getTime() < baselineAt.getTime() ? null : input.latest;
  const uptime7d = computeUptimePercent(latest, observedDays, 7, windowEnd, windowFloor);
  const uptime30d = computeUptimePercent(latest, observedDays, 30, windowEnd, windowFloor);
  const availability90d = computeUptimeAvailability(latest, observedDays, 90, windowEnd, windowFloor);
  const uptime90d = availability90d.percent;

  // ── moved verbatim from computeAndPersistDeviceReliability (L1447-1505) ──
  // the 20 sumBucketsInWindow(...) counts, the five factor scores, resolveWeightProfile,
  // reliabilityScore, trend, mtbfHours, topIssues — replacing `now` with `windowEnd`
  // and `device.deviceRole` with `input.deviceRole`.

  const reportedDaysSinceBaseline = new Set(rows.map((row) => toDayKey(row.collectedAt))).size;
  const provisional = baseline !== null && reportedDaysSinceBaseline < BASELINE_PROVISIONAL_REPORTED_DAYS;
  const finalTrend = provisional ? { direction: 'stable' as const, confidence: 0 } : trend;
  const finalMtbfHours = provisional ? null : mtbfHours;

  const latestProcessedAt = maxTimestamp([
    getLatestCollectedAt(rows)?.toISOString(),
    latest?.collectedAt.toISOString(),
  ]) ?? windowEnd.toISOString();

  const baselineDetails: ReliabilityBaselineDetails | undefined = baseline
    ? {
        id: baseline.id,
        baselineAt: baseline.baselineAt.toISOString(),
        reason: baseline.reason,
        source: baseline.source,
        reportedDaysSinceBaseline,
        provisional,
      }
    : undefined;

  const detailsPayload = {
    // (keep weightProfile / factors / aggregates exactly as today)
    ...(baselineDetails ? { baseline: baselineDetails } : {}),
  };

  const earliest = rows.length > 0 ? rows[0]!.collectedAt.getTime() : null;
  const coverageDays = earliest === null ? 0 : Math.min(90, Math.max(1, Math.ceil((windowEnd.getTime() - earliest) / DAY_MS)));

  return {
    weightProfile,
    coverageDays,
    values: {
      computedAt: windowEnd,
      reliabilityScore, uptimeScore, crashScore, hangScore, serviceFailureScore, hardwareErrorScore,
      uptime7d, uptime30d, uptime90d,
      crashCount7d, crashCount30d, crashCount90d, hangCount7d, hangCount30d,
      serviceFailureCount7d, serviceFailureCount30d, hardwareErrorCount7d, hardwareErrorCount30d,
      mtbfHours: finalMtbfHours,
      trendDirection: finalTrend.direction,
      trendConfidence: finalTrend.confidence,
      topIssues,
      details: detailsPayload,
    },
  };
}

export async function scoreDeviceReliabilityAsOf(
  device: { id: string; deviceRole: string | null; enrolledAt: Date | null },
  windowEnd: Date,
  baseline: ActiveReliabilityBaseline | null,
): Promise<ReliabilityScoringResult> {
  const [rows, latest] = await Promise.all([
    getHistoryForDevice(device.id, 90, windowEnd),
    getLatestHistoryForDevice(device.id, windowEnd),
  ]);
  return scoreDeviceReliability({ rows, latest, deviceRole: device.deviceRole, enrolledAt: device.enrolledAt, windowEnd, baseline });
}
```

   The `rows` arrive sorted ascending, so `rows[0]` is the earliest.

   Check `buildDailyTrendPoints(dailyBuckets, days = 30, now = new Date())`: `computeTrend` already passes `now` explicitly, but grep `buildDailyTrendPoints(` and make sure no caller relies on the default.

   Import from `./reliabilityBaselinePolicy`: `ActiveReliabilityBaseline`, `ReliabilityBaselineDetails`, `BASELINE_PROVISIONAL_REPORTED_DAYS`.

4. Rewrite `computeAndPersistDeviceReliability` to use the pure scorer. There is no baseline yet; Task 4 wires that in.

```ts
export async function computeAndPersistDeviceReliability(deviceId: string): Promise<boolean> {
  const [device] = await db
    .select({ id: devices.id, orgId: devices.orgId, enrolledAt: devices.enrolledAt, deviceRole: devices.deviceRole })
    .from(devices)
    .where(eq(devices.id, deviceId))
    .limit(1);
  if (!device) return false;
  if (!(await shouldProduceMlOutput(device.orgId, 'ml.device_reliability.enabled'))) return false;

  const { values } = await scoreDeviceReliabilityAsOf(
    { id: device.id, deviceRole: device.deviceRole, enrolledAt: device.enrolledAt ?? null },
    new Date(),
    null,
  );
  await db
    .insert(deviceReliability)
    .values({ deviceId: device.id, orgId: device.orgId, ...values })
    .onConflictDoUpdate({ target: deviceReliability.deviceId, set: { orgId: device.orgId, ...values } });
  return true;
}
```

   Keep the existing #1904 comment block (explaining the full rebuild from raw rows) above the `scoreDeviceReliabilityAsOf` call.

- [ ] **Step 4: Run the new and existing scorer tests**

Run:
```bash
cd apps/api && npx vitest run src/services/reliabilityScoring.baseline.test.ts src/services/reliabilityScoring.test.ts \
  src/services/reliabilityScoring.featureFlag.test.ts src/services/reliabilityScoring.listFilter.test.ts \
  src/services/reliabilityScoring.evaluationSiteScope.test.ts src/jobs/reliabilityWorker.test.ts src/routes/agents/reliability.test.ts
```
Expected: PASS.

If `featureFlag.test.ts` breaks, it is because its `db.select` chain mock lacks `orderBy`, or `lte` is now in the history query. Extend that mock's chain to return `{ orderBy: vi.fn(() => Promise.resolve([])), limit }` from `where`. Do not weaken its assertions.

Then run the end-to-end refactor guard against a real DB:
`npx vitest run --config vitest.integration.config.ts src/__tests__/integration/reliabilityWeightProfile.integration.test.ts src/__tests__/integration/reliabilityScoringProjection.integration.test.ts`
Expected: PASS, unchanged.

- [ ] **Step 5: Typecheck and commit**

Run: `cd apps/api && npx tsc --noEmit -p tsconfig.json; echo EXIT=$?`. Expected `EXIT=0`. Don't pipe it to `tail`, which hides a heap OOM.

```bash
git add apps/api/src/services/reliabilityScoring.ts apps/api/src/services/reliabilityScoring.baseline.test.ts apps/api/src/services/reliabilityScoring.featureFlag.test.ts
git commit -m "refactor(api): pure windowEnd/baseline-aware reliability scorer (#5876)"
```

---

### Task 4: Active-marker query and compare-and-set persist

**Files:**
- Create: `apps/api/src/services/reliabilityBaselineQueries.ts`
- Modify: `apps/api/src/services/reliabilityScoring.ts` (`computeAndPersistDeviceReliability`)
- Test: `apps/api/src/services/reliabilityBaselineQueries.test.ts`

**Interfaces:**
- Consumes: `deviceReliabilityBaselines` (Task 1), `ActiveReliabilityBaseline` (Task 2), `scoreDeviceReliabilityAsOf` (Task 3).
- Produces:
  - `getActiveReliabilityBaseline(deviceId: string, opts?: { atOrBefore?: Date }): Promise<ActiveReliabilityBaseline | null>`
  - `activeBaselineIdSql(deviceId: string): SQL` (scalar subquery returning the active marker id or NULL)
  - `reliabilityProvisionalSql: SQL<boolean>` (reads `device_reliability.details->'baseline'->>'provisional'`)
  - `persistDeviceReliability(device: { id: string; orgId: string }, values: ReliabilityScoreValues, baselineIdUsed: string | null): Promise<void>`, exported from `reliabilityScoring.ts`

- [ ] **Step 1: Write the failing test for the SQL shapes**

```ts
// apps/api/src/services/reliabilityBaselineQueries.test.ts
import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../db', () => ({ db: {} }));

import { activeBaselineIdSql, reliabilityProvisionalSql } from './reliabilityBaselineQueries';

const dialect = new PgDialect();
const render = (q: Parameters<PgDialect['sqlToQuery']>[0]) => dialect.sqlToQuery(q);

describe('reliabilityBaselineQueries', () => {
  it('picks the active marker with the canonical ordering', () => {
    const { sql, params } = render(activeBaselineIdSql('dev-1'));
    expect(sql.toLowerCase()).toContain('cleared_at" is null');
    expect(sql.replace(/\s+/g, ' ')).toMatch(/order by .*baseline_at" desc, .*created_at" desc, .*"id" desc limit 1/i);
    expect(params).toContain('dev-1');
  });
  it('reads provisional from details.baseline, defaulting to false', () => {
    const { sql } = render(reliabilityProvisionalSql);
    expect(sql).toContain(`->'baseline'->>'provisional'`);
    expect(sql.toLowerCase()).toContain('coalesce');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/api && npx vitest run src/services/reliabilityBaselineQueries.test.ts`
Expected: FAIL. The module is not found.

- [ ] **Step 3: Implement the queries module**

```ts
// apps/api/src/services/reliabilityBaselineQueries.ts
import { and, desc, eq, isNull, lte, sql, type SQL } from 'drizzle-orm';
import { db } from '../db';
import { deviceReliability, deviceReliabilityBaselines } from '../db/schema';
import type { ActiveReliabilityBaseline } from './reliabilityBaselinePolicy';

// #5876. The ONE ordering that defines "the active marker". Every reader and the
// compare-and-set guard must use it, or a tie on baseline_at could make the guard
// disagree with the scorer.
const ACTIVE_ORDER = [
  desc(deviceReliabilityBaselines.baselineAt),
  desc(deviceReliabilityBaselines.createdAt),
  desc(deviceReliabilityBaselines.id),
] as const;

export async function getActiveReliabilityBaseline(
  deviceId: string,
  opts: { atOrBefore?: Date } = {},
): Promise<ActiveReliabilityBaseline | null> {
  const conditions = [eq(deviceReliabilityBaselines.deviceId, deviceId), isNull(deviceReliabilityBaselines.clearedAt)];
  if (opts.atOrBefore) conditions.push(lte(deviceReliabilityBaselines.baselineAt, opts.atOrBefore));
  const [row] = await db
    .select({
      id: deviceReliabilityBaselines.id,
      baselineAt: deviceReliabilityBaselines.baselineAt,
      reason: deviceReliabilityBaselines.reason,
      source: deviceReliabilityBaselines.source,
    })
    .from(deviceReliabilityBaselines)
    .where(and(...conditions))
    .orderBy(...ACTIVE_ORDER)
    .limit(1);
  return row ?? null;
}

export function activeBaselineIdSql(deviceId: string): SQL {
  return sql`(SELECT ${deviceReliabilityBaselines.id} FROM ${deviceReliabilityBaselines}
    WHERE ${deviceReliabilityBaselines.deviceId} = ${deviceId} AND ${deviceReliabilityBaselines.clearedAt} IS NULL
    ORDER BY ${deviceReliabilityBaselines.baselineAt} DESC, ${deviceReliabilityBaselines.createdAt} DESC, ${deviceReliabilityBaselines.id} DESC
    LIMIT 1)`;
}

export const reliabilityProvisionalSql: SQL<boolean> =
  sql<boolean>`coalesce((${deviceReliability.details}->'baseline'->>'provisional')::boolean, false)`;
```

- [ ] **Step 4: Wire the marker and the guard into `computeAndPersistDeviceReliability`**

```ts
export async function persistDeviceReliability(
  device: { id: string; orgId: string },
  values: ReliabilityScoreValues,
  baselineIdUsed: string | null,
): Promise<void> {
  // #5876 compare-and-set: only overwrite when the marker this run scored against
  // is still the active one. A worker run that loaded the old marker and finishes
  // after a marker change commits is skipped; the marker route's own recompute
  // wins. INSERT (first-ever row) is unguarded by design — see spec "Concurrency".
  await db
    .insert(deviceReliability)
    .values({ deviceId: device.id, orgId: device.orgId, ...values })
    .onConflictDoUpdate({
      target: deviceReliability.deviceId,
      set: { orgId: device.orgId, ...values },
      setWhere: sql`${activeBaselineIdSql(device.id)} IS NOT DISTINCT FROM ${baselineIdUsed}::uuid`,
    });
}
```

In `computeAndPersistDeviceReliability`, replace the `scoreDeviceReliabilityAsOf(..., null)` call and the upsert with:

```ts
  const windowEnd = new Date();
  const baseline = await getActiveReliabilityBaseline(device.id);
  const { values } = await scoreDeviceReliabilityAsOf(
    { id: device.id, deviceRole: device.deviceRole, enrolledAt: device.enrolledAt ?? null },
    windowEnd,
    baseline,
  );
  await persistDeviceReliability(device, values, baseline?.id ?? null);
  return true;
```

Drizzle 0.45 accepts `setWhere` on `onConflictDoUpdate`. If tsc rejects it, use `where` (the older name for the same clause).

- [ ] **Step 5: Run the tests, then commit**

Run: `cd apps/api && npx vitest run src/services/reliabilityBaselineQueries.test.ts src/services/reliabilityScoring` (substring match on purpose, so it runs all five scorer files; check the reported file count is 5 or more), then `npx tsc --noEmit -p tsconfig.json; echo EXIT=$?`.
Expected: PASS and `EXIT=0`.

The real-DB behaviour of the guard is pinned in Task 5's integration test.

```bash
git add apps/api/src/services/reliabilityBaselineQueries.ts apps/api/src/services/reliabilityBaselineQueries.test.ts apps/api/src/services/reliabilityScoring.ts
git commit -m "feat(api): score against the active baseline with a compare-and-set upsert (#5876)"
```

---

### Task 5: Baseline service: create, clear, list, before snapshot

**Files:**
- Create: `apps/api/src/services/reliabilityBaselines.ts`
- Test: `apps/api/src/services/reliabilityBaselines.test.ts` (unit, mocked)
- Test: `apps/api/src/__tests__/integration/reliabilityBaselines.integration.test.ts` (real DB)

**Interfaces:**
- Consumes: Tasks 1 to 4 (`scoreDeviceReliabilityAsOf`, `computeAndPersistDeviceReliability`, `getActiveReliabilityBaseline`, the policy exports).
- Produces:
  ```ts
  export interface CreateReliabilityBaselineInput {
    device: { id: string; orgId: string; deviceRole: string | null; enrolledAt: Date | null };
    reason: ReliabilityBaselineReason;
    baselineAt: Date;                 // already resolved via resolveBaselineAt
    note: string | null;
    source: ReliabilityBaselineSource;
    sourceRef: string | null;
    createdBy: string | null;
    recompute: boolean;               // true = inline recompute in the caller's transaction
  }
  export interface ReliabilityBaselineDto {
    id: string; baselineAt: string; reason: ReliabilityBaselineReason; source: ReliabilityBaselineSource;
    note: string | null; beforeSnapshot: ReliabilityBeforeSnapshot | null;
    createdBy: { id: string; name: string | null } | null; createdAt: string;
    clearedAt: string | null; clearedBy: { id: string; name: string | null } | null;
    active: boolean;                  // true only for the single effective marker
  }
  export async function createReliabilityBaseline(input: CreateReliabilityBaselineInput): Promise<ReliabilityBaselineDto | null>; // null = idempotent no-op (source_ref conflict)
  export async function clearReliabilityBaseline(input: { deviceId: string; baselineId: string; clearedBy: string | null }):
    Promise<'cleared' | 'not_found' | 'already_cleared'>;
  export async function listReliabilityBaselines(deviceId: string): Promise<ReliabilityBaselineDto[]>;
  export async function computeBeforeSnapshot(device: CreateReliabilityBaselineInput['device'], baselineAt: Date): Promise<ReliabilityBeforeSnapshot>;
  ```

- [ ] **Step 1: Write the failing integration test.** This is the authoritative test for this task: the service is SQL-heavy, so its contract is checked against real Postgres.

```ts
// apps/api/src/__tests__/integration/reliabilityBaselines.integration.test.ts
import './setup';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import { deviceReliability, deviceReliabilityHistory, devices } from '../../db/schema';
import { createOrganization, createPartner, createSite } from './db-utils';
import { getTestDb } from './setup';
import {
  clearReliabilityBaseline, createReliabilityBaseline, listReliabilityBaselines,
} from '../../services/reliabilityBaselines';
import { computeAndPersistDeviceReliability, persistDeviceReliability, scoreDeviceReliabilityAsOf } from '../../services/reliabilityScoring';

const DAY = 86_400_000;
const system: DbAccessContext = { scope: 'system', orgId: null, accessibleOrgIds: null, accessiblePartnerIds: null };
const asSystem = <T>(fn: () => Promise<T>) => withDbAccessContext(system, fn);

async function deviceWithCrashHistory() {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner!.id });
  const site = await createSite({ orgId: org!.id });
  const [device] = await getTestDb().insert(devices).values({
    orgId: org!.id, siteId: site!.id, agentId: randomUUID(), hostname: 'rb-int', osType: 'windows',
    osVersion: '11', architecture: 'x64', agentVersion: '1.0.0', deviceRole: 'workstation',
    enrolledAt: new Date(Date.now() - 120 * DAY),
  }).returning();
  // 40 daily samples; a BSOD on each of days 25..20 ago.
  const now = Date.now();
  await getTestDb().insert(deviceReliabilityHistory).values(Array.from({ length: 40 }, (_, i) => {
    const collectedAt = new Date(now - (39 - i) * DAY);
    const daysAgo = 39 - i;
    return {
      deviceId: device!.id, orgId: org!.id, collectedAt, uptimeSeconds: 3600,
      bootTime: new Date(collectedAt.getTime() - 3_600_000),
      crashEvents: daysAgo >= 20 && daysAgo <= 25 ? [{ type: 'bsod' as const, timestamp: new Date(collectedAt.getTime() - 60_000).toISOString() }] : [],
    };
  }));
  return { orgId: org!.id, device: { id: device!.id, orgId: org!.id, deviceRole: 'workstation', enrolledAt: new Date(now - 120 * DAY) } };
}

describe('reliability baselines (real DB)', () => {
  it('a marker after the crashes lifts the score and freezes the before snapshot', async () => {
    const { device } = await deviceWithCrashHistory();
    await asSystem(() => computeAndPersistDeviceReliability(device.id));
    const [before] = await asSystem(() => db.select().from(deviceReliability).where(eq(deviceReliability.deviceId, device.id)));
    expect(before!.crashCount30d).toBeGreaterThan(0);

    const marker = await asSystem(() => createReliabilityBaseline({
      device, reason: 'remediated', baselineAt: new Date(Date.now() - 10 * DAY), note: 'Updated storage driver',
      source: 'manual', sourceRef: null, createdBy: null, recompute: true,
    }));
    expect(marker!.beforeSnapshot!.counts30d.crashes).toBeGreaterThan(0);
    expect(marker!.beforeSnapshot!.reliabilityScore).toBe(before!.reliabilityScore);

    const [after] = await asSystem(() => db.select().from(deviceReliability).where(eq(deviceReliability.deviceId, device.id)));
    expect(after!.crashCount30d).toBe(0);
    expect(after!.reliabilityScore).toBeGreaterThan(before!.reliabilityScore);
    expect((after!.details as any).baseline).toMatchObject({ id: marker!.id, provisional: true });
  });

  it('clearing the marker restores the unmarked score; clearing twice is reported', async () => {
    const { device } = await deviceWithCrashHistory();
    await asSystem(() => computeAndPersistDeviceReliability(device.id));
    const [unmarked] = await asSystem(() => db.select().from(deviceReliability).where(eq(deviceReliability.deviceId, device.id)));
    const marker = await asSystem(() => createReliabilityBaseline({
      device, reason: 'reimaged', baselineAt: new Date(Date.now() - 10 * DAY), note: null,
      source: 'manual', sourceRef: null, createdBy: null, recompute: true,
    }));
    expect(await asSystem(() => clearReliabilityBaseline({ deviceId: device.id, baselineId: marker!.id, clearedBy: null }))).toBe('cleared');
    expect(await asSystem(() => clearReliabilityBaseline({ deviceId: device.id, baselineId: marker!.id, clearedBy: null }))).toBe('already_cleared');
    expect(await asSystem(() => clearReliabilityBaseline({ deviceId: device.id, baselineId: randomUUID(), clearedBy: null }))).toBe('not_found');
    const [restored] = await asSystem(() => db.select().from(deviceReliability).where(eq(deviceReliability.deviceId, device.id)));
    expect(restored!.reliabilityScore).toBe(unmarked!.reliabilityScore);
    expect((restored!.details as any).baseline).toBeUndefined();
  });

  it('a backdated marker earlier than the active one is listed but not effective, with the correct predecessor snapshot', async () => {
    const { device } = await deviceWithCrashHistory();
    const later = await asSystem(() => createReliabilityBaseline({
      device, reason: 'reimaged', baselineAt: new Date(Date.now() - 5 * DAY), note: null,
      source: 'manual', sourceRef: null, createdBy: null, recompute: true,
    }));
    const earlier = await asSystem(() => createReliabilityBaseline({
      device, reason: 'hardware_replaced', baselineAt: new Date(Date.now() - 15 * DAY), note: null,
      source: 'manual', sourceRef: null, createdBy: null, recompute: true,
    }));
    const list = await asSystem(() => listReliabilityBaselines(device.id));
    expect(list.find((m) => m.id === later!.id)!.active).toBe(true);
    expect(list.find((m) => m.id === earlier!.id)!.active).toBe(false);
    // Earlier marker's "before" is scored as of 15d ago with no predecessor → it sees the crashes.
    expect(earlier!.beforeSnapshot!.counts30d.crashes).toBeGreaterThan(0);
    const [row] = await asSystem(() => db.select().from(deviceReliability).where(eq(deviceReliability.deviceId, device.id)));
    expect((row!.details as any).baseline.id).toBe(later!.id);
  });

  it('compare-and-set skips a stale run that scored against the previous marker', async () => {
    const { device } = await deviceWithCrashHistory();
    await asSystem(() => computeAndPersistDeviceReliability(device.id));
    // A "worker" run computes with no marker…
    const stale = await asSystem(() => scoreDeviceReliabilityAsOf(device, new Date(), null));
    // …a marker lands and recomputes…
    const marker = await asSystem(() => createReliabilityBaseline({
      device, reason: 'reimaged', baselineAt: new Date(Date.now() - 10 * DAY), note: null,
      source: 'manual', sourceRef: null, createdBy: null, recompute: true,
    }));
    // …then the stale run tries to persist: it must be skipped.
    await asSystem(() => persistDeviceReliability(device, stale.values, null));
    const [row] = await asSystem(() => db.select().from(deviceReliability).where(eq(deviceReliability.deviceId, device.id)));
    expect((row!.details as any).baseline.id).toBe(marker!.id);
    expect(row!.crashCount30d).toBe(0);
  });

  it('an automatic marker is idempotent per recovery, even after it was cleared', async () => {
    const { device } = await deviceWithCrashHistory();
    const recoveryId = randomUUID();
    const input = {
      device, reason: 'reimaged' as const, baselineAt: new Date(Date.now() - DAY), note: null,
      source: 'bare_metal_recovery' as const, sourceRef: recoveryId, createdBy: null, recompute: false,
    };
    const first = await asSystem(() => createReliabilityBaseline(input));
    expect(first).not.toBeNull();
    await asSystem(() => clearReliabilityBaseline({ deviceId: device.id, baselineId: first!.id, clearedBy: null }));
    expect(await asSystem(() => createReliabilityBaseline(input))).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/reliabilityBaselines.integration.test.ts`
Expected: FAIL. `../../services/reliabilityBaselines` is not found.

- [ ] **Step 3: Implement the service**

```ts
// apps/api/src/services/reliabilityBaselines.ts
import { and, eq, isNull, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { db } from '../db';
import { deviceReliabilityBaselines, users } from '../db/schema';
import {
  RELIABILITY_SCORER_VERSION, reliabilityBeforeSnapshotSchema,
  type ReliabilityBaselineReason, type ReliabilityBaselineSource, type ReliabilityBeforeSnapshot,
} from './reliabilityBaselinePolicy';
import { getActiveReliabilityBaseline } from './reliabilityBaselineQueries';
import { computeAndPersistDeviceReliability, scoreDeviceReliabilityAsOf } from './reliabilityScoring';

// (CreateReliabilityBaselineInput and ReliabilityBaselineDto exactly as in this task's Interfaces block)

export async function computeBeforeSnapshot(
  device: CreateReliabilityBaselineInput['device'],
  baselineAt: Date,
): Promise<ReliabilityBeforeSnapshot> {
  // Chronological predecessor: the marker that was effective at baselineAt.
  const predecessor = await getActiveReliabilityBaseline(device.id, { atOrBefore: baselineAt });
  const { values, coverageDays, weightProfile } = await scoreDeviceReliabilityAsOf(device, baselineAt, predecessor);
  return reliabilityBeforeSnapshotSchema.parse({
    version: 1,
    scorerVersion: RELIABILITY_SCORER_VERSION,
    asOf: baselineAt.toISOString(),
    coverageDays,
    reliabilityScore: values.reliabilityScore,
    weightProfile,
    factors: {
      uptime: { score: values.uptimeScore },
      crashes: { score: values.crashScore },
      hangs: { score: values.hangScore },
      serviceFailures: { score: values.serviceFailureScore },
      hardwareErrors: { score: values.hardwareErrorScore },
    },
    counts30d: {
      crashes: values.crashCount30d ?? 0,
      hangs: values.hangCount30d ?? 0,
      serviceFailures: values.serviceFailureCount30d ?? 0,
      hardwareErrors: values.hardwareErrorCount30d ?? 0,
    },
  });
}

export async function createReliabilityBaseline(input: CreateReliabilityBaselineInput): Promise<ReliabilityBaselineDto | null> {
  const beforeSnapshot = await computeBeforeSnapshot(input.device, input.baselineAt);
  const inserted = await db
    .insert(deviceReliabilityBaselines)
    .values({
      orgId: input.device.orgId,
      deviceId: input.device.id,
      baselineAt: input.baselineAt,
      reason: input.reason,
      source: input.source,
      sourceRef: input.sourceRef,
      note: input.note?.trim() ? input.note.trim() : null,
      beforeSnapshot,
      createdBy: input.createdBy,
    })
    .onConflictDoNothing({
      target: [deviceReliabilityBaselines.deviceId, deviceReliabilityBaselines.sourceRef],
      where: sql`${deviceReliabilityBaselines.sourceRef} IS NOT NULL`,
    })
    .returning({ id: deviceReliabilityBaselines.id });
  if (inserted.length === 0) return null;
  if (input.recompute) await computeAndPersistDeviceReliability(input.device.id);
  const list = await listReliabilityBaselines(input.device.id);
  return list.find((m) => m.id === inserted[0]!.id) ?? null;
}

export async function clearReliabilityBaseline(input: { deviceId: string; baselineId: string; clearedBy: string | null }):
  Promise<'cleared' | 'not_found' | 'already_cleared'> {
  const updated = await db
    .update(deviceReliabilityBaselines)
    .set({ clearedAt: new Date(), clearedBy: input.clearedBy })
    .where(and(
      eq(deviceReliabilityBaselines.id, input.baselineId),
      eq(deviceReliabilityBaselines.deviceId, input.deviceId),
      isNull(deviceReliabilityBaselines.clearedAt),
    ))
    .returning({ id: deviceReliabilityBaselines.id });
  if (updated.length === 0) {
    const [existing] = await db
      .select({ id: deviceReliabilityBaselines.id })
      .from(deviceReliabilityBaselines)
      .where(and(eq(deviceReliabilityBaselines.id, input.baselineId), eq(deviceReliabilityBaselines.deviceId, input.deviceId)))
      .limit(1);
    return existing ? 'already_cleared' : 'not_found';
  }
  await computeAndPersistDeviceReliability(input.deviceId);
  return 'cleared';
}

export async function listReliabilityBaselines(deviceId: string): Promise<ReliabilityBaselineDto[]> {
  const creator = alias(users, 'baseline_creator');
  const clearer = alias(users, 'baseline_clearer');
  const rows = await db
    .select({
      id: deviceReliabilityBaselines.id,
      baselineAt: deviceReliabilityBaselines.baselineAt,
      reason: deviceReliabilityBaselines.reason,
      source: deviceReliabilityBaselines.source,
      note: deviceReliabilityBaselines.note,
      beforeSnapshot: deviceReliabilityBaselines.beforeSnapshot,
      createdAt: deviceReliabilityBaselines.createdAt,
      clearedAt: deviceReliabilityBaselines.clearedAt,
      createdById: deviceReliabilityBaselines.createdBy,
      createdByName: creator.name,
      clearedById: deviceReliabilityBaselines.clearedBy,
      clearedByName: clearer.name,
    })
    .from(deviceReliabilityBaselines)
    .leftJoin(creator, eq(creator.id, deviceReliabilityBaselines.createdBy))
    .leftJoin(clearer, eq(clearer.id, deviceReliabilityBaselines.clearedBy))
    .where(eq(deviceReliabilityBaselines.deviceId, deviceId))
    .orderBy(
      sql`${deviceReliabilityBaselines.baselineAt} DESC`,
      sql`${deviceReliabilityBaselines.createdAt} DESC`,
      sql`${deviceReliabilityBaselines.id} DESC`,
    );
  const activeId = rows.find((r) => r.clearedAt === null)?.id ?? null;
  return rows.map((r) => {
    const snapshot = reliabilityBeforeSnapshotSchema.safeParse(r.beforeSnapshot);
    return {
      id: r.id,
      baselineAt: r.baselineAt.toISOString(),
      reason: r.reason,
      source: r.source,
      note: r.note,
      beforeSnapshot: snapshot.success ? snapshot.data : null,
      createdBy: r.createdById ? { id: r.createdById, name: r.createdByName ?? null } : null,
      createdAt: r.createdAt.toISOString(),
      clearedAt: r.clearedAt ? r.clearedAt.toISOString() : null,
      clearedBy: r.clearedById ? { id: r.clearedById, name: r.clearedByName ?? null } : null,
      active: r.id === activeId,
    };
  });
}
```

Before relying on `users.name`, check the column with `grep -an "name:" apps/api/src/db/schema/users.ts`. If users have no `name` column (for example, only first and last name, or an email), select whichever display field the users list endpoint already uses.

`listReliabilityBaselines` uses the same `baseline_at DESC, created_at DESC, id DESC` order as `ACTIVE_ORDER`, so "first non-cleared" is the active marker by construction.

- [ ] **Step 4: Unit-test the thin branches (mocked)**

Create `reliabilityBaselines.test.ts`. Mock `../db` with `insert(...).values().onConflictDoNothing().returning()`, `update().set().where().returning()` and `select()…limit()` chains, and mock `./reliabilityScoring` (`scoreDeviceReliabilityAsOf`, `computeAndPersistDeviceReliability`) and `./reliabilityBaselineQueries` (`getActiveReliabilityBaseline`). Assert:
  - (a) `recompute: false` never calls `computeAndPersistDeviceReliability`.
  - (b) an empty `returning()` on insert returns `null` and does not recompute.
  - (c) a whitespace-only note is stored as `null`.
  - (d) `computeBeforeSnapshot` calls `getActiveReliabilityBaseline(deviceId, { atOrBefore: baselineAt })` and `scoreDeviceReliabilityAsOf(device, baselineAt, predecessor)`.

```ts
// apps/api/src/services/reliabilityBaselines.test.ts — key cases
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  returningInsert: vi.fn(), returningUpdate: vi.fn(), selectRows: vi.fn(),
  scoreAsOf: vi.fn(), recompute: vi.fn(), active: vi.fn(),
  insertValues: vi.fn(),
}));
vi.mock('../db', () => {
  const selectChain: any = {};
  for (const k of ['from', 'leftJoin', 'where', 'orderBy']) selectChain[k] = vi.fn(() => selectChain);
  selectChain.limit = vi.fn(() => m.selectRows());
  selectChain.then = (res: any, rej: any) => Promise.resolve(m.selectRows()).then(res, rej);
  return { db: {
    insert: vi.fn(() => ({ values: (v: unknown) => { m.insertValues(v); return { onConflictDoNothing: () => ({ returning: m.returningInsert }) }; } })),
    update: vi.fn(() => ({ set: () => ({ where: () => ({ returning: m.returningUpdate }) }) })),
    select: vi.fn(() => selectChain),
  } };
});
vi.mock('./reliabilityScoring', () => ({ scoreDeviceReliabilityAsOf: m.scoreAsOf, computeAndPersistDeviceReliability: m.recompute }));
vi.mock('./reliabilityBaselineQueries', () => ({ getActiveReliabilityBaseline: m.active }));

import { computeBeforeSnapshot, createReliabilityBaseline } from './reliabilityBaselines';

const device = { id: 'd1', orgId: 'o1', deviceRole: 'workstation', enrolledAt: null };
const values = { reliabilityScore: 50, uptimeScore: 100, crashScore: 10, hangScore: 100, serviceFailureScore: 100, hardwareErrorScore: 100,
  crashCount30d: 4, hangCount30d: 0, serviceFailureCount30d: 0, hardwareErrorCount30d: 0 };

describe('reliabilityBaselines service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    m.active.mockResolvedValue(null);
    m.scoreAsOf.mockResolvedValue({ values, coverageDays: 30, weightProfile: 'workstation' });
    m.selectRows.mockReturnValue([]);
  });
  it('computes the before snapshot against the chronological predecessor', async () => {
    const at = new Date('2026-10-01T00:00:00.000Z');
    const pred = { id: 'p', baselineAt: new Date('2026-09-20T00:00:00.000Z'), reason: 'reimaged', source: 'manual' };
    m.active.mockResolvedValue(pred);
    const snap = await computeBeforeSnapshot(device, at);
    expect(m.active).toHaveBeenCalledWith('d1', { atOrBefore: at });
    expect(m.scoreAsOf).toHaveBeenCalledWith(device, at, pred);
    expect(snap.counts30d.crashes).toBe(4);
  });
  it('returns null and does not recompute on an idempotent conflict', async () => {
    m.returningInsert.mockResolvedValue([]);
    const out = await createReliabilityBaseline({ device, reason: 'reimaged', baselineAt: new Date(), note: null,
      source: 'bare_metal_recovery', sourceRef: 'r1', createdBy: null, recompute: true });
    expect(out).toBeNull();
    expect(m.recompute).not.toHaveBeenCalled();
  });
  it('skips the inline recompute when recompute=false and blanks a whitespace note', async () => {
    m.returningInsert.mockResolvedValue([{ id: 'b1' }]);
    await createReliabilityBaseline({ device, reason: 'reimaged', baselineAt: new Date(), note: '   ',
      source: 'manual', sourceRef: null, createdBy: 'u1', recompute: false });
    expect(m.recompute).not.toHaveBeenCalled();
    expect(m.insertValues.mock.calls[0]![0]).toMatchObject({ note: null });
  });
});
```

- [ ] **Step 5: Run the unit and integration tests**

Run:
```bash
cd apps/api && npx vitest run src/services/reliabilityBaselines.test.ts
npx vitest run --config vitest.integration.config.ts src/__tests__/integration/reliabilityBaselines.integration.test.ts
```
Expected: PASS. If the integration suite needs the ML reliability flag on for the org (`shouldProduceMlOutput`), enable it in the fixture the way `reliabilityWeightProfile.integration.test.ts` does. Copy that setup; don't stub it.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/reliabilityBaselines.ts apps/api/src/services/reliabilityBaselines.test.ts apps/api/src/__tests__/integration/reliabilityBaselines.integration.test.ts
git commit -m "feat(api): reliability baseline create/clear/list with frozen before snapshot (#5876)"
```

---

### Task 6: Routes, audit and activity-feed label

**Files:**
- Modify: `apps/api/src/routes/reliability.ts`
- Modify: `apps/api/src/routes/devices/events.ts` (`actionLabels`)
- Test: `apps/api/src/routes/reliability.test.ts`

**Interfaces:**
- Consumes: `createReliabilityBaseline`, `clearReliabilityBaseline`, `listReliabilityBaselines` (Task 5); `resolveBaselineAt`, `isNoteRequired`, `RELIABILITY_BASELINE_REASONS`, `BASELINE_NOTE_MAX_LENGTH` (Task 2); `getDeviceReliability` (Task 8 extends its return value with `baseline` and `provisional`).
- Produces these HTTP endpoints:
  - `GET /reliability/:deviceId/baselines` → `{ baselines: ReliabilityBaselineDto[] }`
  - `POST /reliability/:deviceId/baselines` with body `{ reason, baselineAt?, note? }` → `201 { baseline: ReliabilityBaselineDto, reliability: ReliabilityListItem | null }`. Errors: `400 { error, code: 'baseline_in_future' | 'baseline_too_old' | 'note_required' }`, `403`, `404`.
  - `DELETE /reliability/:deviceId/baselines/:baselineId` → `200 { reliability }`. Errors: `404 { code: 'baseline_not_found' }`, `409 { code: 'baseline_already_cleared' }`.

- [ ] **Step 1: Write the failing route tests**

In `reliability.test.ts`, make the existing `vi.mock('../middleware/auth', …)` permission-aware. Replace the `requirePermission` line with:

```ts
const permGate = vi.hoisted(() => ({ denied: new Set<string>() }));
vi.mock('../middleware/auth', () => ({
  authMiddleware: async (_c: any, next: any) => await next(),
  requirePermission: (resource: string, action: string) => async (c: any, next: any) => {
    if (permGate.denied.has(`${resource}:${action}`)) return c.json({ error: 'Permission denied' }, 403);
    await next();
  },
  requireScope: () => async (_c: any, next: any) => await next(),
}));
vi.mock('../services/reliabilityBaselines', () => ({
  createReliabilityBaseline: vi.fn(), clearReliabilityBaseline: vi.fn(), listReliabilityBaselines: vi.fn(),
}));
vi.mock('../services/auditEvents', () => ({ writeRouteAudit: vi.fn() }));
```

Add `permGate.denied.clear()` to the top-level `beforeEach`. Then add:

```ts
describe('baselines (#5876)', () => {
  const device = { id: DEVICE_ID, orgId: ORG_ID, siteId: SITE_ID, hostname: 'pc-1', deviceRole: 'workstation', enrolledAt: null };
  const dto = { id: '00000000-0000-0000-0000-0000000000b1', baselineAt: '2026-10-08T00:00:00.000Z', reason: 'remediated',
    source: 'manual', note: 'Fixed driver', beforeSnapshot: null, createdBy: null, createdAt: '2026-10-08T00:00:00.000Z',
    clearedAt: null, clearedBy: null, active: true };
  beforeEach(() => {
    vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue(device as any);
    vi.mocked(getDeviceReliability).mockResolvedValue(null);
  });

  it('POST requires devices:write', async () => {
    permGate.denied.add('devices:write');
    const res = await buildApp().request(`/reliability/${DEVICE_ID}/baselines`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reason: 'reimaged' }),
    });
    expect(res.status).toBe(403);
    expect(createReliabilityBaseline).not.toHaveBeenCalled();
  });

  it('POST rejects a remediated marker without a note', async () => {
    const res = await buildApp().request(`/reliability/${DEVICE_ID}/baselines`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reason: 'remediated', note: '  ' }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('note_required');
  });

  it('POST rejects a marker older than 30 days', async () => {
    const res = await buildApp().request(`/reliability/${DEVICE_ID}/baselines`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'reimaged', baselineAt: new Date(Date.now() - 31 * 86_400_000).toISOString() }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('baseline_too_old');
  });

  it('POST creates a manual marker attributed to the caller and audits it', async () => {
    vi.mocked(createReliabilityBaseline).mockResolvedValue(dto as any);
    const res = await buildApp().request(`/reliability/${DEVICE_ID}/baselines`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'remediated', note: 'Fixed driver', source: 'bare_metal_recovery', orgId: ORG_ID_2 }),
    });
    expect(res.status).toBe(201);
    expect(createReliabilityBaseline).toHaveBeenCalledWith(expect.objectContaining({
      device: expect.objectContaining({ id: DEVICE_ID, orgId: ORG_ID }),
      source: 'manual', sourceRef: null, createdBy: 'user-1', recompute: true, reason: 'remediated', note: 'Fixed driver',
    }));
    expect(writeRouteAudit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: 'device.reliability.baseline_set', resourceType: 'device', resourceId: DEVICE_ID, orgId: ORG_ID,
    }));
  });

  it('POST returns 403 on site access denial and 404 for an unknown device', async () => {
    vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValueOnce(SITE_ACCESS_DENIED as any);
    const denied = await buildApp().request(`/reliability/${DEVICE_ID}/baselines`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reason: 'reimaged' }),
    });
    expect(denied.status).toBe(403);
    vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValueOnce(null);
    const missing = await buildApp().request(`/reliability/${DEVICE_ID}/baselines`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reason: 'reimaged' }),
    });
    expect(missing.status).toBe(404);
  });

  it('DELETE maps not_found → 404 and already_cleared → 409, and audits a clear', async () => {
    vi.mocked(clearReliabilityBaseline).mockResolvedValueOnce('not_found');
    expect((await buildApp().request(`/reliability/${DEVICE_ID}/baselines/${dto.id}`, { method: 'DELETE' })).status).toBe(404);
    vi.mocked(clearReliabilityBaseline).mockResolvedValueOnce('already_cleared');
    expect((await buildApp().request(`/reliability/${DEVICE_ID}/baselines/${dto.id}`, { method: 'DELETE' })).status).toBe(409);
    vi.mocked(clearReliabilityBaseline).mockResolvedValueOnce('cleared');
    expect((await buildApp().request(`/reliability/${DEVICE_ID}/baselines/${dto.id}`, { method: 'DELETE' })).status).toBe(200);
    expect(writeRouteAudit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: 'device.reliability.baseline_cleared' }));
  });

  it('GET lists markers with devices:read', async () => {
    vi.mocked(listReliabilityBaselines).mockResolvedValue([dto] as any);
    const res = await buildApp().request(`/reliability/${DEVICE_ID}/baselines`);
    expect(res.status).toBe(200);
    expect((await res.json()).baselines).toHaveLength(1);
  });
});
```

Import `createReliabilityBaseline`, `clearReliabilityBaseline`, `listReliabilityBaselines` and `writeRouteAudit` from their (mocked) modules at the top of the file.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/api && npx vitest run src/routes/reliability.test.ts`
Expected: FAIL with 404s, because the routes don't exist yet.

- [ ] **Step 3: Implement the routes** in `routes/reliability.ts`. Add them before `GET /:deviceId`.

```ts
import { writeRouteAudit } from '../services/auditEvents';
import {
  BASELINE_NOTE_MAX_LENGTH, RELIABILITY_BASELINE_REASONS, isNoteRequired, resolveBaselineAt,
} from '../services/reliabilityBaselinePolicy';
import { clearReliabilityBaseline, createReliabilityBaseline, listReliabilityBaselines } from '../services/reliabilityBaselines';

const requireDeviceWrite = requirePermission(PERMISSIONS.DEVICES_WRITE.resource, PERMISSIONS.DEVICES_WRITE.action);
const baselineParamSchema = z.object({ deviceId: z.string().guid(), baselineId: z.string().guid() });
// Only these three fields are read; source/orgId/actor are server-derived (extra keys are ignored).
const createBaselineBodySchema = z.object({
  reason: z.enum(RELIABILITY_BASELINE_REASONS),
  baselineAt: z.coerce.date().optional(),
  note: z.string().max(BASELINE_NOTE_MAX_LENGTH).optional(),
});

async function resolveDevice(c: Parameters<typeof getDeviceWithOrgAndSiteCheck>[0], deviceId: string) {
  const device = await getDeviceWithOrgAndSiteCheck(c, deviceId, c.get('auth'));
  if (device === SITE_ACCESS_DENIED) return { error: c.json({ error: 'Access to this site denied' }, 403) } as const;
  if (!device) return { error: c.json({ error: 'Device not found' }, 404) } as const;
  return { device } as const;
}

reliabilityRoutes.get(
  '/:deviceId/baselines',
  requireScope('organization', 'partner', 'system'),
  requireReliabilityRead,
  zValidator('param', deviceIdParamSchema),
  async (c) => {
    const { deviceId } = c.req.valid('param');
    const resolved = await resolveDevice(c, deviceId);
    if ('error' in resolved) return resolved.error;
    return c.json({ baselines: await listReliabilityBaselines(deviceId) });
  },
);

reliabilityRoutes.post(
  '/:deviceId/baselines',
  requireScope('organization', 'partner', 'system'),
  requireDeviceWrite,
  zValidator('param', deviceIdParamSchema),
  zValidator('json', createBaselineBodySchema),
  async (c) => {
    const auth = c.get('auth');
    const { deviceId } = c.req.valid('param');
    const body = c.req.valid('json');
    const resolved = await resolveDevice(c, deviceId);
    if ('error' in resolved) return resolved.error;
    const { device } = resolved;

    const at = resolveBaselineAt(body.baselineAt, new Date());
    if (!at.ok) {
      const message = at.error === 'baseline_in_future'
        ? 'Marker time cannot be in the future.'
        : 'Marker time cannot be more than 30 days ago.';
      return c.json({ error: message, code: at.error }, 400);
    }
    const note = body.note?.trim() ? body.note.trim() : null;
    if (isNoteRequired(body.reason, 'manual') && !note) {
      return c.json({ error: 'Describe the remediation work in the note.', code: 'note_required' }, 400);
    }

    const baseline = await createReliabilityBaseline({
      device: { id: device.id, orgId: device.orgId, deviceRole: device.deviceRole ?? null, enrolledAt: device.enrolledAt ?? null },
      reason: body.reason, baselineAt: at.baselineAt, note,
      source: 'manual', sourceRef: null, createdBy: auth.user?.id ?? null, recompute: true,
    });
    writeRouteAudit(c, {
      orgId: device.orgId,
      action: 'device.reliability.baseline_set',
      resourceType: 'device',
      resourceId: device.id,
      resourceName: device.hostname,
      details: { baselineId: baseline?.id ?? null, reason: body.reason, baselineAt: at.baselineAt.toISOString(), note, source: 'manual' },
    });
    return c.json({ baseline, reliability: await getDeviceReliability(deviceId) }, 201);
  },
);

reliabilityRoutes.delete(
  '/:deviceId/baselines/:baselineId',
  requireScope('organization', 'partner', 'system'),
  requireDeviceWrite,
  zValidator('param', baselineParamSchema),
  async (c) => {
    const auth = c.get('auth');
    const { deviceId, baselineId } = c.req.valid('param');
    const resolved = await resolveDevice(c, deviceId);
    if ('error' in resolved) return resolved.error;
    const outcome = await clearReliabilityBaseline({ deviceId, baselineId, clearedBy: auth.user?.id ?? null });
    if (outcome === 'not_found') return c.json({ error: 'Marker not found', code: 'baseline_not_found' }, 404);
    if (outcome === 'already_cleared') return c.json({ error: 'Marker already cleared', code: 'baseline_already_cleared' }, 409);
    writeRouteAudit(c, {
      orgId: resolved.device.orgId,
      action: 'device.reliability.baseline_cleared',
      resourceType: 'device',
      resourceId: deviceId,
      resourceName: resolved.device.hostname,
      details: { baselineId },
    });
    return c.json({ reliability: await getDeviceReliability(deviceId) });
  },
);
```

The marker insert and the recompute run inside the request transaction that `authMiddleware` opened (`withDbAccessContext`), so they commit or roll back together. No explicit `db.transaction` is needed.

In `routes/devices/events.ts` `actionLabels`, add these after `'device.maintenance.enable'`:

```ts
  'device.reliability.baseline_set': 'Reliability baseline set',
  'device.reliability.baseline_cleared': 'Reliability baseline cleared',
```

- [ ] **Step 4: Run the tests to verify they pass, then typecheck**

Run: `cd apps/api && npx vitest run src/routes/reliability.test.ts src/routes/devices/events.test.ts && npx tsc --noEmit -p tsconfig.json; echo EXIT=$?`
Expected: PASS and `EXIT=0`. If `events.test.ts` doesn't exist, run only the first file.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/reliability.ts apps/api/src/routes/reliability.test.ts apps/api/src/routes/devices/events.ts
git commit -m "feat(api): reliability baseline routes with audit (#5876)"
```

---

### Task 7: Automatic marker on bare-metal recovery check-in

**Files:**
- Modify: `apps/api/src/routes/agents/heartbeat.ts` (recoveryMarker block, ~L1266-1322)
- Modify: `apps/api/src/jobs/reliabilityWorker.ts` (`enqueueDeviceReliabilityComputation` gains an optional key)
- Test: `apps/api/src/routes/agents/heartbeat.test.ts` (the `recovery marker check-in` describe at ~L7178)
- Test: `apps/api/src/jobs/reliabilityWorker.test.ts`

**Interfaces:**
- Consumes: `createReliabilityBaseline` (Task 5).
- Produces: `enqueueDeviceReliabilityComputation(deviceId: string, opts?: { dedupeKey?: string }): Promise<string>`. When `dedupeKey` is set, the job id is `reliability-device:${deviceId}:k:${dedupeKey}` instead of the 10-minute slot.

- [ ] **Step 1: Write the failing worker test** (append to `reliabilityWorker.test.ts`, using its existing queue mock)

```ts
it('uses a caller-supplied dedupe key instead of the 10-minute slot (#5876)', async () => {
  await enqueueDeviceReliabilityComputation('dev-1', { dedupeKey: 'baseline-abc' });
  expect(queueAddMock).toHaveBeenCalledWith('compute-device', expect.anything(),
    expect.objectContaining({ jobId: 'reliability-device:dev-1:k:baseline-abc' }));
});
```

(`queueAddMock` stands for this file's existing mock of `queue.add`. Use the name it already has.)

- [ ] **Step 2: Write the failing heartbeat tests**

In `heartbeat.test.ts`:
1. Add `deviceReliabilityBaselines: {}` to the explicit `vi.mock('../../db/schema', …)` list. Add `runAfterDbContextExit: vi.fn((_label, work) => { afterExit.push(work); })` to the `../../db` mock, with `const afterExit: Array<() => unknown> = []` hoisted.
2. Mock the service and the worker:
   ```ts
   vi.mock('../../services/reliabilityBaselines', () => ({ createReliabilityBaseline: vi.fn() }));
   vi.mock('../../jobs/reliabilityWorker', async (orig) => ({ ...(await orig<any>()), enqueueDeviceReliabilityComputation: vi.fn() }));
   ```
   If the test file already mocks `../../jobs/reliabilityWorker`, extend that mock instead.
3. In `arrange()`, make the `bareMetalRecoveries` update branch return `{ where: vi.fn(() => ({ returning: vi.fn(() => Promise.resolve(transitionRows)) })) }`. `transitionRows` is a per-test variable that defaults to `[{ id: REC_ID, snapshotId: 'snap-1', rebootedAt: null }]`.

Add these cases to the describe:

```ts
it('creates a reimaged marker exactly when it wins the transition and enqueues after exit (#5876)', async () => {
  const res = await postHeartbeatWithMarker();           // existing helper used by 'completes a rebooted recovery…'
  expect(res.status).toBe(200);
  expect(createReliabilityBaseline).toHaveBeenCalledWith(expect.objectContaining({
    reason: 'reimaged', source: 'bare_metal_recovery', sourceRef: REC_ID, createdBy: null, recompute: false,
  }));
  expect(enqueueDeviceReliabilityComputation).not.toHaveBeenCalled();
  for (const work of afterExit.splice(0)) await work();
  expect(enqueueDeviceReliabilityComputation).toHaveBeenCalledWith(DEVICE_ID, { dedupeKey: `bmr-${REC_ID}` });
});

it('creates no marker when a concurrent heartbeat already won the transition (#5876)', async () => {
  transitionRows = [];
  await postHeartbeatWithMarker();
  expect(createReliabilityBaseline).not.toHaveBeenCalled();
});

it('creates no marker on an idempotent re-ack of a checked_in recovery (#5876)', async () => {
  // reuse the 're-acks an already checked_in recovery' arrangement
  await postHeartbeatWithCheckedInMarker();
  expect(createReliabilityBaseline).not.toHaveBeenCalled();
});
```

Use the helper names and fixtures the existing five recovery tests already use (`REC_ID`, `DEVICE_ID`, the request builder). If they inline the request, extract a local helper in this describe first. That is a refactor with no behaviour change, so run the five existing tests green before adding the new ones.

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd apps/api && npx vitest run src/jobs/reliabilityWorker.test.ts src/routes/agents/heartbeat.test.ts -t "recovery marker|dedupe key"`
Expected: the new cases FAIL.

- [ ] **Step 4: Implement**

In `reliabilityWorker.ts`:

```ts
export async function enqueueDeviceReliabilityComputation(
  deviceId: string,
  opts: { dedupeKey?: string } = {},
): Promise<string> {
  const queue = getReliabilityQueue();
  // #5876: a baseline change must recompute even if a routine on-demand run
  // already claimed this 10-minute slot, so callers can key the job themselves.
  const jobId = opts.dedupeKey
    ? `reliability-device:${deviceId}:k:${opts.dedupeKey}`
    : `reliability-device:${deviceId}:${Math.floor(Date.now() / ON_DEMAND_RELIABILITY_DEDUPE_WINDOW_MS).toString(36)}`;
  // …rest unchanged (existing-job reuse / stale removal / queue.add with jobId)
```

In `heartbeat.ts`, replace the success branch's unguarded update with a guarded transition, and place the marker inside it:

```ts
    } else if (rec && nonceOk && rec.identity === 'original' && ['restoring', 'validated', 'rebooted'].includes(rec.status)) {
      const checkedInNow = new Date();
      // #5876: guarded transition — only the heartbeat that wins it creates the
      // reliability baseline marker. identity='original' stays in the predicate:
      // a 'new'-identity recovery is a different machine.
      const [won] = await db.update(bareMetalRecoveries).set({
        status: 'checked_in',
        checkedInAt: checkedInNow,
        rebootedAt: rec.rebootedAt ?? checkedInNow,
        updatedAt: checkedInNow,
      }).where(and(
        eq(bareMetalRecoveries.id, rec.id),
        eq(bareMetalRecoveries.identity, 'original'),
        inArray(bareMetalRecoveries.status, ['restoring', 'validated', 'rebooted']),
      )).returning({ id: bareMetalRecoveries.id });
      recoveryMarkerAck = true;
      if (won) {
        deviceUpdates.recoveredAt = checkedInNow;
        deviceUpdates.recoveredFromSnapshotId = rec.snapshotId;
        writeAuditEvent(c, { /* existing bmr.recovery.checked_in success audit, unchanged */ });
        const marker = await createReliabilityBaseline({
          device: { id: device.id, orgId: agent.orgId, deviceRole: device.deviceRole ?? null, enrolledAt: device.enrolledAt ?? null },
          reason: 'reimaged', baselineAt: checkedInNow, note: null,
          source: 'bare_metal_recovery', sourceRef: rec.id, createdBy: null, recompute: false,
        });
        if (marker) {
          writeAuditEvent(c, {
            orgId: agent.orgId,
            actorType: 'system',
            actorId: '00000000-0000-0000-0000-000000000000',
            action: 'device.reliability.baseline_set',
            resourceType: 'device',
            resourceId: device.id,
            details: { baselineId: marker.id, reason: 'reimaged', source: 'bare_metal_recovery', recoveryId: rec.id },
            result: 'success',
          });
          runAfterDbContextExit('reliability-baseline-recompute', () =>
            enqueueDeviceReliabilityComputation(device.id, { dedupeKey: `bmr-${rec.id}` }).catch((err) =>
              console.error('[heartbeat] reliability recompute enqueue failed', { deviceId: device.id, err })));
        }
      }
    } else {
```

Add these imports:
- `runAfterDbContextExit` from `'../../db'`
- `inArray` from `drizzle-orm`, if not already imported
- `createReliabilityBaseline` from `'../../services/reliabilityBaselines'`
- `enqueueDeviceReliabilityComputation` from `'../../jobs/reliabilityWorker'`

Check that the device row selected earlier in the handler carries `deviceRole` and `enrolledAt`. If it is a narrowed select, add those two columns.

Write the system audit with `actorType: 'system'` so the deliberate activity feed (which filters `actor_type <> 'agent'`) shows it. Before relying on it, check in `services/auditEvents.ts` that `writeAuditEvent` honours an explicit `actorType`/`actorId` over the request's agent identity. If it doesn't, use `createAuditLogAsync({...})` (fire-and-forget, retrying; the same pattern as `routes/tunnelWs.ts:200`).

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd apps/api && npx vitest run src/jobs/reliabilityWorker.test.ts src/routes/agents/heartbeat.test.ts && npx tsc --noEmit -p tsconfig.json; echo EXIT=$?`
Expected: PASS (the full heartbeat file, including the five pre-existing recovery tests) and `EXIT=0`.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/agents/heartbeat.ts apps/api/src/routes/agents/heartbeat.test.ts apps/api/src/jobs/reliabilityWorker.ts apps/api/src/jobs/reliabilityWorker.test.ts
git commit -m "feat(api): bare-metal recovery check-in places a reimaged baseline marker (#5876)"
```

---

### Task 8: Read-model consumers: detail, list, history, offenders, evaluation

**Files:**
- Modify: `apps/api/src/services/reliabilityScoring.ts` (`ReliabilityListItem`, `getDeviceReliability`, `listReliabilityDevices`, `getDeviceReliabilityHistory`, `getDeviceReliabilityOffenders`, `evaluateReliabilityScores`, `DeviceReliabilityHistoryPoint`)
- Test: `apps/api/src/services/reliabilityScoring.baseline.test.ts` (extend), `apps/api/src/__tests__/integration/reliabilityBaselines.integration.test.ts` (extend)

**Interfaces:**
- Produces:
  - `ReliabilityListItem` gains `provisional: boolean` and `baseline?: ReliabilityBaselineDetails | null` (`baseline` only from `getDeviceReliability`).
  - `DeviceReliabilityHistoryPoint` gains `beforeBaseline: boolean`.

- [ ] **Step 1: Write the failing tests**

Unit (append to `reliabilityScoring.baseline.test.ts`): `getDeviceReliabilityHistory` must dedupe the way the main scorer does. Extract its bucketing into a pure helper `buildHistoryPoints(rows, baselineAt, windowEnd, days)` and test that:

```ts
describe('buildHistoryPoints (#5876)', () => {
  it('dedupes a re-posted crash and flags pre-marker days instead of dropping them', () => {
    const crash = { type: 'bsod', timestamp: '2026-03-20T09:00:00.000Z' };
    const rows = [
      { collectedAt: new Date('2026-03-20T10:00:00.000Z'), uptimeSeconds: 60, bootTime: new Date('2026-03-20T09:30:00.000Z'), crashEvents: [crash], appHangs: [], serviceFailures: [], hardwareErrors: [] },
      { collectedAt: new Date('2026-03-20T11:00:00.000Z'), uptimeSeconds: 120, bootTime: new Date('2026-03-20T09:30:00.000Z'), crashEvents: [crash], appHangs: [], serviceFailures: [], hardwareErrors: [] },
      { collectedAt: new Date('2026-03-25T11:00:00.000Z'), uptimeSeconds: 120, bootTime: new Date('2026-03-25T09:30:00.000Z'), crashEvents: [], appHangs: [], serviceFailures: [], hardwareErrors: [] },
    ];
    const points = I.buildHistoryPoints(rows as any, new Date('2026-03-22T00:00:00.000Z'), windowEnd, 30);
    const day20 = points.find((p) => p.date === '2026-03-20')!;
    expect(day20.crashCount).toBe(1);
    expect(day20.beforeBaseline).toBe(true);
    expect(points.find((p) => p.date === '2026-03-25')!.beforeBaseline).toBe(false);
    expect(day20.reliabilityEstimate).toBe(I.scoreDailyBucket(I.sortDailyBuckets((() => {
      const m = new Map(); I.mergeRowsIntoDailyBuckets(m, rows.slice(0, 2) as any); return m; })())[0]!));
  });
});
```

Integration (append to `reliabilityBaselines.integration.test.ts`):

```ts
it('detail exposes baseline + provisional; offenders and evaluation respect the marker', async () => {
  const { device, orgId } = await deviceWithCrashHistory();
  const marker = await asSystem(() => createReliabilityBaseline({ device, reason: 'reimaged',
    baselineAt: new Date(Date.now() - 10 * DAY), note: null, source: 'manual', sourceRef: null, createdBy: null, recompute: true }));
  const detail = await asSystem(() => getDeviceReliability(device.id));
  expect(detail!.provisional).toBe(true);
  expect(detail!.baseline).toMatchObject({ id: marker!.id, reason: 'reimaged' });
  const listed = await asSystem(() => listReliabilityDevices({ orgId, limit: 10 }));
  expect(listed.rows.find((r) => r.deviceId === device.id)!.provisional).toBe(true);
  const offenders = await asSystem(() => getDeviceReliabilityOffenders(device.id, 30, 5));
  expect(offenders.crashes ?? []).toHaveLength(0);
});
```

Before relying on `offenders.crashes`, check the shape of `DeviceReliabilityOffenders`: `grep -an "interface DeviceReliabilityOffenders" -A10 apps/api/src/services/reliabilityScoring.ts`. Assert on whichever field holds crash offenders. If crashes aren't an offender category, assert that the total of all categories is 0.

For the evaluation change, add a unit test with mocked `db` in `reliabilityScoring.evaluationSiteScope.test.ts` style. A `failure_confirmed` label whose `occurredAt` is before the device's `details.baseline.baselineAt` must not count as a label.

- [ ] **Step 2: Run them to verify they fail.** Run: `cd apps/api && npx vitest run src/services/reliabilityScoring.baseline.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement**

1. `ReliabilityListItem`: add `provisional: boolean;` and `baseline?: ReliabilityBaselineDetails | null;`.
2. `listReliabilityDevices`: add `provisional: reliabilityProvisionalSql,` to the data select, and map `provisional: Boolean(row.provisional)`.
3. `getDeviceReliability`: it already selects `details`. Add `provisional: readBaselineDetails(row.details)?.provisional ?? false, baseline: readBaselineDetails(row.details),` to the returned object.
4. Extract `buildHistoryPoints` and rewrite `getDeviceReliabilityHistory` on top of the shared dedupe:

```ts
function buildHistoryPoints(
  rows: ScoringHistoryRow[], baselineAt: Date | null, windowEnd: Date, days: number,
): DeviceReliabilityHistoryPoint[] {
  // #5876: same global dedupe + genuine-hardware filter + event-timestamp bucketing
  // as the scorer (the legacy per-row .length sum re-inflated counts, #1904).
  // Pre-marker days are flagged, not dropped, so a chart can draw the cut.
  const map = new Map<string, DailyAggregateBucket>();
  mergeRowsIntoDailyBuckets(map, rows);
  const baselineDay = baselineAt ? toDayKey(baselineAt) : null;
  return bucketsInWindow(sortDailyBuckets(map), days, windowEnd).map((bucket) => ({
    date: bucket.date,
    sampleCount: bucket.sampleCount,
    uptimeSecondsMax: bucket.uptimeSecondsMax,
    crashCount: bucket.crashCount,
    hangCount: bucket.hangCount,
    serviceFailureCount: bucket.serviceFailureCount,
    hardwareErrorCount: bucket.hardwareErrorCount,
    reliabilityEstimate: scoreDailyBucket(bucket),
    beforeBaseline: baselineDay !== null && bucket.date < baselineDay,
  }));
}

export async function getDeviceReliabilityHistory(deviceId: string, days: number): Promise<DeviceReliabilityHistoryPoint[]> {
  const windowEnd = new Date();
  const [rows, baseline] = await Promise.all([
    getHistoryForDevice(deviceId, days, windowEnd),
    getActiveReliabilityBaseline(deviceId),
  ]);
  return buildHistoryPoints(rows, baseline?.baselineAt ?? null, windowEnd, days);
}
```

   Add `beforeBaseline: boolean;` to `DeviceReliabilityHistoryPoint`, and add `buildHistoryPoints` and `applyBaselineToRows` to `reliabilityScoringInternals`.

5. `getDeviceReliabilityOffenders`: after `const rows = await getHistoryForDevice(deviceId, days);`, add `const baseline = await getActiveReliabilityBaseline(deviceId);` and pass `applyBaselineToRows(rows, baseline?.baselineAt ?? null)` to `aggregateReliabilityOffenders`.

6. `evaluateReliabilityScores`: add `baselineAt: sql<string | null>\`${deviceReliability.details}->'baseline'->>'baselineAt'\`` to `deviceRows`. Then filter the labels:

```ts
  const baselineByDevice = new Map(deviceRows.map((row) => [row.deviceId, row.baselineAt ? Date.parse(row.baselineAt) : null]));
  // #5876: a failure label recorded before the device's active marker describes
  // the pre-fix machine; scoring it against the post-fix score would be noise.
  const labels = labelRows
    .filter(/* existing outcome/device filter */)
    .filter((row) => {
      const cut = baselineByDevice.get(row.deviceId);
      return cut == null || row.occurredAt.getTime() >= cut;
    })
    .map(/* existing */);
```

   Make sure `deviceRows` still matches the `computeReliabilityEvaluationSummary` input type. If the extra `baselineAt` field breaks it, strip the field in a `.map` before passing the rows on.

- [ ] **Step 4: Run all reliability tests** (unit plus these integration suites)

```bash
cd apps/api && npx vitest run src/services/reliabilityScoring src/routes/reliability.test.ts
npx vitest run --config vitest.integration.config.ts src/__tests__/integration/reliabilityBaselines.integration.test.ts
npx tsc --noEmit -p tsconfig.json; echo EXIT=$?
```
Expected: PASS and `EXIT=0`.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/reliabilityScoring.ts apps/api/src/services/reliabilityScoring*.test.ts apps/api/src/__tests__/integration/reliabilityBaselines.integration.test.ts
git commit -m "feat(api): baseline-aware reliability detail, list, history, offenders and evaluation (#5876)"
```

---

### Task 9: Fleet, device list and AI consumers

**Files:**
- Modify: `apps/api/src/services/fleetFindings/producers.ts` (`produceReliabilityOffenders`)
- Modify: `apps/api/src/routes/devices/core.ts` (~L1179 select, ~L1398 row map)
- Modify: `apps/api/src/services/aiToolsDevice.ts` (`get_device_hardware_health`, `includeReliability`)
- Modify: `apps/api/src/services/aiToolsUserRisk.ts` (`shapeReliabilityRow` for `get_fleet_health`)
- Modify: `apps/api/src/services/aiAgents/designEvidence.ts`, `apps/api/src/services/aiAgents/runnerPrompt.ts`
- Test: the co-located test of each file (`producers.test.ts` or the fleet-findings test that covers `produceReliabilityOffenders`, `aiToolsDevice.hardwareHealth.test.ts`, `aiToolsReliability.test.ts`, the devices core list test, the `designEvidence`/`runnerPrompt` tests)

**Interfaces:**
- Consumes: `reliabilityProvisionalSql` (Task 4), `ReliabilityListItem.provisional` and `.baseline` (Task 8).
- Produces: device list rows gain `reliabilityProvisional: boolean`. AI tool output `reliability.baseline = { reason, baselineAt, provisional, reportedDaysSinceBaseline } | null`. `get_fleet_health` items gain `provisional`. Design evidence `reliabilityWorst[]` entries gain `provisional`.

- [ ] **Step 1: Write the failing tests**

- **Fleet:** in the producer test, assert the `where` passed to `db.select().from().innerJoin().where()` contains the provisional exclusion. Render it with `new PgDialect().sqlToQuery(...)` and expect `->'baseline'->>'provisional'` to appear under a `not`.
- **AI device tool:** in `aiToolsDevice.hardwareHealth.test.ts`, mock `getDeviceReliability` to return `{ …, provisional: true, baseline: { id: 'b', baselineAt: '2026-10-01T00:00:00.000Z', reason: 'remediated', source: 'manual', reportedDaysSinceBaseline: 3, provisional: true } }` and assert `JSON.parse(output).reliability.baseline` equals `{ reason: 'remediated', baselineAt: '2026-10-01T00:00:00.000Z', provisional: true, reportedDaysSinceBaseline: 3 }`.
- **`get_fleet_health`:** in `aiToolsReliability.test.ts`, assert that a row with `provisional: true` yields `items[0].provisional === true`.
- **Device list:** in the devices core list test that already covers `reliabilityScore` (grep `reliabilityScore` under `apps/api/src/routes/devices/*.test.ts`), assert that `reliabilityProvisional` is mapped (`true` passes through, `null`/`undefined` becomes `false`).

- [ ] **Step 2: Run them to verify they fail.** Run each test file with `npx vitest run <file>`. Expected: FAIL.

- [ ] **Step 3: Implement**

- **`producers.ts`:** add `sql\`NOT ${reliabilityProvisionalSql}\`` to the `and(...)`, with a comment: `// #5876: a provisional score rests on <14 reported days since a fix — not yet evidence either way.`
- **`core.ts` select:** add `reliabilityProvisional: reliabilityProvisionalSql,` next to `reliabilityTrend`. **Row map:** add `reliabilityProvisional: d.reliabilityProvisional === true,`.

  Because the join is a `leftJoin`, `details` is NULL when there is no score row. `coalesce(...)` already returns `false` in that case.
- **`aiToolsDevice.ts`:** inside `result.reliability = reliability ? { … } : null`, add:
  ```ts
  // #5876: a fresh score after a fix/reimage is not long-term health.
  baseline: reliability.baseline
    ? {
        reason: reliability.baseline.reason,
        baselineAt: reliability.baseline.baselineAt,
        provisional: reliability.baseline.provisional,
        reportedDaysSinceBaseline: reliability.baseline.reportedDaysSinceBaseline,
      }
    : null,
  ```
- **`aiToolsUserRisk.ts` `shapeReliabilityRow`:** add `provisional: row.provisional,`.
- **`designEvidence.ts`:** the `reliabilityWorst` mapping becomes `({ deviceId: r.deviceId, score: r.reliabilityScore, trend: r.trendDirection, provisional: r.provisional })`, and the type at ~L170 gains `provisional: boolean`.
- **`runnerPrompt.ts` L1376:** append `${r.provisional ? ' (provisional — recent fix/reimage)' : ''}` to the line.

- [ ] **Step 4: Run the tests and typecheck.** Run the same files, then `npx tsc --noEmit -p tsconfig.json; echo EXIT=$?`. Expected: PASS and `EXIT=0`.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/fleetFindings/producers.ts apps/api/src/routes/devices/core.ts apps/api/src/services/aiToolsDevice.ts \
  apps/api/src/services/aiToolsUserRisk.ts apps/api/src/services/aiAgents/designEvidence.ts apps/api/src/services/aiAgents/runnerPrompt.ts \
  $(git diff --name-only -- '*.test.ts')
git commit -m "feat(api): surface provisional reliability to fleet findings, device list and AI tools (#5876)"
```

---

### Task 10: W1 verification gate

- [ ] **Step 1: Full API unit suite.** Run `cd apps/api && npx vitest run 2>&1 | tail -30`. Expected: 0 failures. This is the only run that catches `orgMerge.test.ts` "no merge policy registered".
- [ ] **Step 2: Contract and integration suites:**
  ```bash
  cd apps/api && npx vitest run --config vitest.integration.config.ts \
    src/__tests__/integration/tenantCascade.integration.test.ts \
    src/__tests__/integration/orgMergeRegistry.integration.test.ts \
    src/__tests__/integration/tenant-export-policy.integration.test.ts \
    src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts \
    src/__tests__/integration/orgLifecycleFoundations.integration.test.ts \
    src/__tests__/integration/deviceReliabilityBaselinesRls.integration.test.ts \
    src/__tests__/integration/reliabilityBaselines.integration.test.ts \
    src/__tests__/integration/reliabilityWeightProfile.integration.test.ts \
    src/__tests__/integration/reliabilityScoringProjection.integration.test.ts
  cd .. && DB_CONTEXTLESS_WRITE_STRICT=true pnpm --filter=@breeze/api test:rls-coverage
  ```
  Expected: all PASS. Check the reported file counts match the list, because "No test files found" means a path is wrong.
- [ ] **Step 3: Drift and naming.** Run `pnpm db:check-drift` and `scripts/check-migration-naming.sh --against-ref origin/main` (after `git fetch origin main`). Expected: clean. If the naming check fails because main gained a later migration, rename the file to sort after it, and update the `MIGRATION` constant in the RLS test.
- [ ] **Step 4: Manual verification as `breeze_app`.** Run `docker exec -it <test-stack pg container> psql -U breeze_app -d breeze`. Set an org context for org B, then try `INSERT INTO device_reliability_baselines (...)` for an org-A device. Expected: `new row violates row-level security policy`.
- [ ] **Step 5: Open the W1 PR** with `Closes #8311` in the body. Tear down with `pnpm test-stack down`.

---

# Wave W2 — Web

Branch: `feature/5876-reliability-baselines/wave-8312`, based on `main` after W1 merges.

### Task 11: Panel types, banner, provisional state and before/after

**Files:**
- Modify: `apps/web/src/components/devices/DeviceReliabilityPanel.tsx`
- Create: `apps/web/src/components/devices/ReliabilityBaselineSection.tsx` (banner, before/after and history, so the 830-line panel doesn't grow by another 300)
- Modify: `apps/web/src/locales/{en,de-DE,es-419,fr-CA,fr-FR,it-IT,pt-BR,tr-TR}/devices.json` (`deviceReliabilityPanel.baseline.*`)
- Test: `apps/web/src/components/devices/DeviceReliabilityPanel.test.tsx`

**Interfaces:**
- Consumes: the `GET /reliability/:deviceId` snapshot `.baseline` and `.provisional`, and `GET /reliability/:deviceId/baselines` (Task 6).
- Produces: `ReliabilityBaselineSection` with props `{ deviceId: string; snapshot: { reliabilityScore: number; crashCount30d: number; hangCount30d: number; serviceFailureCount30d: number; hardwareErrorCount30d: number; provisional: boolean; baseline: BaselineDetails | null }; canWrite: boolean; onChanged: () => void }`.

- [ ] **Step 1: Write the failing tests** (append to `DeviceReliabilityPanel.test.tsx`)

```tsx
describe('DeviceReliabilityPanel baselines (#5876)', () => {
  const baseSnapshot = {
    deviceId: 'dev-1', reliabilityScore: 92, trendDirection: 'stable', trendConfidence: 0, uptime30d: 100,
    crashCount30d: 0, hangCount30d: 0, serviceFailureCount30d: 0, hardwareErrorCount30d: 0, mtbfHours: null,
    topIssues: [], drivers: [], computedAt: '2026-10-09T00:00:00.000Z', provisional: true,
    baseline: { id: 'b1', baselineAt: '2026-10-05T00:00:00.000Z', reason: 'remediated', source: 'manual', reportedDaysSinceBaseline: 4, provisional: true },
  };
  const marker = {
    id: 'b1', baselineAt: '2026-10-05T00:00:00.000Z', reason: 'remediated', source: 'manual', note: 'Replaced RAM',
    createdBy: { id: 'u1', name: 'Alex Tech' }, createdAt: '2026-10-05T00:00:00.000Z', clearedAt: null, clearedBy: null, active: true,
    beforeSnapshot: { version: 1, scorerVersion: 'x', asOf: '2026-10-05T00:00:00.000Z', coverageDays: 40, reliabilityScore: 41,
      weightProfile: 'workstation', factors: { uptime: { score: 100 }, crashes: { score: 10 }, hangs: { score: 100 }, serviceFailures: { score: 100 }, hardwareErrors: { score: 100 } },
      counts30d: { crashes: 7, hangs: 0, serviceFailures: 0, hardwareErrors: 0 } },
  };
  const route = (url: string) => url.endsWith('/baselines')
    ? makeJsonResponse({ baselines: [marker] })
    : makeJsonResponse({ snapshot: baseSnapshot, history: [] });

  it('shows the provisional banner with reason, author, days and the note', async () => {
    fetchWithAuthMock.mockImplementation(async (url: string) => route(url));
    render(<DeviceReliabilityPanel deviceId="dev-1" />);
    const banner = await screen.findByTestId('reliability-baseline-banner');
    expect(banner).toHaveTextContent('Alex Tech');
    expect(banner).toHaveTextContent('4');
    expect(banner).toHaveTextContent('14');
    expect(banner).toHaveTextContent('Replaced RAM');
    expect(screen.getByTestId('reliability-provisional-pill')).toBeInTheDocument();
  });

  it('shows before → since for the score and the 30-day crash count', async () => {
    fetchWithAuthMock.mockImplementation(async (url: string) => route(url));
    render(<DeviceReliabilityPanel deviceId="dev-1" />);
    const row = await screen.findByTestId('reliability-before-after');
    expect(row).toHaveTextContent('41');
    expect(row).toHaveTextContent('92');
    expect(row).toHaveTextContent('7');
  });

  it('renders trend and MTBF as a dash while provisional', async () => {
    fetchWithAuthMock.mockImplementation(async (url: string) => route(url));
    render(<DeviceReliabilityPanel deviceId="dev-1" />);
    expect(await screen.findByTestId('reliability-trend-value')).toHaveTextContent('—');
  });

  it('shows no banner when there is no active marker', async () => {
    fetchWithAuthMock.mockImplementation(async (url: string) => url.endsWith('/baselines')
      ? makeJsonResponse({ baselines: [] })
      : makeJsonResponse({ snapshot: { ...baseSnapshot, provisional: false, baseline: null }, history: [] }));
    render(<DeviceReliabilityPanel deviceId="dev-1" />);
    await screen.findByTestId('reliability-factors');
    expect(screen.queryByTestId('reliability-baseline-banner')).toBeNull();
  });
});
```

- [ ] **Step 2: Run them to verify they fail.** Run `cd apps/web && npx vitest run src/components/devices/DeviceReliabilityPanel.test.tsx`. Expected: FAIL.

- [ ] **Step 3: Implement**

- In `DeviceReliabilityPanel.tsx`:
  - Extend `ReliabilitySnapshot` with `provisional?: boolean; baseline?: { id: string; baselineAt: string; reason: 'reimaged' | 'remediated' | 'hardware_replaced'; source: 'manual' | 'bare_metal_recovery'; reportedDaysSinceBaseline: number; provisional: boolean } | null;`.
  - Give the trend value element `data-testid="reliability-trend-value"`. Render `'—'` for trend and MTBF when `snapshot.provisional`.
  - Render a `data-testid="reliability-provisional-pill"` pill next to the score when provisional, and mute the score colour (`text-muted-foreground`) instead of using `scoreClass`.
  - Mount `<ReliabilityBaselineSection deviceId={deviceId} snapshot={…} canWrite={usePermissions().can('devices', 'write')} onChanged={() => void fetchReliability()} />` directly under the score area.
- In `ReliabilityBaselineSection.tsx`:
  - Fetch `/reliability/${deviceId}/baselines` with `fetchWithAuth` (a read, so `runAction` is not required). Find the `active` marker.
  - Render the banner (`data-testid="reliability-baseline-banner"`) using the i18n keys below. Include the note if present.
  - Render the before/after row (`data-testid="reliability-before-after"`). It shows the before score → the current score, and 30-day crashes, hangs, service failures and hardware errors as before → now. Add the "based on N days" caption when `coverageDays < 90`.
  - Render a collapsible history list (`data-testid="reliability-baseline-history"`). Task 12 adds the actions.
- i18n keys under `deviceReliabilityPanel.baseline`:

  ```json
  "baseline": {
    "reasons": { "reimaged": "Reimaged", "remediated": "Remediated", "hardware_replaced": "Hardware replaced" },
    "bannerProvisional": "Scoring since {{reason}} on {{date}} by {{who}} — provisional, {{days}} of {{required}} days reported",
    "bannerMature": "Scoring since {{reason}} on {{date}} by {{who}} ({{days}} days)",
    "system": "Breeze (automatic)",
    "provisional": "Provisional",
    "beforeAfterTitle": "Before → since",
    "basedOnDays": "Before based on {{count}} days of history",
    "history": "Marker history",
    "cleared": "Cleared"
  }
  ```

  Add real translations of these keys to all 7 non-English `devices.json` files. `localeParity.test.ts` requires every key in every locale, and `translationCoverage.test.ts` caps how many values may stay identical to the English, so copying the English text in will fail.

- [ ] **Step 4: Run the web tests, including i18n**

```bash
cd apps/web && npx vitest run src/components/devices/DeviceReliabilityPanel.test.tsx src/lib/i18n/
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/devices/DeviceReliabilityPanel.tsx apps/web/src/components/devices/ReliabilityBaselineSection.tsx \
  apps/web/src/components/devices/DeviceReliabilityPanel.test.tsx apps/web/src/locales/*/devices.json
git commit -m "feat(web): reliability baseline banner, provisional state and before/after (#5876)"
```

---

### Task 12: "Mark work done" dialog and clear action

**Files:**
- Create: `apps/web/src/components/devices/ReliabilityBaselineDialog.tsx`
- Modify: `apps/web/src/components/devices/ReliabilityBaselineSection.tsx`
- Modify: `apps/web/src/locales/*/devices.json`
- Modify: `apps/web/src/lib/__tests__/no-silent-mutations.test.ts` (add both component paths to `TARGET_GLOBS`)
- Test: `apps/web/src/components/devices/ReliabilityBaselineDialog.test.tsx`

**Interfaces:**
- Consumes: `POST /reliability/:deviceId/baselines` and `DELETE …/:baselineId` (Task 6).
- Produces: `ReliabilityBaselineDialog` with props `{ deviceId: string; open: boolean; onClose: () => void; onSaved: () => void }`.

- [ ] **Step 1: Write the failing tests**

```tsx
// apps/web/src/components/devices/ReliabilityBaselineDialog.test.tsx
import '@/lib/i18n';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ReliabilityBaselineDialog from './ReliabilityBaselineDialog';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));
const fetchMock = vi.mocked(fetchWithAuth);
const ok = (body: unknown, status = 201) => ({ ok: true, status, statusText: 'OK', json: vi.fn().mockResolvedValue(body) }) as unknown as Response;

describe('ReliabilityBaselineDialog (#5876)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('requires a note for Remediated before it can be saved', async () => {
    render(<ReliabilityBaselineDialog deviceId="dev-1" open onClose={vi.fn()} onSaved={vi.fn()} />);
    fireEvent.change(screen.getByTestId('baseline-reason'), { target: { value: 'remediated' } });
    expect(screen.getByTestId('baseline-save')).toBeDisabled();
    fireEvent.change(screen.getByTestId('baseline-note'), { target: { value: 'Replaced RAM' } });
    expect(screen.getByTestId('baseline-save')).not.toBeDisabled();
  });

  it('allows Reimaged without a note and posts reason + ISO time', async () => {
    fetchMock.mockResolvedValue(ok({ baseline: { id: 'b1' }, reliability: null }));
    const onSaved = vi.fn();
    render(<ReliabilityBaselineDialog deviceId="dev-1" open onClose={vi.fn()} onSaved={onSaved} />);
    fireEvent.change(screen.getByTestId('baseline-reason'), { target: { value: 'reimaged' } });
    fireEvent.click(screen.getByTestId('baseline-save'));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/reliability/dev-1/baselines');
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.reason).toBe('reimaged');
    expect(new Date(body.baselineAt).toString()).not.toBe('Invalid Date');
  });

  it('bounds the date input to the last 30 days', () => {
    render(<ReliabilityBaselineDialog deviceId="dev-1" open onClose={vi.fn()} onSaved={vi.fn()} />);
    const input = screen.getByTestId('baseline-at') as HTMLInputElement;
    expect(input.min).not.toBe('');
    expect(input.max).not.toBe('');
  });
});
```

Add to `DeviceReliabilityPanel.test.tsx`:
- The "Mark work done" button (`data-testid="reliability-mark-work-done"`) is hidden when `permState.permissions = [{ resource: 'devices', action: 'read' }]` and shown with the wildcard permission.
- Clicking "Clear" on the active history row, then confirming (`data-testid="reliability-baseline-clear-confirm"`), issues `DELETE /reliability/dev-1/baselines/b1`.

- [ ] **Step 2: Run them to verify they fail.** Run `cd apps/web && npx vitest run src/components/devices/ReliabilityBaselineDialog.test.tsx src/components/devices/DeviceReliabilityPanel.test.tsx`. Expected: FAIL.

- [ ] **Step 3: Implement**

`ReliabilityBaselineDialog.tsx` uses the shared `Dialog` (`../shared/Dialog`):
- A reason `<select data-testid="baseline-reason">`, defaulting to `remediated`.
- A `<input type="datetime-local" data-testid="baseline-at">` that defaults to now. Its `min` is now − 30 days and its `max` is now, both formatted as local `YYYY-MM-DDTHH:mm`.
- A `<textarea data-testid="baseline-note" maxLength={2000}>`, labelled required when the reason is remediated.
- Save (`data-testid="baseline-save"`) is disabled while submitting, or when the reason is `remediated` and the note is blank after trimming.
- On submit:

```ts
await runAction({
  request: () => fetchWithAuth(`/reliability/${deviceId}/baselines`, {
    method: 'POST',
    body: JSON.stringify({ reason, baselineAt: new Date(localValue).toISOString(), note: note.trim() || undefined }),
  }),
  errorFallback: t('deviceReliabilityPanel.baseline.saveError'),
  friendly: (code) => (code === 'baseline_too_old' ? t('deviceReliabilityPanel.baseline.tooOld')
    : code === 'baseline_in_future' ? t('deviceReliabilityPanel.baseline.inFuture')
    : code === 'note_required' ? t('deviceReliabilityPanel.baseline.noteRequired') : undefined),
  successMessage: t('deviceReliabilityPanel.baseline.saved'),
});
onSaved();
onClose();
```

Wrap it in `try/catch` using the CLAUDE.md caller pattern: return on a 401 `ActionError`, and toast only when the error is not an `ActionError`.

In `ReliabilityBaselineSection.tsx`:
- When `canWrite`, render the "Mark work done" button (`data-testid="reliability-mark-work-done"`, `Wrench` icon) and the dialog.
- History rows that are not cleared get a "Clear" button. It opens `ConfirmDialog` (`variant="warning"`, `confirmTestId="reliability-baseline-clear-confirm"`), whose confirm calls `runAction` with `DELETE /reliability/${deviceId}/baselines/${id}`. Close the dialog on success and on failure (the #2429 z-index note in `DeviceLinkedProfilesTab.tsx`).
- After a save or a clear, call `onChanged()` and refetch the list.

New i18n keys under `deviceReliabilityPanel.baseline`, translated in all 8 locales:
`markWorkDone`, `dialogTitle`, `reasonLabel`, `whenLabel`, `noteLabel`, `noteRequiredHint`, `save`, `saved`, `saveError`, `tooOld`, `inFuture`, `noteRequired`, `clear`, `clearTitle`, `clearMessage`, `clearConfirm`, `clearError`, `clearedToast`.

Add `'src/components/devices/ReliabilityBaselineDialog.tsx'` and `'src/components/devices/ReliabilityBaselineSection.tsx'` to `TARGET_GLOBS` in `no-silent-mutations.test.ts`.

- [ ] **Step 4: Run the tests.** Run `cd apps/web && npx vitest run src/components/devices/ src/lib/__tests__/no-silent-mutations.test.ts src/lib/i18n/`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/devices/ReliabilityBaselineDialog.tsx apps/web/src/components/devices/ReliabilityBaselineDialog.test.tsx \
  apps/web/src/components/devices/ReliabilityBaselineSection.tsx apps/web/src/components/devices/DeviceReliabilityPanel.test.tsx \
  apps/web/src/lib/__tests__/no-silent-mutations.test.ts apps/web/src/locales/*/devices.json
git commit -m "feat(web): mark reliability work done and clear markers (#5876)"
```

---

### Task 13: Device list provisional state and activity feed

**Files:**
- Modify: `apps/web/src/components/devices/DeviceList.tsx` (type ~L351; cell ~L2372)
- Modify: `apps/web/src/components/devices/DevicesPage.tsx` (~L812 row mapping)
- Modify: `apps/web/src/components/devices/DeviceActivityFeed.tsx` (`ACTION_RULES`)
- Test: `DeviceList.test.tsx`, `DeviceActivityFeed.test.tsx` (co-located; create a focused test only if none exists)

- [ ] **Step 1: Write the failing tests**

- **DeviceList:** a device with `reliabilityScore: 95, reliabilityProvisional: true` renders a cell (`device-<id>-reliability`) with a `title` containing "provisional", and does **not** carry the success band class.
- **DevicesPage mapping:** `reliabilityProvisional: true` from the API row reaches the `Device`.
- **Activity feed:** the `actions` query parameter sent to `/devices/:id/events` includes `device.reliability`.

- [ ] **Step 2: Run them to verify they fail.**

- [ ] **Step 3: Implement**

- **`DeviceList.tsx` `Device` type:** add `reliabilityProvisional?: boolean;`.
- **DeviceList cell:** when `device.reliabilityProvisional`, use `border-border bg-muted text-muted-foreground` instead of `reliabilityBandClass(score)`, and set the title to `` `Reliability ${score}/100 · provisional (recent fix or reimage)` ``.
- **`DevicesPage.tsx`:** add `reliabilityProvisional: d.reliabilityProvisional === true,`.
- **`DeviceActivityFeed.tsx` `ACTION_RULES`:** add `{ prefix: "device.reliability", icon: ShieldCheck },` and import `ShieldCheck` from lucide-react.

- [ ] **Step 4: Run the tests.** Run `cd apps/web && npx vitest run src/components/devices/`. Expected: PASS.

- [ ] **Step 5: Commit, then the W2 gate**

```bash
git add apps/web/src/components/devices/DeviceList.tsx apps/web/src/components/devices/DevicesPage.tsx \
  apps/web/src/components/devices/DeviceActivityFeed.tsx $(git diff --name-only -- 'apps/web/**/*.test.tsx')
git commit -m "feat(web): provisional reliability in the device list and baseline events in the activity feed (#5876)"
```

Then run the full web suite with `cd apps/web && npx vitest run` and `pnpm --filter @breeze/web exec astro check`. Do a manual browser pass on a worktree stack (`worktree-stack` skill):
- Mark work done on a device that has crash history.
- See the provisional banner and the before/after view.
- Clear the marker and see the score restore.
- Confirm both events appear in the activity feed.

Open the W2 PR with `Closes #8312` and `Closes #5876` (this is the final PR).
