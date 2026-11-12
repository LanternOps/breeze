/**
 * "Sign in with Google" for the customer portal (portal registration W7
 * #11384, plan Task 7; D2, D10–D14; spec §5.6, §5.8, inv. 1, 6, 7).
 *
 * Routes (all under /api/v1/portal):
 *   POST /auth/oidc/google/start          start a login or an invitation-bound sign-in
 *   POST /auth/oidc/google/link/start     link Google to the signed-in account (session + CSRF, index.ts)
 *   GET  /auth/oidc/google/link-status    { available, linked } for the signed-in account (session, index.ts)
 *   GET  /auth/oidc/google/callback       the one Google redirect URI for every purpose (D10)
 * Discovery (`/auth/methods`, `/auth/invite/methods`) stays in ./oidc.ts and
 * gains `google` there.
 *
 * Ships dark: every route here answers 404 while the portal Google client is
 * not configured (config/portalGoogle.ts), the callback included, so an
 * unconfigured deployment exposes no Google surface at all.
 *
 * The callback is W4's (./oidcShared): always 302, always clears the binding
 * cookie, never a 500, one generic failure per purpose with the reason in the
 * audit row and the log only. Its result URLs always end in `&p=google` so
 * the portal shows Google's copy. It differs from Microsoft's in:
 *  - its query parser: Google's redirect carries `scope`, `authuser`, `hd` and
 *    `prompt` (ignored; the query's `hd` is never read, D2);
 *  - the provider check: a Microsoft state is refused before any token
 *    request (and the Microsoft callback refuses a Google state);
 *  - the invite consumer: it peeks the invited account BEFORE consuming and
 *    refuses, without spending the invite, an account that already has a
 *    Google identity (W4 D11, D13; plan Review Focus 4).
 *
 * Custom portal domains keep W4 D5's limit: the binding cookie is host-only
 * and the callback is on the fixed callback origin, so a flow started on a
 * custom domain whose host differs cannot complete; the host binding is still
 * recorded and enforced (fails closed).
 *
 * Nothing here logs or audits a code, token, id_token, secret or token-endpoint
 * body (W4 D14).
 */
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { portalUserIdentities, portalUsers } from '../../db/schema';
import { zValidator } from '../../lib/validation';
import { getPortalGoogleConfig, type PortalGoogleConfig } from '../../config/portalGoogle';
import {
  PortalAccessPolicyOrgNotFoundError,
  isSignInMethodAllowed,
  resolvePortalAccessPolicy,
} from '../../services/portalAccessPolicy';
import { resolvePortalOidcSignIn } from '../../services/portalOidc/accountResolution';
import {
  PortalGoogleTokenError,
  buildPortalGoogleAuthorizeUrl,
  exchangePortalGoogleCode,
  verifyPortalGoogleIdToken,
} from '../../services/portalOidc/googleClient';
import type { PortalGoogleVerifiedIdentity, PortalOidcPurpose } from '../../services/portalOidc/types';
import { PORTAL_GOOGLE_ISSUER } from '../../services/portalOidc/validators';
import { hostOrgIdFor } from './requestHost';
import {
  hashPortalCapabilityToken,
  peekPortalCapabilityToken,
  peekPortalCapabilityTokenByHash,
  validatePortalCapability,
} from './capabilityTokens';
import { checkRateLimit, sweepPortalState, validatePortalCookieCsrfRequest } from './helpers';
import {
  CALLBACK_RATE_LIMIT,
  INVALID_INVITE,
  START_RATE_LIMIT,
  answerCallback,
  consumeInviteForSso,
  finishSignIn,
  ipRateKey,
  parseGoogleCallbackQuery,
  readCallbackState,
  refuse,
  startFlow,
  type CallbackContext,
} from './oidcShared';

export const oidcGoogleRoutes = new Hono();

const PROVIDER = 'google';
const NOT_FOUND = { error: 'Not found' };
const TOO_MANY = { error: 'Too many attempts. Please try again later.' };

// ============================================
// Test seam (no network in tests)
// ============================================

interface PortalOidcGoogleTestDeps {
  /** Replaces the token endpoint call. */
  fetch?: typeof fetch;
  /** Replaces Google's JWKS for id_token verification. */
  verificationKey?: CryptoKey;
}

let googleTestDeps: PortalOidcGoogleTestDeps = {};

