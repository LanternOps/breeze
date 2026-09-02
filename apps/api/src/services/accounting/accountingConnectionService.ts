import { and, eq } from 'drizzle-orm';
import { accountingConnections } from '../../db/schema';
import { decryptSecret, encryptSecret } from '../secretCrypto';
import type { AccountingProviderId } from './types';

export type AccountingEnvironment = 'sandbox' | 'production';
export type AccountingPushMode = 'auto' | 'manual';
export type AccountingConnectionStatus = 'connected' | 'disconnected' | 'reauth_required' | 'error';

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
  status: AccountingConnectionStatus;
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
  status?: AccountingConnectionStatus;
  lastError?: string | null;
  connectedBy?: string | null;
}

export interface AccountingTokenUpdate {
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresAt: Date;
  refreshTokenExpiresAt: Date;
}

// Structural seam for the request-scoped Drizzle client so callers can inject a
// mock in tests. Intentionally narrow; production callers pass the real context
// `db`. (Threading the full `Database` type is a follow-up — see PR review.)
export type DbExecutor = {
  select: (...args: any[]) => any;
  insert: (...args: any[]) => any;
  update: (...args: any[]) => any;
  delete: (...args: any[]) => any;
};

/**
 * DbExecutor plus the transaction handle. Declared separately so the existing
 * mock-injecting callers of DbExecutor are untouched; production passes the real
 * request-scoped `db`, which has `.transaction`.
 */
export type DbTransactor = DbExecutor & {
  transaction: <T>(fn: (tx: DbExecutor) => Promise<T>) => Promise<T>;
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
    status: row.status as AccountingConnectionStatus,
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

  // UPDATE set: reuse the already-encrypted ciphertext from `values` (encrypting
  // again here would double the costly encryptSecret work), but for the columns
  // that carry insert-time DEFAULTS — pushMode/environment/status — read from
  // `fields` (undefined when the caller omits them) so a token-only reconnect
  // (the OAuth callback sends no pushMode) does NOT reset an existing
  // connection's settings, e.g. flip a 'manual' connection back to 'auto'.
  const updateSet = stripUndefined({
    realmIdEncrypted: values.realmIdEncrypted,
    accessTokenEncrypted: values.accessTokenEncrypted,
    refreshTokenEncrypted: values.refreshTokenEncrypted,
    accessTokenExpiresAt: fields.accessTokenExpiresAt,
    refreshTokenExpiresAt: fields.refreshTokenExpiresAt,
    environment: fields.environment,
    homeCurrency: fields.homeCurrency,
    defaultIncomeAccountRef: fields.defaultIncomeAccountRef,
    defaultTaxCodeRef: fields.defaultTaxCodeRef,
    pushMode: fields.pushMode,
    webhookVerifierTokenEncrypted: values.webhookVerifierTokenEncrypted,
    status: fields.status,
    lastError: fields.lastError,
    connectedBy: fields.connectedBy,
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
  // RETURNING + 0-row guard: an RLS-context mismatch (wrong/bare db context)
  // would otherwise match 0 rows silently and discard the freshly-rotated
  // refresh token, permanently breaking the connection. Fail loudly instead.
  const updated = await db
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
    ))
    .returning({ id: accountingConnections.id });
  if (updated.length === 0) {
    throw new Error(`updateTokens matched no accounting_connections row (id=${connectionId}); refusing to drop rotated token silently`);
  }
}

/**
 * Persists the provider-reported home currency (multi-currency §11, bug B8).
 *
 * Narrow UPDATE, never a second upsertConnection: an upsert would resurrect a
 * disconnected row with default settings and no usable credentials.
 *
 * REALM-GENERATION compare-and-set, under a row lock. The unique
 * (partner_id, provider) index means a reconnect to a DIFFERENT realm reuses this
 * row id, so a slow Preferences response from the previous realm must not
 * overwrite the new one. `updated_at` alone cannot decide that: upsertConnection
 * stamps an APPLICATION timestamp, so two reconnects in the same millisecond can
 * share it. The realm id is the real identity — it is compared after decryption
 * under FOR UPDATE (the ciphertext uses a random IV, so SQL cannot compare it),
 * with the timestamp kept as a second barrier against a same-realm double capture.
 *
 * The value is a cache of an EXTERNAL fact — it is not validated against
 * supported_currencies and carries no FK, because a realm may legitimately run
 * a currency Breeze cannot bill in. The only shape rule is ISO-4217-looking.
 *
 * Lock note: this is the only row lock wave 8 takes. It is a single leaf-table
 * row, held across no other lock and no network call.
 */
