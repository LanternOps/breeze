import { and, eq, inArray, isNotNull, isNull, like, ne, or, sql, type SQL } from 'drizzle-orm';
import { accountingConnections, accountingEntityMappings } from '../../db/schema';
import { decryptSecret, encryptSecret, getActiveSecretEncryptionKeyId, hmacFingerprint } from '../secretCrypto';
import { db, withSystemDbAccessContext } from '../../db';
import { readWithPartnerAxisVisibility } from '../../db/partnerAxisRead';
import { assertNoAmbientDbContext, type DbContextRunner } from './dbContextGuard';
import { accountingProviderDisplayName, getAccountingProvider, providerSupports } from './providerRegistry';
import { getValidAccessToken, ReauthRequiredError } from './accountingTokens';
import type { AccountingCapability, AccountingProviderId } from './types';
import { isPgUniqueViolation } from '../../utils/pgErrors';
import { abandonAccountingFees } from './accountingFeeAbandonment';
import { captureException } from '../sentry';

export type AccountingEnvironment = 'sandbox' | 'production';
export type AccountingPushMode = 'auto' | 'manual';
export type AccountingConnectionStatus = 'connected' | 'disconnected' | 'reauth_required' | 'error' | 'pending_tenant';

/**
 * Xero W02: a connect whose grant authorised several organisations, waiting for
 * the user to pick one. It HOLDS the partner's one-connection slot (the unique
 * partner index counts it, so a half-finished connect blocks a QuickBooks
 * connect until cancelled or reaped) but is NOT an active connection: both
 * resolvers below exclude it, so no worker, producer or route ever acts on it.
 */
export const PENDING_TENANT_STATUS = 'pending_tenant' as const;

/** The resolvers' shared predicate. `resolveActiveConnection` and `resolveActiveConnectionRef` MUST stay in lockstep (PR #7182 "Deferred"). */
function activeConnectionWhere(partnerId: string): SQL {
  return and(
    eq(accountingConnections.partnerId, partnerId),
    ne(accountingConnections.status, PENDING_TENANT_STATUS),
  ) as SQL;
}

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
  feeIncomeItemRef?: string | null;
  feeIncomeAccountRef?: string | null;
  defaultTaxCodeRef: string | null;
  defaultExemptTaxCodeRef: string | null;
  defaultPaymentAccountRef: string | null;
  /** Xero connection id (targeted DELETE /connections/{id}); null for QuickBooks and pending_tenant rows. */
  providerConnectionRef: string | null;
  pushMode: AccountingPushMode;
  status: AccountingConnectionStatus;
  createdAt: Date | null;
  updatedAt: Date | null;
  lastError: string | null;
  /** hmacFingerprint(realmId): `fp1:<keyId|legacy>:<hex>`. Null until backfilled. */
  realmIdFingerprint: string | null;
  /** Per-connection QBO -> Breeze payment pull-back switch. DB default true. */
  pullPayments: boolean;
  /** Per-connection Breeze -> QBO payment push switch. DB default true. */
  pushPayments: boolean;
  /** Stamped only after a CDC run in which no item failed. */
  lastReconcileAt: Date | null;
  /** CDC watermark. Column already existed (2026-06-23 migration); now read/written. */
  cdcCursor: Date | null;
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
  feeIncomeItemRef?: string | null;
  feeIncomeAccountRef?: string | null;
  defaultTaxCodeRef?: string | null;
  defaultExemptTaxCodeRef?: string | null;
  defaultPaymentAccountRef?: string | null;
  providerConnectionRef?: string | null;
  pushMode?: AccountingPushMode;
  webhookVerifierToken?: string | null;
  status?: AccountingConnectionStatus;
  lastError?: string | null;
  connectedBy?: string | null;
  pullPayments?: boolean;
  pushPayments?: boolean;
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

/** Mirrors encryptedField but for the queryable HMAC fingerprint column. */
function fingerprintField(value: string | null | undefined): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return hmacFingerprint(value);
}

/** `fp1:<keyId>:<hex>` -> `<keyId>`; null for a malformed/absent fingerprint. */
export function fingerprintKeyGeneration(fingerprint: string | null): string | null {
  if (!fingerprint) return null;
  const match = /^fp1:([^:]+):[0-9a-f]+$/.exec(fingerprint);
  return match?.[1] ?? null;
}

function stripUndefined<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as Partial<T>;
}

export function mapConnection(row: AccountingConnectionRow): AccountingConnection {
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
    feeIncomeItemRef: row.feeIncomeItemRef ?? null,
    feeIncomeAccountRef: row.feeIncomeAccountRef ?? null,
    defaultTaxCodeRef: row.defaultTaxCodeRef ?? null,
    defaultExemptTaxCodeRef: row.defaultExemptTaxCodeRef ?? null,
    defaultPaymentAccountRef: row.defaultPaymentAccountRef ?? null,
    providerConnectionRef: row.providerConnectionRef ?? null,
    pushMode: row.pushMode as AccountingPushMode,
    status: row.status as AccountingConnectionStatus,
    createdAt: row.createdAt ?? null,
    updatedAt: row.updatedAt ?? null,
    lastError: row.lastError ?? null,
    realmIdFingerprint: row.realmIdFingerprint ?? null,
    pullPayments: row.pullPayments,
    pushPayments: row.pushPayments,
    lastReconcileAt: row.lastReconcileAt ?? null,
    cdcCursor: row.cdcCursor ?? null,
  };
}

