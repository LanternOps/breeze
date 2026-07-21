# Reliability-scoring Event-Loop Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make device-reliability scoring cheap and bounded so no single device — or the daily all-org scan at fleet scale — can peg the API Node event loop, and release the #1105 held-transaction connection pin on the reliability ingest route.

**Architecture:** Four changes, all in `apps/api`, scoring **output preserved exactly**. (1) `getHistoryForDevice` stops issuing `SELECT *` and projects only the seven columns the scorer consumes, dropping the ~2KB/row `rawMetrics` JSONB — the dominant transfer/GC cost. (2) Widen the on-demand recompute dedupe window 30s→10min. (3) Lower worker concurrency 5→2. (4) The `POST /agents/:id/reliability` route self-manages a short-lived `withDbAccessContext` around just its DB writes, running the BullMQ enqueue and audit write outside any open transaction (#1105 pattern, mirroring `heartbeat`).

**Tech Stack:** Hono, Drizzle ORM (Postgres), BullMQ (Redis), Vitest (unit + integration), TypeScript.

## Global Constraints

- **Scoring output must be preserved exactly.** Every persisted `device_reliability` field, plus `device_reliability_history`-derived counts, must be byte-for-byte identical before/after. Correctness wins over cleverness (spec, "Design").
- **Do NOT attempt the SQL push-down of per-day event aggregation.** Verified during planning: `mergeRowsIntoDailyBuckets` de-duplicates crash/hang/service/hardware events **across the whole 90-day window** by per-event key (issue #1904, `reliabilityScoring.ts:894-947`). Those keys live inside the JSONB event arrays; reducing to daily rows in SQL would drop them and change counts. The safe, sufficient win is the **column projection only** (drop `rawMetrics`). The event arrays stay; changes #2/#3 cap the residual O(rows) JS cost.
- **No migration, no new env var, no infra/compose change.** Index `reliability_history_device_collected_idx` on `(device_id, collected_at)` already exists (`schema/reliability.ts:57`).
- **Bare pool is forbidden in request code** (CLAUDE.md, RLS section). When Task 4 drops the middleware's request-long wrap for the reliability route, the route MUST open its own `withDbAccessContext` — never leave bare `db` calls uncontexted.
- Node pinned v22.20.0; run `pnpm install` if in a fresh worktree.

---

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `apps/api/src/services/reliabilityScoring.ts` (modify) | `getHistoryForDevice` column projection; narrow `ScoringHistoryRow` type on its consumers | 1 |
| `apps/api/src/services/reliabilityScoring.test.ts` (modify) | Unit golden-value: fixed synthetic multi-post-per-day history → identical buckets from projected rows | 1 |
| `apps/api/src/services/reliabilityScoring.projection.integration.test.ts` (create) | Real-DB golden-value: seed history (incl. high-frequency device), run full compute, assert persisted fields + no `rawMetrics` needed | 2 |
| `apps/api/src/jobs/reliabilityWorker.ts` (modify) | Dedupe window 30s→10min; concurrency 5→2 | 3 |
| `apps/api/src/jobs/reliabilityWorker.test.ts` (modify) | Assert 10-min dedupe slot reuse; assert worker concurrency 2 | 3 |
| `apps/api/src/middleware/agentAuth.ts` (modify) | Add `'reliability'` to `SELF_MANAGED_DB_CONTEXT_ACTIONS` | 4 |
| `apps/api/src/middleware/agentAuth.test.ts` (modify) | Assert reliability path skips the request-long org wrap | 4 |
| `apps/api/src/routes/agents/reliability.ts` (modify) | Self-manage short `withDbAccessContext` around lookup+insert; enqueue + audit outside it | 4 |
| `apps/api/src/routes/agents/reliability.test.ts` (modify) | Depth-tracking: enqueue + audit run at DB-context depth 0 | 4 |

---

## Task 1: O(days)-safe column projection in `getHistoryForDevice`

**Files:**
- Modify: `apps/api/src/services/reliabilityScoring.ts` (add `ScoringHistoryRow` type near `HistoryRow` at line 96; rewrite `getHistoryForDevice` at 1287-1294; narrow param/return types on `getLatestCollectedAt` 1313, `mergeRowsIntoDailyBuckets` 881, `aggregateReliabilityOffenders` 1968)
- Test: `apps/api/src/services/reliabilityScoring.test.ts` (add golden-value bucket-identity test)

**Interfaces:**
- Consumes: `HistoryRow = typeof deviceReliabilityHistory.$inferSelect` (existing, line 96); `deviceReliabilityHistory` columns from `../db/schema`.
- Produces: `type ScoringHistoryRow = Pick<HistoryRow, 'collectedAt' | 'uptimeSeconds' | 'bootTime' | 'crashEvents' | 'appHangs' | 'serviceFailures' | 'hardwareErrors'>`. `getHistoryForDevice(deviceId: string, days: number): Promise<ScoringHistoryRow[]>`. Downstream compute is unchanged; the narrower type is the compile-time proof that no scorer path reads `rawMetrics`, `id`, `deviceId`, or `orgId` off history rows.

- [ ] **Step 1: Write the failing golden-value test**

Add to `apps/api/src/services/reliabilityScoring.test.ts` (uses existing `makeHistoryRow` helper and `reliabilityScoringInternals`). The point: a device that posts many times in one day, with overlapping (re-reported) events, must bucket identically when rows carry ONLY the projected columns (no `rawMetrics`). Build rows WITHOUT `rawMetrics` to prove the scorer never touches it.

```ts
describe('getHistoryForDevice projection is behavior-neutral (event-loop hardening)', () => {
  const internals = reliabilityScoringInternals;

  // A high-frequency device: 4 posts in one UTC day, each re-reporting the SAME
  // crash event, plus one distinct crash. Global dedup (#1904) must collapse the
  // repeat to 1 and keep the distinct one → crashCount === 2 for the day.
  function projectedRow(overrides: Record<string, unknown>) {
    // Deliberately OMIT rawMetrics (and id/deviceId/orgId) to mirror the new
    // projected SELECT. If any scorer path reads them this test throws/NaNs.
    return {
      collectedAt: new Date('2026-02-20T10:00:00.000Z'),
      uptimeSeconds: 600,
      bootTime: new Date('2026-02-20T09:50:00.000Z'),
      crashEvents: [],
      appHangs: [],
      serviceFailures: [],
      hardwareErrors: [],
      ...overrides,
    };
  }

  it('collapses re-reported events and counts distinct ones across many same-day posts', () => {
    const repeated = { type: 'os_crash', timestamp: '2026-02-20T10:05:00.000Z', bugCheckCode: '0x1a' };
    const distinct = { type: 'os_crash', timestamp: '2026-02-20T11:30:00.000Z', bugCheckCode: '0x50' };
    const rows = [
      projectedRow({ collectedAt: new Date('2026-02-20T10:06:00.000Z'), crashEvents: [repeated] }),
      projectedRow({ collectedAt: new Date('2026-02-20T10:24:00.000Z'), crashEvents: [repeated] }),
      projectedRow({ collectedAt: new Date('2026-02-20T10:42:00.000Z'), crashEvents: [repeated] }),
      projectedRow({ collectedAt: new Date('2026-02-20T11:31:00.000Z'), crashEvents: [repeated, distinct] }),
    ];

    const map = new Map();
    internals.mergeRowsIntoDailyBuckets(map, rows as any);
    const buckets = internals.sortDailyBuckets(map);
    const day = buckets.find((b) => b.date === '2026-02-20');

    expect(day).toBeDefined();
    expect(day!.sampleCount).toBe(4);        // every post counted for uptime observation
    expect(day!.crashCount).toBe(2);         // 3× repeat collapsed to 1, + 1 distinct
  });
});
```

- [ ] **Step 2: Run test to verify it passes against current code (baseline pin), then we refactor under it**

Run: `pnpm --filter=@breeze/api test -- reliabilityScoring.test.ts -t "projection is behavior-neutral"`
Expected: PASS on current code (it exercises `mergeRowsIntoDailyBuckets` with projected-shape rows). This test is the **golden guard** the refactor must not break — it asserts the scorer's behavior on rows that lack `rawMetrics`. Confirm it is green now, before touching the source.

- [ ] **Step 3: Add the `ScoringHistoryRow` type**

In `apps/api/src/services/reliabilityScoring.ts`, immediately after line 96 (`type HistoryRow = typeof deviceReliabilityHistory.$inferSelect;`):

```ts
// Event-loop hardening: the scorer reads only these seven columns. Projecting to
// them (see getHistoryForDevice) drops the ~2KB/row `rawMetrics` JSONB — the bulk
// of the per-row payload — from every 90-day read. Using this narrower type on the
// consumers is the compile-time proof that no scorer path reads rawMetrics/id/etc.
type ScoringHistoryRow = Pick<
  HistoryRow,
  'collectedAt' | 'uptimeSeconds' | 'bootTime' | 'crashEvents' | 'appHangs' | 'serviceFailures' | 'hardwareErrors'
>;
```

- [ ] **Step 4: Project the read in `getHistoryForDevice`**

Replace the body at `reliabilityScoring.ts:1287-1294`:

```ts
async function getHistoryForDevice(deviceId: string, days: number): Promise<ScoringHistoryRow[]> {
  const since = getSince(days);
  // #event-loop-hardening: explicit column list (NOT SELECT *) — drops raw_metrics
  // JSONB (~2KB/row) which the scorer never reads. Uses
  // reliability_history_device_collected_idx (device_id, collected_at).
  return db
    .select({
      collectedAt: deviceReliabilityHistory.collectedAt,
      uptimeSeconds: deviceReliabilityHistory.uptimeSeconds,
      bootTime: deviceReliabilityHistory.bootTime,
      crashEvents: deviceReliabilityHistory.crashEvents,
      appHangs: deviceReliabilityHistory.appHangs,
      serviceFailures: deviceReliabilityHistory.serviceFailures,
      hardwareErrors: deviceReliabilityHistory.hardwareErrors,
    })
    .from(deviceReliabilityHistory)
    .where(and(eq(deviceReliabilityHistory.deviceId, deviceId), gte(deviceReliabilityHistory.collectedAt, since)))
    .orderBy(asc(deviceReliabilityHistory.collectedAt));
}
```

- [ ] **Step 5: Narrow the three consumer signatures**

The compiler will now flag each place that expected the wide `HistoryRow[]`. Change these param/return types from `HistoryRow[]` to `ScoringHistoryRow[]` (bodies unchanged — they already read only the seven columns):

- `reliabilityScoring.ts:1313` — `function getLatestCollectedAt(rows: ScoringHistoryRow[]): Date | null {` (reads only `.collectedAt`).
- `reliabilityScoring.ts:881` — `mergeRowsIntoDailyBuckets(map: Map<string, DailyAggregateBucket>, rows: ScoringHistoryRow[], seenKeys: Set<string> = new Set<string>())`.
- `reliabilityScoring.ts:1968` — `function aggregateReliabilityOffenders(rows: ScoringHistoryRow[], limit = DEFAULT_OFFENDER_LIMIT, window?: OffenderWindow)`.

`bootSpanUpDayKeys` already takes `Array<Pick<HistoryRow, 'bootTime' | 'collectedAt'>>` (line 396-397) — structurally compatible, no change needed.

- [ ] **Step 6: Typecheck + run the golden guard + full reliability suite**

Run: `pnpm --filter=@breeze/api typecheck`
Expected: PASS (no `rawMetrics`/`id` access errors surfaced — if the compiler flags one, a scorer path secretly depended on a dropped column; stop and reassess before widening the projection).

Run: `pnpm --filter=@breeze/api test -- reliabilityScoring.test.ts`
Expected: PASS — all existing bucketing/scoring/dedup tests plus the new golden guard stay green (output unchanged).

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/services/reliabilityScoring.ts apps/api/src/services/reliabilityScoring.test.ts
git commit -m "perf(reliability): project scorer read columns, drop rawMetrics JSONB from 90d history read

getHistoryForDevice issued SELECT * (incl ~2KB/row raw_metrics JSONB the scorer
never reads) over the full 90-day window on every ingest — the dominant
transfer/GC cost pegging the API event loop under a high-frequency device.
Project to the 7 consumed columns; ScoringHistoryRow narrows the consumers so
the compiler proves no path reads the dropped columns. Output unchanged.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Real-DB golden-value + bound integration test

**Files:**
- Create: `apps/api/src/services/reliabilityScoring.projection.integration.test.ts`

**Interfaces:**
- Consumes: `computeAndPersistDeviceReliability(deviceId: string): Promise<boolean>` (exported, `reliabilityScoring.ts:1324`); `deviceReliabilityHistory`, `deviceReliability`, `devices`, `organizations` schema; the integration test DB harness (real Postgres on :5433 — see `vitest.integration.config.ts` and existing `*.integration.test.ts` for the `withSystemDbAccessContext`/seed/cleanup conventions).
- Produces: proof that (a) the projected query returns correct data from real Postgres, (b) a device with many same-day posts persists the golden expected `device_reliability` fields, (c) compute succeeds when rows are read without `rawMetrics`.

- [ ] **Step 1: Write the failing integration test**

Follow the seed/cleanup pattern of an existing `apps/api/src/**/*.integration.test.ts` (org + device fixture under `withSystemDbAccessContext`, `cleanupDatabase`-style teardown). Insert a synthetic history for one device — **≥50 posts inside a single UTC day** (the high-frequency case), a known set of crash/service events with deliberate cross-row repeats, and a populated `rawMetrics` on every row (to prove it is fetched-and-ignored). Then run the compute and assert the persisted row.

```ts
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, withSystemDbAccessContext } from '../db';
import { deviceReliability, deviceReliabilityHistory, devices, organizations } from '../db/schema';
import { computeAndPersistDeviceReliability } from './reliabilityScoring';
// ...import the project's standard integration seed/cleanup helpers...

describe('reliability scoring — projected read golden value (integration)', () => {
  const orgId = '00000000-0000-4000-a000-0000000000e1';
  const deviceId = '00000000-0000-4000-a000-0000000000e2';

  beforeAll(async () => {
    await withSystemDbAccessContext(async () => {
      // seed org (ml.device_reliability.enabled must resolve true for this org),
      // seed device (deviceRole workstation, enrolledAt 40 days ago).
      // Insert 50 history rows across 2026-02-20T00:05..23:55Z:
      //  - every row carries rawMetrics: { cpu: 12, mem: 34, blob: 'x'.repeat(2000) }
      //  - rows 0..24 each re-report crash event { type:'os_crash', timestamp:'2026-02-20T10:05:00Z', bugCheckCode:'0x1a' }
      //  - row 30 reports a DISTINCT crash { type:'os_crash', timestamp:'2026-02-20T11:00:00Z', bugCheckCode:'0x50' }
      //  - one service failure { serviceName:'Spooler', timestamp:'2026-02-20T12:00:00Z', recovered:true } on rows 40..45 (same event)
    });
  });

  afterAll(async () => {
    await withSystemDbAccessContext(async () => {
      await db.delete(deviceReliabilityHistory).where(eq(deviceReliabilityHistory.deviceId, deviceId));
      await db.delete(deviceReliability).where(eq(deviceReliability.deviceId, deviceId));
      await db.delete(devices).where(eq(devices.id, deviceId));
      await db.delete(organizations).where(eq(organizations.id, orgId));
    });
  });

  it('persists golden reliability fields from a projected read of a high-frequency device', async () => {
    const ok = await withSystemDbAccessContext(() => computeAndPersistDeviceReliability(deviceId));
    expect(ok).toBe(true);

    const [row] = await withSystemDbAccessContext(() =>
      db.select().from(deviceReliability).where(eq(deviceReliability.deviceId, deviceId)).limit(1),
    );
    expect(row).toBeDefined();
    // GOLDEN: global dedup collapses the 25 repeats to 1, keeps the 1 distinct → 2.
    expect(row!.crashCount30d).toBe(2);
    // GOLDEN: 6 identical Spooler failures across rows 40..45 collapse to 1.
    expect(row!.serviceFailureCount30d).toBe(1);
    // Sanity: a bounded, valid score was produced from raw_metrics-free rows.
    expect(row!.reliabilityScore).toBeGreaterThanOrEqual(0);
    expect(row!.reliabilityScore).toBeLessThanOrEqual(100);
  });
});
```

> Implementer note: pin the remaining GOLDEN field expectations (`hangCount30d`, `hardwareErrorCount30d`, `uptime30d`, `reliabilityScore`, `trendDirection`) to the ACTUAL values from a first green run against real Postgres — record them as literals so any later output drift fails loudly. Do not invent numbers; capture them from the run.

- [ ] **Step 2: Run against real Postgres**

Run: `pnpm --filter=@breeze/api test:integration -- reliabilityScoring.projection.integration.test.ts`
Expected: PASS. `crashCount30d === 2` and `serviceFailureCount30d === 1` confirm behavior is preserved through the projected read; a valid score confirms compute never needed `rawMetrics`.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/services/reliabilityScoring.projection.integration.test.ts
git commit -m "test(reliability): real-DB golden-value for projected history read (high-frequency device)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Widen recompute dedupe window (10 min) + lower worker concurrency (2)

**Files:**
- Modify: `apps/api/src/jobs/reliabilityWorker.ts:31` (dedupe window) and `:123` (concurrency)
- Test: `apps/api/src/jobs/reliabilityWorker.test.ts` (extend)

**Interfaces:**
- Consumes: existing `enqueueDeviceReliabilityComputation(deviceId: string): Promise<string>` slot logic (`reliabilityWorker.ts:180-209`) and `createReliabilityWorker()` (`:107-129`).
- Produces: no signature change. `ON_DEMAND_RELIABILITY_DEDUPE_WINDOW_MS = 10 * 60 * 1000`; worker `concurrency: 2`.

- [ ] **Step 1: Write the failing test — 10-min dedupe reuse**

The existing worker test (`reliabilityWorker.test.ts`) mocks `bullmq` and asserts jobId shape. Add a test that pins the widened window: two enqueues ~9 minutes apart must land in the SAME slot (same jobId), which only holds if the window is ≥10 min. The slot is `Math.floor(Date.now() / WINDOW).toString(36)`, so drive `Date.now()` deterministically.

```ts
it('keeps two recompute requests 9 minutes apart in the same dedupe slot (10-min window)', async () => {
  const base = 1_770_000_000_000; // fixed epoch ms
  const nowSpy = vi.spyOn(Date, 'now');

  nowSpy.mockReturnValue(base);
  const slotA = (await enqueueDeviceReliabilityComputation('device-1')).match(/:([a-z0-9]+)$/)?.[1]
    ?? extractSlotFromLastAdd(); // however the existing test reads the jobId; reuse its accessor

  nowSpy.mockReturnValue(base + 9 * 60 * 1000);
  await enqueueDeviceReliabilityComputation('device-1');

  // Both queue.add calls (or the getJob dedupe path) must use the identical jobId slot.
  const jobIds = getAddedJobIds(); // helper mirroring existing assertions on the mocked queue
  expect(jobIds[0]).toBe(jobIds[1]);
  nowSpy.mockRestore();
});
```

> Implementer note: reuse the exact mocked-`bullmq` accessors the file already uses (see its `queue.add`/`getJob` mocks at lines ~15-33, 96-118). If the existing test reads the jobId off the `add` mock's call args, do the same here rather than regex-matching a return value.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter=@breeze/api test -- reliabilityWorker.test.ts -t "same dedupe slot"`
Expected: FAIL — with the current 30s window, `base` and `base + 9min` fall in different slots, so the jobIds differ.

- [ ] **Step 3: Widen the window constant**

`apps/api/src/jobs/reliabilityWorker.ts:31`:

```ts
// Event-loop hardening: a device recomputes at most once per 10 min on-demand
// regardless of post rate. The jobId slot below keys on this window, so widening
// the constant is the whole throttle. Trade-off: score staleness ≤10 min.
const ON_DEMAND_RELIABILITY_DEDUPE_WINDOW_MS = 10 * 60 * 1000;
```

- [ ] **Step 4: Run the dedupe test to verify it passes**

Run: `pnpm --filter=@breeze/api test -- reliabilityWorker.test.ts -t "same dedupe slot"`
Expected: PASS.

- [ ] **Step 5: Write the failing test — concurrency 2**

```ts
it('creates the reliability worker with concurrency 2 (event-loop hardening)', () => {
  createReliabilityWorker();
  // The bullmq Worker mock records constructor args; assert the options object.
  const opts = getLastWorkerOptions(); // mirror the file's existing Worker mock accessor
  expect(opts.concurrency).toBe(2);
});
```

> Implementer note: the file already mocks `Worker` from `bullmq` (line ~15). Read the 3rd constructor arg (options) from that mock's calls; if no accessor exists yet, capture `vi.mocked(Worker).mock.calls.at(-1)?.[2]`.

- [ ] **Step 6: Run to verify it fails**

Run: `pnpm --filter=@breeze/api test -- reliabilityWorker.test.ts -t "concurrency 2"`
Expected: FAIL — current value is 5.

- [ ] **Step 7: Lower concurrency**

`apps/api/src/jobs/reliabilityWorker.ts:123`:

```ts
      // Event-loop hardening: cap simultaneous heavy computes. With the projected
      // read (Task 1) each compute is cheap, so 2 is ample headroom.
      concurrency: 2,
```

- [ ] **Step 8: Run the full worker suite**

Run: `pnpm --filter=@breeze/api test -- reliabilityWorker.test.ts`
Expected: PASS (both new tests + all existing).

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/jobs/reliabilityWorker.ts apps/api/src/jobs/reliabilityWorker.test.ts
git commit -m "perf(reliability): 10-min on-demand recompute dedupe window + worker concurrency 5->2

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Self-manage DB context on the reliability ingest route (#1105)

**Files:**
- Modify: `apps/api/src/middleware/agentAuth.ts:197` (allowlist)
- Test: `apps/api/src/middleware/agentAuth.test.ts` (assert wrap skipped for reliability)
- Modify: `apps/api/src/routes/agents/reliability.ts` (self-manage context)
- Test: `apps/api/src/routes/agents/reliability.test.ts` (depth-tracking)

**Interfaces:**
- Consumes: `SELF_MANAGED_DB_CONTEXT_ACTIONS` (Set, `agentAuth.ts:197`) — routes whose last path segment is in the set skip the request-long org wrap (`agentAuth.ts:431-434`); `withDbAccessContext` from `../../db`; existing `enqueueDeviceReliabilityComputation`, `writeAuditEvent`, `computeAndPersistDeviceReliability`.
- Produces: the reliability route holds an org-scoped `withDbAccessContext` **only** across the device lookup + history insert; the BullMQ enqueue (and its inline-fallback compute) and `writeAuditEvent` run at DB-context depth 0.

**Why middleware + route change land together (single commit):** adding `'reliability'` to the allowlist WITHOUT the route self-managing would leave the route's `db.select`/`db.insert` running with no DB access context (bare pool — forbidden, and RLS would deny). They are one atomic correctness change.

- [ ] **Step 1: Write the failing middleware test**

In `apps/api/src/middleware/agentAuth.test.ts`, mirror the existing happy-path setup ("proceeds to next() when the device tenant is active", ~line 266). Add a test that drives a request whose path ends in `/reliability` through `agentAuthMiddleware` and asserts the org wrap (`withDbAccessContext` from the mocked `../db`, line 8) is NOT invoked while `next` still runs.

```ts
it('skips the request-long org wrap for the self-managed reliability route', async () => {
  // ...reuse the happy-path auth mocks (valid token hash, active tenant, rate limit ok)...
  const c = makeContext({ path: '/api/v1/agents/agent-123/reliability', param: { id: 'agent-123' } });
  const next = vi.fn(async () => {});

  await agentAuthMiddleware(c, next);

  expect(next).toHaveBeenCalledTimes(1);
  expect(vi.mocked(withDbAccessContext)).not.toHaveBeenCalled(); // route self-manages
});
```

> Implementer note: use the file's existing context/mock builders (whatever `makeContext`/token-hash/rate-limit stubs the happy-path test already uses at ~238-280). The only new assertion is `withDbAccessContext` not called for the reliability action.

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter=@breeze/api test -- agentAuth.test.ts -t "self-managed reliability"`
Expected: FAIL — `reliability` is not yet in the allowlist, so the middleware wraps the request and `withDbAccessContext` IS called.

- [ ] **Step 3: Add `reliability` to the allowlist**

`apps/api/src/middleware/agentAuth.ts:197`:

```ts
const SELF_MANAGED_DB_CONTEXT_ACTIONS = new Set(['heartbeat', 'reliability']);
```

- [ ] **Step 4: Run the middleware test to verify it passes**

Run: `pnpm --filter=@breeze/api test -- agentAuth.test.ts -t "self-managed reliability"`
Expected: PASS.

- [ ] **Step 5: Write the failing route depth-tracking test**

In `apps/api/src/routes/agents/reliability.test.ts`, extend the mocked `../../db` (lines 4-12) so `withDbAccessContext` tracks nesting depth, and capture the depth seen by the enqueue + audit mocks. The route currently runs its DB work with bare `db` (no self-managed context), so after the middleware change these would run at whatever ambient depth — the test pins the target: enqueue/audit at depth 0, insert at depth 1.

```ts
// Replace the ../../db mock's withDbAccessContext with a depth-tracking impl:
let contextDepth = 0;
vi.mock('../../db', () => ({
  runOutsideDbContext: vi.fn((fn) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => {
    contextDepth += 1;
    try { return await fn(); } finally { contextDepth -= 1; }
  }),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: { select: vi.fn(), insert: vi.fn() },
}));

// ...in the suite...
it('runs BullMQ enqueue and audit write at DB-context depth 0 (#1105)', async () => {
  let enqueueDepth = -1;
  let auditDepth = -1;
  vi.mocked(enqueueDeviceReliabilityComputation).mockImplementation(async () => {
    enqueueDepth = contextDepth;
    return 'job-1';
  });
  vi.mocked(writeAuditEvent).mockImplementation(() => {
    auditDepth = contextDepth;
  });

  const res = await buildApp().request('/agents/agent-123/reliability', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });

  expect(res.status).toBe(200);
  expect(enqueueDepth).toBe(0);  // enqueue is OUTSIDE the org transaction
  expect(auditDepth).toBe(0);    // audit is OUTSIDE the org transaction
  expect(vi.mocked(withDbAccessContext)).toHaveBeenCalled(); // insert WAS wrapped
});
```

> Implementer note: `writeAuditEvent` is imported and mocked in this file (line 41-43). Import it alongside the others (line 47-51) so `vi.mocked(writeAuditEvent)` resolves. Keep the existing tests green — the depth-tracking `withDbAccessContext` still just runs `fn()`.

- [ ] **Step 6: Run to verify it fails**

Run: `pnpm --filter=@breeze/api test -- reliability.test.ts -t "depth 0"`
Expected: FAIL — the route does not yet open a `withDbAccessContext`, so `withDbAccessContext` is never called (assertion at end fails), and/or enqueue/audit depths don't reflect the intended structure.

- [ ] **Step 7: Rewrite the route to self-manage its context**

Replace `apps/api/src/routes/agents/reliability.ts` handler body (lines 20-77) so the lookup + insert run inside ONE short org-scoped context, and the enqueue + audit run after it returns. Add the `withDbAccessContext` import.

```ts
import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { eq } from 'drizzle-orm';
import { reliabilityMetricsSchema } from '@breeze/shared/validators';

import { db, withDbAccessContext } from '../../db';
import { deviceReliabilityHistory, devices } from '../../db/schema';
import { enqueueDeviceReliabilityComputation } from '../../jobs/reliabilityWorker';
import { writeAuditEvent } from '../../services/auditEvents';
import { computeAndPersistDeviceReliability } from '../../services/reliabilityScoring';
import { captureException } from '../../services/sentry';
import { sanitizeTimestamp } from './helpers';
import { requireAgentRole } from '../../middleware/requireAgentRole';

export const reliabilityRoutes = new Hono();
// Reliability-metric ingest is the main agent's job; reject watchdog-role
// tokens so a weaker credential can't falsify operator-facing device posture (F8).
reliabilityRoutes.use('*', requireAgentRole);

reliabilityRoutes.post('/:id/reliability', zValidator('json', reliabilityMetricsSchema), async (c) => {
  const agentId = c.req.param('id');
  const metrics = c.req.valid('json');
  const agent = c.get('agent') as { orgId?: string; agentId?: string; deviceId?: string; siteId?: string } | undefined;

  // #1105 — this route is in SELF_MANAGED_DB_CONTEXT_ACTIONS (agentAuth.ts), so the
  // request-long org wrap is skipped. Hold an org-scoped context ONLY across the
  // lookup + insert; the BullMQ enqueue and audit write run OUTSIDE it so no pooled
  // connection is pinned idle-in-transaction across Redis/non-DB work.
  const dbContext = {
    scope: 'organization' as const,
    orgId: agent?.orgId ?? '',
    accessibleOrgIds: agent?.orgId ? [agent.orgId] : [],
    accessiblePartnerIds: [],
    currentPartnerId: null,
  };

  const lookup = await withDbAccessContext(dbContext, async (): Promise<{ ok: true; deviceId: string; orgId: string } | { ok: false }> => {
    const [device] = await db
      .select({ id: devices.id, orgId: devices.orgId })
      .from(devices)
      .where(eq(devices.agentId, agentId))
      .limit(1);

    if (!device) return { ok: false };

    await db.insert(deviceReliabilityHistory).values({
      deviceId: device.id,
      orgId: device.orgId,
      collectedAt: new Date(),
      uptimeSeconds: metrics.uptimeSeconds,
      bootTime: sanitizeTimestamp(metrics.bootTime) ?? new Date(),
      crashEvents: metrics.crashEvents,
      appHangs: metrics.appHangs,
      serviceFailures: metrics.serviceFailures,
      hardwareErrors: metrics.hardwareErrors,
      rawMetrics: metrics,
    });

    return { ok: true, deviceId: device.id, orgId: device.orgId };
  });

  if (!lookup.ok) {
    return c.json({ error: 'Device not found' }, 404);
  }

  // Outside the transaction: Redis enqueue (with inline compute fallback).
  try {
    await enqueueDeviceReliabilityComputation(lookup.deviceId);
  } catch (error) {
    console.error('[agents] failed to enqueue reliability computation, using inline fallback:', error);
    captureException(error);
    await computeAndPersistDeviceReliability(lookup.deviceId);
  }

  // Outside the transaction: audit write (fire-and-forget, as before).
  writeAuditEvent(c, {
    orgId: agent?.orgId ?? lookup.orgId,
    actorType: 'agent',
    actorId: agent?.agentId ?? agentId,
    action: 'agent.reliability.submit',
    resourceType: 'device',
    resourceId: lookup.deviceId,
    details: {
      crashes: metrics.crashEvents.length,
      hangs: metrics.appHangs.length,
      serviceFailures: metrics.serviceFailures.length,
      hardwareErrors: metrics.hardwareErrors.length,
    },
  });

  return c.json({ success: true, status: 'received' });
});
```

> Behavior notes preserved: the insert-failure path still returns `500` — Drizzle `db.insert` rejection now propagates out of `withDbAccessContext` and surfaces via the router's error handling; if the existing test asserts the specific `{ error: 'Failed to record reliability metrics' }` body + 500 (see `reliability.test.ts`), wrap the insert in its own try/catch inside the callback and `return { ok: false, failed: true }`, then map to that 500 body after the context. Match whatever the existing test expects — do not change the observable 404/500/200 contract.

- [ ] **Step 8: Run the route depth-tracking test + full route suite**

Run: `pnpm --filter=@breeze/api test -- reliability.test.ts`
Expected: PASS — the new depth-0 test plus all existing route tests (404-on-missing-device, insert-failure 500 shape, inline-fallback-on-enqueue-failure, success body shape, insert values).

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/middleware/agentAuth.ts apps/api/src/middleware/agentAuth.test.ts apps/api/src/routes/agents/reliability.ts apps/api/src/routes/agents/reliability.test.ts
git commit -m "fix(reliability): self-manage DB context on ingest route to release #1105 held-transaction pin

The reliability ingest ran its entire request inside agentAuth's request-long
org transaction, pinning a pooled connection idle-in-transaction across the
BullMQ enqueue and audit write (Client:ClientRead, #1105). Add 'reliability' to
SELF_MANAGED_DB_CONTEXT_ACTIONS and scope a short withDbAccessContext around only
the lookup+insert; enqueue and audit now run at DB-context depth 0.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Final Verification (after all tasks)

- [ ] `pnpm --filter=@breeze/api typecheck` — PASS
- [ ] `pnpm --filter=@breeze/api test` — full API unit suite PASS
- [ ] `pnpm --filter=@breeze/api test:integration -- reliabilityScoring.projection.integration.test.ts` — PASS (real DB golden value)
- [ ] `git log --oneline main..HEAD` — four implementation commits on top of the design-spec commit
- [ ] Manual sanity: `grep -n "30 \* 1000\|concurrency: 5" apps/api/src/jobs/reliabilityWorker.ts` returns nothing; `grep -n "SELECT \*\|\.select()" ` at `getHistoryForDevice` returns nothing.

## Rollout (per spec)

- Normal release: tag → build → deploy EU + US (`docker compose pull api web && up`).
- No data migration, no new env var, no infra/compose change.
- Post-deploy US verification: API CPU no longer spikes to a full core under reliability load; `POST /agents/:id/reliability` and `GET /devices/:id/events` p95 drop to sub-second; #1105 `Client:ClientRead` warning rate falls to ~0.
- Runaway device `61728f06…` (posts every ~18s, ~13,774 rows) is a **separate operational track** — this hardening makes its compute cheap and bounded regardless.

## Self-Review notes (spec coverage)

- Spec change #1 (O(days)/drop rawMetrics) → **Task 1** (column projection; SQL push-down of event aggregation deliberately NOT done — documented in Global Constraints because #1904 global per-event dedup forbids it; the projection is the spec's "guaranteed-safe floor" and captures the dominant cost).
- Spec change #2 (dedupe window 30s→10min) → **Task 3** steps 1-4.
- Spec change #3 (concurrency 5→2) → **Task 3** steps 5-8.
- Spec change #4 (#1105 route self-manage) → **Task 4** (middleware allowlist + route rewrite, one atomic commit).
- Spec tests: golden-value → Task 1 (unit) + Task 2 (real-DB persisted fields); dedupe-window → Task 3; #1105 depth-tracking → Task 4; bound assertion → Task 2 (high-frequency device computes from rawMetrics-free rows); existing suites → verified green in each task.
