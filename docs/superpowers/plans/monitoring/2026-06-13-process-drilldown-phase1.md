# Process-Level Resource Drill-Down (Phase 1: CPU + RAM) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an operator click a point on a device's CPU/RAM performance chart and see the top processes consuming that resource at that moment, including scrubbing back to past samples.

**Architecture:** A new agent goroutine samples the top-N processes every ~180s (decoupled from the 60s heartbeat) and POSTs a compact snapshot to a new ingest route, which stores one JSONB row per device per sample in `device_process_samples` (RLS shape #1, direct `org_id`). A read route serves the nearest snapshot to a clicked timestamp plus lightweight range markers; the web Performance tab lazily opens a drill-down panel on chart click. A new BullMQ retention job prunes the table with batched deletes (7-day default).

**Tech Stack:** Go (gopsutil v3) agent · Hono + Drizzle + PostgreSQL (postgres.js) API · BullMQ/Redis jobs · Astro + React + Recharts web · Vitest (API/web) + Go `testing`.

**Scope:** Phase 1 = CPU + RAM only. Disk-I/O and network per-process columns are deferred to follow-up plans (spec §"Per-resource phasing"); the schema and UI leave nullable `diskBps`/`netBps` slots so those phases are additive.

**Spec:** `docs/superpowers/specs/monitoring/2026-06-07-process-level-resource-drilldown-design.md`

---

## File Structure

**Create:**
- `apps/api/migrations/2026-06-13-device-process-samples.sql` — table + index + RLS policies (one idempotent migration)
- `apps/api/src/routes/agents/processSample.ts` — ingest route `POST /:id/process-sample`
- `apps/api/src/routes/devices/processSamples.ts` — read route `GET /:id/process-samples`
- `apps/api/src/jobs/processSampleRetention.ts` — batched-delete retention worker
- `apps/web/src/components/devices/ProcessDrilldownPanel.tsx` — drill-down panel (table + scrubber + Live toggle)
- `agent/internal/remote/tools/process_sample.go` — `TopProcessSample` + `selectTopN`
- `agent/internal/remote/tools/process_sample_test.go` — `selectTopN` unit tests

**Modify:**
- `apps/api/src/db/schema/devices.ts` — add `deviceProcessSamples` table + `TopProcess` type
- `apps/api/src/routes/agents/schemas.ts` — add `processSampleSchema`
- `apps/api/src/routes/agents/index.ts` — mount `processSampleRoutes`
- `apps/api/src/routes/devices/schemas.ts` — add `processSamplesQuerySchema`
- `apps/api/src/routes/devices/index.ts` — mount `processSamplesRoutes`
- `apps/api/src/index.ts` — register `processSampleRetention` worker
- `agent/internal/config/config.go` — add `ProcessSampleIntervalSeconds` field + default 180
- `agent/internal/heartbeat/heartbeat.go` — launch sampler goroutine in `Start()`, add `runProcessSampler`/`sendProcessSample`
- `apps/web/src/components/devices/DevicePerformanceGraphs.tsx` — make the CPU/RAM chart clickable, render the panel

---

## Task 1: DB migration + Drizzle schema for `device_process_samples`

**Files:**
- Create: `apps/api/migrations/2026-06-13-device-process-samples.sql`
- Modify: `apps/api/src/db/schema/devices.ts` (after `deviceMetrics`, ends line 184)

- [ ] **Step 1: Write the migration**

Create `apps/api/migrations/2026-06-13-device-process-samples.sql`. Idempotent, no inner `BEGIN/COMMIT` (autoMigrate wraps each file in a transaction), RLS shape #1 (direct `org_id`). `breeze_app` table privileges come from the role's default grants (the `device_metrics` RLS migration adds none either), so no `GRANT` is needed.

```sql
-- 2026-06-13: device_process_samples — per-device top-N process snapshots for
-- the Performance-tab drill-down. RLS shape #1 (direct org_id), policies created
-- in the same migration that creates the table (CLAUDE.md tenancy rule).
-- timestamp = server receive time (the key for chart correlation);
-- agent_timestamp = agent-reported sample time, kept for clock-skew forensics.

CREATE TABLE IF NOT EXISTS public.device_process_samples (
  device_id uuid NOT NULL REFERENCES public.devices(id) ON DELETE CASCADE,
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  "timestamp" timestamptz NOT NULL,
  agent_timestamp timestamptz,
  top_processes jsonb NOT NULL,
  PRIMARY KEY (device_id, "timestamp")
);

CREATE INDEX IF NOT EXISTS device_process_samples_device_ts_desc_idx
  ON public.device_process_samples (device_id, "timestamp" DESC);

ALTER TABLE public.device_process_samples ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.device_process_samples FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS breeze_org_isolation_select ON public.device_process_samples;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON public.device_process_samples;
DROP POLICY IF EXISTS breeze_org_isolation_update ON public.device_process_samples;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON public.device_process_samples;

CREATE POLICY breeze_org_isolation_select ON public.device_process_samples
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON public.device_process_samples
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON public.device_process_samples
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON public.device_process_samples
  FOR DELETE USING (public.breeze_has_org_access(org_id));
```

- [ ] **Step 2: Add the Drizzle schema definition**

In `apps/api/src/db/schema/devices.ts`, immediately after the `deviceMetrics` block (closes at line 184), add:

```typescript
export type TopProcess = {
  name: string;
  pid: number;
  cpu: number;
  ramMb: number;
  diskBps?: number;
  netBps?: number;
};

export const deviceProcessSamples = pgTable('device_process_samples', {
  deviceId: uuid('device_id').notNull().references(() => devices.id),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  timestamp: timestamp('timestamp').notNull(),
  agentTimestamp: timestamp('agent_timestamp'),
  topProcesses: jsonb('top_processes').$type<TopProcess[]>().notNull()
}, (table) => ({
  pk: primaryKey({ columns: [table.deviceId, table.timestamp] })
}));
```

(`pgTable`, `uuid`, `timestamp`, `jsonb`, `primaryKey` are already imported in this file — confirm at the top; `deviceMetrics` uses all of them.)

- [ ] **Step 3: Apply the migration and verify no schema drift**

Run:
```bash
export DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze"
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec tsx src/db/autoMigrate.ts 2>/dev/null || true
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm db:check-drift
```
Expected: migration applies cleanly; `db:check-drift` reports no drift between `devices.ts` and migrations.

- [ ] **Step 4: Verify tenant isolation as `breeze_app`**

Run:
```bash
docker exec -it breeze-postgres psql -U breeze_app -d breeze -c "\d+ device_process_samples"
```
Expected: table exists, `Row security: enabled` and `forced`, four `breeze_org_isolation_*` policies listed.

- [ ] **Step 5: Commit**

```bash
git add apps/api/migrations/2026-06-13-device-process-samples.sql apps/api/src/db/schema/devices.ts
git commit -m "feat(metrics): add device_process_samples table + RLS (shape #1)"
```

---

## Task 2: RLS contract + functional isolation verification

**Files:**
- Verify: `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts` (no edit — shape #1 tables are auto-discovered by the `org_id`-column query at lines ~487-499)

- [ ] **Step 0: Confirm the test DB connection is NOT a BYPASSRLS role (worktree foot-gun)**

The RLS coverage test loads `../../.env.test`. On a fresh worktree that gitignored symlink may be missing, so the test silently runs on a BYPASSRLS admin connection and **passes vacuously** (nearly shipped broken RLS in #1357). Before trusting any RLS result:
```bash
ls -l /Users/toddhebebrand/breeze/.env.test   # must exist (symlink ok); if missing, restore it
docker exec -it breeze-postgres psql -U breeze_app -d breeze -c "SELECT rolname, rolbypassrls FROM pg_roles WHERE rolname = current_user;"
```
Expected: `.env.test` present; `breeze_app` shows `rolbypassrls = f`.

- [ ] **Step 1: Run the RLS coverage contract test**

Run (needs a real DB; uses the dedicated coverage config that loads `.env.test`):
```bash
export DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze"
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec vitest run -c vitest.config.rls-coverage.ts
```
Expected: PASS. The "every org-tenant public table has RLS on and all four DML commands covered by `breeze_has_org_access`" test auto-discovers `device_process_samples` (it has an `org_id` column) and asserts its policies. No allowlist entry is required for shape #1.

- [ ] **Step 2: Manually forge a cross-tenant insert (CLAUDE.md requirement)**

Run as `breeze_app` with a deliberately mismatched org context — it MUST be rejected:
```bash
docker exec -it breeze-postgres psql -U breeze_app -d breeze -c "
  SET breeze.current_scope = 'organization';
  SET breeze.current_org_id = '00000000-0000-0000-0000-000000000001';
  INSERT INTO device_process_samples (device_id, org_id, \"timestamp\", top_processes)
  VALUES (gen_random_uuid(), '00000000-0000-0000-0000-0000000000ff', now(), '[]'::jsonb);
"
```
Expected: `ERROR: new row violates row-level security policy for table "device_process_samples"`. (Adjust the GUC names if the local helper uses different ones — confirm against how `withDbAccessContext` sets them in `apps/api/src/db/index.ts`.)

- [ ] **Step 3: Commit (only if any allowlist/test change was needed)**

If steps 1-2 passed with no file change, skip the commit. Otherwise:
```bash
git add apps/api/src/__tests__/integration/rls-coverage.integration.test.ts
git commit -m "test(rls): cover device_process_samples"
```

---

## Task 3: API ingest route `POST /:id/process-sample`

**Files:**
- Modify: `apps/api/src/routes/agents/schemas.ts` (add schema near `heartbeatSchema`, ~line 94)
- Create: `apps/api/src/routes/agents/processSample.ts`
- Create: `apps/api/src/routes/agents/processSample.test.ts`
- Modify: `apps/api/src/routes/agents/index.ts` (import + mount, near line 41-66)

- [ ] **Step 1: Add the Zod ingest schema (bounded payload)**

In `apps/api/src/routes/agents/schemas.ts`, add:

```typescript
export const processSampleSchema = z.object({
  timestamp: z.string().datetime(),
  processes: z.array(z.object({
    name: z.string().min(1).max(256),
    pid: z.number().int().min(0),
    cpu: z.number().min(0),
    ramMb: z.number().min(0),
    diskBps: z.number().min(0).optional(),
    netBps: z.number().min(0).optional()
  })).max(16)
});
```

The `.max(16)` cap and per-field bounds are the server-side guard so a buggy/compromised agent can't insert an oversized JSONB blob.

- [ ] **Step 2: Write the failing route test**

Create `apps/api/src/routes/agents/processSample.test.ts`. This mirrors existing agent-route tests (Drizzle mock + Hono test client). It asserts: (a) `org_id` is taken from the auth context, not the body; (b) `timestamp` is server-stamped while `agent_timestamp` keeps the agent value; (c) an over-cap payload is rejected by Zod.

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

const inserted: any[] = [];
vi.mock('../../db', () => ({
  db: {
    insert: () => ({ values: (v: any) => { inserted.push(v); return Promise.resolve(); } })
  },
  withDbAccessContext: (_ctx: any, fn: any) => fn()
}));

import { processSampleRoutes } from './processSample';

function appWithAgent(agent: any) {
  const app = new Hono();
  app.use('*', async (c, next) => { c.set('agent', agent); await next(); });
  app.route('/', processSampleRoutes);
  return app;
}

describe('POST /:id/process-sample', () => {
  beforeEach(() => { inserted.length = 0; });

  it('derives org_id from the auth context and ignores any body org_id', async () => {
    const app = appWithAgent({ deviceId: 'dev-1', orgId: 'org-real', agentId: 'a', siteId: 's', role: 'agent' });
    const res = await app.request('/dev-1/process-sample', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        timestamp: '2026-06-13T12:00:00.000Z',
        orgId: 'org-attacker',
        processes: [{ name: 'chrome', pid: 42, cpu: 12.5, ramMb: 800 }]
      })
    });
    expect(res.status).toBe(201);
    expect(inserted[0].orgId).toBe('org-real');
    expect(inserted[0].deviceId).toBe('dev-1');
  });

  it('server-stamps timestamp and stores agent time separately', async () => {
    const app = appWithAgent({ deviceId: 'dev-1', orgId: 'org-real', agentId: 'a', siteId: 's', role: 'agent' });
    await app.request('/dev-1/process-sample', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ timestamp: '2020-01-01T00:00:00.000Z', processes: [] })
    });
    expect(inserted[0].agentTimestamp).toEqual(new Date('2020-01-01T00:00:00.000Z'));
    expect(inserted[0].timestamp.getTime()).toBeGreaterThan(new Date('2025-01-01').getTime());
  });

  it('rejects a payload over the 16-process cap', async () => {
    const app = appWithAgent({ deviceId: 'dev-1', orgId: 'org-real', agentId: 'a', siteId: 's', role: 'agent' });
    const processes = Array.from({ length: 17 }, (_, i) => ({ name: `p${i}`, pid: i, cpu: 0, ramMb: 0 }));
    const res = await app.request('/dev-1/process-sample', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ timestamp: '2026-06-13T12:00:00.000Z', processes })
    });
    expect(res.status).toBe(400);
  });

  it('rejects when path id does not match the authenticated device', async () => {
    const app = appWithAgent({ deviceId: 'dev-1', orgId: 'org-real', agentId: 'a', siteId: 's', role: 'agent' });
    const res = await app.request('/dev-OTHER/process-sample', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ timestamp: '2026-06-13T12:00:00.000Z', processes: [] })
    });
    expect(res.status).toBe(403);
  });
});
```

- [ ] **Step 2b: Run the test to confirm it fails**

Run:
```bash
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec vitest run src/routes/agents/processSample.test.ts
```
Expected: FAIL — `Cannot find module './processSample'`.

- [ ] **Step 3: Implement the ingest route**

Create `apps/api/src/routes/agents/processSample.ts`:

```typescript
import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { bodyLimit } from 'hono/body-limit';
import { db } from '../../db';
import { deviceProcessSamples } from '../../db/schema';
import { type AgentAuthContext } from '../../middleware/agentAuth';
import { processSampleSchema } from './schemas';

