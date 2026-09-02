import { and, eq } from 'drizzle-orm';
import { accountingConnections } from '../../db/schema';
import { decryptSecret, encryptSecret } from '../secretCrypto';
import { db, withSystemDbAccessContext } from '../../db';
import { assertNoAmbientDbContext, type DbContextRunner } from './dbContextGuard';
import { getAccountingProvider } from './providerRegistry';
import { getValidAccessToken, ReauthRequiredError } from './accountingTokens';
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
  /** Nullable = unknown (never captured, or the capture failed). Multi-currency §11. */
  multiCurrencyEnabled: boolean | null;
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
    multiCurrencyEnabled: row.multiCurrencyEnabled ?? null,
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

/**
 * Compare-and-set the realm's home currency. Returns the NEW `updated_at`
 * generation the row is now at, so a caller writing a second realm-derived
 * field (`updateMultiCurrencyEnabled`) can chain its own CAS onto the
 * generation this write produced instead of the pre-write one it captured —
 * which would abort every time, since this write bumps `updated_at`.
 */
export async function updateHomeCurrency(
  db: DbTransactor,
  connectionId: string,
  partnerId: string,
  expected: { updatedAt: Date; realmId: string | null },
  homeCurrency: string
): Promise<Date> {
  const normalized = homeCurrency.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(normalized)) {
    throw new Error(`Refusing to persist a malformed accounting home currency: ${JSON.stringify(homeCurrency)}`);
  }

  return db.transaction(async (tx) => {
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

    const writtenAt = new Date();
    const updated = await tx
      .update(accountingConnections)
      .set({
        homeCurrency: normalized,
        updatedAt: writtenAt,
      })
      .where(and(
        eq(accountingConnections.id, connectionId),
        eq(accountingConnections.partnerId, partnerId)
      ))
      .returning({ id: accountingConnections.id });
    if (updated.length === 0) {
      throw new Error(`updateHomeCurrency matched no accounting_connections row (id=${connectionId}) on write; the DB context is wrong`);
    }
    return writtenAt;
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

/**
 * Persists the provider-reported multi-currency flag (multi-currency §11)
 * under the SAME `updatedAt` + `realmId` compare-and-set as
 * `updateHomeCurrency`.
 *
 * It was originally a plain guarded UPDATE, on the reasoning that a boolean
 * flag carries no per-realm identity the way a cached currency VALUE does.
 * That is wrong: the flag is read straight off a specific realm's
 * `fetchRealmSettings` response, and `refreshRealmSettings` captures its
 * generation BEFORE a multi-second QuickBooks round trip. A reconnect to a
 * DIFFERENT realm landing inside that window would be stamped with the old
 * realm's flag — and `accountingInvoicePush`'s currency guard keys its
 * remediation copy off exactly that flag. Same CAS, same abort error, so
 * `refreshRealmSettings` treats a lost race the same way for both writes.
 */
export async function updateMultiCurrencyEnabled(
  db: DbTransactor,
  connectionId: string,
  partnerId: string,
  expected: { updatedAt: Date; realmId: string | null },
  multiCurrencyEnabled: boolean | null,
): Promise<void> {
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

    if (!row) {
      throw new Error(`updateMultiCurrencyEnabled matched no accounting_connections row (id=${connectionId}); it was deleted underneath the capture or the DB context is wrong`);
    }

    if (decryptNullable(row.realmIdEncrypted) !== expected.realmId) {
      throw new AccountingHomeCurrencyCasAbortError(`updateMultiCurrencyEnabled aborted: connection ${connectionId} now points at a different realm than the capture started for`);
    }

    if (row.updatedAt === null || row.updatedAt.getTime() !== expected.updatedAt.getTime()) {
      throw new AccountingHomeCurrencyCasAbortError(`updateMultiCurrencyEnabled matched no accounting_connections row (id=${connectionId}) at the expected generation; the connection changed underneath the capture`);
    }

    const updated = await tx
      .update(accountingConnections)
      .set({
        multiCurrencyEnabled,
        updatedAt: new Date(),
      })
      .where(and(
        eq(accountingConnections.id, connectionId),
        eq(accountingConnections.partnerId, partnerId)
      ))
      .returning({ id: accountingConnections.id });
    if (updated.length === 0) {
      throw new Error(`updateMultiCurrencyEnabled matched no accounting_connections row (id=${connectionId}) on write; the DB context is wrong`);
    }
  });
}

export type AccountingConnectionErrorCode = 'not_connected' | 'reauth_required';

/** Typed failure the route translates straight to an HTTP status (mirrors AccountingMappingError). */
export class AccountingConnectionError extends Error {
  constructor(
    public readonly code: AccountingConnectionErrorCode,
    public readonly status: 404 | 409,
    message: string,
  ) {
    super(message);
    this.name = 'AccountingConnectionError';
  }
}

