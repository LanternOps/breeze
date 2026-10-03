import type { PaymentMethod } from '@breeze/shared';
import type { AccountingConnection, AccountingEnvironment } from './accountingConnectionService';

export const ACCOUNTING_PROVIDER_IDS = ['quickbooks', 'xero'] as const;
export type AccountingProviderId = typeof ACCOUNTING_PROVIDER_IDS[number];

/**
 * What a provider implementation can do today (spec "Provider capabilities").
 * Enforced at EVERY layer — routes (409 capability_unavailable), producers
 * (no enqueue), workers (log + complete) and the UI (hidden). This is what lets
 * each Xero wave ship alone: a W02-connected row defaults to push_mode='auto' /
 * pull_payments=true / push_payments=true, and without these gates the generic
 * workers would call provider methods that do not exist yet.
 */
export type AccountingCapability =
  | 'connect' | 'mapping' | 'customerImport' | 'invoicePush' | 'paymentPull' | 'paymentPush';
export type AccountingCapabilities = Readonly<Record<AccountingCapability, boolean>>;

export interface ConnectionTokens {
  realmId: string;
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresAt: Date;
  refreshTokenExpiresAt: Date;
}

/** One tenant (organisation) an OAuth grant can reach (Xero W02). */
export interface ProviderTenant {
  tenantId: string;
  /** The provider's id for this user's link to the tenant (Xero: the connection id). */
  connectionRef: string;
  name: string;
  /** Provider tenant type (Xero: 'ORGANISATION', 'PRACTICEMANAGER', …). */
  tenantType: string;
  /** The auth event that FIRST linked this tenant (Xero connection.authEventId). */
  authEventId: string | null;
}

/**
 * Providers whose OAuth grant can reach several tenants and whose callback
 * carries no realm id (Xero W02). Absent = the callback's realmId IS the
 * tenant (QuickBooks).
 */
export interface ProviderTenantSelection {
  /** The provider tenant type that is connectable (Xero: 'ORGANISATION'). */
  readonly connectableTenantType: string;
  authEventIdOf(accessToken: string): string | null;
  listGrantTenants(accessToken: string, authEventId: string): Promise<ProviderTenant[]>;
  /** Reconnect lookup ONLY (plan refinement item 2) — never a fallback for a missing claim. */
  listAllTenants(accessToken: string): Promise<ProviderTenant[]>;
  removeTenantConnection(accessToken: string, connectionRef: string): Promise<void>;
}

/** One selectable option for a connection default-ref picker (income account, tax rate, bank account). */
export interface ProviderSettingsOption {
  ref: string;
  label: string;
  detail: string | null;
}

/** Pickers and organisation badge for a connection's settings step (Xero W02). */
export interface ProviderSettingsOptions {
  organisation: { name: string | null; isDemoCompany: boolean | null };
  incomeAccounts: ProviderSettingsOption[];
  taxRates: ProviderSettingsOption[];
  bankAccounts: ProviderSettingsOption[];
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
  /** Opaque provider revision (QBO: SyncToken). Persisted as `remote_sync_token`. */
  remoteVersion?: string;
  /** QBO CurrencyRef.value, surfaced from listing/create responses (multi-currency §11). */
  currencyCode?: string;
  /** True when the provider knows this contact only as a supplier (Xero: IsSupplier && !IsCustomer). Never set by QuickBooks. */
  supplierOnly?: boolean;
}

export interface RemoteItem extends RemoteEntity {
  sku?: string;
  description?: string;
  type?: 'Service' | 'NonInventory' | 'Inventory' | 'Category' | string;
  unitPrice?: number;
  active?: boolean;
  /** Opaque provider revision (QBO: SyncToken). Persisted as `remote_sync_token`. */
  remoteVersion?: string;
}

export interface RemoteIncomeAccount extends RemoteEntity {
  accountType: string;
  accountSubType?: string;
}

