// apps/api/src/routes/trustPageContent.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

vi.mock('../middleware/auth', () => ({
  authMiddleware: async (c: any, next: any) => {
    if (!c.req.header('authorization')) return c.json({ error: 'Unauthorized' }, 401);
    c.set('auth', { user: { id: 'u1', email: 'u@example.test' }, partnerId: 'p1', orgId: null, scope: 'partner', canAccessOrg: (id: string) => id === '11111111-1111-4111-8111-111111111111' });
    return next();
  },
  requireScope: () => async (_c: any, next: any) => next(),
  requirePermission: (resource: string, action: string) => async (c: any, next: any) =>
    (c.req.header('x-allow') ?? '').split(',').includes(`${resource}:${action}`) ? next() : c.json({ error: 'Forbidden' }, 403),
}));
const svc = vi.hoisted(() => ({ ensureTrustPage: vi.fn() }));
vi.mock('../services/trustPage/publication', async (orig) => ({ ...(await orig<typeof import('../services/trustPage/publication')>()), ...svc }));
const suggest = vi.hoisted(() => vi.fn());
vi.mock('../services/trustPage/subprocessorSuggestions', () => ({ suggestSubprocessors: suggest }));
const auditMock = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('../services/auditService', () => ({ createAuditLogAsync: auditMock }));
const sanitize = vi.hoisted(() => ({ override: null as string | null }));
vi.mock('../services/richTextSanitize', async (orig) => {
  const real = await orig<typeof import('../services/richTextSanitize')>();
  return { ...real, sanitizeFlowRichTextHtml: (s: string) => sanitize.override ?? real.sanitizeFlowRichTextHtml(s) };
});
const dbm = vi.hoisted(() => ({ rows: [] as unknown[][], values: [] as unknown[], deletes: 0 }));
const rev = vi.hoisted(() => ({ locked: 0, next: 1 }));
vi.mock('../services/trustPage/revision', async () => {
  const { TrustPageError } = await import('../services/trustPage/publication');
  const { db } = await import('../db');
  return {
    withTrustPageRevision: async (args: { expectedRevision: number | undefined }, fn: (tx: unknown) => Promise<unknown>) => {
      if (args.expectedRevision !== undefined && args.expectedRevision !== rev.locked) throw new TrustPageError('stale', 409, 'REVISION_MISMATCH');
      return { result: await fn(db), publicationRevision: rev.next };
    },
  };
});
vi.mock('../db', () => {
  const chain = () => {
    const c: any = {};
    for (const m of ['select', 'from', 'where', 'innerJoin', 'limit', 'orderBy', 'returning']) c[m] = vi.fn(() => c);
    c.delete = vi.fn(() => { dbm.deletes++; return c; });
    c.insert = vi.fn(() => c);
    c.values = vi.fn((v: unknown) => { dbm.values.push(v); return c; });
    c.then = (r: any) => Promise.resolve(dbm.rows.shift() ?? []).then(r);
    return c;
  };
  return { db: Object.assign(chain(), { transaction: async (fn: any) => fn(chain()) }), runOutsideDbContext: (fn: any) => fn(), withSystemDbAccessContext: (fn: any) => fn() };
});
import { trustPageContentRoutes } from './trustPageContent';

const ORG = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const PAGE = { id: 'pg1', orgId: ORG, publicationRevision: 2 };
const ctxRow = { orgSlug: 'acme', partnerSlug: 'nw', partnerId: 'p1', deletedAt: null };
const app = new Hono(); app.route('/orgs', trustPageContentRoutes);
const H = (extra: Record<string, string> = {}) => ({ authorization: 'Bearer t', 'x-allow': 'organizations:read,organizations:write', 'content-type': 'application/json', ...extra });
const sp = { name: 'Acme EDR', purpose: 'Endpoint security', location: null, websiteUrl: 'https://acme.example', source: 'manual', sourceKey: null };
const put = (path: string, body: unknown, headers = H()) => app.request(`/orgs/${ORG}/trust-page/${path}`, { method: 'PUT', headers, body: JSON.stringify(body) });

