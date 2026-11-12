import { Hono } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';
import { pickEffectivePortalAccessPolicy, type ResolvedPortalAccessPolicy } from '../../services/portalAccessPolicy';
import { isBrowserSessionAllowed, mintPortalBrowserSession, parseStoredPortalSession } from './browserSession';
import { portalSessions } from './helpers';
import { PORTAL_CSRF_COOKIE_NAME, PORTAL_SESSION_COOKIE_NAME, SESSION_TTL_MS } from './schemas';

const ORG = '7c0a1f7e-1111-4222-8333-444455556666';
const USER = '11111111-2222-4333-8444-555566667777';
const TENANT = '72f988bf-86f1-41af-91ab-2d7cd011db47';
const OTHER_TENANT = '9b0f1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d';
const HD = 'contoso.example.com';
const OTHER_HD = 'fabrikam.example.com';
const base = { portalUserId: USER, orgId: ORG, authEpoch: 3 };
const ISO = '2026-11-01T00:00:00.000Z';
const HOUR = 3_600_000;
const NOW = Date.parse('2026-11-09T12:00:00.000Z');

/** Effective policies built by the real pick, so the gate is tested against real field shapes. */
type GatePolicy = Pick<ResolvedPortalAccessPolicy, 'effective' | 'entraTenant' | 'googleDomains'>;
const CAPS_ALL = { entra: true, google: true, selfRegistration: false };
const PROVEN = { entraTenantProven: true, googleDomainVerified: true };
const empty = { entraEnabled: null, googleEnabled: null, passwordMode: null, selfRegistrationMode: null, ssoNewPersonMode: null, ssoSessionMaxHours: null };
type Row = Parameters<typeof pickEffectivePortalAccessPolicy>[0];
/** A gate policy: the real pick, plus the org's proven tenant (null = none proven) and verified domains (null = not read). */
function policy(org: Row, tenantId: string | null = TENANT, googleDomains: string[] | null = [HD]): GatePolicy {
  const picked = pickEffectivePortalAccessPolicy(org, null, CAPS_ALL, PROVEN);
  return { effective: picked.effective, entraTenant: tenantId ? { tenantId, provenAt: ISO } : null, googleDomains };
}
const allowedPolicy = policy(null);
const ssoOnlyEntra = policy({ ...empty, entraEnabled: true, passwordMode: 'sso_only' });
const entraAndPassword = policy({ ...empty, entraEnabled: true });
const googleOnly = policy({ ...empty, googleEnabled: true });
const entraCap = (hours: number) => policy({ ...empty, entraEnabled: true, passwordMode: 'sso_only', ssoSessionMaxHours: hours });

const passwordUser = { authMethod: 'password', browserAccess: 'granted' };
const entraUser = { authMethod: 'entra', browserAccess: 'granted' };

const pw = (over: Partial<{ createdAtMs: number | null }> = {}) => ({ method: 'password' as const, createdAtMs: null, entraTenantId: null, googleHostedDomain: null, ...over });
const entra = (over: Partial<{ createdAtMs: number | null; entraTenantId: string | null }> = {}) =>
  ({ method: 'entra' as const, createdAtMs: NOW - HOUR, entraTenantId: TENANT, googleHostedDomain: null, ...over });

