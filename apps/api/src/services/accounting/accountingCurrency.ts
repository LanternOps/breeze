import { fromMinorUnits } from '@breeze/shared';
import type { AccountingConnection } from './accountingConnectionService';
import type { AccountingProvider, ChangeSet } from './types';

/**
 * DERIVED from the provider interface, never re-declared. If Task 2's
 * pushInvoice payload is renamed or reshaped, this file stops compiling instead
 * of quietly guarding a shape nothing sends.
 */
type AccountingPushInvoicePayload = Parameters<AccountingProvider['pushInvoice']>[1];

/**
 * The accounting-seam currency contract (multi-currency spec §11, bug B8).
 *
 * Deliberately fail-closed, and deliberately STRICTER than the Stripe posture in
 * §10. Stripe warns-but-allows on a currency mismatch because the checkout still
 * presents the document's own currency; a QuickBooks push into a realm whose home
 * currency is different (or unknown) silently mis-books a ledger, so both cases
 * block. Foreign-currency push (CurrencyRef + ExchangeRate) is deferred beyond
 * this program: there is no conversion anywhere in this file.
 *
 * Pure by construction — no DB, no network, no clock. The Phase-C push entrypoint
 * and the Phase-D payment applier call these; neither exists yet.
 */
export type AccountingCurrencyContractErrorCode =
  | 'ACCOUNTING_HOME_CURRENCY_UNKNOWN'
  | 'ACCOUNTING_INVOICE_CURRENCY_MISMATCH'
  | 'ACCOUNTING_PAYMENT_CURRENCY_MISMATCH'
  | 'ACCOUNTING_PAYMENT_MINOR_UNITS_INVALID';

export class AccountingCurrencyContractError extends Error {
  constructor(
    message: string,
    readonly status: 409 | 502,
    readonly code: AccountingCurrencyContractErrorCode,
  ) {
    super(message);
    this.name = 'AccountingCurrencyContractError';
  }
}

/**
 * Exported so the Phase-B entity-create guard in `accountingMappingService.ts`
 * compares codes by exactly these rules rather than re-deriving them — a
 * second, subtly different normalization is how a guard drifts out of
 * agreement with the push guard it exists to protect.
 */
export function normalizeCurrencyCode(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const code = value.trim().toUpperCase();
  return code.length > 0 ? code : null;
}

const normalizeCode = normalizeCurrencyCode;

function providerLabel(provider: AccountingConnection['provider']): string {
  return provider === 'xero' ? 'Xero' : 'QuickBooks';
}

/**
 * Hard-blocks an invoice push whose stamped currency is not the realm's home
 * currency, and blocks equally when the home currency was never captured.
 */
export function assertAccountingInvoicePushCurrency(
  connection: Pick<AccountingConnection, 'provider' | 'homeCurrency'>,
  invoice: Pick<AccountingPushInvoicePayload, 'currencyCode'>,
): void {
  const label = providerLabel(connection.provider);
  const home = normalizeCode(connection.homeCurrency);
  if (!home) {
    throw new AccountingCurrencyContractError(
      `${label} home currency is unavailable, so this invoice cannot be pushed safely. Reconnect ${label} to capture it, then retry.`,
      409,
      'ACCOUNTING_HOME_CURRENCY_UNKNOWN',
    );
  }

  const invoiceCurrency = normalizeCode(invoice.currencyCode);
  if (invoiceCurrency !== home) {
    throw new AccountingCurrencyContractError(
      `Invoice currency ${invoiceCurrency ?? 'unknown'} does not match the connected ${label} home currency ${home}. Cross-currency accounting pushes are not supported.`,
      409,
      'ACCOUNTING_INVOICE_CURRENCY_MISMATCH',
    );
  }
}

export interface NormalizedAccountingPayment {
  invoiceId: string;
  remoteInvoiceId: string;
  remotePaymentId: string;
  /** Major-unit fixed-2 string, ready for invoice_payments.amount. */
  amount: string;
  currencyCode: string;
  txnDate: string;
}

/**
 * Converts one provider-reported payment into Breeze's major-unit shape.
 *
 * ORDER IS LOAD-BEARING: currency equality is asserted BEFORE any conversion, so
 * a cross-currency payment can never be silently reinterpreted at the invoice's
 * minor-unit exponent (spec §12 non-goal: a payment always matches its invoice's
 * currency).
 */
export function normalizeAccountingPayment(
  payment: ChangeSet['payments'][number],
  invoice: Pick<AccountingPushInvoicePayload, 'invoiceId' | 'currencyCode'>,
): NormalizedAccountingPayment {
  const paymentCurrency = normalizeCode(payment.currency);
  const invoiceCurrency = normalizeCode(invoice.currencyCode);

  if (!paymentCurrency || !invoiceCurrency || paymentCurrency !== invoiceCurrency) {
    throw new AccountingCurrencyContractError(
      `Payment currency ${paymentCurrency ?? 'unknown'} does not match invoice currency ${invoiceCurrency ?? 'unknown'}. Cross-currency payments are not supported.`,
      409,
      'ACCOUNTING_PAYMENT_CURRENCY_MISMATCH',
    );
  }

  // Strictly POSITIVE. Zero is not a payment, and a negative amount is a refund
  // or credit memo — spec §12 puts credit memos out of scope, and applying one
  // here would INCREASE the invoice balance through the payment path. Provider
  // refund/credit events are unsupported until a dedicated flow exists.
  if (!Number.isSafeInteger(payment.amountMinor) || payment.amountMinor <= 0) {
    throw new AccountingCurrencyContractError(
      `Payment ${payment.remotePaymentId} reported a minor-unit amount that is not a positive safe integer; refunds and credit memos are not supported and a non-integer value would be a guess.`,
      502,
      'ACCOUNTING_PAYMENT_MINOR_UNITS_INVALID',
    );
  }

  return {
    invoiceId: invoice.invoiceId,
    remoteInvoiceId: payment.remoteInvoiceId,
    remotePaymentId: payment.remotePaymentId,
    amount: fromMinorUnits(payment.amountMinor, paymentCurrency),
    currencyCode: paymentCurrency,
    txnDate: payment.txnDate,
  };
}

