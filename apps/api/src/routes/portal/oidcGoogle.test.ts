/**
 * Portal "Sign in with Google" routes (portal registration W7 #11384, plan
 * Task 7; D10–D14; inv. 1, 6, 7, 8; Review Focus 1, 4, 5).
 *
 * Unit level, the oidc.test.ts harness: account resolution, the
 * capability-token store, the host lookup, the policy resolver and the audit
 * writer are mocked at their boundaries. The OIDC state store (in-memory
 * twin), the Google client (fed through the route's NODE_ENV=test seam with a
 * stubbed token endpoint and a local RS256 key), the session mint (in-memory),
 * the rate limiter and the portal URL builder are real. Nothing reaches
 * Google. The real-DB end-to-end lives in
 * __tests__/integration/portalGoogleSignIn.integration.test.ts.
 */
import { createHash } from 'crypto';
import { Hono } from 'hono';
import { generateKeyPair, SignJWT } from 'jose';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  googleCfg: { current: null as null | { clientId: string; clientSecret: string; callbackUrl: string } },
  entraCfg: { current: null as null | { clientId: string; clientSecret: string; callbackUrl: string; consentReturnUrl: string } },
  resolveSignIn: vi.fn(),
  hostOrg: vi.fn(),
  peek: vi.fn(),
  peekByHash: vi.fn(),
  validate: vi.fn(),
  consumeByHash: vi.fn(),
  resolvePolicy: vi.fn(),
  verifiedDomains: vi.fn(),
  audit: vi.fn(),
  capture: vi.fn(),
  dbRows: { current: [] as unknown[] },
  ORG: '7c0a1f7e-1111-4222-8333-444455556666',
  USER: '11111111-2222-4333-8444-555566667777',
}));

vi.mock('../../config/portalGoogle', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../config/portalGoogle')>()),
  getPortalGoogleConfig: () => h.googleCfg.current,
}));
vi.mock('../../config/portalEntra', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../config/portalEntra')>()),
  getPortalEntraConfig: () => h.entraCfg.current,
}));
vi.mock('../../services/portalOidc/accountResolution', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/portalOidc/accountResolution')>()),
  resolvePortalOidcSignIn: h.resolveSignIn,
}));
vi.mock('./branding', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./branding')>()),
  resolvePortalHostOrgId: h.hostOrg,
}));
vi.mock('./capabilityTokens', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./capabilityTokens')>()),
  peekPortalCapabilityToken: h.peek,
  peekPortalCapabilityTokenByHash: h.peekByHash,
  validatePortalCapability: h.validate,
  consumePortalCapabilityTokenByHash: h.consumeByHash,
}));
vi.mock('../../services/portalDomainVerification', () => ({ listVerifiedDomainsForOrg: h.verifiedDomains }));
vi.mock('../../services/portalAccessPolicy', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/portalAccessPolicy')>()),
  resolvePortalAccessPolicy: h.resolvePolicy,
}));
vi.mock('../../services/sentry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/sentry')>()),
  captureException: h.capture,
}));
vi.mock('../../services/auditEvents', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/auditEvents')>()),
  writeAuditEventAsync: h.audit,
}));
vi.mock('../../db', () => {
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'from', 'where', 'limit', 'innerJoin', 'leftJoin']) chain[m] = () => chain;
  (chain as { then: unknown }).then = (resolve: (v: unknown) => unknown) => Promise.resolve(h.dbRows.current).then(resolve);
  return {
    db: chain,
    hasDbAccessContext: () => false,
    runOutsideDbContext: <T>(fn: () => T): T => fn(),
    withDbAccessContext: async <T>(_ctx: unknown, fn: () => Promise<T>): Promise<T> => fn(),
    withSystemDbAccessContext: async <T>(fn: () => Promise<T>): Promise<T> => fn(),
    withDbTransaction: async <T>(fn: () => Promise<T>): Promise<T> => fn(),
  };
});
// The real mount (index.ts) is used for the link routes; only the session
// lookup is replaced: a fixed session `good-session` for one portal user.
vi.mock('./auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./auth')>();
  return {
    ...actual,
    portalAuthMiddleware: async (c: import('hono').Context, next: import('hono').Next) => {
      const bearer = c.req.header('authorization');
      const viaCookie = (c.req.header('cookie') ?? '').includes('breeze_portal_session=good-session');
      if (bearer !== 'Bearer good-session' && !viaCookie) {
        return c.json({ error: 'Missing or invalid authorization header' }, 401);
      }
      c.set('portalAuth', {
        user: { id: h.USER, orgId: h.ORG, email: 'pat@contoso.example.com', name: 'Pat', contactId: null, receiveNotifications: true, status: 'active' },
        token: 'good-session',
        authMethod: bearer === 'Bearer good-session' ? 'bearer' : 'cookie',
        timezone: 'UTC',
      });
      return next();
    },
  };
});

import { __testOnly as googleTestOnly, oidcGoogleRoutes } from './oidcGoogle';
import { __testOnly as entraTestOnly, oidcRoutes } from './oidc';
import { portalRoutes } from './index';
import { portalOidcStates, portalRateLimitBuckets, portalSessions } from './helpers';
import { createPortalOidcState } from '../../services/portalOidc/stateStore';
import {
  __testOnly as policyTestOnly,
  pickEffectivePortalAccessPolicy,
} from '../../services/portalAccessPolicy';
import type { PortalOidcDenyReason, PortalOidcSignInOutcome } from '../../services/portalOidc/accountResolution';

