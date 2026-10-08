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
 * the RLS prologue — one `set_config` statement carrying all seven GUCs since
 * #8052 (six statements before). For the openers that check out a pooled
 * connection, the clock starts at ACQUISITION: the first line of the
 * transaction callback, i.e. once the pool has handed over a connection and
 * `BEGIN` has landed. Queueing for a slot is NOT charged against it (#8229) —
 * that wait is bounded separately by the pool-acquire budget below, with its
 * own typed error, because under saturation a long queue means "every
 * connection is busy", not "a connection is wedged". It is DISARMED the instant
 * the prologue completes, before the caller's own `fn` runs — a slow request is
 * not a wedged one, and holding a context open too long is already reported by
 * the separate #1105 tripwire.
 *
 * THE POOL-ACQUIRE BUDGET (#8229). postgres.js has no acquire timeout: a
 * request queued behind a saturated pool waits forever. So moving the prologue
 * clock to acquisition alone would have traded a misleading error for an
 * unbounded queue. The acquire budget runs from call time to acquisition (the
 * pool wait plus `BEGIN` — the callback is the first point the driver lets us
 * observe) and rejects with {@link DbPoolAcquireTimeoutError}. It deliberately
 * requests NO wedged-backend reclaim pass: nothing is wedged, the backends are
 * all busy, and a reclaim scan would find nothing (`scanned=0`) while telling
 * the operator the wrong story. A connection that the pool hands over AFTER the
 * acquire budget expired is refused — the callback throws
 * {@link DbPoolAcquireAbortedError} before issuing anything, which makes the
 * driver roll back and return the connection to the pool instead of running a
 * request nobody is waiting for.
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

/**
 * Shared parsing for the two deadline knobs: default 15s, garbage or negative
 * falls back to the default, 0 is an explicit and honoured "off".
 */
function readDeadlineKnobMs(name: string): number {
  const raw = Number.parseInt(process.env[name] ?? '', 10);
  if (!Number.isFinite(raw) || raw < 0) return 15_000;
  // A sub-second budget would turn ordinary cross-AZ latency into a fault, so
  // anything positive below the floor is treated as a misconfiguration and
  // clamped rather than honoured. 0 remains an explicit, honoured "off".
  if (raw === 0) return 0;
  return Math.max(raw, 1_000);
}

/** Env knob, alongside `DB_POOL_MAX` / `DB_POOL_HEALTH_*`. 0 disables the bound. */
export function getDbAccessContextPrologueTimeoutMs(): number {
  return readDeadlineKnobMs('DB_ACCESS_CONTEXT_PROLOGUE_TIMEOUT_MS');
}

/**
 * #8229 — bound on waiting for a pooled connection (plus `BEGIN`) when a
 * context opener checks one out. Same parsing rules as the prologue knob.
 * 0 disables it and restores postgres.js's unbounded queue.
 */
export function getDbPoolAcquireTimeoutMs(): number {
  return readDeadlineKnobMs('DB_POOL_ACQUIRE_TIMEOUT_MS');
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
 * Thrown by {@link PrologueDeadline.throwIfAborted} at the first check after
 * expiry (before or after the prologue statement).
 *
 * This error never reaches the caller — the race has already settled with the
 * timeout error by the time it is thrown. Its job is to stop the opener from
 * carrying on — issuing the prologue statement, or running the caller's `fn` —
 * on a connection we have given up on: `Promise.race` does not cancel the
 * loser, so without this check a statement that finally resolved late would let
 * the opener proceed onto a connection that is being torn down or has already
 * been recycled to another request.
 */
export class DbAccessContextPrologueAbortedError extends Error {
  constructor(contextLabel: string) {
    super(
      `RLS GUC prologue for ${contextLabel} was aborted after its deadline expired; `
        + 'the opener will not proceed on this connection (#6048).',
    );
    this.name = 'DbAccessContextPrologueAbortedError';
  }
}

/**
 * #8229 — the pool did not hand over a connection within the acquire budget.
 *
 * Deliberately NOT a subclass of {@link DbAccessContextPrologueTimeoutError}:
 * this is pool/CPU saturation, not a wedged connection, and code or alerts that
 * key on the prologue error must not fire for it. No reclamation pass is
 * requested.
 */
export class DbPoolAcquireTimeoutError extends Error {
  readonly elapsedMs: number;
  readonly timeoutMs: number;
  readonly contextLabel: string;

  constructor(input: { contextLabel: string; elapsedMs: number; timeoutMs: number }) {
    super(
      `Timed out waiting for a pooled database connection for ${input.contextLabel} after `
        + `${input.timeoutMs}ms (elapsed ${input.elapsedMs}ms). Every pool slot was busy (or the `
        + 'event loop was starved); this is saturation, not a wedged prologue, so no reclamation '
        + 'was requested. A connection handed over late will be released unused (#8229).',
    );
    this.name = 'DbPoolAcquireTimeoutError';
    this.elapsedMs = input.elapsedMs;
    this.timeoutMs = input.timeoutMs;
    this.contextLabel = input.contextLabel;
  }
}

/**
 * Thrown by {@link PoolAcquisition.acquired} when the pool hands over a
 * connection AFTER the acquire budget expired. Like
 * {@link DbAccessContextPrologueAbortedError}, it never reaches the caller (the
 * race has already settled with {@link DbPoolAcquireTimeoutError}); throwing it
 * from the transaction callback is what makes the driver roll back and return
 * the connection to the pool before anything is issued on it.
 */
export class DbPoolAcquireAbortedError extends Error {
  constructor(contextLabel: string) {
    super(
      `Pooled connection for ${contextLabel} arrived after the acquire budget expired; `
        + 'releasing it unused (#8229).',
    );
    this.name = 'DbPoolAcquireAbortedError';
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
 * Run `work` under a prologue deadline whose clock starts NOW — for a prologue
 * on a connection the caller already holds (`withResolvedDbAccessContext`'s
 * narrowing prologue). Openers that check a connection out of the pool use
 * {@link withAcquireAndPrologueDeadline} instead, so the pool wait is not
 * charged to the prologue (#8229).
 *
 * `work` receives the deadline and MUST call `disarm()` the moment the prologue
 * is done, otherwise the caller's own work is bounded by the prologue budget.
 */
export async function withPrologueDeadline<T>(
  contextLabel: string,
  work: (deadline: PrologueDeadline) => Promise<T>,
  deps: WithPrologueDeadlineDeps = {},
): Promise<T> {
  return withAcquireAndPrologueDeadline(
    contextLabel,
    (acquisition) => work(acquisition.acquired()),
    { ...deps, acquireTimeoutMs: 0 },
  );
}

/**
 * Handed to a pooled-connection opener's `work`. The transaction callback MUST
 * call `acquired()` as its very first statement, before issuing anything.
 */
export interface PoolAcquisition {
  /**
   * Marks the connection as acquired: stops the acquire clock and starts the
   * prologue clock, returning the prologue deadline. Throws
   * {@link DbPoolAcquireAbortedError} if the acquire budget already expired —
   * that throw is what releases a late connection. Idempotent otherwise.
   */
  acquired(): PrologueDeadline;
}

const UNBOUNDED_ACQUISITION: PoolAcquisition = {
  acquired: () => UNBOUNDED_DEADLINE,
};

export interface WithAcquireAndPrologueDeadlineDeps extends WithPrologueDeadlineDeps {
  /** Pool-acquire budget; defaults to {@link getDbPoolAcquireTimeoutMs}. 0 = unbounded. */
  acquireTimeoutMs?: number;
  /**
   * Fired synchronously at ACQUIRE expiry, before the typed error is thrown —
   * observability only (a saturated pool must stay visible even when callers
   * swallow the error). Separate from `onExpired` on purpose: an acquire
   * expiry must never request a reclaim. Must not throw.
   */
  onAcquireExpired?: (expiry: PrologueDeadlineExpiry) => void;
}

/**
 * Run a pooled-connection opener under two consecutive, independent budgets
 * (#8229):
 *
 * 1. ACQUIRE — from now until `work` calls `acquisition.acquired()`. Expiry
 *    calls `onAcquireExpired` (reporting only), then rejects with
 *    {@link DbPoolAcquireTimeoutError}. `onExpired` is NOT called: nothing is
 *    wedged, so no reclamation pass is requested.
 * 2. PROLOGUE — from `acquired()` until the returned deadline is disarmed.
 *    Expiry behaves exactly as it always has (#6048): `onExpired` first, then
 *    {@link DbAccessContextPrologueTimeoutError}, `elapsedMs` measured from
 *    acquisition.
 *
 * Both expiries settle the caller's promise from OUTSIDE the transaction, by
 * racing it — never by throwing inside the callback, whose rollback can queue
 * forever behind a wedged statement (see the module comment).
 */
export async function withAcquireAndPrologueDeadline<T>(
  contextLabel: string,
  work: (acquisition: PoolAcquisition) => Promise<T>,
  deps: WithAcquireAndPrologueDeadlineDeps = {},
): Promise<T> {
  const acquireTimeoutMs = deps.acquireTimeoutMs ?? getDbPoolAcquireTimeoutMs();
  const prologueTimeoutMs = deps.timeoutMs ?? getDbAccessContextPrologueTimeoutMs();
  if (acquireTimeoutMs <= 0 && prologueTimeoutMs <= 0) return work(UNBOUNDED_ACQUISITION);

  const now = deps.now ?? Date.now;
  const calledAt = now();
  let acquireTimer: ReturnType<typeof setTimeout> | undefined;
  let prologueTimer: ReturnType<typeof setTimeout> | undefined;
  let acquireExpired = false;
  let prologueAborted = false;
  let deadline: PrologueDeadline | undefined;

  let fail!: (err: Error) => void;
  const expiry = new Promise<never>((_resolve, reject) => {
    fail = reject;
  });

  const stopAcquireClock = () => {
    if (acquireTimer !== undefined) {
      clearTimeout(acquireTimer);
      acquireTimer = undefined;
    }
  };
  const disarmPrologue = () => {
    if (prologueTimer !== undefined) {
      clearTimeout(prologueTimer);
      prologueTimer = undefined;
    }
  };

  if (acquireTimeoutMs > 0) {
    acquireTimer = setTimeout(() => {
      acquireTimer = undefined;
      acquireExpired = true;
      const elapsedMs = now() - calledAt;
      // Guarded: a reporting fault must not replace the caller's real error.
      try {
        deps.onAcquireExpired?.({ contextLabel, elapsedMs, timeoutMs: acquireTimeoutMs });
      } catch (reportErr) {
        console.warn('[db-pool-acquire] expiry handler failed:', reportErr);
      }
      fail(new DbPoolAcquireTimeoutError({ contextLabel, elapsedMs, timeoutMs: acquireTimeoutMs }));
    }, acquireTimeoutMs);
    // Never the reason the process stays alive.
    acquireTimer.unref?.();
  }

  const acquisition: PoolAcquisition = {
    acquired() {
      // The caller has already been told we gave up. Refuse the connection so
      // the driver rolls back and returns it to the pool.
      if (acquireExpired) throw new DbPoolAcquireAbortedError(contextLabel);
      if (deadline) return deadline;
      stopAcquireClock();
      if (prologueTimeoutMs <= 0) {
        deadline = UNBOUNDED_DEADLINE;
        return deadline;
      }

      const acquiredAt = now();
      deadline = {
        get aborted() {
          return prologueAborted;
        },
        throwIfAborted() {
          if (prologueAborted) throw new DbAccessContextPrologueAbortedError(contextLabel);
        },
        disarm: disarmPrologue,
      };
      prologueTimer = setTimeout(() => {
        prologueTimer = undefined;
        prologueAborted = true;
        const elapsedMs = now() - acquiredAt;
        // Reported BEFORE the throw, and never awaited: recovery is best-effort
        // and single-flight, and making the caller wait for it would hand the
        // deadline's whole purpose back. Guarded because a reporting fault must
        // not replace the caller's real error.
        try {
          deps.onExpired?.({ contextLabel, elapsedMs, timeoutMs: prologueTimeoutMs });
        } catch (reportErr) {
          console.warn('[db-prologue-deadline] expiry handler failed:', reportErr);
        }
        fail(new DbAccessContextPrologueTimeoutError({
          contextLabel,
          elapsedMs,
          timeoutMs: prologueTimeoutMs,
        }));
      }, prologueTimeoutMs);
      prologueTimer.unref?.();
      return deadline;
    },
  };

  try {
    // The race keeps the abandoned `work` promise subscribed, so its eventual
    // rejection (CONNECTION_CLOSED after a reclaim, or DbPoolAcquireAbortedError
    // when a late connection is refused) is handled, not unhandled.
    return await Promise.race([work(acquisition), expiry]);
  } finally {
    stopAcquireClock();
    disarmPrologue();
  }
}
