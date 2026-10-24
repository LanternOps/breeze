/**
 * DNS Security retention and background integration delete (#10019, #10020).
 *
 * Two jobs share one queue and one worker (concurrency 1):
 *
 *  - `sweep` (daily, registry slot `dns-security-retention`): for every
 *    integration, deletes `dns_security_events` and `dns_event_aggregations`
 *    rows older than that integration's `config.retentionDays`, or
 *    DEFAULT_DNS_SECURITY_RETENTION_DAYS when unset. Before this, retention ran
 *    only inline inside a successful sync slice, only for events, only when
 *    `retentionDays` was set, as one unbatched DELETE — so a typical integration
 *    was never pruned and aggregations never were (#10020: 29.7M / 16.9M rows).
 *
 *  - `delete-integration` (on demand, enqueued by
 *    DELETE /dns-security/integrations/:id after it flips the row to
 *    is_active=false + last_sync_status='deleting'): drains aggregations then
 *    events in batches, then removes policies and the integration row. The old
 *    route did this in one request transaction, which ran for minutes,
 *    deadlocked with the still-running sync, and finally failed on the
 *    aggregations FK it never cleared (#10019).
 *
 * Why one queue: both jobs are batched DELETEs on the same two tables. A single
 * worker at concurrency 1 serialises them, so a 30M-row delete and the nightly
 * sweep never compete for the same rows, and the sweep can see — and repair —
 * a delete whose enqueue was lost (the route enqueues after commit, fire and
 * forget; see `requeueStrandedDeletes`).
 *
 * Every batch is its own system-context transaction (`pruneInCtidBatches`, see
 * retentionBatch.ts). Neither job wraps its loop in a context.
 *
 * A delete that hits its batch cap enqueues a continuation rather than running
 * for hours inside one job: progress survives a worker restart (the predicate
 * is simply "rows still referencing the integration") and the nightly sweep can
 * interleave. A sweep that hits its cap leaves the remainder for the next night
 * and says so (`warnOnRetentionBacklog`); raise the batch knobs if it repeats.
 */

import { Queue, Worker, type Job, type JobsOptions } from 'bullmq';
import { and, eq, sql } from 'drizzle-orm';

import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { dnsFilterIntegrations, dnsPolicies } from '../db/schema';
import { getBullMQConnection } from '../services/redis';
import { recordRetentionRun } from '../services/retentionMetrics';
import { captureException } from '../services/sentry';
import {
  parsePositiveIntEnv,
  pruneInCtidBatches,
  resolveRetentionDays,
  warnOnRetentionBacklog,
  type BatchedPruneResult,
} from './retentionBatch';
import { jobSchedule } from './scheduleRegistry';
import { attachWorkerObservability } from './workerObservability';

const LOG_PREFIX = '[DnsSecurityRetention]';
const QUEUE_NAME = 'dns-security-retention';
const SWEEP_JOB_NAME = 'sweep';
const DELETE_JOB_NAME = 'delete-integration';
const EVENTS_TABLE = 'dns_security_events';
const AGGREGATIONS_TABLE = 'dns_event_aggregations';
const DAY_MS = 86_400_000;

/**
 * `last_sync_status` value marking an integration whose delete is in progress.
 * Set together with `is_active = false` by the DELETE route. The sync job only
 * runs active integrations, so the row is never synced again; the API refuses
 * to sync or edit it; the nightly sweep re-enqueues its delete if the job was
 * lost.
 */
export const DNS_INTEGRATION_DELETING_STATUS = 'deleting';

/** Matches the 1–365 bound the integration config validator accepts. */
const MAX_RETENTION_DAYS = 365;

/**
 * Retention applied when an integration has no `config.retentionDays`.
 * Env override: DNS_SECURITY_RETENTION_DAYS_DEFAULT.
 */
const DEFAULT_DNS_SECURITY_RETENTION_DAYS = resolveRetentionDays(
  process.env.DNS_SECURITY_RETENTION_DAYS_DEFAULT, 90, MAX_RETENTION_DAYS, LOG_PREFIX,
);

// Larger than the generic retention defaults on purpose: DNS logs arrive at
// millions of rows a day on a busy org, and a nightly cap below the ingest rate
// means the table never shrinks. 5,000 rows per batch x 400 batches = up to 2M
// rows per table per integration per night; each batch commits on its own.
const BATCH_SIZE = parsePositiveIntEnv(LOG_PREFIX, 'DNS_SECURITY_RETENTION_BATCH_SIZE', 5000);
const MAX_BATCHES = parsePositiveIntEnv(LOG_PREFIX, 'DNS_SECURITY_RETENTION_MAX_BATCHES', 400);

