/**
 * The QuickBooks -> Breeze payment applier (Phase D, Task 3 —
 * .superpowers/sdd/2026-09-02-quickbooks-phase-d-payment-pullback/task-3-brief.md).
 *
 * Consumes one `ChangeSetPaymentLine` produced by `reconcileChanges` (Task 2)
 * and lands it as an `invoice_payments` row plus the `accounting_entity_mappings`
 * row that claims it, at most once. Also mirrors QBO-side deletions
 * (`reverseAccountingPayment`, `markInvoiceDeletedRemotely`).
 *
 * The mapping-row cleanup the two Breeze-side payment destroyers must perform
 * moved OUT of this module in Phase D2: `requestPaymentDelete`
 * (`accountingPaymentPush.ts`) replaced `clearPaymentMappingForInvoicePayment`,
 * because a Breeze-origin mapping with a remote id must now be KEPT and flipped
 * to `pending_op = 'delete'` until QuickBooks confirms the removal, not deleted
 * outright.
 *
 * DB ACCESS CONTRACT (verbatim from `accountingInvoicePush.ts`, the Phase-C
 * coordinator this module mirrors). Every entry point here MUST be entered with
 * NO ambient DB access context (asserted) and takes a `runInDbContext` runner
 * instead: routes pass `(fn) => withAuthDbAccessContext(auth, fn)`, the worker
 * passes `(fn) => withSystemDbAccessContext(fn, 'accountingSync.<type>')`. Each
 * DB phase is one SHORT invocation of that runner, i.e. a real transaction that
 * commits on its own, and no context is ever open across a QuickBooks call.
 *
 * The split is load-bearing, not hygiene. `withDbAccessContext` opens ONE real
 * transaction and holds it for the whole callback; a nested
 * `withSystemDbAccessContext` JOINS it and a nested `db.transaction` degrades to
 * a SAVEPOINT. Held inside ONE caller-opened transaction, every write this
 * module makes to record a FAILURE (a `sync_status='error'` marker) would be a
 * savepoint that rolls back the instant the caller throws: the operator would
 * see no error at all, and a pooled Postgres connection would sit
 * idle-in-transaction across the whole QuickBooks round trip (#1105).
 *
 * This module itself makes NO QuickBooks HTTP call — the CDC read already
 * happened in `reconcileChanges` and the caller hands us the parsed line. The
 * guard is still asserted because the applier is invoked from the same worker
 * loop that DOES make those calls, and it is the loop's context discipline the
 * assert protects.
 *
 * LOCK ORDER is prescribed by `accountingCurrency.ts`'s trailing contract
 * comment, item 4 ("A payment applier that follows the ESTABLISHED INVOICE-FIRST
 * LOCK ORDER"), which in turn points at `invoiceService.recordPayment`
 * ("ONE transaction, invoice row lock FIRST") and is mirrored by
 * `stripeReconcile.recordStripePayment`. Concretely, inside ONE transaction:
 *
 *   a. unlocked discovery read of the invoice mapping — resolves WHICH invoice
 *      to lock; NOT authoritative (mirrors recordStripePayment's own comment);
 *   b. `SELECT ... FROM invoices ... FOR UPDATE`;
 *   c. the payment mapping re-read UNDER that lock — the authoritative
 *      at-most-once claim;
 *   d. `normalizeAccountingPayment` against the LOCKED invoice's stamped
 *      currency (equality asserted before any minor-unit conversion);
 *   e/f. the `invoice_payments` write and `recomputeInvoiceStatus(inv.id, db)`,
 *      which re-reads the payment sum inside the same transaction and therefore
 *      under the same lock.
 *
 * DELIBERATE DEPARTURES FROM THE MANUAL PAYMENT PATH:
 *
 *  0. A VOID INVOICE IS REFUSED, like `recordPayment` refuses one — but as the
 *     clean `invoice_void` outcome plus an invoice-mapping error marker rather
 *     than a throw, because there is no caller to show a 409 to and a throw
 *     would pin the CDC cursor forever on a document that will never accept the
 *     payment.
 *  1. OVER-PAYMENT IS ALLOWED (plan decision 2). `recordPayment` rejects a
 *     payment that exceeds the balance because a human typed it; here
 *     QuickBooks is reporting money that already moved, and refusing it would
 *     leave Breeze permanently disagreeing with the ledger. That is why this
 *     module writes `invoice_payments` directly and never through
 *     `recordPayment`.
 *  2. A CURRENCY MISMATCH IS RECORDED ON THE **INVOICE** MAPPING ROW, not on a
 *     payment mapping row. `accounting_entity_mappings` carries an ownership
 *     trigger (`validate_accounting_mapping_entity_partner`,
 *     2026-09-28-quickbooks-entity-mappings.sql) whose `payment` arm requires
 *     `breeze_entity_id` to be an EXISTING `invoice_payments` id under the same
 *     partner. A mismatch produces no payment row, so there is no id to point
 *     at and a payment mapping row is structurally impossible. The invoice
 *     mapping row is the durable, operator-visible surface for the failure —
 *     the same row `markInvoiceDeletedRemotely` marks.
 */

import { and, eq, isNull, like } from 'drizzle-orm';
import { toMinorUnits } from '@breeze/shared';
import { db } from '../../db';
import { accountingEntityMappings, invoicePayments, invoices } from '../../db/schema';
import type { AccountingEntityMapping as AccountingEntityMappingRow } from '../../db/schema';
import { accountingConnections } from '../../db/schema';
import { assertNoAmbientDbContext, type DbContextRunner } from './dbContextGuard';
import { AccountingCurrencyContractError, normalizeAccountingPayment } from './accountingCurrency';
import type { NormalizedAccountingPayment } from './accountingCurrency';
import { paymentMappingRemoteId } from './accountingPaymentMarker';
import type { AccountingConnection } from './accountingConnectionService';
import type { ChangeSetPaymentLine } from './types';
import { recomputeInvoiceStatus } from '../invoiceService';
import { writeAuditEvent, requestLikeFromSnapshot } from '../auditEvents';
import { captureException } from '../sentry';
import { isPgUniqueViolation } from '../../utils/pgErrors';

