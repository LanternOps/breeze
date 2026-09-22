# Metric Anomaly Episodes — W01 API Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collapse per-bucket `metric_anomalies` rows into `metric_anomaly_episodes` (one row per event), close them automatically when the device has observably recovered, snapshot the responsible processes, and stop long bursts from inflating their own baseline.

**Architecture:** A new tenant table (shape 1, RLS in the same migration) plus two new detector stages in `detectMetricAnomaliesRange`: `episodes` (assembly, runs after `incidents`) and `episode-resolve` (auto-close, runs even when `ml.anomalies.enabled` is off, never on a backfill). Assembly reads the org's unassigned rows, a pure TypeScript planner (`planEpisodeAssembly`) groups them into islands per `(device, episode_key)`, and a fixed sequence of set-based `sql\`\`` statements (one org per call) applies the plan inside the stage's own transaction and advisory lock. The two baseline detectors gain an anti-join against buckets of open episodes, with a fallback to the unfiltered baseline and a Prometheus counter.

**Tech Stack:** Hono/TypeScript API, PostgreSQL + Drizzle (query builder for typed reads, raw `sql` for set-based writes), Vitest (unit, `vitest.integration.config.ts`, `vitest.config.rls-coverage.ts`), prom-client, BullMQ.

**Spec:** `docs/superpowers/specs/monitoring/2026-09-21-metric-anomaly-episodes-design.md` (sections cited as §N). Index + cross-wave contract: `docs/superpowers/plans/monitoring/2026-09-21-metric-anomaly-episodes.md`.

## Spec deviations (the code wins; each is flagged for the reviewer)