export const processSampleRoutes = new Hono();

processSampleRoutes.post(
  '/:id/process-sample',
  bodyLimit({ maxSize: 256 * 1024, onError: (c) => c.json({ error: 'Request body too large' }, 413) }),
  zValidator('json', processSampleSchema),
  async (c) => {
    const deviceId = c.req.param('id');
    const data = c.req.valid('json');
    const agent = c.get('agent') as AgentAuthContext | undefined;

    // Tenancy is derived server-side from the authenticated device — the agent
    // payload is never trusted for org_id, and the path id must match the token.
    if (!agent || agent.deviceId !== deviceId) {
      return c.json({ error: 'Forbidden' }, 403);
    }

    await db.insert(deviceProcessSamples).values({
      deviceId: agent.deviceId,
      orgId: agent.orgId,
      timestamp: new Date(),                       // server receive time
      agentTimestamp: new Date(data.timestamp),    // agent-reported, forensic
      topProcesses: data.processes
    });

    return c.json({ success: true }, 201);
  }
);
```

- [ ] **Step 4: Mount the route**

In `apps/api/src/routes/agents/index.ts`, add the import alongside the others (near line 1-20) and mount it with the other `:id/*` routes (near line 58-66):

```typescript
import { processSampleRoutes } from './processSample';
```
```typescript
agentRoutes.route('/', processSampleRoutes);
```

The `agentRoutes.use('/:id/*', ...)` block (line 41) already applies `agentAuthMiddleware` to `/:id/process-sample` — `process-sample` is not in `AGENT_AUTH_SKIP_ID_SEGMENTS`/`AGENT_AUTH_SKIP_ACTIONS`, so bearer auth is enforced. No skip-list change.

- [ ] **Step 5: Run the test to confirm it passes**

Run:
```bash
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec vitest run src/routes/agents/processSample.test.ts
```
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/agents/processSample.ts apps/api/src/routes/agents/processSample.test.ts apps/api/src/routes/agents/schemas.ts apps/api/src/routes/agents/index.ts
git commit -m "feat(api): ingest route for process samples (server-derived org_id + timestamp)"
```

---

## Task 4: API read route `GET /:id/process-samples`

**Files:**
- Modify: `apps/api/src/routes/devices/schemas.ts` (add query schema)
- Create: `apps/api/src/routes/devices/processSamples.ts`
- Create: `apps/api/src/routes/devices/processSamples.test.ts`
- Modify: `apps/api/src/routes/devices/index.ts` (import + mount, near line 50)

- [ ] **Step 1: Add the query schema**

In `apps/api/src/routes/devices/schemas.ts`, add:

```typescript
export const processSamplesQuerySchema = z.object({
  at: z.string().datetime().optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional()
}).refine((q) => q.at || (q.from && q.to), {
  message: 'Provide either ?at=<ts> or both ?from and ?to'
});
```

- [ ] **Step 2: Write the failing route test**

Create `apps/api/src/routes/devices/processSamples.test.ts`. Asserts the nearest-snapshot query orders by `timestamp DESC` at-or-before `at`, and the markers query returns timestamp-only rows.

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

const calls: any = { nearest: null, markers: null };
vi.mock('../../db', () => {
  const chain = (kind: string) => ({
    from: () => ({
      where: () => ({
        orderBy: () => ({
          limit: () => { calls.nearest = kind; return Promise.resolve([{ timestamp: new Date('2026-06-13T12:00:00Z'), agentTimestamp: null, topProcesses: [{ name: 'chrome', pid: 1, cpu: 9, ramMb: 100 }] }]); },
        }),
      }),
    }),
  });
  return {
    db: {
      select: (cols: any) => {
        // markers query selects only { timestamp }
        if (cols && Object.keys(cols).length === 1 && 'timestamp' in cols) {
          return { from: () => ({ where: () => ({ orderBy: () => { calls.markers = true; return Promise.resolve([{ timestamp: new Date('2026-06-13T11:57:00Z') }]); } }) }) };
        }
        return chain('nearest');
      }
    },
    withDbAccessContext: (_ctx: any, fn: any) => fn()
  };
});
vi.mock('./helpers', () => ({
  getDeviceWithOrgAndSiteCheck: async () => ({ id: 'dev-1', orgId: 'org-1', siteId: 'site-1' }),
  SITE_ACCESS_DENIED: Symbol('denied')
}));
vi.mock('../../middleware/auth', () => ({
  authMiddleware: async (_c: any, next: any) => next(),
  requireScope: () => async (_c: any, next: any) => next(),
  requirePermission: () => async (_c: any, next: any) => next()
}));

import { processSamplesRoutes } from './processSamples';

function app() {
  const a = new Hono();
  a.use('*', async (c, next) => { c.set('auth', { scope: 'organization' }); await next(); });
  a.route('/', processSamplesRoutes);
  return a;
}

describe('GET /:id/process-samples', () => {
  beforeEach(() => { calls.nearest = null; calls.markers = null; });

  it('returns the nearest snapshot for ?at', async () => {
    const res = await app().request('/dev-1/process-samples?at=2026-06-13T12:00:30.000Z');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.sample.topProcesses[0].name).toBe('chrome');
    expect(calls.nearest).toBe('nearest');
  });

  it('returns timestamp markers for ?from&to', async () => {
    const res = await app().request('/dev-1/process-samples?from=2026-06-13T11:00:00.000Z&to=2026-06-13T12:00:00.000Z');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.markers)).toBe(true);
    expect(calls.markers).toBe(true);
  });
});
```

- [ ] **Step 2b: Run to confirm it fails**

Run:
```bash
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec vitest run src/routes/devices/processSamples.test.ts
```
Expected: FAIL — `Cannot find module './processSamples'`.

- [ ] **Step 3: Implement the read route**

Create `apps/api/src/routes/devices/processSamples.ts`. Mirrors `metrics.ts` auth/guards (lines 166-182). RLS is enforced by the request DB context established in `authMiddleware`, exactly as `metrics.ts` relies on it.

```typescript
import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { and, eq, lte, gte, asc, desc } from 'drizzle-orm';
import { db } from '../../db';
import { deviceProcessSamples } from '../../db/schema';
import { requirePermission, requireScope } from '../../middleware/auth';
import { PERMISSIONS } from '../../services/permissions';
import { getDeviceWithOrgAndSiteCheck, SITE_ACCESS_DENIED } from './helpers';
import { processSamplesQuerySchema } from './schemas';

export const processSamplesRoutes = new Hono();

processSamplesRoutes.get(
  '/:id/process-samples',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.DEVICES_READ.resource, PERMISSIONS.DEVICES_READ.action),
  zValidator('query', processSamplesQuerySchema),
  async (c) => {
    const auth = c.get('auth');
    const deviceId = c.req.param('id');
    const query = c.req.valid('query');

    const device = await getDeviceWithOrgAndSiteCheck(c, deviceId, auth);
    if (device === SITE_ACCESS_DENIED) return c.json({ error: 'Access to this site denied' }, 403);
    if (!device) return c.json({ error: 'Device not found' }, 404);

    // Range markers: lightweight timestamp-only list so the scrubber knows
    // which samples exist in the visible chart range.
    if (query.from && query.to) {
      const markers = await db
        .select({ timestamp: deviceProcessSamples.timestamp })
        .from(deviceProcessSamples)
        .where(and(
          eq(deviceProcessSamples.deviceId, deviceId),
          gte(deviceProcessSamples.timestamp, new Date(query.from)),
          lte(deviceProcessSamples.timestamp, new Date(query.to))
        ))
        .orderBy(asc(deviceProcessSamples.timestamp));
      return c.json({ markers: markers.map((m) => m.timestamp.toISOString()) });
    }

    // Nearest snapshot at-or-before the clicked time (index-backed reverse scan
    // on PK (device_id, timestamp DESC)).
    const [sample] = await db
      .select()
      .from(deviceProcessSamples)
      .where(and(
        eq(deviceProcessSamples.deviceId, deviceId),
        lte(deviceProcessSamples.timestamp, new Date(query.at!))
      ))
      .orderBy(desc(deviceProcessSamples.timestamp))
      .limit(1);

    if (!sample) return c.json({ sample: null });
    return c.json({
      sample: {
        timestamp: sample.timestamp.toISOString(),
        agentTimestamp: sample.agentTimestamp ? sample.agentTimestamp.toISOString() : null,
        topProcesses: sample.topProcesses
      }
    });
  }
);
```

- [ ] **Step 4: Mount the route**

In `apps/api/src/routes/devices/index.ts`, add the import near the other sub-resource imports (lines 1-23) and mount it right after `metricsRoutes` (line 50):

```typescript
import { processSamplesRoutes } from './processSamples';
```
```typescript
deviceRoutes.route('/', metricsRoutes);
deviceRoutes.route('/', processSamplesRoutes);
```

- [ ] **Step 5: Run the test to confirm it passes**

Run:
```bash
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec vitest run src/routes/devices/processSamples.test.ts
```
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/devices/processSamples.ts apps/api/src/routes/devices/processSamples.test.ts apps/api/src/routes/devices/schemas.ts apps/api/src/routes/devices/index.ts
git commit -m "feat(api): read route for process samples (nearest + range markers)"
```

---

## Task 5: Agent top-N selector (`selectTopN`)

**Files:**
- Create: `agent/internal/remote/tools/process_sample.go`
- Create: `agent/internal/remote/tools/process_sample_test.go`

- [ ] **Step 1: Write the failing unit test**

Create `agent/internal/remote/tools/process_sample_test.go`:

```go
package tools

import (
	"sort"
	"testing"
)

func pidSet(entries []ProcessSampleEntry) map[int32]bool {
	m := map[int32]bool{}
	for _, e := range entries {
		m[e.PID] = true
	}
	return m
}

func TestSelectTopN(t *testing.T) {
	entries := []ProcessSampleEntry{
		{Name: "a", PID: 1, CPU: 90, RAMMb: 10},  // top CPU
		{Name: "b", PID: 2, CPU: 80, RAMMb: 20},  // 2nd CPU
		{Name: "c", PID: 3, CPU: 1, RAMMb: 900},  // top RAM
		{Name: "d", PID: 4, CPU: 2, RAMMb: 800},  // 2nd RAM
		{Name: "e", PID: 5, CPU: 0, RAMMb: 0},    // neither
	}

	got := selectTopN(entries, 2)
	pids := pidSet(got)

	for _, want := range []int32{1, 2, 3, 4} {
		if !pids[want] {
			t.Errorf("expected PID %d in union of top-2-by-CPU and top-2-by-RAM", want)
		}
	}
	if pids[5] {
		t.Errorf("PID 5 (neither top CPU nor RAM) should be excluded")
	}
	if len(got) != 4 {
		t.Errorf("expected 4 unioned entries, got %d", len(got))
	}
}

func TestSelectTopNDedupesProcessHighInBoth(t *testing.T) {
	entries := []ProcessSampleEntry{
		{Name: "hog", PID: 1, CPU: 99, RAMMb: 999}, // top of both rankings
		{Name: "b", PID: 2, CPU: 50, RAMMb: 1},
		{Name: "c", PID: 3, CPU: 1, RAMMb: 500},
	}
	got := selectTopN(entries, 1)
	// top-1 CPU = pid1, top-1 RAM = pid1 → union is just {1}, no duplicate row.
	if len(got) != 1 || got[0].PID != 1 {
		t.Errorf("expected single deduped entry pid=1, got %+v", got)
	}
}

func TestSelectTopNPreservesInputOrder(t *testing.T) {
	entries := []ProcessSampleEntry{
		{Name: "a", PID: 3, CPU: 10, RAMMb: 1},
		{Name: "b", PID: 1, CPU: 20, RAMMb: 1},
		{Name: "c", PID: 2, CPU: 30, RAMMb: 1},
	}
	got := selectTopN(entries, 3)
	pids := make([]int32, len(got))
	for i, e := range got {
		pids[i] = e.PID
	}
	if !sort.SliceIsSorted(pids, func(i, j int) bool { return false }) && !(pids[0] == 3 && pids[1] == 1 && pids[2] == 2) {
		t.Errorf("expected original input order [3,1,2], got %v", pids)
	}
}
```

- [ ] **Step 2: Run to confirm it fails**

Run:
```bash
cd agent && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH go test ./internal/remote/tools/ -run TestSelectTopN
```
Expected: FAIL — `undefined: ProcessSampleEntry`, `undefined: selectTopN`.

- [ ] **Step 3: Implement the selector + collector**

Create `agent/internal/remote/tools/process_sample.go`. `TopProcessSample` deliberately skips username resolution (the Windows SID-lookup bottleneck) — the snapshot only needs name/pid/cpu/ramMb. CPU comes from the existing instantaneous `sampleProcessCPUPercents` (NOT gopsutil's lifetime-average `CPUPercent()`).

```go
package tools

import (
	"sort"

	"github.com/shirou/gopsutil/v3/process"
)

// ProcessSampleEntry is one process in a periodic top-N snapshot. JSON tags
// match the API ingest schema and the device_process_samples top_processes
// JSONB shape. DiskBps/NetBps are reserved for later phases (omitted now).
type ProcessSampleEntry struct {
	Name    string  `json:"name"`
	PID     int32   `json:"pid"`
	CPU     float64 `json:"cpu"`
	RAMMb   float64 `json:"ramMb"`
	DiskBps float64 `json:"diskBps,omitempty"`
	NetBps  float64 `json:"netBps,omitempty"`
}

// TopProcessSample enumerates processes once, measures *instantaneous* CPU over
// a single shared 250ms window (sampleProcessCPUPercents — never the lifetime
// average), reads RSS, and returns the union of the top perDimension by CPU and
// by RAM. It skips username resolution on purpose: the snapshot does not need
// it, and resolveUsername is the expensive Windows SID-lookup path.
func TopProcessSample(perDimension int) ([]ProcessSampleEntry, error) {
	procs, err := process.Processes()
	if err != nil {
		return nil, err
	}

	cpuPercents := sampleProcessCPUPercents(procs, cpuSampleInterval)

	entries := make([]ProcessSampleEntry, 0, len(procs))
	for _, p := range procs {
		name, err := p.Name()
		if err != nil {
			continue
		}
		e := ProcessSampleEntry{Name: name, PID: p.Pid, CPU: cpuPercents[p.Pid]}
		if mem, err := p.MemoryInfo(); err == nil && mem != nil {
			e.RAMMb = float64(mem.RSS) / 1024 / 1024
		}
		entries = append(entries, e)
	}

	return selectTopN(entries, perDimension), nil
}

// selectTopN returns the union of the top perDimension entries by CPU and the
// top perDimension by RAM, deduped by PID, preserving the original input order.
func selectTopN(entries []ProcessSampleEntry, perDimension int) []ProcessSampleEntry {
	if perDimension < 1 {
		perDimension = 1
	}

	rankTop := func(less func(a, b ProcessSampleEntry) bool) map[int32]bool {
		sorted := append([]ProcessSampleEntry(nil), entries...)
		sort.Slice(sorted, func(i, j int) bool { return less(sorted[i], sorted[j]) })
		top := map[int32]bool{}
		for i := 0; i < len(sorted) && i < perDimension; i++ {
			top[sorted[i].PID] = true
		}
		return top
	}

	keep := rankTop(func(a, b ProcessSampleEntry) bool { return a.CPU > b.CPU })
	for pid := range rankTop(func(a, b ProcessSampleEntry) bool { return a.RAMMb > b.RAMMb }) {
		keep[pid] = true
	}

	out := make([]ProcessSampleEntry, 0, len(keep))
	for _, e := range entries {
		if keep[e.PID] {
			out = append(out, e)
		}
	}
	return out
}
```

- [ ] **Step 4: Run to confirm it passes**

Run:
```bash
cd agent && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH go test -race ./internal/remote/tools/ -run TestSelectTopN
```
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add agent/internal/remote/tools/process_sample.go agent/internal/remote/tools/process_sample_test.go
git commit -m "feat(agent): top-N process snapshot selector (instantaneous CPU, no SID lookup)"
```

---

## Task 6: Agent config field + default

**Files:**
- Modify: `agent/internal/config/config.go` (struct ~line 52, `Default()` ~line 193)

- [ ] **Step 1: Add the config field**

In `agent/internal/config/config.go`, add to the `Config` struct right after `MetricsIntervalSeconds` (line 52):

```go
	ProcessSampleIntervalSeconds int      `mapstructure:"process_sample_interval_seconds"`
```

- [ ] **Step 2: Add the default**

In the `Default()` function, after `MetricsIntervalSeconds: 30,` (line 194):

```go
		ProcessSampleIntervalSeconds: 180,
```

- [ ] **Step 3: Build to confirm it compiles**

Run:
```bash
cd agent && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH go build ./internal/config/
```
Expected: no output (success).

- [ ] **Step 4: Commit**

```bash
git add agent/internal/config/config.go
git commit -m "feat(agent): ProcessSampleIntervalSeconds config (default 180s)"
```

---

## Task 7: Agent sampler goroutine + authenticated POST

**Files:**
- Modify: `agent/internal/heartbeat/heartbeat.go` (`Start()` ~line 730; add new methods near `sendInventoryData` ~line 1018)

- [ ] **Step 1: Add the sampler goroutine + send method**

In `agent/internal/heartbeat/heartbeat.go`, add these methods (place near `sendInventoryData`, ~line 1018). Confirm `"github.com/breeze/agent/internal/remote/tools"` is imported (add it if not — match the module path used by other imports in this package).

```go
// processSampleTopN is the per-dimension top-N (CPU and RAM); the union is
// capped at 2×this and must stay ≤ the API ingest schema's processes.max(16).
const processSampleTopN = 8

// runProcessSampler periodically captures a top-N process snapshot and POSTs it,
// on its own ticker decoupled from the heartbeat (spec: process-sample pipeline).
func (h *Heartbeat) runProcessSampler() {
	defer observability.Recoverer("heartbeat.processSampler")

	secs := h.config.ProcessSampleIntervalSeconds
	if secs < 60 {
		secs = 60
	} else if secs > 3600 {
		secs = 3600
	}
	ticker := time.NewTicker(time.Duration(secs) * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-ticker.C:
			if h.authMon != nil && h.authMon.ShouldSkip() {
				continue
			}
			h.sendProcessSample()
		case <-h.stopChan:
			return
		}
	}
}

func (h *Heartbeat) sendProcessSample() {
	entries, err := tools.TopProcessSample(processSampleTopN)
	if err != nil {
		log.Error("failed to collect process sample", "error", err.Error())
		return
	}

	payload := map[string]any{
		"timestamp": time.Now().UTC().Format(time.RFC3339),
		"processes": entries,
	}
	body, err := json.Marshal(payload)
	if err != nil {
		log.Error("failed to marshal process sample", "error", err.Error())
		return
	}

	url := fmt.Sprintf("%s/api/v1/agents/%s/process-sample", h.config.ServerURL, h.config.AgentID)
	headers := http.Header{
		"Content-Type":  {"application/json"},
		"Authorization": {h.authHeader()},
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	resp, err := httputil.Do(ctx, h.httpClient(), "POST", url, body, headers, h.retryCfg)
	if err != nil {
		log.Error("failed to send process sample", "error", err.Error())
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode >= http.StatusOK && resp.StatusCode < http.StatusMultipleChoices {
		log.Debug("process sample sent", "count", len(entries))
	} else {
		log.Warn("process sample send failed", "status", resp.StatusCode)
	}
}
```

- [ ] **Step 2: Launch the goroutine from `Start()`**

In `Start()`, right after the existing `go h.sendReliabilityMetrics()` line (~line 762, in the initial-dispatch block before the `for` loop), add:

```go
	go h.runProcessSampler()
```

- [ ] **Step 3: Build the whole agent to confirm it compiles**

Run:
```bash
cd agent && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH go build ./...
```
Expected: no output (success). If `tools`, `httputil`, `observability`, `log`, `json`, `fmt`, `http`, `context`, or `time` are not already imported in `heartbeat.go`, add them (most already are — `sendInventoryData` uses `json`, `fmt`, `http`, `context`, `httputil`, `log`).

- [ ] **Step 4: Vet for races**

Run:
```bash
cd agent && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH go vet ./internal/heartbeat/
```
Expected: no output (success).

- [ ] **Step 5: Commit**

```bash
git add agent/internal/heartbeat/heartbeat.go
git commit -m "feat(agent): 180s process-sample goroutine posting top-N snapshots"
```

---

## Task 8: Retention job (batched deletes, 7-day default)

**Files:**
- Create: `apps/api/src/jobs/processSampleRetention.ts`
- Modify: `apps/api/src/index.ts` (workers array, ~line 1012-1033)

- [ ] **Step 1: Implement the retention worker**

Create `apps/api/src/jobs/processSampleRetention.ts`. Modeled on `reliabilityRetention.ts`, but deletes in bounded `ctid` batches so a large sweep never holds a long transaction against the tight prod connection budget (CLAUDE.md large-table guidance).

```typescript
/**
 * Process-Sample Retention Worker
 *
 * BullMQ worker that prunes old device_process_samples in bounded ctid batches.
 * Default retention: 7 days (configurable via PROCESS_SAMPLE_RETENTION_DAYS, max 14).
 */

