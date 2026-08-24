/**
 * Daily ECB reference-rate feed for reporting-only FX (multi-currency wave 7,
 * #3779).
 *
 * Fetches the ECB's EUR-based reference rates from Frankfurter for every
 * supported currency and stores them in `exchange_rates`. Those rows are read
 * ONLY by reporting conversions (`convertForReporting`) — FX never enters
 * document math and is never persisted onto a document (spec §8, §2).
 *
 * Scheduling:
 *   - Repeat cron: 17:15 UTC daily. The ECB publishes its daily reference rates
 *     around 16:00 CET, so a UTC-morning run would always store yesterday's
 *     figures. 17:15 UTC also avoids every cron slot already taken in this repo
 *     (02:00 reliability, 03:00 oauthCleanup, 03:30 auditRetention, 03:45
 *     stripeAccountCacheRefresh, 04:15 auditChainVerify, hourly cisJobs).
 *   - A boot one-shot so a fresh install (or one whose feed has been down) has
 *     usable rates immediately rather than up to a day later. `jobId` on both
 *     the repeatable and the one-shot dedupes across replicas; the boot job uses
 *     removeOnComplete/removeOnFail so the next boot can enqueue it again.
 *
 * Invariants this job upholds:
 *   - A pair the provider does not cover stays UNAVAILABLE. We never write a
 *     placeholder, never write 1:1, and never delete a prior row just because
 *     today's response omitted it — the staleness ceiling governs usability.
 *   - Manual (operator) rates are never overwritten: `upsertFeedRates` carries
 *     the `source <> 'manual'` conflict predicate.
 *   - Network I/O happens OUTSIDE any DB context — a pooled connection must
 *     never be held across provider latency (#1105).
 *
 * Env: `EXCHANGE_RATE_SYNC_ENABLED=false` is the air-gapped / self-hosted kill
 * switch (no outbound calls, manual rates only); `FRANKFURTER_BASE_URL` points
 * at an internal mirror. Both are documented in `.env.example` AND mapped into
 * the api service `environment:` block — an unmapped var is inert, which is the
 * whole point of `src/config/envComposeParity.test.ts`.
 */

import { Queue, Worker, UnrecoverableError, type Job } from 'bullmq';
import { CURRENCY_CODES } from '@breeze/shared';
import { captureException, captureMessage } from '../services/sentry';
import { getBullMQConnection } from '../services/redis';
import {
  ECB_REPORTING_BASE_CODE,
  FrankfurterClientError,
  fetchLatestEcbRates,
} from '../services/frankfurterClient';
import { upsertFeedRates } from '../services/exchangeRateService';
import { jobSchedule } from './scheduleRegistry';

const QUEUE_NAME = 'exchange-rate-sync';
const JOB_NAME = 'exchange-rate-sync';
const REPEAT_JOB_ID = 'exchange-rate-sync-daily';
const BOOT_JOB_ID = 'exchange-rate-sync-boot';
const DAILY_CRON = jobSchedule('exchange-rate-sync');

/** Default ON. `EXCHANGE_RATE_SYNC_ENABLED=false` is the air-gapped/self-hosted
 *  switch. Compose maps this as `${EXCHANGE_RATE_SYNC_ENABLED:-}`, so an
 *  operator who never sets it hands us the EMPTY STRING: empty === unset. */
function isSyncEnabled(): boolean {
  const raw = process.env.EXCHANGE_RATE_SYNC_ENABLED;
  if (raw === undefined || raw === '') return true;
  const v = raw.trim().toLowerCase();
  return !(v === '0' || v === 'false' || v === 'no' || v === 'off');
}

export interface ExchangeRateSyncStats {
  requested: number;
  received: number;
  stored: number;
  manualProtected: number;
  unavailable: string[];
  /** Rows the provider returned that failed validation. Reported, never fatal:
   *  one unknown currency or one over-precision rate must not cost every other
   *  currency its update for the day. */
  rejected: number;
}

export async function syncEcbExchangeRates(): Promise<ExchangeRateSyncStats> {
  const quoteCodes = CURRENCY_CODES.filter((c) => c !== ECB_REPORTING_BASE_CODE);
  // Network I/O happens OUTSIDE any DB context (#1105).
  const fetched = await fetchLatestEcbRates(quoteCodes);
  const fetchedAt = new Date();
  const result = await upsertFeedRates(fetched.rates.map((r) => ({ ...r, fetchedAt })));

  if (fetched.unavailableQuoteCodes.length > 0) {
    console.warn(`[ExchangeRateSync] No ECB coverage for: ${fetched.unavailableQuoteCodes.join(', ')}`);
  }

  if (fetched.rejected.length > 0) {
    // Partial-batch degradation: the good rows are already stored above. This
    // is a WARNING with the count and reasons, not a failure — but it must be
    // visible, because a provider that starts emitting rows we cannot read is
    // how a pair goes quietly stale until the 7-day ceiling blanks it.
    const detail = fetched.rejected
      .map((r) => `${r.quoteCode ?? '?'}: ${r.reason}`)
      .join('; ');
    console.warn(`[ExchangeRateSync] Rejected ${fetched.rejected.length} unusable row(s) — ${detail}`);
    captureMessage(
      `[ExchangeRateSync] rejected ${fetched.rejected.length} unusable provider row(s)`,
      {
        eventCode: 'exchange_rate_rows_rejected',
      },
    );
  }

  return {
    requested: fetched.requestedQuoteCodes.length,
    received: fetched.rates.length,
    stored: result.stored,
    manualProtected: result.manualProtected,
    unavailable: fetched.unavailableQuoteCodes,
    rejected: fetched.rejected.length,
  };
}

