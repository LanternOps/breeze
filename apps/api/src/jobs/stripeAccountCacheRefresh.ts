/**
 * Stripe account-cache bootstrap / refresh worker (#3777 review F6).
 *
 * Wave 5 added `default_currency` / `account_country` / `account_refreshed_at`
 * to `stripe_connect_accounts`, populated when a key is saved or the settings
 * page triggers a TTL refresh. Every connection that predates the cache
 * migrated with those columns NULL, and nothing guaranteed they would ever be
 * filled — a partner who never revisits the settings page could mint
 * mismatched checkout sessions with no warning. This worker closes that gap:
 *
 *   - run ONCE at boot (one-shot job, stable id → multi-replica dedup), and
 *   - daily thereafter (repeatable cron),
 *
 * refreshing every connected account that was never cached, plus accounts
 * where Stripe reported no default currency once the TTL has elapsed (see
 * listPartnersNeedingStripeAccountBootstrap). The detail/checkout surfaces
 * independently treat an unknown cache as an explicit warning, so this job is
 * the convergence path, not the only safety net.
 *
 * Scheduling:
 *   - Repeat cron: 03:45 UTC daily — off-peak, offset from oauthCleanup
 *     (03:00), auditRetention (03:30) and auditChainVerify (04:15).
 *   - `jobId` on both the repeatable and the boot one-shot dedupes across
 *     replicas; the boot job uses removeOnComplete/removeOnFail so the next
 *     boot can enqueue it again.
 *
 * Env flag: `STRIPE_ACCOUNT_CACHE_REFRESH_ENABLED` defaults ON; `false`/`0`
 * disables scheduling without a deploy (the worker still initializes).
 *
 * DB context: the candidate list is read under a system context (cross-partner
 * sweep). Each refresh then runs with NO ambient context —
 * refreshPartnerStripeAccount scopes its own short reads/writes and performs
 * the Stripe round-trip outside any transaction, exactly as the HTTP path does.
 * One dead key (INVALID_STRIPE_KEY) or decrypt fault never aborts the sweep;
 * failures are counted per class and logged.
 */

import { Queue, Worker, Job } from 'bullmq';
import { withSystemDbAccessContext } from '../db';
import { captureException } from '../services/sentry';
import { getBullMQConnection } from '../services/redis';
import {
  listPartnersNeedingStripeAccountBootstrap,
  refreshPartnerStripeAccount,
  PartnerStripeError,
} from '../services/partnerStripe';
import { jobSchedule } from './scheduleRegistry';
import { attachWorkerObservability } from './workerObservability';

const QUEUE_NAME = 'stripe-account-cache-refresh';
const JOB_NAME = 'stripe-account-cache-refresh';
const REPEAT_JOB_ID = 'stripe-account-cache-refresh-daily';
const BOOT_JOB_ID = 'stripe-account-cache-refresh-boot';
const DAILY_CRON = jobSchedule('stripe-account-cache-refresh');

function isRefreshEnabled(): boolean {
  const raw = process.env.STRIPE_ACCOUNT_CACHE_REFRESH_ENABLED;
  if (raw === undefined || raw === '') return true; // default ON
  const v = raw.trim().toLowerCase();
  return !(v === '0' || v === 'false' || v === 'no' || v === 'off');
}

export interface StripeAccountCacheRefreshStats {
  candidates: number;
  refreshed: number;
  /** Stripe unreachable / 5xx / rate-limited — retried on the next sweep. */
  transientFailures: number;
  /** Revoked or unreadable key — the partner must reconnect; retried daily only to notice when they do. */
  permanentFailures: number;
  /** The account facts could not be read, for a reason that is NOT a dead key and NOT a
   *  Stripe outage: a restricted key / unknown error (review F2), or a local key-replacement
   *  race (STRIPE_CONNECTION_CHANGED, review F4). Next sweep picks the row up again. */
  unknownFailures: number;
  unexpectedFailures: number;
}

