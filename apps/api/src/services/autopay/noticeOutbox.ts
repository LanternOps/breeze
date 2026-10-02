import { and, asc, eq, inArray, isNull, lte, or } from 'drizzle-orm';
import type { BillingNoticeKind } from '@breeze/shared';
import { db, assertOutsideHeldDbContext, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { billingNoticeOutbox, organizations, partners } from '../../db/schema';
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
const scope = <T>(fn: () => Promise<T>) => withSystemDbAccessContext(fn);
const owns = (row: Row) => and(eq(billingNoticeOutbox.id, row.id),
  eq(billingNoticeOutbox.status, 'sending'), eq(billingNoticeOutbox.attempts, row.attempts));

export async function dispatchPendingBillingNotices(now = new Date()): Promise<{ sent: number; failed: number }> {
  assertOutsideHeldDbContext('dispatchPendingBillingNotices');
  return runOutsideDbContext(async () => {
    const claimed = await scope(() => db.transaction(async tx => {
      const due = await tx.select().from(billingNoticeOutbox).where(and(
        inArray(billingNoticeOutbox.status, ['pending', 'sending']),
        or(isNull(billingNoticeOutbox.nextAttemptAt), lte(billingNoticeOutbox.nextAttemptAt, now)),
      )).orderBy(asc(billingNoticeOutbox.nextAttemptAt), asc(billingNoticeOutbox.id)).limit(50).for('update', { skipLocked: true });
      const rows: Row[] = [];
      for (const row of due) {
        if (!row.sentAt && row.attempts >= 8) {
          await tx.update(billingNoticeOutbox).set({ status: 'failed', lastError: 'Send attempts exhausted' }).where(eq(billingNoticeOutbox.id, row.id));
          continue;
        }
        const [claim] = await tx.update(billingNoticeOutbox).set({ status: 'sending', attempts: row.attempts + 1,
          nextAttemptAt: new Date(now.getTime() + 15 * 60000) }).where(eq(billingNoticeOutbox.id, row.id)).returning();
        rows.push(claim!);
      }
      return rows;
    }));
    const counts = { sent: 0, failed: 0 };
    for (let row of claimed) {
      try {
        if (!row.sentAt) {
          const [sender] = await scope(() => db.select({ id: partners.id, name: partners.name, billingEmail: partners.billingEmail })
            .from(organizations).innerJoin(partners, eq(partners.id, organizations.partnerId)).where(eq(organizations.id, row.orgId)).limit(1));
          if (!sender) throw new Error('Billing notice organization missing');
          const email = getEmailService();
          if (!email) throw new Error('Email transport is not configured');
          const rendered = row.rendered as RenderedNotice;
          // Earlier sends may outlive this row's batch lease. Recheck its fence
          // and renew immediately before sending; cancellation/reclaim wins.
          const [renewed] = await scope(() => db.update(billingNoticeOutbox).set({
            nextAttemptAt: new Date(Math.max(now.getTime(), Date.now()) + 15 * 60000),
          }).where(owns(row)).returning());
          if (!renewed) continue;
          row = renewed;
          // No transaction/context remains held while the provider is contacted.
          await email.sendEmail({ purpose: 'billing.notice', partnerId: sender.id, partnerName: sender.name,
            replyTo: sender.billingEmail ?? undefined, to: row.toEmail,
            subject: rendered.subject, html: rendered.html, text: rendered.text });
          const [ack] = await scope(() => db.update(billingNoticeOutbox).set({ sentAt: new Date(), providerMessageId: null })
            .where(owns(row)).returning());
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
        await scope(() => db.update(billingNoticeOutbox).set({
          status: !row.sentAt && row.attempts >= 8 ? 'failed' : 'pending',
          nextAttemptAt: new Date(Math.max(now.getTime(), Date.now()) + delay),
          lastError: error instanceof Error ? error.name : 'BillingNoticeError',
        }).where(owns(row)));
        // Do not persist raw transport exceptions: they may contain bearer URLs.
        counts.failed++;
      }
    }
    return counts;
  });
}
