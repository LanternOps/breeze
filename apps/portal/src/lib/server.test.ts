import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultBranding, loadPortalBranding, loadPortalBrandingWithStatus } from './server';

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