export interface RemoteRef {
  /** Customer addresses returned by upsertCustomer; absent for other entities. */
  billAddr?: RemoteAddress;
  shipAddr?: RemoteAddress;
  id: string;
  /**
   * Opaque provider revision of the remote record (QBO: SyncToken). The core
   * never interprets it; it is persisted as `remote_sync_token` and handed back
   * on the next update/delete.
   */
  remoteVersion?: string;
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
 * What a void tells Breeze. A void BUMPS the Invoice's revision, so the stored
 * remote version (QBO: SyncToken) is stale the moment it returns — persisting the new one is what
 * stops the next write starting with a guaranteed 5010. `null` when the
 * provider's response carried no token; the caller then keeps what it had.
 *
 * (The "a void carries a payload too" note that used to sit above this block
 * documents `AccountingVoidInvoicePayload`, not this type; it has moved there.)
 */
export interface InvoiceVoidResult {
  remoteVersion: string | null;
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
  /** Breeze `invoice_payments.id` — the QBO `requestid` AND the payment marker. */
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
  /** Payment reference (QBO: `PaymentRefNum`) — cheque number, Stripe `pi_…`.
   *  Already truncated to the provider's `limits.paymentRefMax` by the
   *  coordinator. NEVER an ownership key. */
  reference: string | null;
  /** `Breeze payment <uuid>` (accountingPaymentMarker.ts). The adoption marker;
   *  the provider places it via `paymentMarker.embed` (QBO: `PrivateNote`).
   *  Deliberately NOT generation-tagged — the pull adopts on this exact string. */
  marker: string;
  /** `accounting_entity_mappings.push_generation`: how many times this mapping
   *  has been re-owned for a fresh create. 0 for a first push. The provider
   *  folds it into the idempotency `requestid` so a re-push after a hand
   *  deletion in QuickBooks is not answered from the 24h replay cache. */
  pushGeneration: number;
}

export interface AccountingFeeEntryHooks {
  /** Persist the send timestamp after acquiring a provider slot, immediately before HTTP. */
  beforeCreate?: () => Promise<void>;
}

export interface AccountingFeeEntryPayload {
  operationId:string; remoteCustomerId:string; amount:string; currencyCode:string; txnDate:string;
  direction:'receipt'|'refund'; incomeRef:string; bankAccountRef:string|null; exemptTaxCodeRef:string|null;
  firstSubmittedAt:string;
}

export interface AccountingDeletePaymentPayload {
  remotePaymentId: string;
  /** The remote version Breeze last saw. Null forces the provider to read a fresh one. */
  remoteVersion: string | null;
}

/** `already_absent` = the provider reports the payment does not exist
 *  (QuickBooks: fault 610 / "Object Not Found"). That is SUCCESS for a
 *  delete: the desired end state is already true. The provider returns it —
 *  it never throws a `not_found` error for this. */
export type PaymentDeleteResult = 'deleted' | 'already_absent';

/** Breeze's `payment_method` enum — what a provider maps its own rail names onto. */
export type AccountingPaymentMethod = PaymentMethod;

/**
 * A provider's published request throttles. Declared per provider so the core
 * limiter never hard-codes one vendor's numbers.
 */
export interface RateLimitSpec {
  perConnection: { limit: number; windowSeconds: number };
  maxConcurrentPerConnection: number | null;
  appWide: { limit: number; windowSeconds: number } | null;
  dailyPerConnection: { limit: () => number } | null;
}

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
  /** Opaque payment revision at read time (QBO: SyncToken) — the applier's
   *  "the provider edited it" signal. */
  remotePaymentVersion: string | null;
  /** The provider's payment-method name (QBO: PaymentMethodRef.name), for
   *  display and logging; null when the realm did not expand the ref. */
  paymentMethodName: string | null;
  /** Breeze's rail for this payment, mapped by the provider (QBO:
   *  `mapQboPaymentMethod`). Unknown names are `other`, never inferred. */
  method: AccountingPaymentMethod;
  /** PaymentRefNum (cheque number etc.); null when absent. */
  paymentRefNum: string | null;
  /**
   * The Breeze `invoice_payments.id` this remote payment claims to be,
   * recovered by the provider's `paymentMarker.extract` from wherever its
   * `embed` placed the marker (QuickBooks: `PrivateNote`, parsed by
   * `parseBreezePaymentMarker` — null unless the WHOLE note matches). Set on a
   * payment Breeze itself created; the pull uses it to ADOPT a create whose
   * response was lost (spec decision 3).
   */
  breezePaymentId: string | null;
}