/**
 * Returns the partner's row for that provider in ANY status, `pending_tenant`
 * included — check `.status` before treating it as active. Use
 * `resolveActiveConnection*` for the active connection.
 */
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

/**
 * The partner's ONE accounting connection, any provider (Xero W01, spec D2 —
 * enforced by accounting_connections_partner_idx). Null when none exists.
 * Replaces every `getConnection(db, partnerId, 'quickbooks')` in the core.
 * Excludes `pending_tenant` (Xero W02) via `activeConnectionWhere`, shared with `resolveActiveConnectionRef`.
 */
export async function resolveActiveConnection(
  dbc: DbExecutor,
  partnerId: string,
): Promise<AccountingConnection | null> {
  const [row] = await dbc
    .select()
    .from(accountingConnections)
    .where(activeConnectionWhere(partnerId))
    .limit(1);
  return row ? mapConnection(row) : null;
}

/**
 * The non-decrypting core of `resolveActiveConnection`'s WHERE/limit, shared by
 * every caller that does not need the decrypted realm/token columns. Selects
 * only `id` + `provider` + `status` — never the encrypted columns `mapConnection`
 * decrypts. Both this and `resolveActiveConnection` build their WHERE from the
 * SAME `activeConnectionWhere` predicate (W02's pending_tenant exclusion), so
 * there is nothing left to keep in sync by hand.
 *
 * Exported as the public id+provider+status read for callers that never need
 * tokens (e.g. a route that only stamps `.id`/`.provider`/`.status` on a
 * response, or a conflict check that only compares providers) — using it instead of
 * `resolveActiveConnection` means a rotated/retired encryption key can never
 * abort a path that was going to ignore the decrypted columns anyway.
 *
 * Excludes `pending_tenant` (Xero W02) via `activeConnectionWhere`, shared with `resolveActiveConnection`.
 */
export async function resolveActiveConnectionRef(
  dbc: DbExecutor,
  partnerId: string,
): Promise<{ id: string; provider: AccountingProviderId; status: AccountingConnectionStatus } | null> {
  const [row] = await dbc
    .select({ id: accountingConnections.id, provider: accountingConnections.provider, status: accountingConnections.status })
    .from(accountingConnections)
    .where(activeConnectionWhere(partnerId))
    .limit(1);
  return row ? { id: row.id, provider: row.provider as AccountingProviderId, status: row.status as AccountingConnectionStatus } : null;
}

/**
 * The partner's row in ANY status (pending_tenant included), non-decrypting.
 * For the one-provider CONFLICT checks only: upsertConnection's no-row branch,
 * the /connect pre-check and GET /accounting/providers. Those must see a
 * pending Xero row, or a QuickBooks connect over it fails as a generic persist
 * error instead of 409 and the UI never greys the other card out.
 */
export async function getPartnerConnectionRef(
  dbc: DbExecutor,
  partnerId: string,
): Promise<{ id: string; provider: AccountingProviderId; status: AccountingConnectionStatus } | null> {
  const [row] = await dbc
    .select({ id: accountingConnections.id, provider: accountingConnections.provider, status: accountingConnections.status })
    .from(accountingConnections)
    .where(eq(accountingConnections.partnerId, partnerId))
    .limit(1);
  return row
    ? { id: row.id, provider: row.provider as AccountingProviderId, status: row.status as AccountingConnectionStatus }
    : null;
}

/**
 * The non-decrypting sibling of `resolveActiveConnection`, for callers that
 * only need the id (money-path hardening: the Stripe refund reconcile runs
 * inside the money transaction, and a rotated/retired encryption key must
 * never abort it via `mapConnection`'s eager decrypt).
 */
export async function resolveActiveConnectionId(
  dbc: DbExecutor,
  partnerId: string,
): Promise<string | null> {
  const ref = await resolveActiveConnectionRef(dbc, partnerId);
  return ref?.id ?? null;
}

/** Load one connection by id, partner-guarded. Jobs carry this id (spec: "a job's destination is never reinterpreted"). */
export async function getConnectionById(
  dbc: DbExecutor,
  connectionId: string,
  partnerId: string,
): Promise<AccountingConnection | null> {
  const [row] = await dbc
    .select()
    .from(accountingConnections)
    .where(and(eq(accountingConnections.id, connectionId), eq(accountingConnections.partnerId, partnerId)))
    .limit(1);
  return row ? mapConnection(row) : null;
}

/**
 * The connection a mapping row belongs to (its integration_id). Payment jobs
 * bind to their connection THROUGH the outbox row (plan preamble item 4): the
 * composite FK cascades on disconnect, so a job whose connection is gone finds
 * no mapping at all rather than a different connection.
 */
