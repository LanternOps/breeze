import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultBranding, loadPortalBranding, loadPortalBrandingWithStatus, loadPortalProfile } from './server';

// Regression guard for the fix-round-1 finding on Task 3.4: loadPortalBranding
// is awaited by the middleware on every '/' visit and auth-only-path redirect
// for a signed-in customer (to pick the flag-aware landing page). A *hanging*
// (not erroring) branding fetch there would block those requests forever —
// fail-closed on the VALUE (defaultBranding → /quotes) is worthless without a
// bound on WHEN. The fetch now carries a timeoutMs-derived AbortSignal
// (apps/portal/src/lib/api.ts), so an abort/timeout must fall through to the
// same defaultBranding fallback as any other network error.
describe('loadPortalBranding — bounded branding fetch (fix round 1)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('falls back to defaultBranding when the branding fetch times out', async () => {
    const timeoutError = new DOMException('The operation timed out.', 'TimeoutError');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(timeoutError));

    const request = new Request('https://portal.example/', {
      headers: { host: 'portal.example' }
    });

    const branding = await loadPortalBranding(request);

    expect(branding).toEqual(defaultBranding);
  });

  it('passes a bounded AbortSignal on the branding fetch (no session cookie path)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ branding: { name: 'Customer Portal' } }),
      { status: 200 }
    ));
    vi.stubGlobal('fetch', fetchMock);

    const request = new Request('https://portal.example/', {
      headers: { host: 'portal.example' }
    });

    await loadPortalBranding(request);

    const [, init] = fetchMock.mock.calls[0];
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
});

// sweep 2026-09-08 G5-6 — the middleware's login-redirect guard needs to know
// WHY a branding fetch failed, not just that it did, so it can send a
// disabled account to its own page instead of computing a landing path from
// (now-defaulted) branding that was never really loaded.
describe('loadPortalBrandingWithStatus — account-disabled detection', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reports accountDisabled when the authenticated branding call 403s with the inactive code', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ error: 'Account is not active', code: 'PORTAL_ACCOUNT_INACTIVE' }),
      { status: 403 }
    ));
    vi.stubGlobal('fetch', fetchMock);

    const request = new Request('https://portal.example/login', {
      headers: { host: 'portal.example', cookie: 'breeze_portal_session=test-session-token' }
    });

    const { branding, accountDisabled } = await loadPortalBrandingWithStatus(request);

    expect(accountDisabled).toBe(true);
    expect(branding).toEqual(defaultBranding);
  });

  it('reports accountDisabled: false for a normal authenticated branding load', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ branding: { name: 'Acme Support', enableDashboard: true } }),
      { status: 200 }
    ));
    vi.stubGlobal('fetch', fetchMock);

    const request = new Request('https://portal.example/login', {
      headers: { host: 'portal.example', cookie: 'breeze_portal_session=test-session-token' }
    });

    const { branding, accountDisabled } = await loadPortalBrandingWithStatus(request);

    expect(accountDisabled).toBe(false);
    expect(branding.enableDashboard).toBe(true);
  });

  // Review finding on qa/sweep-post-v0.110.0: `accountDisabled` was computed
  // from the FIRST (session) response, before the 401-retry re-assigns
  // `response` to the public-domain lookup. A session that 401s (expired)
  // and then hits an account-disabled 403 on the retried public-domain call
  // never surfaced as `accountDisabled: true` — it must be computed from the
  // FINAL response, after the retry.
  it('reports accountDisabled when the retried (post-401) domain lookup 403s with the inactive code', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 }))
      .mockResolvedValueOnce(new Response(
        JSON.stringify({ error: 'Account is not active', code: 'PORTAL_ACCOUNT_INACTIVE' }),
        { status: 403 }
      ));
    vi.stubGlobal('fetch', fetchMock);

    const request = new Request('https://portal.example/login', {
      headers: { host: 'portal.example', cookie: 'breeze_portal_session=test-session-token' }
    });

    const { accountDisabled } = await loadPortalBrandingWithStatus(request);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(accountDisabled).toBe(true);
  });

  it('loadPortalBranding still returns just the branding half (no behavior change)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ error: 'Account is not active', code: 'PORTAL_ACCOUNT_INACTIVE' }),
      { status: 403 }
    ));
    vi.stubGlobal('fetch', fetchMock);

    const request = new Request('https://portal.example/login', {
      headers: { host: 'portal.example', cookie: 'breeze_portal_session=test-session-token' }
    });

    const branding = await loadPortalBranding(request);

    expect(branding).toEqual(defaultBranding);
  });
});

// #5320 — the middleware now resolves the account status on every protected
// page, and the layout that page renders loads branding again. Both go through
// loadPortalBrandingWithStatus, so the pair must cost ONE API call per request,
// not two.
describe('loadPortalBrandingWithStatus — per-request memoization', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('issues a single branding fetch for repeated loads on the same request', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ branding: { name: 'Acme IT' } }),
      { status: 200 }
    ));
    vi.stubGlobal('fetch', fetchMock);

    const request = new Request('https://portal.example/security', {
      headers: { host: 'portal.example', cookie: 'breeze_portal_session=test-session-token' }
    });

    const first = await loadPortalBrandingWithStatus(request);
    const second = await loadPortalBranding(request);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first.branding);
  });

  it('does not share a memo across requests', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ branding: { name: 'Acme IT' } }),
      { status: 200 }
    ));
    vi.stubGlobal('fetch', fetchMock);

    await loadPortalBrandingWithStatus(new Request('https://portal.example/security', {
      headers: { host: 'portal.example' }
    }));
    await loadPortalBrandingWithStatus(new Request('https://portal.example/security', {
      headers: { host: 'portal.example' }
    }));

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('loadPortalProfile — header account context', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns null (never throws) without a session cookie and makes no request', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const profile = await loadPortalProfile(new Request('https://portal.example/devices', {
      headers: { host: 'portal.example' }
    }));
    expect(profile).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns the signed-in customer and memoizes per request', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ user: { id: 'u1', organizationName: 'Acme Co', name: 'Jane Doe', email: 'jane@acme.test' } }),
      { status: 200 }
    ));
    vi.stubGlobal('fetch', fetchMock);
    const request = new Request('https://portal.example/devices', {
      headers: { host: 'portal.example', cookie: 'breeze_portal_session=test-session-token' }
    });
    const first = await loadPortalProfile(request);
    const second = await loadPortalProfile(request);
    expect(first?.organizationName).toBe('Acme Co');
    expect(second).toBe(first);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('returns null on a failed load instead of breaking the page', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('nope', { status: 500 })));
    const profile = await loadPortalProfile(new Request('https://portal.example/devices', {
      headers: { host: 'portal.example', cookie: 'breeze_portal_session=test-session-token' }
    }));
    expect(profile).toBeNull();
  });
});