/** Test seam for the Google token endpoint and signing key. Refuses outside NODE_ENV=test. */
export const __testOnly = {
  setGoogleDeps(deps: PortalOidcGoogleTestDeps | null): void {
    if (process.env.NODE_ENV !== 'test') {
      throw new Error('routes/portal/oidcGoogle __testOnly.setGoogleDeps is only available when NODE_ENV=test');
    }
    googleTestDeps = deps ? { ...deps } : {};
  },
};

// ============================================
// Helpers
// ============================================

/** Mint the state, set the binding cookie, answer `{ redirectUrl }`. 503 when the state store is unavailable. */
function startGoogleFlow(c: Context, cfg: PortalGoogleConfig, purpose: PortalOidcPurpose, hostOrgId: string | null) {
  return startFlow(c, { provider: PROVIDER, purpose, hostOrgId, authority: PORTAL_GOOGLE_ISSUER }, (flow) =>
    buildPortalGoogleAuthorizeUrl(cfg, flow));
}

/**
 * Whether the account already has a Google identity (D13: an invite never
 * gives an account a second one). Its own system context: the public routes
 * hold none, and the callback must not run inside one.
 */
async function accountHasGoogleIdentity(portalUserId: string, orgId: string): Promise<boolean> {
  const [row] = await withSystemDbAccessContext(() =>
    db
      .select({ id: portalUserIdentities.id })
      .from(portalUserIdentities)
      .where(and(
        eq(portalUserIdentities.portalUserId, portalUserId),
        eq(portalUserIdentities.orgId, orgId),
        eq(portalUserIdentities.provider, PROVIDER),
      ))
      .limit(1));
  return row !== undefined;
}

/**
 * The resolver's invite consumer for Google (W4 D11, plan Review Focus 4). The
 * resolver learns the invited account only by consuming the invite, and a
 * consumed invite is spent even when the resolver then refuses. So the
 * invite is PEEKED by the hash the state carries first: an account that
 * already holds a Google identity is refused (null → `invite_invalid`)
 * without consuming. Everything else goes to the shared consumer (GET+DEL,
 * then the W2 re-check), and the resolver re-checks the identity under the
 * account's row lock (a link that lands in between still refuses, spent).
 */
async function consumeInviteForGoogle(
  inviteTokenHash: string,
): Promise<{ portalUserId: string; orgId: string; authEpoch: number } | null> {
  const peeked = await peekPortalCapabilityTokenByHash('invite', inviteTokenHash);
  if (peeked?.format === 'v2' && await accountHasGoogleIdentity(peeked.payload.portalUserId, peeked.payload.orgId)) {
    return null;
  }
  return consumeInviteForSso(inviteTokenHash);
}

// ============================================
// Callback
// ============================================

/** Steps 1–7. `ctx.purpose` is set as soon as the state is read, so an unexpected throw still lands on the right page. */
async function runCallback(c: Context, cfg: PortalGoogleConfig, ctx: CallbackContext): Promise<string> {
  const rate = await checkRateLimit(ipRateKey('callback', c), CALLBACK_RATE_LIMIT);
  if (!rate.allowed) return refuse(c, 'rate_limited', { provider: PROVIDER });

  // 1. Google's query (extra parameters ignored, `hd` never read).
  const query = parseGoogleCallbackQuery(new URL(c.req.url).searchParams);
  if (!query) return refuse(c, 'query_invalid', { provider: PROVIDER });

  // 2. Single-use, browser-bound state of THIS provider (a Microsoft state is refused here).
  const read = await readCallbackState(c, PROVIDER, query, ctx);
  if (!read.ok) return read.location;
  const { state, code } = read;
  const purpose = state.purpose;
  // The state store never accepts a Google tenant proof; narrow for the types, fail closed.
  if (purpose.kind === 'tenant_proof') return refuse(c, 'state_invalid', { provider: PROVIDER });

  // 3. Code exchange and id_token verification (plan D1).
  let identity: PortalGoogleVerifiedIdentity;
  try {
    const tokens = await exchangePortalGoogleCode(
      cfg,
      { code, codeVerifier: state.codeVerifier },
      googleTestDeps.fetch ? { fetch: googleTestDeps.fetch } : {},
    );
    identity = await verifyPortalGoogleIdToken(
      tokens.idToken,
      { clientId: cfg.clientId, nonce: state.nonce },
      googleTestDeps.verificationKey ? { verificationKey: googleTestDeps.verificationKey } : {},
    );
  } catch (error) {
    // The client already logged the failed check; anything else is logged here by name only.
    if (!(error instanceof PortalGoogleTokenError)) {
      console.warn('[portal] Google sign-in token step failed', { error: error instanceof Error ? error.name : 'unknown' });
    }
    return refuse(c, 'token_invalid', { purpose, provider: PROVIDER });
  }

  // 4. Account resolution (no DB context is held on this public route).
  const outcome = await resolvePortalOidcSignIn({
    identity,
    purpose,
    hostOrgId: state.hostOrgId,
    inviteConsumer: consumeInviteForGoogle,
  });

  // 5–7.
  return finishSignIn(c, PROVIDER, purpose, outcome);
}

