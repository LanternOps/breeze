import type { Redis } from 'ioredis';
import { rateLimitIpKey } from './clientIp';

/**
 * Two-tier failed-lookup budget for Quick Support one-time codes.
 *
 * WHY A MISS BUDGET AT ALL (AND WHY NOT PER-PARTNER)
 * --------------------------------------------------
 * A support code is a bearer credential with ~27 bits of entropy (digits 2-9,
 * length 9 => 8^9 ~= 134M codes). Per-IP limits alone do not bound a
 * DISTRIBUTED guesser: N hosts each staying under the 30/min per-IP bucket sum
 * to 30*N guesses/min, which walks the 134M space with ~10 live codes in well
 * under a day once N is large. So a lookup-miss counter is needed to make the
 * guess rate a property of the DEPLOYMENT rather than of the attacker's IP
 * budget.
 *
 * It CANNOT be a per-partner counter: a miss is, by definition, a code that
 * resolved to no live session — there is no partner (or org) to attribute it
 * to, because the lookup that would have found one is exactly the lookup that
 * failed. The only identity a miss carries is the SOURCE it came from, so the
 * budget is keyed on that, with a deployment-wide backstop above it.
 *
 * TIER 1 — PER-SOURCE /64 SUB-BUDGET (the primary control)
 * --------------------------------------------------------
 * Each source network gets its OWN miss allowance, keyed on the same /64 the
 * per-IP rate limiter uses (`rateLimitIpKey`: IPv4 and IPv4-mapped IPv6 pass
 * through unchanged, real IPv6 folds to its /64 — the smallest block an
 * operator will not split across customers). A source that spends its own
 * allowance is 429'd, but that denial is scoped to that /64 alone: it can only
 * ever degrade ITSELF. This is what removes the cross-partner DoS lever — under
 * the old single global counter, ~4 source IPs each staying under their own
 * per-IP limit could exhaust one deployment-wide budget and 429 Quick Support
 * for every partner.
 *
 * At B_src = 30 misses/min per /64, L = 10 live codes and N = 134M, one source
 * on its own faces an expected time-to-hit of N / (L * B_src) minutes =
 * 134,217,728 / (10 * 30) ~= 447,000 min ~= 310 days. A single network is not a
 * threat on its own; it has to recruit many /64s, which is what Tier 2 bounds.
 * B_src is set at (not above) the per-IP rate so the sub-budget can never be the
 * TIGHTER constraint for one legitimate user — a real user is stopped by the
 * per-IP limiter first, if at all.
 *
 * TIER 2 — GLOBAL BACKSTOP (distributed-botnet bound)
 * ---------------------------------------------------
 * A deployment-wide counter still exists, but raised well above the sum a
 * handful of sources can reach, so it only trips under genuinely broad
 * distribution — many distinct /64s each contributing part of their sub-budget.
 * A request is denied when EITHER its /64 sub-budget OR this global backstop is
 * exhausted.
 *
 * At B_global = 500 misses/min the expected time to land on ANY of ~10 live
 * codes is N / (L * B_global) minutes = 134,217,728 / (10 * 500) ~= 26,800 min
 * ~= 447 hours ~= 18.6 days. (For calibration: the earlier corrected figure was
 * ~7.5h at 30,000/min — 134,217,728 / (10 * 30,000) ~= 447 min — and 500/min is
 * 60x slower than that, hence ~447 hours.) Because each /64 is capped at its own
 * 30-miss sub-budget before Tier 1 cuts it off, reaching 500 global misses in a
 * window requires at least ceil(500 / 30) = 17 distinct source networks acting
 * in concert — the backstop is deliberately out of reach of the "few sources"
 * attack Tier 1 already handles, and only fires for a real botnet. A code lives
 * 15 minutes, so even then no individual code is meaningfully at risk; the whole
 * target set is replaced four times an hour.
 *
 * WHY NEITHER TIER BURDENS REAL USERS
 * -----------------------------------
 * Legit misses are near zero by construction: the end user almost never types a
 * code at all (it rides in the download filename), and when a technician reads
 * one over the phone it is a live code typed once — a successful lookup, which
 * spends nothing. A miss means "someone submitted a well-formed code that
 * matches no live session" — typos and stale codes, not the normal path.
 *
 * ONLY WELL-FORMED MISSES COUNT
 * -----------------------------
 * Input that fails the syntax validator never reaches either counter. Such
 * input cannot be a guess against the code space, so counting it would only add
 * noise. This does NOT make the budget un-exhaustible by a hostile caller —
 * well-formed misses are just as cheap to send as garbage — it simply keeps
 * each counter's meaning exact: "guesses against the live-code space".
 *
 * ACCEPTED TRADEOFF ON EXHAUSTION
 * -------------------------------
 * While a /64's sub-budget is exhausted, real end users behind THAT SAME source
 * network get 429s too — but no one else does. All other partners and all other
 * sources stay fully up. The blanket, all-partners degradation only happens if
 * the global backstop trips, which requires a broadly distributed attack; that
 * degradation is accepted (the feature is genuinely under distributed brute
 * force, degrading it is correct, minting codes on the authenticated side is
 * untouched, and every window is rolling so it self-heals within ~60s of the
 * attack stopping). Successful lookups never consume either budget, so a
 * legitimate user holding a real code is unaffected right up until denial.
 */

