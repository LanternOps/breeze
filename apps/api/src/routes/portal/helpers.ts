import type { Context, MiddlewareHandler } from 'hono';
import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import { nanoid } from 'nanoid';
import { getTrustedClientIp } from '../../services/clientIp';
import { isRequestConnectionSecure } from '../auth/helpers';
import { writeAuditEvent } from '../../services/auditEvents';
import { DEFAULT_ALLOWED_ORIGINS } from '../../services/corsOrigins';
import { getRedis } from '../../services/redis';
import { portalBase } from '../../services/portalUrl';
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
  INVITE_TTL_MS,
  INVITE_TTL_SECONDS,
  PORTAL_INVITE_TOKEN_CAP,
} from './schemas';

// ============================================
// In-memory state
// ============================================

export const portalSessions = new Map<string, PortalSession>();
export const portalResetTokens = new Map<string, { userId: string; expiresAt: Date; createdAt: Date }>();
export const portalInviteTokens = new Map<string, { portalUserId: string; expiresAt: Date; createdAt: Date }>();
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

export type PortalCachePolicy = {
  scope: 'private' | 'public';
  browserMaxAgeSeconds: number;
  staleWhileRevalidateSeconds: number;
  sharedMaxAgeSeconds?: number;
  vary?: string[];
};

export function applyPortalCacheHeaders(c: Context, policy: PortalCachePolicy): void {
  if (policy.scope === 'public') {
    const sharedMaxAge = policy.sharedMaxAgeSeconds ?? policy.browserMaxAgeSeconds;
    c.header(
      'Cache-Control',
      `public, max-age=${policy.browserMaxAgeSeconds}, s-maxage=${sharedMaxAge}, stale-while-revalidate=${policy.staleWhileRevalidateSeconds}`
    );
    c.header(
      'CDN-Cache-Control',
      `public, max-age=${sharedMaxAge}, stale-while-revalidate=${policy.staleWhileRevalidateSeconds}`
    );
  } else {
    c.header(
      'Cache-Control',
      `private, max-age=${policy.browserMaxAgeSeconds}, stale-while-revalidate=${policy.staleWhileRevalidateSeconds}`
    );
  }

  if (policy.vary && policy.vary.length > 0) {
    c.header('Vary', policy.vary.join(', '));
  }
}

export function buildWeakEtag(payload: unknown): string {
  const serialized = JSON.stringify(payload) ?? '';
  const digest = createHash('sha1').update(serialized).digest('base64url');
  return `W/"${digest}"`;
}

