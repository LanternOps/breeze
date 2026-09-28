import { afterEach, describe, expect, it, vi } from 'vitest';

const { slotMock } = vi.hoisted(() => ({
  slotMock: vi.fn((_p: unknown, _s: unknown, _c: unknown, fn: () => unknown) => fn()),
}));
vi.mock('./accountingRateLimit', async (orig) => ({
  ...(await orig<typeof import('./accountingRateLimit')>()),
  withProviderCallSlot: slotMock,
  noteDailyRemaining: vi.fn(async () => {}),
}));

import { AccountingProviderError } from './accountingProviderError';
import {
  buildXeroInvoice, findPushedXeroInvoice, findXeroInvoicesByReference, pushXeroInvoice, toXeroPushResult,
  voidXeroInvoice, xeroInvoiceIdempotencyKey, xeroInvoicePreflight, xeroInvoiceReference, xeroLineAmounts,
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

const ctx = {
  connectionId: 'c1', tenantId: 'ten-A', accessToken: 'at',
  rate: { perConnection: { limit: 60, windowSeconds: 60 }, maxConcurrentPerConnection: 5, appWide: null, dailyPerConnection: null },
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
/** Typed view of a fetch spy's calls (vi.spyOn's generic return type would leave the tuple `any`). */
const callsOf = (fetchMock: { mock: { calls: unknown[][] } }) => fetchMock.mock.calls.map((call) => {
  const [url, init] = call as [string, RequestInit];
  return { url, method: init.method, init };
});
const bodyOf = (init: RequestInit) => JSON.parse(init.body as string) as { Invoices: Array<Record<string, unknown>> };
const keyOf = (init: RequestInit) => (init.headers as Record<string, string>)['Idempotency-Key'];
const LOOKUP_URL = `https://api.xero.com/api.xro/2.0/Invoices?where=Reference%3D%3D%22breeze%3A${INVOICE}%22&unitdp=4`;
const CREATE_URL = 'https://api.xero.com/api.xro/2.0/Invoices?unitdp=4&summarizeErrors=true';
const UPDATE_URL = 'https://api.xero.com/api.xro/2.0/Invoices/xi-1?unitdp=4&summarizeErrors=true';
const remote = (over: Record<string, unknown> = {}) => ({
  InvoiceID: 'xi-1', Type: 'ACCREC', InvoiceNumber: 'INV-2026-0001', Reference: `breeze:${INVOICE}`, Status: 'AUTHORISED',
  Contact: { ContactID: 'xc-1' }, CurrencyCode: 'GBP', SubTotal: 100, TotalTax: 20, Total: 120, AmountPaid: 0, AmountCredited: 0,
  UpdatedDateUTC: '/Date(1790000000000+0000)/', ...over,
});
const timeout = () => new DOMException('t', 'TimeoutError');
const failing400 = (message: string) => json({ ErrorNumber: 10, Type: 'ValidationException', Elements: [{ ValidationErrors: [{ Message: message }] }] }, 400);
const mapped = (over: Partial<AccountingInvoicePayload> = {}) => invoice({ mapping: { remoteEntityId: 'xi-1', remoteSyncToken: null }, ...over });

describe('xeroInvoiceIdempotencyKey (refinement 2)', () => {
  it('depends on tenant, invoice, variant and superseded ids — never on the body', () => {
    const k = xeroInvoiceIdempotencyKey('ten-A', INVOICE, 'with-number', []);
    expect(k).toMatch(/^breeze-inv-[0-9a-f]{64}$/);
    expect(xeroInvoiceIdempotencyKey('ten-A', INVOICE, 'with-number', [])).toBe(k);
    expect(xeroInvoiceIdempotencyKey('ten-B', INVOICE, 'with-number', [])).not.toBe(k);
    expect(xeroInvoiceIdempotencyKey('ten-A', 'other', 'with-number', [])).not.toBe(k);
    expect(xeroInvoiceIdempotencyKey('ten-A', INVOICE, 'without-number', [])).not.toBe(k);
    expect(xeroInvoiceIdempotencyKey('ten-A', INVOICE, 'with-number', ['xi-old'])).not.toBe(k);
    expect(xeroInvoiceIdempotencyKey('ten-A', INVOICE, 'with-number', ['b', 'a'])).toBe(xeroInvoiceIdempotencyKey('ten-A', INVOICE, 'with-number', ['a', 'b']));
  });
});

describe('findXeroInvoicesByReference', () => {
  it('filters to exact ACCREC matches and splits live from superseded', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(json({ Invoices: [
      remote(),
      remote({ InvoiceID: 'xi-old2', Status: 'VOIDED' }),
      remote({ InvoiceID: 'xi-old1', Status: 'DELETED' }),
      remote({ InvoiceID: 'bill', Type: 'ACCPAY' }),
      remote({ InvoiceID: 'near', Reference: `breeze:${INVOICE}-x` }),
      remote({ InvoiceID: 'no-type', Type: undefined }),
    ] }));
    const found = await findXeroInvoicesByReference(ctx, INVOICE);
    expect(found.live.map((i) => i.InvoiceID)).toEqual(['xi-1', 'no-type']);
    expect(found.supersededIds).toEqual(['xi-old1', 'xi-old2']);
    expect(callsOf(fetchMock)[0]).toMatchObject({ url: LOOKUP_URL, method: 'GET' });
  });
});

describe('pushXeroInvoice — first push', () => {
  it('looks up the reference, then PUTs the with-number body under the with-number key', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ Invoices: [] }))
      .mockResolvedValueOnce(json({ Invoices: [remote()] }));
    await expect(pushXeroInvoice(ctx, SETTINGS, invoice(), [])).resolves.toEqual({
      id: 'xi-1', docNumber: 'INV-2026-0001', remoteVersion: new Date(1790000000000).toISOString(),
      remoteTaxTotal: '20.00', remoteTotal: '120.00',
    });
    const [lookup, create] = callsOf(fetchMock);
    expect(lookup).toMatchObject({ url: LOOKUP_URL, method: 'GET' });
    expect(create).toMatchObject({ url: CREATE_URL, method: 'PUT' });
    expect(bodyOf(create!.init).Invoices[0]).toMatchObject({ InvoiceNumber: 'INV-2026-0001', Reference: `breeze:${INVOICE}`, Status: 'AUTHORISED' });
    expect(keyOf(create!.init)).toBe(xeroInvoiceIdempotencyKey('ten-A', INVOICE, 'with-number', []));
  });

  it('a second push adopts instead of creating: read, then resend by POST, never a PUT (Review Focus 1)', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ Invoices: [remote()] }))
      .mockResolvedValueOnce(json({ Invoices: [remote()] }));
    await expect(pushXeroInvoice(ctx, SETTINGS, invoice(), [])).resolves.toMatchObject({ id: 'xi-1' });
    expect(callsOf(fetchMock).map((c) => [c.method, c.url])).toEqual([['GET', LOOKUP_URL], ['POST', UPDATE_URL]]);
  });

  it('adopts after a timed-out create (Review Focus 1)', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ Invoices: [] }))
      .mockRejectedValueOnce(timeout())
      .mockResolvedValueOnce(json({ Invoices: [remote()] }))
      .mockResolvedValueOnce(json({ Invoices: [remote()] }));
    await expect(pushXeroInvoice(ctx, SETTINGS, invoice(), [])).resolves.toMatchObject({ id: 'xi-1' });
    expect(callsOf(fetchMock).map((c) => c.method)).toEqual(['GET', 'PUT', 'GET', 'POST']);
  });

  it('a timed-out create that left nothing rethrows the transient (the retry looks first)', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ Invoices: [] }))
      .mockRejectedValueOnce(timeout())
      .mockResolvedValueOnce(json({ Invoices: [] }));
    await expect(pushXeroInvoice(ctx, SETTINGS, invoice(), [])).rejects.toMatchObject({ kind: 'transient', provider: 'xero' });
  });

  it('a concurrent push with a different body gets the key-reuse 400 and adopts the first push\'s invoice (quorum finding 1)', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ Invoices: [] }))
      .mockResolvedValueOnce(failing400(`Idempotency Key: ${xeroInvoiceIdempotencyKey('ten-A', INVOICE, 'with-number', [])} is used with a different request.`))
      .mockResolvedValueOnce(json({ Invoices: [remote()] }))
      .mockResolvedValueOnce(json({ Invoices: [remote()] }));
    await expect(pushXeroInvoice(ctx, SETTINGS, invoice(), [])).resolves.toMatchObject({ id: 'xi-1' });
    expect(callsOf(fetchMock).filter((c) => c.method === 'PUT')).toHaveLength(1);
  });

  it('a voided predecessor changes the key but not the body (refinement 2)', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ Invoices: [] })).mockResolvedValueOnce(json({ Invoices: [remote()] }))
      .mockResolvedValueOnce(json({ Invoices: [remote({ InvoiceID: 'xi-old', Status: 'VOIDED' })] }))
      .mockResolvedValueOnce(json({ Invoices: [remote({ InvoiceID: 'xi-2' })] }));
    await pushXeroInvoice(ctx, SETTINGS, invoice(), []);
    await pushXeroInvoice(ctx, SETTINGS, invoice(), []);
    const puts = callsOf(fetchMock).filter((c) => c.method === 'PUT');
    expect(keyOf(puts[1]!.init)).toBe(xeroInvoiceIdempotencyKey('ten-A', INVOICE, 'with-number', ['xi-old']));
    expect(keyOf(puts[1]!.init)).not.toBe(keyOf(puts[0]!.init));
    expect(puts[1]!.init.body).toBe(puts[0]!.init.body);
  });

  it('a duplicate number owned by our own lost create is adopted', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ Invoices: [] }))
      .mockResolvedValueOnce(failing400('Invoice # must be unique.'))
      .mockResolvedValueOnce(json({ Invoices: [remote()] }))
      .mockResolvedValueOnce(json({ Invoices: [remote()] }));
    await expect(pushXeroInvoice(ctx, SETTINGS, invoice(), [])).resolves.toMatchObject({ id: 'xi-1' });
    expect(callsOf(fetchMock).map((c) => c.method)).toEqual(['GET', 'PUT', 'GET', 'POST']);
  });

  it('a duplicate number held by someone else → one numberless retry under the without-number key (Review Focus 2)', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ Invoices: [] }))
      .mockResolvedValueOnce(failing400('Invoice # must be unique.'))
      .mockResolvedValueOnce(json({ Invoices: [] }))
      .mockResolvedValueOnce(json({ Invoices: [remote({ InvoiceNumber: 'INV-0042' })] }));
    await expect(pushXeroInvoice(ctx, SETTINGS, invoice(), [])).resolves.toMatchObject({ id: 'xi-1', docNumber: 'INV-0042' });
    const puts = callsOf(fetchMock).filter((c) => c.method === 'PUT');
    expect(puts).toHaveLength(2);
    expect(bodyOf(puts[0]!.init).Invoices[0]).toHaveProperty('InvoiceNumber', 'INV-2026-0001');
    expect(bodyOf(puts[1]!.init).Invoices[0]).not.toHaveProperty('InvoiceNumber');
    expect(keyOf(puts[1]!.init)).toBe(xeroInvoiceIdempotencyKey('ten-A', INVOICE, 'without-number', []));
  });

  it('the numberless retry keys on the superseded ids of the LATEST lookup (quorum finding 2)', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ Invoices: [] }))
      .mockResolvedValueOnce(failing400('Invoice # must be unique.'))
      .mockResolvedValueOnce(json({ Invoices: [remote({ InvoiceID: 'xi-v', Status: 'VOIDED' })] }))
      .mockResolvedValueOnce(json({ Invoices: [remote({ InvoiceID: 'xi-2', InvoiceNumber: 'INV-0043' })] }));
    await expect(pushXeroInvoice(ctx, SETTINGS, invoice(), [])).resolves.toMatchObject({ id: 'xi-2' });
    const puts = callsOf(fetchMock).filter((c) => c.method === 'PUT');
    expect(keyOf(puts[1]!.init)).toBe(xeroInvoiceIdempotencyKey('ten-A', INVOICE, 'without-number', ['xi-v']));
  });

  it('a validation failure on the numberless retry is not retried again', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ Invoices: [] }))
      .mockResolvedValueOnce(failing400('Invoice # must be unique.'))
      .mockResolvedValueOnce(json({ Invoices: [] }))
      .mockResolvedValueOnce(failing400("Account code '999' is not a valid code for this document."));
    await expect(pushXeroInvoice(ctx, SETTINGS, invoice(), [])).rejects.toMatchObject({ kind: 'validation', httpStatus: 400 });
    expect(callsOf(fetchMock)).toHaveLength(4);
  });

  it('two live invoices with our reference → duplicate_key, nothing written (never guess)', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(json({ Invoices: [remote(), remote({ InvoiceID: 'xi-2' })] }));
    await expect(pushXeroInvoice(ctx, SETTINGS, invoice(), [])).rejects.toMatchObject({ kind: 'validation', providerCode: 'duplicate_key' });
    expect(callsOf(fetchMock)).toHaveLength(1);
  });

  it('reads the price list once, only when a line has a mapped item', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ Invoices: [] }))
      .mockResolvedValueOnce(json({ Items: [{ ItemID: 'xi-item', Code: 'fw-100-3fa9c1b2d4' }] }))
      .mockResolvedValueOnce(json({ Invoices: [remote()] }));
    await pushXeroInvoice(ctx, SETTINGS, invoice(), [{ invoiceLineId: 'l1', remoteItemRef: { id: 'xi-item' } }]);
    expect(callsOf(fetchMock).map((c) => c.url.split('?')[0]!.split('/').pop())).toEqual(['Invoices', 'Items', 'Invoices']);
    expect(bodyOf(callsOf(fetchMock)[2]!.init).Invoices[0]).toMatchObject({ LineItems: [expect.objectContaining({ ItemCode: 'fw-100-3fa9c1b2d4' })] });
  });

  it('a throttle during the pre-create lookup propagates untouched', async () => {
    const refusal = new AccountingProviderError({ kind: 'rate_limited', provider: 'xero', operation: 'slot', retryAfterMs: 1000, throttleSource: 'local' });
    slotMock.mockImplementationOnce(async () => { throw refusal; });
    await expect(pushXeroInvoice(ctx, SETTINGS, invoice(), [])).rejects.toBe(refusal);
  });
});

