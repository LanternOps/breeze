/**
 * Xero payments (spec W05). Pure Xero wire logic behind the neutral payment
 * core: the ownership marker in `Payment.Reference`, the If-Modified-Since
 * change pull, and (W05b) create / delete with adoption.
 *
 * Xero payments are delete-only ("Payments cannot be modified, only created and
 * deleted") and each applies to exactly ONE invoice, so a ChangeSet from here
 * never carries `unappliedPayments`, and the mapping id stays
 * `<PaymentID>/<InvoiceID>` (paymentMappingRemoteId).
 *
 * No function here is named createPayment/deletePayment (the call-site guard in
 * accountingInvoicePushCallSites.test.ts); the provider class wires them.
 */
import { toMinorUnits } from '@breeze/shared';
import { parseBreezePaymentMarker } from './accountingPaymentMarker';
import { parseXeroDate, xeroApiGet, xeroArray, xeroQuery, type XeroCallContext } from './xeroHttp';
import type { AccountingConnection } from './accountingConnectionService';
import type { ChangeSet, ChangeSetPaymentLine } from './types';

/** `limits.paymentRefMax`: the RAW human reference the core may pass (refinement 14). */
export const XERO_PAYMENT_REF_MAX = 64;
/** `invoice_payments.reference` is varchar(255); a pulled reference is clamped to it. */
export const XERO_PULLED_REFERENCE_MAX = 255;
export const XERO_RECONCILE_OVERLAP_MS = 5 * 60 * 1000;
export const XERO_RECONCILE_PAGE_SIZE = 1000;
/** Seek requests per list per run that move past the window start (refinement 11). */
export const XERO_RECONCILE_MAX_REQUESTS = 10;
/** Seek requests per list per run spent re-reading the overlap before the window start. */
export const XERO_RECONCILE_MAX_OVERLAP_REQUESTS = 10;
const MARKER_SEPARATOR = ' | ';

export interface XeroPayment {
  PaymentID?: string;
  PaymentType?: string;
  Status?: string;
  Date?: string;
  Amount?: number;
  Reference?: string;
  IsReconciled?: boolean;
  UpdatedDateUTC?: string;
  Invoice?: { InvoiceID?: string; Type?: string; CurrencyCode?: string };
  HasValidationErrors?: boolean;
  ValidationErrors?: Array<{ Message?: string }>;
}

interface XeroInvoiceRow { InvoiceID?: string; Type?: string; Status?: string; UpdatedDateUTC?: string }

// ---------------------------------------------------------------------------
// Ownership marker
// ---------------------------------------------------------------------------

/**
 * The marker FIRST, then the human reference: if Xero ever truncated the
 * field, it would cut the reference, never the ownership key. The core has
 * already cut the reference to XERO_PAYMENT_REF_MAX; the slice here is a
 * second, defensive cap.
 */
export function embedXeroPaymentMarker(reference: string | null, marker: string): string {
  const ref = reference?.trim() ?? '';
  return ref ? `${marker}${MARKER_SEPARATOR}${ref.slice(0, XERO_PAYMENT_REF_MAX)}` : marker;
}

/**
 * The text before the first separator. With no separator, one bare trailing
 * `|` is dropped: `"<marker> | "` trims to `"<marker> |"` (a reference edited
 * to nothing in Xero), and that must still claim. The rest must still be
 * exactly the marker, because the anchored parse runs on it.
 */
function markerHead(trimmed: string): string {
  const at = trimmed.indexOf(MARKER_SEPARATOR);
  if (at !== -1) return trimmed.slice(0, at);
  // Equivalent to .replace(/\s*\|$/, '') without backtracking on a long,
  // unbounded Reference.
  return trimmed.endsWith('|') ? trimmed.slice(0, -1).trimEnd() : trimmed;
}

/**
 * The Breeze payment id this Reference claims, or null. Reuses the anchored
 * QuickBooks grammar on the text BEFORE the first separator, so a Reference
 * that merely mentions a Breeze id never claims a row. A claim is still not an
 * authorisation: the pull adopts only a pending Breeze-origin row on the same
 * invoice for the same amount (accountingPaymentPull adoptBreezeOriginPayment).
 */
export function extractXeroPaymentMarker(text: string | null | undefined): string | null {
  if (typeof text !== 'string') return null;
  return parseBreezePaymentMarker(markerHead(text.trim()));
}

/** The human part of a Reference: after our marker, or the whole Reference when it carries none; ≤255; null when empty. */
export function xeroPaymentHumanReference(text: string | null | undefined): string | null {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  let human = trimmed;
  if (extractXeroPaymentMarker(trimmed) !== null) {
    const at = trimmed.indexOf(MARKER_SEPARATOR);
    human = at === -1 ? '' : trimmed.slice(at + MARKER_SEPARATOR.length).trim();
  }
  return human ? human.slice(0, XERO_PULLED_REFERENCE_MAX) : null;
}

// ---------------------------------------------------------------------------
// Pull
// ---------------------------------------------------------------------------

