import { describe, it, expect, vi, beforeEach } from 'vitest';

// Controllable Drizzle chain mock: every builder method returns the same
// chain; a query is resolved when it is awaited (the chain is a thenable that
// yields the next queued result). Tests queue the rows each db call should
// resolve to. This locks the guard/branch logic of invoiceService; the data
// path (totals, snapshots, source flips) is proven by the integration tests.
const results: unknown[][] = [];
function queueResult(rows: unknown[]) { results.push(rows); }

vi.mock('../db', () => {
  const makeChain = () => {
    const chain: Record<string, unknown> = {};
    const methods = ['select', 'from', 'where', 'limit', 'orderBy', 'insert', 'values', 'returning', 'update', 'set', 'delete', 'for', 'innerJoin', 'execute'];
    for (const m of methods) chain[m] = vi.fn(() => chain);
    // Make the chain awaitable: resolve to the next queued result (or []).
    (chain as { then: unknown }).then = (resolve: (v: unknown) => unknown) => {
      const rows = results.shift() ?? [];
      return Promise.resolve(rows).then(resolve);
    };
    return chain;
  };
  const db = makeChain();
  return {
    db,
    runOutsideDbContext: (fn: () => unknown) => fn(),
    withSystemDbAccessContext: (fn: () => unknown) => fn()
  };
});

vi.mock('./catalogService', () => ({ resolvePrice: vi.fn(), computeBundleEconomics: vi.fn() }));
vi.mock('./invoiceEvents', () => ({ emitInvoiceEvent: vi.fn().mockResolvedValue(undefined) }));

import { SQL } from 'drizzle-orm';
import * as svc from './invoiceService';
import { db } from '../db';
import { InvoiceServiceError } from './invoiceTypes';
import { resolvePrice } from './catalogService';

