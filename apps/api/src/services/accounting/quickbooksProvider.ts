import { createHmac, timingSafeEqual } from 'crypto';
import { runOutsideDbContext } from '../../db';
import { QBO_CLIENT_ID, QBO_CLIENT_SECRET, QBO_REDIRECT_URI } from '../../config/env';
import type {
  AccountingCustomerPayload,
  AccountingEntityMapping,
  AccountingInvoiceLineMapping,
  AccountingInvoicePayload,
  AccountingItemPayload,
  AccountingProvider,
  AccountingVoidInvoicePayload,
  ChangeSet,
  ConnectionTokens,
  RemoteAddress,
  RemoteCustomer,
  RemoteIncomeAccount,
  RemoteItem,
  RemoteRef,
} from './types';
import type { AccountingConnection } from './accountingConnectionService';

const QBO_AUTH_URL = 'https://appcenter.intuit.com/connect/oauth2';
const QBO_TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
const QBO_SCOPE = 'com.intuit.quickbooks.accounting';
const QBO_API_MINOR_VERSION = '70';
const QBO_QUERY_PAGE_SIZE = 1000; // QBO hard cap per query page

/**
 * Abort budget for the OPTIONAL home-currency capture. It is awaited inline in
 * the OAuth callback, before the state cookie is cleared and the browser is
 * redirected, so undici's ~300s headers timeout would park the connecting user
 * on a blank /callback for five minutes over a capture that is non-fatal by
 * design. It stays inline rather than fire-and-forget so the compare-and-set
 * still runs against the generation the callback just wrote (a queued job would
 * have to re-derive it), which means the budget has to be short enough that a
 * hung Intuit is invisible: a few seconds beyond a normal Preferences round-trip
 * (sub-second) and well inside a user's patience for a redirect.
 */
export const QBO_PREFERENCES_TIMEOUT_MS = 8_000;

function qboApiBase(environment: 'sandbox' | 'production'): string {
  return environment === 'production'
    ? 'https://quickbooks.api.intuit.com'
    : 'https://sandbox-quickbooks.api.intuit.com';
}

interface QboRawAddress {
  Line1?: string; Line2?: string; City?: string;
  CountrySubDivisionCode?: string; PostalCode?: string; Country?: string;
}

interface QboRawCustomer {
  Id: string;
  SyncToken?: string;
  DisplayName?: string;
  CompanyName?: string;
  PrimaryEmailAddr?: { Address?: string };
  PrimaryPhone?: { FreeFormNumber?: string };
  GivenName?: string;
  FamilyName?: string;
  Active?: boolean;
  BillAddr?: QboRawAddress;
  ShipAddr?: QboRawAddress;
}

/**
 * Builds the DELIBERATELY sanitized preferences error (multi-currency §11).
 * This error is handed to captureException by the OAuth callback and a QBO
 * fault body — or a proxy's HTML error page — can carry realm/company/customer
 * detail, so only the status and the operation ever travel.
 */
function preferencesError(status: number | null, reason: string): Error & { status?: number; operation: string } {
  const err = new Error(
    status === null
      ? `QuickBooks preferences request ${reason}`
      : `QuickBooks preferences request ${reason} (status ${status})`,
  ) as Error & { status?: number; operation: string };
  if (status !== null) err.status = status;
  err.operation = 'fetchHomeCurrency';
  return err;
}

/**
 * QBO Preferences response. `HomeCurrency` is a REFERENCE object, so the code
 * lives at `.value` — and it comes from Preferences, never CompanyInfo
 * (multi-currency §11).
 */
export interface QboRawPreferences {
  Preferences?: {
    CurrencyPrefs?: {
      HomeCurrency?: { value?: string | null } | null;
    } | null;
  };
}

/**
 * Normalizes the realm's home currency to an uppercase three-letter code.
 * Deliberately NOT validated against Breeze's curated supported-currency list:
 * a realm may legitimately run a currency Breeze cannot bill in, and that must
 * stay connectable — the invoice-push guard blocks it later instead.
 */
