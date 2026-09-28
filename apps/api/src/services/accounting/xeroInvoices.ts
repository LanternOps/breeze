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
import { createHash } from 'node:crypto';
import { AccountingProviderError, isAccountingProviderError, providerErrorKindOf } from './accountingProviderError';
import { allocateInvoiceTax, isZeroAmount } from './accountingTaxAllocation';
import { parseXeroDate, requireXeroBody, xeroApiGet, xeroApiWrite, xeroArray, xeroQuery, type XeroCallContext } from './xeroHttp';
import { readXeroItemRefs, type XeroItemRef } from './xeroItems';
import type { AccountingConnection } from './accountingConnectionService';
import type {
  AccountingInvoiceLineMapping, AccountingInvoiceLinePayload, AccountingInvoicePayload, AccountingInvoicePreflightRefusal,
  InvoicePushResult, InvoiceVoidResult,
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

// ---------------------------------------------------------------------------
// I/O: lookup, push (create with adoption, re-push), void
// ---------------------------------------------------------------------------

interface InvoicesBody { Invoices?: XeroInvoice[] }
type CreateVariant = 'with-number' | 'without-number';

const READ_QUERY = xeroQuery({ unitdp: 4 });
const WRITE_QUERY = xeroQuery({ unitdp: 4, summarizeErrors: true });
const LIVE_STATUSES: ReadonlySet<string> = new Set(['DRAFT', 'SUBMITTED', 'AUTHORISED', 'PAID']);
const GONE_STATUSES: ReadonlySet<string> = new Set(['VOIDED', 'DELETED']);

/**
 * Refinement 2: one key per request IDENTITY — tenant, Breeze invoice, variant
 * and the voided predecessors the latest lookup saw — never per request bytes,
 * so two concurrent pushes whose bodies differ cannot mint two creates: the
 * second replays the first, or gets Xero's key-reuse 400 (transient → look again).
 */
export function xeroInvoiceIdempotencyKey(
  tenantId: string, invoiceId: string, variant: CreateVariant, supersededIds: readonly string[],
): string {
  const input = ['invoice', tenantId, invoiceId, variant, [...supersededIds].sort().join(',')].join('\n');
  return `breeze-inv-${createHash('sha256').update(input).digest('hex')}`;
}

function refusal(kind: 'validation' | 'not_found', providerCode: string, operation: string, message: string, cause?: unknown): AccountingProviderError {
  return new AccountingProviderError({
    kind, provider: 'xero', operation, message, providerCode, ...(kind === 'not_found' ? { httpStatus: 404 } : {}), cause,
  });
}
const remoteMissing = (operation: string, cause?: unknown) =>
  refusal('not_found', 'remote_missing', operation, `${operation} found the invoice gone or voided in Xero`, cause);
const remoteLocked = (operation: string, cause?: unknown) =>
  refusal('validation', 'remote_locked', operation, `${operation} refused: a payment or credit is applied in Xero and the amounts differ`, cause);

/** Refinement 10: every Xero invoice carrying our adoption key, split into live and superseded. */
export async function findXeroInvoicesByReference(
  ctx: XeroCallContext,
  invoiceId: string,
): Promise<{ live: XeroInvoice[]; supersededIds: string[] }> {
  const operation = 'Xero invoice lookup';
  const reference = xeroInvoiceReference(invoiceId);
  const body = requireXeroBody(
    await xeroApiGet<InvoicesBody | null>(ctx, `Invoices${xeroQuery({ where: `Reference=="${reference}"`, unitdp: 4 })}`, operation),
    operation,
  );
  const ours = xeroArray<XeroInvoice>(body.Invoices)
    .filter((i) => i.InvoiceID && (i.Type ?? 'ACCREC') === 'ACCREC' && i.Reference === reference);
  return {
    live: ours.filter((i) => LIVE_STATUSES.has(i.Status ?? '')),
    supersededIds: ours.filter((i) => GONE_STATUSES.has(i.Status ?? '')).map((i) => i.InvoiceID as string).sort(),
  };
}

/** One invoice by id, or null on a 404. */
async function readXeroInvoice(ctx: XeroCallContext, invoiceId: string): Promise<XeroInvoice | null> {
  const operation = 'Xero invoice read';
  let body: InvoicesBody | null;
  try {
    body = await xeroApiGet<InvoicesBody | null>(ctx, `Invoices/${encodeURIComponent(invoiceId)}${READ_QUERY}`, operation);
  } catch (err) {
    if (isAccountingProviderError(err) && err.kind === 'not_found') return null;
    throw err;
  }
  return xeroArray<XeroInvoice>(requireXeroBody(body, operation).Invoices)[0] ?? null;
}

/** The single live invoice, null for none, and a refusal for two or more (never guess). */
function onlyLive(found: { live: XeroInvoice[] }): XeroInvoice | null {
  if (found.live.length > 1) {
    throw refusal('validation', 'duplicate_key', 'Xero invoice lookup', `Xero holds ${found.live.length} live invoices for this Breeze invoice`);
  }
  return found.live[0] ?? null;
}

function centsOf(value: number | string | null | undefined): number | null {
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) ? Math.round(n * 100) : null;
}

