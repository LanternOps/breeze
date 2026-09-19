---
tracking_issue: LanternOps/breeze#5650
---
# Fleet Designer W02: Device Function — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A typed home for "what is this device for": `device_function_assessments` with a manual-wins rule, projection columns on `devices`, a service every writer goes through, `GET/PUT /devices/:id/function`, a Function field beside Role on the device page, and `applyDesignFunctions` (the service W03's apply step calls for section 2).

**Architecture:** One migration creates the table (tenancy shape 5, denormalized `org_id`, composite `(device_id, org_id) → devices(id, org_id)` FK `ON UPDATE CASCADE ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED`, partial `UNIQUE (device_id) WHERE active`, `(run_id, org_id) → ai_agent_runs(id, org_id) ON DELETE SET NULL (run_id)`), adds `devices.device_function` / `device_function_source`, and installs four command-specific RLS policies. `services/deviceFunction.ts` is the only writer: it locks the device row `FOR UPDATE`, enforces manual-wins, supersedes the previous active row and rewrites the projection in the same transaction (contacts' parent-first pattern, `services/contacts/crud.ts`). The web reads the projection off the device DTO and the assessment (confidence, evidence) from the new GET.

**Tech Stack:** PostgreSQL + hand-written SQL migration, Drizzle, Hono + Zod, Vitest (unit + integration on real Postgres), React, react-i18next.

**Spec:** `docs/superpowers/specs/ai-mcp/2026-09-11-fleet-designer-agent-design.md` §4.5, §4.10 (device function routes and field), §4.11, §4.14; amendments 10, 13, 14 in the plan index. Advisor quorum (D4, 2026-09-12): agree with amendments — all adopted here: service-maintained projection under a device lock; `repoint` merge policy (device state follows the device; the org-move trigger re-stamps any table with `device_id` + `org_id`, so `leave-for-erasure` would have been a no-op anyway); `(run_id, org_id)` composite FK; `CHECK (confidence BETWEEN 0 AND 1)` with NULL for manual rows; `created_by_user_id` attribution.

## Global Constraints

- Migration `2026-10-15-180200-device-function-assessments.sql`: idempotent, no inner `BEGIN`/`COMMIT`, DDL only. RLS enabled + forced + four policies in the creating migration. Re-check `ls apps/api/migrations/*.sql | sort | tail -1` before committing.
- Register the table in the same PR: `CORE_ORG_CASCADE_DELETE_ORDER` (between `device_filesystem_snapshots` and `device_group_memberships`), `CORE_DEVICE_CASCADE_DELETE_TABLES` and `CORE_DEVICE_ORG_DENORMALIZED_TABLES` (`routes/devices/core.ts`), `CORE_TENANT_EXPORT_POLICY` (`evidence` → `excludedOpen`, rest `included`; `devices` entry gains the two projection columns), `orgMergeRegistry.ts` `REPOINT_TABLES`. It is auto-discovered by `rls-coverage` (has `org_id`).
- Every `device_function_assessments` write goes through `services/deviceFunction.ts`; nothing else touches the table or the projection columns.
- Manual wins: a `manual` active row is never superseded by an `ai` row; an `ai` row supersedes an older `ai` row; `PUT` with `functionKey: null` (clear) supersedes whatever is active and nulls the projection.
- Tests: `cd apps/api && npx vitest run <path>`; integration suite under `src/__tests__/integration/`; run the whole unit suite before the PR.
- Commit after every task with the trailer `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`. Branch `feature/5650-fleet-designer/wave-5652`; PR body `Closes #5652`. `get_feature_status` first.

---

## File Structure

| Path | Responsibility |
|---|---|
| `apps/api/migrations/2026-10-15-180200-device-function-assessments.sql` | table, FKs, indexes, RLS, projection columns (Task 1) |
| `apps/api/src/db/schema/deviceFunctionAssessments.ts`, `schema/devices.ts`, `schema/index.ts` | Drizzle (Task 1) |
| `tenantCascade.ts`, `routes/devices/core.ts`, `tenantExportPolicyRegistry.ts`, `orgMergeRegistry.ts` | registrations (Task 2) |
| `packages/shared/src/validators/deviceFunctions.ts`, `types/deviceFunction.ts` | `setDeviceFunctionSchema`, `DeviceFunctionDto` (Task 3) |
| `apps/api/src/services/deviceFunction.ts` (+ `.test.ts`) | `upsertDeviceFunction`, `clearDeviceFunction`, `getDeviceFunction`, `applyDesignFunctions` (Task 3) |
| `apps/api/src/routes/devices/function.ts` (+ `.test.ts`), `routes/devices/index.ts` | `GET/PUT /devices/:id/function` (Task 4) |
| `apps/api/src/__tests__/integration/deviceFunctionAssessments.integration.test.ts` | RLS forge, manual-wins, supersede, cascade, move-org, merge (Task 5) |
| `apps/web/src/lib/deviceFunctions.ts`, `components/devices/DeviceInfoTab.tsx`, `components/filters/filterFields.ts`, `apps/api/src/services/filterEngine.ts`, locales | Function field + filter (Task 6) |

---

### Task 0: Quorum record

- [ ] **Step 1:** Append to the spec §5 table a row `D4 amendments adopted (W02): repoint merge policy; (run_id, org_id) FK; CHECK confidence 0..1, NULL for manual; created_by_user_id.` Commit with the wave's first commit.

### Task 1: Migration and Drizzle schema

**Files:**
- Create: `apps/api/migrations/2026-10-15-180200-device-function-assessments.sql`
- Create: `apps/api/src/db/schema/deviceFunctionAssessments.ts`
- Modify: `apps/api/src/db/schema/devices.ts:63-64` (add two columns after `deviceRoleSource`), `apps/api/src/db/schema/index.ts` (export)

**Interfaces:**
- Produces: table `device_function_assessments`; `devices.device_function text NULL`, `devices.device_function_source text NULL CHECK IN ('ai','manual')`; Drizzle `deviceFunctionAssessments`, `devices.deviceFunction`, `devices.deviceFunctionSource`.

- [ ] **Step 1: Write the migration**

```sql
-- Fleet Designer W02 (spec §4.5, §4.11): device FUNCTION assessments — "what is
-- this device for", a second axis beside the coarse, billable device_role.
--
-- TENANCY: RLS shape 5 (device-id scoped, DENORMALIZED org_id) — a direct
-- breeze_has_org_access(org_id) policy, structurally pinned to the device by
-- the composite FK. Copies device_custom_field_values
-- (2026-10-11-160000): ON UPDATE CASCADE + DEFERRABLE INITIALLY DEFERRED, the
-- device-axis deferral moveOrg.coverage.test.ts pins (an org move flips the
-- devices row first and re-stamps children in the same after-row queue).
-- DDL only: no rows written, no breeze.scope election. Idempotent.

CREATE TABLE IF NOT EXISTS device_function_assessments (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id             uuid NOT NULL REFERENCES organizations (id),
  device_id          uuid NOT NULL,
  function_key       text NOT NULL,
  label              text NULL,
  -- NULL for a manual row (a technician states a fact, not a probability).
  confidence         numeric(3,2) NULL,
  -- Bounded display strings written by the designer; export excludedOpen.
  evidence           jsonb NOT NULL DEFAULT '[]'::jsonb,
  source             text NOT NULL,
  run_id             uuid NULL,
  report_run_id      uuid NULL REFERENCES report_runs (id) ON DELETE SET NULL,
  active             boolean NOT NULL DEFAULT true,
  superseded_at      timestamptz NULL,
  created_by_user_id uuid NULL REFERENCES users (id) ON DELETE SET NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT device_function_assessments_source_chk CHECK (source IN ('ai', 'manual')),
  CONSTRAINT device_function_assessments_confidence_chk CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  CONSTRAINT device_function_assessments_manual_confidence_chk CHECK (source <> 'manual' OR confidence IS NULL),
  CONSTRAINT device_function_assessments_key_chk CHECK (function_key ~ '^[a-z][a-z0-9_]{1,47}$' OR function_key ~ '^custom:[a-z0-9][a-z0-9-]{1,39}$'),
  CONSTRAINT device_function_assessments_superseded_chk CHECK ((active AND superseded_at IS NULL) OR (NOT active AND superseded_at IS NOT NULL))
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'device_function_assessments_device_org_fk') THEN
    ALTER TABLE device_function_assessments
      ADD CONSTRAINT device_function_assessments_device_org_fk
      FOREIGN KEY (device_id, org_id) REFERENCES devices (id, org_id)
      ON UPDATE CASCADE ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED;
  END IF;
  -- Provenance pinned to the SAME org as the run (ai_agent_runs_id_org_id_key
  -- exists since 2026-09-05-a). SET NULL (run_id) keeps the assessment when a
  -- run is erased; DEFERRABLE INITIALLY IMMEDIATE like every other composite
  -- FK on an org_id column (merge contract).
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'device_function_assessments_run_org_fk') THEN
    ALTER TABLE device_function_assessments
      ADD CONSTRAINT device_function_assessments_run_org_fk
      FOREIGN KEY (run_id, org_id) REFERENCES ai_agent_runs (id, org_id)
      ON DELETE SET NULL (run_id)
      DEFERRABLE INITIALLY IMMEDIATE;
  END IF;
END $$;

-- One ACTIVE assessment per device; history rows keep active = false.
CREATE UNIQUE INDEX IF NOT EXISTS device_function_assessments_active_device_uq
  ON device_function_assessments (device_id) WHERE active;
CREATE INDEX IF NOT EXISTS device_function_assessments_org_key_idx
  ON device_function_assessments (org_id, function_key) WHERE active;
CREATE INDEX IF NOT EXISTS device_function_assessments_device_idx
  ON device_function_assessments (device_id);
CREATE INDEX IF NOT EXISTS device_function_assessments_run_idx
  ON device_function_assessments (run_id) WHERE run_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS device_function_assessments_report_run_idx
  ON device_function_assessments (report_run_id) WHERE report_run_id IS NOT NULL;

ALTER TABLE device_function_assessments ENABLE ROW LEVEL SECURITY;
ALTER TABLE device_function_assessments FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS breeze_org_isolation_select ON device_function_assessments;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON device_function_assessments;
DROP POLICY IF EXISTS breeze_org_isolation_update ON device_function_assessments;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON device_function_assessments;
CREATE POLICY breeze_org_isolation_select ON device_function_assessments FOR SELECT
  USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON device_function_assessments FOR INSERT
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON device_function_assessments FOR UPDATE
  USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON device_function_assessments FOR DELETE
  USING (public.breeze_has_org_access(org_id));
GRANT SELECT, INSERT, UPDATE, DELETE ON device_function_assessments TO breeze_app;

-- Projection columns, maintained by services/deviceFunction.ts (never a trigger).
ALTER TABLE devices ADD COLUMN IF NOT EXISTS device_function text NULL;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS device_function_source text NULL;
ALTER TABLE devices DROP CONSTRAINT IF EXISTS devices_device_function_source_chk;
ALTER TABLE devices ADD CONSTRAINT devices_device_function_source_chk
  CHECK ((device_function IS NULL AND device_function_source IS NULL)
      OR (device_function IS NOT NULL AND device_function_source IN ('ai', 'manual')));
CREATE INDEX IF NOT EXISTS devices_org_device_function_idx
  ON devices (org_id, device_function) WHERE device_function IS NOT NULL;
```

- [ ] **Step 2: Drizzle**

`apps/api/src/db/schema/deviceFunctionAssessments.ts`:
```ts
import { boolean, check, foreignKey, index, jsonb, numeric, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { devices } from './devices';
import { organizations } from './organizations';
import { aiAgentRuns } from './aiAgents';
import { reportRuns } from './reports';
import { users } from './users';

/**
 * Device function assessments (Fleet Designer W02). Tenancy: RLS shape 5
 * (device-id scoped, DENORMALIZED org_id). Only services/deviceFunction.ts
 * writes here; the projection on devices.device_function is maintained by
 * that service in the same transaction. Deferrability is SQL-only.
 */
export const deviceFunctionAssessments = pgTable('device_function_assessments', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  deviceId: uuid('device_id').notNull(),
  functionKey: text('function_key').notNull(),
  label: text('label'),
  confidence: numeric('confidence', { precision: 3, scale: 2 }),
  evidence: jsonb('evidence').$type<string[]>().notNull().default([]),
  source: text('source').$type<'ai' | 'manual'>().notNull(),
  runId: uuid('run_id'),
  reportRunId: uuid('report_run_id').references(() => reportRuns.id, { onDelete: 'set null' }),
  active: boolean('active').notNull().default(true),
  supersededAt: timestamp('superseded_at', { withTimezone: true }),
  createdByUserId: uuid('created_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  deviceOrgFk: foreignKey({ name: 'device_function_assessments_device_org_fk', columns: [table.deviceId, table.orgId], foreignColumns: [devices.id, devices.orgId] }).onUpdate('cascade').onDelete('cascade'),
  runOrgFk: foreignKey({ name: 'device_function_assessments_run_org_fk', columns: [table.runId, table.orgId], foreignColumns: [aiAgentRuns.id, aiAgentRuns.orgId] }),
  activeDeviceUq: uniqueIndex('device_function_assessments_active_device_uq').on(table.deviceId).where(sql`${table.active}`),
  orgKeyIdx: index('device_function_assessments_org_key_idx').on(table.orgId, table.functionKey).where(sql`${table.active}`),
  deviceIdx: index('device_function_assessments_device_idx').on(table.deviceId),
  sourceChk: check('device_function_assessments_source_chk', sql`${table.source} IN ('ai', 'manual')`),
  confidenceChk: check('device_function_assessments_confidence_chk', sql`${table.confidence} IS NULL OR (${table.confidence} >= 0 AND ${table.confidence} <= 1)`),
}));
export type DeviceFunctionAssessment = typeof deviceFunctionAssessments.$inferSelect;
```
(Drizzle cannot express `ON DELETE SET NULL (run_id)` — leave the run FK without an onDelete in Drizzle and rely on the migration; `db:check-drift` tolerates action drift the way `ai_operator_operations` does — verify with `pnpm db:check-drift` and, if it flags it, mirror how `apps/api/src/db/schema/aiOperator*.ts` declares its run FK.)

`devices.ts` after :64:
```ts
  /** Fleet Designer W02 — projection of the active device_function_assessments row; written only by services/deviceFunction.ts. */
  deviceFunction: text('device_function'),
  deviceFunctionSource: text('device_function_source').$type<'ai' | 'manual'>(),
```
`schema/index.ts`: `export * from './deviceFunctionAssessments';`.

- [ ] **Step 3: Verify**

Run: `git add -A apps/api/migrations && scripts/check-migration-naming.sh --staged; cd apps/api && npx vitest run src/db/autoMigrate.test.ts src/db/migrationRlsScope.test.ts; pnpm test-stack up; pnpm db:migrate && pnpm db:check-drift`
Expected: guards PASS; migrate applies; no drift (or the tolerated FK-action note above).

- [ ] **Step 4: Commit**

```bash
git add apps/api/migrations/2026-10-15-180200-device-function-assessments.sql apps/api/src/db/schema
git commit -m "feat(db): device_function_assessments (shape 5) and device function projection columns"
```

### Task 2: Registrations

**Files:**
- Modify: `apps/api/src/services/tenantCascade.ts:403-406`, `apps/api/src/routes/devices/core.ts:261-302` + `:477-572`, `apps/api/src/services/tenantExportPolicyRegistry.ts` (`devices` entry :230 + new entry), `apps/api/src/services/orgMergeRegistry.ts:536+` (`REPOINT_TABLES`)

- [ ] **Step 1: Run the contract tests to see them fail**

Run: `cd apps/api && npx vitest run src/routes/devices/cascadeDelete.test.ts src/routes/devices/moveOrg.coverage.test.ts` → FAIL naming `device_function_assessments`. (The org-cascade, export-policy and merge-registry contracts only fail under Integration Tests — Task 5 runs them.)

- [ ] **Step 2: Register**

- `tenantCascade.ts`: insert `'device_function_assessments',` between `'device_filesystem_snapshots',` and `'device_group_memberships',`.
- `routes/devices/core.ts`: insert `'device_function_assessments',` in `CORE_DEVICE_ORG_DENORMALIZED_TABLES` after `'device_filesystem_snapshots',`; in `CORE_DEVICE_CASCADE_DELETE_TABLES` after the `device_custom_field_values` entry with the comment `// device function assessments (Fleet Designer W02) — FK (device_id, org_id) -> devices(id, org_id) ON DELETE CASCADE; leaf table, no children.`
- `tenantExportPolicyRegistry.ts`: add
```ts
"device_function_assessments": tablePolicy("org_id", {"included":["id","org_id","device_id","function_key","label","confidence","source","run_id","report_run_id","active","superseded_at","created_by_user_id","created_at"],"reviewedIncluded":[],"excludedSensitive":[],"excludedOpen":["evidence"]}),
```
and add `"device_function","device_function_source"` to the `devices` entry's `included` list after `"device_role_source"`.
- `orgMergeRegistry.ts`: add to `REPOINT_TABLES` with the comment `// device_function_assessments (Fleet Designer W02): plain repoint — device state follows the device; its only unique index is (device_id) WHERE active, which cannot collide across orgs.`

- [ ] **Step 3: Run, commit**

Run: `cd apps/api && npx vitest run src/routes/devices/cascadeDelete.test.ts src/routes/devices/moveOrg.coverage.test.ts src/services/tenantCascade.test.ts src/services/orgMergeRegistry.test.ts src/services/tenantExportPolicy.test.ts`

```bash
git add apps/api/src/services/tenantCascade.ts apps/api/src/routes/devices/core.ts apps/api/src/services/tenantExportPolicyRegistry.ts apps/api/src/services/orgMergeRegistry.ts
git commit -m "feat(api): register device_function_assessments in cascade, export and merge registries"
```

### Task 3: Shared validator, DTO, and the service

**Files:**
- Modify: `packages/shared/src/validators/deviceFunctions.ts` (add `setDeviceFunctionSchema`), `packages/shared/src/types/deviceFunction.ts` (new, export from `types/index.ts`)
- Create: `apps/api/src/services/deviceFunction.ts`, `apps/api/src/services/deviceFunction.test.ts`

**Interfaces:**
- Produces: `setDeviceFunctionSchema = z.object({ functionKey: z.string().max(48).nullable(), label: z.string().trim().min(1).max(80).optional() }).strict()` refined so a non-null key parses with `parseFunctionKey` and a custom key carries a label; `DeviceFunctionDto { deviceId; functionKey: string | null; label: string | null; source: 'ai' | 'manual' | null; confidence: number | null; evidence: string[]; assessedAt: string | null; runId: string | null; reportRunId: string | null }`.
- Service: `getDeviceFunction(deviceId, orgId): Promise<DeviceFunctionDto>`; `upsertDeviceFunction(input: { deviceId; orgId; functionKey; label?; source: 'ai' | 'manual'; confidence?: number | null; evidence?: string[]; runId?: string | null; reportRunId?: string | null; userId?: string | null }): Promise<{ outcome: 'written' | 'kept_manual'; assessmentId: string | null }>`; `clearDeviceFunction({ deviceId, orgId, userId })`; `applyDesignFunctions(input: { orgId; reportRunId; runId: string | null; userId; functions: { functionKey; label?; deviceIds; confidence; evidence }[] }): Promise<{ written: number; keptManual: number; skippedForeign: number }>`.
- Consumes: `parseFunctionKey` (W01).

- [ ] **Step 1: Failing unit tests** (Drizzle mock harness as in `services/contacts/crud.test.ts`; assert statement shapes)

```ts
describe('upsertDeviceFunction', () => {
  it('locks the device row FOR UPDATE in the device\'s org before writing', …);   // first statement: select devices where id AND org_id … for update
  it('keeps a manual row when an ai write arrives (kept_manual, no insert, projection unchanged)', …);
  it('supersedes an active ai row (active=false, superseded_at=now) then inserts and rewrites the projection in one transaction', …);
  it('a manual write supersedes anything and stores confidence NULL', …);
  it('rejects an unknown function key and a custom key without a label', …);
});
describe('applyDesignFunctions', () => {
  it('skips device ids outside the org (skippedForeign) and never throws for them', …);
  it('writes one ai row per approved device with the run and report ids', …);
});
```
Run: `cd apps/api && npx vitest run src/services/deviceFunction.test.ts` → FAIL.

- [ ] **Step 2: Implement `services/deviceFunction.ts`**

```ts
export async function upsertDeviceFunction(input: UpsertDeviceFunctionInput) {
  const parsed = parseFunctionKey(input.functionKey);
  if (!parsed) throw new DeviceFunctionError('invalid_function_key');
  if (parsed.kind === 'custom' && !input.label) throw new DeviceFunctionError('label_required');
  const label = parsed.kind === 'custom' ? input.label! : (input.label ?? null);
  return db.transaction(async (tx) => {
    // Parent-first lock (contacts/crud.ts pattern): serialises competing writers
    // per device and pins the org the row will carry.
    const [device] = await tx.select({ id: devices.id, orgId: devices.orgId })
      .from(devices).where(and(eq(devices.id, input.deviceId), eq(devices.orgId, input.orgId))).limit(1).for('update');
    if (!device) throw new DeviceFunctionError('device_not_found');
    const [active] = await tx.select().from(deviceFunctionAssessments)
      .where(and(eq(deviceFunctionAssessments.deviceId, device.id), eq(deviceFunctionAssessments.orgId, device.orgId), eq(deviceFunctionAssessments.active, true))).limit(1);
    if (active && active.source === 'manual' && input.source === 'ai') return { outcome: 'kept_manual' as const, assessmentId: null };
    const now = new Date();
    if (active) {
      await tx.update(deviceFunctionAssessments).set({ active: false, supersededAt: now })
        .where(and(eq(deviceFunctionAssessments.id, active.id), eq(deviceFunctionAssessments.orgId, device.orgId)));
    }
    const [row] = await tx.insert(deviceFunctionAssessments).values({
      orgId: device.orgId, deviceId: device.id, functionKey: input.functionKey, label,
      confidence: input.source === 'manual' ? null : (input.confidence == null ? null : input.confidence.toFixed(2)),
      evidence: (input.evidence ?? []).slice(0, 20).map((e) => e.slice(0, 400)),
      source: input.source, runId: input.runId ?? null, reportRunId: input.reportRunId ?? null,
      createdByUserId: input.userId ?? null,
    }).returning({ id: deviceFunctionAssessments.id });
    await tx.update(devices).set({ deviceFunction: input.functionKey, deviceFunctionSource: input.source, updatedAt: now })
      .where(and(eq(devices.id, device.id), eq(devices.orgId, device.orgId)));
    return { outcome: 'written' as const, assessmentId: row!.id };
  });
}
```
`clearDeviceFunction` = same lock, supersede the active row (any source), set both projection columns NULL. `getDeviceFunction` selects the active row joined to `devices` (org-pinned) and maps to the DTO (`confidence` parsed with `Number`). `applyDesignFunctions` iterates functions × deviceIds, first loading the org's device id set in one query (`skippedForeign` counts misses), calling `upsertDeviceFunction({ …, source: 'ai' })` per device and tallying outcomes. Because `db` resolves to the request's ambient transaction inside a route (`apps/api/src/db/index.ts:525-552`), `db.transaction` here is a savepoint when called from the W03 apply route and a real transaction from the integration test.

- [ ] **Step 3: Run, typecheck, commit**

```bash
git add packages/shared/src apps/api/src/services/deviceFunction.ts apps/api/src/services/deviceFunction.test.ts
git commit -m "feat(api): device function service with manual-wins and projection"
```

### Task 4: Routes

**Files:**
- Create: `apps/api/src/routes/devices/function.ts`, `apps/api/src/routes/devices/function.test.ts`
- Modify: `apps/api/src/routes/devices/index.ts` (mount `functionRoutes` beside the other per-device sub-routers — follow how `core.ts`'s siblings are mounted)

- [ ] **Step 1: Failing route tests** (harness from `routes/devices/core.test.ts`): `GET /:id/function` returns the DTO (nulls when none) and 404 for a device outside access; `PUT /:id/function` with `{ functionKey: 'file_server' }` calls `upsertDeviceFunction` with `source: 'manual'`, `userId`, and audits `device.function.set`; `{ functionKey: null }` calls `clearDeviceFunction`; `{ functionKey: 'custom:pos' }` without label → 400; requires `devices:write` + MFA on PUT, `devices:read` on GET.

- [ ] **Step 2: Implement**

```ts
functionRoutes.get('/:id/function', requireDeviceRead, async (c) => {
  const auth = c.get('auth');
  const device = await loadDeviceForAccess(c.req.param('id'), auth);   // the same helper core.ts uses before PATCH /:id (~:1690) — reuse it, do not re-implement
  if (!device) return c.json({ error: 'Device not found' }, 404);
  return c.json(await getDeviceFunction(device.id, device.orgId));
});
functionRoutes.put('/:id/function', requireDeviceWrite, requireMfa(), zValidator('json', setDeviceFunctionSchema), async (c) => {
  const auth = c.get('auth');
  const body = c.req.valid('json');
  const device = await loadDeviceForAccess(c.req.param('id'), auth);
  if (!device) return c.json({ error: 'Device not found' }, 404);
  try {
    if (body.functionKey === null) await clearDeviceFunction({ deviceId: device.id, orgId: device.orgId, userId: auth.user.id });
    else await upsertDeviceFunction({ deviceId: device.id, orgId: device.orgId, functionKey: body.functionKey, label: body.label, source: 'manual', userId: auth.user.id });
  } catch (err) {
    if (err instanceof DeviceFunctionError) return c.json({ error: err.code }, 400);
    throw err;
  }
  writeRouteAudit(c, { orgId: device.orgId, action: 'device.function.set', resourceType: 'device', resourceId: device.id, resourceName: device.hostname, details: { functionKey: body.functionKey } });
  return c.json(await getDeviceFunction(device.id, device.orgId));
});
```
Also add `deviceFunction` and `deviceFunctionSource` to the device list and detail projections in `routes/devices/core.ts` (`GET /` select ~:763 and `GET /:id` ~:1227) so the web reads them off the existing DTOs.

- [ ] **Step 3: Run, commit**

```bash
git add apps/api/src/routes/devices
git commit -m "feat(api): GET/PUT /devices/:id/function"
```

### Task 5: Integration suite (live Postgres)

**Files:**
- Create: `apps/api/src/__tests__/integration/deviceFunctionAssessments.integration.test.ts` (harness from `deviceCustomFieldValues.integration.test.ts:107-193`)

- [ ] **Step 1: Cases**
1. Org token forge: inserting a row with `org_id = orgB` under `orgContext(orgA)` rejects with SQLSTATE `42501`.
2. Composite FK: inserting `(device of org A, org_id = orgB)` under system context rejects `23503`.
3. Partial unique: two active rows for one device reject `23505`; supersede then insert succeeds.
4. Manual wins: `upsertDeviceFunction(source:'manual')` then `(source:'ai')` → `kept_manual`, projection still the manual key.
5. Device delete cascades the assessments (call the device deletion service); org erasure succeeds with assessments present (the tenantCascade entry).
6. Move-org: move a device with an active assessment to org B (the `moveOrg` route/service) → the row's `org_id` is B (ON UPDATE CASCADE), no 23503.
7. Merge: merge org A into B with an assessment in A → row repointed (run the `orgMergeRegistry.integration.test.ts` helper for one table if it exposes one; otherwise assert `getOrgMergePolicies().device_function_assessments.kind === 'repoint'` and rely on the registry suite).
8. Contract suites: run `rls-coverage`, `tenantCascade`, `tenant-export-policy`, `tenantExportErasureRoundtrip`, `orgMergeRegistry` integration tests and confirm they pass with the new table.

- [ ] **Step 2: Run**

`pnpm test-stack up; cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/deviceFunctionAssessments.integration.test.ts src/__tests__/integration/rls-coverage.integration.test.ts src/__tests__/integration/tenantCascade.integration.test.ts src/__tests__/integration/tenant-export-policy.integration.test.ts src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts src/__tests__/integration/orgMergeRegistry.integration.test.ts` — check the file count and that every case RAN. Then `docker exec -it <test-stack pg> psql -U breeze_app -d breeze` and forge a cross-tenant insert by hand once: expect `new row violates row-level security policy`.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/__tests__/integration/deviceFunctionAssessments.integration.test.ts
git commit -m "test(api): device function assessments RLS, manual-wins, cascade, move and merge"
```

### Task 6: Web — Function field beside Role, list filter

**Files:**
- Create: `apps/web/src/lib/deviceFunctions.ts` (mirror of `DEVICE_FUNCTION_KEYS` with the compile-time parity check `lib/deviceRoles.ts:19-30` uses, plus `getDeviceFunctionLabel(key, label?)` reading `DEVICE_FUNCTION_LABELS` from `@breeze/shared` and returning `label ?? key` for custom)
- Modify: `apps/web/src/components/devices/DeviceInfoTab.tsx:761-843` — add a **Function** row after Role: display chip (label + source badge `AI` / `Manual` + confidence when `ai`), pencil → select over `DEVICE_FUNCTION_KEYS` + "Custom…" free-text (slug + label) + "Clear"; save via `runAction({ request: () => fetchWithAuth(\`/devices/${deviceId}/function\`, { method: 'PUT', body: JSON.stringify(...) }), errorFallback: t('deviceInfoTab.functionSaveFailed'), successMessage: t('deviceInfoTab.functionSaved') })`; evidence list shown in a `<details>` when source is `ai` (fetched from `GET /devices/:id/function` on expand)
- Modify: `apps/web/src/components/filters/filterFields.ts:32-33` (add `{ key: 'deviceFunction', label: 'Device Function', category: 'core', type: 'enum', operators: E, enumValues: [...DEVICE_FUNCTION_KEYS] }`), `apps/api/src/services/filterEngine.ts` (`FILTER_FIELDS` + `getColumnForField` → `devices.deviceFunction`)
- Locales (8): `devices.json` — `deviceInfoTab.function`, `functionSource.ai`, `functionSource.manual`, `functionConfidence` (`"{{pct}}% confidence"`), `functionEvidence`, `functionCustom`, `functionCustomLabel`, `functionClear`, `functionSaved`, `functionSaveFailed`; `filters` namespace label for the new field if labels are localized there.
- Tests: `DeviceInfoTab.test.tsx` (round-trip: renders chip from DTO, PUT body on save, clear), `filterFields.test.ts` / `filterEngine.test.ts` (new field resolves), locale gates.

- [ ] **Step 1: Failing tests**, **Step 2: implement**, **Step 3: run** `cd apps/web && npx vitest run src/components/devices/DeviceInfoTab src/components/filters src/lib/i18n src/lib/__tests__/no-silent-mutations.test.ts && npx astro check && pnpm lint`; `cd apps/api && npx vitest run src/services/filterEngine`.

- [ ] **Step 4: Commit and PR**

```bash
git add apps/web/src apps/api/src/services/filterEngine.ts
git commit -m "feat(web): device Function field beside Role and a Device Function filter"
```
Before the PR: `cd apps/api && npx vitest run`; the integration suites of Task 5; `pnpm db:check-drift`. PR body lists the new table with its tenancy shape, the six registrations, and `Closes #5652`.
