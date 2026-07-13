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
  isValidCfAccessTeamDomain,
} from '../../config/env';
import {
  CfAccessInvalidTokenError,
  CfAccessJwksUnavailableError,
  verifyCfAccessJwt,
} from '../../services/cfAccessJwt';
import {
  bindIssuedUserSession,
  issueUserSession,
} from '../../services';
import { createAuditLogAsync } from '../../services/auditService';
import { TenantInactiveError } from '../../services/tenantStatus';
import {
  auditUserLoginFailure,
  clearCfAccessLogoutQuarantineCookie,
  clearRefreshTokenCookie,
  getCookieValue,
  getClientIP,
  resolveCurrentUserTokenContext,
  NoTenantMembershipError,
  setRefreshTokenCookie,
  rotateCsrfBindingCookie,
} from './helpers';
import { CSRF_COOKIE_NAME, ENABLE_2FA } from './schemas';
import {
  verifyTerminalLogoutTicket,
  type VerifiedTerminalLogoutTicket,
} from '../../services/terminalLogoutTicket';
import {
  AuthBindingRotationRequiredError,
  AuthBindingUnavailableError,
  AuthIssuanceCapabilityError,
  AuthIssuanceConflictError,
  beginAuthIssuance,
  cancelAuthIssuance,
  completeTerminalLogout,
  finishAuthIssuance,
  isTerminalLogoutPending,
} from '../../services/authBrowserTransition';

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

function auditTerminalLogoutCompletion(
  c: Context,
  ticket: VerifiedTerminalLogoutTicket,
  outcome: 'completed' | 'replayed' | 'invalid' | 'failed',
): void {
  const mutatesCookies = outcome === 'completed';
  void createAuditLogAsync({
    actorType: 'system',
    actorId: ticket.transitionId,
    action: 'auth.cf_access_terminal_logout.complete',
    resourceType: 'auth_browser_transition',
    resourceId: ticket.transitionId,
    details: {
      transitionId: ticket.transitionId,
      logoutId: ticket.logoutId,
      result: outcome,
      cleanupStatus: outcome === 'completed'
        ? 'complete'
        : outcome === 'failed'
          ? 'failed'
          : 'not-run',
      refreshCookieClearCount: mutatesCookies ? 1 : 0,
      bindingRotationCount: mutatesCookies ? 1 : 0,
    },
    ipAddress: getClientIP(c),
    userAgent: c.req.header('user-agent'),
    result: outcome === 'failed' ? 'failure' : outcome === 'invalid' ? 'denied' : 'success',
    ...(outcome === 'failed'
      ? { errorMessage: 'Durable terminal logout completion unavailable' }
      : {}),
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
  if (!isValidCfAccessTeamDomain(teamDomain) || !audience) {
    console.error(
      '[cf-access-redirect] CF_ACCESS_TRUST_ENABLED=true but team domain is invalid or AUD is missing'
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

  let capability: Awaited<ReturnType<typeof beginAuthIssuance>> | undefined;
  let tokens: Awaited<ReturnType<typeof issueUserSession>>;
  try {
    capability = await beginAuthIssuance({
      kind: 'browser',
      value: getCookieValue(c.req.header('cookie'), CSRF_COOKIE_NAME) ?? '',
    });
    const admission = capability;
    tokens = await finishAuthIssuance(admission, async (tx) => {
      const issued = await issueUserSession({
        userId: user.id,
        email: user.email,
        roleId: context.roleId,
        orgId: context.orgId,
        partnerId: context.partnerId,
        scope: context.scope,
        mfa: mfaSatisfied,
        amr: ['cf_access'],
      }, { tx, capability: admission });
      await tx.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, user.id));
      return issued;
    });
  } catch (error) {
    if (capability) await cancelAuthIssuance(capability).catch(() => false);
    if (error instanceof AuthBindingRotationRequiredError) {
      rotateCsrfBindingCookie(c, error.replacement.value);
      const requestUrl = new URL(c.req.url);
      return c.redirect(`${requestUrl.pathname}${requestUrl.search}`, 303);
    }
    if (error instanceof AuthBindingUnavailableError
      || error instanceof AuthIssuanceConflictError
      || error instanceof AuthIssuanceCapabilityError) {
      return loginErrorRedirect('unavailable');
    }
    throw error;
  }

  void bindIssuedUserSession(tokens).catch((error) => {
    console.warn('[cf-access-redirect] post-commit session cache bind failed', error);
  });

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
 *   1. Authenticate the signed capability and correlate it to the exact live
 *      pending transition row without consuming it.
 *   2. 303 through the application and team CF logout endpoints, carrying the
 *      capability to the configured-origin completion endpoint.
 *   3. Completion consumes the pending row, clears refresh/C1, installs C2,
 *      and lands on `/login?signedOut=1`.
 *
 * If CF Access trust is disabled, the valid capability goes directly to the
 * same completion endpoint. Missing/invalid/consumed capabilities write no
 * cookies and return only to the local signed-out/error page.
 *
 * Not authMiddleware-gated: a top-level GET navigation cannot present a
 * Bearer token. No cookie is treated as authority; the signed ticket and
 * pending database row are the complete navigation authority.
 */
cfAccessRedirectLoginRoutes.get('/cf-access-logout', async (c) => {
  const ticket = c.req.query('ticket');
  let verified: VerifiedTerminalLogoutTicket;
  try {
    if (!ticket) throw new Error('missing ticket');
    verified = verifyTerminalLogoutTicket(ticket);
  } catch {
    // A GET without an authenticated capability has no authority to clear,
    // revoke, rotate, or otherwise mutate any browser/session state.
    return terminalLogoutRedirect(c, '/login?signedOut=1&logoutError=1');
  }

  const trustEnabled = cfAccessTrustEnabled();
  const teamDomain = cfAccessTeamDomain();
  if (trustEnabled && !isValidCfAccessTeamDomain(teamDomain)) {
    console.error('[cf-access-logout] Refusing terminal navigation with invalid CF Access team domain');
    return terminalLogoutRedirect(c, '/login?signedOut=1&logoutError=1');
  }

  try {
    const pending = await isTerminalLogoutPending({
      transitionId: verified.transitionId,
      logoutId: verified.logoutId,
      generation: verified.generation,
      nonce: verified.nonce,
    });
    if (!pending) return terminalLogoutRedirect(c, '/login?signedOut=1&logoutError=1');
  } catch {
    console.error('[cf-access-logout] Pending navigation check failed');
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

  if (!trustEnabled) {
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
    auditTerminalLogoutCompletion(c, verified, 'failed');
    return terminalLogoutRedirect(c, '/login?signedOut=1&logoutError=1');
  }

  if (completed.kind === 'invalid') {
    auditTerminalLogoutCompletion(c, verified, 'invalid');
    return terminalLogoutRedirect(c, '/login?signedOut=1&logoutError=1');
  }

  if (completed.kind === 'replayed') {
    auditTerminalLogoutCompletion(c, verified, 'replayed');
    return terminalLogoutRedirect(c, '/login?signedOut=1');
  }

  clearRefreshTokenCookie(c);
  rotateCsrfBindingCookie(c, completed.replacement.value);
  clearCfAccessLogoutQuarantineCookie(c);
  auditTerminalLogoutCompletion(c, verified, 'completed');
  return terminalLogoutRedirect(c, '/login?signedOut=1');
});
