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
 * even after BullMQ exhausts its attempts. That is also why
 * `requestPaymentDelete` never DELETES a Breeze-origin row, not even one whose
 * push has not recorded a remote id yet: the create may be in flight at that
 * exact moment, and a deleted mapping row cannot be recreated afterwards — the
 * `accounting_entity_mappings_entity_partner_guard` trigger refuses an INSERT
 * whose `invoice_payments` row no longer exists. Flipping the row to
 * `pending_op = 'delete'` instead keeps a durable place for phase 2 to stamp the
 * remote ref it is about to learn.
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

import { and, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
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
// Defined in the dependency-free marker module because the PULL must respect the
// same lease (it can drop a delete-pending mapping); re-exported here so this
// module stays the coordinator-facing home of the constant.
export { PAYMENT_CLAIM_LEASE_MS } from './accountingPaymentMarker';
import { PAYMENT_CLAIM_LEASE_MS } from './accountingPaymentMarker';
// CURRENCY-AWARE minor-unit helpers — the same pair the Stripe refund path
// uses, and deliberately not `invoiceMath`'s `toCents`/`fromCents`, whose fixed
// 2-decimal exponent misstates a JPY or KWD total (multi-currency §11).
// `@breeze/shared` is a leaf package, so this closes no cycle.
import { fromMinorUnits, toMinorUnits } from '@breeze/shared';
import { getAccountingProvider } from './providerRegistry';
import { requestLikeFromSnapshot, writeAuditEvent } from '../auditEvents';
import { captureException } from '../sentry';
import type { AccountingConnection } from './accountingConnectionService';
import type { AccountingPaymentPayload, PaymentDeleteResult, RemoteRef } from './types';

/** A row must be at least this stale before the sweep re-enqueues it, so the
 *  sweep never races the immediate enqueue the caller just made. */
export const PAYMENT_SWEEP_MIN_AGE_MS = 2 * 60 * 1000;
/** QuickBooks caps PaymentRefNum at 21 characters and REJECTS a longer one. */
export const PAYMENT_REF_MAX_LENGTH = 21;
/**
 * How long a delete-pending mapping with NO remote id is allowed to wait for
 * one before Breeze gives up on it.
 *
 * The row means "a Breeze payment was destroyed while its create was in flight,
 * and we never learned whether QuickBooks kept the Payment". The CDC pull can
 * still adopt it and fill the remote id in (the marker survives in PrivateNote),
 * so the delete worker parks the row instead of guessing. Past this window
 * nothing will resolve it — QBO's 24-hour `requestid` dedupe has closed and CDC
 * has had a day of sweeps — so the row is dropped LOUDLY (Sentry + audit)
 * rather than left owing a delete forever.
 */
export const PAYMENT_DELETE_UNRESOLVED_GRACE_MS = 24 * 60 * 60 * 1000;

export const PAYMENT_PUSH_DISABLED_MESSAGE = 'Payment push is disabled for this QuickBooks connection';

/**
 * How many failed or skipped attempts a `pending_op = 'push'` row gets before
 * Breeze stops asking (final-review findings I1/I2).
 *
 * Without a ceiling the outbox is unbounded: the 15-minute sweep re-enqueues
 * every row that still owes work, so a create QuickBooks will never accept —
 * an over-application, a realm that stays disconnected, a deleted QuickBooks
 * customer — is retried every quarter hour forever, and the operator's only
 * signal is a `last_error` that keeps being rewritten with the same text.
 * Twenty attempts is five hours of sweeps: long enough to ride out a QuickBooks
 * outage or a reconnect, short enough that a genuinely broken row stops
 * generating traffic the same working day.
 *
 * A `delete` row is deliberately NOT capped — see `markPaymentMappingError`.
 */
export const PAYMENT_PUSH_MAX_ATTEMPTS = 20;

/** Stamped by the sync worker when a payment job finds no connected QuickBooks
 *  connection to run against (`notePaymentJobSkipped`). */
export const PAYMENT_NOT_CONNECTED_MESSAGE = 'QuickBooks is not connected';

/**
 * How a push row that burned through `PAYMENT_PUSH_MAX_ATTEMPTS` reads on the
 * mapping card. It quotes the LAST sanitized failure, because "gave up" alone
 * tells an operator nothing about what to fix, and names the recovery: the
 * invoice's "Push to QuickBooks" button, whose fan-out re-owns the row and
 * resets the counter.
 */
export function paymentPushGaveUpMessage(previous: string): string {
  return `QuickBooks payment push gave up after ${PAYMENT_PUSH_MAX_ATTEMPTS} attempts: ${previous}. `
    + 'Fix the cause and push the invoice again.';
}

/**
 * Sentry cadence for an UNCAPPED `delete` row: the first failure, then once
 * every 96 attempts. At the sweep's 15-minute cadence that is one event on day
 * zero and one a day after that — enough to keep a stuck delete visible without
 * turning a disconnected realm into 96 identical events a day.
 */
const PAYMENT_DELETE_ALERT_EVERY_ATTEMPTS = 96;

/**
 * The ONE divergence string both refund paths write into `last_error` — the
 * Stripe webhook (`stripeReconcile.reflectStripeRefund`, partial-refund arm) and
 * this module's own mid-flight `diverged` branch. Sharing it is not tidiness:
 * two texts quoting two different quantities is how a bookkeeper enters the
 * wrong refund.
 *
 * `totalRefunded` is the CUMULATIVE amount refunded so far, in the payment's
 * currency, 2dp — Stripe's `amount_refunded` is itself cumulative, and the
 * coordinator derives the same figure as (pushed amount − current amount). The
 * wording restates it as a RUNNING TOTAL on purpose: the previous text quoted a
 * bare amount ("Partially refunded in Stripe (67.00)"), which a bookkeeper who
 * had already recorded an earlier 40.00 refund read as a second, fresh 67.00 to
 * enter. The trailing clause says what QuickBooks currently shows, so the reader
 * can reconcile the two numbers without opening Stripe.
 */
export function partialRefundDivergenceMessage(totalRefunded: string): string {
  return `Refunded in Stripe, total ${totalRefunded}; record the refund in QuickBooks `
    + '(this QuickBooks payment still shows the full amount)';
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
export type PaymentDeleteOutcome =
  | 'deleted' | 'already_absent' | 'nothing_owed'
  // The row owes a delete but has no remote id yet: the create may still be in
  // flight, or its response was lost and the CDC pull has yet to adopt it.
  | 'awaiting_remote_ref'
  // ...and it never resolved within PAYMENT_DELETE_UNRESOLVED_GRACE_MS.
  | 'unresolved_dropped';

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
 *  - Breeze-origin that QuickBooks can be told about — it has a remote id, or a
 *    `pending_op` meaning a create is owed or in flight -> keep the row, flip
 *    `pending_op='delete'`. Breeze created that Payment in QuickBooks — or is
 *    creating it right now — so Breeze owns its removal, regardless of
 *    `push_mode` or `push_payments` (spec decision 10).
 *  - Breeze-origin STRANDED — `remote_entity_id IS NULL` AND `pending_op IS
 *    NULL` -> delete the row (see the exception below).
 *  - QuickBooks-origin -> delete the row, as Phase D always did. The pull's
 *    reversal path owns those; asking QuickBooks to delete its own payment
 *    because Breeze voided a mirror of it would be backwards.
 *
 * WHY A PUSH-PENDING ROW WITH NO REMOTE ID IS KEPT, NOT DELETED. It is tempting
 * to drop it — "nothing exists in QuickBooks yet" — but that is only true if no
 * create is in flight, and this helper runs at exactly the moment one might be:
 * a worker can sit between its phase 1 and its QuickBooks call. Deleting the row
 * there orphans a real QuickBooks Payment, because phase 2 then finds no row to
 * stamp and CANNOT recreate one — the
 * `accounting_entity_mappings_entity_partner_guard` trigger rejects an INSERT
 * whose `invoice_payments` row is already gone. Flipping to `delete` instead
 * leaves phase 2 somewhere to record the remote ref it is about to learn, and
 * the delete worker parks the row until then
 * (`awaiting_remote_ref`/`PAYMENT_DELETE_UNRESOLVED_GRACE_MS`).
 *
 * `claimed_at` is deliberately left ALONE for the same reason: a live lease
 * means a worker is mid-flight, and clearing it would invite a SECOND worker to
 * start a second create for the same payment. The delete worker gets a clean
 * `sync_in_progress` while the lease is live and retries.
 *
 * The UPDATE touches no column the partner-guard trigger watches
 * (`partner_id`, `breeze_entity_type`, `breeze_entity_id`), so it stays legal
 * even as the `invoice_payments` row disappears in the same transaction.
 *
 * THE STRANDED EXCEPTION (final-review finding C2). A row with
 * `remote_entity_id IS NULL` AND `pending_op IS NULL` is not addressable in
 * QuickBooks and nothing is coming to make it so. No create is in flight — an
 * in-flight create's row still owes a `push` — so the paragraph above does not
 * apply, and flipping it to `delete` would park the delete worker
 * on `awaiting_remote_ref` for 24 hours and then raise a false
 * "a QuickBooks Payment may be orphaned" Sentry alarm for a Payment that was
 * never created. The row is DELETED instead, and nothing new is audited — the
 * caller's own void/refund audit already records the event.
 *
 * Four states reach that shape, all of them terminal states of the push:
 *  - a true deletion of the QuickBooks Payment that the pull mirrored back
 *    (`breeze_origin_removed_remotely` clears the ids and leaves nothing owed,
 *    waiting for a fan-out re-own that never came);
 *  - `push_disabled` — the connection's `push_payments` was switched off;
 *  - a pre-call terminal refusal — `invoice_void`, `customer_not_mapped`, a
 *    currency-contract failure, or a push row that burned through
 *    `PAYMENT_PUSH_MAX_ATTEMPTS`;
 *  - `record_failed` with no remote id, which is already a loud
 *    manual-reconciliation state (Sentry + a stamped `last_error`) and gains
 *    nothing from a delete job that has no id to delete.
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

  if (!mapping.breezeOrigin) {
    await deleteMappingRow(tx, mapping.id);
    return null;
  }

  if (mapping.remoteEntityId === null && mapping.pendingOp === null) {
    // Nothing addressable remotely and nothing owed: drop the row rather than
    // strand it (finding C2). Partner-scoped, and a zero-row result throws for
    // the same reason the flip below does — this runs inside the destroyer's
    // transaction, and a mapping that silently outlives its `invoice_payments`
    // row makes the next CDC delivery read as "already applied" and skip.
    const removed = await tx
      .delete(accountingEntityMappings)
      .where(and(
        eq(accountingEntityMappings.id, mapping.id),
        eq(accountingEntityMappings.partnerId, mapping.partnerId),
      ))
      .returning({ id: accountingEntityMappings.id });
    if (removed.length !== 1) {
      throw new Error(
        `accountingPaymentPush: dropping a stranded payment mapping matched no row (id=${mapping.id}); `
        + 'refusing to leave a mapping behind that would make the next CDC delivery read as already applied',
      );
    }
    return null;
  }

  const rows = await tx
    .update(accountingEntityMappings)
    .set({
      pendingOp: 'delete',
      syncStatus: 'pending',
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
      // Payment rows ONLY. Without this a mis-routed job id (or a future
      // `pending_op` user on another entity type) would hand an Invoice's
      // remote id straight to `provider.deletePayment`.
      eq(accountingEntityMappings.breezeEntityType, 'payment'),
      eq(accountingEntityMappings.pendingOp, op),
      or(
        isNull(accountingEntityMappings.claimedAt),
        lt(accountingEntityMappings.claimedAt, leaseCutoff),
      ),
    ))
    .returning();
  return (rows as MappingRow[])[0] ?? null;
}

/**
 * Release the lease, keeping `pending_op` — the work is still owed.
 *
 * Zero rows is TOLERATED here (unlike `stampRemoteRef`/`convertToDelete`, which
 * throw): every caller is on a path that is already giving up, and the row can
 * legitimately be gone by now — a concurrent tenant erasure, or a destroyer that
 * dropped a QuickBooks-origin row. Failing loudly would replace a precise typed
 * refusal with a raw 500 and change nothing about the outcome. The paths that
 * must not lose a write — the ones recording a QuickBooks RESULT — are the ones
 * that throw.
 */
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
 * Stamp a refusal: release the lease, count the attempt, optionally CLEAR
 * `pending_op` (when retrying can never succeed) and record why, so the mapping
 * card shows an operator what to fix. Runs inside the caller's phase-1
 * transaction, which is why phase 1 RETURNS a recordable refusal instead of
 * throwing it.
 *
 * THE ATTEMPT COUNTER IS THE OUTBOX'S ONLY BOUND (findings I1/I2). `pending_op`
 * is never cleared on a retryable failure — that is what makes the outbox
 * durable — so nothing else stops the 15-minute sweep re-enqueueing a row
 * forever. `sync_attempts` is incremented IN THE UPDATE (never read-modify-write:
 * the sweep and an immediate enqueue can both be mid-flight on one row) and a
 * `push` row that reaches `PAYMENT_PUSH_MAX_ATTEMPTS` gives up here: `pending_op`
 * and the lease are cleared and `last_error` says so, quoting the failure that
 * did it. The invoice fan-out's re-own is the documented recovery, and it resets
 * the counter.
 *
 * A `delete` row is NEVER capped and NEVER dropped. Once Breeze created a
 * Payment in QuickBooks it owns that removal, and giving up would strand money
 * in someone's books; the row keeps asking until QuickBooks confirms (or the
 * pull observes the deletion and satisfies it). The counter still earns its keep
 * there — it is what throttles the delete path's Sentry reporting.
 *
 * Returns the row's NEW attempt count, or null when no row matched. Zero rows is
 * tolerated for the same reason as `releaseLease` above: this is best-effort
 * annotation of a failure that is being reported anyway, and Sentry already
 * carries the original.
 */
