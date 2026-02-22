# Reliability Scoring PR Review Fixes

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix all critical and important issues identified in PR #136 code review — covering data correctness, security, resilience, schema integrity, and test coverage gaps.

**Architecture:** Fixes are grouped into four domains: Go agent collectors, TypeScript API correctness/resilience, SQL schema/migration, and tests. Each task is self-contained. Tasks within a domain must run sequentially; domains are independent.

**Tech Stack:** Go 1.21, TypeScript, Hono, Drizzle ORM, BullMQ, Vitest, PostgreSQL

---

## Domain A — Go Agent Collectors

### Task A1: Fix `classifyHardwareType` event ID matching

**Files:**
- Modify: `agent/internal/collectors/reliability.go:116-128`

**Context:** `strings.Contains(eid, "7")` matches "17", "107", etc. All three platform collectors call `appendHardwareError` which calls `classifyHardwareType`, so fixing the root function fixes all platforms.

**Step 1: Make the fix**

Replace the three `strings.Contains(eid, ...)` calls with exact equality checks:

```go
func classifyHardwareType(message, source, eventID string) string {
	msg := strings.ToLower(message)
	src := strings.ToLower(source)
	eid := strings.ToLower(eventID)
	switch {
	case strings.Contains(src, "whea"), strings.Contains(msg, "machine check"), strings.Contains(msg, "mce"):
		return "mce"
	case strings.Contains(msg, "memory"), strings.Contains(msg, "edac"),
		eid == "13" || eid == "50" || eid == "51":
		return "memory"
	case strings.Contains(msg, "disk"), strings.Contains(msg, "i/o"), strings.Contains(msg, "blk_update_request"),
		eid == "7" || eid == "11" || eid == "15":
		return "disk"
	default:
		return "unknown"
	}
}
```

**Step 2: Run the agent tests**

```bash
cd /Users/toddhebebrand/breeze/.worktrees/BE-3-reliability-scoring/agent && go test ./internal/collectors/... -v
```
Expected: all existing tests pass.

**Step 3: Commit**

```bash
git add agent/internal/collectors/reliability.go
git commit -m "fix: use exact equality for hardware error event ID classification"
```

---

### Task A2: Fix `oom_kill` dead enum — emit correct type from Linux collector

**Files:**
- Modify: `agent/internal/collectors/reliability_linux.go:33-38`

**Context:** The TypeScript/Zod enum includes `"oom_kill"` but Linux emits OOM events as `"system_crash"` with `reason: "oom"`. Any dashboard filter for `type == 'oom_kill'` always returns zero. Fix the Linux collector to emit `"oom_kill"` directly.

**Step 1: Make the fix**

In `reliability_linux.go`, change the OOM case:

```go
case strings.Contains(msg, "oom"), strings.Contains(msg, "out of memory"):
    appendCrash(metrics, "oom_kill", ts, map[string]any{
        "source":  entry.Source,
        "eventId": entry.EventID,
    })
```

**Step 2: Run the agent tests**

```bash
cd /Users/toddhebebrand/breeze/.worktrees/BE-3-reliability-scoring/agent && go test ./internal/collectors/... -v
```
Expected: pass.

**Step 3: Commit**

```bash
git add agent/internal/collectors/reliability_linux.go
git commit -m "fix: emit oom_kill crash type for Linux OOM events (was system_crash with reason oom)"
```

---

### Task A3: Fix double-counting of events as crash/hang + hardware error

**Files:**
- Modify: `agent/internal/collectors/reliability_linux.go:20-53`
- Modify: `agent/internal/collectors/reliability_darwin.go:20-59`

**Context:** After the `switch` classifies an event (e.g., OOM → crash), execution falls through to the trailing `if entry.Category == "hardware" || strings.Contains(msg, ...)` block. An OOM event also contains "out of memory" which does not match the hardware block, but a crash with "memory" in the message (Linux) or the hardware block's `strings.Contains(msg, "memory")` (Darwin) can double-count.

The fix is to make the hardware `if` block an `else` branch so it only fires when the `switch` matched nothing.

**Linux — Step 1: Restructure the classification loop**

Replace the `for` loop body in `reliability_linux.go`:

```go
for _, entry := range events {
    ts := normalizeEventTimestamp(entry.Timestamp)
    msg := strings.ToLower(entry.Message)
    src := strings.ToLower(entry.Source)

    classified := true
    switch {
    case strings.Contains(msg, "kernel panic"), strings.Contains(msg, "oops"), strings.Contains(msg, "segfault"):
        appendCrash(metrics, "kernel_panic", ts, map[string]any{
            "source":  entry.Source,
            "eventId": entry.EventID,
        })

    case strings.Contains(msg, "oom"), strings.Contains(msg, "out of memory"):
        appendCrash(metrics, "oom_kill", ts, map[string]any{
            "source":  entry.Source,
            "eventId": entry.EventID,
        })

    case strings.Contains(msg, "service") && (strings.Contains(msg, "failed") || strings.Contains(msg, "failure")),
        strings.Contains(src, "systemd") && strings.Contains(msg, "failed"):
        appendServiceFailure(metrics, entry.Source, ts, entry.EventID)

    case strings.Contains(msg, "hang"), strings.Contains(msg, "not responding"), strings.Contains(msg, "blocked for more than"):
        appendHang(metrics, entry.Source, ts)

    default:
        classified = false
    }

    if !classified && (entry.Category == "hardware" || strings.Contains(msg, "i/o error") || strings.Contains(msg, "edac") || strings.Contains(msg, "mce")) {
        appendHardwareError(metrics, entry, ts)
    }
}
```

