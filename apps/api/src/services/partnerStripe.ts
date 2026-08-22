import Stripe from 'stripe';
import { and, eq, isNotNull, isNull, lt, or } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { stripeConnectAccounts } from '../db/schema/stripePayments';
import { encryptSecret, decryptSecret } from './secretCrypto';
import { isPgUniqueViolation } from '../utils/pgErrors';

// Pinned API version — do not rely on the SDK default (it moves on upgrade).
const API_VERSION = '2026-06-24.dahlia';

export type PartnerStripeErrorCode =
  | 'NO_STRIPE_KEY'        // partner never configured a key / disconnected
  | 'INVALID_STRIPE_KEY'   // key rejected by Stripe (at save time, or later revoked) — PERMANENT until the key is replaced
  | 'STRIPE_KEY_UNREADABLE' // stored ciphertext can't be decrypted (corrupt / KEK rotated away) — PERMANENT
  | 'STRIPE_CONNECTION_CHANGED' // the stored connection was replaced/disconnected mid-operation —
                                 // a purely LOCAL race, nothing to do with Stripe's availability
  | 'STRIPE_ACCOUNT_UNKNOWN' // Stripe answered, but not with the account: restricted key without
                             // accounts.retrieve, an untyped/unknown error. The KEY MAY BE FINE
                             // (checkout can still work) — never tell the partner to reconnect.
  | 'STRIPE_UNAVAILABLE';  // Stripe unreachable / 5xx / rate-limited — TRANSIENT, retry later

// Status is a function of the code, not an independent field — keeps the pair on
// its valid diagonal (no `('NO_STRIPE_KEY', 400)` foot-guns).
const STATUS_FOR_CODE: Record<PartnerStripeErrorCode, 400 | 409 | 500 | 503> = {
  NO_STRIPE_KEY: 409,
  INVALID_STRIPE_KEY: 400,
  STRIPE_KEY_UNREADABLE: 500,
  STRIPE_CONNECTION_CHANGED: 409,
  STRIPE_ACCOUNT_UNKNOWN: 503,
  STRIPE_UNAVAILABLE: 503,
};

/**
 * Stripe's SDK tags every error with a `type`. Only these three mean "Stripe
 * itself could not answer right now"; everything else (auth 401, permission 403,
 * invalid request, unknown) is a property of the stored key and will not fix
 * itself — a cache must never paper over those as "try again later".
 */
export function isTransientStripeError(err: unknown): boolean {
  const type = (err as { type?: string } | null)?.type;
  return type === 'StripeConnectionError' || type === 'StripeAPIError' || type === 'StripeRateLimitError';
}

/**
 * The ONLY Stripe failure that proves the stored key itself is dead: Stripe
 * refused to authenticate it (never provisioned, rotated, revoked). A
 * permission error (a restricted key that simply can't call accounts.retrieve)
 * and an untyped/unknown error say nothing about whether the key can still
 * create a checkout session, so they must NEVER drive "reconnect required" —
 * telling a partner with working checkout that payments are broken is worse
 * than an unknown currency cache.
 */
export function isStripeKeyAuthFailure(err: unknown): boolean {
  return (err as { type?: string } | null)?.type === 'StripeAuthenticationError';
}

export class PartnerStripeError extends Error {
  readonly status: 400 | 409 | 500 | 503;
  constructor(message: string, readonly code: PartnerStripeErrorCode) {
    super(message);
    this.name = 'PartnerStripeError';
    this.status = STATUS_FOR_CODE[code];
  }
}

// Discriminated so `connected: true` guarantees a non-null stripeAccountId — callers
// don't need to defensively re-check it. The disconnected arm carries only display
// leftovers (last4), never a stale account id.
export type PartnerStripeStatus =
  | { connected: false; last4: string | null }
  | {
      connected: true;
      stripeAccountId: string;
      last4: string | null;
      livemode: boolean;
      defaultCurrency: string | null;
      accountCountry: string | null;
      accountRefreshedAt: Date | null;
    };

