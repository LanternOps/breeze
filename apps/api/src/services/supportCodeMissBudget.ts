import type { Redis } from 'ioredis';

/**
 * Deployment-wide failed-lookup budget for Quick Support one-time codes.
 *
 * WHY A GLOBAL BUDGET AND NOT JUST PER-IP LIMITS
 * ----------------------------------------------
 * A support code is a bearer credential with ~27 bits of entropy (digits 2-9,
 * length 9 => 8^9 ~= 134M codes). Per-IP limits alone do not bound a
 * DISTRIBUTED guesser: 1,000 hosts each staying under the 30/min per-IP bucket
 * is 30,000 guesses/min deployment-wide, which walks a 134M space with ~10 live
 * codes (~13.4M expected guesses to a hit) in well under a day (≈7-8 hours).
 * This counter is the control that makes the guess rate a property of the
 * DEPLOYMENT rather than of the attacker's IP budget.
 *
 * THE MATH
 * --------
 * With B = 100 misses/min allowed deployment-wide, L live codes and N = 134M
 * possible codes, the expected time to land on any live code is
 *   N / (L * B) minutes = 134,217,728 / (10 * 100) / 60 / 24 ~= 93 days.
 * A code lives 15 minutes, so no individual code is ever meaningfully at risk;
 * the attacker is racing a target set that is fully replaced every quarter hour.
 *
 * WHY 100/min IS NOT A BURDEN ON REAL USERS
 * -----------------------------------------
 * Legit misses are close to zero by construction: the end user almost never
 * types a code at all (it rides in the download filename), and when a
 * technician does read one over the phone it is a live code being typed once.
 * A miss means "someone submitted a well-formed code that matches no live
 * session" — typos and stale codes, not the normal path. 100/min across an
 * entire deployment is orders of magnitude above the organic rate.
 *
 * ONLY WELL-FORMED MISSES COUNT
 * -----------------------------
 * Input that fails the syntax validator never reaches this counter. Such input
 * cannot be a guess against the code space, so counting it would only add
 * noise. This does NOT make the budget un-exhaustible by a hostile caller —
 * well-formed misses are just as cheap to send as garbage — it simply keeps the
 * counter's meaning exact: "guesses against the live-code space".
 *
 * ACCEPTED TRADEOFF ON EXHAUSTION
 * -------------------------------
 * While the budget is exhausted, real end users hitting check/download/redeem
 * get 429s too. That is accepted: an exhausted budget means the feature is
 * actively under brute force, degrading it is the correct response, a
 * technician can still mint and read out codes (the authenticated side is
 * untouched), and the window is rolling so it self-heals within ~60s of the
 * attack stopping. Successful lookups never consume budget, so a legitimate
 * user who holds a real code is unaffected right up until the budget trips.
 */

/** Rolling window, seconds. Matches the per-IP limiter's window. */
export const MISS_BUDGET_WINDOW_SECONDS = 60;

/** Well-formed misses tolerated deployment-wide per rolling window. */
export const MISS_BUDGET_PER_WINDOW = 100;

/**
 * Single global key — deliberately NOT keyed by IP, tenant or endpoint. The
 * whole point is that check, download and redeem share one deployment-wide
 * counter, so an attacker cannot buy extra guesses by spreading across
 * endpoints or hosts. Every API instance shares it through Redis, the same
 * store the per-IP limiter uses.
 */
const MISS_BUDGET_KEY = 'support-code:miss-budget';

type SupportCodeMetricsRecorder = {
  onMiss: () => void;
  onBudgetTrip: () => void;
};

const noopRecorder: SupportCodeMetricsRecorder = { onMiss: () => {}, onBudgetTrip: () => {} };
let metricsRecorder: SupportCodeMetricsRecorder = noopRecorder;

/**
 * `routes/metrics.ts` registers the real Prometheus recorder at startup (same
 * thin-indirection pattern as `clientIp.ts` / `abuseMetrics.ts` — services must
 * not import routes). Until then this is a no-op.
 */
