import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import * as dbModule from '../../db';
import { users } from '../../db/schema';
import {
  cfAccessAud,
  cfAccessTeamDomain,
  cfAccessTrustEnabled,
  cfAccessTrustsMfa,
} from '../../config/env';
import {
  CfAccessInvalidTokenError,
  CfAccessJwksUnavailableError,
  verifyCfAccessJwt,
} from '../../services/cfAccessJwt';
import { createTokenPair } from '../../services';
import { createAuditLogAsync } from '../../services/auditService';
import { TenantInactiveError } from '../../services/tenantStatus';
import { ENABLE_2FA } from './schemas';
import {
  auditUserLoginFailure,
  clearRefreshTokenCookie,
  getClientIP,
  resolveCurrentUserTokenContext,
  setRefreshTokenCookie,
} from './helpers';

const { db, withSystemDbAccessContext } = dbModule;

const CF_ACCESS_JWT_HEADER = 'cf-access-jwt-assertion';

/**
 * Same-origin guard for the `?next=` query param. Server-side variant of
 * apps/web/src/lib/authNext.ts: only single-leading-/ paths, no //, no \\,
 * no control characters (which also blocks CRLF Location-header injection).
 */
function safeNext(raw: string | undefined): string {
  if (!raw) return '/';
  if (!raw.startsWith('/')) return '/';
  if (raw.length > 1 && (raw[1] === '/' || raw[1] === '\\')) return '/';
  if (/[\x00-\x1F\x7F]/.test(raw)) return '/';
  return raw;
}

function loginErrorRedirect(reason: string): Response {
  const params = new URLSearchParams({ error: 'cf-access', reason });
  return new Response(null, {
    status: 302,
    headers: { Location: `/login?${params.toString()}` },
  });
}

export const cfAccessRedirectLoginRoutes = new Hono();

/**
 * GET /api/v1/auth/cf-access-login
 *
 * Top-level browser navigation entry-point for Cloudflare Access trust. The
 * SPA redirects the browser to this URL when the deployment's CF Access
 * trust is enabled and there's no Breeze session yet. CF Access enforces
 * the path (more specific than any /api/* Bypass), forwards the
 * Cf-Access-Jwt-Assertion header on a top-level GET (where redirects are
 * survivable), and this handler:
 *
 *   1. Verifies the JWT against the configured team JWKS
 *   2. Looks up the matching Breeze user
 *   3. Mints a Breeze session, sets the refresh cookie
 *   4. 302s back to the `next=` param (sanitized) or `/`
 *
 * Failure modes redirect to /login with an error query so the SPA can
 * surface a useful message and the user can fall back to password login.
 *
 * See Discussion #702 and the companion XHR middleware at
 * apps/api/src/middleware/cfAccessLogin.ts.
 */
