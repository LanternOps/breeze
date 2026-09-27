/**
 * Error type of the invoice push/void coordinator (`accountingInvoicePush.ts`).
 * Its own module so the provider-neutral helpers that coordinator imports
 * (`accountingInvoiceTotals.ts`) can throw it without an import cycle.
 * `accountingInvoicePush.ts` re-exports both names, so existing imports are
 * unchanged.
 */
import type { AccountingThrottleSource } from './accountingProviderError';

export type AccountingInvoicePushErrorCode =
  | 'not_connected' | 'reauth_required' | 'invoice_not_pushable' // draft or unknown invoice
  // The invoice's mapping row is the `markInvoiceDeletedRemotely` marker (#4544):
  // the reconcile worker saw QuickBooks delete/void the previously-pushed
  // invoice. Deliberately never auto-resurrected (Phase D decision 2) — a push
  // must not silently clear the marker and re-create a second QuickBooks
  // invoice for a document the operator (or QuickBooks user) removed there.
  | 'remote_deleted'
  | 'customer_not_mapped' // org mapping absent / not confirmed|create_new
  | 'home_currency_unknown' | 'currency_mismatch' // realm-level (from assert)
  | 'customer_currency_mismatch' // mapping.remoteCurrencyCode ≠ invoice.currencyCode
  // A nested org/catalog-item sync (syncMappedEntity) hit a permanent
  // pre-flight 409 on the DEPENDENCY entity — no income account selected, no
  // item price in the partner currency, a create-time currency mismatch on
  // the org/item itself, or a mapping-conflict race. None of these are a
  // QuickBooks/network failure (nothing was even sent to QuickBooks), so they
  // must NOT be reported as `provider_error`: that code is paired with 502
  // and read by callers as "safe to retry the QuickBooks call" — retrying a
  // call that never ran, against a mapping that is still broken, would just
  // loop. Fix the dependency's mapping, then retry the invoice push.
  | 'dependency_not_ready'
  // A void found the invoice's mapping row `pending` with no remoteEntityId —
  // a push is mid-flight. Deliberately NOT in the worker's TERMINAL_CODES:
  // BullMQ must retry with backoff until the push records its remote id.
  | 'sync_in_progress'
  // QuickBooks refused the void because a Payment is applied to the invoice
  // THERE (#5180). A business rule, not an outage: every retry gets the same
  // answer, so this must not be reported as `provider_error` — that code is
  // paired with 502 and read as "safe to retry", and the five-attempt ladder
  // burned five Sentry alerts on it in production. Terminal in the worker; the
  // mapping row carries a message naming the fix (unapply the payment in
  // QuickBooks, then void again).
  | 'void_blocked_by_payments'
  // #7161: the lines about to be pushed do not sum to the invoice's own
  // subtotal, so QuickBooks would record a different amount than the customer
  // was billed. Refused BEFORE any dependency sync, token refresh or provider
  // call, and persisted on the invoice's mapping row like `currency_mismatch`.
  // A Breeze-side data problem, not an outage: every retry would refuse the
  // same way, so it is terminal in the worker.
  | 'invoice_totals_mismatch'
  // The provider (or Breeze's own limiter) is throttling: the throttled call
  // itself was not accepted remotely — though a dependency sync that ran
  // earlier in the same push may have been (translateNestedSyncError), which
  // the retry re-reads through its mapping. 429 with `retryAfterMs` and
  // `throttleSource`; the worker DELAYS the job without
  // consuming an attempt (jobs/accountingJobDelay.ts), the route answers 429 +
  // Retry-After. Deliberately NOT in the worker's TERMINAL_CODES.
  | 'rate_limited'
  | 'provider_error' | 'record_failed' // 502s; record_failed = remote ok, local persist failed (never retry)
  // 'quickbooks_error': pre-W01 alias; never produced any more, kept for compile compatibility
  | 'quickbooks_error';

export class AccountingInvoicePushError extends Error {
  /** Set on `rate_limited` only: how long to wait before retrying. */
  readonly retryAfterMs?: number;
  /** Set on `rate_limited` only: who throttled (provider 429, Breeze's limiter, or its store). */
  readonly throttleSource?: AccountingThrottleSource;
  constructor(
    public readonly code: AccountingInvoicePushErrorCode,
    public readonly status: 404 | 409 | 429 | 502,
    message: string,
    opts: { retryAfterMs?: number; throttleSource?: AccountingThrottleSource; cause?: unknown } = {},
  ) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = 'AccountingInvoicePushError';
    this.retryAfterMs = opts.retryAfterMs;
    this.throttleSource = opts.throttleSource;
  }
}