export function setSupportCodeMetricsRecorder(
  next: Partial<SupportCodeMetricsRecorder> | null | undefined,
): void {
  metricsRecorder = {
    onMiss: next?.onMiss ?? noopRecorder.onMiss,
    onBudgetTrip: next?.onBudgetTrip ?? noopRecorder.onBudgetTrip,
  };
}

// One warn line per trip, not per request: a brute force generates thousands of
// requests a minute and a per-request log would bury the signal in its own
// noise (and cost more than the attack). Reset when the window drains back
// under budget, so a sustained attack re-warns at most once per window.
let budgetTripped = false;

export function _resetSupportCodeMissBudgetStateForTests(): void {
  budgetTripped = false;
  metricsRecorder = noopRecorder;
}

/**
 * Has the deployment-wide budget been spent for the current window?
 *
 * Read-only: this never consumes budget, so calling it on every request (including
 * the ones that go on to succeed) is free.
 *
 * FAILS OPEN on a Redis outage, deliberately. Every caller runs the per-IP
 * `rateLimiter` first, and that one fails CLOSED on the same outage — so with
 * Redis down these endpoints are already returning 429 to everyone and a second
 * blanket denial here would add nothing but a confusing second cause.
 */
export async function isSupportCodeMissBudgetExhausted(redis: Redis | null): Promise<boolean> {
  if (!redis) return false;
  try {
    const windowStart = Date.now() - MISS_BUDGET_WINDOW_SECONDS * 1000;
    const results = await redis
      .multi()
      .zremrangebyscore(MISS_BUDGET_KEY, '-inf', windowStart)
      .zcard(MISS_BUDGET_KEY)
      .exec();
    const count = toCount(results?.[1]?.[1]);
    if (count < MISS_BUDGET_PER_WINDOW) budgetTripped = false;
    return count >= MISS_BUDGET_PER_WINDOW;
  } catch (err) {
    console.error('[support-code-budget] Redis error reading miss budget:', err);
    return false;
  }
}

/**
 * Record one well-formed miss (a syntactically valid code that matched no live
 * session) against the deployment-wide budget.
 *
 * Best-effort: a Redis failure here loses a count rather than failing the
 * request, for the same reason the check above fails open.
 */
export async function recordSupportCodeMiss(redis: Redis | null): Promise<void> {
  metricsRecorder.onMiss();
  if (!redis) return;

  const now = Date.now();
  const windowStart = now - MISS_BUDGET_WINDOW_SECONDS * 1000;
  // Unique member per miss — a sorted set scored by timestamp is the same
  // rolling-window shape `services/rate-limit.ts` uses, so the two counters
  // age out identically and share Redis eviction behavior.
  const member = `${now}-${Math.random().toString(36).slice(2, 10)}`;

  try {
    const results = await redis
      .multi()
      .zremrangebyscore(MISS_BUDGET_KEY, '-inf', windowStart)
      .zadd(MISS_BUDGET_KEY, now, member)
      .zcard(MISS_BUDGET_KEY)
      .expire(MISS_BUDGET_KEY, MISS_BUDGET_WINDOW_SECONDS)
      .exec();

    const count = toCount(results?.[2]?.[1]);
    if (count < MISS_BUDGET_PER_WINDOW) {
      budgetTripped = false;
      return;
    }
    if (budgetTripped) return;

    budgetTripped = true;
    metricsRecorder.onBudgetTrip();
    console.warn(
      `[support-code-budget] deployment-wide Quick Support miss budget EXHAUSTED: `
      + `${count} well-formed code lookups missed in the last ${MISS_BUDGET_WINDOW_SECONDS}s `
      + `(budget ${MISS_BUDGET_PER_WINDOW}). This is what an online guessing attack against the `
      + `one-time code space looks like. /support/check, /support/download and /support/redeem now `
      + `return 429 to ALL callers until the rolling window drains; minting codes is unaffected. `
      + `Further trips are logged at most once per window.`,
    );
  } catch (err) {
    console.error('[support-code-budget] Redis error recording miss:', err);
  }
}

function toCount(raw: unknown): number {
  if (typeof raw === 'number') return raw;
  const n = Number(raw ?? 0);
  return Number.isFinite(n) ? n : 0;
}
