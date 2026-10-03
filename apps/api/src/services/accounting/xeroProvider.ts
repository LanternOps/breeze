/**
 * Xero AccountingProvider (spec Phase E). W02 ships CONNECT: OAuth, tokens,
 * tenant selection, organisation settings, pickers and targeted disconnect.
 * W03 implements contacts and items; the `mapping`/`customerImport`
 * capabilities flip in W03b. W04 ships invoice push and void (capability
 * flipped in W04b). W05 ships payments: pull (reconcileChanges) and the
 * webhook doorbell (verifyWebhook) are wired in W05a; `createPayment`,
 * `deletePayment` and `paymentPushPreflight` are wired in W05b. W05c flips
 * `paymentPull` and `paymentPush` — Xero now declares all capabilities.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { xeroDailyCallLimit, xeroOAuthConfig } from '../../config/env';
import { AccountingProviderError } from './accountingProviderError';
import {
  decodeXeroAuthEventId, deleteXeroConnection, listXeroConnections, requestXeroTokens, requireXeroBody, xeroApiGet,
  xeroArray, XERO_AUTHORIZE_URL, XERO_SCOPES, type XeroCallContext,
} from './xeroHttp';
import { postXeroFeeEntry } from './xeroFeeEntries';
import { getXeroContact, listXeroContacts, upsertXeroContact } from './xeroContacts';
import { getXeroItem, listXeroItems, upsertXeroItem } from './xeroItems';
import { findPushedXeroInvoice, pushXeroInvoice, voidXeroInvoice, xeroInvoicePreflight } from './xeroInvoices';
import {
  createXeroPayment, deleteXeroPayment, embedXeroPaymentMarker, extractXeroPaymentMarker, readXeroPaymentChanges,
  xeroPaymentPreflight, XERO_PAYMENT_REF_MAX,
} from './xeroPayments';
import type { AccountingConnection, AccountingEnvironment } from './accountingConnectionService';
import type {
  AccountingFeeEntryPayload, AccountingCustomerPayload, AccountingDeletePaymentPayload, AccountingEntityMapping, AccountingInvoiceLineMapping,
  AccountingInvoicePayload, AccountingInvoicePreflightRefusal, AccountingItemPayload, AccountingPaymentPayload, AccountingProvider,
  AccountingVoidInvoicePayload, ChangeSet, ConnectionTokens, InvoicePushResult, InvoiceVoidResult,
  PaymentDeleteResult, ProviderSettingsOption, ProviderSettingsOptions, ProviderTenantSelection, RateLimitSpec,
  RealmSettings, RemoteCustomer, RemoteIncomeAccount, RemoteItem, RemoteRef,
} from './types';

/** Xero-published limits (spec W01 "Rate limiting"): per tenant 60/min + 5 concurrent; app-wide 10k/min; tier-aware day. */
export const XERO_RATE_LIMIT: RateLimitSpec = {
  perConnection: { limit: 60, windowSeconds: 60 },
  maxConcurrentPerConnection: 5,
  appWide: { limit: 10_000, windowSeconds: 60 },
  dailyPerConnection: { limit: () => xeroDailyCallLimit() },
};

/** The callback awaits settings capture inline, so it must fail fast (same rationale as QBO_PREFERENCES_TIMEOUT_MS). */
const XERO_SETTINGS_TIMEOUT_MS = 8_000;

interface XeroOrganisation { Name?: string; BaseCurrency?: string; IsDemoCompany?: boolean }
interface XeroAccount { AccountID?: string; Code?: string; Name?: string; Type?: string; Status?: string; BankAccountNumber?: string }
interface XeroTaxRate { Name?: string; TaxType?: string; Status?: string; CanApplyToRevenue?: boolean; DisplayTaxRate?: number }

function normalizeCurrency(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const code = value.trim().toUpperCase();
  return /^[A-Z]{3}$/.test(code) ? code : null;
}

/**
 * Revenue accounts an invoice line or item can post to. Shared by the settings picker and the workbench listing.
 * Invoice lines reference an AccountCode (W04), so a revenue account without a code is not selectable.
 */
