import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
const serving = vi.hoisted(() => ({ isServing: vi.fn(), readCachedSnapshotPayload: vi.fn(async () => null), cacheSnapshotPayload: vi.fn() }));
vi.mock('../services/trustPage/servingSet', () => ({ ...serving, trustServingMember: (p: string, o?: string) => (o ? `${p}/${o}` : p) }));
const resolve = vi.hoisted(() => ({ resolvePublishedTrustPage: vi.fn() }));
vi.mock('../services/trustPage/resolve', async (orig) => ({ ...(await orig<typeof import('../services/trustPage/resolve')>()), ...resolve }));
const redis = vi.hoisted(() => ({ client: {} as unknown }));
vi.mock('../services/redis', () => ({ getRedis: () => redis.client }));
const limiter = vi.hoisted(() => ({ rateLimiter: vi.fn(async () => ({ allowed: true, remaining: 1, resetAt: new Date() })) }));
vi.mock('../services/rate-limit', () => limiter);
vi.mock('../services/clientIp', () => ({ getTrustedClientIp: () => '203.0.113.9', rateLimitIpKey: (ip: string) => ip }));
const dbSelect = vi.hoisted(() => vi.fn());
vi.mock('../db', () => ({ db: { select: dbSelect }, runOutsideDbContext: (fn: any) => fn(), withSystemDbAccessContext: (fn: any) => fn() }));
const preview = vi.hoisted(() => ({ verifyTrustPreviewToken: vi.fn(async (t: string) => (t === 'good' ? { pageId: 'pg', orgId: 'o' } : null)) }));
vi.mock('../services/trustPage/previewToken', () => preview);
vi.mock('../services/trustPage/publication', () => ({ buildSnapshotForPage: vi.fn(async () => ({ payload: { schemaVersion: 1, controls: [] }, snapshotId: 's', sha256: 'x', deviceCount: 0, generatedAt: new Date() })) }));
import { trustPagePublicRoutes } from './trustPagePublic';

const DOC_ID = '0f7f0d0e-5a1e-4d4b-9a7b-1c2d3e4f5a6d';
const PAYLOAD = { schemaVersion: 1, snapshotId: 's1', org: { name: 'Acme', logoUrl: null, primaryColor: null }, managedBy: { name: 'NW' }, summary: { catalogTotal: 15, controlsShown: 15, controlsMet: 9 }, controls: [], documents: [{ id: DOC_ID, title: 'Doc' }], footer: { poweredByBreeze: true, frameworkAttributions: [] } };
const RESOLVED = { pageId: 'pg', orgId: 'o', partnerId: 'p', publishedAt: new Date('2026-10-01T00:00:00Z'), searchIndexable: false, lastEvaluatedAt: new Date(), snapshotId: 's1', payload: PAYLOAD };
const app = new Hono(); app.route('/trust', trustPagePublicRoutes);
const GENERIC = { error: 'Not found', code: 'NOT_FOUND' };
const docRow = () => ({ from: () => ({ innerJoin: () => ({ leftJoin: () => ({ where: () => ({ limit: async () => [{ storageBackend: 'db', storageKey: null, data: Buffer.from('pdf'), contentType: 'application/pdf', originalFilename: 'p.pdf', byteSize: 3 }] }) }) }) }) });
const docNone = () => ({ from: () => ({ innerJoin: () => ({ leftJoin: () => ({ where: () => ({ limit: async () => [] }) }) }) }) });

async function expectGeneric404(res: Response) {
  expect(res.status).toBe(404);
  expect(await res.json()).toEqual(GENERIC);
}

describe('card', () => {
  beforeEach(() => { vi.clearAllMocks(); redis.client = {}; serving.isServing.mockResolvedValue(true); resolve.resolvePublishedTrustPage.mockResolvedValue(RESOLVED); });
  it('serving-set miss → generic 404 with ZERO SQL', async () => {
    serving.isServing.mockResolvedValue(false);
    const res = await app.request('/trust/card/nw/acme');
    expect(res.status).toBe(404); expect(await res.json()).toEqual(GENERIC);
    expect(resolve.resolvePublishedTrustPage).not.toHaveBeenCalled(); expect(dbSelect).not.toHaveBeenCalled();
  });
  it('invalid slug → 404 before Redis', async () => {
    const res = await app.request('/trust/card/NW/acme');
    expect(res.status).toBe(404); expect(serving.isServing).not.toHaveBeenCalled();
  });
  it('over-long slug → the same generic 404 (no validation-error body)', async () => {
    await expectGeneric404(await app.request(`/trust/card/${'x'.repeat(80)}/acme`));
    expect(serving.isServing).not.toHaveBeenCalled();
  });
  it('Redis unavailable → 503 with Retry-After, no SQL', async () => {
    redis.client = null; serving.isServing.mockResolvedValue(null);
    const res = await app.request('/trust/card/nw/acme');
    expect(res.status).toBe(503); expect(res.headers.get('Retry-After')).toBe('30'); expect(resolve.resolvePublishedTrustPage).not.toHaveBeenCalled();
    expect(dbSelect).not.toHaveBeenCalled();
  });
  it('hit → header card with summary line and stale flag', async () => {
    const res = await app.request('/trust/card/nw/acme');
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data).toMatchObject({ orgName: 'Acme', managedByName: 'NW', stale: false, summaryLine: expect.stringMatching(/9 met/) });
    expect(res.headers.get('X-Robots-Tag')).toBe('noindex');
  });
  it('partner-home card resolves without an org slug', async () => {
    const res = await app.request('/trust/card/nw');
    expect(res.status).toBe(200);
    expect(resolve.resolvePublishedTrustPage).toHaveBeenCalledWith('nw', null);
  });
  it('resolve null / payload missing → generic 404', async () => {
    resolve.resolvePublishedTrustPage.mockResolvedValueOnce(null);
    await expectGeneric404(await app.request('/trust/card/nw/acme'));
    resolve.resolvePublishedTrustPage.mockResolvedValueOnce({ ...RESOLVED, snapshotId: null, payload: null });
    await expectGeneric404(await app.request('/trust/card/nw/acme'));
  });
});

