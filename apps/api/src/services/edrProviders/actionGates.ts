import type { Redis } from 'ioredis';
import { rateLimiter } from '../rate-limit';

/**
 * Breeze-side limits on EDR response actions (W03, #8167), on top of the
 * vendor request budget. Two windows, both must admit:
 *  - per connection: everything sent through one vendor console;
 *  - per actor: one user (or one AI session) across every connection.
 * A batch of N targets costs N. Redis-only (no DB), so it runs outside any DB
 * context. Fails CLOSED when Redis is unavailable: an unthrottled containment
 * action is worse than a refused one.
 */
export const EDR_ACTION_RATE_LIMITS = {
  perConnection: { limit: 30, windowSeconds: 600 },
  perActor: { limit: 10, windowSeconds: 600 },
} as const;

/** `u:<userId>` | `s:<aiSessionId>` | `anon`. The accountable human wins over the session. */
export function edrActorKey(o: { userId: string | null; aiSessionId: string | null }): string {
  if (o.userId) return `u:${o.userId}`;
  if (o.aiSessionId) return `s:${o.aiSessionId}`;
  return 'anon';
}

export async function checkEdrActionRateLimit(o: {
  redis: Redis | null;
  connectionId: string;
  actorKey: string;
  targets: number;
}): Promise<{ ok: true } | { ok: false; retryAfterSeconds: number }> {
  const cost = Math.max(1, Math.floor(o.targets));
  if (!o.redis) {
    return { ok: false, retryAfterSeconds: EDR_ACTION_RATE_LIMITS.perConnection.windowSeconds };
  }
  // Actor first, then connection, each with refund-on-reject (a rejected
  // window gives its entries back). If the connection window rejects, the
  // actor's own admission is kept: a refused attempt counts against the person
  // who made it, never against the shared console budget of their colleagues.
  const windows = [
    { key: `edr-actions:actor:${o.actorKey}`, ...EDR_ACTION_RATE_LIMITS.perActor },
    { key: `edr-actions:conn:${o.connectionId}`, ...EDR_ACTION_RATE_LIMITS.perConnection },
  ];
  for (const w of windows) {
    const res = await rateLimiter(o.redis, w.key, w.limit, w.windowSeconds, cost, { refundOnReject: true });
    if (!res.allowed) {
      return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((res.resetAt.getTime() - Date.now()) / 1000)) };
    }
  }
  return { ok: true };
}
