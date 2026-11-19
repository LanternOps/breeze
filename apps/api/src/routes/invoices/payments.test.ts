import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the service layer — the route is thin; we assert it writes a durable audit
// entry for each money-path mutation with the right action/resource/details.
vi.mock('../../services/invoiceService', () => ({
  recordPayment: vi.fn(),
  listPayments: vi.fn(),
  voidPayment: vi.fn()
}));

// The audit writer is the durable chain; assert the route calls it (separate from
// the intentionally-unconsumed emitInvoiceEvent bus).
vi.mock('../../services/auditEvents', () => ({
  writeRouteAudit: vi.fn()
}));

vi.mock('../../services/invoiceTypes', () => ({
  InvoiceServiceError: class InvoiceServiceError extends Error {
    constructor(msg: string, public status = 400, public code?: string) { super(msg); }
  }
}));

vi.mock('../../middleware/auth', () => ({
  authMiddleware: async (c: any, next: any) => {
    c.set('auth', { user: { id: 'u1' }, partnerId: 'p1', orgId: null, scope: 'partner', accessibleOrgIds: null });
    await next();
  },
  requireScope: () => async (_c: any, next: any) => next(),
  requirePermission: () => async (_c: any, next: any) => next()
}));

import { Hono } from 'hono';
import { invoicePaymentRoutes } from './payments';
import * as svc from '../../services/invoiceService';
import { writeRouteAudit } from '../../services/auditEvents';
import { InvoiceServiceError } from '../../services/invoiceTypes';

const INV_ID = '11111111-1111-1111-1111-111111111111';
const ORG_ID = '22222222-2222-2222-2222-222222222222';
const PAY_ID = '33333333-3333-3333-3333-333333333333';

// payments.ts assumes the auth middleware already ran; mount under a wrapper that
// injects the auth context (mirrors how invoiceRoutes applies it internally).
function app() {
  const a = new Hono();
  a.use('*', async (c, next) => {
    c.set('auth' as never, { user: { id: 'u1' }, partnerId: 'p1', orgId: null, scope: 'partner', accessibleOrgIds: null } as never);
    await next();
  });
  a.route('/', invoicePaymentRoutes);
  return a;
}

