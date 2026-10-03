import { and, eq, gt, inArray, isNotNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { invoices, organizations, partners, invoiceAutopaySchedules, billingNoticeOutbox } from '../../db/schema';
import { sqlOpenAr } from '../../db/schema/invoices';
import { buildAutomationEligibleOrgPredicate } from '../tenantStatus';
import { resolveBillingEmail } from '../invoicePdf';
import { getOrMintInvoiceLink, buildPublicInvoiceUrl } from '../invoiceLinkToken';
import { resolveBillingPaymentSettings } from './billingPaymentSettings';
import { renderBillingNotice } from './renderBillingNotice';
import { enqueueBillingNotice } from './noticeOutbox';

const DAY_MS = 86_400_000;

function utcDay(value: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new RangeError('Expected YYYY-MM-DD');
  const ms = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 10) !== value) {
    throw new RangeError('Invalid calendar date');
  }
  return ms / DAY_MS;
}

export function reminderDueToday(input: {
  dueDate: string; today: string; beforeDueDays: number; repeatDays: number | null;
  overdueEveryDays: number; lastSentSeq: number;
}): { kind: 'payment_reminder' | 'payment_overdue'; seq: number } | null {
  for (const interval of [input.beforeDueDays, input.repeatDays, input.overdueEveryDays]) {
    if (interval !== null && (!Number.isInteger(interval) || interval < 1 || interval > 31)) {
      throw new RangeError('Reminder intervals must be integers in 1–31');
    }
  }
  if (!Number.isSafeInteger(input.lastSentSeq) || input.lastSentSeq < 0) {
    throw new RangeError('Invalid lastSentSeq');
  }
  const delta = utcDay(input.today) - utcDay(input.dueDate);
  let kind: 'payment_reminder' | 'payment_overdue';
  let seq: number;
  if (delta < 0) {
    const elapsed = delta + input.beforeDueDays;
    if (elapsed < 0) return null;
    if (elapsed === 0) seq = 1;
    else {
      if (input.repeatDays === null || elapsed % input.repeatDays !== 0) return null;
      seq = 1 + elapsed / input.repeatDays;
    }
    kind = 'payment_reminder';
  } else {
    if (delta === 0 || delta % input.overdueEveryDays !== 0) return null;
    kind = 'payment_overdue';
    seq = delta / input.overdueEveryDays;
  }
  return seq > input.lastSentSeq ? { kind, seq } : null;
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
    buildAutomationEligibleOrgPredicate(invoices.orgId),
    sql`NOT EXISTS (
      SELECT 1 FROM ${invoiceAutopaySchedules}
      WHERE ${invoiceAutopaySchedules.invoiceId} = ${invoices.id}
        AND ${invoiceAutopaySchedules.orgId} = ${invoices.orgId}
        AND ${inArray(invoiceAutopaySchedules.state, [...ACTIVE_SCHEDULES])}
    )`,
  );
}

export async function runInvoiceReminderSweep(now = new Date()): Promise<{ enqueued: number }> {
  const today = now.toISOString().slice(0, 10);
  utcDay(today);
  let orgCursor: string | undefined;
  let enqueued = 0;
  const errors: unknown[] = [];
  for (;;) {
    const orgs = await system(() => db.select({
      id: organizations.id, partnerId: organizations.partnerId, name: organizations.name,
      billingContact: organizations.billingContact,
      partnerName: partners.name, partnerSettings: partners.settings,
    }).from(organizations).innerJoin(partners, eq(partners.id, organizations.partnerId))
      .where(and(
        orgCursor ? gt(organizations.id, orgCursor) : undefined,
        buildAutomationEligibleOrgPredicate(organizations.id),
        sql`EXISTS (SELECT 1 FROM ${invoices}
          WHERE ${invoices.orgId} = ${organizations.id} AND ${invoiceCandidate()})`,
      )).orderBy(organizations.id).limit(ORG_PAGE));
    if (orgs.length === 0) break;
    for (const org of orgs) {
      orgCursor = org.id;
      const recipient = resolveBillingEmail(org.billingContact)?.trim();
      if (!recipient || !z.string().email().safeParse(recipient).success) continue;
      try {
        const settings = await system(() => resolveBillingPaymentSettings(db, {
          partnerId: org.partnerId, orgId: org.id,
        }));
        if (!settings.remindersEnabled.value) continue;
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
                const cadence = {
                  dueDate: invoice.dueDate, today,
                  beforeDueDays: settings.reminderBeforeDueDays.value,
                  repeatDays: settings.reminderRepeatDays.value,
                  overdueEveryDays: settings.overdueReminderEveryDays.value,
                  lastSentSeq: 0,
                };
                const due = reminderDueToday(cadence);
                if (!due) return false;
                const [history] = await db.select({ seq: sql<number>`coalesce(max(${billingNoticeOutbox.seq}), 0)::int` })
                  .from(billingNoticeOutbox).where(and(
                    eq(billingNoticeOutbox.invoiceId, id), eq(billingNoticeOutbox.orgId, org.id),
                    eq(billingNoticeOutbox.kind, due.kind),
                  )).limit(1);
                if (!reminderDueToday({ ...cadence, lastSentSeq: history?.seq ?? 0 })) return false;
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
                  kind: due.kind, seq: due.seq, dedupeKey: `invoice:${id}:${due.kind}:${due.seq}`,
                  toEmail: recipient, rendered,
                });
                return result.created;
              });
              if (created) enqueued += 1;
            } catch (error) { errors.push(error); }
          }
        }
      } catch (error) { errors.push(error); }
    }
  }
  if (errors.length) throw new AggregateError(errors, `Invoice reminder sweep failed for ${errors.length} items`);
  return { enqueued };
}
