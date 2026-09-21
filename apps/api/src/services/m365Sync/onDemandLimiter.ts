import { getRedis } from '../redis';

/**
 * One on-demand sync per org per 15 minutes (spec §5.2). A `SET NX EX`
 * reservation rather than a counter: the semantics are "a slot is held", the
 * remaining TTL is exactly the retry hint the client needs, and there is no
 * window-boundary burst where two whole-tenant pulls land back to back.
 *
 * Fails CLOSED, matching readActionBudget.ts: a limit we cannot evaluate must
 * not authorise an unbounded number of whole-tenant Graph pulls. The cost of a
 * false denial is one technician waiting 15 minutes.
 */
export const ON_DEMAND_SYNC_WINDOW_SECONDS = 900;

export type OnDemandSyncSlot =
  | { allowed: true }
  | { allowed: false; retryAfterSeconds: number };

function key(orgId: string): string {
  return `m365-sync-on-demand-${orgId}`;
}

function denied(retryAfterSeconds = ON_DEMAND_SYNC_WINDOW_SECONDS): OnDemandSyncSlot {
  return { allowed: false, retryAfterSeconds };
}

export async function consumeOnDemandSyncSlot(orgId: string): Promise<OnDemandSyncSlot> {
  try {
    const redis = getRedis();
    if (!redis) {
      console.error(`[m365Sync/onDemandLimiter] Redis unavailable, failing closed for org=${orgId}`);
      return denied();
    }
    const reserved = await redis.set(key(orgId), '1', 'EX', ON_DEMAND_SYNC_WINDOW_SECONDS, 'NX');
    if (reserved === 'OK') return { allowed: true };

    // -1 (no expiry) and -2 (key expired between SET and TTL) both mean "we
    // cannot say"; fall back to the full window rather than inventing a
    // shorter hint that would invite an immediate retry.
    const remaining = await redis.ttl(key(orgId));
    return denied(typeof remaining === 'number' && remaining > 0 ? remaining : ON_DEMAND_SYNC_WINDOW_SECONDS);
  } catch (err) {
    console.error(`[m365Sync/onDemandLimiter] Redis error for org=${orgId}, failing closed:`, err);
    return denied();
  }
}

/**
 * Give the slot back when the request it reserved never reached the queue
 * (the claim or enqueue failed), so a transient fault does not lock the org
 * out for 15 minutes on top of the error. Best effort: never throws — the
 * worst case is the original fail-closed wait.
 */
export async function releaseOnDemandSyncSlot(orgId: string): Promise<void> {
  try {
    await getRedis()?.del(key(orgId));
  } catch (err) {
    console.error(`[m365Sync/onDemandLimiter] could not release the slot for org=${orgId}:`, err);
  }
}