export async function refreshUncachedStripeAccounts(): Promise<StripeAccountCacheRefreshStats> {
  const candidates = await withSystemDbAccessContext(() => listPartnersNeedingStripeAccountBootstrap());
  const stats: StripeAccountCacheRefreshStats = {
    candidates: candidates.length,
    refreshed: 0,
    transientFailures: 0,
    permanentFailures: 0,
    unknownFailures: 0,
    unexpectedFailures: 0,
  };

  for (const { partnerId } of candidates) {
    try {
      const res = await refreshPartnerStripeAccount(partnerId);
      stats.refreshed += 1;
      if (!res.defaultCurrency) {
        console.warn('[StripeAccountCacheRefresh] Stripe reports no default currency for account — mismatch check stays unavailable', { partnerId, stripeAccountId: res.stripeAccountId });
      }
    } catch (err) {
      if (err instanceof PartnerStripeError) {
        if (err.code === 'STRIPE_UNAVAILABLE') {
          stats.transientFailures += 1;
        } else if (err.code === 'STRIPE_ACCOUNT_UNKNOWN' || err.code === 'STRIPE_CONNECTION_CHANGED') {
          // Restricted key / unknown error (F2) or a local key-replacement race
          // (F4): neither is a transient STRIPE failure and neither means the
          // partner must reconnect.
          stats.unknownFailures += 1;
        } else {
          // INVALID_STRIPE_KEY / STRIPE_KEY_UNREADABLE / NO_STRIPE_KEY (raced a
          // disconnect). Already logged at error level by the service.
          stats.permanentFailures += 1;
        }
        continue;
      }
      stats.unexpectedFailures += 1;
      console.error('[StripeAccountCacheRefresh] unexpected failure refreshing partner account', { partnerId, err });
      captureException(err);
    }
  }

  return stats;
}

let refreshQueue: Queue | null = null;
let refreshWorker: Worker | null = null;

export function getStripeAccountCacheRefreshQueue(): Queue {
  if (!refreshQueue) {
    refreshQueue = new Queue(QUEUE_NAME, { connection: getBullMQConnection() });
  }
  return refreshQueue;
}

export function createStripeAccountCacheRefreshWorker(): Worker {
  return new Worker(
    QUEUE_NAME,
    async (job: Job) => {
      if (job.name !== JOB_NAME) {
        console.warn(`[StripeAccountCacheRefresh] Ignoring unknown job name: ${job.name}`);
        return { skipped: true };
      }
      const startedAt = Date.now();
      const stats = await refreshUncachedStripeAccounts();
      const durationMs = Date.now() - startedAt;
      console.log(
        `[StripeAccountCacheRefresh] ${stats.refreshed}/${stats.candidates} account(s) refreshed ` +
          `(transient=${stats.transientFailures} permanent=${stats.permanentFailures} unknown=${stats.unknownFailures} unexpected=${stats.unexpectedFailures}) in ${durationMs}ms`,
      );
      return { ...stats, durationMs };
    },
    { connection: getBullMQConnection(), concurrency: 1 },
  );
}

export async function scheduleStripeAccountCacheRefresh(queue: Queue = getStripeAccountCacheRefreshQueue()): Promise<void> {
  // Clear any previously-registered repeatable so a changed cron pattern takes
  // effect on redeploy (BullMQ keys repeatables by the full option set).
  const existingJobs = await queue.getRepeatableJobs();
  for (const job of existingJobs) {
    if (job.name === JOB_NAME) {
      await queue.removeRepeatableByKey(job.key);
    }
  }

  if (!isRefreshEnabled()) {
    console.log('[StripeAccountCacheRefresh] STRIPE_ACCOUNT_CACHE_REFRESH_ENABLED=false — skipping schedule registration');
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

  // Run once now: the daily cron alone would leave pre-cache connections
  // unwarned for up to a day after every deploy that introduces (or
  // re-introduces) the cache. removeOnComplete/removeOnFail free the stable id
  // so the next boot can enqueue it again; concurrent replicas dedupe on it.
  await queue.add(
    JOB_NAME,
    { reason: 'boot' },
    {
      jobId: BOOT_JOB_ID,
      removeOnComplete: true,
      removeOnFail: true,
    },
  );
  console.log(`[StripeAccountCacheRefresh] Scheduled daily refresh (cron "${DAILY_CRON}") + boot sweep`);
}

export async function initializeStripeAccountCacheRefreshWorker(): Promise<void> {
  try {
    refreshWorker = createStripeAccountCacheRefreshWorker();
  attachWorkerObservability(refreshWorker, 'stripeAccountCacheRefresh');

    refreshWorker.on('error', (error) => {
      console.error('[StripeAccountCacheRefresh] Worker error:', error);
      captureException(error);
    });

    refreshWorker.on('failed', (job, error) => {
      console.error(`[StripeAccountCacheRefresh] Job ${job?.id} failed:`, error);
      captureException(error);
    });

    await scheduleStripeAccountCacheRefresh();
    console.log('[StripeAccountCacheRefresh] Worker initialized');
  } catch (error) {
    console.error('[StripeAccountCacheRefresh] Failed to initialize:', error);
    throw error;
  }
}

export async function shutdownStripeAccountCacheRefreshWorker(): Promise<void> {
  if (refreshWorker) {
    await refreshWorker.close();
    refreshWorker = null;
  }
  if (refreshQueue) {
    await refreshQueue.close();
    refreshQueue = null;
  }
}

// Exported for test introspection.
export const __testOnly = {
  QUEUE_NAME,
  JOB_NAME,
  REPEAT_JOB_ID,
  BOOT_JOB_ID,
  DAILY_CRON,
  isRefreshEnabled,
};
