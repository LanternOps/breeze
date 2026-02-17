import type { Context } from 'hono';
import { getTrustedClientIp } from '../../services/clientIp';
import { writeAuditEvent } from '../../services/auditEvents';
import { DEFAULT_ALLOWED_ORIGINS } from '../../services/corsOrigins';
import { getRedis } from '../../services/redis';
import type { PortalSession } from './schemas';
import {
  PORTAL_SESSION_COOKIE_NAME,
  PORTAL_SESSION_COOKIE_PATH,
  SESSION_TTL_SECONDS,
  CSRF_HEADER_NAME,
  PORTAL_SESSION_CAP,
  PORTAL_RESET_TOKEN_CAP,
  PORTAL_RATE_BUCKET_CAP,
  STATE_SWEEP_INTERVAL_MS,
  RATE_LIMIT_SWEEP_INTERVAL_MS,
  PORTAL_USE_REDIS,
  PORTAL_REDIS_KEYS,
} from './schemas';

// ============================================
// In-memory state
// ============================================

export const portalSessions = new Map<string, PortalSession>();
export const portalResetTokens = new Map<string, { userId: string; expiresAt: Date; createdAt: Date }>();
export const portalRateLimitBuckets = new Map<string, {
  count: number;
  resetAtMs: number;
  blockedUntilMs: number;
  lastSeenAtMs: number;
}>();

let lastStateSweepAtMs = 0;
let lastRateLimitSweepAtMs = 0;

// ============================================
// Utility functions
// ============================================

export { getPagination } from '../../utils/pagination';

export function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

export function getClientIp(c: Context): string {
  return getTrustedClientIp(c);
}

// ============================================
// Cookie helpers
// ============================================

export function isSecureCookieEnvironment(): boolean {
  return process.env.NODE_ENV === 'production';
}

export function buildPortalSessionCookie(token: string): string {
  const secure = isSecureCookieEnvironment() ? '; Secure' : '';
  return `${PORTAL_SESSION_COOKIE_NAME}=${encodeURIComponent(token)}; Path=${PORTAL_SESSION_COOKIE_PATH}; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_SECONDS}${secure}`;
}

