// apps/api/src/db/poolAdmission.ts
/**
 * Request-pool admission (#8143), running inside #8229's acquire budget.
 *
 * WHY A GATE IN FRONT OF postgres.js. The driver queues a `begin()` that finds
 * no free connection, and nothing reachable through drizzle can take it back
 * out. #8229 refuses a connection handed over after the acquire budget, but the
 * refused request still spent that connection on BEGIN + ROLLBACK, queued ahead
 * of live work. This gate keeps the queue in OUR hands: when the acquire budget
 * expires, `acquisition.signal` aborts and the waiter leaves here, before the
 * driver ever sees it. The gate owns no timer: the single acquire clock (and
 * knob, DB_POOL_ACQUIRE_TIMEOUT_MS) is #8229's.
 *
 * WHAT A PERMIT IS. One per outermost DB context, DB_POOL_MAX of them. NOT a
 * connection count: bare-pool queries are never reserved (the driver pipelines
 * them) and are not gated. Every series derived from this says "permits".
 *
 * WHEN A PERMIT RETURNS. When the underlying transaction promise settles, never
 * when the caller is answered. An abandoned transaction keeps its permit until
 * it rolls back or its connection is closed by the wedged-backend reclaimer, so
 * the gate never admits more transactions than the driver has connections.
 *
 * NESTED RESERVE. A request that holds a permit and opens a second context
 * (`runOutsideDbContext(() => withSystemDbAccessContext(...))`, the #1105
 * escalation) is NESTED. Top-level acquirers are capped at
 * `permits - nestedReserve`, nested waiters are served first, so a depth-1
 * escalation always finds a permit instead of waiting on its own parent.
 *
 * Leaf module: imports only prologueDeadline.
 */

import { DbAccessContextPrologueAbortedError } from './prologueDeadline';

/** One permit is kept for nested escalations once the pool can spare one. */
export function nestedReserveFor(permits: number): number {
  return permits >= 3 ? 1 : 0;
}

/**
 * A waiter left the queue because its acquire budget expired. Never reaches the
 * caller: #8229's race has already settled with DbPoolAcquireTimeoutError.
 */
export class DbPoolAdmissionCancelledError extends Error {
  constructor(contextLabel: string) {
    super(`${contextLabel} left the pool admission queue: its acquire budget expired (#8143).`);
    this.name = 'DbPoolAdmissionCancelledError';
  }
}

export interface PoolAdmissionSnapshot {
  permits: number;
  nestedReserve: number;
  inUse: number;
  waiting: number;
  /** Permits held by abandoned transactions that have not settled yet. */
  abandoned: number;
  /** permits - abandoned: what the gate can actually hand out. */
  effectivePermits: number;
}

export type AbandonedReturnKind = 'rollback' | 'connection-closed';

export const ABANDONED_RETURN_KINDS: readonly AbandonedReturnKind[] = ['rollback', 'connection-closed'];

export interface PoolAdmissionTotals {
  abandoned: number;
  abandonedReturned: Record<AbandonedReturnKind, number>;
  /** Waiters that left the queue at acquire expiry (requests that never reached the driver). */
  cancelledWaiters: number;
}

export type PoolSlotSettlement = 'resolved' | 'rejected' | 'connection-closed';

/** 57P01 admin_shutdown (pg_terminate_backend), 57P02 crash_shutdown, 57P03 cannot_connect_now. */
const SERVER_TERMINATION_CODES = new Set(['57P01', '57P02', '57P03']);

/**
 * postgres.js connection-loss errors carry `code: 'CONNECTION_*'`
 * (`postgres/src/errors.js` `connection()`); a reclaimed backend may surface the
 * server's FATAL 57P01 first. Anything else is an ordinary rejection after a
 * ROLLBACK.
 */
export function classifyPoolSlotSettlement(err: unknown): PoolSlotSettlement {
  const code = (err as { code?: unknown } | null | undefined)?.code;
  if (typeof code !== 'string') return 'rejected';
  return code.startsWith('CONNECTION_') || SERVER_TERMINATION_CODES.has(code) ? 'connection-closed' : 'rejected';
}

export interface PoolSlot {
  readonly id: number;
  readonly label: string;
  readonly nested: boolean;
  readonly abandoned: boolean;
  readonly released: boolean;
  /**
   * Rejects with the abandon reason the moment the slot is abandoned. Openers
   * race it so ANY prologue on this connection releases the CALLER at once,
   * even when the transaction cannot settle yet. Pre-caught.
   */
  readonly abandonment: Promise<never>;
  /** Idempotent; ignored after release. */
  abandon(reason: Error): void;
  /** Throws DbAccessContextPrologueAbortedError once abandoned. Call before COMMIT. */
  throwIfAbandoned(): void;
  /** Idempotent. Call exactly when the underlying transaction promise settles. */
  release(settlement: PoolSlotSettlement): void;
}

export interface AcquireOptions {
  nested?: boolean;
  /** #8229's `acquisition.signal`: aborting it removes the waiter. */
  signal?: AbortSignal;
}

export interface PoolAdmission {
  acquire(label: string, options?: AcquireOptions): Promise<PoolSlot>;
  snapshot(): PoolAdmissionSnapshot;
  totals(): PoolAdmissionTotals;
}

