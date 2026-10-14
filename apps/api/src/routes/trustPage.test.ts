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
const trustMode = vi.hoisted(() => ({ value: 'off' as 'off' | 'shadow' | 'enforce' }));
vi.mock('../config/partnerTrustMode', () => ({ partnerTrustMode: () => trustMode.value }));
const auditMock = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('../services/auditService', () => ({ createAuditLogAsync: auditMock }));
const dbm = vi.hoisted(() => ({ rows: [] as unknown[][], values: [] as unknown[], tx: 0 }));
const servingMock = vi.hoisted(() => ({ scheduleServingRefreshForPartner: vi.fn() }));
vi.mock('../services/trustPage/servingSet', () => servingMock);
vi.mock('../db', () => {
  const chain = () => { const c: any = {}; for (const m of ['select', 'from', 'where', 'innerJoin', 'leftJoin', 'limit', 'orderBy', 'update', 'set', 'insert', 'values', 'returning', 'delete', 'onConflictDoNothing']) c[m] = vi.fn(() => c); c.values = vi.fn((v: unknown) => { dbm.values.push(v); return c; }); c.then = (r: any) => Promise.resolve(dbm.rows.shift() ?? []).then(r); return c; };
  return { db: Object.assign(chain(), { transaction: async (fn: any) => { dbm.tx++; return fn(chain()); } }), runOutsideDbContext: (fn: any) => fn(), withSystemDbAccessContext: (fn: any) => fn() };
});
import { authMiddleware } from '../middleware/auth';
import { db } from '../db';
import { createTrustPreviewToken } from '../services/trustPage/previewToken';
import { trustPageRoutes } from './trustPage';

const ORG = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const PAGE = { id: 'pg1', orgId: ORG, partnerId: 'p1', isPartnerHome: false, publishedAt: null, publicationRevision: 0, hiddenControlIds: [], showPercentages: false, showDeviceCount: false, showManagedBy: true, searchIndexable: false, introHtml: null, securityContactEmail: null, websiteUrl: null, publicationAuthorizedBy: null };
const app = new Hono(); app.use('*', authMiddleware); app.route('/orgs', trustPageRoutes);
const H = (extra: Record<string, string> = {}) => ({ authorization: 'Bearer t', 'x-allow': 'organizations:read,organizations:write', 'content-type': 'application/json', ...extra });

