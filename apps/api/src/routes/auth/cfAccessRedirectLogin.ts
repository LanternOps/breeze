import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import * as dbModule from '../../db';
import { users } from '../../db/schema';
import {
  cfAccessAud,
  cfAccessTeamDomain,
  cfAccessTrustEnabled,
  cfAccessTrustsMfa,
  authBrowserTerminalPreparationEnabled,
  canonicalCfAccessTeamDomain,
} from '../../config/env';
import {
  CfAccessInvalidTokenError,
  CfAccessJwksUnavailableError,
  verifyCfAccessJwt,
} from '../../services/cfAccessJwt';
import { authMiddleware } from '../../middleware/auth';
import {
  AuthBindingRotationRequiredError,
  AuthBindingUnavailableError,
  AuthIssuanceCapabilityError,
  AuthIssuanceConflictError,
  beginAuthIssuance,
  cancelAuthIssuance,
  finishAuthIssuance,
} from '../../services/authBrowserTransition';
import {
  authBrowserTransitionsEnforced,
  bindIssuedUserSession,
  issueUserSession,
  issueUserSessionLegacyDuringTransition,
  type UserSessionIdentity,
} from '../../services/userSession';
import { recordAuthTransitionLegacyIssuer } from '../../services/authTransitionMetrics';
import { createAuditLogAsync } from '../../services/auditService';
import { TenantInactiveError } from '../../services/tenantStatus';
import { getEffectiveMfaPolicy } from '../../services/mfaPolicy';
import { ENABLE_2FA } from './schemas';
import {
  auditUserLoginFailure,
  clearRefreshTokenCookie,
  getClientIP,
  resolveCurrentUserTokenContext,
  NoTenantMembershipError,
  resolveRefreshToken,
  authClientUpgradeRequiredResponse,
  installAuthorizedUserSessionCookies,
  installLegacyUserSessionCookiesDuringTransition,
  isAuthTransitionV1Request,
  validateStrictCookieCsrfRequest,
} from './helpers';
import { installAuthBindingReplacement, requestAuthBinding } from './binding';
import {
  completeCfTerminalLogout,
  isCfTerminalLogoutPending,
  prepareCfTerminalLogout,
} from '../../services/terminalLogout';
import {
  issueTerminalLogoutTicket,
  verifyTerminalLogoutTicket,
  type TerminalLogoutTicketClaims,
} from '../../services/terminalLogoutTicket';

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

