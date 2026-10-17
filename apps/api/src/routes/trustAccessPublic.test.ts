import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const serving = vi.hoisted(() => ({ isServing: vi.fn(), readCachedSnapshotPayload: vi.fn(async () => null), cacheSnapshotPayload: vi.fn() }));
vi.mock('../services/trustPage/servingSet', () => ({ ...serving, trustServingMember: (p: string, o?: string) => (o ? `${p}/${o}` : p) }));
const resolve = vi.hoisted(() => ({ resolvePublishedTrustPage: vi.fn() }));
vi.mock('../services/trustPage/resolve', async (orig) => ({ ...(await orig<typeof import('../services/trustPage/resolve')>()), ...resolve }));
vi.mock('../services/redis', () => ({ getRedis: () => ({}) }));
// A counting limiter: each key admits `limit` calls, then refuses.
const counts = vi.hoisted(() => new Map<string, number>());
const depthAtLimit = vi.hoisted(() => [] as number[]);
const limiter = vi.hoisted(() => ({
  rateLimiter: vi.fn(async (_r: unknown, key: string, limit: number) => {
    depthAtLimit.push(ctx.depth);
    const n = (counts.get(key) ?? 0) + 1; counts.set(key, n);
    return { allowed: n <= limit, remaining: Math.max(0, limit - n), resetAt: new Date() };
  }),
}));
vi.mock('../services/rate-limit', () => limiter);
vi.mock('../services/clientIp', () => ({ getTrustedClientIp: () => '203.0.113.9', rateLimitIpKey: (ip: string) => ip }));
const ctx = vi.hoisted(() => ({ depth: 0, entered: 0 }));
vi.mock('../db', () => ({
  runOutsideDbContext: (fn: () => unknown) => fn(),
  withSystemDbAccessContext: async (fn: () => unknown) => { ctx.depth++; ctx.entered++; try { return await fn(); } finally { ctx.depth--; } },
}));
const svc = vi.hoisted(() => ({
  createAccessRequest: vi.fn(async () => {}), verifyAccessRequest: vi.fn(), readGrant: vi.fn(), openGrantedDocument: vi.fn(),
}));
vi.mock('../services/trustPage/access/requests', () => svc);
const blob = vi.hoisted(() => ({ getBlobStream: vi.fn() }));
vi.mock('../services/blobStorage', () => ({ ...blob, BlobStorageError: class BlobStorageError extends Error {} }));

import { trustAccessPublicRoutes } from './trustAccessPublic';

const app = new Hono(); app.route('/trust/access', trustAccessPublicRoutes);
const GENERIC = { error: 'Not found', code: 'NOT_FOUND' };
const TOKEN = 'T'.repeat(48);
const DOC = '0b9a4f4e-3b8e-4f2a-9c51-7d1f2c0e9a11';
const PAYLOAD = {
  schemaVersion: 2, snapshotId: '2a9a4f4e-3b8e-4f2a-9c51-7d1f2c0e9a33',
  documents: [{ id: DOC, title: 'SOC 2', visibility: 'gated' }], access: { ndaText: null },
};
const RESOLVED = { pageId: 'pg', orgId: 'o', partnerId: 'p', publishedAt: new Date(), searchIndexable: false, lastEvaluatedAt: new Date(), snapshotId: 's1', payload: PAYLOAD };
const validRequest = (over: Record<string, unknown> = {}) => ({
  partnerSlug: 'nw', orgSlug: 'acme', email: 'jane@example.test', name: 'Jane Doe', company: 'Example Ins',
  purpose: 'Underwriting review for renewal.', ndaAccepted: false, ...over,
});
const post = (path: string, body: unknown) => app.request(`/trust/access${path}`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body),
});

beforeEach(() => {
  vi.clearAllMocks(); counts.clear(); ctx.entered = 0; depthAtLimit.length = 0;
  serving.isServing.mockResolvedValue(true);
  resolve.resolvePublishedTrustPage.mockResolvedValue(RESOLVED);
});