/** The ONE normalisation of a payment's version (refinement 13): ISO UpdatedDateUTC. */
export function xeroPaymentVersion(p: Pick<XeroPayment, 'UpdatedDateUTC'>): string | null {
  return parseXeroDate(p.UpdatedDateUTC);
}

function normalizeCurrency(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const code = value.trim().toUpperCase();
  return /^[A-Z]{3}$/.test(code) ? code : null;
}

function isReceivable(p: XeroPayment): boolean {
  return p.PaymentType === 'ACCRECPAYMENT'
    && typeof p.PaymentID === 'string' && p.PaymentID !== ''
    && typeof p.Invoice?.InvoiceID === 'string' && p.Invoice.InvoiceID !== ''
    && (p.Invoice.Type === undefined || p.Invoice.Type === 'ACCREC');
}

/**
 * A DELETED receivable payment. Downstream reversal is keyed on the PaymentID
 * alone, so the nested Invoice is not required: if Xero omits it on a deleted
 * row, the deletion must not be dropped silently. A row that names a
 * non-ACCREC document (a bill payment) is still excluded.
 */
function isReceivableDeletion(p: XeroPayment): boolean {
  return p.PaymentType === 'ACCRECPAYMENT'
    && typeof p.PaymentID === 'string' && p.PaymentID !== ''
    && (p.Invoice?.Type === undefined || p.Invoice.Type === 'ACCREC');
}

/**
 * One AUTHORISED receivable payment → one neutral line; anything else → null.
 * Overpayment/prepayment "payments" are REFUNDS and never reach here
 * (refinement 10). Xero has no payment-method field, so `method` is `other`
 * (never inferred, refinement 20).
 */
export function toChangeSetPaymentLine(
  p: XeroPayment,
  conn: Pick<AccountingConnection, 'homeCurrency'>,
): ChangeSetPaymentLine | null {
  if (!isReceivable(p) || p.Status !== 'AUTHORISED') return null;
  if (typeof p.Amount !== 'number' || !Number.isFinite(p.Amount)) return null;
  const currency = normalizeCurrency(p.Invoice?.CurrencyCode) ?? conn.homeCurrency ?? '';
  return {
    remoteInvoiceId: p.Invoice!.InvoiceID!,
    remotePaymentId: p.PaymentID!,
    amountMinor: toMinorUnits(p.Amount, currency),
    currency,
    txnDate: parseXeroDate(p.Date)?.slice(0, 10) ?? '',
    remotePaymentVersion: xeroPaymentVersion(p),
    paymentMethodName: null,
    method: 'other',
    paymentRefNum: xeroPaymentHumanReference(p.Reference),
    breezePaymentId: extractXeroPaymentMarker(p.Reference),
  };
}

interface SeekRead<T> {
  rows: T[];
  /** The request cap was hit: rows newer than `newest` may remain. */
  capped: boolean;
  /** A full page ended no later than the previous one (about 1,000 rows within
   * the ~2 s re-read window), or its last row had no parseable date. */
  stalled: boolean;
  newest: Date | null;
}

function dateOf(value: unknown): Date | null {
  const iso = parseXeroDate(value);
  return iso ? new Date(iso) : null;
}

function newestOf(rows: ReadonlyArray<{ UpdatedDateUTC?: string }>): Date | null {
  let newest: Date | null = null;
  for (const row of rows) {
    const at = dateOf(row.UpdatedDateUTC);
    if (at && (!newest || at > newest)) newest = at;
  }
  return newest;
}

/**
 * Every row of one list modified since `readFrom`, by SEEK paging (refinement 9):
 * each request is page 1, and a full page is followed by a request from
 * (its last row's UpdatedDateUTC − 1 s). Offset paging would lose a row whenever
 * a row on an earlier page is updated mid-read (quorum finding 1). Rows read
 * twice are de-duplicated by id; the later read wins.
 *
 * If-Modified-Since is second-granular, so the next request sends
 * floor(end − 1 s) and its window can reach back almost 2 s. A full page that
 * ends no later than the previous page did is a STALL: about 1,000 rows across
 * two adjacent seconds (not only within one) can cause it. A stall stops the
 * list loudly (`overflowed`, cursor held), and nothing is lost.
 *
 * Pages that end at or before `windowStart` (the 5-minute overlap) do not count
 * against XERO_RECONCILE_MAX_REQUESTS, so a dense overlap cannot stall the pull
 * (quorum finding 7); they have their own XERO_RECONCILE_MAX_OVERLAP_REQUESTS.
 */
