/**
 * Portal "Sign in with Microsoft" routes (portal registration W4 #11381, plan
 * Task 7; D3, D5, D15; Review Focus 3; inv. 8).
 *
 * Unit level: account resolution, the capability-token store, the host lookup,
 * the policy resolver and the audit writer are mocked at their boundaries. The
 * OIDC state store (in-memory twin), the Entra client (fed through the route's
 * NODE_ENV=test seam with a stubbed token endpoint and a local RS256 key), the
 * session mint (in-memory), the rate limiter and the portal URL builder are
 * real, so replay, browser binding, nonce and the cookies are exercised for
 * real. The real-DB end-to-end lives in
 * __tests__/integration/portalOidcSignIn.integration.test.ts.
 */
import { createHash } from 'crypto';
import { Hono } from 'hono';
import { generateKeyPair, SignJWT } from 'jose';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  cfg: { current: null as null | { clientId: string; clientSecret: string; callbackUrl: string; consentReturnUrl: string } },
  resolveSignIn: vi.fn(),
  hostOrg: vi.fn(),
  peek: vi.fn(),
  validate: vi.fn(),
  consumeByHash: vi.fn(),
  resolvePolicy: vi.fn(),
  audit: vi.fn(),
  capture: vi.fn(),
  dbRows: { current: [] as unknown[] },
  ORG: '7c0a1f7e-1111-4222-8333-444455556666',
  USER: '11111111-2222-4333-8444-555566667777',
}));

vi.mock('../../config/portalEntra', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../config/portalEntra')>()),
  getPortalEntraConfig: () => h.cfg.current,
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
  validatePortalCapability: h.validate,
  consumePortalCapabilityTokenByHash: h.consumeByHash,
}));
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
        user: { id: h.USER, orgId: h.ORG, email: 'pat@acme.test', name: 'Pat', contactId: null, receiveNotifications: true, status: 'active' },
        token: 'good-session',
        authMethod: bearer === 'Bearer good-session' ? 'bearer' : 'cookie',
        timezone: 'UTC',
      });
      return next();
    },
  };
});

import { __testOnly as oidcTestOnly, oidcRoutes } from './oidc';
import { portalRoutes } from './index';
import { portalEntraProofRuns, portalOidcStates, portalRateLimitBuckets, portalSessions } from './helpers';
import { createPortalEntraProofRun, peekPortalEntraProofRun } from '../../services/portalOidc/proofRunStore';
import {
  __testOnly as policyTestOnly,
  pickEffectivePortalAccessPolicy,
} from '../../services/portalAccessPolicy';
import type { PortalOidcDenyReason, PortalOidcSignInOutcome } from '../../services/portalOidc/accountResolution';

const { ORG, USER } = h;
const PARTNER = '3b0a1f7e-1111-4222-8333-444455556666';
const CLIENT_ID = '99999999-8888-4777-8666-555555555555';
const TENANT = '11111111-2222-4333-8444-555555555555';
const OID = '12345678-1234-4234-8234-123456789abc';
const CFG = {
  clientId: CLIENT_ID,
  clientSecret: 'portal-client-secret-value',
  callbackUrl: 'https://breeze.example.test/api/v1/portal/auth/oidc/entra/callback',
  consentReturnUrl: 'https://breeze.example.test/api/v1/portal/auth/oidc/entra/consent-return',
};
/** A B2B guest's home tenant, and the claims marking a guest token issued in another (resource) tenant. */
const GUEST_HOME_TENANT = '33333333-4444-4555-8666-777777777777';
const GUEST_CLAIMS = { idp: `https://sts.windows.net/${GUEST_HOME_TENANT}/`, acct: 1 };
const PORTAL = 'https://portal.example.test/portal';
const UNAVAILABLE = `${PORTAL}/login?sso=unavailable`;
const INVALID_INVITE = { error: 'Invalid or expired invite' };

const sha = (raw: string) => createHash('sha256').update(raw).digest('hex');

type KeyPair = Awaited<ReturnType<typeof generateKeyPair>>;
let keys: KeyPair;
const tokenFetch = vi.fn();
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
/** Built by the real pick: `sso_only` → Microsoft on (tenant proven), password off; `allowed` → password only. */
function policyFor(orgId: string, mode: 'allowed' | 'sso_only' | 'both') {
  const org = mode === 'allowed' ? null : { ...NO_ROW, entraEnabled: true, passwordMode: mode === 'sso_only' ? 'sso_only' as const : 'allowed' as const };
  const proven = mode !== 'allowed';
  return {
    orgId, partnerId: 'p-1',
    entraTenant: proven ? { tenantId: TENANT, provenAt: '2027-01-23T10:00:00.000Z' } : null,
    ...pickEffectivePortalAccessPolicy(org, null, { entra: true, google: false, selfRegistration: false }, { entraTenantProven: proven }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.cfg.current = CFG;
  h.dbRows.current = [];
  h.hostOrg.mockResolvedValue(null);
  h.audit.mockResolvedValue(undefined);
  h.resolvePolicy.mockImplementation(async (orgId: string) => policyFor(orgId, 'allowed'));
  portalOidcStates.clear();
  portalEntraProofRuns.clear();
  portalRateLimitBuckets.clear();
  portalSessions.clear();
  policyTestOnly.setCapabilities({ entra: true, google: false, selfRegistration: false });
  tokenFetch.mockReset();
  oidcTestOnly.setEntraDeps({ fetch: tokenFetch as unknown as typeof fetch, verificationKey: keys.publicKey });
});

afterEach(() => {
  policyTestOnly.setCapabilities(null);
  oidcTestOnly.setEntraDeps(null);
});

const app = () => new Hono().route('/', oidcRoutes);

function bindingFrom(res: Response): { cookieHeader: string; setCookie: string } {
  const setCookie = res.headers.getSetCookie().find((c) => c.startsWith('breeze_portal_oidc='));
  if (!setCookie) throw new Error('no binding cookie');
  return { cookieHeader: setCookie.split(';')[0]!, setCookie };
}

async function start(body: unknown = { purpose: 'login' }, init: { url?: string; headers?: Record<string, string> } = {}) {
  return app().request(init.url ?? '/auth/oidc/entra/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...init.headers },
    body: JSON.stringify(body),
  });
}