export async function getConnectionForMapping(
  dbc: DbExecutor,
  mappingId: string,
  partnerId: string,
): Promise<AccountingConnection | null> {
  const [row] = await dbc
    .select({ connection: accountingConnections })
    .from(accountingEntityMappings)
    .innerJoin(accountingConnections, and(
      eq(accountingConnections.id, accountingEntityMappings.integrationId),
      eq(accountingConnections.partnerId, accountingEntityMappings.partnerId),
    ))
    .where(and(eq(accountingEntityMappings.id, mappingId), eq(accountingEntityMappings.partnerId, partnerId)))
    .limit(1);
  return row ? mapConnection(row.connection) : null;
}

/**
 * Just the PROVIDER of the connection a mapping row belongs to — same
 * partner-guarded join as `getConnectionForMapping`, but it selects only
 * `provider`, so it never decrypts the realm/token columns. For audit labels on
 * paths that must survive an undecryptable token (a payment void, an
 * unresolved-delete drop): before W01 those paths never read the connection row
 * at all, and a decrypt failure must not start aborting them.
 */
export async function getConnectionProviderForMapping(
  dbc: DbExecutor,
  mappingId: string,
  partnerId: string,
): Promise<AccountingProviderId | null> {
  const [row] = await dbc
    .select({ provider: accountingConnections.provider })
    .from(accountingEntityMappings)
    .innerJoin(accountingConnections, and(
      eq(accountingConnections.id, accountingEntityMappings.integrationId),
      eq(accountingConnections.partnerId, accountingEntityMappings.partnerId),
    ))
    .where(and(eq(accountingEntityMappings.id, mappingId), eq(accountingEntityMappings.partnerId, partnerId)))
    .limit(1);
  return row ? (row.provider as AccountingProviderId) : null;
}

/**
 * Batched `getConnectionProviderForMapping` for the reconcile sweep's owed
 * payment rows: mapping id -> its own connection's provider, one query. A
 * mapping absent from the result was deleted since it was listed. Provider
 * column only (no decrypt). System-context callers only: the rows come from a
 * cross-partner sweep, so there is no partner id to guard on beyond the join.
 */
export async function getConnectionProvidersForMappings(
  dbc: DbExecutor,
  mappingIds: string[],
): Promise<Map<string, AccountingProviderId>> {
  if (mappingIds.length === 0) return new Map();
  const rows = await dbc
    .select({ mappingId: accountingEntityMappings.id, provider: accountingConnections.provider })
    .from(accountingEntityMappings)
    .innerJoin(accountingConnections, and(
      eq(accountingConnections.id, accountingEntityMappings.integrationId),
      eq(accountingConnections.partnerId, accountingEntityMappings.partnerId),
    ))
    .where(inArray(accountingEntityMappings.id, mappingIds));
  return new Map((rows as Array<{ mappingId: string; provider: AccountingProviderId }>)
    .map((r) => [r.mappingId, r.provider]));
}

/**
 * Producer-side gate (spec "capabilities … producers don't enqueue"). Reads the
 * partner-axis row through readWithPartnerAxisVisibility: producers run inside
 * whatever request context issued the invoice, and an org-scoped RLS context
 * sees ZERO accounting_connections rows, which would silently skip every
 * enqueue for org-scoped users (#2822). partnerId comes from a row the caller
 * already resolved under its own context, never from the client.
 *
 * Fix round (Task 5 minor): callers use only `.id` (to stamp a job's
 * `connectionId`), never a decrypted field, so this reads through the
 * non-decrypting `resolveActiveConnectionRef` instead of `resolveActiveConnection`
 * + `mapConnection`. Before this, a decrypt failure (rotated/retired
 * encryption key) threw inside these hooks' try/catch and silently skipped the
 * auto-push, whereas pre-W01 the job was always enqueued and a failure
 * surfaced in the worker instead.
 */
export async function resolveActiveConnectionFor(
  partnerId: string,
  capability: AccountingCapability,
): Promise<{ id: string; provider: AccountingProviderId } | null> {
  const ref = await readWithPartnerAxisVisibility(() => resolveActiveConnectionRef(db, partnerId));
  return ref && providerSupports(ref.provider, capability) ? ref : null;
}

/** 409 — the partner already has a connection to a DIFFERENT provider (spec D2). */
export class AccountingProviderConflictError extends Error {
  readonly code = 'accounting_provider_conflict' as const;
  readonly status = 409 as const;
  constructor(
    readonly existingProvider: AccountingProviderId,
    readonly requestedProvider: AccountingProviderId,
    readonly existingStatus?: AccountingConnectionStatus,
  ) {
    const existing = accountingProviderDisplayName(existingProvider);
    const requested = accountingProviderDisplayName(requestedProvider);
    super(existingStatus === PENDING_TENANT_STATUS
      ? `Finish or cancel the ${existing} connection before connecting ${requested}`
      : `Disconnect ${existing} before connecting ${requested}`);
    this.name = 'AccountingProviderConflictError';
  }
}

