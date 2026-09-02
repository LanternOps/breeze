/**
 * The QuickBooks -> Breeze payment applier (Phase D, Task 3 —
 * .superpowers/sdd/2026-09-02-quickbooks-phase-d-payment-pullback/task-3-brief.md).
 *
 * Consumes one `ChangeSetPaymentLine` produced by `reconcileChanges` (Task 2)
 * and lands it as an `invoice_payments` row plus the `accounting_entity_mappings`
 * row that claims it, at most once. Also mirrors QBO-side deletions
 * (`reverseAccountingPayment`, `markInvoiceDeletedRemotely`) and owns the
 * mapping-row cleanup the two Breeze-side payment destroyers must perform
 * (`clearPaymentMappingForInvoicePayment`, called from
 * `invoiceService.voidPayment` and `stripeReconcile`'s full-refund branch).
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

import { and, eq, like } from 'drizzle-orm';
import { db } from '../../db';
import { accountingEntityMappings, invoicePayments, invoices } from '../../db/schema';
import type { AccountingEntityMapping as AccountingEntityMappingRow } from '../../db/schema';
import { assertNoAmbientDbContext, type DbContextRunner } from './dbContextGuard';
import { AccountingCurrencyContractError, normalizeAccountingPayment } from './accountingCurrency';
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

/**
 * Anything that can issue the mapping DELETE: the ambient `db` proxy (which,
 * inside an open access context, IS the transaction handle) or an explicit
 * drizzle transaction handle. Same shape as `invoiceService`'s own `DbExecutor`.
 */