/** A locked (paid-toward) invoice already carries Breeze's money (refinement 7). */
function matchesBreeze(existing: XeroInvoice, invoice: AccountingInvoicePayload): boolean {
  return (existing.CurrencyCode ?? '').toUpperCase() === invoice.currencyCode.toUpperCase()
    && existing.Contact?.ContactID === invoice.customerRef.id
    && centsOf(existing.SubTotal) !== null && centsOf(existing.SubTotal) === centsOf(invoice.subtotal)
    && centsOf(existing.TotalTax) === centsOf(invoice.taxTotal)
    && centsOf(existing.Total) === centsOf(invoice.total);
}

function moneyApplied(existing: XeroInvoice): boolean {
  return (existing.AmountPaid ?? 0) > 0 || (existing.AmountCredited ?? 0) > 0;
}

type ItemLoader = () => Promise<ReadonlyMap<string, XeroItemRef>>;

/** Reads the price list at most once, and only if some line has a mapped item. */
function itemLoader(ctx: XeroCallContext, lineMappings: readonly AccountingInvoiceLineMapping[]): ItemLoader {
  let pending: Promise<ReadonlyMap<string, XeroItemRef>> | null = null;
  const needed = lineMappings.some((m) => m.remoteItemRef);
  return () => {
    if (!needed) return Promise.resolve(new Map());
    pending ??= readXeroItemRefs(ctx);
    return pending;
  };
}

interface PushContext {
  ctx: XeroCallContext;
  conn: XeroInvoiceSettings;
  invoice: AccountingInvoicePayload;
  lineMappings: readonly AccountingInvoiceLineMapping[];
  loadItems: ItemLoader;
}

/** An invoice that already exists in Xero (mapped, or adopted by Reference): resend, accept, or refuse. */
async function settleExisting(p: PushContext, existing: XeroInvoice): Promise<InvoicePushResult> {
  const operation = 'Xero invoice update';
  const id = existing.InvoiceID as string;
  const status = existing.Status ?? '';
  if (GONE_STATUSES.has(status)) throw remoteMissing(operation);
  if (status === 'PAID' || moneyApplied(existing)) {
    // Xero will not edit the lines now; accept them only if they carry Breeze's money.
    if (matchesBreeze(existing, p.invoice)) return toXeroPushResult(existing, 'Xero invoice read');
    throw remoteLocked(operation);
  }
  // InvoiceNumber is never sent on an update (refinement 1): Xero keeps its own.
  const body = { ...buildXeroInvoice(p.invoice, p.lineMappings, await p.loadItems(), p.conn, { includeNumber: false }), InvoiceID: id };
  try {
    const res = requireXeroBody(
      await xeroApiWrite<InvoicesBody | null>(p.ctx, 'POST', `Invoices/${encodeURIComponent(id)}${WRITE_QUERY}`, { Invoices: [body] }, operation),
      operation,
    );
    return toXeroPushResult(xeroArray<XeroInvoice>(res.Invoices)[0], operation);
  } catch (err) {
    // A payment applied between our read and this write: Xero refuses the line edit.
    if (providerErrorKindOf(err) === 'payment_linked') throw remoteLocked(operation, err);
    throw err;
  }
}

async function createInvoice(p: PushContext, variant: CreateVariant, supersededIds: readonly string[]): Promise<InvoicePushResult> {
  const operation = 'Xero invoice create';
  const payload = {
    Invoices: [buildXeroInvoice(p.invoice, p.lineMappings, await p.loadItems(), p.conn, { includeNumber: variant === 'with-number' })],
  };
  const res = requireXeroBody(
    await xeroApiWrite<InvoicesBody | null>(p.ctx, 'PUT', `Invoices${WRITE_QUERY}`, payload, operation, {
      idempotencyKey: xeroInvoiceIdempotencyKey(p.ctx.tenantId, p.invoice.invoiceId, variant, supersededIds),
    }),
    operation,
  );
  return toXeroPushResult(xeroArray<XeroInvoice>(res.Invoices)[0], operation);
}