function incomeAccountOptions(accounts: XeroAccount[]): ProviderSettingsOption[] {
  return accounts
    .filter((a) => a.Status === 'ACTIVE' && (a.Type === 'REVENUE' || a.Type === 'SALES') && a.Code)
    .map((a) => ({ ref: a.Code as string, label: a.Name ? `${a.Code} · ${a.Name}` : (a.Code as string), detail: a.Type ?? null }));
}

function callContext(conn: AccountingConnection, timeoutMs?: number): XeroCallContext {
  if (!conn.realmId) {
    throw new AccountingProviderError({
      kind: 'validation', provider: 'xero', operation: 'call context', message: 'Xero connection is missing a tenant id',
    });
  }
  if (!conn.accessToken) {
    throw new AccountingProviderError({
      kind: 'validation', provider: 'xero', operation: 'call context', message: 'Xero connection is missing an access token',
    });
  }
  return { connectionId: conn.id, tenantId: conn.realmId, accessToken: conn.accessToken, rate: XERO_RATE_LIMIT, timeoutMs };
}

export class XeroProvider implements AccountingProvider {
  readonly provider = 'xero' as const;
  readonly displayName = 'Xero';
  readonly capabilities = {
    connect: true,
    // Xero W03: contacts/items mapping and contact import.
    mapping: true,
    customerImport: true,
    // Xero W04: ACCREC invoice push and void.
    invoicePush: true,
    // Xero W05c: payment pull (reconcileChanges) and push (createPayment/deletePayment).
    paymentPull: true,
    paymentPush: true,
  } as const;
  // Refinement 14: the raw human reference the core may pass; the marker goes first.
  readonly limits = { paymentRefMax: XERO_PAYMENT_REF_MAX, rate: XERO_RATE_LIMIT };
  readonly paymentMarker = { embed: embedXeroPaymentMarker, extract: extractXeroPaymentMarker };

  readonly tenantSelection: ProviderTenantSelection = {
    connectableTenantType: 'ORGANISATION',
    authEventIdOf: (accessToken) => decodeXeroAuthEventId(accessToken),
    listGrantTenants: (accessToken, authEventId) => listXeroConnections(accessToken, { authEventId }),
    listAllTenants: (accessToken) => listXeroConnections(accessToken, { all: true }),
    removeTenantConnection: (accessToken, connectionRef) => deleteXeroConnection(accessToken, connectionRef),
  };

  connectEnvironment(): AccountingEnvironment {
    return 'production'; // Xero has no sandbox; testing uses the Demo Company.
  }

  configError(): string | null {
    const { clientId, clientSecret, redirectUri } = xeroOAuthConfig();
    return clientId && clientSecret && redirectUri ? null : 'Xero OAuth is not configured on this instance';
  }

  buildAuthUrl(state: string): string {
    const { clientId, redirectUri } = xeroOAuthConfig();
    const url = new URL(XERO_AUTHORIZE_URL);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', clientId);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('scope', XERO_SCOPES.join(' '));
    url.searchParams.set('state', state);
    return url.toString();
  }

  async exchangeCode(code: string, _realmId: string): Promise<ConnectionTokens> {
    return requestXeroTokens({ grantType: 'authorization_code', code });
  }

  async refresh(refreshToken: string): Promise<ConnectionTokens> {
    return requestXeroTokens({ grantType: 'refresh_token', refreshToken });
  }

  // Assumes conn.accessToken is valid (getValidAccessToken first); issues no DB queries.
  async fetchRealmSettings(conn: AccountingConnection): Promise<RealmSettings> {
    const ctx = callContext(conn, XERO_SETTINGS_TIMEOUT_MS);
    const org = requireXeroBody(await xeroApiGet<{ Organisations?: XeroOrganisation[] } | null>(ctx, 'Organisation', 'Xero organisation read'), 'Xero organisation read');
    const currencies = requireXeroBody(await xeroApiGet<{ Currencies?: Array<{ Code?: string }> } | null>(ctx, 'Currencies', 'Xero currency list'), 'Xero currency list');
    const organisations = xeroArray<XeroOrganisation>(org.Organisations);
    const currencyList = xeroArray<{ Code?: string }>(currencies.Currencies);
    return {
      homeCurrency: normalizeCurrency(organisations[0]?.BaseCurrency),
      multiCurrencyEnabled: Array.isArray(currencies.Currencies) ? currencyList.length > 1 : null,
    };
  }

