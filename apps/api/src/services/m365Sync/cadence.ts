import type { M365SyncDomain } from '@breeze/shared/m365';
import type { CadenceSignals, M365SyncOutcome } from './types';

export type { CadenceSignals };

/**
 * next run = now + interval, jittered +/-10%. Without the jitter every org
 * seeded in the same tick would stay in lockstep forever and the fleet would
 * re-converge into the same minute every six hours.
 *
 * Lives HERE rather than in run.ts because it is the second half of the cadence
 * decision: W05 needs to change the interval and the due time together, and a
 * jitter helper on the other side of that seam would be edited from two places.
 */
export function nextSyncAt(now: Date, intervalSeconds: number, rng: () => number = Math.random): Date {
  const jitter = 0.9 + rng() * 0.2;
  return new Date(now.getTime() + Math.round(intervalSeconds * 1000 * jitter));
}

/**
 * SEAM — the BODY is owned by W05 (spec §5.7 adaptive cadence).
 *
 * W04 returns the stored interval unchanged, so a run's cadence is exactly what
 * `m365_sync_state.interval_seconds` says, plus the jittered due time. W05
 * replaces the interval computation with the clamped ladder from
 * `M365_SYNC_DOMAIN_INTERVAL_BOUNDS` (x2 on truncated or >60 s latency, x1.5 on
 * throttled/capacity, 25 % decay toward the default on success) and may return
 * `nextSyncAt: null` to unschedule.
 *
 * It returns the PAIR, not just a number: `next_sync_at` and `interval_seconds`
 * are written in the same statement and must be decided together, and run.ts
 * having its own due-time helper is exactly how the two drift apart. `rng` is
 * an optional fifth argument purely so a test can pin the jitter; the
 * four-argument contract call still type-checks.
 */
export function applyCadence(
  _domain: M365SyncDomain,
  state: { intervalSeconds: number },
  _outcome: M365SyncOutcome,
  signals: CadenceSignals,
  rng?: () => number,
): { intervalSeconds: number; nextSyncAt: Date | null } {
  return {
    intervalSeconds: state.intervalSeconds,
    nextSyncAt: nextSyncAt(signals.now, state.intervalSeconds, rng),
  };
}