export const STRIPE_ACCOUNT_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Age at which the daily bootstrap sweep re-checks an account it already
 * stamped. Deliberately SHORTER than both the cache TTL and the sweep's own
 * 24h cron: a row stamped by yesterday's run is a few seconds younger than
 * `now - 24h`, so an equal window skipped it and the "daily" re-check ran every
 * other day (review F5). One hour of slack absorbs cron drift and slow sweeps.
 */
export const STRIPE_ACCOUNT_BOOTSTRAP_RECHECK_MS = 23 * 60 * 60 * 1000;

/**
 * Per-partner Stripe API-key model (replaces Connect OAuth). The partner pastes
 * their OWN Stripe secret/restricted key; we validate it by retrieving the account
 * it belongs to, then store it ENCRYPTED (secretCrypto) — charges later run directly
 * on the partner's account with this key (no platform, no Connect, no Stripe-Account
 * header). One row per partner (partner-axis RLS; unique on partner_id).
 */
export async function savePartnerStripeKey(input: {
  partnerId: string;
  apiKey: string;
  userId: string | null;
}): Promise<{
  stripeAccountId: string;
  last4: string;
  livemode: boolean;
  defaultCurrency: string | null;
  accountCountry: string | null;
  accountRefreshedAt: Date;
}> {
  const apiKey = input.apiKey.trim();

  // Validate by retrieving the account the key belongs to. Any rejection (bad key,
  // revoked, insufficient scope) → INVALID_STRIPE_KEY rather than a 500.
  let account: Stripe.Account;
  try {
    const probe = new Stripe(apiKey, { apiVersion: API_VERSION });
    // No-arg accounts.retrieve() hits GET /v1/account — the account the KEY belongs
    // to (the partner's own account). The SDK's typed overload requires an id (for
    // Connect), so cast to the documented no-arg form.
    account = await runOutsideDbContext(() =>
      (probe.accounts.retrieve as unknown as () => Promise<Stripe.Account>)()
    );
  } catch (err) {
    // Always log the real reason — a money-onboarding path must not swallow it. A
    // transient Stripe outage / rate-limit isn't the partner's fault, so say so
    // rather than telling them to rotate a valid key — and carry the TRANSIENT
    // code (503) with that message, not INVALID_STRIPE_KEY/400 (review F6).
    // Shared predicate, never a second inline copy that can drift from it.
    const type = (err as { type?: string })?.type;
    const transient = isTransientStripeError(err);
    console.error('[partnerStripe] key validation failed', { partnerId: input.partnerId, type: type ?? 'unknown', transient, message: err instanceof Error ? err.message : String(err) });
    throw transient
      ? new PartnerStripeError(
          'Could not reach Stripe to verify the key right now — please try again in a moment.',
          'STRIPE_UNAVAILABLE',
        )
      : new PartnerStripeError(
          'That Stripe key was rejected — double-check it (and that it can read your account) and try again.',
          'INVALID_STRIPE_KEY',
        );
  }

  const accountId = account.id;
  const defaultCurrency = account.default_currency ? account.default_currency.toUpperCase() : null;
  const accountCountry = account.country ?? null;
  const last4 = apiKey.slice(-4);
  const livemode = apiKey.startsWith('sk_live') || apiKey.startsWith('rk_live');
  const encrypted = encryptSecret(apiKey);
  const now = new Date();

  // stripe_connect_accounts_acct_uq is a GLOBAL unique index on
  // stripe_account_id (one Breeze partner per Stripe account, cross-partner),
  // while the table's RLS policy is partner-axis — from THIS partner's request
  // context another partner's claim on the account is invisible. Two
  // consequences (issue #2189):
  //   1. an in-context pre-check SELECT would silently return zero rows and
  //      the upsert would still trip the constraint, and
  //   2. letting the constraint raise inside a request transaction doesn't
  //      work either: postgres.js re-throws the raw 23505 at commit even after
  //      the catch maps it, so the route's 400 was clobbered into a 500. The
  //      route is now self-managed (#3777: no request transaction) and the
  //      upsert below runs in its own short system-context transaction, so the
  //      mapping survives — the pre-check stays as the deterministic guard.
  // So pre-check under a system context on its own short-lived transaction.
  // runOutsideDbContext is required: a nested withSystemDbAccessContext alone
  // short-circuits into the SAME partner-scoped request transaction. Only the
  // claiming partner_id is read — nothing crosses the tenant boundary back to
  // the caller.
  const claimedByOtherPartner = await runOutsideDbContext(() =>
    withSystemDbAccessContext(async () => {
      const rows = await db
        .select({ partnerId: stripeConnectAccounts.partnerId })
        .from(stripeConnectAccounts)
        .where(eq(stripeConnectAccounts.stripeAccountId, accountId))
        .limit(1);
      return rows[0] !== undefined && rows[0].partnerId !== input.partnerId;
    })
  );
  if (claimedByOtherPartner) {
    throw new PartnerStripeError(
      'That Stripe account is already connected to another partner. Use a key for a different Stripe account.',
      'INVALID_STRIPE_KEY',
    );
  }

  await runOutsideDbContext(async () => {
    try {
      await withSystemDbAccessContext(() =>
        db
          .insert(stripeConnectAccounts)
          .values({
            partnerId: input.partnerId,
            stripeAccountId: accountId,
            apiKey: encrypted,
            keyLast4: last4,
            livemode,
            defaultCurrency,
            accountCountry,
            accountRefreshedAt: now,
            status: 'connected',
            connectedBy: input.userId,
            connectedAt: now,
            disconnectedAt: null,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: stripeConnectAccounts.partnerId,
            set: {
              stripeAccountId: accountId,
              apiKey: encrypted,
              keyLast4: last4,
              livemode,
              defaultCurrency,
              accountCountry,
              accountRefreshedAt: now,
              status: 'connected',
              connectedBy: input.userId,
              connectedAt: now,
              disconnectedAt: null,
              updatedAt: now,
            },
          })
      );
    } catch (err) {
      // Concurrent-writer backstop only: the system-context pre-check above
      // catches the deterministic case, so acct_uq (23505) can now fire solely
      // when another partner claims the same Stripe account BETWEEN the
      // pre-check and this upsert. Because this write has its own short system-
      // context transaction, the mapped error reaches the caller. Drizzle wraps
      // the postgres.js error, so the pg code/constraint live on `.cause` —
      // isPgUniqueViolation walks the chain.
      if (isPgUniqueViolation(err, 'stripe_connect_accounts_acct_uq')) {
        throw new PartnerStripeError(
          'That Stripe account is already connected to another partner. Use a key for a different Stripe account.',
          'INVALID_STRIPE_KEY',
        );
      }
      throw err;
    }
  });

  return {
    stripeAccountId: accountId,
    last4,
    livemode,
    defaultCurrency,
    accountCountry,
    accountRefreshedAt: now,
  };
}

