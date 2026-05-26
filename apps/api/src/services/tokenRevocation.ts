import { eq, sql } from 'drizzle-orm';
import { getRedis } from './redis';
import * as dbModule from '../db';
import { refreshTokenFamilies } from '../db/schema/refreshTokenFamilies';

const ACCESS_TOKEN_REVOCATION_TTL_SECONDS = 15 * 60;
const REFRESH_TOKEN_REVOCATION_TTL_SECONDS = 7 * 24 * 60 * 60;
const USER_REVOCATION_TTL_SECONDS = REFRESH_TOKEN_REVOCATION_TTL_SECONDS + ACCESS_TOKEN_REVOCATION_TTL_SECONDS;
// Family revocation sentinel must outlive the refresh token itself: a token
// minted just before revocation could otherwise survive past the sentinel's
// expiry. Match the user-revocation buffer pattern.
const REFRESH_FAMILY_REVOCATION_TTL_SECONDS = USER_REVOCATION_TTL_SECONDS;
// jti → familyId mapping. Stored alongside the refresh token so a stolen
// token's family can be looked up without a DB round-trip on the hot
// /refresh path. TTL matches the refresh token expiry + slop.
const REFRESH_JTI_FAMILY_TTL_SECONDS = REFRESH_TOKEN_REVOCATION_TTL_SECONDS + ACCESS_TOKEN_REVOCATION_TTL_SECONDS;

function getRevokedAccessKey(userId: string): string {
  return `token:revoked:${userId}`;
}

function getRevokedAfterKey(userId: string): string {
  return `token:revoked_after:${userId}`;
}

function getRevokedRefreshKey(jti: string): string {
  return `token:refresh:revoked:${jti}`;
}

function getRefreshJtiFamilyKey(jti: string): string {
  return `refresh-jti-fam:${jti}`;
}

function getRevokedFamilyKey(familyId: string): string {
  return `refresh-fam-revoked:${familyId}`;
}

// Fail-closed: when Redis is unavailable we treat access tokens as revoked.
// This matches the refresh-token behavior and ensures that a Redis outage
// cannot silently re-enable revoked user sessions.  The trade-off is that
// all authenticated traffic is blocked during a Redis outage, but this is
// the correct security posture — revocation is a critical control, not a
// best-effort optimization.
export async function isUserTokenRevoked(userId: string, tokenIssuedAt?: number): Promise<boolean> {
  const redis = getRedis();
  if (!redis) {
    console.error(
      '[token-revocation] Redis unavailable — failing closed (treating token as revoked)'
    );
    return true;
  }

  try {
    const revoked = await redis.get(getRevokedAccessKey(userId));
    if (revoked) {
      // Blanket revocation is active (set during logout).  However, if the
      // token was issued AFTER the revocation timestamp it belongs to a new
      // login session and must be allowed through.
      if (typeof tokenIssuedAt === 'number' && Number.isFinite(tokenIssuedAt)) {
        const revokedAfterRaw = await redis.get(getRevokedAfterKey(userId));
        if (revokedAfterRaw) {
          const revokedAfter = Number.parseInt(revokedAfterRaw, 10);
          if (Number.isFinite(revokedAfter) && tokenIssuedAt > revokedAfter) {
            return false; // token from a new session — valid
          }
        }
      }
      return true;
    }

    if (typeof tokenIssuedAt !== 'number' || !Number.isFinite(tokenIssuedAt)) {
      return false;
    }

    const revokedAfterRaw = await redis.get(getRevokedAfterKey(userId));
    if (!revokedAfterRaw) {
      return false;
    }

    const revokedAfter = Number.parseInt(revokedAfterRaw, 10);
    if (!Number.isFinite(revokedAfter)) {
      return false;
    }

    return tokenIssuedAt <= revokedAfter;
  } catch (error) {
    console.error(
      '[token-revocation] Failed to check token revocation state — failing closed:',
      error
    );
    return true;
  }
}

export async function revokeAllUserTokens(userId: string): Promise<void> {
  const redis = getRedis();
  if (!redis) {
    throw new Error('[token-revocation] Redis unavailable — cannot revoke user tokens');
  }

  // Subtract 1 so tokens minted in the same second as the revocation (e.g.
  // an immediate re-login after password change) are treated as valid.
  // Specific token JTI revocation still covers the exact old token.
  const cutoff = Math.floor(Date.now() / 1000) - 1;
  try {
    await redis
      .multi()
      .setex(getRevokedAccessKey(userId), ACCESS_TOKEN_REVOCATION_TTL_SECONDS, '1')
      .setex(getRevokedAfterKey(userId), USER_REVOCATION_TTL_SECONDS, String(cutoff))
      .exec();
  } catch (error) {
    console.error('[token-revocation] Failed to revoke user tokens:', error);
    throw error;
  }
}

