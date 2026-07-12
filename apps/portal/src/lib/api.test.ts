import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { buildPortalApiUrl, portalApi } from './api';

// Regression guard for the same-origin client API base (the deploy relies on it):
// with PUBLIC_API_URL unset, the browser must issue RELATIVE /api/v1 requests so
// the reverse proxy routes them to the API. A previous default of
// `http://localhost:3001` produced an absolute, CSP-blocked, wrong-port URL.
//
// Simulate the browser by defining a minimal `window` (the empty-base path returns
// before reading window.location, so a stub is enough).
describe('buildPortalApiUrl (client, PUBLIC_API_URL unset)', () => {
  beforeAll(() => {
    (globalThis as unknown as { window?: unknown }).window = {
      location: { origin: 'http://localhost', hostname: 'localhost' }
    };
  });
  afterAll(() => {
    delete (globalThis as unknown as { window?: unknown }).window;
  });

  it('produces a same-origin relative /api/v1 path', () => {
    expect(buildPortalApiUrl('/portal/auth/login')).toBe('/api/v1/portal/auth/login');
  });

  it('does not emit an absolute http://localhost:3001 origin', () => {
    expect(buildPortalApiUrl('/portal/devices')).not.toMatch(/^https?:\/\//);
  });

  it('rewrites a leading /api/ to the versioned /api/v1 prefix', () => {
    expect(buildPortalApiUrl('/api/portal/branding/x')).toBe('/api/v1/portal/branding/x');
  });

  it('passes absolute URLs through untouched', () => {
    expect(buildPortalApiUrl('https://files.example/x.pdf')).toBe('https://files.example/x.pdf');
  });
});

// Pin the literal request path of the intake-forms read. A typo here would be
// invisible forever: NewTicketForm silently degrades to the legacy form on any
// fetch failure, so a 404'ing path would never surface in the UI.
describe('portalApi.getTicketForms request path', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('GETs /portal/tickets/forms (under the /tickets auth prefix, NOT /ticket-forms)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: [] }), { status: 200 })
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await portalApi.getTicketForms();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain('/portal/tickets/forms');
    expect(url).not.toContain('/portal/ticket-forms');
    expect(result.data).toEqual([]);
  });
});