const { ORG, USER } = h;
const GOOGLE_CLIENT_ID = '123456789012-abcdefghijklmnop.apps.googleusercontent.com';
const GOOGLE_CFG = {
  clientId: GOOGLE_CLIENT_ID,
  clientSecret: 'portal-google-secret-value',
  callbackUrl: 'https://breeze.example.test/api/v1/portal/auth/oidc/google/callback',
};
const ENTRA_CLIENT_ID = '99999999-8888-4777-8666-555555555555';
const ENTRA_CFG = {
  clientId: ENTRA_CLIENT_ID,
  clientSecret: 'portal-client-secret-value',
  callbackUrl: 'https://breeze.example.test/api/v1/portal/auth/oidc/entra/callback',
  consentReturnUrl: 'https://breeze.example.test/api/v1/portal/auth/oidc/entra/consent-return',
};
const TENANT = '11111111-2222-4333-8444-555555555555';
const OID = '12345678-1234-4234-8234-123456789abc';
const HD = 'contoso.example.com';
const SUB = '109876543210987654321';
const PORTAL = 'https://portal.example.test/portal';
const G_UNAVAILABLE = `${PORTAL}/login?sso=unavailable&p=google`;
const INVALID_INVITE = { error: 'Invalid or expired invite' };

const sha = (raw: string) => createHash('sha256').update(raw).digest('hex');

type KeyPair = Awaited<ReturnType<typeof generateKeyPair>>;
let keys: KeyPair;
const tokenFetch = vi.fn();
const entraTokenFetch = vi.fn();
const savedPortalUrl = process.env.PUBLIC_PORTAL_URL;

beforeAll(async () => {
  keys = await generateKeyPair('RS256', { modulusLength: 2048 });
  process.env.PUBLIC_PORTAL_URL = PORTAL;
});

afterAll(() => {
  if (savedPortalUrl === undefined) delete process.env.PUBLIC_PORTAL_URL;
  else process.env.PUBLIC_PORTAL_URL = savedPortalUrl;
});

const NO_ROW = { entraEnabled: null, googleEnabled: null, passwordMode: null, selfRegistrationMode: null, ssoNewPersonMode: null, ssoSessionMaxHours: null };
/**
 * Built by the real pick. `google_sso_only`: Google on (a verified domain), Microsoft
 * off, password off. `google_allowed`: Google on, password on. `allowed`: password only.
 */
function policyFor(orgId: string, mode: 'allowed' | 'google_allowed' | 'google_sso_only') {
  const org = mode === 'allowed'
    ? null
    : { ...NO_ROW, googleEnabled: true, passwordMode: mode === 'google_sso_only' ? 'sso_only' as const : 'allowed' as const };
  const verified = mode !== 'allowed';
  return {
    orgId, partnerId: 'p-1', entraTenant: null, googleDomains: verified ? [HD] : null,
    ...pickEffectivePortalAccessPolicy(org, null, { entra: true, google: true, selfRegistration: false }, { entraTenantProven: false, googleDomainVerified: verified }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.googleCfg.current = GOOGLE_CFG;
  h.entraCfg.current = ENTRA_CFG;
  h.dbRows.current = [];
  h.hostOrg.mockResolvedValue(null);
  h.audit.mockResolvedValue(undefined);
  h.resolvePolicy.mockImplementation(async (orgId: string) => policyFor(orgId, 'allowed'));
  h.verifiedDomains.mockResolvedValue([]);
  h.peekByHash.mockResolvedValue(null);
  portalOidcStates.clear();
  portalRateLimitBuckets.clear();
  portalSessions.clear();
  policyTestOnly.setCapabilities({ entra: true, google: true, selfRegistration: false });
  tokenFetch.mockReset();
  entraTokenFetch.mockReset();
  googleTestOnly.setGoogleDeps({ fetch: tokenFetch as unknown as typeof fetch, verificationKey: keys.publicKey });
  entraTestOnly.setEntraDeps({ fetch: entraTokenFetch as unknown as typeof fetch, verificationKey: keys.publicKey });
});

afterEach(() => {
  policyTestOnly.setCapabilities(null);
  googleTestOnly.setGoogleDeps(null);
  entraTestOnly.setEntraDeps(null);
});

const app = () => new Hono().route('/', oidcRoutes).route('/', oidcGoogleRoutes);
const portal = () => new Hono().route('/', portalRoutes);

function bindingFrom(res: Response): { cookieHeader: string; setCookie: string } {
  const setCookie = res.headers.getSetCookie().find((c) => c.startsWith('breeze_portal_oidc='));
  if (!setCookie) throw new Error('no binding cookie');
  return { cookieHeader: setCookie.split(';')[0]!, setCookie };
}

async function start(body: unknown = { purpose: 'login' }, init: { headers?: Record<string, string> } = {}) {
  return app().request('/auth/oidc/google/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...init.headers },
    body: JSON.stringify(body),
  });
}

async function started(body: unknown = { purpose: 'login' }) {
  const res = await start(body);
  expect(res.status).toBe(200);
  const url = new URL(((await res.json()) as { redirectUrl: string }).redirectUrl);
  return { url, state: url.searchParams.get('state')!, nonce: url.searchParams.get('nonce')!, cookie: bindingFrom(res).cookieHeader };
}

async function googleIdToken(nonce: string, claims: Record<string, unknown> = {}) {
  return new SignJWT({
    iss: 'https://accounts.google.com', aud: GOOGLE_CLIENT_ID, azp: GOOGLE_CLIENT_ID, sub: SUB, nonce,
    email: `pat@${HD}`, email_verified: true, hd: HD, name: 'Pat Person', ...claims,
  }).setProtectedHeader({ alg: 'RS256' }).setIssuedAt().setExpirationTime('1h').sign(keys.privateKey);
}

