import Stripe from 'stripe';
import { and, eq, isNull, isNotNull, lte, or, sql } from 'drizzle-orm';
import { db } from '../db';
import {
  invoiceStripePayments,
  stripeConnectAccounts,
  stripeConnectCredentials,
} from '../db/schema/stripePayments';
import { decryptSecret } from './secretCrypto';
import { requestLikeFromSnapshot, writeAuditEventAsync } from './auditEvents';

/**
 * Superseded Stripe credential archive (SEC-150).
 *
 * A Checkout session can only be expired with a key for the account that minted
 * it. `stripe_connect_accounts` holds exactly ONE key per partner, so a rotation
 * or a disconnect used to destroy the only credential that could still revoke
 * every open session — the finding's "key or account replacement" and
 * "disconnect" rows. Superseded keys are archived here instead, and the session
 * mapping keeps a durable pointer (`revocation_credential_id`) at the exact
 * generation that minted it.
 *
 * Every function here requires a SYSTEM DB context: the table is partner-axis
 * and its INSERT/UPDATE/DELETE policies additionally demand
 * `breeze_current_scope() = 'system'`.
 */

/** Stripe's outer dispute window; the earliest a superseded secret may go. */
export const CREDENTIAL_RETENTION_MS = 120 * 24 * 60 * 60 * 1000;
/** Hard cap: destroyed at this point whatever the dependent sessions say. */
export const CREDENTIAL_RETENTION_HARD_CAP_MS = 400 * 24 * 60 * 60 * 1000;

// Pinned API version — must match partnerStripe.ts. The SDK default moves on upgrade.
const API_VERSION = '2026-06-24.dahlia';

export class StripeCredentialUnavailableError extends Error {
  constructor(message: string, readonly reason: 'credential_unavailable') {
    super(message);
    this.name = 'StripeCredentialUnavailableError';
  }
}

export interface ArchiveCredentialInput {
  partnerId: string;
  /** `stripe_connect_accounts.id` — the durable connection row. */
  stripeConnectionId: string;
  /** The account the OUTGOING key belongs to (never the incoming one). */
  stripeAccountId: string;
  /** Ciphertext exactly as stored on `stripe_connect_accounts.api_key`. */
  encryptedApiKey: string;
  keyLast4: string | null;
  livemode: boolean;
  now?: Date;
}

/**
 * Archive the credential that is about to be overwritten or wiped, and re-point
 * every still-open session mapping on that account at it.
 *
 * MUST run inside the same transaction that replaces/clears the live key, with
 * the `stripe_connect_accounts` row already locked FOR UPDATE — otherwise a
 * concurrent rotation could archive the same generation twice, or a session
 * minted between the archive and the overwrite would keep a NULL pointer while
 * its key is already gone.
 *
 * Returns the archived credential id, or null when there was nothing to archive
 * (already-disconnected connection with no stored key).
 */
export async function archiveSupersededCredential(
  input: ArchiveCredentialInput,
): Promise<string | null> {
  if (!input.encryptedApiKey) return null;
  const now = input.now ?? new Date();

  // Monotonic per connection. Read under the caller's row lock, so two rotations
  // cannot pick the same number (and the generation unique index is the backstop).
  const [{ next } = { next: 1 }] = await db
    .select({ next: sql<number>`COALESCE(MAX(${stripeConnectCredentials.generation}), 0) + 1` })
    .from(stripeConnectCredentials)
    .where(eq(stripeConnectCredentials.stripeConnectionId, input.stripeConnectionId));

  const [archived] = await db.insert(stripeConnectCredentials).values({
    partnerId: input.partnerId,
    stripeConnectionId: input.stripeConnectionId,
    stripeAccountId: input.stripeAccountId,
    apiKey: input.encryptedApiKey,
    keyLast4: input.keyLast4,
    livemode: input.livemode,
    generation: Number(next),
    supersededAt: now,
    eraseAfter: new Date(now.getTime() + CREDENTIAL_RETENTION_MS),
    eraseHardCapAt: new Date(now.getTime() + CREDENTIAL_RETENTION_HARD_CAP_MS),
    createdAt: now,
    updatedAt: now,
  }).returning({ id: stripeConnectCredentials.id });
  if (!archived) return null;

  // Re-point every mapping that could still need this key. Rows that already
  // carry a pointer belong to an OLDER generation and must keep it.
  await db.update(invoiceStripePayments)
    .set({ revocationCredentialId: archived.id, updatedAt: now })
    .where(and(
      eq(invoiceStripePayments.stripeAccountId, input.stripeAccountId),
      eq(invoiceStripePayments.stripeObjectType, 'checkout_session'),
      eq(invoiceStripePayments.status, 'pending'),
      isNull(invoiceStripePayments.invoicePaymentId),
      isNull(invoiceStripePayments.revocationCredentialId),
      sql`${invoiceStripePayments.revocationState} IN ('active', 'revocation_requested', 'legacy_unbounded')`,
    ));

  return archived.id;
}

