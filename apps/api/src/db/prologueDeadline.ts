/**
 * Client-side deadline on the RLS GUC prologue (issue #6048 ask 1).
 *
 * WHY A CLIENT-SIDE DEADLINE AND NOT `statement_timeout`. In the incident the
 * backend was not executing anything: it had finished `set_config` and was in
 * `ClientRead`, waiting for the next protocol message from US. No server-side
 * timer ends that — the only party that can is the client, on its own clock.
 * See `db/wedgedBackends.ts` for the full failure anatomy.
 *
 * WHAT THIS BOUNDS, AND WHAT IT DELIBERATELY DOES NOT. The deadline covers ONLY
 * the six `set_config` statements. It is armed inside the transaction callback,
 * after the pool has already handed over a connection and `BEGIN` has already
 * landed, so queueing for a slot is not charged against it (that is a different
 * problem with a different fix). It is DISARMED the instant the prologue
 * completes, before the caller's own `fn` runs — a slow request is not a wedged
 * one, and holding a context open too long is already reported by the separate
 * #1105 tripwire.
 *
 * WHAT EXPIRY PROVES, AND WHAT IT DOES NOT. It proves the prologue missed its
 * wall-clock budget, nothing more. This timer is a plain `setTimeout`, so it
 * expires just as readily when the main thread is too busy to run the socket
 * callbacks as when the connection is genuinely wedged — the exact ambiguity
 * `services/postgresConnectTimeout.ts` exists to resolve for `connect_timeout`
 * (#3022). That is why the recovery it triggers does not trust the timer's
 * verdict: `reclaimWedgedBackends` re-derives wedged-ness from
 * `pg_stat_activity` across two snapshots and terminates nothing the database
 * itself does not still show as stuck. Under event-loop starvation the timer
 * fires, the sweep finds nothing, and the only cost is a typed error — not a
 * terminated backend.
 *
 * WHY THE ERROR NEEDS THE RACE. Throwing from inside the transaction callback is
 * NOT enough to free the slot or even to reach the caller: postgres.js's
 * transaction scope handles a thrown error with `await sql\`rollback\``, and on a
 * wedged connection that rollback queues behind the stuck statement and never
 * resolves. So the caller's promise is raced against the deadline directly. That
 * is safe precisely because the prologue failed: `fn` has not run, so abandoning
 * the transaction abandons no caller work. The abandoned promise stays
 * subscribed by the race, so its eventual `CONNECTION_CLOSED` rejection (once
 * the reclaimer terminates the backend) is handled, not unhandled.
 */

/** Env knob, alongside `DB_POOL_MAX` / `DB_POOL_HEALTH_*`. 0 disables the bound. */
export function getDbAccessContextPrologueTimeoutMs(): number {
  const raw = Number.parseInt(process.env.DB_ACCESS_CONTEXT_PROLOGUE_TIMEOUT_MS ?? '', 10);
  if (!Number.isFinite(raw) || raw < 0) return 15_000;
  // A sub-second budget would turn ordinary cross-AZ latency into a fault, so
  // anything positive below the floor is treated as a misconfiguration and
  // clamped rather than honoured. 0 remains an explicit, honoured "off".
  if (raw === 0) return 0;
  return Math.max(raw, 1_000);
}

/**
 * The typed error the caller sees. Distinct from any driver error on purpose:
 * a `CONNECTION_CLOSED` surfaced from the abandoned transaction would tell an
 * operator the database dropped us, when what actually happened is that our own
 * prologue budget expired and we tore the connection down deliberately.
 */
export class DbAccessContextPrologueTimeoutError extends Error {
  readonly elapsedMs: number;
  readonly timeoutMs: number;
  readonly contextLabel: string;