function tokenEndpointReturns(token: string) {
  tokenFetch.mockImplementation(async () => new Response(JSON.stringify({ id_token: token, access_token: 'access-token-value' }), {
    status: 200, headers: { 'content-type': 'application/json' },
  }));
}

async function callback(query: string, cookie?: string) {
  return app().request(`/auth/oidc/google/callback?${query}`, { headers: cookie ? { Cookie: cookie } : {} });
}

/** Google's redirect as it really arrives: code + state, plus scope, authuser, hd and prompt. */
const googleQuery = (state: string, extra = '') =>
  `state=${encodeURIComponent(state)}&code=4%2F0Aauth-code-value&scope=email+profile+openid&authuser=0&hd=${HD}&prompt=consent${extra}`;

/** start → Google (stubbed) → callback, with the resolver answering `outcome`. */
async function signInWith(outcome: PortalOidcSignInOutcome, body: unknown = { purpose: 'login' }) {
  h.resolveSignIn.mockResolvedValue(outcome);
  const flow = await started(body);
  tokenEndpointReturns(await googleIdToken(flow.nonce));
  const res = await callback(googleQuery(flow.state), flow.cookie);
  return { res, flow };
}

function expectClearsBinding(res: Response) {
  const clear = res.headers.getSetCookie().find((c) => c.startsWith('breeze_portal_oidc='));
  expect(clear).toBeDefined();
  expect(clear).toContain('Max-Age=0');
  expect(clear).toContain('Path=/api/v1/portal/auth/oidc');
}

const googleSession: Extract<PortalOidcSignInOutcome, { kind: 'session' }> = {
  kind: 'session', portalUserId: USER, orgId: ORG, authEpoch: 6, method: 'google', entraTenantId: null, googleHostedDomain: HD, via: 'identity',
};

const inviteCapability = { format: 'v2', payload: { v: 2, purpose: 'invite', portalUserId: USER, orgId: ORG, email: `pat@${HD}`, authEpoch: 3 } };

describe('POST /auth/oidc/google/start', () => {
  it('start login sets the Lax binding cookie and returns a Google authorize URL with the fixed callback', async () => {
    const res = await start();
    expect(res.status).toBe(200);
    const { setCookie } = bindingFrom(res);
    expect(setCookie).toMatch(/^breeze_portal_oidc=[A-Za-z0-9_-]{43};/);
    expect(setCookie).toContain('Path=/api/v1/portal/auth/oidc');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Lax');
    expect(setCookie).toContain('Max-Age=600');
    expect(res.headers.get('cache-control')).toBe('no-store');

    const url = new URL(((await res.json()) as { redirectUrl: string }).redirectUrl);
    expect(`${url.origin}${url.pathname}`).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('client_id')).toBe(GOOGLE_CLIENT_ID);
    expect(url.searchParams.get('redirect_uri')).toBe(GOOGLE_CFG.callbackUrl);
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('scope')).toBe('openid email profile');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('prompt')).toBe('select_account');
    expect(url.searchParams.get('hd')).toBe('*');

    const stored = JSON.parse(portalOidcStates.get(sha(url.searchParams.get('state')!))!.payload);
    expect(stored).toMatchObject({ provider: 'google', purpose: { kind: 'login' }, hostOrgId: null, authority: 'https://accounts.google.com' });
  });

  it('records the custom-domain host org in the state (D5)', async () => {
    h.hostOrg.mockResolvedValue(ORG);
    const res = await start({ purpose: 'login' }, { headers: { Host: 'portal.contoso.example.com' } });
    const url = new URL(((await res.json()) as { redirectUrl: string }).redirectUrl);
    expect(JSON.parse(portalOidcStates.get(sha(url.searchParams.get('state')!))!.payload).hostOrgId).toBe(ORG);
  });

  it('google invite start with an invalid token → 400 Invalid or expired invite', async () => {
    // inv. 7: unknown token, and a token whose account fails the SSO validation.
    h.peek.mockResolvedValue(null);
    let res = await start({ purpose: 'invite', inviteToken: 'raw-invite-token' });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual(INVALID_INVITE);

    h.peek.mockResolvedValue(inviteCapability);
    h.validate.mockResolvedValue({ ok: false, reason: 'invalid' });
    res = await start({ purpose: 'invite', inviteToken: 'raw-invite-token' });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual(INVALID_INVITE);
    expect(h.validate).toHaveBeenCalledWith('invite', inviteCapability, { requirePasswordMethod: false });
    expect(portalOidcStates.size).toBe(0);
    expect(h.consumeByHash).not.toHaveBeenCalled();
  });

  it('google invite start peeks (never consumes) and stores only the token hash', async () => {
    h.peek.mockResolvedValue(inviteCapability);
    h.validate.mockResolvedValue({ ok: true, user: { id: USER, orgId: ORG, authEpoch: 3 } });
    h.dbRows.current = [];
    const flow = await started({ purpose: 'invite', inviteToken: 'raw-invite-token' });
    const stored = portalOidcStates.get(sha(flow.state))!.payload;
    expect(JSON.parse(stored).purpose).toEqual({ kind: 'invite', inviteTokenHash: sha('raw-invite-token') });
    expect(stored).not.toContain('raw-invite-token');
    expect(h.consumeByHash).not.toHaveBeenCalled();
  });

  it('google invite start for an account that already has a google identity → 400 (D13)', async () => {
    h.peek.mockResolvedValue(inviteCapability);
    h.validate.mockResolvedValue({ ok: true, user: { id: USER, orgId: ORG, authEpoch: 3 } });
    h.dbRows.current = [{ id: 'google-identity-1' }];
    const res = await start({ purpose: 'invite', inviteToken: 'raw-invite-token' });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual(INVALID_INVITE);
    expect(portalOidcStates.size).toBe(0);
  });

  it('the start bucket is shared with Microsoft: switching providers buys no extra attempts (20 per 5 min)', async () => {
    for (let i = 0; i < 10; i += 1) {
      expect((await app().request('/auth/oidc/entra/start', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ purpose: 'login' }),
      })).status).toBe(200);
    }
    for (let i = 0; i < 10; i += 1) expect((await start()).status).toBe(200);
    const res = await start();
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBeTruthy();
  });
});

