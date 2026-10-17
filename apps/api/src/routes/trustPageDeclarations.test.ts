import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

vi.mock('../middleware/auth', () => ({
  authMiddleware: async (c: any, next: any) => {
    if (!c.req.header('authorization')) return c.json({ error: 'Unauthorized' }, 401);
    c.set('auth', { user: { id: 'u1', email: 'tech@example.com' }, partnerId: 'p1', orgId: null, scope: 'partner', canAccessOrg: (id: string) => id === ORG });
    return next();
  },
  requireScope: () => async (_c: any, next: any) => next(),
  requireMfa: () => async (c: any, next: any) => (c.req.header('x-mfa') === '1' ? next() : c.json({ error: 'MFA required', code: 'MFA_REQUIRED' }, 403)),
  requirePermission: (resource: string, action: string) => async (c: any, next: any) =>
    (c.req.header('x-allow') ?? '').split(',').includes(`${resource}:${action}`) ? next() : c.json({ error: 'Forbidden' }, 403),
}));
const auditMock = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('../services/auditService', () => ({ createAuditLogAsync: auditMock }));
const pub = vi.hoisted(() => ({ ensureTrustPage: vi.fn() }));
vi.mock('../services/trustPage/publication', async (orig) => ({ ...(await orig<typeof import('../services/trustPage/publication')>()), ...pub }));
const svc = vi.hoisted(() => ({ declareTrustControl: vi.fn(), withdrawTrustDeclaration: vi.fn(), listTrustDeclarations: vi.fn() }));
vi.mock('../services/trustPage/declarations', () => svc);
const dbm = vi.hoisted(() => ({ rows: [] as unknown[][] }));
vi.mock('../db', () => {
  const chain = () => { const c: any = {}; for (const m of ['select', 'from', 'where', 'innerJoin', 'leftJoin', 'limit', 'orderBy']) c[m] = vi.fn(() => c); c.then = (r: any) => Promise.resolve(dbm.rows.shift() ?? []).then(r); return c; };
  return { db: chain(), runOutsideDbContext: (fn: any) => fn(), withSystemDbAccessContext: (fn: any) => fn() };
});

const ORG = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const DECL = '33333333-3333-4333-8333-333333333333';

import { TrustPageError } from '../services/trustPage/publication';
import { trustPageDeclarationRoutes } from './trustPageDeclarations';

const app = new Hono(); app.route('/orgs', trustPageDeclarationRoutes);
const ALL = 'organizations:read,organizations:write';
const H = (extra: Record<string, string> = {}) => ({ authorization: 'Bearer t', 'x-allow': ALL, 'x-mfa': '1', 'content-type': 'application/json', ...extra });
const ctxRow = { partnerName: 'Northwind IT', deletedAt: null };
const PAGE = { id: 'pg1', orgId: ORG, publicationRevision: 4, publishedAt: new Date('2026-10-01T00:00:00Z'), publishedConfig: {
  hiddenControlIds: [], showPercentages: false, showDeviceCount: false, showManagedBy: true, searchIndexable: false,
  introHtml: null, websiteUrl: null, securityContactEmail: null, documentIds: [], declarationIds: [DECL],
} };
const ROW = {
  id: DECL, trustPageId: 'pg1', orgId: ORG, controlId: 'incident_response_plan', statement: 'We keep a tested IR plan.',
  evidenceDocumentId: null, evidenceDocumentSha256: null, declaredByPartnerName: 'Northwind IT', declaredByUserId: 'u1',
  declaredAt: new Date('2026-10-17T00:00:00Z'), expiresAt: new Date('2027-10-17T00:00:00Z'), supersededAt: null, withdrawnAt: null,
  withdrawnByUserId: null, reminderSentAt: null, createdAt: new Date('2026-10-17T00:00:00Z'),
};
const declareBody = { controlId: 'incident_response_plan', statement: 'We keep a tested IR plan.', evidenceDocumentId: null, expectedRevision: 4 };

beforeEach(() => {
  vi.clearAllMocks(); dbm.rows = [];
  pub.ensureTrustPage.mockResolvedValue(PAGE);
});

