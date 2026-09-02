/**
 * The ONE sanctioned entry to `AccountingProvider.createPayment`/`deletePayment`
 * (Phase D2 — docs/superpowers/specs/billing/2026-09-02-quickbooks-phase-d2-payment-push-design.md).
 *
 * THE MAPPING ROW IS THE OUTBOX (spec decision 1). `requestPaymentPush` /
 * `requestPaymentDelete` run INSIDE the caller's already-locked payment
 * transaction and write `pending_op`; the BullMQ enqueue that follows is only a
 * latency optimisation. A lost enqueue — Redis down, the process dying between
 * commit and `add()`, a savepoint not yet committed — is recovered by the
 * 15-minute reconcile sweep, which re-enqueues every stale `pending_op` row. The
 * mapping is NEVER cleared until QuickBooks confirms, so a delete cannot be lost
 * even after BullMQ exhausts its attempts.
 *
 * EXCLUSIVE CLAIM BY LEASE (spec decision 2). A worker claims a row with a
 * compare-and-set — `SET claimed_at = now() WHERE id = ? AND pending_op = ? AND
 * (claimed_at IS NULL OR claimed_at < now() - 10 min)`. Zero rows means somebody
 * else holds it: `sync_in_progress`, retryable. The Phase C upsert idiom is not
 * enough here because it only excludes racing INSERTs, and a payment row can be
 * re-entered by the sweep while a webhook-triggered job is still running.
 *
 * THIS MODULE NEVER TOUCHES REDIS. Every function returns the mapping ids that
 * are owed an enqueue and lets the CALLER do the `add()` after its transaction
 * returns. That keeps BullMQ out of `invoiceService`'s locked transactions, out
 * of this module's unit tests, and out of any code path holding a row lock.
 *
 * DB ACCESS CONTRACT (verbatim from `accountingInvoicePush.ts`, the Phase-C
 * coordinator this module mirrors). `pushPaymentToAccounting` /
 * `deletePaymentInAccounting` MUST be entered with NO ambient DB access context
 * (asserted) and take a `runInDbContext` runner instead. Each DB phase is one
 * SHORT invocation of that runner — a real transaction that commits on its own —
 * and no context is ever open across a QuickBooks call:
 *
 *   Phase 1  lease CAS, connection, payment + invoice, mappings, currency guard,
 *            payload build                                          [COMMITS]
 *   ─ token resolution, then the QBO create/delete — nothing held ─
 *   Phase 2  invoice FOR UPDATE, re-read, stamp / convert / diverge  [COMMITS]
 *
 * The split is load-bearing. Held inside ONE caller-opened transaction, every
 * write that records a FAILURE would be a savepoint that rolls back the instant
 * this coordinator throws: the operator sees no error at all, the lease is never
 * released, and a pooled Postgres connection sits idle-in-transaction across the
 * whole QuickBooks round trip (#1105). Phase 1 exploits the same property in the
 * OTHER direction — a typed refusal that must NOT be recorded simply throws, and
 * the rolled-back transaction un-claims the lease for free; a refusal that MUST
 * be recorded returns a value so its write commits, and the throw happens after
 * the runner returns.
 */

import { and, eq, inArray, isNull, lt, or } from 'drizzle-orm';
import { db, runOutsideDbContext } from '../../db';
import { accountingConnections, accountingEntityMappings, invoicePayments, invoices } from '../../db/schema';
import type { AccountingEntityMapping as AccountingEntityMappingRow } from '../../db/schema';
import { assertNoAmbientDbContext, type DbContextRunner } from './dbContextGuard';
import { AccountingMappingError, resolveConnection, resolveLiveConnection } from './accountingMappingService';
import {
  AccountingCurrencyContractError,
  assertAccountingInvoicePushCurrency,
  normalizeCurrencyCode,
} from './accountingCurrency';
// The marker module is a dependency-free LEAF. Importing `accountingPaymentPull`
// here instead would close a cycle: invoiceService -> this module -> pull ->
// invoiceService (pull needs `recomputeInvoiceStatus`).
import { buildPaymentPrivateNote, paymentMappingRemoteId } from './accountingPaymentMarker';
import { getAccountingProvider } from './providerRegistry';
import { requestLikeFromSnapshot, writeAuditEvent } from '../auditEvents';
import { captureException } from '../sentry';
import type { AccountingConnection } from './accountingConnectionService';
import type { AccountingPaymentPayload, PaymentDeleteResult, RemoteRef } from './types';

/** Worker lease window (spec decision 2). A job that dies mid-flight frees its
 *  claim after this long, and the sweep re-enqueues it. */
export const PAYMENT_CLAIM_LEASE_MS = 10 * 60 * 1000;
/** A row must be at least this stale before the sweep re-enqueues it, so the
 *  sweep never races the immediate enqueue the caller just made. */
export const PAYMENT_SWEEP_MIN_AGE_MS = 2 * 60 * 1000;
/** QuickBooks caps PaymentRefNum at 21 characters and REJECTS a longer one. */
export const PAYMENT_REF_MAX_LENGTH = 21;

export const PAYMENT_PUSH_DISABLED_MESSAGE = 'Payment push is disabled for this QuickBooks connection';

export function partialRefundDivergenceMessage(amount: string): string {
  return `Partially refunded in Stripe (${amount}); record the refund in QuickBooks`;
}

export type AccountingPaymentPushErrorCode =
  | 'not_connected' | 'reauth_required'
  | 'push_disabled'
  | 'sync_in_progress'
  | 'invoice_not_synced'
  | 'invoice_void'
  | 'customer_not_mapped'
  | 'home_currency_unknown' | 'currency_mismatch'
  | 'quickbooks_error'
  | 'record_failed';

