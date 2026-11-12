/**
 * "Sign in with Microsoft" for the customer portal (portal registration W4
 * #11381, plan Task 7; D3, D5, D15; spec §5.6, §5.7, inv. 1, 6, 8, 13).
 *
 * Routes (all under /api/v1/portal):
 *   GET  /auth/methods                    which sign-in methods the login page offers
 *   POST /auth/oidc/entra/start           start a login or an invitation-bound sign-in
 *   POST /auth/oidc/entra/link/start      link Microsoft to the signed-in account (session + CSRF, index.ts)
 *   GET  /auth/oidc/entra/link-status     { available, linked } for the signed-in account (session, index.ts)
 *   POST /auth/invite/methods             which methods can accept this invite (peek, no consume)
 *   GET  /auth/oidc/entra/callback        the one redirect URI for every purpose (D4)
 *   GET  /auth/oidc/entra/consent-return  the admin-consent return (reads nothing as authority)
 *   GET  /auth/oidc/entra/proof           the MSP's tenant proof-run link (./oidcTenantProof.ts)
 *
 * The callback:
 *  - ALWAYS answers 302 and ALWAYS clears the browser-binding cookie, whatever
 *    happens (a failure is never a 500 page on the IdP round trip);
 *  - redirects only to the fixed portal result paths (`/login?sso=…`,
 *    `/profile?sso=…`, `/entra-setup?status=…`). No return URL travels through
 *    the API (D3): the portal keeps `next` itself;
 *  - shows ONE generic failure for every refusal (D15). Only `request_sent` and
 *    `account_exists` are distinct. The deny reason goes to the audit row and
 *    the server log only;
 *  - holds no DB context: account resolution opens its own system contexts
 *    (it refuses to run inside one), and so do the capability-token checks.
 *
 * Host binding (D5): the org whose VERIFIED custom domain is the request's
 * `Host` header is recorded in the state at start; the resolver refuses a
 * sign-in that resolves to another org. On the shared host it is null.
 *
 * Tenant proof (Task 8, ./oidcTenantProof.ts): the proof-run start route is
 * mounted beside the others, and its callback branch is
 * `handleTenantProofCallback`, reached after the code exchange and the
 * id_token check pinned to the run's tenant (the one check that admits a B2B
 * guest of that tenant; every sign-in purpose refuses guests). A proof flow
 * refused here, before that branch, is audited as a refused proof on the
 * run's org.
 *
 * The provider-neutral callback machinery (binding cookie, rate limits, state
 * read, refusal, audit, finishSignIn, the invite consumer) lives in
 * ./oidcShared, shared with Sign in with Google (W7 D10).
 *
 * Nothing here logs or audits a code, token, id_token, secret or token-endpoint
 * body (D14).
 */
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { db, runOutsideDbContext } from '../../db';
import { portalUserIdentities, portalUsers } from '../../db/schema';
import { zValidator } from '../../lib/validation';
import { getPortalEntraConfig, type PortalEntraConfig } from '../../config/portalEntra';
import { getPortalGoogleConfig } from '../../config/portalGoogle';
import { rateLimitIpKey } from '../../services/clientIp';
import {
  PortalAccessPolicyOrgNotFoundError,
  getPortalSignInCapabilities,
  isSignInMethodAllowed,
  resolvePortalAccessPolicy,
} from '../../services/portalAccessPolicy';
import { resolvePortalOidcSignIn } from '../../services/portalOidc/accountResolution';
import {
  PORTAL_ENTRA_SIGN_IN_SCOPE,
  PortalEntraTokenError,
  buildPortalEntraAuthorizeUrl,
  exchangePortalEntraCode,
  verifyPortalEntraIdToken,
} from '../../services/portalOidc/entraClient';
import type { PortalOidcPurpose, PortalOidcVerifiedIdentity } from '../../services/portalOidc/types';
import { getRedis } from '../../services/redis';
import { hostOrgIdFor } from './requestHost';
import { listVerifiedDomainsForOrg } from '../../services/portalDomainVerification';
import {
  PORTAL_ENTRA_PROOF_ROUTE,
  entraSetupResult,
  handleTenantProofCallback,
  startPortalEntraTenantProof,
} from './oidcTenantProof';
import {
  hashPortalCapabilityToken,
  peekPortalCapabilityToken,
  validatePortalCapability,
} from './capabilityTokens';
import {
  checkRateLimit,
  getClientIp,
  sweepPortalState,
  validatePortalCookieCsrfRequest,
} from './helpers';
import {
  CALLBACK_RATE_LIMIT,
  INVALID_INVITE,
  SERVICE_UNAVAILABLE,
  START_RATE_LIMIT,
  answerCallback,
  bindingCookieSecure,
  consumeInviteForSso,
  finishSignIn,
  ipRateKey,
  parseCallbackQuery,
  readCallbackState,
  refuse,
  startFlow,
  type CallbackContext,
} from './oidcShared';
import { PORTAL_USE_REDIS, RESET_PASSWORD_RATE_LIMIT } from './schemas';

