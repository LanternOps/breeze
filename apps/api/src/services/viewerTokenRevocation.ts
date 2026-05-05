import { createHash } from 'node:crypto';
import { getRedis } from './redis';

// TTL matches viewer JWT TTL (jwt.ts VIEWER_ACCESS_TOKEN_EXPIRY) so revoke
// keys auto-expire around the time the tokens they invalidate do.
const REVOKE_TTL_SECONDS = 2 * 60 * 60;

function identifierFingerprint(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 12);
}

export async function revokeViewerJti(jti: string): Promise<void> {
  const redis = getRedis();
  if (!redis) {
    console.error('[viewerTokenRevocation] Redis unavailable — jti revocation skipped', {
      jtiFingerprint: identifierFingerprint(jti),
    });
    return;
  }
  await redis.set(`viewer-jti-revoked:${jti}`, '1', 'EX', REVOKE_TTL_SECONDS);
}

export async function isViewerJtiRevoked(jti: string): Promise<boolean> {
  const redis = getRedis();
  if (!redis) {
    console.error('[viewerTokenRevocation] Redis unavailable — failing closed on jti check');
    return true;
  }
  return (await redis.get(`viewer-jti-revoked:${jti}`)) === '1';
}

export async function revokeViewerSession(sessionId: string): Promise<void> {
  const redis = getRedis();
  if (!redis) {
    console.error('[viewerTokenRevocation] Redis unavailable — session revocation skipped', {
      sessionFingerprint: identifierFingerprint(sessionId),
    });
    return;
  }
  await redis.set(`viewer-session-revoked:${sessionId}`, '1', 'EX', REVOKE_TTL_SECONDS);
}

export async function isViewerSessionRevoked(sessionId: string): Promise<boolean> {
  const redis = getRedis();
  if (!redis) {
    console.error('[viewerTokenRevocation] Redis unavailable — failing closed on session check');
    return true;
  }
  return (await redis.get(`viewer-session-revoked:${sessionId}`)) === '1';
}