/** A started flow: its authorize URL's state and nonce, and the binding cookie to send back. */
async function started(body: unknown = { purpose: 'login' }) {
  const res = await start(body);
  expect(res.status).toBe(200);
  const url = new URL(((await res.json()) as { redirectUrl: string }).redirectUrl);
  return { url, state: url.searchParams.get('state')!, nonce: url.searchParams.get('nonce')!, cookie: bindingFrom(res).cookieHeader };
}

async function idToken(nonce: string, claims: Record<string, unknown> = {}) {
  return new SignJWT({
    tid: TENANT, oid: OID, nonce, ver: '2.0',
    iss: `https://login.microsoftonline.com/${TENANT}/v2.0`, aud: CLIENT_ID,
    preferred_username: 'pat@acme.test', name: 'Pat Person', ...claims,
  }).setProtectedHeader({ alg: 'RS256' }).setIssuedAt().setExpirationTime('1h').sign(keys.privateKey);
}

function tokenEndpointReturns(token: string) {
  tokenFetch.mockImplementation(async () => new Response(JSON.stringify({ id_token: token, access_token: 'access-token-value' }), {
    status: 200, headers: { 'content-type': 'application/json' },
  }));
}

async function callback(query: string, cookie?: string) {
  return app().request(`/auth/oidc/entra/callback?${query}`, { headers: cookie ? { Cookie: cookie } : {} });
}

/** start → Microsoft (stubbed) → callback, with the resolver answering `outcome`. */
async function signInWith(outcome: PortalOidcSignInOutcome, body: unknown = { purpose: 'login' }) {
  h.resolveSignIn.mockResolvedValue(outcome);
  const flow = await started(body);
  tokenEndpointReturns(await idToken(flow.nonce));
  const res = await callback(`code=auth-code-value&state=${encodeURIComponent(flow.state)}&session_state=abc`, flow.cookie);
  return { res, flow };
}

function expectClearsBinding(res: Response) {
  const clear = res.headers.getSetCookie().find((c) => c.startsWith('breeze_portal_oidc='));
  expect(clear).toBeDefined();
  expect(clear).toContain('Max-Age=0');
  expect(clear).toContain('Path=/api/v1/portal/auth/oidc');
}

describe('GET /auth/methods', () => {
  it('methods on the shared host is constant and independent of any org', async () => {
    for (const host of [undefined, 'breeze.example.test']) {
      const res = await app().request('/auth/methods', { headers: host ? { Host: host } : {} });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ password: true, microsoft: true });
    }
    policyTestOnly.setCapabilities({ entra: false, google: false, selfRegistration: false });
    expect(await (await app().request('/auth/methods')).json()).toEqual({ password: true, microsoft: false });
    expect(h.resolvePolicy).not.toHaveBeenCalled();
  });

  it('a verified custom domain answers with that org\'s policy, keyed by the Host header without its port', async () => {
    h.hostOrg.mockImplementation(async (host: string) => (host === 'portal.acme.test' ? ORG : null));
    h.resolvePolicy.mockImplementation(async (orgId: string) => policyFor(orgId, 'sso_only'));
    const res = await app().request('/auth/methods?host=other.test', { headers: { Host: 'Portal.Acme.Test:8443' } });
    expect(await res.json()).toEqual({ password: false, microsoft: true });
    expect(h.hostOrg).toHaveBeenCalledWith('portal.acme.test');
    expect(h.resolvePolicy).toHaveBeenCalledWith(ORG);
  });
});

