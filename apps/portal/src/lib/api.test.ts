import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { buildPortalApiUrl, portalApi, publicApiPath } from './api';

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


describe('publicApiPath (rendered into HTML)', () => {
  it('is same-origin relative on the server even with INTERNAL_API_URL set', async () => {
    vi.stubEnv('INTERNAL_API_URL', 'http://api:3001');
    const { publicApiPath, buildPortalApiUrl } = await import('./api');
    expect(publicApiPath('/portal/quotes/q1/pdf')).toBe('/api/v1/portal/quotes/q1/pdf');
    // The contrast that matters: the fetch URL may carry the internal host, the
    // rendered path never does.
    expect(buildPortalApiUrl('/portal/quotes/q1/pdf')).toMatch(/^http:\/\/api:3001\/api\/v1\/portal\/quotes\/q1\/pdf$/);
    vi.unstubAllEnvs();
  });

  it('normalises a leading /api/ and a missing slash', async () => {
    const { publicApiPath } = await import('./api');
    expect(publicApiPath('portal/x')).toBe('/api/v1/portal/x');
    expect(publicApiPath('/api/portal/x')).toBe('/api/v1/portal/x');
  });
});

it('preserves enriched device fields and exposes a same-origin CSV path', async () => {
  const row = {
    id: 'd-1',
    hostname: 'Laptop',
    displayName: null,
    osType: 'windows',
    osVersion: '11',
    status: 'online',
    lastSeenAt: null,
    lastPatchAt: null,
    protection: 'unknown',
    encryption: null,
    lastBackupAt: null,
    warrantyEndsAt: null,
  };
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
    new Response(JSON.stringify({
      data: [row],
      pagination: { page: 1, limit: 50, total: 1 },
    }), { status: 200 }),
  ));

  await expect(portalApi.getDevices()).resolves.toMatchObject({ data: [row] });
  expect(publicApiPath('/portal/devices/export.csv')).toBe(
    '/api/v1/portal/devices/export.csv',
  );
});

// ---------------------------------------------------------------------------
// W08 #3902
// ---------------------------------------------------------------------------
describe('portalAttachmentContentPath', () => {
  it('is a same-origin /api/v1 path — the SSR-internal host must never reach customer HTML', async () => {
    const { portalAttachmentContentPath } = await import('./api');
    const path = portalAttachmentContentPath('t-1', 'a-1');
    expect(path).toBe('/api/v1/portal/tickets/t-1/attachments/a-1/content');
    expect(path.startsWith('http')).toBe(false);
  });
});

describe('portalApi.getBrandingByDomain', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('loads public branding by encoded domain', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({
        branding: { name: 'Customer Portal' },
      }),
      { status: 200 },
    ));
    vi.stubGlobal('fetch', fetchMock);

    const result = await portalApi.getBrandingByDomain(
      'customer portal.example',
    );

    expect(String(fetchMock.mock.calls[0][0])).toContain(
      '/portal/branding/customer%20portal.example',
    );
    expect(result.data).toEqual({ name: 'Customer Portal' });
    vi.unstubAllGlobals();
  });
});

describe('ApiRequestConfig.timeoutMs', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('attaches an AbortSignal built from timeoutMs to the fetch call', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ branding: { name: 'Customer Portal' } }),
      { status: 200 },
    ));
    vi.stubGlobal('fetch', fetchMock);

    await portalApi.getBranding({ redirectOnUnauthorized: false, timeoutMs: 3000 });

    const [, init] = fetchMock.mock.calls[0];
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('omits signal when timeoutMs is not set, unchanged from prior behavior', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ branding: { name: 'Customer Portal' } }),
      { status: 200 },
    ));
    vi.stubGlobal('fetch', fetchMock);

    await portalApi.getBranding({ redirectOnUnauthorized: false });

    const [, init] = fetchMock.mock.calls[0];
    expect(init.signal).toBeUndefined();
  });

  it('falls through to the existing network-error path when the fetch aborts', async () => {
    const abortError = new DOMException('The operation was aborted.', 'TimeoutError');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(abortError));

    const result = await portalApi.getBranding({ redirectOnUnauthorized: false, timeoutMs: 3000 });

    expect(result.data).toBeUndefined();
    expect(result.error).toBe('Network error');
  });
});

describe('portal security client', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('uses the overview and paginated device paths', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        asOf: '2026-09-02T12:00:00.000Z',
        dataStatus: 'no_data',
        score: null,
        band: null,
        scoreHistory: [],
        threatEvents: { label: 'endpoint threat events', weeks: [] },
        vulnerabilities: {
          openBySeverity: {
            critical: 0, high: 0, medium: 0, low: 0, unknown: 0,
          },
          kevCount: 0,
          lastDetectedAt: null,
        },
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        dataStatus: 'no_data',
        asOf: '2026-09-02T12:00:00.000Z',
        data: [],
        pagination: { page: 2, limit: 25, total: 0 },
      }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await portalApi.getSecurityOverview(30);
    await portalApi.getSecurityDevices({ page: 2, limit: 25 });

    expect(String(fetchMock.mock.calls[0][0])).toContain(
      '/portal/security/overview?days=30',
    );
    expect(String(fetchMock.mock.calls[1][0])).toContain(
      '/portal/security/devices?page=2&limit=25',
    );
  });
});
