import { and, eq } from 'drizzle-orm';
import { db } from '../../db';
import { invoices, invoiceLines, contracts, organizations, orgAutopayEnrollments,
  invoiceAutopaySchedules } from '../../db/schema';
import type { AutopayIneligibleReason } from '@breeze/shared';
import { toMinorUnits } from '../stripeMoney';
import { resolveBillingPaymentSettings } from './billingPaymentSettings';
import { isAutopayEnabledForPartner } from './autopayGate';
import { getAutopayStripeReadiness } from './stripeCapabilities';
import { getAutopayMethod } from './paymentMethods';
import { quoteProcessingFee } from './processingFee';
import { enqueueAutopayNotice, type AutopayTerms } from './chargingNotice';
type Tx = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

import type { AutopayOffsetRule, AutopayPaymentMethodType, AccountHolderType } from '@breeze/shared';

export function utcDay(value: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('Invalid UTC date');
  const date = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new Error('Invalid UTC date');
  }
  return date;
}
export function addUtcDays(value: string, days: number): string {
  if (!Number.isInteger(days)) throw new Error('Days must be an integer');
  const date = utcDay(value);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}
export function computeCollectOn(input: {
  issueDate: string; dueDate: string; offsetDays: number;
  rule: AutopayOffsetRule; noticeDate: string; leadDays: number;
}): string {
  if (!Number.isInteger(input.offsetDays) || input.offsetDays < 0 || input.offsetDays > 60) {
    throw new Error('Invalid autopay offset');
  }
  if (input.leadDays !== 1 && input.leadDays !== 10) throw new Error('Invalid notice lead');
  utcDay(input.dueDate);
  const offsetDate = addUtcDays(input.issueDate, input.offsetDays);
  const chosen = input.rule === 'earlier'
    ? (offsetDate < input.dueDate ? offsetDate : input.dueDate)
    : (offsetDate > input.dueDate ? offsetDate : input.dueDate);
  const earliest = addUtcDays(input.noticeDate, input.leadDays);
  return chosen > earliest ? chosen : earliest;
}
export function noticeLeadDays(method: {
  type: AutopayPaymentMethodType; accountHolderType: AccountHolderType | null;
}): 1 | 10 {
  return method.type === 'us_bank_account' && method.accountHolderType === 'individual' ? 10 : 1;
}