describe('ships dark', () => {
  it('every google route → 404 when the portal Google client is not configured', async () => {
    h.googleCfg.current = null;
    expect((await start()).status).toBe(404);
    expect((await start({ purpose: 'invite', inviteToken: 'raw-invite-token' })).status).toBe(404);
    const cb = await callback('code=c1&state=s1');
    expect(cb.status).toBe(404);
    expect(cb.headers.getSetCookie()).toEqual([]);
    const auth = { Authorization: 'Bearer good-session' };
    expect((await portal().request('/auth/oidc/google/link/start', { method: 'POST', headers: auth })).status).toBe(404);
    expect((await portal().request('/auth/oidc/google/link-status', { headers: auth })).status).toBe(404);
    expect(portalOidcStates.size).toBe(0);
    expect(tokenFetch).not.toHaveBeenCalled();
    expect(h.audit).not.toHaveBeenCalled();
  });
});

describe('google link routes (mounted behind the portal session in index.ts)', () => {
  const csrf = 'csrf-token-value';

  it('link/start requires a portal session and CSRF', async () => {
    h.dbRows.current = [{ authEpoch: 5 }];
    expect((await portal().request('/auth/oidc/google/link/start', { method: 'POST' })).status).toBe(401);

    const noCsrf = await portal().request('/auth/oidc/google/link/start', {
      method: 'POST', headers: { Cookie: 'breeze_portal_session=good-session' },
    });
    expect(noCsrf.status).toBe(403);
    expect(portalOidcStates.size).toBe(0);

    const ok = await portal().request('/auth/oidc/google/link/start', {
      method: 'POST',
      headers: { Cookie: `breeze_portal_session=good-session; breeze_portal_csrf_token=${csrf}`, 'x-breeze-csrf': csrf },
    });
    expect(ok.status).toBe(200);
    const url = new URL(((await ok.json()) as { redirectUrl: string }).redirectUrl);
    expect(`${url.origin}${url.pathname}`).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    const stored = JSON.parse(portalOidcStates.get(sha(url.searchParams.get('state')!))!.payload);
    expect(stored).toMatchObject({ provider: 'google', purpose: { kind: 'link', portalUserId: USER, orgId: ORG, authEpoch: 5 } });
    expect(bindingFrom(ok).setCookie).toContain('SameSite=Lax');
  });

  it('link-status requires a portal session and reports { available, linked } for google', async () => {
    expect((await portal().request('/auth/oidc/google/link-status')).status).toBe(401);
    const auth = { Authorization: 'Bearer good-session' };

    h.resolvePolicy.mockImplementation(async (orgId: string) => policyFor(orgId, 'google_allowed'));
    h.dbRows.current = [];
    let res = await portal().request('/auth/oidc/google/link-status', { headers: auth });
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({ available: true, linked: false });

    h.dbRows.current = [{ id: 'identity-1' }];
    res = await portal().request('/auth/oidc/google/link-status', { headers: auth });
    expect(await res.json()).toEqual({ available: true, linked: true });

    h.resolvePolicy.mockImplementation(async (orgId: string) => policyFor(orgId, 'allowed'));
    res = await portal().request('/auth/oidc/google/link-status', { headers: auth });
    expect(await res.json()).toEqual({ available: false, linked: true });
  });
});

