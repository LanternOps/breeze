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
}));

import { contractRoutes } from './index';
import { deleteDraftContract, cancelContract } from '../../services/contractService';

const A = '11111111-1111-1111-1111-111111111111';
function post(path: string, body: unknown) {
  return contractRoutes.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}

describe('contract bulk routes', () => {
  beforeEach(() => { vi.clearAllMocks(); gate.permGate = async (_c: any, next: any) => next(); });

  it('bulk-delete deletes each draft', async () => {
    (deleteDraftContract as any).mockResolvedValue(undefined);
    const res = await post('/bulk-delete', { ids: [A] });
    expect((await res.json()).data).toMatchObject({ succeeded: 1 });
    expect(deleteDraftContract).toHaveBeenCalledWith(A, expect.anything());
  });

  it('bulk-cancel cancels each contract', async () => {
    (cancelContract as any).mockResolvedValue({});
    const res = await post('/bulk-cancel', { ids: [A] });
    expect((await res.json()).data).toMatchObject({ succeeded: 1 });
    expect(cancelContract).toHaveBeenCalledWith(A, expect.anything());
  });
});
