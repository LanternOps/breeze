import type { AccountingConnection } from './accountingConnectionService';

export type AccountingProviderId = 'quickbooks' | 'xero';

export interface ConnectionTokens {
  realmId: string;
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresAt: Date;
  refreshTokenExpiresAt: Date;
}

export interface RemoteEntity {
  id: string;
  displayName: string;
  email?: string;
}

export interface RemoteAddress {
  line1?: string;
  line2?: string;
  city?: string;
  region?: string;
  postalCode?: string;
  country?: string;
}

export interface RemoteCustomer extends RemoteEntity {
  companyName?: string;
  phone?: string;
  contactName?: string;
  billAddr?: RemoteAddress;
  shipAddr?: RemoteAddress;
  active?: boolean;
  syncToken?: string;
  /** QBO CurrencyRef.value, surfaced from listing/create responses (multi-currency §11). */
  currencyCode?: string;
}

export interface RemoteItem extends RemoteEntity {
  sku?: string;
  description?: string;
  type?: 'Service' | 'NonInventory' | 'Inventory' | 'Category' | string;
  unitPrice?: number;
  active?: boolean;
  syncToken?: string;
}

export interface RemoteIncomeAccount extends RemoteEntity {
  accountType: string;
  accountSubType?: string;
}

export interface RemoteRef {
  id: string;
  syncToken?: string;
  docNumber?: string;
  /**
   * QBO CurrencyRef.value, surfaced on a CREATE response so callers get the
   * realm-assigned currency symmetrically with listRemoteCustomers/
   * mapQboCustomer (multi-currency §11). Not populated by every provider
   * method — currently only upsertCustomer's Customer create response.
   */
  currencyCode?: string;
}

/** A previously-synced remote entity, for update-vs-create decisions. */
export interface AccountingEntityMapping {
  remoteEntityId: string;
  remoteSyncToken: string | null;
}

export interface AccountingCustomerPayload {
  organizationId: string;
  displayName: string;
  companyName?: string;
  phone?: string;
  billingEmail: string | null;
  taxId: string | null;
  billAddr?: RemoteAddress;
  shipAddr?: RemoteAddress;
  /** The organization's stamped billing currency (ISO 4217, uppercase). */
  currencyCode: string;
}

export interface AccountingItemPayload {
  catalogItemId: string;
  name: string;
  sku?: string;
  description: string | null;
  /** Service for Breeze `service` items; NonInventory for hardware/software. */
  type: 'Service' | 'NonInventory';
  /** Major-unit decimal string — storage stays numeric major units (spec §12). */
  unitPrice: string;
  currencyCode: string;
  taxable: boolean;
  active: boolean;
  incomeAccountRef?: string;
}

export interface AccountingInvoiceLinePayload {
  invoiceLineId: string;
  description: string;
  /** Decimal string; never a float, so no binary rounding enters at this seam. */
  quantity: string;
  unitPrice: string;
  lineTotal: string;
  taxable: boolean;
}

export interface AccountingInvoiceLineMapping {
  invoiceLineId: string;
  remoteItemRef: RemoteRef | null;
}

export interface AccountingInvoicePayload {
  invoiceId: string;
  docNumber: string | null;
  /** ISO date (YYYY-MM-DD). */
  txnDate: string;
  dueDate: string | null;
  customerRef: RemoteRef;
  /** The invoice's STAMPED currency. Never re-derived from the org (snapshots rule). */
  currencyCode: string;
  subtotal: string;
  taxTotal: string;
  total: string;
  lines: readonly AccountingInvoiceLinePayload[];
  /**
   * Present on a re-push/retry: the previously-pushed QBO Invoice this call
   * should sparse-update instead of create (spec §"Provider upsert semantics
   * for invoices" — Breeze invoices are immutable post-issue, so an update
   * only re-sends the same content after a partial failure). Embedded here
   * rather than as a fourth `pushInvoice` argument because the provider
   * method's parameter tuple is a pinned type contract (types.test.ts).
   */
  mapping: AccountingEntityMapping | null;
}

/**
 * A void carries a payload too, so no accounting method sits outside the typed
 * currency contract (multi-currency §11). Deliberately wider arity than the
 * Phase-A sketch, which had `voidInvoice(conn, mapping)`.
 */
export interface AccountingVoidInvoicePayload {
  invoiceId: string;
  docNumber: string | null;
  /** The invoice's STAMPED currency, carried so the guard applies on the way out too. */
  currencyCode: string;
}

export interface InvoicePushResult extends RemoteRef {
  /** QBO's TxnTaxDetail.TotalTax from the response, major-unit string, null if absent. */
  remoteTaxTotal: string | null;
  /** QBO's TotalAmt from the response, major-unit string, null if absent. */
  remoteTotal: string | null;
}

/**
 * One Breeze payment, as sent to the accounting provider (Phase D2).
 *
 * Deliberately carries NO payment-method reference: mapping Breeze's
 * `payment_method` enum onto QuickBooks `PaymentMethod` entities needs a
 * per-realm PaymentMethod list Breeze does not fetch, and a wrong rail on a
 * money row is worse than no rail at all (spec "Out of scope").
 */
export interface AccountingPaymentPayload {
  /** Breeze `invoice_payments.id` — the QBO `requestid` AND the PrivateNote marker. */
  invoicePaymentId: string;
  remoteCustomerId: string;
  remoteInvoiceId: string;
  /** Major-unit decimal string, 2dp. Converted to a JSON number at the wire only. */
  amount: string;
  /** The invoice's STAMPED currency. Asserted equal to the realm home currency
   *  by the coordinator BEFORE this payload is built; never sent as a CurrencyRef. */
  currencyCode: string;
  /** ISO date (YYYY-MM-DD) from `invoice_payments.received_at`. */
  txnDate: string;
  /** `PaymentRefNum` — cheque number, Stripe `pi_…`. Already truncated to QBO's
   *  21-char cap by the coordinator. NEVER an ownership key. */
  reference: string | null;
  /** `Breeze payment <uuid>` (accountingPaymentMarker.ts). The adoption marker. */
  privateNote: string;
}