oidcGoogleRoutes.get('/auth/oidc/google/callback', (c) => {
  const cfg = getPortalGoogleConfig();
  // Ships dark: no Google surface (and no cookie written) until the client is configured.
  if (!cfg) return c.json(NOT_FOUND, 404);
  return answerCallback(c, PROVIDER, (ctx) => runCallback(c, cfg, ctx));
});

// ============================================
// Start (public)
// ============================================

const startSchema = z.discriminatedUnion('purpose', [
  z.object({ purpose: z.literal('login') }).strict(),
  z.object({ purpose: z.literal('invite'), inviteToken: z.string().min(1).max(512) }).strict(),
]);

oidcGoogleRoutes.post('/auth/oidc/google/start', async (c, next) => {
  // Ships dark: 404 before the body is even parsed.
  if (!getPortalGoogleConfig()) return c.json(NOT_FOUND, 404);
  return next();
}, zValidator('json', startSchema), async (c) => {
  sweepPortalState();
  const cfg = getPortalGoogleConfig();
  if (!cfg) return c.json(NOT_FOUND, 404);

  const rate = await checkRateLimit(ipRateKey('start', c), START_RATE_LIMIT);
  if (!rate.allowed) {
    c.header('Retry-After', String(rate.retryAfterSeconds));
    return c.json(TOO_MANY, 429);
  }

  const body = c.req.valid('json');
  let purpose: PortalOidcPurpose;
  if (body.purpose === 'invite') {
    // Peeked, never consumed: the callback consumes it by its hash after
    // Google. Valid here = valid for a Google acceptance, including D13's
    // "the invited account has no Google identity yet" (re-checked at the
    // callback before the invite is consumed).
    const peeked = await peekPortalCapabilityToken('invite', body.inviteToken);
    const check = peeked ? await validatePortalCapability('invite', peeked, { requirePasswordMethod: false }) : null;
    if (!check?.ok) return c.json({ error: INVALID_INVITE }, 400);
    if (await accountHasGoogleIdentity(check.user.id, check.user.orgId)) return c.json({ error: INVALID_INVITE }, 400);
    purpose = { kind: 'invite', inviteTokenHash: hashPortalCapabilityToken(body.inviteToken) };
  } else {
    purpose = { kind: 'login' };
  }

  return startGoogleFlow(c, cfg, purpose, await hostOrgIdFor(c));
});

// ============================================
// Link (behind portalAuthMiddleware, mounted in index.ts)
// ============================================

oidcGoogleRoutes.post('/auth/oidc/google/link/start', async (c) => {
  const cfg = getPortalGoogleConfig();
  if (!cfg) return c.json(NOT_FOUND, 404);

  const csrfError = validatePortalCookieCsrfRequest(c);
  if (csrfError) return c.json({ error: csrfError }, 403);

  const rate = await checkRateLimit(ipRateKey('start', c), START_RATE_LIMIT);
  if (!rate.allowed) {
    c.header('Retry-After', String(rate.retryAfterSeconds));
    return c.json(TOO_MANY, 429);
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
  return startGoogleFlow(
    c,
    cfg,
    { kind: 'link', portalUserId: auth.user.id, orgId: auth.user.orgId, authEpoch: account.authEpoch },
    hostOrgId,
  );
});

oidcGoogleRoutes.get('/auth/oidc/google/link-status', async (c) => {
  if (!getPortalGoogleConfig()) return c.json(NOT_FOUND, 404);
  c.header('Cache-Control', 'no-store');
  const auth = c.get('portalAuth');

  let googleAllowed: boolean;
  try {
    // Under the request's org context (RLS shows the org its own rows); the
    // resolver runs W5's verified-domain read outside it (D6 context rule).
    googleAllowed = isSignInMethodAllowed(await resolvePortalAccessPolicy(auth.user.orgId), 'google');
  } catch (error) {
    // Thrown in JS after the read: poisons nothing in the held transaction.
    if (!(error instanceof PortalAccessPolicyOrgNotFoundError)) throw error;
    googleAllowed = false;
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

  return c.json({ available: googleAllowed, linked: identity !== undefined });
});
