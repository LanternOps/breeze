import { describe, expect, it, vi, afterEach } from 'vitest';
import { portalApi, trustBadgePath, trustDocumentPath } from './api';

describe('trust api paths', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('builds encoded public paths', () => {
    expect(trustBadgePath('nw', 'acme')).toBe('/api/v1/trust/public/nw/acme/badge.svg');
    expect(trustDocumentPath('nw', 'acme', 'd1')).toBe('/api/v1/trust/public/nw/acme/documents/d1');
  });
  it('card and page hit the right endpoints without an auth redirect', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: {} }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await portalApi.getTrustCard('nw', 'acme');
    expect(fetchMock.mock.calls[0][0]).toMatch(/\/api\/v1\/trust\/card\/nw\/acme$/);
    await portalApi.getTrustPage('nw', null);
    expect(fetchMock.mock.calls[1][0]).toMatch(/\/api\/v1\/trust\/public\/nw$/);
    await portalApi.getTrustPreview('tok');
    expect(fetchMock.mock.calls[2][0]).toMatch(/\/api\/v1\/trust\/public\/preview\/tok$/);
  });
});