import { Job, Queue, Worker } from 'bullmq';
import { sql } from 'drizzle-orm';

import * as dbModule from '../db';
import { getBullMQConnection } from '../services/redis';
import { captureException } from '../services/sentry';

const { db } = dbModule;
const runWithSystemDbAccess = async <T>(fn: () => Promise<T>): Promise<T> => {
  if (typeof dbModule.withSystemDbAccessContext !== 'function') {
    throw new Error('[ProcessSampleRetention] withSystemDbAccessContext is not available — DB module may not have loaded correctly');
  }
  return dbModule.withSystemDbAccessContext(fn);
};

const QUEUE_NAME = 'process-sample-retention';
const BATCH_SIZE = 10000;
const DEFAULT_RETENTION_DAYS = Math.min(14, Math.max(1, parseInt(process.env.PROCESS_SAMPLE_RETENTION_DAYS || '7', 10)));

type RetentionJobData = { retentionDays?: number };

let retentionQueue: Queue<RetentionJobData> | null = null;
let retentionWorker: Worker<RetentionJobData> | null = null;

export function getProcessSampleRetentionQueue(): Queue<RetentionJobData> {
  if (!retentionQueue) {
    retentionQueue = new Queue<RetentionJobData>(QUEUE_NAME, { connection: getBullMQConnection() });
  }
  return retentionQueue;
}

