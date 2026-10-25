import { describe, it, expect, vi, beforeEach } from 'vitest';

// Route tests for the agreement-request lifecycle (#9075 W2a, spec §5):
// guards (read / write / send split + scopes), validation, error mapping,
// audit, and the post-commit jti revoke on void. The lifecycle service is
// mocked; its own guards are agreementRequestLifecycle.test.ts.

const h = vi.hoisted(() => ({
  guards: [] as string[],
  grants: null as Set<string> | null,
  svc: {
    listAgreementRequests: vi.fn(),
    getAgreementRequestDetail: vi.fn(),
    createAgreementRequest: vi.fn(),
    updateAgreementRequest: vi.fn(),
    deleteAgreementRequest: vi.fn(),
    previewAgreementRequest: vi.fn(),
    sendAgreementRequest: vi.fn(),
    getAgreementRequestLink: vi.fn(),
    voidAgreementRequest: vi.fn(),
  },
  writeRouteAudit: vi.fn(),
  revoke: vi.fn(),
  captureException: vi.fn(),
  afterCommit: [] as Array<{ label: string; work: () => unknown }>,
}));

vi.mock('../../middleware/auth', () => ({
  authMiddleware: async (c: any, next: any) => {
    c.set('auth', {
      user: { id: 'u1' },
      partnerId: 'p1',
      orgId: null,
      scope: 'partner',
      canAccessOrg: () => true,
      orgCondition: () => undefined,
    });
    await next();
  },
  requireScope: (...scopes: string[]) => async (_c: any, next: any) => { h.guards.push(`scope:${scopes.join(',')}`); return next(); },
  requirePermission: (resource: string, action: string) => async (c: any, next: any) => {
    h.guards.push(`perm:${resource}:${action}`);
    if (h.grants && !h.grants.has(`${resource}:${action}`)) return c.json({ error: 'Permission denied' }, 403);
    return next();
  },
  withAuthDbAccessContext: async (_a: unknown, fn: () => Promise<unknown>) => fn(),
}));

vi.mock('../../db', async (importActual) => ({
  ...(await importActual<typeof import('../../db')>()),
  runAfterDbContextCommit: (label: string, work: () => unknown) => { h.afterCommit.push({ label, work }); },
}));

vi.mock('../../services/agreementRequestLifecycle', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/agreementRequestLifecycle')>()),
  ...h.svc,
}));

vi.mock('../../services/agreementAcceptToken', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/agreementAcceptToken')>()),
  revokeAgreementAcceptJti: h.revoke,
}));

vi.mock('../../services/sentry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/sentry')>()),
  captureException: h.captureException,
}));

vi.mock('../../services/auditEvents', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/auditEvents')>()),
  writeRouteAudit: h.writeRouteAudit,
}));

import { contractRoutes } from './index';
import { AgreementRequestServiceError } from '../../services/agreementRequestService';
import { ContractTemplateServiceError } from '../../services/contractTemplateService';

const ORG = '11111111-1111-4111-8111-111111111111';
const TEMPLATE = '44444444-4444-4444-8444-444444444444';
const REQ = '55555555-5555-4555-8555-555555555555';
const BASE = '/agreement-requests';
const DTO = { id: REQ, orgId: ORG, status: 'draft' };

function json(method: string, body: unknown): RequestInit {
  return { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.guards.length = 0;
  h.grants = null;
  h.afterCommit.length = 0;
  h.svc.listAgreementRequests.mockResolvedValue([]);
  h.svc.getAgreementRequestDetail.mockResolvedValue({ ...DTO, recipients: [] });
  h.svc.createAgreementRequest.mockResolvedValue({ ...DTO, recipients: ['a@example.com'] });
  h.svc.updateAgreementRequest.mockResolvedValue({ ...DTO, label: 'x' });
  h.svc.deleteAgreementRequest.mockResolvedValue({ id: REQ, orgId: ORG });
  h.svc.previewAgreementRequest.mockResolvedValue({ sourceType: 'authored', html: '<p>x</p>', unresolved: [] });
  h.svc.sendAgreementRequest.mockResolvedValue({ request: { ...DTO, status: 'sent' }, emailed: false, link: 'https://portal/agreement/t', recipients: ['a@example.com'] });
  h.svc.getAgreementRequestLink.mockResolvedValue({ link: 'https://portal/agreement/t', reissued: false, orgId: ORG });
  h.svc.voidAgreementRequest.mockResolvedValue({ request: { ...DTO, status: 'voided', voidReason: 'wrong client' }, revoke: { jti: 'jti-1', tokenExpiresAt: null } });
});

