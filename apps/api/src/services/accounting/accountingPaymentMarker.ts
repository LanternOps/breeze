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

/**
 * Worker lease on a `pending_op` mapping row (spec decision 2).
 *
 * Here, not in `accountingPaymentPush.ts`, for the same reason
 * `paymentMappingRemoteId` is: BOTH directions now depend on it. The PUSH
 * claims a row with it; the PULL has to respect it, because a CDC deletion that
 * drops a delete-pending mapping while a delete worker holds the lease would
 * pull the row out from under a job that is mid-flight. A `pull -> push` import
 * would drag the provider registry and the mapping service into every pull unit
 * test; this module imports nothing, so it can never do that or close a cycle.
 * Re-exported from `accountingPaymentPush.ts` so its existing importers are
 * unaffected.
 */
export const PAYMENT_CLAIM_LEASE_MS = 10 * 60 * 1000;

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

/**
 * The ONE divergence string both refund paths write into `last_error` — the
 * Stripe webhook (`stripeReconcile.reflectStripeRefund`, partial-refund arm) and
 * this module's own mid-flight `diverged` branch. Sharing it is not tidiness:
 * two texts quoting two different quantities is how a bookkeeper enters the
 * wrong refund.
 *
 * `totalRefunded` is the CUMULATIVE amount refunded so far, in the payment's
 * currency, 2dp — Stripe's `amount_refunded` is itself cumulative, and the
 * coordinator derives the same figure as (pushed amount − current amount). The
 * wording restates it as a RUNNING TOTAL on purpose: the previous text quoted a
 * bare amount ("Partially refunded in Stripe (67.00)"), which a bookkeeper who
 * had already recorded an earlier 40.00 refund read as a second, fresh 67.00 to
 * enter. The trailing clause says what QuickBooks currently shows, so the reader
 * can reconcile the two numbers without opening Stripe.
 */
const PARTIAL_REFUND_DIVERGENCE_PREFIX = 'Refunded in Stripe, total ';

export function partialRefundDivergenceMessage(totalRefunded: string): string {
  return `${PARTIAL_REFUND_DIVERGENCE_PREFIX}${totalRefunded}; record the refund in QuickBooks `
    + '(this QuickBooks payment still shows the full amount)';
}

/**
 * Is this `last_error` already a partial-refund instruction?
 *
 * The pull asks before it marks a Breeze-origin echo diverged (review finding
 * 3). After a Stripe partial refund the Breeze amount is deliberately LOWER
 * than the QuickBooks Payment's — that gap IS the refund the operator has been
 * told to enter — so every later re-save of that Payment reaches
 * `applyBreezeOriginEcho` looking like an amount change. Overwriting the
 * instruction with the generic "Edited in QuickBooks" text destroys the only
 * place the amount to enter was recorded, and audits an edit nobody made.
 *
 * Matched on the PREFIX, not the whole string: the quoted running total moves
 * with each further refund, and a row carrying an older total is still carrying
 * a refund instruction.
 */
export function isPartialRefundDivergenceMessage(message: string | null | undefined): boolean {
  return typeof message === 'string' && message.startsWith(PARTIAL_REFUND_DIVERGENCE_PREFIX);
}