/**
 * 409 — the realm/tenant is already connected to ANOTHER partner (spec W02).
 * Raised from the `(provider, realm_id_fingerprint)` unique index, which Postgres
 * enforces regardless of RLS, so two partners racing for one tenant cannot both win.
 */
export class AccountingTenantHeldError extends Error {
  readonly code = 'accounting_tenant_held' as const;
  readonly status = 409 as const;
  constructor(readonly provider: AccountingProviderId) {
    super(`This ${accountingProviderDisplayName(provider)} organisation is connected to another Breeze account`);
    this.name = 'AccountingTenantHeldError';
  }
}

export const REALM_FINGERPRINT_UNIQUE_INDEX = 'accounting_connections_provider_realm_fp_idx';

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
    feeIncomeItemRef: fields.feeIncomeItemRef,
    feeIncomeAccountRef: fields.feeIncomeAccountRef,
    defaultTaxCodeRef: fields.defaultTaxCodeRef,
    defaultExemptTaxCodeRef: fields.defaultExemptTaxCodeRef,
    defaultPaymentAccountRef: fields.defaultPaymentAccountRef,
    providerConnectionRef: fields.providerConnectionRef,
    pushMode: fields.pushMode ?? 'auto',
    webhookVerifierTokenEncrypted: encryptedField(fields.webhookVerifierToken),
    realmIdFingerprint: fingerprintField(fields.realmId),
    // Insert default true: an existing connected realm should start
    // reconciling once the sweep ships, rather than silently opting out.
    pullPayments: fields.pullPayments ?? true,
    // Same rationale as pullPayments above (Phase D2).
    pushPayments: fields.pushPayments ?? true,
    // INSERT ONLY, deliberately absent from `updateSet` below. It is the horizon
    // this connection pushes payments FROM, so a token-only reconnect (the OAuth
    // callback) must not move it — that would re-open the whole history the
    // horizon exists to exclude. The settings route re-stamps it when the
    // operator turns `push_payments` back on.
    //
    // Stamped from the DATABASE clock, never Node's (#7293): the horizon is
    // compared against `invoice_payments.created_at`, which Postgres stamps with
    // `now()`. With `new Date()` here, an API host clock running even a few ms
    // ahead of Postgres put a payment recorded right after connecting "before"
    // the horizon, so it was silently never pushed. One clock on both sides
    // matches the other two writers (the column's backfill migration and the
    // settings route's re-enable), which already use `now()`.
    pushPaymentsSince: sql`now()`,
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
    feeIncomeItemRef: fields.feeIncomeItemRef,
    feeIncomeAccountRef: fields.feeIncomeAccountRef,
    defaultTaxCodeRef: fields.defaultTaxCodeRef,
    defaultExemptTaxCodeRef: fields.defaultExemptTaxCodeRef,
    defaultPaymentAccountRef: fields.defaultPaymentAccountRef,
    providerConnectionRef: fields.providerConnectionRef,
    pushMode: fields.pushMode,
    webhookVerifierTokenEncrypted: values.webhookVerifierTokenEncrypted,
    realmIdFingerprint: values.realmIdFingerprint,
    // Same "do not reset settings on a token-only reconnect" rule as pushMode
    // above: only present when the caller explicitly supplies it.
    pullPayments: fields.pullPayments,
    pushPayments: fields.pushPayments,
    status: fields.status,
    lastError: fields.lastError,
    connectedBy: fields.connectedBy,
    updatedAt: now,
  });

  let row: AccountingConnectionRow | undefined;
  try {
    [row] = await db
      .insert(accountingConnections)
      .values(values)
      .onConflictDoUpdate({
        // accounting_connections_partner_idx (Xero W01): one row per partner. The
        // update fires ONLY for a same-provider reconnect; a different provider's
        // row makes this a no-op that returns nothing (handled below), so a Xero
        // connect can never overwrite a QuickBooks row's tokens or settings.
        target: accountingConnections.partnerId,
        set: updateSet,
        setWhere: sql`${accountingConnections.provider} = excluded.provider`,
      })
      .returning();
  } catch (err) {
    if (isPgUniqueViolation(err, REALM_FINGERPRINT_UNIQUE_INDEX)) throw new AccountingTenantHeldError(provider);
    throw err;
  }

  if (!row) {
    // Any status: a pending_tenant row of another provider must 409 too (W02).
    // Non-decrypting read (Task 5 minor): this branch only compares providers,
    // so a decrypt failure (rotated/retired encryption key) in
    // `resolveActiveConnection` must never mask the real 409 conflict here.
    const existing = await getPartnerConnectionRef(db, partnerId);
    if (existing && existing.provider !== provider) {
      throw new AccountingProviderConflictError(existing.provider, provider, existing.status);
    }
    throw new Error('Failed to persist accounting connection');
  }

  return mapConnection(row);
}