  async listSettingsOptions(conn: AccountingConnection): Promise<ProviderSettingsOptions> {
    const ctx = callContext(conn);
    const org = requireXeroBody(await xeroApiGet<{ Organisations?: XeroOrganisation[] } | null>(ctx, 'Organisation', 'Xero organisation read'), 'Xero organisation read');
    const accountsBody = requireXeroBody(await xeroApiGet<{ Accounts?: XeroAccount[] } | null>(ctx, 'Accounts', 'Xero account list'), 'Xero account list');
    const taxRatesBody = requireXeroBody(await xeroApiGet<{ TaxRates?: XeroTaxRate[] } | null>(ctx, 'TaxRates', 'Xero tax rate list'), 'Xero tax rate list');
    const accounts = xeroArray<XeroAccount>(accountsBody.Accounts);
    const taxRates = xeroArray<XeroTaxRate>(taxRatesBody.TaxRates);
    const active = accounts.filter((a) => a.Status === 'ACTIVE');
    const organisation = xeroArray<XeroOrganisation>(org.Organisations)[0];
    return {
      organisation: {
        name: organisation?.Name ?? null,
        isDemoCompany: typeof organisation?.IsDemoCompany === 'boolean' ? organisation.IsDemoCompany : null,
      },
      incomeAccounts: incomeAccountOptions(accounts),
      // Bank accounts may have no Code; payments accept Account.AccountID (W05).
      bankAccounts: active
        .filter((a) => a.Type === 'BANK' && a.AccountID)
        .map((a): ProviderSettingsOption => ({ ref: a.AccountID as string, label: a.Name ?? (a.AccountID as string), detail: a.BankAccountNumber ?? null })),
      taxRates: taxRates
        .filter((r) => r.Status === 'ACTIVE' && r.CanApplyToRevenue === true && r.TaxType)
        .map((r): ProviderSettingsOption => ({
          ref: r.TaxType as string,
          label: r.Name ?? (r.TaxType as string),
          detail: typeof r.DisplayTaxRate === 'number' ? `${r.DisplayTaxRate}%` : null,
        })),
    };
  }

  async releaseConnection(conn: AccountingConnection): Promise<void> {
    if (!conn.providerConnectionRef || !conn.accessToken) return;
    await deleteXeroConnection(conn.accessToken, conn.providerConnectionRef);
  }

  // --- contacts (Xero W03) ---
  async listRemoteCustomers(conn: AccountingConnection, query?: string): Promise<RemoteCustomer[]> {
    return listXeroContacts(callContext(conn), query);
  }

  async getRemoteCustomer(conn: AccountingConnection, id: string): Promise<RemoteCustomer | null> {
    return getXeroContact(callContext(conn), id);
  }

  async upsertCustomer(
    conn: AccountingConnection,
    customer: AccountingCustomerPayload,
    mapping: AccountingEntityMapping | null,
  ): Promise<RemoteRef> {
    return upsertXeroContact(callContext(conn), customer, mapping);
  }

  // --- items and income accounts (Xero W03) ---
  async listRemoteItems(conn: AccountingConnection, query?: string): Promise<RemoteItem[]> {
    return listXeroItems(callContext(conn), query);
  }

  async getRemoteItem(conn: AccountingConnection, id: string): Promise<RemoteItem | null> {
    return getXeroItem(callContext(conn), id);
  }

  async listRemoteIncomeAccounts(conn: AccountingConnection): Promise<RemoteIncomeAccount[]> {
    const operation = 'Xero account list';
    const body = requireXeroBody(await xeroApiGet<{ Accounts?: XeroAccount[] } | null>(callContext(conn), 'Accounts', operation), operation);
    return incomeAccountOptions(xeroArray<XeroAccount>(body.Accounts))
      .map((o) => ({ id: o.ref, displayName: o.label, accountType: o.detail ?? 'REVENUE' }));
  }