export const oidcRoutes = new Hono();

// ============================================
// Constants
// ============================================

/**
 * User sign-in always uses the `organizations` authority (structural guest
 * refusal, Global Constraints). Only the tenant-proof run pins a tenant and
 * admits that tenant's guests (./oidcTenantProof.ts).
 */
const SIGN_IN_AUTHORITY = 'organizations';
const PROVIDER = 'entra';

// ============================================
// Test seam (no network in tests)
// ============================================

interface PortalOidcEntraTestDeps {
  /** Replaces the token endpoint call. */
  fetch?: typeof fetch;
  /** Replaces Microsoft's JWKS for id_token verification. */
  verificationKey?: CryptoKey;
  /** Replaces Microsoft Graph for the tenant-proof admin-role check. */
  graphFetch?: typeof fetch;
}

let entraTestDeps: PortalOidcEntraTestDeps = {};

/** Test seam for the Entra token endpoint, signing key and Graph. Refuses outside NODE_ENV=test. */
export const __testOnly = {
  setEntraDeps(deps: PortalOidcEntraTestDeps | null): void {
    if (process.env.NODE_ENV !== 'test') {
      throw new Error('routes/portal/oidc __testOnly.setEntraDeps is only available when NODE_ENV=test');
    }
    entraTestDeps = deps ? { ...deps } : {};
  },
};

// ============================================
// Request helpers
// ============================================

// requestHost / hostOrgIdFor live in ./requestHost (shared with self-registration, W6 D6).
// The binding cookie, rate-limit keys, result redirects, refusal, audit and
// finishSignIn live in ./oidcShared (shared with Sign in with Google, W7 D10).

/** Mint the state, set the binding cookie, answer `{ redirectUrl }`. 503 when the state store is unavailable. */
function startEntraFlow(c: Context, cfg: PortalEntraConfig, purpose: PortalOidcPurpose, hostOrgId: string | null) {
  return startFlow(c, { provider: PROVIDER, purpose, hostOrgId, authority: SIGN_IN_AUTHORITY }, (flow) =>
    buildPortalEntraAuthorizeUrl(cfg, {
      authority: SIGN_IN_AUTHORITY,
      scope: PORTAL_ENTRA_SIGN_IN_SCOPE,
      state: flow.state,
      nonce: flow.nonce,
      codeChallenge: flow.codeChallenge,
    }));
}

// ============================================
// Callback
// ============================================

type VerifiedEntraIdentity = PortalOidcVerifiedIdentity & { entraTenantId: string };

