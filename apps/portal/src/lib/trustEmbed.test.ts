import { afterEach, describe, expect, it, vi } from 'vitest';
import { getTrustEmbedCard, trustEmbedFullPagePath } from './trustEmbed';

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

describe('trustEmbedFullPagePath', () => {
  it('maps the embed to its full page (base-relative)', () => {
    expect(trustEmbedFullPagePath('nw', 'acme')).toBe('/trust/nw/acme');
    expect(trustEmbedFullPagePath('nw', null)).toBe('/trust/nw');
  });
});
