import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the service layer — routes are thin; we assert wiring, validation, error mapping.
vi.mock('../../services/contractService', () => ({
  createContract: vi.fn(),
  getContract: vi.fn(),
  listContracts: vi.fn(),
  updateContract: vi.fn(),
  deleteDraftContract: vi.fn(),
  addContractLineToContract: vi.fn(),
  removeContractLine: vi.fn(),
  activateContract: vi.fn(),
  pauseContract: vi.fn(),
  resumeContract: vi.fn(),
  cancelContract: vi.fn(),
  generateDueInvoice: vi.fn(),
  computeContractEstimate: vi.fn()
}));

// Mock db context helpers used by /generate route.
vi.mock('../../db', () => ({
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
  withSystemDbAccessContext: vi.fn((fn: () => unknown) => fn())
}));

// ContractServiceError lives in contractTypes; routes import the class from there.
vi.mock('../../services/contractTypes', () => ({
  ContractServiceError: class ContractServiceError extends Error {
    constructor(msg: string, public status = 400, public code?: string) { super(msg); }
  }
}));

// Mock auth middleware to inject a partner-scoped actor with contract perms.
vi.mock('../../middleware/auth', () => ({
  authMiddleware: async (c: any, next: any) => {
    c.set('auth', { user: { id: 'u1' }, partnerId: 'p1', orgId: null, scope: 'partner', accessibleOrgIds: null });
    await next();
  },
  requireScope: () => async (_c: any, next: any) => next(),
  requirePermission: () => async (_c: any, next: any) => next()
}));

import { contractRoutes } from './index';
import * as svc from '../../services/contractService';
import { ContractServiceError } from '../../services/contractTypes';

function app() {
  // contractRoutes already applies authMiddleware internally
  return contractRoutes;
}

const CONTRACT_ID = '11111111-1111-1111-1111-111111111111';
const ORG_ID = '22222222-2222-2222-2222-222222222222';
const LINE_ID = '33333333-3333-3333-3333-333333333333';

describe('contract crud routes', () => {
  beforeEach(() => vi.clearAllMocks());

  it('POST / creates a draft contract', async () => {
    (svc.createContract as any).mockResolvedValue({ id: CONTRACT_ID, status: 'draft' });
    const res = await app().request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        orgId: ORG_ID,
        name: 'Monthly Managed Services',
        billingTiming: 'advance',
        intervalMonths: 1,
        startDate: '2026-07-01'
      })
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.id).toBe(CONTRACT_ID);
    expect(body.data.status).toBe('draft');
    expect(svc.createContract).toHaveBeenCalledOnce();
  });

  it('POST / rejects an invalid body (missing required fields → 400, no service call)', async () => {
    const res = await app().request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ orgId: 'not-a-uuid' })
    });
    expect(res.status).toBe(400);
    expect(svc.createContract).not.toHaveBeenCalled();
  });

  it('GET / lists contracts', async () => {
    (svc.listContracts as any).mockResolvedValue([{ id: CONTRACT_ID }]);
    const res = await app().request('/', { method: 'GET' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(1);
    expect(svc.listContracts).toHaveBeenCalledOnce();
  });

  it('GET /:id fetches one contract', async () => {
    (svc.getContract as any).mockResolvedValue({ id: CONTRACT_ID, status: 'draft' });
    const res = await app().request(`/${CONTRACT_ID}`, { method: 'GET' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.id).toBe(CONTRACT_ID);
    expect(svc.getContract).toHaveBeenCalledWith(CONTRACT_ID, expect.anything());
  });

  it('PATCH /:id updates a contract', async () => {
    (svc.updateContract as any).mockResolvedValue({ id: CONTRACT_ID, name: 'Updated Name', status: 'draft' });
    const res = await app().request(`/${CONTRACT_ID}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Updated Name' })
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.name).toBe('Updated Name');
    expect(svc.updateContract).toHaveBeenCalledWith(CONTRACT_ID, { name: 'Updated Name' }, expect.anything());
  });

  it('PATCH /:id rejects an invalid body (bad intervalMonths → 400, no service call)', async () => {
    const res = await app().request(`/${CONTRACT_ID}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ intervalMonths: -5 })
    });
    expect(res.status).toBe(400);
    expect(svc.updateContract).not.toHaveBeenCalled();
  });

  it('DELETE /:id deletes a draft contract', async () => {
    (svc.deleteDraftContract as any).mockResolvedValue(undefined);
    const res = await app().request(`/${CONTRACT_ID}`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.ok).toBe(true);
    expect(svc.deleteDraftContract).toHaveBeenCalledWith(CONTRACT_ID, expect.anything());
  });

  it('maps a ContractServiceError to its status (CONTRACT_NOT_FOUND → 404)', async () => {
    (svc.getContract as any).mockRejectedValue(
      new ContractServiceError('Contract not found', 404, 'CONTRACT_NOT_FOUND')
    );
    const res = await app().request(`/${CONTRACT_ID}`, { method: 'GET' });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.code).toBe('CONTRACT_NOT_FOUND');
  });
});