/** Steps 1–7. `ctx.purpose` is set as soon as the state is read, so an unexpected throw still lands on the right page. */
async function runCallback(c: Context, ctx: CallbackContext): Promise<string> {
  const rate = await checkRateLimit(ipRateKey('callback', c), CALLBACK_RATE_LIMIT);
  if (!rate.allowed) return refuse(c, 'rate_limited', { provider: PROVIDER });

  const cfg = getPortalEntraConfig();
  if (!cfg) return refuse(c, 'not_configured', { provider: PROVIDER });

  // 1. Strict query.
  const query = parseCallbackQuery(new URL(c.req.url).searchParams);
  if (!query) return refuse(c, 'query_invalid', { provider: PROVIDER });

  // 2. Single-use, browser-bound state (a provider error burns the state
  // Microsoft echoed, if it is ours and this browser's, to land on the
  // purpose's page).
  const read = await readCallbackState(c, PROVIDER, query, ctx);
  if (!read.ok) return read.location;
  const { state, code } = read;
  const purpose = state.purpose;

  // 3. Code exchange and id_token verification. A proof run is pinned to its
  // tenant and admits a B2B guest of it (Global Constraints "Proof run": a
  // guest Global Administrator is an admin there; the branch's Graph role
  // check binds to tid/oid). Every other purpose keeps refusing guests.
  let identity: VerifiedEntraIdentity;
  let accessToken: string | null;
  try {
    const tokens = await exchangePortalEntraCode(
      cfg,
      { authority: state.authority, code, codeVerifier: state.codeVerifier },
      entraTestDeps.fetch ? { fetch: entraTestDeps.fetch } : {},
    );
    accessToken = tokens.accessToken;
    identity = await verifyPortalEntraIdToken(
      tokens.idToken,
      purpose.kind === 'tenant_proof'
        ? { clientId: cfg.clientId, nonce: state.nonce, expectedTenantId: purpose.expectedTenantId, allowGuest: true }
        : { clientId: cfg.clientId, nonce: state.nonce, expectedTenantId: null },
      entraTestDeps.verificationKey ? { verificationKey: entraTestDeps.verificationKey } : {},
    );
  } catch (error) {
    // The client already logged the failed check; anything else is logged here by name only.
    if (!(error instanceof PortalEntraTokenError)) {
      console.warn('[portal] Microsoft sign-in token step failed', { error: error instanceof Error ? error.name : 'unknown' });
    }
    return refuse(c, 'token_invalid', { purpose, provider: PROVIDER });
  }

  // 4. Tenant proof (Task 8, ./oidcTenantProof.ts).
  if (purpose.kind === 'tenant_proof') {
    return handleTenantProofCallback(
      c,
      { cfg, purpose, identity, accessToken },
      entraTestDeps.graphFetch ? { graphFetch: entraTestDeps.graphFetch } : {},
    );
  }

  // 5. Account resolution (no DB context is held on this public route).
  const outcome = await resolvePortalOidcSignIn({
    identity,
    purpose,
    hostOrgId: state.hostOrgId,
    inviteConsumer: consumeInviteForSso,
  });

  // 6–7.
  return finishSignIn(c, PROVIDER, purpose, outcome);
}

// Always 302, always clears the binding cookie, never a 500 (./oidcShared).
oidcRoutes.get('/auth/oidc/entra/callback', (c) => answerCallback(c, PROVIDER, (ctx) => runCallback(c, ctx)));

// ============================================
// Admin-consent return (D6)
// ============================================

// Microsoft enforces consent itself; whatever this redirect carries
// (admin_consent, tenant, error, state) is never read as authority and nothing
// is recorded.
oidcRoutes.get('/auth/oidc/entra/consent-return', (c) => {
  c.header('Cache-Control', 'no-store');
  return c.redirect(entraSetupResult('consent_done'), 302);
});

// ============================================
// Tenant proof-run link (public; Task 8, ./oidcTenantProof.ts)
// ============================================

oidcRoutes.get(PORTAL_ENTRA_PROOF_ROUTE, (c) =>
  startPortalEntraTenantProof(c, { secureCookie: bindingCookieSecure(c), hostOrgId: () => hostOrgIdFor(c) }));

// ============================================
// Discovery
// ============================================

/** `{ google }` only where the deployment can run Google (W7 D10, ships dark); `{}` elsewhere. */
function googleKey(deploymentHasGoogle: boolean, value: boolean): { google?: boolean } {
  return deploymentHasGoogle ? { google: value } : {};
}

/**
 * Shared host: a constant (`password` always offered, Microsoft and Google
 * when the deployment can run them, Request access never), so it reveals
 * nothing about any org (inv. 8). A verified custom domain: that org's
 * effective policy.
 *
 * `google` (W7 D10) ships dark: the key is present only on a deployment that
 * can run Google (`getPortalSignInCapabilities().google`), so a deployment
 * without the portal Google client answers W4's shape byte-identically. The
 * portal reads a missing `google` as false.
 */
