import { and, eq } from 'drizzle-orm';
import { accountingConnections } from '../../db/schema';
import { decryptSecret, encryptSecret } from '../secretCrypto';
import type { AccountingProviderId } from './types';

export type AccountingEnvironment = 'sandbox' | 'production';
export type AccountingPushMode = 'auto' | 'manual';

export interface AccountingConnection {
  id: string;
  partnerId: string;
  provider: AccountingProviderId;
  realmId: string | null;
  accessToken: string | null;
  refreshToken: string | null;
  accessTokenExpiresAt: Date | null;
  refreshTokenExpiresAt: Date | null;
  environment: AccountingEnvironment;
  homeCurrency: string | null;
  defaultIncomeAccountRef: string | null;
  defaultTaxCodeRef: string | null;
  pushMode: AccountingPushMode;
  status: string;
  createdAt: Date | null;
  updatedAt: Date | null;
  lastError: string | null;
}

export interface UpsertConnectionFields {
  realmId?: string | null;
  accessToken?: string | null;
  refreshToken?: string | null;
  accessTokenExpiresAt?: Date | null;
  refreshTokenExpiresAt?: Date | null;
  environment?: AccountingEnvironment;
  homeCurrency?: string | null;
  defaultIncomeAccountRef?: string | null;
  defaultTaxCodeRef?: string | null;
  pushMode?: AccountingPushMode;
  webhookVerifierToken?: string | null;
  status?: string;
  lastError?: string | null;
  connectedBy?: string | null;
}

export interface AccountingTokenUpdate {
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresAt: Date;
  refreshTokenExpiresAt: Date;
}

type DbExecutor = {
  select: (...args: any[]) => any;
  insert: (...args: any[]) => any;
  update: (...args: any[]) => any;
  delete: (...args: any[]) => any;
};

type AccountingConnectionRow = typeof accountingConnections.$inferSelect;

function decryptNullable(value: string | null | undefined): string | null {
  if (!value) return null;
  return decryptSecret(value);
}

function encryptedField(value: string | null | undefined): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return encryptSecret(value);
}

function stripUndefined<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as Partial<T>;
}

function mapConnection(row: AccountingConnectionRow): AccountingConnection {
  return {
    id: row.id,
    partnerId: row.partnerId,
    provider: row.provider as AccountingProviderId,
    realmId: decryptNullable(row.realmIdEncrypted),
    accessToken: decryptNullable(row.accessTokenEncrypted),
    refreshToken: decryptNullable(row.refreshTokenEncrypted),
    accessTokenExpiresAt: row.accessTokenExpiresAt ?? null,
    refreshTokenExpiresAt: row.refreshTokenExpiresAt ?? null,
    environment: row.environment as AccountingEnvironment,
    homeCurrency: row.homeCurrency ?? null,
    defaultIncomeAccountRef: row.defaultIncomeAccountRef ?? null,
    defaultTaxCodeRef: row.defaultTaxCodeRef ?? null,
    pushMode: row.pushMode as AccountingPushMode,
    status: row.status,
    createdAt: row.createdAt ?? null,
    updatedAt: row.updatedAt ?? null,
    lastError: row.lastError ?? null,
  };
}

export async function getConnection(
  db: DbExecutor,
  partnerId: string,
  provider: AccountingProviderId
): Promise<AccountingConnection | null> {
  const [row] = await db
    .select()
    .from(accountingConnections)
    .where(and(
      eq(accountingConnections.partnerId, partnerId),
      eq(accountingConnections.provider, provider)
    ))
    .limit(1);

  return row ? mapConnection(row) : null;
}

export async function upsertConnection(
  db: DbExecutor,
  partnerId: string,
  provider: AccountingProviderId,
  fields: UpsertConnectionFields
): Promise<AccountingConnection> {
  const now = new Date();
  const values = stripUndefined({
    partnerId,
    provider,
    realmIdEncrypted: encryptedField(fields.realmId),
    accessTokenEncrypted: encryptedField(fields.accessToken),
    refreshTokenEncrypted: encryptedField(fields.refreshToken),
    accessTokenExpiresAt: fields.accessTokenExpiresAt,
    refreshTokenExpiresAt: fields.refreshTokenExpiresAt,
    environment: fields.environment ?? 'production',
    homeCurrency: fields.homeCurrency,
    defaultIncomeAccountRef: fields.defaultIncomeAccountRef,
    defaultTaxCodeRef: fields.defaultTaxCodeRef,
    pushMode: fields.pushMode ?? 'auto',
    webhookVerifierTokenEncrypted: encryptedField(fields.webhookVerifierToken),
    status: fields.status ?? 'connected',
    lastError: fields.lastError,
    connectedBy: fields.connectedBy,
    updatedAt: now,
  });

  const updateSet = stripUndefined({
    realmIdEncrypted: values.realmIdEncrypted,
    accessTokenEncrypted: values.accessTokenEncrypted,
    refreshTokenEncrypted: values.refreshTokenEncrypted,
    accessTokenExpiresAt: values.accessTokenExpiresAt,
    refreshTokenExpiresAt: values.refreshTokenExpiresAt,
    environment: values.environment,
    homeCurrency: values.homeCurrency,
    defaultIncomeAccountRef: values.defaultIncomeAccountRef,
    defaultTaxCodeRef: values.defaultTaxCodeRef,
    pushMode: values.pushMode,
    webhookVerifierTokenEncrypted: values.webhookVerifierTokenEncrypted,
    status: values.status,
    lastError: values.lastError,
    connectedBy: values.connectedBy,
    updatedAt: now,
  });

  const [row] = await db
    .insert(accountingConnections)
    .values(values)
    .onConflictDoUpdate({
      target: [accountingConnections.partnerId, accountingConnections.provider],
      set: updateSet,
    })
    .returning();

  if (!row) {
    throw new Error('Failed to persist accounting connection');
  }

  return mapConnection(row);
}

export async function updateTokens(
  db: DbExecutor,
  connectionId: string,
  partnerId: string,
  tokens: AccountingTokenUpdate
): Promise<void> {
  await db
    .update(accountingConnections)
    .set({
      accessTokenEncrypted: encryptSecret(tokens.accessToken),
      refreshTokenEncrypted: encryptSecret(tokens.refreshToken),
      accessTokenExpiresAt: tokens.accessTokenExpiresAt,
      refreshTokenExpiresAt: tokens.refreshTokenExpiresAt,
      updatedAt: new Date(),
    })
    .where(and(
      eq(accountingConnections.id, connectionId),
      eq(accountingConnections.partnerId, partnerId)
    ));
}

export async function markStatus(
  db: DbExecutor,
  connectionId: string,
  partnerId: string,
  status: string,
  lastError?: string
): Promise<void> {
  await db
    .update(accountingConnections)
    .set(stripUndefined({
      status,
      lastError,
      updatedAt: new Date(),
    }))
    .where(and(
      eq(accountingConnections.id, connectionId),
      eq(accountingConnections.partnerId, partnerId)
    ));
}

export async function deleteConnection(
  db: DbExecutor,
  partnerId: string,
  provider: AccountingProviderId
): Promise<void> {
  await db
    .delete(accountingConnections)
    .where(and(
      eq(accountingConnections.partnerId, partnerId),
      eq(accountingConnections.provider, provider)
    ));
}