describe('contract line routes', () => {
  beforeEach(() => vi.clearAllMocks());

  it('POST /:id/lines adds a contract line', async () => {
    (svc.addContractLineToContract as any).mockResolvedValue({ id: LINE_ID });
    const res = await app().request(`/${CONTRACT_ID}/lines`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        lineType: 'flat',
        description: 'Monthly fee',
        unitPrice: '150.00',
        taxable: true
      })
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.id).toBe(LINE_ID);
    expect(svc.addContractLineToContract).toHaveBeenCalledOnce();
  });

  it('POST /:id/lines rejects an invalid body (missing description → 400, no service call)', async () => {
    const res = await app().request(`/${CONTRACT_ID}/lines`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ lineType: 'flat', unitPrice: '100.00', taxable: false })
    });
    expect(res.status).toBe(400);
    expect(svc.addContractLineToContract).not.toHaveBeenCalled();
  });

  it('DELETE /:id/lines/:lineId removes a line', async () => {
    (svc.removeContractLine as any).mockResolvedValue({ ok: true });
    const res = await app().request(`/${CONTRACT_ID}/lines/${LINE_ID}`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(svc.removeContractLine).toHaveBeenCalledWith(CONTRACT_ID, LINE_ID, expect.anything());
  });
});

describe('contract lifecycle routes', () => {
  beforeEach(() => vi.clearAllMocks());

  it('POST /:id/activate activates a draft contract', async () => {
    (svc.activateContract as any).mockResolvedValue({ id: CONTRACT_ID, status: 'active' });
    const res = await app().request(`/${CONTRACT_ID}/activate`, { method: 'POST' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.status).toBe('active');
    expect(svc.activateContract).toHaveBeenCalledWith(CONTRACT_ID, expect.anything());
  });

  it('POST /:id/pause pauses an active contract', async () => {
    (svc.pauseContract as any).mockResolvedValue({ id: CONTRACT_ID, status: 'paused' });
    const res = await app().request(`/${CONTRACT_ID}/pause`, { method: 'POST' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.status).toBe('paused');
    expect(svc.pauseContract).toHaveBeenCalledWith(CONTRACT_ID, expect.anything());
  });

  it('POST /:id/resume resumes a paused contract', async () => {
    (svc.resumeContract as any).mockResolvedValue({ id: CONTRACT_ID, status: 'active' });
    const res = await app().request(`/${CONTRACT_ID}/resume`, { method: 'POST' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.status).toBe('active');
    expect(svc.resumeContract).toHaveBeenCalledWith(CONTRACT_ID, expect.anything());
  });

  it('POST /:id/cancel cancels a contract', async () => {
    (svc.cancelContract as any).mockResolvedValue({ id: CONTRACT_ID, status: 'cancelled' });
    const res = await app().request(`/${CONTRACT_ID}/cancel`, { method: 'POST' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.status).toBe('cancelled');
    expect(svc.cancelContract).toHaveBeenCalledWith(CONTRACT_ID, expect.anything());
  });

  it('maps a NOT_A_DRAFT ContractServiceError from activate to 409', async () => {
    (svc.activateContract as any).mockRejectedValue(
      new ContractServiceError('Contract is not a draft', 409, 'NOT_A_DRAFT')
    );
    const res = await app().request(`/${CONTRACT_ID}/activate`, { method: 'POST' });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe('NOT_A_DRAFT');
  });
});

describe('contract generate route', () => {
  beforeEach(() => vi.clearAllMocks());

  it('POST /:id/generate authorizes via getContract then runs generateDueInvoice', async () => {
    (svc.getContract as any).mockResolvedValue({ id: CONTRACT_ID, status: 'active' });
    (svc.generateDueInvoice as any).mockResolvedValue({ invoiceId: 'inv-1', periodStart: '2026-07-01', periodEnd: '2026-08-01' });
    const res = await app().request(`/${CONTRACT_ID}/generate`, { method: 'POST' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.invoiceId).toBe('inv-1');
    expect(svc.getContract).toHaveBeenCalledWith(CONTRACT_ID, expect.anything());
    expect(svc.generateDueInvoice).toHaveBeenCalledWith(CONTRACT_ID);
  });

  it('POST /:id/generate maps a CONTRACT_NOT_FOUND to 404 (authorize gate fires)', async () => {
    (svc.getContract as any).mockRejectedValue(
      new ContractServiceError('Contract not found', 404, 'CONTRACT_NOT_FOUND')
    );
    const res = await app().request(`/${CONTRACT_ID}/generate`, { method: 'POST' });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.code).toBe('CONTRACT_NOT_FOUND');
    // generateDueInvoice must NOT have been called — the auth gate fired first.
    expect(svc.generateDueInvoice).not.toHaveBeenCalled();
  });

  it('POST /:id/generate maps a NOTHING_DUE to 409', async () => {
    (svc.getContract as any).mockResolvedValue({ id: CONTRACT_ID, status: 'active' });
    (svc.generateDueInvoice as any).mockRejectedValue(
      new ContractServiceError('Nothing due yet', 409, 'NOTHING_DUE')
    );
    const res = await app().request(`/${CONTRACT_ID}/generate`, { method: 'POST' });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe('NOTHING_DUE');
  });

  it('GET /:id/estimate returns the resolved period estimate', async () => {
    (svc.computeContractEstimate as any).mockResolvedValue({
      currencyCode: 'USD', periodTotal: '450.00',
      lines: [{ lineId: LINE_ID, lineType: 'per_device', quantity: 9, value: '450.00', live: true }],
    });
    const res = await app().request(`/${CONTRACT_ID}/estimate`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: {
      currencyCode: 'USD', periodTotal: '450.00',
      lines: [{ lineId: LINE_ID, lineType: 'per_device', quantity: 9, value: '450.00', live: true }],
    } });
    expect(svc.computeContractEstimate).toHaveBeenCalledWith(CONTRACT_ID, expect.objectContaining({ partnerId: 'p1' }));
  });
});