export interface ChangeSet {
  /** The provider's change cursor (changes since `sinceCursor`). Becomes the connection's next cdc_cursor. */
  cursor: Date;
  payments: ChangeSetPaymentLine[];
  /**
   * QBO Payment ids the realm reports as `status: "Deleted"` — a REAL deletion
   * and nothing else. A voided or unapplied Payment still EXISTS in QuickBooks
   * and belongs in `unappliedPayments`; classifying it here made the pull clear
   * a Breeze-origin row's remote id, after which the invoice fan-out re-owned
   * the mapping and pushed a SECOND QuickBooks Payment for money that moved
   * once (final-review finding C1).
   */
  deletedPayments: string[];
  /**
   * QBO Payment ids that are ALIVE but currently settle no invoice: a Payment
   * QuickBooks voided (`TotalAmt` 0) or whose Invoice-linked lines were all
   * removed (unapplied, left as customer credit).
   *
   * Delivered as a live payment with an EMPTY line set, so the applier routes it
   * through `reverseStaleAllocations` with an empty keep-set. That reverses a
   * QuickBooks-origin mirror row exactly as a deletion did (the money is no
   * longer applied to the invoice), while a Breeze-origin row KEEPS its remote
   * id and SyncToken — a later Breeze void still has to delete that Payment, and
   * it cannot without them.
   */
  unappliedPayments: string[];
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

/**
 * One accounting system (QuickBooks, Xero). The core coordinators are
 * provider-neutral; every provider MUST honour these obligations, because the
 * core cannot detect a violation — it just misbehaves:
 *
 * 1. ERRORS. Every public async method throws ONLY `AccountingProviderError`
 *    (accountingProviderError.ts), translated at the provider's own boundary.
 *    The core branches on `kind` alone and treats any other thrown value as
 *    `transient` — so an untranslated `invalid_grant` would retry forever and
 *    never mark the connection `reauth`.
 * 2. ABSORBED CONDITIONS. Some outcomes are the provider's to handle, never
 *    to throw:
 *    - `deletePayment`: the remote payment not existing is SUCCESS — return
 *      `'already_absent'`, never a `not_found` error.
 *    - every write (`upsertCustomer`, `upsertItem`, `pushInvoice`,
 *      `voidInvoice`, `deletePayment`): a stale remote version is handled
 *      internally by re-reading the live version and retrying (QuickBooks:
 *      once; a second stale fault may escape as `stale_version`).
 *    - `pushInvoice`: a duplicate document number is handled internally
 *      (QuickBooks retries once without DocNumber).
 *    - `paymentPushPreflight` must be pure and synchronous (no network, no DB):
 *      it runs inside the payment coordinator's Phase 1 transaction, before
 *      any token refresh.
 * 3. `paymentMarker`: `extract(embed(ref, marker))` must recover the marker's
 *    Breeze payment id for ANY `ref` (including null and a max-length one),
 *    and the provider must set `ChangeSetPaymentLine.breezePaymentId` from
 *    that same `extract` on every pulled payment — it is how a create whose
 *    response was lost gets adopted instead of duplicated.
 * 4. `limits.paymentRefMax` caps the RAW reference the coordinator passes in
 *    (`AccountingPaymentPayload.reference`), before `embed` runs.
 * 5. `connectEnvironment()` is only valid once `configError()` returns null.
 */
/**
 * A provider's local refusal to push an invoice, decided without any I/O
 * (Xero W04). `settings` → the connection lacks a setting this provider needs
 * (coordinator code `push_settings_incomplete`); `totals` → Breeze's own
 * figures cannot be expressed to this provider (`invoice_totals_mismatch`).
 * `message` is operator-facing and persisted as the mapping's last_error.
 */
export interface AccountingInvoicePreflightRefusal {
  reason: 'settings' | 'totals';
  message: string;
}

export interface AccountingProvider {
  readonly provider: AccountingProviderId;
  /** Brand name used in operator-visible text ("QuickBooks", "Xero"). Never translated. */
  readonly displayName: string;
  readonly capabilities: AccountingCapabilities;
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
  /** One remote customer by id, or null when it does not exist. Lets a link confirm read one record instead of the whole list. */
  getRemoteCustomer?(conn: AccountingConnection, id: string): Promise<RemoteCustomer | null>;
  getRemoteItem?(conn: AccountingConnection, id: string): Promise<RemoteItem | null>;
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
  ): Promise<InvoiceVoidResult>;
  /**
   * OPTIONAL, synchronous, no I/O (Xero W04). Called by the invoice coordinator
   * in Phase 1 — after the currency and totals guards, before any dependency
   * sync, token refresh or provider call — with the exact line payloads it will
   * push. Null means "no objection". QuickBooks declares none.
   */
  invoicePushPreflight?(
    conn: AccountingConnection,
    invoice: Pick<AccountingInvoicePayload, 'currencyCode' | 'taxTotal' | 'lines'>,
  ): AccountingInvoicePreflightRefusal | null;
  /**
   * OPTIONAL (Xero W04, refinement 22). The remote invoice a push of this Breeze
   * invoice created, found by the provider's adoption key, or null. Lets a void
   * reach a create whose response was lost. A provider without an adoption key
   * for invoices (QuickBooks) declares none.
   */
  findRemoteInvoice?(conn: AccountingConnection, invoiceId: string): Promise<{ id: string; remoteVersion?: string } | null>;
  /** Post or adopt a separate cash entry for an already collected or refunded processing fee. */
  postFeeEntry(conn: AccountingConnection, entry: AccountingFeeEntryPayload, hooks?: AccountingFeeEntryHooks): Promise<RemoteRef>;
  /**
   * CREATE ONLY — there is deliberately no `updatePayment`. Rewriting a
   * QuickBooks Payment's amount would rewrite receipt history, and Intuit models
   * a refund as a separate transaction; a Breeze partial refund is therefore
   * recorded as a divergence rather than pushed (spec decision 9).
   */
  createPayment(conn: AccountingConnection, payment: AccountingPaymentPayload): Promise<RemoteRef>;
  /** Synchronous settings check before any token refresh or network call (Xero W05). A message = park the payment. Absent = none (QuickBooks). */
  paymentPushPreflight?(conn: AccountingConnection): string | null;
  deletePayment(conn: AccountingConnection, payment: AccountingDeletePaymentPayload): Promise<PaymentDeleteResult>;
  reconcileChanges(conn: AccountingConnection, sinceCursor: Date | null): Promise<ChangeSet>;
  verifyWebhook(signatureHeader: string, rawBody: string, verifierToken: string): boolean;
  /** Provider-published limits: the payment-reference length cap and the request throttles. */
  readonly limits: { readonly paymentRefMax: number; readonly rate: RateLimitSpec };
  /**
   * Where the Breeze adoption marker lives on a remote payment. `embed` builds
   * the text the provider stores; `extract` recovers the Breeze payment id from
   * that text (null unless it is a Breeze marker).
   */
  readonly paymentMarker: {
    embed(reference: string | null, marker: string): string;
    extract(text: string | null | undefined): string | null;
  };
  /** The environment a fresh connection records (QBO: QBO_ENVIRONMENT; Xero: 'production'). */
  connectEnvironment(): AccountingEnvironment;
  /** Null when the instance is configured for this provider; otherwise an operator-facing reason. */
  configError(): string | null;
  /**
   * Providers whose OAuth grant can reach several tenants and whose callback
   * carries no realm id (Xero W02). Absent = the callback's realmId IS the tenant (QuickBooks).
   */
  readonly tenantSelection?: ProviderTenantSelection;
  /** Pickers for the connection's default refs (Xero W02). Absent = the provider has its own settings UI. */
  listSettingsOptions?(conn: AccountingConnection): Promise<ProviderSettingsOptions>;
  /**
   * Best-effort provider-side removal of Breeze's link before the row is deleted
   * (Xero: DELETE /connections/{provider_connection_ref}). NEVER token
   * revocation — that removes every link the authorising user has to the app,
   * which can include another Breeze partner's connection (spec quorum finding 3).
   * The caller must pass a connection whose access token was obtained via
   * `getValidAccessToken` — a stale token 401s at the provider and is
   * indistinguishable from a transient failure.
   */
  releaseConnection?(conn: AccountingConnection): Promise<void>;
}

