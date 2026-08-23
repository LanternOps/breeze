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
import {
  revokeAllUserTokens,
  revokeRefreshTokenJti,
  verifyToken,
} from '../../services';
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
import { captureException } from '../../services/sentry';
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
} from './helpers';
import { installAuthBindingReplacement, requestAuthBinding } from './binding';

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
  // Server-side revocation, mirroring POST /logout (login.ts): identify the
  // session from the refresh cookie (no Bearer token on a top-level GET),
  // then revoke ALL of the user's tokens plus the specific refresh jti.
  // Without this, "Sign out" via CF Access only cleared the cookie — the
  // access + refresh tokens stayed live until natural expiry. Best-effort:
  // a missing/invalid cookie or a Redis error still clears + redirects.
  try {
    const refreshToken = resolveRefreshToken(c);
    if (refreshToken) {
      const payload = await verifyToken(refreshToken);
      if (payload && payload.type === 'refresh' && payload.sub) {
        await revokeAllUserTokens(payload.sub);
        if (payload.jti) {
          await revokeRefreshTokenJti(payload.jti);
        }
      }
    }
  } catch (error) {
    console.error(
      '[cf-access-logout] Failed to revoke tokens during logout — clearing cookie anyway:',
      error
    );
  }

  clearRefreshTokenCookie(c);

  if (!cfAccessTrustEnabled()) {
    return new Response(null, { status: 302, headers: { Location: '/login?signedOut=1' } });
  }

  const teamDomain = cfAccessTeamDomain();
  if (!teamDomain) {
    return new Response(null, { status: 302, headers: { Location: '/login?signedOut=1' } });
  }

  // Resolve the public origin from configuration, NOT the request. The Host
  // header is attacker-controllable, and the origin ends up in a Location
  // header — deriving it from the request is an open redirect (a crafted
  // Host would bounce the user's browser to an attacker domain after CF
  // logout). DASHBOARD_URL / PUBLIC_APP_URL is the established pattern for
  // building user-facing absolute URLs (see login.ts, password.ts).
  const configuredBase = (process.env.DASHBOARD_URL || process.env.PUBLIC_APP_URL || '')
    .trim()
    .replace(/\/$/, '');
  let origin = '';
  let parseError: unknown;
  if (configuredBase) {
    try {
      const parsed = new URL(configuredBase);
      // Only http(s) bases yield a usable origin — anything else (e.g. an
      // opaque scheme) serialises `origin` to the literal string "null".
      if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
        origin = parsed.origin;
      }
    } catch (err) {
      parseError = err;
    }
  }
  if (!origin) {
    // Fail closed (#2895). There is no safe way to synthesise an absolute
    // origin here: the request Host header is attacker-controllable and
    // would turn this Location into an open redirect. Skip the CF Access
    // logout chain (which requires absolute URLs) and land on the relative
    // /login instead — the Breeze session is already revoked and its cookie
    // cleared above, so the user is signed out of Breeze either way. Only
    // the CF Access cookies survive until the operator configures an origin.
    //
    // Name the configured value in the log: "unset", "typo'd" and "wrong
    // scheme" are three different operator fixes, and a message that only
    // said "not configured" reads as wrong to someone who can see the var
    // is set. The value is a public URL, not a secret.
    const cause = parseError instanceof Error ? ` (${parseError.message})` : '';
    const message =
      '[cf-access-logout] DASHBOARD_URL / PUBLIC_APP_URL did not resolve to an http(s) origin ' +
      `(configured: ${configuredBase ? JSON.stringify(configuredBase) : '<unset>'})${cause} — ` +
      'skipping the Cloudflare Access logout chain and redirecting to /login. Set DASHBOARD_URL ' +
      'to the public Breeze URL to fully sign users out of Cloudflare Access.';
    console.error(message);
    // console.error is stdout-only on a hosted deployment, and this silently
    // disables half of the sign-out. Surface it where an operator will see it.
    captureException(new Error(message), c);
    return new Response(null, { status: 302, headers: { Location: '/login?signedOut=1' } });
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
  const finalReturn = `${origin}/login?signedOut=1`;
  const teamLogout = `https://${teamDomain}/cdn-cgi/access/logout?returnTo=${encodeURIComponent(finalReturn)}`;
  const appLogout = `${origin}/cdn-cgi/access/logout?returnTo=${encodeURIComponent(teamLogout)}`;
  return new Response(null, { status: 302, headers: { Location: appLogout } });
});