describe('GET /auth/oidc/google/callback', () => {
  it('session outcome mints a google session pinned to hd → /login?sso=signed_in&p=google', async () => {
    const { res } = await signInWith(googleSession);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(`${PORTAL}/login?sso=signed_in&p=google`);
    expectClearsBinding(res);
    expect(res.headers.getSetCookie().some((c) => c.startsWith('breeze_portal_session='))).toBe(true);
    const [session] = [...portalSessions.values()];
    expect(session).toMatchObject({ portalUserId: USER, orgId: ORG, authEpoch: 6, method: 'google', googleHostedDomain: HD });
    expect(session).not.toHaveProperty('entraTenantId');

    // The resolver got the verified Google identity (issuer normalized, sub, the TOKEN's hd).
    expect(h.resolveSignIn).toHaveBeenCalledWith(expect.objectContaining({
      identity: expect.objectContaining({ provider: 'google', issuer: 'https://accounts.google.com', subject: SUB, googleHostedDomain: HD }),
      purpose: { kind: 'login' },
      hostOrgId: null,
    }));
    const body = new URLSearchParams(String(tokenFetch.mock.calls[0]![1].body));
    expect(body.get('code')).toBe('4/0Aauth-code-value');
    expect(body.get('code_verifier')).toBeTruthy();
    expect(h.audit).toHaveBeenCalledTimes(1);
    const event = h.audit.mock.calls[0]![1];
    expect(event).toMatchObject({
      action: 'portal.auth.oidc.login', result: 'success', orgId: ORG, resourceId: USER,
      details: { provider: 'google', outcome: 'session', via: 'identity' },
    });
    expect(JSON.stringify(event)).not.toContain('auth-code-value');
  });

  it('request_sent, account_exists and an invite activation carry &p=google', async () => {
    for (const kind of ['request_sent', 'account_exists'] as const) {
      h.audit.mockClear();
      const { res } = await signInWith({ kind, orgId: ORG });
      expect(res.headers.get('location')).toBe(`${PORTAL}/login?sso=${kind}&p=google`);
      expect(h.audit.mock.calls[0]![1]).toMatchObject({ details: { provider: 'google', outcome: kind } });
    }
    expect(portalSessions.size).toBe(0);

    h.audit.mockClear();
    h.peek.mockResolvedValue(inviteCapability);
    h.validate.mockResolvedValue({ ok: true, user: { id: USER, orgId: ORG, authEpoch: 3 } });
    h.dbRows.current = [];
    const { res } = await signInWith({ ...googleSession, authEpoch: 4, via: 'invite' }, { purpose: 'invite', inviteToken: 'raw-invite-token' });
    expect(res.headers.get('location')).toBe(`${PORTAL}/login?sso=signed_in&p=google`);
    expect(h.audit.mock.calls.map((call) => call[1].action)).toEqual(['portal.auth.identity.link']);
    expect(h.audit.mock.calls[0]![1]).toMatchObject({ details: { provider: 'google', linkedVia: 'invite' } });
  });

  it('a link flow → /profile?sso=linked&p=google; a denied link → /profile?sso=unavailable&p=google', async () => {
    h.dbRows.current = [{ authEpoch: 5 }];
    for (const [outcome, location] of [
      [{ kind: 'linked', portalUserId: USER, orgId: ORG }, `${PORTAL}/profile?sso=linked&p=google`],
      [{ kind: 'denied', reason: 'identity_conflict', orgId: ORG }, `${PORTAL}/profile?sso=unavailable&p=google`],
    ] as const) {
      h.resolveSignIn.mockResolvedValue(outcome);
      const startRes = await portal().request('/auth/oidc/google/link/start', { method: 'POST', headers: { Authorization: 'Bearer good-session' } });
      const url = new URL(((await startRes.json()) as { redirectUrl: string }).redirectUrl);
      tokenEndpointReturns(await googleIdToken(url.searchParams.get('nonce')!));
      const res = await callback(googleQuery(url.searchParams.get('state')!), bindingFrom(startRes).cookieHeader);
      expect(res.headers.get('location')).toBe(location);
    }
  });

  it('google callback replay → unavailable&p=google', async () => {
    const { res, flow } = await signInWith(googleSession);
    expect(res.headers.get('location')).toBe(`${PORTAL}/login?sso=signed_in&p=google`);
    tokenFetch.mockClear();
    const replay = await callback(googleQuery(flow.state), flow.cookie);
    expect(replay.status).toBe(302);
    expect(replay.headers.get('location')).toBe(G_UNAVAILABLE);
    expectClearsBinding(replay);
    expect(tokenFetch).not.toHaveBeenCalled();
    expect(h.audit.mock.calls.at(-1)![1]).toMatchObject({ details: { provider: 'google', outcome: 'denied', reason: 'state_invalid' } });
  });

  it('google callback from another browser → unavailable&p=google (and the state is burned)', async () => {
    const flow = await started();
    tokenEndpointReturns(await googleIdToken(flow.nonce));
    for (const cookie of [undefined, 'breeze_portal_oidc=another-browser-binding-value-0000000000000']) {
      const res = await callback(googleQuery(flow.state), cookie);
      expect(res.headers.get('location')).toBe(G_UNAVAILABLE);
    }
    // The right browser now finds the state spent.
    expect((await callback(googleQuery(flow.state), flow.cookie)).headers.get('location')).toBe(G_UNAVAILABLE);
    expect(tokenFetch).not.toHaveBeenCalled();
    expect(h.resolveSignIn).not.toHaveBeenCalled();
  });

  it('google callback with error=access_denied, a duplicated code/state/iss, or a foreign iss → unavailable&p=google', async () => {
    const flow = await started();
    // access_denied burns the state it names.
    let res = await callback(`error=access_denied&state=${encodeURIComponent(flow.state)}`, flow.cookie);
    expect(res.headers.get('location')).toBe(G_UNAVAILABLE);
    expect(portalOidcStates.size).toBe(0);
    expect(h.audit.mock.calls.at(-1)![1]).toMatchObject({ details: { provider: 'google', reason: 'provider_error' } });

    for (const extra of [
      '&code=second-code',
      '&state=second-state',
      '&iss=https%3A%2F%2Faccounts.google.com&iss=https%3A%2F%2Faccounts.google.com',
      '&iss=https%3A%2F%2Flogin.microsoftonline.com%2Fcommon%2Fv2.0',
      '&iss=accounts.google.com.attacker.example.com',
      '&error=access_denied&error=other',
    ]) {
      const fresh = await started();
      h.audit.mockClear();
      res = await callback(googleQuery(fresh.state, extra), fresh.cookie);
      expect(res.status, extra).toBe(302);
      expect(res.headers.get('location'), extra).toBe(G_UNAVAILABLE);
      expectClearsBinding(res);
    }
    // No code, an empty state, an over-long code.
    for (const query of ['state=abc', 'code=abc', 'code=&state=abc', `code=${'x'.repeat(8193)}&state=abc`, '']) {
      res = await callback(query);
      expect(res.headers.get('location'), query).toBe(G_UNAVAILABLE);
    }
    expect(tokenFetch).not.toHaveBeenCalled();
    expect(h.resolveSignIn).not.toHaveBeenCalled();
  });

  it('google callback accepts Google\'s extra scope, authuser, hd and prompt parameters and never reads hd', async () => {
    h.resolveSignIn.mockResolvedValue(googleSession);
    const flow = await started();
    tokenEndpointReturns(await googleIdToken(flow.nonce));
    // The query's hd names another domain, and Google's documented iss is present: the org comes from the TOKEN's hd only.
    const query = `code=4%2F0Acode&state=${encodeURIComponent(flow.state)}&scope=openid&authuser=1&hd=attacker.example.com&prompt=none&iss=https%3A%2F%2Faccounts.google.com`;
    const res = await callback(query, flow.cookie);
    expect(res.headers.get('location')).toBe(`${PORTAL}/login?sso=signed_in&p=google`);
    const identity = h.resolveSignIn.mock.calls[0]![0].identity;
    expect(identity.googleHostedDomain).toBe(HD);
    expect(JSON.stringify(h.resolveSignIn.mock.calls)).not.toContain('attacker.example.com');
  });

  it('an entra state at the google callback, and a google state at the entra callback → unavailable before any token request', async () => {
    // A Microsoft flow's state presented at the Google callback.
    const entraStart = await app().request('/auth/oidc/entra/start', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ purpose: 'login' }),
    });
    const entraUrl = new URL(((await entraStart.json()) as { redirectUrl: string }).redirectUrl);
    let res = await callback(googleQuery(entraUrl.searchParams.get('state')!), bindingFrom(entraStart).cookieHeader);
    expect(res.headers.get('location')).toBe(G_UNAVAILABLE);
    expect(tokenFetch).not.toHaveBeenCalled();
    expect(entraTokenFetch).not.toHaveBeenCalled();
    expect(h.audit.mock.calls.at(-1)![1]).toMatchObject({ details: { provider: 'google', outcome: 'denied', reason: 'state_invalid' } });
    expect(portalOidcStates.size).toBe(0); // burned

    // A Google flow's state presented at the Microsoft callback.
    const flow = await started();
    res = await app().request(`/auth/oidc/entra/callback?code=c1&state=${encodeURIComponent(flow.state)}`, { headers: { Cookie: flow.cookie } });
    expect(res.headers.get('location')).toBe(`${PORTAL}/login?sso=unavailable`);
    expect(tokenFetch).not.toHaveBeenCalled();
    expect(entraTokenFetch).not.toHaveBeenCalled();
    expect(h.audit.mock.calls.at(-1)![1]).toMatchObject({ details: { provider: 'entra', outcome: 'denied', reason: 'state_invalid' } });
    expect(h.resolveSignIn).not.toHaveBeenCalled();

    // A provider error at the wrong callback lands on the login page, not the other flow's purpose page.
    const link = await createPortalOidcState({
      provider: 'entra', purpose: { kind: 'link', portalUserId: USER, orgId: ORG, authEpoch: 5 }, hostOrgId: null, authority: 'organizations',
    });
    res = await callback(`error=access_denied&state=${encodeURIComponent(link.state)}`, `breeze_portal_oidc=${link.bindingCookie}`);
    expect(res.headers.get('location')).toBe(G_UNAVAILABLE);
  });

  const DENY_REASONS: PortalOidcDenyReason[] = [
    'org_unresolved', 'host_mismatch', 'org_unavailable', 'method_off', 'identity_other_org', 'identity_conflict',
    'account_inactive', 'invited_only', 'invite_invalid', 'link_invalid', 'requests_capped', 'no_address', 'request_conflict',
  ];

  it.each(DENY_REASONS)('every denied reason maps to the same redirect; the reason goes only to audit (provider google) (%s)', async (reason) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { res } = await signInWith({ kind: 'denied', reason, orgId: ORG });
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe(G_UNAVAILABLE);
      expectClearsBinding(res);
      expect(portalSessions.size).toBe(0);
      expect(h.audit).toHaveBeenCalledTimes(1);
      expect(h.audit.mock.calls[0]![1]).toMatchObject({
        action: 'portal.auth.oidc.login', result: 'failure', orgId: ORG,
        details: { provider: 'google', outcome: 'denied', reason },
      });
    } finally {
      warn.mockRestore();
    }
  });

  it('a token Google is not authoritative for (no hd, unverified email, another audience) → unavailable&p=google, resolver never called', async () => {
    for (const claims of [{ hd: undefined }, { email_verified: false }, { email_verified: 'true' }, { aud: 'other-client.apps.googleusercontent.com' }]) {
      const flow = await started();
      tokenEndpointReturns(await googleIdToken(flow.nonce, claims));
      const res = await callback(googleQuery(flow.state), flow.cookie);
      expect(res.headers.get('location'), JSON.stringify(claims)).toBe(G_UNAVAILABLE);
    }
    const flow = await started();
    tokenEndpointReturns(await googleIdToken('another-nonce'));
    expect((await callback(googleQuery(flow.state), flow.cookie)).headers.get('location')).toBe(G_UNAVAILABLE);
    expect(h.resolveSignIn).not.toHaveBeenCalled();
    expect(h.audit.mock.calls.at(-1)![1]).toMatchObject({ details: { provider: 'google', reason: 'token_invalid' } });
  });

  it('a failing token endpoint → unavailable&p=google, its body never logged or audited', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const flow = await started();
      tokenFetch.mockImplementation(async () => new Response('{"error":"invalid_grant","secret-body-marker":1}', { status: 400 }));
      const res = await callback(googleQuery(flow.state), flow.cookie);
      expect(res.headers.get('location')).toBe(G_UNAVAILABLE);
      expect(JSON.stringify(warn.mock.calls)).not.toContain('secret-body-marker');
      expect(JSON.stringify(h.audit.mock.calls)).not.toContain('secret-body-marker');
    } finally {
      warn.mockRestore();
    }
  });

  it('an entra-shaped session outcome at the google callback is refused (no session)', async () => {
    const { res } = await signInWith({ kind: 'session', portalUserId: USER, orgId: ORG, authEpoch: 6, entraTenantId: TENANT, via: 'identity' });
    expect(res.headers.get('location')).toBe(G_UNAVAILABLE);
    expect(portalSessions.size).toBe(0);
    expect(h.audit.mock.calls.at(-1)![1]).toMatchObject({ details: { provider: 'google', reason: 'internal_error' } });
  });

  it('a mint invariant throw is not swallowed by finishSignIn: it surfaces to the callback envelope (logged as an error, 302, no session)', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { res } = await signInWith({ ...googleSession, googleHostedDomain: 'not a domain' });
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe(G_UNAVAILABLE);
      expect(portalSessions.size).toBe(0);
      expect(JSON.stringify(error.mock.calls)).toContain('googleHostedDomain must be a valid domain');
      expect(h.audit.mock.calls.at(-1)![1]).toMatchObject({ details: { provider: 'google', reason: 'internal_error' } });
      // ...and captured, so an invariant breach is visible (fix round 1), with no token or code content.
      expect(h.capture).toHaveBeenCalledTimes(1);
      const [captured, , tags] = h.capture.mock.calls[0]!;
      expect((captured as Error).message).toContain('googleHostedDomain must be a valid domain');
      expect(tags).toEqual({ area: 'portal-oidc-callback', provider: 'google' });
      expect(JSON.stringify(h.capture.mock.calls)).not.toMatch(/auth-code-value|code=|state=/);
    } finally {
      error.mockRestore();
    }
  });

  it('a resolver failure still answers 302 unavailable&p=google, never a 500', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      h.resolveSignIn.mockRejectedValue(new Error('connection terminated'));
      const flow = await started();
      tokenEndpointReturns(await googleIdToken(flow.nonce));
      const res = await callback(googleQuery(flow.state), flow.cookie);
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe(G_UNAVAILABLE);
      expectClearsBinding(res);
    } finally {
      error.mockRestore();
    }
  });

  it('the callback bucket is shared with Microsoft (30 per 5 min) and still answers 302', async () => {
    for (let i = 0; i < 15; i += 1) await app().request('/auth/oidc/entra/callback?code=c&state=s');
    for (let i = 0; i < 15; i += 1) await callback('code=c&state=s');
    h.audit.mockClear();
    const res = await callback('code=c&state=s');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(G_UNAVAILABLE);
    expect(h.audit.mock.calls[0]![1]).toMatchObject({ details: { provider: 'google', reason: 'rate_limited' } });
  });
});