/**
 * The exact `accounting_entity_mappings.last_error` sentinels
 * `markInvoiceDeletedRemotely` (accountingPaymentPull.ts) writes when the
 * reconcile worker sees the provider deleted/voided an invoice Breeze pushed
 * (Phase D decision 2: never auto-resurrected). Written UNPREFIXED so they can
 * never collide with the `PAYMENT_PULL_ERROR_PREFIX` bucket.
 *
 * The persisted text is provider-labelled and keyed by provider ID, never by
 * the free-form display name: `Deleted in QuickBooks` stays byte-identical to
 * what production rows already hold, and Xero's is `Deleted in Xero`. The
 * `satisfies Record<AccountingProviderId, string>` makes adding a provider id
 * without a marker a compile error, so the writer (`invoiceRemoteDeletedMarker`)
 * and the readers (`INVOICE_REMOTE_DELETED_MARKERS`) cannot drift apart — a
 * marker a reader did not recognise would let the push re-create an invoice
 * the provider deleted (a duplicate invoice).
 *
 * `accounting_entity_mappings` has no machine-code column, so every reader
 * compares against the full set derived from this map — via
 * `isInvoiceRemoteDeletedMarker` in code and `notInArray(...)` in SQL — never
 * against a single provider's string.
 *
 * Kept here — a leaf module — rather than in accountingPaymentPull.ts (which
 * imports invoiceService, which needs this too) or invoiceService.ts (imported
 * by accountingPaymentPull.ts), either of which would create a cycle.
 */
