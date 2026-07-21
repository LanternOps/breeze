# Alert Suppression Expiry Reaper Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a background reaper that reactivates timed alert suppressions once `suppressed_until` passes, so they reappear for triage and stop blocking new alerts — while leaving indefinite ("Forever", `suppressed_until IS NULL`) suppressions untouched.

**Architecture:** A BullMQ repeatable "reaper" worker, a structural clone of `apps/api/src/jobs/approvalExpiryReaper.ts` / `quoteExpiryReaper.ts`. It runs a single bounded `UPDATE ... FROM (CTE) ... RETURNING` inside `withSystemDbAccessContext`, flipping `suppressed` → `active` and nulling the stale deadline. Snooze semantics: no event published, so notification channels stay silent. A partial index backs the due-rows scan.

**Tech Stack:** TypeScript, Hono, Drizzle ORM, PostgreSQL, BullMQ + Redis, Vitest.

## Global Constraints

- **Snooze semantics only:** reactivate to `status = 'active'`, set `suppressed_until = NULL`. NO event-bus publish, NO notification re-fire, NO ML feedback. (Publishing an `alert.*` event risks tripping the `notifications.ts` `alert.triggered` subscriber.)
- **Forever is sacred:** rows with `suppressed_until IS NULL` must NEVER be reaped. The SQL predicate and the partial index both require `suppressed_until IS NOT NULL`.
- **System-context DB access:** all DB work runs inside `withSystemDbAccessContext` (alerts is org-scoped RLS; reaping is a system job). No RLS/tenancy-allowlist changes.
- **Migrations:** idempotent (`CREATE INDEX IF NOT EXISTS`), never edit a shipped migration, no inner `BEGIN;`/`COMMIT;`.
- **Cadence:** `REAP_INTERVAL_MS = 5 * 60 * 1000` (5 min). Bound each pass to `MAX_REAP_PER_RUN = 500`.
- **Audit action name:** `alert.suppression_expired` (verbatim), `actorType: 'system'`, best-effort (never blocks a transition).

---

### Task 1: Supporting partial index (migration + schema)

Adds the partial index the reaper's due-rows scan relies on, and keeps `db:check-drift` clean. Independent, idempotent CREATE INDEX on the long-existing `alerts.suppressed_until` column — no cross-migration dependency.