export type PaymentMappingExecutor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Audit intent captured inside the transaction, fired only after it commits. */
interface PendingAudit {
  orgId: string;
  action: 'accounting.payment.pulled' | 'accounting.payment.reversed';
  resourceId: string;
  details: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * `<PaymentId>/<remoteInvoiceId>` — plan decision 1.
 *
 * One QuickBooks Payment can settle SEVERAL invoices (a split payment carries
 * one `Line` per invoice). `accounting_entity_mappings_remote_uniq` is unique on
 * `(integration_id, remote_entity_type, remote_entity_id)`, so a bare Payment id
 * would let only the first split line claim a mapping and the rest would collide.
 * Qualifying it by the invoice makes each (payment, invoice) pair its own claim,
 * and `reverseAccountingPayment` recovers the whole set with a `<PaymentId>/%`
 * prefix match.
 */
export function paymentMappingRemoteId(remotePaymentId: string, remoteInvoiceId: string): string {
  return `${remotePaymentId}/${remoteInvoiceId}`;
}

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
): Promise<PaymentPullResult> {
  assertNoAmbientDbContext('applyAccountingPayment');

  const remoteMappingId = paymentMappingRemoteId(line.remotePaymentId, line.remoteInvoiceId);

  let outcome: ApplyOutcome;
  try {
    // ONE short, self-committing context — that invocation IS the transaction,
    // so every statement below shares it and commits together.
    outcome = await runInDbContext(() => applyInsideTransaction(conn, line, remoteMappingId));
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
): Promise<ApplyOutcome> {
  const noAudit = (r: PaymentPullResult): ApplyOutcome => ({ result: r, audit: null });

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
    await markInvoiceMappingError(conn, invoiceMapping.id, message);
    captureException(
      new Error(`${message} (remotePaymentId=${line.remotePaymentId}, invoiceId=${inv.id})`),
      undefined,
      { service: 'accountingPaymentPull', remotePaymentId: line.remotePaymentId, invoiceId: inv.id },
    );
    return noAudit(result('invoice_void', line.remotePaymentId, line.remoteInvoiceId, inv.id));
  }

  // (c) Authoritative at-most-once claim, read under the lock.
  const existing = await loadMappingByRemoteId(conn, 'payment', 'Payment', remoteMappingId);

  // (d) Currency equality asserted BEFORE any minor-unit conversion, against the
  // LOCKED invoice's stamped currency (multi-currency §11).
  let normalized;
  try {
    normalized = normalizeAccountingPayment(line, { invoiceId: inv.id, currencyCode: inv.currencyCode });
  } catch (err) {
    if (!(err instanceof AccountingCurrencyContractError)) throw err;
    // `err.message` is generated locally by accountingCurrency.ts — never a QBO
    // response body — so it is safe to persist verbatim.
    await markInvoiceMappingError(conn, invoiceMapping.id, err.message);
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

/**
 * Flips ONE mapping row to `sync_status='error'` with an operator-readable
 * reason. Deliberately narrow: it never touches `remote_entity_id` or
 * `link_status`, so the link back to QuickBooks survives the failure and a later
 * push/pull can clear the marker instead of re-creating the remote entity.
 */
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
): Promise<PaymentPullResult[]> {
  assertNoAmbientDbContext('reverseAccountingPayment');

  const candidates = await loadPaymentMappingCandidates(conn, remotePaymentId, runInDbContext);
  return reverseCandidates(conn, remotePaymentId, candidates, runInDbContext);
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
): Promise<PaymentPullResult[]> {
  assertNoAmbientDbContext('reverseStaleAllocations');

  const keep = new Set(keepRemoteInvoiceIds);
  const prefixLength = remotePaymentId.length + 1;
  const candidates = (await loadPaymentMappingCandidates(conn, remotePaymentId, runInDbContext))
    .filter((row) => !keep.has(row.remoteEntityId?.slice(prefixLength) ?? ''));
  if (candidates.length === 0) return [];

  return reverseCandidates(conn, remotePaymentId, candidates, runInDbContext);
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
): Promise<PaymentPullResult[]> {
  const results: PaymentPullResult[] = [];
  for (const candidate of candidates) {
    const reversed = await runInDbContext(() => reverseOneInsideTransaction(conn, remotePaymentId, candidate));
    if (!reversed) continue;
    results.push(reversed.result);
    if (reversed.audit) fireAudit(conn, reversed.audit);
  }
  return results;
}

async function reverseOneInsideTransaction(
  conn: AccountingConnection,
  remotePaymentId: string,
  mapping: MappingRow,
): Promise<ApplyOutcome | null> {
  const remoteInvoiceId = mapping.remoteEntityId?.slice(remotePaymentId.length + 1) ?? null;

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
): Promise<'marked' | 'skipped_unmapped'> {
  assertNoAmbientDbContext('markInvoiceDeletedRemotely');

  return runInDbContext(async () => {
    const mapping = await loadMappingByRemoteId(conn, 'invoice', 'Invoice', remoteInvoiceId);
    if (!mapping) return 'skipped_unmapped';
    await markInvoiceMappingError(conn, mapping.id, 'Deleted in QuickBooks');
    return 'marked';
  });
}

// ---------------------------------------------------------------------------
// clearPaymentMappingForInvoicePayment
// ---------------------------------------------------------------------------

/**
 * Deletes the `payment` mapping row for one `invoice_payments` id, INSIDE the
 * caller's transaction.
 *
 * Called by `invoiceService.voidPayment` and `stripeReconcile`'s full-refund
 * branch — both already hold the invoice row lock, and both destroy the payment
 * row. `breeze_entity_id` is polymorphic, so there is no FK to cascade: without
 * this call the mapping row outlives its payment and a later CDC delivery for
 * the same QuickBooks Payment would look "already applied" and silently skip.
 *
 * Returns the number of rows removed. ZERO IS LEGITIMATE and deliberately not a
 * throw: a manual or Stripe-sourced payment has no accounting mapping at all,
 * which is the common case at both call sites.
 */
export async function clearPaymentMappingForInvoicePayment(
  tx: PaymentMappingExecutor,
  invoicePaymentId: string,
): Promise<number> {
  const rows = await tx
    .delete(accountingEntityMappings)
    .where(and(
      eq(accountingEntityMappings.breezeEntityType, 'payment'),
      eq(accountingEntityMappings.breezeEntityId, invoicePaymentId),
    ))
    .returning({ id: accountingEntityMappings.id });
  return rows.length;
}
