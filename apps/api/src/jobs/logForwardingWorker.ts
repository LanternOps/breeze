/**
 * Log Forwarding Worker
 *
 * BullMQ worker that forwards device event logs to an external
 * Elasticsearch/OpenSearch-compatible `_bulk` endpoint based on per-org
 * forwarding configuration. Includes backpressure protection to avoid
 * overwhelming the queue.
 */

import { Queue, Worker, Job, UnrecoverableError } from 'bullmq';
import { getBullMQConnection, getRedis } from '../services/redis';
import { createInstrumentedQueue } from '../services/bullmqQueue';
import { withSystemDbAccessContext } from '../db';
import { bulkIndexToEndpoint, clearClientCache, getOrgForwardingConfig } from '../services/logForwarding';
import { attachWorkerObservability } from './workerObservability';
import { envInt } from '../utils/envInt';

interface BulkResult {
  indexed: number;
  errors: number;
}

/**
 * Surface a fully-dropped batch as a failed (but non-retryable) job.
 *
 * Terminal drops (SSRF block, auth/4xx misconfig, all-poison docs) return from
 * bulkIndexEvents rather than throwing, so without this the worker would report
 * the job as completed and the data loss would be invisible on the queue —
 * captureException alone is a no-op when SENTRY_DSN is unset (self-hosted).
 * UnrecoverableError fails the job for dashboard visibility + removeOnFail
 * retention WITHOUT triggering the retry policy (retrying a terminal drop is
 * pointless). Partial success (some docs indexed) is left as a normal return.
 */
export function assertBulkDelivered(result: BulkResult, ctx: { deviceId: string; orgId: string }): void {
  if (result.errors > 0 && result.indexed === 0) {
    throw new UnrecoverableError(
      `[logForwarding] dropped ${result.errors} events (terminal, no retry) device=${ctx.deviceId} org=${ctx.orgId}`,
    );
  }
}

const QUEUE_NAME = 'log-forwarding';
const MAX_LOG_FORWARDING_EVENTS = 500;
const MAX_LOG_FORWARDING_HOSTNAME = 255;
const MAX_LOG_FORWARDING_FIELD = 256;
const MAX_LOG_FORWARDING_MESSAGE = 4096;
const MAX_LOG_FORWARDING_DETAILS_BYTES = 16 * 1024;
/**
 * Ceiling on one job's TOTAL serialized event bytes, on top of the per-field
 * caps above. At 500 events the per-field caps alone still allow ~10MB/job —
 * this is what actually bounds retained-job storage (see removeOnFail below).
 */
const MAX_LOG_FORWARDING_JOB_BYTES = envInt('LOG_FORWARDING_MAX_JOB_BYTES', 1_048_576);

/**
 * Per-org gate (issue: the old gate was a single GLOBAL `waiting > 10000`
 * check — one org with a stuck/slow sink fills the queue and silently skips
 * enqueue for every OTHER org too). This bounds how many of ONE org's forward
 * jobs may be enqueued-but-not-yet-settled at once; other orgs are unaffected
 * by it. The global check below is kept as a last-resort circuit breaker for
 * genuine whole-instance overload (many orgs combined).
 */
const MAX_LOG_FORWARDING_PENDING_PER_ORG = envInt('LOG_FORWARDING_MAX_PENDING_PER_ORG', 2000);
const MAX_LOG_FORWARDING_WAITING_GLOBAL = envInt('LOG_FORWARDING_MAX_WAITING_GLOBAL', 10000);
/** Safety TTL so a counter an API crash left un-decremented self-heals rather than blocking an org forever. */
const ORG_PENDING_COUNTER_TTL_SECONDS = 60 * 60;

function orgPendingKey(orgId: string): string {
  return `log_forwarding:org_pending:${orgId}`;
}

interface LogForwardingJobData {
  orgId: string;
  deviceId: string;
  hostname: string;
  events: Array<{
    category: string;
    level: string;
    source: string;
    message: string;
    timestamp: string;
    details?: unknown;
  }>;
}

