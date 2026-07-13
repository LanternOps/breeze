import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { and, eq, isNull } from 'drizzle-orm';
import * as dbModule from '../../db';
import { users, partnerUsers, organizationUsers, organizations, userPasskeys } from '../../db/schema';
import {
  verifyToken,
  isUserTokenRevoked,
  revokeRefreshTokenJti,
  getTrustedClientIp,
  getRedis,
  rateLimiter,
  verifyPassword
} from '../../services';
import { createAuditLogAsync } from '../../services/auditService';
import { recordFailedLogin } from '../../services/anomalyMetrics';
import { consumeMFAToken } from '../../services/mfa';
import type { RequestLike } from '../../services/auditEvents';
import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import {
  decryptMfaTotpSecret,
  decryptMfaTotpSecretForMigration,
  encryptMfaTotpSecret,
  type MfaSecretDecryptionResult
} from '../../services/mfaSecretCrypto';
import { DEFAULT_ALLOWED_ORIGINS, shouldIncludeDefaultOrigins } from '../../services/corsOrigins';
import { assertActiveTenantContext } from '../../services/tenantStatus';
import {
  getRecoveryCodePepper as recoveryCodePepper,
  hashRecoveryCode as hashSingleRecoveryCode,
  hashRecoveryCodes as hashAllRecoveryCodes,
} from '../../services/recoveryCodeAuth';
import type { PublicTokenPayload, UserTokenContext } from './schemas';
import {
  REFRESH_COOKIE_NAME,
  REFRESH_COOKIE_PATH,
  REFRESH_COOKIE_MAX_AGE_SECONDS,
  CSRF_HEADER_NAME,
  CSRF_COOKIE_NAME,
  CSRF_COOKIE_PATH,
  ANONYMOUS_ACTOR_ID
} from './schemas';

const { db } = dbModule;

export const runWithSystemDbAccess = async <T>(fn: () => Promise<T>): Promise<T> => {
  const withSystem = dbModule.withSystemDbAccessContext;
  return typeof withSystem === 'function' ? withSystem(fn) : fn();
};

/**
 * #2153: does the account have at least one usable (non-disabled) passkey?
 *
 * Both callers (the password /login handler and the CF-Access login
 * middleware) use this to advertise a passkey as an ALTERNATE second factor
 * even when the account's primary `mfaMethod` is totp/sms — registering a
 * passkey intentionally does not clobber an existing totp/sms method
 * (passkeys.ts), so login must detect the passkey independently.
 *
 * Runs under system DB access because both callers are PRE-AUTH (no request
 * RLS context): an org-scoped read under `breeze_app` would return 0 rows and
 * silently hide the option.
 *
 * NEVER throws. This is an optional affordance layered on top of the essential
 * login flow — a transient DB error here must not 500 a correctly-authenticated
 * user out of login, so a probe failure fails closed (returns false: the
 * primary factor's prompt is still shown, the passkey alternate is just hidden).
 */
export async function userHasUsablePasskey(userId: string): Promise<boolean> {
  try {
    const rows = await runWithSystemDbAccess(() =>
      db
        .select({ id: userPasskeys.id })
        .from(userPasskeys)
        .where(and(eq(userPasskeys.userId, userId), isNull(userPasskeys.disabledAt)))
        .limit(1)
    );
    return rows.length > 0;
  } catch (err) {
    console.error('[auth] passkey-availability probe failed; hiding passkey alternate:', err);
    return false;
  }
}

// ============================================
// Cookie helpers
// ============================================

export function getClientIP(c: RequestLike): string {
  return getTrustedClientIp(c);
}

export function getClientRateLimitKey(c: RequestLike): string {
  const trustedIp = getClientIP(c);
  if (trustedIp && trustedIp !== 'unknown') {
    return `ip:${trustedIp}`;
  }

  const read = (name: string) => c.req.header(name) ?? c.req.header(name.toLowerCase()) ?? '';
  const fingerprintSource = [
    read('user-agent'),
    read('accept-language'),
    read('origin'),
    read('x-forwarded-for'),
    read('x-real-ip'),
    read('cf-connecting-ip')
  ].join('|');

  const digest = createHash('sha256')
    .update(fingerprintSource || 'no-client-fingerprint')
    .digest('hex')
    .slice(0, 24);

  return `fp:${digest}`;
}