/**
 * Webhook realm routing (Phase D). The Intuit CDC webhook carries only a
 * realmId, so this is how an inbound event finds the owning connection
 * without a linear decrypt-and-compare scan. Exactly one row can match by
 * construction: `accounting_connections_provider_realm_fp_idx` is a unique
 * partial index on (provider, realm_id_fingerprint).
 */
export async function findConnectionByRealmFingerprint(
  dbc: DbExecutor,
  provider: AccountingProviderId,
  realmIdFingerprint: string,
): Promise<AccountingConnection | null> {
  const [row] = await dbc
    .select()
    .from(accountingConnections)
    .where(and(
      eq(accountingConnections.provider, provider),
      eq(accountingConnections.realmIdFingerprint, realmIdFingerprint),
    ))
    .limit(1);

  return row ? mapConnection(row) : null;
}

/**
 * Idempotent boot step. Re-fingerprints every row whose fingerprint is NULL
 * (pre-Phase-D rows, or a fresh realm captured before this boot step ran) or
 * was computed under a different encryption-key generation (self-heals a key
 * rotation — the HMAC key follows APP_ENCRYPTION_KEY(_ID), so a rotation
 * invalidates every previously stamped fingerprint).
 *
 * Opens its own system context; must be called with none open (mirrors the
 * "no DB context across external work" contract other Phase D entry points
 * follow, even though this one never leaves the process).
 */
export async function backfillRealmFingerprints(): Promise<{ scanned: number; updated: number; skipped: number }> {
  assertNoAmbientDbContext('backfillRealmFingerprints');

  // The LIST is one short context; each WRITE gets its own (finding E).
  // Postgres leaves a transaction ABORTED after a constraint violation, so the
  // caught unique violation below used to poison every later row in the sweep
  // with 25P02 and roll back every earlier one — a single shared realm could
  // leave the entire fleet unfingerprinted, and therefore invisible to webhooks.
  const rows = await withSystemDbAccessContext(() => db
    .select({
      id: accountingConnections.id,
      partnerId: accountingConnections.partnerId,
      realmIdEncrypted: accountingConnections.realmIdEncrypted,
      realmIdFingerprint: accountingConnections.realmIdFingerprint,
    })
    .from(accountingConnections)
    .where(isNotNull(accountingConnections.realmIdEncrypted)),
  'backfillRealmFingerprints.list');

  const activeGen = getActiveSecretEncryptionKeyId() ?? 'legacy';
  let updated = 0;
  let skipped = 0;

  for (const row of rows) {
    if (row.realmIdFingerprint !== null && fingerprintKeyGeneration(row.realmIdFingerprint) === activeGen) {
      continue;
    }

    const realmId = decryptSecret(row.realmIdEncrypted);
    // Guarded by the isNotNull(realmIdEncrypted) filter above; decryptSecret
    // only returns null for a falsy/empty input, which that filter excludes.
    if (realmId === null) continue;
    const fingerprint = hmacFingerprint(realmId);

    try {
      // Zero-row-throw discipline (see other writes in this file) doesn't
      // fit a multi-row backfill loop verbatim — aborting the whole sweep
      // over one row deleted concurrently would strand every later row
      // unprocessed. Guard against MISCOUNTING instead: only bump `updated`
      // when a row actually matched.
      const written = await withSystemDbAccessContext(() => db
        .update(accountingConnections)
        .set({ realmIdFingerprint: fingerprint })
        .where(and(
          eq(accountingConnections.id, row.id),
          eq(accountingConnections.partnerId, row.partnerId),
        ))
        .returning({ id: accountingConnections.id }),
      'backfillRealmFingerprints.write');
      if (written.length > 0) updated++;
    } catch (err) {
      // Two partners' realms hashing to the same fingerprint is a real data
      // conflict an operator must see (a stolen/shared realm, or a bug in a
      // migration), not a crash that blocks boot for every other partner.
      // Its transaction is now its own, so the abort dies with it.
      if (isPgUniqueViolation(err, REALM_FINGERPRINT_UNIQUE_INDEX)) {
        skipped++;
        captureException(err instanceof Error ? err : new Error(String(err)), undefined, {
          // #5193: `module` and `op` have no allowlisted equivalent (no
          // existing tag distinguishes a backfill step within a service), so
          // dropped rather than inventing new allowlist entries — `service`
          // already identifies the file, and `accounting_connection_id`
          // (this backfill's own connection id) is what actually triages a
          // fingerprint collision.
          service: 'accountingConnectionService',
          accounting_connection_id: row.id,
        });
        continue;
      }
      throw err;
    }
  }

  return { scanned: rows.length, updated, skipped };
}

/**
 * Connections the 15-minute sweep should reconcile: 'connected' AND at least one
 * direction switched on. Phase D2 (spec decision 6): with pull OFF and push ON
 * the CDC pass still has to run — it is what adopts a Breeze-created Payment
 * whose phase 2 never landed, and what notices a Breeze-origin Payment someone
 * deleted in QuickBooks. In that window it touches Breeze-origin rows ONLY:
 * every QuickBooks-origin line is suppressed (a new import, an edit of one
 * already imported, a deletion) and the run holds its CDC cursor, so turning
 * pull back on can still import the window it was switched off in.
 */
