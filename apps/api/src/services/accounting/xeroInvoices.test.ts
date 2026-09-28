import { afterEach, describe, expect, it, vi } from 'vitest';

const { slotMock } = vi.hoisted(() => ({
  slotMock: vi.fn((_p: unknown, _s: unknown, _c: unknown, fn: () => unknown) => fn()),
}));
vi.mock('./accountingRateLimit', async (orig) => ({
  ...(await orig<typeof import('./accountingRateLimit')>()),
  withProviderCallSlot: slotMock,
  noteDailyRemaining: vi.fn(async () => {}),
}));

import {
  buildXeroInvoice, toXeroPushResult, xeroInvoicePreflight, xeroInvoiceReference, xeroLineAmounts,
} from './xeroInvoices';
import type { AccountingInvoiceLinePayload, AccountingInvoicePayload } from './types';

const INVOICE = '0f0e0d0c-0b0a-4908-8706-050403020100';
const SETTINGS = { defaultIncomeAccountRef: '200', defaultTaxCodeRef: 'OUTPUT2', defaultExemptTaxCodeRef: 'EXEMPTOUTPUT' } as {
  defaultIncomeAccountRef: string | null; defaultTaxCodeRef: string | null; defaultExemptTaxCodeRef: string | null;
};
const line = (over: Partial<AccountingInvoiceLinePayload> = {}): AccountingInvoiceLinePayload => ({
  invoiceLineId: 'l1', description: 'Managed Firewall', quantity: '1.00', unitPrice: '100.00', lineTotal: '100.00', taxable: true, ...over,
});
const invoice = (over: Partial<AccountingInvoicePayload> = {}): AccountingInvoicePayload => ({
  invoiceId: INVOICE, docNumber: 'INV-2026-0001', txnDate: '2026-09-01', dueDate: '2026-10-01',
  customerRef: { id: 'xc-1' }, currencyCode: 'GBP', subtotal: '100.00', taxTotal: '20.00', total: '120.00',
  lines: [line()], mapping: null, ...over,
});

/** The value a synchronous call throws (fails the test if it returns). */
function thrown(fn: () => unknown): unknown {
  try { fn(); } catch (err) { return err; }
  throw new Error('expected the call to throw');
}

afterEach(() => { vi.restoreAllMocks(); slotMock.mockClear(); });

describe('xeroInvoicePreflight', () => {
  it('passes a fully configured connection', () => {
    expect(xeroInvoicePreflight(SETTINGS, invoice())).toBeNull();
  });

  it.each<[string, Partial<typeof SETTINGS>, AccountingInvoiceLinePayload[], string]>([
    ['no revenue account', { defaultIncomeAccountRef: null }, [line()], 'Choose a revenue account in Integrations → Accounting → Xero, then push again'],
    ['taxed line without a tax rate', { defaultTaxCodeRef: null }, [line()], 'Choose a tax rate for taxable lines in Integrations → Accounting → Xero, then push again'],
    ['untaxed line without an exempt rate', { defaultExemptTaxCodeRef: null }, [line(), line({ invoiceLineId: 'l2', taxable: false })], 'Choose a tax rate for non-taxable lines in Integrations → Accounting → Xero, then push again'],
    ['everything missing', { defaultIncomeAccountRef: null, defaultTaxCodeRef: null, defaultExemptTaxCodeRef: null }, [line(), line({ invoiceLineId: 'l2', taxable: false })], 'Choose a revenue account, a tax rate for taxable lines and a tax rate for non-taxable lines in Integrations → Accounting → Xero, then push again'],
  ])('%s → settings refusal', (_name, settings, lines, message) => {
    expect(xeroInvoicePreflight({ ...SETTINGS, ...settings }, invoice({ lines })))
      .toEqual({ reason: 'settings', message });
  });

  it('a zero-tax invoice needs only the exempt rate, even for lines flagged taxable (refinement 4)', () => {
    expect(xeroInvoicePreflight({ ...SETTINGS, defaultTaxCodeRef: null }, invoice({ taxTotal: '0.00', total: '100.00' }))).toBeNull();
    expect(xeroInvoicePreflight({ ...SETTINGS, defaultExemptTaxCodeRef: null }, invoice({ taxTotal: '0.00', total: '100.00' })))
      .toEqual({ reason: 'settings', message: 'Choose a tax rate for non-taxable lines in Integrations → Accounting → Xero, then push again' });
  });

  it('tax with no taxed weight is a totals refusal', () => {
    expect(xeroInvoicePreflight(SETTINGS, invoice({ lines: [line({ taxable: false })] }))).toEqual({
      reason: 'totals',
      message: 'This invoice records 20.00 of tax, but none of its taxable lines carries an amount, so Xero cannot place that tax on a line. Review the invoice lines and tax, then push again.',
    });
  });
});