cfAccessRedirectLoginRoutes.get('/cf-access-login', async (c) => {
  if (!cfAccessTrustEnabled()) {
    return loginErrorRedirect('disabled');
  }

  const token = c.req.header(CF_ACCESS_JWT_HEADER);
  if (!token) {
    return loginErrorRedirect('no-jwt');
  }

  const teamDomain = cfAccessTeamDomain();
  const audience = cfAccessAud();
  if (!teamDomain || !audience) {
    console.error(
      '[cf-access-redirect] CF_ACCESS_TRUST_ENABLED=true but team domain or AUD missing'
    );
    return loginErrorRedirect('misconfigured');
  }

  let claims;
  try {
    claims = await verifyCfAccessJwt(token, { teamDomain, audience });
  } catch (err) {
    if (err instanceof CfAccessInvalidTokenError) {
      console.warn('[cf-access-redirect] rejected JWT', { code: err.code });
      return loginErrorRedirect('invalid-jwt');
    }
    if (err instanceof CfAccessJwksUnavailableError) {
      console.error('[cf-access-redirect] JWKS unavailable', err);
      return loginErrorRedirect('jwks-unavailable');
    }
    console.error('[cf-access-redirect] unexpected verify error', err);
    return loginErrorRedirect('verify-error');
  }

  const normalizedEmail = claims.email.toLowerCase();

  const [user] = await withSystemDbAccessContext(async () =>
    db.select().from(users).where(eq(users.email, normalizedEmail)).limit(1)
  );

  if (!user) {
    return loginErrorRedirect('no-user');
  }

  if (user.status !== 'active') {
    void auditUserLoginFailure(c, {
      userId: user.id,
      email: user.email,
      name: user.name,
      reason: 'account_inactive',
      result: 'denied',
      details: { accountStatus: user.status, method: 'cf_access_jwt_redirect' },
    });
    return loginErrorRedirect('inactive');
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
      details: { method: 'cf_access_jwt_redirect' },
    });
    return loginErrorRedirect('tenant-inactive');
  }

  const trustsMfa = cfAccessTrustsMfa();
  if (ENABLE_2FA && user.mfaEnabled && (user.mfaSecret || user.mfaMethod === 'sms') && !trustsMfa) {
    // POC: MFA flow over redirect is deferred. For now, surface a clear
    // error so the user falls back to password login (which CAN do MFA).
    // Pre-PR follow-up: emit ?mfa=<tempToken>&mfaMethod=... and have the
    // SPA hand off to MFAVerifyForm.
    return loginErrorRedirect('mfa-required');
  }

  const mfaSatisfied = trustsMfa || !(ENABLE_2FA && user.mfaEnabled);

  const tokens = await createTokenPair({
    sub: user.id,
    email: user.email,
    roleId: context.roleId,
    orgId: context.orgId,
    partnerId: context.partnerId,
    scope: context.scope,
    mfa: mfaSatisfied,
  });

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
      method: 'cf_access_jwt_redirect',
      mfa: mfaSatisfied,
      scope: context.scope,
      cfAccessSub: claims.sub,
    },
    ipAddress: getClientIP(c),
    userAgent: c.req.header('user-agent'),
    result: 'success',
  });

  setRefreshTokenCookie(c, tokens.refreshToken);

  // Redirect to `next` (sanitized) with a `cf-access-login=success` marker
  // so the SPA's AuthOverlay knows to bootstrap from the refresh cookie
  // (the SPA's normal post-login `setUser/setTokens` path didn't run since
  // there's no JSON body to consume).
  const next = safeNext(c.req.query('next'));
  const url = new URL(next, 'http://placeholder');
  url.searchParams.set('cf-access-login', 'success');
  const location = url.pathname + url.search + url.hash;
  return new Response(null, {
    status: 302,
    headers: { Location: location },
  });
});

/**
 * GET /api/v1/auth/cf-access-logout
 *
 * Top-level browser navigation entry-point for completing logout when CF
 * Access trust is in front of Breeze. Without this, clicking "Sign out"
 * only clears the Breeze session — CF Access still has an active session
 * for the user, so the next visit re-enters Breeze via the SSO redirect
 * loop with no user interaction.
 *
 * Flow:
 *   1. Clear the Breeze refresh cookie.
 *   2. 302 to CF Access logout endpoint with `returnTo` pointing back at
 *      `/login?signedOut=1`. CF clears its own session and bounces the
 *      user back. `LoginPage` honours the `signedOut=1` flag and shows
 *      the password form instead of triggering the SSO redirect again.
 *
 * If CF Access trust is disabled, falls back to a plain 302 to /login
 * after clearing the refresh cookie.
 *
 * Not authMiddleware-gated: a top-level GET navigation cannot present a
 * Bearer token. The refresh cookie is enough to identify the session and
 * the cookie is cleared regardless.
 */
cfAccessRedirectLoginRoutes.get('/cf-access-logout', (c) => {
  clearRefreshTokenCookie(c);

  if (!cfAccessTrustEnabled()) {
    return new Response(null, {
      status: 302,
      headers: { Location: '/login?signedOut=1' },
    });
  }

  const teamDomain = cfAccessTeamDomain();
  if (!teamDomain) {
    return new Response(null, {
      status: 302,
      headers: { Location: '/login?signedOut=1' },
    });
  }

  // Reconstruct the public origin from the incoming request so the
  // `returnTo` parameter survives whatever proxy / CNAME setup is in
  // front of the api. Falls back to the Host header if the URL parse
  // fails for any reason.
  let origin: string;
  try {
    origin = new URL(c.req.url).origin;
  } catch {
    const host = c.req.header('host') ?? '';
    origin = host ? `https://${host}` : '';
  }
  const returnTo = `${origin}/login?signedOut=1`;
  const cfLogoutUrl = `https://${teamDomain}/cdn-cgi/access/logout?returnTo=${encodeURIComponent(returnTo)}`;

  return new Response(null, {
    status: 302,
    headers: { Location: cfLogoutUrl },
  });
});