export interface Eligibility {
  active: boolean; effective: boolean; methodUsable: boolean; charging: boolean;
  stripeReady: boolean; sameAccount: boolean; achCurrency: boolean; capCurrency: boolean;
  underCap: boolean; excludedContract: boolean; excludedInvoice: boolean;
}
export function eligibilityReason(e: Eligibility): AutopayIneligibleReason | null {
  if (!e.active) return 'not_enrolled';
  if (!e.effective) return 'enrolled_after_issue';
  if (!e.methodUsable) return 'method_not_usable';
  if (!e.charging) return 'charging_disabled';
  if (!e.stripeReady || !e.sameAccount) return 'stripe_unavailable';
  if (!e.achCurrency) return 'ach_currency_unsupported';
  if (!e.capCurrency) return 'cap_currency_mismatch';
  if (!e.underCap) return 'over_cap';
  if (e.excludedContract) return 'excluded_contract';
  if (e.excludedInvoice) return 'excluded_invoice';
  return null;
}
export async function planAutopayForInvoice(tx: Tx, invoiceId: string)
  : Promise<typeof invoiceAutopaySchedules.$inferSelect | null> {
  const [invoice] = await tx.select().from(invoices).where(eq(invoices.id, invoiceId)).limit(1).for('update');
  if (!invoice?.invoiceNumber || !invoice.issueDate || !invoice.dueDate) return null;
  const [existing] = await tx.select().from(invoiceAutopaySchedules)
    .where(eq(invoiceAutopaySchedules.invoiceId, invoiceId)).limit(1);
  if (existing) return existing;
  const [enrollment] = await tx.select().from(orgAutopayEnrollments)
    .where(eq(orgAutopayEnrollments.orgId, invoice.orgId)).limit(1);
  if (!enrollment) return null;
  const [org] = await tx.select().from(organizations).where(eq(organizations.id, invoice.orgId)).limit(1);
  if (!org) throw new Error('Invoice organization missing');
  const settings = await resolveBillingPaymentSettings(tx, { partnerId: invoice.partnerId, orgId: invoice.orgId });
  const method = await getAutopayMethod(tx, invoice.orgId);
  const readiness = await getAutopayStripeReadiness(tx, invoice.partnerId);
  const charging = await isAutopayEnabledForPartner(tx, invoice.partnerId);
  const excluded = await tx.select({ id: contracts.id }).from(invoiceLines).innerJoin(contracts, and(
    eq(invoiceLines.sourceContractId, contracts.id), eq(invoiceLines.orgId, contracts.orgId),
  )).where(and(eq(invoiceLines.invoiceId, invoiceId), eq(contracts.autopayExcluded, true))).limit(1);
  const cap = settings.autopayCap.value;
  const capCurrency = !cap.enabled || cap.currency.toUpperCase() === invoice.currencyCode;
  const reason = eligibilityReason({ active: enrollment.status === 'active',
    effective: !!enrollment.effectiveFrom && enrollment.effectiveFrom <= invoice.updatedAt,
    methodUsable: !!method && ['active', 'pending_verification'].includes(method.status)
      && (method.type !== 'us_bank_account' || method.accountHolderType !== null),
    charging, stripeReady: readiness.ready,
    sameAccount: readiness.stripeAccountId === enrollment.stripeAccountId,
    achCurrency: method?.type !== 'us_bank_account' || invoice.currencyCode === 'USD',
    capCurrency, underCap: !cap.enabled || (capCurrency &&
      toMinorUnits(invoice.total, invoice.currencyCode) <= toMinorUnits(cap.amount, invoice.currencyCode)),
    excludedContract: excluded.length > 0, excludedInvoice: invoice.autopayExcluded,
  });
  const leadDays = method ? noticeLeadDays(method) : 1;
  const collectOn = computeCollectOn({ issueDate: invoice.issueDate, dueDate: invoice.dueDate,
    offsetDays: settings.autopayOffsetDays.value, rule: settings.autopayOffsetRule.value,
    noticeDate: new Date().toISOString().slice(0, 10), leadDays });
  const fee = method ? quoteProcessingFee({ methodType: method.type, cardFunding: method.cardFunding,
    principal: invoice.balance, currency: invoice.currencyCode, stripeAccountCountry: readiness.accountCountry,
    orgBillingCountry: org.billingAddressCountry, orgBillingRegion: org.billingAddressRegion,
    cardFeeBps: settings.cardFeeBps.value, achFeeAmount: settings.achFeeAmount.value,
    feeAttested: settings.feeAttested }) : { feeAmount: '0.00', kind: 'none' as const };
  const snapshot = method ? {
    issuedAt: invoice.updatedAt.toISOString(), offsetDays: settings.autopayOffsetDays.value,
    rule: settings.autopayOffsetRule.value, cap, methodType: method.type, methodId: method.id,
    last4: method.type === 'card' ? method.cardLast4 ?? '' : method.bankLast4 ?? '',
    methodLabel: method.type === 'card'
      ? `${method.cardBrand ?? 'Card'} ••${method.cardLast4 ?? ''}`
      : `${method.bankName ?? 'Bank'} ••${method.bankLast4 ?? ''}`,
    accountHolderType: method.accountHolderType, noticeLeadDays: leadDays,
    principal: invoice.balance, currency: invoice.currencyCode, feeAmount: fee.feeAmount,
    feeKind: fee.kind, cardFeeBps: settings.cardFeeBps.value,
    achFeeAmount: settings.achFeeAmount.value, chargeDate: collectOn, noticeSeq: 1,
  } satisfies AutopayTerms : { issuedAt: invoice.updatedAt.toISOString(), noticeSeq: 0 };
  const [created] = await tx.insert(invoiceAutopaySchedules).values({ orgId: invoice.orgId,
    invoiceId, enrollmentId: enrollment.id, enrollmentGeneration: enrollment.generation,
    eligible: reason === null, ineligibleReason: reason, collectOn, termsSnapshot: snapshot,
    state: reason === null ? 'awaiting_notice' : 'not_needed', stateReason: reason,
    attemptCount: 0 }).returning();
  if (!created) throw new Error('Autopay schedule insert failed');
  if (created.eligible) await enqueueAutopayNotice(tx, created.id);
  const [planned] = await tx.select().from(invoiceAutopaySchedules)
    .where(eq(invoiceAutopaySchedules.id, created.id)).limit(1);
  return planned!;
}