function cfAccessIssuanceError(c: Parameters<typeof installAuthBindingReplacement>[0], error: unknown): Response | null {
  if (error instanceof AuthBindingRotationRequiredError) {
    installAuthBindingReplacement(c, error.replacement);
    return c.json({
      error: 'Authentication binding refresh required',
      reason: 'binding_refresh',
    }, 428);
  }
  if (
    error instanceof AuthBindingUnavailableError
    || error instanceof AuthIssuanceConflictError
    || error instanceof AuthIssuanceCapabilityError
  ) {
    return c.json({ error: 'Authentication temporarily unavailable' }, 409);
  }
  return null;
}

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

  // Parity with the password /login handler (routes/auth/login.ts) and the
  // companion XHR middleware (middleware/cfAccessLogin.ts).
  //
  // The old `trustsMfa || !(ENABLE_2FA && user.mfaEnabled)` granted VACUOUS
  // assurance to any user with no factor — INCLUDING one whose effective
  // policy requires MFA — so a CF Access login walked straight past forced
  // enrollment and every hasSatisfiedMfa() gate. `trustsMfa` still satisfies
  // MFA, but ONLY for a user who actually HAS a factor: the operator is
  // asserting the edge performed a second factor, not that policy is
  // irrelevant.
  //
  // This handler answers with a 302, not JSON, so there is no body to carry
  // the `mfaEnrollmentRequired` flag its XHR sibling returns. The `mfa: false`
  // claim IS the security-relevant half: it is what makes authMiddleware's
  // forced-enrollment gate 428 the session into /auth/mfa/setup and what keeps
  // every hasSatisfiedMfa()-gated route closed until a real factor exists.
  //
  // Fail-closed on an unresolvable policy: getEffectiveMfaPolicy reads under
  // runOutsideDbContext+withSystemDbAccessContext (so this pre-auth path can
  // never silently 0-row under RLS and mistake "no policy row" for "no
  // policy"), and a role/membership-join failure THROWS rather than returning
  // a permissive default — the throw aborts before any token is minted, which
  // is the closed outcome. (A settings-read blip is the resolver's one
  // deliberate fail-open, shared with /login: a transient error must not lock
  // a whole tenant out of signing in.)
  const policy = await getEffectiveMfaPolicy({
    scope: context.scope,
    userId: user.id,
    orgId: context.orgId,
    partnerId: context.partnerId,
  });
  const mfaSatisfied =
    !ENABLE_2FA ||
    (user.mfaEnabled && trustsMfa) ||
    (!user.mfaEnabled && !policy.required);

  const identity: UserSessionIdentity = {
    userId: user.id,
    email: user.email,
    roleId: context.roleId,
    orgId: context.orgId,
    partnerId: context.partnerId,
    scope: context.scope,
    mfa: mfaSatisfied,
  };
  const binding = requestAuthBinding(c);
  const guarded = binding.value.length > 0 || isAuthTransitionV1Request(c);
  if (!guarded && authBrowserTransitionsEnforced()) {
    return authClientUpgradeRequiredResponse(c);
  }

  if (guarded) {
    let capability;
    try {
      capability = await beginAuthIssuance(binding);
      const guardedCapability = capability;
      const issued = await finishAuthIssuance(guardedCapability, async (tx) => {
        await tx
          .update(users)
          .set({ lastLoginAt: new Date() })
          .where(eq(users.id, user.id));
        return issueUserSession(identity, {
          tx,
          capability: guardedCapability,
          expectedEpochs: { authEpoch: user.authEpoch, mfaEpoch: user.mfaEpoch },
        });
      });
      await bindIssuedUserSession(issued);
      installAuthorizedUserSessionCookies(c, issued);
    } catch (error) {
      if (capability) await cancelAuthIssuance(capability).catch(() => undefined);
      const response = cfAccessIssuanceError(c, error);
      if (response) return response;
      throw error;
    }
  } else {
    recordAuthTransitionLegacyIssuer('cf_access_redirect', 'web');
    const issued = await issueUserSessionLegacyDuringTransition(identity);
    await withSystemDbAccessContext(() =>
      db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, user.id))
    );
    installLegacyUserSessionCookiesDuringTransition(c, issued);
  }

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
 * POST /api/v1/auth/cf-access-logout/prepare authenticates the browser,
 * applies strict cookie/header CSRF, durably revokes refresh authority, and
 * returns a signed one-time navigation URL. GET /cf-access-logout accepts only
 * that ticket and chains the app/team Cloudflare logout hops to the cookie-less
 * completion endpoint.
 *
 * Top-level browser navigation entry-point for completing logout when CF
 * Access trust is in front of Breeze. Without this, clicking "Sign out"
 * only clears the Breeze session — CF Access still has an active session
 * for the user, so the next visit re-enters Breeze via the SSO redirect
 * loop with no user interaction.
 *
 * Neither GET derives authority from cookies. Completion validates the signed
 * correlation against PostgreSQL, consumes the nonce once, retires C1, and
 * installs deterministic C2. Invalid, stale, replay-mismatched, or unavailable
 * state fails closed without a redirect.
 */
function terminalTicketResponseHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    ...extra,
  };
}

function terminalTicketError(message: string, status: 400 | 503): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: terminalTicketResponseHeaders({ 'Content-Type': 'application/json; charset=UTF-8' }),
  });
}

function configuredPublicOrigin(): string | null {
  const configuredBase = (process.env.DASHBOARD_URL || process.env.PUBLIC_APP_URL || '').trim();
  if (!configuredBase) return null;
  try {
    const parsed = new URL(configuredBase);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.origin : null;
  } catch {
    return null;
  }
}

function verifiedTicketInput(ticket: string | undefined) {
  if (!ticket) return null;
  const verified = verifyTerminalLogoutTicket(ticket);
  if (!verified) return null;
  return {
    verified,
    correlation: {
      transitionId: verified.claims.transitionId,
      logoutId: verified.claims.logoutId,
      generation: verified.claims.generation,
      nonce: verified.claims.nonce,
    },
  };
}