/**
 * A lost compare-and-set on the home-currency capture: the row was reconnected
 * (same realm or another) between the capture starting and the write. That is an
 * EXPECTED race on a normal user action — double connect, concurrent reconnect —
 * not a defect, so callers report it as a warning rather than an exception.
 * Callers MUST branch on the code, never on message text.
 */
export const ACCOUNTING_HOME_CURRENCY_CAS_ABORT = 'ACCOUNTING_HOME_CURRENCY_CAS_ABORT';

export class AccountingHomeCurrencyCasAbortError extends Error {
  readonly code = ACCOUNTING_HOME_CURRENCY_CAS_ABORT;
  constructor(message: string) {
    super(message);
    this.name = 'AccountingHomeCurrencyCasAbortError';
  }
}

export function isHomeCurrencyCasAbort(err: unknown): boolean {
  return typeof err === 'object'
    && err !== null
    && (err as { code?: unknown }).code === ACCOUNTING_HOME_CURRENCY_CAS_ABORT;
}

export async function updateHomeCurrency(
  db: DbTransactor,
  connectionId: string,
  partnerId: string,
  expected: { updatedAt: Date; realmId: string | null },
  homeCurrency: string
): Promise<void> {
  const normalized = homeCurrency.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(normalized)) {
    throw new Error(`Refusing to persist a malformed accounting home currency: ${JSON.stringify(homeCurrency)}`);
  }

  await db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(accountingConnections)
      .where(and(
        eq(accountingConnections.id, connectionId),
        eq(accountingConnections.partnerId, partnerId)
      ))
      .limit(1)
      .for('update');

    // Zero rows means deleted underneath the capture OR hidden by RLS — both are
    // "do not write", and both must be loud (the updateTokens/markStatus
    // precedent at :193-195: a silent no-op hides an RLS-context mistake).
    if (!row) {
      throw new Error(`updateHomeCurrency matched no accounting_connections row (id=${connectionId}); it was deleted underneath the capture or the DB context is wrong`);
    }

    if (decryptNullable(row.realmIdEncrypted) !== expected.realmId) {
      throw new AccountingHomeCurrencyCasAbortError(`updateHomeCurrency aborted: connection ${connectionId} now points at a different realm than the capture started for`);
    }

    if (row.updatedAt === null || row.updatedAt.getTime() !== expected.updatedAt.getTime()) {
      throw new AccountingHomeCurrencyCasAbortError(`updateHomeCurrency matched no accounting_connections row (id=${connectionId}) at the expected generation; the connection changed underneath the capture`);
    }

    const updated = await tx
      .update(accountingConnections)
      .set({
        homeCurrency: normalized,
        updatedAt: new Date(),
      })
      .where(and(
        eq(accountingConnections.id, connectionId),
        eq(accountingConnections.partnerId, partnerId)
      ))
      .returning({ id: accountingConnections.id });
    if (updated.length === 0) {
      throw new Error(`updateHomeCurrency matched no accounting_connections row (id=${connectionId}) on write; the DB context is wrong`);
    }
  });
}

export async function markStatus(
  db: DbExecutor,
  connectionId: string,
  partnerId: string,
  status: AccountingConnectionStatus,
  lastError?: string
): Promise<void> {
  const updated = await db
    .update(accountingConnections)
    .set(stripUndefined({
      status,
      lastError,
      updatedAt: new Date(),
    }))
    .where(and(
      eq(accountingConnections.id, connectionId),
      eq(accountingConnections.partnerId, partnerId)
    ))
    .returning({ id: accountingConnections.id });
  if (updated.length === 0) {
    throw new Error(`markStatus matched no accounting_connections row (id=${connectionId}); status '${status}' not persisted`);
  }
}

/** Returns true if a connection row was deleted, false if none matched. */
export async function deleteConnection(
  db: DbExecutor,
  partnerId: string,
  provider: AccountingProviderId
): Promise<boolean> {
  const deleted = await db
    .delete(accountingConnections)
    .where(and(
      eq(accountingConnections.partnerId, partnerId),
      eq(accountingConnections.provider, provider)
    ))
    .returning({ id: accountingConnections.id });
  return deleted.length > 0;
}
