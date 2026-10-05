import { and, eq, gt } from 'drizzle-orm';
import { invoices } from '../../db/schema';
import { sqlOpenAr } from '../../db/schema/invoices';
import { buildPublicLinkLiveOrgPredicate } from '../publicLinkOrgGate';
import { toMinorUnits } from '../stripeMoney';
import { readInFlightCollection } from './reservation';
import type { NoticePreSendValidator } from './noticeOutbox';
import type { RenderedNotice } from './types';

/** Fixed cancellation reason for a reminder whose frozen amount or due date went
 * stale. The sweep treats only this reason as "not sent" and replaces the step. */
export const STALE_REMINDER_REASON = 'Reminder amount or due date changed';

function sameAmount(frozen: unknown, current: string, currency: string): boolean {
  if (typeof frozen !== 'string' || !frozen.trim() || !Number.isFinite(Number(frozen))) return false;
  return toMinorUnits(frozen, currency) === toMinorUnits(current, currency);
}

/** Reminders state a balance and due date frozen at enqueue. Transport retries can
 * delay one past a partial payment, a due-date edit or the start of a collection. */
export const validateReminder: NoticePreSendValidator = async (tx, row) => {
  if (!row.invoiceId) return 'Reminder invoice missing';
  const [invoice] = await tx.select({ id: invoices.id, balance: invoices.balance, currencyCode: invoices.currencyCode,
    dueDate: invoices.dueDate }).from(invoices).where(and(
    eq(invoices.id, row.invoiceId), eq(invoices.orgId, row.orgId),
    sqlOpenAr(invoices), gt(invoices.balance, '0'), buildPublicLinkLiveOrgPredicate(invoices.orgId),
  )).limit(1);
  if (!invoice) return 'Reminder invoice or tenant no longer eligible';
  // Same reserving-state set as the pay routes' 409: "View & pay" would be refused.
  if ((await readInFlightCollection(tx, invoice.id)).inProgress) return 'Payment in progress';
  const frozen = (row.rendered as RenderedNotice).frozen;
  if (frozen?.currency !== invoice.currencyCode || frozen.dueDate !== invoice.dueDate
    || !sameAmount(frozen.amount, invoice.balance, invoice.currencyCode)) return STALE_REMINDER_REASON;
  return null;
};
