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
    const methods = ['select', 'from', 'where', 'limit', 'orderBy', 'groupBy', 'insert', 'values', 'returning', 'update', 'set', 'delete', 'for', 'innerJoin', 'leftJoin', 'execute'];
    for (const m of methods) chain[m] = vi.fn(() => chain);
    // Make the chain awaitable: resolve to the next queued result (or []).
    (chain as { then: unknown }).then = (resolve: (v: unknown) => unknown) => {
      const rows = results.shift() ?? [];
      return Promise.resolve(rows).then(resolve);
    };
    return chain;
  };
  const db = makeChain();
  // updateOrgBillingSettings wraps the contact merge and the column update in
  // one transaction; the callback gets the same chain so queued results behave
  // identically inside it.
  (db as { transaction?: unknown }).transaction = vi.fn(
    async (fn: (tx: unknown) => unknown) => fn(db)
  );
  return {
    db,
    runOutsideDbContext: (fn: () => unknown) => fn(),
    withSystemDbAccessContext: (fn: () => unknown) => fn()
  };
});

// The compat service owns the jsonb merge now; its own suite proves the SQL
// shape. Here it is stubbed so these tests assert delegation, not re-assert it.
vi.mock('./contacts/compat', () => ({
  mergeBillingContact: vi.fn().mockResolvedValue(undefined),
}));

// Multi-currency wave 3 (#3775): the resolver + bundle economics are mocked;
// CatalogServiceError stays real so the NO_PRICE_FOR_CURRENCY mapping path is
// exercised with the genuine class (an `instanceof undefined` would throw).
vi.mock('./catalogService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./catalogService')>();
  return { ...actual, resolvePrice: vi.fn(), computeBundleEconomics: vi.fn() };
});
vi.mock('./invoiceEvents', () => ({ emitInvoiceEvent: vi.fn().mockResolvedValue(undefined) }));
// Assembly gathers are module-mocked: the partition/rounding contract is proven
// in invoiceAssembly.test.ts; here we lock how the service consumes
// `{ included, blockedByCurrency }` (Task 11, #3776).
vi.mock('./invoiceAssembly', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./invoiceAssembly')>()),
  gatherOrgTimeEntries: vi.fn(),
  gatherOrgParts: vi.fn(),
  gatherTicketBillables: vi.fn(),
}));

// issueInvoice enqueues an async PDF render; stub it so the unit path never
// opens a BullMQ socket.
vi.mock('../jobs/invoiceWorker', () => ({ enqueueInvoicePdfRender: vi.fn().mockResolvedValue(undefined) }));

// issueInvoice/voidInvoice also enqueue QuickBooks push/void jobs (Phase C,
// Task 4) — same reason as the PDF render mock above.
vi.mock('../jobs/accountingSyncWorker', () => ({
  enqueueAccountingInvoicePush: vi.fn().mockResolvedValue(undefined),
  enqueueAccountingInvoiceVoid: vi.fn().mockResolvedValue(undefined),
}));

// The QBO payment-mapping cleanup voidPayment now performs inside its own
// transaction (Phase D, Task 3). Mocked so these tests assert the DELEGATION
// (handle + payment id), not a second copy of the applier's own suite.
vi.mock('./accounting/accountingPaymentPull', () => ({
  clearPaymentMappingForInvoicePayment: vi.fn().mockResolvedValue(0),
}));

import { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { Mock } from 'vitest';
import * as svc from './invoiceService';
import { db } from '../db';
import { InvoiceServiceError } from './invoiceTypes';
import { resolvePrice, computeBundleEconomics, CatalogServiceError } from './catalogService';
import { mergeBillingContact } from './contacts/compat';
import { enqueueAccountingInvoicePush, enqueueAccountingInvoiceVoid } from '../jobs/accountingSyncWorker';
import { clearPaymentMappingForInvoicePayment } from './accounting/accountingPaymentPull';

const clearPaymentMappingMock = vi.mocked(clearPaymentMappingForInvoicePayment);

const enqueueAccountingInvoicePushMock = vi.mocked(enqueueAccountingInvoicePush);
const enqueueAccountingInvoiceVoidMock = vi.mocked(enqueueAccountingInvoiceVoid);
import { gatherOrgTimeEntries, gatherOrgParts, gatherTicketBillables, type DraftLineSpec } from './invoiceAssembly';

const resolvePriceMock = vi.mocked(resolvePrice);
const bundleEconMock = vi.mocked(computeBundleEconomics);
/** A price-book resolution in USD with margin available (cost in USD). */
const resolvedUsd = (over: Partial<Awaited<ReturnType<typeof resolvePrice>>> = {}) => ({
  unitPrice: '10.00', currencyCode: 'USD', costBasis: '4.00', costCurrency: 'USD',
  marginAvailable: true, taxable: true, taxCategory: null, source: 'price_book' as const, ...over,
});

describe('invoiceService guards', () => {
  beforeEach(() => { results.length = 0; vi.clearAllMocks(); });

  const invoiceId = 'i1';
  const actor = { userId: 'u1', partnerId: 'p1', accessibleOrgIds: ['org1'] };
  const { recordPayment } = svc;

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
    resolvePriceMock.mockResolvedValue(resolvedUsd({ costBasis: null }));
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

  it('createManualInvoice stamps the draft with the org currency (spec §5)', async () => {
    queueResult([{ currencyCode: 'EUR' }]); // org lookup
    queueResult([{ id: 'i1', status: 'draft', orgId: 'org1', partnerId: 'p1', currencyCode: 'EUR' }]); // insert returning
    const actor = { userId: 'u1', partnerId: 'p1', accessibleOrgIds: ['org1'] };
    await svc.createManualInvoice({ orgId: 'org1' }, actor);
    const valuesMock = (db as unknown as { values: Mock }).values;
    expect(valuesMock).toHaveBeenCalledWith(expect.objectContaining({ currencyCode: 'EUR' }));
  });

  it('createManualInvoice: an explicit currencyCode wins over the org currency', async () => {
    // No org lookup is queued: the override short-circuits the org read, so the
    // only db call is the insert. GBP in the insert values proves the override
    // wins even for an org whose currency differs.
    queueResult([{ id: 'i1', status: 'draft', orgId: 'org1', partnerId: 'p1', currencyCode: 'GBP' }]); // insert returning
    const actor = { userId: 'u1', partnerId: 'p1', accessibleOrgIds: ['org1'] };
    await svc.createManualInvoice({ orgId: 'org1', currencyCode: 'GBP' }, actor);
    const valuesMock = (db as unknown as { values: Mock }).values;
    expect(valuesMock).toHaveBeenCalledWith(expect.objectContaining({ currencyCode: 'GBP' }));
  });

  it('createManualInvoice throws ORG_NOT_FOUND (404) when the org row is missing', async () => {
    queueResult([]); // org lookup finds nothing (RLS-scoped empty)
    const actor = { userId: 'u1', partnerId: 'p1', accessibleOrgIds: null };
    await expect(
      svc.createManualInvoice({ orgId: 'missing-org' }, actor)
    ).rejects.toMatchObject({ code: 'ORG_NOT_FOUND', status: 404 });
  });

  // recordPayment runs in ONE transaction (B10). In-tx query order:
  //   1. invoices lock select (FOR UPDATE) → invoice row
  //   2. invoice_payments sum select → prior payments (balance = total − sum)
  //   3. payment insert returning → payment row
  //   4-6. recomputeInvoiceStatus(tx): invoice re-read, payments re-read, update
  //   7. final invoice re-read (returned to the caller)
  // Guard rejections consume only entries 1-2. The mock rows must carry `total`
  // + `currencyCode` — the header's balance column is no longer read.

  it('recordPayment rejects payment on a draft (INVALID_STATE 409)', async () => {
    queueResult([{ id: 'i1', status: 'draft', orgId: 'org1', partnerId: 'p1', currencyCode: 'USD', total: '0.00' }]); // lock select
    const actor = { userId: 'u1', partnerId: 'p1', accessibleOrgIds: ['org1'] };
    await expect(
      svc.recordPayment('i1', { amount: 10, method: 'check', receivedAt: '2026-06-14' }, actor)
    ).rejects.toMatchObject({ code: 'INVALID_STATE', status: 409 });
  });

  it('recordPayment rejects an overpayment against the in-tx balance (OVERPAYMENT 400)', async () => {
    queueResult([{ id: 'i1', status: 'sent', orgId: 'org1', partnerId: 'p1', currencyCode: 'USD', total: '80.00' }]); // lock select
    queueResult([{ amount: '30.00' }]); // prior payments → balance 50.00, NOT the header column
    const actor = { userId: 'u1', partnerId: 'p1', accessibleOrgIds: ['org1'] };
    await expect(
      svc.recordPayment('i1', { amount: 60, method: 'check', receivedAt: '2026-06-14' }, actor)
    ).rejects.toMatchObject({ code: 'OVERPAYMENT', status: 400 });
  });

  it('recordPayment rejects exact-cents overpayment at +0.01 (OVERPAYMENT 400)', async () => {
    queueResult([{ id: 'i1', status: 'sent', orgId: 'org1', partnerId: 'p1', currencyCode: 'USD', total: '50.00' }]); // lock select
    queueResult([]); // no prior payments → balance 50.00
    const actor = { userId: 'u1', partnerId: 'p1', accessibleOrgIds: ['org1'] };
    await expect(
      svc.recordPayment('i1', { amount: 50.01, method: 'check', receivedAt: '2026-06-14' }, actor)
    ).rejects.toMatchObject({ code: 'OVERPAYMENT', status: 400 });
  });

  it('rejects a payment not representable in the invoice currency', async () => {
    const invoice = {
      id: invoiceId,
      status: 'sent',
      orgId: 'org1',
      siteId: null,
      partnerId: 'p1',
      invoiceNumber: 'INV-0001',
      currencyCode: 'JPY',
      total: '2000.00',
      amountPaid: '0.00',
      balance: '2000.00',
      dueDate: '2026-09-01',
      voidedAt: null,
      paidAt: null,
      markedOverdueAt: null,
    };
    queueResult([invoice]); // lock select
    queueResult([]); // no prior payments → balance 2000 (representable JPY)

    await expect(recordPayment(invoiceId, { amount: '100.50', method: 'cash', receivedAt: new Date() } as any, actor))
      .rejects.toMatchObject({ status: 400, code: 'INVALID_AMOUNT' });
  });

  it('accepts the exact payoff of a legacy non-representable balance (JPY 1000.50)', async () => {
    // Pre-multi-currency cent math could leave a JPY invoice with a
    // cent-fraction balance. The exact-payoff amount must bypass the
    // representability guard or the invoice can never reach 'paid'.
    const invoice = {
      id: invoiceId,
      status: 'sent',
      orgId: 'org1',
      siteId: null,
      partnerId: 'p1',
      invoiceNumber: 'INV-0002',
      currencyCode: 'JPY',
      total: '1000.50',
      amountPaid: '0.00',
      balance: '1000.50',
      dueDate: '2026-09-01',
      voidedAt: null,
      paidAt: null,
      markedOverdueAt: null,
    };
    queueResult([invoice]); // lock select (guards + balance base)
    queueResult([]); // no prior payments → in-tx balance 1000.50 (non-representable)
    queueResult([{ id: 'pay1', amount: '1000.50', method: 'cash', reference: null, recordedBy: actor.userId }]); // payment insert
    queueResult([invoice]); // recomputeInvoiceStatus → invoice re-read
    queueResult([{ amount: '1000.50' }]); // recompute payments sum
    queueResult([]); // invoice status update
    queueResult([{ ...invoice, status: 'paid', amountPaid: '1000.50', balance: '0.00' }]); // final read

    const res = await recordPayment(invoiceId, { amount: '1000.50', method: 'cash', receivedAt: new Date() } as any, actor);
    expect(res.invoice.status).toBe('paid');
    expect(res.audit.paymentId).toBe('pay1');
  });

  it('still rejects a non-representable JPY amount that is NOT the exact payoff', async () => {
    queueResult([{
      id: invoiceId, status: 'sent', orgId: 'org1', siteId: null, partnerId: 'p1',
      currencyCode: 'JPY', total: '1000.50', amountPaid: '0.00', balance: '1000.50',
    }]); // lock select
    queueResult([]); // no prior payments → in-tx balance 1000.50
    await expect(recordPayment(invoiceId, { amount: '500.50', method: 'cash', receivedAt: new Date() } as any, actor))
      .rejects.toMatchObject({ status: 400, code: 'INVALID_AMOUNT' });
  });

  it('rejects a REPRESENTABLE underpayment when the locked balance is non-representable (would strand a residue)', async () => {
    // JPY balance 1000.50: paying 500 (perfectly representable) would leave
    // '500.50' — a residue no later payment could clear. Only the exact payoff
    // may land on a non-representable balance.
    queueResult([{
      id: invoiceId, status: 'sent', orgId: 'org1', siteId: null, partnerId: 'p1',
      currencyCode: 'JPY', total: '1000.50', amountPaid: '0.00', balance: '1000.50',
    }]); // lock select
    queueResult([]); // no prior payments → in-tx balance 1000.50
    await expect(recordPayment(invoiceId, { amount: '500', method: 'cash', receivedAt: new Date() } as any, actor))
      .rejects.toMatchObject({ status: 400, code: 'INVALID_AMOUNT' });
  });

  it('evaluates the representability escape against the IN-TX balance, not the stale header column', async () => {
    // Header still says balance '1000.50', but a concurrent (already-committed)
    // payment of the exact payoff exists in invoice_payments. The re-derived
    // balance is 0.00 — representable — so this second exact-payoff attempt
    // must fall through to the overpay check, NOT ride the legacy escape hatch.
    queueResult([{
      id: invoiceId, status: 'sent', orgId: 'org1', siteId: null, partnerId: 'p1',
      currencyCode: 'JPY', total: '1000.50', amountPaid: '0.00', balance: '1000.50',
    }]); // lock select (stale header balance)
    queueResult([{ amount: '1000.50' }]); // prior payment already landed → in-tx balance 0.00
    await expect(recordPayment(invoiceId, { amount: '1000.50', method: 'cash', receivedAt: new Date() } as any, actor))
      .rejects.toMatchObject({ status: 400, code: 'INVALID_AMOUNT' });
  });

  it('getCustomerInvoice returns 404 INVOICE_NOT_FOUND for a mismatched org (no existence leak)', async () => {
    queueResult([{ id: 'i1', status: 'sent', orgId: 'org1', partnerId: 'p1' }]);
    await expect(
      svc.getCustomerInvoice('i1', 'other-org')
    ).rejects.toMatchObject({ code: 'INVOICE_NOT_FOUND', status: 404 });
  });

  it('getCustomerInvoice returns the exact customer-safe invoice header keyset', async () => {
    queueResult([{
      id: 'i1',
      partnerId: 'internal-partner-id',
      orgId: 'org1',
      siteId: 'internal-site-id',
      invoiceNumber: 'INV-1',
      status: 'sent',
      currencyCode: 'USD',
      issueDate: '2026-07-01',
      dueDate: '2026-07-31',
      subtotal: '150.00',
      taxRate: '0.05000',
      taxTotal: '7.50',
      total: '157.50',
      amountPaid: '25.00',
      balance: '132.50',
      depositDue: '50.00',
      billToName: 'Customer, Inc.',
      billToAddress: { line1: 'internal-address-field' },
      billToTaxId: 'internal-tax-id',
      billToTaxExempt: false,
      notes: 'Customer-visible note',
      terms: 'implementation-only legacy terms',
      sellerSnapshot: { name: 'MSP, Inc.' },
      termsAndConditions: 'Net 30',
      sentAt: new Date('2026-07-01T00:00:00Z'),
      firstViewedAt: null,
      viewedAt: null,
      paidAt: null,
      markedOverdueAt: null,
      voidedAt: null,
      voidReason: null,
      replacesInvoiceId: 'internal-replaced-invoice-id',
      replacedByInvoiceId: 'internal-replacement-id',
      pdfDocumentRef: 'internal/invoices/i1.pdf',
      pdfSha256: 'internal-pdf-hash',
      createdBy: 'internal-user-id',
      createdAt: new Date('2026-06-30T00:00:00Z'),
      updatedAt: new Date('2026-07-01T00:00:00Z'),
    }]);
    queueResult([]);

    const { invoice } = await svc.getCustomerInvoice('i1', 'org1');

    expect(Object.keys(invoice).sort()).toEqual([
      'amountPaid',
      'balance',
      'billToName',
      'currencyCode',
      'depositDue',
      'dueDate',
      'id',
      'invoiceNumber',
      'issueDate',
      'notes',
      'sellerSnapshot',
      'status',
      'subtotal',
      'taxRate',
      'taxTotal',
      'termsAndConditions',
      'total',
    ].sort());
    expect(invoice).not.toHaveProperty('createdBy');
    expect(invoice).not.toHaveProperty('replacesInvoiceId');
    expect(invoice).not.toHaveProperty('replacedByInvoiceId');
    expect(invoice).not.toHaveProperty('pdfDocumentRef');
    expect(invoice).not.toHaveProperty('pdfSha256');
    expect(invoice).not.toHaveProperty('partnerId');
    expect(invoice).not.toHaveProperty('orgId');
    expect(invoice).not.toHaveProperty('siteId');
    expect(invoice).not.toHaveProperty('createdAt');
    expect(invoice).not.toHaveProperty('updatedAt');
  });

  it('getCustomerInvoice returns partnerId OUTSIDE the serialized header for the branding lookup', async () => {
    // The portal detail route resolves the partner display name from this id.
    // It used to read `result.invoice.partnerId`, which the serialization
    // boundary strips — undefined reached the partners query and every portal
    // invoice-detail request 500ed (postgres.js UNDEFINED_VALUE).
    queueResult([{ id: 'i1', status: 'sent', orgId: 'org1', partnerId: 'internal-partner-id' }]);
    queueResult([]);
    const result = await svc.getCustomerInvoice('i1', 'org1');
    expect(result.partnerId).toBe('internal-partner-id');
    expect(result.invoice).not.toHaveProperty('partnerId');
  });

  it('serializes ticketNumber without source metadata', () => {
    expect(svc.toCustomerInvoiceLine({
      ticketNumber: 'T-100',
      name: 'Support',
      description: 'Printer repair',
      quantity: '1',
      unitPrice: '100',
      taxable: false,
      lineTotal: '100',
    })).toEqual({
      ticketNumber: 'T-100',
      name: 'Support',
      description: 'Printer repair',
      quantity: '1',
      unitPrice: '100',
      taxable: false,
      lineTotal: '100',
    });
  });

  it('joins tickets and scopes both sides to the invoice org', async () => {
    queueResult([{
      id: 'invoice-1', status: 'sent', orgId: 'org1', partnerId: 'p1',
    }]);
    queueResult([]);
    await svc.getCustomerInvoice('invoice-1', 'org1');
    const join = (db as unknown as { leftJoin: Mock }).leftJoin.mock.calls.at(-1)![1];
    const compiledJoin = new PgDialect().sqlToQuery(join as SQL);
    expect(compiledJoin.sql).toContain(
      '"tickets"."id" = "invoice_lines"."ticket_id"',
    );
    expect(compiledJoin.sql).toContain('"tickets"."org_id" =');
    expect(compiledJoin.params).toContain('org1');

    const where = (db as unknown as { where: Mock }).where.mock.calls.at(-1)![0];
    const compiledWhere = new PgDialect().sqlToQuery(where as SQL);
    expect(compiledWhere.sql).toContain('"invoice_lines"."org_id" =');
    expect(compiledWhere.params).toContain('org1');
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
      'description', 'lineTotal', 'name', 'quantity', 'taxable', 'ticketNumber', 'unitPrice',
    ]);
    expect(result.lines[0]).toEqual({
      ticketNumber: null,
      // Legacy line (source row carries no `name`): description stays the title.
      name: null,
      description: 'Customer-facing work',
      quantity: '2.00',
      unitPrice: '75.00',
      taxable: true,
      lineTotal: '150.00',
    });
  });

  // #3319: the portal DTO used to collapse the pair as `description ?? name`,
  // the INVERSE of the fallback the PDF and the MSP web views use, so a line
  // with both fields set showed the customer the blurb and never the title.
  it('getCustomerInvoice surfaces name and description as separate fields', async () => {
    queueResult([{ id: 'i1', status: 'sent', orgId: 'org1', partnerId: 'p1' }]);
    queueResult([{
      id: 'internal-line-id',
      invoiceId: 'i1',
      orgId: 'org1',
      sourceType: 'manual',
      name: 'Onboarding & network setup',
      description: 'Network audit, agent deployment, endpoint enrollment',
      quantity: '1.00',
      unitPrice: '1500.00',
      taxable: true,
      lineTotal: '1500.00',
      customerVisible: true,
      sortOrder: 0,
    }]);

    const result = await svc.getCustomerInvoice('i1', 'org1');

    expect(result.lines[0]).toMatchObject({
      name: 'Onboarding & network setup',
      description: 'Network audit, agent deployment, endpoint enrollment',
    });
    // Still no internal columns leaked alongside the new field.
    expect(Object.keys(result.lines[0]!).sort()).toEqual([
      'description', 'lineTotal', 'name', 'quantity', 'taxable', 'ticketNumber', 'unitPrice',
    ]);
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

  it('updatePartnerBillingSettings writes and returns documentTheme and documentPageSize', async () => {
    queueResult([{
      currencyCode: 'USD', invoiceNumberPrefix: 'INV', invoiceTermsDays: 30,
      documentTheme: 'condensed', documentPageSize: 'letter',
    }]);
    const actor = { userId: 'u1', partnerId: 'p1', accessibleOrgIds: null };
    const row = await svc.updatePartnerBillingSettings(
      { currencyCode: 'USD', invoiceNumberPrefix: 'INV', invoiceTermsDays: 30, documentTheme: 'condensed', documentPageSize: 'letter' },
      actor,
    );
    expect(row.documentTheme).toBe('condensed');
    expect(row.documentPageSize).toBe('letter');
    const setMock = (db as unknown as { set: { mock: { calls: unknown[][] } } }).set;
    const setArg = setMock.mock.calls.at(-1)![0] as Record<string, unknown>;
    expect(setArg.documentTheme).toBe('condensed');
    expect(setArg.documentPageSize).toBe('letter');
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

  it('updateOrgBillingSettings delegates the billingContact merge to the contacts compat service', async () => {
    // The jsonb write moved to services/contacts/compat (#3258) so the blob and
    // the `contacts` row are written together. The atomic `COALESCE(...) || patch`
    // SHAPE — a SQL expression rather than a read-modify-write — is asserted at
    // services/contacts/compat.test.ts:94, and the key-preservation + null-clear
    // semantics against real Postgres in orgBillingSettings.integration.test.ts.
    // What this test owns is the delegation: that this service no longer writes
    // the column itself, and hands the merge the exact patch it was given.
    queueResult([{ id: 'org1' }]); // existence probe
    queueResult([{ id: 'org1', billingContact: { email: 'new@x.example', name: 'AP Dept' } }]); // projection read-back
    const actor = { userId: 'u1', partnerId: 'p1', accessibleOrgIds: ['org1'] };

    const row = await svc.updateOrgBillingSettings('org1', { billingContactEmail: 'new@x.example', billingContactName: 'AP Dept' }, actor);

    expect(mergeBillingContact).toHaveBeenCalledTimes(1);
    const [, orgIdArg, patchArg, actorArg] = (mergeBillingContact as unknown as Mock).mock.calls[0]!;
    expect(orgIdArg).toBe('org1');
    expect(patchArg).toEqual({ email: 'new@x.example', name: 'AP Dept' });
    expect(actorArg).toBe('u1');
    // A contact-only patch leaves nothing for this service to set, so it must
    // not issue a column UPDATE of its own.
    expect(db.update).not.toHaveBeenCalled();
    expect(row.billingContact).toEqual({ email: 'new@x.example', name: 'AP Dept' });
  });

  it('updateOrgBillingSettings 404s on an unknown org instead of tripping the contacts FK', async () => {
    // The merge inserts a contacts row, so an unknown orgId would raise a
    // foreign-key violation if the existence probe were removed.
    queueResult([]); // existence probe finds nothing
    const actor = { userId: 'u1', partnerId: 'p1', accessibleOrgIds: ['org1'] };

    await expect(
      svc.updateOrgBillingSettings('org1', { billingContactEmail: 'new@x.example' }, actor)
    ).rejects.toMatchObject({ code: 'INVOICE_NOT_FOUND', status: 404 });
    expect(mergeBillingContact).not.toHaveBeenCalled();
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

/**
 * Multi-currency wave 5 (#3777): issueInvoice stamps `document_locale` once, at
 * issue, from the partner's language — unless the draft already carries one
 * (never overwritten). The stamp is a pure key addition to the guarded `.set`
 * using the partner row already read inside the transaction.
 */
describe('issueInvoice document_locale stamp', () => {
  beforeEach(() => { results.length = 0; vi.clearAllMocks(); });

  const actor = { userId: 'u1', partnerId: 'p1', accessibleOrgIds: ['org1'] };
  const draft = (overrides: Record<string, unknown> = {}) => ({
    id: 'inv1', status: 'draft', orgId: 'org1', siteId: null, partnerId: 'p1',
    currencyCode: 'USD', termsAndConditions: null, documentLocale: null, ...overrides,
  });

  /** Queue the issue transaction's db calls for a manual-line-only draft. */
  function queueIssuePath(inv: Record<string, unknown>, partner: Record<string, unknown>) {
    queueResult([inv]); // 0. pre-tx fast-fail read (RLS-scoped, non-authoritative)
    queueResult([inv]); // 1. invoice row lock
    queueResult([{ id: 'l1', invoiceId: 'inv1', sourceType: 'manual', sourceId: null, lineTotal: '100.00', taxable: false, customerVisible: true }]); // 2. lines lock
    queueResult([{ id: 'org1', name: 'Customer', taxExempt: false, taxRate: null, taxId: null }]); // 3. org
    queueResult([partner]); // 4. partner (read inside the tx, after all locks)
    queueResult([{ counter: 1 }]); // 5. counter upsert
    queueResult([{ id: 'inv1' }]); // 6. guarded update ... returning
    queueResult([{ ...inv, status: 'sent' }]); // 7. final re-select
  }

  function issueSet(): Record<string, unknown> {
    const setMock = (db as unknown as { set: Mock }).set;
    const found = setMock.mock.calls.map((c) => c[0] as Record<string, unknown>).find((p) => p.status === 'sent');
    expect(found, 'issue should write the guarded status=sent update').toBeDefined();
    return found!;
  }

  it('stamps documentLocale from the partner language when the draft has none', async () => {
    queueIssuePath(draft(), { id: 'p1', invoiceNumberPrefix: 'INV', invoiceTermsDays: 30, settings: { language: 'fr-CA' } });
    await svc.issueInvoice('inv1', actor);
    expect(issueSet().documentLocale).toBe('fr-CA');
  });

  it('never overwrites a documentLocale the draft already carries', async () => {
    queueIssuePath(draft({ documentLocale: 'de-DE' }), { id: 'p1', invoiceNumberPrefix: 'INV', invoiceTermsDays: 30, settings: { language: 'fr-CA' } });
    await svc.issueInvoice('inv1', actor);
    expect(issueSet().documentLocale).toBe('de-DE');
  });

  it("falls back to 'en' when the partner has no language setting", async () => {
    queueIssuePath(draft(), { id: 'p1', invoiceNumberPrefix: 'INV', invoiceTermsDays: 30, settings: {} });
    await svc.issueInvoice('inv1', actor);
    expect(issueSet().documentLocale).toBe('en');
  });

  // Phase C, Task 4: issuance fires an accounting-sync push job post-commit,
  // next to enqueueInvoicePdfRender.
  it('enqueues an accounting push for the issued invoice, keyed off the locked row', async () => {
    queueIssuePath(draft(), { id: 'p1', invoiceNumberPrefix: 'INV', invoiceTermsDays: 30, settings: {} });
    await svc.issueInvoice('inv1', actor);
    expect(enqueueAccountingInvoicePushMock).toHaveBeenCalledWith('inv1', 'p1');
  });

  it('does not let a failed accounting-push enqueue fail the (already-committed) issuance', async () => {
    queueIssuePath(draft(), { id: 'p1', invoiceNumberPrefix: 'INV', invoiceTermsDays: 30, settings: {} });
    enqueueAccountingInvoicePushMock.mockRejectedValueOnce(new Error('boom'));
    await expect(svc.issueInvoice('inv1', actor)).resolves.toBeDefined();
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

describe('addCatalogLine / addBundleLine price-book resolution (#3775)', () => {
  beforeEach(() => { results.length = 0; vi.clearAllMocks(); });
  const actor = { userId: 'u1', partnerId: 'p1', accessibleOrgIds: ['org1'] };
  const values = () => (db as unknown as { values: Mock }).values;

  function queueInsertAndRecompute(lineRow: { lineTotal: string } & Record<string, unknown>) {
    queueResult([]);                    // sortOrder lookup
    queueResult([lineRow]);             // insert returning
    queueResult([{ id: 'i1', status: 'draft', orgId: 'org1', partnerId: 'p1', amountPaid: '0.00', currencyCode: 'USD' }]);
    queueResult([{ lineTotal: lineRow.lineTotal, taxable: true, customerVisible: true }]);
    queueResult([{ taxExempt: false, taxRate: null }]);
    queueResult([]);                    // update invoices
  }

  it('addCatalogLine resolves in the INVOICE currency on the tx and snapshots cost only when margin is available', async () => {
    resolvePriceMock.mockResolvedValue(resolvedUsd({ unitPrice: '42.00', costBasis: '30.00' }));
    queueResult([{ id: 'i1', status: 'draft', orgId: 'org1', partnerId: 'p1', currencyCode: 'USD' }]);
    queueResult([{ name: 'Seat', description: null, isBundle: false }]);
    queueInsertAndRecompute({ id: 'l1', unitPrice: '42.00', lineTotal: '84.00' });

    const line = await svc.addCatalogLine('i1', 'cat-1', 2, actor);
    expect(line.unitPrice).toBe('42.00');
    expect(resolvePrice).toHaveBeenCalledWith(
      'cat-1', 'USD', 'org1',
      expect.objectContaining({ userId: 'u1', partnerId: 'p1', accessibleOrgIds: ['org1'] }),
      expect.anything()
    );
    expect(values()).toHaveBeenCalledWith(expect.objectContaining({
      catalogItemId: 'cat-1', unitPrice: '42.00', costBasis: '30.00', taxable: true, lineTotal: '84.00'
    }));
  });

  it('addCatalogLine inserts costBasis null when the cost currency differs (marginAvailable false)', async () => {
    resolvePriceMock.mockResolvedValue(resolvedUsd({ costBasis: '30.00', costCurrency: 'CAD', marginAvailable: false }));
    queueResult([{ id: 'i1', status: 'draft', orgId: 'org1', partnerId: 'p1', currencyCode: 'USD' }]);
    queueResult([{ name: 'Seat', description: null, isBundle: false }]);
    queueInsertAndRecompute({ id: 'l1', unitPrice: '10.00', lineTotal: '10.00' });

    await svc.addCatalogLine('i1', 'cat-1', 1, actor);
    expect(values()).toHaveBeenCalledWith(expect.objectContaining({ unitPrice: '10.00', costBasis: null }));
  });

  it('addCatalogLine maps a resolver gap to NO_PRICE_FOR_CURRENCY (409) and inserts nothing', async () => {
    resolvePriceMock.mockRejectedValue(new CatalogServiceError('No EUR price', 409, 'NO_PRICE_FOR_CURRENCY'));
    queueResult([{ id: 'i1', status: 'draft', orgId: 'org1', partnerId: 'p1', currencyCode: 'EUR' }]);
    await expect(svc.addCatalogLine('i1', 'cat-1', 1, actor))
      .rejects.toMatchObject({ code: 'NO_PRICE_FOR_CURRENCY', status: 409 });
    await expect(svc.addCatalogLine('i1', 'cat-1', 1, actor)).rejects.toBeInstanceOf(InvoiceServiceError);
    expect(values()).not.toHaveBeenCalled();
  });

  it('addCatalogLine maps a PRICE_NOT_REPRESENTABLE legacy row to a typed 409 (#3775 review #4) and inserts nothing', async () => {
    resolvePriceMock.mockRejectedValue(new CatalogServiceError('JPY 100.50 not representable', 409, 'PRICE_NOT_REPRESENTABLE'));
    queueResult([{ id: 'i1', status: 'draft', orgId: 'org1', partnerId: 'p1', currencyCode: 'JPY' }]);
    await expect(svc.addCatalogLine('i1', 'cat-1', 1, actor))
      .rejects.toMatchObject({ code: 'PRICE_NOT_REPRESENTABLE', status: 409 });
    expect(values()).not.toHaveBeenCalled();
  });

  const econUsd = (over: Partial<Awaited<ReturnType<typeof computeBundleEconomics>>> = {}) => ({
    currencyCode: 'USD', headlinePrice: '100.00', headlineGap: null, headlineGapMessage: null,
    priceBookComplete: true, marginAvailable: true,
    totalCost: '40.00', margin: '60.00', marginPct: 60, allocationTotal: '100.00',
    allocationAvailable: true, allocationMatchesHeadline: true, missingPriceComponentIds: [] as string[], ...over,
  });

  it('addBundleLine computes economics in the INVOICE currency and snapshots child cost only in the same currency', async () => {
    bundleEconMock.mockResolvedValue(econUsd());
    queueResult([{ id: 'i1', status: 'draft', orgId: 'org1', partnerId: 'p1', currencyCode: 'USD' }]);
    queueResult([{ name: 'Bundle', description: null }]);
    queueInsertAndRecompute({ id: 'parent', sortOrder: 1, unitPrice: '100.00', lineTotal: '100.00' });
    queueResult([
      { componentItemId: 'c-usd', quantity: '1.00', showOnInvoice: true, revenueAllocation: null, name: 'A', description: null, costBasis: '10.00', costCurrency: 'USD' },
      { componentItemId: 'c-cad', quantity: '1.00', showOnInvoice: false, revenueAllocation: null, name: 'B', description: null, costBasis: '30.00', costCurrency: 'CAD' },
    ]);
    queueResult([]); queueResult([]); // two child inserts
    queueResult([{ id: 'i1', status: 'draft', orgId: 'org1', partnerId: 'p1', amountPaid: '0.00', currencyCode: 'USD' }]);
    queueResult([{ lineTotal: '100.00', taxable: true, customerVisible: true }]);
    queueResult([{ taxExempt: false, taxRate: null }]);
    queueResult([]);

    const parent = await svc.addBundleLine('i1', 'b-1', 1, actor);
    expect(parent.id).toBe('parent');
    expect(computeBundleEconomics).toHaveBeenCalledWith(
      'b-1', 'USD', 'org1', expect.objectContaining({ partnerId: 'p1' }), expect.anything()
    );
    expect(values()).toHaveBeenCalledWith(expect.objectContaining({ catalogItemId: 'b-1', unitPrice: '100.00', costBasis: '40.00' }));
    expect(values()).toHaveBeenCalledWith(expect.objectContaining({ catalogItemId: 'c-usd', costBasis: '10.00' }));
    expect(values()).toHaveBeenCalledWith(expect.objectContaining({ catalogItemId: 'c-cad', costBasis: null }));
  });

  it('addBundleLine (JPY, #3775 review #4/#8): persists the whole-yen parent cost and snapshots a fractional-yen legacy child cost as null', async () => {
    bundleEconMock.mockResolvedValue(econUsd({ currencyCode: 'JPY', headlinePrice: '1000.00', totalCost: '51.00', margin: '949.00', marginPct: 94.9, allocationTotal: '0.00' }));
    queueResult([{ id: 'i1', status: 'draft', orgId: 'org1', partnerId: 'p1', currencyCode: 'JPY' }]);
    queueResult([{ name: 'Bundle', description: null }]);
    queueInsertAndRecompute({ id: 'parent', sortOrder: 1, unitPrice: '1000.00', lineTotal: '1000.00' });
    queueResult([
      { componentItemId: 'c-ok', quantity: '1.00', showOnInvoice: true, revenueAllocation: null, name: 'A', description: null, costBasis: '250.00', costCurrency: 'JPY' },
      { componentItemId: 'c-legacy', quantity: '0.50', showOnInvoice: true, revenueAllocation: null, name: 'B', description: null, costBasis: '100.50', costCurrency: 'JPY' },
    ]);
    queueResult([]); queueResult([]);
    queueResult([{ id: 'i1', status: 'draft', orgId: 'org1', partnerId: 'p1', amountPaid: '0.00', currencyCode: 'JPY' }]);
    queueResult([{ lineTotal: '1000.00', taxable: true, customerVisible: true }]);
    queueResult([{ taxExempt: false, taxRate: null }]);
    queueResult([]);

    await svc.addBundleLine('i1', 'b-1', 1, actor);
    expect(computeBundleEconomics).toHaveBeenCalledWith('b-1', 'JPY', 'org1', expect.anything(), expect.anything());
    expect(values()).toHaveBeenCalledWith(expect.objectContaining({ catalogItemId: 'b-1', unitPrice: '1000.00', costBasis: '51.00' }));
    expect(values()).toHaveBeenCalledWith(expect.objectContaining({ catalogItemId: 'c-ok', costBasis: '250.00' }));
    expect(values()).toHaveBeenCalledWith(expect.objectContaining({ catalogItemId: 'c-legacy', costBasis: null }));
  });

  it('addBundleLine (#3775 review #7): copies a component revenueAllocation only when its allocationCurrency is the INVOICE currency', async () => {
    bundleEconMock.mockResolvedValue(econUsd({ currencyCode: 'EUR', allocationAvailable: false, allocationTotal: null, allocationMatchesHeadline: false }));
    queueResult([{ id: 'i1', status: 'draft', orgId: 'org1', partnerId: 'p1', currencyCode: 'EUR' }]);
    queueResult([{ name: 'Bundle', description: null }]);
    queueInsertAndRecompute({ id: 'parent', sortOrder: 1, unitPrice: '100.00', lineTotal: '100.00' });
    queueResult([
      { componentItemId: 'c-eur', quantity: '1.00', showOnInvoice: true, revenueAllocation: '60.00', allocationCurrency: 'EUR', name: 'A', description: null, costBasis: '10.00', costCurrency: 'EUR' },
      { componentItemId: 'c-usd', quantity: '1.00', showOnInvoice: true, revenueAllocation: '40.00', allocationCurrency: 'USD', name: 'B', description: null, costBasis: '10.00', costCurrency: 'EUR' },
      { componentItemId: 'c-none', quantity: '1.00', showOnInvoice: true, revenueAllocation: null, allocationCurrency: null, name: 'C', description: null, costBasis: null, costCurrency: 'EUR' },
    ]);
    queueResult([]); queueResult([]); queueResult([]);
    queueResult([{ id: 'i1', status: 'draft', orgId: 'org1', partnerId: 'p1', amountPaid: '0.00', currencyCode: 'EUR' }]);
    queueResult([{ lineTotal: '100.00', taxable: true, customerVisible: true }]);
    queueResult([{ taxExempt: false, taxRate: null }]);
    queueResult([]);

    await svc.addBundleLine('i1', 'b-1', 1, actor);
    expect(values()).toHaveBeenCalledWith(expect.objectContaining({ catalogItemId: 'c-eur', revenueAllocation: '60.00' }));
    // USD allocation on an EUR invoice: unavailable (null), never relabelled as EUR 40.00
    expect(values()).toHaveBeenCalledWith(expect.objectContaining({ catalogItemId: 'c-usd', revenueAllocation: null }));
    expect(values()).toHaveBeenCalledWith(expect.objectContaining({ catalogItemId: 'c-none', revenueAllocation: null }));
  });

  it('addBundleLine throws NO_PRICE_FOR_CURRENCY (409) when the bundle has no headline price', async () => {
    bundleEconMock.mockResolvedValue(econUsd({ currencyCode: 'EUR', headlinePrice: null, priceBookComplete: false, totalCost: null }));
    queueResult([{ id: 'i1', status: 'draft', orgId: 'org1', partnerId: 'p1', currencyCode: 'EUR' }]);
    await expect(svc.addBundleLine('i1', 'b-1', 1, actor))
      .rejects.toMatchObject({ code: 'NO_PRICE_FOR_CURRENCY', status: 409 });
    expect(values()).not.toHaveBeenCalled();
  });

  // #3775 review #1: a legacy non-representable headline (JPY 100.50) is a GAP
  // for economics, not a raw CatalogServiceError. addBundleLine must map it to a
  // typed InvoiceServiceError so the route answers 409 (not 500) and the
  // operator gets the actionable "correct the JPY price" text.
  it('addBundleLine maps a PRICE_NOT_REPRESENTABLE headline gap to a typed 409 and inserts nothing', async () => {
    bundleEconMock.mockResolvedValue(econUsd({
      currencyCode: 'JPY', headlinePrice: null, priceBookComplete: false, totalCost: null,
      headlineGap: 'PRICE_NOT_REPRESENTABLE',
      headlineGapMessage: 'Price-book price 100.50 for "Kit" is not representable in JPY — correct the JPY price before using this item',
    }));
    queueResult([{ id: 'i1', status: 'draft', orgId: 'org1', partnerId: 'p1', currencyCode: 'JPY' }]);
    await expect(svc.addBundleLine('i1', 'b-1', 1, actor)).rejects.toMatchObject({
      code: 'PRICE_NOT_REPRESENTABLE', status: 409,
      message: expect.stringContaining('not representable in JPY'),
    });
    expect(values()).not.toHaveBeenCalled();
  });

  it('addBundleLine throws PRICE_BOOK_INCOMPLETE (409) when a component lacks a price and inserts nothing', async () => {
    bundleEconMock.mockResolvedValue(econUsd({ currencyCode: 'EUR', priceBookComplete: false, totalCost: null, missingPriceComponentIds: ['c-2', 'c-3'] }));
    queueResult([{ id: 'i1', status: 'draft', orgId: 'org1', partnerId: 'p1', currencyCode: 'EUR' }]);
    await expect(svc.addBundleLine('i1', 'b-1', 1, actor))
      .rejects.toMatchObject({ code: 'PRICE_BOOK_INCOMPLETE', status: 409, message: 'Bundle has no EUR price for 2 component(s)' });
    expect(values()).not.toHaveBeenCalled();
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
    queueResult([{ id: 'i1', status: 'draft', orgId: 'org1', partnerId: 'p1', currencyCode: 'USD' }]);
    queueResult([{ id: 'ct1', orgId: 'org1', currencyCode: 'USD' }]); // #3778: parent contract locked FOR UPDATE
    queueInsertAndRecompute({ id: 'l1', sourceType: 'contract', sourceId: null, catalogItemId: null,
      description: 'Managed services (flat)', quantity: '1', unitPrice: '500.00',
      lineTotal: '500.00', taxable: false, customerVisible: true });

    const { line, pricedFrom } = await svc.addContractLine('i1', {
      description: 'Managed services (flat)', quantity: '1', unitPrice: '500.00',
      taxable: false, catalogItemId: null, sourceId: null, contractId: 'ct1'
    }, actor);

    expect(line.sourceType).toBe('contract');
    expect(line.lineTotal).toBe('500.00');
    expect(pricedFrom).toBe('contract_snapshot');
    expect(resolvePrice).not.toHaveBeenCalled();
  });

  it('catalog path: resolves price via resolvePrice and uses its unitPrice, taxable, costBasis (not caller-supplied)', async () => {
    const actor = { userId: 'u1', partnerId: 'p1', accessibleOrgIds: ['org1'] };
    // resolvePrice returns a known price that differs from what caller would supply
    resolvePriceMock.mockResolvedValue(resolvedUsd({ unitPrice: '99.00', costBasis: '45.00' }));
    queueResult([{ id: 'i1', status: 'draft', orgId: 'org1', partnerId: 'p1', currencyCode: 'USD' }]);
    queueResult([{ id: 'ct1', orgId: 'org1', currencyCode: 'USD' }]); // #3778: parent contract locked FOR UPDATE — B2 guard reads its currency
    queueInsertAndRecompute({ id: 'l2', sourceType: 'contract', sourceId: 'cl-1', catalogItemId: 'cat-1',
      description: 'Managed endpoint', quantity: '3', unitPrice: '99.00',
      lineTotal: '297.00', taxable: true, customerVisible: true });

    const { line, pricedFrom } = await svc.addContractLine('i1', {
      description: 'Managed endpoint',
      quantity: '3',
      unitPrice: '999.00', // caller-supplied price — must be ignored on catalog path
      taxable: false,      // caller-supplied taxable — must be overridden by resolvePrice
      catalogItemId: 'cat-1',
      sourceId: 'cl-1',
      contractId: 'ct1',
    }, actor);

    // resolvePrice must have been called in the INVOICE's currency, on the
    // locked tx, with the correct org + actor (wave 3: price-book resolution).
    expect(resolvePrice).toHaveBeenCalledWith(
      'cat-1', 'USD', 'org1',
      expect.objectContaining({ userId: 'u1', partnerId: 'p1', accessibleOrgIds: ['org1'] }),
      expect.anything()
    );
    // Line uses the resolved price, not the caller-supplied 999.00
    expect(line.unitPrice).toBe('99.00');
    expect(line.lineTotal).toBe('297.00');
    expect(pricedFrom).toBe('price_book');
    const valuesMock = (db as unknown as { values: Mock }).values;
    expect(valuesMock).toHaveBeenCalledWith(expect.objectContaining({ unitPrice: '99.00', costBasis: '45.00', taxable: true }));
  });

  it('catalog path: a PRICE_NOT_REPRESENTABLE legacy row (#3775 review #4) also falls back to the contract snapshot — the bad row never lands', async () => {
    const actor = { userId: 'u1', partnerId: 'p1', accessibleOrgIds: ['org1'] };
    resolvePriceMock.mockRejectedValue(new CatalogServiceError('JPY 100.50 not representable', 409, 'PRICE_NOT_REPRESENTABLE'));
    queueResult([{ id: 'i1', status: 'draft', orgId: 'org1', partnerId: 'p1', currencyCode: 'JPY' }]);
    queueResult([{ id: 'ct1', orgId: 'org1', currencyCode: 'JPY' }]); // #3778: parent contract locked FOR UPDATE
    queueInsertAndRecompute({ id: 'l3', sourceType: 'contract', sourceId: 'cl-1', catalogItemId: 'cat-1',
      description: 'Managed endpoint', quantity: '2', unitPrice: '100.00', lineTotal: '200.00', taxable: true, customerVisible: true });

    const { pricedFrom } = await svc.addContractLine('i1', {
      description: 'Managed endpoint', quantity: '2', unitPrice: '100', taxable: true,
      catalogItemId: 'cat-1', sourceId: 'cl-1', contractId: 'ct1',
    }, actor);

    expect(pricedFrom).toBe('contract_snapshot');
    const valuesMock = (db as unknown as { values: Mock }).values;
    expect(valuesMock).toHaveBeenCalledWith(expect.objectContaining({ unitPrice: '100.00', costBasis: null, catalogItemId: 'cat-1' }));
  });

  it('catalog path: a price-book gap falls back to the contract line snapshot (pricedFrom contract_snapshot, costBasis null)', async () => {
    const actor = { userId: 'u1', partnerId: 'p1', accessibleOrgIds: ['org1'] };
    resolvePriceMock.mockRejectedValue(new CatalogServiceError('No EUR price', 409, 'NO_PRICE_FOR_CURRENCY'));
    queueResult([{ id: 'i1', status: 'draft', orgId: 'org1', partnerId: 'p1', currencyCode: 'EUR' }]);
    queueResult([{ id: 'ct1', orgId: 'org1', currencyCode: 'EUR' }]); // #3778: parent contract locked FOR UPDATE — B2 guard: the snapshot is in the invoice currency
    queueInsertAndRecompute({ id: 'l3', sourceType: 'contract', sourceId: 'cl-1', catalogItemId: 'cat-1',
      description: 'Managed endpoint', quantity: '2', unitPrice: '80.00', lineTotal: '160.00', taxable: true, customerVisible: true });

    const { line, pricedFrom } = await svc.addContractLine('i1', {
      description: 'Managed endpoint', quantity: '2', unitPrice: '80', taxable: true,
      catalogItemId: 'cat-1', sourceId: 'cl-1', contractId: 'ct1',
    }, actor);

    expect(pricedFrom).toBe('contract_snapshot');
    expect(line.unitPrice).toBe('80.00');
    const valuesMock = (db as unknown as { values: Mock }).values;
    expect(valuesMock).toHaveBeenCalledWith(expect.objectContaining({
      unitPrice: '80.00', taxable: true, costBasis: null, catalogItemId: 'cat-1', lineTotal: '160.00'
    }));
  });

  it('catalog path: a non-gap CatalogServiceError still propagates (no snapshot fallback)', async () => {
    const actor = { userId: 'u1', partnerId: 'p1', accessibleOrgIds: ['org1'] };
    resolvePriceMock.mockRejectedValue(new CatalogServiceError('Catalog item not found', 404, 'ITEM_NOT_FOUND'));
    queueResult([{ id: 'i1', status: 'draft', orgId: 'org1', partnerId: 'p1', currencyCode: 'EUR' }]);
    queueResult([{ id: 'ct1', orgId: 'org1', currencyCode: 'EUR' }]); // #3778: parent contract locked FOR UPDATE
    await expect(
      svc.addContractLine('i1', { description: 'x', quantity: '1', unitPrice: '80.00', taxable: true, catalogItemId: 'cat-1', contractId: 'ct1' }, actor)
    ).rejects.toMatchObject({ status: 404, code: 'ITEM_NOT_FOUND' });
    expect((db as unknown as { values: Mock }).values).not.toHaveBeenCalled();
  });

  it('throws CURRENCY_MISMATCH (400) when the source contract currency differs from the invoice header', async () => {
    const actor = { userId: 'u1', partnerId: 'p1', accessibleOrgIds: ['org1'] };
    queueResult([{ id: 'i1', status: 'draft', orgId: 'org1', partnerId: 'p1', currencyCode: 'GBP' }]);
    queueResult([{ id: 'ct1', orgId: 'org1', currencyCode: 'EUR' }]); // #3778: parent contract locked FOR UPDATE
    await expect(
      svc.addContractLine('i1', {
        description: 'Managed services (flat)', quantity: '1', unitPrice: '500.00',
        taxable: false, catalogItemId: null, sourceId: 'cl-1', contractId: 'ct1'
      }, actor)
    ).rejects.toMatchObject({ code: 'CURRENCY_MISMATCH', status: 400 });
  });

  it('non-catalog path: throws INVALID_AMOUNT (400) when unitPrice is negative', async () => {
    const actor = { userId: 'u1', partnerId: 'p1', accessibleOrgIds: ['org1'] };
    queueResult([{ id: 'i1', status: 'draft', orgId: 'org1', partnerId: 'p1', currencyCode: 'USD' }]);
    queueResult([{ id: 'ct1', orgId: 'org1', currencyCode: 'USD' }]); // #3778: parent contract locked FOR UPDATE
    await expect(
      svc.addContractLine('i1', { description: 'x', quantity: '1', unitPrice: '-5.00', taxable: false, contractId: 'ct1' }, actor)
    ).rejects.toMatchObject({ code: 'INVALID_AMOUNT', status: 400 });
  });

  it('non-catalog path: throws INVALID_AMOUNT (400) when quantity is negative', async () => {
    const actor = { userId: 'u1', partnerId: 'p1', accessibleOrgIds: ['org1'] };
    queueResult([{ id: 'i1', status: 'draft', orgId: 'org1', partnerId: 'p1', currencyCode: 'USD' }]);
    queueResult([{ id: 'ct1', orgId: 'org1', currencyCode: 'USD' }]); // #3778: parent contract locked FOR UPDATE
    await expect(
      svc.addContractLine('i1', { description: 'x', quantity: '-2', unitPrice: '10.00', taxable: false, contractId: 'ct1' }, actor)
    ).rejects.toMatchObject({ code: 'INVALID_AMOUNT', status: 400 });
  });

  it('rejects a non-draft invoice with NOT_A_DRAFT (409)', async () => {
    queueResult([{ id: 'i1', status: 'sent', orgId: 'org1', partnerId: 'p1' }]);
    const actor = { userId: 'u1', partnerId: 'p1', accessibleOrgIds: ['org1'] };
    await expect(
      svc.addContractLine('i1', { description: 'x', quantity: '1', unitPrice: '100.00', taxable: false, contractId: 'ct1' }, actor)
    ).rejects.toMatchObject({ code: 'NOT_A_DRAFT', status: 409 });
  });

  it('denies an actor without access to the invoice org (ORG_DENIED 403)', async () => {
    queueResult([{ id: 'i1', status: 'draft', orgId: 'org1', partnerId: 'p1' }]);
    const actor = { userId: 'u1', partnerId: 'p1', accessibleOrgIds: ['other-org'] };
    await expect(
      svc.addContractLine('i1', { description: 'x', quantity: '1', unitPrice: '100.00', taxable: false, contractId: 'ct1' }, actor)
    ).rejects.toMatchObject({ code: 'ORG_DENIED', status: 403 });
  });
});

describe('changeInvoiceCurrency (draft currency immutability, #3774)', () => {
  beforeEach(() => { results.length = 0; vi.clearAllMocks(); });
  const actor = { userId: 'u1', partnerId: 'p1', accessibleOrgIds: ['org1'] };

  it('rejects a non-draft invoice with NOT_A_DRAFT (409)', async () => {
    // locked invoice select → issued row
    queueResult([{ id: 'i1', status: 'sent', orgId: 'org1', partnerId: 'p1', currencyCode: 'USD' }]);
    await expect(
      svc.changeInvoiceCurrency('i1', { currencyCode: 'EUR', clearLines: false }, actor)
    ).rejects.toMatchObject({ code: 'NOT_A_DRAFT', status: 409 });
  });

  it('throws INVOICE_NOT_FOUND (404) when the invoice is absent', async () => {
    queueResult([]);
    await expect(
      svc.changeInvoiceCurrency('missing', { currencyCode: 'EUR', clearLines: false }, actor)
    ).rejects.toMatchObject({ code: 'INVOICE_NOT_FOUND', status: 404 });
  });

  it('refuses to restamp over monetary lines without clearLines (CURRENCY_LOCKED 409)', async () => {
    queueResult([{ id: 'i1', status: 'draft', orgId: 'org1', partnerId: 'p1', currencyCode: 'USD', taxRate: null, amountPaid: '0.00' }]);
    queueResult([{ id: 'l1' }]); // one monetary line
    await expect(
      svc.changeInvoiceCurrency('i1', { currencyCode: 'EUR', clearLines: false }, actor)
    ).rejects.toMatchObject({ code: 'CURRENCY_LOCKED', status: 409 });
    const deleteMock = (db as unknown as { delete: Mock }).delete;
    expect(deleteMock).not.toHaveBeenCalled();
  });

  it('restamps a line-less draft and returns the new currency', async () => {
    queueResult([{ id: 'i1', status: 'draft', orgId: 'org1', partnerId: 'p1', currencyCode: 'USD', taxRate: null, amountPaid: '0.00' }]);
    queueResult([]); // no lines
    queueResult([{ id: 'i1', status: 'draft', orgId: 'org1', partnerId: 'p1', currencyCode: 'EUR' }]); // update returning
    const updated = await svc.changeInvoiceCurrency('i1', { currencyCode: 'EUR', clearLines: false }, actor);
    expect(updated.currencyCode).toBe('EUR');
    const setMock = (db as unknown as { set: Mock }).set;
    expect(setMock).toHaveBeenCalledWith(expect.objectContaining({ currencyCode: 'EUR' }));
    const deleteMock = (db as unknown as { delete: Mock }).delete;
    expect(deleteMock).not.toHaveBeenCalled();
  });

  it('clearLines: true deletes the lines and restamps atomically', async () => {
    queueResult([{ id: 'i1', status: 'draft', orgId: 'org1', partnerId: 'p1', currencyCode: 'USD', taxRate: null, amountPaid: '0.00' }]);
    queueResult([{ id: 'l1' }, { id: 'l2' }]); // two monetary lines
    queueResult([]); // delete
    queueResult([{ id: 'i1', status: 'draft', orgId: 'org1', partnerId: 'p1', currencyCode: 'JPY', total: '0.00' }]); // update returning
    const updated = await svc.changeInvoiceCurrency('i1', { currencyCode: 'JPY', clearLines: true }, actor);
    expect(updated.currencyCode).toBe('JPY');
    const deleteMock = (db as unknown as { delete: Mock }).delete;
    expect(deleteMock).toHaveBeenCalledTimes(1);
    const setMock = (db as unknown as { set: Mock }).set;
    expect(setMock).toHaveBeenCalledWith(expect.objectContaining({
      currencyCode: 'JPY', subtotal: '0.00', taxTotal: '0.00', total: '0.00', balance: '0.00'
    }));
  });

  it('same-currency change is a no-op (returns the row untouched)', async () => {
    queueResult([{ id: 'i1', status: 'draft', orgId: 'org1', partnerId: 'p1', currencyCode: 'EUR', taxRate: null, amountPaid: '0.00' }]);
    const updated = await svc.changeInvoiceCurrency('i1', { currencyCode: 'EUR', clearLines: true }, actor);
    expect(updated.currencyCode).toBe('EUR');
    const setMock = (db as unknown as { set: Mock }).set;
    expect(setMock).not.toHaveBeenCalled();
    const deleteMock = (db as unknown as { delete: Mock }).delete;
    expect(deleteMock).not.toHaveBeenCalled();
  });

  it('denies an actor without access to the invoice org (ORG_DENIED 403)', async () => {
    queueResult([{ id: 'i1', status: 'draft', orgId: 'org1', partnerId: 'p1', currencyCode: 'USD', taxRate: null, amountPaid: '0.00' }]);
    const denied = { userId: 'u1', partnerId: 'p1', accessibleOrgIds: ['other-org'] };
    await expect(
      svc.changeInvoiceCurrency('i1', { currencyCode: 'EUR', clearLines: false }, denied)
    ).rejects.toMatchObject({ code: 'ORG_DENIED', status: 403 });
  });
});

describe('assembly consumers — currency override + blocked-by-currency groups (#3776)', () => {
  beforeEach(() => { results.length = 0; vi.clearAllMocks(); });
  const actor = { userId: 'u1', partnerId: 'p1', accessibleOrgIds: ['org1'] };
  const spec = (lineTotal: string, sourceId = 'te1'): DraftLineSpec => ({
    sourceType: 'time_entry', sourceId, catalogItemId: null, ticketId: null, description: 'Work',
    quantity: '1.00', unitPrice: lineTotal, costBasis: null, taxable: false, customerVisible: true,
    lineTotal, isUnapprovedTime: false
  });
  const empty = () => ({ included: [], blockedByCurrency: {}, missingRate: [] });
  const gap = (sourceId: string, quantity = '1.50') => ({
    sourceType: 'time_entry' as const, sourceId, ticketId: 'tk1', description: 'Work', quantity, currencyCode: 'USD'
  });
  const draftRow = (currencyCode = 'USD') => ({
    id: 'inv1', partnerId: 'p1', orgId: 'org1', siteId: null, status: 'draft', currencyCode,
    taxRate: null, amountPaid: '0.00', subtotal: '0.00', total: '0.00', balance: '0.00'
  });
  const queueTail = (currencyCode = 'USD') => {
    queueResult([]);                  // materializeLines insert
    queueResult([draftRow(currencyCode)]); // recompute: owned invoice
    queueResult([]);                  // recompute: lines
    queueResult([]);                  // recompute: org tax rate
    queueResult([]);                  // recompute: update
    queueResult([draftRow(currencyCode)]); // getInvoice: owned invoice
    queueResult([]);                  // getInvoice: lines
    queueResult([]);                  // getInvoice: grouped evidence counts
    queueResult([]);                  // getInvoice: stripe connection
  };

  it('summarizeBlocked counts and sums per currency at that currency\'s minor unit', () => {
    const out = svc.summarizeBlocked({
      EUR: [spec('100.00'), spec('0.50', 'te2')],
      JPY: [spec('330.00', 'te3')],
      UNKNOWN: [spec('2.50', 'te4')],
    });
    expect(out).toEqual([
      { currencyCode: 'EUR', count: 2, amount: '100.50' },
      { currencyCode: 'JPY', count: 1, amount: '330.00' },
      { currencyCode: 'UNKNOWN', count: 1, amount: '2.50' },
    ]);
    expect(svc.summarizeBlocked({})).toEqual([]);
  });

  it('(a) org: every gathered row blocked → ALL_BLOCKED_BY_CURRENCY 409 with a summary, transient draft deleted', async () => {
    queueResult([{ currencyCode: 'USD' }]);   // org currency
    queueResult([draftRow('USD')]);            // draft insert returning
    queueResult([]);                           // delete transient draft
    (gatherOrgTimeEntries as Mock).mockResolvedValue({ included: [], blockedByCurrency: { EUR: [spec('100.00')] }, missingRate: [] });
    (gatherOrgParts as Mock).mockResolvedValue(empty());
    await expect(
      svc.assembleDraftFromOrg({ orgId: 'org1', from: '2026-06-01', to: '2026-06-30' }, actor)
    ).rejects.toMatchObject({
      code: 'ALL_BLOCKED_BY_CURRENCY', status: 409,
      details: { blockedByCurrency: [{ currencyCode: 'EUR', count: 1, amount: '100.00' }] }
    });
    const deleteMock = (db as unknown as { delete: Mock }).delete;
    expect(deleteMock).toHaveBeenCalledTimes(1);
    // No lines were materialized (the only insert is the draft header).
    const insertMock = (db as unknown as { insert: Mock }).insert;
    expect(insertMock).toHaveBeenCalledTimes(1);
  });

  it('(b) org: nothing gathered at all → NOTHING_TO_INVOICE (no details)', async () => {
    queueResult([{ currencyCode: 'USD' }]);
    queueResult([draftRow('USD')]);
    queueResult([]);
    (gatherOrgTimeEntries as Mock).mockResolvedValue(empty());
    (gatherOrgParts as Mock).mockResolvedValue(empty());
    const err = await svc.assembleDraftFromOrg({ orgId: 'org1', from: '2026-06-01', to: '2026-06-30' }, actor).catch((e) => e);
    expect(err).toBeInstanceOf(InvoiceServiceError);
    expect(err).toMatchObject({ code: 'NOTHING_TO_INVOICE', status: 409 });
    expect(err.details).toBeUndefined();
  });

  it('(c) org: currencyCode override stamps the draft and drives the gathers (old-currency draft path, spec §7)', async () => {
    queueResult([{ currencyCode: 'GBP' }]);   // org is GBP now
    queueResult([draftRow('EUR')]);            // insert returning (header EUR)
    queueTail('EUR');
    (gatherOrgTimeEntries as Mock).mockResolvedValue({ included: [spec('100.00')], blockedByCurrency: {}, missingRate: [] });
    (gatherOrgParts as Mock).mockResolvedValue(empty());
    const out = await svc.assembleDraftFromOrg({ orgId: 'org1', from: '2026-06-01', to: '2026-06-30', currencyCode: 'EUR' }, actor);
    const valuesMock = (db as unknown as { values: Mock }).values;
    expect(valuesMock.mock.calls[0]![0]).toEqual(expect.objectContaining({ currencyCode: 'EUR', orgId: 'org1', status: 'draft' }));
    expect(gatherOrgTimeEntries).toHaveBeenCalledWith('org1', expect.any(Date), expect.any(Date), 'EUR');
    expect(gatherOrgParts).toHaveBeenCalledWith('org1', expect.any(Date), expect.any(Date), 'EUR');
    expect(out.blockedByCurrency).toEqual([]);
    expect(out.invoice.currencyCode).toBe('EUR');
  });

  it('(c\') org: no override → the org currency is the header', async () => {
    queueResult([{ currencyCode: 'GBP' }]);
    queueResult([draftRow('GBP')]);
    queueTail('GBP');
    (gatherOrgTimeEntries as Mock).mockResolvedValue({ included: [spec('100.00')], blockedByCurrency: {}, missingRate: [] });
    (gatherOrgParts as Mock).mockResolvedValue(empty());
    await svc.assembleDraftFromOrg({ orgId: 'org1', from: '2026-06-01', to: '2026-06-30' }, actor);
    const valuesMock = (db as unknown as { values: Mock }).values;
    expect(valuesMock.mock.calls[0]![0]).toEqual(expect.objectContaining({ currencyCode: 'GBP' }));
    expect(gatherOrgTimeEntries).toHaveBeenCalledWith('org1', expect.any(Date), expect.any(Date), 'GBP');
  });

  it('(d) org: mixed → only included specs materialize; blocked groups come back summarized, never as lines', async () => {
    queueResult([{ currencyCode: 'USD' }]);
    queueResult([draftRow('USD')]);
    queueTail('USD');
    (gatherOrgTimeEntries as Mock).mockResolvedValue({
      included: [spec('50.00', 'te-usd')], blockedByCurrency: { EUR: [spec('100.00', 'te-eur')] }, missingRate: []
    });
    (gatherOrgParts as Mock).mockResolvedValue({
      included: [], blockedByCurrency: { EUR: [spec('25.00', 'part-eur')], JPY: [spec('330.00', 'part-jpy')] }, missingRate: []
    });
    const out = await svc.assembleDraftFromOrg({ orgId: 'org1', from: '2026-06-01', to: '2026-06-30' }, actor);
    expect(out.blockedByCurrency).toEqual([
      { currencyCode: 'EUR', count: 2, amount: '125.00' },
      { currencyCode: 'JPY', count: 1, amount: '330.00' },
    ]);
    const valuesMock = (db as unknown as { values: Mock }).values;
    // calls[0] = draft header; calls[1] = materialized lines
    const lines = valuesMock.mock.calls[1]![0] as Array<{ sourceId: string }>;
    expect(lines.map((l) => l.sourceId)).toEqual(['te-usd']);
    const deleteMock = (db as unknown as { delete: Mock }).delete;
    expect(deleteMock).not.toHaveBeenCalled();
  });

  it('(e) ticket: all blocked → ALL_BLOCKED_BY_CURRENCY with details, draft deleted', async () => {
    queueResult([{ orgId: 'org1' }]);          // ticket
    queueResult([{ currencyCode: 'GBP' }]);    // org currency
    queueResult([draftRow('GBP')]);            // insert returning
    queueResult([]);                           // delete
    (gatherTicketBillables as Mock).mockResolvedValue({ included: [], blockedByCurrency: { EUR: [spec('100.00')] }, missingRate: [] });
    await expect(svc.assembleDraftFromTicket('t1', actor)).rejects.toMatchObject({
      code: 'ALL_BLOCKED_BY_CURRENCY', status: 409,
      details: { blockedByCurrency: [{ currencyCode: 'EUR', count: 1, amount: '100.00' }] }
    });
    expect(gatherTicketBillables).toHaveBeenCalledWith('t1', 'GBP');
    const deleteMock = (db as unknown as { delete: Mock }).delete;
    expect(deleteMock).toHaveBeenCalledTimes(1);
  });

  it('(f) ticket: currencyCode override stamps the draft and drives the gather', async () => {
    queueResult([{ orgId: 'org1' }]);
    queueResult([{ currencyCode: 'GBP' }]);
    queueResult([draftRow('EUR')]);
    queueTail('EUR');
    (gatherTicketBillables as Mock).mockResolvedValue({ included: [spec('100.00')], blockedByCurrency: {}, missingRate: [] });
    const out = await svc.assembleDraftFromTicket('t1', actor, { currencyCode: 'EUR' });
    const valuesMock = (db as unknown as { values: Mock }).values;
    expect(valuesMock.mock.calls[0]![0]).toEqual(expect.objectContaining({ currencyCode: 'EUR', orgId: 'org1' }));
    expect(gatherTicketBillables).toHaveBeenCalledWith('t1', 'EUR');
    expect(out.blockedByCurrency).toEqual([]);
  });

  it('(h) org: only rate-less billable time → ALL_MISSING_RATE 409 listing the entries; nothing billed at zero, draft deleted (review #1)', async () => {
    queueResult([{ currencyCode: 'USD' }]);
    queueResult([draftRow('USD')]);
    queueResult([]);                           // delete transient draft
    (gatherOrgTimeEntries as Mock).mockResolvedValue({ included: [], blockedByCurrency: {}, missingRate: [gap('te-norate')] });
    (gatherOrgParts as Mock).mockResolvedValue(empty());
    const err = await svc.assembleDraftFromOrg({ orgId: 'org1', from: '2026-06-01', to: '2026-06-30' }, actor).catch((e) => e);
    expect(err).toBeInstanceOf(InvoiceServiceError);
    expect(err).toMatchObject({
      code: 'ALL_MISSING_RATE', status: 409,
      details: { missingRate: [{ timeEntryId: 'te-norate', ticketId: 'tk1', description: 'Work', hours: '1.50' }] }
    });
    expect(err.message).toContain('no hourly rate in USD');
    const insertMock = (db as unknown as { insert: Mock }).insert;
    expect(insertMock).toHaveBeenCalledTimes(1); // draft header only — no zero line
    const deleteMock = (db as unknown as { delete: Mock }).delete;
    expect(deleteMock).toHaveBeenCalledTimes(1);
  });

  it('(i) org: rate-less time alongside an included row → response.missingRate lists it and it is never materialized', async () => {
    queueResult([{ currencyCode: 'USD' }]);
    queueResult([draftRow('USD')]);
    queueTail('USD');
    (gatherOrgTimeEntries as Mock).mockResolvedValue({
      included: [spec('50.00', 'te-usd')], blockedByCurrency: {}, missingRate: [gap('te-norate', '0.25')]
    });
    (gatherOrgParts as Mock).mockResolvedValue(empty());
    const out = await svc.assembleDraftFromOrg({ orgId: 'org1', from: '2026-06-01', to: '2026-06-30' }, actor);
    expect(out.missingRate).toEqual([{ timeEntryId: 'te-norate', ticketId: 'tk1', description: 'Work', hours: '0.25' }]);
    expect(out.blockedByCurrency).toEqual([]);
    const valuesMock = (db as unknown as { values: Mock }).values;
    const lines = valuesMock.mock.calls[1]![0] as Array<{ sourceId: string }>;
    expect(lines.map((l) => l.sourceId)).toEqual(['te-usd']);
  });

  it('(j) ticket: blocked currency + rate-less time, nothing included → ALL_BLOCKED_BY_CURRENCY carries both groups', async () => {
    queueResult([{ orgId: 'org1' }]);
    queueResult([{ currencyCode: 'GBP' }]);
    queueResult([draftRow('GBP')]);
    queueResult([]);
    (gatherTicketBillables as Mock).mockResolvedValue({
      included: [], blockedByCurrency: { EUR: [spec('100.00')] }, missingRate: [gap('te-norate')]
    });
    await expect(svc.assembleDraftFromTicket('t1', actor)).rejects.toMatchObject({
      code: 'ALL_BLOCKED_BY_CURRENCY', status: 409,
      details: {
        blockedByCurrency: [{ currencyCode: 'EUR', count: 1, amount: '100.00' }],
        missingRate: [{ timeEntryId: 'te-norate', ticketId: 'tk1', description: 'Work', hours: '1.50' }]
      }
    });
  });

  it('(g) ticket: nothing gathered → NOTHING_TO_INVOICE', async () => {
    queueResult([{ orgId: 'org1' }]);
    queueResult([{ currencyCode: 'GBP' }]);
    queueResult([draftRow('GBP')]);
    queueResult([]);
    (gatherTicketBillables as Mock).mockResolvedValue(empty());
    await expect(svc.assembleDraftFromTicket('t1', actor)).rejects.toMatchObject({ code: 'NOTHING_TO_INVOICE', status: 409 });
  });
});

describe('getInvoice — Stripe account currency exposure (#3777)', () => {
  beforeEach(() => { results.length = 0; vi.clearAllMocks(); });
  const actor = { userId: 'u1', partnerId: 'p1', accessibleOrgIds: ['org1'] };

  it('exposes the cached account currency and a warn-dont-block mismatch warning when connected', async () => {
    queueResult([{ id: 'i1', status: 'sent', orgId: 'org1', partnerId: 'p1', currencyCode: 'EUR' }]); // invoice
    queueResult([]); // lines
    queueResult([]); // grouped evidence counts
    queueResult([{ partnerId: 'p1', status: 'connected', defaultCurrency: 'USD', accountCountry: 'US' }]); // stripe_connect_accounts
    queueResult([]); // accounting_entity_mappings (no QuickBooks mapping row)
    const out = await svc.getInvoice('i1', actor);
    expect(out.stripeConnected).toBe(true);
    expect(out.stripeAccountCurrency).toBe('USD');
    expect(out.currencyWarning).toMatchObject({
      code: 'CURRENCY_DIFFERS_FROM_STRIPE_ACCOUNT', documentCurrency: 'EUR', accountCurrency: 'USD',
    });
  });

  it('no warning when the account settles in the document currency', async () => {
    queueResult([{ id: 'i1', status: 'sent', orgId: 'org1', partnerId: 'p1', currencyCode: 'EUR' }]);
    queueResult([]);
    queueResult([]);
    queueResult([{ partnerId: 'p1', status: 'connected', defaultCurrency: 'EUR', accountCountry: 'DE' }]);
    queueResult([]);
    const out = await svc.getInvoice('i1', actor);
    expect(out.stripeAccountCurrency).toBe('EUR');
    expect(out.currencyWarning).toBeNull();
  });

  it('connected but the account currency was never cached (pre-wave-5 row): explicit UNKNOWN warning, not "no warning" (review F6)', async () => {
    queueResult([{ id: 'i1', status: 'sent', orgId: 'org1', partnerId: 'p1', currencyCode: 'EUR' }]);
    queueResult([]);
    queueResult([]);
    queueResult([{ partnerId: 'p1', status: 'connected', defaultCurrency: null, accountCountry: null }]);
    queueResult([]);
    const out = await svc.getInvoice('i1', actor);
    expect(out.stripeConnected).toBe(true);
    expect(out.stripeAccountCurrency).toBeNull();
    expect(out.currencyWarning).toMatchObject({
      code: 'STRIPE_ACCOUNT_CURRENCY_UNKNOWN', documentCurrency: 'EUR', accountCurrency: null,
    });
  });

  it('both null when the partner is not connected', async () => {
    queueResult([{ id: 'i1', status: 'sent', orgId: 'org1', partnerId: 'p1', currencyCode: 'EUR' }]);
    queueResult([]);
    queueResult([]);
    queueResult([]); // no connection row
    queueResult([]);
    const out = await svc.getInvoice('i1', actor);
    expect(out.stripeConnected).toBe(false);
    expect(out.stripeAccountCurrency).toBeNull();
    expect(out.currencyWarning).toBeNull();
  });
});

describe('getInvoice — accountingSync (QuickBooks Phase C, Task 5)', () => {
  beforeEach(() => { results.length = 0; vi.clearAllMocks(); });
  const partnerActor = { userId: 'u1', partnerId: 'p1', accessibleOrgIds: ['org1'] };

  it('surfaces the QuickBooks mapping row when a partner-scoped read can see it', async () => {
    queueResult([{ id: 'i1', status: 'sent', orgId: 'org1', partnerId: 'p1', currencyCode: 'USD' }]); // invoice
    queueResult([]); // lines
    queueResult([]); // grouped evidence counts
    queueResult([]); // stripe connection (not connected)
    queueResult([{
      syncStatus: 'synced',
      lastSyncedAt: new Date('2026-09-01T12:00:00.000Z'),
      lastError: null,
      remoteDocNumber: '1042',
    }]); // accounting_entity_mappings ⋈ accounting_connections
    const out = await svc.getInvoice('i1', partnerActor);
    expect(out.accountingSync).toEqual({
      provider: 'quickbooks',
      syncStatus: 'synced',
      lastSyncedAt: '2026-09-01T12:00:00.000Z',
      lastError: null,
      remoteDocNumber: '1042',
      remoteDeleted: false,
    });
  });

  // #4544: markInvoiceDeletedRemotely (accountingPaymentPull.ts) writes this
  // exact lastError; getInvoiceAccountingSync must surface it as a typed
  // boolean rather than making the web layer string-match lastError.
  it('surfaces remoteDeleted: true when the mapping carries the remote-deleted marker', async () => {
    queueResult([{ id: 'i1', status: 'sent', orgId: 'org1', partnerId: 'p1', currencyCode: 'USD' }]);
    queueResult([]);
    queueResult([]);
    queueResult([]);
    queueResult([{
      syncStatus: 'error',
      lastSyncedAt: null,
      lastError: 'Deleted in QuickBooks',
      remoteDocNumber: null,
    }]);
    const out = await svc.getInvoice('i1', partnerActor);
    expect(out.accountingSync).toMatchObject({ syncStatus: 'error', remoteDeleted: true });
  });

  it('is null when the mapping read returns no row (never connected, or RLS hides a partner-axis table from an org-scoped read) — fail closed, no special-casing', async () => {
    queueResult([{ id: 'i1', status: 'sent', orgId: 'org1', partnerId: 'p1', currencyCode: 'USD' }]);
    queueResult([]);
    queueResult([]);
    queueResult([]);
    // Simulates an org-scoped ambient RLS context on `accounting_entity_mappings`
    // (a partner-axis table): the row exists, but the caller's context can't
    // see it, so the query returns zero rows exactly like "no mapping at all".
    queueResult([]);
    const out = await svc.getInvoice('i1', partnerActor);
    expect(out.accountingSync).toBeNull();
  });
});

describe('getInvoice — billing evidence counts (#3205 W07)', () => {
  beforeEach(() => { results.length = 0; vi.clearAllMocks(); });

  it('#3205 W07 ruling 3: getInvoice adds deviceCount per line; listInvoices does NOT', async () => {
    const actor = { userId: 'u1', partnerId: 'p1', accessibleOrgIds: ['org1'] };
    queueResult([{ id: 'i1', status: 'sent', orgId: 'org1', partnerId: 'p1', currencyCode: 'USD' }]);
    queueResult([{ id: 'l1' }, { id: 'l2' }]);
    queueResult([{ lineId: 'l1', n: 3 }]);
    queueResult([]); // Stripe connection
    queueResult([]); // accounting sync
    queueResult([{ id: 'i1', orgId: 'org1' }]); // listInvoices

    const detail = await svc.getInvoice('i1', actor);
    expect(detail.lines.every((l) => typeof l.deviceCount === 'number')).toBe(true);
    expect(detail.lines.map((l) => l.deviceCount)).toEqual([3, 0]);
    const list = await svc.listInvoices({ limit: 50 }, actor);
    expect(list.some((i: Record<string, unknown>) => 'deviceCount' in i)).toBe(false);
    // Exactly ONE grouped aggregate per detail view — never a per-row aggregate on
    // the invoice index.
    expect((db as unknown as { groupBy: { mock: { calls: unknown[][] } } }).groupBy.mock.calls).toHaveLength(1);
  });
});

describe('changeInvoiceCurrency reprice (price-book reprice of catalog lines, #3775)', () => {
  beforeEach(() => { results.length = 0; vi.clearAllMocks(); });
  const actor = { userId: 'u1', partnerId: 'p1', accessibleOrgIds: ['org1'] };
  const draft = { id: 'i1', status: 'draft', orgId: 'org1', partnerId: 'p1', currencyCode: 'USD', taxRate: null, amountPaid: '0.00' };

  it('reprices a catalog line, restamps, and recomputes totals from the repriced lines', async () => {
    queueResult([draft]);
    queueResult([{ id: 'l1', sourceType: 'catalog', catalogItemId: 'cat1', parentLineId: null, quantity: '2.00' }]);
    resolvePriceMock.mockResolvedValueOnce({
      unitPrice: '20.00', currencyCode: 'EUR', costBasis: '15.00', costCurrency: 'EUR',
      marginAvailable: true, taxable: true, taxCategory: null, source: 'price_book',
    });
    queueResult([]); // line update
    queueResult([]); // header currency update
    // recomputeInvoiceTotals: invoice select, lines select, org tax select, totals update
    queueResult([{ ...draft, currencyCode: 'EUR' }]);
    queueResult([{ lineTotal: '40.00', taxable: true, customerVisible: true }]);
    queueResult([{ taxExempt: false, taxRate: null }]);
    queueResult([]);
    queueResult([{ ...draft, currencyCode: 'EUR', subtotal: '40.00', total: '40.00', balance: '40.00' }]); // final select

    const updated = await svc.changeInvoiceCurrency('i1', { currencyCode: 'EUR', reprice: true }, actor);
    expect(updated.currencyCode).toBe('EUR');
    expect(updated.total).toBe('40.00');
    expect(resolvePriceMock).toHaveBeenCalledTimes(1);
    expect(resolvePriceMock).toHaveBeenCalledWith('cat1', 'EUR', 'org1', { userId: 'u1', partnerId: 'p1', accessibleOrgIds: ['org1'] }, db);
    const setMock = (db as unknown as { set: Mock }).set;
    expect(setMock.mock.calls[0]![0]).toEqual({ unitPrice: '20.00', lineTotal: '40.00', costBasis: '15.00' });
    expect(setMock.mock.calls[1]![0]).toMatchObject({ currencyCode: 'EUR' });
    // totals recompute summed the repriced line (not the [] shortcut)
    expect(setMock.mock.calls[2]![0]).toMatchObject({ subtotal: '40.00', total: '40.00' });
    expect((db as unknown as { delete: Mock }).delete).not.toHaveBeenCalled();
  });

  it('refuses reprice when a non-catalog line exists (CURRENCY_LOCKED 409)', async () => {
    queueResult([draft]);
    queueResult([
      { id: 'l1', sourceType: 'catalog', catalogItemId: 'cat1', parentLineId: null, quantity: '1.00' },
      { id: 'l2', sourceType: 'time_entry', catalogItemId: null, parentLineId: null, quantity: '1.00' },
      { id: 'l3', sourceType: 'bundle', catalogItemId: 'b1', parentLineId: null, quantity: '1.00' },
    ]);
    await expect(
      svc.changeInvoiceCurrency('i1', { currencyCode: 'EUR', reprice: true }, actor)
    ).rejects.toMatchObject({ code: 'CURRENCY_LOCKED', status: 409, message: expect.stringContaining('2 non-catalog line(s) cannot be repriced — pass clearLines instead') });
    expect(resolvePriceMock).not.toHaveBeenCalled();
    expect((db as unknown as { set: Mock }).set).not.toHaveBeenCalled();
    expect((db as unknown as { delete: Mock }).delete).not.toHaveBeenCalled();
  });

  it('a price-book gap aborts the reprice as NO_PRICE_FOR_CURRENCY (409) — header never restamped', async () => {
    queueResult([draft]);
    queueResult([{ id: 'l1', sourceType: 'catalog', catalogItemId: 'cat1', parentLineId: null, quantity: '1.00' }]);
    resolvePriceMock.mockRejectedValueOnce(new CatalogServiceError('No price for "Onboarding" in EUR', 409, 'NO_PRICE_FOR_CURRENCY'));
    await expect(
      svc.changeInvoiceCurrency('i1', { currencyCode: 'EUR', reprice: true }, actor)
    ).rejects.toMatchObject({ code: 'NO_PRICE_FOR_CURRENCY', status: 409, message: expect.stringContaining('Onboarding') });
    expect((db as unknown as { set: Mock }).set).not.toHaveBeenCalled();
  });
});

// Wave-6 release gate (W6-G1-1): the representability guard on every hand-entered
// money value persisted on an invoice line, validated against the INVOICE's
// stamped currency — never the org's current one, and never silently rounded.
describe('invoiceService currency representability guard (W6-G1-1)', () => {
  beforeEach(() => { results.length = 0; vi.clearAllMocks(); });

  const actor = { userId: 'u1', partnerId: 'p1', accessibleOrgIds: ['org1'] };
  const draft = (currencyCode: string) => ({ id: 'i1', status: 'draft', orgId: 'org1', partnerId: 'p1', currencyCode });

  it('addManualLine rejects a fractional minor unit on a JPY invoice (PRICE_NOT_REPRESENTABLE 400)', async () => {
    queueResult([draft('JPY')]);
    await expect(
      svc.addManualLine('i1', { description: 'x', quantity: 1, unitPrice: 100.5, taxable: false }, actor)
    ).rejects.toMatchObject({ code: 'PRICE_NOT_REPRESENTABLE', status: 400 });
    // Nothing may be written once the guard fires.
    expect((db as unknown as { insert: Mock }).insert).not.toHaveBeenCalled();
  });

  it('addManualLine rejects a fractional JPY costBasis even when the unit price is whole', async () => {
    queueResult([draft('JPY')]);
    await expect(
      svc.addManualLine('i1', { description: 'x', quantity: 1, unitPrice: 100, costBasis: 40.5, taxable: false }, actor)
    ).rejects.toMatchObject({ code: 'PRICE_NOT_REPRESENTABLE', status: 400 });
    expect((db as unknown as { insert: Mock }).insert).not.toHaveBeenCalled();
  });

  it('addManualLine accepts a whole-unit JPY price', async () => {
    queueResult([draft('JPY')]);
    queueResult([{ max: 0 }]);                                    // next sortOrder
    queueResult([{ id: 'l1', unitPrice: '100.00' }]);              // insert … returning
    queueResult([draft('JPY')]);                                  // recompute: invoice re-read
    queueResult([{ lineTotal: '100', taxable: false, customerVisible: true }]); // recompute: lines
    queueResult([{ taxExempt: false, taxRate: null }]);            // recompute: org tax rate
    queueResult([]);                                              // recompute: header update
    await expect(
      svc.addManualLine('i1', { description: 'x', quantity: 1, unitPrice: 100, taxable: false }, actor)
    ).resolves.toMatchObject({ id: 'l1' });
  });

  it('addManualLine leaves a 2-decimal currency unchanged — 100.50 USD is accepted', async () => {
    queueResult([draft('USD')]);
    queueResult([{ max: 0 }]);
    queueResult([{ id: 'l1', unitPrice: '100.50' }]);
    queueResult([draft('USD')]);
    queueResult([{ lineTotal: '100.50', taxable: false, customerVisible: true }]);
    queueResult([{ taxExempt: false, taxRate: null }]);
    queueResult([]);
    await expect(
      svc.addManualLine('i1', { description: 'x', quantity: 1, unitPrice: 100.5, taxable: false }, actor)
    ).resolves.toMatchObject({ id: 'l1' });
  });

  it('updateLine rejects a patch that would make an existing JPY line fractional', async () => {
    queueResult([draft('JPY')]);
    queueResult([{ id: 'l1', quantity: '1', unitPrice: '100.00' }]); // existing line
    await expect(
      svc.updateLine('i1', 'l1', { unitPrice: 100.5 }, actor)
    ).rejects.toMatchObject({ code: 'PRICE_NOT_REPRESENTABLE', status: 400 });
    expect((db as unknown as { update: Mock }).update).not.toHaveBeenCalled();
  });

  it('addContractLine rejects a fractional non-catalog JPY snapshot price', async () => {
    queueResult([draft('JPY')]);
    queueResult([{ id: 'ct1', orgId: 'org1', currencyCode: 'JPY' }]); // #3778: parent contract locked FOR UPDATE
    await expect(
      svc.addContractLine('i1', { description: 'x', quantity: '1', unitPrice: '100.5', taxable: false, contractId: 'ct1' }, actor)
    ).rejects.toMatchObject({ code: 'PRICE_NOT_REPRESENTABLE', status: 400 });
    expect((db as unknown as { insert: Mock }).insert).not.toHaveBeenCalled();
  });

  it('addContractLine rejects a fractional injected JPY costBasis', async () => {
    queueResult([draft('JPY')]);
    queueResult([{ id: 'ct1', orgId: 'org1', currencyCode: 'JPY' }]);
    await expect(
      svc.addContractLine('i1', {
        description: 'Overage', quantity: '1', unitPrice: '100', costBasis: '40.5',
        taxable: false, contractId: 'ct1',
      }, actor)
    ).rejects.toMatchObject({ code: 'PRICE_NOT_REPRESENTABLE', status: 400 });
    expect((db as unknown as { insert: Mock }).insert).not.toHaveBeenCalled();
  });
});

// ── overdue sweep tenant scope (org-lifecycle Wave 4 review fix C-A.2) ──────
// The sweep runs fleet-wide under a SYSTEM context, so RLS answers nothing
// here: without an explicit org-status predicate it flips an ARCHIVED tenant's
// invoices to overdue (and emits invoice.overdue → notifications/webhooks) for
// the entire retention window, inside a tenant nobody can open.
describe('runOverdueSweep tenant scope', () => {
  const dialect = new PgDialect();

  beforeEach(() => {
    results.length = 0;
    vi.clearAllMocks();
  });

  it('restricts the due-invoice select to automation-eligible orgs (compiled SQL)', async () => {
    queueResult([]); // no due invoices — only the WHERE clause is under test

    await svc.runOverdueSweep(new Date('2026-08-26T00:00:00Z'));

    const whereArg = (db as unknown as { where: Mock }).where.mock.calls[0]![0] as SQL;
    const { sql, params } = dialect.sqlToQuery(whereArg);
    expect(sql).toContain('automation_eligible_org.id = "invoices"."org_id"');
    expect(sql).toContain('automation_eligible_org.status::text IN');
    // The frozen statuses are the ones that must NOT be admitted.
    expect(params).toEqual(expect.arrayContaining(['active', 'trial', 'suspended', 'churned', 'offboarding']));
    expect(params).not.toContain('archived');
    expect(params).not.toContain('purging');
    expect(params).not.toContain('merging');
  });

  it('still carries the pre-existing due/balance predicates alongside it', async () => {
    queueResult([]);

    await svc.runOverdueSweep(new Date('2026-08-26T00:00:00Z'));

    const whereArg = (db as unknown as { where: Mock }).where.mock.calls[0]![0] as SQL;
    const { sql } = dialect.sqlToQuery(whereArg);
    expect(sql).toContain('"invoices"."due_date" <');
    expect(sql).toContain('"invoices"."balance" > 0');
  });
});

// ---------------------------------------------------------------------------
// Phase D (QuickBooks payment pull-back, Task 3): the payment-mapping cleanup
// and the widened listPayments source tag.
// ---------------------------------------------------------------------------

describe('voidPayment clears the QuickBooks payment mapping', () => {
  beforeEach(() => { results.length = 0; vi.clearAllMocks(); });

  const actor = { userId: 'u1', partnerId: 'p1', accessibleOrgIds: ['org1'] };

  /** Queues the reads voidPayment issues, in order. */
  function queueVoidPaymentReads(payment: Record<string, unknown>) {
    queueResult([{ invoiceId: 'i1' }]);                                                  // unlocked discovery read
    queueResult([{ id: 'i1', status: 'partially_paid', orgId: 'org1', partnerId: 'p1' }]); // invoice FOR UPDATE
    queueResult([payment]);                                                              // payment re-read under lock
    queueResult([]);                                                                     // delete invoice_payments
    queueResult([{ id: 'i1', status: 'partially_paid', orgId: 'org1', partnerId: 'p1', total: '100.00', invoiceNumber: 'INV-1', dueDate: null, paidAt: null, markedOverdueAt: null }]); // recompute: getOwnedInvoiceOr404
    queueResult([]);                                                                     // recompute: payment sum
    queueResult([]);                                                                     // recompute: update invoice
    queueResult([{ id: 'i1', status: 'partially_paid', orgId: 'org1', partnerId: 'p1' }]); // final getOwnedInvoiceOr404
  }

  it('deletes the payment mapping row with the SAME transaction handle, before the payment row', async () => {
    clearPaymentMappingMock.mockResolvedValueOnce(1);
    queueVoidPaymentReads({ id: 'pay1', invoiceId: 'i1', orgId: 'org1', amount: '40.00', method: 'check', reference: '10441', recordedBy: null });

    await svc.voidPayment('pay1', actor);

    // The mocked db chain IS the tx handle the transaction callback receives, so
    // asserting on it proves the cleanup runs inside the caller's transaction
    // rather than escaping to a fresh connection.
    expect(clearPaymentMappingMock).toHaveBeenCalledTimes(1);
    expect(clearPaymentMappingMock).toHaveBeenCalledWith(db, 'pay1');
    // Mapping first: breeze_entity_id is polymorphic with no FK to cascade, so
    // deleting the payment row first would strand the mapping.
    const clearOrder = clearPaymentMappingMock.mock.invocationCallOrder[0]!;
    const deleteOrder = (db as unknown as { delete: Mock }).delete.mock.invocationCallOrder[0]!;
    expect(clearOrder).toBeLessThan(deleteOrder);
  });

  it('does not throw when a manual payment has no mapping row to remove', async () => {
    clearPaymentMappingMock.mockResolvedValueOnce(0);
    queueVoidPaymentReads({ id: 'pay1', invoiceId: 'i1', orgId: 'org1', amount: '40.00', method: 'cash', reference: null, recordedBy: 'u1' });

    const res = await svc.voidPayment('pay1', actor);

    expect(res.audit).toMatchObject({ paymentId: 'pay1', amount: '40.00', method: 'cash' });
    await expect(clearPaymentMappingMock.mock.results[0]!.value).resolves.toBe(0);
  });
});

describe('listPayments source tagging', () => {
  beforeEach(() => { results.length = 0; vi.clearAllMocks(); });

  const actor = { userId: 'u1', partnerId: 'p1', accessibleOrgIds: ['org1'] };

  /** invoice → payment rows → stripe links → quickbooks mapping rows. */
  function queueListPayments(
    payments: Array<Record<string, unknown>>,
    stripeLinked: string[],
    qboLinked: string[],
  ) {
    queueResult([{ id: 'i1', status: 'partially_paid', orgId: 'org1', partnerId: 'p1' }]);
    queueResult(payments);
    queueResult(stripeLinked.map((id) => ({ invoicePaymentId: id })));
    queueResult(qboLinked.map((id) => ({ breezeEntityId: id })));
  }

  it('tags a payment carrying a QuickBooks payment mapping as quickbooks', async () => {
    queueListPayments([{ id: 'pay-qbo', method: 'check' }], [], ['pay-qbo']);

    const rows = await svc.listPayments('i1', actor);

    expect(rows).toEqual([expect.objectContaining({ id: 'pay-qbo', source: 'quickbooks' })]);
  });

  it('tags a succeeded Stripe mapping as stripe and everything else as manual', async () => {
    queueListPayments(
      [{ id: 'pay-stripe', method: 'card' }, { id: 'pay-manual', method: 'cash' }],
      ['pay-stripe'],
      [],
    );

    const rows = await svc.listPayments('i1', actor);

    expect(rows.map((r) => r.source)).toEqual(['stripe', 'manual']);
  });

  it('reports stripe when a row somehow carries BOTH links (stripe wins)', async () => {
    // Structurally impossible today — asserted so the precedence is a decision
    // in the code rather than an accident of Set-lookup order.
    queueListPayments([{ id: 'pay-both', method: 'card' }], ['pay-both'], ['pay-both']);

    const rows = await svc.listPayments('i1', actor);

    expect(rows[0]!.source).toBe('stripe');
  });

  it('does not query the accounting mappings at all when the invoice has no payments', async () => {
    queueResult([{ id: 'i1', status: 'sent', orgId: 'org1', partnerId: 'p1' }]);
    queueResult([]);

    await expect(svc.listPayments('i1', actor)).resolves.toEqual([]);
  });
});
