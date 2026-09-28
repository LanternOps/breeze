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
import { createHash } from 'node:crypto';
import { toMinorUnits } from '@breeze/shared';
import { AccountingProviderError } from './accountingProviderError';
import { parseBreezePaymentMarker } from './accountingPaymentMarker';
import {
  classifyXeroValidation, parseXeroDate, requireXeroBody, xeroApiGet, xeroApiWrite, xeroArray, xeroQuery,
  type XeroCallContext,
} from './xeroHttp';
import type { AccountingConnection } from './accountingConnectionService';
import type {
  AccountingPaymentPayload, ChangeSet, ChangeSetPaymentLine, PaymentDeleteResult, RemoteRef,
} from './types';

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
  /** OpenAPI `Payment.BatchPaymentID`: "Present if the payment was created as part of a batch." (#7300) */
  BatchPaymentID?: string;
  BatchPayment?: { BatchPaymentID?: string };
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

// ---------------------------------------------------------------------------
// Push (W05b)
// ---------------------------------------------------------------------------

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Refinement 17: parked, not failed; shown on the payment row and fixed in the settings step. */
export const XERO_PAYMENT_ACCOUNT_MISSING_MESSAGE =
  'Choose a bank account for payments in Integrations → Accounting → Xero; Breeze will send this payment when one is chosen';

export function xeroPaymentPreflight(conn: Pick<AccountingConnection, 'defaultPaymentAccountRef'>): string | null {
  return conn.defaultPaymentAccountRef?.trim() ? null : XERO_PAYMENT_ACCOUNT_MISSING_MESSAGE;
}

/**
 * One key per request IDENTITY, never per request bytes (refinement 15, W04's
 * lesson): the body carries a mutable setting (the bank account). Same inputs as
 * QuickBooks' requestid (`invoicePaymentId[:g<n>]`), so a fan-out re-own gets a
 * new key. 75 chars (Xero's cap is 128). Xero keeps a key only 6 minutes —
 * adoption, not the key, is the duplicate guard.
 */
export function xeroPaymentIdempotencyKey(tenantId: string, invoicePaymentId: string, pushGeneration: number): string {
  return `breeze-pay-${createHash('sha256').update([tenantId, invoicePaymentId, String(pushGeneration)].join('\n')).digest('hex')}`;
}

function paymentError(
  kind: 'validation' | 'transient',
  operation: string,
  message: string,
  providerCode?: string,
): AccountingProviderError {
  return new AccountingProviderError({ kind, provider: 'xero', operation, message, providerCode });
}

/** Xero ids are GUIDs; anything else must never be interpolated into a path or a `where` clause. */
function requireXeroGuid(value: string, operation: string): string {
  if (!GUID_RE.test(value)) throw paymentError('validation', operation, `${operation}: not a Xero id`);
  return value;
}

function toRemoteRef(p: XeroPayment): RemoteRef {
  const version = xeroPaymentVersion(p);
  return version ? { id: p.PaymentID!, remoteVersion: version } : { id: p.PaymentID! };
}

/** Payments on ONE invoice whose Reference carries THIS Breeze payment's marker, split live / deleted. */
export interface XeroMarkerHits { live: XeroPayment[]; deleted: XeroPayment[] }

/**
 * The adoption lookup (refinement 15). Fails CLOSED when the invoice's payment
 * list cannot be enumerated in one page (quorum finding 5): "no hit" must mean
 * "none exists", never "none on page 1". A thousand payments on one invoice is
 * not a real Breeze invoice, so this refuses (duplicate_key → remote_ambiguous)
 * rather than guessing.
 */