export function mapQboHomeCurrency(raw: QboRawPreferences): string | null {
  const value = raw.Preferences?.CurrencyPrefs?.HomeCurrency?.value;
  if (typeof value !== 'string') return null;
  const code = value.trim().toUpperCase();
  return /^[A-Z]{3}$/.test(code) ? code : null;
}

interface QboRawItem {
  Id: string;
  Name?: string;
  Sku?: string;
  Description?: string;
  Type?: string;
  UnitPrice?: number;
  Active?: boolean;
  SyncToken?: string;
}

interface QboRawAccount {
  Id: string;
  Name?: string;
  AccountType?: string;
  AccountSubType?: string;
  Active?: boolean;
}

export function mapQboAddress(raw: QboRawAddress | undefined): RemoteAddress | undefined {
  if (!raw) return undefined;
  const addr: RemoteAddress = {
    line1: raw.Line1 || undefined,
    line2: raw.Line2 || undefined,
    city: raw.City || undefined,
    region: raw.CountrySubDivisionCode || undefined,
    postalCode: raw.PostalCode || undefined,
    country: raw.Country || undefined,
  };
  return Object.values(addr).some((v) => v !== undefined) ? addr : undefined;
}

export function mapQboCustomer(raw: QboRawCustomer): RemoteCustomer {
  const contactName = [raw.GivenName, raw.FamilyName].filter(Boolean).join(' ').trim();
  return {
    id: raw.Id,
    displayName: raw.DisplayName || raw.CompanyName || raw.Id,
    companyName: raw.CompanyName || undefined,
    email: raw.PrimaryEmailAddr?.Address || undefined,
    phone: raw.PrimaryPhone?.FreeFormNumber || undefined,
    contactName: contactName || undefined,
    active: raw.Active,
    billAddr: mapQboAddress(raw.BillAddr),
    shipAddr: mapQboAddress(raw.ShipAddr),
    syncToken: raw.SyncToken,
  };
}

function mapRemoteItem(raw: QboRawItem): RemoteItem {
  return {
    id: raw.Id,
    displayName: raw.Name || raw.Id,
    sku: raw.Sku || undefined,
    description: raw.Description || undefined,
    type: raw.Type,
    unitPrice: raw.UnitPrice,
    active: raw.Active,
    syncToken: raw.SyncToken,
  };
}

function mapRemoteIncomeAccount(raw: QboRawAccount): RemoteIncomeAccount {
  return {
    id: raw.Id,
    displayName: raw.Name || raw.Id,
    accountType: raw.AccountType || 'Income',
    accountSubType: raw.AccountSubType || undefined,
  };
}

function mapAddressToQbo(address: RemoteAddress | undefined): Record<string, string | undefined> | undefined {
  if (!address) return undefined;
  const result = {
    Line1: address.line1,
    Line2: address.line2,
    City: address.city,
    CountrySubDivisionCode: address.region,
    PostalCode: address.postalCode,
    Country: address.country,
  };
  return Object.values(result).some((value) => value !== undefined) ? result : undefined;
}

interface QboTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  x_refresh_token_expires_in?: number;
  error?: string;
  error_description?: string;
}

export class QuickbooksProvider implements AccountingProvider {
  readonly provider = 'quickbooks' as const;

  buildAuthUrl(state: string): string {
    const url = new URL(QBO_AUTH_URL);
    url.searchParams.set('client_id', QBO_CLIENT_ID);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', QBO_SCOPE);
    url.searchParams.set('redirect_uri', QBO_REDIRECT_URI);
    url.searchParams.set('state', state);
    return url.toString();
  }

  async exchangeCode(code: string, realmId: string): Promise<ConnectionTokens> {
    return this.requestTokens('authorization_code', { code, realmId });
  }

  async refresh(refreshToken: string): Promise<ConnectionTokens> {
    return this.requestTokens('refresh_token', { refreshToken, realmId: '' });
  }