/**
 * Build a Stripe client bound to the partner's own key AND return their account id
 * in a single row read (callers that need both — e.g. createInvoicePayLink for the
 * payment mapping — avoid a second query). Throws NO_STRIPE_KEY if unconfigured,
 * STRIPE_KEY_UNREADABLE if the stored ciphertext can't be decrypted.
 */
export async function getPartnerStripeClient(partnerId: string): Promise<{
  stripe: Stripe;
  stripeAccountId: string;
  defaultCurrency: string | null;
}> {
  const [row] = await db
    .select({
      apiKey: stripeConnectAccounts.apiKey,
      status: stripeConnectAccounts.status,
      stripeAccountId: stripeConnectAccounts.stripeAccountId,
      defaultCurrency: stripeConnectAccounts.defaultCurrency,
    })
    .from(stripeConnectAccounts)
    .where(eq(stripeConnectAccounts.partnerId, partnerId))
    .limit(1);
  if (!row || row.status !== 'connected' || !row.apiKey) {
    throw new PartnerStripeError('Online payment is not available — connect Stripe first.', 'NO_STRIPE_KEY');
  }
  // A connected row whose ciphertext can't be decrypted is a CORRUPT-KEY fault (DB
  // corruption, or KEK rotated away), NOT "not connected". decryptSecret throws on
  // a bad payload/auth-tag and returns null only on empty input — handle both, and
  // log: a wave of these means an APP_ENCRYPTION_KEY misconfig, a platform incident.
  let key: string | null;
  try {
    key = decryptSecret(row.apiKey);
  } catch (err) {
    console.error('[partnerStripe] failed to decrypt stored key for connected partner', { partnerId, message: err instanceof Error ? err.message : String(err) });
    throw new PartnerStripeError('Stored Stripe key could not be read — please reconnect Stripe.', 'STRIPE_KEY_UNREADABLE');
  }
  if (!key) {
    console.error('[partnerStripe] decrypt returned empty for connected partner', { partnerId });
    throw new PartnerStripeError('Stored Stripe key could not be read — please reconnect Stripe.', 'STRIPE_KEY_UNREADABLE');
  }
  return {
    stripe: new Stripe(key, { apiVersion: API_VERSION }),
    stripeAccountId: row.stripeAccountId,
    defaultCurrency: row.defaultCurrency,
  };
}

