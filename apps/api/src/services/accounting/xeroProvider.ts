/**
 * Xero AccountingProvider (spec Phase E). W02 ships CONNECT: OAuth, tokens,
 * tenant selection, organisation settings, pickers and targeted disconnect.
 * W03 implements contacts and items; the `mapping`/`customerImport`
 * capabilities flip in W03b. Every other method refuses with
 * capability_unavailable until its wave flips the capability (W04 invoicePush,
 * W05 paymentPull/paymentPush). The capability gates in routes, producers and
 * workers keep them unreachable; the refusal is the backstop.
 */
import { xeroDailyCallLimit, xeroOAuthConfig } from '../../config/env';
import { AccountingProviderError } from './accountingProviderError';
import {
  decodeXeroAuthEventId, deleteXeroConnection, listXeroConnections, requestXeroTokens, requireXeroBody, xeroApiGet,
  xeroArray, XERO_AUTHORIZE_URL, XERO_SCOPES, type XeroCallContext,
} from './xeroHttp';
import { getXeroContact, listXeroContacts, upsertXeroContact } from './xeroContacts';
import type { AccountingConnection, AccountingEnvironment } from './accountingConnectionService';
import type {
  AccountingCustomerPayload, AccountingDeletePaymentPayload, AccountingEntityMapping, AccountingInvoiceLineMapping,
  AccountingInvoicePayload, AccountingItemPayload, AccountingPaymentPayload, AccountingProvider,
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

function notYet(operation: string, wave: string): never {
  throw new AccountingProviderError({
    kind: 'validation',
    provider: 'xero',
    operation,
    message: `Xero ${operation} is not available yet (ships in ${wave})`,
    providerCode: 'capability_unavailable',
  });
}

function normalizeCurrency(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const code = value.trim().toUpperCase();
  return /^[A-Z]{3}$/.test(code) ? code : null;
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
    connect: true, mapping: false, customerImport: false, invoicePush: false, paymentPull: false, paymentPush: false,
  } as const;
  // paymentRefMax is PROVISIONAL: paymentPush is false until W05, which pins it
  // against the Payments API `Reference` field.
  readonly limits = { paymentRefMax: 255, rate: XERO_RATE_LIMIT };
  readonly paymentMarker = {
    embed: (_reference: string | null, _marker: string): string => notYet('payment marker', 'W05'),
    extract: (_text: string | null | undefined): string | null => notYet('payment marker', 'W05'),
  };

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
      // Invoice lines reference an AccountCode (W04), so a revenue account without a code is not selectable.
      incomeAccounts: active
        .filter((a) => (a.Type === 'REVENUE' || a.Type === 'SALES') && a.Code)
        .map((a): ProviderSettingsOption => ({ ref: a.Code as string, label: a.Name ? `${a.Code} · ${a.Name}` : (a.Code as string), detail: a.Type ?? null })),
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

  // --- later waves (capability false; unreachable behind the gates) ---
  async listRemoteItems(_conn: AccountingConnection, _query?: string): Promise<RemoteItem[]> { return notYet('item listing', 'W03'); }
  async listRemoteIncomeAccounts(_conn: AccountingConnection): Promise<RemoteIncomeAccount[]> { return notYet('income account listing', 'W03'); }
  async upsertItem(
    _conn: AccountingConnection,
    _item: AccountingItemPayload,
    _mapping: AccountingEntityMapping | null,
  ): Promise<RemoteRef> { return notYet('item sync', 'W03'); }
  async pushInvoice(
    _conn: AccountingConnection,
    _invoice: AccountingInvoicePayload,
    _lineMappings: readonly AccountingInvoiceLineMapping[],
  ): Promise<InvoicePushResult> { return notYet('invoice push', 'W04'); }
  async voidInvoice(
    _conn: AccountingConnection,
    _invoice: AccountingVoidInvoicePayload,
    _mapping: AccountingEntityMapping,
  ): Promise<InvoiceVoidResult> { return notYet('invoice void', 'W04'); }
  async createPayment(_conn: AccountingConnection, _payment: AccountingPaymentPayload): Promise<RemoteRef> { return notYet('payment push', 'W05'); }
  async deletePayment(_conn: AccountingConnection, _payment: AccountingDeletePaymentPayload): Promise<PaymentDeleteResult> { return notYet('payment delete', 'W05'); }
  async reconcileChanges(_conn: AccountingConnection, _since: Date | null): Promise<ChangeSet> { return notYet('payment pull', 'W05'); }
  /** Fails closed until W05 ships POST /webhooks/xero (which uses XERO_WEBHOOK_KEY). */
  verifyWebhook(_signatureHeader: string, _rawBody: string, _verifierToken: string): boolean { return false; }
}

export const xeroProvider = new XeroProvider();