describe('POST /auth/oidc/entra/start', () => {
  it('start login sets the Lax binding cookie on the oidc path and returns an organizations authorize URL', async () => {
    const res = await start();
    expect(res.status).toBe(200);
    const { setCookie } = bindingFrom(res);
    expect(setCookie).toMatch(/^breeze_portal_oidc=[A-Za-z0-9_-]{43};/);
    expect(setCookie).toContain('Path=/api/v1/portal/auth/oidc');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Lax');
    expect(setCookie).toContain('Max-Age=600');
    expect(setCookie).not.toContain('Secure');

    const url = new URL(((await res.json()) as { redirectUrl: string }).redirectUrl);
    expect(`${url.origin}${url.pathname}`).toBe('https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize');
    expect(url.searchParams.get('client_id')).toBe(CLIENT_ID);
    expect(url.searchParams.get('redirect_uri')).toBe(CFG.callbackUrl);
    expect(url.searchParams.get('scope')).toBe('openid profile email');
    expect(url.searchParams.get('response_mode')).toBe('query');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('prompt')).toBe('select_account');

    // The stored state: purpose login, the shared host (no host org), bound to the cookie.
    const stored = JSON.parse(portalOidcStates.get(sha(url.searchParams.get('state')!))!.payload);
    expect(stored).toMatchObject({ purpose: { kind: 'login' }, hostOrgId: null, authority: 'organizations' });
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('the binding cookie is Secure over HTTPS', async () => {
    const res = await start({ purpose: 'login' }, { url: 'https://portal.example.test/auth/oidc/entra/start' });
    expect(bindingFrom(res).setCookie).toContain('; Secure');
  });

  describe('the binding cookie\'s Secure flag (D3: Secure in production)', () => {
    const TRUSTED_PROXY_IP = '172.31.0.10';
    /** The request arrives from the trusted reverse proxy, which reports the browser's scheme. */
    const viaProxy = { incoming: { socket: { remoteAddress: TRUSTED_PROXY_IP } } };
    const ENV_KEYS = ['NODE_ENV', 'TRUST_PROXY_HEADERS', 'TRUSTED_PROXY_CIDRS', 'PORTAL_COOKIE_FORCE_SECURE', 'COOKIE_FORCE_SECURE'];
    let saved: Record<string, string | undefined> = {};

    beforeEach(() => {
      saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
      process.env.TRUST_PROXY_HEADERS = 'true';
      process.env.TRUSTED_PROXY_CIDRS = `${TRUSTED_PROXY_IP}/32`;
      delete process.env.PORTAL_COOKIE_FORCE_SECURE;
      delete process.env.COOKIE_FORCE_SECURE;
    });

    afterEach(() => {
      for (const key of ENV_KEYS) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
    });

    /** Every binding cookie the API sets: the login start, the proof-run link, and the callback's clear. */
    async function bindingCookies(forwardedProto: 'http' | 'https'): Promise<string[]> {
      const headers = { 'X-Forwarded-Proto': forwardedProto };
      const startRes = await app().request('/auth/oidc/entra/start', {
        method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ purpose: 'login' }),
      }, viaProxy);
      const run = await createPortalEntraProofRun({ orgId: ORG, partnerId: PARTNER, createdByUserId: USER, expectedTenantId: TENANT });
      const proofRes = await app().request(`/auth/oidc/entra/proof?run=${encodeURIComponent(run.token)}`, { headers }, viaProxy);
      const callbackRes = await app().request('/auth/oidc/entra/callback?code=c1&state=s1', { headers }, viaProxy);
      expect([startRes.status, proofRes.status, callbackRes.status]).toEqual([200, 302, 302]);
      return [startRes, proofRes, callbackRes].map((res) => bindingFrom(res).setCookie);
    }

    async function inProduction<T>(fn: () => Promise<T>): Promise<T> {
      const before = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';
      try {
        return await fn();
      } finally {
        process.env.NODE_ENV = before;
      }
    }

    it('production: Secure on every binding cookie, even when the trusted proxy reports HTTP', async () => {
      const cookies = await inProduction(() => bindingCookies('http'));
      expect(cookies).toHaveLength(3);
      for (const cookie of cookies) expect(cookie).toContain('; Secure');
    });

    it('outside production: follows the trusted transport', async () => {
      for (const cookie of await bindingCookies('http')) expect(cookie).not.toContain('Secure');
      for (const cookie of await bindingCookies('https')) expect(cookie).toContain('; Secure');
    });

    it.each(['PORTAL_COOKIE_FORCE_SECURE', 'COOKIE_FORCE_SECURE'])('outside production: %s=true forces Secure over HTTP', async (flag) => {
      process.env[flag] = 'true';
      for (const cookie of await bindingCookies('http')) expect(cookie).toContain('; Secure');
    });
  });

  it('records the custom-domain host org in the state (D5)', async () => {
    h.hostOrg.mockResolvedValue(ORG);
    const res = await start({ purpose: 'login' }, { headers: { Host: 'portal.acme.test' } });
    const url = new URL(((await res.json()) as { redirectUrl: string }).redirectUrl);
    expect(JSON.parse(portalOidcStates.get(sha(url.searchParams.get('state')!))!.payload).hostOrgId).toBe(ORG);
  });

  it('start invite with an invalid token → 400 Invalid or expired invite (same body as accept-invite)', async () => {
    h.peek.mockResolvedValue(null);
    let res = await start({ purpose: 'invite', inviteToken: 'unknown-token' });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual(INVALID_INVITE);

    h.peek.mockResolvedValue({ format: 'v2', payload: { v: 2, purpose: 'invite', portalUserId: USER, orgId: ORG, email: 'pat@acme.test', authEpoch: 3 } });
    h.validate.mockResolvedValue({ ok: false, reason: 'invalid' });
    res = await start({ purpose: 'invite', inviteToken: 'stale-token' });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual(INVALID_INVITE);
    expect(res.headers.getSetCookie().some((c) => c.startsWith('breeze_portal_oidc='))).toBe(false);
    expect(portalOidcStates.size).toBe(0);
  });

  it('start invite peeks (never consumes) and stores only the token hash', async () => {
    const capability = { format: 'v2', payload: { v: 2, purpose: 'invite', portalUserId: USER, orgId: ORG, email: 'pat@acme.test', authEpoch: 3 } };
    h.peek.mockResolvedValue(capability);
    h.validate.mockResolvedValue({ ok: true, user: { id: USER, orgId: ORG } });
    const flow = await started({ purpose: 'invite', inviteToken: 'raw-invite-token' });
    expect(h.peek).toHaveBeenCalledWith('invite', 'raw-invite-token');
    expect(h.validate).toHaveBeenCalledWith('invite', capability, { requirePasswordMethod: false });
    expect(h.consumeByHash).not.toHaveBeenCalled();
    const stored = portalOidcStates.get(sha(flow.state))!.payload;
    expect(JSON.parse(stored).purpose).toEqual({ kind: 'invite', inviteTokenHash: sha('raw-invite-token') });
    expect(stored).not.toContain('raw-invite-token');
  });

  it('start returns 404 when the portal Entra app is not configured', async () => {
    h.cfg.current = null;
    const res = await start();
    expect(res.status).toBe(404);
    expect(res.headers.getSetCookie()).toEqual([]);
  });

  it('is rate limited per IP (20 per 5 min)', async () => {
    for (let i = 0; i < 20; i++) expect((await start()).status).toBe(200);
    const res = await start();
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBeTruthy();
  });
});

