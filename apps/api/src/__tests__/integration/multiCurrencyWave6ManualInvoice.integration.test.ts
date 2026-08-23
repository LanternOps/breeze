import './setup';

import { eq } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../services/invoiceEvents', () => ({ emitInvoiceEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../jobs/invoiceWorker', () => ({ enqueueInvoicePdfRender: vi.fn().mockResolvedValue(undefined) }));

import { roundToCurrency } from '@breeze/shared';
import { db, withSystemDbAccessContext } from '../../db';
import { invoiceLines, invoices, organizations } from '../../db/schema';
import { addManualLine, createManualInvoice, issueInvoice } from '../../services/invoiceService';
import { gateLabel, seedGateOrg } from './multiCurrencyWave6GateFixtures';

const RUN = !!process.env.DATABASE_URL;
const TAX_RATE = '0.08250';


function assertionMessage(
  transition: string,
  currency: string,
  column: string,
  expected: unknown,
  actual: unknown,
): string {
  return `${transition}; currency=${currency}; column=${column}; expected=${String(expected)}; actual=${String(actual)}`;
}

async function readInvoice(invoiceId: string) {
  const [row] = await withSystemDbAccessContext(() => db
    .select({
      currencyCode: invoices.currencyCode,
      subtotal: invoices.subtotal,
      taxRate: invoices.taxRate,
      taxTotal: invoices.taxTotal,
      total: invoices.total,
      balance: invoices.balance,
      documentLocale: invoices.documentLocale,
    })
    .from(invoices)
    .where(eq(invoices.id, invoiceId)));
  return row;
}

async function setNonzeroInvoiceTaxRate(orgId: string, invoiceId: string): Promise<void> {
  await withSystemDbAccessContext(async () => {
    await db.update(organizations).set({ taxRate: TAX_RATE }).where(eq(organizations.id, orgId));
    await db.update(invoices).set({ taxRate: TAX_RATE }).where(eq(invoices.id, invoiceId));
  });
}

