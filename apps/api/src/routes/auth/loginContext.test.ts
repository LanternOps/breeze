import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../db', () => ({
  db: { select: vi.fn() },
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

vi.mock('../../db/schema', () => ({
  partners: {
    id: 'partners.id',
    slug: 'partners.slug',
    status: 'partners.status',
    deletedAt: 'partners.deletedAt',
  },
  ssoProviders: {
    id: 'ssoProviders.id',
    partnerId: 'ssoProviders.partnerId',
    name: 'ssoProviders.name',
    status: 'ssoProviders.status',
    enforceSSO: 'ssoProviders.enforceSSO',
  },
  partnerLoginBranding: {
    partnerId: 'partnerLoginBranding.partnerId',
    logoUrl: 'partnerLoginBranding.logoUrl',
    accentColor: 'partnerLoginBranding.accentColor',
    headline: 'partnerLoginBranding.headline',
  },
}));

vi.mock('../../services', () => ({
  rateLimiter: vi.fn(async () => ({ allowed: true, remaining: 29, resetAt: new Date() })),
  getRedis: vi.fn(() => ({})),
}));

vi.mock('../../services/sentry', () => ({
  captureException: vi.fn(),
}));

// The shared auth response floor is a no-op under NODE_ENV=test anyway; mocked
// here so the slug route's "awaited on every path" contract is observable.
vi.mock('./helpers', () => ({
  authResponseFloorPromise: vi.fn(() => Promise.resolve()),
}));

import { loginContextRoutes } from './loginContext';
import { authResponseFloorPromise } from './helpers';
import { db, withSystemDbAccessContext } from '../../db';
import { rateLimiter, getRedis } from '../../services';
import { captureException } from '../../services/sentry';

const PARTNER_UUID = '00000000-0000-4000-8000-000000000030';
const PARTNER_UUID_2 = '00000000-0000-4000-8000-000000000031';

// Builds a select() return value that supports the call shapes used by the
// route: `.from(t).limit(n)` (the partner-count probe, no filter),
// `.from(t).where(cond).limit(n)` (the branding lookup), and
// `.from(t).where(cond).orderBy(...).limit(n)` (the deterministic provider
// pick, #2195).
function selectChain(rows: unknown[]) {
  return {
    from: vi.fn().mockReturnValue({
      limit: vi.fn().mockResolvedValue(rows),
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue(rows),
        orderBy: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue(rows),
        }),
      }),
    }),
  };
}

async function getContext() {
  return loginContextRoutes.request('/login-context');
}