export async function listReconcilableConnections(
  dbc: DbExecutor,
): Promise<Array<{ id: string; partnerId: string; provider: AccountingProviderId }>> {
  const rows = await dbc
    .select({ id: accountingConnections.id, partnerId: accountingConnections.partnerId, provider: accountingConnections.provider })
    .from(accountingConnections)
    .where(and(
      eq(accountingConnections.status, 'connected'),
      or(eq(accountingConnections.pullPayments, true), eq(accountingConnections.pushPayments, true)),
    ));
  return rows as Array<{ id: string; partnerId: string; provider: AccountingProviderId }>;
}

/**
 * Advance the CDC watermark and stamp last_reconcile_at, COMPARE-AND-SET on the
 * realm fingerprint the run started against (finding C).
 *
 * A reconnect to a DIFFERENT QuickBooks realm can land while a reconcile job is
 * mid-flight. Without the CAS, that job's final write would stamp a cursor
 * derived from the OLD realm's CDC window onto the NEW realm's connection row,
 * and the new realm's first 30 days would then be skipped as "already read".
 *
 * Returns whether the write landed. Zero rows is NOT a throw here: the realm
 * legitimately moved on, the caller logs and skips, and the next sweep
 * reconciles the new realm from the null cursor `resetConnectionForRealmChange`
 * left behind. A wrong DB context surfaces the same way, one sweep later,
 * rather than as a job that retries forever against a connection that no longer
 * matches.
 */
/**
 * Record that a reconcile run HAPPENED without moving the CDC watermark.
 *
 * `advanceReconcileCursor` is the only other writer of `last_reconcile_at`, and
 * the pull-off freeze branch deliberately does not call it — so the integration
 * card's "Last reconciled" froze at the moment `pull_payments` was switched off
 * and a perfectly healthy connection read as permanently stalled (review wave 3,
 * finding D4).
 *
 * No realm-fingerprint CAS, unlike the cursor write: this claims nothing and
 * carries no watermark, so a realm that changed mid-run cannot be given a stale
 * one. Zero rows is tolerated (the connection may have been deleted) — this is
 * a freshness stamp, never a correctness signal.
 */
export async function stampReconcileRunAt(
  dbc: DbExecutor,
  connectionId: string,
  partnerId: string,
  reconciledAt: Date,
): Promise<void> {
  await dbc
    .update(accountingConnections)
    .set({ lastReconcileAt: reconciledAt, updatedAt: new Date() })
    .where(and(
      eq(accountingConnections.id, connectionId),
      eq(accountingConnections.partnerId, partnerId),
    ))
    .returning({ id: accountingConnections.id });
}

export async function advanceReconcileCursor(
  dbc: DbExecutor,
  connectionId: string,
  partnerId: string,
  expectedRealmFingerprint: string | null,
  cursor: Date,
  reconciledAt: Date,
): Promise<boolean> {
  const updated = await dbc
    .update(accountingConnections)
    .set({
      cdcCursor: cursor,
      lastReconcileAt: reconciledAt,
      updatedAt: new Date(),
    })
    .where(and(
      eq(accountingConnections.id, connectionId),
      eq(accountingConnections.partnerId, partnerId),
      // `eq(col, null)` compiles to `= NULL`, which is never true. A connection
      // whose fingerprint has not been backfilled yet must still be able to
      // advance its cursor.
      expectedRealmFingerprint === null
        ? isNull(accountingConnections.realmIdFingerprint)
        : eq(accountingConnections.realmIdFingerprint, expectedRealmFingerprint),
    ))
    .returning({ id: accountingConnections.id });

  return updated.length > 0;
}

/**
 * Prefix on the `accounting_connections.last_error` messages the RECONCILE
 * WORKER writes (final-review finding H). That column is shared with connection
 * lifecycle errors — a failed refresh writes "reauthorization required" there —
 * so a reconcile run must be able to clear its OWN message without wiping one
 * an operator still has to act on. Same convention (and same literal prefix) as
 * `accountingPaymentPull.PAYMENT_PULL_ERROR_PREFIX` uses on mapping rows;
 * duplicated rather than imported to keep this module free of a dependency on
 * the applier. Contains no LIKE metacharacters.
 */
export const RECONCILE_RUN_ERROR_PREFIX = 'Payment pull: ';

/**
 * Surface a reconcile run's outcome on the connection itself (finding H).
 *
 * Before this, a run that ended with failed items or an un-drained CDC window
 * left NOTHING an operator could see: the job retried and eventually gave up in
 * BullMQ, `last_reconcile_at` simply stopped advancing, and the integration
 * panel still read "connected". Pass a sanitized one-liner (counts only — never
 * a QuickBooks response body) to stamp, or `null` after a clean run to clear.
 *
 * The clear is prefix-scoped so it can never erase a `reauth_required` message.
 */