let syncQueue: Queue | null = null;
let syncWorker: Worker | null = null;

export function getExchangeRateSyncQueue(): Queue {
  if (!syncQueue) {
    syncQueue = new Queue(QUEUE_NAME, { connection: getBullMQConnection() });
  }
  return syncQueue;
}

export function createExchangeRateSyncWorker(): Worker {
  return new Worker(
    QUEUE_NAME,
    async (job: Job) => {
      if (job.name !== JOB_NAME) {
        console.warn(`[ExchangeRateSync] Ignoring unknown job name: ${job.name}`);
        return { skipped: true };
      }
      const startedAt = Date.now();
      try {
        const stats = await syncEcbExchangeRates();
        const durationMs = Date.now() - startedAt;
        console.log(
          `[ExchangeRateSync] ${stats.stored}/${stats.received} rate(s) stored ` +
            `(requested=${stats.requested} manualProtected=${stats.manualProtected} ` +
            `unavailable=${stats.unavailable.length} rejected=${stats.rejected}) in ${durationMs}ms`,
        );
        return { ...stats, durationMs };
      } catch (err) {
        // A transient provider failure (429/5xx/timeout/network) is exactly what
        // BullMQ's retry policy is for — rethrow it unchanged.
        if (err instanceof FrankfurterClientError && err.kind === 'transient') throw err;
        // Everything else is a protocol failure or a misconfiguration (an
        // unparseable FRANKFURTER_BASE_URL, an unsupported currency in the
        // curated list). Retrying the identical request cannot help, and
        // "should not retry" is NOT a property of a plain Error — without
        // UnrecoverableError BullMQ burns all 3 attempts on a doomed request.
        const message = err instanceof Error ? err.message : String(err);
        console.error('[ExchangeRateSync] Permanent failure — not retrying:', err);
        captureException(err);
        throw new UnrecoverableError(`[ExchangeRateSync] permanent failure: ${message}`);
      }
    },
    { connection: getBullMQConnection(), concurrency: 1 },
  );
}

export async function scheduleExchangeRateSync(queue: Queue = getExchangeRateSyncQueue()): Promise<void> {
  // Clear any previously-registered repeatable so a changed cron pattern takes
  // effect on redeploy (BullMQ keys repeatables by the full option set), and so
  // flipping the kill switch off actually stops the daily run.
  const existingJobs = await queue.getRepeatableJobs();
  for (const job of existingJobs) {
    if (job.name === JOB_NAME) {
      await queue.removeRepeatableByKey(job.key);
    }
  }

  if (!isSyncEnabled()) {
    console.log('[ExchangeRateSync] EXCHANGE_RATE_SYNC_ENABLED=false — no outbound rate feed (manual rates only)');
    return;
  }

  await queue.add(
    JOB_NAME,
    {},
    {
      jobId: REPEAT_JOB_ID,
      repeat: { pattern: DAILY_CRON },
      attempts: 3,
      backoff: { type: 'exponential', delay: 60_000 },
      removeOnComplete: { count: 10 },
      removeOnFail: { count: 25 },
    },
  );

  // Run once now: the daily cron alone would leave a fresh install with no
  // rates (and every reporting approximate line suppressed) for up to a day.
  await queue.add(
    JOB_NAME,
    { reason: 'boot' },
    {
      jobId: BOOT_JOB_ID,
      attempts: 3,
      backoff: { type: 'exponential', delay: 60_000 },
      removeOnComplete: true,
      removeOnFail: true,
    },
  );
  console.log(`[ExchangeRateSync] Scheduled daily ECB sync (cron "${DAILY_CRON}") + boot run`);
}

export async function initializeExchangeRateSyncWorker(): Promise<void> {
  try {
    syncWorker = createExchangeRateSyncWorker();

    syncWorker.on('error', (error) => {
      console.error('[ExchangeRateSync] Worker error:', error);
      captureException(error);
    });

    syncWorker.on('failed', (job, error) => {
      console.error(`[ExchangeRateSync] Job ${job?.id} failed:`, error);
      captureException(error);
    });

    await scheduleExchangeRateSync();
    console.log('[ExchangeRateSync] Worker initialized');
  } catch (error) {
    console.error('[ExchangeRateSync] Failed to initialize:', error);
    throw error;
  }
}

export async function shutdownExchangeRateSyncWorker(): Promise<void> {
  if (syncWorker) {
    await syncWorker.close();
    syncWorker = null;
  }
  if (syncQueue) {
    await syncQueue.close();
    syncQueue = null;
  }
}

// Exported for test introspection.
export const __testOnly = {
  QUEUE_NAME,
  JOB_NAME,
  REPEAT_JOB_ID,
  BOOT_JOB_ID,
  DAILY_CRON,
  isSyncEnabled,
};