oidcRoutes.get('/auth/methods', async (c) => {
  c.header('Cache-Control', 'no-store');
  const caps = getPortalSignInCapabilities();
  // `requestAccess` (W6, decision B of 2026-11-11, spec §5.9): never on the
  // shared host. There it would show every customer of every MSP a link that
  // works only for orgs that opted in. The link appears only on a verified
  // custom portal domain whose org has the mode on (below). /request-access
  // still answers by direct URL with the uniform 200, so no oracle either way,
  // and there is deliberately no deployment-wide "does any org use it" read.
  const shared = { password: true, microsoft: caps.entra, ...googleKey(caps.google, true), requestAccess: false };
  const orgId = await hostOrgIdFor(c);
  if (!orgId) return c.json(shared);
  try {
    const policy = await resolvePortalAccessPolicy(orgId);
    // A verified custom domain: that org's own mode (masked to `off` while the
    // capability is off) AND at least one domain verified right now. The W5
    // read runs with no DB context held (public route).
    const requestAccess = policy.effective.selfRegistrationMode.value !== 'off'
      && (await listVerifiedDomainsForOrg(orgId)).length > 0;
    return c.json({
      password: isSignInMethodAllowed(policy, 'password'),
      microsoft: getPortalEntraConfig() !== null && isSignInMethodAllowed(policy, 'entra'),
      ...googleKey(caps.google, getPortalGoogleConfig() !== null && isSignInMethodAllowed(policy, 'google')),
      requestAccess,
    });
  } catch (error) {
    // Thrown in JS after the read (no DB context is held on this public route).
    if (error instanceof PortalAccessPolicyOrgNotFoundError) return c.json(shared);
    throw error;
  }
});

// ============================================
// Start (public)
// ============================================

const startSchema = z.discriminatedUnion('purpose', [
  z.object({ purpose: z.literal('login') }).strict(),
  z.object({ purpose: z.literal('invite'), inviteToken: z.string().min(1).max(512) }).strict(),
]);

oidcRoutes.post('/auth/oidc/entra/start', zValidator('json', startSchema), async (c) => {
  sweepPortalState();
  const cfg = getPortalEntraConfig();
  if (!cfg) return c.json({ error: 'Not found' }, 404);

  const rate = await checkRateLimit(ipRateKey('start', c), START_RATE_LIMIT);
  if (!rate.allowed) {
    c.header('Retry-After', String(rate.retryAfterSeconds));
    return c.json({ error: 'Too many attempts. Please try again later.' }, 429);
  }

  const body = c.req.valid('json');
  let purpose: PortalOidcPurpose;
  if (body.purpose === 'invite') {
    // Peeked, never consumed: the callback consumes it by its hash after
    // Microsoft. Valid here = valid for a Microsoft acceptance.
    const peeked = await peekPortalCapabilityToken('invite', body.inviteToken);
    const check = peeked ? await validatePortalCapability('invite', peeked, { requirePasswordMethod: false }) : null;
    if (!check?.ok) return c.json({ error: INVALID_INVITE }, 400);
    purpose = { kind: 'invite', inviteTokenHash: hashPortalCapabilityToken(body.inviteToken) };
  } else {
    purpose = { kind: 'login' };
  }

  return startEntraFlow(c, cfg, purpose, await hostOrgIdFor(c));
});

// ============================================
// Link (behind portalAuthMiddleware, mounted in index.ts)
// ============================================

oidcRoutes.post('/auth/oidc/entra/link/start', async (c) => {
  const cfg = getPortalEntraConfig();
  if (!cfg) return c.json({ error: 'Not found' }, 404);

  const csrfError = validatePortalCookieCsrfRequest(c);
  if (csrfError) return c.json({ error: csrfError }, 403);

  const rate = await checkRateLimit(ipRateKey('start', c), START_RATE_LIMIT);
  if (!rate.allowed) {
    c.header('Retry-After', String(rate.retryAfterSeconds));
    return c.json({ error: 'Too many attempts. Please try again later.' }, 429);
  }

  const auth = c.get('portalAuth');
  // The session's account generation (the middleware just checked it equals
  // the session's): the link is refused at callback if it moved since.
  const [account] = await db
    .select({ authEpoch: portalUsers.authEpoch })
    .from(portalUsers)
    .where(and(eq(portalUsers.id, auth.user.id), eq(portalUsers.orgId, auth.user.orgId)))
    .limit(1);
  if (!account) return c.json({ error: 'Invalid or expired session' }, 401);

  // Inside the request's org transaction: the host lookup must see every
  // org's portal_branding row, so it runs in its own system context.
  const hostOrgId = await runOutsideDbContext(() => hostOrgIdFor(c));
  return startEntraFlow(
    c,
    cfg,
    { kind: 'link', portalUserId: auth.user.id, orgId: auth.user.orgId, authEpoch: account.authEpoch },
    hostOrgId,
  );
});

