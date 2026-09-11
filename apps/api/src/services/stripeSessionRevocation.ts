import Stripe from 'stripe';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { invoices } from '../db/schema/invoices';
import { invoiceStripePayments } from '../db/schema/stripePayments';
import { stripeSessionRevocationMode } from '../config/env';
import { captureException } from './sentry';
import { decryptSecret } from './secretCrypto';
import { InvoiceServiceError, type InvoiceActor } from './invoiceTypes';
import {
  findLatestArchivedCredentialForAccount,
  getLiveConnectionForRevocation,
  getSupersededStripeCredential,
  StripeCredentialUnavailableError,
} from './stripeCredentialArchive';
import { requestLikeFromSnapshot, writeAuditEventAsync } from './auditEvents';

/**
 * Fail-closed Stripe Checkout session revocation (SEC-2026-09-05-150).
 *
 * A Checkout session stays payable ON STRIPE after Breeze resets the public
 * link, records an alternate payment, voids the invoice or replaces the key.
 * Local settlement protects the Breeze ledger; it cannot stop a provider
 * charge. Every one of those transitions now runs a THREE-PHASE revocation:
 *
 *   1. INTENT   — short system transaction, invoice row locked FOR UPDATE
 *                 (B10 lock order, same as every payment writer). Open mappings
 *                 are stamped `revocation_requested`. From this instant no
 *                 producer may mint a new session for the invoice, so the window
 *                 is safe even if phase 2 never succeeds.
 *   2. PROVIDER — `checkout.sessions.expire`, strictly OUTSIDE any DB context.
 *                 Holding a pooled connection across a Stripe round-trip is the
 *                 #1105 hang class.
 *   3. APPLY    — the caller's own transition transaction re-reads the mappings
 *                 and refuses (503 STRIPE_REVOCATION_PENDING) unless all are
 *                 terminal. The intent is durable, so the sweep finishes the job
 *                 and the operator retries in seconds.
 *
 * Disconnect INVERTS this (bounded-async, Option B): an operator killing their
 * Stripe integration must never be blocked by Stripe being down.
 */

/** Why a session was asked to die. Written verbatim to `revocation_reason`. */
export type RevocationReason =
  | 'link_reset'
  | 'manual_payment'
  | 'invoice_void'
  | 'key_replaced'
  | 'account_changed'
  | 'disconnect'
  | 'sibling_settled'
  /** A producer minted a session while a revocation was already in flight. */
  | 'raced_revocation'
  | 'operator_abandoned';

/** Pinned API version — must match partnerStripe.ts. */
const STRIPE_API_VERSION = '2026-06-24.dahlia';

/** Per-attempt provider timeout. Matches the observed Stripe call latency. */
export const EXPIRE_TIMEOUT_MS = 8_000;
/** Attempts inside ONE request. The worker owns everything beyond that. */
export const EXPIRE_ATTEMPTS_PER_REQUEST = 2;
/** Whole-request provider budget; keeps the call under any sane proxy timeout. */
export const REQUEST_PROVIDER_BUDGET_MS = 12_000;
/** Disconnect is bounded-async: a much tighter budget, and never a refusal. */
export const DISCONNECT_PROVIDER_BUDGET_MS = 5_000;

/** Retry ladder: 30s → ×2 → capped at 1h. */
export const RETRY_BASE_MS = 30_000;
export const RETRY_CAP_MS = 60 * 60 * 1000;
/** Beyond this since the intent was recorded the row becomes `revocation_blocked`. */
export const RETRY_GIVE_UP_MS = 48 * 60 * 60 * 1000;

/** Mapping states that still describe a potentially payable session. */
export const OPEN_REVOCATION_STATES = ['active', 'revocation_requested', 'legacy_unbounded'] as const;

export const REVOCATION_PENDING_CODE = 'STRIPE_REVOCATION_PENDING';
const REVOCATION_PENDING_MESSAGE =
  'Stripe has not confirmed that the open payment link for this invoice is dead yet. '
  + 'Nothing was changed — try again in a moment.';

/** A blocked row an operator explicitly abandoned no longer bars a transition. */
const ABANDONED_REASON_PREFIX = 'operator_abandoned';

export interface OpenSessionRow {
  id: string;
  orgId: string;
  invoiceId: string;
  partnerId: string;
  stripeAccountId: string;
  stripeObjectId: string;
  revocationCredentialId: string | null;
  revocationAttempts: number;
  revocationRequestedAt: Date | null;
}

/** What the provider said about one session, normalised. */
export type ProviderOutcome =
  | { kind: 'revoked'; providerCode: string }
  | { kind: 'charged'; providerCode: string }
  | { kind: 'blocked'; providerCode: string; message: string }
  | { kind: 'retryable'; providerCode: string; message: string };

export interface RevocationSummary {
  requested: number;
  revoked: number;
  charged: number;
  blocked: number;
  stillPending: number;
}

/**
 * The non-throwing twin of invoiceService.requireInvoiceAccess. Duplicated
 * rather than imported to keep this module free of an invoiceService cycle, and
 * deliberately silent: the caller maps a denial to "no rows", never to a 403.
 */
