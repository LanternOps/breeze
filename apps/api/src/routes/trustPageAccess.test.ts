import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
vi.mock('../middleware/auth', () => ({
  authMiddleware: async (c: any, next: any) => {
    if (!c.req.header('authorization')) return c.json({ error: 'Unauthorized' }, 401);
    c.set('auth', { user: { id: 'u1', email: 'tech@msp.test' }, partnerId: 'p1', orgId: null, scope: c.req.header('x-scope') ?? 'partner', canAccessOrg: (id: string) => id === '11111111-1111-4111-8111-111111111111' });
    return next();
  },
  requireScope: () => async (_c: any, next: any) => next(),
  requireMfa: () => async (c: any, next: any) => (c.req.header('x-mfa') === '1' ? next() : c.json({ error: 'MFA required', code: 'MFA_REQUIRED' }, 403)),
  requirePermission: (resource: string, action: string) => async (c: any, next: any) =>
    (c.req.header('x-allow') ?? '').split(',').includes(`${resource}:${action}`) ? next() : c.json({ error: 'Forbidden' }, 403),
}));
const auditMock = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('../services/auditService', () => ({ createAuditLogAsync: auditMock }));
vi.mock('../services/sentry', () => ({ captureException: vi.fn() }));
const svc = vi.hoisted(() => ({
  listAccessRequests: vi.fn(async () => []), approveAccessRequest: vi.fn(), denyAccessRequest: vi.fn(async () => {}),
  revokeAccessGrant: vi.fn(async () => {}), resendAccessGrant: vi.fn(async () => {}),
}));
vi.mock('../services/trustPage/access/requests', () => svc);
vi.mock('../services/trustPage/publication', () => ({
  TrustPageError: class TrustPageError extends Error { constructor(m: string, public status: number, public code: string) { super(m); } },
}));
import { TrustPageError } from '../services/trustPage/publication';
import { trustPageAccessRoutes } from './trustPageAccess';

const ORG = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const REQ = '33333333-3333-4333-8333-333333333333';
const app = new Hono(); app.route('/orgs', trustPageAccessRoutes);
const READ = 'organizations:read'; const WRITE = 'organizations:write';
const call = (method: string, path: string, h: Record<string, string> = {}, body?: unknown) => app.request(`/orgs${path}`, {
  method, headers: { authorization: 'Bearer t', 'content-type': 'application/json', ...h }, body: body === undefined ? undefined : JSON.stringify(body),
});
const base = `/${ORG}/trust-page/access-requests`;

beforeEach(() => { vi.clearAllMocks(); svc.approveAccessRequest.mockResolvedValue({ grantExpiresAt: new Date('2026-10-24T00:00:00Z'), grantedDocumentIds: ['d1'] }); });

describe('GET access-requests', () => {
  it('needs organizations:read and returns the inbox', async () => {
    expect((await call('GET', base)).status).toBe(403);
    const res = await call('GET', `${base}?status=pending_approval`, { 'x-allow': READ });
    expect(res.status).toBe(200);
    expect(svc.listAccessRequests).toHaveBeenCalledWith(ORG, 'pending_approval', expect.any(Date));
  });
  it('an unknown status filter is a 400, another org is a 404 without touching the service', async () => {
    expect((await call('GET', `${base}?status=bogus`, { 'x-allow': READ })).status).toBe(400);
    expect((await call('GET', `/${OTHER}/trust-page/access-requests`, { 'x-allow': READ })).status).toBe(404);
    expect(svc.listAccessRequests).not.toHaveBeenCalled();
  });
});