export interface AccountingDeletePaymentPayload {
  remotePaymentId: string;
  /** The SyncToken Breeze last saw. Null forces the provider to read a fresh one. */
  syncToken: string | null;
}

/** `already_absent` = QuickBooks reports the Payment does not exist. That is
 *  SUCCESS for a delete: the desired end state is already true. */
export type PaymentDeleteResult = 'deleted' | 'already_absent';

export interface RealmSettings {
  homeCurrency: string | null;
  multiCurrencyEnabled: boolean | null;
}

export interface ChangeSetPaymentLine {
  remoteInvoiceId: string;
  remotePaymentId: string;
  /**
   * Provider-reported INTEGER MINOR UNITS. Convert exactly once, and only via
   * normalizeAccountingPayment (accountingCurrency.ts) — multi-currency §11.
   */
  amountMinor: number;
  /** Provider-reported ISO 4217 code for this payment. */
  currency: string;
  /** ISO date (YYYY-MM-DD) from Payment.TxnDate. */
  txnDate: string;
  /** QBO Payment SyncToken at CDC read time — the applier's "QBO edited it" signal. */
  remotePaymentSyncToken: string | null;
  /** PaymentMethodRef.name; null when the realm did not expand the ref. */
  paymentMethodName: string | null;
  /** PaymentRefNum (cheque number etc.); null when absent. */
  paymentRefNum: string | null;
  /**
   * The Breeze `invoice_payments.id` this QuickBooks Payment claims to be,
   * parsed from `PrivateNote` by `parseBreezePaymentMarker` — null unless the
   * WHOLE note matches. Set on a Payment Breeze itself created; the pull uses
   * it to ADOPT a create whose response was lost (spec decision 3).
   */
  breezePaymentId: string | null;
}

export interface ChangeSet {
  /** The instant the CDC window ends. Becomes the connection's next cdc_cursor. */
  cursor: Date;
  payments: ChangeSetPaymentLine[];
  /** QBO Payment ids the realm reports as status:"Deleted", plus voided (TotalAmt 0) payments. */
  deletedPayments: string[];
  /** QBO Invoice ids the realm reports as status:"Deleted" or voided. */
  deletedInvoices: string[];
  /**
   * "This window could NOT be fully enumerated" — belt and braces (final-review
   * finding A). The provider re-reads a truncated CDC entity through `/query`;
   * this stays `false` when that backfill drained the entity, and flips `true`
   * when it could not (a QBO error, or the page cap). A `true` here is DIRTY for
   * the worker exactly like a failed item: the CDC cursor is held and the window
   * replays, because advancing past a truncated window loses every change QBO
   * withheld — permanently, since nothing else ever re-reads it.
   */
  overflowed: boolean;
}

export interface AccountingProvider {
  readonly provider: AccountingProviderId;
  buildAuthUrl(state: string): string;
  exchangeCode(code: string, realmId: string): Promise<ConnectionTokens>;
  refresh(refreshToken: string): Promise<ConnectionTokens>;
  /**
   * The realm/organization's settings relevant to invoice push: home currency
   * (normalized to an uppercase three-letter code, or null when the provider
   * does not report one) and whether multi-currency is enabled on the realm.
   * NOT restricted to Breeze's curated supported-currency list — it is a cache
   * of an external fact (multi-currency §11).
   */
  fetchRealmSettings(conn: AccountingConnection): Promise<RealmSettings>;
  listRemoteCustomers(conn: AccountingConnection, query?: string): Promise<RemoteCustomer[]>;
  listRemoteItems(conn: AccountingConnection, query?: string): Promise<RemoteItem[]>;
  listRemoteIncomeAccounts(conn: AccountingConnection): Promise<RemoteIncomeAccount[]>;
  upsertCustomer(
    conn: AccountingConnection,
    customer: AccountingCustomerPayload,
    mapping: AccountingEntityMapping | null,
  ): Promise<RemoteRef>;
  upsertItem(
    conn: AccountingConnection,
    item: AccountingItemPayload,
    mapping: AccountingEntityMapping | null,
  ): Promise<RemoteRef>;
  pushInvoice(
    conn: AccountingConnection,
    invoice: AccountingInvoicePayload,
    lineMappings: readonly AccountingInvoiceLineMapping[],
  ): Promise<InvoicePushResult>;
  voidInvoice(
    conn: AccountingConnection,
    invoice: AccountingVoidInvoicePayload,
    mapping: AccountingEntityMapping,
  ): Promise<void>;
  /**
   * CREATE ONLY — there is deliberately no `updatePayment`. Rewriting a
   * QuickBooks Payment's amount would rewrite receipt history, and Intuit models
   * a refund as a separate transaction; a Breeze partial refund is therefore
   * recorded as a divergence rather than pushed (spec decision 9).
   */
  createPayment(conn: AccountingConnection, payment: AccountingPaymentPayload): Promise<RemoteRef>;
  deletePayment(conn: AccountingConnection, payment: AccountingDeletePaymentPayload): Promise<PaymentDeleteResult>;
  reconcileChanges(conn: AccountingConnection, sinceCursor: Date | null): Promise<ChangeSet>;
  verifyWebhook(signatureHeader: string, rawBody: string, verifierToken: string): boolean;
}