function actorMayTouchInvoice(actor: InvoiceActor, inv: { orgId: string; siteId: string | null }): boolean {
  if (actor.accessibleOrgIds !== null && !actor.accessibleOrgIds.includes(inv.orgId)) return false;
  if (actor.allowedSiteIds && (!inv.siteId || !actor.allowedSiteIds.includes(inv.siteId))) return false;
  return true;
}

function providerCodeOf(err: unknown): string {
  const e = err as { code?: string; type?: string; statusCode?: number } | null;
  return e?.code ?? e?.type ?? (e?.statusCode ? `http_${e.statusCode}` : 'unknown');
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Classify a `sessions.expire` failure.
 *
 * The ONLY genuinely transient class is timeout / rate-limit / 5xx / connection
 * error. A dead or under-scoped credential is PERMANENT — retrying it forever is
 * noise, not safety — and `resource_missing` means nothing payable can exist, so
 * treating it as retryable would block the transition for ever.
 */
export function classifyExpireError(err: unknown): ProviderOutcome {
  const type = (err as { type?: string } | null)?.type;
  const code = (err as { code?: string } | null)?.code;
  const providerCode = providerCodeOf(err);
  const message = messageOf(err);

  if (err instanceof StripeCredentialUnavailableError) {
    return { kind: 'blocked', providerCode: 'credential_unavailable', message };
  }
  if (code === 'resource_missing') return { kind: 'revoked', providerCode };
  if (
    type === 'StripeAuthenticationError'
    || type === 'StripePermissionError'
    || code === 'api_key_expired'
    || code === 'account_invalid'
  ) {
    return { kind: 'blocked', providerCode, message };
  }
  if (
    type === 'StripeConnectionError'
    || type === 'StripeAPIError'
    || type === 'StripeRateLimitError'
    || code === 'lock_timeout'
    || /timed? ?out/i.test(message)
  ) {
    return { kind: 'retryable', providerCode, message };
  }
  // Everything left is an invalid-request refusal ("you may only expire a session
  // that is open"). The session's own status decides — never the error string.
  return { kind: 'retryable', providerCode, message };
}

/**
 * Expire ONE session, resolving the credential that minted it.
 *
 * `revocation_credential_id` is NULL while the partner's LIVE key still belongs
 * to the session's account; a rotation/disconnect archives the outgoing key and
 * stamps the pointer, so a session minted under generation N stays revocable
 * after the key moved to N+1.
 *
 * MUST be called with NO ambient DB context: it performs a Stripe round-trip.
 */
export async function expireOneSession(row: OpenSessionRow): Promise<ProviderOutcome> {
  let client: Stripe;
  try {
    client = await resolveRevocationClient(row);
  } catch (err) {
    if (err instanceof StripeCredentialUnavailableError) {
      return { kind: 'blocked', providerCode: 'credential_unavailable', message: messageOf(err) };
    }
    throw err;
  }

  try {
    await client.checkout.sessions.expire(row.stripeObjectId, undefined, {
      timeout: EXPIRE_TIMEOUT_MS,
      maxNetworkRetries: 0,
    });
    return { kind: 'revoked', providerCode: 'expired' };
  } catch (err) {
    const classified = classifyExpireError(err);
    if (classified.kind !== 'retryable') return classified;
    // A refusal may mean the session is already expired (fine) or already
    // COMPLETE (a real charge). Ask Stripe what the session actually is rather
    // than parsing its prose. A failure here leaves the row retryable.
    try {
      const session = await client.checkout.sessions.retrieve(row.stripeObjectId, undefined, {
        timeout: EXPIRE_TIMEOUT_MS,
        maxNetworkRetries: 0,
      });
      if (session.status === 'expired') return { kind: 'revoked', providerCode: 'already_expired' };
      if (session.status === 'complete') {
        return session.payment_status === 'paid'
          ? { kind: 'charged', providerCode: 'already_paid' }
          // A complete-but-unpaid session cannot be paid again; card-only
          // sessions never settle asynchronously.
          : { kind: 'revoked', providerCode: 'already_complete_unpaid' };
      }
      return classified;
    } catch (retrieveErr) {
      const retrieveOutcome = classifyExpireError(retrieveErr);
      if (retrieveOutcome.kind === 'revoked' || retrieveOutcome.kind === 'blocked') return retrieveOutcome;
      return classified;
    }
  }
}

/**
 * `runOutsideDbContext` FIRST is NOT optional on any read below.
 *
 * `withDbAccessContext` short-circuits when a context is already open — it
 * deliberately keeps the caller's scope — so a bare `withSystemDbAccessContext`
 * inside a request runs under the REQUEST's scope. Both credential tables are
 * partner-axis, so from an organization-scoped caller (the portal) they would be
 * silently RLS-filtered to zero rows (#1375) and a perfectly healthy connected
 * partner would land in `revocation_blocked` / `credential_unavailable`: the
 * session stays payable, the invoice can never be voided, and the partner is
 * shown a false "reissue your links" banner.
 */
async function runInSystemScope<T>(fn: () => Promise<T>): Promise<T> {
  return runOutsideDbContext(() => withSystemDbAccessContext(fn));
}

async function resolveRevocationClient(row: OpenSessionRow): Promise<Stripe> {
  const credentialId = row.revocationCredentialId
    // No pointer AND no usable live key means the session was minted while a
    // rotation/disconnect was already in flight — there was nothing to point at
    // when its mapping was written. The newest archived credential for the
    // session's own account is the one that minted it; without this fallback the
    // session would be permanently unrevocable.
    ?? (await runInSystemScope(async () => {
      const live = await getLiveConnectionForRevocation(row.partnerId);
      const liveUsable = live !== null && live.encryptedApiKey !== null
        && live.status === 'connected' && live.stripeAccountId === row.stripeAccountId;
      if (liveUsable) return null;
      const archived = await findLatestArchivedCredentialForAccount(row.partnerId, row.stripeAccountId);
      return archived?.id ?? null;
    }));

  if (credentialId) {
    const archived = await runInSystemScope(() =>
      getSupersededStripeCredential(credentialId, {
        reason: 'checkout_session_revocation',
        invoiceStripePaymentId: row.id,
      }));
    if (archived.stripeAccountId !== row.stripeAccountId) {
      throw new StripeCredentialUnavailableError(
        `Archived credential ${credentialId} belongs to ${archived.stripeAccountId}, `
        + `not the session's account ${row.stripeAccountId}`,
        'credential_unavailable');
    }
    return archived.stripe;
  }

  const live = await runInSystemScope(() => getLiveConnectionForRevocation(row.partnerId));
  if (!live || !live.encryptedApiKey || live.status !== 'connected') {
    throw new StripeCredentialUnavailableError(
      `Partner ${row.partnerId} has no live Stripe credential and no archived one for account ${row.stripeAccountId}`,
      'credential_unavailable');
  }
  if (live.stripeAccountId !== row.stripeAccountId) {
    throw new StripeCredentialUnavailableError(
      `Live Stripe credential belongs to ${live.stripeAccountId}, not the session's account ${row.stripeAccountId}`,
      'credential_unavailable');
  }
  let key: string | null;
  try {
    key = decryptSecret(live.encryptedApiKey);
  } catch (err) {
    throw new StripeCredentialUnavailableError(
      `Live Stripe credential for partner ${row.partnerId} could not be decrypted: ${messageOf(err)}`,
      'credential_unavailable');
  }
  if (!key) {
    throw new StripeCredentialUnavailableError(
      `Live Stripe credential for partner ${row.partnerId} decrypted to an empty value`,
      'credential_unavailable');
  }
  return new Stripe(key, { apiVersion: STRIPE_API_VERSION });
}

/**
 * PHASE 1 — durable intent.
 *
 * Locks the invoice row FOR UPDATE (B10 order), stamps every open Checkout
 * mapping `revocation_requested` and commits. Runs in its OWN short system
 * transaction so no Stripe I/O can ever enter a caller's request transaction.
 */
export async function recordRevocationIntent(input: {
  invoiceId: string;
  reason: RevocationReason;
  requestedByUserId: string | null;
  /**
   * TENANCY GATE. This whole transaction runs in a SYSTEM context, which is
   * RLS-exempt, so without it a caller who guessed another partner's invoice
   * UUID could stamp that invoice's Checkout sessions `revocation_requested` —
   * blocking the real owner's pay-link producer and, once the credential lookup
   * failed, parking them permanently. The transition that wraps this still 404s
   * on its own RLS-scoped read, so nothing was ever disclosed; the CROSS-TENANT
   * WRITE was the defect.
   *
   * Enforced on the row this transaction already reads, so it costs no extra
   * query, and a denial writes NOTHING and returns no rows rather than throwing:
   * a 403 here would turn today's 404 into an existence oracle. Omit for the
   * genuinely system-owned callers (the sweep, the credential transitions).
   */
  actor?: InvoiceActor;
}): Promise<OpenSessionRow[]> {
  return runOutsideDbContext(() => withSystemDbAccessContext(async () => {
    const [inv] = await db.select({
      id: invoices.id, partnerId: invoices.partnerId, orgId: invoices.orgId, siteId: invoices.siteId,
    }).from(invoices).where(eq(invoices.id, input.invoiceId)).limit(1).for('update');
    if (!inv) return [];
    if (input.actor && !actorMayTouchInvoice(input.actor, inv)) return [];

    const rows = await db.update(invoiceStripePayments)
      .set({
        revocationState: 'revocation_requested',
        revocationReason: input.reason,
        // The FIRST request wins the clock: a second transition on the same
        // invoice must not reset the 48h give-up window and hide a stuck row.
        revocationRequestedAt: sql`COALESCE(${invoiceStripePayments.revocationRequestedAt}, now())`,
        revocationRequestedByUserId: input.requestedByUserId,
        revocationNextAttemptAt: sql`now()`,
        updatedAt: new Date(),
      })
      .where(and(
        eq(invoiceStripePayments.invoiceId, input.invoiceId),
        eq(invoiceStripePayments.stripeObjectType, 'checkout_session'),
        eq(invoiceStripePayments.status, 'pending'),
        isNull(invoiceStripePayments.invoicePaymentId),
        inArray(invoiceStripePayments.revocationState, [...OPEN_REVOCATION_STATES]),
      ))
      .returning({
        id: invoiceStripePayments.id,
        orgId: invoiceStripePayments.orgId,
        invoiceId: invoiceStripePayments.invoiceId,
        stripeAccountId: invoiceStripePayments.stripeAccountId,
        stripeObjectId: invoiceStripePayments.stripeObjectId,
        revocationCredentialId: invoiceStripePayments.revocationCredentialId,
        revocationAttempts: invoiceStripePayments.revocationAttempts,
        revocationRequestedAt: invoiceStripePayments.revocationRequestedAt,
      });

    return rows.map((r) => ({ ...r, partnerId: inv.partnerId }));
  }));
}

/**
 * PHASE 3 — persist one provider outcome. Its own short system transaction so a
 * slow row never widens another row's lock window.
 */
export async function applyProviderOutcome(
  row: OpenSessionRow, outcome: ProviderOutcome,
): Promise<void> {
  await runOutsideDbContext(() => withSystemDbAccessContext(async () => {
    const now = new Date();
    if (outcome.kind === 'revoked') {
      await db.update(invoiceStripePayments).set({
        revocationState: 'revoked',
        revokedAt: now,
        revocationLastProviderCode: outcome.providerCode,
        revocationLastError: null,
        revocationNextAttemptAt: null,
        updatedAt: now,
      }).where(eq(invoiceStripePayments.id, row.id));
      return;
    }
    if (outcome.kind === 'charged') {
      // Provider truth wins: a real charge is never discarded to satisfy a local
      // flag. The row is parked for human reconciliation and BLOCKS the transition.
      await db.update(invoiceStripePayments).set({
        revocationState: 'charged_repair',
        revocationLastProviderCode: outcome.providerCode,
        revocationLastError: 'session reported paid after revocation was requested',
        revocationNextAttemptAt: null,
        updatedAt: now,
      }).where(eq(invoiceStripePayments.id, row.id));
      return;
    }
    if (outcome.kind === 'blocked') {
      await db.update(invoiceStripePayments).set({
        revocationState: 'revocation_blocked',
        // A missing/erased credential is the ONE blocked reason the partner can
        // act on, so it replaces the trigger reason and drives the Stripe-card
        // banner. Every other block keeps the reason that asked for the
        // revocation; the provider code carries the why.
        ...(outcome.providerCode === 'credential_unavailable'
          ? { revocationReason: 'credential_unavailable' }
          : {}),
        revocationLastProviderCode: outcome.providerCode,
        revocationLastError: outcome.message.slice(0, 2000),
        revocationNextAttemptAt: null,
        revocationAttempts: row.revocationAttempts + 1,
        updatedAt: now,
      }).where(eq(invoiceStripePayments.id, row.id));
      return;
    }

    // Retryable. The DATABASE clock decides eligibility — a worker whose host
    // clock drifted must not resurrect or starve a row (#5503 lesson).
    const attempts = row.revocationAttempts + 1;
    const delayMs = Math.min(RETRY_CAP_MS, RETRY_BASE_MS * (2 ** Math.min(attempts - 1, 10)));
    const requestedAt = row.revocationRequestedAt ?? now;
    const exhausted = now.getTime() - requestedAt.getTime() >= RETRY_GIVE_UP_MS;
    await db.update(invoiceStripePayments).set({
      revocationState: exhausted ? 'revocation_blocked' : 'revocation_requested',
      revocationAttempts: attempts,
      revocationLastProviderCode: outcome.providerCode,
      revocationLastError: outcome.message.slice(0, 2000),
      revocationNextAttemptAt: exhausted
        ? null
        : sql`now() + (${`${Math.round(delayMs / 1000)} seconds`})::interval`,
      updatedAt: now,
    }).where(eq(invoiceStripePayments.id, row.id));
  }));
}

/** Sentry alert for a row that reached an unrepaired terminal state. */
function alertRevocation(stage: 'blocked' | 'charged_repair', row: OpenSessionRow, detail: string): void {
  captureException(
    new Error(`[stripeSessionRevocation] ${stage} session=${row.stripeObjectId} invoice=${row.invoiceId}: ${detail}`),
    undefined,
    { stripe_revocation_stage: stage, org_id: row.orgId },
  );
}

/**
 * PHASE 2 for a batch of rows, honouring a wall-clock budget. Rows the budget
 * did not reach stay `revocation_requested` — durable intent, worker's problem.
 */
export async function runProviderPhase(
  rows: OpenSessionRow[],
  opts: { budgetMs: number; attemptsPerRow: number },
): Promise<RevocationSummary> {
  const deadline = Date.now() + opts.budgetMs;
  const summary: RevocationSummary = { requested: rows.length, revoked: 0, charged: 0, blocked: 0, stillPending: 0 };

  for (const row of rows) {
    if (Date.now() >= deadline) { summary.stillPending++; continue; }
    let outcome: ProviderOutcome | null = null;
    for (let attempt = 0; attempt < opts.attemptsPerRow; attempt++) {
      if (Date.now() >= deadline) break;
      outcome = await expireOneSession(row);
      if (outcome.kind !== 'retryable') break;
    }
    if (!outcome) { summary.stillPending++; continue; }

    await applyProviderOutcome(row, outcome);
    if (outcome.kind === 'revoked') summary.revoked++;
    else if (outcome.kind === 'charged') { summary.charged++; alertRevocation('charged_repair', row, outcome.providerCode); }
    else if (outcome.kind === 'blocked') { summary.blocked++; alertRevocation('blocked', row, `${outcome.providerCode}: ${outcome.message}`); }
    else summary.stillPending++;
  }
  return summary;
}

/**
 * Phases 1 + 2 for one invoice. The CALLER then runs its own transition and
 * calls {@link assertInvoiceSessionsRevoked} inside that transaction.
 *
 * Never throws on a provider failure: a refusal is the transition's decision,
 * taken against the durable row state, not against this return value.
 */
export async function requestInvoiceSessionRevocation(input: {
  invoiceId: string;
  reason: RevocationReason;
  requestedByUserId: string | null;
  /** See {@link recordRevocationIntent} — the cross-tenant write gate. */
  actor?: InvoiceActor;
  budgetMs?: number;
}): Promise<RevocationSummary> {
  const rows = await recordRevocationIntent(input);
  if (rows.length === 0) {
    return { requested: 0, revoked: 0, charged: 0, blocked: 0, stillPending: 0 };
  }
  return runProviderPhase(rows, {
    budgetMs: input.budgetMs ?? REQUEST_PROVIDER_BUDGET_MS,
    attemptsPerRow: EXPIRE_ATTEMPTS_PER_REQUEST,
  });
}

/**
 * PHASE 3 gate. Call INSIDE the transition's own transaction, after the invoice
 * row is locked, so a session minted between phase 2 and the transition cannot
 * slip through.
 *
 * `observe` mode still writes the intent and still calls Stripe; it only refuses
 * to refuse. That is the incident de-escalation lever — never a migration revert.
 */
export type RevocationDbExecutor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

export async function assertInvoiceSessionsRevoked(
  invoiceId: string, dbc: RevocationDbExecutor = db,
): Promise<void> {
  const unresolved = await dbc.select({
    id: invoiceStripePayments.id,
    revocationState: invoiceStripePayments.revocationState,
    revocationReason: invoiceStripePayments.revocationReason,
  }).from(invoiceStripePayments)
    .where(and(
      eq(invoiceStripePayments.invoiceId, invoiceId),
      eq(invoiceStripePayments.stripeObjectType, 'checkout_session'),
      eq(invoiceStripePayments.status, 'pending'),
      isNull(invoiceStripePayments.invoicePaymentId),
      sql`${invoiceStripePayments.revocationState} <> 'revoked'`,
    ));

  const blocking = unresolved.filter((r) => !isOperatorAbandoned(r.revocationState, r.revocationReason));
  if (blocking.length === 0) return;

  if (stripeSessionRevocationMode() === 'observe') {
    console.warn('[stripeSessionRevocation] observe mode — allowing a transition with unrevoked Checkout sessions', {
      invoiceId, unresolved: blocking.map((r) => ({ id: r.id, state: r.revocationState })),
    });
    return;
  }
  throw new InvoiceServiceError(REVOCATION_PENDING_MESSAGE, 503, REVOCATION_PENDING_CODE);
}

function isOperatorAbandoned(state: string, reason: string | null): boolean {
  return state === 'revocation_blocked' && (reason ?? '').startsWith(ABANDONED_REASON_PREFIX);
}

/**
 * Producer gate. A session must never be minted for an invoice whose existing
 * sessions are mid-revocation — that is precisely the window the intent exists
 * to close. Read-only, safe under any scope that can see the mapping rows.
 */
export async function assertNoPendingRevocation(invoiceId: string): Promise<void> {
  const [pending] = await db.select({ id: invoiceStripePayments.id })
    .from(invoiceStripePayments)
    .where(and(
      eq(invoiceStripePayments.invoiceId, invoiceId),
      eq(invoiceStripePayments.stripeObjectType, 'checkout_session'),
      eq(invoiceStripePayments.revocationState, 'revocation_requested'),
    ))
    .limit(1);
  if (!pending) return;
  if (stripeSessionRevocationMode() === 'observe') {
    console.warn('[stripeSessionRevocation] observe mode — minting a session while a revocation is pending', { invoiceId });
    return;
  }
  throw new InvoiceServiceError(
    'A payment link for this invoice is still being revoked — try again in a moment.',
    409, REVOCATION_PENDING_CODE,
  );
}

/**
 * Operator override: an MSP whose Stripe account is gone forever must still be
 * able to void. Explicit, permissioned and audited — never implicit.
 */
export async function abandonInvoiceSessionRevocation(input: {
  invoiceId: string;
  reason: string;
  actorUserId: string | null;
}): Promise<{ abandoned: number; orgId: string | null }> {
  return runOutsideDbContext(() => withSystemDbAccessContext(async () => {
    const now = new Date();
    const rows = await db.update(invoiceStripePayments)
      .set({
        revocationState: 'revocation_blocked',
        revocationReason: `${ABANDONED_REASON_PREFIX}: ${input.reason}`.slice(0, 2000),
        revocationRequestedByUserId: input.actorUserId,
        revocationNextAttemptAt: null,
        updatedAt: now,
      })
      .where(and(
        eq(invoiceStripePayments.invoiceId, input.invoiceId),
        eq(invoiceStripePayments.stripeObjectType, 'checkout_session'),
        eq(invoiceStripePayments.status, 'pending'),
        isNull(invoiceStripePayments.invoicePaymentId),
        // `charged_repair` is included: a session Stripe reported PAID but whose
        // capture can never be recorded locally would otherwise block the invoice
        // forever with no escape. Abandoning it is the operator saying "I have
        // reconciled this charge by hand" — audited, and `revocation_last_provider_code`
        // keeps the `already_paid` history on the row. A settled one is excluded
        // anyway by the status/invoice_payment_id filters above, where #5180's
        // applied-payments guard is the right owner of the refusal.
        sql`${invoiceStripePayments.revocationState} IN ('active', 'revocation_requested', 'revocation_blocked', 'charged_repair', 'legacy_unbounded')`,
      ))
      .returning({ id: invoiceStripePayments.id, orgId: invoiceStripePayments.orgId });

    if (rows.length > 0) {
      await writeAuditEventAsync(requestLikeFromSnapshot({}), {
        orgId: rows[0]!.orgId,
        action: 'invoice.stripe_session_abandoned',
        resourceType: 'invoice',
        resourceId: input.invoiceId,
        actorType: input.actorUserId ? 'user' : 'system',
        actorId: input.actorUserId,
        result: 'success',
        details: { reason: input.reason, sessionCount: rows.length },
      });
    }
    return { abandoned: rows.length, orgId: rows[0]?.orgId ?? null };
  }));
}

/**
 * A session we asked to die reported PAID. Provider truth wins — park the row
 * for human reconciliation and alert. Idempotent; safe from any settle path.
 * Caller supplies a system context.
 */
export async function markSessionChargedRepair(stripeObjectId: string, detail: string): Promise<boolean> {
  const now = new Date();
  const rows = await db.update(invoiceStripePayments)
    .set({
      revocationState: 'charged_repair',
      revocationLastProviderCode: 'already_paid',
      revocationLastError: detail.slice(0, 2000),
      revocationNextAttemptAt: null,
      updatedAt: now,
    })
    .where(and(
      eq(invoiceStripePayments.stripeObjectId, stripeObjectId),
      sql`${invoiceStripePayments.revocationState} IN ('revocation_requested', 'revoked', 'revocation_blocked')`,
    ))
    .returning({ id: invoiceStripePayments.id, orgId: invoiceStripePayments.orgId, invoiceId: invoiceStripePayments.invoiceId });
  if (rows.length === 0) return false;
  captureException(
    new Error(`[stripeSessionRevocation] charged_repair session=${stripeObjectId}: ${detail}`),
    undefined,
    { stripe_revocation_stage: 'charged_repair', org_id: rows[0]!.orgId },
  );
  return true;
}

/**
 * Record revocation intent for the OTHER open sessions on an invoice after one
 * of them captured, using the CALLER'S transaction handle.
 *
 * The capture already cleared the balance those siblings were minted to
 * collect, so each is a second charge waiting to happen. This is intent ONLY —
 * the provider call belongs to the sweep — and that is not a shortcut:
 *
 *   `recordStripePayment` holds the invoice row FOR UPDATE, and its caller
 *   (`settleCheckoutSession` via the portal return route, or the reconcile
 *   sweep) has already opened the enclosing system context, so the "post-commit"
 *   half of that function still runs INSIDE the transaction. Escaping with
 *   `runOutsideDbContext` to take the same invoice lock on a second pooled
 *   connection self-deadlocks: the new connection waits for a lock the caller
 *   will not release until the new connection returns. Participating in the
 *   caller's transaction (no escape, no second lock) is the only safe shape.
 *
 * A revocation failure must never fail a capture, and here it structurally
 * cannot: nothing is called out to Stripe.
 */
export async function markSiblingRevocationIntentInTx(
  invoiceId: string, settledStripeObjectId: string, dbc: RevocationDbExecutor = db,
): Promise<number> {
  const rows = await dbc.update(invoiceStripePayments)
    .set({
      revocationState: 'revocation_requested',
      revocationReason: 'sibling_settled',
      revocationRequestedAt: sql`COALESCE(${invoiceStripePayments.revocationRequestedAt}, now())`,
      revocationNextAttemptAt: sql`now()`,
      updatedAt: new Date(),
    })
    .where(and(
      eq(invoiceStripePayments.invoiceId, invoiceId),
      eq(invoiceStripePayments.stripeObjectType, 'checkout_session'),
      eq(invoiceStripePayments.status, 'pending'),
      isNull(invoiceStripePayments.invoicePaymentId),
      sql`${invoiceStripePayments.stripeObjectId} <> ${settledStripeObjectId}`,
      inArray(invoiceStripePayments.revocationState, [...OPEN_REVOCATION_STATES]),
    ))
    .returning({ id: invoiceStripePayments.id });
  return rows.length;
}

/**
 * Invoice ids with at least one open Checkout session on a given connected
 * account. The account, not the partner, is the unit: a rotation only has to
 * account for sessions the OUTGOING key minted.
 */
export async function listInvoicesWithOpenSessionsForAccount(
  stripeAccountId: string,
): Promise<string[]> {
  const rows = await db.selectDistinct({ invoiceId: invoiceStripePayments.invoiceId })
    .from(invoiceStripePayments)
    .where(and(
      eq(invoiceStripePayments.stripeAccountId, stripeAccountId),
      eq(invoiceStripePayments.stripeObjectType, 'checkout_session'),
      eq(invoiceStripePayments.status, 'pending'),
      isNull(invoiceStripePayments.invoicePaymentId),
      inArray(invoiceStripePayments.revocationState, [...OPEN_REVOCATION_STATES]),
    ));
  return rows.map((r) => r.invoiceId);
}

/** Sessions on this account that are still not provably dead. */
export async function countUnresolvedSessionsForAccount(stripeAccountId: string): Promise<number> {
  const rows = await db.select({ id: invoiceStripePayments.id })
    .from(invoiceStripePayments)
    .where(and(
      eq(invoiceStripePayments.stripeAccountId, stripeAccountId),
      eq(invoiceStripePayments.stripeObjectType, 'checkout_session'),
      eq(invoiceStripePayments.status, 'pending'),
      isNull(invoiceStripePayments.invoicePaymentId),
      inArray(invoiceStripePayments.revocationState, [...OPEN_REVOCATION_STATES]),
    ));
  return rows.length;
}

/**
 * Revoke every open Checkout session on one connected account.
 *
 * Used by the credential transitions (key rotation, disconnect), which are
 * account-scoped rather than invoice-scoped. Each invoice still gets its own
 * intent transaction and its own row lock — never one long transaction across
 * a partner's whole invoice book.
 *
 * Must run with NO ambient DB context.
 */
export async function revokeOpenSessionsForAccount(input: {
  stripeAccountId: string;
  reason: RevocationReason;
  requestedByUserId: string | null;
  budgetMs?: number;
  attemptsPerRow?: number;
}): Promise<RevocationSummary> {
  const invoiceIds = await runOutsideDbContext(() =>
    withSystemDbAccessContext(() => listInvoicesWithOpenSessionsForAccount(input.stripeAccountId)));
  const total: RevocationSummary = { requested: 0, revoked: 0, charged: 0, blocked: 0, stillPending: 0 };
  if (invoiceIds.length === 0) return total;

  const deadline = Date.now() + (input.budgetMs ?? REQUEST_PROVIDER_BUDGET_MS);
  for (const invoiceId of invoiceIds) {
    const rows = (await recordRevocationIntent({
      invoiceId, reason: input.reason, requestedByUserId: input.requestedByUserId,
    })).filter((r) => r.stripeAccountId === input.stripeAccountId);
    total.requested += rows.length;
    if (rows.length === 0) continue;
    const remaining = deadline - Date.now();
    const summary = await runProviderPhase(rows, {
      budgetMs: Math.max(0, remaining),
      attemptsPerRow: input.attemptsPerRow ?? EXPIRE_ATTEMPTS_PER_REQUEST,
    });
    total.revoked += summary.revoked;
    total.charged += summary.charged;
    total.blocked += summary.blocked;
    total.stillPending += summary.stillPending;
  }
  return total;
}

/**
 * Stamp revocation intent for every open session on an account using the
 * CALLER'S transaction handle — no context escape, no invoice row lock.
 *
 * Exists for the disconnect path only, which inverts the three-phase order:
 * the intent, the credential archive and the live-key wipe must commit
 * ATOMICALLY, so that an operator killing their Stripe integration can never
 * end up with a wiped key and no record that the open sessions were meant to
 * die. Skipping the invoice row lock is safe precisely because disconnect never
 * refuses: nothing downstream reads this as proof, it only feeds the sweep.
 * Every other caller must use {@link recordRevocationIntent}.
 */
export async function markRevocationIntentForAccountInTx(input: {
  stripeAccountId: string;
  reason: RevocationReason;
  requestedByUserId: string | null;
  dbc?: RevocationDbExecutor;
}): Promise<number> {
  const dbc = input.dbc ?? db;
  const rows = await dbc.update(invoiceStripePayments)
    .set({
      revocationState: 'revocation_requested',
      revocationReason: input.reason,
      revocationRequestedAt: sql`COALESCE(${invoiceStripePayments.revocationRequestedAt}, now())`,
      revocationRequestedByUserId: input.requestedByUserId,
      revocationNextAttemptAt: sql`now()`,
      updatedAt: new Date(),
    })
    .where(and(
      eq(invoiceStripePayments.stripeAccountId, input.stripeAccountId),
      eq(invoiceStripePayments.stripeObjectType, 'checkout_session'),
      eq(invoiceStripePayments.status, 'pending'),
      isNull(invoiceStripePayments.invoicePaymentId),
      inArray(invoiceStripePayments.revocationState, [...OPEN_REVOCATION_STATES]),
    ))
    .returning({ id: invoiceStripePayments.id });
  return rows.length;
}

export interface PartnerRevocationHealth {
  /** Sessions parked in `revocation_blocked` — payable state unknown/unrepaired. */
  blocked: number;
  /** Of those, the ones whose credential is gone: the partner must reissue links. */
  credentialUnavailable: number;
  /** Sessions Stripe reported PAID after we asked them to die. Needs a human. */
  chargedRepair: number;
  /** Intent recorded but not yet confirmed dead — the sweep is still working. */
  pending: number;
}

/**
 * Revocation health for the partner's Stripe settings card.
 *
 * `credentialUnavailable` is the only class the PARTNER can act on (reissue the
 * affected links), which is why it is counted separately and surfaced in the
 * card banner rather than mailed out proactively. Caller supplies a SYSTEM
 * context: `invoice_stripe_payments` is org-axis and the partner binding only
 * exists on `invoices`.
 */
export async function getPartnerRevocationHealth(partnerId: string): Promise<PartnerRevocationHealth> {
  const rows = await db.select({
    revocationState: invoiceStripePayments.revocationState,
    revocationReason: invoiceStripePayments.revocationReason,
  }).from(invoiceStripePayments)
    .innerJoin(invoices, eq(invoices.id, invoiceStripePayments.invoiceId))
    .where(and(
      eq(invoices.partnerId, partnerId),
      eq(invoiceStripePayments.stripeObjectType, 'checkout_session'),
      inArray(invoiceStripePayments.revocationState, ['revocation_requested', 'revocation_blocked', 'charged_repair']),
    ));

  const health: PartnerRevocationHealth = { blocked: 0, credentialUnavailable: 0, chargedRepair: 0, pending: 0 };
  for (const row of rows) {
    if (row.revocationState === 'charged_repair') { health.chargedRepair++; continue; }
    if (row.revocationState === 'revocation_requested') { health.pending++; continue; }
    // revocation_blocked. An operator-abandoned row is a decision, not a defect.
    if (isOperatorAbandoned(row.revocationState, row.revocationReason)) continue;
    health.blocked++;
    if (row.revocationReason === 'credential_unavailable') health.credentialUnavailable++;
  }
  return health;
}


/**
 * Mark ONE just-written session mapping `revocation_requested` on the caller's
 * transaction handle.
 *
 * The producers' raced branch uses this instead of {@link recordRevocationIntent}.
 * That function escapes with `runOutsideDbContext` and takes the invoice row
 * `FOR UPDATE` — which self-deadlocks here: `withDbAccessContext` short-circuits
 * inside a request, so the mapping INSERT that just ran landed on the CALLER's
 * open transaction and, through the `invoice_id` FK, already holds `FOR KEY
 * SHARE` on that invoice row (#3911). A second pooled connection asking for
 * `FOR UPDATE` would wait on a transaction that cannot commit until it returns,
 * and Postgres sees no cycle to break because the first side is waiting on the
 * application, not on a lock.
 *
 * Not every producer call sits in a request transaction — the three pay routes
 * are self-managed (#1448) — but `create_pay_link` (AI tools) and the public
 * invoice-link route are not, so the safe shape is the only shape.
 */
export async function markSessionRevocationRequestedInTx(
  stripeObjectId: string, reason: RevocationReason, requestedByUserId: string | null,
  dbc: RevocationDbExecutor = db,
): Promise<number> {
  const rows = await dbc.update(invoiceStripePayments)
    .set({
      revocationState: 'revocation_requested',
      revocationReason: reason,
      revocationRequestedAt: sql`COALESCE(${invoiceStripePayments.revocationRequestedAt}, now())`,
      revocationRequestedByUserId: requestedByUserId,
      revocationNextAttemptAt: sql`now()`,
      updatedAt: new Date(),
    })
    .where(and(
      eq(invoiceStripePayments.stripeObjectId, stripeObjectId),
      inArray(invoiceStripePayments.revocationState, [...OPEN_REVOCATION_STATES]),
    ))
    .returning({ id: invoiceStripePayments.id });
  return rows.length;
}

/**
 * Re-arm sessions that were parked `revocation_blocked` by a dead or
 * under-scoped credential, after a new key is saved.
 *
 * Without this, `revocation_blocked` is absorbing: nothing re-selects it, the
 * sweep only drains `revocation_requested`, and one transient auth blip would
 * brick the invoice until an operator used the abandon route. A partner who has
 * just pasted a working key has supplied exactly the thing that was missing.
 *
 * Operator-abandoned rows are deliberately left alone — that was a decision, not
 * a defect, and re-arming it would silently re-block a transition the operator
 * already accepted.
 */
export async function rearmBlockedRevocationsForAccount(stripeAccountId: string): Promise<number> {
  const rows = await db.update(invoiceStripePayments)
    .set({
      revocationState: 'revocation_requested',
      revocationAttempts: 0,
      revocationNextAttemptAt: sql`now()`,
      revocationRequestedAt: sql`now()`,
      updatedAt: new Date(),
    })
    .where(and(
      eq(invoiceStripePayments.stripeAccountId, stripeAccountId),
      eq(invoiceStripePayments.stripeObjectType, 'checkout_session'),
      eq(invoiceStripePayments.status, 'pending'),
      isNull(invoiceStripePayments.invoicePaymentId),
      eq(invoiceStripePayments.revocationState, 'revocation_blocked'),
      sql`COALESCE(${invoiceStripePayments.revocationReason}, '') NOT LIKE ${`${ABANDONED_REASON_PREFIX}%`}`,
    ))
    .returning({ id: invoiceStripePayments.id });
  return rows.length;
}
