// apps/api/src/db/abandonedSlotReclaim.ts
/**
 * Deferred wedged-backend reclaim for abandoned pool permits (#8143).
 *
 * WHY DEFERRED. Before #8143 a reclaim pass was requested the instant a
 * prologue deadline expired, with `minAgeMs = timeoutMs`. The backend that
 * triggered it started its transaction AFTER the timer was armed, so it was
 * always younger than `minAgeMs` and that pass could never match it (216
 * passes, all `scanned=0`, on 2026-10-08). Most abandoned transactions need no
 * reclaim at all: the late statement completes, the opener's abort check
 * throws, postgres.js rolls back, and the permit returns on its own.
 *
 * WHAT THIS DOES. One scheduler watches every abandoned permit. A permit still
 * held `prologueTimeoutMs + ABANDONED_SLOT_RECLAIM_MARGIN_MS` after it was
 * abandoned is a wedge candidate: by then any `set_config` it sent is at least
 * `prologueTimeoutMs` old, so the existing reclaimer predicate can match it.
 * Requests are paced at the reclaim floor. Safety (two snapshots, cap of 4 per
 * pass, same-role only) stays entirely in `wedgedBackends.ts`.
 *
 * BOUND (conditional, stated honestly). First eligible pass at abandonment +
 * prologue budget + 1 s; then one pass per DB_WEDGED_BACKEND_RECLAIM_MIN_INTERVAL_MS,
 * each terminating at most DB_WEDGED_BACKEND_RECLAIM_MAX_PER_PASS backends;
 * the 5-minute scanner in dbPoolHealthMonitor stays as the backstop. With
 * reclaim disabled, the permit stays held and is reported, never re-admitted.
 */

import { captureMessage } from '../services/sentry';
import { claimDbPoolHealthCaptureSlot, getDbPoolHealthCaptureThrottleMs } from './dbPoolHealthMonitor';
import type { PoolSlot } from './poolAdmission';
import {
  getWedgedBackendReclaimMinIntervalMs,
  requestWedgedBackendReclaim,
  type WedgedBackendReclaimOutcome,
} from './wedgedBackends';

export const ABANDONED_SLOT_RECLAIM_MARGIN_MS = 1_000;

const TICK_MS = 1_000;

/**
 * Logs a pass outcome; a failed pass also goes to Sentry, throttled on its own
 * key. Moved unchanged in behaviour from db/index.ts (#6048). Never throws.
 */
export function reportReclaimOutcome(pass: Promise<WedgedBackendReclaimOutcome>): void {
  void pass
    .then((outcome) => {
      if (outcome.error) {
        console.warn('[db-wedged-backend] reclamation pass failed:', outcome.error);
        // Sentry too, not console only: a repair path broken for days while the
        // pool bleeds permits is the same invisible failure #6048 was filed for.
        // Throttled (this repo has twice blacked out Sentry with an unthrottled
        // recurring warning) and wrapped, because the reporter may be failing.
        if (
          claimDbPoolHealthCaptureSlot(
            'wedged-backend-reclaim-failed',
            Date.now(),
            getDbPoolHealthCaptureThrottleMs(),
          )
        ) {
          try {
            // Stable headline: Sentry groups by message.
            captureMessage('[db-wedged-backend] reclamation pass failed (#6048)', {
              eventCode: 'db_wedged_backend_reclaim_failed',
              tags: { db_pool_health_verdict: 'wedged-backend-reclaim-failed' },
            });
          } catch (captureErr) {
            console.error('[db-wedged-backend] failed to report reclaim failure to Sentry:', captureErr);
          }
        }
        return;
      }
      console.warn(
        `[db-wedged-backend] reclamation pass: scanned=${outcome.scanned} `
          + `confirmed=${outcome.confirmed} terminated=[${outcome.terminated.join(',')}] `
          + `cappedAt=${outcome.cappedAt ?? 'none'} in ${outcome.elapsedMs}ms.`,
      );
    })
    .catch((err: unknown) => {
      console.warn('[db-wedged-backend] reclamation pass threw unexpectedly:', err);
    });
}

export interface AbandonedSlotReclaimSchedulerDeps {
  requestReclaim?: (deps: { minAgeMs: number }) => Promise<WedgedBackendReclaimOutcome> | null;
  report?: (pass: Promise<WedgedBackendReclaimOutcome>) => void;
  retryIntervalMs?: () => number;
  now?: () => number;
  warn?: (line: string) => void;
}

export interface AbandonedSlotReclaimScheduler {
  /** Idempotent per slot; ignored once the slot is released. */
  track(slot: PoolSlot, prologueTimeoutMs: number): void;
  trackedCount(): number;
  stop(): void;
}

interface TrackedSlot {
  abandonedAt: number;
  eligibleAt: number;
  minAgeMs: number;
}

export function createAbandonedSlotReclaimScheduler(
  deps: AbandonedSlotReclaimSchedulerDeps = {},
): AbandonedSlotReclaimScheduler {
  const requestReclaim = deps.requestReclaim ?? ((reclaimDeps) => requestWedgedBackendReclaim(reclaimDeps));
  const report = deps.report ?? reportReclaimOutcome;
  const retryIntervalMs = deps.retryIntervalMs ?? getWedgedBackendReclaimMinIntervalMs;
  const now = deps.now ?? Date.now;
  const warn = deps.warn ?? ((line: string) => console.warn(line));
  const tracked = new Map<PoolSlot, TrackedSlot>();
  let nextRequestAt = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  function schedule(): void {
    if (timer !== undefined || tracked.size === 0) return;
    timer = setTimeout(tick, TICK_MS);
    timer.unref?.();
  }

  function tick(): void {
    timer = undefined;
    const t = now();
    let due = 0;
    let minAgeMs = Number.POSITIVE_INFINITY;
    let oldestAbandonedAt = t;
    for (const [slot, entry] of tracked) {
      if (slot.released) {
        tracked.delete(slot);
        continue;
      }
      if (t >= entry.eligibleAt) {
        due += 1;
        minAgeMs = Math.min(minAgeMs, entry.minAgeMs);
        oldestAbandonedAt = Math.min(oldestAbandonedAt, entry.abandonedAt);
      }
    }
    if (due > 0 && t >= nextRequestAt) {
      const retryMs = retryIntervalMs();
      nextRequestAt = t + retryMs;
      try {
        const pass = requestReclaim({ minAgeMs });
        if (pass === null) {
          warn(
            `[db-pool-admission] ${due} abandoned transaction permit(s) still held (oldest abandoned `
              + `${Math.round((t - oldestAbandonedAt) / 1000)}s ago) and the wedged-backend reclaim was declined `
              + '(DB_WEDGED_BACKEND_RECLAIM_DISABLED, or inside its retry floor). The effective pool stays '
              + `reduced until they settle; retrying in ${Math.round(retryMs / 1000)}s (#8143).`,
          );
        } else {
          report(pass);
        }
      } catch (err) {
        warn(`[db-pool-admission] reclaim request threw: ${err instanceof Error ? err.message : String(err)} (#8143)`);
      }
    }
    schedule();
  }

  return {
    track(slot: PoolSlot, prologueTimeoutMs: number) {
      if (slot.released || tracked.has(slot)) return;
      const t = now();
      tracked.set(slot, {
        abandonedAt: t,
        eligibleAt: t + prologueTimeoutMs + ABANDONED_SLOT_RECLAIM_MARGIN_MS,
        minAgeMs: prologueTimeoutMs,
      });
      schedule();
    },
    trackedCount() {
      return tracked.size;
    },
    stop() {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      tracked.clear();
    },
  };
}