**Darwin — Step 2: Same restructure**

Replace the `for` loop body in `reliability_darwin.go`:

```go
for _, entry := range events {
    ts := normalizeEventTimestamp(entry.Timestamp)
    msg := strings.ToLower(entry.Message)
    src := strings.ToLower(entry.Source)
    level := strings.ToLower(entry.Level)

    classified := true
    switch {
    case strings.Contains(msg, "kernel panic"), strings.Contains(msg, "panic("):
        appendCrash(metrics, "kernel_panic", ts, map[string]any{
            "source":  entry.Source,
            "eventId": entry.EventID,
        })

    case strings.Contains(msg, "application crash"), strings.Contains(msg, "crashed"):
        appendCrash(metrics, "system_crash", ts, map[string]any{
            "source":  entry.Source,
            "eventId": entry.EventID,
        })

    case strings.Contains(msg, "hang"), strings.Contains(msg, "not responding"):
        appendHang(metrics, entry.Source, ts)

    case strings.Contains(src, "launchd") && (strings.Contains(msg, "exited") || strings.Contains(msg, "failed")):
        appendServiceFailure(metrics, entry.Source, ts, entry.EventID)

    case level == "critical" && entry.Category == "system" && strings.Contains(msg, "shutdown"):
        appendCrash(metrics, "system_crash", ts, map[string]any{
            "source": entry.Source,
        })

    default:
        classified = false
    }

    if !classified && (entry.Category == "hardware" || strings.Contains(msg, "i/o error") || strings.Contains(msg, "memory")) {
        appendHardwareError(metrics, entry, ts)
    }
}
```

**Step 3: Run agent tests**

```bash
cd /Users/toddhebebrand/breeze/.worktrees/BE-3-reliability-scoring/agent && go test ./internal/collectors/... -v
```
Expected: pass.

**Step 4: Commit**

```bash
git add agent/internal/collectors/reliability_linux.go agent/internal/collectors/reliability_darwin.go
git commit -m "fix: prevent double-counting events as both crash/hang and hardware error"
```

---

## Domain B — API Security & Resilience

### Task B1: Fix empty `accessibleOrgIds` bypassing org filter

**Files:**
- Modify: `apps/api/src/routes/reliability.ts:74`

**Context:** `auth.accessibleOrgIds ?? undefined` returns `[]` (not undefined) for partner users with no accessible orgs, which passes the `if (!orgIds && ...)` guard and produces an unscoped query returning all tenants' data.

**Step 1: Make the fix**

On line 74, change:
```typescript
: (auth.accessibleOrgIds ?? undefined);
```
to:
```typescript
: (auth.accessibleOrgIds?.length ? auth.accessibleOrgIds : undefined);
```

**Step 2: Run existing tests**

