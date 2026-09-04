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
  updateContractLine: vi.fn(),
  contractLineAuditDetails: vi.fn((audit: any) => ({
    contractLineId: audit.contractLineId,
    lineType: audit.lineType,
    ...(audit.changedFields !== undefined ? { changedFields: audit.changedFields } : {}),
    ...(audit.oldUnitPrice !== undefined ? { oldUnitPrice: audit.oldUnitPrice } : {}),
    ...(audit.newUnitPrice !== undefined ? { newUnitPrice: audit.newUnitPrice } : {}),
  })),
  activateContract: vi.fn(),
  pauseContract: vi.fn(),
  resumeContract: vi.fn(),
  cancelContract: vi.fn(),
  generateDueInvoice: vi.fn(),
  computeContractEstimate: vi.fn(),
  changeContractCurrency: vi.fn()
}));

// #3205 W03: the three line routes now audit. Stub the durable audit chain so
// route tests assert the CALL, not the persistence path.
vi.mock('../../services/auditEvents', () => ({
  writeRouteAudit: vi.fn(),
}));

// Mock db context helpers used by /generate route.
vi.mock('../../db', () => ({
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
  withSystemDbAccessContext: vi.fn((fn: () => unknown) => fn())
}));

// ContractServiceError lives in contractTypes; routes import the class from there.
vi.mock('../../services/contractTypes', () => ({
  ContractServiceError: class ContractServiceError extends Error {
    constructor(
      msg: string, public status = 400, public code?: string,
      public details?: Record<string, unknown>
    ) { super(msg); }
  },
  // actorCan is re-exported from contractTypes and used by the service, not the
  // route — but the module is mocked wholesale, so it must still be present.
  actorCan: (a: { permissions?: ReadonlySet<string> }, p: { resource: string; action: string }) =>
    a.permissions?.has(`${p.resource}:${p.action}`) === true,
}));

// Mock auth middleware to inject a partner-scoped actor with contract perms.
// Grants the request's resolved permissions carry. Mutated per-test so the
// wave-6 (#3778) permission-evidence plumbing can be exercised end-to-end.
const grantedPermissions: Array<{ resource: string; action: string }> = [
  { resource: 'contracts', action: 'read' },
  { resource: 'contracts', action: 'write' },
  { resource: 'contracts', action: 'manage' },
];

vi.mock('../../middleware/auth', () => ({
  authMiddleware: async (c: any, next: any) => {
    c.set('auth', { user: { id: 'u1' }, partnerId: 'p1', orgId: null, scope: 'partner', accessibleOrgIds: null });
    // What requirePermission sets on a real request.
    c.set('permissions', { permissions: grantedPermissions, partnerId: 'p1', orgId: null, roleId: 'r1', scope: 'partner' });
    await next();
  },
  requireScope: () => async (_c: any, next: any) => next(),
  requirePermission: () => async (_c: any, next: any) => next()
}));

