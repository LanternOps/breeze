import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../services/invoiceService', () => ({
  deleteDraftInvoice: vi.fn(), issueInvoice: vi.fn(), voidInvoice: vi.fn(),
}));
vi.mock('../../services/billingEvidence', () => ({
  listInvoiceLineDevices: vi.fn(),
  INVOICE_LINE_DEVICES_DEFAULT_LIMIT: 100,
  INVOICE_LINE_DEVICES_MAX_LIMIT: 500,
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
// runBulkIsolated wraps each item in withDbAccessContext + runOutsideDbContext;
// stub both as passthroughs so the loop logic runs without a real DB connection.
vi.mock('../../db', () => ({
  withDbAccessContext: (_ctx: any, fn: any) => fn(),
  runOutsideDbContext: (fn: any) => fn(),
}));

// Per-item audits: assert the call, not the persistence path.
vi.mock('../../services/auditEvents', async (importActual) => ({
  ...(await importActual<typeof import('../../services/auditEvents')>()),
  writeRouteAudit: vi.fn(),
}));

import { invoiceRoutes } from './index';
import { writeRouteAudit } from '../../services/auditEvents';
import { deleteDraftInvoice, issueInvoice, voidInvoice } from '../../services/invoiceService';

const A = '11111111-1111-1111-1111-111111111111';
const B = '22222222-2222-2222-2222-222222222222';
const ORG = '33333333-3333-3333-3333-333333333333';
function post(path: string, body: unknown) {
  return invoiceRoutes.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}

describe('invoice bulk routes', () => {
  beforeEach(() => { vi.clearAllMocks(); gate.permGate = async (_c: any, next: any) => next(); });

  it('bulk-delete deletes each draft', async () => {
    (deleteDraftInvoice as any).mockImplementation(async (id: string) => ({ id, orgId: ORG }));
    const res = await post('/bulk-delete', { ids: [A, B] });
    expect((await res.json()).data).toMatchObject({ succeeded: 2 });
    expect(deleteDraftInvoice).toHaveBeenCalledTimes(2);
    expect(writeRouteAudit).toHaveBeenCalledTimes(2);
    for (const id of [A, B]) {
      expect(writeRouteAudit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
        orgId: ORG, action: 'invoice.delete', resourceType: 'invoice', resourceId: id,
      }));
    }
  });

  it('bulk-issue issues each invoice', async () => {
    (issueInvoice as any).mockResolvedValue({ id: A, orgId: ORG });
    const res = await post('/bulk-issue', { ids: [A] });
    expect((await res.json()).data).toMatchObject({ succeeded: 1 });
    expect(issueInvoice).toHaveBeenCalledWith(A, expect.anything());
    expect(writeRouteAudit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      orgId: ORG, action: 'invoice.issue', resourceType: 'invoice', resourceId: A,
    }));
  });

  it('bulk-void requires a reason and passes reissue:false', async () => {
    (voidInvoice as any).mockResolvedValue({ invoice: { id: A, orgId: ORG } });
    const noReason = await post('/bulk-void', { ids: [A] });
    expect(noReason.status).toBe(400);

    const ok = await post('/bulk-void', { ids: [A], reason: 'duplicate' });
    expect(ok.status).toBe(200);
    expect(voidInvoice).toHaveBeenCalledWith(A, 'duplicate', { reissue: false }, expect.anything());
    expect(writeRouteAudit).toHaveBeenCalledTimes(1);
    expect(writeRouteAudit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      orgId: ORG, action: 'invoice.void', resourceType: 'invoice', resourceId: A,
    }));
  });
});