/**
 * Build a Stripe client from an ARCHIVED credential.
 *
 * Never exposed by a route and never returned to a caller in any shape that
 * carries the key. Every successful decrypt writes an audit row: a retained
 * secret with no access trail would be a new finding, not a fix.
 *
 * Throws StripeCredentialUnavailableError when the row is gone, already erased,
 * or undecryptable — the caller maps that to `revocation_blocked` /
 * `credential_unavailable` rather than pretending the session is dead.
 */
export async function getSupersededStripeCredential(
  credentialId: string,
  context: { reason: string; invoiceStripePaymentId?: string },
): Promise<{ stripe: Stripe; stripeAccountId: string; partnerId: string }> {
  const [row] = await db.select({
    id: stripeConnectCredentials.id,
    partnerId: stripeConnectCredentials.partnerId,
    stripeAccountId: stripeConnectCredentials.stripeAccountId,
    apiKey: stripeConnectCredentials.apiKey,
    generation: stripeConnectCredentials.generation,
    erasedAt: stripeConnectCredentials.erasedAt,
  }).from(stripeConnectCredentials)
    .where(eq(stripeConnectCredentials.id, credentialId))
    .limit(1);

  if (!row) {
    throw new StripeCredentialUnavailableError(
      `Archived Stripe credential ${credentialId} no longer exists`, 'credential_unavailable');
  }
  if (row.erasedAt || !row.apiKey) {
    throw new StripeCredentialUnavailableError(
      `Archived Stripe credential ${credentialId} was erased on ${row.erasedAt?.toISOString() ?? 'unknown'}`,
      'credential_unavailable');
  }

  let key: string | null;
  try {
    key = decryptSecret(row.apiKey);
  } catch (err) {
    console.error('[stripeCredentialArchive] failed to decrypt an archived credential', {
      credentialId, partnerId: row.partnerId,
      message: err instanceof Error ? err.message : String(err),
    });
    throw new StripeCredentialUnavailableError(
      `Archived Stripe credential ${credentialId} could not be decrypted`, 'credential_unavailable');
  }
  if (!key) {
    throw new StripeCredentialUnavailableError(
      `Archived Stripe credential ${credentialId} decrypted to an empty value`, 'credential_unavailable');
  }

  await db.update(stripeConnectCredentials)
    .set({ lastUsedAt: new Date(), updatedAt: new Date() })
    .where(eq(stripeConnectCredentials.id, credentialId));

  // Audit AFTER the decrypt succeeded and BEFORE the key leaves this function.
  // Best-effort: a failed audit write must not strand a revocation, but it is
  // logged loudly because an untracked decrypt is exactly what this row exists
  // to prevent.
  try {
    await writeAuditEventAsync(requestLikeFromSnapshot({}), {
      orgId: null,
      action: 'stripe_connect.superseded_credential_used',
      resourceType: 'partner',
      resourceId: row.partnerId,
      actorType: 'system',
      actorId: null,
      result: 'success',
      details: {
        credentialId,
        generation: row.generation,
        stripeAccountId: row.stripeAccountId,
        reason: context.reason,
        invoiceStripePaymentId: context.invoiceStripePaymentId ?? null,
      },
    });
  } catch (err) {
    console.error('[stripeCredentialArchive] failed to audit an archived-credential decrypt', {
      credentialId, message: err instanceof Error ? err.message : String(err),
    });
  }

  return {
    stripe: new Stripe(key, { apiVersion: API_VERSION }),
    stripeAccountId: row.stripeAccountId,
    partnerId: row.partnerId,
  };
}

/**
 * Daily eraser. Destroys the ciphertext (never the row — the forensic record of
 * what was retained survives) once either:
 *   - the 120-day window has elapsed AND no session mapping on that account is
 *     still non-terminal, or
 *   - the 400-day hard cap has elapsed, unconditionally.
 *
 * Caller supplies a SYSTEM context. Returns the number of secrets destroyed.
 */