export async function lookUpXeroPaymentsByMarker(
  ctx: XeroCallContext,
  remoteInvoiceId: string,
  invoicePaymentId: string,
): Promise<XeroMarkerHits> {
  const operation = 'Xero payment lookup';
  const invoiceId = requireXeroGuid(remoteInvoiceId, operation);
  const body = await xeroApiGet<{ Payments?: unknown } | null>(
    ctx,
    `Payments${xeroQuery({ where: `Invoice.InvoiceID==guid("${invoiceId}")`, page: 1, pageSize: XERO_RECONCILE_PAGE_SIZE })}`,
    operation,
  );
  const all = xeroArray<XeroPayment>(body?.Payments);
  if (all.length >= XERO_RECONCILE_PAGE_SIZE) {
    throw paymentError('validation', operation, 'Xero returned too many payments on this invoice to rule out a duplicate', 'duplicate_key');
  }
  const ours = all.filter((p) =>
    isReceivable(p)
    && p.Invoice!.InvoiceID!.toLowerCase() === invoiceId.toLowerCase()
    && extractXeroPaymentMarker(p.Reference) === invoicePaymentId);
  return {
    live: ours.filter((p) => p.Status === 'AUTHORISED'),
    deleted: ours.filter((p) => p.Status === 'DELETED'),
  };
}

/**
 * Create one Xero payment for one Breeze payment (refinements 15, 19).
 * Adoption lookup BEFORE the create and after any uncertain (`transient`)
 * outcome:
 *  - one live hit with the SAME amount and currency is returned instead of
 *    creating (quorum finding 6: a hit with another amount is not ours to adopt);
 *  - two live hits, or a mismatched one, refuse (duplicate_key → remote_ambiguous);
 *  - no live hit but a DELETED one, on a first-generation push, refuses with
 *    remote_deleted: a human deleted the payment Breeze created (whose response
 *    was lost), and re-creating it would resurrect it (quorum finding 4). A
 *    re-owned push (pushGeneration > 0, i.e. the operator pushed the invoice
 *    again) creates anew.
 * `reference` is `paymentMarker.embed(payment.reference, payment.marker)`.
 */
export async function createXeroPayment(
  ctx: XeroCallContext,
  conn: Pick<AccountingConnection, 'defaultPaymentAccountRef'>,
  payment: AccountingPaymentPayload,
  reference: string,
): Promise<RemoteRef> {
  const op = 'Xero payment create';
  const accountId = conn.defaultPaymentAccountRef?.trim();
  if (!accountId) throw paymentError('validation', op, XERO_PAYMENT_ACCOUNT_MISSING_MESSAGE);
  requireXeroGuid(payment.remoteInvoiceId, op);
  const currency = payment.currencyCode.trim().toUpperCase();
  const wantMinor = toMinorUnits(Number(payment.amount), currency);

  const look = async (): Promise<XeroPayment | null> => {
    const { live, deleted } = await lookUpXeroPaymentsByMarker(ctx, payment.remoteInvoiceId, payment.invoicePaymentId);
    if (live.length > 1) {
      throw paymentError('validation', op, 'Xero holds more than one payment for this Breeze payment', 'duplicate_key');
    }
    const hit = live[0];
    if (hit) {
      const hitCurrency = normalizeCurrency(hit.Invoice?.CurrencyCode) ?? currency;
      const hitMinor = typeof hit.Amount === 'number' ? toMinorUnits(hit.Amount, hitCurrency) : Number.NaN;
      if (hitCurrency !== currency || hitMinor !== wantMinor) {
        throw paymentError('validation', op, 'A Xero payment carries this Breeze payment marker with a different amount or currency', 'duplicate_key');
      }
      return hit;
    }
    if (deleted.length > 0 && payment.pushGeneration === 0) {
      throw paymentError('validation', op, 'The Xero payment Breeze created for this payment was deleted there', 'remote_deleted');
    }
    return null;
  };

  const existing = await look();
  if (existing) return toRemoteRef(existing);

  const body = {
    Payments: [{
      Invoice: { InvoiceID: payment.remoteInvoiceId },
      Account: { AccountID: accountId },
      Date: payment.txnDate,
      // 2dp decimal string → JSON number at the wire only; home currency only (refinement 19).
      Amount: Number(payment.amount),
      Reference: reference,
    }],
  };

  let created: { Payments?: unknown } | null;
  try {
    created = await xeroApiWrite<{ Payments?: unknown } | null>(
      ctx, 'PUT', `Payments${xeroQuery({ summarizeErrors: true })}`, body, op,
      { idempotencyKey: xeroPaymentIdempotencyKey(ctx.tenantId, payment.invoicePaymentId, payment.pushGeneration) },
    );
  } catch (err) {
    // Uncertain: a timeout, a 5xx, or Xero's key-reuse 400 (W04 → transient). Did it land?
    if (err instanceof AccountingProviderError && err.kind === 'transient') {
      const adopted = await look();
      if (adopted) return toRemoteRef(adopted);
    }
    throw err;
  }

  const row = xeroArray<XeroPayment>(requireXeroBody(created, op).Payments)[0];
  if (row?.HasValidationErrors || (row?.ValidationErrors?.length ?? 0) > 0) {
    const text = JSON.stringify({ Elements: [{ ValidationErrors: row!.ValidationErrors ?? [] }] });
    throw paymentError('validation', op, 'Xero rejected the payment', classifyXeroValidation(text));
  }
  if (!row?.PaymentID) throw paymentError('transient', op, `${op} returned no PaymentID`);
  // A create answered with a DELETED row (e.g. a replayed response for a payment
  // deleted since) must never be recorded as live: the pull would then reverse
  // the Breeze payment on its next read. Park it for an operator instead.
  if (row.Status === 'DELETED') {
    throw paymentError('validation', op, 'Xero reports the payment Breeze created as deleted', 'remote_deleted');
  }
  return toRemoteRef(row);
}