export class AccountingPaymentPushError extends Error {
  constructor(
    public readonly code: AccountingPaymentPushErrorCode,
    public readonly status: 404 | 409 | 502,
    message: string,
  ) {
    super(message);
    this.name = 'AccountingPaymentPushError';
  }
}

/**
 * `payment_gone` is an OUTCOME, not an error code: nothing failed and nothing is
 * left undone — the mapping row is either deleted (nothing existed remotely) or
 * flipped to `pending_op = 'delete'`. Throwing a terminal error with no durable
 * row to stamp it on would produce a Sentry event and no operator-visible state.
 */
export type PaymentPushOutcome =
  | 'pushed' | 'already_adopted' | 'converted_to_delete' | 'diverged'
  | 'payment_gone' | 'nothing_owed';
export type PaymentDeleteOutcome = 'deleted' | 'already_absent' | 'nothing_owed';

/** Same shape as invoiceService's own DbExecutor: the ambient `db` proxy (which,
 *  inside an open access context, IS the transaction handle) or a drizzle tx handle. */
export type PaymentMappingExecutor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

type MappingRow = AccountingEntityMappingRow;
type InvoiceRow = typeof invoices.$inferSelect;
type PaymentRow = typeof invoicePayments.$inferSelect;

const SYNCED_INVOICE_STATUSES = new Set(['synced', 'synced_with_tax_variance']);

function sanitizePaymentSyncErrorMessage(err: unknown): string {
  const status = err && typeof err === 'object' && typeof (err as { status?: unknown }).status === 'number'
    ? (err as { status: number }).status
    : undefined;
  return status ? `QuickBooks rejected the payment sync (HTTP ${status})` : 'QuickBooks rejected the payment sync';
}

/** `resolveConnection`/`resolveLiveConnection` throw the mapping-service error
 *  hierarchy; only the two codes they can actually raise are re-typed. */
function translateMappingError(err: unknown): never {
  if (err instanceof AccountingMappingError) {
    if (err.code === 'not_connected') throw new AccountingPaymentPushError('not_connected', 404, err.message);
    if (err.code === 'reauth_required') throw new AccountingPaymentPushError('reauth_required', 409, err.message);
    throw new AccountingPaymentPushError('quickbooks_error', err.status, err.message);
  }
  throw err;
}

/**
 * RETURNS the typed error rather than throwing it: the currency refusal must be
 * STAMPED on the mapping row before it is raised, and phase 1 can only stamp
 * inside its own transaction. Anything that is not a currency-contract failure
 * is a bug here and propagates unchanged.
 */
function toCurrencyPushError(err: unknown, conn: AccountingConnection): AccountingPaymentPushError {
  if (!(err instanceof AccountingCurrencyContractError)) throw err;
  if (err.code === 'ACCOUNTING_HOME_CURRENCY_UNKNOWN') {
    return new AccountingPaymentPushError('home_currency_unknown', 409, err.message);
  }
  const home = normalizeCurrencyCode(conn.homeCurrency);
  return new AccountingPaymentPushError(
    'currency_mismatch',
    409,
    `${err.message} Record this payment in ${home ?? 'the connected home currency'} or reconcile it in QuickBooks by hand.`,
  );
}

// ---------------------------------------------------------------------------
// Loads + mapping-row primitives (partner-scoped at the SQL level wherever a
// partner id is in hand: RLS is stricter than the app layer, and a missing
// partner filter is a cross-tenant read waiting for a system-context caller)
// ---------------------------------------------------------------------------

/**
 * The payment's mapping row, looked up the way its DESTROYERS know it: by the
 * `invoice_payments` id alone. `voidPayment`/`reflectStripeRefund` hold no
 * partner id, and `(breeze_entity_type, breeze_entity_id)` is already unique per
 * connection; RLS scopes the read to the caller's partner.
 */
async function loadPaymentMappingByPaymentId(
  tx: PaymentMappingExecutor,
  invoicePaymentId: string,
): Promise<MappingRow | null> {
  const rows = await tx
    .select()
    .from(accountingEntityMappings)
    .where(and(
      eq(accountingEntityMappings.breezeEntityType, 'payment'),
      eq(accountingEntityMappings.breezeEntityId, invoicePaymentId),
    ))
    .limit(1);
  return (rows as MappingRow[])[0] ?? null;
}

async function loadMappingById(mappingId: string, partnerId: string): Promise<MappingRow | null> {
  const rows = await db
    .select()
    .from(accountingEntityMappings)
    .where(and(
      eq(accountingEntityMappings.id, mappingId),
      eq(accountingEntityMappings.partnerId, partnerId),
    ))
    .limit(1);
  return (rows as MappingRow[])[0] ?? null;
}

async function loadTypedMapping(
  tx: PaymentMappingExecutor,
  integrationId: string,
  partnerId: string,
  breezeEntityType: 'invoice' | 'org',
  breezeEntityId: string,
): Promise<MappingRow | null> {
  const rows = await tx
    .select()
    .from(accountingEntityMappings)
    .where(and(
      eq(accountingEntityMappings.integrationId, integrationId),
      eq(accountingEntityMappings.partnerId, partnerId),
      eq(accountingEntityMappings.breezeEntityType, breezeEntityType),
      eq(accountingEntityMappings.breezeEntityId, breezeEntityId),
    ))
    .limit(1);
  return (rows as MappingRow[])[0] ?? null;
}

/** The partner's connected QuickBooks connection, or null. Read through the
 *  CALLER's handle so it participates in the caller's transaction. */