describe('pushXeroInvoice — re-push of an invoice already in Xero (refinement 7)', () => {
  it.each(['AUTHORISED', 'DRAFT', 'SUBMITTED'])('an unpaid %s invoice is resent by POST: Status AUTHORISED, no InvoiceNumber, no Idempotency-Key', async (Status) => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ Invoices: [remote({ Status })] }))
      .mockResolvedValueOnce(json({ Invoices: [remote()] }));
    await expect(pushXeroInvoice(ctx, SETTINGS, mapped(), [])).resolves.toMatchObject({ id: 'xi-1', remoteTotal: '120.00' });
    const [read, post] = callsOf(fetchMock);
    expect(read).toMatchObject({ url: 'https://api.xero.com/api.xro/2.0/Invoices/xi-1?unitdp=4', method: 'GET' });
    expect(post).toMatchObject({ url: UPDATE_URL, method: 'POST' });
    expect(bodyOf(post!.init).Invoices[0]).toMatchObject({ InvoiceID: 'xi-1', Status: 'AUTHORISED' });
    expect(bodyOf(post!.init).Invoices[0]).not.toHaveProperty('InvoiceNumber');
    expect(post!.init.headers).not.toHaveProperty('Idempotency-Key');
  });

  it.each([{ Status: 'PAID', AmountPaid: 120 }, { AmountPaid: 10 }, { AmountCredited: 5 }])(
    'money applied (%o) with Breeze\'s amounts → read only, no write',
    async (money) => {
      const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(json({ Invoices: [remote(money)] }));
      await expect(pushXeroInvoice(ctx, SETTINGS, mapped(), [])).resolves.toMatchObject({ id: 'xi-1', remoteTotal: '120.00' });
      expect(callsOf(fetchMock)).toHaveLength(1);
    },
  );

  it.each([{ Total: 108, AmountPaid: 10 }, { CurrencyCode: 'USD', AmountCredited: 5 }])(
    'money applied (%o) with different content → remote_locked, no write',
    async (over) => {
      const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(json({ Invoices: [remote(over)] }));
      await expect(pushXeroInvoice(ctx, SETTINGS, mapped(), [])).rejects.toMatchObject({ kind: 'validation', providerCode: 'remote_locked' });
      expect(callsOf(fetchMock)).toHaveLength(1);
    },
  );

  it('a payment applied between the read and the write → remote_locked', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ Invoices: [remote()] }))
      .mockResolvedValueOnce(failing400('This document cannot be edited as it has a payment or credit note allocated to it.'));
    await expect(pushXeroInvoice(ctx, SETTINGS, mapped(), [])).rejects.toMatchObject({ kind: 'validation', providerCode: 'remote_locked' });
  });

  it.each(['VOIDED', 'DELETED'])('%s in Xero → remote_missing', async (Status) => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(json({ Invoices: [remote({ Status })] }));
    await expect(pushXeroInvoice(ctx, SETTINGS, mapped(), [])).rejects.toMatchObject({ kind: 'not_found', providerCode: 'remote_missing' });
  });

  it('404 → remote_missing', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('', { status: 404 }));
    await expect(pushXeroInvoice(ctx, SETTINGS, mapped(), [])).rejects.toMatchObject({ kind: 'not_found', providerCode: 'remote_missing' });
  });
});

