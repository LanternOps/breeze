import { eq } from 'drizzle-orm';
import { autopayTermsSnapshotSchema } from '@breeze/shared';
import { invoiceAutopaySchedules, invoices, organizations, partners } from '../../db/schema';
import { resolveBillingEmail } from '../invoicePdf';
import { getOrMintInvoiceLink, buildPublicInvoiceUrl } from '../invoiceLinkToken';
import { clientNameFor } from './billingEmail';
import { toMinorUnits } from '../stripeMoney';
import { enqueueBillingNotice } from './noticeOutbox';
import { renderBillingNotice } from './renderBillingNotice';
import { enqueueAutopayStaffAttention } from './staffNotifications';
import { announcedCharges } from './announcedCharges';
import type { Tx } from './types';
import { db as ambientDb, getCurrentDbAccessContext } from '../../db';
import { readWithPartnerAxisVisibility } from '../../db/partnerAxisRead';

/** Collection outcomes that stop a charge the client may already have been told about. */
export const NOT_CHARGED_REASONS = ['above_authorized_cap', 'over_cap', 'cap_currency_mismatch', 'consent_required', 'excluded_contract'] as const;
export type NotChargedReason = typeof NOT_CHARGED_REASONS[number];
/** Staff actions that end an announced charge: an MSP exclusion, and a pause or stop whose
 * email was superseded before it went out (F2). Staff did these themselves: no staff notice. */
export type ClientControlReason = 'exclude' | 'paused' | 'stopped';
export function isNotChargedReason(reason: string | null | undefined): reason is NotChargedReason {
  return (NOT_CHARGED_REASONS as readonly string[]).includes(reason ?? '');
}
/** G1/G2: a charge deferred past the grace (collectionEngine DEFERRAL_GRACE_MS) ends with one of
 * these as the schedule's state_reason: the bank never verified, automatic payments stayed
 * switched off, or Stripe stayed unreachable. */
export const DEFERRAL_END_REASONS = ['bank_unverified', 'charging_on_hold', 'service_unavailable'] as const;
export type DeferralEndReason = typeof DEFERRAL_END_REASONS[number];
export function isDeferralEndReason(reason: string | null | undefined): reason is DeferralEndReason {
  return (DEFERRAL_END_REASONS as readonly string[]).includes(reason ?? '');
}

/** Why the announced charge will not happen, in the client's words. */
function clientReason(reason: NotChargedReason | ClientControlReason | DeferralEndReason, partnerName: string): string {
  switch (reason) {
    case 'bank_unverified': return "Your bank account still isn't verified, so we couldn't take this payment from it.";
    case 'charging_on_hold': return `Automatic payments are on hold with ${partnerName}, so this invoice can't be charged automatically.`;
    case 'service_unavailable': return "We couldn't reach our payment service to take this payment.";
    case 'exclude': return `${partnerName} will not charge this invoice automatically.`;
    case 'paused': return 'Automatic payments were paused, and this invoice will not be charged automatically even if they resume.';
    case 'stopped': return 'Automatic payments were stopped, so this invoice will not be charged automatically.';
    case 'excluded_contract': return `${partnerName} asked for this invoice to be paid directly.`;
    case 'above_authorized_cap': return 'This invoice is above the automatic payment limit you authorized.';
    case 'over_cap': return 'This invoice is over your automatic payment limit.';
    case 'cap_currency_mismatch': return 'This invoice\'s currency can\'t be paid automatically.';
    case 'consent_required': return `${partnerName} needs your updated authorization before charging automatically.`;
  }
}
/** Staff already hear about a missing consent from the fee check, and they excluded the contract themselves. */
function staffMessage(reason: NotChargedReason | DeferralEndReason, clientTold: boolean): string | null {
  const told = clientTold ? ' The client was told and can pay directly.' : ' The client can pay directly.';
  switch (reason) {
    case 'bank_unverified': return `The client's bank account was still not verified two days after this invoice was due, so it will not be charged automatically.${told}`;
    case 'charging_on_hold': return `Automatic payments stayed switched off for two days after this invoice was due, so it will not be charged automatically.${told}`;
    case 'service_unavailable': return `Stripe could not be reached for two days after this invoice was due, so it will not be charged automatically. Check the Stripe connection.${told}`;
    case 'above_authorized_cap': return `This invoice is above the limit the client authorized for automatic payments, so it was not charged. Request updated authorization if it should be charged automatically.${told}`;
    case 'over_cap': return `This invoice is above the automatic payment limit, so it was not charged.${told}`;
    case 'cap_currency_mismatch': return `This invoice's currency does not match the automatic payment limit, so it was not charged.${told}`;
    case 'consent_required': return `The client's automatic payment authorization could not be read, so this invoice was not charged. Request updated authorization.${told}`;
    case 'excluded_contract': return null;
  }
}

/** The MSP's name and email settings for the notice. An org-scoped request (an org user
 * excluding an invoice) cannot see the partner row under RLS; partner-axis reads use the
 * sanctioned visibility escape, exactly as isAutopayEnabledForPartner does (F6). */