describe('payload', () => {
  beforeEach(() => { vi.clearAllMocks(); redis.client = {}; serving.isServing.mockResolvedValue(true); resolve.resolvePublishedTrustPage.mockResolvedValue(RESOLVED); });
  it('unknown / unpublished / untrusted all yield the SAME generic 404', async () => {
    resolve.resolvePublishedTrustPage.mockResolvedValue(null);
    const a = await app.request('/trust/public/nw/acme'); expect(a.status).toBe(404); expect(await a.json()).toEqual(GENERIC);
    serving.isServing.mockResolvedValue(false);
    const b = await app.request('/trust/public/nw/acme'); expect(b.status).toBe(404); expect(await b.json()).toEqual(GENERIC);
  });
  it('serving-set false → zero SQL on payload and badge', async () => {
    serving.isServing.mockResolvedValue(false);
    await expectGeneric404(await app.request('/trust/public/nw/acme'));
    await expectGeneric404(await app.request('/trust/public/nw/acme/badge.svg'));
    expect(resolve.resolvePublishedTrustPage).not.toHaveBeenCalled(); expect(dbSelect).not.toHaveBeenCalled();
  });
  it('Redis unavailable → still serves via the live resolve (rate-limited path)', async () => {
    redis.client = null; serving.isServing.mockResolvedValue(null);
    const res = await app.request('/trust/public/nw/acme');
    expect(res.status).toBe(200); expect(resolve.resolvePublishedTrustPage).toHaveBeenCalled();
  });
  it('serves payload + stale, uses the snapshot cache when present, applies public cache headers', async () => {
    serving.readCachedSnapshotPayload.mockResolvedValueOnce(PAYLOAD as never);
    const res = await app.request('/trust/public/nw/acme');
    expect(res.status).toBe(200);
    expect((await res.json()).data).toMatchObject({ payload: { snapshotId: 's1' }, stale: false });
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=300, stale-while-revalidate=600');
  });
  it('populates the snapshot cache on a cache miss', async () => {
    expect((await app.request('/trust/public/nw/acme')).status).toBe(200);
    expect(serving.cacheSnapshotPayload).toHaveBeenCalledWith('s1', PAYLOAD);
  });
  it('stale when last_evaluated_at is older than 24h', async () => {
    resolve.resolvePublishedTrustPage.mockResolvedValue({ ...RESOLVED, lastEvaluatedAt: new Date(Date.now() - 25 * 3600_000) });
    expect((await (await app.request('/trust/public/nw/acme')).json()).data.stale).toBe(true);
  });
  it('a partner restricted between card and payload fetch (Review Focus 5) → 404 from the live resolve', async () => {
    resolve.resolvePublishedTrustPage.mockResolvedValue(null); // predicate now fails
    expect((await app.request('/trust/public/nw/acme')).status).toBe(404);
  });
  it('partner-home payload resolves with a null org slug', async () => {
    expect((await app.request('/trust/public/nw')).status).toBe(200);
    expect(resolve.resolvePublishedTrustPage).toHaveBeenCalledWith('nw', null);
  });
  it('searchIndexable page drops noindex', async () => {
    resolve.resolvePublishedTrustPage.mockResolvedValue({ ...RESOLVED, searchIndexable: true });
    const res = await app.request('/trust/public/nw/acme');
    expect(res.headers.get('X-Robots-Tag')).not.toMatch(/noindex/);
  });
});

