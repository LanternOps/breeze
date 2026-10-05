import {autopayFeeTermsSchema,type FeeAuthorizationGap,type PaymentSettingsView,type ResolvedPaymentSettings} from '@breeze/shared';
import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import { billingPaymentSettings, organizations, orgAutopayEnrollments, orgAutopayConsents, orgPaymentMethods, users } from '../../db/schema';
import { BILLING_PAYMENT_SETTINGS_DEFAULTS as defaults, resolveBillingPaymentSettings } from './billingPaymentSettings';
import { isAutopayEnabledForPartner } from './autopayGate';
import type { db } from '../../db';

export async function paymentSettingsView(connection: typeof db, partnerId: string, orgId?: string):Promise<PaymentSettingsView> {
  const [row] = await connection.select().from(billingPaymentSettings).where(orgId
    ? eq(billingPaymentSettings.orgId, orgId)
    : and(eq(billingPaymentSettings.partnerId, partnerId), isNull(billingPaymentSettings.orgId))).limit(1);
  const effective = await resolveBillingPaymentSettings(connection, { partnerId, orgId });
  const inherited:ResolvedPaymentSettings = orgId
    ? await resolveBillingPaymentSettings(connection, { partnerId })
    : { autopayOffsetDays: { value: defaults.autopayOffsetDays, source: 'default' }, autopayOffsetRule: { value: defaults.autopayOffsetRule, source: 'default' },
        autopayCap: { value: defaults.autopayCap, source: 'default' }, achMode: { value: defaults.achMode, source: 'default' },
        cardFeeBps: { value: 0, source: 'default' }, achFeeAmount: { value: '0.00', source: 'default' },
        remindersEnabled: { value: false, source: 'default' },
        reminderBeforeDueDays: { value: 3, source: 'default' },
        reminderRepeatDays: { value: null, source: 'default' },
        overdueReminderEveryDays: { value: 7, source: 'default' }, };
  const autopayEnabled = await isAutopayEnabledForPartner(connection, partnerId);
  return {
    autopayEnabled, effective, inherited,
    // The attestation is partner-only (CHECK), so only the partner view reports it.
    ...(orgId ? {} : { feeAttestation: row?.feeAttestedAt ? {
      attestedAt: row.feeAttestedAt.toISOString(),
      attestedByName: row.feeAttestedBy ? await attesterName(connection, row.feeAttestedBy) : null,
    } : null }),
    ...(autopayEnabled ? { feeAuthorizationGaps: await feeAuthorizationGaps(connection, partnerId, orgId) } : {}),
    values: {
      autopayOffsetDays: row?.autopayOffsetDays ?? null,
      autopayOffsetRule: row?.autopayOffsetRule ?? null,
      autopayCapEnabled: row?.autopayCapEnabled ?? null,
      autopayCapAmount: row?.autopayCapAmount ?? null,
      autopayCapCurrency: row?.autopayCapCurrency ?? null,
      achMode: row?.achMode ?? null,
      cardFeeBps: row?.cardFeeBps ?? null,
      achFeeAmount: row?.achFeeAmount ?? null,
    },
  };
}

/** Null when the user is no longer readable; the attestation itself stays on file. */
async function attesterName(connection: typeof db, userId: string): Promise<string | null> {
  const [user] = await connection.select({ name: users.name }).from(users).where(eq(users.id, userId)).limit(1);
  return user?.name ?? null;
}

/** Compare the latest consent for the current enrollment generation and payment method.
 * This is a settings comparison, not permission to charge; collection applies eligibility too. */
export async function feeAuthorizationGaps(connection: typeof db, partnerId: string, orgId?: string): Promise<FeeAuthorizationGap[]> {
  const settings = await resolveBillingPaymentSettings(connection, { partnerId });
  const rows = await connection.selectDistinctOn([organizations.id], {
    orgId: organizations.id, orgName: organizations.name, methodType: orgPaymentMethods.type,
    feeTerms: orgAutopayConsents.feeTerms, cardFeeBps: billingPaymentSettings.cardFeeBps,
    achFeeAmount: billingPaymentSettings.achFeeAmount,
  }).from(organizations)
    .innerJoin(orgAutopayEnrollments, and(eq(orgAutopayEnrollments.orgId, organizations.id),
      eq(orgAutopayEnrollments.partnerId, organizations.partnerId)))
    .innerJoin(orgPaymentMethods, and(eq(orgPaymentMethods.orgId, organizations.id),
      eq(orgPaymentMethods.enrollmentId, orgAutopayEnrollments.id), eq(orgPaymentMethods.isAutopayMethod, true),
      inArray(orgPaymentMethods.status, ['active', 'pending_verification'])))
    .leftJoin(orgAutopayConsents, and(eq(orgAutopayConsents.orgId, organizations.id),
      eq(orgAutopayConsents.enrollmentId, orgAutopayEnrollments.id),
      eq(orgAutopayConsents.generation, orgAutopayEnrollments.generation),
      eq(orgAutopayConsents.paymentMethodId, orgPaymentMethods.id)))
    .leftJoin(billingPaymentSettings, eq(billingPaymentSettings.orgId, organizations.id))
    .where(and(eq(organizations.partnerId, partnerId), eq(organizations.type, 'customer'),
      isNull(organizations.deletedAt), inArray(organizations.status, ['active', 'trial']),
      inArray(orgAutopayEnrollments.status, ['active', 'paused']), orgId ? eq(organizations.id, orgId) : undefined))
    .orderBy(organizations.id, desc(orgAutopayConsents.createdAt), desc(orgAutopayConsents.id));
  return rows.flatMap(row => {
    // fee_terms is NOT NULL, so null here means the left join found no consent.
    const terms = row.feeTerms == null ? null : autopayFeeTermsSchema.safeParse(row.feeTerms);
    // No consent, or one given for another method type, authorizes nothing (collection
    // refuses it): report null, never a zero that reads like a real 0-fee consent.
    // Unreadable terms stay a zero fee, which is what collection charges under them.
    const onFile = terms !== null && (!terms.success || terms.data.methodType === row.methodType);
    const accepted = terms?.success && terms.data.methodType === row.methodType ? terms.data : null;
    const authorizedCardFeeBps = onFile ? accepted?.cardFeeBps ?? 0 : null;
    const authorizedAchFeeAmount = !onFile ? null : accepted && /^(0|[1-9]\d?)\.\d{2}$/.test(accepted.achFeeAmount)
      ? accepted.achFeeAmount : '0.00';
    const cardFeeBps = row.cardFeeBps ?? settings.cardFeeBps.value;
    const achFeeAmount = row.achFeeAmount ?? settings.achFeeAmount.value;
    const lower = row.methodType === 'card' ? (authorizedCardFeeBps ?? 0) < cardFeeBps
      : BigInt((authorizedAchFeeAmount ?? '0.00').replace('.', '')) < BigInt(achFeeAmount.replace('.', ''));
    return lower ? [{ orgId: row.orgId, orgName: row.orgName, methodType: row.methodType,
      authorizedCardFeeBps, authorizedAchFeeAmount, cardFeeBps, achFeeAmount }] : [];
  });
}