describe('link routes (mounted behind the portal session in index.ts)', () => {
  const portal = () => new Hono().route('/', portalRoutes);
  const csrf = 'csrf-token-value';

  it('link/start requires a portal session and CSRF', async () => {
    h.dbRows.current = [{ authEpoch: 5 }];
    const noSession = await portal().request('/auth/oidc/entra/link/start', { method: 'POST' });
    expect(noSession.status).toBe(401);

    const noCsrf = await portal().request('/auth/oidc/entra/link/start', {
      method: 'POST', headers: { Cookie: 'breeze_portal_session=good-session' },
    });
    expect(noCsrf.status).toBe(403);
    expect(portalOidcStates.size).toBe(0);

    const ok = await portal().request('/auth/oidc/entra/link/start', {
      method: 'POST',
      headers: { Cookie: `breeze_portal_session=good-session; breeze_portal_csrf_token=${csrf}`, 'x-breeze-csrf': csrf },
    });
    expect(ok.status).toBe(200);
    const url = new URL(((await ok.json()) as { redirectUrl: string }).redirectUrl);
    expect(JSON.parse(portalOidcStates.get(sha(url.searchParams.get('state')!))!.payload).purpose)
      .toEqual({ kind: 'link', portalUserId: USER, orgId: ORG, authEpoch: 5 });
    expect(bindingFrom(ok).setCookie).toContain('SameSite=Lax');
  });

  it('link/start → 404 when not configured', async () => {
    h.cfg.current = null;
    const res = await portal().request('/auth/oidc/entra/link/start', { method: 'POST', headers: { Authorization: 'Bearer good-session' } });
    expect(res.status).toBe(404);
  });

  it('link-status requires a portal session and reports availability and the link', async () => {
    expect((await portal().request('/auth/oidc/entra/link-status')).status).toBe(401);

    h.resolvePolicy.mockImplementation(async (orgId: string) => policyFor(orgId, 'both'));
    h.dbRows.current = [];
    let res = await portal().request('/auth/oidc/entra/link-status', { headers: { Authorization: 'Bearer good-session' } });
    expect(await res.json()).toEqual({ available: true, linked: false });

    h.dbRows.current = [{ id: 'identity-1' }];
    res = await portal().request('/auth/oidc/entra/link-status', { headers: { Authorization: 'Bearer good-session' } });
    expect(await res.json()).toEqual({ available: true, linked: true });

    h.resolvePolicy.mockImplementation(async (orgId: string) => policyFor(orgId, 'allowed'));
    res = await portal().request('/auth/oidc/entra/link-status', { headers: { Authorization: 'Bearer good-session' } });
    expect(await res.json()).toEqual({ available: false, linked: true });

    h.cfg.current = null;
    h.resolvePolicy.mockImplementation(async (orgId: string) => policyFor(orgId, 'both'));
    res = await portal().request('/auth/oidc/entra/link-status', { headers: { Authorization: 'Bearer good-session' } });
    expect((await res.json() as { available: boolean }).available).toBe(false);
  });
});

