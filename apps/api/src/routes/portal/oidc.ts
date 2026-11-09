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
 * Nothing here logs or audits a code, token, id_token, secret or token-endpoint
 * body (D14).
 */
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { db, runOutsideDbContext } from '../../db';
import { portalUserIdentities, portalUsers } from '../../db/schema';
import { zValidator } from '../../lib/validation';
import { envStr } from '../../utils/envStr';
import { getPortalEntraConfig, type PortalEntraConfig } from '../../config/portalEntra';
import { rateLimitIpKey } from '../../services/clientIp';
import { writeAuditEventAsync } from '../../services/auditEvents';
import { captureException } from '../../services/sentry';
import {
  PortalAccessPolicyOrgNotFoundError,
  getPortalSignInCapabilities,
  isSignInMethodAllowed,
  resolvePortalAccessPolicy,
} from '../../services/portalAccessPolicy';
import {
  resolvePortalOidcSignIn,
  type PortalOidcDenyReason,
  type PortalOidcSignInOutcome,
} from '../../services/portalOidc/accountResolution';
import {
  PORTAL_ENTRA_SIGN_IN_SCOPE,
  PortalEntraTokenError,
  buildPortalEntraAuthorizeUrl,
  exchangePortalEntraCode,
  verifyPortalEntraIdToken,
} from '../../services/portalOidc/entraClient';
import {
  PORTAL_OIDC_BINDING_COOKIE,
  PortalOidcStateUnavailableError,
  buildClearPortalOidcBindingCookie,
  buildPortalOidcBindingCookie,
  consumePortalOidcState,
  createPortalOidcState,
} from '../../services/portalOidc/stateStore';
import type { PortalOidcPurpose, PortalOidcVerifiedIdentity } from '../../services/portalOidc/types';
import { getRedis } from '../../services/redis';
import { isRequestConnectionSecure } from '../auth/helpers';
import { resolvePortalHostOrgId } from './branding';
import {
  PORTAL_ENTRA_PROOF_ROUTE,
  auditTenantProofRefusal,
  entraSetupResult,
  handleTenantProofCallback,
  startPortalEntraTenantProof,
} from './oidcTenantProof';
import { PortalSessionStoreUnavailableError, mintPortalBrowserSession } from './browserSession';
import {
  consumePortalCapabilityTokenByHash,
  hashPortalCapabilityToken,
  peekPortalCapabilityToken,
  validatePortalCapability,
} from './capabilityTokens';
import {
  buildPortalUrl,
  checkRateLimit,
  getClientIp,
  getCookieValue,
  sweepPortalState,
  validatePortalCookieCsrfRequest,
} from './helpers';
import { PORTAL_USE_REDIS, RESET_PASSWORD_RATE_LIMIT } from './schemas';

export const oidcRoutes = new Hono();

// ============================================
// Constants
// ============================================

/** Global Constraints: per-IP start limiter (login, invite and link starts share it). */
const START_RATE_LIMIT = { windowMs: 5 * 60 * 1000, maxAttempts: 20, blockMs: 15 * 60 * 1000 };
/** Global Constraints: per-IP callback limiter. */
const CALLBACK_RATE_LIMIT = { windowMs: 5 * 60 * 1000, maxAttempts: 30, blockMs: 15 * 60 * 1000 };

/**
 * User sign-in always uses the `organizations` authority (structural guest
 * refusal, Global Constraints). Only the tenant-proof run pins a tenant and
 * admits that tenant's guests (./oidcTenantProof.ts).
 */
const SIGN_IN_AUTHORITY = 'organizations';
const PROVIDER = 'entra';

/** The same body the password accept-invite answers for any unusable invite. */
const INVALID_INVITE = 'Invalid or expired invite';
const SERVICE_UNAVAILABLE = 'Service temporarily unavailable';

// ============================================
// Result redirects: the ONLY places the callback ever sends the browser
// ============================================

type LoginResult = 'signed_in' | 'request_sent' | 'account_exists' | 'unavailable';
type ProfileResult = 'linked' | 'unavailable';