const DELETE_JOB_OPTIONS: JobsOptions = {
  // The final row delete can lose a deadlock to a sync slice that was already
  // mid-transaction when the row was deactivated; every step is idempotent, so
  // retrying is the whole recovery.
  attempts: 5,
  backoff: { type: 'exponential', delay: 30_000 },
  removeOnComplete: { count: 50 },
  removeOnFail: { count: 50 },
};

export interface DnsSecurityRetentionJobData {
  defaultRetentionDays?: number;
  batchSize?: number;
  maxBatches?: number;
}

export interface DnsIntegrationDeleteJobData {
  integrationId: string;
  batchSize?: number;
  maxBatches?: number;
}

type JobData = DnsSecurityRetentionJobData | DnsIntegrationDeleteJobData;

export interface DnsSecurityRetentionResult {
  deleted: number;
  hasMore: boolean;
  integrations: number;
  requeuedDeletes: number;
  durationMs: number;
}

export type DnsIntegrationDeleteStatus = 'deleted' | 'continuing' | 'gone' | 'skipped_active';

export interface DnsIntegrationDeleteResult {
  status: DnsIntegrationDeleteStatus;
  aggregationsDeleted: number;
  eventsDeleted: number;
}

let retentionQueue: Queue<JobData> | null = null;
let retentionWorker: Worker<JobData> | null = null;

export function getDnsSecurityRetentionQueue(): Queue<JobData> {
  if (!retentionQueue) {
    retentionQueue = new Queue<JobData>(QUEUE_NAME, { connection: getBullMQConnection() });
  }
  return retentionQueue;
}

function inFreshSystemContext<T>(label: string, fn: () => Promise<T>): Promise<T> {
  return runOutsideDbContext(() => withSystemDbAccessContext(fn, label));
}

/**
 * Queue the background delete of an integration the caller has ALREADY marked
 * inactive + deleting (and committed). The job re-checks that marker and does
 * nothing for an active row.
 */
export async function enqueueDnsIntegrationDelete(
  integrationId: string,
  overrides: { batchSize?: number; maxBatches?: number } = {},
): Promise<void> {
  const data: DnsIntegrationDeleteJobData = { integrationId, ...overrides };
  await getDnsSecurityRetentionQueue().add(DELETE_JOB_NAME, data, DELETE_JOB_OPTIONS);
}

// --------------------------------------------------------------------- sweep

function isDeleting(row: { isActive: boolean; lastSyncStatus: string | null }): boolean {
  return !row.isActive && row.lastSyncStatus === DNS_INTEGRATION_DELETING_STATUS;
}

/**
 * Re-enqueue deletes that have no job in flight. The route enqueues after its
 * transaction commits and cannot fail the request if Redis is down, so a lost
 * enqueue would otherwise leave the row inactive forever.
 */
async function requeueStrandedDeletes(integrationIds: string[]): Promise<number> {
  if (integrationIds.length === 0) return 0;
  const queue = getDnsSecurityRetentionQueue();
  const inFlight = await queue.getJobs(['waiting', 'active', 'delayed', 'prioritized', 'waiting-children']);
  const queued = new Set(
    inFlight
      .filter((job) => job?.name === DELETE_JOB_NAME)
      .map((job) => (job.data as DnsIntegrationDeleteJobData).integrationId),
  );
  let requeued = 0;
  for (const id of integrationIds) {
    if (queued.has(id)) continue;
    await enqueueDnsIntegrationDelete(id);
    requeued += 1;
    console.warn(`${LOG_PREFIX} Re-enqueued the background delete of integration ${id} (no job in flight)`);
  }
  return requeued;
}

