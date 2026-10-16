// apps/api/src/db/lagTolerantTimeout.ts
/**
 * A one-shot timeout that knows when it fired late (#8143).
 *
 * WHY. Every DB budget in `db/` (pool acquire, RLS prologue) is a plain
 * `setTimeout`. When the main thread stalls for longer than the budget, the
 * timer fires on the first loop iteration after the stall, and libuv (>= 1.45,
 * Node 20+) runs due timers BEFORE it next polls for I/O. A database reply that
 * arrived DURING the stall is therefore still unread in the socket when the
 * timer fails the request. `lagTolerantTimeout.test.ts` pins this ordering on
 * the running Node with a characterization test, because it is the whole
 * justification for the grace below.
 *
 * WHAT IT DOES. If the timer callback runs at least `lateThresholdMs` after its
 * due time, it is re-armed ONCE for `graceMs`, which gives the reply one I/O
 * poll and one round trip to land. A timer that fires on time is never
 * extended. Either way the fire reports `late`, which callers publish as the
 * `timer` metric label. `late` proves the event loop was stalled at the
 * deadline. It does NOT prove the stall was the only cause.
 *
 * Leaf module: no imports, so the db graph and metricsRuntime can both use it.
 */

export type TimerLateness = 'late' | 'on-time';

export const TIMER_LATENESS_VALUES: readonly TimerLateness[] = ['late', 'on-time'];

/** A timer this late was held up by the event loop, not by the work it guards. */
export const DB_TIMER_LATE_THRESHOLD_MS = 1_000;

const MAX_GRACE_MS = 10_000;

/** Env knob, alongside `DB_POOL_ACQUIRE_TIMEOUT_MS`. 0 disables the grace. */
export function getDbTimerLagGraceMs(): number {
  const raw = Number.parseInt(process.env.DB_TIMER_LAG_GRACE_MS ?? '', 10);
  if (!Number.isFinite(raw) || raw < 0) return 2_000;
  return Math.min(raw, MAX_GRACE_MS);
}

export interface LagTolerantTimeoutFire {
  /** Wall time from arming to the (final) fire. */
  elapsedMs: number;
  /** True when the first fire ran at least the late threshold after its due time. */
  late: boolean;
}

export interface LagTolerantTimeoutHandle {
  /** Idempotent. After cancel(), onFire never runs. */
  cancel(): void;
  readonly fired: boolean;
}

export interface ArmLagTolerantTimeoutInput {
  timeoutMs: number;
  /** Runs at most once. Callers must not throw from it. */
  onFire: (fire: LagTolerantTimeoutFire) => void;
  graceMs?: number;
  lateThresholdMs?: number;
  now?: () => number;
}

export function armLagTolerantTimeout(input: ArmLagTolerantTimeoutInput): LagTolerantTimeoutHandle {
  const now = input.now ?? Date.now;
  const graceMs = input.graceMs ?? getDbTimerLagGraceMs();
  const lateThresholdMs = input.lateThresholdMs ?? DB_TIMER_LATE_THRESHOLD_MS;
  const startedAt = now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancelled = false;
  let fired = false;
  let late = false;

  const arm = (ms: number, next: () => void): void => {
    timer = setTimeout(next, ms);
    // Never the reason the process stays alive.
    timer.unref?.();
  };

  const fire = (): void => {
    timer = undefined;
    if (cancelled) return;
    fired = true;
    input.onFire({ elapsedMs: now() - startedAt, late });
  };

  arm(input.timeoutMs, () => {
    timer = undefined;
    if (cancelled) return;
    late = now() - startedAt - input.timeoutMs >= lateThresholdMs;
    if (late && graceMs > 0) {
      arm(graceMs, fire);
      return;
    }
    fire();
  });

  return {
    cancel() {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    },
    get fired() {
      return fired;
    },
  };
}