describe('badge, documents, preview', () => {
  beforeEach(() => { vi.clearAllMocks(); redis.client = {}; serving.isServing.mockResolvedValue(true); resolve.resolvePublishedTrustPage.mockResolvedValue(RESOLVED); });
  it('badge is an SVG without counts', async () => {
    const res = await app.request('/trust/public/nw/acme/badge.svg');
    expect(res.headers.get('Content-Type')).toMatch(/image\/svg\+xml/);
    const svg = await res.text();
    expect(svg).toMatch(/verified by Breeze/); expect(svg).not.toMatch(/\b9 met\b|of 15\b|controls/);
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=3600');
  });
  it('badge on serving-set null falls through to the live resolve', async () => {
    serving.isServing.mockResolvedValue(null);
    expect((await app.request('/trust/public/nw/acme/badge.svg')).status).toBe(200);
    expect(resolve.resolvePublishedTrustPage).toHaveBeenCalled();
  });
  it('document download refuses an unlinked id and streams a linked one', async () => {
    const miss = await app.request('/trust/public/nw/acme/documents/00000000-0000-4000-8000-000000000000');
    expect(miss.status).toBe(404);
    // Linked: the route checks payload.documents AND re-checks the live link in SQL (dbSelect returns the live row).
    dbSelect.mockReturnValue(docRow());
    const hit = await app.request(`/trust/public/nw/acme/documents/${DOC_ID}`);
    expect(hit.status).toBe(200);
    expect(hit.headers.get('Content-Disposition')).toMatch(/^attachment/);
    expect(hit.headers.get('Cache-Control')).toBe('no-store');
    expect(await hit.text()).toBe('pdf');
  });
  it('document unlinked from the snapshot never queries SQL', async () => {
    await expectGeneric404(await app.request('/trust/public/nw/acme/documents/00000000-0000-4000-8000-000000000000'));
    expect(dbSelect).not.toHaveBeenCalled();
  });
  it('document in the snapshot but unlinked/superseded/deleted live → generic 404', async () => {
    dbSelect.mockReturnValue(docNone());
    await expectGeneric404(await app.request(`/trust/public/nw/acme/documents/${DOC_ID}`));
    expect(dbSelect).toHaveBeenCalledTimes(1);
  });
  it('malformed document id → generic 404, no admission', async () => {
    await expectGeneric404(await app.request('/trust/public/nw/acme/documents/not-a-uuid'));
    expect(serving.isServing).not.toHaveBeenCalled();
  });
  it('document limiter runs before admission and a block returns 429 with zero SQL', async () => {
    limiter.rateLimiter.mockResolvedValueOnce({ allowed: false, remaining: 0, resetAt: new Date() });
    const res = await app.request(`/trust/public/nw/acme/documents/${DOC_ID}`);
    expect(res.status).toBe(429);
    expect(limiter.rateLimiter).toHaveBeenCalledWith(redis.client, 'trust-doc:203.0.113.9', 20, 60);
    expect(serving.isServing).not.toHaveBeenCalled(); expect(dbSelect).not.toHaveBeenCalled();
  });
  it('document on serving-set false → generic 404 with zero SQL', async () => {
    serving.isServing.mockResolvedValue(false);
    await expectGeneric404(await app.request(`/trust/public/nw/acme/documents/${DOC_ID}`));
    expect(dbSelect).not.toHaveBeenCalled(); expect(resolve.resolvePublishedTrustPage).not.toHaveBeenCalled();
  });
  it('preview: invalid token → 404; valid → fresh draft payload, no-store', async () => {
    await expectGeneric404(await app.request('/trust/public/preview/bad'));
    dbSelect.mockReturnValue({ from: () => ({ where: () => ({ limit: async () => [{ id: 'pg', orgId: 'o', publishedAt: null }] }) }) });
    const res = await app.request('/trust/public/preview/good');
    expect(res.status).toBe(200); expect(res.headers.get('Cache-Control')).toBe('no-store'); expect((await res.json()).data.preview).toBe(true);
  });
  it('preview is never parsed as a partner slug (no serving-set or resolve)', async () => {
    await app.request('/trust/public/preview/some-token-value');
    expect(preview.verifyTrustPreviewToken).toHaveBeenCalledWith('some-token-value');
    expect(serving.isServing).not.toHaveBeenCalled(); expect(resolve.resolvePublishedTrustPage).not.toHaveBeenCalled();
  });
  it('reserved partner slug "preview" never reaches the serving set (card, payload, partner-home)', async () => {
    await expectGeneric404(await app.request('/trust/public/preview/acme'));
    await expectGeneric404(await app.request('/trust/public/preview'));
    await expectGeneric404(await app.request('/trust/card/preview/acme'));
    await expectGeneric404(await app.request('/trust/card/preview'));
    expect(serving.isServing).not.toHaveBeenCalled(); expect(resolve.resolvePublishedTrustPage).not.toHaveBeenCalled();
  });
  it('preview: valid token but page gone → generic 404', async () => {
    dbSelect.mockReturnValue({ from: () => ({ where: () => ({ limit: async () => [] }) }) });
    await expectGeneric404(await app.request('/trust/public/preview/good'));
  });
});