describe('xeroLineAmounts (refinement 3)', () => {
  it.each<[string, Partial<AccountingInvoiceLinePayload>, { Description: string; Quantity: number; UnitAmount: number }]>([
    ['exact product → as stored', { quantity: '2.00', unitPrice: '12.50', lineTotal: '25.00' }, { Description: 'Managed Firewall', Quantity: 2, UnitAmount: 12.5 }],
    ['rounded product, exact 4dp unit → quantity kept, 4dp unit', { quantity: '4.00', unitPrice: '0.33', lineTotal: '1.33' }, { Description: 'Managed Firewall', Quantity: 4, UnitAmount: 0.3325 }],
    ['1.5 × 10.95 = 16.425 → half-up 16.43, no exact 4dp unit → quantity 1', { quantity: '1.50', unitPrice: '10.95', lineTotal: '16.43' }, { Description: 'Managed Firewall (1.50 × 10.95)', Quantity: 1, UnitAmount: 16.43 }],
    ['hidden/bundle line: price but zero total → unit 0', { quantity: '2.00', unitPrice: '40.00', lineTotal: '0.00' }, { Description: 'Managed Firewall', Quantity: 2, UnitAmount: 0 }],
    ['zero quantity with a total → quantity 1', { quantity: '0.00', unitPrice: '5.00', lineTotal: '5.00' }, { Description: 'Managed Firewall (0.00 × 5.00)', Quantity: 1, UnitAmount: 5 }],
    ['negative discount line', { quantity: '1.00', unitPrice: '-10.00', lineTotal: '-10.00' }, { Description: 'Managed Firewall', Quantity: 1, UnitAmount: -10 }],
    ['empty description gets a placeholder', { description: '  ' }, { Description: 'Invoice line', Quantity: 1, UnitAmount: 100 }],
  ])('%s', (_name, over, expected) => {
    expect(xeroLineAmounts(line(over))).toEqual(expected);
  });

  // Exactness guards beyond the reference table: a value the payload's decimal
  // strings allow but a JSON number cannot carry exactly (or more than 4
  // places) must never be sent as a nearby float that Xero would bill instead.
  it.each<[string, Partial<AccountingInvoiceLinePayload>, { Description: string; Quantity: number; UnitAmount: number }]>([
    ['quantity finer than 4 places → quantity 1', { quantity: '1.00005', unitPrice: '10.00', lineTotal: '10.00' }, { Description: 'Managed Firewall (1.00005 × 10.00)', Quantity: 1, UnitAmount: 10 }],
    ['unit price finer than 4 places, exact 4dp unit exists → (b)', { quantity: '2.00', unitPrice: '5.000001', lineTotal: '10.00' }, { Description: 'Managed Firewall', Quantity: 2, UnitAmount: 5 }],
    ['unit price finer than 4 places, no exact unit → quantity 1', { quantity: '3.00', unitPrice: '3.33333', lineTotal: '10.00' }, { Description: 'Managed Firewall (3.00 × 3.33333)', Quantity: 1, UnitAmount: 10 }],
    ['quantity no JSON number carries exactly → quantity 1', { quantity: '1234567890123.4567', unitPrice: '0.00', lineTotal: '0.00' }, { Description: 'Managed Firewall (1234567890123.4567 × 0.00)', Quantity: 1, UnitAmount: 0 }],
  ])('%s', (_name, over, expected) => {
    expect(xeroLineAmounts(line(over))).toEqual(expected);
  });

  it('sends every value as the exact decimal (no float drift past 2^53)', () => {
    // 45035996273704.97 scaled to 1e-4 units is above 2^53: Number(n) / 10 ** 4
    // yields 45035996273704.98 (a cent Xero would bill); the decimal parse is exact.
    const out = xeroLineAmounts(line({ quantity: '1.00', unitPrice: '45035996273704.97', lineTotal: '45035996273704.97' }));
    expect(JSON.stringify(out.UnitAmount)).toBe('45035996273704.97');
  });

  it.each([
    ['finer than cents', '16.425'],
    ['beyond what a JSON number carries exactly', '1234567890123456.78'],
  ])('refuses (validation) a line total %s rather than sending a rounded float', (_name, lineTotal) => {
    expect(thrown(() => xeroLineAmounts(line({ quantity: '1.00', unitPrice: lineTotal, lineTotal }))))
      .toMatchObject({ kind: 'validation', provider: 'xero' });
  });

  it("never exceeds Xero's 4000-character description", () => {
    expect(xeroLineAmounts(line({ description: 'x'.repeat(5000), quantity: '1.50', unitPrice: '10.95', lineTotal: '16.43' })).Description).toHaveLength(4000);
  });
});