function loginResult(code: LoginResult): string {
  return buildPortalUrl(`/login?sso=${code}`);
}

function profileResult(code: ProfileResult): string {
  return buildPortalUrl(`/profile?sso=${code}`);
}

/** The generic failure page for a flow's purpose (D15); before a state is read, the login page. */
function failureLocation(purpose: PortalOidcPurpose | undefined): string {
  switch (purpose?.kind) {
    case 'link': return profileResult('unavailable');
    case 'tenant_proof': return entraSetupResult('failed');
    default: return loginResult('unavailable');
  }
}

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

const HOST_NAME = /^[a-z0-9.-]+$/;

/**
 * The request's `Host`, port stripped and lowercased (D5). The portal calls
 * the API same-origin and the proxy keeps `Host`, so this is the portal host
 * the browser used. Never a body or query value. Anything that is not a plain
 * DNS name (an IPv6 literal, garbage) is treated as the shared host.
 */
function requestHost(c: Context): string | null {
  const raw = c.req.header('host')?.trim().toLowerCase();
  if (!raw) return null;
  const host = raw.replace(/:\d+$/, '').replace(/\.$/, '');
  return host && HOST_NAME.test(host) ? host : null;
}

/** The org whose verified custom domain served this request, or null on the shared host. Opens its own system context. */
async function hostOrgIdFor(c: Context): Promise<string | null> {
  const host = requestHost(c);
  return host ? resolvePortalHostOrgId(host) : null;
}

/**
 * `Secure` on the binding cookie (D3): ALWAYS in production. Entra accepts an
 * https redirect URI only (localhost aside), so the callback that reads this
 * cookie is always https there, whatever a proxy reports. Outside production
 * it follows the portal session cookie's rule for a `Lax` cookie: the
 * request's transport (HTTPS or a trusted forwarded `X-Forwarded-Proto`) or an
 * explicit PORTAL_COOKIE_FORCE_SECURE / COOKIE_FORCE_SECURE.
 */
function bindingCookieSecure(c: Context): boolean {
  if (process.env.NODE_ENV === 'production') return true;
  const forced = envStr('PORTAL_COOKIE_FORCE_SECURE', envStr('COOKIE_FORCE_SECURE', '')).toLowerCase();
  return forced === '1' || forced === 'true' || isRequestConnectionSecure(c);
}

function ipRateKey(prefix: 'start' | 'callback', c: Context): string {
  return `portal:oidc:${prefix}:ip:${rateLimitIpKey(getClientIp(c))}`;
}

/** Mint the state, set the binding cookie, answer `{ redirectUrl }`. 503 when the state store is unavailable. */
async function startFlow(c: Context, cfg: PortalEntraConfig, purpose: PortalOidcPurpose, hostOrgId: string | null) {
  let flow: Awaited<ReturnType<typeof createPortalOidcState>>;
  try {
    flow = await createPortalOidcState({ provider: PROVIDER, purpose, hostOrgId, authority: SIGN_IN_AUTHORITY });
  } catch (error) {
    if (error instanceof PortalOidcStateUnavailableError) return c.json({ error: SERVICE_UNAVAILABLE }, 503);
    throw error;
  }
  const redirectUrl = buildPortalEntraAuthorizeUrl(cfg, {
    authority: SIGN_IN_AUTHORITY,
    scope: PORTAL_ENTRA_SIGN_IN_SCOPE,
    state: flow.state,
    nonce: flow.nonce,
    codeChallenge: flow.codeChallenge,
  });
  c.header('Set-Cookie', buildPortalOidcBindingCookie(flow.bindingCookie, { secure: bindingCookieSecure(c) }), { append: true });
  c.header('Cache-Control', 'no-store');
  return c.json({ redirectUrl });
}

// ============================================
// Audit (the callback is a GET: the POST-only portal auth audit wrapper skips it)
// ============================================

type CallbackFailureReason =
  | PortalOidcDenyReason
  | 'rate_limited'
  | 'not_configured'
  | 'query_invalid'
  | 'provider_error'
  | 'state_invalid'
  | 'token_invalid'
  | 'session_unavailable'
  | 'internal_error';