export type PaymentPullOutcome =
  | 'applied'            // new invoice_payments row + new mapping row
  | 'updated'            // QBO edited the payment (newer SyncToken) -> amount/date/token refreshed
  | 'replayed'           // same SyncToken already recorded -> no-op
  | 'reversed'           // mirrored a QBO delete/void
  | 'skipped_unmapped'   // Breeze never pushed this invoice; not an error
  | 'currency_mismatch'  // recorded on the mapping row as sync_status='error'; no payment row
  // QuickBooks took money against an invoice Breeze already voided. CLEAN for
  // cursor purposes (exactly like `currency_mismatch`): retrying cannot help,
  // the divergence is recorded on the invoice mapping row for a human, and the
  // void header's amount_paid/balance are deliberately left untouched.
  | 'invoice_void'
  // The connection was re-authorised against a DIFFERENT QuickBooks realm while
  // this run was in flight, so the item in hand describes a company this
  // connection no longer points at. NO WRITE happens; the outcome is CLEAN for
  // the run's own error accounting (nothing failed), and the worker's
  // compare-and-set on the same fingerprint is what stops the cursor.
  | 'realm_changed'
  // --- Phase D2 (payment push). ALL FIVE ARE CLEAN FOR THE CDC CURSOR: each is
  // a recorded, permanent decision, and re-reading the same window would reach
  // the identical one. ---
  // A Payment BREEZE created, whose create response was lost before phase 2
  // recorded the remote id. The note's marker names a pending push mapping, so
  // the pull fills the id in instead of inserting a second payment row.
  | 'adopted'
  // QuickBooks edited a payment Breeze owns (amount changed, or the allocation
  // moved to another invoice). The Breeze row is NOT rewritten — Breeze is the
  // system of record for its own payments — and the mapping carries the reason.
  | 'breeze_origin_diverged'
  // Breeze-origin, but none of the adoption guards held. Deliberately no write:
  // the push or delete job owns this row's outcome, and a pull-side guess would
  // race it.
  | 'skipped_breeze_origin'
  // `pull_payments` is off. Only NEW QuickBooks-origin imports are suppressed —
  // adoptions, echoes and remote deletions of Breeze-origin payments still run
  // (spec decision 6). Counted, and surfaced ONCE PER RUN as
  // `skippedPullDisabled=<n>` on the reconcile worker's run line — which is the
  // #4543 fix for this reason. Deliberately not logged per item: a CDC window
  // against a pull-off connection is ALL skips, so a per-line log would bury the
  // rest of the run in noise it repeats every 15 minutes.
  | 'skipped_pull_disabled'
  // Somebody deleted, in QuickBooks, a Payment Breeze created. The Breeze row
  // SURVIVES (the money moved); the mapping goes to error with its remote id
  // cleared, so a later push can recreate it.
  | 'breeze_origin_removed_remotely'
  // Produced by the CDC WORKER, never by this module: anything unexpected here
  // throws so the caller's transaction rolls back rather than half-applying, and
  // the worker classifies the throw, leaves the cursor and rethrows.
  | 'failed';

export interface PaymentPullResult {
  outcome: PaymentPullOutcome;
  remotePaymentId: string;
  remoteInvoiceId: string | null;
  invoiceId: string | null;
  invoicePaymentId: string | null;
}

type PaymentMethod = typeof invoicePayments.$inferInsert['method'];
type MappingRow = AccountingEntityMappingRow;
type InvoiceRow = typeof invoices.$inferSelect;
type PaymentRow = typeof invoicePayments.$inferSelect;