describe('buildXeroInvoice', () => {
  it('maps the spec table: ACCREC, AUTHORISED, Exclusive, Reference, DueDate, CurrencyCode, per-line account, tax type and allocated tax', () => {
    const body = buildXeroInvoice(
      invoice({ lines: [line(), line({ invoiceLineId: 'l2', description: 'Setup', taxable: false, lineTotal: '50.00', unitPrice: '50.00' })], subtotal: '150.00', total: '170.00' }),
      [{ invoiceLineId: 'l1', remoteItemRef: { id: 'xi-1' } }, { invoiceLineId: 'l2', remoteItemRef: null }],
      new Map([['xi-1', { code: 'fw-100-3fa9c1b2d4', accountCode: '210' }]]),
      SETTINGS,
      { includeNumber: true },
    );
    expect(body).toEqual({
      Type: 'ACCREC',
      Contact: { ContactID: 'xc-1' },
      Date: '2026-09-01',
      DueDate: '2026-10-01',
      InvoiceNumber: 'INV-2026-0001',
      Reference: `breeze:${INVOICE}`,
      CurrencyCode: 'GBP',
      Status: 'AUTHORISED',
      LineAmountTypes: 'Exclusive',
      LineItems: [
        { Description: 'Managed Firewall', Quantity: 1, UnitAmount: 100, AccountCode: '210', TaxType: 'OUTPUT2', TaxAmount: 20, ItemCode: 'fw-100-3fa9c1b2d4' },
        { Description: 'Setup', Quantity: 1, UnitAmount: 50, AccountCode: '200', TaxType: 'EXEMPTOUTPUT', TaxAmount: 0 },
      ],
    });
    expect(body.LineItems?.every((l) => !('LineAmount' in l))).toBe(true);
  });

  it('the without-number variant omits InvoiceNumber only', () => {
    const withNo = buildXeroInvoice(invoice(), [], new Map(), SETTINGS, { includeNumber: true });
    const without = buildXeroInvoice(invoice(), [], new Map(), SETTINGS, { includeNumber: false });
    expect(without).not.toHaveProperty('InvoiceNumber');
    expect({ ...without, InvoiceNumber: 'INV-2026-0001' }).toEqual(withNo);
  });

  it('DueDate falls back to the invoice date', () => {
    expect(buildXeroInvoice(invoice({ dueDate: null }), [], new Map(), SETTINGS, { includeNumber: true }).DueDate).toBe('2026-09-01');
  });

  it('a mapped item missing from Xero is sent without ItemCode, on the default account (refinement 12)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const body = buildXeroInvoice(invoice(), [{ invoiceLineId: 'l1', remoteItemRef: { id: 'xi-gone' } }], new Map(), SETTINGS, { includeNumber: true });
    expect(body.LineItems?.[0]).toEqual({ Description: 'Managed Firewall', Quantity: 1, UnitAmount: 100, AccountCode: '200', TaxType: 'OUTPUT2', TaxAmount: 20 });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('xi-gone'));
  });

  it('a zero-tax invoice puts every line on the exempt rate (refinement 4)', () => {
    const body = buildXeroInvoice(invoice({ taxTotal: '0.00', total: '100.00' }), [], new Map(), SETTINGS, { includeNumber: true });
    expect(body.LineItems?.[0]).toMatchObject({ TaxType: 'EXEMPTOUTPUT', TaxAmount: 0 });
  });

  it('with the override off, TaxAmount is omitted and Xero calculates (refinement 5 fallback)', () => {
    const body = buildXeroInvoice(invoice(), [], new Map(), SETTINGS, { includeNumber: true, sendLineTax: false });
    expect(body.LineItems?.[0]).not.toHaveProperty('TaxAmount');
    expect(body.LineItems?.[0]).toMatchObject({ TaxType: 'OUTPUT2' });
  });

  it('refuses (validation) when called without the settings the preflight requires', () => {
    expect(thrown(() => buildXeroInvoice(invoice(), [], new Map(), { ...SETTINGS, defaultTaxCodeRef: null }, { includeNumber: true })))
      .toMatchObject({ kind: 'validation', provider: 'xero' });
  });
});

describe('toXeroPushResult', () => {
  it('maps id, number, version and both totals as 2dp strings', () => {
    expect(toXeroPushResult({
      InvoiceID: 'xi-9', InvoiceNumber: 'INV-2026-0001', Status: 'AUTHORISED', TotalTax: 20, Total: 120,
      UpdatedDateUTC: '/Date(1790000000000+0000)/',
    }, 'Xero invoice create')).toEqual({
      id: 'xi-9', docNumber: 'INV-2026-0001', remoteVersion: new Date(1790000000000).toISOString(),
      remoteTaxTotal: '20.00', remoteTotal: '120.00',
    });
  });
  it('null totals when Xero omits them (the drift check then skips)', () => {
    expect(toXeroPushResult({ InvoiceID: 'xi-9' }, 'op')).toEqual({ id: 'xi-9', remoteTaxTotal: null, remoteTotal: null });
  });
  it('an element with HasErrors is a validation failure carrying the first message (refinement 13)', () => {
    expect(thrown(() => toXeroPushResult({ InvoiceID: 'xi-9', HasErrors: true, ValidationErrors: [{ Message: 'Account code is invalid' }] }, 'Xero invoice create')))
      .toMatchObject({ kind: 'validation', providerMessage: 'Account code is invalid' });
  });
  it('no InvoiceID is a transient failure (the caller re-looks before any retry)', () => {
    expect(thrown(() => toXeroPushResult(undefined, 'Xero invoice create'))).toMatchObject({ kind: 'transient' });
  });
  it('the reference is breeze:<invoiceId>', () => {
    expect(xeroInvoiceReference(INVOICE)).toBe(`breeze:${INVOICE}`);
  });
});