interface OidcAuditInput {
  action: 'portal.auth.oidc.login' | 'portal.auth.identity.link';
  orgId: string | null;
  portalUserId: string | null;
  result: 'success' | 'failure';
  details: Record<string, unknown>;
}

/** One secret-free row. A failed audit write never changes the redirect. */
async function writeOidcAudit(c: Context, input: OidcAuditInput): Promise<void> {
  try {
    await writeAuditEventAsync(c, {
      orgId: input.orgId,
      actorType: input.portalUserId ? 'user' : 'system',
      // Null → the anonymous actor id (no `rawActorId` noise in the details).
      actorId: input.portalUserId,
      initiatedBy: 'manual',
      action: input.action,
      resourceType: input.portalUserId ? 'portal_user' : 'portal_auth',
      resourceId: input.portalUserId,
      result: input.result,
      details: input.details,
    });
  } catch (error) {
    console.error('[portal] Microsoft sign-in audit write failed:', error instanceof Error ? error.message : error);
    captureException(error instanceof Error ? error : new Error(String(error)));
  }
}

/**
 * A refused sign-in: the reason goes to the audit row and the log only (D15).
 * A proof flow refused here (before its branch) is audited as a refused proof
 * on the run's org; its branch audits its own refusals.
 */
async function refuse(
  c: Context,
  reason: CallbackFailureReason,
  ctx: { purpose?: PortalOidcPurpose; orgId?: string | null },
): Promise<string> {
  const purpose = ctx.purpose;
  console.warn('[portal] Microsoft sign-in refused', { reason, purpose: purpose?.kind ?? null, orgId: ctx.orgId ?? null });
  if (purpose?.kind === 'tenant_proof') {
    await auditTenantProofRefusal(c, purpose.orgId, reason);
  } else {
    await writeOidcAudit(c, {
      action: 'portal.auth.oidc.login',
      orgId: ctx.orgId ?? (purpose?.kind === 'link' ? purpose.orgId : null),
      portalUserId: purpose?.kind === 'link' ? purpose.portalUserId : null,
      result: 'failure',
      details: { provider: PROVIDER, outcome: 'denied', reason },
    });
  }
  return failureLocation(purpose);
}

// ============================================
// Callback
// ============================================

type CallbackQuery =
  | { kind: 'code'; state: string; code: string }
  | { kind: 'provider_error'; state: string | null };

const CALLBACK_CODE_KEYS: ReadonlySet<string> = new Set(['code', 'state', 'session_state']);

function single(params: URLSearchParams, name: string): string | null {
  const values = params.getAll(name);
  return values.length === 1 ? values[0]! : null;
}

function validOpaque(value: string | null, maxLength: number): value is string {
  return value !== null && value.length > 0 && value.length <= maxLength && !/[\u0000-\u001f\u007f]/.test(value);
}

/**
 * Strict allowlist parse of the authorization response (`response_mode=query`),
 * the approach of `parseM365ConsentCallbackQuery`. A response carrying `error`
 * is a provider error whatever else it carries (its single, well-formed
 * `state` is still consumed so it cannot be replayed). Otherwise only `code`,
 * `state` and `session_state`, each exactly once; anything else is null.
 */
function parseCallbackQuery(params: URLSearchParams): CallbackQuery | null {
  if (params.has('error')) {
    const state = single(params, 'state');
    return { kind: 'provider_error', state: validOpaque(state, 512) ? state : null };
  }
  const keys = [...params.keys()];
  if (new Set(keys).size !== keys.length) return null;
  if (keys.some((key) => !CALLBACK_CODE_KEYS.has(key))) return null;
  const state = single(params, 'state');
  const code = single(params, 'code');
  if (!validOpaque(state, 512) || !validOpaque(code, 8192)) return null;
  if (params.has('session_state') && !validOpaque(single(params, 'session_state'), 256)) return null;
  return { kind: 'code', state, code };
}

type VerifiedEntraIdentity = PortalOidcVerifiedIdentity & { entraTenantId: string };