describe('findPushedXeroInvoice (refinement 22)', () => {
  it('returns the single live invoice with its version, or null', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ Invoices: [remote(), remote({ InvoiceID: 'xi-v', Status: 'VOIDED' })] }))
      .mockResolvedValueOnce(json({ Invoices: [remote({ Status: 'VOIDED' })] }));
    await expect(findPushedXeroInvoice(ctx, INVOICE)).resolves.toEqual({ id: 'xi-1', remoteVersion: new Date(1790000000000).toISOString() });
    await expect(findPushedXeroInvoice(ctx, INVOICE)).resolves.toBeNull();
  });
});

// Review Focus 1 and 2, beyond the brief's table: every uncertain branch of
// createAdopting / settleExisting ends with at most ONE Xero invoice and a
// bounded number of calls (never an endless retry).
describe('pushXeroInvoice — bounded outcomes (Review Focus 1 and 2)', () => {
  const methods = (fetchMock: { mock: { calls: unknown[][] } }) => callsOf(fetchMock).map((c) => c.method);

  it('a payload the line guard refuses (validation) is not an uncertain outcome: no PUT, no look-again', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(json({ Invoices: [] }));
    const bad = invoice({ taxTotal: '0.00', total: '16.425', lines: [line({ unitPrice: '16.425', lineTotal: '16.425' })] });
    await expect(pushXeroInvoice(ctx, SETTINGS, bad, [])).rejects.toMatchObject({ kind: 'validation', provider: 'xero' });
    expect(methods(fetchMock)).toEqual(['GET']);
  });

  it('a validation 400 on the create is terminal: no look-again, no second PUT', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ Invoices: [] }))
      .mockResolvedValueOnce(failing400("Account code '999' is not a valid code for this document."));
    await expect(pushXeroInvoice(ctx, SETTINGS, invoice(), [])).rejects.toMatchObject({ kind: 'validation', httpStatus: 400 });
    expect(methods(fetchMock)).toEqual(['GET', 'PUT']);
  });

  it('a 429 on the create is not uncertain (Xero processed nothing): rethrown, no look-again', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ Invoices: [] }))
      .mockResolvedValueOnce(new Response('', { status: 429, headers: { 'retry-after': '5' } }));
    await expect(pushXeroInvoice(ctx, SETTINGS, invoice(), [])).rejects.toMatchObject({ kind: 'rate_limited' });
    expect(methods(fetchMock)).toEqual(['GET', 'PUT']);
  });

  it('a failing look-again propagates its own error; still exactly one PUT', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ Invoices: [] }))
      .mockRejectedValueOnce(timeout())
      .mockResolvedValueOnce(new Response('', { status: 503 }));
    await expect(pushXeroInvoice(ctx, SETTINGS, invoice(), [])).rejects.toMatchObject({ kind: 'transient', httpStatus: 503 });
    expect(methods(fetchMock)).toEqual(['GET', 'PUT', 'GET']);
  });

  it('a look-again that finds two live invoices refuses duplicate_key and writes nothing more', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ Invoices: [] }))
      .mockRejectedValueOnce(timeout())
      .mockResolvedValueOnce(json({ Invoices: [remote(), remote({ InvoiceID: 'xi-2' })] }));
    await expect(pushXeroInvoice(ctx, SETTINGS, invoice(), [])).rejects.toMatchObject({ kind: 'validation', providerCode: 'duplicate_key' });
    expect(methods(fetchMock)).toEqual(['GET', 'PUT', 'GET']);
  });

  it('an adopted invoice whose resend POST times out fails transient: one PUT, and the retry adopts again (no second create)', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ Invoices: [] }))
      .mockRejectedValueOnce(timeout())
      .mockResolvedValueOnce(json({ Invoices: [remote()] }))
      .mockRejectedValueOnce(timeout())
      // the job's retry
      .mockResolvedValueOnce(json({ Invoices: [remote()] }))
      .mockResolvedValueOnce(json({ Invoices: [remote()] }));
    await expect(pushXeroInvoice(ctx, SETTINGS, invoice(), [])).rejects.toMatchObject({ kind: 'transient' });
    await expect(pushXeroInvoice(ctx, SETTINGS, invoice(), [])).resolves.toMatchObject({ id: 'xi-1' });
    expect(methods(fetchMock)).toEqual(['GET', 'PUT', 'GET', 'POST', 'GET', 'POST']);
  });

  it('a retry after a create whose outcome stayed unknown re-sends the SAME key, so Xero replays rather than creates', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ Invoices: [] }))
      .mockRejectedValueOnce(timeout())
      .mockResolvedValueOnce(json({ Invoices: [] }))
      // the job's retry: the lookup still lags
      .mockResolvedValueOnce(json({ Invoices: [] }))
      .mockResolvedValueOnce(json({ Invoices: [remote()] }));
    await expect(pushXeroInvoice(ctx, SETTINGS, invoice(), [])).rejects.toMatchObject({ kind: 'transient' });
    await expect(pushXeroInvoice(ctx, SETTINGS, invoice(), [])).resolves.toMatchObject({ id: 'xi-1' });
    const puts = callsOf(fetchMock).filter((c) => c.method === 'PUT');
    expect(puts).toHaveLength(2);
    expect(keyOf(puts[1]!.init)).toBe(keyOf(puts[0]!.init));
  });

  it('a timed-out numberless retry that left nothing rethrows transient: two PUTs at most', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ Invoices: [] }))
      .mockResolvedValueOnce(failing400('Invoice # must be unique.'))
      .mockResolvedValueOnce(json({ Invoices: [] }))
      .mockRejectedValueOnce(timeout())
      .mockResolvedValueOnce(json({ Invoices: [] }));
    await expect(pushXeroInvoice(ctx, SETTINGS, invoice(), [])).rejects.toMatchObject({ kind: 'transient' });
    expect(methods(fetchMock)).toEqual(['GET', 'PUT', 'GET', 'PUT', 'GET']);
  });

  it('a timed-out numberless retry that landed is adopted', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ Invoices: [] }))
      .mockResolvedValueOnce(failing400('Invoice # must be unique.'))
      .mockResolvedValueOnce(json({ Invoices: [] }))
      .mockRejectedValueOnce(timeout())
      .mockResolvedValueOnce(json({ Invoices: [remote({ InvoiceNumber: 'INV-0042' })] }))
      .mockResolvedValueOnce(json({ Invoices: [remote({ InvoiceNumber: 'INV-0042' })] }));
    await expect(pushXeroInvoice(ctx, SETTINGS, invoice(), [])).resolves.toMatchObject({ id: 'xi-1', docNumber: 'INV-0042' });
    expect(methods(fetchMock)).toEqual(['GET', 'PUT', 'GET', 'PUT', 'GET', 'POST']);
  });
});