export interface StripeAccountRefreshResult {
  stripeAccountId: string;
  last4: string | null;
  livemode: boolean;
  defaultCurrency: string | null;
  accountCountry: string | null;
  accountRefreshedAt: Date;
}

/**
 * Refresh cached Stripe account metadata without holding a DB context open during
 * HTTP. Returns what was actually PERSISTED (RETURNING), never what was merely
 * retrieved: the cache write is guarded on (partner, account id, status =
 * connected), so a key replacement or disconnect that lands while the Stripe
 * round-trip is in flight updates zero rows. Zero rows → one retry against the
 * row as it is now (a replaced key refreshes the NEW account; a disconnect
 * surfaces NO_STRIPE_KEY). Review F9.
 */
export async function refreshPartnerStripeAccount(partnerId: string, attempt = 0): Promise<StripeAccountRefreshResult> {
  const { stripe, stripeAccountId } = await withSystemDbAccessContext(() => getPartnerStripeClient(partnerId));

  let account: Stripe.Account;
  try {
    account = await runOutsideDbContext(() =>
      (stripe.accounts.retrieve as unknown as () => Promise<Stripe.Account>)()
    );
  } catch (err) {
    const type = (err as { type?: string })?.type;
    // Three outcomes, never two (review F2):
    //  - transient → 503, callers may serve the cached value flagged stale;
    //  - Stripe refused to AUTHENTICATE the key → it is dead, reconnect;
    //  - anything else (restricted key without accounts.retrieve, unknown /
    //    untyped error) → the account facts are simply unknown. Checkout may
    //    well still work, so this must not be reported as a broken connection.
    const classification = isTransientStripeError(err) ? 'transient'
      : isStripeKeyAuthFailure(err) ? 'key-auth-failure'
      : 'unknown';
    console.error('[partnerStripe] account refresh failed', { partnerId, type: type ?? 'unknown', classification, message: err instanceof Error ? err.message : String(err) });
    if (classification === 'transient') {
      throw new PartnerStripeError('Could not reach Stripe right now — try again in a moment.', 'STRIPE_UNAVAILABLE');
    }
    if (classification === 'key-auth-failure') {
      throw new PartnerStripeError('Stripe rejected the stored key — reconnect Stripe.', 'INVALID_STRIPE_KEY');
    }
    throw new PartnerStripeError(
      'Could not read your Stripe account details — your key may not allow it. Payments are unaffected.',
      'STRIPE_ACCOUNT_UNKNOWN',
    );
  }

  const defaultCurrency = account.default_currency ? account.default_currency.toUpperCase() : null;
  const accountCountry = account.country ?? null;
  const now = new Date();

  const [updated] = await withSystemDbAccessContext(() =>
    db
      .update(stripeConnectAccounts)
      .set({ defaultCurrency, accountCountry, accountRefreshedAt: now, updatedAt: now })
      // Guarded by the account id AND connected status read BEFORE the Stripe
      // round-trip: if an admin replaced the key (new account) or disconnected
      // while this refresh was in flight, the stale account's currency/country
      // must not land on the new/disconnected row.
      .where(and(
        eq(stripeConnectAccounts.partnerId, partnerId),
        eq(stripeConnectAccounts.stripeAccountId, stripeAccountId),
        eq(stripeConnectAccounts.status, 'connected'),
      ))
      .returning({
        stripeAccountId: stripeConnectAccounts.stripeAccountId,
        keyLast4: stripeConnectAccounts.keyLast4,
        livemode: stripeConnectAccounts.livemode,
        defaultCurrency: stripeConnectAccounts.defaultCurrency,
        accountCountry: stripeConnectAccounts.accountCountry,
        accountRefreshedAt: stripeConnectAccounts.accountRefreshedAt,
      })
  );

  if (updated) {
    return {
      stripeAccountId: updated.stripeAccountId,
      last4: updated.keyLast4 ?? null,
      livemode: updated.livemode,
      defaultCurrency: updated.defaultCurrency,
      accountCountry: updated.accountCountry,
      accountRefreshedAt: updated.accountRefreshedAt ?? now,
    };
  }

  console.warn('[partnerStripe] account refresh raced a key replacement or disconnect — re-reading the current row', { partnerId, stripeAccountId, attempt });
  if (attempt < 1) return refreshPartnerStripeAccount(partnerId, attempt + 1);
  // An exhausted RETURNING guard is a LOCAL key-replacement/disconnect race, not
  // a Stripe outage: reporting it as STRIPE_UNAVAILABLE told the partner "we
  // could not reach Stripe" and made the sweep count a transient Stripe failure
  // that never happened (review F4). Its own code, its own message.
  throw new PartnerStripeError(
    'Your Stripe connection changed while it was being refreshed — reload the page and try again.',
    'STRIPE_CONNECTION_CHANGED',
  );
}

