/**
 * The `PrivateNote` ownership marker Breeze writes onto every QuickBooks
 * Payment it creates, and the anchored grammar that reads it back (Phase D2,
 * spec decision 3).
 *
 * Its own module because BOTH directions must share one grammar and the two
 * users sit on opposite sides of a dependency edge: the provider PARSES it
 * (`mapQboCdcPayment`), the push coordinator BUILDS it. Putting the pair in
 * `quickbooksProvider.ts` would make the provider-neutral coordinator import a
 * provider implementation; putting them in `types.ts` would put runtime code in
 * a types-only module.
 *
 * WHY A MARKER AT ALL: QBO's `requestid` idempotency window is 24 hours and
 * `PrivateNote` is not queryable, so there is no recovery QUERY for a create
 * whose response was lost. Instead the CDC pull ADOPTS: a Payment whose note
 * names a pending Breeze payment fills in the remote id. That makes the marker
 * an authorisation token, which is why the grammar is anchored — a note that
 * merely CONTAINS the phrase (an operator pasting a Breeze reference into a
 * hand-entered Payment) must never claim a Breeze payment row.
 *
 * `paymentMappingRemoteId` lives here for the same reason: it is the OTHER
 * identity rule the two directions share, and keeping it in
 * `accountingPaymentPull.ts` would force the push coordinator to import the pull
 * module — closing a real cycle (invoiceService -> push -> pull ->
 * invoiceService). This module imports nothing, so it can never be in one.
 */

export const BREEZE_PAYMENT_NOTE_PREFIX = 'Breeze payment ';

/** Lowercase canonical uuid only — the ids Postgres hands back are lowercase. */
const MARKER = /^Breeze payment ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

export function buildPaymentPrivateNote(invoicePaymentId: string): string {
  return `${BREEZE_PAYMENT_NOTE_PREFIX}${invoicePaymentId}`;
}

/** The whole note, or nothing. Leading/trailing whitespace is trimmed first
 *  because QuickBooks' own UI round-trips a trailing newline into the field. */
export function parseBreezePaymentMarker(privateNote: string | null | undefined): string | null {
  if (typeof privateNote !== 'string') return null;
  return MARKER.exec(privateNote.trim())?.[1] ?? null;
}

/**
 * `<PaymentId>/<remoteInvoiceId>` — the at-most-once claim key on
 * `accounting_entity_mappings.remote_entity_id` (Phase D decision 1, and the
 * refinement recorded in `accountingCurrency.ts:190-200`).
 *
 * One QuickBooks Payment can settle SEVERAL invoices (a split payment carries one
 * `Line` per invoice). `accounting_entity_mappings_remote_uniq` is unique on
 * `(integration_id, remote_entity_type, remote_entity_id)`, so a bare Payment id
 * would let only the first split line claim a mapping and the rest would collide.
 * Qualifying it by the invoice makes each (payment, invoice) pair its own claim,
 * and `reverseAccountingPayment` recovers the whole set with a `<PaymentId>/%`
 * prefix match.
 */
export function paymentMappingRemoteId(remotePaymentId: string, remoteInvoiceId: string): string {
  return `${remotePaymentId}/${remoteInvoiceId}`;
}