describe('voidXeroInvoice (refinement 8)', () => {
  const VOID_URL = 'https://api.xero.com/api.xro/2.0/Invoices/xi-1?unitdp=4&summarizeErrors=true';

  it.each<[string, string]>([['AUTHORISED', 'VOIDED'], ['DRAFT', 'DELETED'], ['SUBMITTED', 'DELETED']])(
    '%s → POST Status %s, returning the new version',
    async (Status, target) => {
      const fetchMock = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(json({ Invoices: [remote({ Status })] }))
        .mockResolvedValueOnce(json({ Invoices: [remote({ Status: target, UpdatedDateUTC: '/Date(1790000100000+0000)/' })] }));
      await expect(voidXeroInvoice(ctx, 'xi-1')).resolves.toEqual({ remoteVersion: new Date(1790000100000).toISOString() });
      const post = callsOf(fetchMock)[1]!;
      expect(post).toMatchObject({ url: VOID_URL, method: 'POST' });
      expect(bodyOf(post.init)).toEqual({ Invoices: [{ InvoiceID: 'xi-1', Status: target }] });
      expect(post.init.headers).not.toHaveProperty('Idempotency-Key');
    },
  );

  it.each(['VOIDED', 'DELETED'])('already %s → success, no write', async (Status) => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(json({ Invoices: [remote({ Status })] }));
    await expect(voidXeroInvoice(ctx, 'xi-1')).resolves.toEqual({ remoteVersion: new Date(1790000000000).toISOString() });
    expect(callsOf(fetchMock)).toHaveLength(1);
  });

  it('absent in Xero (404) → success with no version, no write', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('', { status: 404 }));
    await expect(voidXeroInvoice(ctx, 'xi-1')).resolves.toEqual({ remoteVersion: null });
    expect(callsOf(fetchMock)).toHaveLength(1);
  });

  it.each([{ Status: 'PAID', AmountPaid: 120 }, { AmountPaid: 10 }, { AmountCredited: 5 }])(
    'money applied (%o) → payment_linked, no write (Review Focus 5)',
    async (over) => {
      const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(json({ Invoices: [remote(over)] }));
      await expect(voidXeroInvoice(ctx, 'xi-1')).rejects.toMatchObject({ kind: 'payment_linked', provider: 'xero' });
      expect(callsOf(fetchMock)).toHaveLength(1);
    },
  );

  it('a payment applied between the read and the void → payment_linked from Xero\'s 400', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ Invoices: [remote()] }))
      .mockResolvedValueOnce(failing400('The status VOIDED cannot be applied to the invoice because it has payments or credit notes allocated to it.'));
    await expect(voidXeroInvoice(ctx, 'xi-1')).rejects.toMatchObject({ kind: 'payment_linked' });
  });

  it('an unknown status is transient (never guessed)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(json({ Invoices: [remote({ Status: 'SOMETHING_NEW' })] }));
    await expect(voidXeroInvoice(ctx, 'xi-1')).rejects.toMatchObject({ kind: 'transient' });
  });
});

