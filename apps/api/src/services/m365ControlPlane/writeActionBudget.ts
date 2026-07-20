import { getRedis } from '../redis';

/**
 * Per-connection Redis rate budget for typed Graph write actions (M365
 * control plane). Consumed by writeActionService immediately before issuing
 * a Graph mutation on behalf of a connection, so a single misbehaving/
 * compromised connection can't hammer a customer tenant's Graph API or blow
 * through Microsoft's own throttling. Tighter than the read budget
 * (`readActionBudget.ts`) since writes carry higher blast radius per call.
 *
 * Two fixed windows, both enforced atomically in one `multi()` round-trip:
 *   - a per-minute window keyed to the current minute bucket
 *     (`Math.floor(now / 60_000)`)
 *   - a per-UTC-day window keyed to the current UTC calendar date
 *
 * Fixed windows (not sliding) are intentional here: this is a coarse
 * "don't hammer the tenant" budget, not a precise abuse-prevention limiter
 * (see rate-limit.ts / notificationThrottle.ts for sliding-window sorted-set
 * limiters used for those cases). A fixed window is a single INCR+EXPIRE per
 * bucket, which keeps the hot path (every Graph write call) cheap.
 *
 * Fails CLOSED: any Redis unavailability or error denies the call. A budget
 * check we can't answer must not silently let an unbounded number of Graph
 * calls through — the safe direction is to deny and let the caller retry.
 */

export const M365_WRITE_ACTIONS_PER_MINUTE = 10;
export const M365_WRITE_ACTIONS_PER_DAY = 100;

// Comfortably above the window each key bounds, so a key never expires
// mid-window (which would silently reset a connection's count to zero) while
// still not leaking keys forever after the window closes.
const MINUTE_KEY_TTL_SECONDS = 120;
const DAY_KEY_TTL_SECONDS = 60 * 60 * 26;

// Fail-closed denial when we have no budget signal at all (Redis down/error)
// or when the per-minute window is exceeded — the window itself is at most
// 60s, so 60s is always a safe upper bound on when it's worth retrying.
const FAIL_CLOSED_RETRY_AFTER_SECONDS = 60;
// Flat retry hint for a day-budget denial. Not computed to the exact UTC
// day rollover — a day-limit hit means the connection needs operator
// attention (raise the budget / investigate the calling pattern), not a
// tight client retry loop, so a coarse hint is sufficient.
const DAY_LIMIT_RETRY_AFTER_SECONDS = 60 * 60;

export type M365WriteActionBudgetResult =
  | { allowed: true }
  | { allowed: false; retryAfterSeconds: number };

function minuteBudgetKey(connectionId: string, now: number): string {
  const minuteWindow = Math.floor(now / 60_000);
  return `m365-write-budget-min-${connectionId}-${minuteWindow}`;
}

function dayBudgetKey(connectionId: string, now: number): string {
  const utcDay = new Date(now).toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
  return `m365-write-budget-day-${connectionId}-${utcDay}`;
}

function secondsRemainingInMinute(now: number): number {
  return 60 - Math.floor((now % 60_000) / 1_000);
}

function failClosed(retryAfterSeconds = FAIL_CLOSED_RETRY_AFTER_SECONDS): M365WriteActionBudgetResult {
  return { allowed: false, retryAfterSeconds };
}

/**
 * Atomically increment (and check) both the per-minute and per-day budget
 * counters for a connection. Returns `{ allowed: true }` if this call is
 * within both budgets, otherwise `{ allowed: false, retryAfterSeconds }`.
 *
 * Note: the increment happens even on the call that trips a limit (i.e. the
 * counter isn't rolled back on denial) — this matches the fixed-window
 * counter pattern and is intentional: a denied call still "cost" a slot,
 * which makes the budget slightly more conservative under bursts, the safe
 * direction for a fail-closed budget.
 */
export async function consumeM365WriteActionBudget(
  connectionId: string,
): Promise<M365WriteActionBudgetResult> {
  const now = Date.now();
  const minuteKey = minuteBudgetKey(connectionId, now);
  const dayKey = dayBudgetKey(connectionId, now);

  try {
    const redis = getRedis();
    if (!redis) {
      console.error(
        `[writeActionBudget] Redis unavailable, failing closed for connection=${connectionId}`,
      );
      return failClosed();
    }

    const results = await redis
      .multi()
      .incr(minuteKey)
      .expire(minuteKey, MINUTE_KEY_TTL_SECONDS)
      .incr(dayKey)
      .expire(dayKey, DAY_KEY_TTL_SECONDS)
      .exec();

    if (!results) {
      console.error(
        `[writeActionBudget] Redis multi returned null for connection=${connectionId}`,
      );
      return failClosed();
    }

    const minuteCountRaw = results[0]?.[1];
    const minuteCount = typeof minuteCountRaw === 'number' ? minuteCountRaw : Number(minuteCountRaw ?? NaN);
    const dayCountRaw = results[2]?.[1];
    const dayCount = typeof dayCountRaw === 'number' ? dayCountRaw : Number(dayCountRaw ?? NaN);

    if (!Number.isFinite(minuteCount) || !Number.isFinite(dayCount)) {
      console.error(
        `[writeActionBudget] Unexpected multi() result shape for connection=${connectionId}:`,
        results,
      );
      return failClosed();
    }

    if (minuteCount > M365_WRITE_ACTIONS_PER_MINUTE) {
      return failClosed(secondsRemainingInMinute(now));
    }
    if (dayCount > M365_WRITE_ACTIONS_PER_DAY) {
      return failClosed(DAY_LIMIT_RETRY_AFTER_SECONDS);
    }

    return { allowed: true };
  } catch (err) {
    console.error(
      `[writeActionBudget] Redis error for connection=${connectionId}, failing closed:`,
      err,
    );
    return failClosed();
  }
}