describe('GET /orgs/:orgId/trust-page/declarations', () => {
  it('an inaccessible org is the generic 404', async () => {
    const res = await app.request(`/orgs/${OTHER}/trust-page/declarations`, { headers: H() });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found', code: 'NOT_FOUND' });
    expect(svc.listTrustDeclarations).not.toHaveBeenCalled();
  });

  it('a deleted org is the generic 404', async () => {
    dbm.rows.push([{ ...ctxRow, deletedAt: new Date() }]);
    expect((await app.request(`/orgs/${ORG}/trust-page/declarations`, { headers: H() })).status).toBe(404);
  });

  it('returns the catalog, the active and history rows and the ids frozen on the published page', async () => {
    dbm.rows.push([ctxRow]);
    svc.listTrustDeclarations.mockResolvedValueOnce({ active: [ROW], history: [] });
    const res = await app.request(`/orgs/${ORG}/trust-page/declarations`, { headers: H({ 'x-allow': 'organizations:read', 'x-mfa': '0' }) });
    expect(res.status).toBe(200);
    const data = (await res.json()).data;
    expect(data.catalog).toHaveLength(8);
    expect(data.active[0]).toMatchObject({ id: DECL, controlId: 'incident_response_plan', declaredAt: '2026-10-17T00:00:00.000Z' });
    expect(data.publishedDeclarationIds).toEqual([DECL]);
    expect(data.publicationRevision).toBe(4);
  });

  it('an unpublished page reports no published declaration ids', async () => {
    dbm.rows.push([ctxRow]);
    pub.ensureTrustPage.mockResolvedValueOnce({ ...PAGE, publishedAt: null });
    svc.listTrustDeclarations.mockResolvedValueOnce({ active: [], history: [] });
    const data = (await (await app.request(`/orgs/${ORG}/trust-page/declarations`, { headers: H() })).json()).data;
    expect(data.publishedDeclarationIds).toEqual([]);
  });
});

describe('POST /orgs/:orgId/trust-page/declarations', () => {
  it('a read-only user gets 403', async () => {
    const res = await app.request(`/orgs/${ORG}/trust-page/declarations`, { method: 'POST', headers: H({ 'x-allow': 'organizations:read' }), body: JSON.stringify(declareBody) });
    expect(res.status).toBe(403);
    expect(svc.declareTrustControl).not.toHaveBeenCalled();
  });

  it('no MFA → 403 MFA_REQUIRED', async () => {
    const res = await app.request(`/orgs/${ORG}/trust-page/declarations`, { method: 'POST', headers: H({ 'x-mfa': '0' }), body: JSON.stringify(declareBody) });
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('MFA_REQUIRED');
  });

  it('an inaccessible org is 404 and nothing is declared', async () => {
    const res = await app.request(`/orgs/${OTHER}/trust-page/declarations`, { method: 'POST', headers: H(), body: JSON.stringify(declareBody) });
    expect(res.status).toBe(404);
    expect(svc.declareTrustControl).not.toHaveBeenCalled();
  });

  it('a 9-char statement is a 400 validation error', async () => {
    const res = await app.request(`/orgs/${ORG}/trust-page/declarations`, { method: 'POST', headers: H(), body: JSON.stringify({ ...declareBody, statement: '123456789' }) });
    expect(res.status).toBe(400);
  });

  it('success passes the partner name, returns the new revision and writes one declare audit row', async () => {
    dbm.rows.push([ctxRow]);
    svc.declareTrustControl.mockResolvedValueOnce({ declaration: ROW, superseded: null, publicationRevision: 5 });
    const res = await app.request(`/orgs/${ORG}/trust-page/declarations`, { method: 'POST', headers: H(), body: JSON.stringify(declareBody) });
    expect(res.status).toBe(201);
    const data = (await res.json()).data;
    expect(data).toMatchObject({ publicationRevision: 5, superseded: null, declaration: { id: DECL } });
    expect(svc.declareTrustControl).toHaveBeenCalledWith(expect.objectContaining({
      page: PAGE, controlId: 'incident_response_plan', partnerName: 'Northwind IT', actorUserId: 'u1', expectedRevision: 4,
    }));
    expect(auditMock).toHaveBeenCalledTimes(1);
    expect(auditMock).toHaveBeenCalledWith(expect.objectContaining({
      orgId: ORG, action: 'trust_page.declaration.declare', resourceType: 'trust_page', resourceId: 'pg1',
      details: { controlId: 'incident_response_plan', declarationId: DECL, publicationRevision: 5 },
    }));
  });

  it('a re-declaration audits redeclare with the superseded id', async () => {
    dbm.rows.push([ctxRow]);
    svc.declareTrustControl.mockResolvedValueOnce({ declaration: ROW, superseded: 'old-1', publicationRevision: 5 });
    await app.request(`/orgs/${ORG}/trust-page/declarations`, { method: 'POST', headers: H(), body: JSON.stringify(declareBody) });
    expect(auditMock).toHaveBeenCalledWith(expect.objectContaining({
      action: 'trust_page.declaration.redeclare',
      details: { controlId: 'incident_response_plan', declarationId: DECL, publicationRevision: 5, supersededDeclarationId: 'old-1' },
    }));
  });

  it('a service 422 (evidence unavailable) maps through and is not audited', async () => {
    dbm.rows.push([ctxRow]);
    svc.declareTrustControl.mockRejectedValueOnce(new TrustPageError('gone', 422, 'EVIDENCE_UNAVAILABLE'));
    const res = await app.request(`/orgs/${ORG}/trust-page/declarations`, { method: 'POST', headers: H(), body: JSON.stringify(declareBody) });
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe('EVIDENCE_UNAVAILABLE');
    expect(auditMock).not.toHaveBeenCalled();
  });
});