/**
 * Re-fetches the connected realm's settings (home currency + multi-currency
 * flag) on demand — the "Refresh settings" action, distinct from the OAuth
 * callback's connect-time capture. Resolves the connection and a live access
 * token itself (mirrors `resolveConnectionAndToken` in
 * accountingMappingService.ts), so the route stays a thin pass-through.
 *
 * `getValidAccessToken` may ROTATE the connection's tokens (`updateTokens`),
 * which bumps `updated_at` on the row. Re-reading the connection AFTER
 * obtaining the token — rather than reusing the pre-token generation — is
 * deliberate: `updateHomeCurrency`'s compare-and-set below stakes its claim on
 * `updatedAt`, so comparing against a stale pre-refresh snapshot would make
 * the write lose the race on every call that also happened to rotate a token,
 * misreading an ordinary refresh as a concurrent reconnect.
 *
 * Both writes are best-effort against a value the realm reports as unknown
 * (null): a null is never written over a previously captured non-null value,
 * mirroring the OAuth callback's "never blank on an ordinary external
 * condition" rule for home currency.
 */
export async function refreshRealmSettings(
  partnerId: string,
  provider: AccountingProviderId,
  runInDbContext: DbContextRunner,
): Promise<{ homeCurrency: string | null; multiCurrencyEnabled: boolean | null }> {
  assertNoAmbientDbContext('refreshRealmSettings');

  const conn = await runInDbContext(async () => {
    const conn = await getConnection(db, partnerId, provider);
    if (!conn) {
      throw new AccountingConnectionError('not_connected', 404, 'QuickBooks is not connected for this partner');
    }
    if (conn.status === 'reauth_required') {
      throw new AccountingConnectionError('reauth_required', 409, 'QuickBooks needs to be reconnected');
    }
    if (conn.status !== 'connected') {
      throw new AccountingConnectionError('not_connected', 404, 'QuickBooks is not connected for this partner');
    }
    return conn;
  });

  let accessToken: string;
  try {
    // No context held: getValidAccessToken opens its own short system
    // transactions around the refresh fetch and asserts exactly that.
    accessToken = await getValidAccessToken(db, conn);
  } catch (err) {
    if (err instanceof ReauthRequiredError) {
      throw new AccountingConnectionError('reauth_required', 409, 'QuickBooks needs to be reconnected');
    }
    throw err;
  }

  // See the doc comment above: re-read to capture the generation the row will
  // actually be at when we write, not the pre-token-refresh snapshot.
  const freshConn = await runInDbContext(async () => {
    const freshConn = await getConnection(db, partnerId, provider);
    if (!freshConn) {
      throw new AccountingConnectionError('not_connected', 404, 'QuickBooks is not connected for this partner');
    }
    return freshConn;
  });

  const liveConn: AccountingConnection = { ...freshConn, accessToken };
  const providerImpl = getAccountingProvider(provider);
  const settings = await providerImpl.fetchRealmSettings(liveConn);

  // BOTH writes are compare-and-set against the same (updatedAt, realmId)
  // generation, and each one BUMPS `updated_at` — so the second must stake its
  // claim on the generation the FIRST produced, not on the pre-write snapshot.
  // `updateHomeCurrency` returns its new generation for exactly that; losing
  // the home-currency CAS means the generation we hold is stale, so the flag
  // write is skipped rather than issued against a claim we know has expired.
  let generation: Date | null = freshConn.updatedAt;

  if (settings.homeCurrency && generation) {
    try {
      generation = await withSystemDbAccessContext(() => updateHomeCurrency(
        db,
        freshConn.id,
        partnerId,
        { updatedAt: generation as Date, realmId: freshConn.realmId },
        settings.homeCurrency as string,
      ));
    } catch (err) {
      // A lost compare-and-set is an EXPECTED race (a concurrent reconnect or
      // another refresh call already advanced the generation) — the winning
      // write already captured a currency for the generation that survived,
      // so this is not a defect. Any OTHER failure is genuine and propagates.
      if (!isHomeCurrencyCasAbort(err)) throw err;
      generation = null;
    }
  }

  if (typeof settings.multiCurrencyEnabled === 'boolean' && generation) {
    try {
      await withSystemDbAccessContext(() => updateMultiCurrencyEnabled(
        db,
        freshConn.id,
        partnerId,
        { updatedAt: generation as Date, realmId: freshConn.realmId },
        settings.multiCurrencyEnabled,
      ));
    } catch (err) {
      if (!isHomeCurrencyCasAbort(err)) throw err;
    }
  }

  return { homeCurrency: settings.homeCurrency, multiCurrencyEnabled: settings.multiCurrencyEnabled };
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
