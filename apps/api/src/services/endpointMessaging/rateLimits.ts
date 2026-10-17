import { getRedis } from '../redis';
import { rateLimiter } from '../rate-limit';

/**
 * Send-side abuse limits for endpoint messages (#8741 OD-4 starting values).
 * Enforced in the route regardless of whether a human or an AI surface drove
 * the send. Redis-backed; every limiter fails CLOSED when Redis is down.
 */
export const ENDPOINT_MESSAGE_RATE_LIMITS = {
  actorSendsPerHour: 20,
  partnerDeliveriesPerHour: 10_000,
  criticalPerDeviceWindowSeconds: 300,
} as const;

const HOUR_SECONDS = 3600;

export interface LimitDecision {
  allowed: boolean;
  retryAfterSeconds: number;
}

function toDecision(r: { allowed: boolean; resetAt: Date }): LimitDecision {
  return {
    allowed: r.allowed,
    retryAfterSeconds: r.allowed ? 0 : Math.max(1, Math.ceil((r.resetAt.getTime() - Date.now()) / 1000)),
  };
}

/** 20 sends per hour per actor. A rejected attempt does not consume capacity. */
export async function checkActorSendLimit(actorId: string): Promise<LimitDecision> {
  return toDecision(
    await rateLimiter(
      getRedis(),
      `endpoint-msg:actor:${actorId}`,
      ENDPOINT_MESSAGE_RATE_LIMITS.actorSendsPerHour,
      HOUR_SECONDS,
      1,
      { refundOnReject: true },
    ),
  );
}

/** 10 000 device deliveries per hour per partner; `deliveries` is the cost. */
export async function checkPartnerDeliveryLimit(partnerId: string, deliveries: number): Promise<LimitDecision> {
  if (deliveries <= 0) return { allowed: true, retryAfterSeconds: 0 };
  return toDecision(
    await rateLimiter(
      getRedis(),
      `endpoint-msg:partner:${partnerId}`,
      ENDPOINT_MESSAGE_RATE_LIMITS.partnerDeliveriesPerHour,
      HOUR_SECONDS,
      deliveries,
      { refundOnReject: true },
    ),
  );
}

const criticalKey = (deviceId: string) => `endpoint-msg:critical:${deviceId}`;

/** One `critical` per device per 5 minutes. True when this send may proceed. */
export async function claimCriticalSlot(deviceId: string): Promise<boolean> {
  const redis = getRedis();
  if (!redis) return false;
  try {
    const ok = await redis.set(
      criticalKey(deviceId),
      '1',
      'EX',
      ENDPOINT_MESSAGE_RATE_LIMITS.criticalPerDeviceWindowSeconds,
      'NX',
    );
    return ok === 'OK';
  } catch (err) {
    console.error('[endpoint-messages] critical slot claim failed, failing closed:', err);
    return false;
  }
}

/** Give the slot back when the message was not actually queued. */
export async function releaseCriticalSlot(deviceId: string): Promise<void> {
  try {
    await getRedis()?.del(criticalKey(deviceId));
  } catch (err) {
    console.warn('[endpoint-messages] critical slot release failed:', err);
  }
}

/**
 * Endpoint live chat limits (#8743, plan Task 3.3). Same fail-closed Redis
 * limiter; a rejected attempt does not consume capacity.
 */
async function chatLimit(key: string, limit: number): Promise<LimitDecision> {
  return toDecision(await rateLimiter(getRedis(), key, limit, HOUR_SECONDS, 1, { refundOnReject: true }));
}

/** Conversations one actor may open per hour. */
export function checkChatOpenLimit(actorId: string, limit: number): Promise<LimitDecision> {
  return chatLimit(`endpoint-chat:open:${actorId}`, limit);
}

/** Technician messages per conversation per hour (the opening message included). */
export function checkChatMessageLimit(conversationId: string, limit: number): Promise<LimitDecision> {
  return chatLimit(`endpoint-chat:msg:${conversationId}`, limit);
}

/** End-user replies per conversation per hour. */
export function checkChatReplyLimit(conversationId: string, limit: number): Promise<LimitDecision> {
  return chatLimit(`endpoint-chat:reply:${conversationId}`, limit);
}