describe('GET /auth/oidc/entra/callback', () => {
  const sessionOutcome: Extract<PortalOidcSignInOutcome, { kind: 'session' }> = {
    kind: 'session', portalUserId: USER, orgId: ORG, authEpoch: 6, entraTenantId: TENANT, via: 'identity',
  };

  it('callback session outcome mints an entra session and redirects to /login?sso=signed_in', async () => {
    const { res } = await signInWith(sessionOutcome);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(`${PORTAL}/login?sso=signed_in`);
    expectClearsBinding(res);
    expect(res.headers.getSetCookie().some((c) => c.startsWith('breeze_portal_session='))).toBe(true);

    const [session] = [...portalSessions.values()];
    expect(session).toMatchObject({ portalUserId: USER, orgId: ORG, authEpoch: 6, method: 'entra', entraTenantId: TENANT });

    // The resolver got the verified identity (subject = oid, issuer pinned to the tid) and the state's purpose.
    expect(h.resolveSignIn).toHaveBeenCalledWith(expect.objectContaining({
      identity: expect.objectContaining({ provider: 'entra', issuer: `https://login.microsoftonline.com/${TENANT}/v2.0`, subject: OID, entraTenantId: TENANT }),
      purpose: { kind: 'login' },
      hostOrgId: null,
    }));
    // The token endpoint got the code and PKCE verifier; nothing of either reaches the audit row.
    const body = new URLSearchParams(String(tokenFetch.mock.calls[0]![1].body));
    expect(body.get('code')).toBe('auth-code-value');
    expect(body.get('code_verifier')).toBeTruthy();
    expect(h.audit).toHaveBeenCalledTimes(1);
    const event = h.audit.mock.calls[0]![1];
    expect(event).toMatchObject({
      action: 'portal.auth.oidc.login', result: 'success', orgId: ORG, resourceType: 'portal_user', resourceId: USER,
      details: { provider: 'entra', outcome: 'session', via: 'identity' },
    });
    expect(JSON.stringify(event)).not.toContain('auth-code-value');
  });

  it('callback replay → unavailable', async () => {
    h.resolveSignIn.mockResolvedValue(sessionOutcome);
    const flow = await started();
    tokenEndpointReturns(await idToken(flow.nonce));
    const query = `code=c1&state=${encodeURIComponent(flow.state)}`;
    expect((await callback(query, flow.cookie)).headers.get('location')).toBe(`${PORTAL}/login?sso=signed_in`);

    const replay = await callback(query, flow.cookie);
    expect(replay.status).toBe(302);
    expect(replay.headers.get('location')).toBe(UNAVAILABLE);
    expectClearsBinding(replay);
    expect(h.resolveSignIn).toHaveBeenCalledTimes(1);
    expect(tokenFetch).toHaveBeenCalledTimes(1);
  });

  it('callback from a different browser → unavailable', async () => {
    h.resolveSignIn.mockResolvedValue(sessionOutcome);
    const flow = await started();
    tokenEndpointReturns(await idToken(flow.nonce));
    const other = await started();

    // Another browser's binding cookie, then (state already burned) the right one.
    const wrongCookie = await callback(`code=c1&state=${encodeURIComponent(flow.state)}`, other.cookie);
    expect(wrongCookie.headers.get('location')).toBe(UNAVAILABLE);
    const afterBurn = await callback(`code=c1&state=${encodeURIComponent(flow.state)}`, flow.cookie);
    expect(afterBurn.headers.get('location')).toBe(UNAVAILABLE);

    // No cookie at all.
    const third = await started();
    const noCookie = await callback(`code=c1&state=${encodeURIComponent(third.state)}`);
    expect(noCookie.headers.get('location')).toBe(UNAVAILABLE);
    expectClearsBinding(noCookie);

    expect(tokenFetch).not.toHaveBeenCalled();
    expect(h.resolveSignIn).not.toHaveBeenCalled();
    expect(h.audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: 'portal.auth.oidc.login', result: 'failure', details: { provider: 'entra', outcome: 'denied', reason: 'state_invalid' },
    }));
  });

  it.each([
    ['error=access_denied (with a valid state)', (s: string) => `error=access_denied&error_description=User+cancelled&state=${s}`],
    ['an extra query key', (s: string) => `code=c1&state=${s}&admin_consent=True`],
    ['a duplicated code', (s: string) => `code=c1&code=c2&state=${s}`],
    ['a duplicated state', (s: string) => `code=c1&state=${s}&state=${s}`],
    ['no code', (s: string) => `state=${s}`],
    ['no state', (_s: string) => 'code=c1'],
  ])('callback with %s → unavailable', async (_name, query) => {
    h.resolveSignIn.mockResolvedValue(sessionOutcome);
    const flow = await started();
    tokenEndpointReturns(await idToken(flow.nonce));
    const res = await callback(query(encodeURIComponent(flow.state)), flow.cookie);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(UNAVAILABLE);
    expectClearsBinding(res);
    expect(tokenFetch).not.toHaveBeenCalled();
    expect(h.resolveSignIn).not.toHaveBeenCalled();
  });

  it('a provider error burns the state it names', async () => {
    const flow = await started();
    await callback(`error=access_denied&state=${encodeURIComponent(flow.state)}`, flow.cookie);
    expect(portalOidcStates.has(sha(flow.state))).toBe(false);
  });

  it.each([
    ['nonce mismatch', { nonce: 'another-nonce' }],
    ['token for another audience', { aud: '00000000-1111-4222-8333-444444444444' }],
    ['guest (acct = 1)', { acct: 1 }],
    ['guest (idp is another tenant)', { idp: `https://sts.windows.net/${GUEST_HOME_TENANT}/` }],
    ['guest (idp and acct)', GUEST_CLAIMS],
  ])('a token that fails verification (%s) → unavailable, the resolver is never called', async (_name, claims) => {
    const flow = await started();
    tokenEndpointReturns(await idToken(flow.nonce, claims));
    const res = await callback(`code=c1&state=${encodeURIComponent(flow.state)}`, flow.cookie);
    expect(res.headers.get('location')).toBe(UNAVAILABLE);
    expect(h.resolveSignIn).not.toHaveBeenCalled();
    expect(h.audit.mock.calls.map((call) => call[1].details)).toEqual([{ provider: 'entra', outcome: 'denied', reason: 'token_invalid' }]);
  });

  it('guests stay refused on the invite and link purposes (only a proof run admits one)', async () => {
    // Invite.
    h.peek.mockResolvedValue({ format: 'v2', payload: { v: 2, purpose: 'invite', portalUserId: USER, orgId: ORG, email: 'pat@acme.test', authEpoch: 3 } });
    h.validate.mockResolvedValue({ ok: true, user: { id: USER, orgId: ORG } });
    const invite = await started({ purpose: 'invite', inviteToken: 'raw-invite-token' });
    tokenEndpointReturns(await idToken(invite.nonce, GUEST_CLAIMS));
    const inviteRes = await callback(`code=c1&state=${encodeURIComponent(invite.state)}`, invite.cookie);
    expect(inviteRes.headers.get('location')).toBe(UNAVAILABLE);

    // Link.
    h.dbRows.current = [{ authEpoch: 5 }];
    const linkStart = await new Hono().route('/', portalRoutes).request('/auth/oidc/entra/link/start', {
      method: 'POST', headers: { Authorization: 'Bearer good-session' },
    });
    const linkUrl = new URL(((await linkStart.json()) as { redirectUrl: string }).redirectUrl);
    tokenEndpointReturns(await idToken(linkUrl.searchParams.get('nonce')!, GUEST_CLAIMS));
    const linkRes = await callback(`code=c1&state=${encodeURIComponent(linkUrl.searchParams.get('state')!)}`, bindingFrom(linkStart).cookieHeader);
    expect(linkRes.headers.get('location')).toBe(`${PORTAL}/profile?sso=unavailable`);

    expect(h.resolveSignIn).not.toHaveBeenCalled();
    expect(h.audit.mock.calls.map((call) => call[1].details.reason)).toEqual(['token_invalid', 'token_invalid']);
  });

  it('a failing token endpoint → unavailable, its body never logged or audited', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const flow = await started();
      tokenFetch.mockImplementation(async () => new Response('{"error":"invalid_grant","secret-body-marker":1}', { status: 400 }));
      const res = await callback(`code=c1&state=${encodeURIComponent(flow.state)}`, flow.cookie);
      expect(res.headers.get('location')).toBe(UNAVAILABLE);
      expect(JSON.stringify(warn.mock.calls)).not.toContain('secret-body-marker');
      expect(JSON.stringify(h.audit.mock.calls)).not.toContain('secret-body-marker');
    } finally {
      warn.mockRestore();
    }
  });

  const DENY_REASONS: PortalOidcDenyReason[] = [
    'org_unresolved', 'host_mismatch', 'org_unavailable', 'method_off', 'identity_other_org', 'identity_conflict',
    'account_inactive', 'invited_only', 'invite_invalid', 'link_invalid', 'requests_capped', 'no_address',
  ];

  it.each(DENY_REASONS)('callback maps every denied reason to the same redirect and writes the reason only to audit (%s)', async (reason) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { res } = await signInWith({ kind: 'denied', reason, orgId: ORG });
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe(UNAVAILABLE);
      expectClearsBinding(res);
      expect(res.headers.getSetCookie().some((c) => c.startsWith('breeze_portal_session='))).toBe(false);
      expect(portalSessions.size).toBe(0);
      expect(h.audit).toHaveBeenCalledTimes(1);
      expect(h.audit.mock.calls[0]![1]).toMatchObject({
        action: 'portal.auth.oidc.login', result: 'failure', orgId: ORG,
        details: { provider: 'entra', outcome: 'denied', reason },
      });
    } finally {
      warn.mockRestore();
    }
  });

  it('a failed audit write is captured (no token or code content) and never changes the redirect', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      h.audit.mockRejectedValue(new Error('audit insert failed'));
      const { res } = await signInWith({ kind: 'denied', reason: 'method_off', orgId: ORG });
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe(UNAVAILABLE);
      expect(h.capture).toHaveBeenCalledTimes(1);
      const [captured, , tags] = h.capture.mock.calls[0]!;
      expect(captured).toBeInstanceOf(Error);
      expect((captured as Error).message).toBe('audit insert failed');
      expect(JSON.stringify(tags ?? {})).not.toMatch(/code=|state=|token/i);
    } finally {
      warn.mockRestore();
      error.mockRestore();
    }
  });

  it('a denied link → /profile?sso=unavailable', async () => {
    h.dbRows.current = [{ authEpoch: 5 }];
    h.resolveSignIn.mockResolvedValue({ kind: 'denied', reason: 'identity_conflict', orgId: ORG });
    const startRes = await new Hono().route('/', portalRoutes).request('/auth/oidc/entra/link/start', {
      method: 'POST', headers: { Authorization: 'Bearer good-session' },
    });
    const url = new URL(((await startRes.json()) as { redirectUrl: string }).redirectUrl);
    tokenEndpointReturns(await idToken(url.searchParams.get('nonce')!));
    const res = await callback(`code=c1&state=${encodeURIComponent(url.searchParams.get('state')!)}`, bindingFrom(startRes).cookieHeader);
    expect(res.headers.get('location')).toBe(`${PORTAL}/profile?sso=unavailable`);
  });

  it('linked → /profile?sso=linked and a portal.auth.identity.link audit row', async () => {
    h.dbRows.current = [{ authEpoch: 5 }];
    h.resolveSignIn.mockResolvedValue({ kind: 'linked', portalUserId: USER, orgId: ORG });
    const startRes = await new Hono().route('/', portalRoutes).request('/auth/oidc/entra/link/start', {
      method: 'POST', headers: { Authorization: 'Bearer good-session' },
    });
    const url = new URL(((await startRes.json()) as { redirectUrl: string }).redirectUrl);
    tokenEndpointReturns(await idToken(url.searchParams.get('nonce')!));
    const res = await callback(`code=c1&state=${encodeURIComponent(url.searchParams.get('state')!)}`, bindingFrom(startRes).cookieHeader);
    expect(res.headers.get('location')).toBe(`${PORTAL}/profile?sso=linked`);
    expect(h.resolveSignIn).toHaveBeenCalledWith(expect.objectContaining({
      purpose: { kind: 'link', portalUserId: USER, orgId: ORG, authEpoch: 5 },
    }));
    expect(h.audit).toHaveBeenCalledTimes(1);
    expect(h.audit.mock.calls[0]![1]).toMatchObject({
      action: 'portal.auth.identity.link', result: 'success', orgId: ORG, resourceType: 'portal_user', resourceId: USER,
      details: { provider: 'entra', linkedVia: 'self_link' },
    });
  });

  it.each([
    ['request_sent', `${PORTAL}/login?sso=request_sent`],
    ['account_exists', `${PORTAL}/login?sso=account_exists`],
  ] as const)('%s keeps its own result code', async (kind, location) => {
    const { res } = await signInWith({ kind, orgId: ORG });
    expect(res.headers.get('location')).toBe(location);
    expect(portalSessions.size).toBe(0);
  });

  it('an invite activation audits portal.auth.identity.link (linkedVia invite) and wires the real invite consumer', async () => {
    const capability = { format: 'v2', payload: { v: 2, purpose: 'invite', portalUserId: USER, orgId: ORG, email: 'pat@acme.test', authEpoch: 3 } };
    h.peek.mockResolvedValue(capability);
    h.validate.mockResolvedValue({ ok: true, user: { id: USER, orgId: ORG, authEpoch: 3 } });
    const { res } = await signInWith({ ...sessionOutcome, authEpoch: 4, via: 'invite' }, { purpose: 'invite', inviteToken: 'raw-invite-token' });
    expect(res.headers.get('location')).toBe(`${PORTAL}/login?sso=signed_in`);
    expect(h.audit.mock.calls.map((call) => call[1].action)).toEqual(['portal.auth.identity.link']);
    expect(h.audit.mock.calls[0]![1]).toMatchObject({ result: 'success', details: { provider: 'entra', linkedVia: 'invite' } });

    // The consumer handed to the resolver: GET+DEL by the stored hash, then the
    // SSO validation; it answers the ISSUE-time epoch.
    const { inviteConsumer, purpose } = h.resolveSignIn.mock.calls[0]![0];
    expect(purpose).toEqual({ kind: 'invite', inviteTokenHash: sha('raw-invite-token') });
    h.validate.mockClear();
    h.consumeByHash.mockResolvedValue(capability);
    expect(await inviteConsumer(sha('raw-invite-token'))).toEqual({ portalUserId: USER, orgId: ORG, authEpoch: 3 });
    expect(h.consumeByHash).toHaveBeenCalledWith('invite', sha('raw-invite-token'));
    expect(h.validate).toHaveBeenCalledWith('invite', capability, { requirePasswordMethod: false });

    h.consumeByHash.mockResolvedValue(null);
    expect(await inviteConsumer(sha('raw-invite-token'))).toBeNull();
    h.consumeByHash.mockResolvedValue(capability);
    h.validate.mockResolvedValue({ ok: false, reason: 'invalid' });
    expect(await inviteConsumer(sha('raw-invite-token'))).toBeNull();
    h.consumeByHash.mockResolvedValue({ format: 'legacy', portalUserId: USER });
    h.validate.mockResolvedValue({ ok: true, user: { id: USER, orgId: ORG, authEpoch: 3 } });
    expect(await inviteConsumer(sha('raw-invite-token'))).toBeNull();
  });

  it('a resolver failure (e.g. the database) still answers 302 unavailable, never a 500', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      h.resolveSignIn.mockRejectedValue(new Error('connection terminated'));
      const flow = await started();
      tokenEndpointReturns(await idToken(flow.nonce));
      const res = await callback(`code=c1&state=${encodeURIComponent(flow.state)}`, flow.cookie);
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe(UNAVAILABLE);
      expectClearsBinding(res);
    } finally {
      error.mockRestore();
    }
  });

  it('not configured → 302 unavailable', async () => {
    h.cfg.current = null;
    const res = await callback('code=c1&state=s1');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(UNAVAILABLE);
    expectClearsBinding(res);
  });

  describe('tenant proof run (Task 8)', () => {
    const OTHER_TENANT = '22222222-3333-4444-8555-666666666666';
    const FAILED = `${PORTAL}/entra-setup?status=failed`;
    const graphFetch = vi.fn();

    beforeEach(() => {
      graphFetch.mockReset();
      oidcTestOnly.setEntraDeps({
        fetch: tokenFetch as unknown as typeof fetch,
        verificationKey: keys.publicKey,
        graphFetch: graphFetch as unknown as typeof fetch,
      });
    });

    /** An MSP's link → GET /auth/oidc/entra/proof → the state and binding the callback needs. */
    async function openProofLink() {
      const run = await createPortalEntraProofRun({ orgId: ORG, partnerId: PARTNER, createdByUserId: USER, expectedTenantId: TENANT });
      const res = await app().request(`/auth/oidc/entra/proof?run=${encodeURIComponent(run.token)}`);
      expect(res.status).toBe(302);
      const url = new URL(res.headers.get('location')!);
      return { run, url, state: url.searchParams.get('state')!, nonce: url.searchParams.get('nonce')!, cookie: bindingFrom(res).cookieHeader };
    }

    it('the proof link is mounted on the portal routes and starts a sign-in pinned to the run\'s tenant', async () => {
      const { url } = await openProofLink();
      expect(`${url.origin}${url.pathname}`).toBe(`https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/authorize`);
      expect(url.searchParams.get('scope')).toBe('openid profile Directory.Read.All');
      const stored = JSON.parse(portalOidcStates.get(sha(url.searchParams.get('state')!))!.payload);
      expect(stored.purpose).toMatchObject({ kind: 'tenant_proof', orgId: ORG, expectedTenantId: TENANT });
    });

    it('a token for another tenant than the run\'s pin → failed, audited on the org, Graph never called, the run still usable', async () => {
      const flow = await openProofLink();
      tokenEndpointReturns(await idToken(flow.nonce, { tid: OTHER_TENANT, iss: `https://login.microsoftonline.com/${OTHER_TENANT}/v2.0` }));
      const res = await callback(`code=c1&state=${encodeURIComponent(flow.state)}`, flow.cookie);
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe(FAILED);
      expectClearsBinding(res);
      expect(graphFetch).not.toHaveBeenCalled();
      expect(h.resolveSignIn).not.toHaveBeenCalled();
      expect(await peekPortalEntraProofRun(flow.run.token)).not.toBeNull();
      expect(h.audit).toHaveBeenCalledTimes(1);
      expect(h.audit.mock.calls[0]![1]).toMatchObject({
        action: 'organization.portal_identity_proof.failed', orgId: ORG, result: 'failure',
        details: { reason: 'token_invalid' },
      });
      expect(JSON.stringify(h.audit.mock.calls)).not.toContain(flow.run.token);
    });

    it('a provider error on a proof sign-in → failed, audited as a refused proof', async () => {
      const flow = await openProofLink();
      const res = await callback(`error=access_denied&state=${encodeURIComponent(flow.state)}`, flow.cookie);
      expect(res.headers.get('location')).toBe(FAILED);
      expect(h.audit.mock.calls.map((call) => call[1])).toEqual([expect.objectContaining({
        action: 'organization.portal_identity_proof.failed', orgId: ORG, details: { reason: 'provider_error' },
      })]);
    });

    it('the token endpoint\'s access token reaches the Graph admin check through the seam; not an admin → failed, run not consumed', async () => {
      const flow = await openProofLink();
      tokenEndpointReturns(await idToken(flow.nonce));
      graphFetch.mockImplementation(async (input: string) => {
        const url = String(input);
        if (url.includes('/v1.0/me?')) return Response.json({ id: OID });
        if (url.includes('/v1.0/organization?')) return Response.json({ value: [{ id: TENANT }] });
        return Response.json({ value: [{ roleTemplateId: 'fe930be7-5e62-47db-91af-98c3a49a38b1' }] }); // User Administrator
      });
      const res = await callback(`code=c1&state=${encodeURIComponent(flow.state)}`, flow.cookie);
      expect(res.headers.get('location')).toBe(FAILED);
      expect(graphFetch).toHaveBeenCalled();
      for (const [, init] of graphFetch.mock.calls) {
        expect((init as RequestInit).headers).toEqual({ authorization: 'Bearer access-token-value' });
      }
      expect(await peekPortalEntraProofRun(flow.run.token)).not.toBeNull();
      expect(h.audit.mock.calls[0]![1]).toMatchObject({
        action: 'organization.portal_identity_proof.failed', details: { reason: 'admin_check_failed', adminCheck: 'no_accepted_role' },
      });
    });

    it('a B2B guest of the pinned tenant passes the token step and reaches the proof branch, where Graph decides', async () => {
      // Global Constraints "Proof run": a guest who holds an admin role in the
      // customer's tenant is an admin there; the Graph role check binds to tid/oid.
      const flow = await openProofLink();
      tokenEndpointReturns(await idToken(flow.nonce, GUEST_CLAIMS));
      graphFetch.mockImplementation(async (input: string) => {
        const url = String(input);
        if (url.includes('/v1.0/me?')) return Response.json({ id: OID });
        if (url.includes('/v1.0/organization?')) return Response.json({ value: [{ id: TENANT }] });
        return Response.json({ value: [{ roleTemplateId: 'fe930be7-5e62-47db-91af-98c3a49a38b1' }] }); // User Administrator
      });
      const res = await callback(`code=c1&state=${encodeURIComponent(flow.state)}`, flow.cookie);
      expect(res.headers.get('location')).toBe(FAILED);
      // Not refused as a token: the branch's Graph admin check ran on the guest's token and decided.
      expect(graphFetch).toHaveBeenCalled();
      expect(h.audit.mock.calls.map((call) => call[1].details)).toEqual([{ reason: 'admin_check_failed', adminCheck: 'no_accepted_role' }]);
      expect(h.resolveSignIn).not.toHaveBeenCalled();
    });
  });

  it('is rate limited per IP (30 per 5 min) and still answers 302 unavailable', async () => {
    for (let i = 0; i < 30; i++) await callback('code=c1&state=s1');
    expect(h.audit).toHaveBeenCalledTimes(30);
    const res = await callback('code=c1&state=s1');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(UNAVAILABLE);
    expect(h.audit.mock.calls[30]![1]).toMatchObject({ details: { reason: 'rate_limited' } });
  });
});

