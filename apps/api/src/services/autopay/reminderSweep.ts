import { and, eq, gt, inArray, isNotNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { RESERVING_COLLECTION_ATTEMPT_STATES } from '@breeze/shared';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { invoices, organizations, partners, invoiceAutopaySchedules, invoiceCollectionAttempts, billingNoticeOutbox } from '../../db/schema';
import { sqlOpenAr } from '../../db/schema/invoices';
import { buildPublicLinkLiveOrgPredicate } from '../publicLinkOrgGate';
import { captureException } from '../sentry';
import { resolveBillingEmail } from '../invoicePdf';
import { getOrMintInvoiceLink, buildPublicInvoiceUrl } from '../invoiceLinkToken';
import { resolveBillingPaymentSettings } from './billingPaymentSettings';
import { renderBillingNotice } from './renderBillingNotice';
import { enqueueBillingNotice } from './noticeOutbox';
import { STALE_REMINDER_REASON } from './reminderValidation';

const DAY_MS = 86_400_000;

function utcDay(value: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new RangeError('Expected YYYY-MM-DD');
  const ms = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 10) !== value) {
    throw new RangeError('Invalid calendar date');
  }
  return ms / DAY_MS;
}

type ReminderCadence = {
  dueDate: string; today: string; beforeDueDays: number; repeatDays: number | null; overdueEveryDays: number;
};
type ReminderKind = 'payment_reminder' | 'payment_overdue';

/** The latest cadence step on or before today, and whether today is its own day.
 * Only a step that falls today is sent; an earlier one is re-sent only to replace
 * a notice cancelled as stale. Nothing is due on the due date itself. */
export function reminderStep(input: ReminderCadence): { kind: ReminderKind; seq: number; onDay: boolean } | null {
  for (const interval of [input.beforeDueDays, input.repeatDays, input.overdueEveryDays]) {
    if (interval !== null && (!Number.isInteger(interval) || interval < 1 || interval > 31)) {
      throw new RangeError('Reminder intervals must be integers in 1–31');
    }
  }
  const delta = utcDay(input.today) - utcDay(input.dueDate);
  if (delta < 0) {
    const elapsed = delta + input.beforeDueDays;
    if (elapsed < 0) return null;
    if (input.repeatDays === null) return { kind: 'payment_reminder', seq: 1, onDay: elapsed === 0 };
    return { kind: 'payment_reminder', seq: 1 + Math.floor(elapsed / input.repeatDays), onDay: elapsed % input.repeatDays === 0 };
  }
  const seq = Math.floor(delta / input.overdueEveryDays);
  if (delta === 0 || seq === 0) return null;
  return { kind: 'payment_overdue', seq, onDay: delta % input.overdueEveryDays === 0 };
}

export function reminderDueToday(input: ReminderCadence & { lastSentSeq: number }): { kind: ReminderKind; seq: number } | null {
  if (!Number.isSafeInteger(input.lastSentSeq) || input.lastSentSeq < 0) {
    throw new RangeError('Invalid lastSentSeq');
  }
  const step = reminderStep(input);
  return step?.onDay && step.seq > input.lastSentSeq ? { kind: step.kind, seq: step.seq } : null;
}

const ACTIVE_SCHEDULES = ['awaiting_notice', 'scheduled', 'collecting', 'retry_scheduled'] as const;
const ORG_PAGE = 100;
const INVOICE_PAGE = 250;

function system<T>(fn: () => Promise<T>): Promise<T> {
  return runOutsideDbContext(() => withSystemDbAccessContext(fn));
}
function invoiceCandidate() {
  return and(
    sqlOpenAr(invoices), gt(invoices.balance, '0'), isNotNull(invoices.dueDate),
    buildPublicLinkLiveOrgPredicate(invoices.orgId),
    sql`NOT EXISTS (
      SELECT 1 FROM ${invoiceAutopaySchedules}
      WHERE ${invoiceAutopaySchedules.invoiceId} = ${invoices.id}
        AND ${invoiceAutopaySchedules.orgId} = ${invoices.orgId}
        AND ${inArray(invoiceAutopaySchedules.state, [...ACTIVE_SCHEDULES])}
    )`,
    // A payment already in flight (incl. unscheduled "pay by bank" attempts and a
    // processing debit whose schedule a pause cancelled): "View & pay" would 409.
    sql`NOT EXISTS (
      SELECT 1 FROM ${invoiceCollectionAttempts}
      WHERE ${invoiceCollectionAttempts.invoiceId} = ${invoices.id}
        AND ${inArray(invoiceCollectionAttempts.state, [...RESERVING_COLLECTION_ATTEMPT_STATES])}
    )`,
  );
}

