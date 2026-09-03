import { Job, Queue, Worker } from 'bullmq';
import { inArray, sql } from 'drizzle-orm';
import * as dbModule from '../db';
import { db } from '../db';
import { metricAnomalyIncidents } from '../db/schema/metricAnomalyIncidents';
import { getBullMQConnection } from '../services/redis';
import { publishEvent } from '../services/eventBus';
import { captureException } from '../services/sentry';

/**
 * Drains the `metric_anomaly_incidents` transactional dispatch marker
 * (#3828 wave-6-4 task 2 —
 * docs/superpowers/plans/ai-mcp/2026-08-28-ai-agents-wave6-4-anomaly-pilot.md)
 * onto the generic eventBus (`publishEvent`), with an id-only payload. Direct
 * clone of `ticketOutboxPublisher.ts`'s claim → publish → mark-dispatched
 * shape (same #1105 DB-context discipline — see that file's doc comment for
 * the full rationale), with the outbox-row's `published_at` marker replaced
 * by the incident row's own `dispatched_at` — there is no separate outbox
 * table here. `metricAnomaliesTable.ts`'s (`metricAnomalyIncidents.ts`)
 * header explains why that's safe: the detector's upsert (`metricAnomalies.
 * ts`'s `upsertMetricAnomalyIncidents`) never assigns `dispatched_at` /
 * `dispatch_attempts` / `agent_run_id` in its `DO UPDATE SET` list, so a bulk
 * re-upsert of an already-dispatched incident can never clear the marker
 * this publisher just set.
 *
 * Unlike `ticket_outbox` (six event types, three bridged), there is exactly
 * ONE event type here (`anomaly.incident_opened`) and every claimed row maps
 * to it — no per-row type-to-EventType lookup table needed.
 *
 * Payload shape: `{ incidentId, deviceId }` — id-only, deliberately. The
 * consuming subscriber (Task 3) loads the incident + sibling
 * `metric_anomalies` rows itself; this publisher never reads or forwards
 * anomaly detail (score, metric names, evidence/baseline excerpts).
 *
 * Claim ordering: `metric_anomaly_incidents_undispatched_idx` is
 * `(org_id, id) WHERE dispatched_at IS NULL` (see the migration's comment on
 * that index) — a compound index, unlike `ticket_outbox`'s single-column
 * `id` bigserial ordering, because this table's `id` is a random
 * `gen_random_uuid()` PK with no temporal ordering of its own. Both the
 * stuck-scan and the claim CTE order by `(org_id, id)` to walk that index
 * rather than by `id` alone.
 */

const REAPER_QUEUE_NAME = 'metric-anomaly-incident-publisher';
const PUBLISH_INTERVAL_MS = 5 * 1000; // every 5s
const MAX_PUBLISH_PER_RUN = 200;
// Rows with dispatch_attempts > this are considered stuck: logged as an
// alarm and left alone rather than retried forever. Exported so
// metricAnomalyIncidentRetention.ts's prune cutoff stays in sync with this
// threshold instead of duplicating the magic number (#4210).
export const MAX_PUBLISH_ATTEMPTS = 5;

type PublisherJobData = { type: 'publish-anomaly-incidents'; queuedAt: string };

const runWithSystemDbAccess = async <T>(fn: () => Promise<T>): Promise<T> => {
  const withSystem = dbModule.withSystemDbAccessContext;
  if (typeof withSystem !== 'function') {
    throw new Error(
      '[MetricAnomalyIncidentPublisher] withSystemDbAccessContext not available — publisher cannot run without system DB access',
    );
  }
  return withSystem(fn);
};

// #1105 — explicitly exits any DB access context before running `fn`. Used to
// wrap the publish loop so a Redis round-trip per row can never run while a
// pooled connection is pinned idle-in-transaction, even though `publishEvent`
// itself already does this internally (eventBus.ts's `publish()`) — belt and
// suspenders, matching the ticketOutboxPublisher precedent exactly.
const runOutsideDbContext = <T>(fn: () => T): T => {
  const runOutside = dbModule.runOutsideDbContext;
  if (typeof runOutside !== 'function') {
    return fn();
  }
  return runOutside(fn);
};

let reaperQueue: Queue<PublisherJobData> | null = null;
let reaperWorker: Worker<PublisherJobData> | null = null;

function getQueue(): Queue<PublisherJobData> {
  if (!reaperQueue) {
    reaperQueue = new Queue<PublisherJobData>(REAPER_QUEUE_NAME, {
      connection: getBullMQConnection(),
    });
  }
  return reaperQueue;
}