  // NOTE: assumes `conn.accessToken` is already a VALID token. Callers must
  // resolve it via getValidAccessToken(db, conn) first (which refreshes +
  // persists rotation) — this method stays pure HTTP and issues no DB queries.
  async listRemoteCustomers(conn: AccountingConnection): Promise<RemoteCustomer[]> {
    const customers: RemoteCustomer[] = [];
    let startPosition = 1;

    // Page until a short page (< page size) signals the end.
    for (;;) {
      const query = `SELECT * FROM Customer STARTPOSITION ${startPosition} MAXRESULTS ${QBO_QUERY_PAGE_SIZE}`;
      const parsed = await this.qboRequest<{ QueryResponse?: { Customer?: QboRawCustomer[] } }>(
        conn,
        `query?query=${encodeURIComponent(query)}&minorversion=${QBO_API_MINOR_VERSION}`,
        'QuickBooks customer query',
      );
      const page = parsed.QueryResponse?.Customer ?? [];
      for (const raw of page) customers.push(mapQboCustomer(raw));
      if (page.length < QBO_QUERY_PAGE_SIZE) break;
      startPosition += QBO_QUERY_PAGE_SIZE;
    }

    return customers;
  }

  async listRemoteItems(conn: AccountingConnection, _query?: string): Promise<RemoteItem[]> {
    const items: RemoteItem[] = [];
    let startPosition = 1;
    for (;;) {
      const query = `SELECT * FROM Item STARTPOSITION ${startPosition} MAXRESULTS ${QBO_QUERY_PAGE_SIZE}`;
      const parsed = await this.qboRequest<{ QueryResponse?: { Item?: QboRawItem[] } }>(
        conn,
        `query?query=${encodeURIComponent(query)}&minorversion=${QBO_API_MINOR_VERSION}`,
        'QuickBooks item query',
      );
      const page = parsed.QueryResponse?.Item ?? [];
      items.push(...page.map(mapRemoteItem));
      if (page.length < QBO_QUERY_PAGE_SIZE) break;
      startPosition += QBO_QUERY_PAGE_SIZE;
    }
    return items;
  }