| # | Spec says | Plan does | Evidence |
|---|---|---|---|
| 1 | §6: "Otherwise open a new episode … on conflict, re-run the attach." | Assembly also **closes** things. A new island that starts more than `EPISODE_GAP_MINUTES` after an open episode *supersedes* it (the open one is closed); an island older than `first_seen_at − gap` (backfill orphan) and every non-latest island in one batch are created **already closed**. Close reason for both: `cleared` when every member metric has ≥ `EPISODE_CLEAN_BUCKETS` clean rollup buckets between the episode's end and the next island's start, else `expired_no_data`. | The partial unique index `(device_id, episode_key) WHERE status='open'` (§4.1) allows one open episode per key, and assembly runs *before* resolve in every tick (§6/§7 order), so at the 30→35-minute boundary a new bucket arrives while the old episode is still open. Re-running attach can never succeed there. |
| 2 | §6: gap measured as `first_seen_at − gap ≤ window_start ≤ last_seen_at + gap`. | Gap is always **end-to-start**: a bucket joins when `next.window_start ≤ running max(window_end) + gap`. Upper bound is identical (`last_seen_at` is a `window_end`); the lower bound becomes `row.window_end + gap ≥ first_seen_at` (5 minutes more lenient than the spec's start-to-start). | One rule for both directions keeps the planner a single sort + sweep. |
| 3 | §6 snooze: the successor is created dismissed. | A **live snoozed successor** (`close_reason='snoozed' AND snoozed_until > now`) is also an attach target, so a burst that keeps going while snoozed builds one silent episode instead of one per tick. The user-dismissed episode itself (`close_reason='user'`) is never an attach target — §16's "new bucket 10 minutes later → successor" still holds. | Without it every 10-minute tick of a continuing burst creates a new dismissed episode. |
| 4 | §4.1 `bucket_count` = "members attached". | `bucket_count = count(DISTINCT window_start)` of members. | §16 wants the ram pair merged *and* `bucket_count = 17`; the pair writes two rows per bucket. |
| 5 | §4.1 widths: `metric_family varchar(40)`, `episode_key varchar(120)`, `peak_metric_name varchar(80)`. | `metric_family varchar(120)`, `episode_key varchar(200)`, `peak_metric_name varchar(120)`. | The unknown-name fallback sets `metric_family = metric_name`, and `metric_anomalies.metric_name` is `varchar(120)` (`apps/api/src/db/schema/analytics.ts:70`). |
| 6 | §10: exclude buckets of any open-episode member row. | Growth rows (`memory_growth`, `disk_growth`) are not used for exclusion. | A growth row's `window_start` is the start of a 6-bucket trend window, not an anomalous bucket (`apps/api/src/services/metricAnomalies.ts:527`, `:603`). |
| 7 | §16: "linked alert resolved" on auto-resolve. | W01 returns `linkedAlertId` in `EpisodeCloseResult` and calls the close handler; the default handler is a no-op. W02 wires `resolveAlert` (the index already assigns it to W02). | Index contract rows `EpisodeCloseHandler` / `setEpisodeCloseHandler` / `notifyEpisodesClosed`. |
| 8 | Contract: `assembleMetricAnomalyEpisodes(range) → Promise<void>`. | Returns `Promise<EpisodeCloseResult[]>` (the episodes it superseded), so a promoted episode that is superseded also reaches the close handler. Callers that ignore the value are unaffected. | Deviation 1. **Amend the index row.** |
| 9 | §7: "the scan job therefore calls the resolve stage outside the flag gate". | The flag gate needs no scan change: `scan-orgs` already enqueues every org that has a non-decommissioned, non-ephemeral device, whatever its flag (`apps/api/src/jobs/metricAnomalies.ts:122-128`); the flag is read inside `detectMetricAnomaliesRange` (`apps/api/src/services/metricAnomalies.ts:1195-1197`). The plan moves that early return so only detection + assembly are gated. **One scan change is needed:** `findAnomalyOrgRows` also selects orgs that have an `open` episode (Task 9 Step 6b), so an org whose devices were all decommissioned still gets `episode-resolve`. | Verified by reading both files. Without Step 6b such an org's open episodes would never close and would wait for retention. |
| 10 | §6/§7: new stages "sit last". | Order is `baseline, growth-trend, process-runaway, incidents, episodes, episode-resolve`, then the optional `v1-shadow` as today. | `v1-shadow` is a separate flag-gated step after the loop (`metricAnomalies.ts:1227-1237`) and is not part of dispatch. |
| 11 | §7 flag-off result shape not specified. | Flag off: `{ statements: 0, skipped: true, skippedReason: 'ml-disabled', stages: [<episode-resolve result>], episodesClosed }`. `statements`/`skipped` keep meaning "detection"; `MetricAnomalyResult` gains `episodesClosed: number`. | The CLI (`apps/api/scripts/metric-anomaly-backfill.ts`) keys its message on `skippedReason`. |
| 12 | §6 closed-at-assembly `resolved_at = now()`. | Kept for snoozed successors. Episodes created already closed (historical) get `resolved_at = start of the next island` (the moment the evidence closed them), so a months-old backfill does not show up under "Recently closed". | Deviation 1. |
| 13 | §10 counter `metric_anomaly_baseline_fallback_total` (no labels). | Adds a `detector` label (`baseline` \| `process-runaway`). | Two detectors share the fallback. |

## Global Constraints

- Tenancy shape **1** (direct `org_id`), RLS `ENABLE` + `FORCE` + the four `breeze_org_isolation_*` policies on `public.breeze_has_org_access(org_id)` **in the same migration** (CLAUDE.md "Tenant Isolation").
- Migration file placeholder `apps/api/migrations/2026-10-27-100000-metric-anomaly-episodes.sql`. **Re-check at execution time**: `git fetch origin main && git ls-tree --name-only origin/main apps/api/migrations/ | grep '\.sql$' | sort | tail -1` — the name must sort after that file (on 2026-09-22 it was `2026-10-26-170300-caller-verification-ticket-comment-rls.sql`). Rename if main has moved past it. Never use `2026-08-06-*`.
- Migration is idempotent, has no inner `BEGIN/COMMIT`, **writes no rows** (so no `set_config('breeze.scope','system')`, and `migrationRlsScope.test.ts`'s frozen baseline is not touched), and uses inline `CREATE INDEX` (no `CONCURRENTLY`).
- Every registration of §14 lands in this PR: `CORE_ORG_CASCADE_DELETE_ORDER`, `CORE_DEVICE_CASCADE_DELETE_TABLES`, `CORE_DEVICE_ORG_DENORMALIZED_TABLES`, `orgMergeRegistry.ts` (`repoint`), `CORE_TENANT_EXPORT_POLICY` (new table **and** the new columns on `metric_anomalies` / `metric_anomaly_incidents`), `mlOutputRetention.ts`.
- `attribution` is jsonb → `excludedOpen` in the export policy. State in the PR that it is visible in the UI but absent from the GDPR export.
- Constants (spec §5) live in `apps/api/src/services/metricAnomalyEpisodeKeys.ts` and are re-exported from `apps/api/src/services/metricAnomalyEpisodes.ts` (the contract path): `EPISODE_GAP_MINUTES=30`, `EPISODE_CLEAN_BUCKETS=6`, `EPISODE_EXPIRE_HOURS=24`, `EPISODE_RECURRENCE_DAYS=7`, `EPISODE_SNOOZE_DAYS=7`, `EPISODE_ASSEMBLY_LOOKBACK_HOURS=24`; env overrides `METRIC_ANOMALY_EPISODE_<NAME>` (positive integers only).
- Timestamps on `metric_anomalies` and `metric_anomaly_episodes` are naive `timestamp` in UTC. Raw SQL binds ISO strings as `${iso}::timestamp` (as the detectors already do). Raw-SQL reads never return timestamps to TypeScript (Drizzle's postgres-js driver returns them as zone-less strings); typed reads go through the Drizzle query builder.
- Every stage runs inside `runDetectionStage` (its own `withSystemDbAccessContext` transaction, `pg_try_advisory_xact_lock`, 30 s `lock_timeout`, 90 s `statement_timeout`). Nothing in the new code opens its own DB context.
- Grouping grains (put this in the schema header and the PR): `metric_anomalies` = one row per bucket per metric; `metric_anomaly_incidents` = the AI-dispatch outbox, one row per bucket per anomaly type (unchanged); `metric_anomaly_episodes` = the lifecycle a tech sees. Agent incident counts and episode counts differ by design.
- Typecheck with `cd apps/api && NODE_OPTIONS=--max-old-space-size=12288 npx tsc --noEmit -p .; echo "exit=$?"` — read the exit code, never pipe tsc into `tail`.
- Scope one test file with `cd apps/api && npx vitest run <path>`; never `pnpm --filter … test -- --run`.
- Work on `feature/<parent#>-metric-anomaly-episodes/wave-<sub-issue#>`; the PR body carries `Closes #<sub-issue#>`.

## File map

| File | Action | Responsibility |
|---|---|---|
| `packages/shared/src/types/metricAnomalyEpisodes.ts` | create | Status/close-reason/dimension unions + runtime `as const` arrays, `EpisodeAttribution` |
| `packages/shared/src/types/metricAnomalyEpisodes.test.ts` | create | Pins the unions |
| `packages/shared/src/types/index.ts` | modify | `export * from './metricAnomalyEpisodes'` |
| `apps/api/src/routes/devices/anomalies.ts` (+ `.test.ts`) | modify | Legacy list route accepts `status=cleared` |
| `apps/api/migrations/2026-10-27-100000-metric-anomaly-episodes.sql` | create | Table, RLS, indexes, new columns, status CHECK |
| `apps/api/src/db/schema/metricAnomalyEpisodes.ts` | create | Drizzle table `metricAnomalyEpisodes` |
| `apps/api/src/db/schema/analytics.ts` | modify | `metricAnomalies.episodeId` + two partial indexes + episode index |
| `apps/api/src/db/schema/metricAnomalyIncidents.ts` | modify | `episodeId`, `suppressedByEpisode`, index |
| `apps/api/src/db/schema/index.ts` | modify | export the new schema file |
| `apps/api/src/db/migration-metric-anomaly-episodes.test.ts` | create | Static migration + Drizzle mirror check |
| `apps/api/src/routes/devices/core.ts` | modify | both device lists |
| `apps/api/src/services/tenantCascade.ts` | modify | `CORE_ORG_CASCADE_DELETE_ORDER` |
| `apps/api/src/services/orgMergeRegistry.ts` | modify | `REPOINT_TABLES` |
| `apps/api/src/services/tenantExportPolicyRegistry.ts` | modify | new table + amended entries |
| `apps/api/src/services/tenantExportPolicyRegistry.metricAnomalyEpisodes.test.ts` | create | Unit pin of the export policy |
| `apps/api/src/jobs/mlOutputRetention.ts` (+ `.test.ts`) | modify | prune episodes by `last_seen_at` |
| `apps/api/src/services/metricAnomalyEpisodeKeys.ts` (+ `.test.ts`) | create | Constants, family map, `episodeKeyFor` |
| `apps/api/src/services/metricAnomalyEpisodeMetrics.ts` (+ `.test.ts`) | create | Leaf prom-client counters |
| `apps/api/src/services/metricAnomalyEpisodePlanner.ts` (+ `.test.ts`) | create | Pure island planner |
| `apps/api/src/services/metricAnomalyEpisodes.ts` (+ `.test.ts`) | create | Assembly + resolve SQL, attribution, close handler |
| `apps/api/src/services/metricAnomalies.ts` (+ `.test.ts`) | modify | Stages, trigger, flag gate, anti-contamination, fallback |
| `apps/api/src/jobs/metricAnomalies.ts` (+ `.test.ts`) | modify | `trigger` in job data; `scan-orgs` also selects orgs with an open episode |
| `apps/api/scripts/metric-anomaly-backfill.ts` | modify | passes `trigger: 'backfill'` |
| `apps/api/src/__tests__/integration/metricAnomalyEpisodes.integration.test.ts` | create | §16 W01 integration proofs |
| `apps/api/src/__tests__/integration/metricAnomalies.integration.test.ts` | modify | Stage lists grow from 4 to 6 |

---

### Task 1: Shared types and `cleared` on the legacy route

**Files:**
- Create: `packages/shared/src/types/metricAnomalyEpisodes.ts`
- Create: `packages/shared/src/types/metricAnomalyEpisodes.test.ts`
- Modify: `packages/shared/src/types/index.ts` (append at end)
- Modify: `apps/api/src/routes/devices/anomalies.ts:18-21`
- Test: `apps/api/src/routes/devices/anomalies.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces (from `@breeze/shared`): `METRIC_ANOMALY_STATUSES`, `MetricAnomalyStatus`, `METRIC_ANOMALY_EPISODE_STATUSES`, `MetricAnomalyEpisodeStatus`, `EPISODE_CLOSE_REASONS`, `EpisodeCloseReason`, `ATTRIBUTION_DIMENSIONS`, `AttributionDimension`, `AttributionProcess`, `AttributionSnapshot`, `EpisodeAttribution`.

- [ ] **Step 1: Write the failing shared test**

`packages/shared/src/types/metricAnomalyEpisodes.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import * as shared from './index';
import {
  ATTRIBUTION_DIMENSIONS,
  EPISODE_CLOSE_REASONS,
  METRIC_ANOMALY_EPISODE_STATUSES,
  METRIC_ANOMALY_STATUSES,
  type EpisodeAttribution,
} from './metricAnomalyEpisodes';

describe('metric anomaly episode shared types (spec §4.1, §9)', () => {
  it('adds cleared to the per-bucket status domain', () => {
    expect(METRIC_ANOMALY_STATUSES).toEqual(['open', 'dismissed', 'promoted', 'resolved', 'cleared']);
  });

  it('keeps episode status and close reason separate (D6)', () => {
    expect(METRIC_ANOMALY_EPISODE_STATUSES).toEqual(['open', 'resolved', 'dismissed']);
    expect(EPISODE_CLOSE_REASONS).toEqual(['cleared', 'expired_offline', 'expired_no_data', 'user', 'snoozed']);
  });

  it('names the agent TopProcess keys as attribution dimensions', () => {
    expect(ATTRIBUTION_DIMENSIONS).toEqual(['cpu', 'ramMb', 'diskBps', 'netBps']);
  });

  it('is exported from the types index', () => {
    expect(shared.METRIC_ANOMALY_STATUSES).toBe(METRIC_ANOMALY_STATUSES);
    const sample: EpisodeAttribution = {
      peak: { sampledAt: '2026-09-21T22:35:00.000Z', dimension: 'ramMb', processes: [{ name: 'chrome.exe', pid: 4120, value: 1932.5 }] },
    };
    expect(sample.opened).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd packages/shared && npx vitest run src/types/metricAnomalyEpisodes.test.ts`
Expected: FAIL — `Failed to resolve import "./metricAnomalyEpisodes"`.

- [ ] **Step 3: Create the types file**

`packages/shared/src/types/metricAnomalyEpisodes.ts`:

```ts
/**
 * Metric anomaly episodes (spec docs/superpowers/specs/monitoring/
 * 2026-09-21-metric-anomaly-episodes-design.md).
 *
 * Three grouping grains exist and are NOT interchangeable:
 *  - metric_anomalies           one row per 5-minute bucket per metric (evidence)
 *  - metric_anomaly_incidents   AI-dispatch outbox, one row per bucket per anomaly type
 *  - metric_anomaly_episodes    the lifecycle a technician sees (one card per event)
 */

/** Per-bucket row status. `cleared` = closed by episode auto-resolve, never a human label. */
export const METRIC_ANOMALY_STATUSES = ['open', 'dismissed', 'promoted', 'resolved', 'cleared'] as const;
export type MetricAnomalyStatus = (typeof METRIC_ANOMALY_STATUSES)[number];

/** Promotion is a link (`linkedAlertId`), not a status (D6). */
export const METRIC_ANOMALY_EPISODE_STATUSES = ['open', 'resolved', 'dismissed'] as const;
export type MetricAnomalyEpisodeStatus = (typeof METRIC_ANOMALY_EPISODE_STATUSES)[number];

export const EPISODE_CLOSE_REASONS = ['cleared', 'expired_offline', 'expired_no_data', 'user', 'snoozed'] as const;
export type EpisodeCloseReason = (typeof EPISODE_CLOSE_REASONS)[number];

/** Keys of the agent's TopProcess JSON (`apps/api/src/db/schema/devices.ts` TopProcess). */
export const ATTRIBUTION_DIMENSIONS = ['cpu', 'ramMb', 'diskBps', 'netBps'] as const;
export type AttributionDimension = (typeof ATTRIBUTION_DIMENSIONS)[number];

export interface AttributionProcess {
  name: string;
  pid: number;
  value: number;
}

export interface AttributionSnapshot {
  /** ISO-8601 UTC time of the device_process_samples row used. */
  sampledAt: string;
  dimension: AttributionDimension;
  /** Top 3 by `dimension`; empty when the agent omitted the dimension (diskBps/netBps are omitempty). */
  processes: AttributionProcess[];
}

/** `opened` is written once; `peak` is overwritten whenever the peak grows (§9). */
export interface EpisodeAttribution {
  opened?: AttributionSnapshot;
  peak?: AttributionSnapshot;
}
```

Append to `packages/shared/src/types/index.ts`:

```ts

// Metric anomaly episodes (spec 2026-09-21)
export * from './metricAnomalyEpisodes';
```

- [ ] **Step 4: Run the shared test to verify it passes**

Run: `cd packages/shared && npx vitest run src/types/metricAnomalyEpisodes.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Write the failing route test**

Add inside `describe('device anomaly routes', …)` in `apps/api/src/routes/devices/anomalies.test.ts`:

```ts
  it('accepts status=cleared on the legacy list route (rows closed by episode auto-resolve)', async () => {
    const limit = vi.fn().mockResolvedValue([{ ...anomaly, status: 'cleared' }]);
    const orderBy = vi.fn().mockReturnValue({ limit });
    const where = vi.fn().mockReturnValue({ orderBy });
    selectMock.mockReturnValue({ from: vi.fn().mockReturnValue({ where }) });

    const res = await app.request(`/devices/${device.id}/anomalies?status=cleared`);

    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ status: string }> };
    expect(body.data[0]?.status).toBe('cleared');
    expect(where).toHaveBeenCalledWith({
      type: 'and',
      conditions: expect.arrayContaining([
        { type: 'eq', left: 'metricAnomalies.status', right: 'cleared' },
      ]),
    });
  });
```

- [ ] **Step 6: Run it to verify it fails**

Run: `cd apps/api && npx vitest run src/routes/devices/anomalies.test.ts`
Expected: FAIL — the new test gets `400` (zod enum rejects `cleared`).

- [ ] **Step 7: Accept `cleared` in the query schema**

In `apps/api/src/routes/devices/anomalies.ts` add the import and replace the query schema:

```ts
import { METRIC_ANOMALY_STATUSES } from '@breeze/shared';
```

```ts
const anomaliesQuerySchema = z.object({
  // `cleared` = closed by episode auto-resolve (metric anomaly episodes W01).
  // PATCH below deliberately still refuses it: a human never sets `cleared`.
  status: z.enum([...METRIC_ANOMALY_STATUSES, 'all']).optional().default('open'),
  limit: z.coerce.number().int().min(1).max(100).optional().default(25),
});
```

`serializeAnomaly` already returns `row.status` as a string, so no serializer change is needed. Leave `anomalyStatusSchema` (PATCH) unchanged.

- [ ] **Step 8: Run the route tests to verify they pass**

Run: `cd apps/api && npx vitest run src/routes/devices/anomalies.test.ts`
Expected: PASS (all tests, including the pre-existing ones).

- [ ] **Step 9: Commit**

```bash
git add packages/shared/src/types/metricAnomalyEpisodes.ts packages/shared/src/types/metricAnomalyEpisodes.test.ts packages/shared/src/types/index.ts apps/api/src/routes/devices/anomalies.ts apps/api/src/routes/devices/anomalies.test.ts
git commit -m "feat(anomalies): shared episode types and cleared status on legacy route" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Migration and Drizzle schema

**Files:**
- Create: `apps/api/migrations/2026-10-27-100000-metric-anomaly-episodes.sql` (re-check the name, Global Constraints)
- Create: `apps/api/src/db/schema/metricAnomalyEpisodes.ts`
- Modify: `apps/api/src/db/schema/analytics.ts:1-18` (imports), `:65-104` (`metricAnomalies`)
- Modify: `apps/api/src/db/schema/metricAnomalyIncidents.ts`
- Modify: `apps/api/src/db/schema/index.ts:165` (after `export * from './metricAnomalyIncidents';`)
- Test: `apps/api/src/db/migration-metric-anomaly-episodes.test.ts`

**Interfaces:**
- Consumes: `EpisodeAttribution` from `@breeze/shared` (Task 1).
- Produces: Drizzle `metricAnomalyEpisodes` (+ `MetricAnomalyEpisodeRow`), `metricAnomalies.episodeId`, `metricAnomalyIncidents.episodeId`, `metricAnomalyIncidents.suppressedByEpisode`. SQL objects: `metric_anomaly_episodes`, `metric_anomaly_episodes_open_key_uq` (partial unique `(device_id, episode_key) WHERE status = 'open'`), `metric_anomalies.episode_id`, `metric_anomalies_status_check` including `cleared`.

- [ ] **Step 1: Write the failing static test**

`apps/api/src/db/migration-metric-anomaly-episodes.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { metricAnomalies } from './schema/analytics';
import { metricAnomalyEpisodes } from './schema/metricAnomalyEpisodes';
import { metricAnomalyIncidents } from './schema/metricAnomalyIncidents';

/**
 * Metric anomaly episodes W01 — static check of the migration and its Drizzle
 * mirror. Runtime proof (RLS, cascade, export contracts) is the integration
 * suites run in the final task; this file only moves the cheap failures into
 * Test API.
 */
const MIGRATION_PATH = join(__dirname, '..', '..', 'migrations', '2026-10-27-100000-metric-anomaly-episodes.sql');
const migrationSql = readFileSync(MIGRATION_PATH, 'utf8');

const EPISODE_COLUMNS = [
  'id', 'org_id', 'device_id', 'episode_key', 'source_table', 'anomaly_type', 'metric_family',
  'metric_names', 'status', 'close_reason', 'first_seen_at', 'last_seen_at', 'bucket_count',
  'peak_value', 'peak_metric_name', 'peak_baseline_value', 'peak_score', 'peak_at',
  'recurrence_count', 'attribution', 'linked_alert_id', 'snoozed_until', 'resolved_at',
  'resolved_by_user_id', 'note', 'created_at', 'updated_at',
];

describe('metric anomaly episodes migration', () => {
  it('creates the table with RLS enabled, forced, and all four org-isolation policies', () => {
    expect(migrationSql).toContain('CREATE TABLE IF NOT EXISTS metric_anomaly_episodes');
    expect(migrationSql).toContain('ALTER TABLE metric_anomaly_episodes ENABLE ROW LEVEL SECURITY;');
    expect(migrationSql).toContain('ALTER TABLE metric_anomaly_episodes FORCE ROW LEVEL SECURITY;');
    for (const cmd of ['select', 'insert', 'update', 'delete']) {
      expect(migrationSql).toContain(`CREATE POLICY breeze_org_isolation_${cmd} ON metric_anomaly_episodes`);
      expect(migrationSql).toContain(`DROP POLICY IF EXISTS breeze_org_isolation_${cmd} ON metric_anomaly_episodes;`);
    }
    expect(migrationSql).toContain('public.breeze_has_org_access(org_id)');
  });

  it('makes attach-or-create race-proof with a partial unique index on the open key', () => {
    expect(migrationSql).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS metric_anomaly_episodes_open_key_uq\s+ON metric_anomaly_episodes \(device_id, episode_key\)\s+WHERE status = 'open';/,
    );
  });

  it('re-creates the metric_anomalies status check with cleared', () => {
    expect(migrationSql).toContain('ALTER TABLE metric_anomalies DROP CONSTRAINT IF EXISTS metric_anomalies_status_check;');
    expect(migrationSql).toContain("CHECK (status IN ('open', 'dismissed', 'promoted', 'resolved', 'cleared'))");
  });

  it('adds the new columns idempotently', () => {
    expect(migrationSql).toContain('ALTER TABLE metric_anomalies ADD COLUMN IF NOT EXISTS episode_id UUID REFERENCES metric_anomaly_episodes(id) ON DELETE SET NULL;');
    expect(migrationSql).toContain('ALTER TABLE metric_anomaly_incidents ADD COLUMN IF NOT EXISTS episode_id UUID;');
    expect(migrationSql).toContain('ALTER TABLE metric_anomaly_incidents ADD COLUMN IF NOT EXISTS suppressed_by_episode BOOLEAN NOT NULL DEFAULT false;');
  });

  it('writes no rows, so it needs no breeze.scope elevation', () => {
    expect(migrationSql).not.toMatch(/^\s*(INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|MERGE\s+INTO)\b/im);
    expect(migrationSql).not.toMatch(/^\s*(BEGIN|COMMIT);/im);
    expect(migrationSql).not.toContain('CONCURRENTLY');
  });

  it('is mirrored by Drizzle', () => {
    const episodes = getTableConfig(metricAnomalyEpisodes);
    expect(episodes.name).toBe('metric_anomaly_episodes');
    expect(episodes.columns.map((column) => column.name).sort()).toEqual([...EPISODE_COLUMNS].sort());
    expect(episodes.indexes.map((index) => index.config.name).sort()).toEqual([
      'metric_anomaly_episodes_device_key_resolved_idx',
      'metric_anomaly_episodes_device_status_last_seen_idx',
      'metric_anomaly_episodes_linked_alert_idx',
      'metric_anomaly_episodes_open_key_uq',
      'metric_anomaly_episodes_org_status_last_seen_idx',
    ]);
    const anomalies = getTableConfig(metricAnomalies);
    expect(anomalies.columns.map((column) => column.name)).toContain('episode_id');
    expect(anomalies.indexes.map((index) => index.config.name)).toEqual(expect.arrayContaining([
      'metric_anomalies_episode_id_idx',
      'metric_anomalies_unassigned_open_idx',
      'metric_anomalies_device_metric_window_idx',
    ]));
    const incidents = getTableConfig(metricAnomalyIncidents);
    expect(incidents.columns.map((column) => column.name)).toEqual(expect.arrayContaining(['episode_id', 'suppressed_by_episode']));
    // No FK on incidents.episode_id — same cycle-avoidance as agent_run_id (§4.1).
    expect(incidents.foreignKeys.map((fk) => fk.reference().columns.map((c) => c.name)).flat()).not.toContain('episode_id');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/api && npx vitest run src/db/migration-metric-anomaly-episodes.test.ts`
Expected: FAIL — `ENOENT … 2026-10-27-100000-metric-anomaly-episodes.sql` / cannot resolve `./schema/metricAnomalyEpisodes`.

- [ ] **Step 3: Write the migration**

`apps/api/migrations/2026-10-27-100000-metric-anomaly-episodes.sql`:

```sql
-- Metric anomaly episodes (W01) — spec
-- docs/superpowers/specs/monitoring/2026-09-21-metric-anomaly-episodes-design.md §4, §14.
--
-- One row per contiguous run of anomalous 5-minute buckets for a
-- (device, episode_key). metric_anomalies rows stay the per-bucket evidence and
-- gain episode_id. metric_anomaly_incidents keeps its per-bucket dispatch-outbox
-- grain and gains episode_id (no FK, same cycle-avoidance as agent_run_id) plus
-- suppressed_by_episode, both used by W02.
--
-- Tenancy shape 1 (direct org_id): RLS enabled + forced + four org-isolation
-- policies in THIS file. The file writes no rows, so it needs no breeze.scope
-- elevation. Idempotent throughout; autoMigrate wraps it in a transaction.
-- Inline CREATE INDEX, no CONCURRENTLY: metric_anomalies holds tens of
-- thousands of rows per busy partner, not millions (spec §14 item 6).

CREATE TABLE IF NOT EXISTS metric_anomaly_episodes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id),
  device_id UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  episode_key VARCHAR(200) NOT NULL,
  source_table VARCHAR(40) NOT NULL,
  anomaly_type VARCHAR(40) NOT NULL,
  metric_family VARCHAR(120) NOT NULL,
  metric_names TEXT[] NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'open',
  close_reason VARCHAR(30),
  first_seen_at TIMESTAMP NOT NULL,
  last_seen_at TIMESTAMP NOT NULL,
  bucket_count INTEGER NOT NULL,
  peak_value DOUBLE PRECISION NOT NULL,
  peak_metric_name VARCHAR(120) NOT NULL,
  peak_baseline_value DOUBLE PRECISION,
  peak_score DOUBLE PRECISION NOT NULL,
  peak_at TIMESTAMP NOT NULL,
  recurrence_count INTEGER NOT NULL DEFAULT 0,
  attribution JSONB,
  linked_alert_id UUID REFERENCES alerts(id) ON DELETE SET NULL,
  snoozed_until TIMESTAMP,
  resolved_at TIMESTAMP,
  resolved_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  note VARCHAR(500),
  created_at TIMESTAMP NOT NULL DEFAULT now(),
  updated_at TIMESTAMP NOT NULL DEFAULT now(),
  CONSTRAINT metric_anomaly_episodes_status_check CHECK (status IN ('open', 'resolved', 'dismissed')),
  CONSTRAINT metric_anomaly_episodes_close_reason_check CHECK (
    close_reason IS NULL OR close_reason IN ('cleared', 'expired_offline', 'expired_no_data', 'user', 'snoozed')
  ),
  CONSTRAINT metric_anomaly_episodes_open_close_reason_check CHECK ((status = 'open') = (close_reason IS NULL)),
  CONSTRAINT metric_anomaly_episodes_window_check CHECK (first_seen_at < last_seen_at),
  CONSTRAINT metric_anomaly_episodes_bucket_count_check CHECK (bucket_count >= 1),
  CONSTRAINT metric_anomaly_episodes_recurrence_check CHECK (recurrence_count >= 0),
  CONSTRAINT metric_anomaly_episodes_source_table_check CHECK (
    source_table IN ('device_metrics', 'snmp_metrics', 'device_process_samples')
  ),
  CONSTRAINT metric_anomaly_episodes_type_check CHECK (
    anomaly_type IN ('spike', 'drop', 'trend', 'process_runaway', 'network_egress', 'memory_growth', 'disk_growth')
  ),
  CONSTRAINT metric_anomaly_episodes_attribution_object_check CHECK (
    attribution IS NULL OR jsonb_typeof(attribution) = 'object'
  ),
  CONSTRAINT metric_anomaly_episodes_attribution_size_check CHECK (
    attribution IS NULL OR octet_length(attribution::text) <= 8192
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS metric_anomaly_episodes_open_key_uq
  ON metric_anomaly_episodes (device_id, episode_key)
  WHERE status = 'open';

CREATE INDEX IF NOT EXISTS metric_anomaly_episodes_org_status_last_seen_idx
  ON metric_anomaly_episodes (org_id, status, last_seen_at);

CREATE INDEX IF NOT EXISTS metric_anomaly_episodes_device_key_resolved_idx
  ON metric_anomaly_episodes (device_id, episode_key, resolved_at DESC);

CREATE INDEX IF NOT EXISTS metric_anomaly_episodes_device_status_last_seen_idx
  ON metric_anomaly_episodes (device_id, status, last_seen_at DESC);

CREATE INDEX IF NOT EXISTS metric_anomaly_episodes_linked_alert_idx
  ON metric_anomaly_episodes (linked_alert_id);

ALTER TABLE metric_anomaly_episodes ENABLE ROW LEVEL SECURITY;
ALTER TABLE metric_anomaly_episodes FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS breeze_org_isolation_select ON metric_anomaly_episodes;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON metric_anomaly_episodes;
DROP POLICY IF EXISTS breeze_org_isolation_update ON metric_anomaly_episodes;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON metric_anomaly_episodes;

CREATE POLICY breeze_org_isolation_select ON metric_anomaly_episodes
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON metric_anomaly_episodes
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON metric_anomaly_episodes
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON metric_anomaly_episodes
  FOR DELETE USING (public.breeze_has_org_access(org_id));

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE metric_anomaly_episodes TO breeze_app;

-- metric_anomalies: episode link, `cleared` status, assembly + anti-contamination indexes.
ALTER TABLE metric_anomalies ADD COLUMN IF NOT EXISTS episode_id UUID REFERENCES metric_anomaly_episodes(id) ON DELETE SET NULL;

ALTER TABLE metric_anomalies DROP CONSTRAINT IF EXISTS metric_anomalies_status_check;
ALTER TABLE metric_anomalies ADD CONSTRAINT metric_anomalies_status_check
  CHECK (status IN ('open', 'dismissed', 'promoted', 'resolved', 'cleared'));

CREATE INDEX IF NOT EXISTS metric_anomalies_episode_id_idx
  ON metric_anomalies (episode_id);

CREATE INDEX IF NOT EXISTS metric_anomalies_unassigned_open_idx
  ON metric_anomalies (org_id, device_id, window_start)
  WHERE episode_id IS NULL AND status = 'open';

CREATE INDEX IF NOT EXISTS metric_anomalies_device_metric_window_idx
  ON metric_anomalies (device_id, metric_name, window_start)
  WHERE episode_id IS NOT NULL;

-- metric_anomaly_incidents: W02 dispatch-per-episode columns. No FK on
-- episode_id (see metricAnomalyIncidents.ts header: FK cycles break
-- topologicalCascadeOrder()).
ALTER TABLE metric_anomaly_incidents ADD COLUMN IF NOT EXISTS episode_id UUID;
ALTER TABLE metric_anomaly_incidents ADD COLUMN IF NOT EXISTS suppressed_by_episode BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS metric_anomaly_incidents_episode_id_idx
  ON metric_anomaly_incidents (episode_id);
```

- [ ] **Step 4: Write the Drizzle table**

`apps/api/src/db/schema/metricAnomalyEpisodes.ts`:

```ts
import { sql } from 'drizzle-orm';
import {
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import type { EpisodeAttribution } from '@breeze/shared';
import { alerts } from './alerts';
import { devices } from './devices';
import { organizations } from './orgs';
import { users } from './users';

/**
 * Metric anomaly episodes (spec 2026-09-21-metric-anomaly-episodes-design.md).
 *
 * One row per contiguous run of anomalous 5-minute buckets for a
 * (device, episode_key), where episode_key = `source_table:anomaly_type:metric_family`
 * (services/metricAnomalyEpisodeKeys.ts). Assembled and auto-closed by the
 * `episodes` / `episode-resolve` stages in services/metricAnomalies.ts.
 *
 * THREE GROUPING GRAINS — do not conflate them:
 *  - metric_anomalies: one row per bucket per metric; the evidence. Members of
 *    an episode point here via metric_anomalies.episode_id.
 *  - metric_anomaly_incidents: the AI pilot's dispatch OUTBOX, one row per
 *    bucket per anomaly type (metric_name folded). Its grain is unchanged; W02
 *    adds episode_id so the publisher dispatches once per episode.
 *  - metric_anomaly_episodes (this table): the lifecycle a technician sees.
 * The agent's incident count and the tech's episode count differ BY DESIGN.
 *
 * Status is open | resolved | dismissed; `close_reason` says why it closed.
 * Promotion is a link (`linked_alert_id`), not a status. At most one OPEN
 * episode per (device_id, episode_key) — the partial unique index is what makes
 * attach-or-create race-proof between the cron and a backfill.
 *
 * `attribution` is jsonb → excludedOpen in the tenant export policy: visible in
 * the UI, absent from the GDPR export.
 */
export const metricAnomalyEpisodes = pgTable('metric_anomaly_episodes', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  deviceId: uuid('device_id').notNull().references(() => devices.id, { onDelete: 'cascade' }),
  episodeKey: varchar('episode_key', { length: 200 }).notNull(),
  sourceTable: varchar('source_table', { length: 40 }).notNull(),
  anomalyType: varchar('anomaly_type', { length: 40 }).notNull(),
  metricFamily: varchar('metric_family', { length: 120 }).notNull(),
  metricNames: text('metric_names').array().notNull(),
  status: varchar('status', { length: 20 }).notNull().default('open'),
  closeReason: varchar('close_reason', { length: 30 }),
  firstSeenAt: timestamp('first_seen_at').notNull(),
  lastSeenAt: timestamp('last_seen_at').notNull(),
  bucketCount: integer('bucket_count').notNull(),
  peakValue: doublePrecision('peak_value').notNull(),
  peakMetricName: varchar('peak_metric_name', { length: 120 }).notNull(),
  peakBaselineValue: doublePrecision('peak_baseline_value'),
  peakScore: doublePrecision('peak_score').notNull(),
  peakAt: timestamp('peak_at').notNull(),
  recurrenceCount: integer('recurrence_count').notNull().default(0),
  attribution: jsonb('attribution').$type<EpisodeAttribution>(),
  linkedAlertId: uuid('linked_alert_id').references(() => alerts.id, { onDelete: 'set null' }),
  snoozedUntil: timestamp('snoozed_until'),
  resolvedAt: timestamp('resolved_at'),
  resolvedByUserId: uuid('resolved_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  note: varchar('note', { length: 500 }),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => ({
  openKeyUniq: uniqueIndex('metric_anomaly_episodes_open_key_uq')
    .on(table.deviceId, table.episodeKey)
    .where(sql`${table.status} = 'open'`),
  orgStatusLastSeenIdx: index('metric_anomaly_episodes_org_status_last_seen_idx')
    .on(table.orgId, table.status, table.lastSeenAt),
  deviceKeyResolvedIdx: index('metric_anomaly_episodes_device_key_resolved_idx')
    .on(table.deviceId, table.episodeKey, table.resolvedAt.desc()),
  deviceStatusLastSeenIdx: index('metric_anomaly_episodes_device_status_last_seen_idx')
    .on(table.deviceId, table.status, table.lastSeenAt.desc()),
  linkedAlertIdx: index('metric_anomaly_episodes_linked_alert_idx').on(table.linkedAlertId),
}));

export type MetricAnomalyEpisodeRow = typeof metricAnomalyEpisodes.$inferSelect;
```

- [ ] **Step 5: Extend `metricAnomalies` and `metricAnomalyIncidents`**

In `apps/api/src/db/schema/analytics.ts` add two imports at the top:

```ts
import { sql } from 'drizzle-orm';
import { metricAnomalyEpisodes } from './metricAnomalyEpisodes';
```

In `metricAnomalies`, add the column after `linkedCorrelationGroupId`:

```ts
  /** Episode this bucket belongs to (metric anomaly episodes W01). NULL until the `episodes` stage assembles it. */
  episodeId: uuid('episode_id').references(() => metricAnomalyEpisodes.id, { onDelete: 'set null' }),
```

and add three entries at the end of its index block (after `linkedCorrelationIdx`):

```ts
  linkedCorrelationIdx: index('metric_anomalies_linked_correlation_idx').on(table.linkedCorrelationGroupId),
  episodeIdx: index('metric_anomalies_episode_id_idx').on(table.episodeId),
  // Assembly scan: unassigned open rows of one org (services/metricAnomalyEpisodes.ts).
  unassignedOpenIdx: index('metric_anomalies_unassigned_open_idx')
    .on(table.orgId, table.deviceId, table.windowStart)
    .where(sql`${table.episodeId} IS NULL AND ${table.status} = 'open'`),
  // Baseline anti-contamination anti-join (spec §10).
  deviceMetricWindowIdx: index('metric_anomalies_device_metric_window_idx')
    .on(table.deviceId, table.metricName, table.windowStart)
    .where(sql`${table.episodeId} IS NOT NULL`),
```

In `apps/api/src/db/schema/metricAnomalyIncidents.ts` add `boolean` to the `drizzle-orm/pg-core` import list, add these columns after `agentRunId`:

```ts
  /** Episode of the highest-scoring member (set by W02). NO FK, same cycle
   *  reason as agentRunId — see file header. */
  episodeId: uuid('episode_id'),
  /** W02: true when another incident of the same episode already dispatched. */
  suppressedByEpisode: boolean('suppressed_by_episode').notNull().default(false),
```

and this index after `dispatchedAtIdx`:

```ts
  episodeIdx: index('metric_anomaly_incidents_episode_id_idx').on(table.episodeId),
```

In `apps/api/src/db/schema/index.ts`, directly after `export * from './metricAnomalyIncidents';`:

```ts
export * from './metricAnomalyEpisodes';
```

- [ ] **Step 6: Run the static test to verify it passes**

Run: `cd apps/api && npx vitest run src/db/migration-metric-anomaly-episodes.test.ts src/db/autoMigrate.test.ts src/db/migrationRlsScope.test.ts`
Expected: PASS. `autoMigrate.test.ts` validates the filename; `migrationRlsScope.test.ts` passes without a baseline edit (no writes).

- [ ] **Step 7: Run the migration naming guard**

Run: `bash scripts/check-migration-naming.sh --against-ref origin/main; echo "exit=$?"`
Expected: `exit=0`. If it fails, rename the file to sort after the newest `origin/main` migration and update `MIGRATION_PATH` in the test.

- [ ] **Step 8: Commit**

```bash
git add apps/api/migrations/2026-10-27-100000-metric-anomaly-episodes.sql apps/api/src/db/schema/metricAnomalyEpisodes.ts apps/api/src/db/schema/analytics.ts apps/api/src/db/schema/metricAnomalyIncidents.ts apps/api/src/db/schema/index.ts apps/api/src/db/migration-metric-anomaly-episodes.test.ts
git commit -m "feat(anomalies): metric_anomaly_episodes table, RLS, and episode columns" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Cascade, merge, and export registrations

Registration is a mechanical grep, not a judgement call (CLAUDE.md: contract tests caught the miss 5/5, review 0/5). The Drizzle table from Task 2 already turns two Test API contracts red; this task turns them green and adds the three registries that only Integration Tests or the full unit suite would catch.

**Files:**
- Modify: `apps/api/src/routes/devices/core.ts:313` and `:602`
- Modify: `apps/api/src/services/tenantCascade.ts:578-580`
- Modify: `apps/api/src/services/orgMergeRegistry.ts:844-846`
- Modify: `apps/api/src/services/tenantExportPolicyRegistry.ts:406-412`
- Create: `apps/api/src/services/tenantExportPolicyRegistry.metricAnomalyEpisodes.test.ts`

**Interfaces:**
- Consumes: `metricAnomalyEpisodes` Drizzle table (Task 2).
- Produces: `metric_anomaly_episodes` present in `getDeviceCascadeDeleteTables()`, `getDeviceOrgDenormalizedTables()`, `getOrgCascadeDeleteOrder()`, `getOrgMergePolicies()` (`{ kind: 'repoint' }`), `getTenantExportPolicyRegistry()`.

- [ ] **Step 1: Confirm the device-list contracts are red**

Run: `cd apps/api && npx vitest run src/routes/devices/cascadeDelete.test.ts src/routes/devices/moveOrg.coverage.test.ts`
Expected: FAIL — `metric_anomaly_episodes` reported missing from the cascade set (`every table with a device_id FK to devices.id is in exactly one of cascade/detach/linked sets`) and from the org-denormalized set.

- [ ] **Step 2: Register in both device lists**

`apps/api/src/routes/devices/core.ts` has the identical line at `:313` (in `CORE_DEVICE_ORG_DENORMALIZED_TABLES`) and `:602` (in `CORE_DEVICE_CASCADE_DELETE_TABLES`). Replace **both** occurrences of

```ts
  'metric_anomaly_candidates', 'metric_anomalies', 'metric_anomaly_incidents', 'metric_rollups',
```

with

```ts
  // metric_anomaly_episodes: device_id + denormalized org_id (episodes W01). Its
  // only inbound FK is metric_anomalies.episode_id ON DELETE SET NULL, so the
  // position relative to metric_anomalies is not load-bearing.
  'metric_anomaly_candidates', 'metric_anomalies', 'metric_anomaly_episodes', 'metric_anomaly_incidents', 'metric_rollups',
```

(`Edit` with `replace_all: true`.) The Postgres-side restamp trigger `breeze_cascade_device_org_id()` discovers device-child `org_id` tables itself; no migration change is needed for the direct `devices.org_id` UPDATE path.

- [ ] **Step 3: Run the device-list contracts to verify they pass**

Run: `cd apps/api && npx vitest run src/routes/devices/cascadeDelete.test.ts src/routes/devices/moveOrg.coverage.test.ts`
Expected: PASS.

- [ ] **Step 4: Write the failing export-policy unit test**

`apps/api/src/services/tenantExportPolicyRegistry.metricAnomalyEpisodes.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { getTableColumns } from 'drizzle-orm';
import { metricAnomalyEpisodes } from '../db/schema/metricAnomalyEpisodes';
import { getTenantExportPolicyRegistry } from './tenantExportPolicyRegistry';

/**
 * Metric anomaly episodes W01 (spec §14). The export-policy row is the one that
 * fires on a new COLUMN, not just a new table, and both export suites need a
 * live DB — pinning it here moves a missed classification into Test API.
 */
describe('metric anomaly episodes export policy', () => {
  const registry = getTenantExportPolicyRegistry();

  it('classifies every metric_anomaly_episodes column; attribution (jsonb) is excludedOpen', () => {
    const policy = registry['metric_anomaly_episodes'];
    expect(policy).toBeDefined();
    const columnNames = Object.values(getTableColumns(metricAnomalyEpisodes)).map((column) => column.name);
    for (const name of columnNames) {
      const expected = name === 'attribution' ? 'exclude' : 'include';
      expect(policy?.columns[name]?.decision, name).toBe(expected);
    }
  });

  it('amends the existing entries for the new columns on metric_anomalies and metric_anomaly_incidents', () => {
    expect(registry['metric_anomalies']?.columns['episode_id']?.decision).toBe('include');
    expect(registry['metric_anomaly_incidents']?.columns['episode_id']?.decision).toBe('include');
    expect(registry['metric_anomaly_incidents']?.columns['suppressed_by_episode']?.decision).toBe('include');
  });
});
```

- [ ] **Step 5: Run it to verify it fails**

Run: `cd apps/api && npx vitest run src/services/tenantExportPolicyRegistry.metricAnomalyEpisodes.test.ts`
Expected: FAIL — `expected undefined to be defined` for `metric_anomaly_episodes`.

- [ ] **Step 6: Amend the export registry**

In `apps/api/src/services/tenantExportPolicyRegistry.ts` replace the `metric_anomalies` line (`:406`) with:

```ts
  "metric_anomalies": tablePolicy("org_id", {"included":["id","org_id","device_id","source_table","metric_type","metric_name","anomaly_type","status","window_start","window_end","bucket_seconds","observed_value","baseline_value","baseline_min","baseline_max","score","confidence","sample_count","linked_alert_id","linked_correlation_group_id","detected_at","resolved_at","updated_at","episode_id"],"reviewedIncluded":[],"excludedSensitive":[],"excludedOpen":["baseline_summary","evidence"]}),
```

insert directly after the `metric_anomaly_candidates` line (`:407`):

```ts
  // Metric anomaly episodes W01 (spec §14). metric_names is text[] (included,
  // same as metric_anomaly_incidents). attribution is jsonb, so excludedOpen:
  // process snapshots are visible in the UI but absent from the GDPR export.
  "metric_anomaly_episodes": tablePolicy("org_id", {"included":["id","org_id","device_id","episode_key","source_table","anomaly_type","metric_family","metric_names","status","close_reason","first_seen_at","last_seen_at","bucket_count","peak_value","peak_metric_name","peak_baseline_value","peak_score","peak_at","recurrence_count","linked_alert_id","snoozed_until","resolved_at","resolved_by_user_id","note","created_at","updated_at"],"reviewedIncluded":[],"excludedSensitive":[],"excludedOpen":["attribution"]}),
```

and replace the `metric_anomaly_incidents` line (`:412`) with:

```ts
  "metric_anomaly_incidents": tablePolicy("org_id", {"included":["id","org_id","device_id","anomaly_type","bucket_seconds","window_start","first_seen_at","last_seen_at","peak_score","row_count","metric_names","dispatched_at","dispatch_attempts","agent_run_id","created_at","episode_id","suppressed_by_episode"],"reviewedIncluded":[],"excludedSensitive":[],"excludedOpen":[]}),
```

No new column name contains a `SUSPICIOUS_NAME_PARTS` fragment (`services/tenantExportPolicy.ts:35-55`), so nothing needs `reviewedIncluded`.

- [ ] **Step 7: Run the export test to verify it passes**

Run: `cd apps/api && npx vitest run src/services/tenantExportPolicyRegistry.metricAnomalyEpisodes.test.ts`
Expected: PASS.

- [ ] **Step 8: Add the org cascade entry and watch the merge engine go red**

In `apps/api/src/services/tenantCascade.ts` (`CORE_ORG_CASCADE_DELETE_ORDER`, alphabetical by `localeCompare`) change

```ts
  'metric_anomalies',
  'metric_anomaly_candidates',
  'metric_anomaly_incidents',
```

to

```ts
  'metric_anomalies',
  'metric_anomaly_candidates',
  // Episodes W01. FK children first is computed by topologicalCascadeOrder():
  // metric_anomalies.episode_id -> this table is ON DELETE SET NULL, and this
  // table -> alerts/users is ON DELETE SET NULL. No cycle.
  'metric_anomaly_episodes',
  'metric_anomaly_incidents',
```

Run: `cd apps/api && npx vitest run src/services/orgMerge.test.ts`
Expected: FAIL — `[orgMerge] no merge policy registered for 'metric_anomaly_episodes'`.

- [ ] **Step 9: Register the merge policy**

In `apps/api/src/services/orgMergeRegistry.ts` (`REPOINT_TABLES`) change

```ts
  "metric_anomalies",
  "metric_anomaly_candidates",
  "metric_anomaly_incidents",
```

to

```ts
  "metric_anomalies",
  "metric_anomaly_candidates",
  // Episodes W01 — plain repoint. The only unique key is the partial
  // (device_id, episode_key) WHERE status = 'open'; it is keyed on the device,
  // not the org, so merging two orgs can never make two rows collide.
  "metric_anomaly_episodes",
  "metric_anomaly_incidents",
```

- [ ] **Step 10: Run the merge and cascade unit suites to verify they pass**

Run: `cd apps/api && npx vitest run src/services/orgMerge.test.ts src/services/tenantCascade.test.ts src/routes/devices/cascadeDelete.test.ts src/routes/devices/moveOrg.coverage.test.ts`
Expected: PASS. (The integration contracts — `tenantCascade`, `tenant-export-policy`, `tenantExportErasureRoundtrip`, `orgMergeRegistry` — run in Task 11.)

- [ ] **Step 11: Commit**

```bash
git add apps/api/src/routes/devices/core.ts apps/api/src/services/tenantCascade.ts apps/api/src/services/orgMergeRegistry.ts apps/api/src/services/tenantExportPolicyRegistry.ts apps/api/src/services/tenantExportPolicyRegistry.metricAnomalyEpisodes.test.ts
git commit -m "feat(anomalies): register metric_anomaly_episodes in cascade, merge, and export contracts" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Retention

**Files:**
- Modify: `apps/api/src/jobs/mlOutputRetention.ts:41-46` (`PrunedTable`), new prune function after `pruneMetricAnomalies`, `pruneMlOutputs` table list
- Test: `apps/api/src/jobs/mlOutputRetention.test.ts`

**Interfaces:**
- Consumes: the `metric_anomaly_episodes` table (Task 2).
- Produces: `pruneMlOutputs(...).tables` order `remediation_suggestions, metric_anomalies, metric_anomaly_episodes, metric_anomaly_candidates`.

- [ ] **Step 1: Write the failing test**

Add to `describe('ML output retention worker', …)` in `apps/api/src/jobs/mlOutputRetention.test.ts`:

```ts
  it('prunes metric_anomaly_episodes by last_seen_at, right after the metric_anomalies pass', async () => {
    createMlOutputRetentionWorker();

    const result = (await capturedWorkerProcessor.current!({
      data: { retentionDays: 30, batchSize: 4, maxBatches: 3 },
    })) as { tables: Array<{ table: string }> };

    const statements = dbExecuteMock.mock.calls.map((call) => JSON.stringify(call));
    const anomaliesIdx = statements.findIndex((text) => text.includes('DELETE FROM metric_anomalies'));
    const episodesIdx = statements.findIndex((text) => text.includes('DELETE FROM metric_anomaly_episodes'));
    expect(episodesIdx).toBeGreaterThan(anomaliesIdx);
    expect(statements[episodesIdx]).toContain('last_seen_at <');
    expect(result.tables.map((table) => table.table)).toEqual([
      'remediation_suggestions',
      'metric_anomalies',
      'metric_anomaly_episodes',
      'metric_anomaly_candidates',
    ]);
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/api && npx vitest run src/jobs/mlOutputRetention.test.ts`
Expected: FAIL — `expected -1 to be greater than 1` (no episode DELETE).

- [ ] **Step 3: Implement the prune pass**

In `apps/api/src/jobs/mlOutputRetention.ts` widen the union:

```ts
type PrunedTable = {
  table: 'remediation_suggestions' | 'metric_anomalies' | 'metric_anomaly_episodes' | 'metric_anomaly_candidates';
  deleted: number;
  batches: number;
  hasMore: boolean;
};
```

add after `pruneMetricAnomalies`:

```ts
/**
 * Episodes W01 (spec §14): same 365-day default as the member rows, keyed on
 * `last_seen_at`. Runs after the metric_anomalies pass; any surviving member
 * of a pruned episode keeps its row with episode_id set NULL by the FK.
 */
async function pruneMetricAnomalyEpisodes(cutoff: string, batchSize: number, maxBatches: number): Promise<PrunedTable> {
  let deleted = 0;
  let batches = 0;
  let lastBatchDeleted = 0;

  while (batches < maxBatches) {
    const result = await db.execute(sql`
      DELETE FROM metric_anomaly_episodes
      WHERE ctid IN (
        SELECT ctid
        FROM metric_anomaly_episodes
        WHERE last_seen_at < ${cutoff}::timestamptz
        LIMIT ${batchSize}
      )
    `);
    lastBatchDeleted = extractRowCount(result);
    deleted += lastBatchDeleted;
    batches += 1;
    if (lastBatchDeleted < batchSize) break;
  }

  return {
    table: 'metric_anomaly_episodes',
    deleted,
    batches,
    hasMore: batches >= maxBatches && lastBatchDeleted >= batchSize,
  };
}
```

and in `pruneMlOutputs` make the list:

```ts
  const tables = [
    await pruneRemediationSuggestions(cutoff, batchSize, maxBatches),
    await pruneMetricAnomalies(cutoff, batchSize, maxBatches),
    await pruneMetricAnomalyEpisodes(cutoff, batchSize, maxBatches),
    await pruneMetricAnomalyCandidates(cutoff, batchSize, maxBatches),
  ];
```

- [ ] **Step 4: Update the two pre-existing expectations that count statements**

In `it('prunes remediation suggestions, metric anomalies, and shadow candidates …')` change `expect(dbExecuteMock).toHaveBeenCalledTimes(4);` to `toHaveBeenCalledTimes(5)` and the `tables` array to:

```ts
      tables: [
        { table: 'remediation_suggestions', deleted: 5, batches: 2, hasMore: false },
        { table: 'metric_anomalies', deleted: 0, batches: 1, hasMore: false },
        { table: 'metric_anomaly_episodes', deleted: 0, batches: 1, hasMore: false },
        { table: 'metric_anomaly_candidates', deleted: 0, batches: 1, hasMore: false },
      ],
```

In `it('reports hasMore when any output table exhausts the configured batch cap')` change `toHaveBeenCalledTimes(4)` to `toHaveBeenCalledTimes(5)` and the `tables` array to:

```ts
      tables: [
        { table: 'remediation_suggestions', deleted: 8, batches: 2, hasMore: true },
        { table: 'metric_anomalies', deleted: 1, batches: 1, hasMore: false },
        { table: 'metric_anomaly_episodes', deleted: 0, batches: 1, hasMore: false },
        { table: 'metric_anomaly_candidates', deleted: 0, batches: 1, hasMore: false },
      ],
```

(The fourth `mockResolvedValueOnce({ rowCount: 0 })` now feeds the episodes pass; the candidates pass gets the default `{ rowCount: 0 }` from `beforeEach`.)

- [ ] **Step 5: Run the retention tests to verify they pass**

Run: `cd apps/api && npx vitest run src/jobs/mlOutputRetention.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/jobs/mlOutputRetention.ts apps/api/src/jobs/mlOutputRetention.test.ts
git commit -m "feat(anomalies): prune metric_anomaly_episodes with ML output retention" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Episode key map, constants, and counters

**Files:**
- Create: `apps/api/src/services/metricAnomalyEpisodeKeys.ts`
- Create: `apps/api/src/services/metricAnomalyEpisodeKeys.test.ts`
- Create: `apps/api/src/services/metricAnomalyEpisodeMetrics.ts`
- Create: `apps/api/src/services/metricAnomalyEpisodeMetrics.test.ts`

**Interfaces:**
- Consumes: `AttributionDimension` from `@breeze/shared` (Task 1).
- Produces:
  - `EPISODE_GAP_MINUTES`, `EPISODE_CLEAN_BUCKETS`, `EPISODE_EXPIRE_HOURS`, `EPISODE_RECURRENCE_DAYS`, `EPISODE_SNOOZE_DAYS`, `EPISODE_ASSEMBLY_LOOKBACK_HOURS`, `EPISODE_BUCKET_SECONDS` (all `number`)
  - `parseEpisodeEnvInt(name: string, fallback: number): number`
  - `EPISODE_METRIC_FAMILIES: Readonly<Record<string, Readonly<Record<string, { family: string; dimension: AttributionDimension | null }>>>>`
  - `type AttributionDimensionOrNull = AttributionDimension | null`
  - `episodeKeyFor(sourceTable: string, anomalyType: string, metricName: string): { episodeKey: string; metricFamily: string; attributionDimension: AttributionDimensionOrNull }`
  - `EPISODE_STAGE_SKIPPED_METRIC = 'metric_anomaly_episode_stage_skipped_total'`, `BASELINE_FALLBACK_METRIC = 'metric_anomaly_baseline_fallback_total'`
  - `recordEpisodeStageSkipped(stage: 'episodes' | 'episode-resolve'): void`
  - `recordBaselineFallback(detector: 'baseline' | 'process-runaway', pairs: number): void`

- [ ] **Step 1: Write the failing key-map test**

`apps/api/src/services/metricAnomalyEpisodeKeys.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  EPISODE_ASSEMBLY_LOOKBACK_HOURS,
  EPISODE_BUCKET_SECONDS,
  EPISODE_CLEAN_BUCKETS,
  EPISODE_EXPIRE_HOURS,
  EPISODE_GAP_MINUTES,
  EPISODE_METRIC_FAMILIES,
  EPISODE_RECURRENCE_DAYS,
  EPISODE_SNOOZE_DAYS,
  episodeKeyFor,
  parseEpisodeEnvInt,
} from './metricAnomalyEpisodeKeys';

// Spec §4.2, verbatim.
const TABLE = [
  ['device_metrics', 'cpu_percent', 'cpu', 'cpu'],
  ['device_metrics', 'ram_percent', 'ram', 'ramMb'],
  ['device_metrics', 'ram_used_mb', 'ram_used', 'ramMb'],
  ['device_metrics', 'disk_percent', 'disk', null],
  ['device_metrics', 'disk_used_gb', 'disk_used', null],
  ['device_metrics', 'disk_read_bps', 'disk_read', 'diskBps'],
  ['device_metrics', 'disk_write_bps', 'disk_write', 'diskBps'],
  ['device_metrics', 'bandwidth_in_bps', 'net_in', 'netBps'],
  ['device_metrics', 'bandwidth_out_bps', 'net_out', 'netBps'],
  ['device_metrics', 'process_count', 'process_count', null],
  ['device_process_samples', 'top_process_cpu_percent_sum', 'process_cpu', 'cpu'],
  ['device_process_samples', 'top_process_cpu_percent_max', 'process_cpu', 'cpu'],
  ['device_process_samples', 'top_process_ram_mb_sum', 'process_ram', 'ramMb'],
  ['device_process_samples', 'top_process_ram_mb_max', 'process_ram', 'ramMb'],
  ['device_process_samples', 'top_process_disk_bps_sum', 'process_disk', 'diskBps'],
  ['device_process_samples', 'top_process_net_bps_sum', 'process_net', 'netBps'],
  ['device_process_samples', 'top_process_count', 'process_count_top', null],
] as const;

// Every metric_name the three detectors in services/metricAnomalies.ts can write.
const DETECTOR_EMITTED: ReadonlyArray<readonly [string, string]> = [
  ...['cpu_percent', 'ram_percent', 'disk_percent', 'disk_read_bps', 'disk_write_bps', 'bandwidth_in_bps', 'bandwidth_out_bps', 'process_count', 'ram_used_mb', 'disk_used_gb']
    .map((name) => ['device_metrics', name] as const),
  ...['top_process_cpu_percent_sum', 'top_process_cpu_percent_max', 'top_process_ram_mb_sum', 'top_process_ram_mb_max', 'top_process_disk_bps_sum', 'top_process_net_bps_sum']
    .map((name) => ['device_process_samples', name] as const),
];

describe('episodeKeyFor (spec §4.2)', () => {
  it.each(TABLE)('%s / %s -> family %s, dimension %s', (sourceTable, metricName, family, dimension) => {
    expect(episodeKeyFor(sourceTable, 'spike', metricName)).toEqual({
      episodeKey: `${sourceTable}:spike:${family}`,
      metricFamily: family,
      attributionDimension: dimension,
    });
  });

  it('has an explicit entry for every metric the detectors emit', () => {
    for (const [sourceTable, metricName] of DETECTOR_EMITTED) {
      expect(EPISODE_METRIC_FAMILIES[sourceTable]?.[metricName], `${sourceTable}/${metricName}`).toBeDefined();
    }
  });

  it('collapses only the process cpu and ram pairs', () => {
    const namesByFamily = new Map<string, string[]>();
    for (const [sourceTable, metricName, family] of TABLE) {
      const key = `${sourceTable}:${family}`;
      namesByFamily.set(key, [...(namesByFamily.get(key) ?? []), metricName]);
    }
    const collapsed = [...namesByFamily.entries()].filter(([, names]) => names.length > 1).map(([key]) => key).sort();
    expect(collapsed).toEqual(['device_process_samples:process_cpu', 'device_process_samples:process_ram']);
  });

  it('keeps source_table in the key so device and process series never merge', () => {
    expect(episodeKeyFor('device_metrics', 'network_egress', 'bandwidth_out_bps').episodeKey)
      .not.toBe(episodeKeyFor('device_process_samples', 'network_egress', 'top_process_net_bps_sum').episodeKey);
    expect(episodeKeyFor('device_metrics', 'process_runaway', 'process_count').episodeKey)
      .toBe('device_metrics:process_runaway:process_count');
  });

  it('keeps anomaly_type in the key', () => {
    expect(episodeKeyFor('device_metrics', 'spike', 'cpu_percent').episodeKey)
      .not.toBe(episodeKeyFor('device_metrics', 'drop', 'cpu_percent').episodeKey);
  });

  it('falls back to metric_family = metric_name for an unknown metric, with no dimension', () => {
    expect(episodeKeyFor('device_metrics', 'spike', 'gpu_percent')).toEqual({
      episodeKey: 'device_metrics:spike:gpu_percent',
      metricFamily: 'gpu_percent',
      attributionDimension: null,
    });
    // Prototype keys are not known metrics.
    expect(episodeKeyFor('device_metrics', 'spike', 'toString').metricFamily).toBe('toString');
    expect(episodeKeyFor('constructor', 'spike', 'cpu_percent').metricFamily).toBe('cpu_percent');
  });
});

describe('episode constants (spec §5)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('defaults to the spec values', () => {
    expect(EPISODE_GAP_MINUTES).toBe(30);
    expect(EPISODE_CLEAN_BUCKETS).toBe(6);
    expect(EPISODE_EXPIRE_HOURS).toBe(24);
    expect(EPISODE_RECURRENCE_DAYS).toBe(7);
    expect(EPISODE_SNOOZE_DAYS).toBe(7);
    expect(EPISODE_ASSEMBLY_LOOKBACK_HOURS).toBe(24);
    expect(EPISODE_BUCKET_SECONDS).toBe(300);
  });

  it('honours a positive integer env override and rejects anything else', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubEnv('METRIC_ANOMALY_EPISODE_TEST', '45');
    expect(parseEpisodeEnvInt('METRIC_ANOMALY_EPISODE_TEST', 30)).toBe(45);
    for (const junk of ['0', '-5', 'abc', '']) {
      vi.stubEnv('METRIC_ANOMALY_EPISODE_TEST', junk);
      expect(parseEpisodeEnvInt('METRIC_ANOMALY_EPISODE_TEST', 30)).toBe(30);
    }
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/api && npx vitest run src/services/metricAnomalyEpisodeKeys.test.ts`
Expected: FAIL — cannot resolve `./metricAnomalyEpisodeKeys`.

- [ ] **Step 3: Implement the key module**

`apps/api/src/services/metricAnomalyEpisodeKeys.ts`:

```ts
import type { AttributionDimension } from '@breeze/shared';

/**
 * Metric anomaly episodes — constants and the episode key map (spec §4.2, §5).
 *
 * A LEAF module (no db, no services) so the pure planner and its tests can
 * import it without a database. `services/metricAnomalyEpisodes.ts` re-exports
 * everything here; that is the path the cross-wave contract names.
 */

export function parseEpisodeEnvInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0 || String(parsed) !== raw.trim()) {
    console.warn(`[MetricAnomalyEpisodes] Invalid ${name}="${raw}", using default ${fallback}`);
    return fallback;
  }
  return parsed;
}

/** Max gap (end of one anomalous bucket to start of the next) inside one episode. */
export const EPISODE_GAP_MINUTES = parseEpisodeEnvInt('METRIC_ANOMALY_EPISODE_GAP_MINUTES', 30);
/** Clean 5-minute buckets, per member metric, required to auto-resolve. */
export const EPISODE_CLEAN_BUCKETS = parseEpisodeEnvInt('METRIC_ANOMALY_EPISODE_CLEAN_BUCKETS', 6);
/** No clean data for this long after the last anomalous bucket -> expired. */
export const EPISODE_EXPIRE_HOURS = parseEpisodeEnvInt('METRIC_ANOMALY_EPISODE_EXPIRE_HOURS', 24);
/** Window for `recurrence_count`. */
export const EPISODE_RECURRENCE_DAYS = parseEpisodeEnvInt('METRIC_ANOMALY_EPISODE_RECURRENCE_DAYS', 7);
/** How long a user dismiss silences the key on that device (used by W02). */
export const EPISODE_SNOOZE_DAYS = parseEpisodeEnvInt('METRIC_ANOMALY_EPISODE_SNOOZE_DAYS', 7);
/** How far back the assembly scan looks for unassigned rows. */
export const EPISODE_ASSEMBLY_LOOKBACK_HOURS = parseEpisodeEnvInt('METRIC_ANOMALY_EPISODE_ASSEMBLY_LOOKBACK_HOURS', 24);
/** Raw rollup grain the detectors and the clean-data check read. Not tunable. */
export const EPISODE_BUCKET_SECONDS = 300;

export type AttributionDimensionOrNull = AttributionDimension | null;

interface FamilyEntry {
  family: string;
  dimension: AttributionDimensionOrNull;
}

/**
 * source_table -> metric_name -> family. Only the process cpu and ram
 * `_sum`/`_max` pairs collapse. `source_table` stays part of the key because
 * `network_egress` and `process_runaway` are each emitted for a device series
 * AND a process-sample series, which must not merge.
 */
export const EPISODE_METRIC_FAMILIES: Readonly<Record<string, Readonly<Record<string, FamilyEntry>>>> = {
  device_metrics: {
    cpu_percent: { family: 'cpu', dimension: 'cpu' },
    ram_percent: { family: 'ram', dimension: 'ramMb' },
    ram_used_mb: { family: 'ram_used', dimension: 'ramMb' },
    disk_percent: { family: 'disk', dimension: null },
    disk_used_gb: { family: 'disk_used', dimension: null },
    disk_read_bps: { family: 'disk_read', dimension: 'diskBps' },
    disk_write_bps: { family: 'disk_write', dimension: 'diskBps' },
    bandwidth_in_bps: { family: 'net_in', dimension: 'netBps' },
    bandwidth_out_bps: { family: 'net_out', dimension: 'netBps' },
    process_count: { family: 'process_count', dimension: null },
  },
  device_process_samples: {
    top_process_cpu_percent_sum: { family: 'process_cpu', dimension: 'cpu' },
    top_process_cpu_percent_max: { family: 'process_cpu', dimension: 'cpu' },
    top_process_ram_mb_sum: { family: 'process_ram', dimension: 'ramMb' },
    top_process_ram_mb_max: { family: 'process_ram', dimension: 'ramMb' },
    top_process_disk_bps_sum: { family: 'process_disk', dimension: 'diskBps' },
    top_process_net_bps_sum: { family: 'process_net', dimension: 'netBps' },
    top_process_count: { family: 'process_count_top', dimension: null },
  },
};

export function episodeKeyFor(
  sourceTable: string,
  anomalyType: string,
  metricName: string,
): { episodeKey: string; metricFamily: string; attributionDimension: AttributionDimensionOrNull } {
  const byMetric = Object.hasOwn(EPISODE_METRIC_FAMILIES, sourceTable) ? EPISODE_METRIC_FAMILIES[sourceTable] : undefined;
  const entry = byMetric && Object.hasOwn(byMetric, metricName) ? byMetric[metricName] : undefined;
  // Unknown metric -> its own family, so the detector can grow without
  // breaking assembly (spec §4.2).
  const metricFamily = entry?.family ?? metricName;
  return {
    episodeKey: `${sourceTable}:${anomalyType}:${metricFamily}`,
    metricFamily,
    attributionDimension: entry?.dimension ?? null,
  };
}
```

- [ ] **Step 4: Run the key test to verify it passes**

Run: `cd apps/api && npx vitest run src/services/metricAnomalyEpisodeKeys.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing counter test**

`apps/api/src/services/metricAnomalyEpisodeMetrics.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { metricsRegistry } from './metricsRegistry';
import {
  BASELINE_FALLBACK_METRIC,
  EPISODE_STAGE_SKIPPED_METRIC,
  recordBaselineFallback,
  recordEpisodeStageSkipped,
} from './metricAnomalyEpisodeMetrics';

beforeEach(() => {
  metricsRegistry.resetMetrics();
});

describe('metric anomaly episode counters (spec §7, §10)', () => {
  it('counts skipped episode stages by stage', async () => {
    recordEpisodeStageSkipped('episodes');
    recordEpisodeStageSkipped('episode-resolve');
    recordEpisodeStageSkipped('episode-resolve');
    const text = await metricsRegistry.metrics();
    expect(EPISODE_STAGE_SKIPPED_METRIC).toBe('metric_anomaly_episode_stage_skipped_total');
    expect(text).toContain('metric_anomaly_episode_stage_skipped_total{stage="episodes"} 1');
    expect(text).toContain('metric_anomaly_episode_stage_skipped_total{stage="episode-resolve"} 2');
  });

  it('adds baseline fallbacks by detector and ignores zero, negative and non-finite counts', async () => {
    recordBaselineFallback('baseline', 2);
    recordBaselineFallback('process-runaway', 1);
    recordBaselineFallback('baseline', 0);
    recordBaselineFallback('baseline', -3);
    recordBaselineFallback('baseline', Number.NaN);
    const text = await metricsRegistry.metrics();
    expect(BASELINE_FALLBACK_METRIC).toBe('metric_anomaly_baseline_fallback_total');
    expect(text).toContain('metric_anomaly_baseline_fallback_total{detector="baseline"} 2');
    expect(text).toContain('metric_anomaly_baseline_fallback_total{detector="process-runaway"} 1');
    expect(text).not.toContain('NaN');
  });
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `cd apps/api && npx vitest run src/services/metricAnomalyEpisodeMetrics.test.ts`
Expected: FAIL — cannot resolve `./metricAnomalyEpisodeMetrics`.

- [ ] **Step 7: Implement the counters**

`apps/api/src/services/metricAnomalyEpisodeMetrics.ts`:

```ts
/**
 * Metric anomaly episode counters (spec §7, §10).
 *
 * A LEAF module: `prom-client` plus `./metricsRegistry`, nothing else — same
 * shape and reason as aiOperatorOutboxMetrics.ts. Detection runs in the WORKER
 * role, which never loads routes/metrics.ts; registering here is what makes the
 * series appear in the process that produces it.
 */
import { Counter } from 'prom-client';

import { metricsRegistry } from './metricsRegistry';

export const EPISODE_STAGE_SKIPPED_METRIC = 'metric_anomaly_episode_stage_skipped_total';
export const BASELINE_FALLBACK_METRIC = 'metric_anomaly_baseline_fallback_total';

/** A whole-org episode stage hit its lock/statement timeout. A steady rise means open episodes are not clearing. */
const stageSkipped = new Counter({
  name: EPISODE_STAGE_SKIPPED_METRIC,
  help: 'Metric anomaly episode stages (assembly, auto-resolve) skipped on a lock or statement timeout',
  labelNames: ['stage'] as const,
  registers: [metricsRegistry],
});

/** (device, metric) pairs whose open-episode-filtered baseline was too short, so the unfiltered one was used. */
const baselineFallback = new Counter({
  name: BASELINE_FALLBACK_METRIC,
  help: 'Device+metric pairs that fell back to the unfiltered baseline because excluding open-episode buckets left fewer than MIN_BASELINE_BUCKETS',
  labelNames: ['detector'] as const,
  registers: [metricsRegistry],
});

export function recordEpisodeStageSkipped(stage: 'episodes' | 'episode-resolve'): void {
  try {
    stageSkipped.inc({ stage });
  } catch (error) {
    console.error('[MetricAnomalyEpisodes] Failed to record stage skip:', error);
  }
}

export function recordBaselineFallback(detector: 'baseline' | 'process-runaway', pairs: number): void {
  if (!Number.isFinite(pairs) || pairs <= 0) return;
  try {
    baselineFallback.inc({ detector }, pairs);
  } catch (error) {
    console.error('[MetricAnomalyEpisodes] Failed to record baseline fallback:', error);
  }
}
```

- [ ] **Step 8: Run both tests and the worker-closure contract**

Run: `cd apps/api && npx vitest run src/services/metricAnomalyEpisodeKeys.test.ts src/services/metricAnomalyEpisodeMetrics.test.ts src/services/workerEntrypointClosure.contract.test.ts`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/services/metricAnomalyEpisodeKeys.ts apps/api/src/services/metricAnomalyEpisodeKeys.test.ts apps/api/src/services/metricAnomalyEpisodeMetrics.ts apps/api/src/services/metricAnomalyEpisodeMetrics.test.ts
git commit -m "feat(anomalies): episode key map, constants, and episode counters" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Pure assembly planner

The planner owns every "which episode does this bucket belong to" decision, so the attach predicate (§16 unit bullet 2) is tested without a database. It never touches the DB and never reads the clock.

**Files:**
- Create: `apps/api/src/services/metricAnomalyEpisodePlanner.ts`
- Create: `apps/api/src/services/metricAnomalyEpisodePlanner.test.ts`

**Interfaces:**
- Consumes: `episodeKeyFor`, `AttributionDimensionOrNull` (Task 5).
- Produces:
  ```ts
  interface UnassignedAnomalyRow { id: string; deviceId: string; sourceTable: string; anomalyType: string; metricName: string; windowStart: Date; windowEnd: Date; score: number; observedValue: number; baselineValue: number | null }
  interface AnchorEpisode { id: string; deviceId: string; episodeKey: string; status: 'open' | 'dismissed'; firstSeenAt: Date; lastSeenAt: Date }
  type PlannedDisposition = 'open' | 'snoozed' | 'historical'
  type MemberStatus = 'open' | 'dismissed' | 'cleared'
  interface PlannedAttach { anomalyId: string; episodeId: string; memberStatus: MemberStatus; attributionDimension: AttributionDimensionOrNull }
  interface PlannedSupersede { episodeId: string; cleanUntil: Date }
  interface PlannedEpisode { id; deviceId; episodeKey; sourceTable; anomalyType; metricFamily; attributionDimension; metricNames: string[]; firstSeenAt: Date; lastSeenAt: Date; bucketCount: number; peakValue: number; peakMetricName: string; peakBaselineValue: number | null; peakScore: number; peakAt: Date; disposition: PlannedDisposition; snoozedUntil: Date | null; cleanUntil: Date | null; priorInBatch: number; memberIds: string[] }
  interface EpisodeAssemblyPlan { anchorAttaches: PlannedAttach[]; creates: PlannedEpisode[]; supersedes: PlannedSupersede[] }
  function groupKeyOf(deviceId: string, episodeKey: string): string
  function memberStatusFor(disposition: PlannedDisposition): MemberStatus
  function planEpisodeAssembly(input: { rows: readonly UnassignedAnomalyRow[]; anchors: readonly AnchorEpisode[]; activeSnoozes: ReadonlyMap<string, Date>; gapMinutes: number; newId?: () => string }): EpisodeAssemblyPlan
  ```

- [ ] **Step 1: Write the failing planner test**

`apps/api/src/services/metricAnomalyEpisodePlanner.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  groupKeyOf,
  memberStatusFor,
  planEpisodeAssembly,
  type AnchorEpisode,
  type UnassignedAnomalyRow,
} from './metricAnomalyEpisodePlanner';

const DEVICE = 'dddddddd-0000-4000-8000-000000000001';
const T0 = Date.parse('2026-09-21T22:00:00.000Z');
const CPU_KEY = 'device_metrics:spike:cpu';
const m = (minutes: number): Date => new Date(T0 + minutes * 60_000);

let rowSeq = 0;
function row(atMinute: number, overrides: Partial<UnassignedAnomalyRow> = {}): UnassignedAnomalyRow {
  rowSeq += 1;
  return {
    id: `row-${rowSeq}`,
    deviceId: DEVICE,
    sourceTable: 'device_metrics',
    anomalyType: 'spike',
    metricName: 'cpu_percent',
    windowStart: m(atMinute),
    windowEnd: m(atMinute + 5),
    score: 5,
    observedValue: 95,
    baselineValue: 40,
    ...overrides,
  };
}

function anchor(first: number, last: number, overrides: Partial<AnchorEpisode> = {}): AnchorEpisode {
  return { id: 'ep-1', deviceId: DEVICE, episodeKey: CPU_KEY, status: 'open', firstSeenAt: m(first), lastSeenAt: m(last), ...overrides };
}

function plan(rows: UnassignedAnomalyRow[], anchors: AnchorEpisode[] = [], snoozes = new Map<string, Date>()) {
  let n = 0;
  return planEpisodeAssembly({ rows, anchors, activeSnoozes: snoozes, gapMinutes: 30, newId: () => `new-${++n}` });
}

describe('planEpisodeAssembly (spec §5, §6)', () => {
  it('opens one episode for a contiguous 17-bucket burst and summarises it', () => {
    const rows = Array.from({ length: 17 }, (_, i) => row(i * 5, i === 8 ? { score: 20, observedValue: 153, baselineValue: 11 } : {}));
    const result = plan(rows);
    expect(result.supersedes).toEqual([]);
    expect(result.anchorAttaches).toEqual([]);
    expect(result.creates).toHaveLength(1);
    expect(result.creates[0]).toMatchObject({
      id: 'new-1',
      episodeKey: CPU_KEY,
      metricFamily: 'cpu',
      attributionDimension: 'cpu',
      disposition: 'open',
      bucketCount: 17,
      firstSeenAt: m(0),
      lastSeenAt: m(85),
      peakScore: 20,
      peakValue: 153,
      peakBaselineValue: 11,
      peakMetricName: 'cpu_percent',
      peakAt: m(40),
      priorInBatch: 0,
      cleanUntil: null,
      snoozedUntil: null,
    });
    expect(result.creates[0]!.memberIds).toHaveLength(17);
  });

  it('attaches a bucket that starts exactly EPISODE_GAP_MINUTES after the episode ends', () => {
    const inside = row(45);
    const result = plan([inside], [anchor(0, 15)]);
    expect(result.creates).toEqual([]);
    expect(result.supersedes).toEqual([]);
    expect(result.anchorAttaches).toEqual([
      { anomalyId: inside.id, episodeId: 'ep-1', memberStatus: 'open', attributionDimension: 'cpu' },
    ]);
  });

  it('a bucket 31 minutes after the episode ends supersedes it and opens a new episode', () => {
    const outside = row(46);
    const result = plan([outside], [anchor(0, 15)]);
    expect(result.anchorAttaches).toEqual([]);
    expect(result.supersedes).toEqual([{ episodeId: 'ep-1', cleanUntil: m(46) }]);
    expect(result.creates).toHaveLength(1);
    expect(result.creates[0]).toMatchObject({ disposition: 'open', memberIds: [outside.id], priorInBatch: 0 });
  });

  it('chains buckets that each sit within the gap of the previous one', () => {
    const rows = [row(40), row(70), row(100)];
    const result = plan(rows, [anchor(0, 15)]);
    expect(result.anchorAttaches.map((a) => a.anomalyId)).toEqual(rows.map((r) => r.id));
    expect(result.creates).toEqual([]);
  });

  it('a backfill orphan before first_seen_at − gap becomes its own closed episode; a near one attaches', () => {
    const orphan = row(0);
    const near = row(85); // ends at 90, gap 30 to the anchor's first_seen_at (120)
    const result = plan([orphan, near], [anchor(120, 135)]);
    expect(result.anchorAttaches.map((a) => a.anomalyId)).toEqual([near.id]);
    expect(result.supersedes).toEqual([]);
    expect(result.creates).toHaveLength(1);
    expect(result.creates[0]).toMatchObject({ disposition: 'historical', memberIds: [orphan.id], cleanUntil: m(85), priorInBatch: 0 });
  });

  it('merges the process ram pair and counts distinct buckets, not rows', () => {
    const rows = [0, 5, 10].flatMap((t) => [
      row(t, { sourceTable: 'device_process_samples', anomalyType: 'process_runaway', metricName: 'top_process_ram_mb_sum', score: 4 }),
      row(t, { sourceTable: 'device_process_samples', anomalyType: 'process_runaway', metricName: 'top_process_ram_mb_max', score: t === 5 ? 9 : 3 }),
    ]);
    const result = plan(rows);
    expect(result.creates).toHaveLength(1);
    expect(result.creates[0]).toMatchObject({
      episodeKey: 'device_process_samples:process_runaway:process_ram',
      metricNames: ['top_process_ram_mb_max', 'top_process_ram_mb_sum'],
      bucketCount: 3,
      peakMetricName: 'top_process_ram_mb_max',
      peakAt: m(5),
      attributionDimension: 'ramMb',
    });
    expect(result.creates[0]!.memberIds).toHaveLength(6);
  });

  it('keeps network_egress from the device series and the process series apart', () => {
    const result = plan([
      row(0, { anomalyType: 'network_egress', metricName: 'bandwidth_out_bps' }),
      row(0, { anomalyType: 'network_egress', sourceTable: 'device_process_samples', metricName: 'top_process_net_bps_sum' }),
    ]);
    expect(result.creates.map((c) => c.episodeKey).sort()).toEqual([
      'device_metrics:network_egress:net_out',
      'device_process_samples:network_egress:process_net',
    ]);
  });

  it('in one batch, older islands close, the newest opens, and recurrence offsets count up', () => {
    const result = plan([row(0), row(60), row(120)]);
    expect(result.creates.map((c) => [c.disposition, c.priorInBatch, c.cleanUntil])).toEqual([
      ['historical', 0, m(60)],
      ['historical', 1, m(120)],
      ['open', 2, null],
    ]);
  });

  it('a live snooze creates the new episode already dismissed', () => {
    const until = m(7 * 24 * 60);
    const result = plan([row(0)], [], new Map([[groupKeyOf(DEVICE, CPU_KEY), until]]));
    expect(result.creates[0]).toMatchObject({ disposition: 'snoozed', snoozedUntil: until, cleanUntil: null });
  });

  it('extends a live snoozed successor and dismisses its new members', () => {
    const next = row(10);
    const result = plan([next], [anchor(0, 5, { status: 'dismissed' })], new Map([[groupKeyOf(DEVICE, CPU_KEY), m(10_000)]]));
    expect(result.anchorAttaches).toEqual([
      { anomalyId: next.id, episodeId: 'ep-1', memberStatus: 'dismissed', attributionDimension: 'cpu' },
    ]);
    expect(result.creates).toEqual([]);
    expect(result.supersedes).toEqual([]);
  });

  it('prefers the open anchor when a snoozed successor for the same key also exists', () => {
    const next = row(20);
    const result = plan([next], [
      anchor(0, 5, { id: 'snoozed', status: 'dismissed' }),
      anchor(0, 15, { id: 'open' }),
    ]);
    expect(result.anchorAttaches.map((a) => a.episodeId)).toEqual(['open']);
  });

  it('gives a tied peak to the earliest bucket', () => {
    const result = plan([row(0, { score: 7 }), row(5, { score: 7 })]);
    expect(result.creates[0]!.peakAt).toEqual(m(0));
  });

  it('maps a disposition to the status its members take', () => {
    expect(memberStatusFor('open')).toBe('open');
    expect(memberStatusFor('snoozed')).toBe('dismissed');
    expect(memberStatusFor('historical')).toBe('cleared');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/api && npx vitest run src/services/metricAnomalyEpisodePlanner.test.ts`
Expected: FAIL — cannot resolve `./metricAnomalyEpisodePlanner`.

- [ ] **Step 3: Implement the planner**

`apps/api/src/services/metricAnomalyEpisodePlanner.ts`:

```ts
import { randomUUID } from 'node:crypto';

import { episodeKeyFor, type AttributionDimensionOrNull } from './metricAnomalyEpisodeKeys';

/**
 * Pure planner for the `episodes` stage (spec §5, §6). No DB, no clock.
 *
 * Per (device, episode_key) it sweeps the unassigned rows, plus the key's
 * current anchor episode as a pseudo-interval, into ISLANDS: a new island
 * starts when an item's start is more than `gapMinutes` after the running max
 * end. The gap is measured end-to-start in both directions (plan deviation 2).
 *
 *  - The island that contains the anchor attaches its rows to the anchor.
 *  - The LAST island, if it is not the anchor's, becomes the new open episode
 *    (or a snoozed successor while a snooze is live) and supersedes an open
 *    anchor — the partial unique index allows one open episode per key.
 *  - Every other island is created already closed ('historical'): a backfill
 *    orphan older than the anchor, or an older burst in the same batch.
 *    `cleanUntil` (the next island's start) bounds the clean-data check that
 *    decides its close_reason in SQL.
 */

export interface UnassignedAnomalyRow {
  id: string;
  deviceId: string;
  sourceTable: string;
  anomalyType: string;
  metricName: string;
  windowStart: Date;
  windowEnd: Date;
  score: number;
  observedValue: number;
  baselineValue: number | null;
}

export interface AnchorEpisode {
  id: string;
  deviceId: string;
  episodeKey: string;
  /** 'open', or a live snoozed successor (status dismissed, close_reason snoozed). */
  status: 'open' | 'dismissed';
  firstSeenAt: Date;
  lastSeenAt: Date;
}

export type PlannedDisposition = 'open' | 'snoozed' | 'historical';
export type MemberStatus = 'open' | 'dismissed' | 'cleared';

export interface PlannedAttach {
  anomalyId: string;
  episodeId: string;
  memberStatus: MemberStatus;
  attributionDimension: AttributionDimensionOrNull;
}

export interface PlannedSupersede {
  episodeId: string;
  /** Start of the island that superseded it; clean data is counted up to here. */
  cleanUntil: Date;
}

export interface PlannedEpisode {
  id: string;
  deviceId: string;
  episodeKey: string;
  sourceTable: string;
  anomalyType: string;
  metricFamily: string;
  attributionDimension: AttributionDimensionOrNull;
  metricNames: string[];
  firstSeenAt: Date;
  lastSeenAt: Date;
  bucketCount: number;
  peakValue: number;
  peakMetricName: string;
  peakBaselineValue: number | null;
  peakScore: number;
  peakAt: Date;
  disposition: PlannedDisposition;
  snoozedUntil: Date | null;
  cleanUntil: Date | null;
  /** Closed episodes created earlier in this same batch for this key (added to the SQL recurrence count). */
  priorInBatch: number;
  memberIds: string[];
}

export interface EpisodeAssemblyPlan {
  anchorAttaches: PlannedAttach[];
  creates: PlannedEpisode[];
  supersedes: PlannedSupersede[];
}

export interface PlanEpisodeAssemblyInput {
  rows: readonly UnassignedAnomalyRow[];
  anchors: readonly AnchorEpisode[];
  /** groupKeyOf(deviceId, episodeKey) -> snoozed_until of a live user snooze. */
  activeSnoozes: ReadonlyMap<string, Date>;
  gapMinutes: number;
  newId?: () => string;
}

export function groupKeyOf(deviceId: string, episodeKey: string): string {
  return `${deviceId}|${episodeKey}`;
}

export function memberStatusFor(disposition: PlannedDisposition): MemberStatus {
  if (disposition === 'open') return 'open';
  if (disposition === 'snoozed') return 'dismissed';
  return 'cleared';
}

interface GroupMeta {
  deviceId: string;
  sourceTable: string;
  anomalyType: string;
  episodeKey: string;
  metricFamily: string;
  attributionDimension: AttributionDimensionOrNull;
}

type IslandItem =
  | { kind: 'row'; row: UnassignedAnomalyRow; start: number; end: number }
  | { kind: 'anchor'; anchor: AnchorEpisode; start: number; end: number };

function chooseAnchor(candidates: readonly AnchorEpisode[]): AnchorEpisode | undefined {
  const open = candidates.find((candidate) => candidate.status === 'open');
  if (open) return open;
  return [...candidates].sort((a, b) => b.lastSeenAt.getTime() - a.lastSeenAt.getTime())[0];
}

function summarize(rows: readonly UnassignedAnomalyRow[]) {
  const first = rows[0]!;
  let firstSeen = first.windowStart;
  let lastSeen = first.windowEnd;
  let peak = first;
  const names = new Set<string>();
  const buckets = new Set<number>();
  for (const candidate of rows) {
    if (candidate.windowStart < firstSeen) firstSeen = candidate.windowStart;
    if (candidate.windowEnd > lastSeen) lastSeen = candidate.windowEnd;
    if (candidate.score > peak.score || (candidate.score === peak.score && candidate.windowStart < peak.windowStart)) {
      peak = candidate;
    }
    names.add(candidate.metricName);
    buckets.add(candidate.windowStart.getTime());
  }
  return {
    metricNames: [...names].sort(),
    firstSeenAt: firstSeen,
    lastSeenAt: lastSeen,
    bucketCount: buckets.size,
    peakValue: peak.observedValue,
    peakMetricName: peak.metricName,
    peakBaselineValue: peak.baselineValue,
    peakScore: peak.score,
    peakAt: peak.windowStart,
    memberIds: rows.map((candidate) => candidate.id),
  };
}

export function planEpisodeAssembly(input: PlanEpisodeAssemblyInput): EpisodeAssemblyPlan {
  const gapMs = input.gapMinutes * 60_000;
  const newId = input.newId ?? randomUUID;

  const groups = new Map<string, { meta: GroupMeta; rows: UnassignedAnomalyRow[] }>();
  for (const candidate of input.rows) {
    const key = episodeKeyFor(candidate.sourceTable, candidate.anomalyType, candidate.metricName);
    const groupKey = groupKeyOf(candidate.deviceId, key.episodeKey);
    let group = groups.get(groupKey);
    if (!group) {
      group = {
        meta: {
          deviceId: candidate.deviceId,
          sourceTable: candidate.sourceTable,
          anomalyType: candidate.anomalyType,
          episodeKey: key.episodeKey,
          metricFamily: key.metricFamily,
          attributionDimension: key.attributionDimension,
        },
        rows: [],
      };
      groups.set(groupKey, group);
    }
    group.rows.push(candidate);
  }

  const anchorsByGroup = new Map<string, AnchorEpisode[]>();
  for (const candidate of input.anchors) {
    const groupKey = groupKeyOf(candidate.deviceId, candidate.episodeKey);
    anchorsByGroup.set(groupKey, [...(anchorsByGroup.get(groupKey) ?? []), candidate]);
  }

  const plan: EpisodeAssemblyPlan = { anchorAttaches: [], creates: [], supersedes: [] };

  for (const groupKey of [...groups.keys()].sort()) {
    const { meta, rows } = groups.get(groupKey)!;
    const current = chooseAnchor(anchorsByGroup.get(groupKey) ?? []);

    const items: IslandItem[] = rows.map((candidate) => ({
      kind: 'row' as const,
      row: candidate,
      start: candidate.windowStart.getTime(),
      end: candidate.windowEnd.getTime(),
    }));
    if (current) {
      items.push({ kind: 'anchor', anchor: current, start: current.firstSeenAt.getTime(), end: current.lastSeenAt.getTime() });
    }
    items.sort((a, b) => a.start - b.start || (a.kind === b.kind ? 0 : a.kind === 'anchor' ? -1 : 1));

    const islands: IslandItem[][] = [];
    let runningEnd = Number.NEGATIVE_INFINITY;
    for (const item of items) {
      if (islands.length === 0 || item.start > runningEnd + gapMs) islands.push([]);
      islands[islands.length - 1]!.push(item);
      runningEnd = Math.max(runningEnd, item.end);
    }

    const anchorIdx = islands.findIndex((island) => island.some((item) => item.kind === 'anchor'));
    const lastIdx = islands.length - 1;
    const snoozedUntil = input.activeSnoozes.get(groupKey) ?? null;
    let createdInGroup = 0;

    islands.forEach((island, idx) => {
      const islandRows = island.flatMap((item) => (item.kind === 'row' ? [item.row] : []));
      if (idx === anchorIdx && current) {
        const memberStatus: MemberStatus = current.status === 'open' ? 'open' : 'dismissed';
        for (const candidate of islandRows) {
          plan.anchorAttaches.push({
            anomalyId: candidate.id,
            episodeId: current.id,
            memberStatus,
            attributionDimension: meta.attributionDimension,
          });
        }
        return;
      }

      const isHead = idx === lastIdx;
      if (isHead && current && current.status === 'open' && anchorIdx >= 0 && anchorIdx < idx) {
        plan.supersedes.push({ episodeId: current.id, cleanUntil: new Date(island[0]!.start) });
      }
      const disposition: PlannedDisposition = snoozedUntil ? 'snoozed' : isHead ? 'open' : 'historical';
      plan.creates.push({
        id: newId(),
        ...meta,
        ...summarize(islandRows),
        disposition,
        snoozedUntil: disposition === 'snoozed' ? snoozedUntil : null,
        cleanUntil: disposition === 'historical' ? new Date(islands[idx + 1]!.start) : null,
        priorInBatch: createdInGroup,
      });
      createdInGroup += 1;
    });
  }

  return plan;
}
```

- [ ] **Step 4: Run the planner test to verify it passes**

Run: `cd apps/api && npx vitest run src/services/metricAnomalyEpisodePlanner.test.ts`
Expected: PASS (13 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/metricAnomalyEpisodePlanner.ts apps/api/src/services/metricAnomalyEpisodePlanner.test.ts
git commit -m "feat(anomalies): pure episode assembly planner" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Assembly SQL and attribution

**Files:**
- Create: `apps/api/src/services/metricAnomalyEpisodes.ts`
- Create: `apps/api/src/__tests__/integration/metricAnomalyEpisodes.integration.test.ts`

**Interfaces:**
- Consumes: Task 5 constants, Task 6 `planEpisodeAssembly` / `groupKeyOf` / `memberStatusFor` and types, Drizzle `metricAnomalies`, `metricAnomalyEpisodes`, type `MetricAnomalyRange` from `./metricAnomalies` (type-only import — no runtime cycle).
- Produces:
  - `export * from './metricAnomalyEpisodeKeys'` (the contract path for the constants and `episodeKeyFor`)
  - `type EpisodeAutoCloseReason = 'cleared' | 'expired_offline' | 'expired_no_data'`
  - `interface EpisodeCloseResult { episodeId: string; deviceId: string; linkedAlertId: string | null; closeReason: EpisodeAutoCloseReason }`
  - `assembleMetricAnomalyEpisodes(range: MetricAnomalyRange): Promise<EpisodeCloseResult[]>` — must run inside a system DB context (the `episodes` stage provides one); returns the episodes it superseded.

- [ ] **Step 1: Bring up a private test stack**

Run (repo root): `pnpm test-stack up`
Expected: a worktree-local `.env.test` is written and Postgres/Redis report healthy. Leave it up until Task 11.

- [ ] **Step 2: Write the failing integration test**

`apps/api/src/__tests__/integration/metricAnomalyEpisodes.integration.test.ts`:

```ts
import './setup';

import { beforeEach, describe, expect, it } from 'vitest';
import { and, asc, eq } from 'drizzle-orm';

import { withSystemDbAccessContext } from '../../db';
import {
  deviceProcessSamples,
  devices,
  metricAnomalies,
  metricAnomalyEpisodes,
  metricRollups,
  mlFeedbackEvents,
  organizations,
} from '../../db/schema';
import { assembleMetricAnomalyEpisodes } from '../../services/metricAnomalyEpisodes';
import { createOrganization, createPartner, createSite } from './db-utils';
import { getTestDb } from './setup';

const BUCKET_MS = 5 * 60_000;
const MINUTE_MS = 60_000;

function floorToBucket(value: Date): Date {
  return new Date(Math.floor(value.getTime() / BUCKET_MS) * BUCKET_MS);
}

function at(base: Date, minutes: number): Date {
  return new Date(base.getTime() + minutes * MINUTE_MS);
}

function bucketsFrom(start: Date, count: number): Date[] {
  return Array.from({ length: count }, (_, index) => at(start, index * 5));
}

let deviceCounter = 0;
async function insertDevice(orgId: string, siteId: string, lastSeenAt: Date | null = new Date()): Promise<string> {
  deviceCounter += 1;
  const [row] = await getTestDb()
    .insert(devices)
    .values({
      orgId,
      siteId,
      agentId: `episode-test-${Date.now()}-${deviceCounter}`,
      hostname: `episode-host-${deviceCounter}`,
      displayName: `episode-host-${deviceCounter}`,
      osType: 'linux',
      osVersion: 'test',
      architecture: 'x86_64',
      agentVersion: '0.0.0-test',
      status: 'online',
      enrolledAt: new Date('2026-06-18T00:00:00.000Z'),
      lastSeenAt,
    })
    .returning({ id: devices.id });
  if (!row) throw new Error('insertDevice returned no row');
  return row.id;
}

async function enableAnomalies(orgId: string): Promise<void> {
  await getTestDb()
    .update(organizations)
    .set({ settings: { 'ml.anomalies.enabled': true, 'ml.anomalies.create_alerts': true } })
    .where(eq(organizations.id, orgId));
}

interface AnomalySeed {
  orgId: string;
  deviceId: string;
  windowStart: Date;
  sourceTable?: 'device_metrics' | 'device_process_samples';
  metricType?: string;
  metricName?: string;
  anomalyType?: string;
  score?: number;
  observedValue?: number;
  baselineValue?: number | null;
  status?: string;
  episodeId?: string | null;
}

async function insertAnomaly(seed: AnomalySeed): Promise<string> {
  const [row] = await getTestDb()
    .insert(metricAnomalies)
    .values({
      orgId: seed.orgId,
      deviceId: seed.deviceId,
      sourceTable: seed.sourceTable ?? 'device_metrics',
      metricType: seed.metricType ?? 'cpu',
      metricName: seed.metricName ?? 'cpu_percent',
      anomalyType: seed.anomalyType ?? 'spike',
      status: seed.status ?? 'open',
      windowStart: seed.windowStart,
      windowEnd: at(seed.windowStart, 5),
      bucketSeconds: 300,
      observedValue: seed.observedValue ?? 95,
      baselineValue: seed.baselineValue === undefined ? 40 : seed.baselineValue,
      score: seed.score ?? 5,
      confidence: 0.9,
      sampleCount: 1,
      baselineSummary: {},
      evidence: {},
      episodeId: seed.episodeId ?? null,
    })
    .returning({ id: metricAnomalies.id });
  if (!row) throw new Error('insertAnomaly returned no row');
  return row.id;
}

interface EpisodeSeed {
  orgId: string;
  deviceId: string;
  firstSeenAt: Date;
  lastSeenAt: Date;
  episodeKey?: string;
  sourceTable?: string;
  anomalyType?: string;
  metricFamily?: string;
  metricNames?: string[];
  status?: 'open' | 'resolved' | 'dismissed';
  closeReason?: string | null;
  snoozedUntil?: Date | null;
  resolvedAt?: Date | null;
  linkedAlertId?: string | null;
}

async function insertEpisode(seed: EpisodeSeed): Promise<string> {
  const metricNames = seed.metricNames ?? ['cpu_percent'];
  const [row] = await getTestDb()
    .insert(metricAnomalyEpisodes)
    .values({
      orgId: seed.orgId,
      deviceId: seed.deviceId,
      episodeKey: seed.episodeKey ?? 'device_metrics:spike:cpu',
      sourceTable: seed.sourceTable ?? 'device_metrics',
      anomalyType: seed.anomalyType ?? 'spike',
      metricFamily: seed.metricFamily ?? 'cpu',
      metricNames,
      status: seed.status ?? 'open',
      closeReason: seed.closeReason ?? null,
      firstSeenAt: seed.firstSeenAt,
      lastSeenAt: seed.lastSeenAt,
      bucketCount: 1,
      peakValue: 95,
      peakMetricName: metricNames[0]!,
      peakBaselineValue: 40,
      peakScore: 5,
      peakAt: seed.firstSeenAt,
      snoozedUntil: seed.snoozedUntil ?? null,
      resolvedAt: seed.resolvedAt ?? null,
      linkedAlertId: seed.linkedAlertId ?? null,
    })
    .returning({ id: metricAnomalyEpisodes.id });
  if (!row) throw new Error('insertEpisode returned no row');
  return row.id;
}

interface RollupSeed {
  orgId: string;
  deviceId: string;
  metricName: string;
  starts: Date[];
  value: (index: number) => number;
  sourceTable?: 'device_metrics' | 'device_process_samples';
  metricType?: string;
}

async function insertRollups(seed: RollupSeed): Promise<void> {
  if (seed.starts.length === 0) return;
  await getTestDb().insert(metricRollups).values(
    seed.starts.map((bucketStart, index) => {
      const value = seed.value(index);
      return {
        orgId: seed.orgId,
        sourceTable: seed.sourceTable ?? 'device_metrics',
        deviceId: seed.deviceId,
        metricType: seed.metricType ?? 'cpu',
        metricName: seed.metricName,
        bucketStart,
        bucketSeconds: 300,
        avgValue: value,
        minValue: value,
        maxValue: value,
        p95Value: value,
        sumValue: value,
        sampleCount: 1,
        gapSeconds: 0,
        metadata: { rollupVersion: 'metric-rollups-v1', source: 'raw' },
      };
    }),
  );
}

async function insertProcessSample(
  orgId: string,
  deviceId: string,
  timestamp: Date,
  processes: Array<{ name: string; pid: number; cpu: number; ramMb: number; diskBps?: number; netBps?: number }>,
): Promise<void> {
  await getTestDb().insert(deviceProcessSamples).values({ orgId, deviceId, timestamp, topProcesses: processes });
}

async function episodesFor(orgId: string, deviceId: string) {
  return getTestDb()
    .select()
    .from(metricAnomalyEpisodes)
    .where(and(eq(metricAnomalyEpisodes.orgId, orgId), eq(metricAnomalyEpisodes.deviceId, deviceId)))
    .orderBy(asc(metricAnomalyEpisodes.firstSeenAt));
}

async function anomalyById(id: string) {
  const [row] = await getTestDb().select().from(metricAnomalies).where(eq(metricAnomalies.id, id));
  if (!row) throw new Error(`anomaly ${id} missing`);
  return row;
}

async function membersOf(episodeId: string) {
  return getTestDb()
    .select()
    .from(metricAnomalies)
    .where(eq(metricAnomalies.episodeId, episodeId))
    .orderBy(asc(metricAnomalies.windowStart));
}

// The `episodes` stage runs inside runDetectionStage's system context; calling
// the function directly needs one too.
async function assemble(orgId: string) {
  const to = floorToBucket(new Date());
  return withSystemDbAccessContext(() => assembleMetricAnomalyEpisodes({ orgId, from: at(to, -15), to }));
}

describe('metric anomaly episode assembly (spec §6, §9)', () => {
  let orgId: string;
  let siteId: string;
  let now: Date;

  beforeEach(async () => {
    const partner = await createPartner();
    orgId = (await createOrganization({ partnerId: partner.id, name: 'Episode Org' })).id;
    await enableAnomalies(orgId);
    siteId = (await createSite({ orgId, name: 'Episode Site' })).id;
    now = floorToBucket(new Date());
  });

  it('collapses 17 consecutive disk-write buckets into one open episode with correct peak fields', async () => {
    const device = await insertDevice(orgId, siteId);
    const start = at(now, -120);
    const ids: string[] = [];
    for (let i = 0; i < 17; i++) {
      ids.push(await insertAnomaly({
        orgId, deviceId: device, windowStart: at(start, i * 5), metricType: 'disk', metricName: 'disk_write_bps',
        score: i === 8 ? 20 : 5, observedValue: i === 8 ? 153e6 : 86e6, baselineValue: i === 8 ? 11e6 : 5.5e6,
      }));
    }

    await assemble(orgId);
    await assemble(orgId); // idempotent: nothing left unassigned, nothing changes

    const episodes = await episodesFor(orgId, device);
    expect(episodes).toHaveLength(1);
    const episode = episodes[0]!;
    expect(episode).toMatchObject({
      status: 'open',
      closeReason: null,
      episodeKey: 'device_metrics:spike:disk_write',
      metricFamily: 'disk_write',
      metricNames: ['disk_write_bps'],
      bucketCount: 17,
      peakValue: 153e6,
      peakMetricName: 'disk_write_bps',
      peakBaselineValue: 11e6,
      peakScore: 20,
      recurrenceCount: 0,
    });
    expect(episode.firstSeenAt.toISOString()).toBe(start.toISOString());
    expect(episode.lastSeenAt.toISOString()).toBe(at(start, 85).toISOString());
    expect(episode.peakAt.toISOString()).toBe(at(start, 40).toISOString());
    const members = await membersOf(episode.id);
    expect(members.map((member) => member.id).sort()).toEqual([...ids].sort());
    expect(members.every((member) => member.status === 'open')).toBe(true);
  });

  it('merges the process ram _sum/_max pair into one episode', async () => {
    const device = await insertDevice(orgId, siteId);
    const start = at(now, -60);
    for (let i = 0; i < 5; i++) {
      for (const metricName of ['top_process_ram_mb_sum', 'top_process_ram_mb_max']) {
        await insertAnomaly({
          orgId, deviceId: device, windowStart: at(start, i * 5), sourceTable: 'device_process_samples', metricType: 'process',
          metricName, anomalyType: 'process_runaway',
          score: metricName === 'top_process_ram_mb_max' && i === 2 ? 9 : 4,
          observedValue: metricName === 'top_process_ram_mb_max' && i === 2 ? 2355 : 6500,
        });
      }
    }

    await assemble(orgId);

    const episodes = await episodesFor(orgId, device);
    expect(episodes).toHaveLength(1);
    expect(episodes[0]).toMatchObject({
      episodeKey: 'device_process_samples:process_runaway:process_ram',
      metricNames: ['top_process_ram_mb_max', 'top_process_ram_mb_sum'],
      bucketCount: 5,
      peakMetricName: 'top_process_ram_mb_max',
      peakValue: 2355,
    });
    expect(await membersOf(episodes[0]!.id)).toHaveLength(10);
  });

  it('splits two bursts 31 minutes apart: the first closes (cleared on clean data), the second has recurrence_count 1', async () => {
    const device = await insertDevice(orgId, siteId);
    const start = at(now, -180);
    for (const minute of [0, 5, 10]) await insertAnomaly({ orgId, deviceId: device, windowStart: at(start, minute) });
    await assemble(orgId);
    const [first] = await episodesFor(orgId, device);
    expect(first).toMatchObject({ status: 'open', bucketCount: 3 });

    // Six clean cpu buckets between the bursts, then a bucket 31 minutes after the first burst ended (at +15).
    await insertRollups({ orgId, deviceId: device, metricName: 'cpu_percent', starts: bucketsFrom(at(start, 15), 6), value: () => 20 });
    const late = await insertAnomaly({ orgId, deviceId: device, windowStart: at(start, 46) });
    const closed = await assemble(orgId);

    const episodes = await episodesFor(orgId, device);
    expect(episodes).toHaveLength(2);
    expect(episodes[0]).toMatchObject({ id: first!.id, status: 'resolved', closeReason: 'cleared', resolvedByUserId: null });
    expect(episodes[0]!.resolvedAt).not.toBeNull();
    expect(episodes[1]).toMatchObject({ status: 'open', recurrenceCount: 1, bucketCount: 1 });
    expect((await anomalyById(late)).episodeId).toBe(episodes[1]!.id);
    expect((await membersOf(first!.id)).every((member) => member.status === 'cleared')).toBe(true);
    expect(closed).toEqual([{ episodeId: first!.id, deviceId: device, linkedAlertId: null, closeReason: 'cleared' }]);
  });

  it('keeps a bucket exactly 30 minutes after the burst in the same episode', async () => {
    const device = await insertDevice(orgId, siteId);
    const start = at(now, -180);
    for (const minute of [0, 5, 10, 45]) await insertAnomaly({ orgId, deviceId: device, windowStart: at(start, minute) });

    await assemble(orgId);

    const episodes = await episodesFor(orgId, device);
    expect(episodes).toHaveLength(1);
    expect(episodes[0]).toMatchObject({ status: 'open', bucketCount: 4 });
  });

  it('in one batch, closes the older burst as history (expired_no_data without clean data) and opens the newer', async () => {
    const device = await insertDevice(orgId, siteId);
    const start = at(now, -180);
    for (const minute of [0, 5, 10, 46]) await insertAnomaly({ orgId, deviceId: device, windowStart: at(start, minute) });

    await assemble(orgId);

    const episodes = await episodesFor(orgId, device);
    expect(episodes).toHaveLength(2);
    expect(episodes[0]).toMatchObject({ status: 'resolved', closeReason: 'expired_no_data', bucketCount: 3 });
    expect(episodes[0]!.resolvedAt!.toISOString()).toBe(at(start, 46).toISOString());
    expect(episodes[1]).toMatchObject({ status: 'open', recurrenceCount: 1 });
    expect((await membersOf(episodes[0]!.id)).every((member) => member.status === 'cleared')).toBe(true);
  });

  it('backfill lower bound: a months-old style orphan never rewrites first_seen_at of today\'s episode', async () => {
    const device = await insertDevice(orgId, siteId);
    const start = at(now, -60);
    const episodeId = await insertEpisode({ orgId, deviceId: device, firstSeenAt: start, lastSeenAt: at(start, 15) });
    for (const minute of [0, 5, 10]) await insertAnomaly({ orgId, deviceId: device, windowStart: at(start, minute), episodeId });
    const orphan = await insertAnomaly({ orgId, deviceId: device, windowStart: at(now, -300) });
    const near = await insertAnomaly({ orgId, deviceId: device, windowStart: at(start, -30) }); // ends 25 min before first_seen_at

    await assemble(orgId);

    const episodes = await episodesFor(orgId, device);
    expect(episodes).toHaveLength(2);
    const current = episodes.find((episode) => episode.id === episodeId)!;
    expect(current).toMatchObject({ status: 'open', bucketCount: 4 });
    expect(current.firstSeenAt.toISOString()).toBe(at(start, -30).toISOString());
    expect((await anomalyById(near)).episodeId).toBe(episodeId);
    const history = episodes.find((episode) => episode.id !== episodeId)!;
    expect(history).toMatchObject({ status: 'resolved', closeReason: 'expired_no_data', bucketCount: 1 });
    expect(history.resolvedAt!.toISOString()).toBe(at(start, -30).toISOString());
    expect((await anomalyById(orphan)).episodeId).toBe(history.id);
  });

  it('snooze: a new bucket 10 minutes after a user dismiss creates a silent successor, later buckets extend it', async () => {
    const device = await insertDevice(orgId, siteId);
    const snoozedUntil = at(now, 7 * 24 * 60);
    await insertEpisode({
      orgId, deviceId: device, firstSeenAt: at(now, -40), lastSeenAt: at(now, -30),
      status: 'dismissed', closeReason: 'user', snoozedUntil, resolvedAt: at(now, -25),
    });
    const member = await insertAnomaly({ orgId, deviceId: device, windowStart: at(now, -20) });

    await assemble(orgId);

    let episodes = await episodesFor(orgId, device);
    expect(episodes).toHaveLength(2);
    const successor = episodes[1]!;
    expect(successor).toMatchObject({ status: 'dismissed', closeReason: 'snoozed', recurrenceCount: 1, resolvedByUserId: null });
    expect(successor.snoozedUntil!.toISOString()).toBe(snoozedUntil.toISOString());
    expect(successor.resolvedAt).not.toBeNull();
    expect(await anomalyById(member)).toMatchObject({ status: 'dismissed', episodeId: successor.id });
    const feedback = await getTestDb().select().from(mlFeedbackEvents).where(eq(mlFeedbackEvents.sourceId, member));
    expect(feedback).toHaveLength(0);

    const next = await insertAnomaly({ orgId, deviceId: device, windowStart: at(now, -15) });
    await assemble(orgId);

    episodes = await episodesFor(orgId, device);
    expect(episodes).toHaveLength(2);
    expect(episodes[1]).toMatchObject({ id: successor.id, bucketCount: 2 });
    expect(await anomalyById(next)).toMatchObject({ status: 'dismissed', episodeId: successor.id });
  });

  it('snapshots the top 3 processes at open and at peak, and overwrites only the peak when it grows', async () => {
    const device = await insertDevice(orgId, siteId);
    const start = at(now, -60);
    const ramRow = (minute: number, score: number) => insertAnomaly({
      orgId, deviceId: device, windowStart: at(start, minute), sourceTable: 'device_process_samples', metricType: 'process',
      metricName: 'top_process_ram_mb_max', anomalyType: 'process_runaway', score,
    });
    await ramRow(0, 4);
    await ramRow(5, 6);
    await ramRow(10, 9);
    await insertProcessSample(orgId, device, at(start, 1), [
      { name: 'a.exe', pid: 1, cpu: 1, ramMb: 100 },
      { name: 'b.exe', pid: 2, cpu: 1, ramMb: 300 },
      { name: 'c.exe', pid: 3, cpu: 1, ramMb: 200 },
      { name: 'd.exe', pid: 4, cpu: 1, ramMb: 50 },
    ]);
    await insertProcessSample(orgId, device, at(start, 11), [
      { name: 'chrome.exe', pid: 4120, cpu: 3, ramMb: 1932.5 },
      { name: 'MsMpEng.exe', pid: 900, cpu: 1, ramMb: 400 },
      { name: 'Teams.exe', pid: 77, cpu: 1, ramMb: 300 },
      { name: 'x.exe', pid: 5, cpu: 1, ramMb: 10 },
    ]);

    await assemble(orgId);

    let [episode] = await episodesFor(orgId, device);
    expect(episode!.attribution).toEqual({
      opened: {
        sampledAt: at(start, 1).toISOString(),
        dimension: 'ramMb',
        processes: [
          { name: 'b.exe', pid: 2, value: 300 },
          { name: 'c.exe', pid: 3, value: 200 },
          { name: 'a.exe', pid: 1, value: 100 },
        ],
      },
      peak: {
        sampledAt: at(start, 11).toISOString(),
        dimension: 'ramMb',
        processes: [
          { name: 'chrome.exe', pid: 4120, value: 1932.5 },
          { name: 'MsMpEng.exe', pid: 900, value: 400 },
          { name: 'Teams.exe', pid: 77, value: 300 },
        ],
      },
    });

    // A new, higher peak at +15 moves only `peak`.
    await ramRow(15, 20);
    await insertProcessSample(orgId, device, at(start, 16), [{ name: 'backup.exe', pid: 42, cpu: 9, ramMb: 5000 }]);
    await assemble(orgId);

    [episode] = await episodesFor(orgId, device);
    expect(episode!.attribution?.opened?.processes.map((p) => p.name)).toEqual(['b.exe', 'c.exe', 'a.exe']);
    expect(episode!.attribution?.peak).toEqual({
      sampledAt: at(start, 16).toISOString(),
      dimension: 'ramMb',
      processes: [{ name: 'backup.exe', pid: 42, value: 5000 }],
    });
  });

  it('stores an empty process list when the dimension is absent, and NULL when no sample is near', async () => {
    const diskDevice = await insertDevice(orgId, siteId);
    const start = at(now, -60);
    await insertAnomaly({ orgId, deviceId: diskDevice, windowStart: start, metricType: 'disk', metricName: 'disk_write_bps' });
    await insertProcessSample(orgId, diskDevice, at(start, 1), [{ name: 'svchost.exe', pid: 8, cpu: 1, ramMb: 20 }]);
    const quietDevice = await insertDevice(orgId, siteId);
    await insertAnomaly({ orgId, deviceId: quietDevice, windowStart: start });
    const countDevice = await insertDevice(orgId, siteId);
    await insertAnomaly({ orgId, deviceId: countDevice, windowStart: start, metricType: 'process', metricName: 'process_count', anomalyType: 'process_runaway' });
    await insertProcessSample(orgId, countDevice, at(start, 1), [{ name: 'a.exe', pid: 1, cpu: 1, ramMb: 1 }]);

    await assemble(orgId);

    const [disk] = await episodesFor(orgId, diskDevice);
    expect(disk!.attribution?.opened?.processes).toEqual([]);
    expect(disk!.attribution?.peak?.dimension).toBe('diskBps');
    const [quiet] = await episodesFor(orgId, quietDevice);
    expect(quiet!.attribution).toBeNull();
    const [count] = await episodesFor(orgId, countDevice);
    expect(count!.attribution).toBeNull(); // process_count has no attribution dimension
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/metricAnomalyEpisodes.integration.test.ts`
Expected: FAIL — cannot resolve `../../services/metricAnomalyEpisodes`.

- [ ] **Step 4: Implement assembly**

`apps/api/src/services/metricAnomalyEpisodes.ts`:

```ts
import { and, asc, eq, gt, gte, isNull, max, or, sql, type SQL } from 'drizzle-orm';
import type { AttributionDimension } from '@breeze/shared';

import { db } from '../db';
import { metricAnomalies, metricAnomalyEpisodes } from '../db/schema';
import type { MetricAnomalyRange } from './metricAnomalies';
import {
  EPISODE_ASSEMBLY_LOOKBACK_HOURS,
  EPISODE_BUCKET_SECONDS,
  EPISODE_CLEAN_BUCKETS,
  EPISODE_GAP_MINUTES,
  EPISODE_RECURRENCE_DAYS,
} from './metricAnomalyEpisodeKeys';
import {
  groupKeyOf,
  memberStatusFor,
  planEpisodeAssembly,
  type AnchorEpisode,
  type MemberStatus,
  type PlannedEpisode,
  type PlannedSupersede,
} from './metricAnomalyEpisodePlanner';

/**
 * Metric anomaly episodes — assembly (`episodes` stage) and auto-resolve
 * (`episode-resolve` stage). Spec:
 * docs/superpowers/specs/monitoring/2026-09-21-metric-anomaly-episodes-design.md
 *
 * Every exported DB function here expects to run INSIDE a system DB context —
 * `runDetectionStage` (services/metricAnomalies.ts) provides one per stage,
 * with the per-org advisory lock and the lock/statement timeouts. Nothing here
 * opens its own context. All statements are set-based and scoped to one org.
 *
 * Timestamps: episode and anomaly columns are naive UTC `timestamp`. Raw SQL
 * binds ISO strings as `::timestamp`; raw SQL never RETURNS a timestamp to
 * TypeScript (postgres-js hands those back as zone-less strings). Typed reads
 * go through the Drizzle query builder.
 */

// The contract path for the constants and episodeKeyFor (plan index).
export * from './metricAnomalyEpisodeKeys';

export type EpisodeAutoCloseReason = 'cleared' | 'expired_offline' | 'expired_no_data';

export interface EpisodeCloseResult {
  episodeId: string;
  deviceId: string;
  linkedAlertId: string | null;
  closeReason: EpisodeAutoCloseReason;
}

const AUTO_CLOSE_REASONS: ReadonlySet<string> = new Set(['cleared', 'expired_offline', 'expired_no_data']);

function resultRows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  const rows = (result as { rows?: unknown } | null)?.rows;
  return Array.isArray(rows) ? (rows as T[]) : [];
}

function toCloseResults(result: unknown): EpisodeCloseResult[] {
  return resultRows<{ episodeId?: unknown; deviceId?: unknown; linkedAlertId?: unknown; closeReason?: unknown }>(result)
    .filter((row) => typeof row.episodeId === 'string'
      && typeof row.deviceId === 'string'
      && typeof row.closeReason === 'string'
      && AUTO_CLOSE_REASONS.has(row.closeReason))
    .map((row) => ({
      episodeId: row.episodeId as string,
      deviceId: row.deviceId as string,
      linkedAlertId: typeof row.linkedAlertId === 'string' ? row.linkedAlertId : null,
      closeReason: row.closeReason as EpisodeAutoCloseReason,
    }));
}

/**
 * Minimum, over the episode's metric names, of observed clean 5-minute rollup
 * buckets in [from, until). "Clean by construction": any anomalous bucket in
 * that range would have been attached and moved last_seen_at. Arguments are
 * SQL column expressions written in this file (never user input).
 */
function minCleanBucketsSql(
  orgId: string,
  cols: { deviceId: string; sourceTable: string; metricNames: string; from: string; until: string | null },
): SQL {
  const until = cols.until ? sql.raw(`AND mr.bucket_start < ${cols.until}`) : sql.raw('');
  return sql`(
    SELECT min(clean.n)
    FROM unnest(${sql.raw(cols.metricNames)}) AS m(metric_name)
    CROSS JOIN LATERAL (
      SELECT count(*)::integer AS n
      FROM metric_rollups mr
      WHERE mr.org_id = ${orgId}
        AND mr.device_id = ${sql.raw(cols.deviceId)}
        AND mr.source_table = ${sql.raw(cols.sourceTable)}
        AND mr.metric_name = m.metric_name
        AND mr.bucket_seconds = ${EPISODE_BUCKET_SECONDS}
        AND mr.bucket_start >= ${sql.raw(cols.from)}
        ${until}
        AND mr.sample_count > 0
    ) clean
  )`;
}

/**
 * One device_process_samples row nearest the bucket midpoint within
 * [anchor − 5 min, anchor + 10 min], reduced to the top 3 processes by the
 * target's `dimension` (spec §9). Used as a LATERAL over `e` (episode) and
 * `t` (target row carrying `dimension`).
 */
function processSnapshotSql(anchorColumn: 'e.first_seen_at' | 'e.peak_at'): SQL {
  const anchorTz = sql.raw(`(${anchorColumn} AT TIME ZONE 'UTC')`);
  return sql`
    SELECT jsonb_build_object(
      'sampledAt', to_char(s."timestamp" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'dimension', t.dimension,
      'processes', COALESCE((
        SELECT jsonb_agg(
          jsonb_build_object(
            'name', picked.value ->> 'name',
            'pid', (picked.value ->> 'pid')::numeric::integer,
            'value', (picked.value ->> t.dimension)::double precision
          )
          ORDER BY (picked.value ->> t.dimension)::double precision DESC
        )
        FROM (
          SELECT proc.value
          FROM jsonb_array_elements(s.top_processes) AS proc(value)
          WHERE jsonb_typeof(proc.value -> t.dimension) = 'number'
          ORDER BY (proc.value ->> t.dimension)::double precision DESC
          LIMIT 3
        ) picked
      ), '[]'::jsonb)
    ) AS snap
    FROM device_process_samples s
    WHERE s.device_id = e.device_id
      AND s."timestamp" >= ${anchorTz} - interval '5 minutes'
      AND s."timestamp" <= ${anchorTz} + interval '10 minutes'
    ORDER BY abs(extract(epoch FROM (s."timestamp" - (${anchorTz} + interval '150 seconds'))))
    LIMIT 1
  `;
}

async function attachMembers(
  orgId: string,
  attaches: ReadonlyArray<{ anomalyId: string; episodeId: string; memberStatus: MemberStatus }>,
  nowIso: string,
): Promise<void> {
  if (attaches.length === 0) return;
  const payload = JSON.stringify(attaches.map((attach) => ({
    anomaly_id: attach.anomalyId,
    episode_id: attach.episodeId,
    member_status: attach.memberStatus,
  })));
  await db.execute(sql`
    UPDATE metric_anomalies ma
    SET episode_id = p.episode_id,
        status = p.member_status,
        resolved_at = CASE WHEN p.member_status = 'open' THEN ma.resolved_at ELSE ${nowIso}::timestamp END,
        updated_at = ${nowIso}::timestamp
    FROM jsonb_to_recordset(${payload}::jsonb) AS p(anomaly_id uuid, episode_id uuid, member_status text)
    WHERE ma.id = p.anomaly_id
      AND ma.org_id = ${orgId}
      AND ma.episode_id IS NULL
      AND ma.status = 'open'
      AND EXISTS (
        SELECT 1 FROM metric_anomaly_episodes e
        WHERE e.id = p.episode_id AND e.org_id = ${orgId}
      )
  `);
}

/**
 * Recompute bounds, bucket_count, metric_names and peak from ALL members.
 * Idempotent by construction. Returns the ids whose peak moved (they need a
 * fresh `peak` attribution snapshot).
 */
async function recomputeEpisodeAggregates(orgId: string, episodeIds: readonly string[], nowIso: string): Promise<string[]> {
  if (episodeIds.length === 0) return [];
  const ids = JSON.stringify(episodeIds);
  const result = await db.execute(sql`
    WITH target AS (
      SELECT (jsonb_array_elements_text(${ids}::jsonb))::uuid AS episode_id
    ),
    agg AS (
      SELECT
        ma.episode_id,
        min(ma.window_start) AS first_seen_at,
        max(ma.window_end) AS last_seen_at,
        count(DISTINCT ma.window_start)::integer AS bucket_count,
        array_agg(DISTINCT ma.metric_name::text ORDER BY ma.metric_name::text) AS metric_names
      FROM metric_anomalies ma
      JOIN target t ON t.episode_id = ma.episode_id
      WHERE ma.org_id = ${orgId}
      GROUP BY ma.episode_id
    ),
    peak AS (
      SELECT DISTINCT ON (ma.episode_id)
        ma.episode_id, ma.observed_value, ma.metric_name, ma.baseline_value, ma.score, ma.window_start
      FROM metric_anomalies ma
      JOIN target t ON t.episode_id = ma.episode_id
      WHERE ma.org_id = ${orgId}
      ORDER BY ma.episode_id, ma.score DESC, ma.window_start ASC
    )
    UPDATE metric_anomaly_episodes e
    SET first_seen_at = a.first_seen_at,
        last_seen_at = a.last_seen_at,
        bucket_count = a.bucket_count,
        metric_names = a.metric_names,
        peak_value = pk.observed_value,
        peak_metric_name = pk.metric_name,
        peak_baseline_value = pk.baseline_value,
        peak_score = pk.score,
        peak_at = pk.window_start,
        updated_at = ${nowIso}::timestamp
    FROM agg a
    JOIN peak pk ON pk.episode_id = a.episode_id
    JOIN metric_anomaly_episodes prior ON prior.id = a.episode_id
    WHERE e.id = a.episode_id
      AND e.org_id = ${orgId}
    RETURNING
      e.id::text AS "episodeId",
      (prior.peak_at IS DISTINCT FROM pk.window_start OR prior.peak_score IS DISTINCT FROM pk.score) AS "peakChanged"
  `);
  return resultRows<{ episodeId: string; peakChanged: boolean }>(result)
    .filter((row) => row.peakChanged === true)
    .map((row) => row.episodeId);
}

/** Deviation 1: an open episode whose key has a newer island beyond the gap. */
async function closeSupersededEpisodes(
  orgId: string,
  supersedes: readonly PlannedSupersede[],
  nowIso: string,
): Promise<EpisodeCloseResult[]> {
  if (supersedes.length === 0) return [];
  const payload = JSON.stringify(supersedes.map((item) => ({
    episode_id: item.episodeId,
    clean_until: item.cleanUntil.toISOString(),
  })));
  const cleanBuckets = minCleanBucketsSql(orgId, {
    deviceId: 'e.device_id',
    sourceTable: 'e.source_table',
    metricNames: 'e.metric_names',
    from: 'e.last_seen_at',
    until: 't.clean_until',
  });
  const result = await db.execute(sql`
    WITH target AS (
      SELECT p.episode_id, p.clean_until
      FROM jsonb_to_recordset(${payload}::jsonb) AS p(episode_id uuid, clean_until timestamp)
    ),
    decided AS (
      SELECT
        e.id,
        CASE WHEN ${cleanBuckets} >= ${EPISODE_CLEAN_BUCKETS} THEN 'cleared' ELSE 'expired_no_data' END AS close_reason
      FROM metric_anomaly_episodes e
      JOIN target t ON t.episode_id = e.id
      WHERE e.org_id = ${orgId}
        AND e.status = 'open'
    ),
    closed AS (
      UPDATE metric_anomaly_episodes e
      SET status = 'resolved',
          close_reason = d.close_reason,
          resolved_at = ${nowIso}::timestamp,
          updated_at = ${nowIso}::timestamp
      FROM decided d
      WHERE e.id = d.id
        AND e.status = 'open'
      RETURNING e.id, e.device_id, e.linked_alert_id, e.close_reason
    ),
    cleared_members AS (
      UPDATE metric_anomalies ma
      SET status = 'cleared',
          resolved_at = ${nowIso}::timestamp,
          updated_at = ${nowIso}::timestamp
      FROM closed c
      WHERE ma.episode_id = c.id
        AND ma.org_id = ${orgId}
        AND ma.status = 'open'
      RETURNING ma.id
    )
    SELECT
      c.id::text AS "episodeId",
      c.device_id::text AS "deviceId",
      c.linked_alert_id::text AS "linkedAlertId",
      c.close_reason AS "closeReason"
    FROM closed c
  `);
  return toCloseResults(result);
}

async function insertPlannedEpisodes(orgId: string, creates: readonly PlannedEpisode[], nowIso: string): Promise<void> {
  if (creates.length === 0) return;
  const payload = JSON.stringify(creates.map((create) => ({
    id: create.id,
    device_id: create.deviceId,
    episode_key: create.episodeKey,
    source_table: create.sourceTable,
    anomaly_type: create.anomalyType,
    metric_family: create.metricFamily,
    metric_names: create.metricNames,
    disposition: create.disposition,
    first_seen_at: create.firstSeenAt.toISOString(),
    last_seen_at: create.lastSeenAt.toISOString(),
    clean_until: create.cleanUntil?.toISOString() ?? null,
    bucket_count: create.bucketCount,
    peak_value: create.peakValue,
    peak_metric_name: create.peakMetricName,
    peak_baseline_value: create.peakBaselineValue,
    peak_score: create.peakScore,
    peak_at: create.peakAt.toISOString(),
    prior_in_batch: create.priorInBatch,
    snoozed_until: create.snoozedUntil?.toISOString() ?? null,
  })));
  const historicalCleanBuckets = minCleanBucketsSql(orgId, {
    deviceId: 'p.device_id',
    sourceTable: 'p.source_table',
    metricNames: 'p.metric_names',
    from: 'p.last_seen_at',
    until: 'p.clean_until',
  });
  // ON CONFLICT on the partial unique index: under the org advisory lock the
  // planner already saw every open episode, so a conflict means a writer that
  // does not take the lock. DO NOTHING leaves those rows unassigned (the
  // member UPDATE requires the episode to exist) for the next tick — never a
  // 23505 out of the stage.
  await db.execute(sql`
    INSERT INTO metric_anomaly_episodes (
      id, org_id, device_id, episode_key, source_table, anomaly_type, metric_family, metric_names,
      status, close_reason, first_seen_at, last_seen_at, bucket_count,
      peak_value, peak_metric_name, peak_baseline_value, peak_score, peak_at,
      recurrence_count, snoozed_until, resolved_at, created_at, updated_at
    )
    SELECT
      p.id,
      ${orgId}::uuid,
      p.device_id,
      p.episode_key,
      p.source_table,
      p.anomaly_type,
      p.metric_family,
      p.metric_names,
      CASE p.disposition WHEN 'open' THEN 'open' WHEN 'snoozed' THEN 'dismissed' ELSE 'resolved' END,
      CASE p.disposition
        WHEN 'open' THEN NULL
        WHEN 'snoozed' THEN 'snoozed'
        ELSE CASE WHEN ${historicalCleanBuckets} >= ${EPISODE_CLEAN_BUCKETS} THEN 'cleared' ELSE 'expired_no_data' END
      END,
      p.first_seen_at,
      p.last_seen_at,
      p.bucket_count,
      p.peak_value,
      p.peak_metric_name,
      p.peak_baseline_value,
      p.peak_score,
      p.peak_at,
      p.prior_in_batch + (
        SELECT count(*)::integer
        FROM metric_anomaly_episodes x
        WHERE x.org_id = ${orgId}
          AND x.device_id = p.device_id
          AND x.episode_key = p.episode_key
          AND x.status <> 'open'
          AND x.resolved_at >= ${nowIso}::timestamp - (${EPISODE_RECURRENCE_DAYS} * interval '1 day')
      ),
      p.snoozed_until,
      CASE p.disposition WHEN 'open' THEN NULL WHEN 'snoozed' THEN ${nowIso}::timestamp ELSE p.clean_until END,
      ${nowIso}::timestamp,
      ${nowIso}::timestamp
    FROM jsonb_to_recordset(${payload}::jsonb) AS p(
      id uuid,
      device_id uuid,
      episode_key text,
      source_table text,
      anomaly_type text,
      metric_family text,
      metric_names text[],
      disposition text,
      first_seen_at timestamp,
      last_seen_at timestamp,
      clean_until timestamp,
      bucket_count integer,
      peak_value double precision,
      peak_metric_name text,
      peak_baseline_value double precision,
      peak_score double precision,
      peak_at timestamp,
      prior_in_batch integer,
      snoozed_until timestamp
    )
    ON CONFLICT (device_id, episode_key) WHERE status = 'open' DO NOTHING
  `);
}

async function writeAttribution(
  orgId: string,
  targets: ReadonlyArray<{ episodeId: string; dimension: AttributionDimension; writeOpened: boolean }>,
  nowIso: string,
): Promise<void> {
  if (targets.length === 0) return;
  const payload = JSON.stringify(targets.map((target) => ({
    episode_id: target.episodeId,
    dimension: target.dimension,
    write_opened: target.writeOpened,
  })));
  await db.execute(sql`
    WITH target AS (
      SELECT p.episode_id, p.dimension, p.write_opened
      FROM jsonb_to_recordset(${payload}::jsonb) AS p(episode_id uuid, dimension text, write_opened boolean)
    ),
    snaps AS (
      SELECT e.id, t.write_opened, opened.snap AS opened_snap, peak.snap AS peak_snap
      FROM target t
      JOIN metric_anomaly_episodes e ON e.id = t.episode_id AND e.org_id = ${orgId}
      LEFT JOIN LATERAL (${processSnapshotSql('e.first_seen_at')}) opened ON t.write_opened
      LEFT JOIN LATERAL (${processSnapshotSql('e.peak_at')}) peak ON true
    )
    UPDATE metric_anomaly_episodes e
    SET attribution = NULLIF(
          jsonb_strip_nulls(jsonb_build_object(
            'opened', CASE WHEN s.write_opened THEN s.opened_snap ELSE e.attribution -> 'opened' END,
            'peak', s.peak_snap
          )),
          '{}'::jsonb
        ),
        updated_at = ${nowIso}::timestamp
    FROM snaps s
    WHERE e.id = s.id
  `);
}

/**
 * `episodes` stage (spec §6). Reads the org's unassigned open rows inside the
 * lookback, plans islands in TypeScript, then applies the plan in a fixed
 * order: attach to existing episodes -> recompute them -> close superseded
 * ones (their last_seen_at is now current) -> insert new episodes -> attach
 * their members -> recompute them -> attribution. Returns the episodes it
 * superseded so the caller can hand them to the close handler.
 */
export async function assembleMetricAnomalyEpisodes(range: MetricAnomalyRange): Promise<EpisodeCloseResult[]> {
  const now = new Date();
  const nowIso = now.toISOString();
  const lookbackStart = new Date(now.getTime() - EPISODE_ASSEMBLY_LOOKBACK_HOURS * 3_600_000);

  const rows = await db
    .select({
      id: metricAnomalies.id,
      deviceId: metricAnomalies.deviceId,
      sourceTable: metricAnomalies.sourceTable,
      anomalyType: metricAnomalies.anomalyType,
      metricName: metricAnomalies.metricName,
      windowStart: metricAnomalies.windowStart,
      windowEnd: metricAnomalies.windowEnd,
      score: metricAnomalies.score,
      observedValue: metricAnomalies.observedValue,
      baselineValue: metricAnomalies.baselineValue,
    })
    .from(metricAnomalies)
    .where(and(
      eq(metricAnomalies.orgId, range.orgId),
      isNull(metricAnomalies.episodeId),
      eq(metricAnomalies.status, 'open'),
      gte(metricAnomalies.windowStart, lookbackStart),
    ))
    .orderBy(asc(metricAnomalies.deviceId), asc(metricAnomalies.windowStart));
  if (rows.length === 0) return [];

  const anchorRows = await db
    .select({
      id: metricAnomalyEpisodes.id,
      deviceId: metricAnomalyEpisodes.deviceId,
      episodeKey: metricAnomalyEpisodes.episodeKey,
      status: metricAnomalyEpisodes.status,
      firstSeenAt: metricAnomalyEpisodes.firstSeenAt,
      lastSeenAt: metricAnomalyEpisodes.lastSeenAt,
    })
    .from(metricAnomalyEpisodes)
    .where(and(
      eq(metricAnomalyEpisodes.orgId, range.orgId),
      or(
        eq(metricAnomalyEpisodes.status, 'open'),
        and(
          eq(metricAnomalyEpisodes.status, 'dismissed'),
          eq(metricAnomalyEpisodes.closeReason, 'snoozed'),
          gt(metricAnomalyEpisodes.snoozedUntil, now),
        ),
      ),
    ));
  const anchors: AnchorEpisode[] = anchorRows.map((anchor) => ({
    ...anchor,
    status: anchor.status === 'open' ? 'open' : 'dismissed',
  }));

  const snoozeRows = await db
    .select({
      deviceId: metricAnomalyEpisodes.deviceId,
      episodeKey: metricAnomalyEpisodes.episodeKey,
      snoozedUntil: max(metricAnomalyEpisodes.snoozedUntil),
    })
    .from(metricAnomalyEpisodes)
    .where(and(
      eq(metricAnomalyEpisodes.orgId, range.orgId),
      eq(metricAnomalyEpisodes.status, 'dismissed'),
      gt(metricAnomalyEpisodes.snoozedUntil, now),
    ))
    .groupBy(metricAnomalyEpisodes.deviceId, metricAnomalyEpisodes.episodeKey);
  const activeSnoozes = new Map<string, Date>();
  for (const snooze of snoozeRows) {
    if (snooze.snoozedUntil) activeSnoozes.set(groupKeyOf(snooze.deviceId, snooze.episodeKey), snooze.snoozedUntil);
  }

  const plan = planEpisodeAssembly({ rows, anchors, activeSnoozes, gapMinutes: EPISODE_GAP_MINUTES });

  await attachMembers(range.orgId, plan.anchorAttaches, nowIso);
  const anchorIds = [...new Set(plan.anchorAttaches.map((attach) => attach.episodeId))];
  const anchorPeakMoved = new Set(await recomputeEpisodeAggregates(range.orgId, anchorIds, nowIso));

  const superseded = await closeSupersededEpisodes(range.orgId, plan.supersedes, nowIso);

  await insertPlannedEpisodes(range.orgId, plan.creates, nowIso);
  await attachMembers(
    range.orgId,
    plan.creates.flatMap((create) => create.memberIds.map((anomalyId) => ({
      anomalyId,
      episodeId: create.id,
      memberStatus: memberStatusFor(create.disposition),
    }))),
    nowIso,
  );
  await recomputeEpisodeAggregates(range.orgId, plan.creates.map((create) => create.id), nowIso);

  const targets: Array<{ episodeId: string; dimension: AttributionDimension; writeOpened: boolean }> = [];
  for (const create of plan.creates) {
    if (create.attributionDimension) {
      targets.push({ episodeId: create.id, dimension: create.attributionDimension, writeOpened: true });
    }
  }
  const anchorDimension = new Map(plan.anchorAttaches.map((attach) => [attach.episodeId, attach.attributionDimension]));
  for (const episodeId of anchorPeakMoved) {
    const dimension = anchorDimension.get(episodeId);
    if (dimension) targets.push({ episodeId, dimension, writeOpened: false });
  }
  await writeAttribution(range.orgId, targets, nowIso);

  return superseded;
}
```

- [ ] **Step 5: Run the integration test to verify it passes**

Run: `cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/metricAnomalyEpisodes.integration.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 6: Typecheck**

Run: `cd apps/api && NODE_OPTIONS=--max-old-space-size=12288 npx tsc --noEmit -p .; echo "exit=$?"`
Expected: `exit=0`.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/services/metricAnomalyEpisodes.ts apps/api/src/__tests__/integration/metricAnomalyEpisodes.integration.test.ts
git commit -m "feat(anomalies): assemble metric anomaly episodes with process attribution" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: Auto-resolve and the close handler

**Files:**
- Modify: `apps/api/src/services/metricAnomalyEpisodes.ts` (imports + append)
- Create: `apps/api/src/services/metricAnomalyEpisodes.test.ts`
- Modify: `apps/api/src/__tests__/integration/metricAnomalyEpisodes.integration.test.ts` (append a `describe`)

**Interfaces:**
- Consumes: `EpisodeCloseResult`, `toCloseResults`, `minCleanBucketsSql` (Task 7), `EPISODE_GAP_MINUTES`, `EPISODE_CLEAN_BUCKETS`, `EPISODE_EXPIRE_HOURS` (Task 5).
- Produces:
  - `resolveMetricAnomalyEpisodes(orgId: string, now?: Date): Promise<EpisodeCloseResult[]>` — must run inside a system DB context
  - `type EpisodeCloseHandler = (orgId: string, closed: EpisodeCloseResult[]) => Promise<void>`
  - `setEpisodeCloseHandler(fn: EpisodeCloseHandler | null): void` — `null` restores the no-op default (W02 wires alert resolve)
  - `notifyEpisodesClosed(orgId: string, closed: EpisodeCloseResult[]): Promise<void>` — never throws

- [ ] **Step 1: Write the failing unit test**

`apps/api/src/services/metricAnomalyEpisodes.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { executeMock, captureExceptionMock } = vi.hoisted(() => ({
  executeMock: vi.fn(),
  captureExceptionMock: vi.fn(),
}));

vi.mock('../db', () => ({ db: { execute: executeMock } }));
vi.mock('./sentry', () => ({ captureException: captureExceptionMock }));

import {
  notifyEpisodesClosed,
  resolveMetricAnomalyEpisodes,
  setEpisodeCloseHandler,
  type EpisodeCloseResult,
} from './metricAnomalyEpisodes';

const ORG = '11111111-1111-1111-1111-111111111111';
const CLOSED: EpisodeCloseResult[] = [
  { episodeId: 'ep-1', deviceId: 'dev-1', linkedAlertId: 'alert-1', closeReason: 'cleared' },
];

describe('episode close handler (W01 hook, W02 wires alert resolve)', () => {
  beforeEach(() => {
    setEpisodeCloseHandler(null);
    captureExceptionMock.mockReset();
  });

  it('is a no-op by default', async () => {
    await expect(notifyEpisodesClosed(ORG, CLOSED)).resolves.toBeUndefined();
  });

  it('hands the closed episodes to the registered handler', async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    setEpisodeCloseHandler(handler);
    await notifyEpisodesClosed(ORG, CLOSED);
    expect(handler).toHaveBeenCalledWith(ORG, CLOSED);
  });

  it('does not call the handler for an empty batch', async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    setEpisodeCloseHandler(handler);
    await notifyEpisodesClosed(ORG, []);
    expect(handler).not.toHaveBeenCalled();
  });

  it('never lets a handler failure fail the detection job', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    setEpisodeCloseHandler(vi.fn().mockRejectedValue(new Error('alert service down')));
    await expect(notifyEpisodesClosed(ORG, CLOSED)).resolves.toBeUndefined();
    expect(captureExceptionMock).toHaveBeenCalledWith(expect.any(Error), undefined, expect.objectContaining({ org_id: ORG }));
  });

  it('restores the no-op when given null', async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    setEpisodeCloseHandler(handler);
    setEpisodeCloseHandler(null);
    await notifyEpisodesClosed(ORG, CLOSED);
    expect(handler).not.toHaveBeenCalled();
  });
});

describe('resolveMetricAnomalyEpisodes (spec §7)', () => {
  beforeEach(() => {
    executeMock.mockReset();
  });

  it('maps closed rows, drops malformed ones, and binds the supplied now', async () => {
    executeMock.mockResolvedValue([
      { episodeId: 'ep-1', deviceId: 'dev-1', linkedAlertId: null, closeReason: 'cleared' },
      { episodeId: 'ep-2', deviceId: 'dev-2', linkedAlertId: 'alert-2', closeReason: 'expired_offline' },
      { episodeId: 'ep-3', deviceId: 'dev-3', linkedAlertId: null, closeReason: 'user' },
      { acquired: true },
    ]);

    const result = await resolveMetricAnomalyEpisodes(ORG, new Date('2026-09-22T12:00:00.000Z'));

    expect(result).toEqual([
      { episodeId: 'ep-1', deviceId: 'dev-1', linkedAlertId: null, closeReason: 'cleared' },
      { episodeId: 'ep-2', deviceId: 'dev-2', linkedAlertId: 'alert-2', closeReason: 'expired_offline' },
    ]);
    const text = JSON.stringify(executeMock.mock.calls[0]);
    expect(text).toContain('2026-09-22T12:00:00.000Z');
    expect(text).toContain('expired_offline');
    expect(text).toContain('expired_no_data');
    expect(text).toContain("SET status = 'cleared'");
    expect(text).toContain("ma.status = 'open'"); // promoted members are never touched
    expect(text).toContain('mr.sample_count > 0');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/api && npx vitest run src/services/metricAnomalyEpisodes.test.ts`
Expected: FAIL — `notifyEpisodesClosed is not a function` / `resolveMetricAnomalyEpisodes is not a function`.

- [ ] **Step 3: Implement resolve and the handler**

In `apps/api/src/services/metricAnomalyEpisodes.ts` add `EPISODE_EXPIRE_HOURS` to the `./metricAnomalyEpisodeKeys` import list and add:

```ts
import { captureException } from './sentry';
```

Append to the file:

```ts
export type EpisodeCloseHandler = (orgId: string, closed: EpisodeCloseResult[]) => Promise<void>;

const noopCloseHandler: EpisodeCloseHandler = async () => {};
let closeHandler: EpisodeCloseHandler = noopCloseHandler;

/**
 * Register what happens after episodes close automatically (auto-resolve,
 * supersede). W01 ships the no-op; W02 registers alert auto-resolve for
 * promoted episodes (`linkedAlertId`). Called OUTSIDE any DB context, after
 * the stage transactions commit — the handler opens its own. Pass null to
 * restore the no-op.
 */
export function setEpisodeCloseHandler(fn: EpisodeCloseHandler | null): void {
  closeHandler = fn ?? noopCloseHandler;
}

export async function notifyEpisodesClosed(orgId: string, closed: EpisodeCloseResult[]): Promise<void> {
  if (closed.length === 0) return;
  try {
    await closeHandler(orgId, closed);
  } catch (error) {
    // The episodes are already closed and committed; a handler fault must not
    // turn a completed detection run into a failed job that re-runs detection.
    console.error(`[MetricAnomalyEpisodes] org=${orgId} close handler failed for ${closed.length} episode(s):`, error);
    captureException(error, undefined, { org_id: orgId, subsystem: 'metric_anomaly_episodes' });
  }
}

/**
 * `episode-resolve` stage (spec §7). For every OPEN episode of the org whose
 * last anomalous bucket ended more than EPISODE_GAP_MINUTES ago:
 *  - cleared          every member metric has >= EPISODE_CLEAN_BUCKETS clean
 *                     5-minute rollups (sample_count > 0) since last_seen_at;
 *  - expired_offline  not cleared, last_seen_at older than EPISODE_EXPIRE_HOURS,
 *                     and the device itself has not been seen for that long;
 *  - expired_no_data  same, but the device is checking in (the series stopped).
 * Closing sets status 'resolved', resolved_at = now, resolved_by_user_id NULL,
 * and moves members still 'open' to 'cleared' (a promoted member keeps its
 * label). Runs whatever `ml.anomalies.enabled` says; never for a backfill.
 */
export async function resolveMetricAnomalyEpisodes(orgId: string, now: Date = new Date()): Promise<EpisodeCloseResult[]> {
  const nowIso = now.toISOString();
  const cleanBuckets = minCleanBucketsSql(orgId, {
    deviceId: 'e.device_id',
    sourceTable: 'e.source_table',
    metricNames: 'e.metric_names',
    from: 'e.last_seen_at',
    until: null,
  });
  const result = await db.execute(sql`
    WITH candidates AS (
      SELECT
        e.id,
        e.last_seen_at,
        d.last_seen_at AS device_last_seen_at,
        ${cleanBuckets} AS min_clean
      FROM metric_anomaly_episodes e
      JOIN devices d ON d.id = e.device_id
      WHERE e.org_id = ${orgId}
        AND e.status = 'open'
        AND e.last_seen_at < ${nowIso}::timestamp - (${EPISODE_GAP_MINUTES} * interval '1 minute')
    ),
    decided AS (
      SELECT
        c.id,
        CASE
          WHEN c.min_clean >= ${EPISODE_CLEAN_BUCKETS} THEN 'cleared'
          WHEN c.last_seen_at < ${nowIso}::timestamp - (${EPISODE_EXPIRE_HOURS} * interval '1 hour') THEN
            CASE
              WHEN c.device_last_seen_at IS NULL
                OR c.device_last_seen_at < ${nowIso}::timestamp - (${EPISODE_EXPIRE_HOURS} * interval '1 hour')
                THEN 'expired_offline'
              ELSE 'expired_no_data'
            END
          ELSE NULL
        END AS close_reason
      FROM candidates c
    ),
    closed AS (
      UPDATE metric_anomaly_episodes e
      SET status = 'resolved',
          close_reason = d.close_reason,
          resolved_at = ${nowIso}::timestamp,
          updated_at = ${nowIso}::timestamp
      FROM decided d
      WHERE e.id = d.id
        AND d.close_reason IS NOT NULL
        AND e.status = 'open'
      RETURNING e.id, e.device_id, e.linked_alert_id, e.close_reason
    ),
    cleared_members AS (
      UPDATE metric_anomalies ma
      SET status = 'cleared',
          resolved_at = ${nowIso}::timestamp,
          updated_at = ${nowIso}::timestamp
      FROM closed c
      WHERE ma.episode_id = c.id
        AND ma.org_id = ${orgId}
        AND ma.status = 'open'
      RETURNING ma.id
    )
    SELECT
      c.id::text AS "episodeId",
      c.device_id::text AS "deviceId",
      c.linked_alert_id::text AS "linkedAlertId",
      c.close_reason AS "closeReason"
    FROM closed c
  `);
  return toCloseResults(result);
}
```

- [ ] **Step 4: Run the unit test to verify it passes**

Run: `cd apps/api && npx vitest run src/services/metricAnomalyEpisodes.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Add the failing auto-resolve integration tests**

In `apps/api/src/__tests__/integration/metricAnomalyEpisodes.integration.test.ts` extend the service import to

```ts
import {
  assembleMetricAnomalyEpisodes,
  resolveMetricAnomalyEpisodes,
} from '../../services/metricAnomalyEpisodes';
import { promoteMetricAnomalyToAlert } from '../../services/metricAnomalyPromotion';
```

and append:

```ts
describe('metric anomaly episode auto-resolve (spec §7)', () => {
  const T0 = new Date('2026-09-01T12:00:00.000Z'); // episode last_seen_at in every case
  let orgId: string;
  let siteId: string;

  beforeEach(async () => {
    const partner = await createPartner();
    orgId = (await createOrganization({ partnerId: partner.id, name: 'Resolve Org' })).id;
    await enableAnomalies(orgId);
    siteId = (await createSite({ orgId, name: 'Resolve Site' })).id;
  });

  async function seedOpenEpisode(
    deviceId: string,
    options: { metricNames?: string[]; sourceTable?: 'device_metrics' | 'device_process_samples'; episodeKey?: string } = {},
  ): Promise<{ episodeId: string; memberIds: string[] }> {
    const metricNames = options.metricNames ?? ['cpu_percent'];
    const sourceTable = options.sourceTable ?? 'device_metrics';
    const episodeId = await insertEpisode({
      orgId, deviceId, firstSeenAt: at(T0, -15), lastSeenAt: T0, metricNames, sourceTable,
      episodeKey: options.episodeKey ?? 'device_metrics:spike:cpu',
      anomalyType: sourceTable === 'device_metrics' ? 'spike' : 'process_runaway',
    });
    const memberIds: string[] = [];
    for (const minute of [-15, -10, -5]) {
      memberIds.push(await insertAnomaly({
        orgId, deviceId, windowStart: at(T0, minute), episodeId, sourceTable, metricName: metricNames[0],
        anomalyType: sourceTable === 'device_metrics' ? 'spike' : 'process_runaway',
      }));
    }
    return { episodeId, memberIds };
  }

  function resolveAt(now: Date) {
    return withSystemDbAccessContext(() => resolveMetricAnomalyEpisodes(orgId, now));
  }

  async function episodeById(id: string) {
    const [row] = await getTestDb().select().from(metricAnomalyEpisodes).where(eq(metricAnomalyEpisodes.id, id));
    return row!;
  }

  it('clears after 6 clean buckets: members cleared, a promoted member untouched, linked alert handed back', async () => {
    const device = await insertDevice(orgId, siteId);
    const { episodeId, memberIds } = await seedOpenEpisode(device);
    const promotion = await withSystemDbAccessContext(() =>
      promoteMetricAnomalyToAlert({ orgId, deviceId: device, anomalyId: memberIds[0]!, requireCreateAlertsFlag: false }),
    );
    if (promotion.status !== 'promoted') throw new Error('expected promotion');
    await getTestDb().update(metricAnomalyEpisodes).set({ linkedAlertId: promotion.alertId }).where(eq(metricAnomalyEpisodes.id, episodeId));
    await insertRollups({ orgId, deviceId: device, metricName: 'cpu_percent', starts: bucketsFrom(T0, 6), value: () => 20 });

    const closed = await resolveAt(at(T0, 40));

    expect(closed).toEqual([{ episodeId, deviceId: device, linkedAlertId: promotion.alertId, closeReason: 'cleared' }]);
    const episode = await episodeById(episodeId);
    expect(episode).toMatchObject({ status: 'resolved', closeReason: 'cleared', resolvedByUserId: null });
    expect(episode.resolvedAt!.toISOString()).toBe(at(T0, 40).toISOString());
    expect((await anomalyById(memberIds[0]!)).status).toBe('promoted');
    expect((await anomalyById(memberIds[1]!)).status).toBe('cleared');
    expect((await anomalyById(memberIds[2]!)).status).toBe('cleared');
  });

  it('stays open with only 5 clean buckets', async () => {
    const device = await insertDevice(orgId, siteId);
    const { episodeId } = await seedOpenEpisode(device);
    await insertRollups({ orgId, deviceId: device, metricName: 'cpu_percent', starts: bucketsFrom(T0, 5), value: () => 20 });

    expect(await resolveAt(at(T0, 40))).toEqual([]);
    expect((await episodeById(episodeId)).status).toBe('open');
  });

  it('requires clean data on EVERY member metric', async () => {
    const device = await insertDevice(orgId, siteId);
    const { episodeId } = await seedOpenEpisode(device, {
      sourceTable: 'device_process_samples',
      metricNames: ['top_process_ram_mb_max', 'top_process_ram_mb_sum'],
      episodeKey: 'device_process_samples:process_runaway:process_ram',
    });
    const rollup = (metricName: string, count: number) => insertRollups({
      orgId, deviceId: device, sourceTable: 'device_process_samples', metricType: 'process', metricName,
      starts: bucketsFrom(T0, count), value: () => 500,
    });
    await rollup('top_process_ram_mb_max', 6);
    await rollup('top_process_ram_mb_sum', 2);
    expect(await resolveAt(at(T0, 40))).toEqual([]);

    await getTestDb().delete(metricRollups).where(eq(metricRollups.deviceId, device));
    await rollup('top_process_ram_mb_max', 6);
    await rollup('top_process_ram_mb_sum', 6);
    expect((await resolveAt(at(T0, 40))).map((row) => row.episodeId)).toEqual([episodeId]);
  });

  it('expires as expired_no_data after 24 h when the device reports but the series is absent', async () => {
    const now = at(T0, 25 * 60);
    const device = await insertDevice(orgId, siteId, at(now, -5));
    const { episodeId } = await seedOpenEpisode(device);

    expect(await resolveAt(now)).toEqual([{ episodeId, deviceId: device, linkedAlertId: null, closeReason: 'expired_no_data' }]);
  });

  it('expires as expired_offline after 24 h when the device itself went quiet', async () => {
    const device = await insertDevice(orgId, siteId, T0);
    const { episodeId } = await seedOpenEpisode(device);

    expect(await resolveAt(at(T0, 25 * 60))).toEqual([{ episodeId, deviceId: device, linkedAlertId: null, closeReason: 'expired_offline' }]);
  });

  it('leaves an episode alone while it is still inside the gap', async () => {
    const device = await insertDevice(orgId, siteId);
    const { episodeId } = await seedOpenEpisode(device);
    await insertRollups({ orgId, deviceId: device, metricName: 'cpu_percent', starts: bucketsFrom(T0, 6), value: () => 20 });

    expect(await resolveAt(at(T0, 20))).toEqual([]);
    expect((await episodeById(episodeId)).status).toBe('open');
  });
});
```

- [ ] **Step 6: Run the integration file to verify it passes**

Run: `cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/metricAnomalyEpisodes.integration.test.ts`
Expected: PASS (15 tests). If you run this step before Step 3 you get `resolveMetricAnomalyEpisodes is not a function` — that is the red.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/services/metricAnomalyEpisodes.ts apps/api/src/services/metricAnomalyEpisodes.test.ts apps/api/src/__tests__/integration/metricAnomalyEpisodes.integration.test.ts
git commit -m "feat(anomalies): auto-resolve metric anomaly episodes on observed clean data" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: Wire the stages, the trigger, and the flag gate

**Files:**
- Modify: `apps/api/src/services/metricAnomalies.ts` (imports, `METRIC_ANOMALY_STAGES` `:44-51`, `MetricAnomalyRange` `:84-88`, `MetricAnomalyResult` `:90-111`, `detectMetricAnomaliesRange` `:1190-1253`)
- Modify: `apps/api/src/services/metricAnomalies.test.ts`
- Modify: `apps/api/src/jobs/metricAnomalies.ts` (`DetectOrgRangeJobData` `:54-60`, `findAnomalyOrgRows` `:122-128`, `processScanOrgs` `:155-161`, `processDetectOrgRange` `:189-195`, `enqueueDetectOrgRange` `:280-339`, `enqueueMetricAnomalyBackfill` `:341-353`)
- Modify: `apps/api/src/jobs/metricAnomalies.test.ts`
- Modify: `apps/api/scripts/metric-anomaly-backfill.ts:25-29`
- Modify: `apps/api/src/__tests__/integration/metricAnomalies.integration.test.ts` (three stage-list assertions)
- Modify: `apps/api/src/__tests__/integration/metricAnomalyEpisodes.integration.test.ts` (append a `describe`)

**Interfaces:**
- Consumes: `assembleMetricAnomalyEpisodes`, `resolveMetricAnomalyEpisodes`, `notifyEpisodesClosed`, `setEpisodeCloseHandler`, `EpisodeCloseResult` (Tasks 7-8); `recordEpisodeStageSkipped` (Task 5).
- Produces:
  - `type MetricAnomalyTrigger = 'scan' | 'backfill'`; `MetricAnomalyRange.trigger?: MetricAnomalyTrigger` (default `'scan'`)
  - `METRIC_ANOMALY_STAGES = ['baseline', 'growth-trend', 'process-runaway', 'incidents', 'episodes', 'episode-resolve', 'v1-shadow']`
  - `MetricAnomalyResult.episodesClosed: number`
  - Job data `DetectOrgRangeJobData.trigger?: MetricAnomalyTrigger`
  - `scan-orgs` fan-out = orgs with a live (non-decommissioned, non-ephemeral) device ∪ orgs with an `open` episode
  - Close-handler call site: `notifyEpisodesClosed(orgId, closed)` runs ONCE per run, after the stage loop and the v1-shadow step, with the closes of every COMPLETED `episodes` and `episode-resolve` stage. `processDetectOrgRange` holds no DB context (#5283), so the handler runs after both stage transactions committed and outside any DB context — the requirement W02 (its D-8) depends on. A handler error is logged + sent to Sentry inside `notifyEpisodesClosed` and never fails the run.

- [ ] **Step 1: Update the orchestration unit tests (red)**

In `apps/api/src/services/metricAnomalies.test.ts`:

(a) Add to the `vi.hoisted` block: `assembleMock: vi.fn()`, `resolveMock: vi.fn()`, `notifyMock: vi.fn()`, `recordStageSkippedMock: vi.fn()`, `recordFallbackMock: vi.fn()` (and destructure them). Add after the existing `vi.mock('./mlFeatureFlags', …)`:

```ts
vi.mock('./metricAnomalyEpisodes', () => ({
  assembleMetricAnomalyEpisodes: assembleMock,
  resolveMetricAnomalyEpisodes: resolveMock,
  notifyEpisodesClosed: notifyMock,
}));

vi.mock('./metricAnomalyEpisodeMetrics', () => ({
  recordEpisodeStageSkipped: recordStageSkippedMock,
  recordBaselineFallback: recordFallbackMock,
}));
```

and at the end of `resetDbMocks()`:

```ts
  assembleMock.mockReset();
  assembleMock.mockResolvedValue([]);
  resolveMock.mockReset();
  resolveMock.mockResolvedValue([]);
  notifyMock.mockReset();
  notifyMock.mockResolvedValue(undefined);
  recordStageSkippedMock.mockReset();
  recordFallbackMock.mockReset();
```

(b) Replace `it('gates all writes behind the anomaly ML feature flag', …)` with:

```ts
  it('gates detection and assembly behind ml.anomalies.enabled but still runs episode-resolve (D4)', async () => {
    shouldProduceMlOutputMock.mockResolvedValue(false);

    const result = await detectMetricAnomaliesRange({
      orgId: '11111111-1111-1111-1111-111111111111',
      from: new Date('2026-06-18T12:00:00.000Z'),
      to: new Date('2026-06-18T12:30:00.000Z'),
    });

    expect(result).toEqual({
      orgId: '11111111-1111-1111-1111-111111111111',
      from: '2026-06-18T12:00:00.000Z',
      to: '2026-06-18T12:30:00.000Z',
      statements: 0,
      skipped: true,
      skippedReason: 'ml-disabled',
      stages: [{ stage: 'episode-resolve', outcome: 'completed', durationMs: expect.any(Number) }],
      episodesClosed: 0,
    });
    expect(shouldProduceMlOutputMock).toHaveBeenCalledWith('11111111-1111-1111-1111-111111111111', 'ml.anomalies.enabled');
    expect(detectorStatements()).toHaveLength(0);
    expect(assembleMock).not.toHaveBeenCalled();
    expect(resolveMock).toHaveBeenCalledWith('11111111-1111-1111-1111-111111111111', expect.any(Date));
  });
```

(c) In `it('upserts baseline deviations, growth trends, …')` change `statements: 4` to `statements: 5` and the stage list to:

```ts
    expect(result.stages.map((stage) => `${stage.stage}:${stage.outcome}`)).toEqual([
      'baseline:completed',
      'growth-trend:completed',
      'process-runaway:completed',
      'incidents:completed',
      'episodes:completed',
      'episode-resolve:completed',
    ]);
```

(d) In `it('runs the v1 seasonal robust shadow scorer only when …')` change `statements: 4` to `statements: 5`.

(e) In `it('is gated by the same ml.anomalies.enabled flag as the rest of the detect job')` replace `expect(executeMock).not.toHaveBeenCalled();` with `expect(detectorStatements()).toHaveLength(0);`.

(f) In `it('probes the per-org advisory lock …')` change `expect(lockProbes).toHaveLength(4);` to `toHaveLength(6)`. In `it('bounds lock and statement waits …')` change both `toHaveLength(4)` to `toHaveLength(6)`.

(g) In the `it.each([['55P03', …], ['57014', …]])` test replace the outcome list and statements with:

```ts
    expect(result.stages.map((stage) => stage.outcome)).toEqual([
      'timeout',
      'completed',
      'completed',
      'completed',
      'completed',
      'completed',
    ]);
    expect(result).toMatchObject({ statements: 4, skipped: false });
```

(h) In `it('reports skippedReason "timeout" when every stage trips its wait bound')` add before the call:

```ts
    assembleMock.mockRejectedValue(pgError('57014'));
    resolveMock.mockRejectedValue(pgError('57014'));
```

(i) In `it('opens a fresh system context per stage …')` add:

```ts
    expect(labels).toContain('metricAnomalies.episodes');
    expect(labels).toContain('metricAnomalies.episode-resolve');
```

(j) Replace `it('does not mark the whole run skipped when only the v1 shadow stage loses the lock', …)` with:

```ts
  it('does not mark the whole run skipped when only the v1 shadow stage loses the lock', async () => {
    shouldProduceMlOutputMock.mockResolvedValue(true);
    let probes = 0;
    executeMock.mockImplementation(async (query: unknown) => {
      const text = JSON.stringify(query);
      // Six main stages acquire; the 7th probe (v1-shadow) is refused.
      if (text.includes('pg_try_advisory_xact_lock')) {
        probes += 1;
        return [{ acquired: probes <= 6 }];
      }
      return [];
    });

    const result = await detectMetricAnomaliesRange({ orgId, ...range });

    expect(result).toMatchObject({ statements: 5, v1ShadowStatements: 0, v1ShadowSkipped: true, skipped: false });
    expect(result.skippedReason).toBeUndefined();
    expect(result.stages.map((stage) => stage.outcome)).toEqual([
      'completed', 'completed', 'completed', 'completed', 'completed', 'completed', 'locked',
    ]);
  });
```

(k) Append a new `describe`:

```ts
describe('episode stages (metric anomaly episodes W01)', () => {
  const orgId = '11111111-1111-1111-1111-111111111111';
  const range = { from: new Date('2026-06-18T12:00:00.000Z'), to: new Date('2026-06-18T12:15:00.000Z') };

  beforeEach(() => {
    resetDbMocks();
    shouldProduceMlOutputMock.mockReset();
    shouldProduceMlOutputMock.mockImplementation(async (_orgId: string, flag: string) => flag === 'ml.anomalies.enabled');
  });

  it('runs assembly after incidents, with the normalised range', async () => {
    await detectMetricAnomaliesRange({ orgId, ...range });
    expect(assembleMock).toHaveBeenCalledWith({ orgId, ...range, trigger: 'scan' });
  });

  it('a backfill runs assembly but never episode-resolve (now-relative)', async () => {
    const result = await detectMetricAnomaliesRange({ orgId, ...range, trigger: 'backfill' });
    expect(assembleMock).toHaveBeenCalledWith({ orgId, ...range, trigger: 'backfill' });
    expect(resolveMock).not.toHaveBeenCalled();
    expect(result.stages.map((stage) => stage.stage)).not.toContain('episode-resolve');
  });

  it('a flag-off backfill runs nothing at all', async () => {
    shouldProduceMlOutputMock.mockResolvedValue(false);
    const result = await detectMetricAnomaliesRange({ orgId, ...range, trigger: 'backfill' });
    expect(result).toMatchObject({ skipped: true, skippedReason: 'ml-disabled', stages: [], episodesClosed: 0 });
    expect(executeMock).not.toHaveBeenCalled();
  });

  it('hands every auto-closed episode to the close handler once, after the stages', async () => {
    const superseded = { episodeId: 'ep-1', deviceId: 'dev-1', linkedAlertId: null, closeReason: 'cleared' as const };
    const expired = { episodeId: 'ep-2', deviceId: 'dev-2', linkedAlertId: 'alert-2', closeReason: 'expired_offline' as const };
    assembleMock.mockResolvedValue([superseded]);
    resolveMock.mockResolvedValue([expired]);

    const result = await detectMetricAnomaliesRange({ orgId, ...range });

    expect(notifyMock).toHaveBeenCalledTimes(1);
    expect(notifyMock).toHaveBeenCalledWith(orgId, [superseded, expired]);
    expect(result.episodesClosed).toBe(2);
  });

  it('counts a timed-out episode stage, and only episode stages', async () => {
    assembleMock.mockRejectedValue(pgError('57014'));
    executeMock.mockImplementation(async (query: unknown) => {
      if (JSON.stringify(query).includes('INSERT INTO metric_anomalies (')) throw pgError('57014');
      return [{ acquired: true }];
    });

    await detectMetricAnomaliesRange({ orgId, ...range });

    expect(recordStageSkippedMock).toHaveBeenCalledTimes(1);
    expect(recordStageSkippedMock).toHaveBeenCalledWith('episodes');
  });
});
```

(The last test makes the baseline, growth-trend and process-runaway statements time out as well — none of those may touch the episode counter.)

- [ ] **Step 2: Run the orchestration tests to verify they fail**

Run: `cd apps/api && npx vitest run src/services/metricAnomalies.test.ts`
Expected: FAIL — stage lists have 4 entries, `assembleMock`/`resolveMock` never called, `episodesClosed` missing.

- [ ] **Step 3: Implement the wiring in `services/metricAnomalies.ts`**

Add imports after the existing ones:

```ts
import {
  assembleMetricAnomalyEpisodes,
  notifyEpisodesClosed,
  resolveMetricAnomalyEpisodes,
  type EpisodeCloseResult,
} from './metricAnomalyEpisodes';
import { recordEpisodeStageSkipped } from './metricAnomalyEpisodeMetrics';
```

Replace the stage list:

```ts
/**
 * The ordered detection stages. Each runs in its OWN transaction (#5283): the
 * whole run used to share one, so a second run's `ON CONFLICT` upsert waited on
 * the first run's *transactionid* for the duration of all four statements
 * instead of just the one it actually conflicted with.
 *
 * `episodes` (assembly) and `episode-resolve` (auto-close) come after
 * `incidents` so a lock-contended tick never starves the dispatch outbox; the
 * loop stops at the first `locked` stage. `episode-resolve` is the only stage
 * that runs with ml.anomalies.enabled off, and it never runs for a backfill.
 */
export const METRIC_ANOMALY_STAGES = [
  'baseline',
  'growth-trend',
  'process-runaway',
  'incidents',
  'episodes',
  'episode-resolve',
  'v1-shadow',
] as const;
```

Replace `MetricAnomalyRange`:

```ts
/**
 * `scan` (default) — the 10-minute cron. `backfill` — an explicit historical
 * window (enqueueMetricAnomalyBackfill, the CLI). A backfill still assembles
 * episodes (attach predicates are episode-relative, so replay is safe) but
 * skips `episode-resolve`, which is now()-relative.
 */
export type MetricAnomalyTrigger = 'scan' | 'backfill';

export interface MetricAnomalyRange {
  orgId: string;
  from: Date;
  to: Date;
  trigger?: MetricAnomalyTrigger;
}
```

Add to `MetricAnomalyResult` after `stages`:

```ts
  /**
   * Episodes closed automatically this run (supersede + auto-resolve), already
   * handed to the close handler. `statements` / `skipped` describe detection
   * and assembly only; `episode-resolve` is reported here and in `stages`.
   */
  episodesClosed: number;
```

Replace `detectMetricAnomaliesRange` with:

```ts
function isEpisodeStage(stage: MetricAnomalyStage): stage is 'episodes' | 'episode-resolve' {
  return stage === 'episodes' || stage === 'episode-resolve';
}

export async function detectMetricAnomaliesRange(options: MetricAnomalyRange): Promise<MetricAnomalyResult> {
  const { from, to } = normalizeRange(options.from, options.to);
  const trigger: MetricAnomalyTrigger = options.trigger ?? 'scan';
  const range: MetricAnomalyRange = { orgId: options.orgId, from, to, trigger };
  const base = { orgId: options.orgId, from: from.toISOString(), to: to.toISOString() };

  const detectionEnabled = await readMlFlag(options.orgId, 'ml.anomalies.enabled');

  // Episodes a stage closed are kept only once that stage has COMMITTED; a
  // timed-out or locked stage rolled back, so its closes never happened.
  const pending: { closed: EpisodeCloseResult[] } = { closed: [] };
  const closed: EpisodeCloseResult[] = [];

  // Task 2 (#3828): `incidents` collapses the rows the three detectors above it
  // just touched into their canonical incident row. It runs even when an
  // earlier stage was skipped — it reads `metric_anomalies`, so it still has
  // this tick's committed rows plus anything a previous tick left
  // unmaterialised, and skipping it would strand those anomalies with no
  // incident to dispatch. `episodes` reads metric_anomalies the same way.
  const orderedStages: Array<readonly [MetricAnomalyStage, () => Promise<void>]> = [];
  if (detectionEnabled) {
    orderedStages.push(
      ['baseline', () => detectBaselineDeviations(range)],
      ['growth-trend', () => detectGrowthTrends(range)],
      ['process-runaway', () => detectProcessSampleRunaways(range)],
      ['incidents', () => upsertMetricAnomalyIncidents(range)],
      ['episodes', async () => {
        pending.closed = await assembleMetricAnomalyEpisodes(range);
      }],
    );
  }
  // D4: turning detection off must not freeze open episodes, so resolve sits
  // outside the flag gate. scan-orgs already enqueues flag-off orgs
  // (jobs/metricAnomalies.ts findAnomalyOrgRows has no flag filter) and, since
  // W01, every org that still owns an open episode.
  if (trigger === 'scan') {
    orderedStages.push(['episode-resolve', async () => {
      pending.closed = await resolveMetricAnomalyEpisodes(options.orgId, new Date());
    }]);
  }

  const stages: MetricAnomalyStageResult[] = [];
  let lockContended = false;

  for (const [stage, run] of orderedStages) {
    pending.closed = [];
    const result = await runDetectionStage(stage, options.orgId, run);
    stages.push(result);
    if (result.outcome === 'completed') closed.push(...pending.closed);
    if (result.outcome === 'timeout' && isEpisodeStage(stage)) recordEpisodeStageSkipped(stage);
    // Stop on `locked` — every later stage takes the SAME org key, so they
    // would all fail to acquire too and the round trips would be pure waste.
    // A `timeout` is per-statement, so the remaining stages still get a turn.
    if (result.outcome === 'locked') {
      lockContended = true;
      break;
    }
  }

  let v1ShadowStatements = 0;
  let v1ShadowSkipped = true;
  if (detectionEnabled && !lockContended && (await readMlFlag(options.orgId, 'ml.anomalies.v1_shadow.enabled'))) {
    const shadow = await runDetectionStage('v1-shadow', options.orgId, () =>
      detectSeasonalRobustCandidates(range),
    );
    stages.push(shadow);
    v1ShadowSkipped = shadow.outcome !== 'completed';
    v1ShadowStatements = shadow.outcome === 'completed' ? 1 : 0;
    if (shadow.outcome === 'locked') lockContended = true;
  }

  // After every stage transaction has committed, outside any DB context
  // (processDetectOrgRange opens none, #5283). `closed` holds the supersedes
  // from `episodes` AND the auto-closes from `episode-resolve`, so a promoted
  // episode that is superseded reaches W02's alert handler too. Never throws.
  await notifyEpisodesClosed(options.orgId, closed);

  if (!detectionEnabled) {
    return {
      ...base,
      statements: 0,
      skipped: true,
      skippedReason: 'ml-disabled',
      stages,
      episodesClosed: closed.length,
    };
  }

  const statements = stages.filter(
    (stage) => stage.stage !== 'v1-shadow' && stage.stage !== 'episode-resolve' && stage.outcome === 'completed',
  ).length;
  const skipped = statements === 0 && v1ShadowStatements === 0;

  return {
    ...base,
    statements,
    v1ShadowStatements,
    v1ShadowSkipped,
    skipped,
    ...(skipped ? { skippedReason: deriveSkipReason(stages) } : {}),
    stages,
    episodesClosed: closed.length,
  };
}
```

- [ ] **Step 4: Run the orchestration tests to verify they pass**

Run: `cd apps/api && npx vitest run src/services/metricAnomalies.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing job tests**

In `apps/api/src/jobs/metricAnomalies.test.ts` add the import

```ts
import { detectMetricAnomaliesRange } from '../services/metricAnomalies';
```

and inside `describe('metric anomalies queue helpers', …)`:

```ts
  it('marks backfill enqueues trigger=backfill and scheduled fan-out trigger=scan', async () => {
    await enqueueMetricAnomalyBackfill({
      orgId: 'org-1',
      from: new Date('2026-06-18T11:00:00.000Z'),
      to: new Date('2026-06-18T12:00:00.000Z'),
    });
    expect(detectAddCalls()[0]?.[1]).toMatchObject({ trigger: 'backfill' });

    addMock.mockClear();
    await initializeMetricAnomaliesWorker();
    await workerProcessorMock({ data: { type: 'scan-orgs', lookbackMinutes: 15 } });
    expect(detectAddCalls()[0]?.[1]).toMatchObject({ trigger: 'scan' });
  });

  it('passes the job trigger to detection, treating pre-W01 jobs without one as scan', async () => {
    vi.mocked(detectMetricAnomaliesRange).mockClear();
    await initializeMetricAnomaliesWorker();
    const job = {
      type: 'detect-org-range',
      orgId: 'org-1',
      from: '2026-06-18T11:45:00.000Z',
      to: '2026-06-18T12:00:00.000Z',
      queuedAt: '2026-06-18T12:00:00.000Z',
    };

    await workerProcessorMock({ data: { ...job, trigger: 'backfill' } });
    expect(detectMetricAnomaliesRange).toHaveBeenLastCalledWith(expect.objectContaining({ orgId: 'org-1', trigger: 'backfill' }));

    await workerProcessorMock({ data: job });
    expect(detectMetricAnomaliesRange).toHaveBeenLastCalledWith(expect.objectContaining({ trigger: 'scan' }));
  });
```

Run: `cd apps/api && npx vitest run src/jobs/metricAnomalies.test.ts`
Expected: FAIL — `trigger` absent from job data and from the detection call.

- [ ] **Step 6: Carry the trigger through the job**

In `apps/api/src/jobs/metricAnomalies.ts` change the service import to

```ts
import {
  detectMetricAnomaliesRange,
  type MetricAnomalyResult,
  type MetricAnomalyTrigger,
} from '../services/metricAnomalies';
```

extend the job data:

```ts
type DetectOrgRangeJobData = {
  type: 'detect-org-range';
  orgId: string;
  from: string;
  to: string;
  queuedAt: string;
  /** Absent on jobs enqueued before metric anomaly episodes W01 — treated as 'scan'. */
  trigger?: MetricAnomalyTrigger;
};
```

in `processScanOrgs` pass `trigger: 'scan'` to `enqueueDetectOrgRange`:

```ts
    const { outcome } = await enqueueDetectOrgRange({
      jobId: buildScheduledMetricAnomalyJobId(row.orgId),
      orgId: row.orgId,
      from,
      to,
      trigger: 'scan',
    });
```

replace `processDetectOrgRange`:

```ts
async function processDetectOrgRange(data: DetectOrgRangeJobData): Promise<MetricAnomalyResult> {
  return detectMetricAnomaliesRange({
    orgId: data.orgId,
    from: new Date(data.from),
    to: new Date(data.to),
    trigger: data.trigger ?? 'scan',
  });
}
```

add `trigger: MetricAnomalyTrigger;` to the `enqueueDetectOrgRange` options type and `trigger: options.trigger,` to the `queue.add('detect-org-range', { … })` payload (after `to`), and in `enqueueMetricAnomalyBackfill`:

```ts
  const { id } = await enqueueDetectOrgRange({
    jobId: buildMetricAnomalyJobId(options.orgId, options.from, options.to),
    orgId: options.orgId,
    from: options.from,
    to: options.to,
    trigger: 'backfill',
  });
```

In `apps/api/scripts/metric-anomaly-backfill.ts` change the call to:

```ts
  const result = await detectMetricAnomaliesRange({
    orgId: options.orgId,
    from: options.from,
    to: options.to,
    // Explicit historical window: assemble episodes, never auto-resolve them.
    trigger: 'backfill',
  });
```

Run: `cd apps/api && npx vitest run src/jobs/metricAnomalies.test.ts src/services/metricAnomalies.test.ts`
Expected: PASS.

- [ ] **Step 6b: Scan orgs that still have open episodes (red, then green)**

`findAnomalyOrgRows` (`apps/api/src/jobs/metricAnomalies.ts:122-128`) selects only orgs with a non-decommissioned, non-ephemeral device. An org whose devices were all decommissioned after an episode opened would never be scanned again, so `episode-resolve` would never close its episodes (they would sit `open` until retention). Add the orgs that own an `open` episode to the fan-out.

In `apps/api/src/jobs/metricAnomalies.test.ts` change the schema mock to

```ts
vi.mock('../db/schema', () => ({
  devices: {},
  metricAnomalyEpisodes: {},
}));
```

and add inside `describe('metric anomalies queue helpers', …)`:

```ts
  it('also scans orgs that only have open episodes, so episode-resolve can close them (D4)', async () => {
    groupByMock
      .mockResolvedValueOnce([{ orgId: 'org-1' }]) // orgs with a live device
      .mockResolvedValueOnce([{ orgId: 'org-1' }, { orgId: 'org-no-devices' }]); // orgs with an open episode
    await initializeMetricAnomaliesWorker();

    await workerProcessorMock({ data: { type: 'scan-orgs', lookbackMinutes: 15 } });

    expect(selectMock).toHaveBeenCalledTimes(2);
    expect(detectAddCalls().map(([, data]) => data.orgId)).toEqual(['org-1', 'org-no-devices']);
    expect(detectAddCalls().every(([, data]) => data.trigger === 'scan')).toBe(true);
  });
```

Run: `cd apps/api && npx vitest run src/jobs/metricAnomalies.test.ts`
Expected: FAIL — `selectMock` called once and only `org-1` enqueued.

In `apps/api/src/jobs/metricAnomalies.ts` change the schema import to `import { devices, metricAnomalyEpisodes } from '../db/schema';` and replace `findAnomalyOrgRows`:

```ts
// Quick Support exclusion: ephemeral devices (`devices.is_ephemeral`) live in
// the hidden per-partner 'quick_support' org and are a stranger's personal
// machine borrowed for one ~20-minute session. That org stays inside
// technicians' accessibleOrgIds for RLS reasons, so this fleet-wide sweep is NOT
// filtered for us; excluding the devices also drops the hidden org out of the
// fan-out entirely (it holds nothing but ephemeral devices).
//
// Metric anomaly episodes W01 (spec D4): orgs that still own an OPEN episode
// are scanned too, even with no live device, so `episode-resolve` can close
// those episodes (it runs whatever ml.anomalies.enabled says). Detection for
// such an org finds no rollups and writes nothing. Both reads run in the one
// system context processScanOrgs opens.
async function findAnomalyOrgRows(): Promise<Array<{ orgId: string }>> {
  const deviceOrgs = await db
    .select({ orgId: devices.orgId })
    .from(devices)
    .where(sql`${devices.status} <> 'decommissioned' AND ${devices.isEphemeral} = false`)
    .groupBy(devices.orgId);
  const openEpisodeOrgs = await db
    .select({ orgId: metricAnomalyEpisodes.orgId })
    .from(metricAnomalyEpisodes)
    .where(sql`${metricAnomalyEpisodes.status} = 'open'`)
    .groupBy(metricAnomalyEpisodes.orgId);

  const seen = new Set<string>();
  const rows: Array<{ orgId: string }> = [];
  for (const row of [...deviceOrgs, ...openEpisodeOrgs]) {
    if (seen.has(row.orgId)) continue;
    seen.add(row.orgId);
    rows.push({ orgId: row.orgId });
  }
  return rows;
}
```

Run: `cd apps/api && npx vitest run src/jobs/metricAnomalies.test.ts`
Expected: PASS, including the pre-existing `does not hold system DB context while scan fan-out enqueues BullMQ jobs` (both reads sit inside the one `withSystemDbAccessContext`, so its call order is unchanged) and `accounts each org separately across a multi-org fan-out` (both reads return the same two orgs; the dedupe keeps two enqueues).

- [ ] **Step 7: Update the existing integration stage lists and add the flag-off proof (red)**

In `apps/api/src/__tests__/integration/metricAnomalies.integration.test.ts` there are three assertions of the form

```ts
    expect(result.stages.map((stage) => stage.outcome)).toEqual([
      'completed',
      'completed',
      'completed',
      'completed',
    ]);
```

(in `positive control: an unrelated org …`, `releases the lock at the end of every stage …` — asserting on `second.stages` — and `commits each detection stage separately …`). In each, the array becomes six `'completed'` entries.

In `metricAnomalyEpisodes.integration.test.ts` add the imports

```ts
import { detectMetricAnomaliesRange } from '../../services/metricAnomalies';
import { setEpisodeCloseHandler, type EpisodeCloseResult } from '../../services/metricAnomalyEpisodes';
```

(merge `setEpisodeCloseHandler` and the type into the existing `metricAnomalyEpisodes` import), add `afterEach` to the `vitest` import, and append:

```ts
describe('episode stages inside detectMetricAnomaliesRange (spec §6, §7, D4)', () => {
  let orgId: string;
  let siteId: string;
  let now: Date;
  const handled: Array<{ orgId: string; closed: EpisodeCloseResult[] }> = [];

  beforeEach(async () => {
    const partner = await createPartner();
    orgId = (await createOrganization({ partnerId: partner.id, name: 'Stage Org' })).id;
    siteId = (await createSite({ orgId, name: 'Stage Site' })).id;
    now = floorToBucket(new Date());
    handled.length = 0;
    setEpisodeCloseHandler(async (closedOrgId, closed) => {
      handled.push({ orgId: closedOrgId, closed });
    });
  });

  afterEach(() => {
    setEpisodeCloseHandler(null);
  });

  async function seedClearableEpisode(deviceId: string): Promise<string> {
    const lastSeenAt = at(now, -60);
    const episodeId = await insertEpisode({ orgId, deviceId, firstSeenAt: at(lastSeenAt, -5), lastSeenAt });
    await insertAnomaly({ orgId, deviceId, windowStart: at(lastSeenAt, -5), episodeId });
    await insertRollups({ orgId, deviceId, metricName: 'cpu_percent', starts: bucketsFrom(lastSeenAt, 6), value: () => 20 });
    return episodeId;
  }

  it('auto-resolve runs with ml.anomalies.enabled = false', async () => {
    // No enableAnomalies(): the flag defaults off.
    const device = await insertDevice(orgId, siteId);
    const episodeId = await seedClearableEpisode(device);

    const result = await detectMetricAnomaliesRange({ orgId, from: at(now, -15), to: now });

    expect(result).toMatchObject({ skipped: true, skippedReason: 'ml-disabled', statements: 0, episodesClosed: 1 });
    expect(result.stages.map((stage) => `${stage.stage}:${stage.outcome}`)).toEqual(['episode-resolve:completed']);
    const [episode] = await episodesFor(orgId, device);
    expect(episode).toMatchObject({ id: episodeId, status: 'resolved', closeReason: 'cleared' });
    expect(handled).toEqual([{ orgId, closed: [{ episodeId, deviceId: device, linkedAlertId: null, closeReason: 'cleared' }] }]);
  });

  it('a backfill assembles but never auto-resolves', async () => {
    await enableAnomalies(orgId);
    const device = await insertDevice(orgId, siteId);
    const episodeId = await seedClearableEpisode(device);
    const fresh = await insertAnomaly({ orgId, deviceId: device, windowStart: at(now, -10), metricName: 'ram_percent', metricType: 'memory' });

    const result = await detectMetricAnomaliesRange({ orgId, from: at(now, -15), to: now, trigger: 'backfill' });

    expect(result.stages.map((stage) => stage.stage)).not.toContain('episode-resolve');
    expect(result.stages.map((stage) => stage.stage)).toContain('episodes');
    const episodes = await episodesFor(orgId, device);
    expect(episodes.find((episode) => episode.id === episodeId)).toMatchObject({ status: 'open' });
    expect((await anomalyById(fresh)).episodeId).not.toBeNull();
    expect(handled).toEqual([]);
  });
});
```

- [ ] **Step 8: Run both integration files to verify they pass**

Run: `cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/metricAnomalyEpisodes.integration.test.ts src/__tests__/integration/metricAnomalies.integration.test.ts`
Expected: PASS. (Before Step 3 these fail: the flag-off run returns `stages: []` and the episode stays open.)

- [ ] **Step 9: Typecheck**

Run: `cd apps/api && NODE_OPTIONS=--max-old-space-size=12288 npx tsc --noEmit -p .; echo "exit=$?"`
Expected: `exit=0`. (`apps/api/tsconfig.json` includes only `src/**/*`, so the one-line CLI edit in `scripts/metric-anomaly-backfill.ts` is not typechecked here; it passes a literal `'backfill'` to a field typed `MetricAnomalyTrigger`, which the reviewer checks by eye.)

- [ ] **Step 10: Commit**

```bash
git add apps/api/src/services/metricAnomalies.ts apps/api/src/services/metricAnomalies.test.ts apps/api/src/jobs/metricAnomalies.ts apps/api/src/jobs/metricAnomalies.test.ts apps/api/scripts/metric-anomaly-backfill.ts apps/api/src/__tests__/integration/metricAnomalies.integration.test.ts apps/api/src/__tests__/integration/metricAnomalyEpisodes.integration.test.ts
git commit -m "feat(anomalies): run episode assembly and flag-independent auto-resolve as detector stages" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 10: Baseline anti-contamination with fallback

**Files:**
- Modify: `apps/api/src/services/metricAnomalies.ts` (`detectBaselineDeviations` `:332-487`, `detectProcessSampleRunaways` `:632-806`, new helpers above `detectBaselineDeviations`, import)
- Modify: `apps/api/src/services/metricAnomalies.test.ts` (append a `describe`)
- Modify: `apps/api/src/__tests__/integration/metricAnomalyEpisodes.integration.test.ts` (append a `describe`)

**Interfaces:**
- Consumes: `recordBaselineFallback` (Task 5), `metric_anomaly_episodes` + `metric_anomalies.episode_id` (Task 2), stage wiring + `trigger` (Task 9).
- Produces: both baseline detectors exclude open-episode buckets; `baseline_summary` gains `baselineFallback: boolean` and `baselineExcludedBuckets: number`; the detector statements return `fallbackPairs`.

- [ ] **Step 1: Write the failing unit tests**

Append to `apps/api/src/services/metricAnomalies.test.ts`:

```ts
describe('baseline anti-contamination (spec §10)', () => {
  const orgId = '11111111-1111-1111-1111-111111111111';
  const range = { from: new Date('2026-06-18T12:00:00.000Z'), to: new Date('2026-06-18T12:15:00.000Z') };

  beforeEach(() => {
    resetDbMocks();
    shouldProduceMlOutputMock.mockReset();
    shouldProduceMlOutputMock.mockImplementation(async (_orgId: string, flag: string) => flag === 'ml.anomalies.enabled');
  });

  it('excludes open-episode buckets from both baseline detectors, with an unfiltered fallback', async () => {
    await detectMetricAnomaliesRange({ orgId, ...range });

    const [baselineSql, growthSql, processSql] = detectorStatements();
    for (const text of [baselineSql ?? '', processSql ?? '']) {
      expect(text).toContain('open_episode_buckets');
      expect(text).toContain("e.status = 'open'");
      expect(text).toContain("ma.anomaly_type NOT IN ('memory_growth', 'disk_growth')");
      expect(text).toContain('FILTER (WHERE oeb.device_id IS NULL)');
      expect(text).toContain('used_fallback');
      expect(text).toContain('baselineFallback');
      expect(text).toContain('fallbackPairs');
    }
    // Growth trends compare a window with itself — no baseline to protect.
    expect(growthSql).not.toContain('open_episode_buckets');
  });

  it('counts fallback pairs per detector from the statement result', async () => {
    executeMock.mockImplementation(async (query: unknown) => {
      const text = JSON.stringify(query);
      if (text.includes('INSERT INTO metric_anomalies (') && text.includes('open_episode_buckets')) {
        return [{ fallbackPairs: text.includes("mr.source_table = 'device_process_samples'") ? 1 : 2 }];
      }
      return [{ acquired: true }];
    });

    await detectMetricAnomaliesRange({ orgId, ...range });

    expect(recordFallbackMock).toHaveBeenCalledWith('baseline', 2);
    expect(recordFallbackMock).toHaveBeenCalledWith('process-runaway', 1);
  });
});
```

- [ ] **Step 2: Write the failing integration proofs**

In `metricAnomalyEpisodes.integration.test.ts` add the imports

```ts
import { metricsRegistry } from '../../services/metricsRegistry';
import { BASELINE_FALLBACK_METRIC } from '../../services/metricAnomalyEpisodeMetrics';
```

and append:

```ts
async function readFallbackCount(detector: string): Promise<number> {
  const metric = metricsRegistry.getSingleMetric(BASELINE_FALLBACK_METRIC);
  if (!metric) return 0;
  const { values } = await metric.get();
  return values.find((value) => value.labels.detector === detector)?.value ?? 0;
}

describe('baseline anti-contamination (spec §10)', () => {
  let orgId: string;
  let siteId: string;

  beforeEach(async () => {
    const partner = await createPartner();
    orgId = (await createOrganization({ partnerId: partner.id, name: 'Contamination Org' })).id;
    await enableAnomalies(orgId);
    siteId = (await createSite({ orgId, name: 'Contamination Site' })).id;
  });

  it('still detects a 6-hour burst at 4x baseline in hour 5, and assembles it as one 6-hour episode', async () => {
    const device = await insertDevice(orgId, siteId);
    const burstStart = at(floorToBucket(new Date()), -6 * 60);
    // 24 h of baseline at 1.5 MB/s (stddev 0.1 MB/s), then 72 buckets at 6 MB/s.
    await insertRollups({
      orgId, deviceId: device, metricType: 'disk', metricName: 'disk_write_bps',
      starts: bucketsFrom(at(burstStart, -24 * 60), 288), value: (i) => (i % 2 === 0 ? 1.4e6 : 1.6e6),
    });
    await insertRollups({
      orgId, deviceId: device, metricType: 'disk', metricName: 'disk_write_bps',
      starts: bucketsFrom(burstStart, 72), value: () => 6e6,
    });

    // Tick bucket by bucket, like the cron, so each tick's assembly feeds the next tick's baseline.
    // `backfill` keeps auto-resolve (now-relative) from closing the episode mid-replay.
    for (let i = 0; i < 72; i++) {
      const from = at(burstStart, i * 5);
      await detectMetricAnomaliesRange({ orgId, from, to: at(from, 5), trigger: 'backfill' });
    }

    const hourFive = await getTestDb()
      .select()
      .from(metricAnomalies)
      .where(and(
        eq(metricAnomalies.deviceId, device),
        eq(metricAnomalies.metricName, 'disk_write_bps'),
        eq(metricAnomalies.anomalyType, 'spike'),
        eq(metricAnomalies.windowStart, at(burstStart, 5 * 60)),
      ));
    expect(hourFive).toHaveLength(1);

    const episodes = await episodesFor(orgId, device);
    expect(episodes).toHaveLength(1);
    expect(episodes[0]).toMatchObject({ status: 'open', episodeKey: 'device_metrics:spike:disk_write', bucketCount: 72 });
    expect(episodes[0]!.firstSeenAt.toISOString()).toBe(burstStart.toISOString());
    expect(episodes[0]!.lastSeenAt.toISOString()).toBe(at(burstStart, 6 * 60).toISOString());
  }, 180_000);

  it('falls back to the unfiltered baseline, and counts it, when exclusion leaves fewer than 12 buckets', async () => {
    const device = await insertDevice(orgId, siteId);
    const anchor = new Date('2026-06-18T18:00:00.000Z');
    const baselineStarts = Array.from({ length: 14 }, (_, i) => at(anchor, -(6 + i) * 5)); // anchor-30 .. anchor-95
    await insertRollups({ orgId, deviceId: device, metricName: 'cpu_percent', starts: baselineStarts, value: () => 10 });
    await insertRollups({ orgId, deviceId: device, metricName: 'cpu_percent', starts: [anchor], value: () => 99 });
    // 10 of the 14 baseline buckets belong to an OPEN episode, leaving 4 clean.
    const episodeId = await insertEpisode({ orgId, deviceId: device, firstSeenAt: at(anchor, -75), lastSeenAt: at(anchor, -25) });
    for (const windowStart of baselineStarts.slice(0, 10)) {
      await insertAnomaly({ orgId, deviceId: device, windowStart, episodeId });
    }

    const before = await readFallbackCount('baseline');
    await detectMetricAnomaliesRange({ orgId, from: anchor, to: at(anchor, 5), trigger: 'backfill' });

    const [spike] = await getTestDb()
      .select()
      .from(metricAnomalies)
      .where(and(eq(metricAnomalies.deviceId, device), eq(metricAnomalies.windowStart, anchor), eq(metricAnomalies.anomalyType, 'spike')));
    expect(spike).toBeDefined();
    expect(spike!.baselineValue).toBe(10);
    expect(spike!.baselineSummary as Record<string, unknown>).toMatchObject({
      baselineFallback: true,
      baselineBuckets: 14,
      baselineExcludedBuckets: 10,
    });
    expect(await readFallbackCount('baseline')).toBe(before + 1);
  });
});
```

- [ ] **Step 3: Run both to verify they fail**

Run: `cd apps/api && npx vitest run src/services/metricAnomalies.test.ts`
Expected: FAIL — `open_episode_buckets` not in the statements; `recordFallbackMock` never called.

Run: `cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/metricAnomalyEpisodes.integration.test.ts -t "anti-contamination"`
Expected: FAIL — hour-5 query returns `[]` (the contaminated baseline stops detection after roughly 70 minutes) and the episode's `bucketCount` is far below 72; the fallback test fails on the missing `baselineFallback` key.

- [ ] **Step 4: Implement the shared baseline fragments**

In `apps/api/src/services/metricAnomalies.ts` add the import

```ts
import { recordBaselineFallback, recordEpisodeStageSkipped } from './metricAnomalyEpisodeMetrics';
```

(replacing the single-name import from Task 9), and insert above `detectBaselineDeviations`:

```ts
/**
 * Spec §10 — buckets that belong to a CURRENTLY OPEN episode are excluded from
 * the baseline, so a long burst cannot inflate its own threshold and stop being
 * detected. Buckets of closed episodes rejoin the baseline, so a device that
 * legitimately steps up re-baselines once its episode closes. Growth rows are
 * not used: their window_start is the start of a multi-bucket trend window, not
 * an anomalous bucket (plan deviation 6).
 */
function openEpisodeBucketsSql(orgId: string, sourceTable: 'device_metrics' | 'device_process_samples'): SQL {
  return sql`
    SELECT DISTINCT ma.device_id, ma.metric_name, ma.window_start
    FROM metric_anomaly_episodes e
    JOIN metric_anomalies ma ON ma.episode_id = e.id
    WHERE e.org_id = ${orgId}
      AND e.status = 'open'
      AND ma.org_id = ${orgId}
      AND ma.source_table = ${sourceTable}
      AND ma.anomaly_type NOT IN ('memory_growth', 'disk_growth')
  `;
}

/** Raw and open-episode-filtered aggregates over `b` (baseline rollups) LEFT JOINed to `oeb`. */
function baselineAggregatesSql(): SQL {
  return sql.raw(`
        avg(b.avg_value)::double precision AS raw_value,
        min(b.avg_value)::double precision AS raw_min,
        max(b.avg_value)::double precision AS raw_max,
        stddev_samp(b.avg_value)::double precision AS raw_stddev,
        count(*)::integer AS raw_count,
        (avg(b.avg_value) FILTER (WHERE oeb.device_id IS NULL))::double precision AS clean_value,
        (min(b.avg_value) FILTER (WHERE oeb.device_id IS NULL))::double precision AS clean_min,
        (max(b.avg_value) FILTER (WHERE oeb.device_id IS NULL))::double precision AS clean_max,
        (stddev_samp(b.avg_value) FILTER (WHERE oeb.device_id IS NULL))::double precision AS clean_stddev,
        (count(*) FILTER (WHERE oeb.device_id IS NULL))::integer AS clean_count`);
}

/**
 * Use the filtered baseline when it still has MIN_BASELINE_BUCKETS rows, else
 * fall back to the unfiltered one (`used_fallback`) — without the fallback a
 * long burst would remove most of the 24 h window and detection would stop
 * silently, the failure §10 exists to prevent, reached from the other side.
 * MIN_BASELINE_BUCKETS is a module constant, never user input.
 */
function chosenBaselineSql(): SQL {
  const min = MIN_BASELINE_BUCKETS;
  return sql.raw(`
        CASE WHEN bl.clean_count >= ${min} THEN bl.clean_value ELSE bl.raw_value END AS baseline_value,
        CASE WHEN bl.clean_count >= ${min} THEN bl.clean_min ELSE bl.raw_min END AS baseline_min,
        CASE WHEN bl.clean_count >= ${min} THEN bl.clean_max ELSE bl.raw_max END AS baseline_max,
        CASE WHEN bl.clean_count >= ${min} THEN bl.clean_stddev ELSE bl.raw_stddev END AS baseline_stddev,
        CASE WHEN bl.clean_count >= ${min} THEN bl.clean_count ELSE bl.raw_count END AS baseline_count,
        (bl.clean_count < ${min} AND bl.raw_count >= ${min}) AS used_fallback,
        (bl.raw_count - bl.clean_count)::integer AS excluded_count`);
}

function readFallbackPairs(result: unknown): number {
  const row = Array.isArray(result) ? (result[0] as { fallbackPairs?: unknown } | undefined) : undefined;
  const pairs = Number(row?.fallbackPairs ?? 0);
  return Number.isFinite(pairs) && pairs > 0 ? pairs : 0;
}
```

- [ ] **Step 5: Replace `detectBaselineDeviations`**

```ts
async function detectBaselineDeviations(options: MetricAnomalyRange): Promise<void> {
  const { from, to } = normalizeRange(options.from, options.to);
  // bucket_start is timestamp-without-tz; bind ISO strings + ::timestamp so the
  // comparison stays in tz-free space (matches the rollup writer) and postgres.js
  // does not bind a raw Date as timestamptz.
  const fromIso = from.toISOString();
  const toIso = to.toISOString();

  const result = await db.execute(sql`
    WITH recent AS (
      SELECT
        mr.org_id,
        mr.device_id,
        mr.source_table,
        mr.metric_type,
        mr.metric_name,
        mr.bucket_start,
        mr.bucket_seconds,
        mr.avg_value,
        mr.sample_count
      FROM metric_rollups mr
      WHERE mr.org_id = ${options.orgId}
        AND mr.source_table = 'device_metrics'
        AND mr.bucket_seconds = ${RAW_BUCKET_SECONDS}
        AND mr.bucket_start >= ${fromIso}::timestamp
        AND mr.bucket_start < ${toIso}::timestamp
        AND mr.avg_value IS NOT NULL
        AND mr.sample_count > 0
    ),
    open_episode_buckets AS (${openEpisodeBucketsSql(options.orgId, 'device_metrics')}),
    baseline AS (
      SELECT
        r.org_id,
        r.device_id,
        r.source_table,
        r.metric_type,
        r.metric_name,
        r.bucket_start,
        r.bucket_seconds,
        r.avg_value,
        r.sample_count,
        ${baselineAggregatesSql()}
      FROM recent r
      JOIN metric_rollups b
        ON b.org_id = r.org_id
       AND b.device_id = r.device_id
       AND b.source_table = r.source_table
       AND b.metric_type = r.metric_type
       AND b.metric_name = r.metric_name
       AND b.bucket_seconds = r.bucket_seconds
       AND b.avg_value IS NOT NULL
       AND b.sample_count > 0
       AND b.bucket_start >= r.bucket_start - (${BASELINE_LOOKBACK_HOURS} * interval '1 hour')
       AND b.bucket_start < r.bucket_start - (${BASELINE_GAP_MINUTES} * interval '1 minute')
      LEFT JOIN open_episode_buckets oeb
        ON oeb.device_id = b.device_id
       AND oeb.metric_name = b.metric_name
       AND oeb.window_start = b.bucket_start
      GROUP BY
        r.org_id,
        r.device_id,
        r.source_table,
        r.metric_type,
        r.metric_name,
        r.bucket_start,
        r.bucket_seconds,
        r.avg_value,
        r.sample_count
    ),
    chosen AS (
      SELECT
        bl.org_id,
        bl.device_id,
        bl.source_table,
        bl.metric_type,
        bl.metric_name,
        bl.bucket_start,
        bl.bucket_seconds,
        bl.avg_value,
        bl.sample_count,
        ${chosenBaselineSql()}
      FROM baseline bl
    ),
    scored AS (
      SELECT
        b.*,
        CASE
          WHEN b.metric_name = 'bandwidth_out_bps'
            AND b.avg_value >= greatest(coalesce(b.baseline_value, 0) + (4 * greatest(coalesce(b.baseline_stddev, 0), 1)), coalesce(b.baseline_value, 0) * 3, 1000000)
            THEN 'network_egress'
          WHEN b.metric_name = 'process_count'
            AND b.avg_value >= greatest(coalesce(b.baseline_value, 0) + (3 * greatest(coalesce(b.baseline_stddev, 0), 1)), coalesce(b.baseline_value, 0) + 20)
            THEN 'process_runaway'
          WHEN b.metric_name IN ('cpu_percent', 'ram_percent', 'disk_percent')
            AND b.avg_value >= greatest(coalesce(b.baseline_value, 0) + (3 * greatest(coalesce(b.baseline_stddev, 0), 1)), coalesce(b.baseline_value, 0) * 1.5, 90)
            THEN 'spike'
          WHEN b.metric_name IN ('disk_read_bps', 'disk_write_bps', 'bandwidth_in_bps')
            AND b.avg_value >= greatest(coalesce(b.baseline_value, 0) + (4 * greatest(coalesce(b.baseline_stddev, 0), 1)), coalesce(b.baseline_value, 0) * 3, 1000000)
            THEN 'spike'
          WHEN b.metric_name IN ('cpu_percent', 'ram_percent', 'disk_percent', 'process_count')
            AND coalesce(b.baseline_value, 0) >= 25
            AND b.avg_value <= least(coalesce(b.baseline_value, 0) - (3 * greatest(coalesce(b.baseline_stddev, 0), 1)), coalesce(b.baseline_value, 0) * 0.35)
            THEN 'drop'
          ELSE NULL
        END AS anomaly_type,
        (
          abs(b.avg_value - coalesce(b.baseline_value, b.avg_value))
          / greatest(coalesce(b.baseline_stddev, 0), 1)
        )::double precision AS score
      FROM chosen b
      WHERE b.baseline_count >= ${MIN_BASELINE_BUCKETS}
    ),
    inserted AS (
      INSERT INTO metric_anomalies (
        org_id,
        device_id,
        source_table,
        metric_type,
        metric_name,
        anomaly_type,
        status,
        window_start,
        window_end,
        bucket_seconds,
        observed_value,
        baseline_value,
        baseline_min,
        baseline_max,
        score,
        confidence,
        sample_count,
        baseline_summary,
        evidence
      )
      SELECT
        s.org_id,
        s.device_id,
        s.source_table,
        s.metric_type,
        s.metric_name,
        s.anomaly_type,
        'open',
        s.bucket_start,
        s.bucket_start + (${RAW_BUCKET_SECONDS} * interval '1 second'),
        s.bucket_seconds,
        s.avg_value,
        s.baseline_value,
        s.baseline_min,
        s.baseline_max,
        greatest(s.score, 0),
        least(0.99, greatest(0.5, 0.5 + (s.score / 10)))::double precision,
        s.sample_count,
        jsonb_build_object(
          'modelVersion', ${METRIC_ANOMALY_VERSION}::text,
          'baselineHours', ${BASELINE_LOOKBACK_HOURS}::integer,
          'baselineGapMinutes', ${BASELINE_GAP_MINUTES}::integer,
          'baselineBuckets', s.baseline_count,
          'baselineStddev', s.baseline_stddev,
          'baselineFallback', s.used_fallback,
          'baselineExcludedBuckets', s.excluded_count
        ),
        jsonb_build_object(
          'kind', 'baseline_deviation',
          'metricName', s.metric_name,
          'observedValue', s.avg_value,
          'baselineValue', s.baseline_value
        )
      FROM scored s
      WHERE s.anomaly_type IS NOT NULL
      ON CONFLICT (org_id, device_id, metric_name, anomaly_type, bucket_seconds, window_start)
      DO UPDATE SET ${anomalyUpsertAssignments()}
      WHERE metric_anomalies.status = 'open'
      RETURNING 1
    )
    SELECT count(DISTINCT (c.device_id, c.metric_name))::integer AS "fallbackPairs"
    FROM chosen c
    WHERE c.used_fallback
  `);
  recordBaselineFallback('baseline', readFallbackPairs(result));
}
```

(A data-modifying CTE always runs to completion even though the final `SELECT` does not read it, so `inserted` needs no reference.)

- [ ] **Step 6: Replace `detectProcessSampleRunaways`**

```ts
async function detectProcessSampleRunaways(options: MetricAnomalyRange): Promise<void> {
  const { from, to } = normalizeRange(options.from, options.to);
  const fromIso = from.toISOString();
  const toIso = to.toISOString();

  const result = await db.execute(sql`
    WITH recent AS (
      SELECT
        mr.org_id,
        mr.device_id,
        mr.source_table,
        mr.metric_type,
        mr.metric_name,
        mr.bucket_start,
        mr.bucket_seconds,
        mr.avg_value,
        mr.max_value,
        mr.sample_count
      FROM metric_rollups mr
      WHERE mr.org_id = ${options.orgId}
        AND mr.source_table = 'device_process_samples'
        AND mr.bucket_seconds = ${RAW_BUCKET_SECONDS}
        AND mr.bucket_start >= ${fromIso}::timestamp
        AND mr.bucket_start < ${toIso}::timestamp
        AND mr.metric_name IN (
          'top_process_cpu_percent_sum',
          'top_process_cpu_percent_max',
          'top_process_ram_mb_sum',
          'top_process_ram_mb_max',
          'top_process_disk_bps_sum',
          'top_process_net_bps_sum'
        )
        AND mr.avg_value IS NOT NULL
        AND mr.sample_count > 0
    ),
    open_episode_buckets AS (${openEpisodeBucketsSql(options.orgId, 'device_process_samples')}),
    baseline AS (
      SELECT
        r.org_id,
        r.device_id,
        r.source_table,
        r.metric_type,
        r.metric_name,
        r.bucket_start,
        r.bucket_seconds,
        r.avg_value,
        r.max_value,
        r.sample_count,
        ${baselineAggregatesSql()}
      FROM recent r
      JOIN metric_rollups b
        ON b.org_id = r.org_id
       AND b.device_id = r.device_id
       AND b.source_table = r.source_table
       AND b.metric_type = r.metric_type
       AND b.metric_name = r.metric_name
       AND b.bucket_seconds = r.bucket_seconds
       AND b.avg_value IS NOT NULL
       AND b.sample_count > 0
       AND b.bucket_start >= r.bucket_start - (${BASELINE_LOOKBACK_HOURS} * interval '1 hour')
       AND b.bucket_start < r.bucket_start - (${BASELINE_GAP_MINUTES} * interval '1 minute')
      LEFT JOIN open_episode_buckets oeb
        ON oeb.device_id = b.device_id
       AND oeb.metric_name = b.metric_name
       AND oeb.window_start = b.bucket_start
      GROUP BY
        r.org_id,
        r.device_id,
        r.source_table,
        r.metric_type,
        r.metric_name,
        r.bucket_start,
        r.bucket_seconds,
        r.avg_value,
        r.max_value,
        r.sample_count
    ),
    chosen AS (
      SELECT
        bl.org_id,
        bl.device_id,
        bl.source_table,
        bl.metric_type,
        bl.metric_name,
        bl.bucket_start,
        bl.bucket_seconds,
        bl.avg_value,
        bl.max_value,
        bl.sample_count,
        ${chosenBaselineSql()}
      FROM baseline bl
    ),
    scored AS (
      SELECT
        b.*,
        (
          abs(b.avg_value - coalesce(b.baseline_value, b.avg_value))
          / greatest(coalesce(b.baseline_stddev, 0), 1)
        )::double precision AS score
      FROM chosen b
      WHERE b.baseline_count >= ${MIN_BASELINE_BUCKETS}
        AND (
          (
            b.metric_name IN ('top_process_cpu_percent_sum', 'top_process_cpu_percent_max')
            AND b.avg_value >= greatest(
              coalesce(b.baseline_value, 0) + (3 * greatest(coalesce(b.baseline_stddev, 0), 1)),
              coalesce(b.baseline_value, 0) * 2,
              80
            )
          )
          OR (
            b.metric_name IN ('top_process_ram_mb_sum', 'top_process_ram_mb_max')
            AND b.avg_value >= greatest(
              coalesce(b.baseline_value, 0) + (3 * greatest(coalesce(b.baseline_stddev, 0), 1)),
              coalesce(b.baseline_value, 0) * 1.75,
              1024
            )
          )
          OR (
            b.metric_name IN ('top_process_disk_bps_sum', 'top_process_net_bps_sum')
            AND b.avg_value >= greatest(
              coalesce(b.baseline_value, 0) + (4 * greatest(coalesce(b.baseline_stddev, 0), 1)),
              coalesce(b.baseline_value, 0) * 3,
              1000000
            )
          )
        )
    ),
    inserted AS (
      INSERT INTO metric_anomalies (
        org_id,
        device_id,
        source_table,
        metric_type,
        metric_name,
        anomaly_type,
        status,
        window_start,
        window_end,
        bucket_seconds,
        observed_value,
        baseline_value,
        baseline_min,
        baseline_max,
        score,
        confidence,
        sample_count,
        baseline_summary,
        evidence
      )
      SELECT
        s.org_id,
        s.device_id,
        s.source_table,
        s.metric_type,
        s.metric_name,
        CASE
          WHEN s.metric_name = 'top_process_net_bps_sum' THEN 'network_egress'
          ELSE 'process_runaway'
        END,
        'open',
        s.bucket_start,
        s.bucket_start + (${RAW_BUCKET_SECONDS} * interval '1 second'),
        s.bucket_seconds,
        s.avg_value,
        s.baseline_value,
        s.baseline_min,
        s.baseline_max,
        greatest(s.score, 0),
        least(0.99, greatest(0.55, 0.55 + (s.score / 10)))::double precision,
        s.sample_count,
        jsonb_build_object(
          'modelVersion', ${METRIC_ANOMALY_VERSION}::text,
          'baselineHours', ${BASELINE_LOOKBACK_HOURS}::integer,
          'baselineGapMinutes', ${BASELINE_GAP_MINUTES}::integer,
          'baselineBuckets', s.baseline_count,
          'baselineStddev', s.baseline_stddev,
          'baselineFallback', s.used_fallback,
          'baselineExcludedBuckets', s.excluded_count,
          'sourceTable', s.source_table
        ),
        jsonb_build_object(
          'kind', 'process_sample_runaway',
          'metricName', s.metric_name,
          'observedValue', s.avg_value,
          'baselineValue', s.baseline_value,
          'baselineMax', s.baseline_max
        )
      FROM scored s
      ON CONFLICT (org_id, device_id, metric_name, anomaly_type, bucket_seconds, window_start)
      DO UPDATE SET ${anomalyUpsertAssignments()}
      WHERE metric_anomalies.status = 'open'
      RETURNING 1
    )
    SELECT count(DISTINCT (c.device_id, c.metric_name))::integer AS "fallbackPairs"
    FROM chosen c
    WHERE c.used_fallback
  `);
  recordBaselineFallback('process-runaway', readFallbackPairs(result));
}
```

- [ ] **Step 7: Run the unit and integration tests to verify they pass**

Run: `cd apps/api && npx vitest run src/services/metricAnomalies.test.ts`
Expected: PASS (every pre-existing detector assertion still holds: `INSERT INTO metric_anomalies`, `ON CONFLICT`, `WHERE metric_anomalies.status = 'open'`, the process-series names).

Run: `cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/metricAnomalyEpisodes.integration.test.ts src/__tests__/integration/metricAnomalies.integration.test.ts`
Expected: PASS, including the zero-stddev and flat-baseline tests in `metricAnomalies.integration.test.ts` (no open episodes there, so `clean_* = raw_*`).

- [ ] **Step 8: Typecheck and commit**

Run: `cd apps/api && NODE_OPTIONS=--max-old-space-size=12288 npx tsc --noEmit -p .; echo "exit=$?"`
Expected: `exit=0`.

```bash
git add apps/api/src/services/metricAnomalies.ts apps/api/src/services/metricAnomalies.test.ts apps/api/src/__tests__/integration/metricAnomalyEpisodes.integration.test.ts
git commit -m "feat(anomalies): exclude open-episode buckets from anomaly baselines, with fallback counter" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 11: Contract suites, tenancy verification, and PR

No new code. Every command below must be run and its result read; a suite that prints "No test files found" did not run.

**Files:** none (PR body only).

**Interfaces:** consumes everything above.

- [ ] **Step 1: Re-check the migration name against `origin/main`**

Run: `git fetch origin main && git ls-tree --name-only origin/main apps/api/migrations/ | grep '\.sql$' | sort | tail -1 && bash scripts/check-migration-naming.sh --against-ref origin/main; echo "exit=$?"`
Expected: `exit=0` and the printed newest file sorts before `2026-10-27-100000-metric-anomaly-episodes.sql`. Otherwise rename (and update `MIGRATION_PATH` in `apps/api/src/db/migration-metric-anomaly-episodes.test.ts`), then re-run.

- [ ] **Step 2: Typecheck API and shared**

Run: `cd apps/api && NODE_OPTIONS=--max-old-space-size=12288 npx tsc --noEmit -p .; echo "exit=$?"`
Run: `cd packages/shared && npx tsc --noEmit; echo "exit=$?"`
Expected: `exit=0` for both. Never pipe tsc through `tail` — an OOM prints nothing and reads green.

- [ ] **Step 3: Unit suites for touched files, then the full API unit suite**

Run: `cd apps/api && npx vitest run src/services/metricAnomalies.test.ts src/services/metricAnomalyEpisodes.test.ts src/services/metricAnomalyEpisodeKeys.test.ts src/services/metricAnomalyEpisodePlanner.test.ts src/services/metricAnomalyEpisodeMetrics.test.ts src/services/tenantExportPolicyRegistry.metricAnomalyEpisodes.test.ts src/jobs/metricAnomalies.test.ts src/jobs/mlOutputRetention.test.ts src/routes/devices/anomalies.test.ts src/routes/devices/cascadeDelete.test.ts src/routes/devices/moveOrg.coverage.test.ts src/db/migration-metric-anomaly-episodes.test.ts src/db/autoMigrate.test.ts src/db/migrationRlsScope.test.ts src/services/workerEntrypointClosure.contract.test.ts`
Expected: PASS, file count 15.

Run: `cd packages/shared && npx vitest run src/types/metricAnomalyEpisodes.test.ts`
Expected: PASS.

Run: `cd apps/api && npx vitest run`
Expected: PASS. This is the only run where `orgMerge.test.ts`'s cascade walk sees every table.

- [ ] **Step 4: Integration contracts against the private stack**

The stack from Task 7 Step 1 should still be up (`pnpm test-stack up` again if not).

Run:

```bash
cd apps/api && npx vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/metricAnomalyEpisodes.integration.test.ts \
  src/__tests__/integration/metricAnomalies.integration.test.ts \
  src/__tests__/integration/mlOutputRetention.integration.test.ts \
  src/__tests__/integration/tenantCascade.integration.test.ts \
  src/__tests__/integration/tenant-export-policy.integration.test.ts \
  src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts \
  src/__tests__/integration/orgMergeRegistry.integration.test.ts \
  src/__tests__/integration/orgLifecycleFoundations.integration.test.ts
```

Expected: PASS, 8 files. `tenantCascade` must report `metric_anomaly_episodes` present, alphabetised, and FK-children-first; `tenant-export-policy` must report every column classified.

- [ ] **Step 5: RLS coverage contract**

Run: `DB_CONTEXTLESS_WRITE_STRICT=true pnpm --filter=@breeze/api test:rls-coverage`
Expected: PASS with `metric_anomaly_episodes` auto-discovered as shape 1 (no allowlist edit). "No test files found" means the wrong config ran.

- [ ] **Step 6: Ledger drift**

Run: `cd apps/api && set -a && . ../../.env.test && set +a && pnpm db:check-drift; echo "exit=$?"`
Expected: `No drift detected — all N migration files match the breeze_migrations ledger.` and `exit=0`.

- [ ] **Step 7: Forge a cross-tenant insert as `breeze_app`**

Run:

```bash
set -a && . ./.env.test && set +a && psql "$DATABASE_URL_APP" <<'SQL'
BEGIN;
SELECT set_config('breeze.scope', 'organization', true);
SELECT set_config('breeze.accessible_org_ids', '00000000-0000-4000-8000-00000000000a', true);
INSERT INTO metric_anomaly_episodes (
  org_id, device_id, episode_key, source_table, anomaly_type, metric_family, metric_names,
  first_seen_at, last_seen_at, bucket_count, peak_value, peak_metric_name, peak_score, peak_at
) VALUES (
  '00000000-0000-4000-8000-00000000000b', '00000000-0000-4000-8000-00000000000c',
  'device_metrics:spike:cpu', 'device_metrics', 'spike', 'cpu', ARRAY['cpu_percent'],
  now(), now() + interval '5 minutes', 1, 99, 'cpu_percent', 9, now()
);
ROLLBACK;
SQL
```

Expected: `ERROR:  new row violates row-level security policy for table "metric_anomaly_episodes"`. Paste the line into the PR. (If `psql` is not installed locally, run the same heredoc through `docker exec -i <test-stack postgres container> psql -U breeze_app -d breeze_test`; `pnpm test-stack ls` names the container.)

- [ ] **Step 8: Tear down**

Run (repo root): `pnpm test-stack down`
Expected: the worktree's pg/redis project is removed. Say in the PR/hand-off that nothing was left running.

- [ ] **Step 9: Open the PR**

PR title: `feat(anomalies): metric anomaly episodes W01 — table, assembly, auto-resolve, attribution, baseline anti-contamination`

PR body must include:

- `Closes #<W01 sub-issue>` and the spec path.
- **Three grouping grains.** `metric_anomalies` = one row per bucket per metric (evidence); `metric_anomaly_incidents` = the AI dispatch outbox, one per bucket per anomaly type, grain unchanged; `metric_anomaly_episodes` = the lifecycle a tech sees. Incident counts and episode counts differ by design.
- **Attribution is `excludedOpen`.** Process snapshots are visible in the UI but absent from the GDPR/tenant export (jsonb rule).
- Tenancy: shape 1; cascade, device, merge (`repoint`), export (new table + `metric_anomalies.episode_id`, `metric_anomaly_incidents.episode_id` / `suppressed_by_episode`), retention registrations; the `breeze_app` forge output from Step 7.
- Behaviour: `episode-resolve` runs with `ml.anomalies.enabled` off and never on a backfill; `scan-orgs` also fans out to orgs that still own an open episode; the legacy route accepts `status=cleared`; alert auto-resolve for promoted episodes lands in W02 (W01 only hands `linkedAlertId` to a no-op handler).
- The spec-deviation table from the top of this plan.
- New metrics: `metric_anomaly_episode_stage_skipped_total{stage}`, `metric_anomaly_baseline_fallback_total{detector}`.
- Every command of Steps 2-7 with its result.

Stacked-branch rule: this PR targets `main`; if it is ever re-based onto a sibling branch, dispatch CI with `gh workflow run CI --ref <branch>`.

---

## Contract amendments for the plan index

Already applied to the index's contract table during plan reconciliation (2026-09-22); listed here so the W01 reviewer can check the code against them.

| Name | Where | Defined in | Shape |
|---|---|---|---|
| `assembleMetricAnomalyEpisodes(range: MetricAnomalyRange)` | `apps/api/src/services/metricAnomalyEpisodes.ts` | W01 | **amended** `→ Promise<EpisodeCloseResult[]>` (the episodes it superseded; deviation 8) |
| `EpisodeCloseHandler`, `notifyEpisodesClosed` | same file | W01 | `(orgId: string, closed: EpisodeCloseResult[]) => Promise<void>`; `setEpisodeCloseHandler(fn: EpisodeCloseHandler \| null)` — `null` restores the no-op |
| `MetricAnomalyTrigger` | `apps/api/src/services/metricAnomalies.ts` | W01 | `'scan' \| 'backfill'` (named type for `MetricAnomalyRange.trigger`) |
| `MetricAnomalyResult.episodesClosed` | same file | W01 | `number` |
| `METRIC_ANOMALY_STATUSES`, `METRIC_ANOMALY_EPISODE_STATUSES`, `EPISODE_CLOSE_REASONS`, `ATTRIBUTION_DIMENSIONS` | `packages/shared/src/types/metricAnomalyEpisodes.ts` | W01 | runtime `as const` arrays behind the contract unions (W02 zod enums use them) |
| `EPISODE_BUCKET_SECONDS` | `apps/api/src/services/metricAnomalyEpisodes.ts` (re-export) | W01 | `300`, not env-overridable |

## Open questions for the owner

1. **Close reason for superseded and historical episodes** (deviation 1): `cleared` with ≥ 6 clean buckets per metric before the next island, else `expired_no_data`. Acceptable, or should they get a distinct reason (a new CHECK value such as `superseded`)?
2. ~~Orgs with only decommissioned devices are not scanned~~ — **resolved in this wave**: Task 9 Step 6b adds orgs with an `open` episode to the `scan-orgs` fan-out.
3. **`bucket_count` counts distinct buckets** (deviation 4). W04's "N detections" chip reads `bucketCount` (one detection = one anomalous 5-minute bucket); its member table can hold two rows per bucket for the cpu/ram pairs. Accepted at reconciliation.
4. **Snoozed successors extend** (deviation 3) rather than one dismissed episode per tick. Accepted at reconciliation.

## Self-review (run by the plan author)

1. **Spec coverage (W01 rows of §17 and §14/§16):** migration items 1-6 → Task 2; Drizzle schema → Task 2; shared types → Task 1; `episodeKeyFor` + constants → Task 5; assembly stage incl. snooze successor → Tasks 6-7, 9; attribution LATERAL → Task 7; auto-resolve (flag-independent, skipped on backfill) → Tasks 8-9; orgs with open episodes still scanned → Task 9 Step 6b; close-handler hook → Task 8; `cleared` status in CHECK + legacy route enum → Tasks 1-2; anti-contamination + fallback + counter → Task 10; skip counter → Tasks 5, 9; every §14 registration → Task 3 (+ retention Task 4); §16 integration proofs: 17-bucket + ram pair (Task 7), 31-min split + recurrence (Task 7), cleared/5-bucket/expired_no_data/expired_offline (Task 8), resolve with flag off (Task 9), snooze successor (Task 7), hour-5 + fallback (Task 10), backfill lower bound (Task 7); contract suites → Task 11. Not in W01 by design: episode routes, promotion via episode, feedback rows, publisher gate (W02); evaluation (W03); web (W04).
2. **Placeholder scan:** every code step carries the code; the only deferred behaviour (alert resolve) is an explicit W02 contract item.
3. **Type consistency:** `EpisodeCloseResult`, `MetricAnomalyTrigger`, `PlannedAttach.attributionDimension`, `memberStatusFor`, `recordBaselineFallback('baseline' | 'process-runaway', n)`, `recordEpisodeStageSkipped('episodes' | 'episode-resolve')` and `episodesClosed` are spelled the same in every task that uses them.