describe('the google invite consumer (W4 D11, plan RF4)', () => {
  async function consumerFromInviteFlow() {
    h.peek.mockResolvedValue(inviteCapability);
    h.validate.mockResolvedValue({ ok: true, user: { id: USER, orgId: ORG, authEpoch: 3 } });
    h.dbRows.current = [];
    await signInWith({ kind: 'denied', reason: 'invite_invalid', orgId: ORG }, { purpose: 'invite', inviteToken: 'raw-invite-token' });
    return h.resolveSignIn.mock.calls[0]![0].inviteConsumer as (hash: string) => Promise<unknown>;
  }

  it('invite for an account that already has a google identity → invite_invalid, invite not consumed', async () => {
    const inviteConsumer = await consumerFromInviteFlow();
    h.peekByHash.mockResolvedValue(inviteCapability);
    h.dbRows.current = [{ id: 'google-identity-1' }];
    h.consumeByHash.mockResolvedValue(inviteCapability);

    // Null → the resolver answers invite_invalid; the token was only peeked.
    expect(await inviteConsumer(sha('raw-invite-token'))).toBeNull();
    expect(h.peekByHash).toHaveBeenCalledWith('invite', sha('raw-invite-token'));
    expect(h.consumeByHash).not.toHaveBeenCalled();
  });

  it('an account without a google identity: consumed by its hash, validated without the password requirement, issue-time epoch', async () => {
    const inviteConsumer = await consumerFromInviteFlow();
    h.peekByHash.mockResolvedValue(inviteCapability);
    h.dbRows.current = [];
    h.consumeByHash.mockResolvedValue(inviteCapability);
    h.validate.mockClear();
    expect(await inviteConsumer(sha('raw-invite-token'))).toEqual({ portalUserId: USER, orgId: ORG, authEpoch: 3 });
    expect(h.consumeByHash).toHaveBeenCalledWith('invite', sha('raw-invite-token'));
    expect(h.validate).toHaveBeenCalledWith('invite', inviteCapability, { requirePasswordMethod: false });

    // An unknown or already-spent token is still handed to the consumer, which answers null.
    h.peekByHash.mockResolvedValue(null);
    h.consumeByHash.mockResolvedValue(null);
    expect(await inviteConsumer(sha('raw-invite-token'))).toBeNull();
  });
});