/**
 * Cache health as the client must see it. `stale`: Stripe could not be reached
 * right now, the cached value is shown with its age. `unknown`: Stripe answered
 * but would not tell us about the account (restricted key, unknown error) —
 * informational only, the connection itself is fine. `reconnect_required`: Stripe
 * refused to authenticate the stored key, or the ciphertext is unreadable — the
 * cached value is NOT trustworthy and checkout will fail until the key is replaced.
 */
export type StripeAccountCacheState = 'fresh' | 'stale' | 'unknown' | 'reconnect_required';

export type PartnerStripeAccountSnapshot =
  | { connected: false; last4: string | null }
  | {
      connected: true;
      stripeAccountId: string;
      last4: string | null;
      livemode: boolean;
      defaultCurrency: string | null;
      accountCountry: string | null;
      accountRefreshedAt: Date | null;
      cacheState: StripeAccountCacheState;
      error: { code: PartnerStripeErrorCode; message: string } | null;
    };

/**
 * ONE consistent snapshot of the partner's Stripe connection for the settings
 * route: status + display fields + cached account facts come from a single row
 * read; when the cache is past its TTL (or was never populated — pre-wave-5
 * rows), the refreshed snapshot is the row RETURNING'd by the cache write, so
 * status and cache can never come from two different rows (review F9).
 *
 * Cache-miss handling (review F4): only a TRANSIENT Stripe failure serves the
 * cached value, flagged `stale`. A permanent failure (revoked key,
 * undecryptable ciphertext) is reported as `reconnect_required` with the
 * error — never as stale success. A disconnect that lands between the read
 * and the refresh collapses to `connected: false`.
 *
 * Must be called with NO ambient request transaction (the GET route is
 * self-managed) — the refresh path performs a Stripe round-trip.
 */
