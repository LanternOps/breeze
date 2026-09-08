import { createHash } from 'node:crypto';
import { and, asc, eq, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../db';
import { invoices, invoicePayments } from '../db/schema/invoices';
import { accountingEntityMappings } from '../db/schema/accounting';
import { invoiceStripePayments, stripeConnectAccounts, stripeFinancialEvents } from '../db/schema/stripePayments';
import { recomputeInvoiceStatus } from './invoiceService';
import { emitInvoiceEvent } from './invoiceEvents';
import { fromMinorUnits, toMinorUnits } from './stripeMoney';
import {
  partialRefundDivergenceMessage,
  requestPaymentDelete,
  requestPaymentPush,
} from './accounting/accountingPaymentPush';
import {
  enqueueAccountingPaymentDelete,
  enqueueAccountingPaymentPush,
} from '../jobs/accountingSyncWorker';
import { requestLikeFromSnapshot, writeAuditEventAsync } from './auditEvents';

export type NormalizedStripeFinancialEvent = {
  partnerId: string;
  stripeAccountId: string;
  stripeEventId: string;
  eventType: string;
  livemode: boolean;
  providerCreated: number;
  paymentIntentId: string;
  chargeId?: string | null;
  disputeId?: string | null;
  currency: string;
  chargeAmountMinor?: number | null;
  refundedAmountMinor?: number | null;
  disputeAmountMinor?: number | null;
  disputeFundsWithdrawn?: boolean | null;
};

type ApplyResult =
  | { state: 'pending' | 'ignored' | 'blocked' | 'already_processed' }
  | {
      state: 'applied'; invoiceId: string; orgId: string; partnerId: string; paymentId?: string;
      change: 'reduced' | 'restored' | 'unchanged';
      accountingDeleteMappingId?: string | null;
      accountingPushMappingId?: string | null;
      audit?: {
        paymentId: string; amount: string; method: string; recordedBy: string | null;
        reason: string;
      };
    };

const MAX_PENDING_ATTEMPTS = 50;

function pendingRetryUpdate(event: typeof stripeFinancialEvents.$inferSelect, reason: string) {
  const now = new Date();
  const attemptCount = event.attemptCount + 1;
  const exhausted = attemptCount >= MAX_PENDING_ATTEMPTS;
  const delayMinutes = Math.min(360, 5 * (2 ** Math.min(attemptCount - 1, 6)));
  return {
    status: exhausted ? 'blocked' as const : 'pending' as const,
    attemptCount,
    lastError: exhausted ? `${reason}_retry_exhausted` : reason,
    lastAttemptAt: now,
    nextAttemptAt: exhausted ? null : new Date(now.getTime() + delayMinutes * 60_000),
    processedAt: exhausted ? now : null,
    updatedAt: now,
  };
}

function digestEvent(event: NormalizedStripeFinancialEvent): string {
  return createHash('sha256').update(JSON.stringify({
    account: event.stripeAccountId,
    livemode: event.livemode,
    created: event.providerCreated,
    type: event.eventType,
    paymentIntent: event.paymentIntentId,
    charge: event.chargeId ?? null,
    dispute: event.disputeId ?? null,
    currency: event.currency.toUpperCase(),
    chargeAmount: event.chargeAmountMinor ?? null,
    refundedAmount: event.refundedAmountMinor ?? null,
    disputeAmount: event.disputeAmountMinor ?? null,
    withdrawn: event.disputeFundsWithdrawn ?? null,
  })).digest('hex');
}

function exactNonNegativeInteger(value: number | null | undefined, field: string): number | null {
  if (value == null) return null;
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid Stripe ${field}`);
  return value;
}

/** Persist before processing. A caller may acknowledge once this insert commits. */
export async function ingestStripeFinancialEvent(event: NormalizedStripeFinancialEvent): Promise<ApplyResult> {
  if (!event.stripeEventId || !event.stripeAccountId || !event.paymentIntentId) {
    throw new Error('Stripe financial event is missing a durable identity or account/payment binding');
  }
  if (!Number.isSafeInteger(event.providerCreated) || event.providerCreated < 0) {
    throw new Error('Stripe financial event has an invalid provider timestamp');
  }
  const currency = event.currency.toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw new Error('Stripe financial event has an invalid currency');
  const payloadDigest = digestEvent(event);

  const [connection] = await withSystemDbAccessContext(() => db.select({
    id: stripeConnectAccounts.id,
    partnerId: stripeConnectAccounts.partnerId,
    stripeAccountId: stripeConnectAccounts.stripeAccountId,
    livemode: stripeConnectAccounts.livemode,
  }).from(stripeConnectAccounts).where(and(
    eq(stripeConnectAccounts.partnerId, event.partnerId),
    eq(stripeConnectAccounts.stripeAccountId, event.stripeAccountId),
  )).limit(1));
  if (!connection || connection.livemode !== event.livemode) {
    throw new Error('Stripe financial event failed connection/livemode binding');
  }

  await withSystemDbAccessContext(() => db.insert(stripeFinancialEvents).values({
    partnerId: event.partnerId,
    stripeConnectionId: connection.id,
    stripeAccountId: event.stripeAccountId,
    stripeEventId: event.stripeEventId,
    eventType: event.eventType,
    livemode: event.livemode,
    providerCreated: event.providerCreated,
    paymentIntentId: event.paymentIntentId,
    chargeId: event.chargeId ?? null,
    disputeId: event.disputeId ?? null,
    currency,
    chargeAmountMinor: exactNonNegativeInteger(event.chargeAmountMinor, 'charge amount')?.toString() ?? null,
    refundedAmountMinor: exactNonNegativeInteger(event.refundedAmountMinor, 'refunded amount')?.toString() ?? null,
    disputeAmountMinor: exactNonNegativeInteger(event.disputeAmountMinor, 'dispute amount')?.toString() ?? null,
    disputeFundsWithdrawn: event.disputeFundsWithdrawn ?? null,
    payloadDigest,
  }).onConflictDoNothing({ target: stripeFinancialEvents.stripeEventId }));

  const [durable] = await withSystemDbAccessContext(() => db.select({
    partnerId: stripeFinancialEvents.partnerId,
    stripeAccountId: stripeFinancialEvents.stripeAccountId,
    payloadDigest: stripeFinancialEvents.payloadDigest,
  }).from(stripeFinancialEvents).where(eq(stripeFinancialEvents.stripeEventId, event.stripeEventId)).limit(1));
  if (!durable || durable.partnerId !== event.partnerId || durable.stripeAccountId !== event.stripeAccountId || durable.payloadDigest !== payloadDigest) {
    throw new Error('Stripe event identity was reused with different financial data');
  }

  return applyStripeFinancialEvent(event.stripeEventId);
}

function disputeEventIsNewer(mapping: typeof invoiceStripePayments.$inferSelect, event: typeof stripeFinancialEvents.$inferSelect): boolean {
  if (event.disputeFundsWithdrawn == null) return false;
  if (mapping.lastDisputeEventCreated == null) return true;
  if (event.providerCreated !== mapping.lastDisputeEventCreated) return event.providerCreated > mapping.lastDisputeEventCreated;
  if (event.stripeEventId === mapping.lastDisputeEventId) return false;
  // Stripe timestamps have one-second precision and delivery order is not
  // guaranteed. At an equal timestamp, prefer reinstatement (funds present)
  // over withdrawal so a closed/won dispute cannot be reopened by a delayed
  // same-second delivery.
  return event.disputeFundsWithdrawn === false && mapping.disputeFundsWithdrawn;
}

export async function applyStripeFinancialEvent(stripeEventId: string): Promise<ApplyResult> {
  const outcome = await withSystemDbAccessContext(async (): Promise<ApplyResult> => {
    const [preEvent] = await db.select().from(stripeFinancialEvents)
      .where(eq(stripeFinancialEvents.stripeEventId, stripeEventId)).limit(1);
    if (!preEvent) throw new Error(`Stripe financial event ${stripeEventId} is not durable`);
    if (preEvent.status === 'applied' || preEvent.status === 'ignored') return { state: 'already_processed' };
    if (preEvent.refundedAmountMinor == null && preEvent.disputeFundsWithdrawn == null) {
      await db.update(stripeFinancialEvents).set({
        status: 'ignored', attemptCount: preEvent.attemptCount + 1,
        lastError: null, lastAttemptAt: new Date(), nextAttemptAt: null,
        processedAt: new Date(), updatedAt: new Date(),
      }).where(eq(stripeFinancialEvents.id, preEvent.id));
      return { state: 'ignored' };
    }

    const mappings = await db.select().from(invoiceStripePayments).where(and(
      eq(invoiceStripePayments.stripeAccountId, preEvent.stripeAccountId),
      eq(invoiceStripePayments.stripePaymentIntentId, preEvent.paymentIntentId),
    )).limit(2);
    if (mappings.length === 0) {
      await db.update(stripeFinancialEvents).set(pendingRetryUpdate(preEvent, 'payment_mapping_not_ready'))
        .where(eq(stripeFinancialEvents.id, preEvent.id));
      return { state: 'pending' };
    }
    if (mappings.length !== 1) {
      await db.update(stripeFinancialEvents).set({
        status: 'blocked', attemptCount: preEvent.attemptCount + 1,
        lastError: 'ambiguous_payment_mapping', lastAttemptAt: new Date(), nextAttemptAt: null,
        processedAt: new Date(), updatedAt: new Date(),
      }).where(eq(stripeFinancialEvents.id, preEvent.id));
      return { state: 'blocked' };
    }

    const discovery = mappings[0]!;
    const [invoice] = await db.select().from(invoices)
      .where(eq(invoices.id, discovery.invoiceId)).limit(1).for('update');
    if (!invoice) throw new Error(`Invoice ${discovery.invoiceId} not found`);
    const [mapping] = await db.select().from(invoiceStripePayments)
      .where(eq(invoiceStripePayments.id, discovery.id)).limit(1).for('update');
    const [event] = await db.select().from(stripeFinancialEvents)
      .where(eq(stripeFinancialEvents.id, preEvent.id)).limit(1).for('update');
    if (!mapping || !event) throw new Error('Stripe reconciliation state disappeared under lock');
    if (event.status === 'applied' || event.status === 'ignored') return { state: 'already_processed' };

    const [currentConnection] = await db.select({ id: stripeConnectAccounts.id })
      .from(stripeConnectAccounts).where(and(
        eq(stripeConnectAccounts.id, event.stripeConnectionId),
        eq(stripeConnectAccounts.partnerId, event.partnerId),
        eq(stripeConnectAccounts.stripeAccountId, event.stripeAccountId),
        eq(stripeConnectAccounts.livemode, event.livemode),
      )).limit(1);
    if (!currentConnection) {
      await db.update(stripeFinancialEvents).set({
        status: 'blocked', attemptCount: event.attemptCount + 1,
        lastError: 'connection_binding_stale', lastAttemptAt: new Date(), nextAttemptAt: null,
        processedAt: new Date(), updatedAt: new Date(),
      }).where(eq(stripeFinancialEvents.id, event.id));
      return { state: 'blocked' };
    }

    if (invoice.partnerId !== event.partnerId || mapping.stripeAccountId !== event.stripeAccountId) {
      await db.update(stripeFinancialEvents).set({
        status: 'blocked', attemptCount: event.attemptCount + 1,
        lastError: 'partner_or_account_binding_mismatch', lastAttemptAt: new Date(), nextAttemptAt: null,
        processedAt: new Date(), updatedAt: new Date(),
      }).where(eq(stripeFinancialEvents.id, event.id));
      return { state: 'blocked' };
    }
    if (mapping.currency.toUpperCase() !== event.currency.toUpperCase()) {
      await db.update(stripeFinancialEvents).set({
        status: 'blocked', attemptCount: event.attemptCount + 1,
        lastError: 'currency_mismatch', lastAttemptAt: new Date(), nextAttemptAt: null,
        processedAt: new Date(), updatedAt: new Date(),
      }).where(eq(stripeFinancialEvents.id, event.id));
      return { state: 'blocked' };
    }

    const originalMinor = toMinorUnits(mapping.amount, mapping.currency);
    const eventChargeMinor = event.chargeAmountMinor == null ? null : Number(event.chargeAmountMinor);
    if (eventChargeMinor != null && eventChargeMinor !== originalMinor) {
      await db.update(stripeFinancialEvents).set({
        status: 'blocked', attemptCount: event.attemptCount + 1,
        lastError: 'charge_amount_mismatch', lastAttemptAt: new Date(), nextAttemptAt: null,
        processedAt: new Date(), updatedAt: new Date(),
      }).where(eq(stripeFinancialEvents.id, event.id));
      return { state: 'blocked' };
    }

    if (!mapping.invoicePaymentId && (mapping.status === 'pending' || mapping.status === 'failed')) {
      await db.update(stripeFinancialEvents).set(pendingRetryUpdate(event, 'payment_capture_not_linked'))
        .where(eq(stripeFinancialEvents.id, event.id));
      return { state: 'pending' };
    }

    const priorRefunded = Number(mapping.refundedAmountMinor);
    const observedRefunded = event.refundedAmountMinor == null ? priorRefunded : Number(event.refundedAmountMinor);
    if (!Number.isSafeInteger(observedRefunded) || observedRefunded < 0 || observedRefunded > originalMinor) {
      await db.update(stripeFinancialEvents).set({
        status: 'blocked', attemptCount: event.attemptCount + 1,
        lastError: 'refund_amount_out_of_bounds', lastAttemptAt: new Date(), nextAttemptAt: null,
        processedAt: new Date(), updatedAt: new Date(),
      }).where(eq(stripeFinancialEvents.id, event.id));
      return { state: 'blocked' };
    }
    const refunded = Math.max(priorRefunded, observedRefunded);

    let disputeWithdrawn = mapping.disputeFundsWithdrawn;
    let disputeAmount = Number(mapping.disputeAmountMinor);
    let disputeCreated = mapping.lastDisputeEventCreated;
    let disputeEventId = mapping.lastDisputeEventId;
    if (disputeEventIsNewer(mapping, event)) {
      const observedDispute = Number(event.disputeAmountMinor ?? 0);
      if (!Number.isSafeInteger(observedDispute) || observedDispute < 0 || observedDispute > originalMinor) {
        await db.update(stripeFinancialEvents).set({
          status: 'blocked', attemptCount: event.attemptCount + 1,
          lastError: 'dispute_amount_out_of_bounds', lastAttemptAt: new Date(), nextAttemptAt: null,
          processedAt: new Date(), updatedAt: new Date(),
        }).where(eq(stripeFinancialEvents.id, event.id));
        return { state: 'blocked' };
      }
      disputeWithdrawn = Boolean(event.disputeFundsWithdrawn);
      disputeAmount = observedDispute;
      disputeCreated = event.providerCreated;
      disputeEventId = event.stripeEventId;
    }

    const targetMinor = Math.max(0, originalMinor - refunded - (disputeWithdrawn ? disputeAmount : 0));
    const nextStatus = refunded >= originalMinor
      ? 'refunded' as const
      : disputeWithdrawn
        ? (targetMinor === 0 ? 'disputed' as const : 'partially_disputed' as const)
        : refunded > 0
          ? 'partially_refunded' as const
          : 'succeeded' as const;

    let paymentId = mapping.invoicePaymentId ?? undefined;
    let accountingDeleteMappingId: string | null = null;
    let accountingPushMappingId: string | null = null;
    let previousMinor = 0;
    let audit: Extract<ApplyResult, { state: 'applied' }>['audit'];
    if (mapping.invoicePaymentId) {
      const [payment] = await db.select().from(invoicePayments)
        .where(eq(invoicePayments.id, mapping.invoicePaymentId)).limit(1).for('update');
      if (!payment) throw new Error('Linked Stripe invoice payment is missing');
      previousMinor = toMinorUnits(payment.amount, mapping.currency);
      if (targetMinor === 0) {
        // Move off succeeded and clear the FK before delete; ON DELETE SET NULL
        // would otherwise violate the non-deferrable succeeded-has-payment CHECK.
        await db.update(invoiceStripePayments).set({
          status: nextStatus, invoicePaymentId: null,
          refundedAmountMinor: refunded.toString(), disputeAmountMinor: disputeAmount.toString(),
          disputeFundsWithdrawn: disputeWithdrawn, lastDisputeEventCreated: disputeCreated,
          lastDisputeEventId: disputeEventId, lastEventAt: new Date(event.providerCreated * 1000), updatedAt: new Date(),
        }).where(eq(invoiceStripePayments.id, mapping.id));
        accountingDeleteMappingId = await requestPaymentDelete(db, payment.id);
        await db.delete(invoicePayments).where(eq(invoicePayments.id, payment.id));
        audit = {
          paymentId: payment.id, amount: payment.amount, method: payment.method,
          recordedBy: payment.recordedBy ?? null, reason: event.eventType,
        };
      } else {
        await db.update(invoicePayments).set({ amount: fromMinorUnits(targetMinor, mapping.currency) })
          .where(eq(invoicePayments.id, payment.id));
        if (targetMinor < previousMinor) {
          await db.update(accountingEntityMappings).set({
            syncStatus: 'error',
            lastError: partialRefundDivergenceMessage(fromMinorUnits(originalMinor - targetMinor, mapping.currency)),
            updatedAt: new Date(),
          }).where(and(
            eq(accountingEntityMappings.breezeEntityType, 'payment'),
            eq(accountingEntityMappings.breezeEntityId, payment.id),
            eq(accountingEntityMappings.breezeOrigin, true),
            isNotNull(accountingEntityMappings.remoteEntityId),
          ));
        }
      }
    } else if (targetMinor > 0) {
      const [payment] = await db.insert(invoicePayments).values({
        invoiceId: mapping.invoiceId, orgId: mapping.orgId,
        amount: fromMinorUnits(targetMinor, mapping.currency), method: 'card',
        reference: mapping.stripePaymentIntentId,
        receivedAt: mapping.paymentReceivedAt ?? mapping.createdAt.toISOString().slice(0, 10),
        recordedBy: null, note: 'Restored after Stripe dispute resolution',
      }).returning();
      if (!payment) throw new Error('Failed to restore Stripe invoice payment');
      paymentId = payment.id;
      accountingPushMappingId = await requestPaymentPush(db, {
        invoicePaymentId: payment.id,
        invoiceId: mapping.invoiceId,
        partnerId: invoice.partnerId,
      });
    }

    if (!(mapping.invoicePaymentId && targetMinor === 0)) {
      await db.update(invoiceStripePayments).set({
        status: nextStatus, invoicePaymentId: paymentId ?? null,
        refundedAmountMinor: refunded.toString(), disputeAmountMinor: disputeAmount.toString(),
        disputeFundsWithdrawn: disputeWithdrawn, lastDisputeEventCreated: disputeCreated,
        lastDisputeEventId: disputeEventId, lastEventAt: new Date(event.providerCreated * 1000), updatedAt: new Date(),
      }).where(eq(invoiceStripePayments.id, mapping.id));
    }

    await recomputeInvoiceStatus(mapping.invoiceId);
    await db.update(stripeFinancialEvents).set({
      status: 'applied', attemptCount: event.attemptCount + 1, lastError: null,
      lastAttemptAt: new Date(), nextAttemptAt: null, processedAt: new Date(), updatedAt: new Date(),
    }).where(eq(stripeFinancialEvents.id, event.id));
    return {
      state: 'applied', invoiceId: mapping.invoiceId, orgId: mapping.orgId,
      partnerId: invoice.partnerId, paymentId,
      change: targetMinor < previousMinor ? 'reduced' : targetMinor > previousMinor ? 'restored' : 'unchanged',
      accountingDeleteMappingId,
      accountingPushMappingId,
      audit,
    };
  });

  if (outcome.state === 'applied') {
    if (outcome.accountingDeleteMappingId) {
      try {
        await enqueueAccountingPaymentDelete(outcome.accountingDeleteMappingId, outcome.partnerId);
      } catch (err) {
        console.error('[stripeReversalState] payment delete enqueue failed after commit', err);
      }
    }
    if (outcome.accountingPushMappingId) {
      try {
        await enqueueAccountingPaymentPush(outcome.accountingPushMappingId, outcome.partnerId);
      } catch (err) {
        console.error('[stripeReversalState] payment push enqueue failed after commit', err);
      }
    }
    if (outcome.audit) {
      try {
        await writeAuditEventAsync(requestLikeFromSnapshot({}), {
          orgId: outcome.orgId, action: 'invoice.payment.voided', resourceType: 'invoice_payment',
          resourceId: outcome.audit.paymentId, actorType: 'system', actorId: null, result: 'success',
          details: {
            amount: outcome.audit.amount, method: outcome.audit.method,
            recordedBy: outcome.audit.recordedBy, invoiceId: outcome.invoiceId,
            reason: outcome.audit.reason,
          },
        });
      } catch (err) {
        console.error('[stripeReversalState] failed to write payment reversal audit', err);
      }
    }
    if (outcome.paymentId && outcome.change !== 'unchanged') {
      await emitInvoiceEvent({
        type: outcome.change === 'reduced' ? 'payment.voided' : 'payment.recorded',
        invoiceId: outcome.invoiceId, orgId: outcome.orgId, partnerId: outcome.partnerId,
        paymentId: outcome.paymentId,
      });
    }
  }
  return outcome;
}

/** Retry pre-link/transient inbox rows in provider order. */
export async function processPendingStripeFinancialEvents(limit = 200): Promise<number> {
  const pending = await withSystemDbAccessContext(() => db.select({ id: stripeFinancialEvents.stripeEventId })
    .from(stripeFinancialEvents)
    .where(and(
      inArray(stripeFinancialEvents.status, ['pending']),
      // Fresh next_attempt_at values come from PostgreSQL's DEFAULT NOW(). Use
      // that same clock for eligibility: an application host a few milliseconds
      // behind the database must not hide a newly durable reversal until the
      // next ten-minute sweep. Later retry deadlines remain absolute instants.
      or(isNull(stripeFinancialEvents.nextAttemptAt), sql`${stripeFinancialEvents.nextAttemptAt} <= NOW()`),
    ))
    .orderBy(asc(stripeFinancialEvents.nextAttemptAt), asc(stripeFinancialEvents.providerCreated), asc(stripeFinancialEvents.createdAt))
    .limit(limit));
  let applied = 0;
  for (const row of pending) {
    try {
      const result = await applyStripeFinancialEvent(row.id);
      if (result.state === 'applied') applied += 1;
    } catch (err) {
      console.error('[stripeReversalState] pending event apply failed', {
        eventId: row.id, message: err instanceof Error ? err.message : String(err),
      });
      await withSystemDbAccessContext(async () => {
        const [event] = await db.select().from(stripeFinancialEvents)
          .where(and(eq(stripeFinancialEvents.stripeEventId, row.id), eq(stripeFinancialEvents.status, 'pending')))
          .limit(1).for('update');
        if (event) {
          await db.update(stripeFinancialEvents)
            .set(pendingRetryUpdate(event, 'apply_error'))
            .where(eq(stripeFinancialEvents.id, event.id));
        }
      });
    }
  }
  return applied;
}

export async function processPendingStripeFinancialEventsForPayment(
  stripeAccountId: string,
  paymentIntentId: string,
): Promise<number> {
  const pending = await withSystemDbAccessContext(() => db.select({ id: stripeFinancialEvents.stripeEventId })
    .from(stripeFinancialEvents).where(and(
      eq(stripeFinancialEvents.status, 'pending'),
      eq(stripeFinancialEvents.stripeAccountId, stripeAccountId),
      eq(stripeFinancialEvents.paymentIntentId, paymentIntentId),
    )).orderBy(asc(stripeFinancialEvents.providerCreated), asc(stripeFinancialEvents.createdAt)));
  let applied = 0;
  for (const row of pending) {
    const result = await applyStripeFinancialEvent(row.id);
    if (result.state === 'applied') applied += 1;
  }
  return applied;
}