export async function requireCurrentPasswordStepUp(
  c: Context,
  userId: string,
  currentPassword: string,
  keyPrefix = 'auth:pwd-stepup'
): Promise<Response | null> {
  const redis = getRedis();
  if (!redis) {
    return c.json({ error: 'Service temporarily unavailable' }, 503);
  }

  const rateCheck = await rateLimiter(redis, `${keyPrefix}:${userId}`, 5, 5 * 60);
  if (!rateCheck.allowed) {
    return c.json({
      error: 'Too many attempts. Please try again later.',
      retryAfter: Math.ceil((rateCheck.resetAt.getTime() - Date.now()) / 1000)
    }, 429);
  }

  const [user] = await db
    .select({ passwordHash: users.passwordHash })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  if (!user?.passwordHash) {
    return c.json({ error: 'Invalid credentials' }, 401);
  }

  const valid = await verifyPassword(user.passwordHash, currentPassword);
  if (!valid) {
    return c.json({ error: 'Invalid credentials' }, 401);
  }

  return null;
}

export const MFA_STEP_UP_GRANT_TTL_SECONDS = 5 * 60;

export type MfaStepUpPurpose =
  | 'passkey.register'
  | 'totp.replace'
  | 'sms.replace'
  | 'email.change';

export type MfaStepUpVerifiedMethod = 'totp' | 'sms' | 'passkey';

export interface MfaStepUpGrantBinding {
  purpose: MfaStepUpPurpose;
  userId: string;
  sessionId: string;
  authEpoch: number;
  mfaEpoch: number;
  verifiedMethod: MfaStepUpVerifiedMethod;
}

export interface MfaStepUpGrantRecord extends MfaStepUpGrantBinding {
  version: 1;
  issuedAt: string;
  expiresAt: string;
}

export type MfaStepUpGrantExpectedBinding = Omit<MfaStepUpGrantBinding, 'verifiedMethod'> & {
  verifiedMethod?: MfaStepUpVerifiedMethod;
};

export class MfaStepUpGrantInvalidError extends Error {
  constructor() {
    super('MFA step-up grant is invalid or expired');
    this.name = 'MfaStepUpGrantInvalidError';
  }
}

export class MfaStepUpGrantUnavailableError extends Error {
  constructor() {
    super('MFA step-up authorization is unavailable');
    this.name = 'MfaStepUpGrantUnavailableError';
  }
}

const MFA_STEP_UP_PURPOSES = new Set<MfaStepUpPurpose>([
  'passkey.register',
  'totp.replace',
  'sms.replace',
  'email.change',
]);
const MFA_STEP_UP_METHODS = new Set<MfaStepUpVerifiedMethod>(['totp', 'sms', 'passkey']);
const MFA_STEP_UP_RECORD_KEYS = [
  'authEpoch',
  'expiresAt',
  'issuedAt',
  'mfaEpoch',
  'purpose',
  'sessionId',
  'userId',
  'verifiedMethod',
  'version',
] as const;

export function hashMfaStepUpGrant(rawGrant: string): string {
  return createHash('sha256').update(rawGrant).digest('hex');
}

function mfaStepUpGrantKey(rawGrant: string): string {
  return `auth:mfa-step-up-grant:${hashMfaStepUpGrant(rawGrant)}`;
}