async function markPaymentMappingError(
  mappingId: string,
  partnerId: string,
  message: string,
  opts: { clearPendingOp: boolean },
): Promise<number | null> {
  const rows = await db
    .update(accountingEntityMappings)
    .set({
      syncStatus: 'error',
      lastError: message,
      claimedAt: null,
      syncAttempts: sql`${accountingEntityMappings.syncAttempts} + 1`,
      ...(opts.clearPendingOp ? { pendingOp: null } : {}),
      updatedAt: new Date(),
    })
    .where(and(
      eq(accountingEntityMappings.id, mappingId),
      eq(accountingEntityMappings.partnerId, partnerId),
    ))
    .returning({
      syncAttempts: accountingEntityMappings.syncAttempts,
      pendingOp: accountingEntityMappings.pendingOp,
    });
  const row = (rows as Array<{ syncAttempts: number; pendingOp: string | null }>)[0];
  if (!row) return null;

  if (row.pendingOp === 'push' && row.syncAttempts >= PAYMENT_PUSH_MAX_ATTEMPTS) {
    await db
      .update(accountingEntityMappings)
      .set({
        pendingOp: null,
        claimedAt: null,
        lastError: paymentPushGaveUpMessage(message),
        updatedAt: new Date(),
      })
      .where(and(
        eq(accountingEntityMappings.id, mappingId),
        eq(accountingEntityMappings.partnerId, partnerId),
      ))
      .returning({ id: accountingEntityMappings.id });
  }
  return row.syncAttempts;
}