  async upsertItem(
    conn: AccountingConnection,
    item: AccountingItemPayload,
    mapping: AccountingEntityMapping | null,
  ): Promise<RemoteRef> {
    return upsertXeroItem(callContext(conn), item, mapping, {
      taxCodeRef: conn.defaultTaxCodeRef,
      exemptTaxCodeRef: conn.defaultExemptTaxCodeRef,
    });
  }

  // --- invoices (Xero W04; invoicePush capability flipped in W04b) ---
  invoicePushPreflight(
    conn: AccountingConnection,
    invoice: Pick<AccountingInvoicePayload, 'currencyCode' | 'taxTotal' | 'lines'>,
  ): AccountingInvoicePreflightRefusal | null {
    return xeroInvoicePreflight(conn, invoice);
  }

  async pushInvoice(
    conn: AccountingConnection,
    invoice: AccountingInvoicePayload,
    lineMappings: readonly AccountingInvoiceLineMapping[],
  ): Promise<InvoicePushResult> {
    return pushXeroInvoice(callContext(conn), conn, invoice, lineMappings);
  }

  async voidInvoice(
    conn: AccountingConnection,
    _invoice: AccountingVoidInvoicePayload,
    mapping: AccountingEntityMapping,
  ): Promise<InvoiceVoidResult> {
    return voidXeroInvoice(callContext(conn), mapping.remoteEntityId);
  }

  /** Refinement 22: lets a Breeze void reach a create whose response was lost. */
  async findRemoteInvoice(conn: AccountingConnection, invoiceId: string): Promise<{ id: string; remoteVersion?: string } | null> {
    return findPushedXeroInvoice(callContext(conn), invoiceId);
  }

  // Assumes conn.accessToken is valid (the reconcile worker resolves it first); issues no DB queries.
  async reconcileChanges(conn: AccountingConnection, since: Date | null): Promise<ChangeSet> {
    return readXeroPaymentChanges(callContext(conn), conn, since);
  }

  /**
   * `x-xero-signature` = base64(HMAC-SHA256(raw body, XERO_WEBHOOK_KEY))
   * (Webhooks guide). Constant-time on equal-length buffers; a length mismatch
   * is false without comparing. Never throws.
   */
  verifyWebhook(signatureHeader: string, rawBody: string, signingKey: string): boolean {
    if (!signatureHeader || !signingKey) return false;
    const expected = createHmac('sha256', signingKey).update(rawBody, 'utf8').digest('base64');
    const left = Buffer.from(signatureHeader.trim(), 'utf8');
    const right = Buffer.from(expected, 'utf8');
    return left.length === right.length && timingSafeEqual(left, right);
  }

  // --- payment push (Xero W05b; capability gate: see the file header) ---
  /** Refinement 17: a missing bank account parks the payment before any token refresh or call. */
  paymentPushPreflight(conn: AccountingConnection): string | null {
    return xeroPaymentPreflight(conn);
  }

  // Assumes conn.accessToken is valid (the coordinator resolves it first); issues no DB queries.
  async createPayment(conn: AccountingConnection, payment: AccountingPaymentPayload): Promise<RemoteRef> {
    return createXeroPayment(callContext(conn), conn, payment, this.paymentMarker.embed(payment.reference, payment.marker));
  }

  async postFeeEntry(conn:AccountingConnection,entry:AccountingFeeEntryPayload,hooks:import('./types').AccountingFeeEntryHooks={}):Promise<RemoteRef>{
    return postXeroFeeEntry(callContext(conn),entry,hooks);
  }

  async deletePayment(conn: AccountingConnection, payment: AccountingDeletePaymentPayload): Promise<PaymentDeleteResult> {
    // Xero has no optimistic concurrency: the stored version is not needed (refinement 18).
    return deleteXeroPayment(callContext(conn), payment.remotePaymentId);
  }
}

export const xeroProvider = new XeroProvider();