/**
 * The real invite consumer the resolver calls (step 2): GET+DEL by the hash the
 * state carries, then the W2 re-check without the password requirement. It
 * answers the epoch the invite was ISSUED at; the resolver re-checks it under
 * a row lock.
 */
async function consumeInviteForMicrosoft(
  inviteTokenHash: string,
): Promise<{ portalUserId: string; orgId: string; authEpoch: number } | null> {
  const consumed = await consumePortalCapabilityTokenByHash('invite', inviteTokenHash);
  if (!consumed || consumed.format !== 'v2') return null;
  const check = await validatePortalCapability('invite', consumed, { requirePasswordMethod: false });
  if (!check.ok) return null;
  return { portalUserId: check.user.id, orgId: check.user.orgId, authEpoch: consumed.payload.authEpoch };
}

/** Step 6–7: map the resolver's outcome to a redirect, minting the session and auditing. */
async function finishSignIn(
  c: Context,
  purpose: Exclude<PortalOidcPurpose, { kind: 'tenant_proof' }>,
  outcome: PortalOidcSignInOutcome,
): Promise<string> {
  if (outcome.kind === 'denied') return refuse(c, outcome.reason, { purpose, orgId: outcome.orgId });

  // A link flow only ever ends linked (or denied, above).
  if (purpose.kind === 'link') {
    if (outcome.kind !== 'linked') return refuse(c, 'link_invalid', { purpose, orgId: outcome.orgId });
    await writeOidcAudit(c, {
      action: 'portal.auth.identity.link',
      orgId: outcome.orgId,
      portalUserId: outcome.portalUserId,
      result: 'success',
      details: { provider: PROVIDER, linkedVia: 'self_link' },
    });
    return profileResult('linked');
  }

  switch (outcome.kind) {
    case 'session': {
      // An invite activation has already committed (account active, identity
      // linked): record it whether or not the session store takes the session.
      if (outcome.via === 'invite') {
        await writeOidcAudit(c, {
          action: 'portal.auth.identity.link',
          orgId: outcome.orgId,
          portalUserId: outcome.portalUserId,
          result: 'success',
          details: { provider: PROVIDER, linkedVia: 'invite' },
        });
      }
      try {
        await mintPortalBrowserSession(c, {
          portalUserId: outcome.portalUserId,
          orgId: outcome.orgId,
          authEpoch: outcome.authEpoch,
          method: 'entra',
          entraTenantId: outcome.entraTenantId,
        });
      } catch (error) {
        if (error instanceof PortalSessionStoreUnavailableError) {
          return refuse(c, 'session_unavailable', { purpose, orgId: outcome.orgId });
        }
        throw error;
      }
      if (outcome.via !== 'invite') {
        await writeOidcAudit(c, {
          action: 'portal.auth.oidc.login',
          orgId: outcome.orgId,
          portalUserId: outcome.portalUserId,
          result: 'success',
          details: { provider: PROVIDER, outcome: 'session', via: outcome.via },
        });
      }
      return loginResult('signed_in');
    }
    case 'request_sent':
    case 'account_exists':
      await writeOidcAudit(c, {
        action: 'portal.auth.oidc.login',
        orgId: outcome.orgId,
        portalUserId: null,
        result: 'success',
        details: { provider: PROVIDER, outcome: outcome.kind },
      });
      return loginResult(outcome.kind);
    default:
      // `linked` for a non-link purpose cannot happen; fail closed.
      return refuse(c, 'link_invalid', { purpose, orgId: outcome.orgId });
  }
}