describe('invoice payment audit logging', () => {
  beforeEach(() => vi.clearAllMocks());

  it('POST /:id/payments writes invoice.payment.recorded to the audit chain', async () => {
    (svc.recordPayment as any).mockResolvedValue({
      invoice: { id: INV_ID, status: 'partial' },
      audit: {
        orgId: ORG_ID, paymentId: PAY_ID, invoiceId: INV_ID,
        amount: '40.00', method: 'card', reference: 'REF-1', recordedBy: 'u1'
      }
    });
    const res = await app().request(`/${INV_ID}/payments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ amount: 40, method: 'card', reference: 'REF-1', receivedAt: '2026-06-14' })
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    // Response shape is still the invoice — additive change, no behavior break.
    expect(body.data.id).toBe(INV_ID);
    expect(writeRouteAudit).toHaveBeenCalledTimes(1);
    expect(writeRouteAudit).toHaveBeenCalledWith(expect.anything(), {
      orgId: ORG_ID,
      action: 'invoice.payment.recorded',
      resourceType: 'invoice_payment',
      resourceId: PAY_ID,
      details: { amount: '40.00', method: 'card', reference: 'REF-1', invoiceId: INV_ID }
    });
  });

  it('DELETE /:id/payments/:pid writes invoice.payment.voided with the pre-delete financial details', async () => {
    (svc.voidPayment as any).mockResolvedValue({
      invoice: { id: INV_ID, status: 'sent' },
      audit: {
        orgId: ORG_ID, paymentId: PAY_ID, invoiceId: INV_ID,
        amount: '40.00', method: 'card', reference: 'REF-1', recordedBy: 'u9'
      }
    });
    const res = await app().request(`/${INV_ID}/payments/${PAY_ID}`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.id).toBe(INV_ID);
    expect(body.providerRecordUntouched).toBe(false);
    expect(body).not.toHaveProperty('quickbooksRecordUntouched');
    expect(writeRouteAudit).toHaveBeenCalledTimes(1);
    expect(writeRouteAudit).toHaveBeenCalledWith(expect.anything(), {
      orgId: ORG_ID,
      action: 'invoice.payment.voided',
      resourceType: 'invoice_payment',
      resourceId: PAY_ID,
      // The destroyed row's amount/method/recordedBy must survive in the chain.
      details: { amount: '40.00', method: 'card', reference: 'REF-1', invoiceId: INV_ID, recordedBy: 'u9' }
    });
  });

  it('DELETE /:id/payments/:pid carries the untouched-QuickBooks flag into the audit details', async () => {
    // A QuickBooks-origin void Breeze was allowed to take because no CDC sweep
    // would re-import it. The QuickBooks Payment is still standing, and a reader
    // of this event must not have to infer that (review wave 3, finding D2).
    (svc.voidPayment as any).mockResolvedValue({
      invoice: { id: INV_ID, status: 'sent' },
      audit: {
        orgId: ORG_ID, paymentId: PAY_ID, invoiceId: INV_ID,
        amount: '40.00', method: 'card', reference: 'REF-1', recordedBy: 'u9',
        providerRecordUntouched: true, untouchedReason: 'pull_disabled',
      }
    });

    const res = await app().request(`/${INV_ID}/payments/${PAY_ID}`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ data: { id: INV_ID }, providerRecordUntouched: true });
    expect(body).not.toHaveProperty('quickbooksRecordUntouched');

    expect(writeRouteAudit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: 'invoice.payment.voided',
      details: expect.objectContaining({
        quickbooksRecordUntouched: true,
        untouchedReason: 'pull_disabled',
      }),
    }));
  });

  describe('idempotency key (#3803)', () => {
    const recorded = {
      invoice: { id: INV_ID, status: 'partial' },
      audit: { orgId: ORG_ID, paymentId: PAY_ID, invoiceId: INV_ID, amount: '40.00', method: 'check', reference: null, recordedBy: 'u1' },
      replayed: false,
    };
    const post = (body: Record<string, unknown>, headers: Record<string, string> = {}) =>
      app().request(`/${INV_ID}/payments`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify({ amount: 40, method: 'check', receivedAt: '2026-06-14', ...body }),
      });
    const keyPassed = () => (svc.recordPayment as any).mock.calls[0][1].idempotencyKey;

    it('passes the Idempotency-Key header to the service', async () => {
      (svc.recordPayment as any).mockResolvedValue(recorded);
      const res = await post({}, { 'Idempotency-Key': 'hdr-key-1' });
      expect(res.status).toBe(200);
      expect(keyPassed()).toBe('hdr-key-1');
    });

    it('passes a body idempotencyKey to the service', async () => {
      (svc.recordPayment as any).mockResolvedValue(recorded);
      const res = await post({ idempotencyKey: 'body-key-1' });
      expect(res.status).toBe(200);
      expect(keyPassed()).toBe('body-key-1');
    });

    it('accepts a header and body key that agree', async () => {
      (svc.recordPayment as any).mockResolvedValue(recorded);
      const res = await post({ idempotencyKey: 'same-key' }, { 'Idempotency-Key': 'same-key' });
      expect(res.status).toBe(200);
      expect(keyPassed()).toBe('same-key');
    });

    it('refuses a header and body key that disagree, before the service runs', async () => {
      const res = await post({ idempotencyKey: 'body-key' }, { 'Idempotency-Key': 'header-key' });
      expect(res.status).toBe(400);
      expect((await res.json()).code).toBe('IDEMPOTENCY_KEY_MISMATCH');
      expect(svc.recordPayment).not.toHaveBeenCalled();
    });

    it('refuses a malformed Idempotency-Key header, before the service runs', async () => {
      const res = await post({}, { 'Idempotency-Key': 'has space' });
      expect(res.status).toBe(400);
      expect((await res.json()).code).toBe('INVALID_IDEMPOTENCY_KEY');
      expect(svc.recordPayment).not.toHaveBeenCalled();
    });

    it('sends no key when the caller sends none', async () => {
      (svc.recordPayment as any).mockResolvedValue(recorded);
      await post({});
      expect(keyPassed()).toBeUndefined();
    });

    it('a replay returns the invoice, marks the response, and writes no second audit entry', async () => {
      (svc.recordPayment as any).mockResolvedValue({ ...recorded, replayed: true });
      const res = await post({ idempotencyKey: 'replayed-key' });
      expect(res.status).toBe(200);
      expect(res.headers.get('Idempotent-Replayed')).toBe('true');
      expect((await res.json()).data.id).toBe(INV_ID);
      expect(writeRouteAudit).not.toHaveBeenCalled();
    });

    it('a first recording is not marked as a replay', async () => {
      (svc.recordPayment as any).mockResolvedValue(recorded);
      const res = await post({ idempotencyKey: 'fresh-key' });
      expect(res.headers.get('Idempotent-Replayed')).toBeNull();
      expect(writeRouteAudit).toHaveBeenCalledTimes(1);
    });
  });

  it('does not write an audit entry when the service throws', async () => {
    (svc.recordPayment as any).mockRejectedValue(new InvoiceServiceError('Payment exceeds balance', 409, 'OVERPAYMENT'));
    const res = await app().request(`/${INV_ID}/payments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ amount: 40, method: 'card', receivedAt: '2026-06-14' })
    });
    expect(res.status).toBe(409);
    expect(writeRouteAudit).not.toHaveBeenCalled();
  });
});