type StuckIncidentRow = {
  id: string;
  device_id: string;
  dispatch_attempts: number;
};

type ClaimedIncidentRow = {
  id: string;
  org_id: string;
  device_id: string;
  dispatch_attempts: number;
};

function extractRows<T>(result: unknown): T[] {
  const rows = (result as { rows?: T[] }).rows ?? (result as T[]);
  return Array.isArray(rows) ? rows : [];
}

export interface PublishIncidentsResult {
  published: number;
  skipped: number;
}

interface ClaimResult {
  stuckRows: StuckIncidentRow[];
  claimedRows: ClaimedIncidentRow[];
}

/**
 * Phase 1 (CLAIM) — DB-only work. Runs inside its own short
 * `withSystemDbAccessContext` transaction (opened by the caller) so the held
 * connection covers only these two statements, never the publish loop.
 */
async function scanAndClaimIncidentRows(): Promise<ClaimResult> {
  // Read-only alarm scan — never locked, never mutated.
  const stuck = await db.execute<StuckIncidentRow>(sql`
    SELECT id, device_id, dispatch_attempts
    FROM ${metricAnomalyIncidents}
    WHERE ${metricAnomalyIncidents.dispatchedAt} IS NULL
      AND ${metricAnomalyIncidents.dispatchAttempts} > ${MAX_PUBLISH_ATTEMPTS}
    ORDER BY ${metricAnomalyIncidents.orgId}, ${metricAnomalyIncidents.id}
    LIMIT ${MAX_PUBLISH_PER_RUN}
  `);
  const stuckRows = extractRows<StuckIncidentRow>(stuck);
  for (const row of stuckRows) {
    const message =
      `[MetricAnomalyIncidentPublisher] metric_anomaly_incidents row ${row.id} (device ${row.device_id}) `
      + `stuck at ${row.dispatch_attempts} dispatch attempts — skipping`;
    console.error(message);
    captureException(new Error(message));
  }

  // Atomically claim live rows and bump dispatch_attempts.
  const claimed = await db.execute<ClaimedIncidentRow>(sql`
    WITH due AS (
      SELECT id
      FROM ${metricAnomalyIncidents}
      WHERE ${metricAnomalyIncidents.dispatchedAt} IS NULL
        AND ${metricAnomalyIncidents.dispatchAttempts} <= ${MAX_PUBLISH_ATTEMPTS}
      ORDER BY ${metricAnomalyIncidents.orgId}, ${metricAnomalyIncidents.id}
      LIMIT ${MAX_PUBLISH_PER_RUN}
      FOR UPDATE SKIP LOCKED
    )
    UPDATE ${metricAnomalyIncidents} AS i
    SET dispatch_attempts = i.dispatch_attempts + 1
    FROM due
    WHERE i.id = due.id
    RETURNING i.id, i.org_id, i.device_id, i.dispatch_attempts;
  `);
  const claimedRows = extractRows<ClaimedIncidentRow>(claimed);

  return { stuckRows, claimedRows };
}

/**
 * Phase 2 (PUBLISH) — no DB context. Caller must invoke this via
 * `runOutsideDbContext` so the Redis round-trip never runs while a pooled
 * connection is pinned idle-in-transaction (#1105).
 */
async function publishClaimedRows(rows: ClaimedIncidentRow[]): Promise<string[]> {
  const publishedIds: string[] = [];
  for (const row of rows) {
    try {
      // id-only by construction — never anomaly detail (score, metric
      // names, evidence/baseline excerpts). See the file doc comment.
      await publishEvent(
        'anomaly.incident_opened',
        row.org_id,
        { incidentId: row.id, deviceId: row.device_id },
        'metric-anomaly-incident-publisher',
      );
      publishedIds.push(row.id);
    } catch (err) {
      console.error(`[MetricAnomalyIncidentPublisher] Failed to publish incident row ${row.id}:`, err);
      captureException(err instanceof Error ? err : new Error(String(err)));
      // Leave dispatched_at NULL — next pass retries; attempt already counted above.
    }
  }
  return publishedIds;
}

/**
 * Phase 3 (MARK DISPATCHED) — DB-only work, its own short
 * `withSystemDbAccessContext` transaction opened by the caller, entirely
 * separate from the claim transaction so it never overlaps the publish loop.
 */
async function markIncidentRowsDispatched(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await db
    .update(metricAnomalyIncidents)
    .set({ dispatchedAt: sql`now()` })
    .where(inArray(metricAnomalyIncidents.id, ids));
}