oidcRoutes.get('/auth/oidc/entra/link-status', async (c) => {
  c.header('Cache-Control', 'no-store');
  const auth = c.get('portalAuth');

  let microsoftAllowed: boolean;
  try {
    // Reads under the request's org context (RLS shows the org its own rows).
    microsoftAllowed = isSignInMethodAllowed(await resolvePortalAccessPolicy(auth.user.orgId), 'entra');
  } catch (error) {
    // Thrown in JS after the read: poisons nothing in the held transaction.
    if (!(error instanceof PortalAccessPolicyOrgNotFoundError)) throw error;
    microsoftAllowed = false;
  }
  const [identity] = await db
    .select({ id: portalUserIdentities.id })
    .from(portalUserIdentities)
    .where(and(
      eq(portalUserIdentities.portalUserId, auth.user.id),
      eq(portalUserIdentities.orgId, auth.user.orgId),
      eq(portalUserIdentities.provider, PROVIDER),
    ))
    .limit(1);

  return c.json({ available: getPortalEntraConfig() !== null && microsoftAllowed, linked: identity !== undefined });
});

// ============================================
// Invite methods (public; the accept-invite buckets)
// ============================================

const inviteMethodsSchema = z.object({ token: z.string().min(1).max(512) });

oidcRoutes.post('/auth/invite/methods', zValidator('json', inviteMethodsSchema), async (c) => {
  sweepPortalState();
  const { token } = c.req.valid('json');
  const ip = rateLimitIpKey(getClientIp(c));
  for (const rateKey of [`portal:accept:ip:${ip}`, `portal:accept:token:${hashPortalCapabilityToken(token)}`]) {
    const rate = await checkRateLimit(rateKey, RESET_PASSWORD_RATE_LIMIT);
    if (!rate.allowed) {
      c.header('Retry-After', String(rate.retryAfterSeconds));
      return c.json({ error: 'Too many attempts. Please try again later.' }, 429);
    }
  }

  if (PORTAL_USE_REDIS && !getRedis()) {
    return c.json({ error: SERVICE_UNAVAILABLE }, 503);
  }

  // A peek: the token stays for whichever accept the person then uses.
  const peeked = await peekPortalCapabilityToken('invite', token);
  if (!peeked) return c.json({ error: INVALID_INVITE }, 400);

  // Exactly what each accept path would decide: the password accept-invite's
  // validation, and the SSO one plus the org's effective Microsoft and Google
  // gates (one policy read for both).
  const passwordCheck = await validatePortalCapability('invite', peeked);
  const ssoCheck = await validatePortalCapability('invite', peeked, { requirePasswordMethod: false });
  const entraConfigured = getPortalEntraConfig() !== null;
  const googleConfigured = getPortalGoogleConfig() !== null;
  let microsoft = false;
  let google = false;
  if (ssoCheck.ok && (entraConfigured || googleConfigured)) {
    try {
      const policy = await resolvePortalAccessPolicy(ssoCheck.user.orgId);
      microsoft = entraConfigured && isSignInMethodAllowed(policy, 'entra');
      google = googleConfigured && isSignInMethodAllowed(policy, 'google');
    } catch (error) {
      if (!(error instanceof PortalAccessPolicyOrgNotFoundError)) throw error;
    }
  }
  const password = passwordCheck.ok;

  // Uniform: an unusable invite looks the same however it is unusable. It is
  // unusable only when no method can accept it (W7 D10).
  if (!password && !microsoft && !google) return c.json({ error: INVALID_INVITE }, 400);
  c.header('Cache-Control', 'no-store');
  // `google` ships dark exactly as in /auth/methods.
  return c.json({ password, microsoft, ...googleKey(getPortalSignInCapabilities().google, google) });
});