/**
 * A payment job that never reached the coordinator at all — today only the sync
 * worker's "no connected QuickBooks connection" short-circuit, which used to
 * `return` silently and leave the row pending with no record of why.
 *
 * That silence is half of finding I2: the sweep re-enqueued the row every 15
 * minutes against a realm that was disconnected weeks ago, the operator saw a
 * mapping stuck on `pending` with an empty `last_error`, and nothing ever
 * counted the attempts. Routing the skip through `markPaymentMappingError` gives
 * it both — a reason on the card, and the same ceiling a QuickBooks failure gets.
 *
 * Opens its OWN short system context (the worker calls this outside any) and
 * swallows its own failures: this is annotation of a job that is ending either
 * way, and a pool error here must not turn a clean skip into a BullMQ retry.
 */
export async function notePaymentJobSkipped(
  mappingId: string,
  partnerId: string,
  reason: string,
): Promise<void> {
  try {
    await withSystemDbAccessContext(
      () => markPaymentMappingError(mappingId, partnerId, reason, { clearPendingOp: false }),
      'accountingPaymentPush.notePaymentJobSkipped',
    );
  } catch (err) {
    captureException(err instanceof Error ? err : new Error(String(err)), undefined, {
      service: 'accountingPaymentPush', mappingId, partnerId,
    });
  }
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
): Promise<number | null> {
  try {
    return await runInDbContext(() => markPaymentMappingError(mappingId, partnerId, message, opts));
  } catch (err) {
    captureException(err instanceof Error ? err : new Error(String(err)), undefined, {
      service: 'accountingPaymentPush', mappingId, partnerId,
    });
    return null;
  }
}

