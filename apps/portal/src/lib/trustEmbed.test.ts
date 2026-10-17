import { afterEach, describe, expect, it, vi } from 'vitest';
import { getTrustEmbedCard, loadTrustEmbedPage, trustEmbedFullPagePath } from './trustEmbed';

const GENERIC_404 = { error: 'Not found', code: 'NOT_FOUND' };

const CARD = {
  title: 'Acme · Security posture', orgName: 'Acme', logoUrl: null, primaryColor: null, managedByName: 'NW',
  summaryLine: 'Showing 15 of 15 Breeze-verifiable controls · 9 met', publishedAt: '2026-10-01T00:00:00.000Z',
  lastEvaluatedAt: '2026-10-16T00:00:00.000Z', stale: false, searchIndexable: false, locale: 'en',
  controlsShown: 15, catalogTotal: 15, controlsMet: 9,
};
const respond = (body: unknown, status = 200) => vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status }));

describe('getTrustEmbedCard (W03a)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('reads the card endpoint (org and partner-home) and returns frameAncestors', async () => {
    const fetchMock = respond({ data: { ...CARD, frameAncestors: ['https://example.com'] } });
    vi.stubGlobal('fetch', fetchMock);
    expect(await getTrustEmbedCard('nw', 'acme')).toMatchObject({ orgName: 'Acme', frameAncestors: ['https://example.com'] });
    expect(fetchMock.mock.calls[0][0]).toMatch(/\/api\/v1\/trust\/card\/nw\/acme$/);
    await getTrustEmbedCard('nw', null);
    expect(fetchMock.mock.calls[1][0]).toMatch(/\/api\/v1\/trust\/card\/nw$/);
  });

  it('404, 503 and network errors → null', async () => {
    vi.stubGlobal('fetch', respond({ error: 'Not found', code: 'NOT_FOUND' }, 404));
    expect(await getTrustEmbedCard('nw', 'acme')).toBeNull();
    vi.stubGlobal('fetch', respond({ error: 'Temporarily unavailable' }, 503));
    expect(await getTrustEmbedCard('nw', 'acme')).toBeNull();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('down')));
    expect(await getTrustEmbedCard('nw', 'acme')).toBeNull();
  });

  it('an API without frameAncestors (older build) means no embedding', async () => {
    vi.stubGlobal('fetch', respond({ data: CARD }));
    expect((await getTrustEmbedCard('nw', 'acme'))?.frameAncestors).toEqual([]);
  });

  it('drops any entry that is not a normalized https origin (defence in depth)', async () => {
    vi.stubGlobal('fetch', respond({ data: { ...CARD, frameAncestors: ['https://example.com', 'https://Evil.example', "'self'", 'https://x.example; script-src *', 7] } }));
    expect((await getTrustEmbedCard('nw', 'acme'))?.frameAncestors).toEqual(['https://example.com']);
  });
});

describe('loadTrustEmbedPage (the embed pages\' frontmatter)', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
  const ctx = () => {
    const url = new URL('https://portal.example/portal/trust/embed/nw/acme');
    return { url, request: new Request(url, { headers: { host: 'portal.example', 'x-forwarded-proto': 'https' } }), locals: {} as { trustEmbedOrigins?: string[] } };
  };

  it('a loaded card with origins hands them to the middleware via locals and links to the full page', async () => {
    vi.stubGlobal('fetch', respond({ data: { ...CARD, frameAncestors: ['https://example.com'] } }));
    const c = ctx();
    const out = await loadTrustEmbedPage(c, 'nw', 'acme');
    expect(c.locals.trustEmbedOrigins).toEqual(['https://example.com']);
    expect(out?.card.orgName).toBe('Acme');
    expect(out?.fullPageUrl).toMatch(/^https:\/\/portal\.example\/.*trust\/nw\/acme$/);
  });

  it('an empty allowlist, a 404 or a failed fetch → null and locals untouched (the page 404s, not framable)', async () => {
    for (const fetchMock of [respond({ data: { ...CARD, frameAncestors: [] } }), respond(GENERIC_404, 404), respond({}, 503)]) {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.stubGlobal('fetch', fetchMock);
      const c = ctx();
      expect(await loadTrustEmbedPage(c, 'nw', 'acme')).toBeNull();
      expect(c.locals.trustEmbedOrigins).toBeUndefined();
    }
  });

  it('reads the allowlist on every load: a removed origin is gone on the next request (Review Focus 1)', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { ...CARD, frameAncestors: ['https://a.example.com', 'https://b.example.com'] } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { ...CARD, frameAncestors: ['https://b.example.com'] } }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const first = ctx(); await loadTrustEmbedPage(first, 'nw', 'acme');
    const second = ctx(); await loadTrustEmbedPage(second, 'nw', 'acme');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(first.locals.trustEmbedOrigins).toEqual(['https://a.example.com', 'https://b.example.com']);
    expect(second.locals.trustEmbedOrigins).toEqual(['https://b.example.com']);
  });
});

describe('getTrustEmbedCard logging', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
  it('a 404 is quiet; a 503 or network failure is logged', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('fetch', respond(GENERIC_404, 404));
    await getTrustEmbedCard('nw', 'acme');
    expect(warn).not.toHaveBeenCalled();
    vi.stubGlobal('fetch', respond({}, 503));
    await getTrustEmbedCard('nw', 'acme');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('down')));
    await getTrustEmbedCard('nw', 'acme');
    expect(warn).toHaveBeenCalledTimes(2);
  });
  it('dropping a non-normalized entry is logged', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('fetch', respond({ data: { ...CARD, frameAncestors: ['https://example.com', "'self'"] } }));
    await getTrustEmbedCard('nw', 'acme');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('dropped'), expect.objectContaining({ dropped: 1 }));
  });
});

describe('trustEmbedFullPagePath', () => {
  it('maps the embed to its full page (base-relative)', () => {
    expect(trustEmbedFullPagePath('nw', 'acme')).toBe('/trust/nw/acme');
    expect(trustEmbedFullPagePath('nw', null)).toBe('/trust/nw');
  });
});
