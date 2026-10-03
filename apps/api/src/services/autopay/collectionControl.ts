import { db, withSystemDbAccessContext } from '../../db';
import { assertNoHeldDbContextForStripe } from '../stripeSettle';
import { and, eq, inArray } from 'drizzle-orm';
import { RESERVING_COLLECTION_ATTEMPT_STATES } from '@breeze/shared';
import { invoices, invoiceAutopaySchedules, invoiceCollectionAttempts, billingNoticeOutbox,
  organizations, partners, orgAutopayEnrollments } from '../../db/schema';
import { InvoiceServiceError, type InvoiceActor } from '../invoiceTypes';
import { requireInvoiceAccess } from '../invoiceService';
import { getOrMintInvoiceLink, buildPublicInvoiceUrl } from '../invoiceLinkToken';
import { resolveBillingEmail } from '../invoicePdf';
import { enqueueBillingNotice } from './noticeOutbox';
import { renderBillingNotice } from './renderBillingNotice';
import { enqueueAutopayStaffNotifications, type AutopayStaffNotice } from './staffNotifications';
import type { Tx } from './types';

export type InvoiceControl = 'skip' | 'exclude';
export type InvoiceControlResult = { status: 'pending'; control: InvoiceControl }
  | { status: 'skipped' | 'excluded'; staffNotice?: AutopayStaffNotice };

/** Shared by all collection producers, including confirmation of an existing PI. */
export function collectionFenced(input: {
  clientSkippedAt?: Date | string | null; mspExcludedAt?: Date | string | null;
  autopayExcluded: boolean; enrollmentStatus: string | null;
}): boolean {
  return input.clientSkippedAt != null || input.mspExcludedAt != null
    || input.autopayExcluded || input.enrollmentStatus !== 'active';
}

export function pendingInvoiceControl(reason: string | null): InvoiceControl | 'stop' | null {
  if (reason === 'control_pending:skip') return 'skip';
  if (reason === 'control_pending:exclude') return 'exclude';
  if (reason === 'control_pending:stop') return 'stop';
  return null;
}

/** Fence first under the shared invoice lock. This request path never calls Stripe or releases money.
 * Batch H's reconciler finalizes pending requests after verified cancellation/settlement.
 */
export async function requestInvoiceControl(tx: Tx, input: {
  invoiceId: string; kind: InvoiceControl; actor?: InvoiceActor;
}): Promise<InvoiceControlResult> {
  const [invoice] = await tx.select().from(invoices).where(eq(invoices.id, input.invoiceId)).limit(1).for('update');
  if (!invoice) throw new InvoiceServiceError('Invoice not found', 404, 'INVOICE_NOT_FOUND');
  if (input.kind === 'exclude') {
    if (!input.actor) throw new InvoiceServiceError('Invoice access denied', 403, 'ORG_DENIED');
    requireInvoiceAccess(input.actor, invoice);
  }
  const [schedule] = await tx.select().from(invoiceAutopaySchedules)
    .where(eq(invoiceAutopaySchedules.invoiceId, invoice.id)).limit(1).for('update');
  const pending = pendingInvoiceControl(schedule?.stateReason ?? null);
  if (pending === input.kind) return { status: 'pending', control: input.kind };
  if (pending) throw new InvoiceServiceError('Another payment control is pending', 409, 'COLLECTION_IN_PROGRESS');
  if (input.kind === 'skip' && schedule?.state === 'skipped_by_client') return { status: 'skipped' };
  const alreadyExcluded = input.kind === 'exclude' && invoice.autopayExcluded
    && (!schedule || schedule.state === 'excluded_by_msp');
  if (!alreadyExcluded && ['void', 'paid'].includes(invoice.status)) throw new InvoiceServiceError('Invoice is closed', 409, 'INVALID_STATE');
  if (input.kind === 'skip' && (!schedule?.enrollmentId || !['awaiting_notice', 'scheduled', 'retry_scheduled', 'collecting', 'action_required'].includes(schedule.state))) {
    throw new InvoiceServiceError('Invoice cannot be skipped', 409, 'INVALID_STATE');
  }
  const now = new Date();
  if (input.kind === 'exclude' && !invoice.autopayExcluded) {
    await tx.update(invoices).set({ autopayExcluded: true, updatedAt: now }).where(eq(invoices.id, invoice.id));
  }
  // Reservations are invoice-wide: client-on-session attempts need no schedule.
  // The invoice fence plus attempt.invoiceId lets the reconciler discover these
  // pending controls without creating a schedule or enrollment authority.
  const [reserving] = await tx.select({ id: invoiceCollectionAttempts.id }).from(invoiceCollectionAttempts)
    .where(and(eq(invoiceCollectionAttempts.invoiceId, invoice.id),
      inArray(invoiceCollectionAttempts.state, [...RESERVING_COLLECTION_ATTEMPT_STATES]))).limit(1);
  if (!schedule) return reserving ? { status: 'pending', control: input.kind } : { status: 'excluded' };
  // Preserve terminal history, but only report completion after inspecting money.
  if (!reserving && input.kind === 'exclude'
    && !['awaiting_notice', 'scheduled', 'retry_scheduled', 'collecting', 'action_required', 'not_needed'].includes(schedule.state)) {
    return { status: 'excluded' };
  }
  await tx.update(invoiceAutopaySchedules).set(input.kind === 'skip'
    ? { clientSkippedAt: now }
    : { mspExcludedBy: input.actor!.userId, mspExcludedAt: now }).where(eq(invoiceAutopaySchedules.id, schedule.id));
  await tx.update(billingNoticeOutbox).set({ status: 'cancelled' }).where(and(
    eq(billingNoticeOutbox.invoiceId, invoice.id), eq(billingNoticeOutbox.kind, 'invoice_autopay'),
    inArray(billingNoticeOutbox.status, ['pending', 'failed']),
  ));
  if (reserving) {
    await tx.update(invoiceAutopaySchedules).set({ stateReason: `control_pending:${input.kind}` })
      .where(eq(invoiceAutopaySchedules.id, schedule.id));
    return { status: 'pending', control: input.kind };
  }
  return finalizeInvoiceControl(tx, invoice, schedule, input.kind);
}

