import { createHmac, timingSafeEqual } from 'crypto';
import { runOutsideDbContext } from '../../db';
import { QBO_CLIENT_ID, QBO_CLIENT_SECRET, QBO_REDIRECT_URI } from '../../config/env';
import type {
  AccountingProvider,
  ChangeSet,
  ConnectionTokens,
  CustomerUpsertInput,
  ItemUpsertInput,
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

  async upsertCustomer(conn: AccountingConnection, input: CustomerUpsertInput): Promise<RemoteRef> {
    if (input.existing && !input.existing.syncToken) {
      throw new Error('QuickBooks Customer update requires the current SyncToken');
    }
    const payload = {
      ...(input.existing ? {
        sparse: true,
        Id: input.existing.id,
        SyncToken: input.existing.syncToken,
      } : {}),
      DisplayName: input.displayName,
      CompanyName: input.companyName,
      PrimaryEmailAddr: input.email ? { Address: input.email } : undefined,
      PrimaryPhone: input.phone ? { FreeFormNumber: input.phone } : undefined,
      PrimaryTaxIdentifier: input.taxId,
      BillAddr: mapAddressToQbo(input.billingAddress),
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

  async upsertItem(conn: AccountingConnection, input: ItemUpsertInput): Promise<RemoteRef> {
    if (input.existing && !input.existing.syncToken) {
      throw new Error('QuickBooks Item update requires the current SyncToken');
    }
    const payload = {
      ...(input.existing ? {
        sparse: true,
        Id: input.existing.id,
        SyncToken: input.existing.syncToken,
      } : {}),
      Name: input.name,
      Sku: input.sku,
      Description: input.description,
      Type: input.type,
      UnitPrice: input.unitPrice,
      Taxable: input.taxable,
      Active: input.active,
      IncomeAccountRef: { value: input.incomeAccountRef },
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

  async pushInvoice(..._args: unknown[]): Promise<RemoteRef> {
    throw new Error('NotImplemented: Phase C');
  }

  async voidInvoice(..._args: unknown[]): Promise<void> {
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
