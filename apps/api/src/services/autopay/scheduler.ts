import { autopayTermsSnapshotSchema } from '@breeze/shared';
import { collectionFenced, pendingInvoiceControl } from './collectionControl';
import { and, eq, inArray, sql, asc, gt } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { invoices, invoiceLines, contracts, organizations, orgAutopayEnrollments,
  invoiceAutopaySchedules, billingNoticeOutbox, invoiceCollectionAttempts } from '../../db/schema';
import type { AutopayIneligibleReason } from '@breeze/shared';
import { toMinorUnits } from '../stripeMoney';
import { resolveBillingPaymentSettings } from './billingPaymentSettings';
import { isAutopayEnabledForPartner } from './autopayGate';
import { getAutopayStripeReadiness } from './stripeCapabilities';
import { getAutopayMethod } from './paymentMethods';
import { quoteProcessingFee } from './processingFee';
import { acceptedCollectionFee } from './collectionFee';
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
export async function planAutopayForInvoice(tx: Tx, invoiceId: string, refresh = false)
  : Promise<typeof invoiceAutopaySchedules.$inferSelect | null> {
  const [invoice] = await tx.select().from(invoices).where(eq(invoices.id, invoiceId)).limit(1).for('update');
  if (!invoice?.invoiceNumber || !invoice.issueDate || !invoice.dueDate) return null;
  const [existing] = await tx.select().from(invoiceAutopaySchedules)
    .where(eq(invoiceAutopaySchedules.invoiceId, invoiceId)).limit(1);
  if (existing && !refresh) return existing;
  if (refresh && (!existing || !['scheduled','awaiting_notice'].includes(existing.state)
    || pendingInvoiceControl(existing.stateReason))) return existing ?? null;
  const previous = existing ? autopayTermsSnapshotSchema.parse(existing.termsSnapshot) : null;
  const [enrollment] = await tx.select().from(orgAutopayEnrollments)
    .where(eq(orgAutopayEnrollments.orgId, invoice.orgId)).limit(1);
  if (!enrollment) return null;
  if (existing && (collectionFenced({schedule:existing,invoice,enrollment})
    || existing.enrollmentId !== enrollment.id || existing.enrollmentGeneration !== enrollment.generation)) {
    await tx.update(invoiceAutopaySchedules).set({state:'not_needed',stateReason:'authority_changed',nextAttemptAt:null})
      .where(eq(invoiceAutopaySchedules.id,existing.id));
    return existing;
  }
  if (existing) {
    const [reserving]=await tx.select().from(invoiceCollectionAttempts).where(and(eq(invoiceCollectionAttempts.invoiceId,invoiceId),
      inArray(invoiceCollectionAttempts.state,['reserved','created','confirming','processing','requires_action']))).limit(1);
    if(reserving)return existing;
  }
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
  let reason = eligibilityReason({ active: enrollment.status === 'active' && !org.deletedAt && ['active','trial'].includes(org.status),
    effective: !!enrollment.effectiveFrom && enrollment.effectiveFrom <= (previous ? new Date(previous.issuedAt) : invoice.updatedAt),
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
  const lawfulFee = method ? quoteProcessingFee({ methodType: method.type, cardFunding: method.cardFunding,
    principal: invoice.balance, currency: invoice.currencyCode, stripeAccountCountry: readiness.accountCountry,
    orgBillingCountry: org.billingAddressCountry, orgBillingRegion: org.billingAddressRegion,
    cardFeeBps: settings.cardFeeBps.value, achFeeAmount: settings.achFeeAmount.value,
    feeAttested: settings.feeAttested }) : null;
  const fee = method && lawfulFee ? await acceptedCollectionFee(tx, {
    orgId:invoice.orgId,partnerId:invoice.partnerId,enrollmentId:enrollment.id,generation:enrollment.generation,
    methodId:method.id,methodType:method.type,principal:invoice.balance,currency:invoice.currencyCode,quote:lawfulFee,
  }) : null;
  if (!reason && !fee) reason = 'consent_required';
  const snapshot = method ? {
    issuedAt: previous?.issuedAt ?? invoice.updatedAt.toISOString(), offsetDays: settings.autopayOffsetDays.value,
    rule: settings.autopayOffsetRule.value, cap, methodType: method.type, methodId: method.id,
    last4: method.type === 'card' ? method.cardLast4 ?? '' : method.bankLast4 ?? '',
    methodLabel: method.type === 'card'
      ? `${method.cardBrand ?? 'Card'} ••${method.cardLast4 ?? ''}`
      : `${method.bankName ?? 'Bank'} ••${method.bankLast4 ?? ''}`,
    accountHolderType: method.accountHolderType, noticeLeadDays: leadDays,
    principal: invoice.balance, currency: invoice.currencyCode, feeAmount: fee?.feeAmount ?? '0.00',
    feeKind: fee?.kind ?? 'none', cardFeeBps: settings.cardFeeBps.value,
    achFeeAmount: settings.achFeeAmount.value, chargeDate: collectOn, noticeSeq: (previous?.noticeSeq ?? 0) + 1,
  } satisfies AutopayTerms : { issuedAt: previous?.issuedAt ?? invoice.updatedAt.toISOString(), noticeSeq: 0 };
  const values = { orgId: invoice.orgId, invoiceId, enrollmentId: enrollment.id, enrollmentGeneration: enrollment.generation,
    eligible: reason === null, ineligibleReason: reason, collectOn, termsSnapshot: autopayTermsSnapshotSchema.parse(snapshot),
    state: reason === null ? 'awaiting_notice' as const : 'not_needed' as const, stateReason: reason,
    noticeOutboxId: null, noticeSentAt: null, nextAttemptAt: null };
  if (existing?.noticeOutboxId) await tx.update(billingNoticeOutbox).set({status:'cancelled'}).where(and(
    eq(billingNoticeOutbox.id,existing.noticeOutboxId),inArray(billingNoticeOutbox.status,['pending','failed'])));
  const [created] = existing ? await tx.update(invoiceAutopaySchedules).set(values).where(eq(invoiceAutopaySchedules.id,existing.id)).returning()
    : await tx.insert(invoiceAutopaySchedules).values({...values,attemptCount:0}).returning();
  if (!created) throw new Error('Autopay schedule insert failed');
  if (created.eligible) await enqueueAutopayNotice(tx, created.id);
  const [planned] = await tx.select().from(invoiceAutopaySchedules)
    .where(eq(invoiceAutopaySchedules.id, created.id)).limit(1);
  return planned!;
}

/** Close schedules for all settlement/void paths, including external accounting writers. */
export async function closeSettledAutopaySchedules(): Promise<void> {
  await withSystemDbAccessContext(() => db.execute(sql`
    UPDATE invoice_autopay_schedules s SET state='not_needed', next_attempt_at=NULL,
      state_reason=CASE WHEN i.status='void' THEN 'invoice_voided' ELSE 'invoice_settled' END
    FROM invoices i WHERE i.id=s.invoice_id AND i.org_id=s.org_id
      AND i.status IN ('paid','void')
      AND s.state IN ('awaiting_notice','scheduled','collecting','retry_scheduled','action_required')
  `), 'autopay.closeSettled');
}

/** Recover canceled/stale/missing notices without enrolling historical invoices. */
export async function sweepOrphanAutopayNotices(): Promise<void> {
  await closeSettledAutopaySchedules();
  let cursor: string | undefined;
  for (;;) {
    const rows=await withSystemDbAccessContext(()=>db.select({id:invoiceAutopaySchedules.id,invoiceId:invoiceAutopaySchedules.invoiceId})
      .from(invoiceAutopaySchedules).where(and(eq(invoiceAutopaySchedules.state,'awaiting_notice'),
        cursor?gt(invoiceAutopaySchedules.id,cursor):undefined,
        sql`NOT EXISTS (SELECT 1 FROM billing_notice_outbox n WHERE n.id=${invoiceAutopaySchedules.noticeOutboxId}
          AND n.status IN ('pending','sending'))`)).orderBy(asc(invoiceAutopaySchedules.id)).limit(200));
    if(!rows.length)return;
    for(const row of rows) await withSystemDbAccessContext(async()=>{
      await db.select({id:invoices.id}).from(invoices).where(eq(invoices.id,row.invoiceId)).for('update');
      const [current]=await db.select().from(invoiceAutopaySchedules).where(eq(invoiceAutopaySchedules.id,row.id)).limit(1);
      if(!current || current.state!=='awaiting_notice')return;
      const [live]=current.noticeOutboxId?await db.select().from(billingNoticeOutbox).where(and(eq(billingNoticeOutbox.id,current.noticeOutboxId),inArray(billingNoticeOutbox.status,['pending','sending']))).limit(1):[];
      if(!live)await planAutopayForInvoice(db,row.invoiceId,true);
    },'autopay.renoticeOrphan');
    cursor=rows[rows.length-1]!.id;
  }
}