describe('trust page content routes', () => {
  beforeEach(() => { vi.clearAllMocks(); dbm.rows = []; dbm.values = []; dbm.deletes = 0; rev.locked = 2; rev.next = 3; sanitize.override = null; svc.ensureTrustPage.mockResolvedValue(PAGE); });

  it('requires auth and the right permission', async () => {
    expect((await app.request(`/orgs/${ORG}/trust-page/faq`)).status).toBe(401);
    expect((await app.request(`/orgs/${ORG}/trust-page/faq`, { headers: H({ 'x-allow': '' }) })).status).toBe(403);
    expect((await put('faq', { expectedRevision: 2, items: [] }, H({ 'x-allow': 'organizations:read' }))).status).toBe(403);
  });

  it('404s for an org the caller cannot access', async () => {
    const res = await app.request(`/orgs/${OTHER}/trust-page/subprocessors`, { headers: H() });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found', code: 'NOT_FOUND' });
  });

  it('GET subprocessors returns the rows and the page revision', async () => {
    dbm.rows.push([ctxRow], [{ id: 's1', name: 'Acme EDR', sortOrder: 0 }]);
    const res = await app.request(`/orgs/${ORG}/trust-page/subprocessors`, { headers: H() });
    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual({ subprocessors: [{ id: 's1', name: 'Acme EDR', sortOrder: 0 }], publicationRevision: 2 });
  });

  it('PUT subprocessors with a stale revision is 409 and writes nothing', async () => {
    dbm.rows.push([ctxRow]);
    const res = await put('subprocessors', { expectedRevision: 1, subprocessors: [sp] });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('REVISION_MISMATCH');
    expect(dbm.deletes).toBe(0);
    expect(auditMock).not.toHaveBeenCalled();
  });

  it('PUT subprocessors replaces all rows in order, reports the bumped revision and audits', async () => {
    dbm.rows.push([ctxRow], [], [{ id: 'n1' }, { id: 'n2' }]);
    const two = [{ ...sp, name: 'A' }, { ...sp, name: 'B', source: 'backup', sourceKey: 'backup:b' }];
    const res = await put('subprocessors', { expectedRevision: 2, subprocessors: two });
    expect(res.status).toBe(200);
    expect((await res.json()).data.publicationRevision).toBe(3);
    expect(dbm.deletes).toBe(1);
    const inserted = dbm.values[0] as Array<Record<string, unknown>>;
    expect(inserted.map((r) => [r.name, r.sortOrder, r.orgId, r.trustPageId])).toEqual([['A', 0, ORG, 'pg1'], ['B', 1, ORG, 'pg1']]);
    expect(auditMock).toHaveBeenCalledTimes(1);
  });

  it('PUT subprocessors rejects 51 rows, an http:// website and a duplicate sourceKey', async () => {
    dbm.rows.push([ctxRow], [ctxRow], [ctxRow]);
    expect((await put('subprocessors', { expectedRevision: 2, subprocessors: Array.from({ length: 51 }, () => sp) })).status).toBe(400);
    expect((await put('subprocessors', { expectedRevision: 2, subprocessors: [{ ...sp, websiteUrl: 'http://x.example' }] })).status).toBe(400);
    const dup = { ...sp, source: 'backup', sourceKey: 'backup:x' };
    const res = await put('subprocessors', { expectedRevision: 2, subprocessors: [dup, dup] });
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe('DUPLICATE_SOURCE_KEY');
  });

  it('GET suggestions delegates to the service', async () => {
    dbm.rows.push([ctxRow]);
    suggest.mockResolvedValueOnce([{ ...sp, source: 'm365', sourceKey: 'm365:microsoft 365' }]);
    const res = await app.request(`/orgs/${ORG}/trust-page/subprocessors/suggestions`, { headers: H() });
    expect(res.status).toBe(200);
    expect((await res.json()).data.suggestions).toHaveLength(1);
    expect(suggest).toHaveBeenCalledWith(ORG, expect.any(Date));
  });

  it('PUT faq strips a <script> from the stored answer', async () => {
    dbm.rows.push([ctxRow], [], [{ id: 'f1' }]);
    const res = await put('faq', { expectedRevision: 2, items: [{ question: 'Is data encrypted?', answerHtml: '<p>Yes</p><script>alert(1)</script>' }] });
    expect(res.status).toBe(200);
    const stored = (dbm.values[0] as Array<{ answerHtml: string }>)[0]!.answerHtml;
    expect(stored).toContain('Yes');
    expect(stored).not.toContain('script');
  });

  it('PUT faq answers that sanitize past 16,000 chars are 422 ANSWER_TOO_LONG', async () => {
    sanitize.override = `<p>${'x'.repeat(16_001)}</p>`;
    dbm.rows.push([ctxRow]);
    const res = await put('faq', { expectedRevision: 2, items: [{ question: 'Is data encrypted?', answerHtml: '<p>Yes</p>' }] });
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe('ANSWER_TOO_LONG');
    expect(dbm.deletes).toBe(0);
  });

  it('PUT faq with a stale revision is 409', async () => {
    dbm.rows.push([ctxRow]);
    expect((await put('faq', { expectedRevision: 0, items: [] })).status).toBe(409);
  });

  it('GET faq returns the items and revision', async () => {
    dbm.rows.push([ctxRow], [{ id: 'f1', question: 'q', answerHtml: '<p>a</p>', sortOrder: 0 }]);
    const res = await app.request(`/orgs/${ORG}/trust-page/faq`, { headers: H() });
    expect((await res.json()).data.publicationRevision).toBe(2);
  });
});
