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
 * WHAT THIS MODULE IS TODAY: a guard PRIMITIVE with a unit contract. It is
 * called by nothing, because nothing can push: QuickbooksProvider.pushInvoice /
 * voidInvoice are `NotImplemented: Phase C`, reconcileChanges is
 * `NotImplemented: Phase D`, and the entity-mapping table that would resolve a
 * remote invoice id is not in the repo. Exporting a pure function does NOT stop
 * a future caller from reaching `provider.pushInvoice` directly — this comment
 * is advisory, so Phase C must convert it into a mechanical gate:
 *
 *  1. ONE GUARDED COORDINATOR. Phase C exposes exactly one sanctioned entry —
 *     `pushInvoiceToAccounting(...)` — which loads the connection and the typed
 *     payload, calls assertAccountingInvoicePushCurrency FIRST, and only then
 *     reaches the provider transport. `provider.pushInvoice` / `voidInvoice`
 *     stay transport-only and are never called from anywhere else.
 *  2. A STATIC CALL-SITE GATE, using the AST technique in
 *     apps/api/src/services/stripeCheckoutCallSites.test.ts: parse apps/api/src
 *     + ee, find every call expression whose callee ends in `.pushInvoice` or
 *     `.voidInvoice` on an AccountingProvider, and fail unless the enclosing
 *     module is the coordinator itself. That is what makes the guard
 *     unbypassable rather than merely available.
 *  3. apps/api/src/__tests__/integration/accountingInvoicePushCurrency.integration.test.ts —
 *     seed a USD QBO connection + an EUR invoice, call the real coordinator,
 *     assert ACCOUNTING_INVOICE_CURRENCY_MISMATCH, assert NO QBO request was
 *     made and NO sync/mapping state was persisted; plus a null-home-currency
 *     case asserting ACCOUNTING_HOME_CURRENCY_UNKNOWN with reconnect guidance.
 *     assertAccountingInvoicePushCurrency must run immediately after the typed
 *     connection + invoice payload are loaded and BEFORE any network call.
 *  4. A Phase-D payment applier that follows the ESTABLISHED INVOICE-FIRST LOCK
 *     ORDER (invoiceService.recordPayment, apps/api/src/services/invoiceService.ts:1305-1314:
 *     "ONE transaction, invoice row lock FIRST"). Concretely, in one transaction:
 *       a. SELECT the invoice row FOR UPDATE;
 *       b. re-read currency and recompute the balance from invoice_payments
 *          UNDER that lock (the header balance column is only a cache of the sum);
 *       c. resolve the remote-invoice mapping and call normalizeAccountingPayment
 *          against the LOCKED invoice's stamped currency;
 *       d. claim the unique (connection, remotePaymentId) mapping and insert the
 *          invoice_payments row and recompute the header IN THE SAME transaction,
 *          so a re-delivered remotePaymentId applies at most once.
 *     A Phase-D suite must prove the ordering (normalize after mapping
 *     resolution, before any invoice_payments write) and the at-most-once
 *     property under concurrent re-delivery.
 */
