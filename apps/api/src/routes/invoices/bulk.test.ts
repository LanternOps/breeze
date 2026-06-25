import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../services/invoiceService', () => ({
  deleteDraftInvoice: vi.fn(), issueInvoice: vi.fn(), voidInvoice: vi.fn(),
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

import { invoiceRoutes } from './index';
import { deleteDraftInvoice, issueInvoice, voidInvoice } from '../../services/invoiceService';

const A = '11111111-1111-1111-1111-111111111111';
const B = '22222222-2222-2222-2222-222222222222';
function post(path: string, body: unknown) {
  return invoiceRoutes.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}

describe('invoice bulk routes', () => {
  beforeEach(() => { vi.clearAllMocks(); gate.permGate = async (_c: any, next: any) => next(); });

  it('bulk-delete deletes each draft', async () => {
    (deleteDraftInvoice as any).mockResolvedValue(undefined);
    const res = await post('/bulk-delete', { ids: [A, B] });
    expect((await res.json()).data).toMatchObject({ succeeded: 2 });
    expect(deleteDraftInvoice).toHaveBeenCalledTimes(2);
  });

  it('bulk-issue issues each invoice', async () => {
    (issueInvoice as any).mockResolvedValue({});
    const res = await post('/bulk-issue', { ids: [A] });
    expect((await res.json()).data).toMatchObject({ succeeded: 1 });
    expect(issueInvoice).toHaveBeenCalledWith(A, expect.anything());
  });

  it('bulk-void requires a reason and passes reissue:false', async () => {
    (voidInvoice as any).mockResolvedValue({});
    const noReason = await post('/bulk-void', { ids: [A] });
    expect(noReason.status).toBe(400);

    const ok = await post('/bulk-void', { ids: [A], reason: 'duplicate' });
    expect(ok.status).toBe(200);
    expect(voidInvoice).toHaveBeenCalledWith(A, 'duplicate', { reissue: false }, expect.anything());
  });
});
