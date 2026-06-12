import type { Context, Next } from 'hono';
import { eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import * as dbModule from '../db';
import { users } from '../db/schema';
import {
  cfAccessAud,
  cfAccessTeamDomain,
  cfAccessTrustEnabled,
  cfAccessTrustsMfa,
} from '../config/env';
import {
  CfAccessInvalidTokenError,
  CfAccessJwksUnavailableError,
  verifyCfAccessJwt,
} from '../services/cfAccessJwt';
import {
  bindRefreshJtiToFamily,
  createTokenPair,
  mintRefreshTokenFamily,
} from '../services';
import { getRedis } from '../services';
import { createAuditLogAsync } from '../services/auditService';
import { TenantInactiveError } from '../services/tenantStatus';
import { ENABLE_2FA } from '../routes/auth/schemas';
import {
  auditUserLoginFailure,
  getClientIP,
  resolveCurrentUserTokenContext,
  setRefreshTokenCookie,
  toPublicTokens,
  userRequiresSetup,
} from '../routes/auth/helpers';
import { readMobileDeviceId } from '../services/mobileDeviceBinding';

const { db, withSystemDbAccessContext } = dbModule;

const CF_ACCESS_JWT_HEADER = 'cf-access-jwt-assertion';

/**
 * Hono middleware that short-circuits `POST /auth/login` when a valid
 * Cloudflare Access JWT is presented (Discussion #702).
 *
 * Behaviour:
 *   - CF_ACCESS_TRUST_ENABLED unset/false  → next()
 *   - Cf-Access-Jwt-Assertion header absent → next()
 *   - JWT signature / claim invalid        → next() (fail-closed on trust)
 *   - JWKS network blip                    → next() (fail-open on availability)
 *   - User not found by email              → next() (let password handler 401)
 *   - User inactive                        → next() (let password handler 401)
 *   - User has MFA + CF_ACCESS_TRUSTS_MFA=false → issue MFA temp token
 *   - Otherwise                            → mint token pair, set cookie, return
 *
 * Mount BEFORE the zValidator+password handler so the JWT path is tried first
 * but the password path still validates its body when this falls through.
 *
 * See:
 *   - apps/api/src/services/cfAccessJwt.ts (JWKS verifier)
 *   - apps/api/src/routes/auth/login.ts (the handler this falls through to)
 */
export async function cfAccessLoginMiddleware(c: Context, next: Next): Promise<Response | void> {
  if (!cfAccessTrustEnabled()) return next();

  const token = c.req.header(CF_ACCESS_JWT_HEADER);
  if (!token) return next();

  const teamDomain = cfAccessTeamDomain();
  const audience = cfAccessAud();
  if (!teamDomain || !audience) {
    // Trust is enabled but the deployment is misconfigured. Fail-open to
    // the password handler rather than wedge /login for everyone. Surface
    // a single warning so ops sees it.
    console.warn(
      '[cf-access-login] CF_ACCESS_TRUST_ENABLED=true but CF_ACCESS_TEAM_DOMAIN or CF_ACCESS_AUD is empty; ignoring header.'
    );
    return next();
  }

  let claims;
  try {
    claims = await verifyCfAccessJwt(token, { teamDomain, audience });
  } catch (err) {
    if (err instanceof CfAccessInvalidTokenError) {
      // Don't log token contents; just the code. Repeated INVALID is
      // either a stale CF Access session or an attacker probe — either
      // way fall through and let the password handler do its thing.
      console.warn('[cf-access-login] rejected JWT', { code: err.code });
    } else if (err instanceof CfAccessJwksUnavailableError) {
      console.error('[cf-access-login] JWKS unavailable, falling through to password', err);
    } else {
      console.error('[cf-access-login] unexpected verify error', err);
    }
    return next();
  }

  const normalizedEmail = claims.email.toLowerCase();

  const [user] = await withSystemDbAccessContext(async () =>
    db.select().from(users).where(eq(users.email, normalizedEmail)).limit(1)
  );

  if (!user) {
    // No matching Breeze user. Fall through; password handler will 401
    // generically. We don't want to leak "no such email" via this path
    // either.
    return next();
  }

  if (user.status !== 'active') {
    void auditUserLoginFailure(c, {
      userId: user.id,
      email: user.email,
      name: user.name,
      reason: 'account_inactive',
      result: 'denied',
      details: { accountStatus: user.status, method: 'cf_access_jwt' },
    });
    return next();
  }

  let context;
  try {
    context = await resolveCurrentUserTokenContext(user.id);
  } catch (err) {
    if (!(err instanceof TenantInactiveError)) throw err;
    void auditUserLoginFailure(c, {
      userId: user.id,
      email: user.email,
      name: user.name,
      reason: 'tenant_inactive',
      result: 'denied',
      details: { method: 'cf_access_jwt' },
    });
    return next();
  }

  // CF Access JWT cannot tell us whether the user satisfied MFA at the
  // edge — that's an operator-level assertion via CF_ACCESS_TRUSTS_MFA.
  // If the user has Breeze MFA enrolled and we don't trust CF Access as
  // MFA, issue a temp token and require the user to complete TOTP, same
  // shape the password handler uses.
  const trustsMfa = cfAccessTrustsMfa();
  if (ENABLE_2FA && user.mfaEnabled && (user.mfaSecret || user.mfaMethod === 'sms' || user.mfaMethod === 'passkey') && !trustsMfa) {
    const redis = getRedis();
    if (!redis) {
      console.error('[cf-access-login] redis unavailable; cannot issue MFA temp token, falling through');
      return next();
    }
    const tempToken = nanoid(32);
    const mfaMethod = user.mfaMethod || 'totp';
    await redis.setex(
      `mfa:pending:${tempToken}`,
      300,
      JSON.stringify({ userId: user.id, mfaMethod })
    );
    return c.json({
      mfaRequired: true,
      tempToken,
      mfaMethod,
      phoneLast4: user.phoneNumber?.slice(-4) || null,
      user: null,
      tokens: null,
    });
  }

  const mfaSatisfied = trustsMfa || !(ENABLE_2FA && user.mfaEnabled);

  // Mint a fresh refresh-token family for this login so the rotation chain
  // participates in OAuth 2.1 reuse-detection — same invariant as every
  // other authenticated mint path (see services/refreshTokenFamily.ts and
  // the /login handler this middleware short-circuits).
  const familyId = await mintRefreshTokenFamily(user.id);

  const tokens = await createTokenPair(
    {
      sub: user.id,
      email: user.email,
      roleId: context.roleId,
      orgId: context.orgId,
      partnerId: context.partnerId,
      scope: context.scope,
      mfa: mfaSatisfied,
      mdid: readMobileDeviceId(c) ?? undefined,
    },
    { refreshFam: familyId }
  );

  await bindRefreshJtiToFamily(tokens.refreshJti, familyId);

  await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, user.id));

  createAuditLogAsync({
    orgId: context.orgId ?? undefined,
    actorId: user.id,
    actorEmail: user.email,
    action: 'user.login',
    resourceType: 'user',
    resourceId: user.id,
    resourceName: user.name,
    details: {
      method: 'cf_access_jwt',
      mfa: mfaSatisfied,
      scope: context.scope,
      cfAccessSub: claims.sub,
    },
    ipAddress: getClientIP(c),
    userAgent: c.req.header('user-agent'),
    result: 'success',
  });

  setRefreshTokenCookie(c, tokens.refreshToken);

  return c.json({
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      mfaEnabled: ENABLE_2FA ? user.mfaEnabled : false,
      avatarUrl: user.avatarUrl,
    },
    tokens: toPublicTokens(tokens),
    mfaRequired: false,
    requiresSetup: userRequiresSetup(user),
  });
}