describe('GET /auth/login-context (#2183)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getRedis).mockReturnValue({} as any);
    vi.mocked(rateLimiter).mockResolvedValue({ allowed: true, remaining: 29, resetAt: new Date() } as any);
    vi.mocked(db.select).mockReset().mockReturnValue(selectChain([]) as any);
    delete process.env.IS_HOSTED;
  });

  // Every hosted spelling the production config validator accepts must trip
  // the guard (envFlag, not a bare === 'true') — an IS_HOSTED=1 deploy that
  // missed the guard would publicly serve a single-partner region's branding.
  it.each(['true', '1', 'yes', 'on'])(
    'short-circuits to all-null on a hosted instance (IS_HOSTED=%s) without touching the DB (#2195)',
    async (spelling) => {
      process.env.IS_HOSTED = spelling;
      vi.mocked(db.select).mockReturnValueOnce(selectChain([{ id: PARTNER_UUID }]) as any);

      const res = await getContext();
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ branding: null, partnerSso: null });
      // The single-partner fast-path must never run on hosted — even a region
      // with exactly one partner reveals nothing.
      expect(db.select).not.toHaveBeenCalled();
    }
  );

  it('returns branding + partnerSso on a single-partner instance with both configured', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(selectChain([{ id: PARTNER_UUID }]) as any)
      .mockReturnValueOnce(selectChain([{
        logoUrl: 'https://cdn.example.com/logo.png',
        accentColor: '#112233',
        headline: 'Welcome back'
      }]) as any)
      .mockReturnValueOnce(selectChain([{ name: 'Okta', enforceSSO: true }]) as any);

    const res = await getContext();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      branding: {
        logoUrl: 'https://cdn.example.com/logo.png',
        accentColor: '#112233',
        headline: 'Welcome back'
      },
      partnerSso: {
        providerName: 'Okta',
        loginUrl: `/api/v1/sso/login/partner/${PARTNER_UUID}`,
        enforceSSO: true
      }
    });
  });

  it('passes through enforceSSO: false when the provider does not enforce SSO', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(selectChain([{ id: PARTNER_UUID }]) as any)
      .mockReturnValueOnce(selectChain([]) as any)
      .mockReturnValueOnce(selectChain([{ name: 'Okta', enforceSSO: false }]) as any);

    const res = await getContext();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      branding: null,
      partnerSso: {
        providerName: 'Okta',
        loginUrl: `/api/v1/sso/login/partner/${PARTNER_UUID}`,
        enforceSSO: false
      }
    });
  });

  it('returns branding null / partnerSso null when neither is configured (single partner)', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(selectChain([{ id: PARTNER_UUID }]) as any)
      .mockReturnValueOnce(selectChain([]) as any)
      .mockReturnValueOnce(selectChain([]) as any);

    const res = await getContext();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ branding: null, partnerSso: null });
  });

  it('returns all-null on a multi-partner instance (no tenant leakage)', async () => {
    vi.mocked(db.select).mockReturnValueOnce(
      selectChain([{ id: PARTNER_UUID }, { id: PARTNER_UUID_2 }]) as any
    );

    const res = await getContext();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ branding: null, partnerSso: null });
    // Only the partner-count probe should run — no branding/provider lookup,
    // no partner id/name ever touches the response.
    expect(db.select).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(body)).not.toContain(PARTNER_UUID);
  });

  it('returns all-null on a zero-partner instance', async () => {
    vi.mocked(db.select).mockReturnValueOnce(selectChain([]) as any);

    const res = await getContext();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ branding: null, partnerSso: null });
    expect(db.select).toHaveBeenCalledTimes(1);
  });

  it('omits provider config beyond name + loginUrl + enforceSSO', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(selectChain([{ id: PARTNER_UUID }]) as any)
      .mockReturnValueOnce(selectChain([]) as any)
      .mockReturnValueOnce(selectChain([{ name: 'Okta', enforceSSO: true }]) as any);

    const res = await getContext();
    const body = await res.json();
    expect(Object.keys(body.partnerSso).sort()).toEqual(['enforceSSO', 'loginUrl', 'providerName']);
  });

  it('429s past the rate limit', async () => {
    vi.mocked(rateLimiter).mockResolvedValueOnce({ allowed: false, remaining: 0, resetAt: new Date() } as any);

    const res = await getContext();
    expect(res.status).toBe(429);
    expect(db.select).not.toHaveBeenCalled();
  });

  it('calls rateLimiter unconditionally when Redis is unavailable (fail-closed, no skip-the-check guard)', async () => {
    vi.mocked(getRedis).mockReturnValue(null as any);
    // rateLimiter itself fails closed on a null redis client in production;
    // here we assert the route still invokes it (with the null client) and
    // honors whatever it returns, rather than short-circuiting past it.
    vi.mocked(rateLimiter).mockResolvedValueOnce({ allowed: false, remaining: 0, resetAt: new Date() } as any);

    const res = await getContext();
    expect(rateLimiter).toHaveBeenCalledWith(null, expect.stringContaining('login-context:'), 30, 60);
    expect(res.status).toBe(429);
    expect(db.select).not.toHaveBeenCalled();
  });

  it('degrades to the stock page (200, null shape, no-store) when the DB read throws', async () => {
    vi.mocked(withSystemDbAccessContext).mockRejectedValueOnce(new Error('connection reset'));
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const res = await getContext();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ branding: null, partnerSso: null });
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(consoleErrorSpy).toHaveBeenCalled();
    expect(captureException).toHaveBeenCalledWith(expect.any(Error), expect.anything());

    consoleErrorSpy.mockRestore();
  });
});

async function getSlugContext(slug: string) {
  return loginContextRoutes.request(`/login-context/partner/${slug}`);
}

const NULL_CONTEXT = { branding: null, partnerSso: null };