/** Audit intent captured inside the transaction, fired only after it commits. */
interface PendingAudit {
  orgId: string;
  action: 'accounting.payment.pulled' | 'accounting.payment.reversed'
    | 'accounting.payment.adopted' | 'accounting.payment.diverged';
  resourceId: string;
  details: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

// The composite at-most-once key moved to the dependency-free marker module in
// Phase D2 so the PUSH coordinator can use it without importing this module —
// invoiceService -> accountingPaymentPush -> accountingPaymentPull ->
// invoiceService would be a real cycle. Re-exported so nothing else has to move.
export { paymentMappingRemoteId } from './accountingPaymentMarker';

/**
 * Prefix on every error THIS module writes to an invoice mapping's `last_error`
 * (final-review finding G).
 *
 * That column is shared with the invoice PUSH path, which writes things like
 * "Deleted in QuickBooks". Before the prefix existed, a pulled payment's
 * currency mismatch would silently overwrite a push error an operator still
 * needed to see — and, in the other direction, nothing ever cleared a payment
 * error once the underlying problem was fixed, so the mapping card showed a
 * stale failure forever.
 *
 * The prefix makes the two owners distinguishable: a later `applied`/`updated`
 * clears ONLY a prefixed marker, and never touches a push-originated one.
 * Contains no LIKE metacharacters, so it is safe as a `<prefix>%` pattern.
 */
export const PAYMENT_PULL_ERROR_PREFIX = 'Payment pull: ';

/**
 * Not prefixed with `PAYMENT_PULL_ERROR_PREFIX`: these land on the PAYMENT
 * mapping row, which has exactly one owner, not on the shared invoice mapping.
 */
export const BREEZE_ORIGIN_DIVERGED_MESSAGE = 'Edited in QuickBooks; Breeze remains the source of truth for this payment';
export const BREEZE_ORIGIN_REMOVED_MESSAGE = 'Deleted in QuickBooks';

/**
 * QuickBooks PaymentMethod name -> Breeze `payment_method` enum.
 *
 * Only the names QuickBooks ships as realm defaults are mapped. Everything else
 * — including plausible-looking rails like "ACH", "Wire" or "Direct Debit" — is
 * `other` ON PURPOSE: `bank_transfer` is never INFERRED from a free-text name a
 * QBO admin can rename at will, because mis-labelling the rail on a money row is
 * worse than an honest `other`.
 */
const QBO_PAYMENT_METHOD_NAMES: Record<string, PaymentMethod> = {
  cash: 'cash',
  check: 'check',
  cheque: 'check',
  'credit card': 'card',
  card: 'card',
  'debit card': 'card',
  visa: 'card',
  mastercard: 'card',
  'master card': 'card',
  amex: 'card',
  'american express': 'card',
  discover: 'card',
  'diners club': 'card',
};

export function mapQboPaymentMethod(name: string | null): PaymentMethod {
  if (typeof name !== 'string') return 'other';
  return QBO_PAYMENT_METHOD_NAMES[name.trim().toLowerCase()] ?? 'other';
}

function result(
  outcome: PaymentPullOutcome,
  remotePaymentId: string,
  remoteInvoiceId: string | null,
  invoiceId: string | null = null,
  invoicePaymentId: string | null = null,
): PaymentPullResult {
  return { outcome, remotePaymentId, remoteInvoiceId, invoiceId, invoicePaymentId };
}

function fireAudit(conn: AccountingConnection, audit: PendingAudit): void {
  // Off-request path (CDC sweep / signed webhook): the system-scope writer, not
  // writeRouteAudit — exactly like stripeReconcile's refund void.
  try {
    writeAuditEvent(requestLikeFromSnapshot({}), {
      orgId: audit.orgId,
      action: audit.action,
      resourceType: 'invoice',
      resourceId: audit.resourceId,
      actorType: 'system',
      actorId: null,
      result: 'success',
      details: { provider: conn.provider, ...audit.details },
    });
  } catch (err) {
    // Never let an audit failure undo committed money state.
    captureException(err instanceof Error ? err : new Error(String(err)), undefined, {
      service: 'accountingPaymentPull', action: audit.action, resourceId: audit.resourceId,
    });
  }
}

// ---------------------------------------------------------------------------
// Loads (every one partner-scoped at the SQL level — RLS is stricter than the
// app layer and a missing partner filter here is a cross-tenant read waiting
// for a system-context caller)
// ---------------------------------------------------------------------------

async function loadMappingByRemoteId(
  conn: AccountingConnection,
  breezeEntityType: 'invoice' | 'payment',
  remoteEntityType: 'Invoice' | 'Payment',
  remoteEntityId: string,
): Promise<MappingRow | null> {
  const rows = await db
    .select()
    .from(accountingEntityMappings)
    .where(and(
      eq(accountingEntityMappings.integrationId, conn.id),
      eq(accountingEntityMappings.partnerId, conn.partnerId),
      eq(accountingEntityMappings.breezeEntityType, breezeEntityType),
      eq(accountingEntityMappings.remoteEntityType, remoteEntityType),
      eq(accountingEntityMappings.remoteEntityId, remoteEntityId),
    ))
    .limit(1);
  return (rows as MappingRow[])[0] ?? null;
}

async function loadMappingById(conn: AccountingConnection, mappingId: string): Promise<MappingRow | null> {
  const rows = await db
    .select()
    .from(accountingEntityMappings)
    .where(and(
      eq(accountingEntityMappings.id, mappingId),
      eq(accountingEntityMappings.partnerId, conn.partnerId),
    ))
    .limit(1);
  return (rows as MappingRow[])[0] ?? null;
}

/** The invoice row, LOCKED. Partner-guarded: a mapping row can outlive an erased org. */
async function lockOwnedInvoice(invoiceId: string, partnerId: string): Promise<InvoiceRow | null> {
  const rows = await db
    .select()
    .from(invoices)
    .where(and(eq(invoices.id, invoiceId), eq(invoices.partnerId, partnerId)))
    .limit(1)
    .for('update');
  return (rows as InvoiceRow[])[0] ?? null;
}

/**
 * Is this connection still pointed at the realm the run started against?
 *
 * Re-read INSIDE the caller's transaction, immediately before any write. A
 * reconnect to another QuickBooks company reuses the same
 * `accounting_connections` row (the upsert keys on partner+provider), so a job
 * already holding a decrypted token and a parsed CDC window would otherwise
 * stamp the OLD realm's payments onto a connection that now means something
 * else. A vanished row answers false too: there is nothing left to write for.
 */
async function realmStillMatches(
  conn: AccountingConnection,
  expectedRealmFingerprint: string | null,
): Promise<boolean> {
  const rows = await db
    .select({ realmIdFingerprint: accountingConnections.realmIdFingerprint })
    .from(accountingConnections)
    .where(and(
      eq(accountingConnections.id, conn.id),
      eq(accountingConnections.partnerId, conn.partnerId),
    ))
    .limit(1);
  const row = (rows as Array<{ realmIdFingerprint: string | null }>)[0];
  if (!row) return false;
  return (row.realmIdFingerprint ?? null) === expectedRealmFingerprint;
}

async function loadPaymentRow(invoicePaymentId: string): Promise<PaymentRow | null> {
  const rows = await db
    .select()
    .from(invoicePayments)
    .where(eq(invoicePayments.id, invoicePaymentId))
    .limit(1);
  return (rows as PaymentRow[])[0] ?? null;
}

// ---------------------------------------------------------------------------
// applyAccountingPayment
// ---------------------------------------------------------------------------

interface ApplyOutcome {
  result: PaymentPullResult;
  audit: PendingAudit | null;
}

export async function applyAccountingPayment(
  conn: AccountingConnection,
  line: ChangeSetPaymentLine,
  runInDbContext: DbContextRunner,
  expectedRealmFingerprint: string | null,
): Promise<PaymentPullResult> {
  assertNoAmbientDbContext('applyAccountingPayment');

  const remoteMappingId = paymentMappingRemoteId(line.remotePaymentId, line.remoteInvoiceId);

  let outcome: ApplyOutcome;
  try {
    // ONE short, self-committing context — that invocation IS the transaction,
    // so every statement below shares it and commits together.
    outcome = await runInDbContext(() => applyInsideTransaction(conn, line, remoteMappingId, expectedRealmFingerprint));
  } catch (err) {
    if (!isPgUniqueViolation(err, 'accounting_entity_mappings_remote_uniq')) throw err;
    // A concurrent webhook and sweep raced for the same (payment, invoice) pair
    // and the other one won. The unique violation ABORTED our transaction, so
    // the re-read has to happen in a FRESH context — a re-read issued inside the
    // aborted one would fail with 25P02 ("current transaction is aborted"). The
    // rollback also means our own invoice_payments insert is gone, so there is
    // no orphan payment row to clean up: the winner's row is the only one.
    return runInDbContext(async () => {
      const claimed = await loadMappingByRemoteId(conn, 'payment', 'Payment', remoteMappingId);
      // The mapping alone only names the payment row; read it back so the
      // caller still gets a complete result including the invoice id.
      if (!claimed) {
        // The winner's row was reversed (or erased) in the gap between its
        // commit and this re-read. Reporting `replayed` here would tell the
        // worker this payment is safely recorded and let it advance the CDC
        // cursor past a payment that now exists NOWHERE. Fail the item instead:
        // the cursor stays put and the next sweep re-applies it cleanly.
        throw new Error(
          `accountingPaymentPull: a concurrent writer claimed the QuickBooks payment mapping ${remoteMappingId} `
          + 'but no mapping row remains on re-read — refusing to report this payment as already applied',
        );
      }
      const pay = await loadPaymentRow(claimed.breezeEntityId);
      return result(
        'replayed', line.remotePaymentId, line.remoteInvoiceId,
        pay?.invoiceId ?? null, claimed.breezeEntityId,
      );
    });
  }

  if (outcome.audit) fireAudit(conn, outcome.audit);
  return outcome.result;
}

async function applyInsideTransaction(
  conn: AccountingConnection,
  line: ChangeSetPaymentLine,
  remoteMappingId: string,
  expectedRealmFingerprint: string | null,
): Promise<ApplyOutcome> {
  const noAudit = (r: PaymentPullResult): ApplyOutcome => ({ result: r, audit: null });

  // (0) Realm guard, BEFORE anything is read or written (finding C).
  if (!await realmStillMatches(conn, expectedRealmFingerprint)) {
    return noAudit(result('realm_changed', line.remotePaymentId, line.remoteInvoiceId));
  }

  // (a) Unlocked discovery read — resolves WHICH invoice to lock. NOT
  // authoritative; the invoice row itself is re-read under the lock below.
  const invoiceMapping = await loadMappingByRemoteId(conn, 'invoice', 'Invoice', line.remoteInvoiceId);
  if (!invoiceMapping) {
    // Breeze never pushed this invoice — QuickBooks is reporting a payment on a
    // document Breeze does not own. Not an error, and nothing to record.
    return noAudit(result('skipped_unmapped', line.remotePaymentId, line.remoteInvoiceId));
  }

  // (b) Invoice row FIRST, FOR UPDATE.
  const inv = await lockOwnedInvoice(invoiceMapping.breezeEntityId, conn.partnerId);
  if (!inv) {
    // The mapping outlived its invoice (an erased org, or a partner change).
    return noAudit(result('skipped_unmapped', line.remotePaymentId, line.remoteInvoiceId));
  }

  // (b2) A voided invoice is a hard stop, checked on the LOCKED row and BEFORE
  // the payment mapping is consulted — so no branch below it (replay, edit,
  // first delivery) can write to a void document. Recording the payment would
  // rewrite `amount_paid`/`balance` on a header the operator deliberately
  // voided, and `deriveInvoiceStatus` short-circuits on `voided`, so the row
  // would silently disagree with its own status with no operator signal. The
  // marker is the same invoice-mapping path the currency mismatch uses.
  if (inv.status === 'void') {
    const message = 'Payment received in QuickBooks against a voided invoice';
    await markInvoiceMappingError(conn, invoiceMapping.id, `${PAYMENT_PULL_ERROR_PREFIX}${message}`);
    captureException(
      new Error(`${message} (remotePaymentId=${line.remotePaymentId}, invoiceId=${inv.id})`),
      undefined,
      { service: 'accountingPaymentPull', remotePaymentId: line.remotePaymentId, invoiceId: inv.id },
    );
    return noAudit(result('invoice_void', line.remotePaymentId, line.remoteInvoiceId, inv.id));
  }

  // (b3) A payment with no transaction date (finding H). `mapQboCdcPayment`
  // emits `TxnDate ?? ''` because QBO's CDC shape makes the field optional, and
  // an empty string reached Postgres as `received_at` and surfaced as an opaque
  // driver error — the operator got a stack trace instead of a reason. Thrown,
  // not recorded: the worker counts it `failed`, holds the cursor and re-reads
  // the payment next sweep, which is the right answer for a field QuickBooks
  // may simply not have flushed yet. Checked AFTER the unmapped/void arms so a
  // payment Breeze does not own still short-circuits cleanly.
  if (line.txnDate.trim() === '') {
    throw new Error(
      `accountingPaymentPull: QuickBooks payment ${line.remotePaymentId} reported no transaction date `
      + `for invoice ${line.remoteInvoiceId}; refusing to record a payment with no received_at`,
    );
  }

  // (c) Authoritative at-most-once claim, read under the lock.
  const existing = await loadMappingByRemoteId(conn, 'payment', 'Payment', remoteMappingId);

  // (c2) Pull switched off. Only a NEW QuickBooks-origin import is suppressed:
  // a line that already has a mapping, or that carries Breeze's own marker, is
  // this connection's outbound work echoing back and must still be processed
  // (spec decision 6). The skip is never silent — it is a counted outcome the
  // worker reports once per run as `skippedPullDisabled=<n>` (#4543).
  if (!existing && !line.breezePaymentId && !conn.pullPayments) {
    return noAudit(result('skipped_pull_disabled', line.remotePaymentId, line.remoteInvoiceId, inv.id));
  }

  // (d) Currency equality asserted BEFORE any minor-unit conversion, against the
  // LOCKED invoice's stamped currency (multi-currency §11).
  let normalized;
  try {
    normalized = normalizeAccountingPayment(line, { invoiceId: inv.id, currencyCode: inv.currencyCode });
  } catch (err) {
    if (!(err instanceof AccountingCurrencyContractError)) throw err;
    // `err.message` is generated locally by accountingCurrency.ts — never a QBO
    // response body — so it is safe to persist verbatim.
    await markInvoiceMappingError(conn, invoiceMapping.id, `${PAYMENT_PULL_ERROR_PREFIX}${err.message}`);
    captureException(err, undefined, {
      service: 'accountingPaymentPull',
      remotePaymentId: line.remotePaymentId,
      remoteInvoiceId: line.remoteInvoiceId,
      invoiceId: inv.id,
    });
    return noAudit(result('currency_mismatch', line.remotePaymentId, line.remoteInvoiceId, inv.id));
  }

  const method = mapQboPaymentMethod(line.paymentMethodName);
  const reference = line.paymentRefNum ?? line.remotePaymentId;

  if (existing) {
    // (e0) Breeze-origin: this is our OWN write echoing back. Never mutate the
    // money row from QuickBooks (spec decision 5).
    if (existing.breezeOrigin) {
      return applyBreezeOriginEcho(conn, line, existing, normalized, inv);
    }

    // Everything below here — the same-token replay, the amount/method/date
    // update, the token write, clearPaymentPullMappingError and the recompute —
    // is the QUICKBOOKS-ORIGIN path, and QuickBooks stays the source of truth
    // for those payments.

    // (e) Same token -> the line has already been applied verbatim. No write, no
    // recompute, no audit: a replay must be indistinguishable from never having
    // been delivered.
    if (existing.remoteSyncToken === line.remotePaymentSyncToken) {
      return noAudit(result(
        'replayed', line.remotePaymentId, line.remoteInvoiceId, inv.id, existing.breezeEntityId,
      ));
    }

    // Captured BEFORE the updates below: `replacedSyncToken` is the forensic
    // record of which QuickBooks revision this edit superseded, and reading it
    // off `existing` afterwards would report the NEW token on any executor that
    // hands back a live row rather than a snapshot.
    const replacedSyncToken = existing.remoteSyncToken;

    const updatedPayments = await db
      .update(invoicePayments)
      .set({ amount: normalized.amount, method, reference, receivedAt: normalized.txnDate })
      .where(eq(invoicePayments.id, existing.breezeEntityId))
      .returning({ id: invoicePayments.id });
    if (updatedPayments.length !== 1) {
      throw new Error(
        `accountingPaymentPull: payment mapping ${existing.id} points at invoice_payments row `
        + `${existing.breezeEntityId}, which the update did not match — refusing to lose the QuickBooks payment edit`,
      );
    }

    const updatedMappings = await db
      .update(accountingEntityMappings)
      .set({
        remoteSyncToken: line.remotePaymentSyncToken,
        syncStatus: 'synced',
        lastError: null,
        lastSyncedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(and(
        eq(accountingEntityMappings.id, existing.id),
        eq(accountingEntityMappings.partnerId, conn.partnerId),
      ))
      .returning({ id: accountingEntityMappings.id });
    if (updatedMappings.length !== 1) {
      throw new Error(`accountingPaymentPull: payment mapping update matched no row (id=${existing.id})`);
    }

    await clearPaymentPullMappingError(conn, invoiceMapping.id);
    await recomputeInvoiceStatus(inv.id, db);

    return {
      result: result('updated', line.remotePaymentId, line.remoteInvoiceId, inv.id, existing.breezeEntityId),
      audit: {
        orgId: inv.orgId,
        action: 'accounting.payment.pulled',
        resourceId: inv.id,
        details: {
          remotePaymentId: line.remotePaymentId,
          remoteInvoiceId: line.remoteInvoiceId,
          invoicePaymentId: existing.breezeEntityId,
          amount: normalized.amount,
          currency: normalized.currencyCode,
          replacedSyncToken,
        },
      },
    };
  }

  // (e2) No mapping for this (payment, invoice) pair — but the note carries
  // Breeze's own marker, so this Payment is a create of OURS whose response we
  // never saw. ADOPT the pending mapping rather than inserting a second payment
  // row (spec decision 3). Every guard below must hold; any failure is a clean
  // `skipped_breeze_origin`, because the push or delete job owns the outcome and
  // a pull-side guess would race it.
  if (line.breezePaymentId) {
    return adoptBreezeOriginPayment(conn, line, line.breezePaymentId, remoteMappingId, normalized, inv);
  }

  // (f) First delivery for this (payment, invoice) pair.
  const insertedPayments = await db
    .insert(invoicePayments)
    .values({
      invoiceId: inv.id,
      orgId: inv.orgId,
      amount: normalized.amount,
      method,
      reference,
      receivedAt: normalized.txnDate,
      recordedBy: null,
      note: 'Pulled from QuickBooks',
    })
    .returning({ id: invoicePayments.id });
  const paymentId = (insertedPayments as Array<{ id: string }>)[0]?.id;
  if (!paymentId) {
    // A zero-row INSERT ... RETURNING is an RLS-context bug, never a no-op.
    throw new Error(
      'accountingPaymentPull: invoice_payments insert returned no row — refusing to record a QuickBooks payment '
      + `with no row to claim (remotePaymentId=${line.remotePaymentId})`,
    );
  }

  // The mapping row is what makes this at-most-once. If a racer already claimed
  // the remote id, this INSERT trips `accounting_entity_mappings_remote_uniq`
  // and aborts the whole transaction — including the payment insert above, which
  // is exactly what must happen. `applyAccountingPayment` translates that abort
  // into `replayed` from a fresh context.
  const insertedMappings = await db
    .insert(accountingEntityMappings)
    .values({
      integrationId: conn.id,
      partnerId: conn.partnerId,
      breezeEntityType: 'payment',
      breezeEntityId: paymentId,
      remoteEntityType: 'Payment',
      remoteEntityId: paymentMappingRemoteId(line.remotePaymentId, line.remoteInvoiceId),
      remoteSyncToken: line.remotePaymentSyncToken,
      linkStatus: 'confirmed',
      syncStatus: 'synced',
      lastSyncedAt: new Date(),
    })
    .returning({ id: accountingEntityMappings.id });
  if (!(insertedMappings as Array<{ id: string }>)[0]) {
    throw new Error('accountingPaymentPull: payment mapping insert returned no row');
  }

  await clearPaymentPullMappingError(conn, invoiceMapping.id);
  await recomputeInvoiceStatus(inv.id, db);

  return {
    result: result('applied', line.remotePaymentId, line.remoteInvoiceId, inv.id, paymentId),
    audit: {
      orgId: inv.orgId,
      action: 'accounting.payment.pulled',
      resourceId: inv.id,
      details: {
        remotePaymentId: line.remotePaymentId,
        remoteInvoiceId: line.remoteInvoiceId,
        invoicePaymentId: paymentId,
        amount: normalized.amount,
        currency: normalized.currencyCode,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Phase D2 — Breeze-origin branches
// ---------------------------------------------------------------------------

/**
 * The echo of a payment Breeze itself pushed (spec decision 5).
 *
 * The token is stored in EVERY branch, including the diverged one: a later
 * corrective delete needs the CURRENT SyncToken, and refusing to record it would
 * make that delete fail with a stale-object fault forever.
 *
 * `invoice_payments` is never written here, and there is deliberately no
 * `recomputeInvoiceStatus`: nothing about the Breeze ledger changed.
 */
async function applyBreezeOriginEcho(
  conn: AccountingConnection,
  line: ChangeSetPaymentLine,
  existing: MappingRow,
  normalized: NormalizedAccountingPayment,
  inv: InvoiceRow,
): Promise<ApplyOutcome> {
  const noAudit = (r: PaymentPullResult): ApplyOutcome => ({ result: r, audit: null });

  if (existing.remoteSyncToken === line.remotePaymentSyncToken) {
    return noAudit(result(
      'replayed', line.remotePaymentId, line.remoteInvoiceId, inv.id, existing.breezeEntityId,
    ));
  }

  // Compared in MINOR UNITS against the locked invoice's currency, not as
  // decimal strings: `numeric` scale is a storage detail and a re-scaled
  // '150.0' must not read as a QuickBooks edit.
  const pay = await loadPaymentRow(existing.breezeEntityId);
  const unchanged = pay !== null && toMinorUnits(pay.amount, normalized.currencyCode) === line.amountMinor;

  const stored = await db
    .update(accountingEntityMappings)
    .set({ remoteSyncToken: line.remotePaymentSyncToken, updatedAt: new Date() })
    .where(and(
      eq(accountingEntityMappings.id, existing.id),
      eq(accountingEntityMappings.partnerId, conn.partnerId),
    ))
    .returning({ id: accountingEntityMappings.id });
  if (stored.length !== 1) {
    throw new Error(`accountingPaymentPull: storing the echoed SyncToken matched no row (id=${existing.id})`);
  }

  if (unchanged) {
    // A token bump with no financial change — QuickBooks re-saved the Payment
    // (a memo edit, a deposit). Nothing to do, and NOT an error.
    return noAudit(result(
      'replayed', line.remotePaymentId, line.remoteInvoiceId, inv.id, existing.breezeEntityId,
    ));
  }

  await markPaymentMappingDiverged(conn, existing.id, BREEZE_ORIGIN_DIVERGED_MESSAGE);
  return {
    result: result(
      'breeze_origin_diverged', line.remotePaymentId, line.remoteInvoiceId, inv.id, existing.breezeEntityId,
    ),
    audit: divergedAudit(inv, line, existing.breezeEntityId, 'amount_changed'),
  };
}

/**
 * A Payment Breeze created whose create response was lost before phase 2
 * recorded the remote id (spec decision 3).
 *
 * WHY THE MARKER ALONE IS NOT A CLAIM. `PrivateNote` is free text a QuickBooks
 * operator can type, and a SPLIT Payment carries the SAME note on every one of
 * its lines while the Breeze payment it names belongs to exactly ONE invoice.
 * So a marker only authorises an adoption when the mapping behind it is
 * Breeze-origin, still has no remote id, still owes work, and (when its money
 * row is still alive) that row sits on THIS locked invoice for THIS amount.
 * Anything else is a clean `skipped_breeze_origin`: the push or delete job owns
 * that row's outcome and a pull-side guess would race it.
 */
async function adoptBreezeOriginPayment(
  conn: AccountingConnection,
  line: ChangeSetPaymentLine,
  invoicePaymentId: string,
  remoteMappingId: string,
  normalized: NormalizedAccountingPayment,
  inv: InvoiceRow,
): Promise<ApplyOutcome> {
  const noAudit = (r: PaymentPullResult): ApplyOutcome => ({ result: r, audit: null });
  const skipped = (breezeEntityId: string | null): ApplyOutcome => noAudit(result(
    'skipped_breeze_origin', line.remotePaymentId, line.remoteInvoiceId, inv.id, breezeEntityId,
  ));

  const owned = await loadPaymentMappingByBreezeId(conn, invoicePaymentId);
  if (!owned || !owned.breezeOrigin) return skipped(owned?.breezeEntityId ?? null);

  if (owned.remoteEntityId !== null && owned.remoteEntityId !== remoteMappingId) {
    // QuickBooks moved (or copied) this Payment's allocation to a different
    // invoice. Breeze cannot follow that without rewriting its own ledger, so
    // record it for a human.
    await markPaymentMappingDiverged(conn, owned.id, BREEZE_ORIGIN_DIVERGED_MESSAGE);
    return {
      result: result(
        'breeze_origin_diverged', line.remotePaymentId, line.remoteInvoiceId, inv.id, owned.breezeEntityId,
      ),
      audit: divergedAudit(inv, line, owned.breezeEntityId, 'allocation_moved'),
    };
  }

  const pay = await loadPaymentRow(owned.breezeEntityId);
  // A row that owes a DELETE has NO `invoice_payments` row left to check: the
  // void or full refund destroyed it in the SAME transaction that flipped
  // `pending_op` (`requestPaymentDelete`). Its adoption is authorised by the
  // mapping alone — safe because the delete only ever uses the `<PaymentId>`
  // half of the composite id, and the invoice half is audit context, never the
  // choice of what to delete.
  const paymentMatches = pay === null
    ? owned.pendingOp === 'delete'
    : pay.invoiceId === inv.id && toMinorUnits(pay.amount, normalized.currencyCode) === line.amountMinor;
  const adoptable = owned.remoteEntityId === null
    && (owned.pendingOp === 'push' || owned.pendingOp === 'delete')
    && paymentMatches;
  if (!adoptable) return skipped(owned.breezeEntityId);

  // EXACTLY the column set `accountingPaymentPush`'s `stampRemoteRef` writes, so
  // the two directions can never disagree about what "the remote ref is known"
  // means. A row that still owes a delete keeps owing it — the delete worker
  // parks on `awaiting_remote_ref` until precisely this write lands — and its
  // lease is released so that worker can claim it. A row that owed the push has
  // nothing left to do, and clearing `pending_op` is what stops the sweep
  // re-enqueuing a create that would DUPLICATE the Payment once QuickBooks'
  // 24-hour `requestid` window has closed.
  const adoptingDelete = owned.pendingOp === 'delete';
  const now = new Date();
  const adopted = await db
    .update(accountingEntityMappings)
    .set({
      remoteEntityId: remoteMappingId,
      remoteSyncToken: line.remotePaymentSyncToken,
      linkStatus: 'confirmed',
      syncStatus: adoptingDelete ? 'pending' : 'synced',
      pendingOp: adoptingDelete ? 'delete' : null,
      claimedAt: null,
      lastError: null,
      ...(adoptingDelete ? {} : { lastSyncedAt: now }),
      updatedAt: now,
    })
    .where(and(
      eq(accountingEntityMappings.id, owned.id),
      eq(accountingEntityMappings.partnerId, conn.partnerId),
      // Guarded: only a row that STILL has no remote id may be adopted. A push
      // job's phase 2 that landed a microsecond ago must win, not be overwritten.
      isNull(accountingEntityMappings.remoteEntityId),
    ))
    .returning({ id: accountingEntityMappings.id });
  if (adopted.length !== 1) return skipped(owned.breezeEntityId);

  // No recompute: the payment row already exists and already counted — or it is
  // already gone, and its own removal recomputed the invoice.
  return {
    result: result('adopted', line.remotePaymentId, line.remoteInvoiceId, inv.id, owned.breezeEntityId),
    audit: {
      orgId: inv.orgId,
      action: 'accounting.payment.adopted',
      resourceId: inv.id,
      details: {
        remotePaymentId: line.remotePaymentId,
        remoteInvoiceId: line.remoteInvoiceId,
        invoicePaymentId: owned.breezeEntityId,
        amount: normalized.amount,
        currency: normalized.currencyCode,
        adoptedPendingOp: owned.pendingOp,
      },
    },
  };
}

/** The `payment` mapping row for one Breeze payment id, scoped to this connection. */
async function loadPaymentMappingByBreezeId(
  conn: AccountingConnection,
  invoicePaymentId: string,
): Promise<MappingRow | null> {
  const rows = await db
    .select()
    .from(accountingEntityMappings)
    .where(and(
      eq(accountingEntityMappings.integrationId, conn.id),
      eq(accountingEntityMappings.partnerId, conn.partnerId),
      eq(accountingEntityMappings.breezeEntityType, 'payment'),
      eq(accountingEntityMappings.breezeEntityId, invoicePaymentId),
    ))
    .limit(1);
  return (rows as MappingRow[])[0] ?? null;
}

/**
 * Flips a PAYMENT mapping row to error.
 *
 * Never touches `remote_entity_id` or `link_status`: the link back to
 * QuickBooks must survive the divergence so a human can compare the two
 * records. It also never touches `pending_op` or `claimed_at` — a divergence is
 * an ANNOTATION, not a cancellation. A Breeze-origin row can legitimately owe a
 * delete while QuickBooks edits it (a void landing during an in-flight push),
 * and clearing the outbox here would abandon that delete and strand the
 * QuickBooks Payment forever; clearing the lease would hand a second worker a
 * row another one is mid-flight on.
 */
async function markPaymentMappingDiverged(
  conn: AccountingConnection,
  mappingId: string,
  message: string,
): Promise<void> {
  const rows = await db
    .update(accountingEntityMappings)
    .set({ syncStatus: 'error', lastError: message, updatedAt: new Date() })
    .where(and(
      eq(accountingEntityMappings.id, mappingId),
      eq(accountingEntityMappings.partnerId, conn.partnerId),
    ))
    .returning({ id: accountingEntityMappings.id });
  if (rows.length !== 1) {
    throw new Error(`accountingPaymentPull: divergence marker matched no row (id=${mappingId})`);
  }
}

function divergedAudit(
  inv: InvoiceRow,
  line: ChangeSetPaymentLine,
  invoicePaymentId: string,
  reason: 'amount_changed' | 'allocation_moved',
): PendingAudit {
  return {
    orgId: inv.orgId,
    action: 'accounting.payment.diverged',
    resourceId: inv.id,
    details: {
      remotePaymentId: line.remotePaymentId,
      remoteInvoiceId: line.remoteInvoiceId,
      invoicePaymentId,
      remoteAmountMinor: line.amountMinor,
      reason,
    },
  };
}

/**
 * Flips ONE mapping row to `sync_status='error'` with an operator-readable
 * reason. Deliberately narrow: it never touches `remote_entity_id` or
 * `link_status`, so the link back to QuickBooks survives the failure and a later
 * push/pull can clear the marker instead of re-creating the remote entity.
 */
/**
 * Clears a PAYMENT-ORIGINATED error marker off the invoice mapping once a
 * payment lands cleanly (finding G).
 *
 * Scoped by the prefix IN SQL rather than by the row read before the invoice
 * lock, so a marker another writer set in between is judged on its own content.
 * A zero-row result is the normal case (the mapping was already `synced`), and
 * deliberately not a throw.
 */
async function clearPaymentPullMappingError(conn: AccountingConnection, mappingId: string): Promise<void> {
  await db
    .update(accountingEntityMappings)
    .set({ syncStatus: 'synced', lastError: null, updatedAt: new Date() })
    .where(and(
      eq(accountingEntityMappings.id, mappingId),
      eq(accountingEntityMappings.partnerId, conn.partnerId),
      eq(accountingEntityMappings.syncStatus, 'error'),
      like(accountingEntityMappings.lastError, `${PAYMENT_PULL_ERROR_PREFIX}%`),
    ))
    .returning({ id: accountingEntityMappings.id });
}

async function markInvoiceMappingError(
  conn: AccountingConnection,
  mappingId: string,
  message: string,
): Promise<void> {
  const rows = await db
    .update(accountingEntityMappings)
    .set({ syncStatus: 'error', lastError: message, updatedAt: new Date() })
    .where(and(
      eq(accountingEntityMappings.id, mappingId),
      eq(accountingEntityMappings.partnerId, conn.partnerId),
    ))
    .returning({ id: accountingEntityMappings.id });
  if (rows.length !== 1) {
    throw new Error(`accountingPaymentPull: mapping error marker matched no row (id=${mappingId})`);
  }
}

// ---------------------------------------------------------------------------
// reverseAccountingPayment
// ---------------------------------------------------------------------------

/**
 * Mirrors a QuickBooks payment delete/void.
 *
 * A QBO Payment can span several invoices, so this recovers EVERY mapping row
 * whose remote id starts `<PaymentId>/` and reverses each in its OWN short
 * context — one bad invoice must not roll back the reversals that already
 * succeeded. The mapping row is the ONLY thing that authorises a delete: a
 * payment with no mapping is manual or Stripe-sourced and is structurally
 * unreachable from here.
 *
 * A failure propagates rather than being collected. The worker then leaves the
 * CDC cursor where it is, so the next sweep re-reads the same deletion — and a
 * reversal whose mapping row is already gone is a clean no-op, so the retry is
 * safe. Reversals that committed before the failure stay committed.
 */
export async function reverseAccountingPayment(
  conn: AccountingConnection,
  remotePaymentId: string,
  runInDbContext: DbContextRunner,
  expectedRealmFingerprint: string | null,
): Promise<PaymentPullResult[]> {
  assertNoAmbientDbContext('reverseAccountingPayment');

  const candidates = await loadPaymentMappingCandidates(conn, remotePaymentId, runInDbContext);
  return reverseCandidates(conn, remotePaymentId, candidates, runInDbContext, expectedRealmFingerprint);
}

/**
 * Mirrors an ALLOCATION QuickBooks removed from a payment it still holds
 * (final-review finding B).
 *
 * A QBO Payment can be edited to settle a different set of invoices. The
 * applier only ever sees the lines the payment carries NOW, so an allocation
 * that was dropped leaves its Breeze `invoice_payments` row — and the invoice
 * balance it paid down — standing forever: no CDC deletion is ever emitted for
 * it, because the Payment itself was not deleted.
 *
 * `keepRemoteInvoiceIds` is the CURRENT line set for this payment. Every
 * existing `<PaymentId>/<remoteInvoiceId>` mapping whose invoice is NOT in it
 * is reversed through the same row-level path a full reversal uses, so the
 * lock order, the mapping-authorises-the-delete rule and the audit trail are
 * identical. An empty current set is NOT special-cased: that is a payment whose
 * every allocation was removed, and every row should indeed go — a payment with
 * no invoice-linked line at all reaches `reverseAccountingPayment` instead,
 * because the provider classifies it as a deletion.
 */
export async function reverseStaleAllocations(
  conn: AccountingConnection,
  remotePaymentId: string,
  keepRemoteInvoiceIds: readonly string[],
  runInDbContext: DbContextRunner,
  expectedRealmFingerprint: string | null,
): Promise<PaymentPullResult[]> {
  assertNoAmbientDbContext('reverseStaleAllocations');

  const keep = new Set(keepRemoteInvoiceIds);
  const prefixLength = remotePaymentId.length + 1;
  const candidates = (await loadPaymentMappingCandidates(conn, remotePaymentId, runInDbContext))
    .filter((row) => !keep.has(row.remoteEntityId?.slice(prefixLength) ?? ''));
  if (candidates.length === 0) return [];

  return reverseCandidates(conn, remotePaymentId, candidates, runInDbContext, expectedRealmFingerprint);
}

/** Every `payment` mapping row for one QBO Payment id, scoped to this connection. */
async function loadPaymentMappingCandidates(
  conn: AccountingConnection,
  remotePaymentId: string,
  runInDbContext: DbContextRunner,
): Promise<MappingRow[]> {
  const prefix = `${remotePaymentId}/`;
  return runInDbContext(async () => {
    const rows = await db
      .select()
      .from(accountingEntityMappings)
      .where(and(
        eq(accountingEntityMappings.integrationId, conn.id),
        eq(accountingEntityMappings.partnerId, conn.partnerId),
        eq(accountingEntityMappings.breezeEntityType, 'payment'),
        like(accountingEntityMappings.remoteEntityId, `${prefix}%`),
      ));
    // LIKE treats `_` and `%` as wildcards. QBO ids are numeric today, but a
    // JS prefix re-check costs nothing and makes the match exact regardless.
    return (rows as MappingRow[]).filter((row) => row.remoteEntityId?.startsWith(prefix));
  });
}

/** Reverse each candidate in its OWN short context; one failure keeps the rest. */
async function reverseCandidates(
  conn: AccountingConnection,
  remotePaymentId: string,
  candidates: readonly MappingRow[],
  runInDbContext: DbContextRunner,
  expectedRealmFingerprint: string | null,
): Promise<PaymentPullResult[]> {
  const results: PaymentPullResult[] = [];
  for (const candidate of candidates) {
    const reversed = await runInDbContext(
      () => reverseOneInsideTransaction(conn, remotePaymentId, candidate, expectedRealmFingerprint),
    );
    // The realm moved under us: stop, and report it ONCE rather than per
    // candidate. Every remaining candidate would answer identically.
    if (reversed === REALM_CHANGED) {
      results.push(result('realm_changed', remotePaymentId, null));
      break;
    }
    if (!reversed) continue;
    results.push(reversed.result);
    if (reversed.audit) fireAudit(conn, reversed.audit);
  }
  return results;
}

/** Sentinel: the connection's realm changed, so this transaction wrote nothing. */
const REALM_CHANGED = Symbol('realm_changed');

async function reverseOneInsideTransaction(
  conn: AccountingConnection,
  remotePaymentId: string,
  mapping: MappingRow,
  expectedRealmFingerprint: string | null,
): Promise<ApplyOutcome | null | typeof REALM_CHANGED> {
  if (!await realmStillMatches(conn, expectedRealmFingerprint)) return REALM_CHANGED;

  const remoteInvoiceId = mapping.remoteEntityId?.slice(remotePaymentId.length + 1) ?? null;

  // A Payment BREEZE created that somebody removed in QuickBooks (spec decision
  // 5). The Breeze payment row SURVIVES: the money really moved (a Stripe
  // charge, a cheque), and deleting Breeze's record because the accounting
  // mirror was removed would destroy the evidence of a real receipt. Clearing
  // `remote_entity_id` makes the payment re-pushable (the unique index on it is
  // PARTIAL — `WHERE remote_entity_id IS NOT NULL` — so nulling it can never
  // collide); the error puts the decision in front of a human.
  //
  // Checked BEFORE the unlocked payment read on purpose: that read's `!pre` arm
  // SWEEPS the mapping row, which for a Breeze-origin row would silently drop an
  // outbox entry that still owes QuickBooks a delete.
  //
  // No invoice lock is taken and no recompute runs: the only write is to the
  // mapping row, and no money row and no invoice balance change.
  //
  // `reverseStaleAllocations` reaches the same branch, which is why a dropped
  // allocation on a Breeze-origin payment is a divergence, not a reversal.
  if (mapping.breezeOrigin) {
    const marked = await db
      .update(accountingEntityMappings)
      .set({
        syncStatus: 'error',
        lastError: BREEZE_ORIGIN_REMOVED_MESSAGE,
        remoteEntityId: null,
        remoteSyncToken: null,
        updatedAt: new Date(),
      })
      .where(and(
        eq(accountingEntityMappings.id, mapping.id),
        eq(accountingEntityMappings.partnerId, conn.partnerId),
      ))
      .returning({ id: accountingEntityMappings.id });
    if (marked.length !== 1) {
      throw new Error(
        `accountingPaymentPull: Breeze-origin removal marker matched no row (id=${mapping.id})`,
      );
    }
    // `pending_op` and `claimed_at` are deliberately UNTOUCHED: the mapping is
    // the push outbox, and a row that still owes QuickBooks a delete (or a
    // re-push) must keep owing it. The push coordinator, not the pull, closes
    // out its own claims.
    return {
      result: result(
        'breeze_origin_removed_remotely', remotePaymentId, remoteInvoiceId, null, mapping.breezeEntityId,
      ),
      audit: null,
    };
  }

  // Unlocked discovery read: which invoice owns the mapped payment row?
  const pre = await loadPaymentRow(mapping.breezeEntityId);
  if (!pre) {
    // The payment row is already gone (a manual void or a Stripe full refund
    // that ran before the Phase-D mapping cleanup existed). Sweep the orphan
    // mapping so a later CDC replay is a clean no-op, and report nothing
    // destroyed — there is no invoice balance to recompute.
    await deleteMappingRow(conn, mapping.id);
    return null;
  }

  const inv = await lockOwnedInvoice(pre.invoiceId, conn.partnerId);
  if (!inv) return null; // erased org / foreign partner

  // Re-read both rows UNDER the lock: a concurrent reversal may have won.
  const locked = await loadMappingById(conn, mapping.id);
  if (!locked) return null;
  const pay = await loadPaymentRow(locked.breezeEntityId);
  if (!pay) {
    await deleteMappingRow(conn, locked.id);
    return null;
  }

  // Snapshot the destroyed row's financial details BEFORE the delete so the
  // reversal survives in the durable audit chain (invoiceService.voidPayment's
  // precedent) even though the row itself will not.
  const snapshot = { amount: pay.amount, method: pay.method, reference: pay.reference, receivedAt: pay.receivedAt };

  const removedPayments = await db
    .delete(invoicePayments)
    .where(eq(invoicePayments.id, pay.id))
    .returning({ id: invoicePayments.id });
  if (removedPayments.length !== 1) {
    throw new Error(
      `accountingPaymentPull: invoice_payments delete matched no row (id=${pay.id}) while holding the invoice lock`,
    );
  }
  await deleteMappingRow(conn, locked.id, { required: true });

  await recomputeInvoiceStatus(inv.id, db);

  return {
    result: result('reversed', remotePaymentId, remoteInvoiceId, inv.id, pay.id),
    audit: {
      orgId: inv.orgId,
      action: 'accounting.payment.reversed',
      resourceId: inv.id,
      details: {
        remotePaymentId,
        remoteInvoiceId,
        invoicePaymentId: pay.id,
        ...snapshot,
        reason: 'deleted_in_quickbooks',
      },
    },
  };
}

async function deleteMappingRow(
  conn: AccountingConnection,
  mappingId: string,
  opts: { required?: boolean } = {},
): Promise<number> {
  const rows = await db
    .delete(accountingEntityMappings)
    .where(and(
      eq(accountingEntityMappings.id, mappingId),
      eq(accountingEntityMappings.partnerId, conn.partnerId),
    ))
    .returning({ id: accountingEntityMappings.id });
  if (opts.required && rows.length !== 1) {
    throw new Error(`accountingPaymentPull: payment mapping delete matched no row (id=${mappingId})`);
  }
  return rows.length;
}

// ---------------------------------------------------------------------------
// markInvoiceDeletedRemotely
// ---------------------------------------------------------------------------

/**
 * Records that QuickBooks deleted or voided an invoice Breeze pushed.
 *
 * Deliberately does NOT clear `remote_entity_id` and does NOT re-push. Clearing
 * the remote id would make the next push CREATE a second QuickBooks invoice for
 * a document the operator deliberately removed; the error marker leaves the
 * link intact and puts the decision in front of a human.
 */
export async function markInvoiceDeletedRemotely(
  conn: AccountingConnection,
  remoteInvoiceId: string,
  runInDbContext: DbContextRunner,
  expectedRealmFingerprint: string | null,
): Promise<'marked' | 'skipped_unmapped' | 'realm_changed' | 'invoice_void'> {
  assertNoAmbientDbContext('markInvoiceDeletedRemotely');

  return runInDbContext(async () => {
    if (!await realmStillMatches(conn, expectedRealmFingerprint)) return 'realm_changed';
    const mapping = await loadMappingByRemoteId(conn, 'invoice', 'Invoice', remoteInvoiceId);
    if (!mapping) return 'skipped_unmapped';

    // SELF-VOID GUARD (Phase D2, spec decision 11). Breeze's own void job voids
    // the invoice in QuickBooks, and CDC reports that void as a deletion — so
    // without this the operator voids an invoice in Breeze and, seconds later,
    // the mapping card shows the alarming "Deleted in QuickBooks". A Breeze
    // invoice that is ALREADY void is the author of this notification, not its
    // victim. A MISSING invoice row is not: an erased org leaves the mapping as
    // the only record, and answering `invoice_void` there would hide a real
    // remote deletion.
    const rows = await db
      .select({ status: invoices.status })
      .from(invoices)
      .where(and(eq(invoices.id, mapping.breezeEntityId), eq(invoices.partnerId, conn.partnerId)))
      .limit(1);
    if ((rows as Array<{ status: string }>)[0]?.status === 'void') return 'invoice_void';

    await markInvoiceMappingError(conn, mapping.id, BREEZE_ORIGIN_REMOVED_MESSAGE);
    return 'marked';
  });
}