describe('parseStoredPortalSession', () => {
  it('parses a pre-W4 password payload (no entraTenantId) unchanged', () => {
    expect(parseStoredPortalSession({ ...base, method: 'password', createdAt: ISO }))
      .toEqual({ ...base, method: 'password', createdAtMs: Date.parse(ISO), entraTenantId: null, googleHostedDomain: null });
    // pre-W3: no method; a password session never needed createdAt.
    expect(parseStoredPortalSession({ ...base, createdAt: ISO }))
      .toEqual({ ...base, method: 'password', createdAtMs: Date.parse(ISO), entraTenantId: null, googleHostedDomain: null });
    expect(parseStoredPortalSession({ ...base })).toEqual({ ...base, method: 'password', createdAtMs: null, entraTenantId: null, googleHostedDomain: null });
    expect(parseStoredPortalSession({ ...base, createdAt: 'x' })).toEqual({ ...base, method: 'password', createdAtMs: null, entraTenantId: null, googleHostedDomain: null });
    // The in-memory twin stores createdAt as a Date.
    expect(parseStoredPortalSession({ ...base, createdAt: new Date(ISO) }))
      .toEqual({ ...base, method: 'password', createdAtMs: Date.parse(ISO), entraTenantId: null, googleHostedDomain: null });
    // A password session carries no tenant, whatever the payload says.
    expect(parseStoredPortalSession({ ...base, method: 'password', createdAt: ISO, entraTenantId: TENANT })?.entraTenantId).toBeNull();
  });

  it('refuses an entra payload without createdAt or with a non-GUID entraTenantId', () => {
    const ok = { ...base, method: 'entra', createdAt: ISO, entraTenantId: TENANT };
    expect(parseStoredPortalSession(ok)).toEqual({ ...base, method: 'entra', createdAtMs: Date.parse(ISO), entraTenantId: TENANT, googleHostedDomain: null });
    expect(parseStoredPortalSession({ ...ok, createdAt: new Date(ISO) })?.createdAtMs).toBe(Date.parse(ISO));
    expect(parseStoredPortalSession({ ...ok, entraTenantId: TENANT.toUpperCase() })?.entraTenantId).toBe(TENANT);

    const { createdAt: _c, ...noCreatedAt } = ok;
    const { entraTenantId: _t, ...noTenant } = ok;
    for (const raw of [
      noCreatedAt,
      { ...ok, createdAt: 'not a date' },
      { ...ok, createdAt: 1_700_000_000_000 },
      { ...ok, createdAt: new Date('nope') },
      noTenant,
      { ...ok, entraTenantId: null },
      { ...ok, entraTenantId: 'contoso.onmicrosoft.com' },
      { ...ok, entraTenantId: `${TENANT}x` },
      { ...ok, entraTenantId: 42 },
    ]) {
      expect(parseStoredPortalSession(raw)).toBeNull();
    }
  });

  it('a google session needs a createdAt (SSO absolute lifetime) and carries no tenant', () => {
    expect(parseStoredPortalSession({ ...base, method: 'google', createdAt: ISO, entraTenantId: TENANT, googleHostedDomain: HD }))
      .toEqual({ ...base, method: 'google', createdAtMs: Date.parse(ISO), entraTenantId: null, googleHostedDomain: HD });
    expect(parseStoredPortalSession({ ...base, method: 'google', googleHostedDomain: HD })).toBeNull();
    expect(parseStoredPortalSession({ ...base, method: 'google', createdAt: 'x', googleHostedDomain: HD })).toBeNull();
  });

  // W7 (#11384) plan D7: a google session pins the verified Workspace domain (`hd`) it signed in with.
  it('parses a google payload with createdAt and googleHostedDomain; refuses one without hd or with an invalid hd', () => {
    const ok = { ...base, method: 'google', createdAt: ISO, googleHostedDomain: HD };
    expect(parseStoredPortalSession(ok)).toEqual({ ...base, method: 'google', createdAtMs: Date.parse(ISO), entraTenantId: null, googleHostedDomain: HD });
    expect(parseStoredPortalSession({ ...ok, googleHostedDomain: 'sub.contoso.example.com' })?.googleHostedDomain).toBe('sub.contoso.example.com');

    const { googleHostedDomain: _h, ...noHd } = ok;
    for (const raw of [
      noHd,
      { ...ok, googleHostedDomain: null },
      { ...ok, googleHostedDomain: '' },
      { ...ok, googleHostedDomain: 42 },
      { ...ok, googleHostedDomain: ['contoso.example.com'] },
      // Stored lowercase or not at all: an uppercase pin is a payload this release never wrote.
      { ...ok, googleHostedDomain: 'Contoso.Example.com' },
      { ...ok, googleHostedDomain: ' contoso.example.com' },
      { ...ok, googleHostedDomain: 'contoso.example.com ' },
      { ...ok, googleHostedDomain: '*' },
      { ...ok, googleHostedDomain: '*.example.com' },
      { ...ok, googleHostedDomain: 'localhost' },
      { ...ok, googleHostedDomain: 'contoso..example.com' },
      { ...ok, googleHostedDomain: 'pat@contoso.example.com' },
      { ...ok, googleHostedDomain: 'gmail.com' },
      // The hd alone is not enough: the SSO lifetime still needs createdAt.
      { ...base, method: 'google', googleHostedDomain: HD },
    ]) {
      expect(parseStoredPortalSession(raw)).toBeNull();
    }
  });

  it('the in-memory twin refuses a google session without googleHostedDomain exactly as the Redis payload does', () => {
    // The Redis payload is JSON (createdAt an ISO string); the in-memory twin is a
    // PortalSession (token, createdAt and expiresAt as Dates). Both go through the one parse.
    const created = new Date(ISO);
    const twin = (extra: Record<string, unknown>) => ({
      token: 't'.repeat(48), ...base, method: 'google', createdAt: created, expiresAt: new Date(created.getTime() + SESSION_TTL_MS), ...extra,
    });
    const redisPayload = (extra: Record<string, unknown>) =>
      JSON.parse(JSON.stringify({ ...base, method: 'google', createdAt: created.toISOString(), ...extra })) as unknown;

    const expected = { ...base, method: 'google', createdAtMs: created.getTime(), entraTenantId: null, googleHostedDomain: HD };
    expect(parseStoredPortalSession(twin({ googleHostedDomain: HD }))).toEqual(expected);
    expect(parseStoredPortalSession(redisPayload({ googleHostedDomain: HD }))).toEqual(expected);
    for (const extra of [{}, { googleHostedDomain: undefined }, { googleHostedDomain: null }, { googleHostedDomain: 'CONTOSO.EXAMPLE.COM' }, { googleHostedDomain: 'not a domain' }]) {
      expect(parseStoredPortalSession(twin(extra))).toBeNull();
      expect(parseStoredPortalSession(redisPayload(extra))).toBeNull();
    }
  });

  it('password and entra payloads parse unchanged and carry googleHostedDomain null', () => {
    expect(parseStoredPortalSession({ ...base, method: 'password', createdAt: ISO }))
      .toEqual({ ...base, method: 'password', createdAtMs: Date.parse(ISO), entraTenantId: null, googleHostedDomain: null });
    expect(parseStoredPortalSession({ ...base, method: 'entra', createdAt: ISO, entraTenantId: TENANT }))
      .toEqual({ ...base, method: 'entra', createdAtMs: Date.parse(ISO), entraTenantId: TENANT, googleHostedDomain: null });
    // A stray hd on a non-google payload is ignored, never carried into the session.
    expect(parseStoredPortalSession({ ...base, method: 'password', createdAt: ISO, googleHostedDomain: HD })?.googleHostedDomain).toBeNull();
    expect(parseStoredPortalSession({ ...base, createdAt: ISO, googleHostedDomain: HD })?.googleHostedDomain).toBeNull();
    expect(parseStoredPortalSession({ ...base, method: 'entra', createdAt: ISO, entraTenantId: TENANT, googleHostedDomain: HD })?.googleHostedDomain).toBeNull();
    // ...and a garbage one does not refuse them either.
    expect(parseStoredPortalSession({ ...base, method: 'password', createdAt: ISO, googleHostedDomain: 42 })?.method).toBe('password');
    expect(parseStoredPortalSession({ ...base, method: 'entra', createdAt: ISO, entraTenantId: TENANT, googleHostedDomain: 42 })?.method).toBe('entra');
  });

  it('rejects an unknown method and a non-integer authEpoch', () => {
    expect(parseStoredPortalSession({ ...base, method: 'saml' })).toBeNull();
    expect(parseStoredPortalSession({ ...base, method: null })).toBeNull();
    expect(parseStoredPortalSession({ ...base, method: 1 })).toBeNull();
    expect(parseStoredPortalSession({ ...base, authEpoch: 1.5 })).toBeNull();
    expect(parseStoredPortalSession({ ...base, authEpoch: '3' })).toBeNull();
    expect(parseStoredPortalSession({ ...base, authEpoch: 0 })).toBeNull();
    expect(parseStoredPortalSession({ portalUserId: USER, orgId: ORG })).toBeNull();
  });

  it('rejects a bad shape', () => {
    for (const raw of [null, undefined, 'session', 42, [], { ...base, portalUserId: 7 }, { ...base, orgId: null }]) {
      expect(parseStoredPortalSession(raw)).toBeNull();
    }
  });
});