describe('POST /auth/invite/methods', () => {
  const capability = { format: 'v2', payload: { v: 2, purpose: 'invite', portalUserId: USER, orgId: ORG, email: 'pat@acme.test', authEpoch: 3 } };
  const methods = (token = 'raw-invite-token') => app().request('/auth/invite/methods', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }),
  });
  /** The password path refuses (sso_only), the Microsoft path accepts. */
  const ssoOnlyValidation = async (_p: string, _c: unknown, opts?: { requirePasswordMethod?: boolean }) =>
    opts?.requirePasswordMethod === false ? { ok: true, user: { id: USER, orgId: ORG } } : { ok: false, reason: 'invalid' };

  it('invite methods: sso_only org → { password: false, microsoft: true }; both off → 400', async () => {
    h.peek.mockResolvedValue(capability);
    h.validate.mockImplementation(ssoOnlyValidation);
    h.resolvePolicy.mockImplementation(async (orgId: string) => policyFor(orgId, 'sso_only'));
    let res = await methods();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ password: false, microsoft: true });
    expect(h.peek).toHaveBeenCalledWith('invite', 'raw-invite-token');
    expect(h.consumeByHash).not.toHaveBeenCalled();

    // Microsoft off for the org and the password path refused: nothing to offer.
    h.resolvePolicy.mockImplementation(async (orgId: string) => policyFor(orgId, 'allowed'));
    res = await methods();
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual(INVALID_INVITE);
  });

  it('an allowed org with Microsoft on offers both', async () => {
    h.peek.mockResolvedValue(capability);
    h.validate.mockResolvedValue({ ok: true, user: { id: USER, orgId: ORG } });
    h.resolvePolicy.mockImplementation(async (orgId: string) => policyFor(orgId, 'both'));
    expect(await (await methods()).json()).toEqual({ password: true, microsoft: true });
  });

  it('Microsoft is not offered while the portal Entra app is not configured', async () => {
    h.cfg.current = null;
    h.peek.mockResolvedValue(capability);
    h.validate.mockResolvedValue({ ok: true, user: { id: USER, orgId: ORG } });
    h.resolvePolicy.mockImplementation(async (orgId: string) => policyFor(orgId, 'both'));
    expect(await (await methods()).json()).toEqual({ password: true, microsoft: false });
  });

  it('an unknown or invalid token → the same 400 as accept-invite', async () => {
    h.peek.mockResolvedValue(null);
    let res = await methods();
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual(INVALID_INVITE);
    h.peek.mockResolvedValue(capability);
    h.validate.mockResolvedValue({ ok: false, reason: 'org_unavailable' });
    res = await methods();
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual(INVALID_INVITE);
  });

  it('counts against the accept-invite buckets (per IP and per token)', async () => {
    h.peek.mockResolvedValue(null);
    await methods('raw-invite-token');
    expect([...portalRateLimitBuckets.keys()]).toEqual(expect.arrayContaining([
      expect.stringMatching(/^portal:accept:ip:/),
      `portal:accept:token:${sha('raw-invite-token')}`,
    ]));
    for (let i = 0; i < 9; i++) await methods('raw-invite-token');
    const res = await methods('raw-invite-token');
    expect(res.status).toBe(429);
  });
});

describe('GET /auth/oidc/entra/consent-return', () => {
  it('consent-return ignores admin_consent/tenant params', async () => {
    for (const query of ['', '?admin_consent=True&tenant=11111111-2222-4333-8444-555555555555', '?error=access_denied&state=x']) {
      const res = await app().request(`/auth/oidc/entra/consent-return${query}`);
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe(`${PORTAL}/entra-setup?status=consent_done`);
    }
    expect(h.audit).not.toHaveBeenCalled();
  });
});

describe('__testOnly', () => {
  it('refuses outside NODE_ENV=test', () => {
    const saved = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      expect(() => oidcTestOnly.setEntraDeps(null)).toThrow(/NODE_ENV=test/);
    } finally {
      process.env.NODE_ENV = saved;
    }
  });
});
