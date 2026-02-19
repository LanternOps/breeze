import type { Context } from 'hono';
import { eq } from 'drizzle-orm';
import * as dbModule from '../../db';
import { users, partnerUsers, organizationUsers, organizations } from '../../db/schema';
import {
  verifyToken,
  isUserTokenRevoked,
  revokeRefreshTokenJti,
  getTrustedClientIp
} from '../../services';
import { createAuditLogAsync } from '../../services/auditService';
import type { RequestLike } from '../../services/auditEvents';
import { createHash } from 'crypto';
import { decryptSecret, encryptSecret } from '../../services/secretCrypto';
import { DEFAULT_ALLOWED_ORIGINS } from '../../services/corsOrigins';
import type { PublicTokenPayload, UserTokenContext } from './schemas';
import {
  REFRESH_COOKIE_NAME,
  REFRESH_COOKIE_PATH,
  REFRESH_COOKIE_MAX_AGE_SECONDS,
  CSRF_HEADER_NAME,
  ANONYMOUS_ACTOR_ID
} from './schemas';

const { db } = dbModule;

export const runWithSystemDbAccess = async <T>(fn: () => Promise<T>): Promise<T> => {
  const withSystem = dbModule.withSystemDbAccessContext;
  return typeof withSystem === 'function' ? withSystem(fn) : fn();
};

// ============================================
// Cookie helpers
// ============================================

export function getClientIP(c: RequestLike): string {
  return getTrustedClientIp(c);
}

export function isSecureCookieEnvironment(): boolean {
  return process.env.NODE_ENV === 'production';
}

export function buildRefreshTokenCookie(refreshToken: string): string {
  const secure = isSecureCookieEnvironment() ? '; Secure' : '';
  return `${REFRESH_COOKIE_NAME}=${encodeURIComponent(refreshToken)}; Path=${REFRESH_COOKIE_PATH}; HttpOnly; SameSite=Lax; Max-Age=${REFRESH_COOKIE_MAX_AGE_SECONDS}${secure}`;
}

export function buildClearRefreshTokenCookie(): string {
  const secure = isSecureCookieEnvironment() ? '; Secure' : '';
  return `${REFRESH_COOKIE_NAME}=; Path=${REFRESH_COOKIE_PATH}; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
}

export function setRefreshTokenCookie(c: Context, refreshToken: string): void {
  c.header('Set-Cookie', buildRefreshTokenCookie(refreshToken), { append: true });
}

export function clearRefreshTokenCookie(c: Context): void {
  c.header('Set-Cookie', buildClearRefreshTokenCookie(), { append: true });
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

  return new Set<string>([...DEFAULT_ALLOWED_ORIGINS, ...configuredOrigins]);
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
  const csrfHeader = c.req.header(CSRF_HEADER_NAME);
  if (!csrfHeader || csrfHeader.trim().length === 0) {
    return 'Missing CSRF header';
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
  return encryptSecret(secret);
}

export function decryptMfaSecret(secret: string | null | undefined): string | null {
  if (!secret) return null;
  try {
    return decryptSecret(secret);
  } catch (error) {
    console.error('[auth] Failed to decrypt MFA secret — user may need to re-enroll MFA:', error);
    return null;
  }
}

export function getRecoveryCodePepper(): string {
  const pepper =
    process.env.MFA_RECOVERY_CODE_PEPPER
    || process.env.APP_ENCRYPTION_KEY
    || process.env.SECRET_ENCRYPTION_KEY
    || process.env.JWT_SECRET
    || (process.env.NODE_ENV === 'test' ? 'test-mfa-recovery-code-pepper' : '');

  if (!pepper && process.env.NODE_ENV === 'production') {
    throw new Error('No MFA recovery code pepper configured. Set MFA_RECOVERY_CODE_PEPPER, APP_ENCRYPTION_KEY, SECRET_ENCRYPTION_KEY, or JWT_SECRET.');
  }

  return pepper;
}

export function hashRecoveryCode(code: string): string {
  const normalizedCode = code.trim().toUpperCase();
  return createHash('sha256')
    .update(`${getRecoveryCodePepper()}:${normalizedCode}`)
    .digest('hex');
}

export function hashRecoveryCodes(codes: string[]): string[] {
  return codes.map(hashRecoveryCode);
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

// ============================================
// User context helpers
// ============================================

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
    orgId: string;
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
  if (!orgId) {
    return;
  }

  writeAuthAudit(c, {
    orgId,
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
  opts: { orgId: string; userId: string; email: string; name: string; mfa: boolean; scope: string; ip: string }
): void {
  createAuditLogAsync({
    orgId: opts.orgId,
    actorId: opts.userId,
    actorEmail: opts.email,
    action: 'user.login',
    resourceType: 'user',
    resourceId: opts.userId,
    resourceName: opts.name,
    details: { method: 'password', mfa: opts.mfa, scope: opts.scope },
    ipAddress: opts.ip,
    userAgent: c.req.header('user-agent'),
    result: 'success'
  });
}
