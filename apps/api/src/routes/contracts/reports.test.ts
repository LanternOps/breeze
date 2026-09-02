import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the report service — the route is thin; we assert MOUNT ORDERING,
// validation, actor plumbing and error mapping (#3778, Task 15).
vi.mock('../../services/contractCurrencyReportService', () => ({
  listContractCurrencyMismatches: vi.fn(),
}));

// The crud/lifecycle/line/generate siblings are pulled in by ./index; mock the
// service they share so importing the mounted app stays cheap and side-effect free.
vi.mock('../../services/contractService', () => ({
  createContract: vi.fn(), getContract: vi.fn(), listContracts: vi.fn(),
  updateContract: vi.fn(), deleteDraftContract: vi.fn(),
  addContractLineToContract: vi.fn(), removeContractLine: vi.fn(),
  activateContract: vi.fn(), pauseContract: vi.fn(), resumeContract: vi.fn(),
  cancelContract: vi.fn(), generateDueInvoice: vi.fn(),
  computeContractEstimate: vi.fn(), changeContractCurrency: vi.fn(),
}));

vi.mock('../../db', () => ({
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
  withSystemDbAccessContext: vi.fn((fn: () => unknown) => fn()),
}));

vi.mock('../../services/contractTypes', () => ({
  ContractServiceError: class ContractServiceError extends Error {
    constructor(
      msg: string, public status = 400, public code?: string,
      public details?: Record<string, unknown>
    ) { super(msg); }
  },
  actorCan: (a: { permissions?: ReadonlySet<string> }, p: { resource: string; action: string }) =>
    a.permissions?.has(`${p.resource}:${p.action}`) === true,
}));

vi.mock('../../middleware/auth', () => ({
  authMiddleware: async (c: any, next: any) => {
    c.set('auth', { user: { id: 'u1' }, partnerId: 'p1', orgId: null, scope: 'partner', accessibleOrgIds: ['org-1'] });
    c.set('permissions', {
      permissions: [
        { resource: 'contracts', action: 'read' },
        { resource: 'contracts', action: 'write' },
      ],
      partnerId: 'p1', orgId: null, roleId: 'r1', scope: 'partner',
    });
    await next();
  },
  requireScope: () => async (_c: any, next: any) => next(),
  requirePermission: () => async (_c: any, next: any) => next(),
}));

import { contractRoutes } from './index';
import * as svc from '../../services/contractCurrencyReportService';
import { ContractServiceError } from '../../services/contractTypes';

const ORG_ID = '22222222-2222-2222-2222-222222222222';
const CONTRACT_ID = '11111111-1111-1111-1111-111111111111';

const EMPTY = { items: [], nextCursor: null };

describe('GET /contracts/currency-mismatches', () => {
  beforeEach(() => vi.clearAllMocks());

  it('is NOT swallowed by GET /:id — returns the report body, not an invalid-uuid 400', async () => {
    (svc.listContractCurrencyMismatches as any).mockResolvedValue({
      items: [{
        contractId: CONTRACT_ID, contractName: 'Legacy MSA', orgId: ORG_ID, orgName: 'Acme',
        status: 'active', contractCurrencyCode: 'USD', orgCurrencyCode: 'EUR',
        nextBillingAt: null, draftMonetaryInvoiceCount: 0, blockingDraftInvoiceIds: [],
        orphanedBillingPeriodCount: 0, activeChangeEligible: true, ineligibleReason: null,
      }],
      nextCursor: null,
    });

    const res = await contractRoutes.request('/currency-mismatches');
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.data.items[0].contractId).toBe(CONTRACT_ID);
    expect(body.data.nextCursor).toBeNull();
    expect(svc.listContractCurrencyMismatches).toHaveBeenCalledTimes(1);
  });

  it('passes the validated query through and the route-resolved actor', async () => {
    (svc.listContractCurrencyMismatches as any).mockResolvedValue(EMPTY);

    const res = await contractRoutes.request(
      `/currency-mismatches?orgId=${ORG_ID}&status=active&limit=5&cursor=${CONTRACT_ID}`
    );
    expect(res.status).toBe(200);
    const [query, actor] = (svc.listContractCurrencyMismatches as any).mock.calls[0];
    expect(query).toEqual({ orgId: ORG_ID, status: 'active', limit: 5, cursor: CONTRACT_ID });
    expect(actor).toMatchObject({ userId: 'u1', partnerId: 'p1', accessibleOrgIds: ['org-1'] });
    // Permission evidence is plumbed through contractActorFrom, not re-derived.
    expect([...actor.permissions].sort()).toEqual(['contracts:read', 'contracts:write']);
  });

  it('rejects a malformed query (400) without reaching the service', async () => {
    const res = await contractRoutes.request('/currency-mismatches?orgId=not-a-uuid');
    expect(res.status).toBe(400);
    expect(svc.listContractCurrencyMismatches).not.toHaveBeenCalled();
  });

  it('maps a ContractServiceError through handleContractError', async () => {
    (svc.listContractCurrencyMismatches as any).mockRejectedValue(
      new ContractServiceError('Organization access denied', 403, 'ORG_DENIED')
    );
    const res = await contractRoutes.request(`/currency-mismatches?orgId=${ORG_ID}`);
    expect(res.status).toBe(403);
    expect((await res.json() as any).code).toBe('ORG_DENIED');
  });

  it('exposes NO bulk mutation on the report path', async () => {
    (svc.listContractCurrencyMismatches as any).mockResolvedValue(EMPTY);
    for (const method of ['POST', 'PATCH', 'PUT', 'DELETE']) {
      const res = await contractRoutes.request('/currency-mismatches', { method });
      expect(res.status).not.toBe(200);
    }
  });
});