describe('isBrowserSessionAllowed', () => {
  it('password session needs password-eligible + browser granted + passwordMode allowed', () => {
    expect(isBrowserSessionAllowed(pw(), passwordUser, allowedPolicy, NOW)).toBe(true);
    // Each leg alone refuses.
    expect(isBrowserSessionAllowed(pw(), { ...passwordUser, authMethod: 'entra' }, allowedPolicy, NOW)).toBe(false);
    expect(isBrowserSessionAllowed(pw(), { ...passwordUser, browserAccess: 'none' }, allowedPolicy, NOW)).toBe(false);
    expect(ssoOnlyEntra.effective.passwordMode.value).toBe('sso_only');
    expect(isBrowserSessionAllowed(pw(), passwordUser, ssoOnlyEntra, NOW)).toBe(false);
  });

  it('password session has no absolute cap', () => {
    const cap1 = policy({ ...empty, ssoSessionMaxHours: 1 });
    expect(isBrowserSessionAllowed(pw({ createdAtMs: NOW - 1000 * HOUR }), passwordUser, cap1, NOW)).toBe(true);
    expect(isBrowserSessionAllowed(pw({ createdAtMs: null }), passwordUser, cap1, NOW)).toBe(true);
    // Nor a tenant pin: no proven tenant at all changes nothing for a password session.
    expect(isBrowserSessionAllowed(pw(), passwordUser, policy(null, null), NOW)).toBe(true);
  });

  it('entra session allowed inside the cap with the matching proven tenant', () => {
    expect(isBrowserSessionAllowed(entra(), entraUser, ssoOnlyEntra, NOW)).toBe(true);
    expect(isBrowserSessionAllowed(entra(), entraUser, entraAndPassword, NOW)).toBe(true);
    // Not password eligibility: a password account's entra session is gated by entra alone.
    expect(isBrowserSessionAllowed(entra(), passwordUser, ssoOnlyEntra, NOW)).toBe(true);
    // One millisecond inside the default 12 h.
    expect(isBrowserSessionAllowed(entra({ createdAtMs: NOW - 12 * HOUR + 1 }), entraUser, ssoOnlyEntra, NOW)).toBe(true);
    // A GUID compares without regard to case.
    expect(isBrowserSessionAllowed(entra(), entraUser, policy({ ...empty, entraEnabled: true }, TENANT.toUpperCase()), NOW)).toBe(true);
    // Browser access is still required.
    expect(isBrowserSessionAllowed(entra(), { ...entraUser, browserAccess: 'none' }, ssoOnlyEntra, NOW)).toBe(false);
  });

  it('entra session refused at exactly ssoSessionMaxHours', () => {
    expect(ssoOnlyEntra.effective.ssoSessionMaxHours.value).toBe(12);
    expect(isBrowserSessionAllowed(entra({ createdAtMs: NOW - 12 * HOUR }), entraUser, ssoOnlyEntra, NOW)).toBe(false);
    expect(isBrowserSessionAllowed(entra({ createdAtMs: NOW - 30 * HOUR }), entraUser, ssoOnlyEntra, NOW)).toBe(false);
    // The cap is read from the policy passed in (the CURRENT one): lowered to 1 h, a 2 h session dies.
    expect(isBrowserSessionAllowed(entra({ createdAtMs: NOW - 2 * HOUR }), entraUser, entraCap(12), NOW)).toBe(true);
    expect(isBrowserSessionAllowed(entra({ createdAtMs: NOW - 2 * HOUR }), entraUser, entraCap(1), NOW)).toBe(false);
    expect(isBrowserSessionAllowed(entra({ createdAtMs: NOW - HOUR }), entraUser, entraCap(1), NOW)).toBe(false);
    expect(isBrowserSessionAllowed(entra({ createdAtMs: NOW - HOUR + 1 }), entraUser, entraCap(1), NOW)).toBe(true);
    // No createdAt at all fails closed.
    expect(isBrowserSessionAllowed(entra({ createdAtMs: null }), entraUser, ssoOnlyEntra, NOW)).toBe(false);
  });

  it("entra session refused when the policy's proven tenant differs", () => {
    expect(isBrowserSessionAllowed(entra(), entraUser, policy({ ...empty, entraEnabled: true }, OTHER_TENANT), NOW)).toBe(false);
    // No proven tenant on the policy (defence in depth: the resolver also masks entra off then).
    expect(isBrowserSessionAllowed(entra(), entraUser, policy({ ...empty, entraEnabled: true }, null), NOW)).toBe(false);
    expect(isBrowserSessionAllowed(entra({ entraTenantId: null }), entraUser, ssoOnlyEntra, NOW)).toBe(false);
    expect(isBrowserSessionAllowed(entra({ entraTenantId: OTHER_TENANT }), entraUser, ssoOnlyEntra, NOW)).toBe(false);
  });

  it('an entra session never satisfies a password-only gate and vice versa', () => {
    // entra effectively off (today's default), tenant proven, inside the cap.
    expect(isBrowserSessionAllowed(entra(), entraUser, allowedPolicy, NOW)).toBe(false);
    expect(isBrowserSessionAllowed(entra(), passwordUser, allowedPolicy, NOW)).toBe(false);
    // sso_only: a password session is refused even on a password account.
    expect(isBrowserSessionAllowed(pw(), passwordUser, ssoOnlyEntra, NOW)).toBe(false);
  });

  it('a google session needs google allowed and is capped like any SSO session', () => {
    const google = { method: 'google' as const, createdAtMs: NOW - HOUR, entraTenantId: null, googleHostedDomain: HD };
    expect(isBrowserSessionAllowed(google, entraUser, googleOnly, NOW)).toBe(true);
    expect(isBrowserSessionAllowed(google, entraUser, ssoOnlyEntra, NOW)).toBe(false);
    expect(isBrowserSessionAllowed({ ...google, createdAtMs: NOW - 12 * HOUR }, entraUser, googleOnly, NOW)).toBe(false);
    expect(isBrowserSessionAllowed({ ...google, createdAtMs: null }, entraUser, googleOnly, NOW)).toBe(false);
  });

  // W7 (#11384) plan D7 / Review Focus 3.
  const gsession = (over: Partial<{ createdAtMs: number | null; googleHostedDomain: string | null }> = {}) =>
    ({ method: 'google' as const, createdAtMs: NOW - HOUR, entraTenantId: null, googleHostedDomain: HD, ...over });
  const googleUser = { authMethod: 'google', browserAccess: 'granted' };
  const googleCap = (hours: number, googleDomains: string[] | null = [HD]) =>
    policy({ ...empty, googleEnabled: true, passwordMode: 'sso_only', ssoSessionMaxHours: hours }, TENANT, googleDomains);

  it('google session allowed inside the cap while its hd is in policy.googleDomains', () => {
    expect(googleOnly.effective.googleEnabled.value).toBe(true);
    expect(isBrowserSessionAllowed(gsession(), googleUser, googleOnly, NOW)).toBe(true);
    // Not account auth method or password eligibility: a password account's google session is gated by google alone.
    expect(isBrowserSessionAllowed(gsession(), passwordUser, googleOnly, NOW)).toBe(true);
    // One of several verified domains.
    expect(isBrowserSessionAllowed(gsession(), googleUser, policy({ ...empty, googleEnabled: true }, null, ['alpha.example.com', HD, 'zeta.example.com']), NOW)).toBe(true);
    // No proven Entra tenant changes nothing for a google session.
    expect(isBrowserSessionAllowed(gsession(), googleUser, policy({ ...empty, googleEnabled: true }, null), NOW)).toBe(true);
    // One millisecond inside the cap; refused at it; the CURRENT cap is the one read.
    expect(isBrowserSessionAllowed(gsession({ createdAtMs: NOW - 12 * HOUR + 1 }), googleUser, googleCap(12), NOW)).toBe(true);
    expect(isBrowserSessionAllowed(gsession({ createdAtMs: NOW - 12 * HOUR }), googleUser, googleCap(12), NOW)).toBe(false);
    expect(isBrowserSessionAllowed(gsession({ createdAtMs: NOW - 2 * HOUR }), googleUser, googleCap(1), NOW)).toBe(false);
    // Browser access is still required.
    expect(isBrowserSessionAllowed(gsession(), { ...googleUser, browserAccess: 'none' }, googleOnly, NOW)).toBe(false);
  });

  it('google session refused when its hd is not in policy.googleDomains, or googleDomains is null', () => {
    // Google on, inside the cap; only the domain list differs.
    expect(isBrowserSessionAllowed(gsession(), googleUser, googleCap(12, [HD]), NOW)).toBe(true);
    expect(isBrowserSessionAllowed(gsession(), googleUser, googleCap(12, [OTHER_HD]), NOW)).toBe(false);
    expect(isBrowserSessionAllowed(gsession(), googleUser, googleCap(12, []), NOW)).toBe(false);
    expect(isBrowserSessionAllowed(gsession(), googleUser, googleCap(12, null), NOW)).toBe(false);
    // Exact match only: no suffix, parent-domain or case-folded match.
    expect(isBrowserSessionAllowed(gsession(), googleUser, googleCap(12, ['example.com']), NOW)).toBe(false);
    expect(isBrowserSessionAllowed(gsession(), googleUser, googleCap(12, [`sub.${HD}`]), NOW)).toBe(false);
    expect(isBrowserSessionAllowed(gsession({ googleHostedDomain: `sub.${HD}` }), googleUser, googleCap(12, [HD]), NOW)).toBe(false);
    expect(isBrowserSessionAllowed(gsession(), googleUser, googleCap(12, [HD.toUpperCase()]), NOW)).toBe(false);
    // A session with no pin never passes, whatever the list holds.
    expect(isBrowserSessionAllowed(gsession({ googleHostedDomain: null }), googleUser, googleCap(12, [HD]), NOW)).toBe(false);
    expect(isBrowserSessionAllowed(gsession({ googleHostedDomain: null }), googleUser, googleCap(12, null), NOW)).toBe(false);
  });

  it('a google session never satisfies a password-only or entra-only policy', () => {
    // inv. 9. Each policy lists the session's hd as verified and holds a proven tenant: only the method refuses.
    const passwordOnly = policy({ ...empty, googleEnabled: false });
    expect(passwordOnly.effective.passwordMode.value).toBe('allowed');
    expect(passwordOnly.effective.googleEnabled.value).toBe(false);
    expect(isBrowserSessionAllowed(gsession(), googleUser, passwordOnly, NOW)).toBe(false);
    expect(isBrowserSessionAllowed(gsession(), passwordUser, passwordOnly, NOW)).toBe(false);
    expect(isBrowserSessionAllowed(gsession(), googleUser, allowedPolicy, NOW)).toBe(false);
    expect(isBrowserSessionAllowed(gsession(), googleUser, ssoOnlyEntra, NOW)).toBe(false);
    expect(isBrowserSessionAllowed(gsession(), googleUser, entraAndPassword, NOW)).toBe(false);
    // ...and neither a password nor an entra session satisfies a google-only sso_only policy.
    const googleSsoOnly = googleCap(12);
    expect(isBrowserSessionAllowed(gsession(), googleUser, googleSsoOnly, NOW)).toBe(true);
    expect(isBrowserSessionAllowed(pw(), passwordUser, googleSsoOnly, NOW)).toBe(false);
    expect(isBrowserSessionAllowed(entra(), entraUser, googleSsoOnly, NOW)).toBe(false);
    // An entra session carrying a stray hd is not thereby a google session.
    expect(isBrowserSessionAllowed({ ...entra(), googleHostedDomain: HD }, entraUser, googleSsoOnly, NOW)).toBe(false);
  });

  it('fails closed for a method it does not know', () => {
    expect(isBrowserSessionAllowed({ ...pw(), method: 'saml' as never }, passwordUser, allowedPolicy, NOW)).toBe(false);
  });
});

