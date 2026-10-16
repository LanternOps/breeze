import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../services/contractService', () => ({
  createContract: vi.fn(),
  getContract: vi.fn(),
  listContracts: vi.fn(),
  updateContract: vi.fn(),
  deleteDraftContract: vi.fn(),
  addContractLineToContract: vi.fn(),
  removeContractLine: vi.fn(),
  updateContractLine: vi.fn(),
  contractLineAuditDetails: vi.fn((audit: any) => ({
    contractLineId: audit.contractLineId,
    lineType: audit.lineType,
    ...(audit.changedFields !== undefined ? { changedFields: audit.changedFields } : {}),
    ...(audit.oldUnitPrice !== undefined ? { oldUnitPrice: audit.oldUnitPrice } : {}),
    ...(audit.newUnitPrice !== undefined ? { newUnitPrice: audit.newUnitPrice } : {}),
    ...(audit.retired !== undefined ? { retired: audit.retired } : {}),
  })),
  activateContract: vi.fn(),
  pauseContract: vi.fn(),
  resumeContract: vi.fn(),
  cancelContract: vi.fn(),
  generateDueInvoice: vi.fn(),
  computeContractEstimate: vi.fn(),
  changeContractCurrency: vi.fn()
}));

vi.mock('../../services/auditEvents', () => ({ writeRouteAudit: vi.fn() }));
vi.mock('../../db', () => ({
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
  withSystemDbAccessContext: vi.fn((fn: () => unknown) => fn()),
}));
vi.mock('../../services/contractTypes', () => ({
  ContractServiceError: class ContractServiceError extends Error {
    constructor(msg: string, public status = 400, public code?: string, public details?: Record<string, unknown>) { super(msg); }
  },
  actorCan: (a: { permissions?: ReadonlySet<string> }, p: { resource: string; action: string }) =>
    a.permissions?.has(`${p.resource}:${p.action}`) === true,
}));
vi.mock('../../middleware/auth', () => ({
  authMiddleware: async (c: any, next: any) => {
    c.set('auth', { user: { id: 'u1' }, partnerId: 'p1', orgId: null, scope: 'partner', accessibleOrgIds: null });
    c.set('permissions', { permissions: [{ resource: 'contracts', action: 'read' }], partnerId: 'p1', orgId: null, roleId: 'r1', scope: 'partner' });
    await next();
  },
  requireScope: () => async (_c: any, next: any) => next(),
  requirePermission: () => async (_c: any, next: any) => next(),
}));
vi.mock('../../services/contractHourPeriodsRead', () => ({ listContractHourPeriods: vi.fn() }));

import { contractRoutes } from './index';
import { listContractHourPeriods } from '../../services/contractHourPeriodsRead';
import { ContractServiceError } from '../../services/contractTypes';

const CONTRACT_ID = '11111111-1111-1111-1111-111111111111';

describe('GET /:id/hour-periods (#4547 W03)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns the page and forwards limit, cursor and the actor', async () => {
    (listContractHourPeriods as any).mockResolvedValue({ items: [{ id: 'hp1' }], nextCursor: null });
    const cursor = '2026-08-01|22222222-2222-4222-8222-222222222222';
    const res = await contractRoutes.request(`/${CONTRACT_ID}/hour-periods?limit=5&cursor=${encodeURIComponent(cursor)}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { items: [{ id: 'hp1' }], nextCursor: null } });
    expect(listContractHourPeriods).toHaveBeenCalledWith(CONTRACT_ID, { limit: 5, cursor }, expect.objectContaining({ userId: 'u1' }));
  });

  it('defaults the limit', async () => {
    (listContractHourPeriods as any).mockResolvedValue({ items: [], nextCursor: null });
    await contractRoutes.request(`/${CONTRACT_ID}/hour-periods`);
    expect(listContractHourPeriods).toHaveBeenCalledWith(CONTRACT_ID, { limit: 24 }, expect.anything());
  });

  it.each(['limit=0', 'limit=101', 'limit=abc', 'cursor=nope'])('rejects %s with 400 and no service call', async (qs) => {
    const res = await contractRoutes.request(`/${CONTRACT_ID}/hour-periods?${qs}`);
    expect(res.status).toBe(400);
    expect(listContractHourPeriods).not.toHaveBeenCalled();
  });

  it('maps a service error to its status and code', async () => {
    (listContractHourPeriods as any).mockRejectedValue(new ContractServiceError('Contract not found', 404, 'CONTRACT_NOT_FOUND'));
    const res = await contractRoutes.request(`/${CONTRACT_ID}/hour-periods`);
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: 'CONTRACT_NOT_FOUND' });
  });
});
