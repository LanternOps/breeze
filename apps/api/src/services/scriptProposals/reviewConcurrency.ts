// apps/api/src/services/scriptProposals/reviewConcurrency.ts
//
// Per-org concurrency cap for the script-review worker (W02, #5612, spec
// §4.4: "per-org concurrency 3"). Open-source BullMQ has no per-tenant-group
// concurrency, so this is enforced with a small Redis counter acquired at the
// top of the job processor (jobs/scriptReviewWorker.ts) and released in a
// `finally` — NOT with a Postgres advisory lock, which would hold a pooled
// connection for the lifetime of the (up to 60 s) Anthropic call, the
// "hang at concurrency ≥ pool size" anti-pattern CLAUDE.md calls out.
import { getRedis } from '../redis';
import { captureException } from '../sentry';

export const SCRIPT_REVIEW_ORG_CONCURRENCY = 3;

// Safety TTL on the counter key, well above SCRIPT_REVIEW_TIMEOUT_MS (60 s):
// if a worker process crashes between acquire and the `finally` release, the
// key self-heals instead of permanently wedging the org at its cap.
const CONCURRENCY_KEY_TTL_SECONDS = 90;

function concurrencyKey(orgId: string): string {
  return `script-review:concurrency:${orgId}`;
}

// Atomic check-and-increment: refuses (returns 0) at or above the cap,
// otherwise increments and refreshes the safety TTL.
const ACQUIRE_SCRIPT = `
local current = tonumber(redis.call('GET', KEYS[1]) or '0')
if current >= tonumber(ARGV[1]) then
  return 0
end
redis.call('INCR', KEYS[1])
redis.call('EXPIRE', KEYS[1], ARGV[2])
return 1
`;

// Never decrements below zero — a release without a matching prior acquire
// (should not happen, but a crash-recovery retry could double-release) must
// not push the counter negative and manufacture extra capacity.
const RELEASE_SCRIPT = `
local current = tonumber(redis.call('GET', KEYS[1]) or '0')
if current > 0 then
  redis.call('DECR', KEYS[1])
end
return 1
`;

/**
 * Attempts to claim one of `cap` concurrent review slots for `orgId`.
 * Fails OPEN (returns true, no cap enforced) when the general Redis client
 * is unavailable — this is a cost/fairness control, not a security boundary.
 * That branch IS reachable: `getRedis()` and BullMQ's own connection are two
 * ioredis instances with independent availability flags (services/redis.ts),
 * so BullMQ can be delivering jobs while the general client is down. It is
 * therefore captured to Sentry (rate-limited by Sentry itself), not just
 * logged, so a silently-disabled cap is visible.
 */
export async function tryAcquireOrgReviewSlot(
  orgId: string,
  cap: number = SCRIPT_REVIEW_ORG_CONCURRENCY,
): Promise<boolean> {
  const redis = getRedis();
  if (!redis) {
    console.warn('[scriptReviewConcurrency] Redis unavailable — failing open (no per-org cap enforced)', { orgId });
    captureException(new Error('script-review per-org concurrency cap disabled: general Redis client unavailable'), undefined, {
      service: 'scriptReviewConcurrency', orgId,
    });
    return true;
  }
  const result = await redis.eval(
    ACQUIRE_SCRIPT, 1, concurrencyKey(orgId), String(cap), String(CONCURRENCY_KEY_TTL_SECONDS),
  );
  return result === 1;
}

/** Releases a previously-acquired slot. No-op if Redis is unavailable. */
export async function releaseOrgReviewSlot(orgId: string): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  await redis.eval(RELEASE_SCRIPT, 1, concurrencyKey(orgId));
}
