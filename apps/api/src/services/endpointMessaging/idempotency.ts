import { getRedis } from '../redis';

/**
 * Per-(actor, messageId) idempotency for the send route (#8741 Review Focus 7).
 *
 * `messageId` is client-generated, so a double click or a network retry
 * carries the same id. The first request claims the key (SET NX); when it
 * finishes with a 200 the body is stored for 24 h and every replay returns it
 * verbatim, queueing nothing. A request that ends in any non-200 RELEASES the
 * key so the technician can fix the problem and resend the same id. A crash
 * mid-flight leaves only the short-lived `pending` marker.
 */
const DONE_TTL_SECONDS = 24 * 60 * 60;
const PENDING_TTL_SECONDS = 10 * 60;

export type IdempotencyClaim =
  | { state: 'claimed' }
  | { state: 'replay'; body: unknown }
  | { state: 'in_progress' }
  | { state: 'conflict' }
  | { state: 'unavailable' };

const key = (actorId: string, messageId: string) => `endpoint-msg:idem:${actorId}:${messageId}`;

export async function claimMessageIdempotency(actorId: string, messageId: string, fingerprint: string): Promise<IdempotencyClaim> {
  const redis = getRedis();
  if (!redis) return { state: 'unavailable' };
  try {
    const k = key(actorId, messageId);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const won = await redis.set(k, JSON.stringify({ state: 'pending', fingerprint }), 'EX', PENDING_TTL_SECONDS, 'NX');
      if (won === 'OK') return { state: 'claimed' };
      const existing = await redis.get(k);
      if (existing === null) continue; // expired or released between the two calls
      const parsed = JSON.parse(existing) as { state?: string; body?: unknown; fingerprint?: string };
      // Same id, different request: never replay (or wait on) someone else's send.
      if (parsed.fingerprint !== fingerprint) return { state: 'conflict' };
      return parsed.state === 'done' ? { state: 'replay', body: parsed.body } : { state: 'in_progress' };
    }
    return { state: 'in_progress' };
  } catch (err) {
    console.error('[endpoint-messages] idempotency store failed, failing closed:', err);
    return { state: 'unavailable' };
  }
}

export async function completeMessageIdempotency(actorId: string, messageId: string, fingerprint: string, body: unknown): Promise<void> {
  try {
    await getRedis()?.set(key(actorId, messageId), JSON.stringify({ state: 'done', fingerprint, body }), 'EX', DONE_TTL_SECONDS);
  } catch (err) {
    // The commands are already queued; losing the replay cache only weakens
    // double-click protection for this one message. Surface it, don't fail the send.
    console.error('[endpoint-messages] could not store idempotent response:', err);
  }
}

export async function releaseMessageIdempotency(actorId: string, messageId: string): Promise<void> {
  try {
    await getRedis()?.del(key(actorId, messageId));
  } catch (err) {
    console.warn('[endpoint-messages] could not release idempotency key:', err);
  }
}
