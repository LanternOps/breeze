import { enqueueOnlineReceipt } from './autopay/paymentNotices';
import { and, eq, isNull } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../db';
import { invoices, invoicePayments } from '../db/schema/invoices';
import { invoiceStripePayments } from '../db/schema/stripePayments';
import { recomputeInvoiceStatus } from './invoiceService';
import { emitInvoiceEvent } from './invoiceEvents';
import { fromMinorUnits, toMinorUnits } from './stripeMoney';
import { captureException } from './sentry';
import { requestPaymentPush } from './accounting/accountingPaymentPush';
import { enqueueAccountingPaymentPush } from '../jobs/accountingSyncWorker';
import { processPendingStripeFinancialEventsForPayment } from './stripeReversalState';
import { markSiblingRevocationIntentInTx, markSessionChargedRepair } from './stripeSessionRevocation';

function toCents(v: string | number) { return Math.round(Number(v) * 100); }

interface CaptureInput {
  stripeObjectId: string;            // cs_… or pi_…
  stripePaymentIntentId: string;     // pi_…
  stripeAccountId: string;
  amount: string;                    // major units, e.g. "100.00"
  currency: string;
  receivedAt?: string;               // YYYY-MM-DD
}

/** Post-transaction outcome descriptor: side effects (Sentry/event emission)
 *  run only after the reconcile transaction — and its invoice row lock — end. */
type ReconcileOutcome =
  | { kind: 'noop'; invoiceId: string }
  | { kind: 'terminal'; invoiceId: string; orgId: string; partnerId: string; reason: string; source: (typeof invoiceStripePayments.$inferSelect)['source'] }
  | {
    kind: 'recorded'; invoiceId: string; orgId: string; partnerId: string; paymentId: string; paid: boolean;
    // The accounting mapping row this capture created, owed a `push-payment`
    // job once the transaction has returned. Null = nothing owed.
    paymentPushMappingId: string | null;
  };

/**
 * Reconcile a captured Stripe charge into the engine. System DB context (webhook is unauth).
 * Idempotent via the invoice_stripe_payments mapping (unique stripe_object_id) and the
 * mapping.invoice_payment_id guard. Single reconcile point: recomputeInvoiceStatus.
 *
 * Race safety (B10, #3774): withSystemDbAccessContext runs its callback in ONE
 * transaction, and the lock order matches every other payment writer — invoice
 * row FOR UPDATE first, THEN the mapping row re-read FOR UPDATE (two webhook
 * deliveries can both observe a null invoice_payment_id in the unlocked
 * discovery read), then the payment insert and a GUARDED mapping link.
 */
export interface RecordStripePaymentOptions {
  /**
   * Charged-repair (the settle-from-Checkout paths): once the capture
   * has decided, park the session for a human when its mapping is no longer
   * `active`/`legacy_unbounded` — i.e. a session we asked Stripe to kill that
   * Stripe nonetheless reports paid. Provider truth still wins: the capture is
   * recorded (or terminal-failed) exactly as without this flag.
   *
   * Runs in THIS transaction, after the capture's own writes, so the park
   * commits or rolls back with them. That also keeps the B10 lock order: on the
   * locking paths the capture has already taken the invoice row and then the
   * mapping row, and on the early already-linked no-op no lock is held yet, so
   * the park's single-row mapping UPDATE never takes a lock out of order.
   */
  markChargedRepairIfRevoked?: boolean;
}

/**
 * Runs one post-commit side effect of a Stripe capture (#7069). By the time these
 * run, the capture's transaction has COMMITTED: the payment row, mapping link and
 * invoice status are durable. A throw from here would make recordStripePayment
 * reject, so the portal settle route would answer { settled:false } and the sweep
 * would count a failure for money that is already recorded (and a webhook would
 * 500 into a Stripe retry that short-circuits on the linked mapping). So a failure
 * is logged and reported to Sentry, never propagated.
 */
async function afterCommit(
  stage: string,
  ctx: { partnerId: string; invoiceId: string; stripeObjectId: string },
  fn: () => Promise<void>,
): Promise<void> {
  try {
    await fn();
  } catch (err) {
    console.error(`[stripeReconcile] post-commit ${stage} failed (capture already committed)`,
      `invoiceId=${ctx.invoiceId}`, `stripeObjectId=${ctx.stripeObjectId}`, err instanceof Error ? err.message : err);
    captureException(err instanceof Error ? err : new Error(String(err)), undefined, {
      partner_id: ctx.partnerId,
      stripe_reconcile_stage: stage,
    });
  }
}