async function createAdopting(p: PushContext, initialSupersededIds: readonly string[]): Promise<InvoicePushResult> {
  let supersededIds = initialSupersededIds;
  /** After an outcome our create (or a peer's) may have survived: adopt what landed, or null. */
  const lookAgain = async (): Promise<InvoicePushResult | null> => {
    const found = await findXeroInvoicesByReference(p.ctx, p.invoice.invoiceId);
    supersededIds = found.supersededIds; // the LATEST view keys the next create (quorum finding 2)
    const live = onlyLive(found);
    return live ? settleExisting(p, live) : null;
  };

  try {
    return await createInvoice(p, 'with-number', supersededIds);
  } catch (err) {
    const kind = providerErrorKindOf(err);
    if (kind !== 'transient' && kind !== 'duplicate_doc_number') throw err;
    const adopted = await lookAgain();
    if (adopted) return adopted;
    if (kind !== 'duplicate_doc_number') throw err;
  }
  // Refinement 9: the number belongs to a document that is not ours. One retry
  // without it, under the without-number key.
  try {
    return await createInvoice(p, 'without-number', supersededIds);
  } catch (err) {
    if (providerErrorKindOf(err) !== 'transient') throw err;
    const adopted = await lookAgain();
    if (adopted) return adopted;
    throw err;
  }
}

/**
 * Push one Breeze invoice. Mapped → read and settle. Unmapped → adoption
 * lookup by Reference, then create (with adoption after an uncertain outcome
 * and the duplicate-number fallback). Named so the call-site contract test
 * (M10) never mistakes it for `AccountingProvider.pushInvoice`.
 */
export async function pushXeroInvoice(
  ctx: XeroCallContext,
  conn: XeroInvoiceSettings,
  invoice: AccountingInvoicePayload,
  lineMappings: readonly AccountingInvoiceLineMapping[],
): Promise<InvoicePushResult> {
  const p: PushContext = { ctx, conn, invoice, lineMappings, loadItems: itemLoader(ctx, lineMappings) };
  if (invoice.mapping) {
    const existing = await readXeroInvoice(ctx, invoice.mapping.remoteEntityId);
    if (!existing) throw remoteMissing('Xero invoice read');
    return settleExisting(p, existing);
  }
  const found = await findXeroInvoicesByReference(ctx, invoice.invoiceId);
  const adopted = onlyLive(found);
  if (adopted) return settleExisting(p, adopted);
  return createAdopting(p, found.supersededIds);
}

/** Refinement 22: the live invoice a push of this Breeze invoice created, or null. */
export async function findPushedXeroInvoice(ctx: XeroCallContext, invoiceId: string): Promise<{ id: string; remoteVersion?: string } | null> {
  const live = onlyLive(await findXeroInvoicesByReference(ctx, invoiceId));
  if (!live) return null;
  const remoteVersion = parseXeroDate(live.UpdatedDateUTC);
  return { id: live.InvoiceID as string, ...(remoteVersion ? { remoteVersion } : {}) };
}

/**
 * Void one Xero invoice (refinement 8). Reads first: absent or already
 * VOIDED/DELETED is success (the desired end state holds); money applied is
 * `payment_linked` (the core's void-with-payments flow, #5180); DRAFT and
 * SUBMITTED are DELETED (Xero cannot void them); AUTHORISED is VOIDED.
 */
export async function voidXeroInvoice(ctx: XeroCallContext, remoteInvoiceId: string): Promise<InvoiceVoidResult> {
  const operation = 'Xero invoice void';
  const existing = await readXeroInvoice(ctx, remoteInvoiceId);
  if (!existing) return { remoteVersion: null };
  const status = existing.Status ?? '';
  if (GONE_STATUSES.has(status)) return { remoteVersion: parseXeroDate(existing.UpdatedDateUTC) };
  if (status === 'PAID' || moneyApplied(existing)) {
    throw new AccountingProviderError({
      kind: 'payment_linked', provider: 'xero', operation, message: `${operation} refused: a payment or credit is applied in Xero`,
    });
  }
  if (!LIVE_STATUSES.has(status)) {
    throw new AccountingProviderError({ kind: 'transient', provider: 'xero', operation, message: `${operation} found an unknown invoice status` });
  }
  const target = status === 'AUTHORISED' ? 'VOIDED' : 'DELETED';
  const res = requireXeroBody(
    await xeroApiWrite<InvoicesBody | null>(
      ctx, 'POST', `Invoices/${encodeURIComponent(remoteInvoiceId)}${WRITE_QUERY}`, { Invoices: [{ InvoiceID: remoteInvoiceId, Status: target }] }, operation,
    ),
    operation,
  );
  const updated = xeroArray<XeroInvoice>(res.Invoices)[0];
  if (updated?.HasErrors) {
    throw validation(operation, `${operation} was rejected by Xero`, updated.ValidationErrors?.find((v) => v?.Message)?.Message);
  }
  return { remoteVersion: parseXeroDate(updated?.UpdatedDateUTC) };
}
