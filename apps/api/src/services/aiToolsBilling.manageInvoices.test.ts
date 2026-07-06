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

vi.mock('./contractService', () => ({
  getContract: vi.fn().mockResolvedValue({ contract: { id: 'contract-1' }, lines: [], periods: [] }),
  computeContractEstimate: vi.fn().mockResolvedValue({ lines: [] }),
}));

import { registerBillingTools } from './aiToolsBilling';
import * as invoiceService from './invoiceService';
import * as contractService from './contractService';
import type { AiTool } from './aiTools';
import { InvoiceServiceError } from './invoiceTypes';

const auth = {
  user: { id: 'u-1' },
  partnerId: 'p-1',
  accessibleOrgIds: ['org-1'],
} as any;

const actor = { userId: 'u-1', partnerId: 'p-1', accessibleOrgIds: ['org-1'] };
const now = new Date('2026-07-01T00:00:00.000Z');

function contractRow(id = 'contract-1'): Awaited<ReturnType<typeof contractService.getContract>>['contract'] {
  return {
    id,
    partnerId: 'p-1',
    orgId: 'org-1',
    name: 'Managed services',
    status: 'active',
    billingTiming: 'advance',
    intervalMonths: 1,
    startDate: '2026-07-01',
    endDate: null,
    nextBillingAt: null,
    autoIssue: false,
    autoRenew: false,
    renewalTermMonths: null,
    renewalNoticeDays: null,
    currencyCode: 'USD',
    notes: null,
    terms: null,
    createdBy: 'u-1',
    createdAt: now,
    updatedAt: now,
  };
}

function contractLineRow(
  patch: Partial<Awaited<ReturnType<typeof contractService.getContract>>['lines'][number]>
): Awaited<ReturnType<typeof contractService.getContract>>['lines'][number] {
  return {
    id: 'contract-line-1',
    contractId: 'contract-1',
    orgId: 'org-1',
    lineType: 'per_device',
    description: 'Managed endpoint coverage',
    catalogItemId: null,
    unitPrice: '12.50',
    manualQuantity: null,
    siteId: null,
    taxable: true,
    sortOrder: 0,
    createdAt: now,
    ...patch,
  };
}

function getTool(): AiTool {
  const map = new Map<string, AiTool>();
  registerBillingTools(map);
  const t = map.get('manage_invoices');
  if (!t) throw new Error('manage_invoices not registered');
  return t;
}