describe('discovery', () => {
  it('/auth/methods on the shared host returns a constant google flag', async () => {
    // inv. 8: whatever the policy, the shared host answers the deployment's capability.
    for (const mode of ['allowed', 'google_sso_only'] as const) {
      h.resolvePolicy.mockImplementation(async (orgId: string) => policyFor(orgId, mode));
      const res = await app().request('/auth/methods');
      expect(await res.json()).toEqual({ password: true, microsoft: true, google: true, requestAccess: false });
    }
    expect(h.resolvePolicy).not.toHaveBeenCalled();

    // A deployment without Google: the W4 answer, byte-identical (no google key).
    policyTestOnly.setCapabilities({ entra: true, google: false, selfRegistration: false });
    h.googleCfg.current = null;
    expect(await (await app().request('/auth/methods')).json()).toEqual({ password: true, microsoft: true, requestAccess: false });
  });

  it('/auth/methods on a verified custom domain reflects that org\'s google policy', async () => {
    h.hostOrg.mockResolvedValue(ORG);
    const ask = async () => (await app().request('/auth/methods', { headers: { Host: 'portal.contoso.example.com' } })).json();

    h.resolvePolicy.mockImplementation(async (orgId: string) => policyFor(orgId, 'google_sso_only'));
    expect(await ask()).toEqual({ password: false, microsoft: false, google: true, requestAccess: false });

    h.resolvePolicy.mockImplementation(async (orgId: string) => policyFor(orgId, 'allowed'));
    expect(await ask()).toEqual({ password: true, microsoft: false, google: false, requestAccess: false });

    // The org allows Google but the deployment's client is gone: off.
    h.resolvePolicy.mockImplementation(async (orgId: string) => policyFor(orgId, 'google_allowed'));
    h.googleCfg.current = null;
    expect((await ask() as { google: boolean }).google).toBe(false);
  });

  const methods = (token = 'raw-invite-token') => app().request('/auth/invite/methods', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }),
  });

  it('/auth/invite/methods: sso_only org with only Google → { password: false, microsoft: false, google: true }', async () => {
    h.peek.mockResolvedValue(inviteCapability);
    // The password accept fails (sso_only), the SSO validation passes.
    h.validate.mockImplementation(async (_p: string, _c: unknown, opts?: { requirePasswordMethod?: boolean }) =>
      opts?.requirePasswordMethod === false ? { ok: true, user: { id: USER, orgId: ORG, authEpoch: 3 } } : { ok: false, reason: 'invalid' });
    h.resolvePolicy.mockImplementation(async (orgId: string) => policyFor(orgId, 'google_sso_only'));
    let res = await methods();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ password: false, microsoft: false, google: true });

    // Google off as well: nothing can accept it → the uniform 400.
    h.resolvePolicy.mockImplementation(async (orgId: string) => ({ ...policyFor(orgId, 'allowed') }));
    res = await methods();
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual(INVALID_INVITE);

    // The client is not configured: google false, still a 400 here.
    h.resolvePolicy.mockImplementation(async (orgId: string) => policyFor(orgId, 'google_sso_only'));
    h.googleCfg.current = null;
    res = await methods();
    expect(res.status).toBe(400);
  });
});

