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

export async function isViewerSessionRevoked(sessionId: string, timeoutMs = 2_000): Promise<boolean> {
  const redis = getRedis();
  if (!redis) {
    console.error('[viewerTokenRevocation] Redis unavailable — failing closed on session check');
    return true;
  }
  // A timeout on a shared ioredis command only abandons the caller: the GET
  // remains queued and can retain memory/socket work indefinitely. Use a
  // dedicated, non-retrying connection so timeout can disconnect the actual
  // underlying command and leave no loser behind.
  let lookup: ReturnType<typeof redis.duplicate> | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    lookup = redis.duplicate({
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 0,
      commandTimeout: timeoutMs,
    });
    const failClosed = new Promise<true>((resolve) => {
      timeout = setTimeout(() => {
        lookup?.disconnect(false);
        resolve(true);
      }, timeoutMs);
    });
    return await Promise.race([
      (async () => {
        if (lookup?.status === 'wait') await lookup.connect();
        return (await lookup!.get(`viewer-session-revoked:${sessionId}`)) === '1';
      })(),
      failClosed,
    ]);
  } catch {
    return true;
  } finally {
    if (timeout) clearTimeout(timeout);
    lookup?.disconnect(false);
  }
}
