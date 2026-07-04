import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../db', () => ({
  db: { select: vi.fn() },
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

vi.mock('../../db/schema', () => ({
  partners: { id: 'partners.id' },
  ssoProviders: {
    id: 'ssoProviders.id',
    partnerId: 'ssoProviders.partnerId',
    name: 'ssoProviders.name',
    status: 'ssoProviders.status',
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

import { loginContextRoutes } from './loginContext';
import { db, withSystemDbAccessContext } from '../../db';
import { rateLimiter, getRedis } from '../../services';
import { captureException } from '../../services/sentry';

const PARTNER_UUID = '00000000-0000-4000-8000-000000000030';
const PARTNER_UUID_2 = '00000000-0000-4000-8000-000000000031';

// Builds a select() return value that supports both call shapes used by the
// route: `.from(t).limit(n)` (the partner-count probe, no filter) and
// `.from(t).where(cond).limit(n)` (the branding/provider lookups).
function selectChain(rows: unknown[]) {
  return {
    from: vi.fn().mockReturnValue({
      limit: vi.fn().mockResolvedValue(rows),
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue(rows),
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
  });

  it('returns branding + partnerSso on a single-partner instance with both configured', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(selectChain([{ id: PARTNER_UUID }]) as any)
      .mockReturnValueOnce(selectChain([{
        logoUrl: 'https://cdn.example.com/logo.png',
        accentColor: '#112233',
        headline: 'Welcome back'
      }]) as any)
      .mockReturnValueOnce(selectChain([{ name: 'Okta' }]) as any);

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
        available: true,
        providerName: 'Okta',
        loginUrl: `/api/v1/sso/login/partner/${PARTNER_UUID}`
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

  it('omits provider config beyond name + loginUrl', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(selectChain([{ id: PARTNER_UUID }]) as any)
      .mockReturnValueOnce(selectChain([]) as any)
      .mockReturnValueOnce(selectChain([{ name: 'Okta' }]) as any);

    const res = await getContext();
    const body = await res.json();
    expect(Object.keys(body.partnerSso).sort()).toEqual(['available', 'loginUrl', 'providerName']);
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