export const INVOICE_REMOTE_DELETED_MARKER_BY_PROVIDER = {
  quickbooks: 'Deleted in QuickBooks',
  xero: 'Deleted in Xero',
} as const satisfies Record<AccountingProviderId, string>;

/** Every provider's remote-deleted sentinel — the set every reader matches against. */
export const INVOICE_REMOTE_DELETED_MARKERS: readonly string[] = Object.values(INVOICE_REMOTE_DELETED_MARKER_BY_PROVIDER);

/** The remote-deleted sentinel a provider's reconcile writes. */
export function invoiceRemoteDeletedMarker(provider: AccountingProviderId): string {
  return INVOICE_REMOTE_DELETED_MARKER_BY_PROVIDER[provider];
}

/** True when `lastError` is exactly one of the remote-deleted sentinels. */
export function isInvoiceRemoteDeletedMarker(lastError: string | null | undefined): boolean {
  return typeof lastError === 'string' && INVOICE_REMOTE_DELETED_MARKERS.includes(lastError);
}

/** @deprecated pre-W01 name for the QuickBooks marker; kept for existing test imports. */
export const INVOICE_REMOTE_DELETED_ERROR = 'Deleted in QuickBooks';

export interface AccountingFeeJournalEntry {
  connectionId:string; realmFingerprint:string; payload:AccountingFeeEntryPayload;
  state:'pending'|'posted'|'needs_mapping'|'abandoned'; leaseToken:string|null; leaseUntil:string|null; remoteId:string|null; error:string|null;
}