let queue: Queue<LogForwardingJobData> | null = null;
let worker: Worker<LogForwardingJobData> | null = null;

function truncateLogString(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max);
}

function sanitizeDetails(value: unknown): unknown {
  if (value === undefined) {
    return undefined;
  }
  try {
    const serialized = JSON.stringify(value);
    if (!serialized || serialized.length <= MAX_LOG_FORWARDING_DETAILS_BYTES) {
      return value;
    }
  } catch (err) {
    console.warn('[LogForwarding] Failed to serialize details payload, dropping field:', err);
    return undefined;
  }
  return undefined;
}

function sanitizeLogForwardingData(data: LogForwardingJobData): LogForwardingJobData {
  const fieldTruncated = data.events.slice(0, MAX_LOG_FORWARDING_EVENTS).map((event) => ({
    category: truncateLogString(event.category, MAX_LOG_FORWARDING_FIELD),
    level: truncateLogString(event.level, MAX_LOG_FORWARDING_FIELD),
    source: truncateLogString(event.source, MAX_LOG_FORWARDING_FIELD),
    message: truncateLogString(event.message, MAX_LOG_FORWARDING_MESSAGE),
    timestamp: event.timestamp,
    details: sanitizeDetails(event.details),
  }));

  // The per-field caps above still allow ~10MB for a full 500-event job —
  // enforce a total-byte ceiling on top, on the retained (post-truncation)
  // shape actually written to the job. Always keeps at least one event so a
  // single oversized event doesn't silently vanish with no data at all.
  const events: typeof fieldTruncated = [];
  let totalBytes = 0;
  for (const event of fieldTruncated) {
    const eventBytes = Buffer.byteLength(JSON.stringify(event), 'utf-8');
    if (events.length > 0 && totalBytes + eventBytes > MAX_LOG_FORWARDING_JOB_BYTES) break;
    events.push(event);
    totalBytes += eventBytes;
  }

  return {
    orgId: data.orgId,
    deviceId: data.deviceId,
    hostname: truncateLogString(data.hostname, MAX_LOG_FORWARDING_HOSTNAME),
    events,
  };
}

export function getLogForwardingQueue(): Queue<LogForwardingJobData> {
  if (!queue) {
    queue = createInstrumentedQueue<LogForwardingJobData>(QUEUE_NAME, {
      defaultJobOptions: {
        // Nothing to inspect for a successful transient forward — don't retain it.
        removeOnComplete: true,
        // Small and byte-capped (MAX_LOG_FORWARDING_JOB_BYTES per job) — kept
        // for operator visibility into failures, not indefinitely.
        removeOnFail: { count: 50 },
        attempts: 5,
        backoff: { type: 'exponential', delay: 1000 },
      },
    });
  }
  return queue;
}

/** Best-effort; a counter miss degrades to "no per-org gate this call", not a hard failure. */
async function incrementOrgPending(orgId: string): Promise<number | null> {
  const redis = getRedis();
  if (!redis) return null;
  try {
    const value = await redis.incr(orgPendingKey(orgId));
    if (value === 1) {
      await redis.expire(orgPendingKey(orgId), ORG_PENDING_COUNTER_TTL_SECONDS);
    }
    return value;
  } catch (err) {
    console.error(`[logForwarding] org-pending counter increment failed for org ${orgId}`, err);
    return null;
  }
}

async function decrementOrgPending(orgId: string): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  try {
    const value = await redis.decr(orgPendingKey(orgId));
    // Defensive floor — a missed increment (e.g. the counter expired mid-flight)
    // must never let the tracked count go negative and inflate future headroom.
    if (value < 0) {
      await redis.set(orgPendingKey(orgId), '0', 'EX', ORG_PENDING_COUNTER_TTL_SECONDS);
    }
  } catch (err) {
    console.error(`[logForwarding] org-pending counter decrement failed for org ${orgId}`, err);
  }
}