/** Caller must hold the invoice lock and have verified no outstanding reservation remains.
 * Reused by the cancellation reconciler; transition and notices commit together.
 */
export async function finalizeInvoiceControl(tx: Tx, invoice: typeof invoices.$inferSelect,
  schedule: typeof invoiceAutopaySchedules.$inferSelect, kind: InvoiceControl): Promise<InvoiceControlResult> {
  const state = kind === 'skip' ? 'skipped_by_client' : 'excluded_by_msp';
  const alreadyFinalized = schedule.state === state;
  // A later attempt can leave a pending control on an already-final schedule.
  // Clear that metadata after reconciliation without repeating the final notices.
  if (!alreadyFinalized || pendingInvoiceControl(schedule.stateReason)) {
    await tx.update(invoiceAutopaySchedules).set({ state, nextAttemptAt: null, stateReason: kind })
      .where(eq(invoiceAutopaySchedules.id, schedule.id));
  }
  if (alreadyFinalized) return { status: kind === 'skip' ? 'skipped' : 'excluded' };
  if (kind === 'exclude') return { status: 'excluded' };
  await enqueueSkippedInvoiceConfirmation(tx, invoice);
  const staffNotice: AutopayStaffNotice = { orgId: invoice.orgId, partnerId: invoice.partnerId,
    event: 'autopay.skipped', dedupeKey: `autopay:${invoice.id}:skipped`,
    message: 'The client skipped automatic payment for this invoice.' };
  await enqueueAutopayStaffNotifications(tx, staffNotice);
  return { status: 'skipped', staffNotice };
}

async function enqueueSkippedInvoiceConfirmation(tx: Tx, invoice: typeof invoices.$inferSelect): Promise<void> {
  const [org] = await tx.select().from(organizations).where(eq(organizations.id, invoice.orgId)).limit(1);
  const [partner] = await tx.select().from(partners).where(eq(partners.id, invoice.partnerId)).limit(1);
  if (!org || !partner) throw new Error('Skip notice ownership unavailable');
  const recipient = resolveBillingEmail(org.billingContact);
  if (!recipient) return;
  const link = await getOrMintInvoiceLink(invoice, tx);
  const rendered = await renderBillingNotice('payment_reminder', { partnerId: invoice.partnerId, orgId: invoice.orgId,
    mandatory: {}, frozen: { amount: invoice.balance, currency: invoice.currencyCode, dueDate: invoice.dueDate },
    data: { invoiceNumber: invoice.invoiceNumber, balance: invoice.balance, currency: invoice.currencyCode,
      dueDate: invoice.dueDate, daysOverdue: 0, payLink: buildPublicInvoiceUrl(link.token),
      partnerName: partner.name, orgName: org.name, partnerSettings: partner.settings } }, tx);
  const prefix = 'Automatic payment has been skipped for this invoice. You can pay using the invoice link.';
  await enqueueBillingNotice(tx, { orgId: invoice.orgId, partnerId: invoice.partnerId, invoiceId: invoice.id,
    kind: 'payment_reminder', seq: 0, dedupeKey: `invoice:${invoice.id}:skip:1`, toEmail: recipient,
    rendered: { ...rendered, subject: `Automatic payment skipped — ${invoice.invoiceNumber}`,
      html: `<p>${prefix}</p>${rendered.html}`, text: `${prefix}\n\n${rendered.text}` } });
}

/** Recover fences using the same mapping-bound, outside-transaction provider path
 * as crash recovery. Never confirm while reconciling a control. Includes client
 * attempts without a schedule, discoverable through the invoice/enrollment fence.
 */
export async function reconcilePendingControls(): Promise<void> {
  assertNoHeldDbContextForStripe('reconcilePendingControls');
  const { resumeCollectionAttempt } = await import('./collectionEngine');
  const attempts = await withSystemDbAccessContext(() => db.select().from(invoiceCollectionAttempts)
    .where(inArray(invoiceCollectionAttempts.state, [...RESERVING_COLLECTION_ATTEMPT_STATES])), 'autopay.pendingControls');
  const errors: unknown[] = [];
  for (const attempt of attempts) {
    try {
      const fenced = await withSystemDbAccessContext(async () => {
        const [invoice] = await db.select().from(invoices).where(eq(invoices.id, attempt.invoiceId)).limit(1);
        if (!invoice) throw new Error('Control invoice missing');
        const [schedule] = await db.select().from(invoiceAutopaySchedules)
          .where(eq(invoiceAutopaySchedules.invoiceId, invoice.id)).limit(1);
        const [enrollment] = await db.select().from(orgAutopayEnrollments)
          .where(eq(orgAutopayEnrollments.orgId, invoice.orgId)).limit(1);
        return collectionFenced({ ...schedule, autopayExcluded: invoice.autopayExcluded,
          enrollmentStatus: enrollment?.status ?? null }) || !!pendingInvoiceControl(schedule?.stateReason ?? null);
      }, 'autopay.controlFence');
      if (fenced) await resumeCollectionAttempt(attempt.id, true);
    } catch (error) {
      // One unavailable account must not prevent another invoice's control from finishing.
      errors.push(error);
    }
  }
  if (errors.length) throw new AggregateError(errors, 'Pending payment controls need reconciliation');
}
