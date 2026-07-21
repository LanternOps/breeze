# Device Instability Shadow Model — Phase A (Foundation & Contracts) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the tenant-isolated foundation for the device-instability shadow model — feature flag, the `device_instability_candidates` table (RLS + cascade), and an empty (zeroed) evaluation endpoint behind authz — without the scorer.

**Architecture:** Pure additive foundation in the existing TypeScript/Hono/Drizzle/Postgres stack. A new Shape-1 (direct `org_id`) tenant table mirrors `metric_anomalies`. A new ML feature flag (default off) gates all future writes. An empty admin evaluation endpoint establishes the contract Phase C will fill. No worker, no scoring, no UI in this phase.

**Tech Stack:** Hono, Drizzle ORM, PostgreSQL (hand-written idempotent SQL migrations), Vitest (unit + integration configs), BullMQ (not used until Phase B).

## Global Constraints

- **Spec:** `docs/superpowers/specs/ai-mcp/2026-06-23-ml-device-instability-shadow-execution-addendum.md` (extends `internal/specs/2026-06-19-ml-device-instability-shadow-plan.md`). Where they conflict, the addendum wins.
- **Phase B gate:** Do NOT build the scorer in this plan. The scorer depends on reliability v0 fix PR #1851 being merged. This plan is Phase A only and ships independently.
- **Out of scope here:** the `device_status_changes` flap ledger (deferred per addendum §#2), the scorer/worker (Phase B), evaluation logic (Phase C), UI (Phase D).
- **Migrations:** hand-written SQL under `apps/api/migrations/`, filename `YYYY-MM-DD-<slug>.sql`, fully idempotent (`IF NOT EXISTS`, `DROP POLICY IF EXISTS` then `CREATE`), no inner `BEGIN;`/`COMMIT;` (autoMigrate wraps each file in a transaction). Never edit a shipped migration.
- **Tenant isolation:** new tenant table MUST enable + force RLS with `breeze_has_org_access(org_id)` policies for all four DML commands, and `GRANT ... TO breeze_app`. A direct-`org_id` Shape-1 table is auto-discovered by the RLS coverage contract test — no allowlist entry. It MUST be added to `ORG_CASCADE_DELETE_ORDER` in `localeCompare` order.
- **Flag default:** `ml.device_instability.shadow.enabled` defaults to `false` (off until baked).
- **Model version constant:** `device-instability-v0-shadow`. Horizon default: `72` hours.
- **Node:** prefix `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH` for all pnpm/vitest commands.

---

## File Structure

| File | Responsibility | Action |
|---|---|---|
| `apps/api/src/services/mlFeatureFlags.ts` | Register the new flag + its default | Modify |
| `apps/api/src/services/mlFeatureFlags.test.ts` | Assert the new flag's default | Modify |
| `apps/api/migrations/2026-06-23-device-instability-candidates.sql` | Create table + RLS + indexes | Create |
| `apps/api/src/db/schema/analytics.ts` | Drizzle definition for the new table | Modify |
| `apps/api/src/db/schema/index.ts` | (already `export * from './analytics'` — verify) | Verify |
| `apps/api/src/services/tenantCascade.ts` | Add table to `ORG_CASCADE_DELETE_ORDER` | Modify |
| `apps/api/src/services/deviceInstability.ts` | Pure `emptyInstabilityEvaluationSummary()` + types | Create |
| `apps/api/src/services/deviceInstability.test.ts` | Unit-test the empty summary | Create |
| `apps/api/src/routes/reliability.ts` | Add `GET /instability/evaluation` handler | Modify |
| `apps/api/src/routes/reliability.test.ts` | Route test for the new endpoint | Modify |

---

## Task 1: Register the `ml.device_instability.shadow.enabled` feature flag

**Files:**
- Modify: `apps/api/src/services/mlFeatureFlags.ts` (the `ML_FEATURE_FLAGS` array, lines 6-18; `defaultMlFeatureFlagValue`, lines 100-120)
- Test: `apps/api/src/services/mlFeatureFlags.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: the flag literal `'ml.device_instability.shadow.enabled'` is now a valid `MlFeatureFlagName`; `defaultMlFeatureFlagValue('ml.device_instability.shadow.enabled', …)` returns `false`.

- [ ] **Step 1: Write the failing test**

Add to `apps/api/src/services/mlFeatureFlags.test.ts`, inside the existing defaults `describe` block:

```typescript
it('defaults the device-instability shadow flag to off (off until baked)', () => {
  expect(defaultMlFeatureFlagValue('ml.device_instability.shadow.enabled', { nodeEnv: 'production' })).toBe(false);
  expect(defaultMlFeatureFlagValue('ml.device_instability.shadow.enabled', { nodeEnv: 'development' })).toBe(false);
});

it('lists the device-instability shadow flag as a known ML flag', () => {
  expect(ML_FEATURE_FLAGS).toContain('ml.device_instability.shadow.enabled');
});
```

If `ML_FEATURE_FLAGS` is not already imported in the test file, add it to the existing import from `./mlFeatureFlags`.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && pnpm exec vitest run src/services/mlFeatureFlags.test.ts`
Expected: FAIL — the flag string is not assignable to `MlFeatureFlagName` (type error) / `ML_FEATURE_FLAGS` does not contain it.

- [ ] **Step 3: Add the flag to the array**

In `apps/api/src/services/mlFeatureFlags.ts`, add the entry to `ML_FEATURE_FLAGS` (keep the existing entries; append after `'ml.user_risk_v1.enabled'`):

```typescript
export const ML_FEATURE_FLAGS = [
  'ml.alert_correlation.enabled',
  'ml.rca.enabled',
  'ml.metric_rollups.enabled',
  'ml.anomalies.enabled',
  'ml.anomalies.v1_shadow.enabled',
  'ml.anomalies.create_alerts',
  'ml.remediation_suggestions.enabled',
  'ml.ticket_triage.enabled',
  'ml.device_reliability.enabled',
  'ml.user_risk_v0.enabled',
  'ml.user_risk_v1.enabled',
  'ml.device_instability.shadow.enabled',
] as const;
```

No change to `defaultMlFeatureFlagValue` is needed: the final `return false;` already makes it default-off. (The test asserts that explicitly so the default can't silently flip later.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/api && pnpm exec vitest run src/services/mlFeatureFlags.test.ts`
Expected: PASS (all cases, including the two new ones).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/mlFeatureFlags.ts apps/api/src/services/mlFeatureFlags.test.ts
git commit -m "feat(ml): register ml.device_instability.shadow.enabled flag (default off)"
```

---

## Task 2: Create the `device_instability_candidates` table (migration + schema + cascade)

**Files:**
- Create: `apps/api/migrations/2026-06-23-device-instability-candidates.sql`
- Modify: `apps/api/src/db/schema/analytics.ts` (append the table; reuse existing imports at lines 1-17)
- Verify: `apps/api/src/db/schema/index.ts` already has `export * from './analytics';`
- Modify: `apps/api/src/services/tenantCascade.ts` (`ORG_CASCADE_DELETE_ORDER`, lines 63-154)

**Interfaces:**
- Consumes: nothing.
- Produces: Drizzle table `deviceInstabilityCandidates` (exported from `db/schema`), backing SQL table `device_instability_candidates` with RLS + cascade. Columns later tasks/phases rely on: `id, orgId, deviceId, modelVersion, windowStart, windowEnd, predictedHorizonHours, score, riskLevel, topSignals, evidence, outcomeSummary, readinessState, baselineStartedAt, createdAt, updatedAt`.

- [ ] **Step 1: Write the migration**

Create `apps/api/migrations/2026-06-23-device-instability-candidates.sql`:

```sql
-- Device instability shadow model output (ML next phase, Phase A foundation).
-- Direct org_id RLS shape 1. Idempotent throughout.
-- autoMigrate wraps this file in a transaction (no inner BEGIN/COMMIT).

CREATE TABLE IF NOT EXISTS device_instability_candidates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id),
  device_id UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  model_version VARCHAR(60) NOT NULL DEFAULT 'device-instability-v0-shadow',
  window_start TIMESTAMP NOT NULL,
  window_end TIMESTAMP NOT NULL,
  predicted_horizon_hours INTEGER NOT NULL DEFAULT 72,
  score INTEGER NOT NULL DEFAULT 0,
  risk_level VARCHAR(20) NOT NULL DEFAULT 'low',
  readiness_state VARCHAR(20) NOT NULL DEFAULT 'learning',
  baseline_started_at TIMESTAMP,
  top_signals JSONB NOT NULL DEFAULT '[]'::jsonb,
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  outcome_summary JSONB,
  created_at TIMESTAMP NOT NULL DEFAULT now(),
  updated_at TIMESTAMP NOT NULL DEFAULT now(),
  CONSTRAINT device_instability_risk_level_check CHECK (
    risk_level IN ('low', 'medium', 'high', 'critical')
  ),
  CONSTRAINT device_instability_readiness_check CHECK (
    readiness_state IN ('learning', 'ready', 'insufficient_data')
  ),
  CONSTRAINT device_instability_window_check CHECK (window_start < window_end),
  CONSTRAINT device_instability_horizon_check CHECK (predicted_horizon_hours > 0),
  CONSTRAINT device_instability_score_check CHECK (score >= 0 AND score <= 100),
  CONSTRAINT device_instability_top_signals_array_check CHECK (jsonb_typeof(top_signals) = 'array'),
  CONSTRAINT device_instability_evidence_object_check CHECK (jsonb_typeof(evidence) = 'object'),
  CONSTRAINT device_instability_top_signals_size_check CHECK (octet_length(top_signals::text) <= 8192),
  CONSTRAINT device_instability_evidence_size_check CHECK (octet_length(evidence::text) <= 8192),
  CONSTRAINT device_instability_outcome_summary_object_check CHECK (
    outcome_summary IS NULL OR jsonb_typeof(outcome_summary) = 'object'
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS device_instability_candidates_key_uq
  ON device_instability_candidates (
    org_id,
    device_id,
    model_version,
    window_end,
    predicted_horizon_hours
  );

CREATE INDEX IF NOT EXISTS device_instability_org_risk_created_idx
  ON device_instability_candidates (org_id, risk_level, created_at DESC);

CREATE INDEX IF NOT EXISTS device_instability_device_created_idx
  ON device_instability_candidates (device_id, created_at DESC);

ALTER TABLE device_instability_candidates ENABLE ROW LEVEL SECURITY;
ALTER TABLE device_instability_candidates FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS breeze_org_isolation_select ON device_instability_candidates;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON device_instability_candidates;
DROP POLICY IF EXISTS breeze_org_isolation_update ON device_instability_candidates;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON device_instability_candidates;

CREATE POLICY breeze_org_isolation_select ON device_instability_candidates
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON device_instability_candidates
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON device_instability_candidates
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON device_instability_candidates
  FOR DELETE USING (public.breeze_has_org_access(org_id));

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE device_instability_candidates TO breeze_app;
```

- [ ] **Step 2: Verify the migration applies idempotently on a throwaway Postgres**

Run (applies twice; second run must be a clean no-op):

```bash
cd apps/api
docker run --rm -d --name breeze-mig-check -e POSTGRES_PASSWORD=pw -p 55432:5432 postgres:16
sleep 4
# minimal prerequisites: the helper fn + referenced tables must exist for a real apply;
# for a syntax/idempotency check, apply just this file twice against a DB where they exist,
# or rely on the full `pnpm db:check-drift` path below which runs the whole migration set.
docker exec -i breeze-mig-check psql -U postgres -c "SELECT 1;" >/dev/null && echo "pg up"
docker rm -f breeze-mig-check
```

Expected: container starts and stops cleanly. (Full apply happens via `db:check-drift` in Step 5, which runs the entire ordered migration set including the `breeze_has_org_access` function and `organizations`/`devices` tables.)

- [ ] **Step 3: Add the Drizzle schema definition**

In `apps/api/src/db/schema/analytics.ts`, append after the `metricAnomalies`/`metricAnomalyCandidates` definitions (the imports at lines 1-17 already include `pgTable, uuid, varchar, timestamp, jsonb, integer, index, uniqueIndex` and `organizations`, `devices`):

```typescript
export const deviceInstabilityCandidates = pgTable('device_instability_candidates', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  deviceId: uuid('device_id').notNull().references(() => devices.id, { onDelete: 'cascade' }),
  modelVersion: varchar('model_version', { length: 60 }).notNull().default('device-instability-v0-shadow'),
  windowStart: timestamp('window_start').notNull(),
  windowEnd: timestamp('window_end').notNull(),
  predictedHorizonHours: integer('predicted_horizon_hours').notNull().default(72),
  score: integer('score').notNull().default(0),
  riskLevel: varchar('risk_level', { length: 20 }).notNull().default('low'),
  readinessState: varchar('readiness_state', { length: 20 }).notNull().default('learning'),
  baselineStartedAt: timestamp('baseline_started_at'),
  topSignals: jsonb('top_signals').notNull().default([]),
  evidence: jsonb('evidence').notNull().default({}),
  outcomeSummary: jsonb('outcome_summary'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull()
}, (table) => ({
  keyUniq: uniqueIndex('device_instability_candidates_key_uq').on(
    table.orgId,
    table.deviceId,
    table.modelVersion,
    table.windowEnd,
    table.predictedHorizonHours
  ),
  orgRiskCreatedIdx: index('device_instability_org_risk_created_idx').on(table.orgId, table.riskLevel, table.createdAt),
  deviceCreatedIdx: index('device_instability_device_created_idx').on(table.deviceId, table.createdAt)
}));
```

- [ ] **Step 4: Add the cascade-order entry**

In `apps/api/src/services/tenantCascade.ts`, add `'device_instability_candidates'` to `ORG_CASCADE_DELETE_ORDER` in `localeCompare` position — it sorts between `'device_hardware'` and `'device_ip_history'`:

```typescript
  'device_hardware',
  'device_instability_candidates',
  'device_ip_history',
```

(Verify with `node -e "const a=['device_hardware','device_instability_candidates','device_ip_history']; console.log(JSON.stringify([...a].sort((x,y)=>x.localeCompare(y)))===JSON.stringify(a))"` → must print `true`.)

- [ ] **Step 5: Verify schema/migration agree (drift) and types compile**

Run:

```bash
cd /Users/toddhebebrand/breeze
export DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze"
pnpm db:check-drift
cd apps/api && pnpm exec tsc --noEmit -p tsconfig.json
```

Expected: `db:check-drift` reports no drift (schema matches the migration); `tsc` exits 0.

- [ ] **Step 6: Verify RLS + cascade contracts (real DB integration tests)**

These run in the Integration Tests CI job; run locally against the test DB. Per repo convention they live in `src/__tests__/integration/*` and need a real `breeze_app` DB:

```bash
cd apps/api
export DATABASE_URL="postgresql://breeze:breeze@localhost:5433/breeze"   # test DB
pnpm exec vitest run --config vitest.integration.config.ts src/__tests__/integration/rls-coverage.integration.test.ts
```

Expected: PASS — the new `org_id` table is auto-discovered and its four policies + FORCE RLS are present, so it does NOT appear in `offenders`. Then forge a cross-tenant insert as `breeze_app` and confirm it fails with `new row violates row-level security policy` (per CLAUDE.md verification step). Also run the org-cascade contract test in the same integration suite to confirm the new table is registered (a miss only shows here, not in unit tests).

- [ ] **Step 7: Commit**

```bash
git add apps/api/migrations/2026-06-23-device-instability-candidates.sql \
        apps/api/src/db/schema/analytics.ts \
        apps/api/src/services/tenantCascade.ts
git commit -m "feat(ml): device_instability_candidates table (RLS shape-1 + cascade)"
```

---

## Task 3: Empty instability evaluation endpoint (behind authz)

**Files:**
- Create: `apps/api/src/services/deviceInstability.ts`
- Create: `apps/api/src/services/deviceInstability.test.ts`
- Modify: `apps/api/src/routes/reliability.ts` (imports lines 1-15; add handler; router defined at the `export const reliabilityRoutes = new Hono()` line)
- Modify: `apps/api/src/routes/reliability.test.ts`

**Interfaces:**
- Consumes: `requireScope`, `requirePermission`/`requireReliabilityRead`, `authMiddleware` (already imported/used in `reliability.ts`); `zValidator`, `z`.
- Produces: exported `InstabilityEvaluationRange = '7d' | '30d' | '90d'`, `InstabilityEvaluationSummary` interface, and `emptyInstabilityEvaluationSummary(range: InstabilityEvaluationRange): InstabilityEvaluationSummary`. New route `GET /reliability/instability/evaluation?range=30d`.

- [ ] **Step 1: Write the failing unit test for the pure summary**

Create `apps/api/src/services/deviceInstability.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';

import { emptyInstabilityEvaluationSummary } from './deviceInstability';

describe('emptyInstabilityEvaluationSummary', () => {
  it('returns a zeroed summary with the model version and requested range', () => {
    const summary = emptyInstabilityEvaluationSummary('30d');
    expect(summary.modelVersion).toBe('device-instability-v0-shadow');
    expect(summary.window).toEqual({ range: '30d' });
    expect(summary.totalCandidates).toBe(0);
    expect(summary.byRiskLevel).toEqual({ low: 0, medium: 0, high: 0, critical: 0 });
    expect(summary.byReadiness).toEqual({ learning: 0, ready: 0, insufficient_data: 0 });
    expect(summary.outcomes).toEqual({ within72h: 0, highOrCriticalWithin72h: 0, highOrCriticalNoOutcome: 0 });
    expect(summary.rates).toEqual({ highOrCriticalOutcomeRate: null, mediumPlusOutcomeRate: null });
  });

  it('echoes other valid ranges', () => {
    expect(emptyInstabilityEvaluationSummary('7d').window).toEqual({ range: '7d' });
    expect(emptyInstabilityEvaluationSummary('90d').window).toEqual({ range: '90d' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && pnpm exec vitest run src/services/deviceInstability.test.ts`
Expected: FAIL — module `./deviceInstability` does not exist.

- [ ] **Step 3: Implement the pure summary module**

Create `apps/api/src/services/deviceInstability.ts`:

```typescript
// Device instability shadow model — evaluation contract (Phase A).
// The scorer (Phase B) and real evaluation (Phase C) are not built yet; this
// module pins the response shape so the admin endpoint exists and is testable.

export const DEVICE_INSTABILITY_MODEL_VERSION = 'device-instability-v0-shadow';

export type InstabilityEvaluationRange = '7d' | '30d' | '90d';

export interface InstabilityEvaluationSummary {
  modelVersion: string;
  window: { range: InstabilityEvaluationRange };
  totalCandidates: number;
  byRiskLevel: { low: number; medium: number; high: number; critical: number };
  byReadiness: { learning: number; ready: number; insufficient_data: number };
  outcomes: { within72h: number; highOrCriticalWithin72h: number; highOrCriticalNoOutcome: number };
  // Rates are null when there is nothing to divide by (no candidates yet).
  rates: { highOrCriticalOutcomeRate: number | null; mediumPlusOutcomeRate: number | null };
}

export function emptyInstabilityEvaluationSummary(
  range: InstabilityEvaluationRange,
): InstabilityEvaluationSummary {
  return {
    modelVersion: DEVICE_INSTABILITY_MODEL_VERSION,
    window: { range },
    totalCandidates: 0,
    byRiskLevel: { low: 0, medium: 0, high: 0, critical: 0 },
    byReadiness: { learning: 0, ready: 0, insufficient_data: 0 },
    outcomes: { within72h: 0, highOrCriticalWithin72h: 0, highOrCriticalNoOutcome: 0 },
    rates: { highOrCriticalOutcomeRate: null, mediumPlusOutcomeRate: null },
  };
}
```

- [ ] **Step 4: Run unit test to verify it passes**

Run: `cd apps/api && pnpm exec vitest run src/services/deviceInstability.test.ts`
Expected: PASS.

- [ ] **Step 5: Add the route handler**

In `apps/api/src/routes/reliability.ts`, add to the imports near the top:

```typescript
import {
  emptyInstabilityEvaluationSummary,
  type InstabilityEvaluationRange,
} from '../services/deviceInstability';
```

Then, after the existing `reliabilityRoutes.use('*', authMiddleware);` line and alongside the other handlers, add:

```typescript
const instabilityEvaluationQuerySchema = z.object({
  range: z.enum(['7d', '30d', '90d']).default('30d'),
  orgId: z.string().uuid().optional(),
});

// Internal/admin preview of the device-instability shadow model's quality.
// Phase A: returns a zeroed summary (no candidates produced yet) behind the same
// authz as the reliability surface. Phase C fills in real aggregation.
reliabilityRoutes.get(
  '/instability/evaluation',
  requireScope('organization', 'partner', 'system'),
  requireReliabilityRead,
  zValidator('query', instabilityEvaluationQuerySchema),
  async (c) => {
    const auth = c.get('auth');
    const query = c.req.valid('query');

    if (query.orgId && !auth.canAccessOrg(query.orgId)) {
      return c.json({ error: 'Access denied to this organization' }, 403);
    }

    return c.json(emptyInstabilityEvaluationSummary(query.range as InstabilityEvaluationRange));
  }
);
```

(If `z` / `zValidator` / `requireScope` / `requireReliabilityRead` are not already imported in this file, they are — see the existing handlers; reuse them.)

- [ ] **Step 6: Write the route test**

Add to `apps/api/src/routes/reliability.test.ts`, mirroring the auth-mock setup already used by the other cases in that file (same `app`/request harness and mocked `auth` context):

```typescript
describe('GET /reliability/instability/evaluation', () => {
  it('returns a zeroed summary for an authorized org-scope request', async () => {
    const res = await testRequest('/reliability/instability/evaluation?range=30d', { scope: 'organization' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.modelVersion).toBe('device-instability-v0-shadow');
    expect(body.window).toEqual({ range: '30d' });
    expect(body.totalCandidates).toBe(0);
    expect(body.byRiskLevel).toEqual({ low: 0, medium: 0, high: 0, critical: 0 });
  });

  it('defaults range to 30d when omitted', async () => {
    const res = await testRequest('/reliability/instability/evaluation', { scope: 'organization' });
    expect(res.status).toBe(200);
    expect((await res.json()).window).toEqual({ range: '30d' });
  });

  it('rejects an invalid range', async () => {
    const res = await testRequest('/reliability/instability/evaluation?range=bogus', { scope: 'organization' });
    expect(res.status).toBe(400);
  });
});
```

Note: `testRequest(path, { scope })` is a stand-in for whatever request helper `reliability.test.ts` already defines (it sets up `authMiddleware`/`auth` context). Use that file's existing helper and auth-mock pattern verbatim — do not invent a new harness. If the existing tests assert on `res.status`/`res.json()` directly via `app.request(...)`, follow that exact form instead.

- [ ] **Step 7: Run the route test + typecheck**

Run:
```bash
cd apps/api
pnpm exec vitest run src/routes/reliability.test.ts src/services/deviceInstability.test.ts
pnpm exec tsc --noEmit -p tsconfig.json
```
Expected: PASS; `tsc` exits 0.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/services/deviceInstability.ts \
        apps/api/src/services/deviceInstability.test.ts \
        apps/api/src/routes/reliability.ts \
        apps/api/src/routes/reliability.test.ts
git commit -m "feat(ml): empty device-instability evaluation endpoint behind authz"
```

---

## Phase A Done / Next

After all three tasks: the flag exists (off), the tenant-isolated table exists with passing RLS + cascade + drift checks, and `GET /reliability/instability/evaluation` returns a zeroed, range-validated summary behind authz. No behavior changes for users; nothing writes candidates yet.

**Not in this plan (separate plans, in order):**
1. **Phase B — Scorer v0** (gated on #1851): signal extractors (event-log bursts, metric anomalies, patch failures, reliability degradation; connectivity via last-seen/missed-check-ins), weighted score + readiness/learning caps, idempotent upserts, the `device-instability-shadow` BullMQ worker (mirror `reliabilityWorker.ts` init/shutdown + `index.ts` registration), all gated by `ml.device_instability.shadow.enabled`.
2. **Phase C — Evaluation:** fill `emptyInstabilityEvaluationSummary` with real outcome-linked aggregation; backfill for internal orgs.
3. **Phase D — Preview UI:** device-detail panel + minimal org-wide internal list.
4. **Deferred — flap ledger:** `device_status_changes` + `offlineDetector` write hook (needed for the connectivity flap feature).

## Self-Review

- **Spec coverage (addendum Phase A items):** feature flag → Task 1 ✓; `device_instability_candidates` schema/migration/RLS/cascade → Task 2 ✓; empty evaluation endpoint behind authz → Task 3 ✓. Plumbing checklist: flag ✓, RLS shape-1 auto-discovery (no allowlist) ✓, cascade order ✓, FK ON DELETE CASCADE ✓. Worker/scorer/ledger correctly deferred (out of Phase A scope) ✓.
- **Placeholder scan:** no TBD/TODO; all SQL, schema, and TypeScript shown in full. The one soft reference (route-test harness `testRequest`) is explicitly pinned to the existing `reliability.test.ts` pattern with a fallback to `app.request(...)`, because that harness already exists and must not be reinvented.
- **Type consistency:** `emptyInstabilityEvaluationSummary(range)` signature, `InstabilityEvaluationSummary` fields, and `DEVICE_INSTABILITY_MODEL_VERSION = 'device-instability-v0-shadow'` are identical across the service, its test, and the route. Drizzle column names match the SQL migration columns one-to-one (verified field by field). Cascade string `'device_instability_candidates'` matches the SQL table name and the Drizzle `pgTable` name.