export async function recordStripePayment(
  input: CaptureInput,
  options: RecordStripePaymentOptions = {},
): Promise<{ invoiceId: string }> {
  // The capture decision proper. Runs inside the transaction opened below.
  const captureUnderLock = async (): Promise<ReconcileOutcome> => {
    // Unlocked discovery read: maps the Stripe object to an invoice id so the
    // invoice lock can be taken first. NOT authoritative — rechecked under lock.
    const [pre] = await db.select().from(invoiceStripePayments)
      .where(eq(invoiceStripePayments.stripeObjectId, input.stripeObjectId)).limit(1);
    // A genuinely missing mapping is unexpected/transient (race against the pay
    // route's INSERT, or a stale redelivery) — throw so the webhook 500s and
    // Stripe retries, by which point the mapping should exist.
    if (!pre) throw new Error(`No mapping for stripe object ${input.stripeObjectId}`);
    if (pre.invoicePaymentId) return { kind: 'noop', invoiceId: pre.invoiceId }; // already recorded — no-op

    const [inv] = await db.select().from(invoices).where(eq(invoices.id, pre.invoiceId)).limit(1).for('update');
    if (!inv) throw new Error(`Invoice ${pre.invoiceId} not found`);
    // Mapping re-read AFTER the invoice lock: a concurrent delivery that won the
    // lock has already linked it — this is the authoritative idempotency check.
    const [mapping] = await db.select().from(invoiceStripePayments)
      .where(eq(invoiceStripePayments.id, pre.id)).limit(1).for('update');
    if (!mapping) throw new Error(`Mapping for stripe object ${input.stripeObjectId} disappeared`);
    if (mapping.invoicePaymentId || mapping.paymentCapturedAt) return { kind: 'noop', invoiceId: mapping.invoiceId };
    if ((mapping.status === 'failed' && mapping.stripeObjectType !== 'payment_intent')
        || mapping.status === 'refunded' || mapping.status === 'disputed') {
      return { kind: 'noop', invoiceId: mapping.invoiceId };
    }
    if (mapping.status === 'partially_refunded' || mapping.status === 'partially_disputed') {
      throw new Error(`Partially reversed mapping ${mapping.id} lost its linked payment`);
    }

    // TERMINAL conditions: a retry will NEVER succeed, so we must not throw (a
    // thrown error → 500 → Stripe retries forever). Instead mark the mapping
    // failed and RETURN 202-cleanly; the payment.failed event + Sentry capture
    // happen after the transaction (no Redis work under the held lock).
    const terminalFail = async (reason: string): Promise<ReconcileOutcome> => {
      await markMapping(mapping.id, 'failed');
      return { kind: 'terminal', invoiceId: inv.id, orgId: inv.orgId, partnerId: inv.partnerId, reason, source: mapping.source };
    };

    if (inv.status === 'draft' || inv.status === 'void') {
      return terminalFail(`invoice is ${inv.status}`);
    }
    // Defense-in-depth (F4): the verified webhook amount must be in the invoice's
    // own currency, and the charge must have landed on the account the mapping
    // was created against. A mismatch means tampering or a routing bug, never a
    // transient — terminal-fail rather than silently writing a wrong-currency row.
    if (String(input.currency).toUpperCase() !== String(inv.currencyCode).toUpperCase()) {
      return terminalFail(`currency mismatch (event=${input.currency} invoice=${inv.currencyCode})`);
    }
    if (mapping.currency && String(input.currency).toUpperCase() !== String(mapping.currency).toUpperCase()) {
      return terminalFail(`currency mismatch (event=${input.currency} mapping=${mapping.currency})`);
    }
    if (!input.stripeAccountId || input.stripeAccountId !== mapping.stripeAccountId) {
      return terminalFail(`account mismatch (event=${input.stripeAccountId} mapping=${mapping.stripeAccountId})`);
    }
    if (mapping.stripePaymentIntentId && mapping.stripePaymentIntentId !== input.stripePaymentIntentId) {
      return terminalFail(`payment intent mismatch (event=${input.stripePaymentIntentId} mapping=${mapping.stripePaymentIntentId})`);
    }
    const principalAmount = mapping.amount ?? input.amount;
    const principalMinor = toMinorUnits(principalAmount, input.currency);
    const feeMinor = toMinorUnits(mapping.feeAmount ?? '0.00', input.currency);
    const grossMinor = principalMinor + feeMinor;
    if (!Number.isSafeInteger(grossMinor) || grossMinor <= 0
        || toMinorUnits(input.amount, input.currency) !== grossMinor) {
      return terminalFail(`amount mismatch (event=${input.amount} principal=${principalAmount} fee=${mapping.feeAmount ?? '0.00'})`);
    }
    // Exact cents on both sides (#3803 item 8). Converting the BALANCE to minor
    // units rounded it first, so a JPY 1001 capture against a legacy 1000.50
    // balance compared 1001 > 1001, passed, and was recorded as an overpayment.
    if (toCents(fromMinorUnits(principalMinor, inv.currencyCode)) > toCents(inv.balance)) {
      return terminalFail('overpayment: principal exceeds balance');
    }

    const receivedAt = input.receivedAt ?? new Date().toISOString().slice(0, 10);
    const [payment] = await db.insert(invoicePayments).values({
      invoiceId: inv.id, orgId: inv.orgId,
      amount: fromMinorUnits(principalMinor, inv.currencyCode),
      method: mapping.paymentMethodType === 'us_bank_account' ? 'ach_debit' : 'card',
      reference: input.stripePaymentIntentId,
      receivedAt, recordedBy: null, note: null,
    }).returning();

    // Guarded link: only an UNLINKED mapping may take this payment id. Under the
    // held locks a miss means the locking contract broke — fail loudly (500 →
    // Stripe retries; the tx rolls the orphan payment insert back too).
    const linked = await db.update(invoiceStripePayments)
      .set({ invoicePaymentId: payment!.id, status: 'succeeded', stripePaymentIntentId: input.stripePaymentIntentId,
             paymentReceivedAt: receivedAt, paymentCapturedAt: new Date(),
             lastEventAt: new Date(), updatedAt: new Date() })
      .where(and(eq(invoiceStripePayments.id, mapping.id), isNull(invoiceStripePayments.invoicePaymentId)))
      .returning({ id: invoiceStripePayments.id });
    if (linked.length !== 1) {
      throw new Error(`Mapping for stripe object ${input.stripeObjectId} changed under the payment lock`);
    }

    // The capture just cleared the balance every OTHER open Checkout
    // session on this invoice was minted to collect, so each of them is now a
    // second charge waiting to happen. Intent is stamped HERE, under the invoice
    // lock this transaction already holds — see markSiblingRevocationIntentInTx
    // for why escaping to a second connection would self-deadlock. The sweep
    // does the provider call, so a Stripe outage can never fail a capture.
    await markSiblingRevocationIntentInTx(inv.id, input.stripeObjectId, db);

    await recomputeInvoiceStatus(inv.id);
    // Only principal settles the invoice and enters this accounting payment
    // outbox. The mapping preserves the fee separately for W5 fee-income posting.
    // `db` here IS the transaction handle — this callback runs inside the
    // enclosing withSystemDbAccessContext transaction, so the mapping row (the
    // outbox) commits with the payment or not at all.
    const paymentPushMappingId = await requestPaymentPush(db, {
      invoicePaymentId: payment!.id, invoiceId: inv.id, partnerId: inv.partnerId,
    });
    const [updated] = await db.select().from(invoices).where(eq(invoices.id, inv.id)).limit(1);
    // Receipt intent commits with the ledger for Checkout, PI and sweep captures.
    await enqueueOnlineReceipt(db, mapping.id);
    return { kind: 'recorded', invoiceId: inv.id, orgId: inv.orgId, partnerId: inv.partnerId,
             paymentId: payment!.id, paid: updated?.status === 'paid', paymentPushMappingId };
  };

  const outcome = await withSystemDbAccessContext(async (): Promise<ReconcileOutcome> => {
    const decided = await captureUnderLock();
    if (options.markChargedRepairIfRevoked) {
      const [mapping] = await db.select({ revocationState: invoiceStripePayments.revocationState })
        .from(invoiceStripePayments)
        .where(and(
          eq(invoiceStripePayments.stripeObjectId, input.stripeObjectId),
          eq(invoiceStripePayments.stripeObjectType, 'checkout_session'),
        )).limit(1);
      if (mapping && mapping.revocationState !== 'active' && mapping.revocationState !== 'legacy_unbounded') {
        await markSessionChargedRepair(
          input.stripeObjectId,
          `session settled while revocation_state=${mapping.revocationState}`,
        );
      }
    }
    return decided;
  });

  // Side effects AFTER the transaction commits (and the row locks release).
  // Every one of them is best-effort — see afterCommit (#7069).
  if (outcome.kind === 'terminal') {
    const commitCtx = { partnerId: outcome.partnerId, invoiceId: outcome.invoiceId, stripeObjectId: input.stripeObjectId };
    console.warn('[stripeReconcile] terminal payment failure', { stripeObjectId: input.stripeObjectId, invoiceId: outcome.invoiceId, reason: outcome.reason });
    // A customer was charged on Stripe and we are refusing to record it (currency
    // mismatch, overpayment, account mismatch, void/draft invoice). That is a money
    // divergence requiring human reconciliation — surface it to Sentry, not just logs.
    captureException(new Error(`[stripeReconcile] terminal payment failure (${outcome.reason}) stripeObjectId=${input.stripeObjectId} invoiceId=${outcome.invoiceId}`));
    if (outcome.source !== 'autopay') await afterCommit('settle-emit-payment.failed', commitCtx, () => emitInvoiceEvent({
      type: 'payment.failed', invoiceId: outcome.invoiceId, orgId: outcome.orgId, partnerId: outcome.partnerId }));
  } else if (outcome.kind === 'recorded') {
    const commitCtx = { partnerId: outcome.partnerId, invoiceId: outcome.invoiceId, stripeObjectId: input.stripeObjectId };
    await afterCommit('settle-emit-payment.recorded', commitCtx, () => emitInvoiceEvent({
      type: 'payment.recorded', invoiceId: outcome.invoiceId, orgId: outcome.orgId,
      partnerId: outcome.partnerId, paymentId: outcome.paymentId }));
    // Fire-and-forget nudge. The enqueue helper is itself Redis-outage-safe: the
    // mapping row is the durable record, so a lost job only delays the push
    // until the reconcile sweep re-enqueues it. The extra try/catch matters more
    // here than on the request path: an unexpected throw would 500 the webhook,
    // and Stripe would retry a capture that has already been recorded.
    if (outcome.paymentPushMappingId) {
      try {
        await enqueueAccountingPaymentPush(outcome.paymentPushMappingId, outcome.partnerId);
      } catch (err) {
        console.error('[stripeReconcile] enqueueAccountingPaymentPush failed (payment already committed)', `paymentId=${outcome.paymentId}`, err instanceof Error ? err.message : err);
      }
    }
    // A refund/dispute may have arrived before the capture linked its payment.
    // Apply that durable inbox now, before announcing the invoice as paid.
    // The capture has already committed. A throw here would 500 the webhook,
    // and Stripe's retry short-circuits on the now-existing mapping — so the
    // reversal would be skipped entirely until the ten-minute sweep. Continue
    // as if zero reversals applied and let the sweep pick them up.
    let appliedReversals = 0;
    try {
      appliedReversals = await processPendingStripeFinancialEventsForPayment(
        input.stripeAccountId,
        input.stripePaymentIntentId,
      );
    } catch (err) {
      console.error('[stripeReconcile] pending reversal application failed after the capture committed',
        `stripePaymentIntentId=${input.stripePaymentIntentId}`, err instanceof Error ? err.message : err);
      captureException(err instanceof Error ? err : new Error(String(err)), undefined, {
        partner_id: outcome.partnerId,
        stripe_reconcile_stage: 'settle-pending-reversals',
      });
    }
    let paidAfterReversals = outcome.paid;
    if (appliedReversals > 0) {
      // A reversal may have un-paid the invoice. If the re-read fails we cannot
      // confirm it is still paid, so invoice.paid is NOT announced (a false
      // "paid" is worse than a missing one; the invoice row itself is correct).
      paidAfterReversals = false;
      await afterCommit('settle-post-reversal-status', commitCtx, async () => {
        const [current] = await withSystemDbAccessContext(() => db.select({ status: invoices.status })
          .from(invoices).where(eq(invoices.id, outcome.invoiceId)).limit(1));
        paidAfterReversals = current?.status === 'paid';
      });
    }
    if (paidAfterReversals) {
      await afterCommit('settle-emit-invoice.paid', commitCtx, () => emitInvoiceEvent({
        type: 'invoice.paid', invoiceId: outcome.invoiceId, orgId: outcome.orgId, partnerId: outcome.partnerId }));
    }
  }
  return { invoiceId: outcome.invoiceId };
}

export async function markMapping(mappingId: string, status: 'failed'): Promise<void> {
  await db.update(invoiceStripePayments)
    .set({ status, lastEventAt: new Date(), updatedAt: new Date() })
    .where(eq(invoiceStripePayments.id, mappingId));
}
