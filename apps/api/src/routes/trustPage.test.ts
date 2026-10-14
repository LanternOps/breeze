// apps/api/src/routes/trustPage.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
vi.mock('../middleware/auth', () => ({
  authMiddleware: async (c: any, next: any) => {
    if (!c.req.header('authorization')) return c.json({ error: 'Unauthorized' }, 401);
    c.set('auth', { user: { id: 'u1' }, partnerId: 'p1', orgId: null, scope: c.req.header('x-scope') ?? 'partner', partnerOrgAccess: c.req.header('x-org-access') ?? 'all', accessibleOrgIds: ['11111111-1111-4111-8111-111111111111'], canAccessOrg: (id: string) => id === '11111111-1111-4111-8111-111111111111' });
    return next();
  },
  requireScope: () => async (_c: any, next: any) => next(),
  requireMfa: () => async (c: any, next: any) => (c.req.header('x-mfa') === '1' ? next() : c.json({ error: 'MFA required', code: 'MFA_REQUIRED' }, 403)),
  requirePermission: (resource: string, action: string) => async (c: any, next: any) =>
    (c.req.header('x-allow') ?? '').split(',').includes(`${resource}:${action}`) ? next() : c.json({ error: 'Forbidden' }, 403),
}));
vi.mock('../services/partnerTrust', () => ({ evaluateCapabilityContinuationForState: () => ({ allow: true }), requireCapability: () => async (c: any, next: any) => (c.req.header('x-trust') === 'deny' ? c.json({ error: 'TRUST_PROBATION' }, 403) : next()) }));
const svc = vi.hoisted(() => ({
  ensureTrustPage: vi.fn(), publishTrustPage: vi.fn(), unpublishTrustPage: vi.fn(), buildSnapshotForPage: vi.fn(),
  loadPublicDocumentsForPage: vi.fn(async () => []), validatePublishSlugs: vi.fn(),
}));
vi.mock('../services/trustPage/publication', async (orig) => ({ ...(await orig<typeof import('../services/trustPage/publication')>()), ...svc }));
vi.mock('../services/trustPage/previewToken', () => ({ createTrustPreviewToken: vi.fn(async () => 'tok'), TRUST_PREVIEW_TTL_SECONDS: 900 }));
const intro = vi.hoisted(() => ({ override: null as string | null }));
vi.mock('../services/trustPage/payloadBuilder', async (orig) => {
  const real = await orig<typeof import('../services/trustPage/payloadBuilder')>();
  return { ...real, sanitizeIntro: (s: string) => intro.override ?? real.sanitizeIntro(s) };
});
const auditMock = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('../services/auditService', () => ({ createAuditLogAsync: auditMock }));
const dbm = vi.hoisted(() => ({ rows: [] as unknown[][] }));
vi.mock('../db', () => {
  const chain = () => { const c: any = {}; for (const m of ['select', 'from', 'where', 'innerJoin', 'leftJoin', 'limit', 'orderBy', 'update', 'set', 'insert', 'values', 'returning', 'delete', 'onConflictDoNothing']) c[m] = vi.fn(() => c); c.then = (r: any) => Promise.resolve(dbm.rows.shift() ?? []).then(r); return c; };
  return { db: Object.assign(chain(), { transaction: async (fn: any) => fn(chain()) }), runOutsideDbContext: (fn: any) => fn(), withSystemDbAccessContext: (fn: any) => fn() };
});
import { authMiddleware } from '../middleware/auth';
import { trustPageRoutes } from './trustPage';

const ORG = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const PAGE = { id: 'pg1', orgId: ORG, partnerId: 'p1', isPartnerHome: false, publishedAt: null, publicationRevision: 0, hiddenControlIds: [], showPercentages: false, showDeviceCount: false, showManagedBy: true, searchIndexable: false, introHtml: null, securityContactEmail: null, websiteUrl: null, publicationAuthorizedBy: null };
const app = new Hono(); app.use('*', authMiddleware); app.route('/orgs', trustPageRoutes);
const H = (extra: Record<string, string> = {}) => ({ authorization: 'Bearer t', 'x-allow': 'organizations:read,organizations:write', 'content-type': 'application/json', ...extra });