/**
 * Single pass over `metric_anomaly_incidents`. Returns the number of rows
 * successfully published and the number of rows skipped as permanently
 * stuck.
 *
 * Orchestrates its own DB-context boundaries (claim → publish → mark
 * dispatched) so no caller may accidentally hold a DB transaction open
 * across the publish loop (#1105). Callers must invoke this directly, never
 * wrapped in an outer `withSystemDbAccessContext`.
 */
export async function publishPendingIncidents(): Promise<PublishIncidentsResult> {
  // Phase 1: claim, inside a short DB context that closes before we return.
  const { stuckRows, claimedRows } = await runWithSystemDbAccess(scanAndClaimIncidentRows);

  if (claimedRows.length === 0) {
    return { published: 0, skipped: stuckRows.length };
  }

  // Phase 2: publish, explicitly outside any DB context — the claiming
  // transaction from phase 1 has already committed, but we exit defensively
  // in case a future caller nests `publishPendingIncidents` inside its own
  // context.
  const publishedIds = await runOutsideDbContext(() => publishClaimedRows(claimedRows));

  // Phase 3: mark successfully-published rows dispatched, in a second short
  // DB context that never overlaps the publish loop above.
  if (publishedIds.length > 0) {
    await runWithSystemDbAccess(() => markIncidentRowsDispatched(publishedIds));
  }

  if (claimedRows.length === MAX_PUBLISH_PER_RUN) {
    console.warn(
      `[MetricAnomalyIncidentPublisher] Hit ${MAX_PUBLISH_PER_RUN}-item cap — backlog may be growing`,
    );
  }

  return { published: publishedIds.length, skipped: stuckRows.length };
}

function createWorker(): Worker<PublisherJobData> {
  return new Worker<PublisherJobData>(
    REAPER_QUEUE_NAME,
    async (_job: Job<PublisherJobData>) => {
      try {
        // publishPendingIncidents manages its own DB-context boundaries
        // internally (claim → publish → mark-dispatched) — it must NOT be
        // wrapped in an outer withSystemDbAccessContext here, or the publish
        // loop would run inside a held transaction (#1105).
        const { published, skipped } = await publishPendingIncidents();
        if (published > 0 || skipped > 0) {
          console.log(
            `[MetricAnomalyIncidentPublisher] Published ${published} incident(s), ${skipped} stuck`,
          );
        }
        return { published, skipped };
      } catch (err) {
        console.error('[MetricAnomalyIncidentPublisher] Run failed:', err);
        captureException(err instanceof Error ? err : new Error(String(err)));
        throw err;
      }
    },
    {
      connection: getBullMQConnection(),
      concurrency: 1,
    },
  );
}

async function scheduleRepeatableJob(): Promise<void> {
  const queue = getQueue();

  const repeatables = await queue.getRepeatableJobs();
  for (const job of repeatables) {
    if (job.name === 'publish-anomaly-incidents') {
      await queue.removeRepeatableByKey(job.key);
    }
  }

  await queue.add(
    'publish-anomaly-incidents',
    { type: 'publish-anomaly-incidents', queuedAt: new Date().toISOString() },
    {
      jobId: 'metric-anomaly-incident-publisher',
      repeat: { every: PUBLISH_INTERVAL_MS },
      removeOnComplete: { count: 20 },
      removeOnFail: { count: 200 },
    },
  );
}

export async function initializeMetricAnomalyIncidentPublisher(): Promise<void> {
  if (reaperWorker) return;

  reaperWorker = createWorker();
  reaperWorker.on('error', (error) => {
    console.error('[MetricAnomalyIncidentPublisher] Worker error:', error);
    captureException(error);
  });
  reaperWorker.on('failed', (job, error) => {
    console.error(`[MetricAnomalyIncidentPublisher] Job ${job?.id} failed:`, error);
    captureException(error);
  });

  try {
    await scheduleRepeatableJob();
  } catch (err) {
    await reaperWorker.close();
    reaperWorker = null;
    throw err;
  }

  console.log('[MetricAnomalyIncidentPublisher] Initialized');
}

export async function shutdownMetricAnomalyIncidentPublisher(): Promise<void> {
  const worker = reaperWorker;
  const queue = reaperQueue;
  reaperWorker = null;
  reaperQueue = null;

  if (worker) {
    try {
      await worker.close();
    } catch (err) {
      console.error('[MetricAnomalyIncidentPublisher] Error closing worker:', err);
    }
  }
  if (queue) {
    try {
      await queue.close();
    } catch (err) {
      console.error('[MetricAnomalyIncidentPublisher] Error closing queue:', err);
    }
  }
}
