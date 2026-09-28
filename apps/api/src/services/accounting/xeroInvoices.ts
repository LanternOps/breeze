/**
 * Xero sales invoices (ACCREC) for invoice push and void (Xero W04). Owns these
 * refinements of plan 2026-09-27-xero-w04-invoice-push-void.md:
 *   3  each line's exact amount, never Xero's rounding
 *   4  "taxed" = taxable AND the invoice's tax is non-zero
 *   5  per-line TaxAmount from accountingTaxAllocation (switchable)
 *   6  the synchronous pre-flight
 *   12 ItemCode plus the item's own sales account; a missing item is not fatal
 *   13 summarizeErrors=true, and a HasErrors element is a failure
 * The I/O half (lookup, push, re-push, void) follows the pure half.
 */
import { AccountingProviderError } from './accountingProviderError';
import { allocateInvoiceTax, isZeroAmount } from './accountingTaxAllocation';
import { parseXeroDate } from './xeroHttp';
import type { XeroItemRef } from './xeroItems';
import type { AccountingConnection } from './accountingConnectionService';
import type {
  AccountingInvoiceLineMapping, AccountingInvoiceLinePayload, AccountingInvoicePayload, AccountingInvoicePreflightRefusal,
  InvoicePushResult,
} from './types';

export const XERO_INVOICE_REFERENCE_PREFIX = 'breeze:';
/**
 * Send the allocated tax per line (spec W04 "Tax allocation"). Lab X34/X35
 * settles spec open item 1; if Xero rejects overrides, set this to false:
 * Xero then calculates, and the post-push drift check flags any difference.
 */
export const XERO_SEND_LINE_TAX_AMOUNT = true;
const DESCRIPTION_MAX = 4000;
const EMPTY_DESCRIPTION = 'Invoice line';
const SETTINGS_HOME = 'Integrations → Accounting → Xero';

export type XeroInvoiceSettings = Pick<AccountingConnection, 'defaultIncomeAccountRef' | 'defaultTaxCodeRef' | 'defaultExemptTaxCodeRef'>;

export interface XeroInvoiceLine {
  Description: string; Quantity: number; UnitAmount: number; AccountCode: string; TaxType: string;
  TaxAmount?: number; ItemCode?: string;
}

export interface XeroInvoice {
  InvoiceID?: string; Type?: string; InvoiceNumber?: string; Reference?: string; Status?: string;
  Contact?: { ContactID?: string }; Date?: string; DueDate?: string; CurrencyCode?: string; LineAmountTypes?: string;
  LineItems?: XeroInvoiceLine[]; SubTotal?: number; TotalTax?: number; Total?: number;
  AmountPaid?: number; AmountCredited?: number; UpdatedDateUTC?: string;
  HasErrors?: boolean; ValidationErrors?: Array<{ Message?: string }>;
}

export function xeroInvoiceReference(invoiceId: string): string {
  return `${XERO_INVOICE_REFERENCE_PREFIX}${invoiceId}`;
}

function validation(operation: string, message: string, providerMessage?: string): AccountingProviderError {
  return new AccountingProviderError({ kind: 'validation', provider: 'xero', operation, message, providerMessage });
}

/** Refinement 4: a line is taxed only if it is taxable AND the invoice actually carries tax. */
function taxedFlags(invoice: Pick<AccountingInvoicePayload, 'taxTotal' | 'lines'>): boolean[] {
  const invoiceTaxed = !isZeroAmount(invoice.taxTotal);
  return invoice.lines.map((l) => l.taxable && invoiceTaxed);
}

function taxShares(invoice: Pick<AccountingInvoicePayload, 'currencyCode' | 'taxTotal' | 'lines'>, taxed: boolean[]): string[] | null {
  return allocateInvoiceTax(invoice.taxTotal, invoice.lines.map((l, i) => ({ lineTotal: l.lineTotal, taxed: taxed[i]! })), invoice.currencyCode);
}