/** Rolling window, seconds. Matches the per-IP limiter's window. */
export const MISS_BUDGET_WINDOW_SECONDS = 60;

/**
 * Well-formed misses tolerated per SOURCE /64 per rolling window. Set at (not
 * above) the per-IP rate so a single legit user is never stopped by this tier
 * before the per-IP limiter stops them.
 */
export const MISS_BUDGET_PER_SOURCE_PER_WINDOW = 30;

/**
 * Well-formed misses tolerated DEPLOYMENT-WIDE per rolling window — the
 * distributed-botnet backstop. Raised far above the per-source sub-budget so a
 * handful of sources (each capped by Tier 1) cannot reach it; it only trips
 * when many distinct /64s guess in concert.
 */
export const MISS_BUDGET_GLOBAL_PER_WINDOW = 500;

/**
 * Deployment-wide backstop key — shared by check, download and redeem so an
 * attacker cannot buy extra global headroom by spreading across endpoints.
 * Every API instance shares it through Redis, the same store the per-IP limiter
 * uses.
 */
const GLOBAL_MISS_BUDGET_KEY = 'support-code:miss-budget';

/**
 * Per-source sub-budget key prefix. The suffix is `rateLimitIpKey(ip)`, so it
 * folds to the exact same /64 identity the per-IP rate limiter keys on (IPv4
 * and IPv4-mapped IPv6 unchanged — a mapped address must NOT pool the whole
 * IPv4 internet into one bucket — real IPv6 folded to /64).
 */
const SOURCE_MISS_BUDGET_KEY_PREFIX = 'support-code:miss-budget:src:';

function sourceMissBudgetKey(ip: string): string {
  return `${SOURCE_MISS_BUDGET_KEY_PREFIX}${rateLimitIpKey(ip)}`;
}

type SupportCodeMetricsRecorder = {
  onMiss: () => void;
  onGlobalBudgetTrip: () => void;
  onSourceBudgetTrip: () => void;
};

const noopRecorder: SupportCodeMetricsRecorder = {
  onMiss: () => {},
  onGlobalBudgetTrip: () => {},
  onSourceBudgetTrip: () => {},
};
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
    onGlobalBudgetTrip: next?.onGlobalBudgetTrip ?? noopRecorder.onGlobalBudgetTrip,
    onSourceBudgetTrip: next?.onSourceBudgetTrip ?? noopRecorder.onSourceBudgetTrip,
  };
}

// One warn line per GLOBAL-backstop trip, not per request: a distributed brute
// force generates thousands of requests a minute and a per-request log would
// bury the signal in its own noise. Reset when the window drains back under the
// backstop, so a sustained attack re-warns at most once per window. Per-source
// trips are deliberately NOT warned — one log line per attacking /64 would BE
// the log spam — they surface only through the per-source trip metric.
let globalBudgetTripped = false;

export function _resetSupportCodeMissBudgetStateForTests(): void {
  globalBudgetTripped = false;
  metricsRecorder = noopRecorder;
}

/**
 * Is this source, or the deployment as a whole, out of miss budget for the
 * current window? Denies when EITHER tier is exhausted.
 *
 * Read-only: this never consumes budget, so calling it on every request
 * (including the ones that go on to succeed) is free.
 *
 * FAILS OPEN on a Redis outage, deliberately — for BOTH tiers. Every caller
 * runs the per-IP `rateLimiter` first, and that one fails CLOSED on the same
 * outage, so with Redis down these endpoints are already returning 429 to
 * everyone and a second blanket denial here would add nothing but a confusing
 * second cause.
 */
