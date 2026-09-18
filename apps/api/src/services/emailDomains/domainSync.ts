import type { SendingDomainStatus } from './provider';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** Attempts served at the 2-minute cadence before stepping down (spec §6.2). */
const PENDING_FAST_ATTEMPTS = 5;
/** Attempts served at the 10-minute cadence after that, before going hourly. */
const PENDING_MEDIUM_ATTEMPTS = 6;

/**
 * Row-level poll cadence (spec §6.2). Returned as a DELAY, not an absolute
 * time, so the caller owns `now` and every test can pin it.
 *
 *   pending   2 min x5, then 10 min x6, then hourly until the provider fails it
 *   at_risk   hourly (the provider's own 72 h grace is what ends this state)
 *   verified  every 24 h +/- 10% jitter, PER ROW
 *   failed    hourly, purely so the 72 h `failed_expired` check runs
 *
 * The jitter is the whole reason `verified` is not a daily cron: without it
 * every row verified in the same tick re-checks in the same minute forever,
 * and the fleet re-converges. Same helper shape as
 * `services/m365Sync/cadence.ts`'s `nextSyncAt` — `rng` exists only so a test
 * can pin it.
 */
export function nextCheckDelayMs(
  status: SendingDomainStatus,
  checkAttempts: number,
  rng: () => number = Math.random,
): number {
  switch (status) {
    case 'provisioning':
    case 'removing':
      // Both are "the worker still owes this row an external call". The job's
      // own BullMQ retry is the primary recovery; this is the sweep's backstop.
      return MINUTE_MS;
    case 'pending': {
      const attempts = Math.max(0, Math.trunc(checkAttempts));
      if (attempts < PENDING_FAST_ATTEMPTS) return 2 * MINUTE_MS;
      if (attempts < PENDING_FAST_ATTEMPTS + PENDING_MEDIUM_ATTEMPTS) return 10 * MINUTE_MS;
      return HOUR_MS;
    }
    case 'at_risk':
    case 'failed':
      return HOUR_MS;
    case 'verified': {
      const jitter = 0.9 + rng() * 0.2;
      return Math.round(DAY_MS * jitter);
    }
    case 'suspended':
      // No provider calls at all (spec §6.1); the row is only revisited so an
      // unsuspend that raced the sweep is not stuck behind a stale next_check_at.
      return DAY_MS;
  }
}