import { contractRoutes } from './index';
import * as svc from '../../services/contractService';
import { ContractServiceError } from '../../services/contractTypes';
import { writeRouteAudit } from '../../services/auditEvents';
import { contractLineRoutes } from './lines';

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

  it('POST /:id/lines accepts a per_device_role line and forwards deviceRoles (#3205)', async () => {
    (svc.addContractLineToContract as any).mockResolvedValue({ id: LINE_ID });
    const res = await app().request(`/${CONTRACT_ID}/lines`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ lineType: 'per_device_role', description: 'Network gear', unitPrice: '25.00', taxable: true, deviceRoles: ['switch', 'router'] })
    });
    expect(res.status).toBe(200);
    expect((svc.addContractLineToContract as any).mock.calls[0][1]).toMatchObject({ lineType: 'per_device_role', deviceRoles: ['switch', 'router'] });
  });

  it('POST /:id/lines accepts a valid allowance line and 400s on each violation (#3205 W04)', async () => {
    (svc.addContractLineToContract as any).mockResolvedValue({ id: LINE_ID });
    const post = (body: unknown) => app().request(`/${CONTRACT_ID}/lines`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    const ok = {
      lineType: 'per_device', description: 'Endpoints', unitPrice: '10.00', taxable: true,
      includedQuantity: '25', overageMode: 'bill', overageUnitPrice: '12.00',
    };
    expect((await post(ok)).status).toBe(200);
    for (const bad of [
      { ...ok, overageMode: undefined, overageUnitPrice: undefined },
      { ...ok, includedQuantity: undefined },
      { ...ok, includedQuantity: '0' },
      { ...ok, includedQuantity: '25.5' },
      { ...ok, overageMode: 'flag' },
      { ...ok, lineType: 'flat' },
    ]) {
      expect((await post(bad)).status).toBe(400);
    }
    expect(svc.addContractLineToContract).toHaveBeenCalledTimes(1);
  });

  it('POST /:id/lines rejects a per_device_role line without deviceRoles (400, no service call)', async () => {
    const res = await app().request(`/${CONTRACT_ID}/lines`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ lineType: 'per_device_role', description: 'Network gear', unitPrice: '25.00', taxable: true })
    });
    expect(res.status).toBe(400);
    expect(svc.addContractLineToContract).not.toHaveBeenCalled();
  });

  it('PATCH /:id/lines/:lineId forwards (contractId, lineId, patch, actor) and returns the line', async () => {
    (svc.updateContractLine as any).mockResolvedValue({
      line: { id: LINE_ID, description: 'Renamed', site: null, deviceGroup: null },
      audit: { orgId: ORG_ID, contractId: CONTRACT_ID, contractName: 'Acme MSA', contractLineId: LINE_ID, lineType: 'flat', changedFields: ['description'] },
    });
    const res = await app().request(`/${CONTRACT_ID}/lines/${LINE_ID}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ description: 'Renamed' }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).data.description).toBe('Renamed');
    expect(svc.updateContractLine).toHaveBeenCalledWith(CONTRACT_ID, LINE_ID, { description: 'Renamed' }, expect.anything());
  });

  it('PATCH rejects a body containing lineType, with no service call', async () => {
    const res = await app().request(`/${CONTRACT_ID}/lines/${LINE_ID}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ description: 'Renamed', lineType: 'flat' }),
    });
    expect(res.status).toBe(400);
    expect(svc.updateContractLine).not.toHaveBeenCalled();
  });

  it('PATCH rejects a non-GUID lineId param, with no service call', async () => {
    const res = await app().request(`/${CONTRACT_ID}/lines/not-a-guid`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ description: 'Renamed' }),
    });
    expect(res.status).toBe(400);
    expect(svc.updateContractLine).not.toHaveBeenCalled();
  });

  it('PATCH renders a ContractServiceError with code and details intact', async () => {
    (svc.updateContractLine as any).mockRejectedValue(
      new ContractServiceError('bad patch', 400, 'INVALID_LINE_PATCH', { issues: [{ path: 'siteId', message: 'nope' }] }),
    );
    const res = await app().request(`/${CONTRACT_ID}/lines/${LINE_ID}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ siteId: null }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'bad patch', code: 'INVALID_LINE_PATCH', details: { issues: [{ path: 'siteId', message: 'nope' }] } });
  });

  it('PATCH maps a 409 INVALID_STATE through handleContractError', async () => {
    (svc.updateContractLine as any).mockRejectedValue(new ContractServiceError('not editable', 409, 'INVALID_STATE'));
    const res = await app().request(`/${CONTRACT_ID}/lines/${LINE_ID}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ description: 'x' }),
    });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('INVALID_STATE');
  });

  // ---- audit -------------------------------------------------------------
  it('writes contract.line.updated once, against the CONTRACT id', async () => {
    (svc.updateContractLine as any).mockResolvedValue({
      line: { id: LINE_ID },
      audit: { orgId: ORG_ID, contractId: CONTRACT_ID, contractName: 'Acme MSA', contractLineId: LINE_ID, lineType: 'flat', changedFields: ['unitPrice'], oldUnitPrice: '10.00', newUnitPrice: '12.00' },
    });
    await app().request(`/${CONTRACT_ID}/lines/${LINE_ID}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ unitPrice: '12.00' }),
    });
    expect(writeRouteAudit).toHaveBeenCalledTimes(1);
    expect((writeRouteAudit as any).mock.calls[0][1]).toEqual({
      orgId: ORG_ID, action: 'contract.line.updated', resourceType: 'contract',
      resourceId: CONTRACT_ID, resourceName: 'Acme MSA',
      details: { contractLineId: LINE_ID, lineType: 'flat', changedFields: ['unitPrice'], oldUnitPrice: '10.00', newUnitPrice: '12.00' },
    });
  });

  it('writes NO audit event when the service reports changedFields: []', async () => {
    (svc.updateContractLine as any).mockResolvedValue({
      line: { id: LINE_ID },
      audit: { orgId: ORG_ID, contractId: CONTRACT_ID, contractName: 'Acme MSA', contractLineId: LINE_ID, lineType: 'flat', changedFields: [] },
    });
    const res = await app().request(`/${CONTRACT_ID}/lines/${LINE_ID}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ description: 'same' }),
    });
    expect(res.status).toBe(200);
    expect(writeRouteAudit).not.toHaveBeenCalled();
  });

  it('POST writes contract.line.added with the new price', async () => {
    (svc.addContractLineToContract as any).mockResolvedValue({
      id: LINE_ID, orgId: ORG_ID, lineType: 'flat', unitPrice: '150.00', contractName: 'Acme MSA',
    });
    await app().request(`/${CONTRACT_ID}/lines`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ lineType: 'flat', description: 'Monthly fee', unitPrice: '150.00', taxable: true }),
    });
    expect((writeRouteAudit as any).mock.calls[0][1]).toMatchObject({
      action: 'contract.line.added', resourceType: 'contract', resourceId: CONTRACT_ID,
      resourceName: 'Acme MSA',
      details: { contractLineId: LINE_ID, lineType: 'flat', newUnitPrice: '150.00' },
    });
  });

  it('DELETE returns { ok: true } and writes contract.line.removed', async () => {
    (svc.removeContractLine as any).mockResolvedValue({
      orgId: ORG_ID, contractId: CONTRACT_ID, contractName: 'Acme MSA', contractLineId: LINE_ID, lineType: 'per_seat',
    });
    const res = await app().request(`/${CONTRACT_ID}/lines/${LINE_ID}`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { ok: true } });
    expect(svc.removeContractLine).toHaveBeenCalledWith(CONTRACT_ID, LINE_ID, expect.anything());
    expect((writeRouteAudit as any).mock.calls[0][1]).toMatchObject({
      action: 'contract.line.removed', details: { contractLineId: LINE_ID, lineType: 'per_seat' },
    });
  });

  it('DELETE returns 404 when the service throws LINE_NOT_FOUND', async () => {
    (svc.removeContractLine as any).mockRejectedValue(new ContractServiceError('Contract line not found', 404, 'LINE_NOT_FOUND'));
    const res = await app().request(`/${CONTRACT_ID}/lines/${LINE_ID}`, { method: 'DELETE' });
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe('LINE_NOT_FOUND');
    expect(writeRouteAudit).not.toHaveBeenCalled();
  });

  // The suite stubs requirePermission, so a real 403 cannot be asserted here.
  // What CAN be pinned is that PATCH is registered behind the same middleware
  // chain as its siblings — scopes, writePerm, param validator (+ the json
  // validator PATCH alone carries) — so it cannot ship unguarded.
  it('PATCH is registered behind the same scope and permission middleware as DELETE, plus a body validator', () => {
    const onPath = contractLineRoutes.routes.filter((r) => r.path === '/:id/lines/:lineId');
    const patch = onPath.filter((r) => r.method === 'PATCH');
    const del = onPath.filter((r) => r.method === 'DELETE');
    expect(del.length).toBeGreaterThan(0);
    expect(patch).toHaveLength(del.length + 1);
  });

  // Decision 6's no-free-text rule, enforced at the boundary that persists it.
  it.each([
    ['contract.line.added'],
    ['contract.line.updated'],
    ['contract.line.removed'],
  ])('the %s details object carries no free text', async (action) => {
    const AUDIT = { orgId: ORG_ID, contractId: CONTRACT_ID, contractName: 'Acme MSA', contractLineId: LINE_ID, lineType: 'flat' };
    if (action === 'contract.line.added') {
      (svc.addContractLineToContract as any).mockResolvedValue({ id: LINE_ID, orgId: ORG_ID, lineType: 'flat', unitPrice: '1.00' });
      await app().request(`/${CONTRACT_ID}/lines`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ lineType: 'flat', description: 'Secret name', unitPrice: '1.00', taxable: false }),
      });
    } else if (action === 'contract.line.updated') {
      (svc.updateContractLine as any).mockResolvedValue({ line: { id: LINE_ID }, audit: { ...AUDIT, changedFields: ['description'] } });
      await app().request(`/${CONTRACT_ID}/lines/${LINE_ID}`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ description: 'Secret name' }),
      });
    } else {
      (svc.removeContractLine as any).mockResolvedValue(AUDIT);
      await app().request(`/${CONTRACT_ID}/lines/${LINE_ID}`, { method: 'DELETE' });
    }
    const details = (writeRouteAudit as any).mock.calls[0][1].details as Record<string, unknown>;
    const allowed = ['contractLineId', 'lineType', 'changedFields', 'oldUnitPrice', 'newUnitPrice'];
    expect(Object.keys(details).every((k) => allowed.includes(k))).toBe(true);
    expect(JSON.stringify(details)).not.toContain('Secret name');
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

  it('POST /:id/generate returns overages verbatim (#3205 W04)', async () => {
    (svc.getContract as any).mockResolvedValue({ id: CONTRACT_ID, status: 'active' });
    const overages = [{ contractLineId: LINE_ID, invoiceLineId: 'invoice-line-overage-1', description: 'Endpoints', counted: 30, included: 25, overage: 5, mode: 'bill' }];
    const generated = {
      generated: true, invoiceId: 'inv-1', autoIssue: false, priceBookGaps: [], uncoveredDevices: null, overages,
    };
    (svc.generateDueInvoice as any).mockResolvedValue(generated);
    const res = await app().request(`/${CONTRACT_ID}/generate`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: {
      generated: true,
      invoiceId: 'inv-1',
      autoIssue: false,
      priceBookGaps: [],
      uncoveredDevices: null,
      overages: [{
        contractLineId: LINE_ID,
        invoiceLineId: 'invoice-line-overage-1',
        description: 'Endpoints',
        counted: 30,
        included: 25,
        overage: 5,
        mode: 'bill',
      }],
    } });
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

  it('GET /:id/estimate returns the allowance fields and overages verbatim (#3205 W04)', async () => {
    const estimate = {
      currencyCode: 'USD', periodTotal: '250.00',
      lines: [{
        lineId: LINE_ID, lineType: 'per_device', quantity: 25, value: '250.00', live: true,
        counted: 26, included: 25, overage: 1, overageMode: 'flag', overageValue: '0.00',
      }],
      uncoveredDevices: null,
      overages: [{ contractLineId: LINE_ID, invoiceLineId: null, description: 'Endpoints', counted: 26, included: 25, overage: 1, mode: 'flag' }],
    };
    (svc.computeContractEstimate as any).mockResolvedValue(estimate);
    const res = await app().request(`/${CONTRACT_ID}/estimate`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: {
      currencyCode: 'USD',
      periodTotal: '250.00',
      lines: [{
        lineId: LINE_ID,
        lineType: 'per_device',
        quantity: 25,
        value: '250.00',
        live: true,
        counted: 26,
        included: 25,
        overage: 1,
        overageMode: 'flag',
        overageValue: '0.00',
      }],
      uncoveredDevices: null,
      overages: [{
        contractLineId: LINE_ID,
        invoiceLineId: null,
        description: 'Endpoints',
        counted: 26,
        included: 25,
        overage: 1,
        mode: 'flag',
      }],
    } });
  });
});