describe('approve', () => {
  it('without MFA → 403 and the service is never called', async () => {
    const res = await call('POST', `${base}/${REQ}/approve`, { 'x-allow': WRITE }, {});
    expect(res.status).toBe(403);
    expect(svc.approveAccessRequest).not.toHaveBeenCalled();
  });
  it('with MFA → 200, audited with the grant', async () => {
    const res = await call('POST', `${base}/${REQ}/approve`, { 'x-allow': WRITE, 'x-mfa': '1' }, { note: 'ok' });
    expect(res.status).toBe(200);
    expect(svc.approveAccessRequest).toHaveBeenCalledWith(expect.objectContaining({ requestId: REQ, orgId: ORG, actorUserId: 'u1', note: 'ok' }));
    expect(auditMock).toHaveBeenCalledWith(expect.objectContaining({ action: 'trust_page.access.approve', orgId: ORG, details: expect.objectContaining({ requestId: REQ, grantedDocumentIds: ['d1'] }) }));
  });
  it('a pending_verification request → 409 INVALID_STATE', async () => {
    svc.approveAccessRequest.mockRejectedValueOnce(new TrustPageError('This request is pending verification', 409 as never, 'INVALID_STATE'));
    const res = await call('POST', `${base}/${REQ}/approve`, { 'x-allow': WRITE, 'x-mfa': '1' }, {});
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'INVALID_STATE' });
    expect(auditMock).not.toHaveBeenCalled();
  });
  it('no gated documents → 422', async () => {
    svc.approveAccessRequest.mockRejectedValueOnce(new TrustPageError('none', 422 as never, 'NO_GATED_DOCUMENTS'));
    const res = await call('POST', `${base}/${REQ}/approve`, { 'x-allow': WRITE, 'x-mfa': '1' }, {});
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ code: 'NO_GATED_DOCUMENTS' });
  });
  it('another org\'s request id → 404 (the org-scoped lookup finds nothing)', async () => {
    svc.approveAccessRequest.mockRejectedValueOnce(new TrustPageError('Not found', 404 as never, 'NOT_FOUND'));
    expect((await call('POST', `${base}/${REQ}/approve`, { 'x-allow': WRITE, 'x-mfa': '1' }, {})).status).toBe(404);
  });
  it('an org the partner user cannot access → 404 before the service', async () => {
    expect((await call('POST', `/${OTHER}/trust-page/access-requests/${REQ}/approve`, { 'x-allow': WRITE, 'x-mfa': '1' }, {})).status).toBe(404);
    expect(svc.approveAccessRequest).not.toHaveBeenCalled();
  });
  it('a malformed request id → 400', async () => {
    expect((await call('POST', `${base}/nope/approve`, { 'x-allow': WRITE, 'x-mfa': '1' }, {})).status).toBe(400);
  });
});

describe('deny / revoke / resend', () => {
  it('deny needs write (no MFA) and carries the note', async () => {
    expect((await call('POST', `${base}/${REQ}/deny`, { 'x-allow': READ }, {})).status).toBe(403);
    const res = await call('POST', `${base}/${REQ}/deny`, { 'x-allow': WRITE }, { note: 'Sign the NDA first' });
    expect(res.status).toBe(200);
    expect(svc.denyAccessRequest).toHaveBeenCalledWith(expect.objectContaining({ requestId: REQ, note: 'Sign the NDA first' }));
    expect(auditMock).toHaveBeenCalledWith(expect.objectContaining({ action: 'trust_page.access.deny' }));
  });
  it('revoke needs write (no MFA)', async () => {
    const res = await call('POST', `${base}/${REQ}/revoke`, { 'x-allow': WRITE });
    expect(res.status).toBe(200);
    expect(auditMock).toHaveBeenCalledWith(expect.objectContaining({ action: 'trust_page.access.revoke' }));
  });
  it('resend needs MFA', async () => {
    expect((await call('POST', `${base}/${REQ}/resend`, { 'x-allow': WRITE })).status).toBe(403);
    const res = await call('POST', `${base}/${REQ}/resend`, { 'x-allow': WRITE, 'x-mfa': '1' });
    expect(res.status).toBe(200);
    expect(auditMock).toHaveBeenCalledWith(expect.objectContaining({ action: 'trust_page.access.resend' }));
  });
});