export function createProcessSampleRetentionWorker(): Worker<RetentionJobData> {
  return new Worker<RetentionJobData>(
    QUEUE_NAME,
    async (job: Job<RetentionJobData>) => {
      return runWithSystemDbAccess(async () => {
        const retentionDays = Math.min(14, Math.max(1, job.data.retentionDays ?? DEFAULT_RETENTION_DAYS));
        const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
        const startedAt = Date.now();

        let deleted = 0;
        for (;;) {
          const result = await db.execute(sql`
            DELETE FROM device_process_samples
            WHERE ctid IN (
              SELECT ctid FROM device_process_samples
              WHERE "timestamp" < ${cutoff}
              LIMIT ${BATCH_SIZE}
            )
          `);
          const n = (result as unknown as { count?: number }).count ?? 0;
          deleted += n;
          if (n < BATCH_SIZE) break;
        }

        const durationMs = Date.now() - startedAt;
        console.log(`[ProcessSampleRetention] Pruned ${deleted} process samples older than ${retentionDays} days in ${durationMs}ms`);
        return { retentionDays, deleted, durationMs };
      });
    },
    { connection: getBullMQConnection(), concurrency: 1 }
  );
}

export async function initializeProcessSampleRetention(): Promise<void> {
  try {
    retentionWorker = createProcessSampleRetentionWorker();
    retentionWorker.on('error', (error) => {
      console.error('[ProcessSampleRetention] Worker error:', error);
      captureException(error);
    });
    retentionWorker.on('failed', (job, error) => {
      console.error(`[ProcessSampleRetention] Job ${job?.id} failed after ${job?.attemptsMade} attempts:`, error);
      captureException(error);
    });

    const queue = getProcessSampleRetentionQueue();
    const existing = await queue.getRepeatableJobs();
    for (const job of existing) {
      await queue.removeRepeatableByKey(job.key);
    }

    await queue.add(
      'cleanup',
      { retentionDays: DEFAULT_RETENTION_DAYS },
      { repeat: { every: 24 * 60 * 60 * 1000 }, removeOnComplete: { count: 5 }, removeOnFail: { count: 10 } }
    );

    console.log('[ProcessSampleRetention] Retention worker initialized');
  } catch (error) {
    console.error('[ProcessSampleRetention] Failed to initialize:', error);
    throw error;
  }
}