export function buildClearPortalSessionCookie(): string {
  const secure = isSecureCookieEnvironment() ? '; Secure' : '';
  return `${PORTAL_SESSION_COOKIE_NAME}=; Path=${PORTAL_SESSION_COOKIE_PATH}; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
}

export function getCookieValue(cookieHeader: string | undefined, name: string): string | null {
  if (!cookieHeader) return null;
  const target = `${name}=`;

  for (const part of cookieHeader.split(';')) {
    const trimmed = part.trim();
    if (trimmed.startsWith(target)) {
      const value = trimmed.slice(target.length);
      try {
        return decodeURIComponent(value);
      } catch {
        return value;
      }
    }
  }

  return null;
}

// ============================================
// Map cap / sweep helpers
// ============================================

export function capMapByOldest<T>(
  map: Map<string, T>,
  cap: number,
  getAgeMs: (value: T) => number
) {
  if (map.size <= cap) {
    return;
  }

  const overflow = map.size - cap;
  const entries = Array.from(map.entries())
    .sort(([, left], [, right]) => getAgeMs(left) - getAgeMs(right));

  for (let i = 0; i < overflow; i++) {
    const key = entries[i]?.[0];
    if (key) {
      map.delete(key);
    }
  }
}

export function sweepPortalState(nowMs: number = Date.now()) {
  if (nowMs - lastStateSweepAtMs < STATE_SWEEP_INTERVAL_MS) {
    return;
  }

  lastStateSweepAtMs = nowMs;

  for (const [token, session] of portalSessions.entries()) {
    if (session.expiresAt.getTime() <= nowMs) {
      portalSessions.delete(token);
    }
  }

  for (const [tokenHash, reset] of portalResetTokens.entries()) {
    if (reset.expiresAt.getTime() <= nowMs) {
      portalResetTokens.delete(tokenHash);
    }
  }

  capMapByOldest(portalSessions, PORTAL_SESSION_CAP, (session) => session.createdAt.getTime());
  capMapByOldest(portalResetTokens, PORTAL_RESET_TOKEN_CAP, (token) => token.createdAt.getTime());
}

function sweepRateLimitBuckets(nowMs: number = Date.now()) {
  if (nowMs - lastRateLimitSweepAtMs < RATE_LIMIT_SWEEP_INTERVAL_MS) {
    return;
  }

  lastRateLimitSweepAtMs = nowMs;

  for (const [key, bucket] of portalRateLimitBuckets.entries()) {
    const stale = bucket.resetAtMs <= nowMs && bucket.blockedUntilMs <= nowMs;
    const idleTooLong = nowMs - bucket.lastSeenAtMs > RATE_LIMIT_SWEEP_INTERVAL_MS * 6;
    if (stale || idleTooLong) {
      portalRateLimitBuckets.delete(key);
    }
  }

  capMapByOldest(portalRateLimitBuckets, PORTAL_RATE_BUCKET_CAP, (bucket) => bucket.lastSeenAtMs);
}

// ============================================
// Rate limiting
// ============================================

export async function checkRateLimit(
  key: string,
  config: { windowMs: number; maxAttempts: number; blockMs: number },
  nowMs: number = Date.now()
): Promise<{ allowed: boolean; retryAfterSeconds: number }> {
  if (PORTAL_USE_REDIS) {
    const redis = getRedis();
    if (!redis) {
      if (process.env.NODE_ENV === 'production') {
        return { allowed: false, retryAfterSeconds: 60 };
      }
      return { allowed: true, retryAfterSeconds: 0 };
    }

    const blockKey = PORTAL_REDIS_KEYS.rlBlock(key);
    const blockTtl = await redis.ttl(blockKey);
    if (blockTtl > 0) {
      return { allowed: false, retryAfterSeconds: blockTtl };
    }

    const attemptsKey = PORTAL_REDIS_KEYS.rlAttempts(key);
    const windowSeconds = Math.ceil(config.windowMs / 1000);
    const count = await redis.incr(attemptsKey);
    if (count === 1) {
      await redis.expire(attemptsKey, windowSeconds);
    }

    if (count > config.maxAttempts) {
      const blockSeconds = Math.ceil(config.blockMs / 1000);
      await redis.setex(blockKey, blockSeconds, '1');
      return { allowed: false, retryAfterSeconds: blockSeconds };
    }

    return { allowed: true, retryAfterSeconds: 0 };
  }

  sweepRateLimitBuckets(nowMs);

  let bucket = portalRateLimitBuckets.get(key);
  if (!bucket || bucket.resetAtMs <= nowMs) {
    bucket = {
      count: 0,
      resetAtMs: nowMs + config.windowMs,
      blockedUntilMs: 0,
      lastSeenAtMs: nowMs
    };
  }

  if (bucket.blockedUntilMs > nowMs) {
    bucket.lastSeenAtMs = nowMs;
    portalRateLimitBuckets.set(key, bucket);
    capMapByOldest(portalRateLimitBuckets, PORTAL_RATE_BUCKET_CAP, (entry) => entry.lastSeenAtMs);
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((bucket.blockedUntilMs - nowMs) / 1000))
    };
  }

  bucket.count += 1;
  bucket.lastSeenAtMs = nowMs;

  if (bucket.count > config.maxAttempts) {
    bucket.blockedUntilMs = nowMs + config.blockMs;
    portalRateLimitBuckets.set(key, bucket);
    capMapByOldest(portalRateLimitBuckets, PORTAL_RATE_BUCKET_CAP, (entry) => entry.lastSeenAtMs);
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil(config.blockMs / 1000))
    };
  }

  portalRateLimitBuckets.set(key, bucket);
  capMapByOldest(portalRateLimitBuckets, PORTAL_RATE_BUCKET_CAP, (entry) => entry.lastSeenAtMs);
  return { allowed: true, retryAfterSeconds: 0 };
}

export async function clearRateLimitKeys(keys: string[]) {
  if (PORTAL_USE_REDIS) {
    const redis = getRedis();
    if (redis) {
      const redisKeys = keys.flatMap((k) => [
        PORTAL_REDIS_KEYS.rlAttempts(k),
        PORTAL_REDIS_KEYS.rlBlock(k),
      ]);
      if (redisKeys.length > 0) {
        await redis.del(...redisKeys);
      }
    }
    return;
  }
  for (const key of keys) {
    portalRateLimitBuckets.delete(key);
  }
}

// ============================================
// Payload / audit helpers
// ============================================

export function buildPortalUserPayload(user: {
  id: string;
  orgId: string;
  orgName?: string | null;
  email: string;
  name: string | null;
  receiveNotifications: boolean;
  status: string;
}) {
  return {
    id: user.id,
    orgId: user.orgId,
    orgName: user.orgName ?? null,
    organizationId: user.orgId,
    organizationName: user.orgName ?? 'Organization',
    email: user.email,
    name: user.name,
    receiveNotifications: user.receiveNotifications,
    status: user.status
  };
}

export function writePortalAudit(
  c: Context,
  event: Parameters<typeof writeAuditEvent>[1]
) {
  if (process.env.NODE_ENV === 'test') {
    return;
  }
  writeAuditEvent(c, event);
}

// ============================================
// CORS / CSRF helpers
// ============================================

function getAllowedOrigins(): Set<string> {
  const configuredOrigins = (process.env.CORS_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);

  return new Set<string>([...DEFAULT_ALLOWED_ORIGINS, ...configuredOrigins]);
}

function isAllowedOrigin(origin: string): boolean {
  const allowedOrigins = getAllowedOrigins();
  if (allowedOrigins.has(origin)) {
    return true;
  }

  if (process.env.NODE_ENV !== 'production') {
    try {
      const parsed = new URL(origin);
      if (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1') {
        return true;
      }
    } catch {
      return false;
    }
  }

  return false;
}

export function validatePortalCookieCsrfRequest(c: Context): string | null {
  const auth = c.get('portalAuth');
  if (auth.authMethod !== 'cookie') {
    return null;
  }

  const csrfHeader = c.req.header(CSRF_HEADER_NAME);
  if (!csrfHeader || csrfHeader.trim().length === 0) {
    return 'Missing CSRF header';
  }

  const origin = c.req.header('origin');
  if (origin && !isAllowedOrigin(origin)) {
    return 'Invalid request origin';
  }

  return null;
}
