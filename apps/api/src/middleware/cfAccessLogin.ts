import type { Context, Next } from 'hono';
import { eq } from 'drizzle-orm';
import * as dbModule from '../db';
import { users } from '../db/schema';
import {
  cfAccessAud,
  cfAccessTeamDomain,
  cfAccessTrustEnabled,
  cfAccessTrustsMfa,
  isValidCfAccessTeamDomain,
} from '../config/env';
import {
  CfAccessInvalidTokenError,
  CfAccessJwksUnavailableError,
  verifyCfAccessJwt,
} from '../services/cfAccessJwt';
import {
  decideAuthenticatedUserSession,
  AuthBindingRotationRequiredError,
  AuthBindingUnavailableError,
  AuthIssuanceCapabilityError,
  AuthIssuanceConflictError,
  PendingMfaInvalidError,
  PendingMfaUnavailableError,
  NATIVE_AUTH_BINDING_HEADER,
  selectAuthBindingSource,
} from '../services';
import { createAuditLogAsync } from '../services/auditService';
import { TenantInactiveError } from '../services/tenantStatus';
import { CSRF_COOKIE_NAME, ENABLE_2FA } from '../routes/auth/schemas';
import {
  auditUserLoginFailure,
  getCookieValue,
  getClientIP,
  resolveCurrentUserTokenContext,
  NoTenantMembershipError,
  setRefreshTokenCookie,
  rotateCsrfBindingCookie,
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
  if (!isValidCfAccessTeamDomain(teamDomain) || !audience) {
    // Trust is enabled but the deployment is misconfigured. Fail-open to
    // the password handler rather than wedge /login for everyone. Surface
    // a single warning so ops sees it.
    console.warn(
      '[cf-access-login] CF_ACCESS_TRUST_ENABLED=true but CF_ACCESS_TEAM_DOMAIN is invalid or CF_ACCESS_AUD is empty; ignoring header.'
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
    // Membership-less / non-admin user: don't authenticate via CF-Access (it
    // would mint a system-scope token). Fall through to password auth, which
    // also fails closed for this user. (security review #2)
    if (!(err instanceof TenantInactiveError) && !(err instanceof NoTenantMembershipError)) throw err;
    void auditUserLoginFailure(c, {
      userId: user.id,
      email: user.email,
      name: user.name,
      reason: err instanceof NoTenantMembershipError ? 'no_membership' : 'tenant_inactive',
      result: 'denied',
      details: { method: 'cf_access_jwt' },
    });
    return next();
  }

  const trustsMfa = cfAccessTrustsMfa();
  const mobileDeviceId = readMobileDeviceId(c);
  let loginDecision;
  try {
    loginDecision = await decideAuthenticatedUserSession({
      authBinding: selectAuthBindingSource({
        browserBinding: getCookieValue(c.req.header('cookie'), CSRF_COOKIE_NAME),
        nativeBinding: c.req.header(NATIVE_AUTH_BINDING_HEADER),
        nativeRequest: mobileDeviceId !== null,
      }),
      userId: user.id,
      roleId: context.roleId,
      orgId: context.orgId,
      partnerId: context.partnerId,
      scope: context.scope,
      primaryAuthenticationMethod: 'cf_access',
      credentialBinding: {
        kind: 'cf_access',
        verifiedEmail: normalizedEmail,
      },
      requireLocalMfa: ENABLE_2FA && !trustsMfa,
      externallySatisfiedMfa: trustsMfa,
      mobileDeviceId: mobileDeviceId ?? undefined,
    });
  } catch (error) {
    if (error instanceof AuthBindingRotationRequiredError) {
      if (error.replacement.kind === 'native') {
        c.header(NATIVE_AUTH_BINDING_HEADER, error.replacement.value);
      } else {
        rotateCsrfBindingCookie(c, error.replacement.value);
      }
      return c.json({ error: 'Authentication binding refresh required', reason: 'binding_refresh' }, 428);
    }
    if (error instanceof AuthBindingUnavailableError
      || error instanceof AuthIssuanceConflictError
      || error instanceof AuthIssuanceCapabilityError) {
      return c.json({ error: 'Authentication temporarily unavailable' }, 409);
    }
    if (error instanceof PendingMfaInvalidError) {
      console.error('[cf-access-login] locked identity or MFA state changed; denying assertion login');
      return c.json({ error: 'Invalid email or password' }, 401);
    }
    if (error instanceof PendingMfaUnavailableError) {
      console.error('[cf-access-login] cannot make live MFA session decision; falling through');
      return next();
    }
    throw error;
  }
  if (loginDecision.kind === 'pending') {
    return c.json({
      mfaRequired: true,
      tempToken: loginDecision.tempToken,
      mfaMethod: loginDecision.primaryMfaMethod,
      passkeyAvailable: loginDecision.passkeyAvailable,
      phoneLast4: loginDecision.phoneLast4,
      user: null,
      tokens: null,
    });
  }

  const mfaSatisfied = trustsMfa;
  const tokens = loginDecision.tokens;

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
      cfAccessCountry: claims.country ?? null,
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