interface Waiter {
  label: string;
  nested: boolean;
  resolve: (slot: PoolSlot) => void;
  detach: () => void;
}

export function createPoolAdmission(input: { permits: number; nestedReserve?: number }): PoolAdmission {
  const permits = input.permits;
  if (!Number.isInteger(permits) || permits < 1) {
    throw new RangeError(`pool admission permits must be an integer >= 1, got ${permits}`);
  }
  const nestedReserve = input.nestedReserve ?? nestedReserveFor(permits);
  // A reserve equal to the permit count would leave top-level callers nothing.
  if (!Number.isInteger(nestedReserve) || nestedReserve < 0 || nestedReserve >= permits) {
    throw new RangeError(
      `pool admission nestedReserve must be an integer in [0, ${permits - 1}], got ${nestedReserve}`,
    );
  }
  const topWaiters: Waiter[] = [];
  const nestedWaiters: Waiter[] = [];
  let inUse = 0;
  let abandonedCount = 0;
  let nextId = 1;
  const totals: PoolAdmissionTotals = {
    abandoned: 0,
    abandonedReturned: { rollback: 0, 'connection-closed': 0 },
    cancelledWaiters: 0,
  };

  const canGrant = (nested: boolean): boolean =>
    nested ? inUse < permits : inUse < permits - nestedReserve;

  const snapshot = (): PoolAdmissionSnapshot => ({
    permits,
    nestedReserve,
    inUse,
    waiting: topWaiters.length + nestedWaiters.length,
    abandoned: abandonedCount,
    effectivePermits: permits - abandonedCount,
  });

  function makeSlot(label: string, nested: boolean): PoolSlot {
    inUse += 1;
    let isAbandoned = false;
    let isReleased = false;
    let rejectAbandonment!: (reason: Error) => void;
    const abandonment = new Promise<never>((_resolve, reject) => {
      rejectAbandonment = reject;
    });
    abandonment.catch(() => {});

    return {
      id: nextId++,
      label,
      nested,
      get abandoned() {
        return isAbandoned;
      },
      get released() {
        return isReleased;
      },
      abandonment,
      abandon(reason: Error) {
        if (isAbandoned || isReleased) return;
        isAbandoned = true;
        abandonedCount += 1;
        totals.abandoned += 1;
        rejectAbandonment(reason);
      },
      throwIfAbandoned() {
        if (isAbandoned) throw new DbAccessContextPrologueAbortedError(label);
      },
      release(settlement: PoolSlotSettlement) {
        if (isReleased) return;
        isReleased = true;
        inUse -= 1;
        if (isAbandoned) {
          abandonedCount -= 1;
          totals.abandonedReturned[settlement === 'connection-closed' ? 'connection-closed' : 'rollback'] += 1;
        }
        drain();
      },
    };
  }

  function drain(): void {
    for (;;) {
      let waiter: Waiter | undefined;
      if (nestedWaiters.length > 0 && canGrant(true)) waiter = nestedWaiters.shift();
      else if (topWaiters.length > 0 && canGrant(false)) waiter = topWaiters.shift();
      if (!waiter) return;
      // Detach BEFORE resolving: a granted waiter can never also be cancelled.
      waiter.detach();
      waiter.resolve(makeSlot(waiter.label, waiter.nested));
    }
  }

  function acquire(label: string, options: AcquireOptions = {}): Promise<PoolSlot> {
    const nested = options.nested === true;
    const signal = options.signal;
    if (signal?.aborted) {
      totals.cancelledWaiters += 1;
      return Promise.reject(new DbPoolAdmissionCancelledError(label));
    }
    const queue = nested ? nestedWaiters : topWaiters;
    // Fast path only when nobody that should go first is already waiting.
    const nobodyAhead = nested
      ? nestedWaiters.length === 0
      : nestedWaiters.length === 0 && topWaiters.length === 0;
    if (nobodyAhead && canGrant(nested)) return Promise.resolve(makeSlot(label, nested));

    return new Promise<PoolSlot>((resolve, reject) => {
      const onAbort = (): void => {
        const index = queue.indexOf(waiter);
        if (index === -1) return;
        queue.splice(index, 1);
        totals.cancelledWaiters += 1;
        reject(new DbPoolAdmissionCancelledError(label));
      };
      const waiter: Waiter = {
        label,
        nested,
        resolve,
        detach: () => signal?.removeEventListener('abort', onAbort),
      };
      queue.push(waiter);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  return {
    acquire,
    snapshot,
    totals: () => ({
      abandoned: totals.abandoned,
      abandonedReturned: { ...totals.abandonedReturned },
      cancelledWaiters: totals.cancelledWaiters,
    }),
  };
}

// --- process registry -------------------------------------------------------
// `db/index.ts` registers the request pool's gate at module load. Read it from
// here (not through db/index) so metricsRuntime stays a leaf importer.

let requestPoolAdmission: PoolAdmission | null = null;

export function registerRequestPoolAdmission(admission: PoolAdmission): void {
  requestPoolAdmission = admission;
}

export function getRequestPoolAdmission(): PoolAdmission | null {
  return requestPoolAdmission;
}

export function __resetRequestPoolAdmissionForTests(): void {
  requestPoolAdmission = null;
}