const EMPTY_GUID = '00000000-0000-0000-0000-000000000000';

/**
 * A payment Xero created as part of a batch payment (#7300). Xero's OpenAPI
 * example value for `BatchPaymentID` is the all-zero GUID, so that — and an
 * empty string — is read as "no batch", never as membership.
 */
function xeroBatchPaymentId(p: XeroPayment): string | null {
  for (const id of [p.BatchPaymentID, p.BatchPayment?.BatchPaymentID]) {
    if (typeof id === 'string' && id.trim() !== '' && id.trim() !== EMPTY_GUID) return id;
  }
  return null;
}

/**
 * Delete one Xero payment (refinement 18). Read first: gone or DELETED →
 * already_absent (no write); a batch-payment member → remote_batched (no write,
 * #7300); reconciled → remote_locked (no write); else POST Status DELETED with
 * NO idempotency key (a cached error must not replay). A batch refusal that
 * only shows on the POST is classified by `classifyXeroValidation`.
 */
export async function deleteXeroPayment(ctx: XeroCallContext, remotePaymentId: string): Promise<PaymentDeleteResult> {
  const op = 'Xero payment delete';
  const id = requireXeroGuid(remotePaymentId, op);
  const readOp = 'Xero payment read';
  let current: XeroPayment | undefined;
  try {
    const body = await xeroApiGet<{ Payments?: unknown } | null>(ctx, `Payments/${id}`, readOp);
    current = xeroArray<XeroPayment>(requireXeroBody(body, readOp).Payments)[0];
  } catch (err) {
    if (err instanceof AccountingProviderError && err.kind === 'not_found') return 'already_absent';
    throw err;
  }
  // Xero answers an unknown id with 404 (handled above). A 2xx with no row is a
  // malformed response, not proof of absence: `already_absent` would drop the
  // mapping while a live payment may remain in Xero, so retry instead.
  if (!current) throw paymentError('transient', op, `${readOp} returned no payment`);
  if (current.Status === 'DELETED') return 'already_absent';
  // Batch before reconciled: a reconciled batch is unreconciled and deleted as a
  // batch, so the batch is the instruction the bookkeeper needs.
  if (xeroBatchPaymentId(current) !== null) {
    throw paymentError('validation', op, 'Xero will not delete one payment of a batch payment on its own', 'remote_batched');
  }
  if (current.IsReconciled === true) {
    throw paymentError('validation', op, 'Xero will not delete a reconciled payment', 'remote_locked');
  }
  try {
    await xeroApiWrite(ctx, 'POST', `Payments/${id}`, { Status: 'DELETED' }, op);
  } catch (err) {
    if (err instanceof AccountingProviderError && err.kind === 'not_found') return 'already_absent';
    throw err;
  }
  return 'deleted';
}