function parseMfaStepUpGrantRecord(raw: string | null): MfaStepUpGrantRecord {
  if (!raw) throw new MfaStepUpGrantInvalidError();
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new MfaStepUpGrantInvalidError();
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new MfaStepUpGrantInvalidError();
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.length !== MFA_STEP_UP_RECORD_KEYS.length
    || !keys.every((key, index) => key === MFA_STEP_UP_RECORD_KEYS[index])) {
    throw new MfaStepUpGrantInvalidError();
  }
  if (record.version !== 1
    || typeof record.userId !== 'string' || record.userId.length === 0
    || typeof record.sessionId !== 'string' || record.sessionId.length === 0
    || typeof record.purpose !== 'string' || !MFA_STEP_UP_PURPOSES.has(record.purpose as MfaStepUpPurpose)
    || typeof record.verifiedMethod !== 'string'
    || !MFA_STEP_UP_METHODS.has(record.verifiedMethod as MfaStepUpVerifiedMethod)
    || !Number.isSafeInteger(record.authEpoch) || (record.authEpoch as number) < 1
    || !Number.isSafeInteger(record.mfaEpoch) || (record.mfaEpoch as number) < 1
    || typeof record.issuedAt !== 'string'
    || typeof record.expiresAt !== 'string') {
    throw new MfaStepUpGrantInvalidError();
  }
  const issuedAt = Date.parse(record.issuedAt);
  const expiresAt = Date.parse(record.expiresAt);
  if (!Number.isFinite(issuedAt)
    || !Number.isFinite(expiresAt)
    || new Date(issuedAt).toISOString() !== record.issuedAt
    || new Date(expiresAt).toISOString() !== record.expiresAt
    || expiresAt - issuedAt !== MFA_STEP_UP_GRANT_TTL_SECONDS * 1_000
    || issuedAt > Date.now()
    || expiresAt <= Date.now()) {
    throw new MfaStepUpGrantInvalidError();
  }
  return record as unknown as MfaStepUpGrantRecord;
}

function mfaStepUpGrantMatches(
  record: MfaStepUpGrantRecord,
  expected: MfaStepUpGrantExpectedBinding,
): boolean {
  return record.purpose === expected.purpose
    && record.userId === expected.userId
    && record.sessionId === expected.sessionId
    && record.authEpoch === expected.authEpoch
    && record.mfaEpoch === expected.mfaEpoch
    && (expected.verifiedMethod === undefined || record.verifiedMethod === expected.verifiedMethod);
}

function assertMatchingMfaStepUpGrant(
  raw: string | null,
  expected: MfaStepUpGrantExpectedBinding,
): MfaStepUpGrantRecord {
  const record = parseMfaStepUpGrantRecord(raw);
  if (!mfaStepUpGrantMatches(record, expected)) throw new MfaStepUpGrantInvalidError();
  return record;
}

/** Store only a SHA-256 reference; the opaque 256-bit bearer value is returned once. */
export async function issueMfaStepUpGrant(input: MfaStepUpGrantBinding): Promise<string> {
  const redis = getRedis();
  if (!redis) throw new MfaStepUpGrantUnavailableError();
  const rawGrant = randomBytes(32).toString('base64url');
  const issuedAt = new Date();
  const record: MfaStepUpGrantRecord = {
    version: 1,
    ...input,
    issuedAt: issuedAt.toISOString(),
    expiresAt: new Date(issuedAt.getTime() + MFA_STEP_UP_GRANT_TTL_SECONDS * 1_000).toISOString(),
  };
  try {
    await redis.setex(
      mfaStepUpGrantKey(rawGrant),
      MFA_STEP_UP_GRANT_TTL_SECONDS,
      JSON.stringify(record),
    );
  } catch {
    throw new MfaStepUpGrantUnavailableError();
  }
  return rawGrant;
}

/** Validate a grant for options/challenge binding without consuming it. */
export async function readMfaStepUpGrant(
  rawGrant: string,
  expected: MfaStepUpGrantExpectedBinding,
): Promise<MfaStepUpGrantRecord> {
  const redis = getRedis();
  if (!redis) throw new MfaStepUpGrantUnavailableError();
  try {
    return assertMatchingMfaStepUpGrant(await redis.get(mfaStepUpGrantKey(rawGrant)), expected);
  } catch (error) {
    if (error instanceof MfaStepUpGrantInvalidError) throw error;
    throw new MfaStepUpGrantUnavailableError();
  }
}

/** Re-check, then atomically burn and compare the exact record before mutation. */
export async function consumeMfaStepUpGrant(
  rawGrant: string,
  expected: MfaStepUpGrantBinding,
): Promise<MfaStepUpGrantRecord> {
  const previouslyRead = await readMfaStepUpGrant(rawGrant, expected);
  const redis = getRedis();
  if (!redis) throw new MfaStepUpGrantUnavailableError();
  let consumed: MfaStepUpGrantRecord;
  try {
    consumed = assertMatchingMfaStepUpGrant(
      await redis.getdel(mfaStepUpGrantKey(rawGrant)),
      expected,
    );
  } catch (error) {
    if (error instanceof MfaStepUpGrantInvalidError) throw error;
    throw new MfaStepUpGrantUnavailableError();
  }
  if (JSON.stringify(consumed) !== JSON.stringify(previouslyRead)) {
    throw new MfaStepUpGrantInvalidError();
  }
  return consumed;
}