async function readSeek<T extends { UpdatedDateUTC?: string }>(
  ctx: XeroCallContext,
  path: 'Payments' | 'Invoices',
  params: Record<string, string>,
  idOf: (row: T) => string | undefined,
  readFrom: Date,
  windowStart: Date,
  operation: string,
): Promise<SeekRead<T>> {
  const byId = new Map<string, T>();
  let since = readFrom;
  let lastEnd: number | null = null;
  let progressRequests = 0;
  let overlapRequests = 0;
  const done = (capped: boolean, stalled: boolean, newest?: Date): SeekRead<T> => {
    const rows = [...byId.values()];
    return { rows, capped, stalled, newest: newest ?? newestOf(rows) };
  };
  for (;;) {
    const body = await xeroApiGet<Record<string, unknown> | null>(
      ctx,
      `${path}${xeroQuery({ ...params, page: 1, pageSize: XERO_RECONCILE_PAGE_SIZE })}`,
      operation,
      { ifModifiedSince: since },
    );
    const pageRows = body === null ? [] : xeroArray<T>(body[path]);
    for (const row of pageRows) {
      const id = idOf(row);
      if (!id) continue;
      byId.delete(id);          // re-insert so iteration order follows the latest read
      byId.set(id, row);
    }
    if (pageRows.length < XERO_RECONCILE_PAGE_SIZE) return done(false, false);

    const end = dateOf(pageRows[pageRows.length - 1]!.UpdatedDateUTC)?.getTime() ?? null;
    if (end === null || (lastEnd !== null && end <= lastEnd)) return done(true, true);
    lastEnd = end;
    if (end <= windowStart.getTime()) overlapRequests += 1; else progressRequests += 1;
    if (progressRequests >= XERO_RECONCILE_MAX_REQUESTS || overlapRequests >= XERO_RECONCILE_MAX_OVERLAP_REQUESTS) {
      return done(true, false, new Date(end));
    }
    since = new Date(end - 1000);
  }
}

/**
 * `reconcileChanges` for Xero (refinements 9–13). Two paged, conditional reads:
 * AR payments (AUTHORISED → lines, DELETED → deletions) and voided/deleted AR
 * invoices. The cursor is the newest UpdatedDateUTC actually read, never below
 * the window start; a list that hit the request cap limits it to that list's
 * last row; a capped list with no progress at all is `overflowed`.
 *
 * Assumes `conn.accessToken` is valid (the worker resolves it first); issues no
 * DB queries.
 */
export async function readXeroPaymentChanges(
  ctx: XeroCallContext,
  conn: AccountingConnection,
  sinceCursor: Date | null,
): Promise<ChangeSet> {
  const windowStart = new Date(Math.max(sinceCursor?.getTime() ?? 0, conn.createdAt?.getTime() ?? 0));
  const readFrom = new Date(windowStart.getTime() - XERO_RECONCILE_OVERLAP_MS);

  const payments = await readSeek<XeroPayment>(
    ctx, 'Payments', { where: 'PaymentType=="ACCRECPAYMENT"', order: 'UpdatedDateUTC ASC' },
    (p) => p.PaymentID, readFrom, windowStart, 'Xero payment changes',
  );
  const invoices = await readSeek<XeroInvoiceRow>(
    ctx, 'Invoices', { Statuses: 'VOIDED,DELETED', where: 'Type=="ACCREC"', order: 'UpdatedDateUTC ASC' },
    (i) => i.InvoiceID, readFrom, windowStart, 'Xero invoice void changes',
  );

  const lines = new Map<string, ChangeSetPaymentLine>();
  const deleted = new Set<string>();
  for (const p of payments.rows) {
    if (p.Status === 'DELETED') {
      if (isReceivableDeletion(p)) { deleted.add(p.PaymentID!); lines.delete(p.PaymentID!); }
      continue;
    }
    if (!isReceivable(p)) continue;
    const line = toChangeSetPaymentLine(p, conn);
    if (line && !deleted.has(line.remotePaymentId)) lines.set(line.remotePaymentId, line);
  }
  const deletedInvoices = [...new Set(invoices.rows
    .filter((i) => typeof i.InvoiceID === 'string' && (i.Type ?? 'ACCREC') === 'ACCREC' && (i.Status === 'VOIDED' || i.Status === 'DELETED'))
    .map((i) => i.InvoiceID!))];

  let cursor = windowStart;
  let overflowed = false;
  const capped = [payments, invoices].filter((r) => r.capped);
  if (capped.some((r) => r.stalled)) {
    overflowed = true; // no progress possible: the worker holds the cursor and surfaces it
  } else if (capped.length > 0) {
    const earliest = Math.min(...capped.map((r) => r.newest?.getTime() ?? -Infinity));
    if (earliest <= windowStart.getTime()) overflowed = true;
    else cursor = new Date(earliest);
  } else {
    // The max across both lists assumes the Invoices read finishes within the
    // 5-minute overlap of the Payments read. The limiter rejects rather than
    // waits (withProviderCallSlot), which bounds the gap between them.
    const newest = Math.max(payments.newest?.getTime() ?? -Infinity, invoices.newest?.getTime() ?? -Infinity);
    if (newest > windowStart.getTime()) cursor = new Date(newest);
  }

  return {
    cursor,
    payments: [...lines.values()],
    deletedPayments: [...deleted],
    unappliedPayments: [],
    deletedInvoices,
    overflowed,
  };
}