describe('headers and method discipline', () => {
  it('a GET to any /trust/access path is the generic 404 and never verifies', async () => {
    for (const path of ['/verify', '/grant', '/download', '/requests', `/verify/${TOKEN}`, `/verify?token=${TOKEN}`]) {
      const res = await app.request(`/trust/access${path}`);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual(GENERIC);
      expect(res.headers.get('Cache-Control')).toBe('no-store');
    }
    expect(svc.verifyAccessRequest).not.toHaveBeenCalled();
  });
  it('every response is no-store + no-referrer + noindex', async () => {
    svc.verifyAccessRequest.mockResolvedValueOnce({ orgName: 'Acme' });
    const res = await post('/verify', { token: TOKEN });
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(res.headers.get('Referrer-Policy')).toBe('no-referrer');
    expect(res.headers.get('X-Robots-Tag')).toContain('noindex');
  });
  it('no handler reads a token from the query string or a path param', () => {
    const source = readFileSync(fileURLToPath(new URL('./trustAccessPublic.ts', import.meta.url)), 'utf8');
    expect(source).not.toMatch(/req\.(query|param)\(['"]token/);
    expect(source).not.toMatch(/\/:token/);
  });
});

describe('POST /requests', () => {
  it('valid body on a serving page → 202 accepted, service called with the resolved page and normalized payload', async () => {
    const res = await post('/requests', validRequest());
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ data: { accepted: true } });
    expect(svc.createAccessRequest).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'jane@example.test' }), RESOLVED, expect.objectContaining({ schemaVersion: 2, snapshotId: PAYLOAD.snapshotId }), expect.any(Date),
    );
  });
  it('rate limits run before any DB context', async () => {
    await post('/requests', validRequest());
    const keys = limiter.rateLimiter.mock.calls.map((c) => c[1] as string);
    expect(keys.some((k) => k.includes('ip'))).toBe(true);
    expect(keys.some((k) => k.includes('email'))).toBe(true);
    expect(keys.some((k) => k.includes('page'))).toBe(true);
    expect(keys.join(' ')).not.toContain('jane@example.test');   // the email is hashed in the key
    expect(depthAtLimit.length).toBe(3);
    expect(depthAtLimit.every((d) => d === 0)).toBe(true);        // #1105: never inside a db context
    expect(ctx.entered).toBeGreaterThan(0);                       // …and the DB work did happen afterwards
  });
  it('the 6th request in an hour from one IP → 429', async () => {
    for (let i = 0; i < 5; i++) expect((await post('/requests', validRequest({ email: `r${i}@example.test` }))).status).toBe(202);
    const res = await post('/requests', validRequest({ email: 'r6@example.test' }));
    expect(res.status).toBe(429);
    expect(svc.createAccessRequest).toHaveBeenCalledTimes(5);
  });
  it('the 4th request in a day for one email → 429 (whatever the IP)', async () => {
    for (let i = 0; i < 3; i++) expect((await post('/requests', validRequest())).status).toBe(202);
    counts.forEach((_v, k) => { if (k.includes(':ip:')) counts.set(k, 0); });
    expect((await post('/requests', validRequest())).status).toBe(429);
  });
  it('an invalid body (or malformed JSON) is the generic 404, never a validation body', async () => {
    for (const body of [validRequest({ email: 'nope' }), validRequest({ extra: 1 }), '{not json']) {
      const res = await post('/requests', body);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual(GENERIC);
    }
    expect(svc.createAccessRequest).not.toHaveBeenCalled();
  });
  it('a page that does not serve → generic 404 (serving-set miss reaches no SQL)', async () => {
    serving.isServing.mockResolvedValue(false);
    const res = await post('/requests', validRequest());
    expect(res.status).toBe(404);
    expect(resolve.resolvePublishedTrustPage).not.toHaveBeenCalled();
    expect(ctx.entered).toBe(0);
  });
  it('the reserved slug `access` is refused before Redis', async () => {
    const res = await post('/requests', validRequest({ partnerSlug: 'access' }));
    expect(res.status).toBe(404);
    expect(serving.isServing).not.toHaveBeenCalled();
  });
});

describe('POST /verify', () => {
  it('a consumed token and an unknown token produce byte-identical bodies', async () => {
    svc.verifyAccessRequest.mockResolvedValue(null);
    const a = await post('/verify', { token: TOKEN });
    const b = await post('/verify', { token: 'U'.repeat(48) });
    const malformed = await post('/verify', { token: 'short' });
    const bodies = await Promise.all([a.text(), b.text(), malformed.text()]);
    expect([a.status, b.status, malformed.status]).toEqual([404, 404, 404]);
    expect(new Set(bodies).size).toBe(1);
    expect(svc.verifyAccessRequest).toHaveBeenCalledTimes(2);   // the malformed one never reached the service
  });
  it('success → 200 with the org name only', async () => {
    svc.verifyAccessRequest.mockResolvedValueOnce({ orgName: 'Acme' });
    const res = await post('/verify', { token: TOKEN });
    expect(await res.json()).toEqual({ data: { orgName: 'Acme' } });
  });
  it('11th verify in a minute from one IP → 429', async () => {
    svc.verifyAccessRequest.mockResolvedValue(null);
    for (let i = 0; i < 10; i++) await post('/verify', { token: TOKEN });
    expect((await post('/verify', { token: TOKEN })).status).toBe(429);
  });
});

describe('POST /grant and /download', () => {
  it('grant → 200 view, or the generic 404', async () => {
    svc.readGrant.mockResolvedValueOnce({ orgName: 'Acme', expiresAt: '2026-10-24T00:00:00.000Z', documents: [] });
    expect((await post('/grant', { token: TOKEN })).status).toBe(200);
    svc.readGrant.mockResolvedValueOnce(null);
    const res = await post('/grant', { token: TOKEN });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual(GENERIC);
  });
  it('download streams an attachment (no-store, nosniff, noindex)', async () => {
    svc.openGrantedDocument.mockResolvedValueOnce({ storageBackend: 'db', storageKey: null, data: Buffer.from('pdf'), contentType: 'image/png', originalFilename: 'soc2.png', byteSize: 3 });
    blob.getBlobStream.mockResolvedValueOnce({ body: Buffer.from('pdf'), contentLength: 3 });
    const res = await post('/download', { token: TOKEN, documentId: DOC });
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Disposition')).toMatch(/^attachment/);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('X-Robots-Tag')).toContain('noindex');
    expect(svc.openGrantedDocument).toHaveBeenCalledWith(TOKEN, DOC, expect.any(Date));
  });
  it('download refused → generic 404; a bad documentId never reaches the service', async () => {
    svc.openGrantedDocument.mockResolvedValueOnce(null);
    expect((await post('/download', { token: TOKEN, documentId: DOC })).status).toBe(404);
    expect((await post('/download', { token: TOKEN, documentId: 'nope' })).status).toBe(404);
    expect(svc.openGrantedDocument).toHaveBeenCalledTimes(1);
  });
});