describe('invoiceService guards', () => {
  beforeEach(() => { results.length = 0; vi.clearAllMocks(); });

  it('addManualLine rejects a non-draft invoice with NOT_A_DRAFT (409)', async () => {
    // getOwnedInvoiceOr404 → a sent invoice
    queueResult([{ id: 'i1', status: 'sent', orgId: 'org1', partnerId: 'p1' }]);
    const actor = { userId: 'u1', partnerId: 'p1', accessibleOrgIds: ['org1'] };
    await expect(
      svc.addManualLine('i1', { description: 'x', quantity: 1, unitPrice: 1, taxable: false }, actor)
    ).rejects.toMatchObject({ code: 'NOT_A_DRAFT', status: 409 });
  });

  it('updateInvoice rejects a non-draft invoice with NOT_A_DRAFT (409)', async () => {
    // getOwnedInvoiceOr404 → a sent invoice
    queueResult([{ id: 'i1', status: 'sent', orgId: 'org1', partnerId: 'p1' }]);
    const actor = { userId: 'u1', partnerId: 'p1', accessibleOrgIds: ['org1'] };
    await expect(
      svc.updateInvoice('i1', { notes: 'edit' }, actor)
    ).rejects.toMatchObject({ code: 'NOT_A_DRAFT', status: 409 });
  });

  it('addManualLine denies an actor without access to the invoice org (ORG_DENIED 403)', async () => {
    // draft invoice for org1, but actor can only access other-org
    queueResult([{ id: 'i1', status: 'draft', orgId: 'org1', partnerId: 'p1' }]);
    const actor = { userId: 'u1', partnerId: 'p1', accessibleOrgIds: ['other-org'] };
    await expect(
      svc.addManualLine('i1', { description: 'x', quantity: 1, unitPrice: 1, taxable: false }, actor)
    ).rejects.toMatchObject({ code: 'ORG_DENIED', status: 403 });
  });

  it('addManualLine throws INVOICE_NOT_FOUND (404) when the invoice is absent', async () => {
    queueResult([]); // getOwnedInvoiceOr404 finds nothing (RLS-scoped empty)
    const actor = { userId: 'u1', partnerId: 'p1', accessibleOrgIds: null };
    await expect(
      svc.addManualLine('missing', { description: 'x', quantity: 1, unitPrice: 1, taxable: false }, actor)
    ).rejects.toMatchObject({ code: 'INVOICE_NOT_FOUND', status: 404 });
  });

  it('addCatalogLine routes a bundle item to an INVALID_STATE error', async () => {
    queueResult([{ id: 'i1', status: 'draft', orgId: 'org1', partnerId: 'p1' }]); // invoice
    (resolvePrice as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ unitPrice: '10.00', costBasis: null, taxable: true, taxCategory: null, source: 'item' });
    queueResult([{ name: 'Bundle X', isBundle: true }]); // catalog item lookup
    const actor = { userId: 'u1', partnerId: 'p1', accessibleOrgIds: ['org1'] };
    await expect(
      svc.addCatalogLine('i1', 'cat-bundle', 1, actor)
    ).rejects.toMatchObject({ code: 'INVALID_STATE', status: 400 });
  });

  it('createManualInvoice requires a resolvable partner (PARTNER_UNRESOLVABLE 400)', async () => {
    const actor = { userId: 'u1', partnerId: null, accessibleOrgIds: ['org1'] };
    await expect(
      svc.createManualInvoice({ orgId: 'org1' }, actor)
    ).rejects.toBeInstanceOf(InvoiceServiceError);
  });

  it('recordPayment rejects payment on a draft (INVALID_STATE 409)', async () => {
    queueResult([{ id: 'i1', status: 'draft', orgId: 'org1', partnerId: 'p1', balance: '0.00' }]);
    const actor = { userId: 'u1', partnerId: 'p1', accessibleOrgIds: ['org1'] };
    await expect(
      svc.recordPayment('i1', { amount: 10, method: 'check', receivedAt: '2026-06-14' }, actor)
    ).rejects.toMatchObject({ code: 'INVALID_STATE', status: 409 });
  });

  it('recordPayment rejects an overpayment (OVERPAYMENT 400)', async () => {
    queueResult([{ id: 'i1', status: 'sent', orgId: 'org1', partnerId: 'p1', balance: '50.00' }]);
    const actor = { userId: 'u1', partnerId: 'p1', accessibleOrgIds: ['org1'] };
    await expect(
      svc.recordPayment('i1', { amount: 60, method: 'check', receivedAt: '2026-06-14' }, actor)
    ).rejects.toMatchObject({ code: 'OVERPAYMENT', status: 400 });
  });

  it('recordPayment rejects exact-cents overpayment at +0.01 (OVERPAYMENT 400)', async () => {
    queueResult([{ id: 'i1', status: 'sent', orgId: 'org1', partnerId: 'p1', balance: '50.00' }]);
    const actor = { userId: 'u1', partnerId: 'p1', accessibleOrgIds: ['org1'] };
    await expect(
      svc.recordPayment('i1', { amount: 50.01, method: 'check', receivedAt: '2026-06-14' }, actor)
    ).rejects.toMatchObject({ code: 'OVERPAYMENT', status: 400 });
  });

  it('getCustomerInvoice returns 404 INVOICE_NOT_FOUND for a mismatched org (no existence leak)', async () => {
    queueResult([{ id: 'i1', status: 'sent', orgId: 'org1', partnerId: 'p1' }]);
    await expect(
      svc.getCustomerInvoice('i1', 'other-org')
    ).rejects.toMatchObject({ code: 'INVOICE_NOT_FOUND', status: 404 });
  });

  it('getCustomerInvoice returns the exact customer-safe invoice line keyset', async () => {
    queueResult([{ id: 'i1', status: 'sent', orgId: 'org1', partnerId: 'p1' }]);
    queueResult([{
      id: 'internal-line-id',
      invoiceId: 'i1',
      orgId: 'org1',
      sourceType: 'time_entry',
      sourceId: 'internal-source-id',
      catalogItemId: 'internal-catalog-id',
      ticketId: 'internal-ticket-id',
      description: 'Customer-facing work',
      quantity: '2.00',
      unitPrice: '75.00',
      costBasis: '20.00',
      revenueAllocation: { labor: '150.00' },
      taxable: true,
      lineTotal: '150.00',
      isUnapprovedTime: true,
      customerVisible: true,
      sortOrder: 0,
    }]);

    const result = await svc.getCustomerInvoice('i1', 'org1');

    expect(Object.keys(result.lines[0]!).sort()).toEqual([
      'description', 'lineTotal', 'quantity', 'taxable', 'unitPrice',
    ]);
    expect(result.lines[0]).toEqual({
      description: 'Customer-facing work',
      quantity: '2.00',
      unitPrice: '75.00',
      taxable: true,
      lineTotal: '150.00',
    });
  });

  it('markViewed returns 404 INVOICE_NOT_FOUND for a mismatched org (no existence leak)', async () => {
    queueResult([{ id: 'i1', status: 'sent', orgId: 'org1', partnerId: 'p1', firstViewedAt: null }]);
    await expect(
      svc.markViewed('i1', 'other-org')
    ).rejects.toMatchObject({ code: 'INVOICE_NOT_FOUND', status: 404 });
  });

  it('updatePartnerBillingSettings requires a resolvable partner (PARTNER_UNRESOLVABLE 400)', async () => {
    const actor = { userId: 'u1', partnerId: null, accessibleOrgIds: ['org1'] };
    await expect(
      svc.updatePartnerBillingSettings(
        { currencyCode: 'USD', invoiceNumberPrefix: 'INV', invoiceTermsDays: 30 },
        actor
      )
    ).rejects.toMatchObject({ code: 'PARTNER_UNRESOLVABLE', status: 400 });
  });

  it('updatePartnerBillingSettings writes the partner row and returns it', async () => {
    queueResult([{ currencyCode: 'EUR', defaultTaxRate: '0.200', invoiceNumberPrefix: 'EU', invoiceTermsDays: 14, invoiceFooter: 'Thanks' }]);
    const actor = { userId: 'u1', partnerId: 'p1', accessibleOrgIds: null };
    const row = await svc.updatePartnerBillingSettings(
      { currencyCode: 'EUR', defaultTaxRate: 0.2, invoiceNumberPrefix: 'EU', invoiceTermsDays: 14, invoiceFooter: 'Thanks' },
      actor
    );
    expect(row.currencyCode).toBe('EUR');
    expect(row.invoiceNumberPrefix).toBe('EU');
  });

  it('updatePartnerBillingSettings includes autoTaxHardware in the returned row', async () => {
    queueResult([{ currencyCode: 'USD', defaultTaxRate: null, invoiceNumberPrefix: 'INV', invoiceTermsDays: 30, invoiceFooter: null, autoTaxHardware: false }]);
    const actor = { userId: 'u1', partnerId: 'p1', accessibleOrgIds: null };
    const row = await svc.updatePartnerBillingSettings(
      { currencyCode: 'USD', invoiceNumberPrefix: 'INV', invoiceTermsDays: 30, autoTaxHardware: false },
      actor
    );
    expect(row.autoTaxHardware).toBe(false);
  });

  it('updatePartnerBillingSettings persists a scale-5 tax rate and a 2-decimal markup', async () => {
    queueResult([{ currencyCode: 'USD', invoiceNumberPrefix: 'INV', invoiceTermsDays: 30 }]);
    const actor = { userId: 'u1', partnerId: 'p1', accessibleOrgIds: null };
    await svc.updatePartnerBillingSettings(
      { currencyCode: 'USD', invoiceNumberPrefix: 'INV', invoiceTermsDays: 30, defaultTaxRate: 0.08875, defaultMarkupPercent: 12.5 },
      actor,
    );
    const setMock = (db as unknown as { set: { mock: { calls: unknown[][] } } }).set;
    const setArg = setMock.mock.calls.at(-1)![0] as Record<string, unknown>;
    expect(setArg.defaultTaxRate).toBe('0.08875'); // numeric(8,5): 3 percent decimals preserved
    expect(setArg.defaultMarkupPercent).toBe('12.50'); // numeric(6,2)
  });

  it('updatePartnerBillingSettings clears the tax rate and markup when null', async () => {
    queueResult([{ currencyCode: 'USD', invoiceNumberPrefix: 'INV', invoiceTermsDays: 30 }]);
    const actor = { userId: 'u1', partnerId: 'p1', accessibleOrgIds: null };
    await svc.updatePartnerBillingSettings(
      { currencyCode: 'USD', invoiceNumberPrefix: 'INV', invoiceTermsDays: 30, defaultTaxRate: null, defaultMarkupPercent: null },
      actor,
    );
    const setMock = (db as unknown as { set: { mock: { calls: unknown[][] } } }).set;
    const setArg = setMock.mock.calls.at(-1)![0] as Record<string, unknown>;
    expect(setArg.defaultTaxRate).toBeNull();
    expect(setArg.defaultMarkupPercent).toBeNull();
  });

  it('updateOrgBillingSettings denies an actor without access to the org (ORG_DENIED 403)', async () => {
    const actor = { userId: 'u1', partnerId: 'p1', accessibleOrgIds: ['other-org'] };
    await expect(
      svc.updateOrgBillingSettings('org1', { taxExempt: true }, actor)
    ).rejects.toMatchObject({ code: 'ORG_DENIED', status: 403 });
  });

  it('updateOrgBillingSettings writes the org row and returns it', async () => {
    queueResult([{ id: 'org1', taxId: 'GB123', taxExempt: true, taxRate: null, billingAddressCountry: 'GB' }]);
    const actor = { userId: 'u1', partnerId: 'p1', accessibleOrgIds: ['org1'] };
    const row = await svc.updateOrgBillingSettings('org1', { taxId: 'GB123', taxExempt: true, billingAddressCountry: 'GB' }, actor);
    expect(row.taxExempt).toBe(true);
    expect(row.billingAddressCountry).toBe('GB');
  });

  it('updateOrgBillingSettings merges billingContact via an atomic jsonb `||` expression, with no pre-read', async () => {
    // The merge now happens in one UPDATE (COALESCE(billing_contact,'{}') || patch)
    // — race-free and no read-modify-write round-trip. The unit layer asserts the
    // SHAPE of the write (a SQL expression, no pre-read select); the actual
    // key-preservation + null-clear semantics are proven against real Postgres in
    // orgBillingSettings.integration.test.ts.
    queueResult([{ id: 'org1', billingContact: { email: 'new@x.example', name: 'AP Dept' } }]); // returning row only
    const actor = { userId: 'u1', partnerId: 'p1', accessibleOrgIds: ['org1'] };

    await svc.updateOrgBillingSettings('org1', { billingContactEmail: 'new@x.example', billingContactName: 'AP Dept' }, actor);

    const setMock = (db as unknown as { set: { mock: { calls: unknown[][] } } }).set;
    const setArg = setMock.mock.calls.at(-1)![0] as Record<string, unknown>;
    expect(setArg.billingContact).toBeInstanceOf(SQL); // a merge expression, not a plain object
    // No pre-read: the merge is done entirely in the UPDATE.
    expect((db.select as unknown as { mock: { calls: unknown[][] } }).mock.calls).toHaveLength(0);
  });

  it('updateOrgBillingSettings does NOT touch billingContact (nor select) when no contact field is in the patch', async () => {
    queueResult([{ id: 'org1', taxExempt: true }]); // returning row only
    const actor = { userId: 'u1', partnerId: 'p1', accessibleOrgIds: ['org1'] };

    await svc.updateOrgBillingSettings('org1', { taxExempt: true }, actor);

    const setMock = (db as unknown as { set: { mock: { calls: unknown[][] } } }).set;
    const setArg = setMock.mock.calls.at(-1)![0] as Record<string, unknown>;
    expect(setArg).not.toHaveProperty('billingContact');
    // Assert the pre-read select genuinely never fired — the `not.toHaveProperty`
    // above would pass even if a stray select ran, so prove the branch directly.
    expect((db.select as unknown as { mock: { calls: unknown[][] } }).mock.calls).toHaveLength(0);
  });
});

