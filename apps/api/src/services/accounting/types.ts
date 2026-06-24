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

export interface RemoteRef {
  id: string;
  syncToken?: string;
  docNumber?: string;
}

export interface ChangeSet {
  cursor: Date;
  payments: Array<{
    remoteInvoiceId: string;
    remotePaymentId: string;
    amountMinor: number;
    currency: string;
    txnDate: string;
  }>;
}

export interface AccountingProvider {
  readonly provider: AccountingProviderId;
  buildAuthUrl(state: string): string;
  exchangeCode(code: string, realmId: string): Promise<ConnectionTokens>;
  refresh(refreshToken: string): Promise<ConnectionTokens>;
  listRemoteCustomers(conn: AccountingConnection, query?: string): Promise<RemoteEntity[]>;
  listRemoteItems(conn: AccountingConnection, query?: string): Promise<RemoteEntity[]>;
  upsertCustomer(...args: unknown[]): Promise<RemoteRef>;
  upsertItem(...args: unknown[]): Promise<RemoteRef>;
  pushInvoice(...args: unknown[]): Promise<RemoteRef>;
  voidInvoice(...args: unknown[]): Promise<void>;
  reconcileChanges(conn: AccountingConnection, sinceCursor: Date | null): Promise<ChangeSet>;
  verifyWebhook(signatureHeader: string, rawBody: string, verifierToken: string): boolean;
}
