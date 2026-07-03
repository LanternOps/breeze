import Stripe from 'stripe';
import { eq } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { stripeConnectAccounts } from '../db/schema/stripePayments';
import { encryptSecret, decryptSecret } from './secretCrypto';
import { isPgUniqueViolation } from '../utils/pgErrors';

// Pinned API version — do not rely on the SDK default (it moves on upgrade).
const API_VERSION = '2026-03-25.dahlia';

export type PartnerStripeErrorCode =
  | 'NO_STRIPE_KEY'        // partner never configured a key / disconnected
  | 'INVALID_STRIPE_KEY'   // key rejected by Stripe at save time
  | 'STRIPE_KEY_UNREADABLE'; // stored ciphertext can't be decrypted (corrupt / KEK rotated away)

// Status is a function of the code, not an independent field — keeps the pair on
// its valid diagonal (no `('NO_STRIPE_KEY', 400)` foot-guns).
const STATUS_FOR_CODE: Record<PartnerStripeErrorCode, 400 | 409 | 500> = {
  NO_STRIPE_KEY: 409,
  INVALID_STRIPE_KEY: 400,
  STRIPE_KEY_UNREADABLE: 500,
};

export class PartnerStripeError extends Error {
  readonly status: 400 | 409 | 500;
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
  | { connected: true; stripeAccountId: string; last4: string | null; livemode: boolean };

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
}): Promise<{ stripeAccountId: string; last4: string; livemode: boolean }> {
  const apiKey = input.apiKey.trim();

  // Validate by retrieving the account the key belongs to. Any rejection (bad key,
  // revoked, insufficient scope) → INVALID_STRIPE_KEY rather than a 500.
  let accountId: string;
  try {
    const probe = new Stripe(apiKey, { apiVersion: API_VERSION });
    // No-arg accounts.retrieve() hits GET /v1/account — the account the KEY belongs
    // to (the partner's own account). The SDK's typed overload requires an id (for
    // Connect), so cast to the documented no-arg form.
    const account = await (probe.accounts.retrieve as unknown as () => Promise<Stripe.Account>)();
    accountId = account.id;
  } catch (err) {
    // Always log the real reason — a money-onboarding path must not swallow it. A
    // transient Stripe outage / rate-limit isn't the partner's fault, so say so
    // rather than telling them to rotate a valid key.
    const type = (err as { type?: string })?.type;
    const transient = type === 'StripeConnectionError' || type === 'StripeAPIError' || type === 'StripeRateLimitError';
    console.error('[partnerStripe] key validation failed', { partnerId: input.partnerId, type: type ?? 'unknown', transient, message: err instanceof Error ? err.message : String(err) });
    throw new PartnerStripeError(
      transient
        ? 'Could not reach Stripe to verify the key right now — please try again in a moment.'
        : 'That Stripe key was rejected — double-check it (and that it can read your account) and try again.',
      'INVALID_STRIPE_KEY',
    );
  }

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
  //   2. letting the constraint raise doesn't work either: the request runs
  //      inside the withDbAccessContext transaction, and postgres.js records
  //      the raw 23505 and re-throws it at commit even after the catch below
  //      maps it — the route's mapped 400 was deterministically clobbered
  //      into a raw 500.
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

  try {
    await db
      .insert(stripeConnectAccounts)
      .values({
        partnerId: input.partnerId,
        stripeAccountId: accountId,
        apiKey: encrypted,
        keyLast4: last4,
        livemode,
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
          status: 'connected',
          connectedBy: input.userId,
          connectedAt: now,
          disconnectedAt: null,
          updatedAt: now,
        },
      });
  } catch (err) {
    // Concurrent-writer backstop only: the system-context pre-check above
    // catches the deterministic case, so acct_uq (23505) can now fire solely
    // when another partner claims the same Stripe account BETWEEN the
    // pre-check and this upsert. On this path the surrounding
    // withDbAccessContext transaction is already aborted and postgres.js will
    // re-throw the raw error at commit (the mapped error below does NOT reach
    // the caller — they see a 500), but the window is a vanishing-probability
    // race instead of the previously deterministic path. Kept for the log/
    // intent trail; Drizzle wraps the postgres.js error, so the pg code/
    // constraint live on `.cause` — isPgUniqueViolation walks the chain.
    if (isPgUniqueViolation(err, 'stripe_connect_accounts_acct_uq')) {
      throw new PartnerStripeError(
        'That Stripe account is already connected to another partner. Use a key for a different Stripe account.',
        'INVALID_STRIPE_KEY',
      );
    }
    throw err;
  }

  return { stripeAccountId: accountId, last4, livemode };
}

/**
 * Build a Stripe client bound to the partner's own key AND return their account id
 * in a single row read (callers that need both — e.g. createInvoicePayLink for the
 * payment mapping — avoid a second query). Throws NO_STRIPE_KEY if unconfigured,
 * STRIPE_KEY_UNREADABLE if the stored ciphertext can't be decrypted.
 */
export async function getPartnerStripeClient(partnerId: string): Promise<{ stripe: Stripe; stripeAccountId: string }> {
  const [row] = await db
    .select({ apiKey: stripeConnectAccounts.apiKey, status: stripeConnectAccounts.status, stripeAccountId: stripeConnectAccounts.stripeAccountId })
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
  return { stripe: new Stripe(key, { apiVersion: API_VERSION }), stripeAccountId: row.stripeAccountId };
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
    return { connected: true, stripeAccountId: row.stripeAccountId, last4: row.keyLast4 ?? null, livemode: row.livemode };
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
