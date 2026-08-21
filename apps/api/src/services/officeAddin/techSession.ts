import { nanoid } from 'nanoid';
import type Redis from 'ioredis';

/**
 * Opaque Redis session for the Outlook tech add-in (spec §3, Task 9).
 *
 * Deliberately mirrors the client-ai session pattern (clientAiExchange.ts /
 * routes/clientAi/schemas.ts CLIENT_AI_REDIS_KEYS): nanoid(48) opaque token,
 * SETEX for the session hash, SADD + EXPIRE(2x TTL) for the per-user reverse
 * index used by bulk revocation.
 *
 * Namespace is intentionally `techaddin:*`, never `clientai:*` — a technician
 * session must never be readable by clientAiAuthMiddleware (it would hydrate
 * the opaque token as a portal/client user, crossing the tech/client-user
 * trust boundary this add-in exists to keep separate).
 *
 * Two TTL concepts:
 *   - TECH_SESSION_SLIDING_TTL_SECONDS: Redis key TTL, refreshed (EXPIRE) on
 *     every successful getTechSession call — keeps an active tech signed in.
 *   - TECH_SESSION_MAX_LIFETIME_MS: absolute cap measured from `createdAt`,
 *     enforced in getTechSession regardless of how recently the key was
 *     touched — bounds how long a session can be kept alive by sliding alone.
 */

export const TECH_SESSION_SLIDING_TTL_SECONDS = 12 * 60 * 60; // 12h sliding
export const TECH_SESSION_MAX_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000; // 7d absolute

export const TECH_SESSION_KEYS = {
  session: (token: string) => `techaddin:session:${token}`,
  userSessions: (userId: string) => `techaddin:user-sessions:${userId}`,
};

export interface TechSessionPayload {
  userId: string;
  partnerId: string;
  bindingId: string;
  createdAt: string;
}

export async function mintTechSession(
  redis: Redis,
  payload: Omit<TechSessionPayload, 'createdAt'>
): Promise<{ token: string; expiresInSeconds: number }> {
  const token = nanoid(48);
  const fullPayload: TechSessionPayload = { ...payload, createdAt: new Date().toISOString() };

  await redis.setex(
    TECH_SESSION_KEYS.session(token),
    TECH_SESSION_SLIDING_TTL_SECONDS,
    JSON.stringify(fullPayload)
  );
  await redis.sadd(TECH_SESSION_KEYS.userSessions(payload.userId), token);
  await redis.expire(
    TECH_SESSION_KEYS.userSessions(payload.userId),
    TECH_SESSION_SLIDING_TTL_SECONDS * 2
  );

  return { token, expiresInSeconds: TECH_SESSION_SLIDING_TTL_SECONDS };
}

/**
 * Field guard matching mintTechSession's write shape. Every downstream
 * consumer (the tech middleware, the per-user revocation index) assumes these
 * four non-empty strings exist — a payload that fails this never came from
 * mintTechSession and must be treated as corrupt, not trusted.
 */
function isTechSessionPayload(value: unknown): value is TechSessionPayload {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.userId === 'string' && v.userId.length > 0 &&
    typeof v.partnerId === 'string' && v.partnerId.length > 0 &&
    typeof v.bindingId === 'string' && v.bindingId.length > 0 &&
    typeof v.createdAt === 'string' && v.createdAt.length > 0
  );
}

export async function getTechSession(redis: Redis, token: string): Promise<TechSessionPayload | null> {
  const sessionKey = TECH_SESSION_KEYS.session(token);
  const raw = await redis.get(sessionKey);
  if (!raw) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = undefined;
  }
  if (!isTechSessionPayload(parsed)) {
    // Corrupt/foreign payload under our namespace: log the KEY (never the
    // value — it is untrusted bytes) and delete it so the bad key can't keep
    // costing a parse + this branch on every retry.
    console.error('[office-addin] corrupt tech session payload, deleting key', sessionKey);
    await redis.del(sessionKey);
    return null;
  }
  const session: TechSessionPayload = parsed;

  const createdAtMs = new Date(session.createdAt).getTime();
  if (Number.isNaN(createdAtMs) || Date.now() - createdAtMs > TECH_SESSION_MAX_LIFETIME_MS) {
    await redis.del(TECH_SESSION_KEYS.session(token));
    return null;
  }

  // Sliding window: any successful read pushes expiry forward.
  await redis.expire(TECH_SESSION_KEYS.session(token), TECH_SESSION_SLIDING_TTL_SECONDS);

  return session;
}

export async function revokeTechSessionsForUser(redis: Redis, userId: string): Promise<void> {
  const indexKey = TECH_SESSION_KEYS.userSessions(userId);
  const tokens = await redis.smembers(indexKey);
  if (tokens.length > 0) {
    await redis.del(...tokens.map((t) => TECH_SESSION_KEYS.session(t)));
  }
  await redis.del(indexKey);
}