/** Steps 1–7. `ctx.purpose` is set as soon as the state is read, so an unexpected throw still lands on the right page. */
async function runCallback(c: Context, ctx: { purpose?: PortalOidcPurpose }): Promise<string> {
  const rate = await checkRateLimit(ipRateKey('callback', c), CALLBACK_RATE_LIMIT);
  if (!rate.allowed) return refuse(c, 'rate_limited', {});

  const cfg = getPortalEntraConfig();
  if (!cfg) return refuse(c, 'not_configured', {});

  // 1. Strict query.
  const query = parseCallbackQuery(new URL(c.req.url).searchParams);
  if (!query) return refuse(c, 'query_invalid', {});
  const bindingCookie = getCookieValue(c.req.header('cookie'), PORTAL_OIDC_BINDING_COOKIE) ?? undefined;

  if (query.kind === 'provider_error') {
    // Burn the state Microsoft echoed (if it is ours and this browser's), to land on the purpose's page.
    const state = query.state ? await consumePortalOidcState(query.state, bindingCookie) : null;
    ctx.purpose = state?.purpose;
    return refuse(c, 'provider_error', { purpose: state?.purpose });
  }

  // 2. Single-use, browser-bound state.
  const state = await consumePortalOidcState(query.state, bindingCookie);
  if (!state) return refuse(c, 'state_invalid', {});
  const purpose = state.purpose;
  ctx.purpose = purpose;

  // 3. Code exchange and id_token verification. A proof run is pinned to its
  // tenant and admits a B2B guest of it (Global Constraints "Proof run": a
  // guest Global Administrator is an admin there; the branch's Graph role
  // check binds to tid/oid). Every other purpose keeps refusing guests.
  let identity: VerifiedEntraIdentity;
  let accessToken: string | null;
  try {
    const tokens = await exchangePortalEntraCode(
      cfg,
      { authority: state.authority, code: query.code, codeVerifier: state.codeVerifier },
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
    return refuse(c, 'token_invalid', { purpose });
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
    inviteConsumer: consumeInviteForMicrosoft,
  });

  // 6–7.
  return finishSignIn(c, purpose, outcome);
}

oidcRoutes.get('/auth/oidc/entra/callback', async (c) => {
  sweepPortalState();
  // Always: the binding is single-use whatever the outcome.
  c.header('Set-Cookie', buildClearPortalOidcBindingCookie({ secure: bindingCookieSecure(c) }), { append: true });
  c.header('Cache-Control', 'no-store');

  const ctx: { purpose?: PortalOidcPurpose } = {};
  let location: string;
  try {
    location = await runCallback(c, ctx);
  } catch (error) {
    // Never a 500 on the IdP round trip. Logged by message only (no token
    // material reaches this point: the token step catches its own errors).
    console.error('[portal] Microsoft sign-in callback failed:', error instanceof Error ? error.message : error);
    location = await refuse(c, 'internal_error', { purpose: ctx.purpose });
  }
  return c.redirect(location, 302);
});

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

/**
 * Shared host: a constant (`password` always offered, Microsoft when the
 * deployment can run it), so it reveals nothing about any org (inv. 8). A
 * verified custom domain: that org's effective policy.
 */
oidcRoutes.get('/auth/methods', async (c) => {
  c.header('Cache-Control', 'no-store');
  const shared = { password: true, microsoft: getPortalSignInCapabilities().entra };
  const orgId = await hostOrgIdFor(c);
  if (!orgId) return c.json(shared);
  try {
    const policy = await resolvePortalAccessPolicy(orgId);
    return c.json({
      password: isSignInMethodAllowed(policy, 'password'),
      microsoft: getPortalEntraConfig() !== null && isSignInMethodAllowed(policy, 'entra'),
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

  return startFlow(c, cfg, purpose, await hostOrgIdFor(c));
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
  return startFlow(
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
  // validation, and the Microsoft one plus the org's effective Microsoft gate.
  const passwordCheck = await validatePortalCapability('invite', peeked);
  const ssoCheck = await validatePortalCapability('invite', peeked, { requirePasswordMethod: false });
  let microsoft = false;
  if (ssoCheck.ok && getPortalEntraConfig() !== null) {
    try {
      microsoft = isSignInMethodAllowed(await resolvePortalAccessPolicy(ssoCheck.user.orgId), 'entra');
    } catch (error) {
      if (!(error instanceof PortalAccessPolicyOrgNotFoundError)) throw error;
    }
  }
  const password = passwordCheck.ok;

  // Uniform: an unusable invite looks the same however it is unusable.
  if (!password && !microsoft) return c.json({ error: INVALID_INVITE }, 400);
  c.header('Cache-Control', 'no-store');
  return c.json({ password, microsoft });
});