cfAccessRedirectLoginRoutes.post('/cf-access-logout/prepare', authMiddleware, async (c) => {
  if (!authBrowserTerminalPreparationEnabled()) {
    return c.json({ error: 'Terminal logout preparation is disabled' }, 503);
  }

  const csrfError = validateStrictCookieCsrfRequest(c);
  if (csrfError) return c.json({ error: csrfError }, 403);

  const auth = c.get('auth');
  const token = auth.token;
  if (
    !token
    || typeof token.aep !== 'number'
    || typeof token.mep !== 'number'
    || !token.sid
  ) {
    return c.json({ error: 'Invalid or expired token' }, 401);
  }

  try {
    const prepared = await prepareCfTerminalLogout({
      binding: requestAuthBinding(c),
      access: {
        userId: auth.user.id,
        authEpoch: token.aep,
        mfaEpoch: token.mep,
        familyId: token.sid,
      },
      refreshToken: resolveRefreshToken(c),
    });
    const claims: TerminalLogoutTicketClaims = {
      version: 1,
      audience: 'terminal-logout-completion',
      transitionId: prepared.transitionId,
      logoutId: prepared.logoutId,
      generation: prepared.generation,
      nonce: prepared.nonce,
      issuedAt: prepared.issuedAt,
      expiresAt: prepared.expiresAt,
    };
    const ticket = issueTerminalLogoutTicket(claims);
    clearRefreshTokenCookie(c);
    c.header('Cache-Control', 'no-store');
    c.header('Referrer-Policy', 'no-referrer');
    return c.json({
      navigationUrl: `/api/v1/auth/cf-access-logout?ticket=${encodeURIComponent(ticket)}`,
    });
  } catch {
    console.error(
      '[cf-access-logout] Durable terminal preparation failed',
      { name: 'TerminalLogoutError', reason: 'durable_preparation_failed' },
    );
    return c.json({ error: 'Terminal logout preparation unavailable' }, 503);
  }
});

cfAccessRedirectLoginRoutes.get('/cf-access-logout', async (c) => {
  const ticket = c.req.query('ticket');
  const input = verifiedTicketInput(ticket);
  if (!input) {
    return terminalTicketError('Invalid or expired terminal logout ticket', 400);
  }
  try {
    if (!await isCfTerminalLogoutPending(input.correlation)) {
      return terminalTicketError('Invalid or expired terminal logout ticket', 400);
    }
  } catch {
    console.error(
      '[cf-access-logout] Pending ticket check failed',
      { name: 'TerminalLogoutError', reason: 'pending_check_failed' },
    );
    return terminalTicketError('Terminal logout temporarily unavailable', 503);
  }
  if (!cfAccessTrustEnabled()) {
    return terminalTicketError('Cloudflare Access logout is disabled', 503);
  }
  const teamDomain = canonicalCfAccessTeamDomain(cfAccessTeamDomain());
  const origin = configuredPublicOrigin();
  if (!teamDomain || !origin) {
    return terminalTicketError('Cloudflare Access logout is misconfigured', 503);
  }

  const completion = `${origin}/api/v1/auth/cf-access-logout/complete?ticket=${encodeURIComponent(ticket!)}`;
  const teamLogout = `https://${teamDomain}/cdn-cgi/access/logout?returnTo=${encodeURIComponent(completion)}`;
  const appLogout = `${origin}/cdn-cgi/access/logout?returnTo=${encodeURIComponent(teamLogout)}`;
  return new Response(null, {
    status: 302,
    headers: terminalTicketResponseHeaders({ Location: appLogout }),
  });
});

cfAccessRedirectLoginRoutes.get('/cf-access-logout/complete', async (c) => {
  const input = verifiedTicketInput(c.req.query('ticket'));
  if (!input) {
    return terminalTicketError('Invalid or expired terminal logout ticket', 400);
  }
  let result;
  try {
    result = await completeCfTerminalLogout({
      ...input.correlation,
      signingKeyId: input.verified.signingKeyId,
    });
  } catch {
    console.error(
      '[cf-access-logout] Ticket completion failed',
      { name: 'TerminalLogoutError', reason: 'completion_failed' },
    );
    return terminalTicketError('Terminal logout temporarily unavailable', 503);
  }
  if (result.kind === 'invalid') {
    return terminalTicketError('Invalid or expired terminal logout ticket', 400);
  }

  clearRefreshTokenCookie(c);
  installAuthBindingReplacement(c, result.replacement);
  return new Response(null, {
    status: 303,
    headers: terminalTicketResponseHeaders({ Location: '/login?signedOut=1' }),
  });
});
