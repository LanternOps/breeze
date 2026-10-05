import { eq } from 'drizzle-orm';
import { autopayTermsSnapshotSchema } from '@breeze/shared';
import { invoiceAutopaySchedules, invoices, organizations, partners } from '../../db/schema';
import { resolveBillingEmail } from '../invoicePdf';
import { getOrMintInvoiceLink, buildPublicInvoiceUrl } from '../invoiceLinkToken';
import { escapeHtml } from '../emailLayout';
import { toMinorUnits } from '../stripeMoney';
import { enqueueBillingNotice } from './noticeOutbox';
import { renderBillingNotice } from './renderBillingNotice';
import { enqueueAutopayStaffAttention } from './staffNotifications';
import type { Tx } from './types';

/** Collection outcomes that stop a charge the client may already have been told about. */
export const NOT_CHARGED_REASONS = ['above_authorized_cap', 'over_cap', 'cap_currency_mismatch', 'consent_required', 'excluded_contract'] as const;
export type NotChargedReason = typeof NOT_CHARGED_REASONS[number];
export function isNotChargedReason(reason: string | null | undefined): reason is NotChargedReason {
  return (NOT_CHARGED_REASONS as readonly string[]).includes(reason ?? '');
}

function clientReason(reason: NotChargedReason, partnerName: string): string {
  switch (reason) {
    case 'above_authorized_cap': return 'This invoice is above the automatic payment limit you authorized, so it will not be charged automatically.';
    case 'over_cap': return 'This invoice is over your automatic payment limit, so it will not be charged automatically.';
    case 'cap_currency_mismatch': return 'This invoice\'s currency can\'t be paid automatically, so it will not be charged automatically.';
    case 'consent_required': return `${partnerName} needs your updated authorization before charging automatically, so this invoice will not be charged automatically.`;
    case 'excluded_contract': return `${partnerName} asked for this invoice to be paid directly, so it will not be charged automatically.`;
  }
}
/** Staff already hear about a missing consent from the fee check, and they excluded the contract themselves. */
function staffMessage(reason: NotChargedReason, clientTold: boolean): string | null {
  const told = clientTold ? ' The client was told and can pay directly.' : ' The client can pay directly.';
  switch (reason) {
    case 'above_authorized_cap': return `This invoice is above the limit the client authorized for automatic payments, so it was not charged. Request updated authorization if it should be charged automatically.${told}`;
    case 'over_cap': return `This invoice is above the automatic payment limit, so it was not charged.${told}`;
    case 'cap_currency_mismatch': return `This invoice's currency does not match the automatic payment limit, so it was not charged.${told}`;
    case 'consent_required': return `The client's automatic payment authorization could not be read, so this invoice was not charged. Request updated authorization.${told}`;
    case 'excluded_contract': return null;
  }
}

/** The client was told this invoice would be charged automatically (a charging notice was
 * delivered) and collection now will not charge it (R3, 2a-3). Tell them, and how to pay,
 * with the same payment_reminder shape as the post-skip confirmation. One notice per
 * announcement. Caller holds the invoice lock and has already moved the schedule out of
 * collection. Returns whether the client notice was queued. */
export async function noticeChargeNotMade(tx: Tx, input: { invoiceId: string; scheduleId: string; reason: NotChargedReason }): Promise<boolean> {
  const [invoice] = await tx.select().from(invoices).where(eq(invoices.id, input.invoiceId)).limit(1);
  const [schedule] = await tx.select().from(invoiceAutopaySchedules).where(eq(invoiceAutopaySchedules.id, input.scheduleId)).limit(1);
  if (!invoice || !schedule || schedule.invoiceId !== invoice.id) return false;
  const terms = autopayTermsSnapshotSchema.safeParse(schedule.termsSnapshot);
  const announced = !!schedule.noticeSentAt && terms.success && terms.data.kind === 'terms';
  let queued = false;
  const payable = ['sent', 'partially_paid', 'overdue'].includes(invoice.status) && toMinorUnits(invoice.balance, invoice.currencyCode) > 0;
  if (announced && payable && terms.success && terms.data.kind === 'terms') {
    const [org] = await tx.select().from(organizations).where(eq(organizations.id, invoice.orgId)).limit(1);
    const [partner] = await tx.select().from(partners).where(eq(partners.id, invoice.partnerId)).limit(1);
    if (!org || !partner) throw new Error('Not-charged notice ownership unavailable');
    const recipient = resolveBillingEmail(org.billingContact);
    if (recipient) {
      const link = await getOrMintInvoiceLink(invoice, tx);
      const rendered = await renderBillingNotice('payment_reminder', { partnerId: invoice.partnerId, orgId: invoice.orgId,
        mandatory: {}, frozen: { amount: invoice.balance, currency: invoice.currencyCode, dueDate: invoice.dueDate },
        data: { invoiceNumber: invoice.invoiceNumber, balance: invoice.balance, currency: invoice.currencyCode,
          dueDate: invoice.dueDate, daysOverdue: 0, payLink: buildPublicInvoiceUrl(link.token),
          partnerName: partner.name, orgName: org.name, partnerSettings: partner.settings } }, tx);
      const prefix = `${clientReason(input.reason, partner.name)} You can pay using the invoice link.`;
      const created = await enqueueBillingNotice(tx, { orgId: invoice.orgId, partnerId: invoice.partnerId, invoiceId: invoice.id,
        kind: 'payment_reminder', seq: 0, dedupeKey: `invoice:${invoice.id}:not_charged:${terms.data.noticeSeq}`, toEmail: recipient,
        rendered: { ...rendered, subject: `Automatic payment cancelled — ${invoice.invoiceNumber}`,
          html: `<p>${escapeHtml(prefix)}</p>${rendered.html}`, text: `${prefix}\n\n${rendered.text}` } });
      queued = !!created.id;
    }
  }
  const staff = staffMessage(input.reason, queued);
  // In-app per invoice. Email once per condition: a missing authorization shares the fee
  // check's key (collectionFee.acceptedCollectionFee), a cap change emails once a day per client.
  const methodId = terms.success && terms.data.kind === 'terms' ? terms.data.methodId : 'none';
  const emailDedupeKey = input.reason === 'consent_required'
    ? `autopay:consent_required:${schedule.enrollmentId}:${schedule.enrollmentGeneration}:${methodId}`
    : `autopay:not_charged:${input.reason}:${schedule.enrollmentId}:${schedule.enrollmentGeneration}:${new Date().toISOString().slice(0, 10)}`;
  if (staff) await enqueueAutopayStaffAttention(tx, { orgId: invoice.orgId, partnerId: invoice.partnerId, invoiceId: invoice.id,
    event: 'autopay.needs_attention', dedupeKey: `autopay:${schedule.id}:not_charged:${input.reason}`, emailDedupeKey, message: staff });
  console.info('[autopay] Invoice not charged automatically', { orgId: invoice.orgId, invoiceId: invoice.id,
    scheduleId: schedule.id, reason: input.reason, announced, clientNotified: queued });
  return queued;
}
