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

import * as svc from './invoiceService';
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
});