/** The push is done and nothing more is owed: drop `pending_op` and the lease
 *  together. Used when the CDC echo adopted the row before phase 2 got to it —
 *  the coordinator still owns closing out its own at-most-once claim. */
async function clearPendingPush(mappingId: string, partnerId: string): Promise<void> {
  await db
    .update(accountingEntityMappings)
    .set({ pendingOp: null, claimedAt: null, updatedAt: new Date() })
    .where(and(
      eq(accountingEntityMappings.id, mappingId),
      eq(accountingEntityMappings.partnerId, partnerId),
    ))
    .returning({ id: accountingEntityMappings.id });
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
 *  writeRouteAudit. Never lets an audit failure undo committed money state.
 *  `orgId` is nullable because the unresolved-delete drop has no payment row and
 *  no remote invoice id left to resolve one from (`audit_logs.org_id` is
 *  nullable). */
function fireAudit(params: {
  provider: string;
  action: 'accounting.payment.pushed' | 'accounting.payment.deleted' | 'accounting.payment.delete_unresolved';
  orgId: string | null;
  resourceType: 'invoice' | 'accounting_entity_mapping';
  resourceId: string | null;
  result?: 'success' | 'failure';
  details: Record<string, unknown>;
}): void {
  try {
    writeAuditEvent(requestLikeFromSnapshot({}), {
      orgId: params.orgId,
      action: params.action,
      resourceType: params.resourceType,
      resourceId: params.resourceId,
      actorType: 'system',
      actorId: null,
      result: params.result ?? 'success',
      details: { provider: params.provider, ...params.details },
    });
  } catch (err) {
    captureException(err instanceof Error ? err : new Error(String(err)), undefined, {
      service: 'accountingPaymentPush',
      action: params.action,
      // Sentry tags are Record<string, string>; the unresolved-delete drop has
      // no resource id to report.
      ...(params.resourceId ? { resourceId: params.resourceId } : {}),
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
      // Same guard as the lease CAS: only `payment` rows are ever handed to the
      // payment workers.
      eq(accountingEntityMappings.breezeEntityType, 'payment'),
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
 *
 * A payment with NO mapping gets one inserted. A payment that already has one is
 * skipped — EXCEPT the one state that means "Breeze wants this in QuickBooks and
 * it is not there": a Breeze-origin row with no remote id and nothing owed, which
 * is exactly what `accountingPaymentPull`'s `breeze_origin_removed_remotely`
 * leaves behind when somebody deletes a Breeze-created Payment in QuickBooks.
 * That row is RE-OWNED here rather than re-inserted, because
 * `accounting_entity_mappings_breeze_uniq` makes a second insert for the same
 * payment impossible — which is why this fan-out, not the insert path, is the
 * re-push mechanism the pull's removal branch depends on.
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
      .select({
        id: accountingEntityMappings.id,
        breezeEntityId: accountingEntityMappings.breezeEntityId,
        breezeOrigin: accountingEntityMappings.breezeOrigin,
        remoteEntityId: accountingEntityMappings.remoteEntityId,
        pendingOp: accountingEntityMappings.pendingOp,
      })
      .from(accountingEntityMappings)
      .where(and(
        eq(accountingEntityMappings.integrationId, conn.id),
        eq(accountingEntityMappings.partnerId, partnerId),
        eq(accountingEntityMappings.breezeEntityType, 'payment'),
        inArray(accountingEntityMappings.breezeEntityId, payments.map((p) => p.id)),
      ));
    const owned = new Map(claimed.map((r) => [r.breezeEntityId, r]));

    const enqueue: string[] = [];
    for (const payment of payments) {
      const existing = owned.get(payment.id);
      if (!existing) {
        const mappingId = await insertPendingPushMapping(db, conn.id, partnerId, payment.id);
        if (mappingId) enqueue.push(mappingId);
        continue;
      }
      // Re-ownable ONLY in the removed-remotely state. A row with a remote id is
      // already in QuickBooks (re-owing it would CREATE a duplicate Payment,
      // since the push is create-only); a row with a `pending_op` is already
      // owed to a worker; a QuickBooks-origin row is not ours to push.
      const removedRemotely = existing.breezeOrigin
        && existing.remoteEntityId === null
        && existing.pendingOp === null;
      if (!removedRemotely) continue;
      // A lost CAS is NOT fatal here. This whole fan-out is ONE transaction, so
      // throwing would roll back the sibling payments' inserts too — punishing
      // every other payment on the invoice for one row another writer claimed.
      if (!await reownPushMapping(existing.id, partnerId)) {
        console.log(
          '[accountingPaymentPush] skipped re-owning a payment mapping another writer claimed first',
          `mappingId=${existing.id}`, `invoiceId=${invoiceId}`, `partnerId=${partnerId}`,
        );
        continue;
      }
      enqueue.push(existing.id);
    }
    return enqueue;
  });
}

/**
 * Put a Breeze-origin mapping back on the outbox after QuickBooks lost its
 * Payment (`accountingPaymentPull`'s `breeze_origin_removed_remotely`).
 *
 * The WHERE re-asserts the whole re-ownable state, not just the id: a concurrent
 * adoption or push that stamped a remote id between this transaction's read and
 * this write MUST win, because the push is create-only and re-owing a stamped
 * row would create a SECOND QuickBooks Payment for the same money.
 *
 * Returns whether the row was re-owned. Zero rows is a lost race, NOT an error:
 * the caller runs every payment of the invoice in one transaction, so a throw
 * here would roll back the sibling inserts as well.
 */
async function reownPushMapping(mappingId: string, partnerId: string): Promise<boolean> {
  const rows = await db
    .update(accountingEntityMappings)
    .set({
      pendingOp: 'push',
      syncStatus: 'pending',
      // Matches `insertPendingPushMapping`: the row is once again a payment
      // QuickBooks has never seen, so it is a create, not a confirmed link.
      linkStatus: 'create_new',
      lastError: null,
      claimedAt: null,
      // A fresh push deserves a fresh budget: a re-own is a deliberate operator
      // action (or a re-push after QuickBooks lost the Payment), and inheriting
      // an exhausted counter would make it give up on its first failure.
      syncAttempts: 0,
      updatedAt: new Date(),
    })
    .where(and(
      eq(accountingEntityMappings.id, mappingId),
      eq(accountingEntityMappings.partnerId, partnerId),
      eq(accountingEntityMappings.breezeOrigin, true),
      isNull(accountingEntityMappings.remoteEntityId),
      isNull(accountingEntityMappings.pendingOp),
    ))
    .returning({ id: accountingEntityMappings.id });
  return rows.length === 1;
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
      if (existing && (existing.pendingOp === null || existing.pendingOp === 'delete')) {
        // `pendingOp === null`: nothing is owed. `pendingOp === 'delete'`:
        // mirrors the delete side's own CAS-miss shortcut below — a destroyer
        // flipped this row to a delete while a push job for it was still
        // queued (a void racing an in-flight/queued create). Retrying the
        // push can never succeed against a row that no longer wants one, so
        // report `nothing_owed` rather than burning five retries on
        // `sync_in_progress`; the delete-payment job the destroyer's caller
        // already enqueued (or the sweep will) is what actually does the work.
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
      // Same rule as the missing-payment branch above: a remote id means a
      // QuickBooks Payment exists and Breeze still owes its removal, so the row
      // converts to a delete rather than being dropped.
      if (claimed.remoteEntityId) {
        await convertToDelete(mappingId, partnerId);
        return { kind: 'outcome', outcome: 'converted_to_delete' } as const;
      }
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
      const lockedInvoice = await lockOwnedInvoice(prep.invoiceId, partnerId);
      if (!lockedInvoice) {
        // No lock means no serialisation against a concurrent
        // recordPayment/voidPayment, and the invoice this Payment settles is
        // gone. Refuse rather than write the result unlocked: `record_failed`
        // is terminal and stamps the row for an operator.
        throw new Error(
          `accountingPaymentPush: invoice ${prep.invoiceId} could not be locked in phase 2 `
          + `(remote payment ${ref.id}); refusing to record the result unlocked`,
        );
      }

      const mapping = await loadMappingById(mappingId, partnerId);
      if (!mapping) {
        throw new Error(
          `accountingPaymentPush: mapping ${mappingId} vanished between the QuickBooks create and phase 2 `
          + `(remote payment ${ref.id}); refusing to lose the QuickBooks sync result`,
        );
      }
      const remoteEntityId = paymentMappingRemoteId(ref.id, prep.remoteInvoiceId);

      // The echo won the race: the CDC pull adopted this row and stored a token
      // that is at least as new as ours. Keep ITS token.
      // The comparison is on the FULL composite id, never the Payment id alone:
      // one QuickBooks Payment can settle several invoices, and a sibling split
      // line's mapping is a different row that must not be mistaken for ours.
      if (mapping.remoteEntityId === remoteEntityId) {
        if (mapping.pendingOp === 'delete') {
          // A destroyer flipped the row while the adopter was stamping it. The
          // delete is still owed and already has an Id and a token; just free
          // the lease so the delete worker can claim it.
          await releaseLease(mappingId, partnerId);
          return { outcome: 'converted_to_delete' as const, audit: null };
        }
        // The push IS complete — this coordinator owns closing out its own claim,
        // so `pending_op` goes too, not just the lease. Left set, the sweep would
        // re-enqueue forever and, once QBO's 24-hour `requestid` dedupe window
        // lapsed, mint a SECOND Payment for money that only moved once.
        await clearPendingPush(mappingId, partnerId);
        return { outcome: 'already_adopted' as const, audit: null };
      }

      const payment = await loadPaymentRow(mapping.breezeEntityId);
      // Two ways to land here: the payment row went away during the round trip,
      // or `requestPaymentDelete` flipped this row to `delete` while we were in
      // flight. It never deletes a Breeze-origin push row precisely so that this
      // branch can hand the delete worker an Id and a SyncToken.
      if (mapping.pendingOp === 'delete' || !payment) {
        await stampRemoteRef(mappingId, partnerId, remoteEntityId, ref.syncToken ?? null, {
          syncStatus: 'pending', linkStatus: 'confirmed', pendingOp: 'delete', lastError: null,
        });
        return { outcome: 'converted_to_delete' as const, audit: null };
      }

      if (payment.amount !== prep.amount) {
        // A partial refund reduced the amount mid-flight. Rewriting a QuickBooks
        // Payment's amount would rewrite receipt history (spec decision 9), so
        // record the divergence and leave the Payment exactly as created.
        //
        // The message quotes the TOTAL REFUNDED SO FAR, which here is what
        // QuickBooks was told (`prep.amount`) minus what the Breeze row now says
        // — the same quantity the Stripe path reads straight off Stripe's
        // cumulative `amount_refunded`. Quoting `payment.amount` (the REMAINING
        // amount, as this branch first did) tells the bookkeeper to refund money
        // that was never returned.
        // Currency-aware minor units, exactly as the Stripe refund path derives
        // the same figure — `toCents`/`fromCents` hard-code a 2-decimal
        // exponent, which silently misstates the refunded total for a
        // zero-decimal (JPY) or three-decimal (KWD) invoice.
        const currency = prep.payload.currencyCode;
        const totalRefunded = fromMinorUnits(
          toMinorUnits(prep.amount, currency) - toMinorUnits(payment.amount, currency),
          currency,
        );
        const message = partialRefundDivergenceMessage(totalRefunded);
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
    fireAudit({
      provider: prep.conn.provider,
      action: 'accounting.payment.pushed',
      orgId: audit.orgId,
      resourceType: 'invoice',
      resourceId: audit.invoiceId,
      details: audit.details,
    });
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
      // The row owes a delete but never recorded a remote id: a destroyer
      // flipped it while its create was in flight (or before one ran). Whether a
      // QuickBooks Payment exists is genuinely unknown from here — `createPayment`
      // may have succeeded with a response Breeze never saw — and the PrivateNote
      // marker is not queryable, so there is no recovery QUERY. Waiting is the
      // only correct move: the CDC pull adopts the Payment and fills the remote
      // id in, and the sweep re-enqueues this job afterwards.
      //
      // `created_at`, NOT `updated_at`: the lease CAS bumps `updated_at` on every
      // attempt, so an age measured on it would never expire.
      const unresolvedForMs = now.getTime() - claimed.createdAt.getTime();
      if (unresolvedForMs < PAYMENT_DELETE_UNRESOLVED_GRACE_MS) {
        await releaseLease(mappingId, partnerId);
        return { kind: 'outcome', outcome: 'awaiting_remote_ref' } as const;
      }
      // Past the window nothing will resolve it. Drop the row rather than leave a
      // delete owed forever, and make the loss loud: a QuickBooks Payment may be
      // orphaned and only a human can reconcile it.
      await deleteMappingRow(db, mappingId);
      return {
        kind: 'outcome',
        outcome: 'unresolved_dropped',
        invoicePaymentId: claimed.breezeEntityId,
        unresolvedForMs,
      } as const;
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

  if (prep.kind === 'outcome') {
    if (prep.outcome === 'unresolved_dropped') {
      captureException(
        new Error(
          `accountingPaymentPush: dropped a delete-pending payment mapping (id=${mappingId}) that never recorded a `
          + 'QuickBooks remote id within the grace window; a QuickBooks Payment for this Breeze payment may be '
          + 'orphaned and needs manual reconciliation',
        ),
        undefined,
        { service: 'accountingPaymentPush', mappingId, partnerId },
      );
      fireAudit({
        // The connection was never resolved on this path (it must work even for
        // a disconnected realm), and this coordinator only ever runs against
        // QuickBooks connections.
        provider: 'quickbooks',
        action: 'accounting.payment.delete_unresolved',
        orgId: null,
        resourceType: 'accounting_entity_mapping',
        resourceId: mappingId,
        result: 'failure',
        details: {
          invoicePaymentId: prep.invoicePaymentId,
          mappingId,
          unresolvedForMs: prep.unresolvedForMs,
        },
      });
    }
    return prep.outcome;
  }
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
    // `pending_op` KEPT and NEVER capped: the mapping is never cleared until
    // QuickBooks confirms, which is what makes a delete survive Redis failure
    // and exhausted retries. The stamp runs FIRST so its attempt count can
    // throttle the Sentry event below — an uncapped row retried every 15 minutes
    // would otherwise raise 96 identical events a day for one stuck delete, and
    // that volume is how a real one stops being noticed.
    const attempts = await markPaymentMappingErrorInOwnContext(
      runInDbContext, mappingId, partnerId, message, { clearPendingOp: false },
    );
    if (attempts === null || attempts <= 1 || attempts % PAYMENT_DELETE_ALERT_EVERY_ATTEMPTS === 0) {
      captureException(err instanceof Error ? err : new Error(String(err)), undefined, {
        service: 'accountingPaymentPush',
        mappingId,
        remotePaymentId: prep.remotePaymentId,
        // Sentry tags are strings; `unknown` means the stamp itself could not be
        // written, so the event is raised rather than suppressed.
        syncAttempts: attempts === null ? 'unknown' : String(attempts),
      });
    }
    throw new AccountingPaymentPushError('quickbooks_error', 502, message);
  }

  try {
    await runInDbContext(async () => {
      const removed = await deleteMappingRow(db, mappingId);
      if (removed !== 1) {
        throw new Error(`accountingPaymentPush: payment mapping delete matched no row (id=${mappingId})`);
      }
    });
  } catch (dbErr) {
    captureException(dbErr instanceof Error ? dbErr : new Error(String(dbErr)), undefined, {
      service: 'accountingPaymentPush', mappingId, remotePaymentId: prep.remotePaymentId,
    });
    const message = `QuickBooks removed the payment (remote id ${prep.remotePaymentId}) but Breeze could not clear its mapping; the reconcile sweep will retry`;
    // `pending_op` KEPT and the lease released: a repeat delete against an
    // already-deleted Payment answers `already_absent`, which clears the row —
    // so the sweep heals this on its own.
    await markPaymentMappingErrorInOwnContext(runInDbContext, mappingId, partnerId, message, { clearPendingOp: false });
    throw new AccountingPaymentPushError('record_failed', 502, message);
  }

  if (prep.orgId && prep.invoiceId) {
    fireAudit({
      provider: prep.conn.provider,
      action: 'accounting.payment.deleted',
      orgId: prep.orgId,
      resourceType: 'invoice',
      resourceId: prep.invoiceId,
      details: {
        invoicePaymentId: prep.invoicePaymentId,
        remotePaymentId: prep.remotePaymentId,
        remoteInvoiceId: prep.remoteInvoiceId,
        result,
      },
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