export async function enqueueLogForwarding(data: LogForwardingJobData): Promise<void> {
  const q = getLogForwardingQueue();
  const sanitized = sanitizeLogForwardingData(data);
  if (sanitized.events.length === 0) {
    return;
  }

  // Per-org gate FIRST: bounds one org's own pending footprint independent of
  // every other org's queue health.
  const orgPending = await incrementOrgPending(sanitized.orgId);
  if (orgPending !== null && orgPending > MAX_LOG_FORWARDING_PENDING_PER_ORG) {
    await decrementOrgPending(sanitized.orgId); // don't hold a slot for the request we're rejecting
    console.warn(
      `[logForwarding] Org ${sanitized.orgId} has ${orgPending} pending forward job(s), `
      + `exceeding the per-org cap of ${MAX_LOG_FORWARDING_PENDING_PER_ORG} — skipping enqueue for this org only`,
    );
    return;
  }

  // Global circuit breaker, retained as a last resort for genuine
  // whole-instance overload (many orgs combined) — no longer the only gate.
  const waiting = await q.getWaitingCount();
  if (waiting > MAX_LOG_FORWARDING_WAITING_GLOBAL) {
    if (orgPending !== null) await decrementOrgPending(sanitized.orgId);
    console.warn(`[logForwarding] Queue depth ${waiting} exceeds ${MAX_LOG_FORWARDING_WAITING_GLOBAL}, skipping enqueue for org ${sanitized.orgId}`);
    return;
  }

  try {
    await q.add('forward-events', sanitized, {
      jobId: `fwd-${sanitized.deviceId}-${Date.now()}`,
    });
  } catch (err) {
    if (orgPending !== null) await decrementOrgPending(sanitized.orgId);
    throw err;
  }
}

export async function initializeLogForwardingWorker(): Promise<void> {
  worker = new Worker<LogForwardingJobData>(
    QUEUE_NAME,
    async (job: Job<LogForwardingJobData>) => {
      // Re-apply the enqueue-time bounds so a job stored before those bounds
      // existed (or by any other producer) still sends at most
      // MAX_LOG_FORWARDING_EVENTS events / MAX_LOG_FORWARDING_JOB_BYTES.
      const { orgId, deviceId, hostname, events } = sanitizeLogForwardingData(job.data);

      // Short system context for the config read only. It is released before
      // the outbound request so no pooled DB connection or transaction is
      // held across network I/O (the send may take up to its full timeout).
      const config = await withSystemDbAccessContext(() => getOrgForwardingConfig(orgId));
      if (!config) return { indexed: 0, errors: 0 };

      const docs = events.map((e) => ({
        deviceId,
        orgId,
        hostname,
        category: e.category,
        level: e.level,
        source: e.source,
        message: e.message,
        timestamp: e.timestamp,
        details: e.details,
      }));

      const result = await bulkIndexToEndpoint(config, docs, orgId);
      assertBulkDelivered(result, { deviceId, orgId });
      return result;
    },
    {
      connection: getBullMQConnection(),
      concurrency: 5,
      lockDuration: 300_000,
      stalledInterval: 60_000,
      maxStalledCount: 2,
    },
  );
  attachWorkerObservability(worker, 'logForwardingWorker');

  worker.on('error', (error) => {
    console.error('[logForwarding] Worker error:', error);
  });

  worker.on('completed', (job) => {
    if (job?.data?.orgId) void decrementOrgPending(job.data.orgId);
  });

  worker.on('failed', (job, err) => {
    console.error(`[logForwarding] Job ${job?.id} failed:`, err.message);
    // BullMQ emits 'failed' on every failed ATTEMPT, not only the final one —
    // a job still scheduled for retry is still occupying the org's pending
    // budget, so only release the slot once no attempts remain.
    if (job?.data?.orgId && job.attemptsMade >= (job.opts?.attempts ?? 1)) {
      void decrementOrgPending(job.data.orgId);
    }
  });

  console.log('[logForwarding] Worker started');
}

export async function shutdownLogForwardingWorker(): Promise<void> {
  if (worker) {
    await worker.close();
    worker = null;
  }
  if (queue) {
    await queue.close();
    queue = null;
  }
  clearClientCache();
}