// In-memory backend (PORTAL_USE_REDIS is false under NODE_ENV=test). The Redis
// payload is pinned in auth.sessionMint.test.ts.
describe('mintPortalBrowserSession (in-memory backend)', () => {
  type MintInput = Parameters<typeof mintPortalBrowserSession>[1];
  const mint = (input: MintInput) => {
    const app = new Hono();
    app.post('/mint', async (c) => c.json(await mintPortalBrowserSession(c, input)));
    return app.request('/mint', { method: 'POST' });
  };

  beforeEach(() => portalSessions.clear());

  it('writes the in-memory twin and the session + CSRF cookies; returns the token and its expiry', async () => {
    const before = Date.now();
    const res = await mint({ ...base, method: 'password' });
    const after = Date.now();
    expect(res.status).toBe(200);
    const body = await res.json() as { token: string; expiresAt: string };
    expect(body.token).toMatch(/^[A-Za-z0-9_-]{48}$/);

    const stored = portalSessions.get(body.token)!;
    expect(stored).toEqual({
      token: body.token, ...base, method: 'password', createdAt: expect.any(Date), expiresAt: expect.any(Date),
    });
    expect('entraTenantId' in stored).toBe(false);
    expect(stored.createdAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(stored.createdAt.getTime()).toBeLessThanOrEqual(after);
    expect(stored.expiresAt.getTime()).toBe(stored.createdAt.getTime() + SESSION_TTL_MS);
    expect(Date.parse(body.expiresAt)).toBe(stored.expiresAt.getTime());

    const cookies = res.headers.getSetCookie();
    expect(cookies).toHaveLength(2);
    expect(cookies[0]!.startsWith(`${PORTAL_SESSION_COOKIE_NAME}=${body.token};`)).toBe(true);
    expect(cookies[1]!.startsWith(`${PORTAL_CSRF_COOKIE_NAME}=`)).toBe(true);

    // What was stored reads back as the session that was minted.
    expect(parseStoredPortalSession(stored)).toEqual({ ...base, method: 'password', createdAtMs: stored.createdAt.getTime(), entraTenantId: null, googleHostedDomain: null });
  });

  it('an entra mint stores its tenant and reads back as a capped, pinned entra session', async () => {
    const res = await mint({ ...base, method: 'entra', entraTenantId: TENANT.toUpperCase() });
    const { token } = await res.json() as { token: string };
    const stored = portalSessions.get(token)!;
    expect(stored).toMatchObject({ method: 'entra', entraTenantId: TENANT });
    const parsed = parseStoredPortalSession(stored)!;
    expect(parsed).toEqual({ ...base, method: 'entra', createdAtMs: stored.createdAt.getTime(), entraTenantId: TENANT, googleHostedDomain: null });
    expect(isBrowserSessionAllowed(parsed, entraUser, ssoOnlyEntra, Date.now())).toBe(true);
  });

  it('refuses an entra mint without a GUID tenant and a non-entra mint with one (stores nothing)', async () => {
    for (const input of [
      { ...base, method: 'entra' as const },
      { ...base, method: 'entra' as const, entraTenantId: 'contoso.onmicrosoft.com' },
      { ...base, method: 'password' as const, entraTenantId: TENANT },
    ]) {
      const res = await mint(input);
      expect(res.status).toBe(500);
      expect(res.headers.getSetCookie()).toEqual([]);
    }
    expect(portalSessions.size).toBe(0);
  });
});

// W7 (#11384) plan D7. The Redis byte layout is pinned in auth.sessionMint.test.ts.
describe('mintPortalBrowserSession: google (in-memory backend)', () => {
  type MintInput = Parameters<typeof mintPortalBrowserSession>[1];
  const mint = (input: MintInput) => {
    const app = new Hono();
    app.post('/mint', async (c) => c.json(await mintPortalBrowserSession(c, input)));
    return app.request('/mint', { method: 'POST' });
  };

  beforeEach(() => portalSessions.clear());

  it('a google mint stores its hd and reads back as a capped, pinned google session', async () => {
    const res = await mint({ ...base, method: 'google', googleHostedDomain: 'Contoso.Example.com' } as MintInput);
    expect(res.status).toBe(200);
    const { token } = await res.json() as { token: string };
    const stored = portalSessions.get(token)!;
    expect(stored).toEqual({
      token, ...base, method: 'google', googleHostedDomain: HD, createdAt: expect.any(Date), expiresAt: expect.any(Date),
    });
    expect('entraTenantId' in stored).toBe(false);
    const parsed = parseStoredPortalSession(stored)!;
    expect(parsed).toEqual({ ...base, method: 'google', createdAtMs: stored.createdAt.getTime(), entraTenantId: null, googleHostedDomain: HD });
    expect(isBrowserSessionAllowed(parsed, { authMethod: 'google', browserAccess: 'granted' }, googleOnly, Date.now())).toBe(true);

    // Password and entra mints carry no hd key at all.
    const pwToken = (await (await mint({ ...base, method: 'password' })).json() as { token: string }).token;
    const entraToken = (await (await mint({ ...base, method: 'entra', entraTenantId: TENANT })).json() as { token: string }).token;
    expect('googleHostedDomain' in portalSessions.get(pwToken)!).toBe(false);
    expect('googleHostedDomain' in portalSessions.get(entraToken)!).toBe(false);
  });

  it('mint refuses googleHostedDomain on a non-google session and requires it on a google one', async () => {
    for (const input of [
      { ...base, method: 'google' },
      { ...base, method: 'google', googleHostedDomain: '' },
      { ...base, method: 'google', googleHostedDomain: 'not a domain' },
      { ...base, method: 'google', googleHostedDomain: '*.example.com' },
      { ...base, method: 'google', googleHostedDomain: ' contoso.example.com' },
      { ...base, method: 'google', googleHostedDomain: HD, entraTenantId: TENANT },
      { ...base, method: 'password', googleHostedDomain: HD },
      { ...base, method: 'entra', entraTenantId: TENANT, googleHostedDomain: HD },
    ]) {
      const res = await mint(input as MintInput);
      expect(res.status).toBe(500);
      expect(res.headers.getSetCookie()).toEqual([]);
    }
    expect(portalSessions.size).toBe(0);
  });
});
