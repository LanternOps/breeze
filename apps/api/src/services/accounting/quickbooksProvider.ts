import { createHmac, timingSafeEqual } from 'crypto';
import { runOutsideDbContext } from '../../db';
import { QBO_CLIENT_ID, QBO_CLIENT_SECRET, QBO_REDIRECT_URI } from '../../config/env';
import type {
  AccountingProvider,
  ChangeSet,
  ConnectionTokens,
  RemoteAddress,
  RemoteCustomer,
  RemoteEntity,
  RemoteRef,
} from './types';
import type { AccountingConnection } from './accountingConnectionService';

const QBO_AUTH_URL = 'https://appcenter.intuit.com/connect/oauth2';
const QBO_TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
const QBO_SCOPE = 'com.intuit.quickbooks.accounting';
const QBO_API_MINOR_VERSION = '70';
const QBO_CUSTOMER_PAGE_SIZE = 1000; // QBO hard cap per query page

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
  };
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
    if (!conn.realmId) throw new Error('QuickBooks connection is missing a realmId');
    if (!conn.accessToken) throw new Error('QuickBooks connection is missing an access token');

    const base = qboApiBase(conn.environment);
    const customers: RemoteCustomer[] = [];
    let startPosition = 1;

    // Page until a short page (< page size) signals the end.
    for (;;) {
      const query = `SELECT * FROM Customer STARTPOSITION ${startPosition} MAXRESULTS ${QBO_CUSTOMER_PAGE_SIZE}`;
      const url = `${base}/v3/company/${conn.realmId}/query?query=${encodeURIComponent(query)}&minorversion=${QBO_API_MINOR_VERSION}`;
      const response = await runOutsideDbContext(() =>
        fetch(url, {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${conn.accessToken}`,
            Accept: 'application/json',
          },
        })
      );

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        const err = new Error(`QuickBooks customer query failed with ${response.status}`);
        (err as Error & { status?: number; body?: string }).status = response.status;
        (err as Error & { status?: number; body?: string }).body = body.slice(0, 500);
        throw err;
      }

      const parsed = await response.json() as { QueryResponse?: { Customer?: QboRawCustomer[] } };
      const page = parsed.QueryResponse?.Customer ?? [];
      for (const raw of page) customers.push(mapQboCustomer(raw));
      if (page.length < QBO_CUSTOMER_PAGE_SIZE) break;
      startPosition += QBO_CUSTOMER_PAGE_SIZE;
    }

    return customers;
  }

  async listRemoteItems(_conn: AccountingConnection, _query?: string): Promise<RemoteEntity[]> {
    throw new Error('NotImplemented: Phase B');
  }

  async upsertCustomer(..._args: unknown[]): Promise<RemoteRef> {
    throw new Error('NotImplemented: Phase B');
  }

  async upsertItem(..._args: unknown[]): Promise<RemoteRef> {
    throw new Error('NotImplemented: Phase B');
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