describe('voidXeroInvoice — bounded outcomes', () => {
  it('a timed-out void is transient; the retry reads VOIDED and succeeds without a second write', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ Invoices: [remote()] }))
      .mockRejectedValueOnce(timeout())
      .mockResolvedValueOnce(json({ Invoices: [remote({ Status: 'VOIDED', UpdatedDateUTC: '/Date(1790000100000+0000)/' })] }));
    await expect(voidXeroInvoice(ctx, 'xi-1')).rejects.toMatchObject({ kind: 'transient' });
    await expect(voidXeroInvoice(ctx, 'xi-1')).resolves.toEqual({ remoteVersion: new Date(1790000100000).toISOString() });
    expect(callsOf(fetchMock).map((c) => c.method)).toEqual(['GET', 'POST', 'GET']);
  });

  it('an element with HasErrors on the void response is a validation failure carrying its message', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ Invoices: [remote()] }))
      .mockResolvedValueOnce(json({ Invoices: [{ InvoiceID: 'xi-1', HasErrors: true, ValidationErrors: [{ Message: 'Invoice not of valid status for modification' }] }] }));
    await expect(voidXeroInvoice(ctx, 'xi-1')).rejects.toMatchObject({
      kind: 'validation', provider: 'xero', providerMessage: 'Invoice not of valid status for modification',
    });
  });
});
