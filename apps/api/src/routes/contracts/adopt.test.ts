import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

vi.mock('../../middleware/auth', () => ({
  authMiddleware: async (c: any, next: any) => {
    if (!c.req.header('authorization')) return c.json({ error: 'Unauthorized' }, 401);
    c.set('auth', { user: { id: 'u1' }, partnerId: 'p1', accessibleOrgIds: ['org1'], scope: 'partner' });
    c.set('permissions', { permissions: [{ resource: 'contracts', action: 'write' }] });
    return next();
  },
  requireScope: () => async (_c: any, next: any) => next(),
  // Records which permission each route asked for, so the test can assert the
  // write gate (not read, not manage) guards adopt-draft.
  requirePermission: (resource: string, action: string) => async (c: any, next: any) =>
    c.req.header('x-allow') === `${resource}:${action}` ? next() : c.json({ error: 'Forbidden' }, 403),
}));

const serviceMocks = vi.hoisted(() => ({ adoptDraftContract: vi.fn() }));
vi.mock('../../services/contractAdoptService', () => serviceMocks);
const auditMocks = vi.hoisted(() => ({ auditBillingDocument: vi.fn() }));
vi.mock('../../services/billingDocumentAudit', () => auditMocks);

import { authMiddleware } from '../../middleware/auth';
import { ContractServiceError } from '../../services/contractTypes';
import { contractAdoptRoutes } from './adopt';

const { adoptDraftContract } = serviceMocks;
const { auditBillingDocument } = auditMocks;

const X = '11111111-1111-4111-8111-111111111111';
const Y = '22222222-2222-4222-8222-222222222222';
const PATH = `/${X}/adopt-draft`;
const WRITE = { authorization: 'Bearer t', 'x-allow': 'contracts:write', 'content-type': 'application/json' };
const READ_ONLY = { authorization: 'Bearer t', 'x-allow': 'contracts:read', 'content-type': 'application/json' };
const body = JSON.stringify({ sourceContractId: Y });

const app = new Hono();
app.use('*', authMiddleware);
app.route('/', contractAdoptRoutes);

const RESULT = {
  target: { id: X, orgId: 'org1', name: 'Quote accept draft' },
  source: { id: Y, orgId: 'org1', name: 'Hand-built draft' },
  movedDeliverables: 3, movedDocuments: 1, movedAgreementRequests: 0,
};

describe('POST /contracts/:id/adopt-draft (#9346)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    adoptDraftContract.mockResolvedValue(RESULT);
  });

  it('401 unauthenticated', async () =>
    expect((await app.request(PATH, { method: 'POST', body })).status).toBe(401));

  it('403 without contracts:write, and the service never runs', async () => {
    const res = await app.request(PATH, { method: 'POST', headers: READ_ONLY, body });
    expect(res.status).toBe(403);
    expect(adoptDraftContract).not.toHaveBeenCalled();
    expect(auditBillingDocument).not.toHaveBeenCalled();
  });

  it('400 for a malformed body', async () => {
    const res = await app.request(PATH, { method: 'POST', headers: WRITE, body: JSON.stringify({ sourceContractId: 'x' }) });
    expect(res.status).toBe(400);
    expect(adoptDraftContract).not.toHaveBeenCalled();
  });

  it('200: calls the service with the actor and writes exactly one contract.draft_adopted audit row', async () => {
    const res = await app.request(PATH, { method: 'POST', headers: WRITE, body });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: RESULT });
    expect(adoptDraftContract).toHaveBeenCalledWith(X, { sourceContractId: Y }, expect.objectContaining({
      userId: 'u1', partnerId: 'p1', accessibleOrgIds: ['org1'],
    }));
    expect(auditBillingDocument).toHaveBeenCalledTimes(1);
    expect(auditBillingDocument).toHaveBeenCalledWith(expect.anything(), 'contract', 'draft_adopted', RESULT.target, {
      sourceContractId: Y, sourceContractName: 'Hand-built draft',
      movedDeliverables: 3, movedDocuments: 1, movedAgreementRequests: 0,
    });
  });

  it.each([
    [400, 'ADOPT_SOURCE_NOT_DRAFT', undefined],
    [404, 'CONTRACT_NOT_FOUND', undefined],
    [409, 'DUPLICATE_NAME', { names: ['Quarterly review'] }],
  ] as const)('%s %s passes the service error through and audits nothing', async (status, code, details) => {
    adoptDraftContract.mockRejectedValueOnce(new ContractServiceError('nope', status, code, details));
    const res = await app.request(PATH, { method: 'POST', headers: WRITE, body });
    expect(res.status).toBe(status);
    expect(await res.json()).toEqual({ error: 'nope', code, ...(details ? { details } : {}) });
    expect(auditBillingDocument).not.toHaveBeenCalled();
  });

  it('is mounted BEFORE contractCrudRoutes', () => {
    const src = readFileSync(join(__dirname, 'index.ts'), 'utf8');
    const at = src.indexOf("contractRoutes.route('/', contractAdoptRoutes");
    expect(at).toBeGreaterThan(-1);
    expect(at).toBeLessThan(src.indexOf("contractRoutes.route('/', contractCrudRoutes"));
  });
});