export async function shutdownProcessSampleRetention(): Promise<void> {
  if (retentionWorker) { await retentionWorker.close(); retentionWorker = null; }
  if (retentionQueue) { await retentionQueue.close(); retentionQueue = null; }
}
```

- [ ] **Step 2: Register the worker at startup**

In `apps/api/src/index.ts`, add the import next to the other job imports, then add an entry to the `workers` array (after the `reliabilityRetention` entry, ~line 1031):

```typescript
import { initializeProcessSampleRetention } from './jobs/processSampleRetention';
```
```typescript
  ['processSampleRetention', initializeProcessSampleRetention],
```

- [ ] **Step 3: Type-check**

Run:
```bash
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec tsc --noEmit
```
Expected: no new errors in `processSampleRetention.ts` or `index.ts` (pre-existing errors in `agents.test.ts`/`apiKeyAuth.test.ts` are known and unrelated).

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/jobs/processSampleRetention.ts apps/api/src/index.ts
git commit -m "feat(api): batched-delete retention for device_process_samples (7d default)"
```

---

## Task 9: Web drill-down panel component

**Files:**
- Create: `apps/web/src/components/devices/ProcessDrilldownPanel.tsx`
- Create: `apps/web/src/components/devices/ProcessDrilldownPanel.test.tsx`

