/**
 * Per-session resolution budget for brokered storage sessions
 * (services/backupStorageSessions.ts). Kept free of imports so the session
 * service and its Drizzle store can both use it without an import cycle.
 */

/** Largest resolve batch a helper may send (wire contract, version 1). */
export const STORAGE_SESSION_MAX_BATCH = 100;

/**
 * Resolution budget. Two independent limits, both per session:
 *
 * 1. Rate (token buckets, one for calls and one for resolved objects). Each
 *    bucket holds up to its burst and refills continuously at its rate; a call
 *    that would overdraw either bucket is answered 429 with a Retry-After of
 *    exactly the time until both buckets hold enough again, and consumes
 *    nothing. Sizing:
 *      objects: STORAGE_SESSION_MAX_BATCH per second sustained (6,000/min),
 *               burst of 10 full batches. A sequential restore of small
 *               objects rarely sustains that, and a throttled one only waits
 *               (at most maxBatch / rate = 1 s per full batch) — it never fails.
 *               The helper's look-ahead re-resolution (a full batch of expired
 *               URLs at most once per ~270 s usable URL lifetime) and its stall
 *               restarts (<= 3 per object, each after 2 min without bytes) are
 *               two orders of magnitude below it.
 *      calls:   600/min, burst 600. One call per multipart part (or per
 *               unbatched small file): 10 parts/s is ~50 MiB/s at the 5 MiB
 *               minimum part size and ~640 MiB/s at the 64 MiB part size the
 *               server issues. Storage-session calls are metered apart from the
 *               agent's general request buckets, by a per-session gate at the
 *               same rate plus a per-device ceiling
 *               (services/agentStorageSessionRateLimit.ts), so this bucket and
 *               that gate never disagree about a well-behaved helper.
 *
 * 2. Absolute ceiling for the session's lifetime, sized so that a helper
 *    following the protocol cannot reach it before the deadline ends the
 *    session anyway:
 *      maxResolvedObjects = authorizedKeys * RESOLVES_PER_KEY
 *                         + maxBatch * ceil(lifetimeSeconds / REFRESH_INTERVAL)
 *    - RESOLVES_PER_KEY (8): the first resolution, up to 3 stall restarts and
 *      2 re-resolutions after a storage 403 per download, plus slack.
 *    - the lifetime term: a full batch of look-ahead URLs re-resolved on
 *      expiry at most once per usable URL lifetime (300 s TTL - 30 s margin);
 *      REFRESH_INTERVAL (120 s) allows more than twice that.
 *      maxCalls = maxResolvedObjects + EXTRA_CALLS (calls that resolve nothing).
 *    Spending the ceiling ends the session: the call is answered 410 and the
 *    session is revoked, because waiting can never make it usable again.
 */
export const STORAGE_SESSION_OBJECTS_PER_MINUTE = STORAGE_SESSION_MAX_BATCH * 60;
export const STORAGE_SESSION_OBJECT_BURST = STORAGE_SESSION_MAX_BATCH * 10;
export const STORAGE_SESSION_CALLS_PER_MINUTE = 600;
export const STORAGE_SESSION_CALL_BURST = STORAGE_SESSION_CALLS_PER_MINUTE;
export const STORAGE_SESSION_RESOLVES_PER_KEY = 8;
export const STORAGE_SESSION_REFRESH_INTERVAL_SECONDS = 120;
export const STORAGE_SESSION_EXTRA_CALLS = 200;
/** Absorbs floating-point error in the bucket arithmetic. */
const BUDGET_EPSILON = 1e-6;

export function storageSessionBudgets(
  authorizedKeyCount: number,
  lifetimeSeconds: number,
  maxBatch = STORAGE_SESSION_MAX_BATCH,
): { maxResolvedObjects: number; maxCalls: number } {
  const keys = Math.max(0, Math.floor(authorizedKeyCount));
  const refreshRounds = Math.max(1, Math.ceil(Math.max(0, lifetimeSeconds) / STORAGE_SESSION_REFRESH_INTERVAL_SECONDS));
  const maxResolvedObjects = keys * STORAGE_SESSION_RESOLVES_PER_KEY + maxBatch * refreshRounds;
  return { maxResolvedObjects, maxCalls: maxResolvedObjects + STORAGE_SESSION_EXTRA_CALLS };
}

/** The budget columns of one session, as stored. */
export type StorageSessionBudgetState = {
  callCount: number;
  resolvedObjectCount: number;
  maxCalls: number;
  maxResolvedObjects: number;
  rateCallsAvailable: number;
  rateObjectsAvailable: number;
  rateRefilledAt: Date;
};

export type StorageSessionBudgetDecision =
  | {
    kind: 'granted';
    next: Pick<StorageSessionBudgetState, 'callCount' | 'resolvedObjectCount' | 'rateCallsAvailable' | 'rateObjectsAvailable' | 'rateRefilledAt'>;
  }
  | { kind: 'throttled'; retryAfterSeconds: number }
  | { kind: 'exhausted' };

/**
 * Decide one call against a session's budget (see the sizing notes above).
 * Pure: the store applies `next` atomically with the read it was computed from.
 */
export function evaluateStorageSessionBudget(
  state: StorageSessionBudgetState,
  request: { calls: number; objects: number },
  now: Date,
): StorageSessionBudgetDecision {
  if (
    state.callCount + request.calls > state.maxCalls
    || state.resolvedObjectCount + request.objects > state.maxResolvedObjects
  ) {
    return { kind: 'exhausted' };
  }
  const callRate = STORAGE_SESSION_CALLS_PER_MINUTE / 60;
  const objectRate = STORAGE_SESSION_OBJECTS_PER_MINUTE / 60;
  const elapsed = Math.max(0, (now.getTime() - state.rateRefilledAt.getTime()) / 1000);
  const calls = Math.min(STORAGE_SESSION_CALL_BURST, state.rateCallsAvailable + elapsed * callRate);
  const objects = Math.min(STORAGE_SESSION_OBJECT_BURST, state.rateObjectsAvailable + elapsed * objectRate);
  if (calls + BUDGET_EPSILON >= request.calls && objects + BUDGET_EPSILON >= request.objects) {
    return {
      kind: 'granted',
      next: {
        callCount: state.callCount + request.calls,
        resolvedObjectCount: state.resolvedObjectCount + request.objects,
        rateCallsAvailable: Math.max(0, calls - request.calls),
        rateObjectsAvailable: Math.max(0, objects - request.objects),
        rateRefilledAt: now,
      },
    };
  }
  // A request never exceeds a bucket's burst (at most maxBatch objects and one
  // call), so waiting always suffices.
  const wait = Math.max((request.calls - calls) / callRate, (request.objects - objects) / objectRate, 0);
  return { kind: 'throttled', retryAfterSeconds: Math.max(1, Math.ceil(wait)) };
}
