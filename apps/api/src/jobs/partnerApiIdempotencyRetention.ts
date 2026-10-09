/**
 * Partner API idempotency claim retention
 *
 * Reaps `partner_api_idempotency_keys` — the durable claim table behind
 * `X-Idempotency-Key` on the Partner API ticket writes (`POST
 * /partner-api/tickets`, `POST /partner-api/tickets/:id/comments`; migration
 * 2026-12-18-100000, design doc §4.4). A claim only has to outlive the window
 * in which a client may retry, not the ticket or comment it created: rows
 * older than `PARTNER_API_IDEMPOTENCY_RETENTION_DAYS` are hard-deleted. After
 * that, a retry with the old key is a fresh request — the documented contract.
 *
 * Without this sweep the table grows unbounded until org erasure: the FK
 * cascade from `tickets` only clears claims whose ticket was itself deleted.
 *
 * Its own job, not a branch of `enrollmentKeyCleanup`: that job's enable flag
 * governs enrollment-key hygiene and an operator turning it off must not
 * silently stop this retention (and vice versa).
 *
 * Scheduling:
 *   - Repeat cron from `scheduleRegistry` ('partner-api-idempotency-retention').
 *   - `jobId` dedupes the repeatable job across API replicas.
 *
 * Env flags:
 *   - `PARTNER_API_IDEMPOTENCY_RETENTION_ENABLED` defaults to ON; `false` /
 *     `0` skips schedule registration (the worker still initializes so the
 *     queue stays reachable for a manual `add()`).
 *   - `PARTNER_API_IDEMPOTENCY_RETENTION_DAYS` — integer retention window in
 *     days. Default 7. Not a security bound: a shorter window only means a
 *     very late retry creates a second resource rather than replaying.
 *
 * Idempotency: one `DELETE ... WHERE created_at < cutoff`, scanning
 * `partner_api_idempotency_keys_created_at_idx`; running twice in one window
 * finds zero rows the second time. Safe to retry on failure.
 *
 * RLS: background jobs have no request-scoped context, so the delete runs in
 * `withSystemDbAccessContext` — the sweep is system-wide by design.
 */

import { Queue, Worker, Job } from 'bullmq';
import { lt } from 'drizzle-orm';
import * as dbModule from '../db';
import { partnerApiIdempotencyKeys } from '../db/schema';
import { captureException } from '../services/sentry';
import { getBullMQConnection } from '../services/redis';
import { jobSchedule } from './scheduleRegistry';
import { attachWorkerObservability } from './workerObservability';

const QUEUE_NAME = 'partner-api-idempotency-retention';
const JOB_NAME = 'partner-api-idempotency-retention';
const REPEAT_JOB_ID = 'partner-api-idempotency-retention';
const DAILY_CRON = jobSchedule('partner-api-idempotency-retention');
// Far beyond any sane client retry window, and short enough that the claim
// table stays a working set rather than an archive.
const DEFAULT_RETENTION_DAYS = 7;

function isRetentionEnabled(): boolean {
  const raw = process.env.PARTNER_API_IDEMPOTENCY_RETENTION_ENABLED;
  if (raw === undefined || raw === '') return true; // default ON
  const v = raw.trim().toLowerCase();
  return !(v === '0' || v === 'false' || v === 'no' || v === 'off');
}

function getRetentionDays(): number {
  const raw = process.env.PARTNER_API_IDEMPOTENCY_RETENTION_DAYS;
  if (raw === undefined || raw === '') return DEFAULT_RETENTION_DAYS;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_RETENTION_DAYS;
}

const runWithSystemDbAccess = async <T>(fn: () => Promise<T>): Promise<T> => {
  if (typeof dbModule.withSystemDbAccessContext !== 'function') {
    throw new Error(
      '[PartnerApiIdempotencyRetention] withSystemDbAccessContext is not available — DB module may not have loaded correctly',
    );
  }
  return dbModule.withSystemDbAccessContext(fn);
};

let retentionQueue: Queue | null = null;
let retentionWorker: Worker | null = null;

