import {
  M365_SYNC_DOMAIN_DEFAULT_INTERVAL_SECONDS,
  M365_SYNC_DOMAIN_INTERVAL_BOUNDS,
  type M365SyncDomain,
} from '@breeze/shared/m365';
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

/** Executor latency above this is evidence the tenant is large (spec §5.7). */
const SLOW_EXECUTOR_MS = 60_000;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * Spec §5.7, in order of signal strength rather than the spec table's order: a
 * truncated or slow run is evidence about the tenant's SIZE and must not be
 * softened by the success decay that would otherwise apply to the same run (a
 * truncated run is `partial`, but a slow run can be `success`). Every result is
 * clamped to the domain's bounds, so sign-in activity can never be pulled below
 * its 24 h floor.
 */
export function nextInterval(
  domain: M365SyncDomain,
  current: number,
  outcome: M365SyncOutcome,
  signals: CadenceSignals,
): number {
  const { min, max } = M365_SYNC_DOMAIN_INTERVAL_BOUNDS[domain];
  const target = M365_SYNC_DOMAIN_DEFAULT_INTERVAL_SECONDS[domain];

  // A tenant that cannot use the feature at all (no Entra ID P1) should not be
  // polled at the default cadence forever — straight to the domain ceiling.
  if (signals.unlicensed) return max;

  let next = current;
  if (signals.truncated || signals.latencyMs > SLOW_EXECUTOR_MS) {
    next = current * 2;
  } else if (outcome === 'throttled' || signals.capacity) {
    next = current * 1.5;
  } else if (outcome === 'success') {
    next = current + (target - current) * 0.25;
  }
  return clamp(Math.round(next), min, max);
}

/**
 * The seam W04's completion writer calls. Returns the PAIR the state row
 * carries — `next_sync_at` and `interval_seconds` are written in one statement
 * and decided together here, never in run.ts. `nextSyncAt: null` takes the row
 * out of the ticker's due set until an (upgrade-)consent or retest re-seeds it
 * (spec §5.7, §5.8): that is what `needs_consent` and a dead credential get. A
 * non-auth terminal error still schedules, otherwise one bad run would silently
 * retire a domain. `rng` is optional purely so a test can pin the jitter.
 */
export function applyCadence(
  domain: M365SyncDomain,
  state: { intervalSeconds: number },
  outcome: M365SyncOutcome,
  signals: CadenceSignals,
  rng?: () => number,
): { intervalSeconds: number; nextSyncAt: Date | null } {
  const intervalSeconds = nextInterval(domain, state.intervalSeconds, outcome, signals);
  if (outcome === 'needs_consent' || signals.authFailure) {
    return { intervalSeconds, nextSyncAt: null };
  }
  // The NEW interval is what gets scheduled, through the one shared jitter
  // helper above.
  return { intervalSeconds, nextSyncAt: nextSyncAt(signals.now, intervalSeconds, rng) };
}