export async function isRefreshTokenJtiRevoked(jti: string): Promise<boolean> {
  const redis = getRedis();
  if (!redis) {
    console.error('[token-revocation] Redis unavailable — failing closed (treating refresh token as revoked)');
    return true;
  }

  try {
    const revoked = await redis.get(getRevokedRefreshKey(jti));
    return Boolean(revoked);
  } catch (error) {
    console.error('[token-revocation] Failed to check refresh token revocation — failing closed:', error);
    return true;
  }
}

/**
 * Atomically claim revocation of a refresh-token jti.
 *
 * Returns `true` when this caller won the claim (the key did not exist and we
 * just wrote it), `false` when another caller — typically a concurrent /refresh
 * racing on the same cookie — already revoked the jti.
 *
 * The /refresh hot path MUST treat `false` as a concurrent-refresh signal and
 * refuse to mint a new pair. An unconditional SETEX would let both racers
 * believe they were the first to revoke, leaving two parallel valid descendant
 * chains on the same family for up to the refresh TTL. This is exactly the
 * TOCTOU the family-revocation scheme was meant to close.
 *
 * Throws only on Redis unavailability or write errors. Idempotent at the
 * Redis-key level: re-claiming an already-claimed jti returns `false` without
 * extending the TTL (`NX` skips writes for existing keys).
 */
export async function revokeRefreshTokenJti(jti: string): Promise<boolean> {
  const redis = getRedis();
  if (!redis) {
    throw new Error('[token-revocation] Redis unavailable — cannot revoke refresh token');
  }

  try {
    const result = await redis.set(
      getRevokedRefreshKey(jti),
      '1',
      'EX',
      REFRESH_TOKEN_REVOCATION_TTL_SECONDS,
      'NX'
    );
    return result === 'OK';
  } catch (error) {
    console.error('[token-revocation] Failed to revoke refresh token:', error);
    throw error;
  }
}

// ============================================================================
// Refresh-Token Families (OAuth 2.1 reuse detection)
//
// Each /login mints a fresh familyId; every refresh token in the resulting
// rotation chain carries the same `fam` claim. When a revoked jti is
// replayed, the whole family is killed so the legitimate user's later
// refresh can't continue silently in parallel with the attacker's.
//
// Source-of-truth split:
//   - Redis (`refresh-fam-revoked:<familyId>`) is the hot-path lookup.
//   - Postgres (`refresh_token_families.revoked_at`) is the durable audit
//     trail, surviving Redis flushes.
// Both are written on every revoke; reads prefer Redis and fall back to PG.
// ============================================================================

/**
 * Remembers the mapping from a freshly-minted refresh-token jti to its
 * family id. Stored in Redis only (not PG) because the lookup is hot-path
 * and the mapping naturally expires with the token; on Redis loss we fall
 * back to the `fam` claim that's already embedded in the verified JWT.
 *
 * Idempotent. Best-effort: a Redis outage here just means a slightly slower
 * /refresh next time (we'll fall through to the JWT claim).
 */
export async function rememberJtiFamily(jti: string, familyId: string): Promise<void> {
  const redis = getRedis();
  if (!redis) {
    // Not fatal — the family id is also encoded in the JWT `fam` claim, so
    // the family-revocation check still works from the verified payload.
    return;
  }
  try {
    await redis.setex(getRefreshJtiFamilyKey(jti), REFRESH_JTI_FAMILY_TTL_SECONDS, familyId);
  } catch (error) {
    console.warn('[token-revocation] Failed to remember jti→family mapping:', error);
  }
}

/**
 * Hot-path lookup of the family for a given jti. Returns null on miss.
 * Callers should fall back to the verified JWT's `fam` claim — Redis is
 * an accelerator, not the source of truth.
 */
export async function getFamilyForJti(jti: string): Promise<string | null> {
  const redis = getRedis();
  if (!redis) return null;
  try {
    return await redis.get(getRefreshJtiFamilyKey(jti));
  } catch (error) {
    console.warn('[token-revocation] Failed to look up jti→family mapping:', error);
    return null;
  }
}