export function getPartnerApiIdempotencyRetentionQueue(): Queue {
  if (!retentionQueue) {
    retentionQueue = new Queue(QUEUE_NAME, {
      connection: getBullMQConnection(),
    });
  }
  return retentionQueue;
}

export function createPartnerApiIdempotencyRetentionWorker(): Worker {
  return new Worker(
    QUEUE_NAME,
    async (job: Job) => {
      if (job.name !== JOB_NAME) {
        console.warn(`[PartnerApiIdempotencyRetention] Ignoring unknown job name: ${job.name}`);
        return { deletedCount: 0, skipped: true };
      }
      return runWithSystemDbAccess(async () => {
        const startedAt = Date.now();
        const retentionDays = getRetentionDays();
        const cutoff = new Date(Date.now() - retentionDays * 86_400_000);

        const deletedRows = await dbModule.db
          .delete(partnerApiIdempotencyKeys)
          .where(lt(partnerApiIdempotencyKeys.createdAt, cutoff))
          .returning({ id: partnerApiIdempotencyKeys.id });
        const deletedCount = deletedRows.length;

        const durationMs = Date.now() - startedAt;
        console.log(
          `[PartnerApiIdempotencyRetention] Deleted ${deletedCount} Partner API idempotency claim(s) `
          + `(retention=${retentionDays}d) in ${durationMs}ms`,
        );
        return { deletedCount, durationMs };
      });
    },
    {
      connection: getBullMQConnection(),
      concurrency: 1,
    },
  );
}

export async function schedulePartnerApiIdempotencyRetention(
  queue: Queue = getPartnerApiIdempotencyRetentionQueue(),
): Promise<void> {
  // Always clear any previously-registered repeatable so a changed cron
  // pattern takes effect on redeploy.
  const existingJobs = await queue.getRepeatableJobs();
  for (const job of existingJobs) {
    if (job.name === JOB_NAME) {
      await queue.removeRepeatableByKey(job.key);
    }
  }

  if (!isRetentionEnabled()) {
    console.log(
      '[PartnerApiIdempotencyRetention] PARTNER_API_IDEMPOTENCY_RETENTION_ENABLED=false — skipping schedule registration',
    );
    return;
  }

  await queue.add(
    JOB_NAME,
    {},
    {
      jobId: REPEAT_JOB_ID,
      repeat: { pattern: DAILY_CRON },
      removeOnComplete: { count: 10 },
      removeOnFail: { count: 25 },
    },
  );
  console.log(
    `[PartnerApiIdempotencyRetention] Scheduled daily retention (cron "${DAILY_CRON}", jobId=${REPEAT_JOB_ID})`,
  );
}

export async function initializePartnerApiIdempotencyRetentionWorker(): Promise<void> {
  try {
    retentionWorker = createPartnerApiIdempotencyRetentionWorker();
    attachWorkerObservability(retentionWorker, 'partnerApiIdempotencyRetention');

    retentionWorker.on('error', (error) => {
      console.error('[PartnerApiIdempotencyRetention] Worker error:', error);
      captureException(error);
    });

    retentionWorker.on('failed', (job, error) => {
      console.error(`[PartnerApiIdempotencyRetention] Job ${job?.id} failed:`, error);
      captureException(error);
    });

    await schedulePartnerApiIdempotencyRetention();
    console.log('[PartnerApiIdempotencyRetention] Worker initialized');
  } catch (error) {
    console.error('[PartnerApiIdempotencyRetention] Failed to initialize:', error);
    throw error;
  }
}

export async function shutdownPartnerApiIdempotencyRetentionWorker(): Promise<void> {
  if (retentionWorker) {
    await retentionWorker.close();
    retentionWorker = null;
  }
  if (retentionQueue) {
    await retentionQueue.close();
    retentionQueue = null;
  }
}

// Exported for test introspection.
export const __testOnly = {
  QUEUE_NAME,
  JOB_NAME,
  REPEAT_JOB_ID,
  DAILY_CRON,
  DEFAULT_RETENTION_DAYS,
  isRetentionEnabled,
  getRetentionDays,
};
