import type Redis from 'ioredis';
import { CLIENT_AI_REDIS_KEYS } from '../routes/clientAi/schemas';

/**
 * Best-effort cleanup for client-AI sessions owned by portal users.
 *
 * Durable authorization is enforced by the portal-user auth epoch on every
 * request. This cleanup only shortens revocation latency and deliberately
 * stays independent of the exchange/DB module so credential and status
 * writers do not initialize exchange-time schema dependencies.
 */
export async function purgeClientAiSessionsForUsers(
  redis: Redis,
  portalUserIds: string[]
): Promise<number> {
  let purged = 0;
  for (const portalUserId of new Set(portalUserIds)) {
    try {
      const indexKey = CLIENT_AI_REDIS_KEYS.userSessions(portalUserId);
      const tokens = await redis.smembers(indexKey);
      if (tokens.length > 0) {
        await redis.del(...tokens.map((token) => CLIENT_AI_REDIS_KEYS.session(token)));
        purged += tokens.length;
      }
      await redis.del(indexKey);
    } catch (err) {
      console.error('[client-ai] Failed to purge sessions for portal user:', {
        portalUserId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return purged;
}