  constructor(input: {
    contextLabel: string;
    elapsedMs: number;
    timeoutMs: number;
    cause?: unknown;
  }) {
    super(
      `RLS GUC prologue for ${input.contextLabel} did not complete within ${input.timeoutMs}ms `
        + `(elapsed ${input.elapsedMs}ms). The pooled connection was abandoned and a reclamation `
        + 'pass was requested; see [db-wedged-backend] logs (#6048).',
      input.cause === undefined ? undefined : { cause: input.cause },
    );
    this.name = 'DbAccessContextPrologueTimeoutError';
    this.elapsedMs = input.elapsedMs;
    this.timeoutMs = input.timeoutMs;
    this.contextLabel = input.contextLabel;
  }
}

/**
 * Thrown by {@link PrologueDeadline.throwIfAborted} at the next statement
 * boundary after expiry.
 *
 * This error never reaches the caller — the race has already settled with the
 * timeout error by the time it is thrown. Its job is to stop the prologue from
 * issuing MORE `set_config` statements on a connection we have given up on:
 * `Promise.race` does not cancel the loser, so without this check a statement
 * that finally resolved late would queue the next five onto a connection that
 * is being torn down or has already been recycled to another request.
 */
export class DbAccessContextPrologueAbortedError extends Error {
  constructor(contextLabel: string) {
    super(
      `RLS GUC prologue for ${contextLabel} was aborted after its deadline expired; `
        + 'no further set_config statements will be issued on this connection (#6048).',
    );
    this.name = 'DbAccessContextPrologueAbortedError';
  }
}

export interface PrologueDeadline {
  /** True once the budget expired. */
  readonly aborted: boolean;
  /** Throws {@link DbAccessContextPrologueAbortedError} once aborted. */
  throwIfAborted(): void;
  /** Stop the clock. Idempotent; called as soon as the prologue completes. */
  disarm(): void;
}

/** A deadline that never fires, for the disabled path. Allocation-free. */
const UNBOUNDED_DEADLINE: PrologueDeadline = {
  aborted: false,
  throwIfAborted() {},
  disarm() {},
};

export interface PrologueDeadlineExpiry {
  contextLabel: string;
  elapsedMs: number;
  timeoutMs: number;
}

export interface WithPrologueDeadlineDeps {
  timeoutMs?: number;
  /**
   * Fired synchronously at expiry, BEFORE the typed error is thrown, so caller
   * latency is bounded by the deadline rather than by recovery. Must not throw.
   */
  onExpired?: (expiry: PrologueDeadlineExpiry) => void;
  now?: () => number;
}

/**
 * Run `work` under a prologue deadline.
 *
 * `work` receives the deadline and MUST call `disarm()` the moment the prologue
 * is done, otherwise the caller's own work is bounded by the prologue budget.
 */
export async function withPrologueDeadline<T>(
  contextLabel: string,
  work: (deadline: PrologueDeadline) => Promise<T>,
  deps: WithPrologueDeadlineDeps = {},
): Promise<T> {
  const timeoutMs = deps.timeoutMs ?? getDbAccessContextPrologueTimeoutMs();
  if (timeoutMs <= 0) return work(UNBOUNDED_DEADLINE);

  const now = deps.now ?? Date.now;
  const startedAt = now();
  let aborted = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const deadline: PrologueDeadline = {
    get aborted() {
      return aborted;
    },
    throwIfAborted() {
      if (aborted) throw new DbAccessContextPrologueAbortedError(contextLabel);
    },
    disarm() {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
    },
  };

  const expiry = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      timer = undefined;
      aborted = true;
      const elapsedMs = now() - startedAt;
      // Reported BEFORE the throw, and never awaited: recovery is best-effort
      // and single-flight, and making the caller wait for it would hand the
      // deadline's whole purpose back. Guarded because a reporting fault must
      // not replace the caller's real error.
      try {
        deps.onExpired?.({ contextLabel, elapsedMs, timeoutMs });
      } catch (reportErr) {
        console.warn('[db-prologue-deadline] expiry handler failed:', reportErr);
      }
      reject(new DbAccessContextPrologueTimeoutError({ contextLabel, elapsedMs, timeoutMs }));
    }, timeoutMs);
    // Never the reason the process stays alive.
    timer.unref?.();
  });

  try {
    return await Promise.race([work(deadline), expiry]);
  } finally {
    deadline.disarm();
  }
}