describe('POST /orgs/:orgId/trust-page/declarations/:declarationId/withdraw', () => {
  const url = `/orgs/${ORG}/trust-page/declarations/${DECL}/withdraw`;

  it('a stale revision is 409 REVISION_MISMATCH and not audited', async () => {
    dbm.rows.push([ctxRow]);
    svc.withdrawTrustDeclaration.mockRejectedValueOnce(new TrustPageError('stale', 409, 'REVISION_MISMATCH'));
    const res = await app.request(url, { method: 'POST', headers: H(), body: JSON.stringify({ expectedRevision: 3 }) });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('REVISION_MISMATCH');
    expect(auditMock).not.toHaveBeenCalled();
  });

  it('no MFA → 403; read-only → 403', async () => {
    expect((await app.request(url, { method: 'POST', headers: H({ 'x-mfa': '0' }), body: JSON.stringify({ expectedRevision: 4 }) })).status).toBe(403);
    expect((await app.request(url, { method: 'POST', headers: H({ 'x-allow': 'organizations:read' }), body: JSON.stringify({ expectedRevision: 4 }) })).status).toBe(403);
    expect(svc.withdrawTrustDeclaration).not.toHaveBeenCalled();
  });

  it('a non-uuid declaration id is a 400', async () => {
    expect((await app.request(`/orgs/${ORG}/trust-page/declarations/nope/withdraw`, { method: 'POST', headers: H(), body: JSON.stringify({ expectedRevision: 4 }) })).status).toBe(400);
  });

  it('success returns the new revision and writes one withdraw audit row', async () => {
    dbm.rows.push([ctxRow]);
    svc.withdrawTrustDeclaration.mockResolvedValueOnce({ publicationRevision: 5, controlId: 'incident_response_plan' });
    const res = await app.request(url, { method: 'POST', headers: H(), body: JSON.stringify({ expectedRevision: 4 }) });
    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual({ publicationRevision: 5 });
    expect(svc.withdrawTrustDeclaration).toHaveBeenCalledWith(expect.objectContaining({ page: PAGE, declarationId: DECL, actorUserId: 'u1', expectedRevision: 4 }));
    expect(auditMock).toHaveBeenCalledTimes(1);
    expect(auditMock).toHaveBeenCalledWith(expect.objectContaining({
      action: 'trust_page.declaration.withdraw',
      details: { controlId: 'incident_response_plan', declarationId: DECL, publicationRevision: 5 },
    }));
  });
});