describe('entra callback redirects are unchanged (no p parameter) — RF5', () => {
  async function entraIdToken(nonce: string) {
    return new SignJWT({
      tid: TENANT, oid: OID, nonce, ver: '2.0', iss: `https://login.microsoftonline.com/${TENANT}/v2.0`, aud: ENTRA_CLIENT_ID,
      preferred_username: `pat@${HD}`, name: 'Pat Person',
    }).setProtectedHeader({ alg: 'RS256' }).setIssuedAt().setExpirationTime('1h').sign(keys.privateKey);
  }

  it('entra callback redirects are unchanged (no p parameter)', async () => {
    const cases: [PortalOidcSignInOutcome, string][] = [
      [{ kind: 'session', portalUserId: USER, orgId: ORG, authEpoch: 6, entraTenantId: TENANT, via: 'identity' }, `${PORTAL}/login?sso=signed_in`],
      [{ kind: 'request_sent', orgId: ORG }, `${PORTAL}/login?sso=request_sent`],
      [{ kind: 'account_exists', orgId: ORG }, `${PORTAL}/login?sso=account_exists`],
      [{ kind: 'denied', reason: 'method_off', orgId: ORG }, `${PORTAL}/login?sso=unavailable`],
    ];
    for (const [outcome, location] of cases) {
      h.resolveSignIn.mockResolvedValue(outcome);
      const startRes = await app().request('/auth/oidc/entra/start', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ purpose: 'login' }),
      });
      const url = new URL(((await startRes.json()) as { redirectUrl: string }).redirectUrl);
      const idToken = await entraIdToken(url.searchParams.get('nonce')!);
      entraTokenFetch.mockImplementation(async () => new Response(JSON.stringify({ id_token: idToken, access_token: 'a' }), {
        status: 200, headers: { 'content-type': 'application/json' },
      }));
      const res = await app().request(`/auth/oidc/entra/callback?code=c1&state=${encodeURIComponent(url.searchParams.get('state')!)}`, {
        headers: { Cookie: bindingFrom(startRes).cookieHeader },
      });
      expect(res.headers.get('location')).toBe(location);
      expect(res.headers.get('location')).not.toContain('p=');
    }
    // A Microsoft session never carries a google pin.
    expect([...portalSessions.values()][0]).toMatchObject({ method: 'entra', entraTenantId: TENANT });
    expect([...portalSessions.values()][0]).not.toHaveProperty('googleHostedDomain');
  });
});

describe('__testOnly', () => {
  it('refuses outside NODE_ENV=test', () => {
    const saved = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      expect(() => googleTestOnly.setGoogleDeps(null)).toThrow(/only available when NODE_ENV=test/);
    } finally {
      process.env.NODE_ENV = saved;
    }
  });
});
