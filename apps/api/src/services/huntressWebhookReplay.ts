/**
 * Replay guard for Standard Webhooks deliveries to the Huntress receiver
 * (#10335). Svix delivers at least once and re-signs every retry with a fresh
 * timestamp, so the 10-minute signature window alone does not stop a verified
 * delivery from being processed twice. The `webhook-id` is reserved in Redis
 * with SET NX once the signature has verified, the same pattern the Resend
 * receiver uses (routes/webhooks/emailProvider.ts).
 *
 * Only Standard Webhooks deliveries carry a message id. The legacy
 * x-huntress-signature scheme has none and is not reserved.
 */
import type Redis from 'ioredis';

/**
 * Must outlast the 10-minute signature window; matches the Resend receiver's
 * 24 hours so a late Svix retry of an already-ingested delivery is still caught.
 */
export const HUNTRESS_WEBHOOK_DEDUPE_TTL_SECONDS = 24 * 60 * 60;

type ReplayRedis = Pick<Redis, 'set' | 'del'>;

export type HuntressWebhookReservation =
  | { status: 'reserved'; key: string }
  | { status: 'duplicate' }
  | { status: 'unavailable' };

export function huntressWebhookReplayKey(integrationId: string, messageId: string): string {
  return `huntress:webhook:${integrationId}:${messageId}`;
}

/** Never throws: a Redis failure is reported as `unavailable` for the caller to fail closed on. */
export async function reserveHuntressWebhookMessage(
  redis: ReplayRedis | null,
  integrationId: string,
  messageId: string,
): Promise<HuntressWebhookReservation> {
  if (!redis) return { status: 'unavailable' };
  const key = huntressWebhookReplayKey(integrationId, messageId);
  try {
    const reserved = await redis.set(key, '1', 'EX', HUNTRESS_WEBHOOK_DEDUPE_TTL_SECONDS, 'NX');
    return reserved === 'OK' ? { status: 'reserved', key } : { status: 'duplicate' };
  } catch (err) {
    console.error('[huntress] Webhook replay reservation failed:', err instanceof Error ? err.message : err);
    return { status: 'unavailable' };
  }
}

/**
 * Best-effort release after a failed ingest, so Huntress's retry is accepted
 * instead of answered as a duplicate. A failed release only logs: the key
 * then expires with its TTL.
 */
export async function releaseHuntressWebhookMessage(redis: ReplayRedis, key: string): Promise<void> {
  try {
    await redis.del(key);
  } catch (err) {
    console.error('[huntress] Failed to release webhook replay reservation:', err instanceof Error ? err.message : err);
  }
}