/**
 * Atomically marks the family as revoked in both Redis (hot-path sentinel)
 * and Postgres (durable audit row). Idempotent: a second call against an
 * already-revoked family is a no-op for the PG row's first revocation
 * timestamp (uses `WHERE revoked_at IS NULL`).
 *
 * Uses `withSystemDbAccessContext` for the DB write because reuse-detection
 * runs before the user-scope is established in /refresh — and even if it
 * did run user-scoped, the system-scope path is the conservative choice
 * (it never fails RLS).
 */
export async function revokeFamily(familyId: string, reason: string): Promise<void> {
  const truncatedReason = reason.length > 64 ? reason.slice(0, 64) : reason;

  // Best-effort Redis flip first. Failure here is logged but the DB update
  // still goes through — fail-closed semantics live in isFamilyRevoked,
  // which prefers Redis but falls back to PG on Redis miss.
  const redis = getRedis();
  if (redis) {
    try {
      await redis.setex(
        getRevokedFamilyKey(familyId),
        REFRESH_FAMILY_REVOCATION_TTL_SECONDS,
        '1'
      );
    } catch (error) {
      console.error('[token-revocation] Failed to write family-revoked sentinel to Redis:', error);
    }
  } else {
    console.error('[token-revocation] Redis unavailable while revoking family — DB row will still be updated');
  }

  // Durable audit: stamp revoked_at on the PG row (idempotent — only the
  // first revocation wins). Bypass RLS via system scope so the call works
  // regardless of which DB context (if any) is on the stack.
  try {
    await dbModule.withSystemDbAccessContext(async () => {
      await dbModule.db
        .update(refreshTokenFamilies)
        .set({
          revokedAt: sql`COALESCE(revoked_at, now())`,
          revokedReason: sql`COALESCE(revoked_reason, ${truncatedReason})`,
        })
        .where(eq(refreshTokenFamilies.familyId, familyId));
    });
  } catch (error) {
    // The Redis sentinel above is what gates /refresh; the DB row is a
    // durable audit. If Redis flipped but PG didn't, we still block the
    // attacker — we just lose the audit trail.
    console.error('[token-revocation] Failed to persist family revocation to DB:', error);
  }
}

/**
 * Returns true if the family has been revoked. Hot-path check uses Redis;
 * on Redis miss/error, falls back to the PG audit row.
 *
 * Fail-closed: if BOTH Redis and PG are unreachable, returns true. The
 * trade-off matches `isUserTokenRevoked` — a brief outage blocks all
 * refreshes rather than silently re-enabling a compromised family.
 */
export async function isFamilyRevoked(familyId: string): Promise<boolean> {
  const redis = getRedis();
  if (redis) {
    try {
      const sentinel = await redis.get(getRevokedFamilyKey(familyId));
      if (sentinel) return true;
      // Redis says "not revoked" — but the sentinel could have been evicted
      // (no maxmemory eviction-policy guarantee). Confirm against PG before
      // declaring the family alive. This is cheap: indexed PK lookup.
    } catch (error) {
      console.warn(
        '[token-revocation] Family-revoked Redis lookup failed — falling back to DB:',
        error
      );
    }
  }

  try {
    const rows = await dbModule.withSystemDbAccessContext(async () =>
      dbModule.db
        .select({ revokedAt: refreshTokenFamilies.revokedAt })
        .from(refreshTokenFamilies)
        .where(eq(refreshTokenFamilies.familyId, familyId))
        .limit(1)
    );
    const row = rows[0];
    if (!row) {
      // No row at all → fail-closed. A valid /refresh path always has a row
      // (created during /login). A missing row means either Redis is also
      // wiped (token from another deployment generation) or the JWT was
      // forged; either way we reject.
      return true;
    }
    return row.revokedAt !== null;
  } catch (error) {
    console.error(
      '[token-revocation] Family-revoked DB lookup failed — failing closed:',
      error
    );
    return true;
  }
}

/**
 * Best-effort lastUsedAt update. Called on every successful /refresh. Not
 * critical to the security model — used for analytics + dashboards only
 * (e.g. "this session has been silent for 30d"). System-scoped for the
 * same reason as revokeFamily.
 */
export async function touchFamilyLastUsed(familyId: string): Promise<void> {
  try {
    await dbModule.withSystemDbAccessContext(async () => {
      await dbModule.db
        .update(refreshTokenFamilies)
        .set({ lastUsedAt: sql`now()` })
        .where(eq(refreshTokenFamilies.familyId, familyId));
    });
  } catch (error) {
    // Pure telemetry; do not block the refresh.
    console.warn('[token-revocation] Failed to update family lastUsedAt:', error);
  }
}
