import { validatePaymentActionNotice } from './paymentNoticeValidation';
import { and, asc, eq, gt, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import type { BillingNoticeKind } from '@breeze/shared';
import { db, assertOutsideHeldDbContext, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { billingNoticeOutbox, invoices, organizations, partners } from '../../db/schema';
import { sqlOpenAr } from '../../db/schema/invoices';
import { buildPublicLinkLiveOrgPredicate } from '../publicLinkOrgGate';
import { captureException } from '../sentry';
import { getEmailService } from '../email';
import type { Tx, RenderedNotice } from './types';
export type { RenderedNotice } from './types';
export async function enqueueBillingNotice(tx: Tx, input: {
  orgId: string; partnerId: string; invoiceId?: string; enrollmentId?: string;
  kind: BillingNoticeKind; seq: number; dedupeKey: string; toEmail: string; rendered: RenderedNotice;
}): Promise<{ id: string; created: boolean }> {
  const [org] = await tx.select({ partnerId: organizations.partnerId }).from(organizations).where(eq(organizations.id, input.orgId)).limit(1);
  if (!org || org.partnerId !== input.partnerId) throw new Error('Billing notice ownership mismatch');
  const [created] = await tx.insert(billingNoticeOutbox).values({
    orgId: input.orgId, invoiceId: input.invoiceId ?? null, enrollmentId: input.enrollmentId ?? null,
    kind: input.kind, seq: input.seq, dedupeKey: input.dedupeKey, toEmail: input.toEmail,
    rendered: structuredClone(input.rendered), status: 'pending', attempts: 0, nextAttemptAt: new Date(),
  }).onConflictDoNothing({ target: billingNoticeOutbox.dedupeKey }).returning({ id: billingNoticeOutbox.id });
  if (created) return { id: created.id, created: true };
  const [existing] = await tx.select({ id: billingNoticeOutbox.id }).from(billingNoticeOutbox).where(and(
    eq(billingNoticeOutbox.dedupeKey, input.dedupeKey), eq(billingNoticeOutbox.orgId, input.orgId),
  )).limit(1);
  if (!existing) throw new Error('Billing notice dedupe ownership mismatch');
  return { id: existing.id, created: false };
}
export type NoticeSentHandler = (tx: Tx, row: typeof billingNoticeOutbox.$inferSelect) => Promise<void>;
const handlers = new Map<BillingNoticeKind, NoticeSentHandler>();
export function registerNoticeSentHandler(kind: BillingNoticeKind, handler: NoticeSentHandler): void {
  if (handlers.has(kind)) throw new Error(`Billing sent handler already registered: ${kind}`);
  handlers.set(kind, handler);
}
type Row = typeof billingNoticeOutbox.$inferSelect;
/** Return a safe, fixed cancellation reason, or null to allow delivery. */
export type NoticePreSendValidator = (tx: Tx, row: Row) => Promise<string | null>;
const validators = new Map<BillingNoticeKind, NoticePreSendValidator>();
export function registerNoticePreSendValidator(kind: BillingNoticeKind, validator: NoticePreSendValidator): void {
  if (validators.has(kind)) throw new Error(`Billing pre-send validator already registered: ${kind}`);
  validators.set(kind, validator);
}
const validateReminder: NoticePreSendValidator = async (tx, row) => {
  if (!row.invoiceId) return 'Reminder invoice missing';
  const [invoice] = await tx.select({ id: invoices.id }).from(invoices).where(and(
    eq(invoices.id, row.invoiceId), eq(invoices.orgId, row.orgId),
    sqlOpenAr(invoices), gt(invoices.balance, '0'), buildPublicLinkLiveOrgPredicate(invoices.orgId),
  )).limit(1);
  return invoice ? null : 'Reminder invoice or tenant no longer eligible';
};
registerNoticePreSendValidator('payment_failed', validatePaymentActionNotice);
registerNoticePreSendValidator('payment_reminder', validateReminder);
registerNoticePreSendValidator('payment_overdue', validateReminder);

const scope = <T>(fn: () => Promise<T>) => withSystemDbAccessContext(fn);
const owns = (row: Row) => and(eq(billingNoticeOutbox.id, row.id),
  eq(billingNoticeOutbox.status, 'sending'), eq(billingNoticeOutbox.attempts, row.attempts));

const ACK_PENDING = 'Delivery acknowledgement pending';
function reportFailure(row: Row, phase: string, _error: unknown): void {
  // Transport/handler messages may contain bearer URLs. Keep only safe identity
  // and a bounded phase; never persist or capture the raw exception message.
  const tags = { service: 'billingNoticeOutbox', billing_notice_id: row.id, billing_notice_kind: row.kind, org_id: row.orgId, autopay_phase: phase };
  console.error('[billingNoticeOutbox] dispatch failure', tags);
  captureException(new Error(`Billing notice ${phase} failed`), undefined, tags);
}

export async function dispatchPendingBillingNotices(now = new Date()): Promise<{ sent: number; failed: number }> {
  assertOutsideHeldDbContext('dispatchPendingBillingNotices');
  return runOutsideDbContext(async () => {
    const counts = { sent: 0, failed: 0 };
    const claimed = await scope(() => db.transaction(async tx => {
      const due = await tx.select().from(billingNoticeOutbox).where(and(
        inArray(billingNoticeOutbox.status, ['pending', 'sending']),
        sql`NOT (${billingNoticeOutbox.status} = 'sending' AND ${billingNoticeOutbox.sentAt} IS NULL AND ${billingNoticeOutbox.lastError} IS NOT DISTINCT FROM ${ACK_PENDING})`,
        or(isNull(billingNoticeOutbox.nextAttemptAt), lte(billingNoticeOutbox.nextAttemptAt, now)),
      )).orderBy(asc(billingNoticeOutbox.nextAttemptAt), asc(billingNoticeOutbox.id)).limit(50).for('update', { skipLocked: true });
      const rows: Row[] = [];
      for (const row of due) {
        if (row.attempts >= 8) {
          const status = row.sentAt ? 'handler_failed' : 'failed';
          await tx.update(billingNoticeOutbox).set({ status, lastError: 'Attempts exhausted' }).where(eq(billingNoticeOutbox.id, row.id));
          reportFailure(row, status, undefined);
          counts.failed++;
          continue;
        }
        const [claim] = await tx.update(billingNoticeOutbox).set({ status: 'sending', attempts: row.attempts + 1,
          nextAttemptAt: new Date(now.getTime() + 15 * 60000) }).where(eq(billingNoticeOutbox.id, row.id)).returning();
        rows.push(claim!);
      }
      return rows;
    }));
    for (let row of claimed) {
      try {
        if (!row.sentAt) {
          const validate = validators.get(row.kind);
          if (validate) {
            const allowed = await scope(() => db.transaction(async tx => {
              const [current] = await tx.select().from(billingNoticeOutbox).where(owns(row)).for('update');
              if (!current) return false;
              const reason = await validate(tx, current);
              if (!reason) return true;
              await tx.update(billingNoticeOutbox).set({ status: 'cancelled', lastError: reason }).where(owns(current));
              return false;
            }));
            if (!allowed) continue;
          }
          const [sender] = await scope(() => db.select({ id: partners.id, name: partners.name, billingEmail: partners.billingEmail })
            .from(organizations).innerJoin(partners, eq(partners.id, organizations.partnerId)).where(eq(organizations.id, row.orgId)).limit(1));
          if (!sender) throw new Error('Billing notice organization missing');
          const email = getEmailService();
          if (!email) throw new Error('Email transport is not configured');
          const rendered = row.rendered as RenderedNotice;
          // Earlier sends may outlive this row's batch lease. Recheck its fence
          // and renew immediately before sending; cancellation/reclaim wins.
          const [renewed] = await scope(() => db.update(billingNoticeOutbox).set({
            lastError: ACK_PENDING,
            nextAttemptAt: new Date(Math.max(now.getTime(), Date.now()) + 15 * 60000),
          }).where(owns(row)).returning());
          if (!renewed) continue;
          row = renewed;
          // No transaction/context remains held while the provider is contacted.
          await email.sendEmail({ purpose: 'billing.notice', partnerId: sender.id, partnerName: sender.name,
            replyTo: sender.billingEmail ?? undefined, to: row.toEmail,
            subject: rendered.subject, html: rendered.html, text: rendered.text });
          // Acceptance is external to our transaction. Retry ONLY the ack;
          // never put accepted mail back into the send queue. The durable marker
          // fences lease recovery if all ack writes fail (or this process dies).
          // Delivery remains at least once across a provider-acceptance crash:
          // operators must reconcile parked rows; the transport offers no
          // idempotency key or receipt lookup to resolve that uncertainty.
          let ack: Row | undefined;
          let ackError: unknown;
          for (let attempt = 0; attempt < 3; attempt++) {
            try {
              [ack] = await scope(() => db.update(billingNoticeOutbox).set({ sentAt: new Date(), providerMessageId: null, lastError: null })
                .where(owns(row)).returning());
              ackError = undefined;
              break;
            } catch (error) { ackError = error; }
          }
          if (ackError) {
            reportFailure(row, 'acknowledgement', ackError);
            counts.failed++;
            continue;
          }
          if (!ack) continue; // cancelled or fenced: never resurrect authority
          row = ack;
        }
        const completed = await scope(() => db.transaction(async tx => {
          const [current] = await tx.select().from(billingNoticeOutbox).where(owns(row)).for('update');
          if (!current?.sentAt) return false;
          const handler = handlers.get(current.kind);
          if (handler) await handler(tx as Tx, current);
          await tx.update(billingNoticeOutbox).set({ status: 'sent', lastError: null, nextAttemptAt: now }).where(owns(row));
          return true;
        }));
        if (completed) counts.sent++;
      } catch (error) {
        const delay = Math.min(60 * 2 ** Math.min(row.attempts - 1, 6), 3600) * 1000;
        reportFailure(row, row.attempts >= 8 ? (row.sentAt ? 'handler_failed' : 'failed') : (row.sentAt ? 'handler' : 'send'), error);
        try { await scope(() => db.update(billingNoticeOutbox).set({
          status: row.attempts >= 8 ? (row.sentAt ? 'handler_failed' : 'failed') : 'pending',
          nextAttemptAt: new Date(Math.max(now.getTime(), Date.now()) + delay),
          lastError: error instanceof Error ? error.name : 'BillingNoticeError',
        }).where(owns(row))); }
        catch (persistError) { reportFailure(row, 'retry_persistence', persistError); }
        // Do not persist raw transport exceptions: they may contain bearer URLs.
        counts.failed++;
      }
    }
    return counts;
  });
}
