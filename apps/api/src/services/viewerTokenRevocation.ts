import { createHash } from 'node:crypto';
import { getRedis } from './redis';
import { VIEWER_ACCESS_TOKEN_EXPIRY_SECONDS } from './jwt';

function identifierFingerprint(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 12);
}

export async function revokeViewerJti(jti: string): Promise<void> {
  const redis = getRedis();
  if (!redis) {
    console.error('[viewerTokenRevocation] Redis unavailable — jti revocation failed closed', {
      jtiFingerprint: identifierFingerprint(jti),
    });
    throw new Error('viewer token revocation unavailable');
  }
  await redis.set(
    `viewer-jti-revoked:${jti}`,
    '1',
    'EX',
    VIEWER_ACCESS_TOKEN_EXPIRY_SECONDS,
  );
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
    console.error('[viewerTokenRevocation] Redis unavailable — session revocation failed closed', {
      sessionFingerprint: identifierFingerprint(sessionId),
    });
    throw new Error('viewer session revocation unavailable');
  }
  await redis.set(
    `viewer-session-revoked:${sessionId}`,
    '1',
    'EX',
    VIEWER_ACCESS_TOKEN_EXPIRY_SECONDS,
  );
}

export async function isViewerSessionRevoked(sessionId: string): Promise<boolean> {
  const redis = getRedis();
  if (!redis) {
    console.error('[viewerTokenRevocation] Redis unavailable — failing closed on session check');
    return true;
  }
  return (await redis.get(`viewer-session-revoked:${sessionId}`)) === '1';
}