// The permission split, spec §5 / OD7 B.
const ROUTES: Array<[string, string, RequestInit | undefined, string]> = [
  ['GET /', BASE, undefined, 'agreements:read'],
  ['GET /:id', `${BASE}/${REQ}`, undefined, 'agreements:read'],
  ['GET /:id/preview', `${BASE}/${REQ}/preview`, undefined, 'agreements:read'],
  ['POST /', BASE, json('POST', { orgId: ORG, templateId: TEMPLATE }), 'agreements:write'],
  ['PATCH /:id', `${BASE}/${REQ}`, json('PATCH', { label: 'x' }), 'agreements:write'],
  ['DELETE /:id', `${BASE}/${REQ}`, { method: 'DELETE' }, 'agreements:write'],
  ['POST /:id/send', `${BASE}/${REQ}/send`, { method: 'POST' }, 'agreements:send'],
  ['GET /:id/link', `${BASE}/${REQ}/link`, undefined, 'agreements:send'],
  ['POST /:id/void', `${BASE}/${REQ}/void`, json('POST', {}), 'agreements:send'],
];

describe('permission split (read / write / send) and scopes', () => {
  for (const [name, url, init, perm] of ROUTES) {
    it(`${name} is guarded by partner/organization/system scopes and ${perm}`, async () => {
      const res = await contractRoutes.request(url, init);
      expect(res.status).toBeLessThan(300);
      expect(h.guards).toEqual(['scope:partner,organization,system', `perm:${perm}`]);
    });

    it(`${name} 403s a caller holding every agreements permission except ${perm}`, async () => {
      h.grants = new Set(['agreements:read', 'agreements:write', 'agreements:send'].filter((p) => p !== perm));
      const res = await contractRoutes.request(url, init);
      expect(res.status).toBe(403);
    });
  }
});

describe('validation', () => {
  it('a non-uuid id → 400 before the service', async () => {
    const res = await contractRoutes.request(`${BASE}/not-a-uuid`);
    expect(res.status).toBe(400);
    expect(h.svc.getAgreementRequestDetail).not.toHaveBeenCalled();
  });

  it('POST / with a bad recipient → 400', async () => {
    const res = await contractRoutes.request(BASE, json('POST', { orgId: ORG, templateId: TEMPLATE, recipients: ['nope'] }));
    expect(res.status).toBe(400);
    expect(h.svc.createAgreementRequest).not.toHaveBeenCalled();
  });

  it('PATCH with an empty body → 400', async () => {
    const res = await contractRoutes.request(`${BASE}/${REQ}`, json('PATCH', {}));
    expect(res.status).toBe(400);
    expect(h.svc.updateAgreementRequest).not.toHaveBeenCalled();
  });

  it('GET / with a raw status → 400', async () => {
    const res = await contractRoutes.request(`${BASE}?status=draft`);
    expect(res.status).toBe(400);
  });
});

