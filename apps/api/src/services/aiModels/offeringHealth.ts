/**
 * AI model registry W09 (#7607): per-offering cooldown after a provider
 * failure (D9). resolveModel PREFERS a healthy fallback over a cooling
 * primary, and still uses the primary when nothing else is eligible: a
 * cooldown never turns into an outage. Redis absent, failing or slow → no
 * cooldown (fail open to normal resolution). Keys are per offering id, which
 * is partner-owned, so one partner's failures never steer another's routing.
 */
import { getRedis } from '../redis';
import { COOLDOWN_TTL_MS, type ProviderFailureCause } from './failover';
import { listOfferings } from './offerings';
import type { ResolvedModel } from './resolveModel';
import type { TurnBinding } from './turnBinding';

const REDIS_TIMEOUT_MS = 250;
const key = (offeringId: string) => `ai-model:cooldown:${offeringId}`;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** ioredis queues commands while disconnected; never let that stall a dispatch. */
async function bounded<T>(work: Promise<T>, fallback: T): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<T>((resolve) => { timer = setTimeout(() => resolve(fallback), REDIS_TIMEOUT_MS); });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function markOfferingCooldown(offeringId: string, cause: ProviderFailureCause): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  try {
    await bounded(redis.set(key(offeringId), cause, 'PX', COOLDOWN_TTL_MS[cause]).then(() => undefined), undefined);
  } catch (error) {
    console.warn('[offeringHealth] cooldown write failed', { offeringId, cause, error: errorMessage(error) });
  }
}

export async function coolingOfferings(ids: readonly string[]): Promise<Set<string>> {
  const unique = [...new Set(ids.filter((id) => typeof id === 'string' && id.length > 0))];
  const redis = getRedis();
  if (!redis || unique.length === 0) return new Set();
  try {
    const values = await bounded(redis.mget(...unique.map(key)), unique.map(() => null as string | null));
    return new Set(unique.filter((_, i) => values[i] !== null && values[i] !== undefined));
  } catch (error) {
    console.warn('[offeringHealth] cooldown read failed; treating nothing as cooling', { error: errorMessage(error) });
    return new Set();
  }
}

export async function clearOfferingCooldowns(ids: readonly string[]): Promise<void> {
  const redis = getRedis();
  if (!redis || ids.length === 0) return;
  try {
    await bounded(redis.del(...ids.map(key)).then(() => undefined), undefined);
  } catch (error) {
    console.warn('[offeringHealth] cooldown clear failed', { error: errorMessage(error) });
  }
}

/** A rotated key may fix auth_failed / quota_exhausted at once: forget that connection's cooldowns. */
export async function clearConnectionCooldowns(partnerId: string, connectionId: string): Promise<void> {
  const offerings = await listOfferings(partnerId, { connectionId });
  await clearOfferingCooldowns(offerings.map((o) => o.id));
}

export async function noteProviderFailure(
  resolved: Pick<ResolvedModel, 'offering' | 'surface' | 'funding'>,
  cause: ProviderFailureCause,
): Promise<void> {
  // The partnerless platform default (patch_test) has no offering to cool.
  if (!resolved.offering.id) return;
  console.warn('[aiModels] provider failure; offering cooling down', {
    offeringId: resolved.offering.id, surface: resolved.surface, funding: resolved.funding, cause,
  });
  await markOfferingCooldown(resolved.offering.id, cause);
}

/** The same as noteProviderFailure, for callers that hold only the turn's binding (chat). */
export async function noteProviderFailureForBinding(
  binding: Pick<TurnBinding, 'offeringId' | 'surface' | 'funding'>,
  cause: ProviderFailureCause,
): Promise<void> {
  await noteProviderFailure({ offering: { id: binding.offeringId, displayName: '' }, surface: binding.surface, funding: binding.funding }, cause);
}