/**
 * L4 (critical) re-auth fallback for SSO-only / passwordless accounts that have
 * no password to satisfy {@link requireCurrentPasswordStepUp}. Verifies a fresh
 * TOTP code against the user's enrolled MFA secret. Mirrors the password
 * step-up's shape (rate limit → lookup → verify) and returns the same opaque
 * 401/429/503 responses so callers can `if (err) return err` uniformly. Only
 * TOTP step-up is supported here; SMS/passkey L4 re-auth is out of scope.
 */
export async function requireFreshMfaStepUp(
  c: Context,
  userId: string,
  code: string,
  keyPrefix = 'auth:mfa-stepup',
): Promise<Response | null> {
  const redis = getRedis();
  if (!redis) {
    return c.json({ error: 'Service temporarily unavailable' }, 503);
  }

  const rateCheck = await rateLimiter(redis, `${keyPrefix}:${userId}`, 5, 5 * 60);
  if (!rateCheck.allowed) {
    return c.json({
      error: 'Too many attempts. Please try again later.',
      retryAfter: Math.ceil((rateCheck.resetAt.getTime() - Date.now()) / 1000)
    }, 429);
  }

  const [user] = await db
    .select({ mfaEnabled: users.mfaEnabled, mfaSecret: users.mfaSecret, mfaMethod: users.mfaMethod })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  // Only TOTP step-up is supported here; SMS/passkey L4 re-auth is out of scope.
  // Allowlist on the method (not a denylist) so any non-TOTP/unset method is
  // rejected even if a stale secret lingers — defense-in-depth for the auth path.
  if (!user?.mfaEnabled || user.mfaMethod !== 'totp' || !user.mfaSecret) {
    return c.json({ error: 'Invalid credentials' }, 401);
  }

  const secret = decryptMfaTotpSecret(user.mfaSecret);
  if (!secret) {
    return c.json({ error: 'Invalid credentials' }, 401);
  }

  // consumeMFAToken (not verifyMFAToken): enforce single-use of the TOTP step
  // so a sniffed live code cannot re-authorize multiple critical actions within
  // its validity window. This L4 path had no other single-use binding. (sec review #2)
  const valid = await consumeMFAToken(secret, code, userId);
  if (!valid) {
    return c.json({ error: 'Invalid credentials' }, 401);
  }

  return null;
}

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

function resolveAuthCookieSameSite(): SameSiteValue {
  return normalizeSameSite(process.env.AUTH_COOKIE_SAME_SITE ?? process.env.COOKIE_SAME_SITE);
}

function shouldSetSecureCookie(sameSite: SameSiteValue): boolean {
  if (sameSite === 'None') {
    // Browsers require Secure when SameSite=None.
    return true;
  }
  const forceSecure = (process.env.AUTH_COOKIE_FORCE_SECURE ?? process.env.COOKIE_FORCE_SECURE)?.trim().toLowerCase();
  if (forceSecure === '1' || forceSecure === 'true') {
    return true;
  }
  return isSecureCookieEnvironment();
}

function buildCookieSecuritySuffix(sameSite: SameSiteValue): string {
  const secure = shouldSetSecureCookie(sameSite) ? '; Secure' : '';
  return `; SameSite=${sameSite}${secure}`;
}

export function buildRefreshTokenCookie(refreshToken: string): string {
  const sameSite = resolveAuthCookieSameSite();
  return `${REFRESH_COOKIE_NAME}=${encodeURIComponent(refreshToken)}; Path=${REFRESH_COOKIE_PATH}; HttpOnly${buildCookieSecuritySuffix(sameSite)}; Max-Age=${REFRESH_COOKIE_MAX_AGE_SECONDS}`;
}

export function buildCsrfTokenCookie(csrfToken: string): string {
  const sameSite = resolveAuthCookieSameSite();
  return `${CSRF_COOKIE_NAME}=${encodeURIComponent(csrfToken)}; Path=${CSRF_COOKIE_PATH}${buildCookieSecuritySuffix(sameSite)}; Max-Age=${REFRESH_COOKIE_MAX_AGE_SECONDS}`;
}