describe('updateIssuedDueDate', () => {
  beforeEach(() => { results.length = 0; vi.clearAllMocks(); });

  it('updates dueDate on a sent invoice and returns old/new in the audit payload', async () => {
    const actor = { userId: 'u1', partnerId: 'p1', accessibleOrgIds: ['org1'] };
    queueResult([{ id: 'i1', status: 'sent', orgId: 'org1', partnerId: 'p1', dueDate: '2026-06-01' }]); // getOwnedInvoiceOr404
    queueResult([]); // db.update dueDate
    // recomputeInvoiceStatus internals:
    queueResult([{ id: 'i1', orgId: 'org1', invoiceNumber: 'INV-0001', total: '100.00', dueDate: '2026-09-01', voidedAt: null, paidAt: null, markedOverdueAt: null }]); // getOwnedInvoiceOr404
    queueResult([{ amount: '0.00' }]); // paidRows
    queueResult([]); // db.update status patch
    // final getOwnedInvoiceOr404
    queueResult([{ id: 'i1', status: 'sent', orgId: 'org1', partnerId: 'p1', dueDate: '2026-09-01' }]);

    const result = await svc.updateIssuedDueDate('i1', '2026-09-01', actor);
    expect(result.audit).toEqual({ orgId: 'org1', invoiceId: 'i1', oldDueDate: '2026-06-01', newDueDate: '2026-09-01' });
    expect(result.invoice.dueDate).toBe('2026-09-01');
  });

  it('re-derives status: an overdue invoice moved to a future due date flips back to partially_paid', async () => {
    const actor = { userId: 'u1', partnerId: 'p1', accessibleOrgIds: ['org1'] };
    queueResult([{ id: 'i1', status: 'overdue', orgId: 'org1', partnerId: 'p1', dueDate: '2026-01-01' }]); // getOwnedInvoiceOr404
    queueResult([]); // db.update dueDate
    // recomputeInvoiceStatus internals: total 100, paid 40 -> balance 60 > 0, dueDate now future -> partially_paid
    queueResult([{ id: 'i1', orgId: 'org1', invoiceNumber: 'INV-0002', total: '100.00', dueDate: '2026-12-01', voidedAt: null, paidAt: null, markedOverdueAt: '2026-02-01' }]);
    queueResult([{ amount: '40.00' }]); // paidRows
    queueResult([]); // db.update status patch
    queueResult([{ id: 'i1', status: 'partially_paid', orgId: 'org1', partnerId: 'p1', dueDate: '2026-12-01' }]); // final getOwnedInvoiceOr404

    const result = await svc.updateIssuedDueDate('i1', '2026-12-01', actor);
    expect(result.invoice.status).toBe('partially_paid');
  });

  it.each(['draft', 'paid', 'void'])('409s (INVALID_STATE) when invoice status is %s', async (status) => {
    const actor = { userId: 'u1', partnerId: 'p1', accessibleOrgIds: ['org1'] };
    queueResult([{ id: 'i1', status, orgId: 'org1', partnerId: 'p1', dueDate: '2026-06-01' }]);
    await expect(
      svc.updateIssuedDueDate('i1', '2026-09-01', actor)
    ).rejects.toMatchObject({ code: 'INVALID_STATE', status: 409 });
  });

  it('denies an actor without access to the invoice org (ORG_DENIED 403)', async () => {
    queueResult([{ id: 'i1', status: 'sent', orgId: 'org1', partnerId: 'p1', dueDate: '2026-06-01' }]);
    const actor = { userId: 'u1', partnerId: 'p1', accessibleOrgIds: ['other-org'] };
    await expect(
      svc.updateIssuedDueDate('i1', '2026-09-01', actor)
    ).rejects.toMatchObject({ code: 'ORG_DENIED', status: 403 });
  });
});