export async function isSupportCodeMissBudgetExhausted(
  redis: Redis | null,
  ip: string,
): Promise<boolean> {
  if (!redis) return false;
  const sourceKey = sourceMissBudgetKey(ip);
  try {
    const windowStart = Date.now() - MISS_BUDGET_WINDOW_SECONDS * 1000;
    const results = await redis
      .multi()
      .zremrangebyscore(sourceKey, '-inf', windowStart)
      .zcard(sourceKey)
      .zremrangebyscore(GLOBAL_MISS_BUDGET_KEY, '-inf', windowStart)
      .zcard(GLOBAL_MISS_BUDGET_KEY)
      .exec();

    const sourceCount = toCount(results?.[1]?.[1]);
    const globalCount = toCount(results?.[3]?.[1]);

    // Re-arm the once-per-window global warn as soon as the backstop drains.
    if (globalCount < MISS_BUDGET_GLOBAL_PER_WINDOW) globalBudgetTripped = false;

    return (
      sourceCount >= MISS_BUDGET_PER_SOURCE_PER_WINDOW
      || globalCount >= MISS_BUDGET_GLOBAL_PER_WINDOW
    );
  } catch (err) {
    console.error('[support-code-budget] Redis error reading miss budget:', err);
    return false;
  }
}

/**
 * Record one well-formed miss (a syntactically valid code that matched no live
 * session) against BOTH the caller's per-source sub-budget and the global
 * backstop.
 *
 * Best-effort: a Redis failure here loses a count rather than failing the
 * request, for the same reason the check above fails open.
 */
export async function recordSupportCodeMiss(redis: Redis | null, ip: string): Promise<void> {
  metricsRecorder.onMiss();
  if (!redis) return;

  const now = Date.now();
  const windowStart = now - MISS_BUDGET_WINDOW_SECONDS * 1000;
  const sourceKey = sourceMissBudgetKey(ip);
  // Unique member per miss — a sorted set scored by timestamp is the same
  // rolling-window shape `services/rate-limit.ts` uses, so the counters age out
  // identically and share Redis eviction behavior. The two keys are distinct,
  // so one member value is safe to reuse across them.
  const member = `${now}-${Math.random().toString(36).slice(2, 10)}`;

  try {
    const results = await redis
      .multi()
      .zremrangebyscore(sourceKey, '-inf', windowStart)
      .zadd(sourceKey, now, member)
      .zcard(sourceKey)
      .expire(sourceKey, MISS_BUDGET_WINDOW_SECONDS)
      .zremrangebyscore(GLOBAL_MISS_BUDGET_KEY, '-inf', windowStart)
      .zadd(GLOBAL_MISS_BUDGET_KEY, now, member)
      .zcard(GLOBAL_MISS_BUDGET_KEY)
      .expire(GLOBAL_MISS_BUDGET_KEY, MISS_BUDGET_WINDOW_SECONDS)
      .exec();

    const sourceCount = toCount(results?.[2]?.[1]);
    const globalCount = toCount(results?.[6]?.[1]);

    // Per-source trip: fire the metric on the crossing miss only (the record
    // that brings this /64 to its limit), so it counts ~once per window per
    // attacking source without an in-memory per-source latch. No warn — that
    // would be one line per attacking /64. A drained-and-refilled window
    // crosses again and re-counts, which is the desired per-window signal.
    if (sourceCount === MISS_BUDGET_PER_SOURCE_PER_WINDOW) {
      metricsRecorder.onSourceBudgetTrip();
    }

    // Global backstop: once-per-window warn + trip metric, latched per process.
    if (globalCount < MISS_BUDGET_GLOBAL_PER_WINDOW) {
      globalBudgetTripped = false;
      return;
    }
    if (globalBudgetTripped) return;

    globalBudgetTripped = true;
    metricsRecorder.onGlobalBudgetTrip();
    console.warn(
      `[support-code-budget] deployment-wide Quick Support miss backstop EXHAUSTED: `
      + `${globalCount} well-formed code lookups missed across all sources in the last `
      + `${MISS_BUDGET_WINDOW_SECONDS}s (backstop ${MISS_BUDGET_GLOBAL_PER_WINDOW}). Reaching this `
      + `requires many distinct source networks guessing in concert — a distributed online attack `
      + `against the one-time code space. /support/check, /support/download and /support/redeem now `
      + `return 429 to ALL callers until the rolling window drains; minting codes is unaffected. `
      + `Further trips are logged at most once per window. (Per-source sub-budget trips, which affect `
      + `only the attacking network, are not logged — see the per-source trip metric.)`,
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