describe('responses + audit', () => {
  it('POST / → 201 with the detail and a billing.agreement.request_created audit', async () => {
    const res = await contractRoutes.request(BASE, json('POST', { orgId: ORG, templateId: TEMPLATE, recipients: ['A@Example.com'] }));
    expect(res.status).toBe(201);
    expect((await res.json()).data).toMatchObject({ id: REQ });
    expect(h.svc.createAgreementRequest.mock.calls[0]![1]).toMatchObject({ recipients: ['a@example.com'] });
    expect(h.writeRouteAudit.mock.calls[0]![1]).toMatchObject({
      action: 'billing.agreement.request_created', orgId: ORG, resourceType: 'agreement_request', resourceId: REQ, result: 'success',
    });
  });

  it('GET / passes the status bucket through', async () => {
    await contractRoutes.request(`${BASE}?status=pending&orgId=${ORG}`);
    expect(h.svc.listAgreementRequests.mock.calls[0]![1]).toEqual({ status: 'pending', orgId: ORG });
  });

  it('PATCH and DELETE audit request_updated / request_deleted', async () => {
    await contractRoutes.request(`${BASE}/${REQ}`, json('PATCH', { label: 'x' }));
    await contractRoutes.request(`${BASE}/${REQ}`, { method: 'DELETE' });
    expect(h.writeRouteAudit.mock.calls.map((c) => c[1].action)).toEqual([
      'billing.agreement.request_updated', 'billing.agreement.request_deleted',
    ]);
  });

  it('POST /:id/send → { emailed: false, link } and a billing.agreement.sent audit that never logs the link', async () => {
    const res = await contractRoutes.request(`${BASE}/${REQ}/send`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect((await res.json()).data).toMatchObject({ emailed: false, link: 'https://portal/agreement/t' });
    const audit = h.writeRouteAudit.mock.calls[0]![1];
    expect(audit).toMatchObject({ action: 'billing.agreement.sent', resourceId: REQ, details: { recipientCount: 1, emailed: false } });
    expect(JSON.stringify(audit)).not.toContain('agreement/t');
  });

  it('GET /:id/link audits the credential dispense without the link itself', async () => {
    const res = await contractRoutes.request(`${BASE}/${REQ}/link`);
    expect((await res.json()).data).toEqual({ link: 'https://portal/agreement/t', reissued: false });
    const audit = h.writeRouteAudit.mock.calls[0]![1];
    expect(audit).toMatchObject({ action: 'billing.agreement.link_copied', orgId: ORG, details: { reissued: false } });
    expect(JSON.stringify(audit)).not.toContain('agreement/t');
  });

  it('POST /:id/void audits and revokes the jti only AFTER commit (never inside the tx)', async () => {
    const res = await contractRoutes.request(`${BASE}/${REQ}/void`, json('POST', { reason: 'wrong client' }));
    expect(res.status).toBe(200);
    expect(h.svc.voidAgreementRequest.mock.calls[0]![2]).toEqual({ reason: 'wrong client' });
    expect(h.writeRouteAudit.mock.calls[0]![1]).toMatchObject({ action: 'billing.agreement.voided', details: { reason: 'wrong client' } });
    expect(h.revoke).not.toHaveBeenCalled();
    expect(h.afterCommit).toHaveLength(1);
    await h.afterCommit[0]!.work();
    expect(h.revoke).toHaveBeenCalledWith('jti-1', null);
  });
});

describe('void post-commit revoke edge cases', () => {
  it('a voided request with no minted token schedules no Redis work', async () => {
    h.svc.voidAgreementRequest.mockResolvedValueOnce({ request: { ...DTO, status: 'voided', voidReason: null }, revoke: null });
    const res = await contractRoutes.request(`${BASE}/${REQ}/void`, json('POST', {}));
    expect(res.status).toBe(200);
    expect(h.afterCommit).toHaveLength(0);
  });

  it('a failed Redis revoke after commit is reported, not thrown (the durable kill already holds)', async () => {
    h.revoke.mockRejectedValueOnce(new Error('redis down'));
    const res = await contractRoutes.request(`${BASE}/${REQ}/void`, json('POST', {}));
    expect(res.status).toBe(200);
    await expect(h.afterCommit[0]!.work()).resolves.toBeUndefined();
    expect(h.captureException).toHaveBeenCalledWith(expect.objectContaining({ message: 'redis down' }));
  });
});

describe('error mapping', () => {
  const cases: Array<[number, string]> = [
    [404, 'REQUEST_NOT_FOUND'],
    [409, 'INVALID_STATE'],
    [409, 'AGREEMENT_ALREADY_SIGNED'],
    [410, 'AGREEMENT_EXPIRED'],
    [422, 'RECIPIENTS_REQUIRED'],
    [422, 'AGREEMENT_VARIABLES_UNRESOLVED'],
  ];
  for (const [status, code] of cases) {
    it(`service ${status} ${code} → same status and code, no audit`, async () => {
      h.svc.sendAgreementRequest.mockRejectedValueOnce(new AgreementRequestServiceError('x', status as 404, code as 'INVALID_STATE'));
      const res = await contractRoutes.request(`${BASE}/${REQ}/send`, { method: 'POST' });
      expect(res.status).toBe(status);
      expect(await res.json()).toMatchObject({ code });
      expect(h.writeRouteAudit).not.toHaveBeenCalled();
    });
  }

  it('a template guard error maps through', async () => {
    h.svc.createAgreementRequest.mockRejectedValueOnce(new ContractTemplateServiceError('archived', 422, 'TEMPLATE_ARCHIVED'));
    const res = await contractRoutes.request(BASE, json('POST', { orgId: ORG, templateId: TEMPLATE }));
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ code: 'TEMPLATE_ARCHIVED' });
  });

  it('an unexpected error is not swallowed as a 4xx', async () => {
    h.svc.voidAgreementRequest.mockRejectedValueOnce(new Error('boom'));
    const res = await contractRoutes.request(`${BASE}/${REQ}/void`, json('POST', {}));
    expect(res.status).toBe(500);
    expect(h.afterCommit).toHaveLength(0);
  });
});