export async function runDnsSecurityRetention(
  job: DnsSecurityRetentionJobData = {},
): Promise<DnsSecurityRetentionResult> {
  const startedAt = Date.now();
  const defaultDays = resolveRetentionDays(
    job.defaultRetentionDays, DEFAULT_DNS_SECURITY_RETENTION_DAYS, MAX_RETENTION_DAYS,
  );
  const batchSize = Math.max(1, job.batchSize ?? BATCH_SIZE);
  const maxBatches = Math.max(1, job.maxBatches ?? MAX_BATCHES);

  const integrations = await inFreshSystemContext('dnsSecurityRetention.list', () =>
    db
      .select({
        id: dnsFilterIntegrations.id,
        orgId: dnsFilterIntegrations.orgId,
        config: dnsFilterIntegrations.config,
        isActive: dnsFilterIntegrations.isActive,
        lastSyncStatus: dnsFilterIntegrations.lastSyncStatus,
      })
      .from(dnsFilterIntegrations),
  );

  let deleted = 0;
  let hasMore = false;
  const stranded: string[] = [];

  const track = (table: string, result: BatchedPruneResult, detail?: string) => {
    deleted += result.deleted;
    hasMore ||= result.hasMore;
    warnOnRetentionBacklog(LOG_PREFIX, table, result, detail);
  };

  for (const integration of integrations) {
    if (isDeleting(integration)) {
      stranded.push(integration.id);
      continue;
    }
    // Inactive (but not deleting) integrations still age out: the rows are
    // retained history, and the window applies to them the same way.
    const days = resolveRetentionDays(integration.config?.retentionDays, defaultDays, MAX_RETENTION_DAYS);
    const cutoff = new Date(startedAt - days * DAY_MS);
    // postgres-js does not coerce a JS Date in a template param (retentionBatch.ts).
    const cutoffIso = cutoff.toISOString();
    const cutoffDate = cutoffIso.slice(0, 10);
    const detail = `integration=${integration.id} retentionDays=${days}`;

    // org_id first so each batch is a range scan on (org_id, timestamp) /
    // (org_id, date, integration_id) instead of every row of the integration.
    track(EVENTS_TABLE, await pruneInCtidBatches({
      table: EVENTS_TABLE,
      where: sql`org_id = ${integration.orgId} AND "timestamp" < ${cutoffIso}::timestamp AND integration_id = ${integration.id}`,
      batchSize,
      maxBatches,
      label: 'dnsSecurityRetention.events',
    }), detail);

    track(AGGREGATIONS_TABLE, await pruneInCtidBatches({
      table: AGGREGATIONS_TABLE,
      where: sql`org_id = ${integration.orgId} AND "date" < ${cutoffDate}::date AND integration_id = ${integration.id}`,
      batchSize,
      maxBatches,
      label: 'dnsSecurityRetention.aggregations',
    }), detail);
  }

  // Aggregation rows written before integration_id existed (0031) belong to no
  // integration; they age out at the default window.
  const legacyCutoffDate = new Date(startedAt - defaultDays * DAY_MS).toISOString().slice(0, 10);
  track(AGGREGATIONS_TABLE, await pruneInCtidBatches({
    table: AGGREGATIONS_TABLE,
    where: sql`integration_id IS NULL AND "date" < ${legacyCutoffDate}::date`,
    batchSize,
    maxBatches,
    label: 'dnsSecurityRetention.aggregations.legacy',
  }), 'integration=none');

  const requeuedDeletes = await requeueStrandedDeletes(stranded);

  const durationMs = Date.now() - startedAt;
  console.log(
    `${LOG_PREFIX} Deleted ${deleted} DNS event/aggregation rows across ${integrations.length} integrations ` +
    `(default retention ${defaultDays} days, requeued deletes ${requeuedDeletes}) in ${durationMs}ms`,
  );
  recordRetentionRun('dns_security_retention', { rowsDeleted: deleted, incomplete: hasMore });

  return { deleted, hasMore, integrations: integrations.length, requeuedDeletes, durationMs };
}

// -------------------------------------------------------------------- delete

