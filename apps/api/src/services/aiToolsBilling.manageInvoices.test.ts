import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./invoiceService', () => ({
  listInvoices: vi.fn().mockResolvedValue([]),
  getInvoice: vi.fn().mockResolvedValue({ invoice: { id: 'inv-1' }, lines: [] }),
  createManualInvoice: vi.fn().mockResolvedValue({ id: 'inv-1', status: 'draft' }),
  addManualLine: vi.fn().mockResolvedValue({ id: 'line-1' }),
  addCatalogLine: vi.fn().mockResolvedValue({ id: 'line-1' }),
  addBundleLine: vi.fn().mockResolvedValue({ id: 'line-1' }),
  addContractLine: vi.fn().mockResolvedValue({ id: 'line-1' }),
  updateLine: vi.fn().mockResolvedValue({ id: 'inv-1', status: 'draft' }),
  removeLine: vi.fn().mockResolvedValue({ id: 'inv-1', status: 'draft' }),
  updateInvoice: vi.fn().mockResolvedValue({ id: 'inv-1', status: 'draft' }),
  deleteDraftInvoice: vi.fn().mockResolvedValue(undefined),
  assembleDraftFromOrg: vi.fn().mockResolvedValue({ invoice: { id: 'inv-1' }, lines: [] }),
  assembleDraftFromTicket: vi.fn().mockResolvedValue({ invoice: { id: 'inv-1' }, lines: [] }),
  issueInvoice: vi.fn().mockResolvedValue({ id: 'inv-1', status: 'sent', invoiceNumber: 'INV-100' }),
  recordPayment: vi.fn().mockResolvedValue({ invoice: { id: 'inv-1', status: 'paid' } }),
  voidPayment: vi.fn().mockResolvedValue({ invoice: { id: 'inv-1', status: 'sent' } }),
  voidInvoice: vi.fn().mockResolvedValue({ invoice: { id: 'inv-1', status: 'void' }, lines: [] }),
}));

vi.mock('./invoiceCheckout', () => ({
  createInvoicePayLink: vi.fn().mockResolvedValue({ url: 'https://pay.example.test/inv-1' }),
}));

import { registerBillingTools } from './aiToolsBilling';
import * as invoiceService from './invoiceService';
import type { AiTool } from './aiTools';
import { InvoiceServiceError } from './invoiceTypes';

const auth = {
  user: { id: 'u-1' },
  partnerId: 'p-1',
  accessibleOrgIds: ['org-1'],
} as any;

const actor = { userId: 'u-1', partnerId: 'p-1', accessibleOrgIds: ['org-1'] };

function getTool(): AiTool {
  const map = new Map<string, AiTool>();
  registerBillingTools(map);
  const t = map.get('manage_invoices');
  if (!t) throw new Error('manage_invoices not registered');
  return t;
}

describe('manage_invoices', () => {
  beforeEach(() => vi.clearAllMocks());

  it('create_draft calls createManualInvoice with an actor built from auth', async () => {
    const out = await getTool().handler({ action: 'create_draft', orgId: 'org-1' }, auth);

    expect(invoiceService.createManualInvoice).toHaveBeenCalledWith(
      { orgId: 'org-1', siteId: undefined, notes: undefined, termsAndConditions: undefined },
      { userId: 'u-1', partnerId: 'p-1', accessibleOrgIds: ['org-1'] },
    );
    expect(JSON.parse(out)).toMatchObject({ id: 'inv-1', status: 'draft' });
  });

  it('add_contract_line maps contractId to sourceId and calls addContractLine with actor', async () => {
    const out = await getTool().handler(
      {
        action: 'add_contract_line',
        invoiceId: 'inv-1',
        contractId: 'c-1',
        line: {
          description: 'Managed endpoint coverage',
          quantity: 3,
          unitPrice: 12.5,
          taxable: true,
        },
      },
      auth,
    );

    expect(invoiceService.addContractLine).toHaveBeenCalledWith(
      'inv-1',
      {
        description: 'Managed endpoint coverage',
        quantity: '3',
        unitPrice: '12.5',
        taxable: true,
        catalogItemId: null,
        sourceId: 'c-1',
      },
      actor,
    );
    expect(JSON.parse(out)).toEqual({ id: 'line-1' });
  });

  it('issue calls issueInvoice', async () => {
    await getTool().handler({ action: 'issue', invoiceId: 'inv-1' }, auth);

    expect(invoiceService.issueInvoice).toHaveBeenCalledWith(
      'inv-1',
      expect.objectContaining({ userId: 'u-1' }),
    );
  });

  it('record_payment calls recordPayment with the payment payload and actor', async () => {
    const payment = {
      amount: 125,
      method: 'card',
      reference: 'ch_123',
      receivedAt: '2026-07-01T10:00:00.000Z',
    };

    const out = await getTool().handler(
      { action: 'record_payment', invoiceId: 'inv-1', payment },
      auth,
    );

    expect(invoiceService.recordPayment).toHaveBeenCalledWith('inv-1', payment, actor);
    expect(JSON.parse(out)).toEqual({ invoice: { id: 'inv-1', status: 'paid' } });
  });

  it('void calls voidInvoice with positional args, reissue option, and actor', async () => {
    const out = await getTool().handler(
      { action: 'void', invoiceId: 'inv-1', reason: 'Customer cancellation', reissue: true },
      auth,
    );

    expect(invoiceService.voidInvoice).toHaveBeenCalledWith(
      'inv-1',
      'Customer cancellation',
      { reissue: true },
      actor,
    );
    expect(JSON.parse(out)).toEqual({ invoice: { id: 'inv-1', status: 'void' }, lines: [] });
  });

  it('void_payment calls voidPayment with paymentId and actor', async () => {
    const out = await getTool().handler({ action: 'void_payment', paymentId: 'pay-1' }, auth);

    expect(invoiceService.voidPayment).toHaveBeenCalledWith('pay-1', actor);
    expect(JSON.parse(out)).toEqual({ invoice: { id: 'inv-1', status: 'sent' } });
  });

  it('returns a JSON error when a service action rejects with InvoiceServiceError', async () => {
    vi.mocked(invoiceService.recordPayment).mockRejectedValueOnce(
      new InvoiceServiceError('Payment exceeds balance', 400, 'OVERPAYMENT'),
    );

    const out = await getTool().handler(
      { action: 'record_payment', invoiceId: 'inv-1', payment: { amount: 999 } },
      auth,
    );

    expect(JSON.parse(out)).toEqual({ error: 'Payment exceeds balance', code: 'OVERPAYMENT' });
  });

  it('re-throws non-service errors from service actions', async () => {
    const err = new Error('database unavailable');
    vi.mocked(invoiceService.voidPayment).mockRejectedValueOnce(err);

    await expect(
      getTool().handler({ action: 'void_payment', paymentId: 'pay-1' }, auth),
    ).rejects.toBe(err);
  });

  it('unknown action returns a JSON error', async () => {
    const out = await getTool().handler({ action: 'nope' }, auth);

    expect(JSON.parse(out)).toHaveProperty('error');
  });
});