describe('trust page routes', () => {
  beforeEach(() => { intro.override = null; trustMode.value = 'off'; dbm.rows = []; dbm.values = []; dbm.tx = 0; vi.clearAllMocks(); svc.ensureTrustPage.mockResolvedValue(PAGE); });

  it.each([
    ['shadow', 'probation', { allowed: false, reason: 'probation_default_deny' }],
    ['enforce', 'probation', { allowed: false, reason: 'probation_default_deny' }],
    ['shadow', 'restricted', { allowed: false, reason: 'restricted' }],
    ['shadow', 'trusted', { allowed: true, reason: null }],
    ['off', 'probation', { allowed: true, reason: null }],
  ] as const)('Ruling 24: GET canPublish in %s mode for a %s partner follows the publish rule', async (mode, trustState, expected) => {
    trustMode.value = mode;
    dbm.rows.push([{ orgSlug: 'acme', partnerSlug: 'nw', trustState, deletedAt: null }], []);
    const res = await app.request(`/orgs/${ORG}/trust-page`, { headers: H() });
    expect((await res.json()).data.canPublish).toEqual(expected);
  });

  it('I13: PUT stores the SANITIZED intro (hostile markup never reaches the row)', async () => {
    dbm.rows.push([{ orgSlug: 'acme', partnerSlug: 'nw', trustState: 'trusted', deletedAt: null }], [{ ...PAGE, publicationRevision: 1 }]);
    const hostile = '<p onclick="steal()">Hello <a href="javascript:alert(1)">x</a></p><img src=x onerror=alert(1)><script>alert(1)</script>';
    const res = await app.request(`/orgs/${ORG}/trust-page`, { method: 'PUT', headers: H(), body: JSON.stringify({ introHtml: hostile }) });
    expect(res.status).toBe(200);
    const setCalls = vi.mocked((db as unknown as { set: (v: unknown) => unknown }).set).mock.calls.map((c) => c[0] as Record<string, unknown>);
    const stored = setCalls.find((v) => 'introHtml' in v)?.introHtml as string;
    expect(stored).toContain('Hello');
    for (const bad of ['onclick', 'onerror', '<script', 'javascript:', '<img']) expect(stored).not.toContain(bad);
  });

  it('GET creates the draft and reports slug validity and publish eligibility', async () => {
    const linked = { documentId: 'd1', visibility: 'gated', disclosureConfirmedAt: new Date('2026-10-01T00:00:00Z'), sortOrder: 2, docId: 'd1', deletedAt: null, title: 'SOC 2', category: 'compliance', contentType: 'application/pdf', byteSize: 1234, supersededByDocumentId: null };
    dbm.rows.push([{ orgSlug: 'Acme Dental', partnerSlug: 'nw', trustState: 'trusted', deletedAt: null }], [linked]);
    const res = await app.request(`/orgs/${ORG}/trust-page`, { headers: H() });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.slugs).toMatchObject({ valid: false });
    expect(body.data.publicPath).toMatch(/^\/portal\/trust\/nw\//);
    expect(body.data.documents[0]).toEqual({
      documentId: 'd1', visibility: 'gated', disclosureConfirmedAt: '2026-10-01T00:00:00.000Z', sortOrder: 2,
      title: 'SOC 2', category: 'compliance', contentType: 'application/pdf', byteSize: 1234,
      supersededByDocumentId: null, deleted: false,
    });
  });
  it('GET flags a linked document with no org_documents row as deleted', async () => {
    dbm.rows.push([{ orgSlug: 'acme', partnerSlug: 'nw', trustState: 'trusted', deletedAt: null }],
      [{ documentId: 'd2', visibility: 'public', disclosureConfirmedAt: null, sortOrder: 0, docId: null, deletedAt: null, title: null, category: null, contentType: null, byteSize: null, supersededByDocumentId: null }]);
    const res = await app.request(`/orgs/${ORG}/trust-page`, { headers: H() });
    const body = await res.json();
    expect(body.data.documents[0]).toMatchObject({ documentId: 'd2', deleted: true, title: null, disclosureConfirmedAt: null, supersededByDocumentId: null });
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
  it('partner-home needs MFA and partner-wide admin, then moves the flag and audits', async () => {
    const ctxRow = { orgSlug: 'acme', partnerSlug: 'nw', partnerId: 'p1', trustState: 'trusted', deletedAt: null, orgType: 'internal' };
    const body = JSON.stringify({ isPartnerHome: true });
    dbm.rows.push([ctxRow]);
    expect((await app.request(`/orgs/${ORG}/trust-page/partner-home`, { method: 'POST', headers: H({ 'x-org-access': 'all' }), body })).status).toBe(403); // no MFA
    dbm.rows.push([ctxRow]);
    expect((await app.request(`/orgs/${ORG}/trust-page/partner-home`, { method: 'POST', headers: H({ 'x-mfa': '1', 'x-org-access': 'selected' }), body })).status).toBe(403);
    dbm.rows = [[ctxRow], [{ id: 'other', orgId: 'x' }], [], [{ ...PAGE, isPartnerHome: true }]];
    const ok = await app.request(`/orgs/${ORG}/trust-page/partner-home`, { method: 'POST', headers: H({ 'x-mfa': '1', 'x-org-access': 'all' }), body });
    expect(ok.status).toBe(200);
    expect(auditMock).toHaveBeenCalledWith(expect.objectContaining({ action: 'trust_page.partner_home', details: expect.objectContaining({ isPartnerHome: true, previousPageId: 'other' }) }));
    expect(servingMock.scheduleServingRefreshForPartner).toHaveBeenCalledWith('p1', 'trust_page.partner_home');
  });
  describe('partner-home rules (Ruling 25)', () => {
    const req = (isPartnerHome: boolean) => app.request(`/orgs/${ORG}/trust-page/partner-home`, { method: 'POST', headers: H({ 'x-mfa': '1', 'x-org-access': 'all' }), body: JSON.stringify({ isPartnerHome }) });
    it.each(['customer', 'quick_support', 'unassigned_pool'])('setting it on a %s org is 422 PARTNER_HOME_INTERNAL_ONLY and writes nothing', async (orgType) => {
      dbm.rows = [[{ orgSlug: 'acme', partnerSlug: 'nw', trustState: 'trusted', deletedAt: null, orgType }]];
      const res = await req(true);
      expect(res.status).toBe(422);
      expect((await res.json()).code).toBe('PARTNER_HOME_INTERNAL_ONLY');
      expect(dbm.tx).toBe(0);
      expect(auditMock).not.toHaveBeenCalled();
    });
    it('clearing it on a PUBLISHED page with no attestation is 422 PARTNER_HOME_UNPUBLISH_FIRST', async () => {
      svc.ensureTrustPage.mockResolvedValueOnce({ ...PAGE, isPartnerHome: true, publishedAt: new Date(), publicationAuthorizedBy: null });
      dbm.rows = [[{ orgSlug: 'acme', partnerSlug: 'nw', trustState: 'trusted', deletedAt: null, orgType: 'internal' }]];
      const res = await req(false);
      expect(res.status).toBe(422);
      expect((await res.json()).code).toBe('PARTNER_HOME_UNPUBLISH_FIRST');
      expect(dbm.tx).toBe(0);
    });
    it.each([
      ['an unpublished page', { publishedAt: null, publicationAuthorizedBy: null }],
      ['a published page that carries an attestation', { publishedAt: new Date(), publicationAuthorizedBy: 'Jane Doe, COO' }],
    ])('clearing it on %s is allowed (even if the org is no longer internal)', async (_label, over) => {
      svc.ensureTrustPage.mockResolvedValueOnce({ ...PAGE, isPartnerHome: true, ...over });
      dbm.rows = [[{ orgSlug: 'acme', partnerSlug: 'nw', trustState: 'trusted', deletedAt: null, orgType: 'customer' }], [], [], [], [{ ...PAGE }]];
      const res = await req(false);
      expect(res.status).toBe(200);
      expect(dbm.tx).toBe(1);
    });
  });
  it('I10: minting a preview token needs organizations:write', async () => {
    dbm.rows.push([{ orgSlug: 'acme', partnerSlug: 'nw', trustState: 'trusted', deletedAt: null }]);
    const res = await app.request(`/orgs/${ORG}/trust-page/preview-token`, { method: 'POST', headers: H({ 'x-allow': 'organizations:read' }) });
    expect(res.status).toBe(403);
    expect(createTrustPreviewToken).not.toHaveBeenCalled();
  });
  it('preview-token returns a token and path', async () => {
    dbm.rows.push([{ orgSlug: 'acme', partnerSlug: 'nw', trustState: 'trusted', deletedAt: null }]);
    const res = await app.request(`/orgs/${ORG}/trust-page/preview-token`, { method: 'POST', headers: H() });
    expect(await res.json()).toEqual({ data: { token: 'tok', expiresInSeconds: 900, previewPath: '/trust/preview/tok' } });
  });

  describe('documents PUT', () => {
    const D1 = '33333333-3333-4333-8333-333333333333';
    const D2 = '44444444-4444-4444-8444-444444444444';
    const ctxRow = { orgSlug: 'acme', partnerSlug: 'nw', trustState: 'trusted', deletedAt: null };
    const put = (documents: unknown[]) => app.request(`/orgs/${ORG}/trust-page/documents`, { method: 'PUT', headers: H(), body: JSON.stringify({ documents }) });
    it('422s DOCUMENT_UNAVAILABLE naming the missing id and runs no transaction', async () => {
      dbm.rows = [[ctxRow], [{ id: D1 }]];
      const res = await put([{ documentId: D1, visibility: 'public', disclosureConfirmed: true }, { documentId: D2, visibility: 'public', disclosureConfirmed: true }]);
      expect(res.status).toBe(422);
      const body = await res.json();
      expect(body.code).toBe('DOCUMENT_UNAVAILABLE');
      expect(body.details.documentIds).toEqual([D2]);
      expect(dbm.tx).toBe(0);
      expect(dbm.values).toEqual([]);
    });
    it('rejects an unconfirmed public document at the schema (400)', async () => {
      const res = await put([{ documentId: D1, visibility: 'public', disclosureConfirmed: false }]);
      expect(res.status).toBe(400);
      expect(dbm.tx).toBe(0);
    });
    it('replaces links with confirmation stamps, audits added/removed/confirmed, returns the new revision', async () => {
      dbm.rows = [[ctxRow], [{ id: D1 }, { id: D2 }], [{ documentId: D1, disclosureConfirmedAt: null, disclosureConfirmedByUserId: null }, { documentId: 'old-doc', disclosureConfirmedAt: null, disclosureConfirmedByUserId: null }], [], [], [], [{ publicationRevision: 5 }]];
      const res = await put([{ documentId: D1, visibility: 'public', disclosureConfirmed: true }, { documentId: D2, visibility: 'public', disclosureConfirmed: true }]);
      expect(res.status).toBe(200);
      expect((await res.json()).data.publicationRevision).toBe(5);
      expect(dbm.tx).toBe(1);
      const rows = dbm.values[0] as Array<Record<string, unknown>>;
      expect(rows).toHaveLength(2);
      for (const r of rows) {
        expect(r.disclosureConfirmedAt).toBeInstanceOf(Date);
        expect(r.disclosureConfirmedByUserId).toBe('u1');
      }
      expect(auditMock).toHaveBeenCalledWith(expect.objectContaining({
        action: 'trust_page.documents.update',
        details: expect.objectContaining({ added: [D2], removed: ['old-doc'], confirmed: 2, publicationRevision: 5 }),
      }));
    });
    it('I7: a reorder keeps the ORIGINAL confirmation stamp of an already-linked confirmed document', async () => {
      const T0 = new Date('2026-10-01T09:00:00.000Z');
      dbm.rows = [[ctxRow], [{ id: D1 }, { id: D2 }], [{ documentId: D1, disclosureConfirmedAt: T0, disclosureConfirmedByUserId: 'u0' }], [], [], [], [{ publicationRevision: 6 }]];
      const res = await put([{ documentId: D2, visibility: 'public', disclosureConfirmed: true }, { documentId: D1, visibility: 'public', disclosureConfirmed: true }]);
      expect(res.status).toBe(200);
      const rows = dbm.values[0] as Array<Record<string, unknown>>;
      const d1 = rows.find((r) => r.documentId === D1)!;
      const d2 = rows.find((r) => r.documentId === D2)!;
      expect(d1).toMatchObject({ sortOrder: 1, disclosureConfirmedAt: T0, disclosureConfirmedByUserId: 'u0' });
      expect(d2.disclosureConfirmedAt).toBeInstanceOf(Date);
      expect((d2.disclosureConfirmedAt as Date).getTime()).not.toBe(T0.getTime());
      expect(d2.disclosureConfirmedByUserId).toBe('u1');
    });
  });

  it.each([
    ['GET', 'trust-page', undefined],
    ['PUT', 'trust-page', { showPercentages: true }],
    ['PUT', 'trust-page/documents', { documents: [] }],
    ['POST', 'trust-page/publish', { expectedRevision: 0 }],
    ['POST', 'trust-page/unpublish', undefined],
    ['POST', 'trust-page/partner-home', { isPartnerHome: true }],
    ['POST', 'trust-page/preview-token', undefined],
    ['GET', 'trust-page/controls', undefined],
  ])('%s /%s 404s an inaccessible org without touching services', async (method, path, payload) => {
    const res = await app.request(`/orgs/${OTHER}/${path}`, {
      method,
      headers: H({ 'x-mfa': '1', 'x-org-access': 'all', 'x-allow': 'organizations:read,organizations:write' }),
      body: payload ? JSON.stringify(payload) : undefined,
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found', code: 'NOT_FOUND' });
    expect(svc.ensureTrustPage).not.toHaveBeenCalled();
    expect(svc.publishTrustPage).not.toHaveBeenCalled();
    expect(svc.unpublishTrustPage).not.toHaveBeenCalled();
    expect(createTrustPreviewToken).not.toHaveBeenCalled();
  });
});