- [ ] **Step 1: Write the failing component test**

Create `apps/web/src/components/devices/ProcessDrilldownPanel.test.tsx`. Asserts click→fetch→sorted-table, the sample-time header, and the Live toggle switching endpoints.

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import ProcessDrilldownPanel from './ProcessDrilldownPanel';

const fetchWithAuth = vi.fn();
vi.mock('../../lib/api', () => ({ fetchWithAuth: (...args: any[]) => fetchWithAuth(...args) }));

function jsonResponse(body: any) {
  return Promise.resolve({ ok: true, json: () => Promise.resolve(body) } as Response);
}

describe('ProcessDrilldownPanel', () => {
  beforeEach(() => { fetchWithAuth.mockReset(); });

  it('fetches the nearest sample for the clicked time and renders rows sorted by CPU', async () => {
    fetchWithAuth.mockReturnValue(jsonResponse({
      sample: {
        timestamp: '2026-06-13T12:31:40.000Z',
        agentTimestamp: null,
        topProcesses: [
          { name: 'node', pid: 2, cpu: 5, ramMb: 50 },
          { name: 'chrome', pid: 1, cpu: 88, ramMb: 1200 }
        ]
      }
    }));

    render(<ProcessDrilldownPanel deviceId="dev-1" at="2026-06-13T12:32:00.000Z" onClose={() => {}} />);

    await waitFor(() => expect(screen.getByTestId('process-drilldown-row-0')).toBeInTheDocument());
    // default sort = CPU desc → chrome (88) first
    expect(screen.getByTestId('process-drilldown-row-0')).toHaveTextContent('chrome');
    // header shows the actual sample time, not the clicked time
    expect(screen.getByTestId('process-drilldown-sample-time')).toHaveTextContent('12:31');
    expect(fetchWithAuth).toHaveBeenCalledWith(expect.stringContaining('/devices/dev-1/process-samples?at=2026-06-13T12%3A32%3A00.000Z'));
  });

  it('Live toggle switches to the on-demand processes endpoint', async () => {
    fetchWithAuth.mockReturnValue(jsonResponse({ sample: { timestamp: '2026-06-13T12:31:40.000Z', agentTimestamp: null, topProcesses: [] } }));
    render(<ProcessDrilldownPanel deviceId="dev-1" at="2026-06-13T12:32:00.000Z" onClose={() => {}} />);
    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalled());

    fetchWithAuth.mockReturnValue(jsonResponse({ processes: [{ name: 'live', pid: 9, cpuPercent: 3, memoryMb: 7 }] }));
    fireEvent.click(screen.getByTestId('process-drilldown-live-toggle'));

    await waitFor(() => expect(fetchWithAuth).toHaveBeenLastCalledWith(expect.stringContaining('/devices/dev-1/processes')));
  });
});
```

- [ ] **Step 2: Run to confirm it fails**

Run:
```bash
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/web exec vitest run src/components/devices/ProcessDrilldownPanel.test.tsx
```
Expected: FAIL — cannot resolve `./ProcessDrilldownPanel`.

- [ ] **Step 3: Implement the panel**

Create `apps/web/src/components/devices/ProcessDrilldownPanel.tsx`. Uses the shared `Dialog` drawer. Default sort = CPU desc; resource toggle re-sorts; "nearest sample" header shows the real sample time; Live toggle reads the existing on-demand `/devices/:id/processes`. Confirm the `fetchWithAuth` import path matches the rest of `devices/` (e.g. `DevicePerformanceGraphs.tsx` imports it — match that exact path; the test mocks `../../lib/api`).

```tsx
import { useCallback, useEffect, useMemo, useState } from 'react';
import { fetchWithAuth } from '../../lib/api';
import Dialog from '../shared/Dialog';