describe('GET /auth/login-context/partner/:slug (#4017)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getRedis).mockReturnValue({} as any);
    vi.mocked(rateLimiter).mockResolvedValue({ allowed: true, remaining: 29, resetAt: new Date() } as any);
    vi.mocked(db.select).mockReset().mockReturnValue(selectChain([]) as any);
    delete process.env.IS_HOSTED;
  });

  it.each(['true', '1'])(
    'resolves on a hosted instance (IS_HOSTED=%s) — the visitor supplies the tenant, so no hosted guard',
    async (spelling) => {
      process.env.IS_HOSTED = spelling;
      vi.mocked(db.select)
        .mockReturnValueOnce(selectChain([{ id: PARTNER_UUID, slug: 'acme-msp' }]) as any)
        .mockReturnValueOnce(selectChain([]) as any)
        .mockReturnValueOnce(selectChain([{ name: 'Okta', enforceSSO: true }]) as any);

      const res = await getSlugContext('acme-msp');
      expect(res.status).toBe(200);
      expect((await res.json()).partnerSso).toEqual({
        providerName: 'Okta',
        loginUrl: `/api/v1/sso/login/partner/${PARTNER_UUID}`,
        enforceSSO: true,
      });
    }
  );

  it('resolves branding + partnerSso for a known slug', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(selectChain([{ id: PARTNER_UUID, slug: 'acme-msp' }]) as any)
      .mockReturnValueOnce(selectChain([{
        logoUrl: 'https://cdn.example.com/logo.png',
        accentColor: '#112233',
        headline: 'Welcome back',
      }]) as any)
      .mockReturnValueOnce(selectChain([{ name: 'Okta', enforceSSO: false }]) as any);

    const res = await getSlugContext('acme-msp');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      branding: { logoUrl: 'https://cdn.example.com/logo.png', accentColor: '#112233', headline: 'Welcome back' },
      partnerSso: { providerName: 'Okta', loginUrl: `/api/v1/sso/login/partner/${PARTNER_UUID}`, enforceSSO: false },
    });
  });

  it('returns the null shape for an unknown slug, with no branding/provider read', async () => {
    const res = await getSlugContext('does-not-exist');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(NULL_CONTEXT);
    expect(db.select).toHaveBeenCalledTimes(1);
  });

  it('answers an unknown slug and a known-but-unconfigured slug identically (status, body, headers)', async () => {
    const unknown = await getSlugContext('ghost-partner');

    vi.mocked(db.select)
      .mockReturnValueOnce(selectChain([{ id: PARTNER_UUID, slug: 'quiet-partner' }]) as any)
      .mockReturnValueOnce(selectChain([]) as any)
      .mockReturnValueOnce(selectChain([]) as any);
    const known = await getSlugContext('quiet-partner');

    expect(known.status).toBe(unknown.status);
    expect(await known.text()).toBe(await unknown.text());
    expect([...known.headers.entries()]).toEqual([...unknown.headers.entries()]);
  });

  it('is never publicly cacheable', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(selectChain([{ id: PARTNER_UUID, slug: 'acme-msp' }]) as any)
      .mockReturnValueOnce(selectChain([]) as any)
      .mockReturnValueOnce(selectChain([{ name: 'Okta', enforceSSO: false }]) as any);

    const res = await getSlugContext('acme-msp');
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('awaits the shared auth response floor before answering', async () => {
    let release!: () => void;
    vi.mocked(authResponseFloorPromise).mockReturnValueOnce(new Promise<void>((r) => { release = r; }));

    let settled = false;
    const pending = getSlugContext('ghost-partner').then((res) => { settled = true; return res; });
    await new Promise((r) => setTimeout(r, 20));
    expect(settled).toBe(false);

    release();
    expect((await pending).status).toBe(200);
  });

  it('matches case-insensitively and prefers the exact-case row when two slugs differ only by case', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(selectChain([
        { id: PARTNER_UUID_2, slug: 'acme' },
        { id: PARTNER_UUID, slug: 'Acme' },
      ]) as any)
      .mockReturnValueOnce(selectChain([]) as any)
      .mockReturnValueOnce(selectChain([{ name: 'Okta', enforceSSO: false }]) as any);

    const body = await (await getSlugContext('Acme')).json();
    expect(body.partnerSso.loginUrl).toBe(`/api/v1/sso/login/partner/${PARTNER_UUID}`);
  });

  it('refuses to guess when two slugs differ only by case and neither matches exactly', async () => {
    vi.mocked(db.select).mockReturnValueOnce(selectChain([
      { id: PARTNER_UUID_2, slug: 'acme' },
      { id: PARTNER_UUID, slug: 'Acme' },
    ]) as any);

    const res = await getSlugContext('ACME');
    expect(await res.json()).toEqual(NULL_CONTEXT);
    expect(db.select).toHaveBeenCalledTimes(1);
  });

  it('429s past its own rate-limit bucket without touching the DB', async () => {
    vi.mocked(rateLimiter).mockResolvedValueOnce({ allowed: false, remaining: 0, resetAt: new Date() } as any);

    const res = await getSlugContext('acme-msp');
    expect(res.status).toBe(429);
    expect(db.select).not.toHaveBeenCalled();
    expect(rateLimiter).toHaveBeenCalledWith(expect.anything(), expect.stringContaining('login-context:slug:'), 30, 60);
  });

  it('calls rateLimiter even when Redis is unavailable (fail-closed)', async () => {
    vi.mocked(getRedis).mockReturnValue(null as any);
    vi.mocked(rateLimiter).mockResolvedValueOnce({ allowed: false, remaining: 0, resetAt: new Date() } as any);

    const res = await getSlugContext('acme-msp');
    expect(rateLimiter).toHaveBeenCalledWith(null, expect.stringContaining('login-context:slug:'), 30, 60);
    expect(res.status).toBe(429);
  });

  it('400s on an oversized slug without touching the DB', async () => {
    const res = await getSlugContext('a'.repeat(101));
    expect(res.status).toBe(400);
    expect(db.select).not.toHaveBeenCalled();
  });

  it('degrades to the null shape (200, no-store) when the DB read throws', async () => {
    vi.mocked(withSystemDbAccessContext).mockRejectedValueOnce(new Error('connection reset'));
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const res = await getSlugContext('acme-msp');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(NULL_CONTEXT);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(captureException).toHaveBeenCalledWith(expect.any(Error), expect.anything());

    consoleErrorSpy.mockRestore();
  });
});
