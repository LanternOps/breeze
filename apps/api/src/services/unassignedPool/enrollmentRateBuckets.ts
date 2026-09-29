/**
 * Deploy-key enrollment rate buckets, applied after the deploy key resolves
 * (on top of the per-IP enrollment limit): one bucket per key and one per
 * partner (DEPLOY_KEY_RATE). FAIL CLOSED: if Redis is unavailable or errors,
 * the enrollment is refused — unlike limiters that only protect comfort,
 * these bound how fast a shared key can fill a partner's holding area.
 *
 * Call it OUTSIDE any held DB transaction (it is a Redis round-trip).
 */
import { getRedis } from '../redis';
import { assertOutsideHeldDbContextSafe, rateLimiter, type RateLimitResult } from '../rate-limit';
import { DEPLOY_KEY_RATE } from './limits';

export type DeployKeyRateDecision =
  | { allowed: true }
  | { allowed: false; bucket: 'key' | 'partner' | 'unavailable'; retryAfterSeconds: number };

function retryAfter(result: RateLimitResult): number {
  return Math.max(1, Math.ceil((result.resetAt.getTime() - Date.now()) / 1000));
}

export async function checkDeployKeyRateBuckets(input: {
  deployKeyId: string;
  partnerId: string;
}): Promise<DeployKeyRateDecision> {
  const unavailable: DeployKeyRateDecision = {
    allowed: false,
    bucket: 'unavailable',
    retryAfterSeconds: DEPLOY_KEY_RATE.perKey.windowSeconds,
  };
  // The held-DB-context guard runs OUTSIDE the try below: under
  // DB_CONTEXT_TRIPWIRE_STRICT it throws, and that is a caller bug to surface,
  // never a quiet refusal. (rateLimiter repeats the same check; once this one
  // passed, it passes too.)
  assertOutsideHeldDbContextSafe('checkDeployKeyRateBuckets');
  const redis = getRedis();
  if (!redis) return unavailable;
  try {
    const perKey = await rateLimiter(
      redis,
      `deploy-key-enroll:key:${input.deployKeyId}`,
      DEPLOY_KEY_RATE.perKey.limit,
      DEPLOY_KEY_RATE.perKey.windowSeconds,
    );
    if (!perKey.allowed) return { allowed: false, bucket: 'key', retryAfterSeconds: retryAfter(perKey) };
    const perPartner = await rateLimiter(
      redis,
      `deploy-key-enroll:partner:${input.partnerId}`,
      DEPLOY_KEY_RATE.perPartner.limit,
      DEPLOY_KEY_RATE.perPartner.windowSeconds,
    );
    if (!perPartner.allowed) return { allowed: false, bucket: 'partner', retryAfterSeconds: retryAfter(perPartner) };
    return { allowed: true };
  } catch (err) {
    console.error('[deployKeyRate] rate bucket check failed; refusing:', err);
    return unavailable;
  }
}