/*
 * DEFERRED ENFORCEMENT + INTEGRATION CONTRACT (multi-currency §11, wave 8 → Phase C/D).
 *
 * STATUS: items 1-4 below are all DELIVERED (1-3 Phase C, 4 Phase D). This
 * comment stays as the contract for future changes to any of them.
 *
 *  1. DELIVERED. ONE GUARDED COORDINATOR —
 *     `pushInvoiceToAccounting`/`voidInvoiceInAccounting` in
 *     `accountingInvoicePush.ts` — loads the connection and the typed
 *     payload, calls assertAccountingInvoicePushCurrency FIRST, and only then
 *     reaches the provider transport. `provider.pushInvoice` / `voidInvoice`
 *     stay transport-only and are never called from anywhere else.
 *  2. DELIVERED. A STATIC CALL-SITE GATE —
 *     `accountingInvoicePushCallSites.test.ts`, using the AST technique in
 *     `stripeCheckoutCallSites.test.ts`: parses apps/api/src + ee, finds every
 *     call expression whose callee ends in `.pushInvoice` or `.voidInvoice` on
 *     an AccountingProvider, and fails unless the enclosing module is the
 *     coordinator itself. That is what makes the guard unbypassable rather
 *     than merely available.
 *  3. DELIVERED, UPDATED BY #4498. `apps/api/src/__tests__/integration/accountingInvoicePushCurrency.integration.test.ts` —
 *     seeds a USD QBO connection + an EUR invoice, calls the real coordinator,
 *     asserts `currency_mismatch` (ACCOUNTING_INVOICE_CURRENCY_MISMATCH) and
 *     that NO QBO request was made (a `fetch` spy). Through #4498, no
 *     sync/mapping state was persisted either (no `accounting_entity_mappings`
 *     row for the invoice at all) — a tech had no signal that an auto-push
 *     had failed short of retrying it manually. As of #4498, `currency_mismatch`
 *     specifically now persists an ERROR-ONLY mapping row (`sync_status:'error'`,
 *     no `remoteEntityId`, both currencies named in `lastError`) so the
 *     invoice detail card's existing `syncStatus:'error'`-is-pushable branch
 *     surfaces it with no new UI plumbing — see `persistInvoiceCurrencyMismatchErrorInOwnContext`
 *     in `accountingInvoicePush.ts`. `home_currency_unknown` is UNCHANGED and
 *     still persists nothing (a rarer connection-setup problem, out of #4498's
 *     scope); the suite also proves a null-home-currency case asserting
 *     `home_currency_unknown` (ACCOUNTING_HOME_CURRENCY_UNKNOWN) the same
 *     way, and a same-currency happy-path case (provider transport mocked at
 *     the `fetch` boundary) proving the mapping row lands `synced` and a
 *     second push against the same invoice UPDATEs the existing mapping row
 *     rather than inserting a second one, against the real
 *     `accounting_entity_mappings_breeze_uniq` unique index.
 *     assertAccountingInvoicePushCurrency runs immediately after the typed
 *     connection + invoice payload are loaded and BEFORE any network call.
 *  4. DELIVERED. `accountingPaymentPull.ts`'s `applyAccountingPayment`, proved by
 *     `apps/api/src/__tests__/integration/accountingPaymentPull.integration.test.ts`.
 *     One transaction, in this order:
 *       a. an UNLOCKED discovery read of the invoice mapping — resolves WHICH
 *          invoice to lock; not authoritative;
 *       b. `SELECT ... FROM invoices ... FOR UPDATE` on that invoice;
 *       c. the PAYMENT mapping re-read UNDER the invoice lock — this is the
 *          authoritative at-most-once claim, not step (a);
 *       d. `normalizeAccountingPayment` against the LOCKED invoice's stamped
 *          currency (equality asserted before any minor-unit conversion);
 *       e/f. the `invoice_payments` insert and `recomputeInvoiceStatus`, which
 *          re-reads the payment sum in the same transaction and therefore under
 *          the same lock.
 *
 *     ONE DELIBERATE REFINEMENT beyond what this comment originally specified:
 *     the at-most-once claim is keyed on `accounting_entity_mappings.remote_entity_id`
 *     set to the COMPOSITE `'<PaymentId>/<remoteInvoiceId>'`
 *     (`paymentMappingRemoteId`), never on the bare `remotePaymentId`. One QBO
 *     `Payment` legitimately settles several Breeze invoices (a split payment
 *     carries one `Line` per invoice), so a bare payment id would let only the
 *     first split line claim the mapping and the rest would collide against
 *     `accounting_entity_mappings_remote_uniq`. Qualifying the id by the invoice
 *     makes each (payment, invoice) pair its own claim; `reverseAccountingPayment`
 *     recovers the whole set of an invoice's payment lines with a
 *     `<PaymentId>/%` prefix match.
 */