export function buildClearRefreshTokenCookie(): string {
  const sameSite = resolveAuthCookieSameSite();
  return `${REFRESH_COOKIE_NAME}=; Path=${REFRESH_COOKIE_PATH}; HttpOnly${buildCookieSecuritySuffix(sameSite)}; Max-Age=0`;
}

export function buildClearCsrfTokenCookie(): string {
  const sameSite = resolveAuthCookieSameSite();
  return `${CSRF_COOKIE_NAME}=; Path=${CSRF_COOKIE_PATH}${buildCookieSecuritySuffix(sameSite)}; Max-Age=0`;
}

export const CF_ACCESS_LOGOUT_QUARANTINE_COOKIE_NAME = 'breeze_cf_logout_quarantine';
const CF_ACCESS_LOGOUT_QUARANTINE_MAX_AGE_SECONDS = 10 * 60;
const CF_ACCESS_LOGOUT_QUARANTINE_COOKIE_PATH = '/api/v1';

export function hasCfAccessLogoutQuarantine(c: Context): boolean {
  return getCookieValue(c.req.header('Cookie'), CF_ACCESS_LOGOUT_QUARANTINE_COOKIE_NAME) === '1';
}

export function setCfAccessLogoutQuarantineCookie(c: Context): void {
  const sameSite = resolveAuthCookieSameSite();
  c.header(
    'Set-Cookie',
    `${CF_ACCESS_LOGOUT_QUARANTINE_COOKIE_NAME}=1; Path=${CF_ACCESS_LOGOUT_QUARANTINE_COOKIE_PATH}; HttpOnly${buildCookieSecuritySuffix(sameSite)}; Max-Age=${CF_ACCESS_LOGOUT_QUARANTINE_MAX_AGE_SECONDS}`,
    { append: true },
  );
}

export function clearCfAccessLogoutQuarantineCookie(c: Context): void {
  const sameSite = resolveAuthCookieSameSite();
  c.header(
    'Set-Cookie',
    `${CF_ACCESS_LOGOUT_QUARANTINE_COOKIE_NAME}=; Path=${CF_ACCESS_LOGOUT_QUARANTINE_COOKIE_PATH}; HttpOnly${buildCookieSecuritySuffix(sameSite)}; Max-Age=0`,
    { append: true },
  );
}

export function setRefreshTokenCookie(c: Context, refreshToken: string): void {
  if (hasCfAccessLogoutQuarantine(c)) {
    throw new HTTPException(409, { message: 'Terminal logout is still in progress' });
  }
  const csrfToken = randomBytes(32).toString('hex');
  c.header('Set-Cookie', buildRefreshTokenCookie(refreshToken), { append: true });
  c.header('Set-Cookie', buildCsrfTokenCookie(csrfToken), { append: true });
}