describe('trust page routes', () => {
  beforeEach(() => { intro.override = null; dbm.rows = []; vi.clearAllMocks(); svc.ensureTrustPage.mockResolvedValue(PAGE); });

  it('GET creates the draft and reports slug validity and publish eligibility', async () => {
    dbm.rows.push([{ orgSlug: 'Acme Dental', partnerSlug: 'nw', trustState: 'trusted', deletedAt: null }]);
    const res = await app.request(`/orgs/${ORG}/trust-page`, { headers: H() });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.slugs).toMatchObject({ valid: false });
    expect(body.data.publicPath).toMatch(/^\/portal\/trust\/nw\//);
  });
  it('404s an org outside the caller\'s access', async () => {
    const res = await app.request(`/orgs/${OTHER}/trust-page`, { headers: H() });
    expect(res.status).toBe(404);
  });
  it('PUT validates and audits', async () => {
    dbm.rows.push([{ orgSlug: 'acme', partnerSlug: 'nw', trustState: 'trusted', deletedAt: null }], [{ ...PAGE, publicationRevision: 1 }]);
    const res = await app.request(`/orgs/${ORG}/trust-page`, { method: 'PUT', headers: H(), body: JSON.stringify({ introHtml: '<p>x</p><script>1</script>', hiddenControlIds: ['dns_filtering'] }) });
    expect(res.status).toBe(200);
    expect(auditMock).toHaveBeenCalledWith(expect.objectContaining({ action: 'trust_page.update', orgId: ORG }));
    const bad = await app.request(`/orgs/${ORG}/trust-page`, { method: 'PUT', headers: H(), body: JSON.stringify({ hiddenControlIds: ['nope'] }) });
    expect(bad.status).toBe(400);
  });
  it('PUT accepts a 5,000-char entity-heavy intro and rejects one that sanitizes past 8x', async () => {
    dbm.rows.push([{ orgSlug: 'acme', partnerSlug: 'nw', trustState: 'trusted', deletedAt: null }], [{ ...PAGE, publicationRevision: 1 }]);
    const ok = await app.request(`/orgs/${ORG}/trust-page`, { method: 'PUT', headers: H(), body: JSON.stringify({ introHtml: '&'.repeat(5000) }) });
    expect(ok.status).toBe(200);
    intro.override = 'x'.repeat(40001);
    dbm.rows.push([{ orgSlug: 'acme', partnerSlug: 'nw', trustState: 'trusted', deletedAt: null }]);
    const tooLong = await app.request(`/orgs/${ORG}/trust-page`, { method: 'PUT', headers: H(), body: JSON.stringify({ introHtml: '<p>x</p>' }) });
    expect(tooLong.status).toBe(422);
    expect((await tooLong.json()).code).toBe('INTRO_TOO_LONG');
  });
  it('publish requires MFA, write, capability and a matching revision; maps service errors', async () => {
    dbm.rows.push([{ orgSlug: 'acme', partnerSlug: 'nw', trustState: 'trusted', deletedAt: null }]);
    expect((await app.request(`/orgs/${ORG}/trust-page/publish`, { method: 'POST', headers: H(), body: JSON.stringify({ expectedRevision: 0 }) })).status).toBe(403); // no MFA
    dbm.rows.push([{ orgSlug: 'acme', partnerSlug: 'nw', trustState: 'trusted', deletedAt: null }]);
    expect((await app.request(`/orgs/${ORG}/trust-page/publish`, { method: 'POST', headers: H({ 'x-mfa': '1', 'x-trust': 'deny' }), body: JSON.stringify({ expectedRevision: 0 }) })).status).toBe(403);
    const { TrustPageError } = await import('../services/trustPage/publication');
    svc.publishTrustPage.mockRejectedValueOnce(new TrustPageError('stale', 409, 'REVISION_MISMATCH'));
    dbm.rows.push([{ orgSlug: 'acme', partnerSlug: 'nw', trustState: 'trusted', deletedAt: null }]);
    const stale = await app.request(`/orgs/${ORG}/trust-page/publish`, { method: 'POST', headers: H({ 'x-mfa': '1' }), body: JSON.stringify({ expectedRevision: 0 }) });
    expect(stale.status).toBe(409);
    expect((await stale.json()).code).toBe('REVISION_MISMATCH');
    svc.publishTrustPage.mockResolvedValueOnce({ page: { ...PAGE, publishedAt: new Date(), publicationRevision: 1 }, snapshotId: 's1' });
    dbm.rows.push([{ orgSlug: 'acme', partnerSlug: 'nw', trustState: 'trusted', deletedAt: null }]);
    const ok = await app.request(`/orgs/${ORG}/trust-page/publish`, { method: 'POST', headers: H({ 'x-mfa': '1' }), body: JSON.stringify({ expectedRevision: 0, authorization: { authorizedBy: 'Jane Doe, COO' } }) });
    expect(ok.status).toBe(200);
    expect(auditMock).toHaveBeenCalledWith(expect.objectContaining({ action: 'trust_page.publish', details: expect.objectContaining({ snapshotId: 's1', publicationRevision: 1 }) }));
  });
  it('partner-home needs partner-wide admin', async () => {
    dbm.rows.push([{ orgSlug: 'acme', partnerSlug: 'nw', trustState: 'trusted', deletedAt: null }]);
    const res = await app.request(`/orgs/${ORG}/trust-page/partner-home`, { method: 'POST', headers: H({ 'x-org-access': 'selected' }), body: JSON.stringify({ isPartnerHome: true }) });
    expect(res.status).toBe(403);
  });
  it('preview-token returns a token and path', async () => {
    dbm.rows.push([{ orgSlug: 'acme', partnerSlug: 'nw', trustState: 'trusted', deletedAt: null }]);
    const res = await app.request(`/orgs/${ORG}/trust-page/preview-token`, { method: 'POST', headers: H() });
    expect(await res.json()).toEqual({ data: { token: 'tok', expiresInSeconds: 900, previewPath: '/trust/preview/tok' } });
  });
});
