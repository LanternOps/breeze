import { describe, it, expect, vi, beforeEach } from 'vitest';

// Full contractService mock — lifecycle.ts imports activateContract/pauseContract/resumeContract too
vi.mock('../../services/contractService', () => ({
  deleteDraftContract: vi.fn(),
  cancelContract: vi.fn(),
  createContract: vi.fn(),
  getContract: vi.fn(),
  listContracts: vi.fn(),
  updateContract: vi.fn(),
  addContractLineToContract: vi.fn(),
  removeContractLine: vi.fn(),
  activateContract: vi.fn(),
  pauseContract: vi.fn(),
  resumeContract: vi.fn(),
  generateDueInvoice: vi.fn(),
  computeContractEstimate: vi.fn(),
}));

// generate.ts uses these at module level
vi.mock('../../services/invoiceService', () => ({ issueInvoice: vi.fn() }));
vi.mock('../../services/invoicePdf', () => ({ sendInvoiceEmail: vi.fn() }));
vi.mock('../../services/sentry', () => ({ captureException: vi.fn() }));
vi.mock('../../db', () => ({
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
  withSystemDbAccessContext: vi.fn((fn: () => unknown) => fn()),
  // runBulkIsolated wraps each item in withDbAccessContext (passthrough here so
  // the loop runs without a real DB connection).
  withDbAccessContext: vi.fn((_ctx: unknown, fn: () => unknown) => fn()),
}));
vi.mock('../../services/contractTypes', () => ({
  ContractServiceError: class ContractServiceError extends Error {
    constructor(msg: string, public status = 400, public code?: string) { super(msg); }
  },
}));

const gate = vi.hoisted(() => ({ permGate: async (_c: any, next: any) => next() }));
vi.mock('../../middleware/auth', () => ({
  authMiddleware: async (c: any, next: any) => {
    c.set('auth', { user: { id: 'u1' }, partnerId: 'p1', orgId: null, scope: 'partner', accessibleOrgIds: null });
    await next();
  },
  requireScope: () => async (c: any, next: any) => gate.permGate(c, next),
  requirePermission: () => async (c: any, next: any) => gate.permGate(c, next),
  dbAccessContextFromAuth: () => ({ scope: 'partner', orgId: null, accessibleOrgIds: null }),
}));

// Per-item audits: assert the call, not the persistence path.
vi.mock('../../services/auditEvents', async (importActual) => ({
  ...(await importActual<typeof import('../../services/auditEvents')>()),
  writeRouteAudit: vi.fn(),
}));

import { contractRoutes } from './index';
import { writeRouteAudit } from '../../services/auditEvents';
import { deleteDraftContract, cancelContract } from '../../services/contractService';

const A = '11111111-1111-1111-1111-111111111111';
const ORG = '33333333-3333-3333-3333-333333333333';
function post(path: string, body: unknown) {
  return contractRoutes.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}

describe('contract bulk routes', () => {
  beforeEach(() => { vi.clearAllMocks(); gate.permGate = async (_c: any, next: any) => next(); });

  it('bulk-delete deletes each draft', async () => {
    (deleteDraftContract as any).mockResolvedValue({ id: A, orgId: ORG, name: 'MSA' });
    const res = await post('/bulk-delete', { ids: [A] });
    expect((await res.json()).data).toMatchObject({ succeeded: 1 });
    expect(deleteDraftContract).toHaveBeenCalledWith(A, expect.anything());
    expect(writeRouteAudit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      orgId: ORG, action: 'contract.delete', resourceType: 'contract', resourceId: A,
    }));
  });

  it('bulk-cancel cancels each contract', async () => {
    (cancelContract as any).mockResolvedValue({ id: A, orgId: ORG, name: 'MSA' });
    const res = await post('/bulk-cancel', { ids: [A] });
    expect((await res.json()).data).toMatchObject({ succeeded: 1 });
    expect(cancelContract).toHaveBeenCalledWith(A, expect.anything());
    expect(writeRouteAudit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      orgId: ORG, action: 'contract.cancel', resourceType: 'contract', resourceId: A,
    }));
  });
});