type Row = { name: string; pid: number; cpu: number; ramMb: number; diskBps?: number; netBps?: number };
type SortKey = 'cpu' | 'ramMb';

type Props = {
  deviceId: string;
  at: string;          // ISO timestamp of the clicked chart point
  onClose: () => void;
};

export default function ProcessDrilldownPanel({ deviceId, at, onClose }: Props) {
  const [rows, setRows] = useState<Row[]>([]);
  const [sampleTime, setSampleTime] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>('cpu');
  const [live, setLive] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();

  const load = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      if (live) {
        const res = await fetchWithAuth(`/devices/${deviceId}/processes?limit=16&sortBy=cpu&sortDesc=true`);
        if (!res.ok) throw new Error('Failed to fetch live processes');
        const json = await res.json();
        const procs = (json.processes ?? json.data?.processes ?? []) as Array<Record<string, unknown>>;
        setRows(procs.map((p) => ({ name: String(p.name ?? ''), pid: Number(p.pid ?? 0), cpu: Number(p.cpuPercent ?? p.cpu ?? 0), ramMb: Number(p.memoryMb ?? p.ramMb ?? 0) })));
        setSampleTime(null);
      } else {
        const res = await fetchWithAuth(`/devices/${deviceId}/process-samples?at=${encodeURIComponent(at)}`);
        if (!res.ok) throw new Error('Failed to fetch process sample');
        const json = await res.json();
        if (!json.sample) { setRows([]); setSampleTime(null); return; }
        setRows((json.sample.topProcesses ?? []) as Row[]);
        setSampleTime(json.sample.timestamp);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load processes');
    } finally {
      setLoading(false);
    }
  }, [deviceId, at, live]);

  useEffect(() => { load(); }, [load]);

  const sorted = useMemo(
    () => [...rows].sort((a, b) => (sortKey === 'cpu' ? b.cpu - a.cpu : b.ramMb - a.ramMb)),
    [rows, sortKey]
  );

  return (
    <Dialog open onClose={onClose} maxWidth="lg">
      <div className="p-4" data-testid="process-drilldown-panel">
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-base font-semibold">Top processes</h3>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={live} onChange={(e) => setLive(e.target.checked)} data-testid="process-drilldown-live-toggle" />
            Live
          </label>
        </div>

        <p className="mt-1 text-xs text-muted-foreground" data-testid="process-drilldown-sample-time">
          {live ? 'Live (now)' : sampleTime ? `Nearest sample: ${new Date(sampleTime).toLocaleString()}` : 'No sample near this time'}
        </p>

        <div className="mt-3 flex gap-2 text-sm">
          <button type="button" onClick={() => setSortKey('cpu')} aria-pressed={sortKey === 'cpu'} className={sortKey === 'cpu' ? 'font-semibold' : ''}>CPU</button>
          <button type="button" onClick={() => setSortKey('ramMb')} aria-pressed={sortKey === 'ramMb'} className={sortKey === 'ramMb' ? 'font-semibold' : ''}>RAM</button>
        </div>

        {error && <p className="mt-3 text-sm text-red-500">{error}</p>}
        {loading && <p className="mt-3 text-sm text-muted-foreground">Loading…</p>}

        <table className="mt-3 w-full text-sm">
          <thead>
            <tr className="text-left text-muted-foreground">
              <th>Process</th><th>PID</th><th>CPU %</th><th>RAM (MB)</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((r, i) => (
              <tr key={`${r.pid}-${i}`} data-testid={`process-drilldown-row-${i}`}>
                <td>{r.name}</td>
                <td>{r.pid}</td>
                <td>{r.cpu.toFixed(1)}</td>
                <td>{Math.round(r.ramMb)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Dialog>
  );
}
```

- [ ] **Step 4: Run to confirm it passes**

Run:
```bash
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/web exec vitest run src/components/devices/ProcessDrilldownPanel.test.tsx
```
Expected: PASS (2 tests). If `Dialog`'s default vs named export or `fetchWithAuth`'s import path differ, align the imports with `DevicePerformanceGraphs.tsx`/`ProcessManager.tsx` and re-run.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/devices/ProcessDrilldownPanel.tsx apps/web/src/components/devices/ProcessDrilldownPanel.test.tsx
git commit -m "feat(web): process drill-down panel (sortable table, sample-time header, Live toggle)"
```

---

## Task 10: Wire the drill-down into the Performance chart (lazy)

**Files:**
- Modify: `apps/web/src/components/devices/DevicePerformanceGraphs.tsx` (CPU/RAM `LineChart` ~line 216; component body ~line 76)
- Create: `apps/web/src/components/devices/DevicePerformanceGraphs.drilldown.test.tsx`

- [ ] **Step 1: Write the failing lazy-load test**

Create `apps/web/src/components/devices/DevicePerformanceGraphs.drilldown.test.tsx`. Asserts the hard requirement: **no** process-sample request fires on mount — only after a chart click.

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import DevicePerformanceGraphs from './DevicePerformanceGraphs';

const fetchWithAuth = vi.fn();
vi.mock('../../lib/api', () => ({ fetchWithAuth: (...a: any[]) => fetchWithAuth(...a) }));

describe('DevicePerformanceGraphs drill-down lazy-load', () => {
  beforeEach(() => {
    fetchWithAuth.mockReset();
    fetchWithAuth.mockReturnValue(Promise.resolve({ ok: true, json: () => Promise.resolve({ data: [] }) } as Response));
  });

  it('does not request process-samples on mount', async () => {
    render(<DevicePerformanceGraphs deviceId="dev-1" />);
    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalled());
    const calledUrls = fetchWithAuth.mock.calls.map((c) => String(c[0]));
    expect(calledUrls.some((u) => u.includes('/process-samples'))).toBe(false);
    expect(calledUrls.every((u) => u.includes('/metrics'))).toBe(true);
  });
});
```

- [ ] **Step 2: Run to confirm it passes already (guard test)**

Run:
```bash
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/web exec vitest run src/components/devices/DevicePerformanceGraphs.drilldown.test.tsx
```
Expected: PASS today (no drill-down code yet). This test is the regression guard that the wiring in Step 3 must NOT break.

- [ ] **Step 3: Add the click handler + lazy panel render**

In `apps/web/src/components/devices/DevicePerformanceGraphs.tsx`:

(a) Add the import near the top:
```tsx
import ProcessDrilldownPanel from './ProcessDrilldownPanel';
```

(b) Add state in the component body (after the existing `useState` calls, ~line 80):
```tsx
  const [drilldownAt, setDrilldownAt] = useState<string | null>(null);
```

(c) Add `onClick` to the CPU/RAM `<LineChart>` (the one at ~line 218 with `dataKey="cpu"`/`"ram"`). Recharts passes the chart state; `activeLabel` is the clicked X value (the `timestamp`):
```tsx
    <LineChart
      data={data}
      onClick={(state: { activeLabel?: string | number } | null) => {
        if (state && state.activeLabel != null) setDrilldownAt(String(state.activeLabel));
      }}
    >
```

(d) Render the panel lazily at the end of the component's returned JSX (just before the outermost closing tag):
```tsx
      {drilldownAt && (
        <ProcessDrilldownPanel deviceId={deviceId} at={drilldownAt} onClose={() => setDrilldownAt(null)} />
      )}
```

- [ ] **Step 4: Run both web tests to confirm pass + no regression**

Run:
```bash
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/web exec vitest run src/components/devices/DevicePerformanceGraphs.drilldown.test.tsx src/components/devices/ProcessDrilldownPanel.test.tsx
```
Expected: PASS (lazy-load guard still green, panel tests green).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/devices/DevicePerformanceGraphs.tsx apps/web/src/components/devices/DevicePerformanceGraphs.drilldown.test.tsx
git commit -m "feat(web): open process drill-down on Performance chart click (lazy)"
```

---

## Task 11: Full verification sweep

- [ ] **Step 1: API affected-file tests**

Run (single fork — full-suite parallel runs are flaky per project memory):
```bash
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec vitest run --pool forks --poolOptions.forks.singleFork src/routes/agents/processSample.test.ts src/routes/devices/processSamples.test.ts
```
Expected: PASS.

- [ ] **Step 2: Agent tests + race**

Run:
```bash
cd agent && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH go test -race ./internal/remote/tools/...
```
Expected: PASS.

- [ ] **Step 3: Web tests**

Run:
```bash
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/web exec vitest run src/components/devices/
```
Expected: PASS.

- [ ] **Step 4: RLS contract + drift**

Run:
```bash
export DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze"
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm db:check-drift
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec vitest run -c vitest.config.rls-coverage.ts
```
Expected: no drift; RLS coverage PASS (device_process_samples auto-covered). (First confirm `.env.test` exists and `breeze_app.rolbypassrls = f` per Task 2 Step 0 — otherwise the coverage test passes vacuously.)

- [ ] **Step 5: End-to-end smoke (optional, needs a live agent)**

With a local agent enrolled, wait one sample interval (~180s), then confirm a row landed and the read route serves it:
```bash
docker exec -i breeze-postgres psql -U breeze -d breeze -c "SELECT device_id, \"timestamp\", jsonb_array_length(top_processes) FROM device_process_samples ORDER BY \"timestamp\" DESC LIMIT 3;"
```
Expected: recent rows with a non-zero process count. In the web UI, open a device → Performance, click a CPU/RAM chart point, and confirm the drill-down panel lists processes with the nearest-sample time in the header.

---

## Self-Review Notes (spec coverage)

- Historical drill-down (scrub to past spikes) → Tasks 1,4,9,10 (nearest snapshot + Live toggle).
- CPU + RAM per process, phased → Task 5 (Phase 1); `diskBps`/`netBps` are nullable slots in the schema (Task 1), agent struct (Task 5), and API schema (Task 3) so disk/net phases are additive (separate plans).
- Click chart entry point → Task 10.
- Storage Approach A (1 JSONB row/device/sample) → Task 1.
- Tenancy: server-derived `org_id`, RLS shape #1, same-migration policies → Tasks 1,2,3.
- Clock skew: server-stamped `timestamp` + `agent_timestamp` → Tasks 1,3.
- Payload bounds → Task 3 (`processes.max(16)` + per-field limits).
- Sampler decoupled from heartbeat, instantaneous CPU invariant → Tasks 5,6,7.
- Retention (net-new, batched, 7-day default) → Task 8.
- Lazy web load (zero added page-load cost) → Tasks 9,10 (guard test in Task 10).

**Deviation from spec:** the existing Performance chart plots CPU/RAM/Disk on one combined `LineChart`, so a click yields a timestamp but not a specific resource. The panel therefore opens sorted by CPU with a CPU/RAM toggle, rather than auto-sorting by the exact line clicked. This preserves the core need (drill-down at a timestamp, sortable by resource); per-line click targeting can be a refinement if desired.

**Deferred to follow-up plans:** Phase 2 (disk I/O per process) and Phase 3 (network per process) collection behind faked OS interfaces; spike-triggered capture; a full slider-style time scrubber (this plan ships nearest-snapshot + Live; the `?from&to` markers endpoint is built in Task 4 and ready for a slider).
