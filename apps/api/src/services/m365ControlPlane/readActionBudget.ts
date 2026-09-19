import { getRedis } from '../redis';

/**
 * Per-connection Redis rate budget for typed Graph read actions (M365
 * control plane). Consumed by readActionService (next task) immediately
 * before issuing a Graph call on behalf of a connection, so a single
 * misbehaving/compromised connection can't hammer a customer tenant's Graph
 * API or blow through Microsoft's own throttling.
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
 * bucket, which keeps the hot path (every Graph read call) cheap.
 *
 * Fails CLOSED: any Redis unavailability or error denies the call. A budget
 * check we can't answer must not silently let an unbounded number of Graph
 * calls through — the safe direction is to deny and let the caller retry.
 */

export const M365_READ_ACTIONS_PER_MINUTE = 30;
export const M365_READ_ACTIONS_PER_DAY = 2_000;

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

export type M365ReadActionBudgetResult =
  | { allowed: true }
  | { allowed: false; retryAfterSeconds: number };

function minuteBudgetKey(connectionId: string, now: number): string {
  const minuteWindow = Math.floor(now / 60_000);
  return `m365-read-budget-min-${connectionId}-${minuteWindow}`;
}

function dayBudgetKey(connectionId: string, now: number): string {
  const utcDay = new Date(now).toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
  return `m365-read-budget-day-${connectionId}-${utcDay}`;
}

function secondsRemainingInMinute(now: number): number {
  return 60 - Math.floor((now % 60_000) / 1_000);
}

function failClosed(retryAfterSeconds = FAIL_CLOSED_RETRY_AFTER_SECONDS): M365ReadActionBudgetResult {
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
export async function consumeM365ReadActionBudget(
  connectionId: string,
): Promise<M365ReadActionBudgetResult> {
  const now = Date.now();
  const minuteKey = minuteBudgetKey(connectionId, now);
  const dayKey = dayBudgetKey(connectionId, now);

  try {
    const redis = getRedis();
    if (!redis) {
      console.error(
        `[readActionBudget] Redis unavailable, failing closed for connection=${connectionId}`,
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
        `[readActionBudget] Redis multi returned null for connection=${connectionId}`,
      );
      return failClosed();
    }

    const minuteCountRaw = results[0]?.[1];
    const minuteCount = typeof minuteCountRaw === 'number' ? minuteCountRaw : Number(minuteCountRaw ?? NaN);
    const dayCountRaw = results[2]?.[1];
    const dayCount = typeof dayCountRaw === 'number' ? dayCountRaw : Number(dayCountRaw ?? NaN);

    if (!Number.isFinite(minuteCount) || !Number.isFinite(dayCount)) {
      console.error(
        `[readActionBudget] Unexpected multi() result shape for connection=${connectionId}:`,
        results,
      );
      return failClosed();
    }

    if (minuteCount > M365_READ_ACTIONS_PER_MINUTE) {
      return failClosed(secondsRemainingInMinute(now));
    }
    if (dayCount > M365_READ_ACTIONS_PER_DAY) {
      return failClosed(DAY_LIMIT_RETRY_AFTER_SECONDS);
    }

    return { allowed: true };
  } catch (err) {
    console.error(
      `[readActionBudget] Redis error for connection=${connectionId}, failing closed:`,
      err,
    );
    return failClosed();
  }
}

/**
 * Whole-domain sync pull budget (spec §5.10). Deliberately its OWN key family:
 * a sync call is one executor round trip that may page 60 times inside the
 * executor, so it is nothing like an interactive read and must not consume, or
 * be consumed by, the 30/min + 2 000/day interactive pools.
 *
 * One fixed hourly window per connection. Continuation calls (sign-in activity,
 * W05) count against the same 12, which is the point: a tenant that needs ten
 * continuation pages must not get ten free Graph budgets.
 *
 * Fails CLOSED for the same reason the interactive budget does — a budget we
 * cannot answer is a denial, and the ticker retries the row next tick.
 */
export const M365_SYNC_ACTIONS_PER_HOUR = 12;

const SYNC_HOUR_KEY_TTL_SECONDS = 60 * 90;
const SYNC_DENY_RETRY_AFTER_SECONDS = 60 * 60;

function syncBudgetKey(connectionId: string, now: number): string {
  const hourWindow = Math.floor(now / 3_600_000);
  return `m365-sync-budget-hour-${connectionId}-${hourWindow}`;
}

function secondsRemainingInHour(now: number): number {
  return 3600 - Math.floor((now % 3_600_000) / 1_000);
}

export async function consumeM365SyncBudget(
  connectionId: string,
): Promise<M365ReadActionBudgetResult> {
  const now = Date.now();
  const key = syncBudgetKey(connectionId, now);

  try {
    const redis = getRedis();
    if (!redis) {
      console.error(
        `[readActionBudget] Redis unavailable, failing closed for sync connection=${connectionId}`,
      );
      return { allowed: false, retryAfterSeconds: SYNC_DENY_RETRY_AFTER_SECONDS };
    }

    const results = await redis.multi().incr(key).expire(key, SYNC_HOUR_KEY_TTL_SECONDS).exec();
    if (!results) {
      console.error(`[readActionBudget] Redis multi returned null for sync connection=${connectionId}`);
      return { allowed: false, retryAfterSeconds: SYNC_DENY_RETRY_AFTER_SECONDS };
    }

    const rawCount = results[0]?.[1];
    const count = typeof rawCount === 'number' ? rawCount : Number(rawCount ?? NaN);
    if (!Number.isFinite(count)) {
      console.error(
        `[readActionBudget] Unexpected sync multi() result shape for connection=${connectionId}:`,
        results,
      );
      return { allowed: false, retryAfterSeconds: SYNC_DENY_RETRY_AFTER_SECONDS };
    }

    if (count > M365_SYNC_ACTIONS_PER_HOUR) {
      return { allowed: false, retryAfterSeconds: secondsRemainingInHour(now) };
    }
    return { allowed: true };
  } catch (err) {
    console.error(
      `[readActionBudget] Redis error for sync connection=${connectionId}, failing closed:`,
      err,
    );
    return { allowed: false, retryAfterSeconds: SYNC_DENY_RETRY_AFTER_SECONDS };
  }
}