export function isEtagFresh(ifNoneMatchHeader: string | undefined, etag: string): boolean {
  if (!ifNoneMatchHeader) {
    return false;
  }

  return ifNoneMatchHeader
    .split(',')
    .map((tag) => tag.trim())
    .includes(etag);
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

function forcePortalSecureCookie(): boolean {
  const forceSecure = (process.env.PORTAL_COOKIE_FORCE_SECURE ?? process.env.COOKIE_FORCE_SECURE)?.trim().toLowerCase();
  return forceSecure === '1' || forceSecure === 'true';
}

function shouldSetSecureCookie(sameSite: SameSiteValue, connectionSecure: boolean): boolean {
  if (sameSite === 'None') {
    // Browsers require Secure when SameSite=None.
    return true;
  }
  if (forcePortalSecureCookie()) {
    return true;
  }
  return connectionSecure;
}

function buildCookieSecuritySuffix(sameSite: SameSiteValue, connectionSecure: boolean): string {
  const secure = shouldSetSecureCookie(sameSite, connectionSecure) ? '; Secure' : '';
  return `; SameSite=${sameSite}${secure}`;
}

// `connectionSecure` is required on every build* function so no caller can
// silently fall back to the pre-#1618 NODE_ENV heuristic (#2611 — the portal
// surface had its own copy of that footgun). Derive it from the request via
// isRequestConnectionSecure(c), or use the set/clear entry points below, which
// also emit the misconfiguration warnings.
export function buildPortalSessionCookie(token: string, connectionSecure: boolean): string {
  const sameSite = resolvePortalCookieSameSite();
  return `${PORTAL_SESSION_COOKIE_NAME}=${encodeURIComponent(token)}; Path=${PORTAL_SESSION_COOKIE_PATH}; HttpOnly${buildCookieSecuritySuffix(sameSite, connectionSecure)}; Max-Age=${SESSION_TTL_SECONDS}`;
}

export function buildPortalCsrfCookie(token: string, connectionSecure: boolean): string {
  const sameSite = resolvePortalCookieSameSite();
  return `${PORTAL_CSRF_COOKIE_NAME}=${encodeURIComponent(token)}; Path=${PORTAL_CSRF_COOKIE_PATH}${buildCookieSecuritySuffix(sameSite, connectionSecure)}; Max-Age=${SESSION_TTL_SECONDS}`;
}

export function buildClearPortalSessionCookie(connectionSecure: boolean): string {
  const sameSite = resolvePortalCookieSameSite();
  return `${PORTAL_SESSION_COOKIE_NAME}=; Path=${PORTAL_SESSION_COOKIE_PATH}; HttpOnly${buildCookieSecuritySuffix(sameSite, connectionSecure)}; Max-Age=0`;
}

export function buildClearPortalCsrfCookie(connectionSecure: boolean): string {
  const sameSite = resolvePortalCookieSameSite();
  return `${PORTAL_CSRF_COOKIE_NAME}=; Path=${PORTAL_CSRF_COOKIE_PATH}${buildCookieSecuritySuffix(sameSite, connectionSecure)}; Max-Age=0`;
}

// Throttled warnings so a busy misconfigured deployment logs periodically
// without flooding. Keyed per warning kind (a small fixed set — never by
// host/peer) so one misconfiguration class can't suppress reports of another.
// Module-scoped; resets on process restart. Mirrors the admin-app pattern
// (routes/auth/helpers.ts) on the portal surface (#2611).
const PORTAL_COOKIE_WARN_INTERVAL_MS = 10 * 60 * 1000;
const portalCookieLastWarnAt = new Map<string, number>();

function warnPortalCookieThrottled(kind: string, message: string): void {
  const now = Date.now();
  const last = portalCookieLastWarnAt.get(kind);
  if (last !== undefined && now - last < PORTAL_COOKIE_WARN_INTERVAL_MS) {
    return;
  }
  portalCookieLastWarnAt.set(kind, now);
  console.warn(message);
}

export function _resetPortalCookieWarnStateForTests(): void {
  portalCookieLastWarnAt.clear();
}

function describePortalCookieTransport(c: Context): string {
  const host = c.req.header('host') ?? 'unknown-host';
  const observedProto = c.req.header('x-forwarded-proto');
  return `host "${host}", X-Forwarded-Proto ${observedProto ? `"${observedProto}"` : 'absent'}`;
}

// Keyed off the ACTUAL Secure decision, not just the transport: `Secure` can be
// forced onto an insecure transport (PORTAL_COOKIE_FORCE_SECURE / SameSite=None),
// and that case breaks portal login outright — the warning must say so, not
// claim the cookies are non-Secure. The blind NODE_ENV fallback breadcrumb is
// emitted by the shared isRequestConnectionSecure().
function warnOnPortalCookieTransportMismatch(c: Context, sameSite: SameSiteValue, connectionSecure: boolean, secure: boolean): void {
  if (connectionSecure) {
    return;
  }
  if (secure) {
    // Explicit config forces `Secure` onto a transport the browser will reject
    // it on. Only reachable via deliberate configuration, so warn in every
    // environment — this is the #1618/#2611 symptom by operator choice.
    const cause = sameSite === 'None'
      ? 'PORTAL_COOKIE_SAME_SITE=None requires the Secure attribute'
      : 'PORTAL_COOKIE_FORCE_SECURE is set';
    warnPortalCookieThrottled(
      'forced-secure-over-http',
      `[portal] Issuing \`Secure\` session cookies over a NON-HTTPS request (${describePortalCookieTransport(c)}) because ${cause}. ` +
      'The browser WILL silently discard them and portal login WILL break (issue #2611). Fix TLS so the ' +
      'browser reaches Breeze over https, or remove that configuration.'
    );
    return;
  }
  // Non-Secure cookies over HTTP: login works, but credentials transit
  // unencrypted. Dev-over-http is the normal local flow — only warn when
  // deployed (production).
  if (!isSecureCookieEnvironment()) {
    return;
  }
  warnPortalCookieThrottled(
    'insecure-transport',
    `[portal] Issuing NON-Secure session cookies: this production request arrived over HTTP (${describePortalCookieTransport(c)}). ` +
    'Persistent login will work, but the connection is not encrypted. If Breeze should be served over HTTPS, ' +
    'fix TLS / your reverse proxy so the browser reaches it over https and the proxy forwards ' +
    '`X-Forwarded-Proto: https` (see issue #2611).'
  );
}

export function setPortalSessionCookies(c: Context, sessionToken: string): void {
  const connectionSecure = isRequestConnectionSecure(c);
  const sameSite = resolvePortalCookieSameSite();
  warnOnPortalCookieTransportMismatch(c, sameSite, connectionSecure, shouldSetSecureCookie(sameSite, connectionSecure));
  c.header('Set-Cookie', buildPortalSessionCookie(sessionToken, connectionSecure), { append: true });
  c.header('Set-Cookie', buildPortalCsrfCookie(randomBytes(32).toString('hex'), connectionSecure), { append: true });
}

export function clearPortalSessionCookies(c: Context): void {
  // Derive from the same request so the clearing cookie's attributes match the
  // set cookie's within this transport (a `Secure` clear sent over HTTP would
  // itself be ignored by the browser, stranding the cookie).
  const connectionSecure = isRequestConnectionSecure(c);
  c.header('Set-Cookie', buildClearPortalSessionCookie(connectionSecure), { append: true });
  c.header('Set-Cookie', buildClearPortalCsrfCookie(connectionSecure), { append: true });
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

  for (const [tokenHash, invite] of portalInviteTokens.entries()) {
    if (invite.expiresAt.getTime() <= nowMs) {
      portalInviteTokens.delete(tokenHash);
    }
  }

  capMapByOldest(portalSessions, PORTAL_SESSION_CAP, (session) => session.createdAt.getTime());
  capMapByOldest(portalResetTokens, PORTAL_RESET_TOKEN_CAP, (token) => token.createdAt.getTime());
  capMapByOldest(portalInviteTokens, PORTAL_INVITE_TOKEN_CAP, (token) => token.createdAt.getTime());
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

/**
 * Shared boundary guard for the portal quote/invoice mutation routers.
 * Cookie sessions must prove the double-submit CSRF token, while bearer-token
 * API clients remain exempt. Mutations with a JSON body must also reject form
 * submissions before Hono's JSON validator attempts to parse them.
 */
export const portalFinancialMutationGuard: MiddlewareHandler = async (c, next) => {
  if (c.req.method !== 'POST') {
    await next();
    return;
  }

  const csrfError = validatePortalCookieCsrfRequest(c);
  if (csrfError) {
    return c.json({ error: csrfError }, 403);
  }

  const requiresJsonBody =
    /\/quotes\/[^/]+\/(?:accept|decline)$/.test(c.req.path)
    || /\/invoices\/[^/]+\/settle$/.test(c.req.path);
  if (requiresJsonBody) {
    const contentType = c.req.header('content-type')?.toLowerCase() ?? '';
    if (!contentType.startsWith('application/json')) {
      return c.json({ error: 'Content-Type must be application/json' }, 415);
    }
  }

  await next();
};

function safeCompareTokens(headerToken: string, cookieToken: string): boolean {
  const headerBuffer = Buffer.from(headerToken, 'utf8');
  const cookieBuffer = Buffer.from(cookieToken, 'utf8');
  if (headerBuffer.length !== cookieBuffer.length) {
    return false;
  }
  return timingSafeEqual(headerBuffer, cookieBuffer);
}

// ============================================
// Portal URL + invite tokens
// ============================================

/**
 * Absolute base for portal-hosted pages in outbound emails (reset, invite).
 * The portal is served under /portal on the main domain, so links MUST include
 * that segment — delegated to the shared portalBase() resolver, which appends
 * the portal base path to app-origin fallbacks and rejects malformed values.
 */
export function buildPortalUrl(path: string): string {
  const suffix = path.startsWith('/') ? path : `/${path}`;
  return `${portalBase()}${suffix}`;
}

export async function storePortalInviteToken(portalUserId: string): Promise<string | null> {
  const rawToken = nanoid(48);
  const tokenHash = createHash('sha256').update(rawToken).digest('hex');
  if (PORTAL_USE_REDIS) {
    const redis = getRedis();
    if (!redis) return null; // redis required but unavailable — don't mint an unredeemable token
    await redis.setex(PORTAL_REDIS_KEYS.inviteToken(tokenHash), INVITE_TTL_SECONDS, JSON.stringify({ portalUserId }));
  } else {
    portalInviteTokens.set(tokenHash, { portalUserId, expiresAt: new Date(Date.now() + INVITE_TTL_MS), createdAt: new Date() });
    capMapByOldest(portalInviteTokens, PORTAL_INVITE_TOKEN_CAP, (t) => t.createdAt.getTime());
  }
  return rawToken;
}

export async function consumePortalInviteToken(rawToken: string): Promise<string | null> {
  const tokenHash = createHash('sha256').update(rawToken).digest('hex');
  if (PORTAL_USE_REDIS) {
    const redis = getRedis();
    if (!redis) return null;
    const raw = await redis.get(PORTAL_REDIS_KEYS.inviteToken(tokenHash));
    if (!raw) return null;
    await redis.del(PORTAL_REDIS_KEYS.inviteToken(tokenHash));
    try { return JSON.parse(raw).portalUserId ?? null; } catch { return null; }
  }
  const stored = portalInviteTokens.get(tokenHash);
  portalInviteTokens.delete(tokenHash);
  if (stored && stored.expiresAt.getTime() > Date.now()) return stored.portalUserId;
  return null;
}