describe.runIf(RUN)(gateLabel('G1', 'manual invoice create -> line -> issue'), () => {
  it('persists an EUR stamp and currency-rounded taxable and non-taxable totals through issue', async () => {
    const fixture = await seedGateOrg('EUR');
    const created = await withSystemDbAccessContext(() =>
      createManualInvoice({ orgId: fixture.orgId }, fixture.actor));

    const createdRow = await readInvoice(created.id);
    expect(
      createdRow,
      assertionMessage('createManualInvoice transition', 'EUR', 'invoices row', 'present', createdRow),
    ).toBeDefined();
    expect(
      createdRow?.currencyCode,
      assertionMessage('createManualInvoice transition', 'EUR', 'currency_code', 'EUR', createdRow?.currencyCode),
    ).toBe('EUR');

    // Sub-cent unit price on purpose: the exact product 3 x 33.333 = 99.999 must be
    // rounded ONCE at the currency boundary. Driven at the SERVICE seam (the HTTP
    // validator's `money = multipleOf(0.01)` would reject 33.333 before it got here),
    // which is exactly the layer this gate is proving.
    await withSystemDbAccessContext(() => addManualLine(created.id, {
      name: 'Taxable consulting',
      quantity: 3,
      unitPrice: 33.333,
      taxable: true,
    }, fixture.actor));

    await withSystemDbAccessContext(() => addManualLine(created.id, {
      name: 'Non-taxable consulting',
      quantity: 3,
      unitPrice: 33.333,
      taxable: false,
    }, fixture.actor));

    await setNonzeroInvoiceTaxRate(fixture.orgId, created.id);
    await withSystemDbAccessContext(() => issueInvoice(created.id, fixture.actor));

    const issuedRow = await readInvoice(created.id);
    const expectedSubtotal = roundToCurrency('199.998', 'EUR');
    const expectedTaxTotal = roundToCurrency('8.25', 'EUR');
    const expectedTotal = roundToCurrency('208.25', 'EUR');

    expect(
      issuedRow,
      assertionMessage('issueInvoice transition', 'EUR', 'invoices row', 'present', issuedRow),
    ).toBeDefined();
    expect(
      issuedRow?.currencyCode,
      assertionMessage('issueInvoice transition', 'EUR', 'currency_code', 'EUR', issuedRow?.currencyCode),
    ).toBe('EUR');
    expect(
      issuedRow?.subtotal,
      assertionMessage('issueInvoice transition', 'EUR', 'subtotal', expectedSubtotal, issuedRow?.subtotal),
    ).toBe(expectedSubtotal);
    expect(
      issuedRow?.taxTotal,
      assertionMessage('issueInvoice transition', 'EUR', 'tax_total', expectedTaxTotal, issuedRow?.taxTotal),
    ).toBe(expectedTaxTotal);
    expect(
      issuedRow?.total,
      assertionMessage('issueInvoice transition', 'EUR', 'total', expectedTotal, issuedRow?.total),
    ).toBe(expectedTotal);
    expect(
      issuedRow?.balance,
      assertionMessage('issueInvoice transition', 'EUR', 'balance', expectedTotal, issuedRow?.balance),
    ).toBe(expectedTotal);
    expect(
      issuedRow?.documentLocale,
      assertionMessage('issueInvoice transition', 'EUR', 'document_locale', 'non-null', issuedRow?.documentLocale),
    ).not.toBeNull();
  });

  it('issues whole-unit JPY amounts and rejects a non-representable manual unit price', async () => {
    const fixture = await seedGateOrg('JPY');
    const created = await withSystemDbAccessContext(() =>
      createManualInvoice({ orgId: fixture.orgId }, fixture.actor));

    await withSystemDbAccessContext(() => addManualLine(created.id, {
      name: 'JPY taxable consulting',
      quantity: 3,
      unitPrice: 333,
      taxable: true,
    }, fixture.actor));

    await setNonzeroInvoiceTaxRate(fixture.orgId, created.id);
    await withSystemDbAccessContext(() => issueInvoice(created.id, fixture.actor));

    const issuedRow = await readInvoice(created.id);
    const [issuedLine] = await withSystemDbAccessContext(() => db
      .select({
        quantity: invoiceLines.quantity,
        unitPrice: invoiceLines.unitPrice,
        lineTotal: invoiceLines.lineTotal,
      })
      .from(invoiceLines)
      .where(eq(invoiceLines.invoiceId, created.id)));
    const expectedSubtotal = roundToCurrency('999', 'JPY');
    const expectedTaxTotal = roundToCurrency('82.4175', 'JPY');
    const expectedTotal = roundToCurrency('1081', 'JPY');

    expect(
      issuedRow,
      assertionMessage('issueInvoice transition', 'JPY', 'invoices row', 'present', issuedRow),
    ).toBeDefined();
    expect(
      issuedRow?.currencyCode,
      assertionMessage('issueInvoice transition', 'JPY', 'currency_code', 'JPY', issuedRow?.currencyCode),
    ).toBe('JPY');
    expect(
      issuedRow?.subtotal,
      assertionMessage('issueInvoice transition', 'JPY', 'subtotal', expectedSubtotal, issuedRow?.subtotal),
    ).toBe(expectedSubtotal);
    expect(
      issuedRow?.taxTotal,
      assertionMessage('issueInvoice transition', 'JPY', 'tax_total', expectedTaxTotal, issuedRow?.taxTotal),
    ).toBe(expectedTaxTotal);
    expect(
      issuedRow?.total,
      assertionMessage('issueInvoice transition', 'JPY', 'total', expectedTotal, issuedRow?.total),
    ).toBe(expectedTotal);
    expect(
      issuedRow?.balance,
      assertionMessage('issueInvoice transition', 'JPY', 'balance', expectedTotal, issuedRow?.balance),
    ).toBe(expectedTotal);
    expect(
      issuedLine?.quantity,
      assertionMessage('addManualLine transition', 'JPY', 'quantity', '3.00', issuedLine?.quantity),
    ).toBe('3.00');
    expect(
      issuedLine?.unitPrice,
      assertionMessage('addManualLine transition', 'JPY', 'unit_price', '333.00', issuedLine?.unitPrice),
    ).toBe('333.00');
    expect(
      issuedLine?.lineTotal,
      assertionMessage('addManualLine transition', 'JPY', 'line_total', expectedSubtotal, issuedLine?.lineTotal),
    ).toBe(expectedSubtotal);

    const rejectionDraft = await withSystemDbAccessContext(() =>
      createManualInvoice({ orgId: fixture.orgId }, fixture.actor));
    await expect(
      withSystemDbAccessContext(() => addManualLine(rejectionDraft.id, {
        name: 'Invalid fractional JPY price',
        quantity: 1,
        unitPrice: 100.5,
        taxable: false,
      }, fixture.actor)),
      assertionMessage(
        'addManualLine rejection transition',
        'JPY',
        'unit_price',
        'PRICE_NOT_REPRESENTABLE rejection for 100.50',
        'promise outcome',
      ),
    ).rejects.toMatchObject({ code: 'PRICE_NOT_REPRESENTABLE' });
  });
});