async function loadConnectedConnection(
  tx: PaymentMappingExecutor,
  partnerId: string,
): Promise<{ id: string; pushMode: string; pushPayments: boolean } | null> {
  const rows = await tx
    .select({
      id: accountingConnections.id,
      pushMode: accountingConnections.pushMode,
      pushPayments: accountingConnections.pushPayments,
    })
    .from(accountingConnections)
    .where(and(
      eq(accountingConnections.partnerId, partnerId),
      eq(accountingConnections.provider, 'quickbooks'),
      eq(accountingConnections.status, 'connected'),
    ))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Inserts the pending Breeze-origin `payment` mapping, or reports that somebody
 * already owns this payment.
 *
 * `onConflictDoNothing`, NOT a caught unique violation: this runs inside the
 * CALLER's payment transaction, and a real 23505 would abort that transaction —
 * undoing an `invoice_payments` row an operator (or Stripe) already committed.
 * Zero rows back means a mapping exists; there is nothing to enqueue.
 */
async function insertPendingPushMapping(
  tx: PaymentMappingExecutor,
  integrationId: string,
  partnerId: string,
  invoicePaymentId: string,
): Promise<string | null> {
  const rows = await tx
    .insert(accountingEntityMappings)
    .values({
      integrationId,
      partnerId,
      breezeEntityType: 'payment',
      breezeEntityId: invoicePaymentId,
      remoteEntityType: 'Payment',
      remoteEntityId: null,
      breezeOrigin: true,
      linkStatus: 'create_new',
      syncStatus: 'pending',
      pendingOp: 'push',
    })
    .onConflictDoNothing({
      target: [
        accountingEntityMappings.integrationId,
        accountingEntityMappings.breezeEntityType,
        accountingEntityMappings.breezeEntityId,
      ],
    })
    .returning({ id: accountingEntityMappings.id });
  return (rows as Array<{ id: string }>)[0]?.id ?? null;
}

async function deleteMappingRow(tx: PaymentMappingExecutor, mappingId: string): Promise<number> {
  const rows = await tx
    .delete(accountingEntityMappings)
    .where(eq(accountingEntityMappings.id, mappingId))
    .returning({ id: accountingEntityMappings.id });
  return rows.length;
}

async function loadPaymentRow(invoicePaymentId: string): Promise<PaymentRow | null> {
  const rows = await db
    .select()
    .from(invoicePayments)
    .where(eq(invoicePayments.id, invoicePaymentId))
    .limit(1);
  return (rows as PaymentRow[])[0] ?? null;
}

async function loadOwnedInvoice(invoiceId: string, partnerId: string): Promise<InvoiceRow | null> {
  const rows = await db
    .select()
    .from(invoices)
    .where(and(eq(invoices.id, invoiceId), eq(invoices.partnerId, partnerId)))
    .limit(1);
  return (rows as InvoiceRow[])[0] ?? null;
}

/** The invoice row, LOCKED. Partner-guarded: a mapping can outlive an erased org. */
async function lockOwnedInvoice(invoiceId: string, partnerId: string): Promise<InvoiceRow | null> {
  const rows = await db
    .select()
    .from(invoices)
    .where(and(eq(invoices.id, invoiceId), eq(invoices.partnerId, partnerId)))
    .limit(1)
    .for('update');
  return (rows as InvoiceRow[])[0] ?? null;
}

// ---------------------------------------------------------------------------
// requestPaymentPush / requestPaymentDelete — called INSIDE the caller's
// already-locked payment transaction
// ---------------------------------------------------------------------------

/**
 * Record that a freshly-inserted Breeze payment owes QuickBooks a create.
 *
 * Called by `invoiceService.recordPayment` and `stripeReconcile.recordStripePayment`
 * inside their locked transaction, immediately after the `invoice_payments`
 * insert. Returns the mapping id the caller must enqueue a `push-payment` job
 * for once its transaction returns, or `null` when nothing is owed.
 *
 * Manual push mode returns null on purpose: the invoice's own manual "Push to
 * QuickBooks" fans its payments out afterwards (`fanOutOwedPayments`), so an
 * operator who has opted out of automatic pushes does not get automatic ones
 * through the payment door instead.
 *
 * Inside a REQUEST context the caller's transaction is a savepoint, so the
 * worker can start before it commits and see no mapping row at all. That is why
 * "mapping not found" is retryable in the coordinator, never terminal.
 */
export async function requestPaymentPush(
  tx: PaymentMappingExecutor,
  params: { invoicePaymentId: string; invoiceId: string; partnerId: string },
): Promise<string | null> {
  const conn = await loadConnectedConnection(tx, params.partnerId);
  if (!conn || !conn.pushPayments || conn.pushMode !== 'auto') return null;

  const invoiceMapping = await loadTypedMapping(tx, conn.id, params.partnerId, 'invoice', params.invoiceId);
  if (!invoiceMapping?.remoteEntityId) return null;
  if (!SYNCED_INVOICE_STATUSES.has(invoiceMapping.syncStatus)) return null;

  return insertPendingPushMapping(tx, conn.id, params.partnerId, params.invoicePaymentId);
}

/**
 * A Breeze payment row is about to be destroyed — do the right thing with its
 * accounting mapping. The single destroyer-side helper (it REPLACES Phase D's
 * `clearPaymentMappingForInvoicePayment`, which only ever deleted the row).
 *
 * Called by `invoiceService.voidPayment` and `stripeReconcile`'s full-refund
 * branch, BEFORE the `invoice_payments` delete, inside the transaction that
 * already holds the invoice lock. `breeze_entity_id` is polymorphic, so there is
 * no FK to cascade: without this call the mapping outlives its payment and a
 * later CDC delivery for the same QuickBooks Payment reads as "already applied"
 * and silently skips.
 *
 * Three cases:
 *  - Breeze-origin WITH a remote id -> keep the row, flip `pending_op='delete'`.
 *    Breeze created that Payment in QuickBooks, so Breeze owns its removal —
 *    regardless of `push_mode` or `push_payments` (spec decision 10).
 *  - Breeze-origin with NO remote id -> delete the row. Nothing exists in
 *    QuickBooks. If a create is in flight right now, its phase 2 finds the
 *    payment row gone and converts ITSELF to a delete (spec decision 7), so
 *    nothing is stranded.
 *  - QuickBooks-origin -> delete the row, as Phase D always did. The pull's
 *    reversal path owns those; asking QuickBooks to delete its own payment
 *    because Breeze voided a mirror of it would be backwards.
 *
 * Returns the mapping id to enqueue a `delete-payment` job for, or `null`.
 * Zero rows is LEGITIMATE and deliberately not a throw: a manual or Stripe
 * payment usually has no accounting mapping at all.
 */
export async function requestPaymentDelete(
  tx: PaymentMappingExecutor,
  invoicePaymentId: string,
): Promise<string | null> {
  const mapping = await loadPaymentMappingByPaymentId(tx, invoicePaymentId);
  if (!mapping) return null;

  if (!mapping.breezeOrigin || !mapping.remoteEntityId) {
    await deleteMappingRow(tx, mapping.id);
    return null;
  }

  const rows = await tx
    .update(accountingEntityMappings)
    .set({
      pendingOp: 'delete',
      syncStatus: 'pending',
      claimedAt: null,
      lastError: null,
      updatedAt: new Date(),
    })
    .where(and(
      eq(accountingEntityMappings.id, mapping.id),
      eq(accountingEntityMappings.partnerId, mapping.partnerId),
    ))
    .returning({ id: accountingEntityMappings.id });
  if (rows.length !== 1) {
    throw new Error(
      `accountingPaymentPush: delete request matched no accounting_entity_mappings row (id=${mapping.id}); `
      + 'refusing to destroy a Breeze payment whose QuickBooks Payment would then be orphaned',
    );
  }
  return mapping.id;
}

// ---------------------------------------------------------------------------
// Lease (spec decision 2)
// ---------------------------------------------------------------------------

/** Compare-and-set claim. Null = somebody else holds it, or nothing is owed. */
async function claimPaymentMapping(
  mappingId: string,
  partnerId: string,
  op: 'push' | 'delete',
  now: Date,
): Promise<MappingRow | null> {
  const leaseCutoff = new Date(now.getTime() - PAYMENT_CLAIM_LEASE_MS);
  const rows = await db
    .update(accountingEntityMappings)
    .set({ claimedAt: now, updatedAt: now })
    .where(and(
      eq(accountingEntityMappings.id, mappingId),
      eq(accountingEntityMappings.partnerId, partnerId),
      eq(accountingEntityMappings.pendingOp, op),
      or(
        isNull(accountingEntityMappings.claimedAt),
        lt(accountingEntityMappings.claimedAt, leaseCutoff),
      ),
    ))
    .returning();
  return (rows as MappingRow[])[0] ?? null;
}

/** Release the lease, keeping `pending_op` — the work is still owed. */
async function releaseLease(mappingId: string, partnerId: string): Promise<void> {
  await db
    .update(accountingEntityMappings)
    .set({ claimedAt: null, updatedAt: new Date() })
    .where(and(
      eq(accountingEntityMappings.id, mappingId),
      eq(accountingEntityMappings.partnerId, partnerId),
    ))
    .returning({ id: accountingEntityMappings.id });
}

/**
 * Stamp a refusal: release the lease, optionally CLEAR `pending_op` (when
 * retrying can never succeed) and record why, so the mapping card shows an
 * operator what to fix. Runs inside the caller's phase-1 transaction, which is
 * why phase 1 RETURNS a recordable refusal instead of throwing it.
 */
async function markPaymentMappingError(
  mappingId: string,
  partnerId: string,
  message: string,
  opts: { clearPendingOp: boolean },
): Promise<void> {
  await db
    .update(accountingEntityMappings)
    .set({
      syncStatus: 'error',
      lastError: message,
      claimedAt: null,
      ...(opts.clearPendingOp ? { pendingOp: null } : {}),
      updatedAt: new Date(),
    })
    .where(and(
      eq(accountingEntityMappings.id, mappingId),
      eq(accountingEntityMappings.partnerId, partnerId),
    ))
    .returning({ id: accountingEntityMappings.id });
}

/** `markPaymentMappingError` in its OWN short, self-committing transaction, and
 *  still best-effort: opening the context can fail (pool exhaustion), and that
 *  must not replace the caller's real typed error with a raw one. Sentry has the
 *  original either way. Mirrors accountingInvoicePush.ts's
 *  `markInvoiceMappingErrorInOwnContext`. */
async function markPaymentMappingErrorInOwnContext(
  runInDbContext: DbContextRunner,
  mappingId: string,
  partnerId: string,
  message: string,
  opts: { clearPendingOp: boolean },
): Promise<void> {
  try {
    await runInDbContext(() => markPaymentMappingError(mappingId, partnerId, message, opts));
  } catch (err) {
    captureException(err instanceof Error ? err : new Error(String(err)), undefined, {
      service: 'accountingPaymentPush', mappingId, partnerId,
    });
  }
}

async function convertToDelete(mappingId: string, partnerId: string): Promise<void> {
  const rows = await db
    .update(accountingEntityMappings)
    .set({ pendingOp: 'delete', syncStatus: 'pending', claimedAt: null, updatedAt: new Date() })
    .where(and(
      eq(accountingEntityMappings.id, mappingId),
      eq(accountingEntityMappings.partnerId, partnerId),
    ))
    .returning({ id: accountingEntityMappings.id });
  if (rows.length !== 1) {
    throw new Error(`accountingPaymentPush: converting mapping ${mappingId} to a delete matched no row`);
  }
}

async function stampRemoteRef(
  mappingId: string,
  partnerId: string,
  remoteEntityId: string,
  remoteSyncToken: string | null,
  state: {
    syncStatus: 'pending' | 'synced' | 'error';
    linkStatus: 'confirmed';
    pendingOp: 'delete' | null;
    lastError: string | null;
    stampSyncedAt?: boolean;
  },
): Promise<void> {
  const rows = await db
    .update(accountingEntityMappings)
    .set({
      remoteEntityId,
      remoteSyncToken,
      linkStatus: state.linkStatus,
      syncStatus: state.syncStatus,
      pendingOp: state.pendingOp,
      claimedAt: null,
      lastError: state.lastError,
      ...(state.stampSyncedAt ? { lastSyncedAt: new Date() } : {}),
      updatedAt: new Date(),
    })
    .where(and(
      eq(accountingEntityMappings.id, mappingId),
      eq(accountingEntityMappings.partnerId, partnerId),
    ))
    .returning({ id: accountingEntityMappings.id });
  if (rows.length !== 1) {
    throw new Error(
      `accountingPaymentPush: stamping the remote ref matched no accounting_entity_mappings row (id=${mappingId}); `
      + 'refusing to lose the QuickBooks payment result',
    );
  }
}

/** Off-request path (worker): the system-scope audit writer, never
 *  writeRouteAudit. Never lets an audit failure undo committed money state. */
function fireAudit(
  conn: AccountingConnection,
  action: 'accounting.payment.pushed' | 'accounting.payment.deleted',
  orgId: string,
  invoiceId: string,
  details: Record<string, unknown>,
): void {
  try {
    writeAuditEvent(requestLikeFromSnapshot({}), {
      orgId,
      action,
      resourceType: 'invoice',
      resourceId: invoiceId,
      actorType: 'system',
      actorId: null,
      result: 'success',
      details: { provider: conn.provider, ...details },
    });
  } catch (err) {
    captureException(err instanceof Error ? err : new Error(String(err)), undefined, {
      service: 'accountingPaymentPush', action, resourceId: invoiceId,
    });
  }
}

// ---------------------------------------------------------------------------
// Sweep query + fan-out
// ---------------------------------------------------------------------------

/**
 * Every mapping row that still owes QuickBooks an operation, is not currently
 * leased, and is old enough that the caller's own immediate enqueue has had
 * time to run.
 *
 * DELIBERATELY connection-agnostic: it does not join `accounting_connections`,
 * because a `delete` must propagate even when both switches are off and even for
 * a connection the reconcile fan-out skipped (spec decision 10). The partial
 * index `accounting_entity_mappings_pending_op_idx` serves it, and the steady
 * state is zero rows.
 */
export async function listOwedPaymentMappings(
  dbc: PaymentMappingExecutor,
  now: Date,
): Promise<Array<{ id: string; partnerId: string; pendingOp: 'push' | 'delete' }>> {
  const leaseCutoff = new Date(now.getTime() - PAYMENT_CLAIM_LEASE_MS);
  const ageCutoff = new Date(now.getTime() - PAYMENT_SWEEP_MIN_AGE_MS);
  const rows = await dbc
    .select({
      id: accountingEntityMappings.id,
      partnerId: accountingEntityMappings.partnerId,
      pendingOp: accountingEntityMappings.pendingOp,
    })
    .from(accountingEntityMappings)
    .where(and(
      inArray(accountingEntityMappings.pendingOp, ['push', 'delete']),
      or(
        isNull(accountingEntityMappings.claimedAt),
        lt(accountingEntityMappings.claimedAt, leaseCutoff),
      ),
      lt(accountingEntityMappings.updatedAt, ageCutoff),
    ));
  return rows as Array<{ id: string; partnerId: string; pendingOp: 'push' | 'delete' }>;
}

/**
 * After an invoice lands in QuickBooks, give every payment of that invoice a
 * pending push mapping (spec decision 10).
 *
 * Runs in BOTH modes: in `manual` it is the only way payments reach QuickBooks
 * at all, and in `auto` it catches payments recorded while the invoice push was
 * still pending (their `requestPaymentPush` returned null because the invoice
 * had no remote id yet). Returns the mapping ids the caller must enqueue.
 */
export async function fanOutOwedPayments(
  invoiceId: string,
  partnerId: string,
  runInDbContext: DbContextRunner,
): Promise<string[]> {
  return runInDbContext(async () => {
    const conn = await loadConnectedConnection(db, partnerId);
    if (!conn || !conn.pushPayments) return [];

    const invoiceMapping = await loadTypedMapping(db, conn.id, partnerId, 'invoice', invoiceId);
    if (!invoiceMapping?.remoteEntityId) return [];
    if (!SYNCED_INVOICE_STATUSES.has(invoiceMapping.syncStatus)) return [];

    const payments = await db
      .select({ id: invoicePayments.id })
      .from(invoicePayments)
      .where(eq(invoicePayments.invoiceId, invoiceId));
    if (payments.length === 0) return [];

    const claimed = await db
      .select({ breezeEntityId: accountingEntityMappings.breezeEntityId })
      .from(accountingEntityMappings)
      .where(and(
        eq(accountingEntityMappings.integrationId, conn.id),
        eq(accountingEntityMappings.partnerId, partnerId),
        eq(accountingEntityMappings.breezeEntityType, 'payment'),
        inArray(accountingEntityMappings.breezeEntityId, payments.map((p) => p.id)),
      ));
    const owned = new Set(claimed.map((r) => r.breezeEntityId));

    const enqueue: string[] = [];
    for (const payment of payments) {
      if (owned.has(payment.id)) continue;
      const mappingId = await insertPendingPushMapping(db, conn.id, partnerId, payment.id);
      if (mappingId) enqueue.push(mappingId);
    }
    return enqueue;
  });
}

// ---------------------------------------------------------------------------
// pushPaymentToAccounting
// ---------------------------------------------------------------------------

type PushPrep =
  | { kind: 'outcome'; outcome: PaymentPushOutcome }
  | { kind: 'refused'; error: AccountingPaymentPushError }
  | {
    kind: 'ready';
    conn: AccountingConnection;
    invoiceId: string;
    orgId: string;
    remoteInvoiceId: string;
    amount: string;
    payload: AccountingPaymentPayload;
  };

export async function pushPaymentToAccounting(
  mappingId: string,
  partnerId: string,
  runInDbContext: DbContextRunner,
): Promise<PaymentPushOutcome> {
  assertNoAmbientDbContext('pushPaymentToAccounting');

  // ---- Phase 1: lease + loads + guards, one short self-committing context ----
  const prep: PushPrep = await runInDbContext(async () => {
    const now = new Date();
    const claimed = await claimPaymentMapping(mappingId, partnerId, 'push', now);
    if (!claimed) {
      const existing = await loadMappingById(mappingId, partnerId);
      if (existing && existing.pendingOp === null) {
        return { kind: 'outcome', outcome: 'nothing_owed' } as const;
      }
      // Either a live lease, or the row is not visible yet because the caller's
      // transaction is still an uncommitted savepoint. Both are retryable, which
      // is why `sync_in_progress` is absent from the worker's terminal set.
      return {
        kind: 'refused',
        error: new AccountingPaymentPushError(
          'sync_in_progress',
          409,
          'Another QuickBooks payment sync for this payment is already in flight; it will be retried',
        ),
      } as const;
    }

    // A typed refusal that must NOT be recorded simply THROWS: this whole phase
    // is one transaction, so the throw rolls the lease claim back too.
    const conn = await resolveConnection(partnerId, 'quickbooks').catch(translateMappingError);
    if (!conn.pushPayments) {
      await markPaymentMappingError(mappingId, partnerId, PAYMENT_PUSH_DISABLED_MESSAGE, { clearPendingOp: true });
      return {
        kind: 'refused',
        error: new AccountingPaymentPushError('push_disabled', 409, PAYMENT_PUSH_DISABLED_MESSAGE),
      } as const;
    }

    const payment = await loadPaymentRow(claimed.breezeEntityId);
    if (!payment) {
      // Voided or fully refunded before this job started.
      if (claimed.remoteEntityId) {
        await convertToDelete(mappingId, partnerId);
        return { kind: 'outcome', outcome: 'converted_to_delete' } as const;
      }
      await deleteMappingRow(db, mappingId);
      return { kind: 'outcome', outcome: 'payment_gone' } as const;
    }

    const invoice = await loadOwnedInvoice(payment.invoiceId, partnerId);
    if (!invoice) {
      await deleteMappingRow(db, mappingId);
      return { kind: 'outcome', outcome: 'payment_gone' } as const;
    }
    if (invoice.status === 'void') {
      // Spec decision 11: a void never DELETES a QuickBooks payment, and it must
      // not create one either — QuickBooks refuses to apply a Payment to a void
      // Invoice, and asserting cash against a document the operator voided is
      // exactly the divergence decision 11 exists to prevent.
      const message = 'Invoice was voided in Breeze; QuickBooks payments are not pushed to a void invoice';
      await markPaymentMappingError(mappingId, partnerId, message, { clearPendingOp: true });
      return { kind: 'refused', error: new AccountingPaymentPushError('invoice_void', 409, message) } as const;
    }

    const invoiceMapping = await loadTypedMapping(db, conn.id, partnerId, 'invoice', invoice.id);
    if (!invoiceMapping?.remoteEntityId || !SYNCED_INVOICE_STATUSES.has(invoiceMapping.syncStatus)) {
      // RETRYABLE: the invoice push may still be in flight, and its own fan-out
      // will re-enqueue this payment when it lands. Release the lease so the
      // sweep can pick the row up, and keep `pending_op`.
      await releaseLease(mappingId, partnerId);
      return {
        kind: 'refused',
        error: new AccountingPaymentPushError(
          'invoice_not_synced',
          409,
          'The invoice has not finished syncing to QuickBooks yet; the payment push will be retried',
        ),
      } as const;
    }

    const orgMapping = await loadTypedMapping(db, conn.id, partnerId, 'org', invoice.orgId);
    if (!orgMapping?.remoteEntityId || orgMapping.linkStatus === 'unlinked' || orgMapping.linkStatus === 'suggested') {
      const message = 'This organization is not mapped to a QuickBooks customer yet — confirm or create a mapping first';
      await markPaymentMappingError(mappingId, partnerId, message, { clearPendingOp: true });
      return { kind: 'refused', error: new AccountingPaymentPushError('customer_not_mapped', 409, message) } as const;
    }

    // Currency guard BEFORE any token refresh or network call (spec decision 13,
    // multi-currency §11 contract in accountingCurrency.ts).
    try {
      assertAccountingInvoicePushCurrency(conn, { currencyCode: invoice.currencyCode });
    } catch (err) {
      const typed = toCurrencyPushError(err, conn);
      await markPaymentMappingError(mappingId, partnerId, typed.message, { clearPendingOp: true });
      return { kind: 'refused', error: typed } as const;
    }

    return {
      kind: 'ready',
      conn,
      invoiceId: invoice.id,
      orgId: invoice.orgId,
      remoteInvoiceId: invoiceMapping.remoteEntityId,
      amount: payment.amount,
      payload: {
        invoicePaymentId: payment.id,
        remoteCustomerId: orgMapping.remoteEntityId,
        remoteInvoiceId: invoiceMapping.remoteEntityId,
        amount: payment.amount,
        currencyCode: invoice.currencyCode,
        txnDate: payment.receivedAt,
        // QuickBooks REJECTS a PaymentRefNum over 21 chars, and a Stripe
        // payment_intent id is 27. Truncation is safe because this field is
        // human reference only — ownership lives in PrivateNote (decision 3).
        reference: payment.reference ? payment.reference.slice(0, PAYMENT_REF_MAX_LENGTH) : null,
        privateNote: buildPaymentPrivateNote(payment.id),
      },
    } as const;
  });

  if (prep.kind === 'outcome') return prep.outcome;
  if (prep.kind === 'refused') throw prep.error;

  // ---- Token refresh, then QuickBooks, with NOTHING held ----
  const liveConn = await resolveLiveConnection(prep.conn).catch(translateMappingError);
  const provider = getAccountingProvider(prep.conn.provider);

  let ref: RemoteRef;
  try {
    ref = await runOutsideDbContext(() => provider.createPayment(liveConn, prep.payload));
  } catch (err) {
    const message = sanitizePaymentSyncErrorMessage(err);
    captureException(err instanceof Error ? err : new Error(String(err)), undefined, {
      service: 'accountingPaymentPush', mappingId, invoicePaymentId: prep.payload.invoicePaymentId,
    });
    // Own short context so the marker COMMITS before the throw. `pending_op` is
    // KEPT: the work is still owed and the sweep must retry it.
    await markPaymentMappingErrorInOwnContext(runInDbContext, mappingId, partnerId, message, { clearPendingOp: false });
    throw new AccountingPaymentPushError('quickbooks_error', 502, message);
  }

  // ---- Phase 2: invoice FOR UPDATE first, then re-read everything ----
  let outcome: PaymentPushOutcome;
  let audit: { orgId: string; invoiceId: string; details: Record<string, unknown> } | null = null;
  try {
    const phase2 = await runInDbContext(async () => {
      await lockOwnedInvoice(prep.invoiceId, partnerId);

      const mapping = await loadMappingById(mappingId, partnerId);
      if (!mapping) {
        throw new Error(
          `accountingPaymentPush: mapping ${mappingId} vanished between the QuickBooks create and phase 2 `
          + `(remote payment ${ref.id}); refusing to lose the QuickBooks sync result`,
        );
      }
      const remoteEntityId = paymentMappingRemoteId(ref.id, prep.remoteInvoiceId);

      // The echo won the race: the CDC pull adopted this row and stored a token
      // that is at least as new as ours. Keep ITS token; just release the lease.
      // The comparison is on the FULL composite id, never the Payment id alone:
      // one QuickBooks Payment can settle several invoices, and a sibling split
      // line's mapping is a different row that must not be mistaken for ours.
      if (mapping.remoteEntityId === remoteEntityId) {
        await releaseLease(mappingId, partnerId);
        return { outcome: 'already_adopted' as const, audit: null };
      }

      const payment = await loadPaymentRow(mapping.breezeEntityId);
      if (!payment) {
        // Voided or fully refunded during the round trip. Stamp the ref anyway —
        // the delete needs an Id and a SyncToken — then flip to delete.
        await stampRemoteRef(mappingId, partnerId, remoteEntityId, ref.syncToken ?? null, {
          syncStatus: 'pending', linkStatus: 'confirmed', pendingOp: 'delete', lastError: null,
        });
        return { outcome: 'converted_to_delete' as const, audit: null };
      }

      if (payment.amount !== prep.amount) {
        // A partial refund reduced the amount mid-flight. Rewriting a QuickBooks
        // Payment's amount would rewrite receipt history (spec decision 9), so
        // record the divergence and leave the Payment exactly as created.
        const message = partialRefundDivergenceMessage(payment.amount);
        await stampRemoteRef(mappingId, partnerId, remoteEntityId, ref.syncToken ?? null, {
          syncStatus: 'error', linkStatus: 'confirmed', pendingOp: null, lastError: message,
        });
        return { outcome: 'diverged' as const, audit: null };
      }

      await stampRemoteRef(mappingId, partnerId, remoteEntityId, ref.syncToken ?? null, {
        syncStatus: 'synced', linkStatus: 'confirmed', pendingOp: null, lastError: null, stampSyncedAt: true,
      });
      return {
        outcome: 'pushed' as const,
        audit: {
          orgId: prep.orgId,
          invoiceId: prep.invoiceId,
          details: {
            invoicePaymentId: payment.id,
            remotePaymentId: ref.id,
            remoteInvoiceId: prep.remoteInvoiceId,
            amount: payment.amount,
            currency: prep.payload.currencyCode,
          },
        },
      };
    });
    outcome = phase2.outcome;
    audit = phase2.audit;
  } catch (dbErr) {
    captureException(dbErr instanceof Error ? dbErr : new Error(String(dbErr)), undefined, {
      service: 'accountingPaymentPush', mappingId, remotePaymentId: ref.id,
    });
    const message = `QuickBooks accepted the payment (remote id ${ref.id}) but Breeze failed to record it — do not retry; contact support to reconcile`;
    // `pending_op` CLEARED: a retry would create a SECOND QuickBooks Payment for
    // money that only moved once. The CDC echo will adopt the orphan instead.
    await markPaymentMappingErrorInOwnContext(runInDbContext, mappingId, partnerId, message, { clearPendingOp: true });
    throw new AccountingPaymentPushError('record_failed', 502, message);
  }

  if (audit) {
    fireAudit(prep.conn, 'accounting.payment.pushed', audit.orgId, audit.invoiceId, audit.details);
  }
  return outcome;
}

// ---------------------------------------------------------------------------
// deletePaymentInAccounting
// ---------------------------------------------------------------------------

/**
 * Remove from QuickBooks a Payment Breeze created there.
 *
 * Runs regardless of `push_mode` AND `push_payments` (spec decision 10): once
 * Breeze created a Payment in QuickBooks it owns its removal, and switching the
 * feature off must not strand money in the books that Breeze no longer records.
 */
export async function deletePaymentInAccounting(
  mappingId: string,
  partnerId: string,
  runInDbContext: DbContextRunner,
): Promise<PaymentDeleteOutcome> {
  assertNoAmbientDbContext('deletePaymentInAccounting');

  const prep = await runInDbContext(async () => {
    const now = new Date();
    const claimed = await claimPaymentMapping(mappingId, partnerId, 'delete', now);
    if (!claimed) {
      const existing = await loadMappingById(mappingId, partnerId);
      if (!existing || existing.pendingOp !== 'delete') {
        // No row, or the row no longer owes a delete: another worker already
        // finished it, or `requestPaymentDelete` never flipped it. Not an error.
        return { kind: 'outcome', outcome: 'nothing_owed' } as const;
      }
      return {
        kind: 'refused',
        error: new AccountingPaymentPushError(
          'sync_in_progress',
          409,
          'Another QuickBooks payment delete for this payment is already in flight; it will be retried',
        ),
      } as const;
    }

    if (!claimed.remoteEntityId) {
      // Nothing exists in QuickBooks. Drop the row; there is nothing to call.
      await deleteMappingRow(db, mappingId);
      return { kind: 'outcome', outcome: 'already_absent' } as const;
    }

    const conn = await resolveConnection(partnerId, 'quickbooks').catch(translateMappingError);

    // `<PaymentId>/<remoteInvoiceId>` (paymentMappingRemoteId). Split on the
    // FIRST separator only: QBO ids are numeric, but the invoice half is opaque.
    const separator = claimed.remoteEntityId.indexOf('/');
    const remotePaymentId = separator === -1 ? claimed.remoteEntityId : claimed.remoteEntityId.slice(0, separator);
    const remoteInvoiceId = separator === -1 ? null : claimed.remoteEntityId.slice(separator + 1);

    // Audit context: the payment row is already gone, so the org comes from the
    // invoice this Payment settled. Absent context downgrades to a log, never a
    // failure — the delete itself is what matters.
    let orgId: string | null = null;
    let invoiceId: string | null = null;
    if (remoteInvoiceId) {
      const invoiceMapping = await loadRemoteInvoiceMapping(conn.id, partnerId, remoteInvoiceId);
      if (invoiceMapping) {
        const invoice = await loadOwnedInvoice(invoiceMapping.breezeEntityId, partnerId);
        if (invoice) {
          orgId = invoice.orgId;
          invoiceId = invoice.id;
        }
      }
    }

    return {
      kind: 'ready',
      conn,
      remotePaymentId,
      remoteInvoiceId,
      syncToken: claimed.remoteSyncToken ?? null,
      invoicePaymentId: claimed.breezeEntityId,
      orgId,
      invoiceId,
    } as const;
  });

  if (prep.kind === 'outcome') return prep.outcome;
  if (prep.kind === 'refused') throw prep.error;

  const liveConn = await resolveLiveConnection(prep.conn).catch(translateMappingError);
  const provider = getAccountingProvider(prep.conn.provider);

  let result: PaymentDeleteResult;
  try {
    result = await runOutsideDbContext(() => provider.deletePayment(liveConn, {
      remotePaymentId: prep.remotePaymentId,
      syncToken: prep.syncToken,
    }));
  } catch (err) {
    const message = sanitizePaymentSyncErrorMessage(err);
    captureException(err instanceof Error ? err : new Error(String(err)), undefined, {
      service: 'accountingPaymentPush', mappingId, remotePaymentId: prep.remotePaymentId,
    });
    // `pending_op` KEPT: the mapping is never cleared until QuickBooks confirms,
    // which is what makes a delete survive Redis failure and exhausted retries.
    await markPaymentMappingErrorInOwnContext(runInDbContext, mappingId, partnerId, message, { clearPendingOp: false });
    throw new AccountingPaymentPushError('quickbooks_error', 502, message);
  }

  await runInDbContext(async () => {
    const removed = await deleteMappingRow(db, mappingId);
    if (removed !== 1) {
      throw new Error(`accountingPaymentPush: payment mapping delete matched no row (id=${mappingId})`);
    }
  });

  if (prep.orgId && prep.invoiceId) {
    fireAudit(prep.conn, 'accounting.payment.deleted', prep.orgId, prep.invoiceId, {
      invoicePaymentId: prep.invoicePaymentId,
      remotePaymentId: prep.remotePaymentId,
      remoteInvoiceId: prep.remoteInvoiceId,
      result,
    });
  } else {
    console.warn(
      '[accountingPaymentPush] deleted a QuickBooks payment with no resolvable Breeze invoice for the audit trail',
      `mappingId=${mappingId}`,
      `remotePaymentId=${prep.remotePaymentId}`,
    );
  }
  return result;
}

async function loadRemoteInvoiceMapping(
  integrationId: string,
  partnerId: string,
  remoteInvoiceId: string,
): Promise<MappingRow | null> {
  const rows = await db
    .select()
    .from(accountingEntityMappings)
    .where(and(
      eq(accountingEntityMappings.integrationId, integrationId),
      eq(accountingEntityMappings.partnerId, partnerId),
      eq(accountingEntityMappings.breezeEntityType, 'invoice'),
      eq(accountingEntityMappings.remoteEntityId, remoteInvoiceId),
    ))
    .limit(1);
  return (rows as MappingRow[])[0] ?? null;
}