// ---------------------------------------------------------------------------
// Wave 6 (#3778): the currency route carries VERIFIED permission evidence into
// the service, and surfaces the structured `details` the service attaches.
// ---------------------------------------------------------------------------
describe('POST /:id/currency — permission evidence + error details (#3778)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    grantedPermissions.length = 0;
    grantedPermissions.push(
      { resource: 'contracts', action: 'read' },
      { resource: 'contracts', action: 'write' },
      { resource: 'contracts', action: 'manage' },
    );
  });

  async function post(body: unknown) {
    return app().request(`/${CONTRACT_ID}/currency`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
  }

  it('forwards confirmActiveChange and an actor carrying contracts:manage', async () => {
    (svc.changeContractCurrency as any).mockResolvedValue({ id: CONTRACT_ID, currencyCode: 'EUR' });
    const res = await post({ currencyCode: 'EUR', confirmActiveChange: true });
    expect(res.status).toBe(200);

    const [, input, actor] = (svc.changeContractCurrency as any).mock.calls[0];
    expect(input).toMatchObject({ currencyCode: 'EUR', confirmActiveChange: true });
    expect([...actor.permissions]).toContain('contracts:manage');
  });

  it('a contracts:write-only request reaches the service WITHOUT manage evidence, and its 403 maps through', async () => {
    grantedPermissions.length = 0;
    grantedPermissions.push({ resource: 'contracts', action: 'read' }, { resource: 'contracts', action: 'write' });
    (svc.changeContractCurrency as any).mockRejectedValue(
      new ContractServiceError('needs manage', 403, 'ACTIVE_CHANGE_FORBIDDEN'));

    const res = await post({ currencyCode: 'EUR', confirmActiveChange: true });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'ACTIVE_CHANGE_FORBIDDEN' });

    const actor = (svc.changeContractCurrency as any).mock.calls[0][2];
    expect([...actor.permissions]).not.toContain('contracts:manage');
  });

  it('returns the structured details naming the blocking rows', async () => {
    (svc.changeContractCurrency as any).mockRejectedValue(
      new ContractServiceError('2 draft invoice(s)', 409, 'UNBILLED_MONETARY_ROWS', { draftInvoiceIds: ['a', 'b'] }));

    const res = await post({ currencyCode: 'EUR', confirmActiveChange: true });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      code: 'UNBILLED_MONETARY_ROWS', details: { draftInvoiceIds: ['a', 'b'] },
    });
  });

  it('rejects a mis-keyed field (strict schema) with a 400', async () => {
    const res = await post({ currencyCode: 'EUR', convert: true });
    expect(res.status).toBe(400);
    expect(svc.changeContractCurrency).not.toHaveBeenCalled();
  });
});