export async function getPartnerStripeAccountSnapshot(partnerId: string): Promise<PartnerStripeAccountSnapshot> {
  const status = await runOutsideDbContext(() =>
    withSystemDbAccessContext(() => getPartnerStripeStatus(partnerId))
  );
  if (!status.connected) return status;

  const stale = status.accountRefreshedAt === null
    || Date.now() - status.accountRefreshedAt.getTime() > STRIPE_ACCOUNT_CACHE_TTL_MS;
  if (!stale) return { ...status, cacheState: 'fresh', error: null };

  try {
    const fresh = await refreshPartnerStripeAccount(partnerId);
    return { connected: true, ...fresh, cacheState: 'fresh', error: null };
  } catch (err) {
    if (!(err instanceof PartnerStripeError)) throw err;
    if (err.code === 'NO_STRIPE_KEY') return { connected: false, last4: status.last4 };
    if (err.code === 'STRIPE_UNAVAILABLE') {
      console.warn('[partnerStripe] account cache refresh failed transiently — serving cached value flagged stale', { partnerId, message: err.message });
      return { ...status, cacheState: 'stale', error: { code: err.code, message: err.message } };
    }
    if (err.code === 'STRIPE_ACCOUNT_UNKNOWN' || err.code === 'STRIPE_CONNECTION_CHANGED') {
      // The key may be perfectly usable for checkout; we just can't read the
      // account. Report the cache as unknown, NOT the connection as broken (F2).
      console.warn('[partnerStripe] account facts unavailable — cache reported as unknown', { partnerId, code: err.code, message: err.message });
      return { ...status, cacheState: 'unknown', error: { code: err.code, message: err.message } };
    }
    // INVALID_STRIPE_KEY / STRIPE_KEY_UNREADABLE: already logged at error level
    // by the refresh path. Surface the state; do NOT pretend the cache is good.
    return { ...status, cacheState: 'reconnect_required', error: { code: err.code, message: err.message } };
  }
}

/**
 * Connected accounts whose currency cache needs a bootstrap (#3777 review F6):
 * rows never refreshed (pre-cache connections migrate with every cache column
 * NULL), plus rows where Stripe reported no default currency and the re-check
 * window has elapsed (STRIPE_ACCOUNT_BOOTSTRAP_RECHECK_MS — under the sweep's
 * own cadence, so "daily" really is daily; review F5). Caller supplies the DB
 * context (system scope — this is a cross-partner sweep).
 */
export async function listPartnersNeedingStripeAccountBootstrap(now: Date = new Date()): Promise<{ partnerId: string }[]> {
  const recheckBefore = new Date(now.getTime() - STRIPE_ACCOUNT_BOOTSTRAP_RECHECK_MS);
  return db
    .select({ partnerId: stripeConnectAccounts.partnerId })
    .from(stripeConnectAccounts)
    .where(and(
      eq(stripeConnectAccounts.status, 'connected'),
      isNotNull(stripeConnectAccounts.apiKey),
      or(
        isNull(stripeConnectAccounts.accountRefreshedAt),
        and(isNull(stripeConnectAccounts.defaultCurrency), lt(stripeConnectAccounts.accountRefreshedAt, recheckBefore)),
      ),
    ))
    .orderBy(stripeConnectAccounts.partnerId);
}

/** Build a Stripe client bound to the partner's own key. Throws NO_STRIPE_KEY if unconfigured. */
export async function getPartnerStripe(partnerId: string): Promise<Stripe> {
  return (await getPartnerStripeClient(partnerId)).stripe;
}

/** Display status for the settings UI (never returns the key itself). */
export async function getPartnerStripeStatus(partnerId: string): Promise<PartnerStripeStatus> {
  const [row] = await db
    .select()
    .from(stripeConnectAccounts)
    .where(eq(stripeConnectAccounts.partnerId, partnerId))
    .limit(1);
  if (row && row.status === 'connected' && row.apiKey) {
    return {
      connected: true,
      stripeAccountId: row.stripeAccountId,
      last4: row.keyLast4 ?? null,
      livemode: row.livemode,
      defaultCurrency: row.defaultCurrency,
      accountCountry: row.accountCountry,
      accountRefreshedAt: row.accountRefreshedAt,
    };
  }
  return { connected: false, last4: row?.keyLast4 ?? null };
}

/** Disconnect: wipe the stored secret + last4 and mark disconnected. */
export async function disconnectPartnerStripe(partnerId: string): Promise<void> {
  const now = new Date();
  await db
    .update(stripeConnectAccounts)
    .set({ status: 'disconnected', apiKey: null, keyLast4: null, disconnectedAt: now, updatedAt: now })
    .where(eq(stripeConnectAccounts.partnerId, partnerId));
}
