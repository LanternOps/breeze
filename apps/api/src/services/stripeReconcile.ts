import { and, eq, isNull } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../db';
import { invoices, invoicePayments } from '../db/schema/invoices';
import { invoiceStripePayments } from '../db/schema/stripePayments';
import { recomputeInvoiceStatus } from './invoiceService';
import { emitInvoiceEvent } from './invoiceEvents';
import { fromMinorUnits } from './stripeMoney';
import { captureException } from './sentry';
import { writeAuditEvent, requestLikeFromSnapshot } from './auditEvents';
import { clearPaymentMappingForInvoicePayment } from './accounting/accountingPaymentPull';

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
  | { kind: 'terminal'; invoiceId: string; orgId: string; partnerId: string; reason: string }
  | { kind: 'recorded'; invoiceId: string; orgId: string; partnerId: string; paymentId: string; paid: boolean };

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
export async function recordStripePayment(input: CaptureInput): Promise<{ invoiceId: string }> {
  const outcome = await withSystemDbAccessContext(async (): Promise<ReconcileOutcome> => {
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
    if (mapping.invoicePaymentId) return { kind: 'noop', invoiceId: mapping.invoiceId };

    // TERMINAL conditions: a retry will NEVER succeed, so we must not throw (a
    // thrown error → 500 → Stripe retries forever). Instead mark the mapping
    // failed and RETURN 202-cleanly; the payment.failed event + Sentry capture
    // happen after the transaction (no Redis work under the held lock).
    const terminalFail = async (reason: string): Promise<ReconcileOutcome> => {
      await markMapping(mapping.id, 'failed');
      return { kind: 'terminal', invoiceId: inv.id, orgId: inv.orgId, partnerId: inv.partnerId, reason };
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
    if (!input.stripeAccountId || input.stripeAccountId !== mapping.stripeAccountId) {
      return terminalFail(`account mismatch (event=${input.stripeAccountId} mapping=${mapping.stripeAccountId})`);
    }
    // The locked row's balance is authoritative against the locking writers
    // (recordPayment, voidPayment, this path): each holds the invoice row lock
    // while recomputeInvoiceStatus persists it. reflectStripeRefund below does
    // NOT take the lock before its recompute — deliberately deferred (#3803
    // item 1), so a refund racing this path can still interleave.
    if (toCents(input.amount) > toCents(inv.balance)) {
      return terminalFail('overpayment: payment exceeds balance');
    }

    const [payment] = await db.insert(invoicePayments).values({
      invoiceId: inv.id, orgId: inv.orgId, amount: Number(input.amount).toFixed(2),
      method: 'card', reference: input.stripePaymentIntentId,
      receivedAt: input.receivedAt ?? new Date().toISOString().slice(0, 10), recordedBy: null, note: null
    }).returning();

    // Guarded link: only an UNLINKED mapping may take this payment id. Under the
    // held locks a miss means the locking contract broke — fail loudly (500 →
    // Stripe retries; the tx rolls the orphan payment insert back too).
    const linked = await db.update(invoiceStripePayments)
      .set({ invoicePaymentId: payment!.id, status: 'succeeded', stripePaymentIntentId: input.stripePaymentIntentId,
             lastEventAt: new Date(), updatedAt: new Date() })
      .where(and(eq(invoiceStripePayments.id, mapping.id), isNull(invoiceStripePayments.invoicePaymentId)))
      .returning({ id: invoiceStripePayments.id });
    if (linked.length !== 1) {
      throw new Error(`Mapping for stripe object ${input.stripeObjectId} changed under the payment lock`);
    }

    await recomputeInvoiceStatus(inv.id);
    const [updated] = await db.select().from(invoices).where(eq(invoices.id, inv.id)).limit(1);
    return { kind: 'recorded', invoiceId: inv.id, orgId: inv.orgId, partnerId: inv.partnerId,
             paymentId: payment!.id, paid: updated?.status === 'paid' };
  });

  // Side effects AFTER the transaction commits (and the row locks release).
  if (outcome.kind === 'terminal') {
    console.warn('[stripeReconcile] terminal payment failure', { stripeObjectId: input.stripeObjectId, invoiceId: outcome.invoiceId, reason: outcome.reason });
    // A customer was charged on Stripe and we are refusing to record it (currency
    // mismatch, overpayment, account mismatch, void/draft invoice). That is a money
    // divergence requiring human reconciliation — surface it to Sentry, not just logs.
    captureException(new Error(`[stripeReconcile] terminal payment failure (${outcome.reason}) stripeObjectId=${input.stripeObjectId} invoiceId=${outcome.invoiceId}`));
    await emitInvoiceEvent({ type: 'payment.failed', invoiceId: outcome.invoiceId, orgId: outcome.orgId, partnerId: outcome.partnerId });
  } else if (outcome.kind === 'recorded') {
    await emitInvoiceEvent({ type: 'payment.recorded', invoiceId: outcome.invoiceId, orgId: outcome.orgId,
      partnerId: outcome.partnerId, paymentId: outcome.paymentId });
    if (outcome.paid) {
      await emitInvoiceEvent({ type: 'invoice.paid', invoiceId: outcome.invoiceId, orgId: outcome.orgId, partnerId: outcome.partnerId });
    }
  }
  return { invoiceId: outcome.invoiceId };
}

export async function markMapping(mappingId: string, status: 'failed' | 'refunded' | 'partially_refunded'): Promise<void> {
  await db.update(invoiceStripePayments)
    .set({ status, lastEventAt: new Date(), updatedAt: new Date() })
    .where(eq(invoiceStripePayments.id, mappingId));
}

interface RefundInput {
  stripePaymentIntentId: string;
  amountRefundedCents: number; // cumulative refunded on the charge
  chargeAmountCents: number;   // original captured amount
  currency: string;           // charge currency (drives minor-unit conversion)
  stripeAccountId: string;    // event.account — must match the mapping's connected account
}

/** Reflect a Stripe-side refund. No Breeze-initiated money movement. System context. */
export async function reflectStripeRefund(input: RefundInput): Promise<void> {
  await withSystemDbAccessContext(async () => {
    const [mapping] = await db.select().from(invoiceStripePayments)
      .where(eq(invoiceStripePayments.stripePaymentIntentId, input.stripePaymentIntentId)).limit(1);
    if (!mapping) {
      // No mapping for this PI — leave a forensic trail (money divergence: a refund
      // landed for a charge we have no record of, or a redelivery after cleanup).
      console.warn('[stripeReconcile] refund for unknown payment_intent — no mapping', { stripePaymentIntentId: input.stripePaymentIntentId });
      return;
    }
    if (!mapping.invoicePaymentId) {
      // Mapping exists but was never linked to a payment row (e.g. the charge was
      // terminal-failed). Nothing to reflect, but record why for reconciliation.
      console.warn('[stripeReconcile] refund for a payment_intent with no linked payment row', { stripePaymentIntentId: input.stripePaymentIntentId, mappingId: mapping.id });
      return;
    }

    // Account binding (mirror recordStripePayment's guard): a refund event whose
    // account does not match the mapping's connected account must never mutate
    // another account's payment row.
    if (!input.stripeAccountId || input.stripeAccountId !== mapping.stripeAccountId) {
      console.warn('[stripeReconcile] refund account mismatch — refusing to mutate payment row', {
        stripePaymentIntentId: input.stripePaymentIntentId, eventAccount: input.stripeAccountId, mappingAccount: mapping.stripeAccountId,
      });
      return;
    }

    const paymentId = mapping.invoicePaymentId;
    const full = input.amountRefundedCents >= input.chargeAmountCents;
    if (full) {
      // Full refund → void the payment row (mirrors voidPayment mechanics).
      // Snapshot the financial record BEFORE deleting so the destroyed payment
      // (amount/method/recordedBy/invoiceId) survives in the durable audit chain —
      // this is a webhook path with no Hono request context, so we use the
      // system-scope audit writer (mirrors quoteExpiryReaper), not writeRouteAudit.
      const [snapshot] = await db.select().from(invoicePayments).where(eq(invoicePayments.id, paymentId)).limit(1);
      // Clear the 'payment' accounting_entity_mappings row for this
      // invoice_payments id FIRST (same reasoning as invoiceService.voidPayment:
      // breeze_entity_id is polymorphic so nothing cascades). A Stripe-captured
      // payment normally has no accounting mapping at all — this returns 0 and is
      // a deliberate orphan sweep, not an expected deletion. `db` here IS the
      // transaction handle: this whole callback runs inside the enclosing
      // withSystemDbAccessContext transaction.
      await clearPaymentMappingForInvoicePayment(db, paymentId);
      await db.delete(invoicePayments).where(eq(invoicePayments.id, paymentId));
      await db.update(invoiceStripePayments)
        .set({ status: 'refunded', invoicePaymentId: null, lastEventAt: new Date(), updatedAt: new Date() })
        .where(eq(invoiceStripePayments.id, mapping.id));
      // Best-effort, never throwing (consistent with the rest of this reconcile path).
      try {
        writeAuditEvent(requestLikeFromSnapshot({}), {
          orgId: mapping.orgId,
          action: 'invoice.payment.voided',
          resourceType: 'invoice_payment',
          resourceId: paymentId,
          actorType: 'system',
          actorId: null,
          result: 'success',
          details: {
            amount: snapshot?.amount,
            method: snapshot?.method,
            recordedBy: snapshot?.recordedBy ?? null,
            invoiceId: mapping.invoiceId,
            reason: 'stripe_refund',
          },
        });
      } catch (err) {
        console.error('[stripeReconcile] failed to write void audit event', err);
      }
    } else {
      // Partial refund → reduce the positive payment amount (stays > 0; respects the amount>0 CHECK).
      // Currency-aware: zero-decimal currencies (JPY, …) must NOT be divided by 100.
      const remainingCents = input.chargeAmountCents - input.amountRefundedCents;
      await db.update(invoicePayments)
        .set({ amount: fromMinorUnits(remainingCents, input.currency) })
        .where(eq(invoicePayments.id, paymentId));
      await db.update(invoiceStripePayments)
        .set({ status: 'partially_refunded', lastEventAt: new Date(), updatedAt: new Date() })
        .where(eq(invoiceStripePayments.id, mapping.id));
    }
    await recomputeInvoiceStatus(mapping.invoiceId);
    await emitInvoiceEvent({ type: 'payment.voided', invoiceId: mapping.invoiceId, orgId: mapping.orgId,
      partnerId: await invoicePartnerId(mapping.invoiceId), paymentId });
  });
}

async function invoicePartnerId(invoiceId: string): Promise<string> {
  const [inv] = await db.select({ partnerId: invoices.partnerId }).from(invoices).where(eq(invoices.id, invoiceId)).limit(1);
  return inv!.partnerId;
}