export async function eraseExpiredStripeCredentials(now: Date = new Date()): Promise<number> {
  const candidates = await db.select({
    id: stripeConnectCredentials.id,
    partnerId: stripeConnectCredentials.partnerId,
    stripeAccountId: stripeConnectCredentials.stripeAccountId,
    generation: stripeConnectCredentials.generation,
    eraseHardCapAt: stripeConnectCredentials.eraseHardCapAt,
  }).from(stripeConnectCredentials)
    .where(and(
      isNull(stripeConnectCredentials.erasedAt),
      isNotNull(stripeConnectCredentials.apiKey),
      or(
        lte(stripeConnectCredentials.eraseAfter, now),
        lte(stripeConnectCredentials.eraseHardCapAt, now),
      ),
    ))
    .orderBy(stripeConnectCredentials.eraseAfter)
    .limit(500);

  let erased = 0;
  for (const candidate of candidates) {
    const pastHardCap = candidate.eraseHardCapAt.getTime() <= now.getTime();
    if (!pastHardCap) {
      const [dependent] = await db.select({ id: invoiceStripePayments.id })
        .from(invoiceStripePayments)
        .where(and(
          eq(invoiceStripePayments.revocationCredentialId, candidate.id),
          sql`${invoiceStripePayments.revocationState} IN ('active', 'revocation_requested', 'legacy_unbounded')`,
        ))
        .limit(1);
      // A session that can still be paid keeps its key alive: destroying it now
      // would convert a retryable revocation into a permanent `revocation_blocked`.
      if (dependent) continue;
    }

    await db.update(stripeConnectCredentials)
      .set({ apiKey: null, erasedAt: now, updatedAt: now })
      .where(and(
        eq(stripeConnectCredentials.id, candidate.id),
        isNull(stripeConnectCredentials.erasedAt),
      ));
    erased++;

    try {
      await writeAuditEventAsync(requestLikeFromSnapshot({}), {
        orgId: null,
        action: 'stripe_connect.superseded_credential_erased',
        resourceType: 'partner',
        resourceId: candidate.partnerId,
        actorType: 'system',
        actorId: null,
        result: 'success',
        details: {
          credentialId: candidate.id,
          generation: candidate.generation,
          stripeAccountId: candidate.stripeAccountId,
          reason: pastHardCap ? 'hard_cap' : 'retention_elapsed',
        },
      });
    } catch (err) {
      console.error('[stripeCredentialArchive] failed to audit a credential erase', {
        credentialId: candidate.id, message: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return erased;
}

/**
 * Newest usable archived credential for a partner/account pair.
 *
 * The safety net for a session that was minted while a rotation or disconnect
 * was already in flight: it carries no `revocation_credential_id` (there was
 * nothing to point at when it was written) and the live key no longer matches,
 * so without this lookup it would be permanently unrevocable. Ordered by
 * generation DESC — the most recent superseded key is the one that minted it.
 */
export async function findLatestArchivedCredentialForAccount(
  partnerId: string, stripeAccountId: string,
): Promise<{ id: string } | null> {
  const [row] = await db.select({ id: stripeConnectCredentials.id })
    .from(stripeConnectCredentials)
    .where(and(
      eq(stripeConnectCredentials.partnerId, partnerId),
      eq(stripeConnectCredentials.stripeAccountId, stripeAccountId),
      isNull(stripeConnectCredentials.erasedAt),
      isNotNull(stripeConnectCredentials.apiKey),
    ))
    .orderBy(sql`${stripeConnectCredentials.generation} DESC`)
    .limit(1);
  return row ?? null;
}

/**
 * The live connection row for a partner, for the revocation path. Deliberately
 * NOT `getPartnerStripeClient`: revocation must bind to the account the SESSION
 * was minted on, so the caller compares `stripeAccountId` itself and falls back
 * to the archive when they differ.
 */
export async function getLiveConnectionForRevocation(partnerId: string): Promise<{
  stripeConnectionId: string; stripeAccountId: string; encryptedApiKey: string | null; status: string;
} | null> {
  const [row] = await db.select({
    stripeConnectionId: stripeConnectAccounts.id,
    stripeAccountId: stripeConnectAccounts.stripeAccountId,
    encryptedApiKey: stripeConnectAccounts.apiKey,
    status: stripeConnectAccounts.status,
  }).from(stripeConnectAccounts)
    .where(eq(stripeConnectAccounts.partnerId, partnerId))
    .limit(1);
  return row ?? null;
}