async function partnerForNotice(tx: Tx, partnerId: string) {
  const load = async (executor: Tx) => (await executor.select({ id: partners.id, name: partners.name, settings: partners.settings })
    .from(partners).where(eq(partners.id, partnerId)).limit(1))[0];
  return getCurrentDbAccessContext()?.scope === 'organization' ? readWithPartnerAxisVisibility(() => load(ambientDb)) : load(tx);
}

/** The single "this invoice will not be charged automatically" notice (D-19, R3, 2a-3).
 * The client was told the invoice would be charged (a charging notice actually went out) and
 * now it will not be: an MSP exclusion ('exclude'), or a collection outcome that ended the
 * schedule. One payment_reminder per announcement, whatever the reason, in the post-skip
 * shape; nothing when no charging notice was delivered or the invoice is no longer payable.
 * Collection reasons also tell staff. Caller holds the invoice lock and has already moved the
 * schedule out of collection. Returns whether the client notice was queued. */
export async function noticeChargeNotMade(tx: Tx, input: { invoiceId: string; reason: NotChargedReason | ClientControlReason | DeferralEndReason; scheduleId?: string }): Promise<boolean> {
  const [invoice] = await tx.select().from(invoices).where(eq(invoices.id, input.invoiceId)).limit(1);
  if (!invoice) return false;
  const [announced] = await announcedCharges(tx, { invoiceId: invoice.id });
  let queued = false;
  const payable = ['sent', 'partially_paid', 'overdue'].includes(invoice.status) && toMinorUnits(invoice.balance, invoice.currencyCode) > 0;
  if (announced && payable) {
    const [org] = await tx.select().from(organizations).where(eq(organizations.id, invoice.orgId)).limit(1);
    const partner = await partnerForNotice(tx, invoice.partnerId);
    if (!org || !partner) throw new Error('Not-charged notice ownership unavailable');
    const recipient = resolveBillingEmail(org.billingContact);
    if (recipient) {
      const link = await getOrMintInvoiceLink(invoice, tx);
      // Locked wording (renderBillingNotice 'not_charged'): the reason, the announced date, what
      // is due and the pay link, composed once like every client billing email.
      const rendered = await renderBillingNotice('payment_reminder', { partnerId: invoice.partnerId, orgId: invoice.orgId,
        mandatory: {}, frozen: { amount: invoice.balance, currency: invoice.currencyCode, dueDate: invoice.dueDate, reason: input.reason },
        data: { invoiceNumber: invoice.invoiceNumber, balance: invoice.balance, currency: invoice.currencyCode,
          dueDate: invoice.dueDate, daysOverdue: 0, payLink: buildPublicInvoiceUrl(link.token),
          partnerName: partner.name, orgName: org.name, clientName: clientNameFor(org.billingContact, org.name),
          partnerSettings: partner.settings, variant: 'not_charged', notChargedReason: clientReason(input.reason, partner.name),
          announcedFor: announced.chargeDate } }, tx);
      // One notice per announcement: a re-noticed charge that is stopped again is told again.
      await enqueueBillingNotice(tx, { orgId: invoice.orgId, partnerId: invoice.partnerId, invoiceId: invoice.id,
        kind: 'payment_reminder', seq: 0, dedupeKey: `invoice:${invoice.id}:not_charged:${announced.noticeSeq}`, toEmail: recipient, rendered });
      queued = true;
    }
  }
  const staff = isNotChargedReason(input.reason) || isDeferralEndReason(input.reason) ? staffMessage(input.reason, queued) : null;
  if (staff && input.scheduleId) {
    const [schedule] = await tx.select().from(invoiceAutopaySchedules).where(eq(invoiceAutopaySchedules.id, input.scheduleId)).limit(1);
    const terms = autopayTermsSnapshotSchema.safeParse(schedule?.termsSnapshot);
    // In-app per invoice. Email once per condition: a missing authorization shares the fee
    // check's key (collectionFee.acceptedCollectionFee), a cap change emails once a day per client.
    const methodId = terms.success && terms.data.kind === 'terms' ? terms.data.methodId : 'none';
    const emailDedupeKey = input.reason === 'consent_required'
      ? `autopay:consent_required:${schedule?.enrollmentId}:${schedule?.enrollmentGeneration}:${methodId}`
      : `autopay:not_charged:${input.reason}:${schedule?.enrollmentId}:${schedule?.enrollmentGeneration}:${new Date().toISOString().slice(0, 10)}`;
    await enqueueAutopayStaffAttention(tx, { orgId: invoice.orgId, partnerId: invoice.partnerId, invoiceId: invoice.id,
      event: 'autopay.needs_attention', dedupeKey: `autopay:${input.scheduleId}:not_charged:${input.reason}`, emailDedupeKey, message: staff });
  }
  console.info('[autopay] Invoice not charged automatically', { orgId: invoice.orgId, invoiceId: invoice.id,
    scheduleId: input.scheduleId ?? null, reason: input.reason, announced: !!announced, clientNotified: queued });
  return queued;
}