export async function runDnsIntegrationDelete(
  job: DnsIntegrationDeleteJobData,
): Promise<DnsIntegrationDeleteResult> {
  const { integrationId } = job;
  const batchSize = Math.max(1, job.batchSize ?? BATCH_SIZE);
  const maxBatches = Math.max(1, job.maxBatches ?? MAX_BATCHES);
  const result: DnsIntegrationDeleteResult = { status: 'gone', aggregationsDeleted: 0, eventsDeleted: 0 };

  const [row] = await inFreshSystemContext('dnsIntegrationDelete.read', () =>
    db
      .select({ id: dnsFilterIntegrations.id, isActive: dnsFilterIntegrations.isActive })
      .from(dnsFilterIntegrations)
      .where(eq(dnsFilterIntegrations.id, integrationId)),
  );
  if (!row) return result;
  if (row.isActive) {
    // Only the DELETE route enqueues this job, and only after deactivating the
    // row. An active row here means it was re-enabled: never delete it.
    console.warn(`${LOG_PREFIX} Skipping delete of integration ${integrationId}: it is active`);
    return { ...result, status: 'skipped_active' };
  }

  const continuation = async (): Promise<DnsIntegrationDeleteResult> => {
    await getDnsSecurityRetentionQueue().add(
      DELETE_JOB_NAME,
      { integrationId, batchSize: job.batchSize, maxBatches: job.maxBatches },
      DELETE_JOB_OPTIONS,
    );
    return { ...result, status: 'continuing' };
  };

  const aggregations = await pruneInCtidBatches({
    table: AGGREGATIONS_TABLE,
    where: sql`integration_id = ${integrationId}`,
    batchSize,
    maxBatches,
    label: 'dnsIntegrationDelete.aggregations',
  });
  result.aggregationsDeleted = aggregations.deleted;
  if (aggregations.hasMore) return continuation();

  const events = await pruneInCtidBatches({
    table: EVENTS_TABLE,
    where: sql`integration_id = ${integrationId}`,
    batchSize,
    maxBatches,
    label: 'dnsIntegrationDelete.events',
  });
  result.eventsDeleted = events.deleted;
  if (events.hasMore) return continuation();

  // Final step in one transaction. The row lock re-checks the marker against a
  // concurrent re-enable; the FKs cascade (2027-01-05-100300), so any event or
  // aggregation a still-running sync slice inserted after the drain goes with
  // the parent instead of blocking it.
  const removed = await inFreshSystemContext('dnsIntegrationDelete.final', async () => {
    const locked = await db
      .select({ id: dnsFilterIntegrations.id })
      .from(dnsFilterIntegrations)
      .where(and(eq(dnsFilterIntegrations.id, integrationId), eq(dnsFilterIntegrations.isActive, false)))
      .for('update');
    if (locked.length === 0) return false;
    await db.delete(dnsPolicies).where(eq(dnsPolicies.integrationId, integrationId));
    await db.delete(dnsFilterIntegrations).where(eq(dnsFilterIntegrations.id, integrationId));
    return true;
  });

  if (!removed) {
    console.warn(`${LOG_PREFIX} Integration ${integrationId} was re-enabled or removed before the final delete`);
    return { ...result, status: 'skipped_active' };
  }

  console.log(
    `${LOG_PREFIX} Deleted integration ${integrationId} ` +
    `(this job: ${result.aggregationsDeleted} aggregations, ${result.eventsDeleted} events)`,
  );
  return { ...result, status: 'deleted' };
}

// -------------------------------------------------------------------- worker

export function createDnsSecurityRetentionWorker(): Worker<JobData> {
  return new Worker<JobData>(
    QUEUE_NAME,
    // No context wrapper: every batch and step opens its own.
    async (job: Job<JobData>) => {
      if (job.name === DELETE_JOB_NAME) {
        return runDnsIntegrationDelete(job.data as DnsIntegrationDeleteJobData);
      }
      return runDnsSecurityRetention((job.data ?? {}) as DnsSecurityRetentionJobData);
    },
    { connection: getBullMQConnection(), concurrency: 1 },
  );
}

export async function initializeDnsSecurityRetention(): Promise<void> {
  try {
    retentionWorker = createDnsSecurityRetentionWorker();
    attachWorkerObservability(retentionWorker, 'dnsSecurityRetention');

    retentionWorker.on('error', (error) => {
      console.error(`${LOG_PREFIX} Worker error:`, error);
      captureException(error);
    });
    retentionWorker.on('failed', (job, error) => {
      console.error(`${LOG_PREFIX} Job ${job?.id} (${job?.name}) failed:`, error);
      captureException(error);
    });

    // Daily cron slot from the registry — NOT `every: 24h` (epoch-anchored).
    await getDnsSecurityRetentionQueue().upsertJobScheduler(
      QUEUE_NAME,
      { pattern: jobSchedule('dns-security-retention') },
      {
        name: SWEEP_JOB_NAME,
        data: { defaultRetentionDays: DEFAULT_DNS_SECURITY_RETENTION_DAYS, batchSize: BATCH_SIZE, maxBatches: MAX_BATCHES },
        opts: { removeOnComplete: { count: 5 }, removeOnFail: { count: 10 } },
      },
    );

    console.log(`${LOG_PREFIX} Retention worker initialized`);
  } catch (error) {
    console.error(`${LOG_PREFIX} Failed to initialize:`, error);
    throw error;
  }
}

export async function shutdownDnsSecurityRetention(): Promise<void> {
  if (retentionWorker) {
    await retentionWorker.close();
    retentionWorker = null;
  }
  if (retentionQueue) {
    await retentionQueue.close();
    retentionQueue = null;
  }
}

export const __testOnly = {
  QUEUE_NAME,
  DELETE_JOB_NAME,
  SWEEP_JOB_NAME,
  DEFAULT_DNS_SECURITY_RETENTION_DAYS,
  MAX_RETENTION_DAYS,
  BATCH_SIZE,
  MAX_BATCHES,
};