export async function stampReconcileRunError(
  dbc: DbExecutor,
  connectionId: string,
  partnerId: string,
  message: string | null,
): Promise<void> {
  const scope = [
    eq(accountingConnections.id, connectionId),
    eq(accountingConnections.partnerId, partnerId),
  ];
  await dbc
    .update(accountingConnections)
    .set({
      lastError: message === null ? null : `${RECONCILE_RUN_ERROR_PREFIX}${message}`,
      updatedAt: new Date(),
    })
    .where(and(
      ...scope,
      ...(message === null
        ? [like(accountingConnections.lastError, `${RECONCILE_RUN_ERROR_PREFIX}%`)]
        : []),
    ))
    .returning({ id: accountingConnections.id });
}

/**
 * QuickBooks payment deletions this connection still OWES, about to be lost.
 *
 * `accounting_entity_mappings_connection_partner_fk` is ON DELETE CASCADE and
 * `resetConnectionForRealmChange` deletes the mappings outright, so both paths
 * take every `pending_op = 'delete'` row with them. Each of those means Breeze
 * created a Payment in the partner's QuickBooks and has not removed it — the
 * same debt `tenantCascade` and `orgMerge` now preserve. Here it CANNOT be
 * preserved: the mapping is meaningless without its connection (a realm change
 * makes the remote ids point at a different company file entirely), and a
 * disconnect the operator asked for must never be blocked.
 *
 * So the debt is reported instead of retained — warning, Sentry, and an audit
 * entry written by the route — naming the remote ids, which is the only thing
 * that lets a human find those Payments in QuickBooks afterwards.
 */
export interface OwedPaymentDeletes {
  count: number;
  /** `<PaymentId>/<InvoiceId>` composites, capped so one pathological
   *  connection cannot write an unbounded audit detail or Sentry message. */
  remoteEntityIds: string[];
}

const OWED_DELETE_REPORT_CAP = 50;

/** The payment deletes one connection still owes (the predicate of every owed-delete read that is scoped to a connection). */
export function owedPaymentDeletesOfConnection(connectionId: string, partnerId: string): SQL | undefined {
  return and(
    eq(accountingEntityMappings.integrationId, connectionId),
    eq(accountingEntityMappings.partnerId, partnerId),
    eq(accountingEntityMappings.breezeEntityType, 'payment'),
    eq(accountingEntityMappings.pendingOp, 'delete'),
  );
}

/** Read-only half of `collectOwedPaymentDeletes`: counts, never reports. For a caller that may KEEP the debt instead of discarding it (the pending-tenant reaper, #7289). */
export async function readOwedPaymentDeletes(dbc: DbExecutor, where: SQL | undefined): Promise<OwedPaymentDeletes> {
  const rows = await dbc
    .select({
      id: accountingEntityMappings.id,
      remoteEntityId: accountingEntityMappings.remoteEntityId,
    })
    .from(accountingEntityMappings)
    .where(where) as Array<{ id: string; remoteEntityId: string | null }>;

  const remoteEntityIds = rows
    .map((r) => r.remoteEntityId)
    .filter((v): v is string => typeof v === 'string')
    .slice(0, OWED_DELETE_REPORT_CAP);
  return { count: rows.length, remoteEntityIds };
}

/**
 * Count-and-report, BEFORE the caller's delete: the warning and Sentry capture
 * every owed-delete discard gets. The audit entry is the caller's route's job
 * (`accounting.connection.owed_deletes_discarded`). Silent when nothing is owed.
 */
export async function collectOwedPaymentDeletes(
  dbc: DbExecutor,
  where: SQL | undefined,
  context: { provider?: AccountingProviderId } & Record<string, unknown>,
): Promise<OwedPaymentDeletes> {
  const owed = await readOwedPaymentDeletes(dbc, where);
  if (owed.count === 0) return owed;
  const { remoteEntityIds } = owed;
  // Named for the provider when the caller knows it: the Xero pending-tenant
  // path reaches here too (#7289), and "QuickBooks" would misdirect on-call.
  const label = context.provider ? accountingProviderDisplayName(context.provider) : 'accounting';

  console.warn(
    `[accountingConnectionService] discarding owed ${label} payment delete(s) — `
    + 'Breeze created these Payments and will no longer remove them',
    { ...context, count: owed.count, remoteEntityIds },
  );
  captureException(
    new Error(
      `accountingConnectionService: discarded ${owed.count} owed ${label} payment delete(s) — `
      + 'the Payments Breeze created stay in the customer books and need manual reconciliation',
    ),
    undefined,
    { service: 'accountingConnectionService', accounting_connection_id: String(context.connectionId ?? 'unknown') },
  );
  return owed;
}

/**
 * DISCONNECT SEMANTICS for a reconnect that lands on a DIFFERENT realm
 * (finding C).
 *
 * `upsertConnection` keys on `(partner_id, provider)`, so re-authorising
 * against another QuickBooks company REUSES the same connection row — and every
 * `accounting_entity_mappings` row hanging off it still points at the OLD
 * realm's Customer/Item/Invoice/Payment ids. Left in place, the next push would
 * "update" a stranger's invoice and the next CDC pull would apply the new
 * realm's payments against mappings that mean nothing there. The stored cursor
 * is equally poisoned: it is a watermark in the old realm's change stream.
 *
 * So a realm change wipes the mappings and the watermark — the same state a
 * disconnect/reconnect leaves — and the new realm re-imports and re-maps from
 * scratch. Deliberately NOT called when the prior realm could not be read: the
 * cost of guessing wrong is destroying a healthy connection's whole mapping set.
 */