**Files:**
- Create: `apps/api/migrations/2026-06-30-alerts-suppression-expiry-idx.sql`
- Modify: `apps/api/src/db/schema/alerts.ts` (the `alerts` table's index block, ~line 80-86)

**Interfaces:**
- Produces: DB index `idx_alerts_suppressed_expiry` on `alerts(suppressed_until) WHERE status = 'suppressed' AND suppressed_until IS NOT NULL`.

- [ ] **Step 1: Write the migration file**

Create `apps/api/migrations/2026-06-30-alerts-suppression-expiry-idx.sql`:

```sql
-- Partial index backing the suppression-expiry reaper's due-rows scan
-- (apps/api/src/jobs/suppressionExpiryReaper.ts). Only timed suppressions
-- (suppressed_until NOT NULL) are ever reaped; Forever suppressions (NULL) are
-- excluded by design, so they are excluded from the index too.
CREATE INDEX IF NOT EXISTS idx_alerts_suppressed_expiry
  ON alerts (suppressed_until)
  WHERE status = 'suppressed' AND suppressed_until IS NOT NULL;
```

- [ ] **Step 2: Add the matching Drizzle index to the schema**

In `apps/api/src/db/schema/alerts.ts`, extend the `alerts` table's index block. Replace:

```ts
}, (table) => ({
  // Backs the `alerts.critical` device-filter field (#968).
  activeCriticalIdx: index('idx_alerts_active_critical')
    .on(table.deviceId)
    .where(sql`status = 'active' AND severity = 'critical'`)
}));
```

with:

```ts
}, (table) => ({
  // Backs the `alerts.critical` device-filter field (#968).
  activeCriticalIdx: index('idx_alerts_active_critical')
    .on(table.deviceId)
    .where(sql`status = 'active' AND severity = 'critical'`),
  // Backs the suppression-expiry reaper's due-rows scan
  // (apps/api/src/jobs/suppressionExpiryReaper.ts).
  suppressedExpiryIdx: index('idx_alerts_suppressed_expiry')
    .on(table.suppressedUntil)
    .where(sql`status = 'suppressed' AND suppressed_until IS NOT NULL`)
}));
```

(`sql` and `index` are already imported in this file.)

- [ ] **Step 3: Apply the migration and verify no drift**

Run (from repo root):

```bash
export DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze"
pnpm db:migrate        # runs apps/api src/db/autoMigrate.ts — applies pending migrations idempotently
pnpm db:check-drift
```

Expected: migration applies cleanly; `db:check-drift` reports **no drift** (schema index matches the migration).

- [ ] **Step 4: Verify migration ordering regression test still passes**

Run:

```bash
pnpm --filter @breeze/api exec vitest run src/db/autoMigrate.test.ts
```

Expected: PASS (confirms the new file sorts safely from-empty).

- [ ] **Step 5: Commit**

```bash
git add apps/api/migrations/2026-06-30-alerts-suppression-expiry-idx.sql apps/api/src/db/schema/alerts.ts
git commit -m "feat(alerts): partial index for suppression-expiry reaper"
```

---

### Task 2: The reaper module + unit tests (TDD)

The core worker. TDD: mock-based unit tests for the JS logic (count, audit emission, best-effort audit), then the implementation. The SQL predicate itself is verified in Task 4 against a real DB.

**Files:**
- Create: `apps/api/src/jobs/suppressionExpiryReaper.ts`
- Test: `apps/api/src/jobs/suppressionExpiryReaper.test.ts`

**Interfaces:**
- Consumes: `db.execute`, `withSystemDbAccessContext` (from `../db`); `alerts` (from `../db/schema/alerts`); `getBullMQConnection` (from `../services/redis`); `captureException` (from `../services/sentry`); `writeAuditEvent`, `requestLikeFromSnapshot` (from `../services/auditEvents`).
- Produces:
  - `reapExpiredSuppressions(): Promise<number>` — single bounded pass, returns count transitioned.
  - `initializeSuppressionExpiryReaper(): Promise<void>` / `shutdownSuppressionExpiryReaper(): Promise<void>` — lifecycle (consumed by Task 3).

- [ ] **Step 1: Write the failing unit test**

Create `apps/api/src/jobs/suppressionExpiryReaper.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { executeMock, alertsTable } = vi.hoisted(() => ({
  executeMock: vi.fn(),
  alertsTable: {
    status: 'alerts.status',
    suppressedUntil: 'alerts.suppressed_until',
  },
}));

vi.mock('bullmq', () => ({
  Queue: class {},
  Worker: class {},
  Job: class {},
}));

vi.mock('../db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db')>();
  return {
    ...actual,
    db: {
      ...actual.db,
      execute: (...args: unknown[]) => executeMock(...(args as [])),
    },
    withSystemDbAccessContext: async <T>(fn: () => Promise<T>) => fn(),
  };
});

vi.mock('../db/schema/alerts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db/schema/alerts')>();
  return {
    ...actual,
    alerts: alertsTable,
  };
});

vi.mock('../services/redis', () => ({
  getRedisConnection: vi.fn(() => ({})),
  getBullMQConnection: vi.fn(() => ({ host: 'localhost', port: 6379 })),
  isBullMQAvailable: vi.fn(() => true),
}));

vi.mock('../services/sentry', () => ({
  captureException: vi.fn(),
}));

vi.mock('../services/auditEvents', () => ({
  writeAuditEvent: vi.fn(),
  requestLikeFromSnapshot: vi.fn(() => ({ req: { header: () => undefined } })),
}));

import { reapExpiredSuppressions } from './suppressionExpiryReaper';
import { writeAuditEvent } from '../services/auditEvents';

describe('suppressionExpiryReaper.reapExpiredSuppressions', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('reactivates expired suppressions and audits each transition', async () => {
    executeMock.mockResolvedValueOnce({
      rows: [{ id: 'alert-1', org_id: 'org-1', title: 'Warranty expires' }],
    });

    const reaped = await reapExpiredSuppressions();

    expect(reaped).toBe(1);
    expect(executeMock).toHaveBeenCalledTimes(1);
    expect(writeAuditEvent).toHaveBeenCalledTimes(1);
    expect(writeAuditEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        orgId: 'org-1',
        action: 'alert.suppression_expired',
        resourceType: 'alert',
        resourceId: 'alert-1',
        actorType: 'system',
        result: 'success',
        details: { previousStatus: 'suppressed' },
      }),
    );
  });

  it('returns 0 and audits nothing when no suppressions are due', async () => {
    executeMock.mockResolvedValueOnce({ rows: [] });

    const reaped = await reapExpiredSuppressions();

    expect(reaped).toBe(0);
    expect(executeMock).toHaveBeenCalledTimes(1);
    expect(writeAuditEvent).not.toHaveBeenCalled();
  });

  it('still transitions when the audit write throws (best-effort audit)', async () => {
    executeMock.mockResolvedValueOnce({
      rows: [{ id: 'alert-2', org_id: 'org-2', title: 'CPU high' }],
    });
    vi.mocked(writeAuditEvent).mockImplementation(() => {
      throw new Error('audit sink down');
    });

    const reaped = await reapExpiredSuppressions();

    expect(reaped).toBe(1);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
pnpm --filter @breeze/api exec vitest run src/jobs/suppressionExpiryReaper.test.ts
```

Expected: FAIL — `Failed to resolve import "./suppressionExpiryReaper"` (module not created yet).

- [ ] **Step 3: Write the reaper implementation**

Create `apps/api/src/jobs/suppressionExpiryReaper.ts`:

```ts
import { Job, Queue, Worker } from 'bullmq';
import { sql } from 'drizzle-orm';
import * as dbModule from '../db';
import { db } from '../db';
import { alerts } from '../db/schema/alerts';
import { getBullMQConnection } from '../services/redis';
import { captureException } from '../services/sentry';
import { writeAuditEvent, requestLikeFromSnapshot } from '../services/auditEvents';

/**
 * Reaps `alerts` rows whose timed suppression has elapsed: `status='suppressed'`
 * with a non-null `suppressed_until` in the past. Flips them back to `active`
 * and clears the stale deadline so they reappear for triage and stop blocking
 * new alerts (alertService dedupe counts 'suppressed' as open). Snooze semantics:
 * no event is published, so notification channels stay silent.
 *
 * Indefinite ("Forever", suppressed_until IS NULL) suppressions are never touched.
 *
 * Runs every 5 minutes inside `withSystemDbAccessContext` — alerts is org-scoped
 * RLS, but expiry reaping is a system job.
 */

const QUEUE_NAME = 'suppression-expiry-reaper';
const REAP_INTERVAL_MS = 5 * 60 * 1000; // every 5 min
const MAX_REAP_PER_RUN = 500;

type ReaperJobData = { type: 'reap-expired-suppressions'; queuedAt: string };

const runWithSystemDbAccess = async <T>(fn: () => Promise<T>): Promise<T> => {
  const withSystem = dbModule.withSystemDbAccessContext;
  if (typeof withSystem !== 'function') {
    throw new Error(
      '[SuppressionExpiryReaper] withSystemDbAccessContext not available — reaper cannot run without system DB access',
    );
  }
  return withSystem(fn);
};

let reaperQueue: Queue<ReaperJobData> | null = null;
let reaperWorker: Worker<ReaperJobData> | null = null;

function getQueue(): Queue<ReaperJobData> {
  if (!reaperQueue) {
    reaperQueue = new Queue<ReaperJobData>(QUEUE_NAME, { connection: getBullMQConnection() });
  }
  return reaperQueue;
}

/**
 * Single pass: flip past-due timed suppressions to `active`, clear their
 * deadline, and write an audit row per transition. Bounded to MAX_REAP_PER_RUN
 * via a CTE so a backlog spike can't lock the table for too long. Returns the
 * number of alerts transitioned.
 */
export async function reapExpiredSuppressions(): Promise<number> {
  const transitioned = await db.execute<{
    id: string;
    org_id: string;
    title: string;
  }>(sql`
    WITH due AS (
      SELECT id
      FROM ${alerts}
      WHERE ${alerts.status} = 'suppressed'
        AND ${alerts.suppressedUntil} IS NOT NULL
        AND ${alerts.suppressedUntil} < now()
      ORDER BY ${alerts.suppressedUntil} ASC
      LIMIT ${MAX_REAP_PER_RUN}
      FOR UPDATE SKIP LOCKED
    )
    UPDATE ${alerts} AS a
    SET status = 'active',
        suppressed_until = NULL
    FROM due
    WHERE a.id = due.id
      AND a.status = 'suppressed'
    RETURNING a.id, a.org_id, a.title;
  `);

  const rows = (transitioned as unknown as { rows?: Array<{ id: string; org_id: string; title: string }> }).rows
    ?? (transitioned as unknown as Array<{ id: string; org_id: string; title: string }>);

  if (!Array.isArray(rows) || rows.length === 0) {
    return 0;
  }

  // Audit log: one row per reactivated alert. Best-effort — never block a
  // transition on the audit write. System job, so no IP/UA.
  const requestLike = requestLikeFromSnapshot({});
  for (const row of rows) {
    try {
      writeAuditEvent(requestLike, {
        orgId: row.org_id,
        action: 'alert.suppression_expired',
        resourceType: 'alert',
        resourceId: row.id,
        resourceName: row.title,
        actorType: 'system',
        actorId: null,
        result: 'success',
        details: { previousStatus: 'suppressed' },
      });
    } catch (err) {
      console.error('[SuppressionExpiryReaper] Failed to write audit event:', err);
    }
  }

  if (rows.length === MAX_REAP_PER_RUN) {
    console.warn(`[SuppressionExpiryReaper] Hit ${MAX_REAP_PER_RUN}-item cap — backlog may be growing`);
  }

  return rows.length;
}

function createWorker(): Worker<ReaperJobData> {
  return new Worker<ReaperJobData>(
    QUEUE_NAME,
    async (_job: Job<ReaperJobData>) => {
      try {
        const reaped = await runWithSystemDbAccess(reapExpiredSuppressions);
        if (reaped > 0) {
          console.log(`[SuppressionExpiryReaper] Reactivated ${reaped} alert(s)`);
        }
        return { reaped };
      } catch (err) {
        console.error('[SuppressionExpiryReaper] Run failed:', err);
        captureException(err instanceof Error ? err : new Error(String(err)));
        throw err;
      }
    },
    { connection: getBullMQConnection(), concurrency: 1 },
  );
}

async function scheduleRepeatableJob(): Promise<void> {
  const queue = getQueue();
  const repeatables = await queue.getRepeatableJobs();
  for (const job of repeatables) {
    if (job.name === 'reap-expired-suppressions') {
      await queue.removeRepeatableByKey(job.key);
    }
  }
  await queue.add(
    'reap-expired-suppressions',
    { type: 'reap-expired-suppressions', queuedAt: new Date().toISOString() },
    {
      jobId: 'suppression-expiry-reaper',
      repeat: { every: REAP_INTERVAL_MS },
      removeOnComplete: { count: 20 },
      removeOnFail: { count: 200 },
    },
  );
}

export async function initializeSuppressionExpiryReaper(): Promise<void> {
  if (reaperWorker) return;
  reaperWorker = createWorker();
  reaperWorker.on('error', (error) => {
    console.error('[SuppressionExpiryReaper] Worker error:', error);
    captureException(error);
  });
  reaperWorker.on('failed', (job, error) => {
    console.error(`[SuppressionExpiryReaper] Job ${job?.id} failed:`, error);
    captureException(error);
  });
  try {
    await scheduleRepeatableJob();
  } catch (err) {
    await reaperWorker.close();
    reaperWorker = null;
    throw err;
  }
  console.log('[SuppressionExpiryReaper] Initialized');
}

export async function shutdownSuppressionExpiryReaper(): Promise<void> {
  const worker = reaperWorker;
  const queue = reaperQueue;
  reaperWorker = null;
  reaperQueue = null;
  if (worker) {
    try { await worker.close(); } catch (err) { console.error('[SuppressionExpiryReaper] Error closing worker:', err); }
  }
  if (queue) {
    try { await queue.close(); } catch (err) { console.error('[SuppressionExpiryReaper] Error closing queue:', err); }
  }
}
```

- [ ] **Step 4: Run the unit tests to verify they pass**

Run:

```bash
pnpm --filter @breeze/api exec vitest run src/jobs/suppressionExpiryReaper.test.ts
```

Expected: PASS (3 tests).

- [ ] **Step 5: Typecheck**

Run:

```bash
pnpm --filter @breeze/api exec tsc --noEmit
```

Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/jobs/suppressionExpiryReaper.ts apps/api/src/jobs/suppressionExpiryReaper.test.ts
git commit -m "feat(alerts): suppression-expiry reaper (reactivate lapsed timed mutes)"
```

---

### Task 3: Wire the reaper into the API lifecycle

Registers the reaper so it initializes on API boot and shuts down cleanly, alongside the other three reapers.

**Files:**
- Modify: `apps/api/src/index.ts` (import ~line 242; init array ~line 1193; shutdown array ~line 1365)

**Interfaces:**
- Consumes: `initializeSuppressionExpiryReaper`, `shutdownSuppressionExpiryReaper` (from Task 2).

- [ ] **Step 1: Add the import**

In `apps/api/src/index.ts`, immediately after the line:

```ts
import { initializeQuoteExpiryReaper, shutdownQuoteExpiryReaper } from './jobs/quoteExpiryReaper';
```

add:

```ts
import { initializeSuppressionExpiryReaper, shutdownSuppressionExpiryReaper } from './jobs/suppressionExpiryReaper';
```

- [ ] **Step 2: Add to the init array**

Find the initializer array entry:

```ts
    ['quoteExpiryReaper', initializeQuoteExpiryReaper],
```

and add immediately after it:

```ts
    ['suppressionExpiryReaper', initializeSuppressionExpiryReaper],
```

- [ ] **Step 3: Add to the shutdown array**

Find the shutdown array entry:

```ts
    shutdownQuoteExpiryReaper,
```

and add immediately after it:

```ts
    shutdownSuppressionExpiryReaper,
```

- [ ] **Step 4: Typecheck**

Run:

```bash
pnpm --filter @breeze/api exec tsc --noEmit
```

Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/index.ts
git commit -m "feat(alerts): register suppression-expiry reaper on API boot"
```

---

### Task 4: Real-DB integration test (SQL predicate correctness)

Verifies the SQL predicate against a live DB — the guarantee that unit tests can't cover because they mock `db.execute`. Critically asserts the **Forever-exclusion** invariant.

**Files:**
- Create: `apps/api/src/jobs/suppressionExpiryReaper.integration.test.ts`

**Interfaces:**
- Consumes: `reapExpiredSuppressions` (from Task 2); `db`, `withSystemDbAccessContext` (from `../db`); `alerts`, `devices`, `organizations`, `partners`, `sites` (from `../db/schema`).

- [ ] **Step 1: Write the integration test**

Create `apps/api/src/jobs/suppressionExpiryReaper.integration.test.ts`:

```ts
import '../__tests__/integration/setup';

import { expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../db';
import { alerts, devices, organizations, partners, sites } from '../db/schema';
import { reapExpiredSuppressions } from './suppressionExpiryReaper';

const runDb = it.runIf(!!process.env.DATABASE_URL);

runDb('reactivates only past timed suppressions; leaves future, forever, and non-suppressed rows', async () => {
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const past = new Date(Date.now() - 60_000);
  const future = new Date(Date.now() + 60 * 60_000);

  const ids = await withSystemDbAccessContext(async () => {
    const [partner] = await db.insert(partners).values({ name: `SR Partner ${unique}`, slug: `sr-partner-${unique}`, type: 'msp', plan: 'pro', status: 'active' }).returning({ id: partners.id });
    const [org] = await db.insert(organizations).values({ partnerId: partner!.id, name: `SR Org ${unique}`, slug: `sr-org-${unique}`, type: 'customer', status: 'active' }).returning({ id: organizations.id });
    const [site] = await db.insert(sites).values({ orgId: org!.id, name: `SR Site ${unique}` }).returning({ id: sites.id });
    const [device] = await db.insert(devices).values({ orgId: org!.id, siteId: site!.id, agentId: `sr-agent-${unique}`, hostname: `sr-host-${unique}`, osType: 'windows', osVersion: '11', architecture: 'x86_64', agentVersion: '0.0.0-test', status: 'offline' }).returning({ id: devices.id });

    const base = { deviceId: device!.id, orgId: org!.id, severity: 'info' as const, title: 'SR alert', triggeredAt: new Date() };
    const [pastSup] = await db.insert(alerts).values({ ...base, status: 'suppressed', suppressedUntil: past }).returning({ id: alerts.id });
    const [futureSup] = await db.insert(alerts).values({ ...base, status: 'suppressed', suppressedUntil: future }).returning({ id: alerts.id });
    const [foreverSup] = await db.insert(alerts).values({ ...base, status: 'suppressed', suppressedUntil: null }).returning({ id: alerts.id });
    const [activeAlert] = await db.insert(alerts).values({ ...base, status: 'active', suppressedUntil: null }).returning({ id: alerts.id });
    return { pastSup: pastSup!.id, futureSup: futureSup!.id, foreverSup: foreverSup!.id, activeAlert: activeAlert!.id };
  });

  // Other suites may leave suppressed rows behind on the shared DB, so assert on
  // our specific rows rather than the exact reaped count.
  const reaped = await withSystemDbAccessContext(() => reapExpiredSuppressions());
  expect(reaped).toBeGreaterThanOrEqual(1);

  await withSystemDbAccessContext(async () => {
    const [pastRow] = await db.select().from(alerts).where(eq(alerts.id, ids.pastSup));
    expect(pastRow!.status).toBe('active');
    expect(pastRow!.suppressedUntil).toBeNull();

    const [futureRow] = await db.select().from(alerts).where(eq(alerts.id, ids.futureSup));
    expect(futureRow!.status).toBe('suppressed');

    const [foreverRow] = await db.select().from(alerts).where(eq(alerts.id, ids.foreverSup));
    expect(foreverRow!.status).toBe('suppressed'); // Forever stays forever
    expect(foreverRow!.suppressedUntil).toBeNull();

    const [activeRow] = await db.select().from(alerts).where(eq(alerts.id, ids.activeAlert));
    expect(activeRow!.status).toBe('active');
  });
});
```

- [ ] **Step 2: Run the integration test against a live DB**

Requires Postgres reachable via `DATABASE_URL` (the integration config loads `../../.env.test`; local DB on `:5433`). From `apps/api`:

```bash
pnpm exec vitest run --config vitest.integration.config.ts src/jobs/suppressionExpiryReaper.integration.test.ts
```

Expected: PASS (1 test). If `DATABASE_URL` is unset the test is skipped via `it.runIf` — ensure it actually runs (not skipped) before committing.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/jobs/suppressionExpiryReaper.integration.test.ts
git commit -m "test(alerts): real-DB coverage for suppression-expiry predicate (forever-exclusion)"
```

---

## Self-Review

**Spec coverage:**
- Reaper file + bounded CTE UPDATE + snooze semantics → Task 2. ✓
- Best-effort audit (`alert.suppression_expired`, system actor) → Task 2 (impl + unit test). ✓
- 5-min cadence + registration in `index.ts` → Task 2 (constants) + Task 3 (wiring). ✓
- Migration + schema partial index + drift-clean → Task 1. ✓
- Testing (past→active/null, future untouched, forever untouched, non-suppressed ignored, best-effort audit) → Task 2 (JS logic) + Task 4 (SQL predicate incl. forever-exclusion). ✓
- Non-goals (no re-notify/escalation, no config, no UI change, reactivate to `active` unconditionally) → enforced by Global Constraints + implementation. ✓

**Placeholder scan:** No TBD/TODO/"handle edge cases"; every code step shows complete code and exact commands. ✓

**Type consistency:** `reapExpiredSuppressions` / `initializeSuppressionExpiryReaper` / `shutdownSuppressionExpiryReaper` named identically across Tasks 2→3→4. Audit fields (`orgId`, `action`, `resourceType`, `resourceId`, `resourceName`, `actorType`, `actorId`, `result`, `details`) match the `writeAuditEvent` signature used by `approvalExpiryReaper.ts`. RETURNING columns (`id`, `org_id`, `title`) match the `rows` type and the audit-loop usage. ✓
