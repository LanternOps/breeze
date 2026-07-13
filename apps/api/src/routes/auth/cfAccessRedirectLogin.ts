import { Hono, type Context } from 'hono';
import { eq } from 'drizzle-orm';
import * as dbModule from '../../db';
import { users } from '../../db/schema';
import {
  cfAccessAud,
  authBrowserPublicOrigin,
  cfAccessTeamDomain,
  cfAccessTrustEnabled,
  cfAccessTrustsMfa,
} from '../../config/env';
import {
  CfAccessInvalidTokenError,
  CfAccessJwksUnavailableError,
  verifyCfAccessJwt,
} from '../../services/cfAccessJwt';
import {
  issueUserSessionLegacyDuringTransition,
} from '../../services';
import { createAuditLogAsync } from '../../services/auditService';
import { TenantInactiveError } from '../../services/tenantStatus';
import { ENABLE_2FA } from './schemas';
import {
  auditUserLoginFailure,
  clearCfAccessLogoutQuarantineCookie,
  clearRefreshTokenCookie,
  getClientIP,
  resolveCurrentUserTokenContext,
  NoTenantMembershipError,
  setCfAccessLogoutQuarantineCookie,
  setRefreshTokenCookie,
  rotateCsrfBindingCookie,
} from './helpers';
import { verifyTerminalLogoutTicket } from '../../services/terminalLogoutTicket';
import { completeTerminalLogout } from '../../services/authBrowserTransition';

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

function terminalLogoutRedirect(
  c: Context,
  location: string,
): Response {
  c.header('Cache-Control', 'no-store');
  c.header('Referrer-Policy', 'no-referrer');
  return c.redirect(location, 303);
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
    // A membership-less / non-admin user must not be issued a system-scope
    // token via the CF-Access path either. Fail closed. (security review #2)
    if (!(err instanceof TenantInactiveError) && !(err instanceof NoTenantMembershipError)) throw err;
    void auditUserLoginFailure(c, {
      userId: user.id,
      email: user.email,
      name: user.name,
      reason: err instanceof NoTenantMembershipError ? 'no_membership' : 'tenant_inactive',
      result: 'denied',
      details: { method: 'cf_access_jwt_redirect' },
    });
    return loginErrorRedirect(err instanceof NoTenantMembershipError ? 'inactive' : 'tenant-inactive');
  }

  const trustsMfa = cfAccessTrustsMfa();
  if (ENABLE_2FA && user.mfaEnabled && (user.mfaSecret || user.mfaMethod === 'sms' || user.mfaMethod === 'passkey') && !trustsMfa) {
    // POC: MFA flow over redirect is deferred. For now, surface a clear
    // error so the user falls back to password login (which CAN do MFA).
    // Pre-PR follow-up: emit ?mfa=<tempToken>&mfaMethod=... and have the
    // SPA hand off to MFAVerifyForm.
    return loginErrorRedirect('mfa-required');
  }

  const mfaSatisfied = trustsMfa;

  const tokens = await issueUserSessionLegacyDuringTransition({
    userId: user.id,
    email: user.email,
    roleId: context.roleId,
    orgId: context.orgId,
    partnerId: context.partnerId,
    scope: context.scope,
    mfa: mfaSatisfied,
    amr: ['cf_access'],
  });

  // System DB context required: no request auth context is established on this
  // pre-auth path, so a bare UPDATE silently matches 0 rows under breeze_app RLS
  // and last_login_at never moves (#1375).
  await withSystemDbAccessContext(() =>
    db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, user.id))
  );

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
      cfAccessCountry: claims.country ?? null,
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
cfAccessRedirectLoginRoutes.get('/cf-access-logout', async (c) => {
  const ticket = c.req.query('ticket');
  try {
    if (!ticket) throw new Error('missing ticket');
    verifyTerminalLogoutTicket(ticket);
  } catch {
    // A GET without an authenticated capability has no authority to clear,
    // revoke, rotate, or otherwise mutate any browser/session state.
    return terminalLogoutRedirect(c, '/login?signedOut=1&logoutError=1');
  }

  // Only an operator-configured origin may enter a redirect Location. Never
  // derive an authentication return target from Host or forwarding headers.
  const origin = authBrowserPublicOrigin();
  if (!origin) {
    return terminalLogoutRedirect(c, '/login?signedOut=1&logoutError=1');
  }

  const completionUrl = new URL('/api/v1/auth/cf-access-logout/complete', origin);
  completionUrl.searchParams.set('ticket', ticket);

  // Persist an issuer barrier across both Cloudflare navigation hops. C1 is
  // deliberately kept until signed durable completion can atomically retire
  // it and establish C2, including when the browser returns without cookies.
  setCfAccessLogoutQuarantineCookie(c);

  const teamDomain = cfAccessTeamDomain();
  if (!cfAccessTrustEnabled() || !/^[a-z0-9.-]+$/i.test(teamDomain)) {
    return terminalLogoutRedirect(c, completionUrl.toString());
  }

  // CF Access stores TWO `CF_Authorization` cookies per session:
  // 1. Per-application cookie at the app domain (app.example.com)
  // 2. Global session token at the team domain (your-team.cloudflareaccess.com)
  // Each domain's `/cdn-cgi/access/logout` endpoint clears only its own
  // cookie (per
  // https://developers.cloudflare.com/cloudflare-one/identity/authorization-cookie/).
  // For a full logout we need to hit both. Chain them via returnTo:
  //
  //   app-logout (clears per-app cookie)
  //   └─ returnTo=team-logout (clears global cookie)
  //      └─ returnTo=/login?signedOut=1
  //
  // The `/cdn-cgi/access/*` paths are reserved by Cloudflare and
  // intercepted at the edge, so they never hit the origin and aren't
  // affected by the `/api/*` bypass app.
  const finalReturn = completionUrl.toString();
  const teamLogout = `https://${teamDomain}/cdn-cgi/access/logout?returnTo=${encodeURIComponent(finalReturn)}`;
  const appLogout = `${origin}/cdn-cgi/access/logout?returnTo=${encodeURIComponent(teamLogout)}`;
  return terminalLogoutRedirect(c, appLogout);
});

/** Signed post-IdP boundary: atomically consume C1 and establish C2. */
cfAccessRedirectLoginRoutes.get('/cf-access-logout/complete', async (c) => {
  const ticket = c.req.query('ticket');
  let verified;
  try {
    if (!ticket) throw new Error('missing ticket');
    verified = verifyTerminalLogoutTicket(ticket);
  } catch {
    return terminalLogoutRedirect(c, '/login?signedOut=1&logoutError=1');
  }

  let completed;
  try {
    completed = await completeTerminalLogout({
      transitionId: verified.transitionId,
      logoutId: verified.logoutId,
      generation: verified.generation,
      nonce: verified.nonce,
      signingKeyId: verified.signingKeyId,
    });
  } catch (error) {
    console.error('[cf-access-logout] Durable completion failed');
    void error;
    return terminalLogoutRedirect(c, '/login?signedOut=1&logoutError=1');
  }

  if (completed.kind === 'invalid') {
    return terminalLogoutRedirect(c, '/login?signedOut=1&logoutError=1');
  }

  clearRefreshTokenCookie(c);
  rotateCsrfBindingCookie(c, completed.replacement.value);
  clearCfAccessLogoutQuarantineCookie(c);
  return terminalLogoutRedirect(c, '/login?signedOut=1');
});