export async function runInvoiceReminderSweep(now = new Date()): Promise<{ enqueued: number; skippedNoContact: number }> {
  const today = now.toISOString().slice(0, 10);
  utcDay(today);
  let orgCursor: string | undefined;
  let enqueued = 0;
  let skippedNoContact = 0;
  let failureCount = 0;
  const errors: Error[] = [];
  const reportFailure = (orgId: string, invoiceId?: string) => {
    failureCount++;
    // Exceptions can carry recipient addresses or bearer links: retain only ids.
    const tags = { service: 'invoiceReminderSweep', orgId, ...(invoiceId ? { invoiceId } : {}) };
    const error = new Error('Invoice reminder sweep item failed');
    console.error('[invoiceReminderSweep] item failed', tags);
    captureException(error, undefined, tags);
    if (errors.length < 100) errors.push(error);
  };
  for (;;) {
    const orgs = await system(() => db.select({
      id: organizations.id, partnerId: organizations.partnerId, name: organizations.name,
      billingContact: organizations.billingContact,
      partnerName: partners.name, partnerSettings: partners.settings,
    }).from(organizations).innerJoin(partners, eq(partners.id, organizations.partnerId))
      .where(and(
        orgCursor ? gt(organizations.id, orgCursor) : undefined,
        buildPublicLinkLiveOrgPredicate(organizations.id),
        sql`EXISTS (SELECT 1 FROM ${invoices}
          WHERE ${invoices.orgId} = ${organizations.id} AND ${invoiceCandidate()})`,
      )).orderBy(organizations.id).limit(ORG_PAGE));
    if (orgs.length === 0) break;
    for (const org of orgs) {
      orgCursor = org.id;
      try {
        const settings = await system(() => resolveBillingPaymentSettings(db, {
          partnerId: org.partnerId, orgId: org.id,
        }));
        if (!settings.remindersEnabled.value) continue;
        const recipient = resolveBillingEmail(org.billingContact)?.trim();
        if (!recipient || !z.string().email().safeParse(recipient).success) {
          skippedNoContact++;
          continue;
        }
        let invoiceCursor: string | undefined;
        for (;;) {
          const ids = await system(() => db.select({ id: invoices.id }).from(invoices).where(and(
            eq(invoices.orgId, org.id), eq(invoices.partnerId, org.partnerId), invoiceCandidate(),
            invoiceCursor ? gt(invoices.id, invoiceCursor) : undefined,
          )).orderBy(invoices.id).limit(INVOICE_PAGE));
          if (ids.length === 0) break;
          for (const { id } of ids) {
            invoiceCursor = id;
            try {
              const created = await system(async () => {
                const [invoice] = await db.select().from(invoices).where(and(
                  eq(invoices.id, id), eq(invoices.orgId, org.id),
                  eq(invoices.partnerId, org.partnerId), invoiceCandidate(),
                )).limit(1).for('update');
                if (!invoice?.dueDate || !invoice.invoiceNumber) return false;
                const due = reminderStep({
                  dueDate: invoice.dueDate, today,
                  beforeDueDays: settings.reminderBeforeDueDays.value,
                  repeatDays: settings.reminderRepeatDays.value,
                  overdueEveryDays: settings.overdueReminderEveryDays.value,
                });
                if (!due) return false;
                const stepKey = `invoice:${id}:${due.kind}:${due.seq}`;
                if (!due.onDay) {
                  // Off its day, a step is only re-sent to replace a stale cancellation (unique-index lookup).
                  const [prior] = await db.select({ status: billingNoticeOutbox.status, lastError: billingNoticeOutbox.lastError })
                    .from(billingNoticeOutbox).where(eq(billingNoticeOutbox.dedupeKey, stepKey)).limit(1);
                  if (prior?.status !== 'cancelled' || prior.lastError !== STALE_REMINDER_REASON) return false;
                }
                // A step cancelled as stale was never delivered: it does not advance the
                // cadence, and its replacement takes the next revision of the step's key.
                const stale = sql`${billingNoticeOutbox.status} = 'cancelled' AND ${billingNoticeOutbox.lastError} IS NOT DISTINCT FROM ${STALE_REMINDER_REASON}`;
                const [history] = await db.select({
                  seq: sql<number>`coalesce(max(${billingNoticeOutbox.seq}) FILTER (WHERE NOT (${stale})), 0)::int`,
                  atStep: sql<number>`(count(*) FILTER (WHERE ${billingNoticeOutbox.seq} = ${due.seq}))::int`,
                }).from(billingNoticeOutbox).where(and(
                    eq(billingNoticeOutbox.invoiceId, id), eq(billingNoticeOutbox.orgId, org.id),
                    eq(billingNoticeOutbox.kind, due.kind),
                  )).limit(1);
                if (due.seq <= (history?.seq ?? 0)) return false;
                const revision = history?.atStep ?? 0;
                const link = await getOrMintInvoiceLink(invoice);
                const rendered = await renderBillingNotice(due.kind, {
                  partnerId: org.partnerId, orgId: org.id, mandatory: {},
                  frozen: { amount: invoice.balance, currency: invoice.currencyCode,
                    dueDate: invoice.dueDate, daysOverdue: Math.max(0, utcDay(today) - utcDay(invoice.dueDate)) },
                  data: {
                    invoiceNumber: invoice.invoiceNumber, balance: invoice.balance,
                    currency: invoice.currencyCode, dueDate: invoice.dueDate,
                    daysOverdue: Math.max(0, utcDay(today) - utcDay(invoice.dueDate)),
                    payLink: buildPublicInvoiceUrl(link.token), partnerName: org.partnerName,
                    orgName: org.name, partnerSettings: org.partnerSettings,
                  },
                });
                const result = await enqueueBillingNotice(db, {
                  orgId: org.id, partnerId: org.partnerId, invoiceId: id,
                  kind: due.kind, seq: due.seq, dedupeKey: revision > 0 ? `${stepKey}:r${revision}` : stepKey,
                  toEmail: recipient, rendered,
                });
                return result.created;
              });
              if (created) enqueued += 1;
            } catch { reportFailure(org.id, id); }
          }
        }
      } catch { reportFailure(org.id); }
    }
  }
  if (skippedNoContact) console.warn('[invoiceReminderSweep] missing billing contact', { skippedNoContact });
  if (failureCount) throw new AggregateError(errors, `Invoice reminder sweep failed for ${failureCount} items`);
  return { enqueued, skippedNoContact };
}
