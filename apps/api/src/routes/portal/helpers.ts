import type { Context } from 'hono';
import { randomBytes, timingSafeEqual } from 'crypto';
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
  PORTAL_CSRF_COOKIE_NAME,
  PORTAL_CSRF_COOKIE_PATH,
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

type SameSiteValue = 'Lax' | 'Strict' | 'None';

function normalizeSameSite(raw: string | undefined): SameSiteValue {
  const value = raw?.trim().toLowerCase();
  if (value === 'strict') return 'Strict';
  if (value === 'none') return 'None';
  return 'Lax';
}

function resolvePortalCookieSameSite(): SameSiteValue {
  return normalizeSameSite(process.env.PORTAL_COOKIE_SAME_SITE ?? process.env.COOKIE_SAME_SITE);
}

function shouldSetSecureCookie(sameSite: SameSiteValue): boolean {
  if (sameSite === 'None') {
    // Browsers require Secure when SameSite=None.
    return true;
  }
  const forceSecure = (process.env.PORTAL_COOKIE_FORCE_SECURE ?? process.env.COOKIE_FORCE_SECURE)?.trim().toLowerCase();
  if (forceSecure === '1' || forceSecure === 'true') {
    return true;
  }
  return isSecureCookieEnvironment();
}

function buildCookieSecuritySuffix(sameSite: SameSiteValue): string {
  const secure = shouldSetSecureCookie(sameSite) ? '; Secure' : '';
  return `; SameSite=${sameSite}${secure}`;
}

export function buildPortalSessionCookie(token: string): string {
  const sameSite = resolvePortalCookieSameSite();
  return `${PORTAL_SESSION_COOKIE_NAME}=${encodeURIComponent(token)}; Path=${PORTAL_SESSION_COOKIE_PATH}; HttpOnly${buildCookieSecuritySuffix(sameSite)}; Max-Age=${SESSION_TTL_SECONDS}`;
}

export function buildPortalCsrfCookie(token: string): string {
  const sameSite = resolvePortalCookieSameSite();
  return `${PORTAL_CSRF_COOKIE_NAME}=${encodeURIComponent(token)}; Path=${PORTAL_CSRF_COOKIE_PATH}${buildCookieSecuritySuffix(sameSite)}; Max-Age=${SESSION_TTL_SECONDS}`;
}

export function buildClearPortalSessionCookie(): string {
  const sameSite = resolvePortalCookieSameSite();
  return `${PORTAL_SESSION_COOKIE_NAME}=; Path=${PORTAL_SESSION_COOKIE_PATH}; HttpOnly${buildCookieSecuritySuffix(sameSite)}; Max-Age=0`;
}

export function buildClearPortalCsrfCookie(): string {
  const sameSite = resolvePortalCookieSameSite();
  return `${PORTAL_CSRF_COOKIE_NAME}=; Path=${PORTAL_CSRF_COOKIE_PATH}${buildCookieSecuritySuffix(sameSite)}; Max-Age=0`;
}

export function setPortalSessionCookies(c: Context, sessionToken: string): void {
  c.header('Set-Cookie', buildPortalSessionCookie(sessionToken), { append: true });
  c.header('Set-Cookie', buildPortalCsrfCookie(randomBytes(32).toString('hex')), { append: true });
}

export function clearPortalSessionCookies(c: Context): void {
  c.header('Set-Cookie', buildClearPortalSessionCookie(), { append: true });
  c.header('Set-Cookie', buildClearPortalCsrfCookie(), { append: true });
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

  const csrfHeader = c.req.header(CSRF_HEADER_NAME)?.trim();
  if (!csrfHeader || csrfHeader.length === 0) {
    return 'Missing CSRF header';
  }

  const csrfCookie = getCookieValue(c.req.header('cookie'), PORTAL_CSRF_COOKIE_NAME);
  if (!csrfCookie) {
    return 'Missing CSRF cookie';
  }
  if (!safeCompareTokens(csrfHeader, csrfCookie)) {
    return 'Invalid CSRF token';
  }

  const origin = c.req.header('origin');
  if (origin && !isAllowedOrigin(origin)) {
    return 'Invalid request origin';
  }

  const fetchSite = c.req.header('sec-fetch-site');
  if (fetchSite) {
    const normalized = fetchSite.toLowerCase();
    if (normalized !== 'same-origin' && normalized !== 'same-site') {
      return 'Cross-site request blocked';
    }
  }

  return null;
}

function safeCompareTokens(headerToken: string, cookieToken: string): boolean {
  const headerBuffer = Buffer.from(headerToken, 'utf8');
  const cookieBuffer = Buffer.from(cookieToken, 'utf8');
  if (headerBuffer.length !== cookieBuffer.length) {
    return false;
  }
  return timingSafeEqual(headerBuffer, cookieBuffer);
}