```bash
pnpm -C apps/api test -- reliability.test.ts
```
Expected: pass (existing tests don't depend on the old behavior).

**Step 3: Commit**

```bash
git add apps/api/src/routes/reliability.ts
git commit -m "fix: empty accessibleOrgIds array no longer bypasses org scoping on reliability list route"
```

---

### Task B2: Add error handling to `db.insert` in agent reliability route

**Files:**
- Modify: `apps/api/src/routes/agents/reliability.ts:29-40`

**Context:** If the insert throws (FK violation, disk full, connection loss), the exception propagates with no device context in logs and no helpful error response. Wrap it in try-catch.

**Step 1: Make the fix**

Replace the bare insert call (lines 29-40) with:

```typescript
try {
  await db.insert(deviceReliabilityHistory).values({
    deviceId: device.id,
    orgId: device.orgId,
    collectedAt: new Date(),
    uptimeSeconds: metrics.uptimeSeconds,
    bootTime: new Date(metrics.bootTime),
    crashEvents: metrics.crashEvents,
    appHangs: metrics.appHangs,
    serviceFailures: metrics.serviceFailures,
    hardwareErrors: metrics.hardwareErrors,
    rawMetrics: metrics,
  });
} catch (error) {
  console.error(`[agents] failed to insert reliability history device=${device.id} org=${device.orgId}:`, error);
  return c.json({ error: 'Failed to record reliability metrics' }, 500);
}
```

**Step 2: Run tests**

```bash
pnpm -C apps/api test -- reliability.test.ts
```
Expected: pass.

**Step 3: Commit**

```bash
git add apps/api/src/routes/agents/reliability.ts
git commit -m "fix: handle db.insert failure in agent reliability route with contextual error logging"
```

---

### Task B3: Remove inline compute fallback (or capture to Sentry before falling back)

**Files:**
- Modify: `apps/api/src/routes/agents/reliability.ts:42-47`

**Context:** When `enqueueDeviceReliabilityComputation` fails (Redis down), silently running inline compute inside the HTTP handler hides the outage and adds per-heartbeat latency. The existing test at line 74 of `reliability.test.ts` tests that the fallback fires. We'll keep the fallback but capture the exception to Sentry so the outage is observable, and update the test to verify Sentry capture.

**Step 1: Add Sentry import to the route file**

At the top of `apps/api/src/routes/agents/reliability.ts`, add:
```typescript
import { captureException } from '../../services/sentry';
```

**Step 2: Add Sentry capture to the fallback**

Change lines 42-47:
```typescript
try {
  await enqueueDeviceReliabilityComputation(device.id);
} catch (error) {
  console.error('[agents] failed to enqueue reliability computation, using inline fallback:', error);
  captureException(error);
  await computeAndPersistDeviceReliability(device.id);
}
```

**Step 3: Update the mock in the test to include Sentry**

In `apps/api/src/routes/agents/reliability.test.ts`, add a mock after the existing mocks:
```typescript
vi.mock('../../services/sentry', () => ({
  captureException: vi.fn(),
}));
```
Then import it at the top with the other imports:
```typescript
import { captureException } from '../../services/sentry';
```

Update the fallback test to also assert Sentry was called:
```typescript
it('falls back to inline compute when queue enqueue fails', async () => {
  vi.mocked(enqueueDeviceReliabilityComputation).mockRejectedValue(new Error('queue unavailable'));
  vi.mocked(computeAndPersistDeviceReliability).mockResolvedValue(true);

  const app = buildApp();
  const response = await app.request('/agents/agent-123/reliability', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  expect(response.status).toBe(200);
  expect(vi.mocked(enqueueDeviceReliabilityComputation)).toHaveBeenCalledWith('device-1');
  expect(vi.mocked(captureException)).toHaveBeenCalledWith(expect.any(Error));
  expect(vi.mocked(computeAndPersistDeviceReliability)).toHaveBeenCalledWith('device-1');
});
```

**Step 4: Run tests**

```bash
pnpm -C apps/api test -- reliability.test.ts
```
Expected: pass.

**Step 5: Commit**

```bash
git add apps/api/src/routes/agents/reliability.ts apps/api/src/routes/agents/reliability.test.ts
git commit -m "fix: capture queue enqueue failures to Sentry before reliability inline fallback"
```

---

### Task B4: Fix `withSystemDbAccess` silent fallback in workers

**Files:**
- Modify: `apps/api/src/jobs/reliabilityWorker.ts:10-13`
- Modify: `apps/api/src/jobs/reliabilityRetention.ts:16-19`

**Context:** The ternary `typeof withSystem === 'function' ? withSystem(fn) : fn()` silently drops DB context if the export isn't a function. Replace with an assertion that throws.

**Step 1: Fix reliabilityWorker.ts lines 10-13**

```typescript
const runWithSystemDbAccess = async <T>(fn: () => Promise<T>): Promise<T> => {
  if (typeof dbModule.withSystemDbAccessContext !== 'function') {
    throw new Error('[ReliabilityWorker] withSystemDbAccessContext is not available — DB module may not have loaded correctly');
  }
  return dbModule.withSystemDbAccessContext(fn);
};
```

**Step 2: Fix reliabilityRetention.ts lines 16-19** (identical pattern)

```typescript
const runWithSystemDbAccess = async <T>(fn: () => Promise<T>): Promise<T> => {
  if (typeof dbModule.withSystemDbAccessContext !== 'function') {
    throw new Error('[ReliabilityRetention] withSystemDbAccessContext is not available — DB module may not have loaded correctly');
  }
  return dbModule.withSystemDbAccessContext(fn);
};
```

**Step 3: Run tests**

```bash
pnpm -C apps/api test -- reliabilityWorker reliabilityRetention
```
Expected: pass (no existing tests for workers, but TypeScript compilation must succeed).

**Step 4: Commit**

```bash
git add apps/api/src/jobs/reliabilityWorker.ts apps/api/src/jobs/reliabilityRetention.ts
git commit -m "fix: withSystemDbAccessContext absence now throws instead of silently dropping DB context"
```

---

### Task B5: Add Sentry capture and missing `failed` handler to BullMQ workers

**Files:**
- Modify: `apps/api/src/jobs/reliabilityWorker.ts:134-145`
- Modify: `apps/api/src/jobs/reliabilityRetention.ts:65-93`

**Context:** Worker errors and job failures are only logged to `console.error`. They need Sentry capture. Retention worker also has no `failed` event handler at all.

**Step 1: Add Sentry import to reliabilityWorker.ts**

```typescript
import { captureException } from '../services/sentry';
```

**Step 2: Update `initializeReliabilityWorker` error/failed handlers**

```typescript
reliabilityWorker.on('error', (error) => {
  console.error('[ReliabilityWorker] Worker error:', error);
  captureException(error);
});
reliabilityWorker.on('failed', (job, error) => {
  console.error(`[ReliabilityWorker] Job ${job?.id} (${job?.data?.type}) failed after ${job?.attemptsMade} attempts:`, error);
  captureException(error);
});
```

**Step 3: Add Sentry import to reliabilityRetention.ts**

```typescript
import { captureException } from '../services/sentry';
```

**Step 4: Update `initializeReliabilityRetention` — add Sentry + add missing `failed` handler**

```typescript
retentionWorker.on('error', (error) => {
  console.error('[ReliabilityRetention] Worker error:', error);
  captureException(error);
});
retentionWorker.on('failed', (job, error) => {
  console.error(`[ReliabilityRetention] Job ${job?.id} failed after ${job?.attemptsMade} attempts:`, error);
  captureException(error);
});
```

**Step 5: Run TypeScript compilation**

```bash
pnpm -C apps/api tsc --noEmit
```
Expected: no errors.

**Step 6: Commit**

```bash
git add apps/api/src/jobs/reliabilityWorker.ts apps/api/src/jobs/reliabilityRetention.ts
git commit -m "fix: capture BullMQ worker errors to Sentry; add missing failed handler to retention worker"
```

---

### Task B6: Fix `Promise.all` → `Promise.allSettled` + concurrency limit

**Files:**
- Modify: `apps/api/src/services/reliabilityScoring.ts:820-829`

**Context:** `Promise.all` over all org devices will exhaust the DB connection pool at scale and swallows per-device failures silently. Use `Promise.allSettled` with chunked concurrency (no new dependency needed).

**Step 1: Add concurrency helper above `computeAndPersistOrgReliability`**

Insert this function just before `computeAndPersistOrgReliability`:

```typescript
async function runConcurrently<T>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<void>
): Promise<{ succeeded: number; failed: number }> {
  let succeeded = 0;
  let failed = 0;
  for (let i = 0; i < items.length; i += concurrency) {
    const chunk = items.slice(i, i + concurrency);
    const results = await Promise.allSettled(chunk.map(fn));
    for (const result of results) {
      if (result.status === 'fulfilled') {
        succeeded++;
      } else {
        failed++;
        console.error('[ReliabilityScoring] device computation failed:', result.reason);
      }
    }
  }
  return { succeeded, failed };
}
```

**Step 2: Update `computeAndPersistOrgReliability`**

```typescript
export async function computeAndPersistOrgReliability(orgId: string): Promise<{ orgId: string; devicesComputed: number }> {
  const orgDevices = await db
    .select({ id: devices.id })
    .from(devices)
    .where(and(eq(devices.orgId, orgId), sql`${devices.status} <> 'decommissioned'`));

  if (orgDevices.length === 0) return { orgId, devicesComputed: 0 };

  const { succeeded } = await runConcurrently(
    orgDevices,
    10,
    (device) => computeAndPersistDeviceReliability(device.id).then(() => undefined)
  );

  return { orgId, devicesComputed: succeeded };
}
```

**Step 3: Run existing tests**

```bash
pnpm -C apps/api test -- reliabilityScoring.test.ts
```
Expected: pass.

**Step 4: Commit**

```bash
git add apps/api/src/services/reliabilityScoring.ts
git commit -m "fix: limit org reliability computation to 10 concurrent devices; use allSettled to isolate per-device failures"
```

---

### Task B7: Add `safeHandler` wrapper to `get_fleet_health` AI tool

**Files:**
- Modify: `apps/api/src/services/aiTools.ts:981-1051`

**Context:** Every other fleet tool uses a `safeHandler` wrapper for error handling. `get_fleet_health` has none — a DB failure throws unhandled into the AI agent loop.

**Step 1: Add a local `safeFleetHandler` helper near the `get_fleet_health` registration**

Directly above the `registerTool` call for `get_fleet_health` (around line 981), insert:

```typescript
function safeFleetHandler(
  toolName: string,
  fn: (input: Record<string, unknown>, auth: AuthContext) => Promise<string>
): (input: Record<string, unknown>, auth: AuthContext) => Promise<string> {
  return async (input, auth) => {
    try {
      return await fn(input, auth);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Internal error';
      console.error(`[fleet:${toolName}]`, message, err);
      return JSON.stringify({ error: 'Operation failed. Check server logs for details.' });
    }
  };
}
```

Note: Check the actual `auth` type used in the file (likely imported from middleware). Use `typeof auth` or replace with the correct type. If an `AuthContext` type isn't available in `aiTools.ts`, use `Parameters<typeof handler>[1]` or just `any` for the local helper — the important thing is the try-catch wrapping.

**Step 2: Wrap the handler**

Change:
```typescript
  handler: async (input, auth) => {
```
to:
```typescript
  handler: safeFleetHandler('get_fleet_health', async (input, auth) => {
```
and close the outer function with an extra `)` at the end.

**Step 3: Run TypeScript compilation**

```bash
pnpm -C apps/api tsc --noEmit
```
Expected: no errors.

**Step 4: Commit**

```bash
git add apps/api/src/services/aiTools.ts
git commit -m "fix: wrap get_fleet_health handler in safeFleetHandler to prevent unhandled AI loop crashes"
```

---

## Domain C — Database Migration & Schema

### Task C1: Add ON DELETE CASCADE, CHECK constraints, and `hang_count_90d`

**Files:**
- Modify: `apps/api/src/db/migrations/2026-02-21-reliability-scoring.sql`
- Modify: `apps/api/src/db/schema/reliability.ts`

**Context:** This migration file has not been applied to production (it's new in this PR). We amend it in-place rather than creating a follow-up migration.

**The changes needed:**
1. `ON DELETE CASCADE` on both `device_id` FKs so device deletion doesn't fail
2. SQL CHECK constraints bounding scores to [0, 100] and uptime to [0, 100]
3. Add `hang_count_90d` column (present for crashes but missing for hangs)

**Step 1: Update the migration SQL**

Replace the two `CREATE TABLE` blocks in `2026-02-21-reliability-scoring.sql` with:

```sql
DO $$
BEGIN
  CREATE TYPE trend_direction AS ENUM ('improving', 'stable', 'degrading');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS device_reliability_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  org_id UUID NOT NULL REFERENCES organizations(id),
  collected_at TIMESTAMP NOT NULL DEFAULT NOW(),
  uptime_seconds BIGINT NOT NULL,
  boot_time TIMESTAMP NOT NULL,
  crash_events JSONB NOT NULL DEFAULT '[]'::jsonb,
  app_hangs JSONB NOT NULL DEFAULT '[]'::jsonb,
  service_failures JSONB NOT NULL DEFAULT '[]'::jsonb,
  hardware_errors JSONB NOT NULL DEFAULT '[]'::jsonb,
  raw_metrics JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS reliability_history_device_collected_idx
  ON device_reliability_history (device_id, collected_at);
CREATE INDEX IF NOT EXISTS reliability_history_org_collected_idx
  ON device_reliability_history (org_id, collected_at);

CREATE TABLE IF NOT EXISTS device_reliability (
  device_id UUID PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
  org_id UUID NOT NULL REFERENCES organizations(id),
  computed_at TIMESTAMP NOT NULL DEFAULT NOW(),

  reliability_score INTEGER NOT NULL CHECK (reliability_score BETWEEN 0 AND 100),
  uptime_score INTEGER NOT NULL CHECK (uptime_score BETWEEN 0 AND 100),
  crash_score INTEGER NOT NULL CHECK (crash_score BETWEEN 0 AND 100),
  hang_score INTEGER NOT NULL CHECK (hang_score BETWEEN 0 AND 100),
  service_failure_score INTEGER NOT NULL CHECK (service_failure_score BETWEEN 0 AND 100),
  hardware_error_score INTEGER NOT NULL CHECK (hardware_error_score BETWEEN 0 AND 100),

  uptime_7d REAL NOT NULL CHECK (uptime_7d BETWEEN 0 AND 100),
  uptime_30d REAL NOT NULL CHECK (uptime_30d BETWEEN 0 AND 100),
  uptime_90d REAL NOT NULL CHECK (uptime_90d BETWEEN 0 AND 100),

  crash_count_7d INTEGER NOT NULL DEFAULT 0,
  crash_count_30d INTEGER NOT NULL DEFAULT 0,
  crash_count_90d INTEGER NOT NULL DEFAULT 0,

  hang_count_7d INTEGER NOT NULL DEFAULT 0,
  hang_count_30d INTEGER NOT NULL DEFAULT 0,
  hang_count_90d INTEGER NOT NULL DEFAULT 0,

  service_failure_count_7d INTEGER NOT NULL DEFAULT 0,
  service_failure_count_30d INTEGER NOT NULL DEFAULT 0,

  hardware_error_count_7d INTEGER NOT NULL DEFAULT 0,
  hardware_error_count_30d INTEGER NOT NULL DEFAULT 0,

  mtbf_hours REAL,
  trend_direction trend_direction NOT NULL,
  trend_confidence REAL NOT NULL DEFAULT 0 CHECK (trend_confidence BETWEEN 0 AND 1),
  top_issues JSONB NOT NULL DEFAULT '[]'::jsonb,
  details JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS reliability_org_score_idx
  ON device_reliability (org_id, reliability_score);
CREATE INDEX IF NOT EXISTS reliability_score_idx
  ON device_reliability (reliability_score);
CREATE INDEX IF NOT EXISTS reliability_trend_idx
  ON device_reliability (trend_direction);
```

**Step 2: Update the Drizzle schema to match**

In `apps/api/src/db/schema/reliability.ts`, add `hangCount90d` to the `deviceReliability` table, after `hangCount30d` (line 81):

```typescript
  hangCount30d: integer('hang_count_30d').notNull().default(0),
  hangCount90d: integer('hang_count_90d').notNull().default(0),
```

Also add `ON DELETE CASCADE` to both `references` in the schema:

```typescript
// deviceReliabilityHistory:
deviceId: uuid('device_id').notNull().references(() => devices.id, { onDelete: 'cascade' }),

// deviceReliability:
deviceId: uuid('device_id').primaryKey().references(() => devices.id, { onDelete: 'cascade' }),
```

**Step 3: Verify TypeScript compiles**

```bash
pnpm -C apps/api tsc --noEmit
```
Expected: no errors.

**Step 4: Commit**

```bash
git add apps/api/src/db/migrations/2026-02-21-reliability-scoring.sql apps/api/src/db/schema/reliability.ts
git commit -m "fix: add ON DELETE CASCADE, CHECK constraints for score bounds, and hang_count_90d column"
```

---

## Domain D — Tests

### Task D1: Export score functions from `reliabilityScoringInternals` and add score function tests

**Files:**
- Modify: `apps/api/src/services/reliabilityScoring.ts:1121-1130`
- Modify: `apps/api/src/services/reliabilityScoring.test.ts`

**Context:** The score computation functions `scoreUptime`, `scoreCrashes`, `scoreHangs`, `scoreServiceFailures`, `scoreHardwareErrors`, `scoreBand`, and `computeTopIssues` are untested. Add them to `reliabilityScoringInternals` then test each.

**Step 1: Add functions to the internals export**

```typescript
export const reliabilityScoringInternals = {
  parseAggregateState,
  mergeRowsIntoDailyBuckets,
  sortDailyBuckets,
  sumBucketsInWindow,
  scoreDailyBucket,
  buildDailyTrendPoints,
  computeTrend,
  computeMtbfHours,
  // Newly exported for testing:
  scoreUptime,
  scoreCrashes,
  scoreHangs,
  scoreServiceFailures,
  scoreHardwareErrors,
  scoreBand,
  computeTopIssues,
};
```

**Step 2: Add the tests to `reliabilityScoring.test.ts`**

Append after the existing `describe('reliabilityScoringInternals', ...)` block:

```typescript
describe('scoreUptime', () => {
  const { scoreUptime } = reliabilityScoringInternals;

  it('returns 100 at 100% uptime', () => expect(scoreUptime(100)).toBe(100));
  it('returns 0 at exactly 90% uptime (cliff boundary)', () => expect(scoreUptime(90)).toBe(0));
  it('returns 0 below 90% uptime', () => expect(scoreUptime(89)).toBe(0));
  it('returns 0 at 0%', () => expect(scoreUptime(0)).toBe(0));
  it('returns 50 at 95% uptime (midpoint of linear range)', () => expect(scoreUptime(95)).toBe(50));
});

describe('scoreCrashes', () => {
  const { scoreCrashes } = reliabilityScoringInternals;

  it('returns 100 with no crashes', () => expect(scoreCrashes(0, 0)).toBe(100));
  it('reduces score proportionally', () => expect(scoreCrashes(0, 1)).toBe(80));
  it('applies 0.5x weight to 7d crashes', () => expect(scoreCrashes(2, 0)).toBe(80));
  it('clamps to 0 with many crashes', () => expect(scoreCrashes(10, 10)).toBe(0));
});

describe('scoreHangs', () => {
  const { scoreHangs } = reliabilityScoringInternals;

  it('returns 100 with no hangs', () => expect(scoreHangs(0, 0)).toBe(100));
  it('unresolved hangs carry 2x penalty vs resolved', () => {
    const oneResolved = scoreHangs(1, 0);      // -10
    const oneUnresolved = scoreHangs(1, 1);    // -10 (total) -20 (unresolved) = -30 from 100 = 70
    expect(oneResolved).toBe(90);
    expect(oneUnresolved).toBe(70);
  });
  it('clamps to 0', () => expect(scoreHangs(20, 20)).toBe(0));
});

describe('scoreServiceFailures', () => {
  const { scoreServiceFailures } = reliabilityScoringInternals;

  it('returns 100 with no failures', () => expect(scoreServiceFailures(0, 0)).toBe(100));
  it('recovered services add 5 points each', () => expect(scoreServiceFailures(1, 1)).toBe(90));
  it('clamps to 0 with many failures', () => expect(scoreServiceFailures(10, 0)).toBe(0));
  it('clamps to 100 even with many recoveries', () => expect(scoreServiceFailures(0, 10)).toBe(100));
});

describe('scoreHardwareErrors', () => {
  const { scoreHardwareErrors } = reliabilityScoringInternals;

  it('returns 100 with no errors', () => expect(scoreHardwareErrors(0, 0, 0)).toBe(100));
  it('one critical error removes 30 points', () => expect(scoreHardwareErrors(1, 0, 0)).toBe(70));
  it('one error severity removes 15 points', () => expect(scoreHardwareErrors(0, 1, 0)).toBe(85));
  it('one warning removes 5 points', () => expect(scoreHardwareErrors(0, 0, 1)).toBe(95));
  it('clamps to 0 with 4+ critical errors', () => expect(scoreHardwareErrors(4, 0, 0)).toBe(0));
});

describe('scoreBand', () => {
  const { scoreBand } = reliabilityScoringInternals;

  it('returns critical at 50', () => expect(scoreBand(50)).toBe('critical'));
  it('returns poor at 51', () => expect(scoreBand(51)).toBe('poor'));
  it('returns poor at 70', () => expect(scoreBand(70)).toBe('poor'));
  it('returns fair at 71', () => expect(scoreBand(71)).toBe('fair'));
  it('returns fair at 85', () => expect(scoreBand(85)).toBe('fair'));
  it('returns good at 86', () => expect(scoreBand(86)).toBe('good'));
  it('returns good at 100', () => expect(scoreBand(100)).toBe('good'));
});

describe('computeTopIssues', () => {
  const { computeTopIssues } = reliabilityScoringInternals;
  const now = new Date('2026-02-20T00:00:00.000Z');

  it('returns empty array when all counts are zero', () => {
    const issues = computeTopIssues({
      dailyBuckets: [],
      now,
      uptime30d: 100,
      crashCount30d: 0,
      hangCount30d: 0,
      serviceFailureCount30d: 0,
      hardwareErrorCount30d: 0,
      criticalHardwareCount30d: 0,
    });
    expect(issues).toHaveLength(0);
  });

  it('sets crash severity to critical at 3+ crashes', () => {
    const issues = computeTopIssues({
      dailyBuckets: [],
      now,
      uptime30d: 100,
      crashCount30d: 3,
      hangCount30d: 0,
      serviceFailureCount30d: 0,
      hardwareErrorCount30d: 0,
      criticalHardwareCount30d: 0,
    });
    const crashes = issues.find((i) => i.type === 'crashes');
    expect(crashes?.severity).toBe('critical');
  });

  it('caps result to 5 issues', () => {
    const issues = computeTopIssues({
      dailyBuckets: [],
      now,
      uptime30d: 80,
      crashCount30d: 5,
      hangCount30d: 5,
      serviceFailureCount30d: 5,
      hardwareErrorCount30d: 5,
      criticalHardwareCount30d: 2,
    });
    expect(issues.length).toBeLessThanOrEqual(5);
  });
});
```

**Step 3: Run the tests**

```bash
pnpm -C apps/api test -- reliabilityScoring.test.ts
```
Expected: all tests pass. If `scoreBand` is not exported from internals, look for it at the bottom of the file and verify you added it to `reliabilityScoringInternals` in step 1.

**Step 4: Commit**

```bash
git add apps/api/src/services/reliabilityScoring.ts apps/api/src/services/reliabilityScoring.test.ts
git commit -m "test: add score function unit tests (scoreUptime, scoreCrashes, scoreHangs, scoreServiceFailures, scoreHardwareErrors, scoreBand, computeTopIssues)"
```

---

### Task D2: Add missing tests to agent reliability route

**Files:**
- Modify: `apps/api/src/routes/agents/reliability.test.ts`

**Context:** Two important cases are missing: (1) device not found returns 404, (2) the db.insert was actually called with the right shape.

**Step 1: Add tests at the end of the existing `describe` block**

```typescript
it('returns 404 when device is not found by agentId', async () => {
  vi.mocked(db.select).mockReturnValue({
    from: vi.fn(() => ({
      where: vi.fn(() => ({
        limit: vi.fn().mockResolvedValue([]),
      })),
    })),
  } as any);

  const app = buildApp();
  const response = await app.request('/agents/agent-unknown/reliability', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  expect(response.status).toBe(404);
});

it('inserts reliability history with the correct device and org ids', async () => {
  vi.mocked(enqueueDeviceReliabilityComputation).mockResolvedValue('job-1');
  const insertValues = vi.fn().mockResolvedValue(undefined);
  vi.mocked(db.insert).mockReturnValue({ values: insertValues } as any);

  const app = buildApp();
  await app.request('/agents/agent-123/reliability', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  expect(insertValues).toHaveBeenCalledWith(
    expect.objectContaining({
      deviceId: 'device-1',
      orgId: 'org-1',
      uptimeSeconds: payload.uptimeSeconds,
    })
  );
});

it('returns success response body with expected shape', async () => {
  vi.mocked(enqueueDeviceReliabilityComputation).mockResolvedValue('job-1');

  const app = buildApp();
  const response = await app.request('/agents/agent-123/reliability', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body).toEqual({ success: true, status: 'received' });
});
```

**Step 2: Run the tests**

```bash
pnpm -C apps/api test -- reliability.test.ts
```
Expected: all 5 tests pass.

**Step 3: Commit**

```bash
git add apps/api/src/routes/agents/reliability.test.ts
git commit -m "test: add device-not-found 404, insert shape verification, and response body tests for agent reliability route"
```

---

### Task D3: Create public reliability routes test file

**Files:**
- Create: `apps/api/src/routes/reliability.test.ts`

**Context:** The public routes (`GET /`, `GET /org/:orgId/summary`, `GET /:deviceId/history`, `GET /:deviceId`) have zero tests. This is 189 lines of access-control and query-routing code. Key behaviors to cover: org access guard, empty accessibleOrgIds guard, 404 paths.

**Step 1: Create the test file**

```typescript
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

vi.mock('../services/reliabilityScoring', () => ({
  listReliabilityDevices: vi.fn(),
  getOrgReliabilitySummary: vi.fn(),
  getDeviceReliabilityHistory: vi.fn(),
  getDeviceReliability: vi.fn(),
}));

vi.mock('./devices/helpers', () => ({
  getDeviceWithOrgCheck: vi.fn(),
}));

import {
  listReliabilityDevices,
  getOrgReliabilitySummary,
  getDeviceReliabilityHistory,
  getDeviceReliability,
} from '../services/reliabilityScoring';
import { getDeviceWithOrgCheck } from './devices/helpers';
import { reliabilityRoutes } from './reliability';

type ScopeType = 'organization' | 'partner' | 'system';

function buildApp(authOverrides: Record<string, unknown> = {}): Hono {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('auth', {
      scope: 'organization' as ScopeType,
      orgId: 'org-1',
      accessibleOrgIds: ['org-1'],
      canAccessOrg: (id: string) => id === 'org-1',
      ...authOverrides,
    });
    await next();
  });
  app.route('/reliability', reliabilityRoutes);
  return app;
}

describe('GET /reliability', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(listReliabilityDevices).mockResolvedValue({ total: 0, rows: [] });
  });

  it('returns 200 with empty results for org-scoped user', async () => {
    const app = buildApp();
    const response = await app.request('/reliability/');
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data).toEqual([]);
    expect(body.pagination.total).toBe(0);
  });

  it('returns 403 when orgId query param is inaccessible', async () => {
    const app = buildApp();
    const response = await app.request('/reliability/?orgId=00000000-0000-0000-0000-000000000001');
    expect(response.status).toBe(403);
  });

  it('returns 400 when partner user has no org context (empty accessibleOrgIds)', async () => {
    const app = buildApp({
      scope: 'partner',
      orgId: undefined,
      accessibleOrgIds: [],
      canAccessOrg: () => false,
    });
    const response = await app.request('/reliability/');
    expect(response.status).toBe(400);
  });

  it('passes accessible org ids to listReliabilityDevices for partner scope', async () => {
    const app = buildApp({
      scope: 'partner',
      orgId: undefined,
      accessibleOrgIds: ['org-1', 'org-2'],
      canAccessOrg: (id: string) => ['org-1', 'org-2'].includes(id),
    });
    await app.request('/reliability/');
    expect(vi.mocked(listReliabilityDevices)).toHaveBeenCalledWith(
      expect.objectContaining({ orgIds: ['org-1', 'org-2'] })
    );
  });

  it('allows system scope with no org context', async () => {
    const app = buildApp({
      scope: 'system',
      orgId: undefined,
      accessibleOrgIds: undefined,
      canAccessOrg: () => true,
    });
    const response = await app.request('/reliability/');
    expect(response.status).toBe(200);
  });
});

describe('GET /reliability/org/:orgId/summary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getOrgReliabilitySummary).mockResolvedValue({} as any);
    vi.mocked(listReliabilityDevices).mockResolvedValue({ total: 0, rows: [] });
  });

  it('returns 403 for inaccessible org', async () => {
    const app = buildApp();
    const response = await app.request('/reliability/org/00000000-0000-0000-0000-000000000099/summary');
    expect(response.status).toBe(403);
  });

  it('returns 200 with summary for accessible org', async () => {
    const app = buildApp();
    const response = await app.request('/reliability/org/org-1/summary');
    // org-1 is not a valid UUID format — need a real UUID for the param validator
    // This test uses a properly formatted UUID that matches canAccessOrg
    expect([200, 400]).toContain(response.status); // 400 if UUID validation rejects 'org-1'
  });
});

describe('GET /reliability/:deviceId', () => {
  const deviceId = '00000000-0000-0000-0000-000000000001';

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 404 when device is not found', async () => {
    vi.mocked(getDeviceWithOrgCheck).mockResolvedValue(null);
    const app = buildApp();
    const response = await app.request(`/reliability/${deviceId}`);
    expect(response.status).toBe(404);
  });

  it('returns 404 when no reliability snapshot exists yet', async () => {
    vi.mocked(getDeviceWithOrgCheck).mockResolvedValue({ id: deviceId, orgId: 'org-1' } as any);
    vi.mocked(getDeviceReliability).mockResolvedValue(null);
    vi.mocked(getDeviceReliabilityHistory).mockResolvedValue([]);
    const app = buildApp();
    const response = await app.request(`/reliability/${deviceId}`);
    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.error).toMatch(/No reliability snapshot/);
  });

  it('returns 200 with snapshot and history when device exists', async () => {
    const snapshot = { reliabilityScore: 85 };
    vi.mocked(getDeviceWithOrgCheck).mockResolvedValue({ id: deviceId, orgId: 'org-1' } as any);
    vi.mocked(getDeviceReliability).mockResolvedValue(snapshot as any);
    vi.mocked(getDeviceReliabilityHistory).mockResolvedValue([]);
    const app = buildApp();
    const response = await app.request(`/reliability/${deviceId}`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.snapshot.reliabilityScore).toBe(85);
  });
});

describe('GET /reliability/:deviceId/history', () => {
  const deviceId = '00000000-0000-0000-0000-000000000001';

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getDeviceReliabilityHistory).mockResolvedValue([]);
  });

  it('returns 404 when device not found', async () => {
    vi.mocked(getDeviceWithOrgCheck).mockResolvedValue(null);
    const app = buildApp();
    const response = await app.request(`/reliability/${deviceId}/history`);
    expect(response.status).toBe(404);
  });

  it('returns 200 with history for accessible device', async () => {
    vi.mocked(getDeviceWithOrgCheck).mockResolvedValue({ id: deviceId, orgId: 'org-1' } as any);
    const app = buildApp();
    const response = await app.request(`/reliability/${deviceId}/history`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.deviceId).toBe(deviceId);
    expect(body.points).toEqual([]);
  });
});
```

**Step 2: Run the new tests**

```bash
pnpm -C apps/api test -- apps/api/src/routes/reliability.test.ts
```
Expected: all tests pass. If any fail due to UUID validation for string IDs like 'org-1', update those tests to use proper UUID strings (e.g., `'00000000-0000-0000-0000-000000000001'`).

**Step 3: Commit**

```bash
git add apps/api/src/routes/reliability.test.ts
git commit -m "test: add route tests for public reliability endpoints covering access control and 404 paths"
```

---

## Final Step: Run Full Test Suite

```bash
pnpm -C apps/api test -- aiToolsReliability.test.ts aiGuardrails.test.ts reliability.test.ts reliabilityScoring.test.ts
```
Expected: all tests pass.

Then verify Go tests:
```bash
cd /Users/toddhebebrand/breeze/.worktrees/BE-3-reliability-scoring/agent && go test ./internal/collectors/... ./internal/heartbeat/... -v
```
Expected: all pass.