function getReadTool(name: 'get_invoice' | 'list_invoices'): AiTool {
  const map = new Map<string, AiTool>();
  registerBillingTools(map);
  const t = map.get(name);
  if (!t) throw new Error(`${name} not registered`);
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

  it('add_contract_line resolves authoritative contract line values before calling addContractLine', async () => {
    vi.mocked(contractService.getContract).mockResolvedValueOnce({
      contract: contractRow(),
      lines: [
        contractLineRow({
          id: 'contract-line-1',
          description: 'Managed endpoint coverage',
          unitPrice: '12.50',
          taxable: true,
          catalogItemId: 'catalog-1',
        }),
      ],
      periods: [],
    });
    vi.mocked(contractService.computeContractEstimate).mockResolvedValueOnce({
      currencyCode: 'USD',
      periodTotal: '37.50',
      lines: [{ lineId: 'contract-line-1', lineType: 'per_device', quantity: 3, value: '37.50', live: true }],
    });

    const out = await getTool().handler(
      {
        action: 'add_contract_line',
        invoiceId: 'inv-1',
        contractId: 'contract-1',
        contractLineId: 'contract-line-1',
        line: {
          description: 'AI supplied value must be ignored',
          quantity: 999,
          unitPrice: 1,
          taxable: false,
        },
      },
      auth,
    );

    expect(contractService.getContract).toHaveBeenCalledWith('contract-1', actor);
    expect(contractService.computeContractEstimate).toHaveBeenCalledWith('contract-1', actor);
    expect(invoiceService.addContractLine).toHaveBeenCalledWith(
      'inv-1',
      {
        description: 'Managed endpoint coverage',
        quantity: '3',
        unitPrice: '12.50',
        taxable: true,
        catalogItemId: 'catalog-1',
        sourceId: 'contract-line-1',
      },
      actor,
    );
    expect(JSON.parse(out)).toEqual({ id: 'line-1' });
  });

  it('add_contract_line returns an error when the contract line is not on the scoped contract', async () => {
    vi.mocked(contractService.getContract).mockResolvedValueOnce({
      contract: contractRow(),
      lines: [
        contractLineRow({
          id: 'contract-line-1',
          description: 'Managed endpoint coverage',
          unitPrice: '12.50',
          taxable: true,
          catalogItemId: null,
        }),
      ],
      periods: [],
    });

    const out = await getTool().handler(
      {
        action: 'add_contract_line',
        invoiceId: 'inv-1',
        contractId: 'contract-1',
        contractLineId: 'missing-line',
      },
      auth,
    );

    expect(JSON.parse(out)).toEqual({ error: 'Contract line not found for this contract' });
    expect(contractService.computeContractEstimate).not.toHaveBeenCalled();
    expect(invoiceService.addContractLine).not.toHaveBeenCalled();
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

describe('get_invoice / list_invoices deposit fields', () => {
  beforeEach(() => vi.clearAllMocks());

  it('get_invoice adds depositPaid=true when amountPaid covers depositDue', async () => {
    vi.mocked(invoiceService.getInvoice).mockResolvedValueOnce({
      invoice: { id: 'inv-1', depositDue: '100.00', amountPaid: '100.00' },
      lines: [],
      stripeConnected: false,
    } as any);

    const out = await getReadTool('get_invoice').handler({ invoiceId: 'inv-1' }, auth);

    expect(JSON.parse(out).invoice).toMatchObject({ depositDue: '100.00', depositPaid: true });
  });

  it('get_invoice adds depositPaid=false when amountPaid is short of depositDue', async () => {
    vi.mocked(invoiceService.getInvoice).mockResolvedValueOnce({
      invoice: { id: 'inv-1', depositDue: '100.00', amountPaid: '40.00' },
      lines: [],
      stripeConnected: false,
    } as any);

    const out = await getReadTool('get_invoice').handler({ invoiceId: 'inv-1' }, auth);

    expect(JSON.parse(out).invoice).toMatchObject({ depositDue: '100.00', depositPaid: false });
  });

  it('get_invoice omits depositPaid when no deposit is configured', async () => {
    vi.mocked(invoiceService.getInvoice).mockResolvedValueOnce({
      invoice: { id: 'inv-1', depositDue: null, amountPaid: '0.00' },
      lines: [],
      stripeConnected: false,
    } as any);

    const out = await getReadTool('get_invoice').handler({ invoiceId: 'inv-1' }, auth);

    expect(JSON.parse(out).invoice).toEqual({ id: 'inv-1', depositDue: null, amountPaid: '0.00' });
    expect(JSON.parse(out).invoice).not.toHaveProperty('depositPaid');
  });

  it('list_invoices adds depositPaid per row using integer-cents comparison', async () => {
    vi.mocked(invoiceService.listInvoices).mockResolvedValueOnce([
      { id: 'inv-1', depositDue: '68.20', amountPaid: '68.20' },
      { id: 'inv-2', depositDue: '100.00', amountPaid: '99.99' },
      { id: 'inv-3', depositDue: null, amountPaid: '0.00' },
    ] as any);

    const out = await getReadTool('list_invoices').handler({}, auth);
    const { invoices } = JSON.parse(out);

    expect(invoices[0]).toMatchObject({ depositPaid: true });
    expect(invoices[1]).toMatchObject({ depositPaid: false });
    expect(invoices[2]).not.toHaveProperty('depositPaid');
  });
});
