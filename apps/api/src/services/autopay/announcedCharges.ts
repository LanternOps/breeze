import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import { billingNoticeOutbox, invoiceAutopaySchedules, invoices } from '../../db/schema';
import type { RenderedNotice, Tx } from './types';
import { emailDate } from './billingEmail';

type ScheduleState = (typeof invoiceAutopaySchedules.$inferSelect)['state'];
export interface AnnouncedCharge { invoiceId: string; invoiceNumber: string; chargeDate: string | null; noticeSeq: number;
  /** V2-5: a failure email sent after that notice told the client a retry date (ISO): the most
   * recently communicated date, so it is the one a "will not happen" line cites. */
  retryOn?: string | null }

/** Invoices whose pre-charge notice (invoice_autopay) actually reached the client: they
 * were told "we will initiate payment on or around <date>". When an MSP exclusion, pause
 * or stop cancels that charge, the client must hear that it will not happen (D-19).
 * The date is the one the newest sent notice showed. */
export async function announcedCharges(tx: Tx,
  where: { invoiceId: string } | { orgId: string; states: readonly ScheduleState[] } | { enrollmentId: string; states: readonly ScheduleState[] },
): Promise<AnnouncedCharge[]> {
  const rows = await tx.select({ invoiceId: billingNoticeOutbox.invoiceId, invoiceNumber: invoices.invoiceNumber,
    kind: billingNoticeOutbox.kind, seq: billingNoticeOutbox.seq, sentAt: billingNoticeOutbox.sentAt,
    rendered: billingNoticeOutbox.rendered })
    .from(billingNoticeOutbox)
    .innerJoin(invoiceAutopaySchedules, and(eq(invoiceAutopaySchedules.invoiceId, billingNoticeOutbox.invoiceId),
      eq(invoiceAutopaySchedules.orgId, billingNoticeOutbox.orgId)))
    .innerJoin(invoices, eq(invoices.id, invoiceAutopaySchedules.invoiceId))
    .where(and(inArray(billingNoticeOutbox.kind, ['invoice_autopay', 'payment_failed']), isNotNull(billingNoticeOutbox.sentAt),
      'invoiceId' in where ? eq(invoiceAutopaySchedules.invoiceId, where.invoiceId)
        : 'orgId' in where ? eq(invoiceAutopaySchedules.orgId, where.orgId) : eq(invoiceAutopaySchedules.enrollmentId, where.enrollmentId),
      // Schedules the caller is about to cancel. An invoice lookup runs after its own control.
      'states' in where ? inArray(invoiceAutopaySchedules.state, [...where.states]) : undefined));
  const newest = new Map<string, { seq: number; sentAt: Date; charge: AnnouncedCharge }>();
  for (const row of rows) {
    if (row.kind !== 'invoice_autopay' || !row.sentAt || !row.invoiceId) continue;
    const chargeDate = (row.rendered as RenderedNotice | null)?.frozen?.chargeDate;
    const current = newest.get(row.invoiceId);
    if (current && current.seq >= row.seq) continue;
    newest.set(row.invoiceId, { seq: row.seq, sentAt: row.sentAt, charge: { invoiceId: row.invoiceId,
      invoiceNumber: row.invoiceNumber ?? row.invoiceId, chargeDate: typeof chargeDate === 'string' ? chargeDate : null, noticeSeq: row.seq } });
  }
  // The newest failure email after that notice that named a retry date.
  const retries = new Map<string, Date>();
  for (const row of rows) {
    const entry = row.invoiceId ? newest.get(row.invoiceId) : undefined;
    const retryOn = (row.rendered as RenderedNotice | null)?.frozen?.retryOn;
    if (row.kind !== 'payment_failed' || !row.sentAt || !entry || row.sentAt <= entry.sentAt || typeof retryOn !== 'string') continue;
    const previous = retries.get(row.invoiceId!);
    if (previous && previous >= row.sentAt) continue;
    retries.set(row.invoiceId!, row.sentAt);
    entry.charge.retryOn = retryOn;
  }
  return [...newest.values()].map(entry => entry.charge);
}

/** " to take on or around November 4, 2026" (after "the automatic payment we planned"), or
 * nothing when the date is unknown (FP-10: "announced for on or around" read badly). */
export function announcedOn(charge: AnnouncedCharge): string {
  if (charge.retryOn) return ` to try again on or after ${emailDate(charge.retryOn)}`;
  return charge.chargeDate ? ` to take on or around ${emailDate(charge.chargeDate)}` : '';
}