describe('addContractLine', () => {
  beforeEach(() => { results.length = 0; vi.clearAllMocks(); });

  // Helper: queue the 6 DB calls that insertLineAndRecompute + recomputeInvoiceTotals need.
  function queueInsertAndRecompute(lineRow: unknown) {
    queueResult([]);                    // sortOrder lookup (no existing lines)
    queueResult([lineRow]);             // insert invoiceLines → returning new line
    queueResult([{ id: 'i1', status: 'draft', orgId: 'org1', partnerId: 'p1', amountPaid: '0.00' }]); // recomputeInvoiceTotals re-fetch
    queueResult([{ lineTotal: (lineRow as { lineTotal: string }).lineTotal, taxable: false, customerVisible: true }]); // select lines
    queueResult([{ taxExempt: false, taxRate: null }]); // effectiveRateForOrg
    queueResult([]);                    // update invoices
  }

  it('non-catalog path: sets sourceType=contract and returns the inserted line with normalized values', async () => {
    const actor = { userId: 'u1', partnerId: 'p1', accessibleOrgIds: ['org1'] };
    queueResult([{ id: 'i1', status: 'draft', orgId: 'org1', partnerId: 'p1' }]);
    queueInsertAndRecompute({ id: 'l1', sourceType: 'contract', sourceId: null, catalogItemId: null,
      description: 'Managed services (flat)', quantity: '1', unitPrice: '500.00',
      lineTotal: '500.00', taxable: false, customerVisible: true });

    const line = await svc.addContractLine('i1', {
      description: 'Managed services (flat)', quantity: '1', unitPrice: '500.00',
      taxable: false, catalogItemId: null, sourceId: null
    }, actor);

    expect(line.sourceType).toBe('contract');
    expect(line.lineTotal).toBe('500.00');
    expect(resolvePrice).not.toHaveBeenCalled();
  });

  it('catalog path: resolves price via resolvePrice and uses its unitPrice, taxable, costBasis (not caller-supplied)', async () => {
    const actor = { userId: 'u1', partnerId: 'p1', accessibleOrgIds: ['org1'] };
    // resolvePrice returns a known price that differs from what caller would supply
    (resolvePrice as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      unitPrice: '99.00', taxable: true, costBasis: '45.00', taxCategory: null, source: 'item'
    });
    queueResult([{ id: 'i1', status: 'draft', orgId: 'org1', partnerId: 'p1' }]);
    queueInsertAndRecompute({ id: 'l2', sourceType: 'contract', sourceId: 'cl-1', catalogItemId: 'cat-1',
      description: 'Managed endpoint', quantity: '3', unitPrice: '99.00',
      lineTotal: '297.00', taxable: true, customerVisible: true });

    const line = await svc.addContractLine('i1', {
      description: 'Managed endpoint',
      quantity: '3',
      unitPrice: '999.00', // caller-supplied price — must be ignored on catalog path
      taxable: false,      // caller-supplied taxable — must be overridden by resolvePrice
      catalogItemId: 'cat-1',
      sourceId: 'cl-1',
    }, actor);

    // resolvePrice must have been called with the correct org + actor
    expect(resolvePrice).toHaveBeenCalledWith(
      'cat-1', 'org1',
      { userId: 'u1', partnerId: 'p1', accessibleOrgIds: ['org1'] }
    );
    // Line uses the resolved price, not the caller-supplied 999.00
    expect(line.unitPrice).toBe('99.00');
    expect(line.lineTotal).toBe('297.00');
  });

  it('non-catalog path: throws INVALID_AMOUNT (400) when unitPrice is negative', async () => {
    const actor = { userId: 'u1', partnerId: 'p1', accessibleOrgIds: ['org1'] };
    queueResult([{ id: 'i1', status: 'draft', orgId: 'org1', partnerId: 'p1' }]);
    await expect(
      svc.addContractLine('i1', { description: 'x', quantity: '1', unitPrice: '-5.00', taxable: false }, actor)
    ).rejects.toMatchObject({ code: 'INVALID_AMOUNT', status: 400 });
  });

  it('non-catalog path: throws INVALID_AMOUNT (400) when quantity is negative', async () => {
    const actor = { userId: 'u1', partnerId: 'p1', accessibleOrgIds: ['org1'] };
    queueResult([{ id: 'i1', status: 'draft', orgId: 'org1', partnerId: 'p1' }]);
    await expect(
      svc.addContractLine('i1', { description: 'x', quantity: '-2', unitPrice: '10.00', taxable: false }, actor)
    ).rejects.toMatchObject({ code: 'INVALID_AMOUNT', status: 400 });
  });

  it('rejects a non-draft invoice with NOT_A_DRAFT (409)', async () => {
    queueResult([{ id: 'i1', status: 'sent', orgId: 'org1', partnerId: 'p1' }]);
    const actor = { userId: 'u1', partnerId: 'p1', accessibleOrgIds: ['org1'] };
    await expect(
      svc.addContractLine('i1', { description: 'x', quantity: '1', unitPrice: '100.00', taxable: false }, actor)
    ).rejects.toMatchObject({ code: 'NOT_A_DRAFT', status: 409 });
  });

  it('denies an actor without access to the invoice org (ORG_DENIED 403)', async () => {
    queueResult([{ id: 'i1', status: 'draft', orgId: 'org1', partnerId: 'p1' }]);
    const actor = { userId: 'u1', partnerId: 'p1', accessibleOrgIds: ['other-org'] };
    await expect(
      svc.addContractLine('i1', { description: 'x', quantity: '1', unitPrice: '100.00', taxable: false }, actor)
    ).rejects.toMatchObject({ code: 'ORG_DENIED', status: 403 });
  });
});