  // NOTE: like listRemoteCustomers, this assumes `conn.accessToken` is already
  // valid and issues no DB queries. The fetch runs OUTSIDE any DB context so a
  // QBO round-trip never holds a pooled connection (#1105 class).
  async fetchHomeCurrency(conn: AccountingConnection): Promise<string | null> {
    if (!conn.realmId) throw new Error('QuickBooks connection is missing a realmId');
    if (!conn.accessToken) throw new Error('QuickBooks connection is missing an access token');

    const url = `${qboApiBase(conn.environment)}/v3/company/${conn.realmId}/preferences?minorversion=${QBO_API_MINOR_VERSION}`;
    // An explicit controller rather than AbortSignal.timeout so the timer is
    // cleared on the normal path and the abort reason is a sanitized error.
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(preferencesError(null, 'timed out')),
      QBO_PREFERENCES_TIMEOUT_MS,
    );
    let response: Response;
    try {
      response = await runOutsideDbContext(() =>
        fetch(url, {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${conn.accessToken}`,
            Accept: 'application/json',
          },
          signal: controller.signal,
        })
      );
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      // Sanitized, unlike listRemoteCustomers. The body is never read — but it
      // must still be discarded, or undici holds the connection open until GC.
      await response.body?.cancel().catch(() => {});
      throw preferencesError(response.status, 'failed');
    }

    // Guarded: a proxy/WAF can answer 200 with an HTML page, and the SyntaxError
    // from an unguarded .json() embeds a snippet of that body in its message —
    // which the OAuth callback would hand straight to captureException, defeating
    // the sanitization above.
    let parsed: QboRawPreferences;
    try {
      parsed = await response.json() as QboRawPreferences;
    } catch {
      throw preferencesError(response.status, 'returned a non-JSON body');
    }
    return mapQboHomeCurrency(parsed);
  }

  async listRemoteIncomeAccounts(conn: AccountingConnection): Promise<RemoteIncomeAccount[]> {
    const accounts: RemoteIncomeAccount[] = [];
    let startPosition = 1;
    for (;;) {
      const query = `SELECT * FROM Account WHERE AccountType = 'Income' AND Active = true STARTPOSITION ${startPosition} MAXRESULTS ${QBO_QUERY_PAGE_SIZE}`;
      const parsed = await this.qboRequest<{ QueryResponse?: { Account?: QboRawAccount[] } }>(
        conn,
        `query?query=${encodeURIComponent(query)}&minorversion=${QBO_API_MINOR_VERSION}`,
        'QuickBooks income account query',
      );
      const page = parsed.QueryResponse?.Account ?? [];
      accounts.push(...page.map(mapRemoteIncomeAccount));
      if (page.length < QBO_QUERY_PAGE_SIZE) break;
      startPosition += QBO_QUERY_PAGE_SIZE;
    }
    return accounts;
  }

  async upsertCustomer(
    conn: AccountingConnection,
    customer: AccountingCustomerPayload,
    mapping: AccountingEntityMapping | null,
  ): Promise<RemoteRef> {
    if (mapping && !mapping.remoteSyncToken) {
      throw new Error('QuickBooks Customer update requires the current SyncToken');
    }
    // CurrencyRef is deliberately NOT sent — sending it to a single-currency
    // realm is a QBO error, so the realm default is what a create gets. What
    // makes that safe is the CREATE-path guard in accountingMappingService.ts
    // (`assertCreateCurrencyMatchesRealm`, called from `syncMappedEntity`
    // before this method is reached): it refuses to create a Customer/Item
    // whose Breeze-stamped currency is not the connection's captured
    // `homeCurrency`, and refuses outright when that home currency is unknown.
    // Phase C's `assertAccountingInvoicePushCurrency` is the matching guard on
    // the invoice-push path; neither one gates an UPDATE, because QBO fixes
    // CurrencyRef at creation and a sparse update cannot change it.
    const payload = {
      ...(mapping ? {
        sparse: true,
        Id: mapping.remoteEntityId,
        SyncToken: mapping.remoteSyncToken,
      } : {}),
      DisplayName: customer.displayName,
      CompanyName: customer.companyName,
      PrimaryEmailAddr: customer.billingEmail ? { Address: customer.billingEmail } : undefined,
      PrimaryPhone: customer.phone ? { FreeFormNumber: customer.phone } : undefined,
      PrimaryTaxIdentifier: customer.taxId ?? undefined,
      BillAddr: mapAddressToQbo(customer.billAddr),
      ShipAddr: mapAddressToQbo(customer.shipAddr),
    };
    const parsed = await this.qboRequest<{ Customer?: QboRawCustomer }>(
      conn,
      `customer?minorversion=${QBO_API_MINOR_VERSION}`,
      'QuickBooks customer upsert',
      { method: 'POST', body: JSON.stringify(payload) },
    );
    if (!parsed.Customer?.Id) throw new Error('QuickBooks customer response was missing an Id');
    return { id: parsed.Customer.Id, syncToken: parsed.Customer.SyncToken };
  }

  async upsertItem(
    conn: AccountingConnection,
    item: AccountingItemPayload,
    mapping: AccountingEntityMapping | null,
  ): Promise<RemoteRef> {
    if (mapping && !mapping.remoteSyncToken) {
      throw new Error('QuickBooks Item update requires the current SyncToken');
    }
    if (!mapping && !item.incomeAccountRef) {
      throw new Error('QuickBooks Item creation requires an income account');
    }
    const payload = {
      ...(mapping ? {
        sparse: true,
        Id: mapping.remoteEntityId,
        SyncToken: mapping.remoteSyncToken,
      } : {}),
      Name: item.name,
      Sku: item.sku,
      Description: item.description ?? undefined,
      Type: item.type,
      // The seam carries a major-unit decimal string (spec §12); QBO wants a
      // JSON number.
      UnitPrice: Number(item.unitPrice),
      Taxable: item.taxable,
      Active: item.active,
      IncomeAccountRef: item.incomeAccountRef ? { value: item.incomeAccountRef } : undefined,
    };
    const parsed = await this.qboRequest<{ Item?: QboRawItem }>(
      conn,
      `item?minorversion=${QBO_API_MINOR_VERSION}`,
      'QuickBooks item upsert',
      { method: 'POST', body: JSON.stringify(payload) },
    );
    if (!parsed.Item?.Id) throw new Error('QuickBooks item response was missing an Id');
    return { id: parsed.Item.Id, syncToken: parsed.Item.SyncToken };
  }

  async pushInvoice(
    _conn: AccountingConnection,
    _invoice: AccountingInvoicePayload,
    _lineMappings: readonly AccountingInvoiceLineMapping[],
  ): Promise<RemoteRef> {
    throw new Error('NotImplemented: Phase C');
  }

  async voidInvoice(
    _conn: AccountingConnection,
    _invoice: AccountingVoidInvoicePayload,
    _mapping: AccountingEntityMapping,
  ): Promise<void> {
    throw new Error('NotImplemented: Phase C');
  }

  async reconcileChanges(_conn: AccountingConnection, _sinceCursor: Date | null): Promise<ChangeSet> {
    throw new Error('NotImplemented: Phase D');
  }

  verifyWebhook(signatureHeader: string, rawBody: string, verifierToken: string): boolean {
    if (!signatureHeader || !verifierToken) return false;
    const expected = createHmac('sha256', verifierToken).update(rawBody).digest('base64');
    const left = Buffer.from(signatureHeader, 'utf8');
    const right = Buffer.from(expected, 'utf8');
    if (left.length !== right.length) return false;
    return timingSafeEqual(left, right);
  }

  private async qboRequest<T>(
    conn: AccountingConnection,
    path: string,
    operation: string,
    init: RequestInit = {},
  ): Promise<T> {
    if (!conn.realmId) throw new Error('QuickBooks connection is missing a realmId');
    if (!conn.accessToken) throw new Error('QuickBooks connection is missing an access token');

    const response = await runOutsideDbContext(() => fetch(
      `${qboApiBase(conn.environment)}/v3/company/${conn.realmId}/${path}`,
      {
        ...init,
        headers: {
          Authorization: `Bearer ${conn.accessToken}`,
          Accept: 'application/json',
          ...(init.body ? { 'Content-Type': 'application/json' } : {}),
          ...init.headers,
        },
      },
    ));
    const text = await response.text();
    if (!response.ok) {
      const error = new Error(`${operation} failed with ${response.status}`);
      Object.assign(error, { status: response.status, body: text.slice(0, 500) });
      throw error;
    }
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new Error(`${operation} returned invalid JSON`);
    }
  }

  private async requestTokens(
    grantType: 'authorization_code' | 'refresh_token',
    input: { code?: string; refreshToken?: string; realmId: string }
  ): Promise<ConnectionTokens> {
    const body = new URLSearchParams();
    body.set('grant_type', grantType);
    if (grantType === 'authorization_code') {
      body.set('code', input.code ?? '');
      body.set('redirect_uri', QBO_REDIRECT_URI);
    } else {
      body.set('refresh_token', input.refreshToken ?? '');
    }

    const response = await runOutsideDbContext(() =>
      fetch(QBO_TOKEN_URL, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${Buffer.from(`${QBO_CLIENT_ID}:${QBO_CLIENT_SECRET}`).toString('base64')}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body: body.toString(),
      })
    );

    const text = await response.text();
    const parsed = text ? JSON.parse(text) as QboTokenResponse : {};
    if (!response.ok) {
      const err = new Error(parsed.error_description || parsed.error || `QuickBooks token request failed with ${response.status}`);
      (err as Error & { status?: number; qboError?: string }).status = response.status;
      (err as Error & { status?: number; qboError?: string }).qboError = parsed.error;
      throw err;
    }

    if (!parsed.access_token || !parsed.refresh_token || !parsed.expires_in || !parsed.x_refresh_token_expires_in) {
      throw new Error('QuickBooks token response was missing required fields');
    }

    const now = Date.now();
    return {
      realmId: input.realmId,
      accessToken: parsed.access_token,
      refreshToken: parsed.refresh_token,
      accessTokenExpiresAt: new Date(now + parsed.expires_in * 1000),
      refreshTokenExpiresAt: new Date(now + parsed.x_refresh_token_expires_in * 1000),
    };
  }
}

export const quickbooksProvider = new QuickbooksProvider();