function joinList(items: string[]): string {
  return items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

export function xeroInvoicePreflight(
  conn: XeroInvoiceSettings,
  invoice: Pick<AccountingInvoicePayload, 'currencyCode' | 'taxTotal' | 'lines'>,
): AccountingInvoicePreflightRefusal | null {
  const taxed = taxedFlags(invoice);
  if (!taxShares(invoice, taxed)) {
    return {
      reason: 'totals',
      message: `This invoice records ${invoice.taxTotal} of tax, but none of its taxable lines carries an amount, so Xero cannot place that tax on a line. Review the invoice lines and tax, then push again.`,
    };
  }
  const missing: string[] = [];
  if (!conn.defaultIncomeAccountRef) missing.push('a revenue account');
  if (taxed.some(Boolean) && !conn.defaultTaxCodeRef) missing.push('a tax rate for taxable lines');
  if (taxed.some((t) => !t) && !conn.defaultExemptTaxCodeRef) missing.push('a tax rate for non-taxable lines');
  return missing.length
    ? { reason: 'settings', message: `Choose ${joinList(missing)} in ${SETTINGS_HOME}, then push again` }
    : null;
}

/** Exact scaled integer of a decimal string (no significant digit past `scale`), else null. */
function scaled(value: string, scale: number): bigint | null {
  const m = /^(-)?(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (!m) return null;
  const frac = m[3] ?? '';
  if (/[1-9]/.test(frac.slice(scale))) return null;
  const n = BigInt(`${m[2]}${frac.slice(0, scale).padEnd(scale, '0')}`);
  return m[1] ? -n : n;
}

/**
 * The JSON number that serializes to EXACTLY the decimal `n × 10^-scale`, else
 * null. Parses the decimal text (correctly rounded) rather than computing
 * `Number(n) / 10 ** scale`, which drifts once `n` passes 2^53
 * (45035996273704.97 → …98), then proves the round trip: `String(num)` is what
 * `JSON.stringify` sends, so a value no double carries exactly (more than ~15
 * significant digits) is refused here instead of reaching Xero as a nearby
 * amount. Unreachable for the numeric(12,2) columns the payload comes from.
 */
function exactNumber(n: bigint, scale: number): number | null {
  const abs = n < 0n ? -n : n;
  const unit = 10n ** BigInt(scale);
  const num = Number(`${n < 0n ? '-' : ''}${abs / unit}.${String(abs % unit).padStart(scale, '0')}`);
  return scaled(String(num), scale) === n ? num : null;
}

function description(text: string, suffix = ''): string {
  const base = text.trim() || EMPTY_DESCRIPTION;
  return `${base.slice(0, DESCRIPTION_MAX - suffix.length)}${suffix}`;
}

/**
 * Refinement 3: Quantity and UnitAmount whose product is EXACTLY the Breeze
 * line total, so Xero's LineAmount can never differ through its own rounding.
 * Throws `validation` when not even the line total can be sent exactly (never
 * for numeric(12,2) data) rather than sending a nearby float.
 */
export function xeroLineAmounts(
  line: Pick<AccountingInvoiceLinePayload, 'description' | 'quantity' | 'unitPrice' | 'lineTotal'>,
): { Description: string; Quantity: number; UnitAmount: number } {
  const q = scaled(line.quantity, 4);  // 1e-4 units; null past 4 places (unitdp=4)
  const u = scaled(line.unitPrice, 4); // 1e-4 units
  const t = scaled(line.lineTotal, 2); // cents
  const quantity = q === null ? null : exactNumber(q, 4);
  if (t !== null && q !== null && quantity !== null) {
    const target = t * 1_000_000n;     // cents → 1e-8 units, the scale of q × u
    // (a) as stored, when the product is exact
    const stored = u !== null && q * u === target ? exactNumber(u, 4) : null;
    if (stored !== null) return { Description: description(line.description), Quantity: quantity, UnitAmount: stored };
    // (b) the quantity with a unit exact to 4 places
    const derived = q !== 0n && target % q === 0n ? exactNumber(target / q, 4) : null;
    if (derived !== null) return { Description: description(line.description), Quantity: quantity, UnitAmount: derived };
  }
  // (c) quantity 1 at the line total, the stored figures kept in the text
  const total = t === null ? null : exactNumber(t, 2);
  if (total === null) {
    throw validation('Xero invoice payload', `An invoice line total (${line.lineTotal}) cannot be sent to Xero as an exact amount. Review the invoice lines, then push again.`);
  }
  const suffix = ` (${line.quantity} × ${line.unitPrice})`;
  return { Description: description(line.description, suffix), Quantity: 1, UnitAmount: total };
}

export function buildXeroInvoice(
  invoice: AccountingInvoicePayload,
  lineMappings: readonly AccountingInvoiceLineMapping[],
  items: ReadonlyMap<string, XeroItemRef>,
  conn: XeroInvoiceSettings,
  opts: { includeNumber: boolean; sendLineTax?: boolean },
): XeroInvoice {
  // Defence in depth: the coordinator ran the same pre-flight in Phase 1, but a
  // setting can change between then and now.
  const blocked = xeroInvoicePreflight(conn, invoice);
  if (blocked) throw validation('Xero invoice payload', blocked.message);
  const taxed = taxedFlags(invoice);
  const shares = taxShares(invoice, taxed) as string[]; // non-null: the pre-flight passed
  const sendLineTax = opts.sendLineTax ?? XERO_SEND_LINE_TAX_AMOUNT;
  const itemRefByLine = new Map(lineMappings.map((m) => [m.invoiceLineId, m.remoteItemRef]));

  const LineItems = invoice.lines.map((line, i): XeroInvoiceLine => {
    const remoteItemId = itemRefByLine.get(line.invoiceLineId)?.id;
    const item = remoteItemId ? items.get(remoteItemId) : undefined;
    if (remoteItemId && !item) {
      console.warn(`[xeroInvoices] mapped item ${remoteItemId} is not in Xero; line ${line.invoiceLineId} sent without ItemCode`);
    }
    return {
      ...xeroLineAmounts(line),
      AccountCode: item?.accountCode ?? (conn.defaultIncomeAccountRef as string),
      TaxType: (taxed[i] ? conn.defaultTaxCodeRef : conn.defaultExemptTaxCodeRef) as string,
      ...(sendLineTax ? { TaxAmount: Number(shares[i]) } : {}),
      ...(item ? { ItemCode: item.code } : {}),
    };
  });

  return {
    Type: 'ACCREC',
    Contact: { ContactID: invoice.customerRef.id },
    Date: invoice.txnDate,
    DueDate: invoice.dueDate ?? invoice.txnDate,
    ...(opts.includeNumber && invoice.docNumber ? { InvoiceNumber: invoice.docNumber } : {}),
    Reference: xeroInvoiceReference(invoice.invoiceId),
    CurrencyCode: invoice.currencyCode,
    Status: 'AUTHORISED',
    LineAmountTypes: 'Exclusive',
    LineItems,
  };
}

function money(value: unknown): string | null {
  return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(2) : null;
}

export function toXeroPushResult(invoice: XeroInvoice | undefined, operation: string): InvoicePushResult {
  if (invoice?.HasErrors) {
    const first = invoice.ValidationErrors?.find((v) => typeof v?.Message === 'string')?.Message;
    throw validation(operation, `${operation} was rejected by Xero`, first);
  }
  if (!invoice?.InvoiceID) {
    throw new AccountingProviderError({ kind: 'transient', provider: 'xero', operation, message: `${operation} returned no invoice` });
  }
  const remoteVersion = parseXeroDate(invoice.UpdatedDateUTC);
  return {
    id: invoice.InvoiceID,
    ...(invoice.InvoiceNumber ? { docNumber: invoice.InvoiceNumber } : {}),
    ...(remoteVersion ? { remoteVersion } : {}),
    remoteTaxTotal: money(invoice.TotalTax),
    remoteTotal: money(invoice.Total),
  };
}