export async function resetConnectionForRealmChange(
  dbc: DbExecutor,
  connectionId: string,
  partnerId: string,
): Promise<{ mappingsDeleted: number; owedPaymentDeletes: OwedPaymentDeletes }> {
  // BEFORE the delete: after it there is nothing left to count.
  const owedPaymentDeletes = await collectOwedPaymentDeletes(
    dbc, owedPaymentDeletesOfConnection(connectionId, partnerId), { connectionId, partnerId, reason: 'realm_changed' },
  );

  const deleted = await dbc
    .delete(accountingEntityMappings)
    .where(and(
      eq(accountingEntityMappings.integrationId, connectionId),
      eq(accountingEntityMappings.partnerId, partnerId),
    ))
    .returning({ id: accountingEntityMappings.id });

  // The ONE place a tenant/realm change clears per-organisation state (Xero W02
  // review J). Every path that changes it reaches here via finalizeConnection:
  // the OAuth callback (QuickBooks, Xero single-org) and the Xero picker claim.
  // The default refs name accounts / tax codes IN the old organisation (Xero
  // AccountCodes like "200" repeat across orgs, so a kept ref would silently
  // resolve to a different account); a same-realm reconnect never gets here.
  await dbc
    .update(accountingConnections)
    .set({
      cdcCursor: null,
      lastReconcileAt: null,
      defaultIncomeAccountRef: null,
      feeIncomeItemRef: null,
      feeIncomeAccountRef: null,
      defaultTaxCodeRef: null,
      defaultExemptTaxCodeRef: null,
      defaultPaymentAccountRef: null,
      updatedAt: new Date(),
    })
    .where(and(
      eq(accountingConnections.id, connectionId),
      eq(accountingConnections.partnerId, partnerId),
    ))
    .returning({ id: accountingConnections.id });

  return { mappingsDeleted: deleted.length, owedPaymentDeletes };
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
  const label = accountingProviderDisplayName(provider);

  const conn = await runInDbContext(async () => {
    const conn = await getConnection(db, partnerId, provider);
    if (!conn) {
      throw new AccountingConnectionError('not_connected', 404, `${label} is not connected for this partner`);
    }
    if (conn.status === 'reauth_required') {
      throw new AccountingConnectionError('reauth_required', 409, `${label} needs to be reconnected`);
    }
    if (conn.status !== 'connected') {
      throw new AccountingConnectionError('not_connected', 404, `${label} is not connected for this partner`);
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
      throw new AccountingConnectionError('reauth_required', 409, `${label} needs to be reconnected`);
    }
    throw err;
  }

  // See the doc comment above: re-read to capture the generation the row will
  // actually be at when we write, not the pre-token-refresh snapshot.
  const freshConn = await runInDbContext(async () => {
    const freshConn = await getConnection(db, partnerId, provider);
    if (!freshConn) {
      throw new AccountingConnectionError('not_connected', 404, `${label} is not connected for this partner`);
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

/**
 * Drop the connection. `removed` is false when no row matched.
 *
 * `connectionId` is the id of the row it removed (null when none matched).
 *
 * Also reports the QuickBooks payment deletions the cascade is about to discard
 * — see `OwedPaymentDeletes`. Counted BEFORE the delete (afterwards there is
 * nothing left to count) and never blocking: a disconnect the operator asked
 * for must always succeed.
 */
export async function deleteConnection(
  db: DbExecutor,
  partnerId: string,
  provider: AccountingProviderId
): Promise<{ removed: boolean; connectionId: string | null; owedPaymentDeletes: OwedPaymentDeletes }> {
  const owedPaymentDeletes = await collectOwedPaymentDeletes(db, and(
    eq(accountingEntityMappings.partnerId, partnerId),
    eq(accountingEntityMappings.breezeEntityType, 'payment'),
    eq(accountingEntityMappings.pendingOp, 'delete'),
  ), { partnerId, provider, reason: 'disconnect' });

  const deleted = await db
    .delete(accountingConnections)
    .where(and(
      eq(accountingConnections.partnerId, partnerId),
      eq(accountingConnections.provider, provider)
    ))
    .returning({ id: accountingConnections.id });
  for(const connection of deleted)await abandonAccountingFees(db,partnerId,connection.id);
  // The id is returned so the caller can identify the connection in an audit
  // entry AFTER the row is gone — the disconnect's owed-delete record has to
  // name the same subject as its realm-change twin (review wave 3, finding D3).
  return {
    removed: deleted.length > 0,
    connectionId: (deleted as Array<{ id: string }>)[0]?.id ?? null,
    owedPaymentDeletes,
  };
}