export function clearRefreshTokenCookie(c: Context): void {
  c.header('Set-Cookie', buildClearRefreshTokenCookie(), { append: true });
  c.header('Set-Cookie', buildClearCsrfTokenCookie(), { append: true });
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

export function resolveRefreshToken(c: Context): string | null {
  return getCookieValue(c.req.header('cookie'), REFRESH_COOKIE_NAME);
}

// ============================================
// CORS / CSRF helpers
// ============================================

export function getAllowedOrigins(): Set<string> {
  const configuredOrigins = (process.env.CORS_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);

  // Gate dev-only origins on environment, mirroring corsOrigins.ts.
  // In production, do NOT merge localhost defaults unless
  // CORS_INCLUDE_DEFAULT_ORIGINS=true is explicitly set.
  const nodeEnv = process.env.NODE_ENV ?? 'development';
  const includeDefaults = shouldIncludeDefaultOrigins(nodeEnv);
  const defaults = includeDefaults ? DEFAULT_ALLOWED_ORIGINS : [];

  return new Set<string>([...defaults, ...configuredOrigins]);
}

export function isAllowedOrigin(origin: string): boolean {
  const allowList = getAllowedOrigins();
  if (allowList.has(origin)) {
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

export function validateCookieCsrfRequest(c: Context): string | null {
  const csrfHeader = c.req.header(CSRF_HEADER_NAME)?.trim();
  if (!csrfHeader || csrfHeader.length === 0) {
    return 'Missing CSRF header';
  }

  const csrfCookie = getCookieValue(c.req.header('cookie'), CSRF_COOKIE_NAME);
  if (!csrfCookie) {
    // Backward compatibility for non-browser clients that do not expose cookie APIs.
    // Browsers are still protected by Origin/Sec-Fetch-Site checks below.
    const hasOrigin = Boolean(c.req.header('origin'));
    const fetchSite = c.req.header('sec-fetch-site');
    const isBrowserSignal = hasOrigin || Boolean(fetchSite);
    if (csrfHeader === '1' && !isBrowserSignal) {
      return null;
    }
    return 'Missing CSRF cookie';
  }
  if (!safeCompareTokens(csrfHeader, csrfCookie)) {
    return 'Invalid CSRF token';
  }

  const origin = c.req.header('origin');
  if (origin && !isAllowedOrigin(origin)) {
    return 'Invalid request origin';
  }

  // Defense-in-depth: block cross-site requests when the browser provides Sec-Fetch-Site
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

// ============================================
// Token helpers
// ============================================

export function toPublicTokens(tokens: { accessToken: string; expiresInSeconds: number }): PublicTokenPayload {
  return {
    accessToken: tokens.accessToken,
    expiresInSeconds: tokens.expiresInSeconds
  };
}

// ============================================
// MFA crypto helpers
// ============================================

export function encryptMfaSecret(secret: string | null | undefined): string | null {
  return encryptMfaTotpSecret(secret);
}

export function decryptMfaSecret(secret: string | null | undefined): string | null {
  if (!secret) return null;
  try {
    return decryptMfaTotpSecret(secret);
  } catch (error) {
    console.error('[auth] Failed to decrypt MFA secret — user may need to re-enroll MFA:', error);
    return null;
  }
}

export function decryptMfaSecretForMigration(secret: string | null | undefined): MfaSecretDecryptionResult {
  if (!secret) return { plaintext: null, migratedSecret: null };
  try {
    return decryptMfaTotpSecretForMigration(secret);
  } catch (error) {
    console.error('[auth] Failed to decrypt MFA secret — user may need to re-enroll MFA:', error);
    return { plaintext: null, migratedSecret: null };
  }
}

export function getRecoveryCodePepper(): string {
  return recoveryCodePepper();
}

export function hashRecoveryCode(code: string): string {
  return hashSingleRecoveryCode(code);
}

export function hashRecoveryCodes(codes: string[]): string[] {
  return hashAllRecoveryCodes(codes);
}

// ============================================
// Invite token helpers
// ============================================

export function hashInviteToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function inviteRedisKey(tokenHash: string): string {
  return `invite:${tokenHash}`;
}

export function inviteUserRedisKey(userId: string): string {
  return `invite-user:${userId}`;
}

// ============================================
// Error response helpers
// ============================================

export function genericAuthError() {
  return { error: 'Invalid email or password' };
}

export function registrationDisabledResponse(c: Context): Response {
  return c.json({ error: 'Not Found' }, 404);
}

export function mfaDisabledResponse(c: Context): Response {
  return c.json({ error: 'Not Found' }, 404);
}

// ============================================
// Token/session helpers
// ============================================

export async function isTokenRevokedForUser(userId: string, tokenIssuedAt?: number): Promise<boolean> {
  return isUserTokenRevoked(userId, tokenIssuedAt);
}

export async function revokeCurrentRefreshTokenJti(c: Context, expectedUserId?: string): Promise<void> {
  const refreshToken = resolveRefreshToken(c);
  if (!refreshToken) {
    return;
  }

  const payload = await verifyToken(refreshToken);
  if (!payload || payload.type !== 'refresh' || !payload.jti) {
    return;
  }

  if (expectedUserId && payload.sub !== expectedUserId) {
    return;
  }

  await revokeRefreshTokenJti(payload.jti);
}

/**
 * Cache the durable refresh-family revocation for hot-path checks.
 *
 * PostgreSQL is the source of truth. Callers must invoke this only after the
 * family revocation transaction commits. Unlike the older combined
 * `revokeFamily` service, this cache-only helper deliberately propagates Redis
 * failures so committed mutations can report partial cleanup truthfully.
 */
export async function cacheRefreshTokenFamilyRevocation(familyId: string): Promise<void> {
  const redis = getRedis();
  if (!redis) {
    throw new Error('Redis unavailable while caching refresh family revocation');
  }

  // Keep the sentinel alive for the refresh-cookie lifetime plus one access
  // token lifetime, matching tokenRevocation.ts's durable-family cache window.
  await redis.setex(
    `refresh-fam-revoked:${familyId}`,
    REFRESH_COOKIE_MAX_AGE_SECONDS + (15 * 60),
    '1',
  );
}

// ============================================
// User context helpers
// ============================================

/**
 * Thrown by resolveCurrentUserTokenContext when a user has no partner or org
 * membership and is NOT a platform admin. Such a principal must never be issued
 * a token (it would otherwise default to scope:'system', which short-circuits
 * RLS to full cross-tenant access). Login entry points map this to a generic
 * 401. (security review #2)
 */
export class NoTenantMembershipError extends Error {
  constructor(userId: string) {
    super(`User ${userId} has no tenant membership and is not a platform admin`);
    this.name = 'NoTenantMembershipError';
  }
}

export async function resolveCurrentUserTokenContext(userId: string): Promise<UserTokenContext> {
  return runWithSystemDbAccess(async () => {
    let roleId: string | null = null;
    let partnerId: string | null = null;
    let orgId: string | null = null;
    let scope: 'system' | 'partner' | 'organization' = 'system';

    let partnerUsersTable:
      | { partnerId?: unknown; roleId?: unknown; userId?: unknown }
      | undefined;
    try {
      partnerUsersTable = partnerUsers as unknown as { partnerId?: unknown; roleId?: unknown; userId?: unknown } | undefined;
    } catch {
      partnerUsersTable = undefined;
    }

    if (partnerUsersTable?.partnerId && partnerUsersTable?.roleId && partnerUsersTable?.userId) {
      const [partnerAssoc] = await db
        .select({
          partnerId: partnerUsers.partnerId,
          roleId: partnerUsers.roleId
        })
        .from(partnerUsers)
        .where(eq(partnerUsers.userId, userId))
        .limit(1);

      if (partnerAssoc?.partnerId && partnerAssoc?.roleId) {
        await assertActiveTenantContext({
          scope: 'partner',
          partnerId: partnerAssoc.partnerId,
          orgId: null
        });
        return {
          roleId: partnerAssoc.roleId,
          partnerId: partnerAssoc.partnerId,
          orgId: null,
          scope: 'partner'
        };
      }
    }

    let organizationUsersTable:
      | { orgId?: unknown; roleId?: unknown; userId?: unknown }
      | undefined;
    try {
      organizationUsersTable = organizationUsers as unknown as { orgId?: unknown; roleId?: unknown; userId?: unknown } | undefined;
    } catch {
      organizationUsersTable = undefined;
    }

    if (organizationUsersTable?.orgId && organizationUsersTable?.roleId && organizationUsersTable?.userId) {
      const [orgAssoc] = await db
        .select({
          orgId: organizationUsers.orgId,
          roleId: organizationUsers.roleId
        })
        .from(organizationUsers)
        .where(eq(organizationUsers.userId, userId))
        .limit(1);

      if (orgAssoc?.orgId && orgAssoc?.roleId) {
        orgId = orgAssoc.orgId;
        roleId = orgAssoc.roleId;
        scope = 'organization';

        const [org] = await db
          .select({ partnerId: organizations.partnerId })
          .from(organizations)
          .where(eq(organizations.id, orgAssoc.orgId))
          .limit(1);

        partnerId = org?.partnerId ?? null;
        await assertActiveTenantContext({
          scope: 'organization',
          partnerId,
          orgId
        });
      }
    }

    // No partner or org membership resolved. The ONLY legitimate membership-less
    // system-scope principal is a platform admin; every other such user is an
    // orphaned / partially-provisioned account (e.g. the #1367 class). Handing
    // them the default scope:'system' grants full cross-tenant access because
    // the RLS helpers (breeze_has_org_access/_partner_access) short-circuit TRUE
    // for system scope. Fail closed unless the user is a platform admin.
    // (security review #2)
    if (scope === 'system') {
      const [u] = await db
        .select({ isPlatformAdmin: users.isPlatformAdmin })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);
      if (u?.isPlatformAdmin !== true) {
        throw new NoTenantMembershipError(userId);
      }
    }

    return { roleId, partnerId, orgId, scope };
  });
}

export async function resolveUserAuditOrgId(userId: string): Promise<string | null> {
  return runWithSystemDbAccess(async () => {
    try {
      const orgUsersTable = organizationUsers as unknown as { orgId?: unknown; userId?: unknown } | undefined;
      if (!orgUsersTable?.orgId || !orgUsersTable?.userId) {
        return null;
      }

      const [orgAssoc] = await db
        .select({ orgId: organizationUsers.orgId })
        .from(organizationUsers)
        .where(eq(organizationUsers.userId, userId))
        .limit(1);

      return orgAssoc?.orgId ?? null;
    } catch (err) {
      console.error('[audit] Failed to resolve orgId for user:', userId, err);
      return null;
    }
  });
}

// ============================================
// Audit helpers
// ============================================

export function writeAuthAudit(
  c: RequestLike,
  opts: {
    orgId?: string;
    action: string;
    result: 'success' | 'failure' | 'denied';
    reason?: string;
    userId?: string;
    email?: string;
    name?: string;
    details?: Record<string, unknown>;
  }
): void {
  createAuditLogAsync({
    orgId: opts.orgId,
    actorType: opts.userId ? 'user' : 'system',
    actorId: opts.userId ?? ANONYMOUS_ACTOR_ID,
    actorEmail: opts.email,
    action: opts.action,
    resourceType: 'user',
    resourceId: opts.userId,
    resourceName: opts.name,
    details: {
      ...opts.details,
      reason: opts.reason
    },
    ipAddress: getClientIP(c),
    userAgent: c.req.header('user-agent'),
    result: opts.result
  });
}

export async function auditUserLoginFailure(
  c: RequestLike,
  opts: {
    userId: string;
    email?: string;
    name?: string;
    reason: string;
    result?: 'failure' | 'denied';
    details?: Record<string, unknown>;
  }
): Promise<void> {
  const orgId = await resolveUserAuditOrgId(opts.userId);

  recordFailedLogin(opts.reason, orgId);

  writeAuthAudit(c, {
    orgId: orgId ?? undefined,
    action: 'user.login.failed',
    result: opts.result ?? 'failure',
    reason: opts.reason,
    userId: opts.userId,
    email: opts.email,
    name: opts.name,
    details: opts.details
  });
}

export function auditLogin(
  c: RequestLike,
  opts: { orgId: string | null; userId: string; email: string; name: string; mfa: boolean; scope: string; ip: string; method?: string; remainingRecoveryCodes?: number }
): void {
  createAuditLogAsync({
    orgId: opts.orgId ?? undefined,
    actorId: opts.userId,
    actorEmail: opts.email,
    action: 'user.login',
    resourceType: 'user',
    resourceId: opts.userId,
    resourceName: opts.name,
    details: {
      method: opts.method ?? 'password',
      mfa: opts.mfa,
      scope: opts.scope,
      ...(opts.remainingRecoveryCodes === undefined
        ? {}
        : { remainingRecoveryCodes: opts.remainingRecoveryCodes }),
    },
    ipAddress: opts.ip,
    userAgent: c.req.header('user-agent'),
    result: 'success'
  });
}

/**
 * Check if a user requires the first-login setup wizard.
 * Triggers for the bootstrap admin on first login (before they complete setup).
 * New partner registrations get their org/site created at registration time
 * and have setupCompletedAt set, so they skip the wizard.
 */
export function userRequiresSetup(user: {
  setupCompletedAt: Date | string | null;
  email: string;
  preferences?: unknown;
}): boolean {
  if (user.setupCompletedAt) return false;

  if (user.email === 'admin@breeze.local') return true;

  if (
    user.preferences &&
    typeof user.preferences === 'object' &&
    !Array.isArray(user.preferences) &&
    (user.preferences as { bootstrapSetupRequired?: unknown }).bootstrapSetupRequired === true
  ) {
    return true;
  }

  return false;
}
