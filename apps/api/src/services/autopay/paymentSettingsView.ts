import {autopayFeeTermsSchema,autopayScheduleTermsSchema,type FeeAuthorizationGap,type PaymentSettingsView,type ResolvedPaymentSettings} from '@breeze/shared';
import { toMinorUnits } from '../stripeMoney';
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
 * Lists clients whose authorization is below the configured fee, and clients with no
 * authorization on file for that method (authorized fields null) whatever the fee.
 * This is a settings comparison, not permission to charge; collection applies eligibility too. */
export async function feeAuthorizationGaps(connection: typeof db, partnerId: string, orgId?: string): Promise<FeeAuthorizationGap[]> {
  const settings = await resolveBillingPaymentSettings(connection, { partnerId });
  const rows = await connection.selectDistinctOn([organizations.id], {
    orgId: organizations.id, orgName: organizations.name, methodType: orgPaymentMethods.type,
    feeTerms: orgAutopayConsents.feeTerms, scheduleTerms: orgAutopayConsents.scheduleTerms, cardFeeBps: billingPaymentSettings.cardFeeBps,
    achFeeAmount: billingPaymentSettings.achFeeAmount, capEnabled: billingPaymentSettings.autopayCapEnabled,
    capAmount: billingPaymentSettings.autopayCapAmount, capCurrency: billingPaymentSettings.autopayCapCurrency,
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
    // No authorization at all is listed whatever the configured fee: collection refuses it (consent_required).
    const lower = !onFile || (row.methodType === 'card' ? authorizedCardFeeBps! < cardFeeBps
      : BigInt(authorizedAchFeeAmount!.replace('.', '')) < BigInt(achFeeAmount.replace('.', '')));
    const capGap = onFile ? narrowerAcceptedCap(row.scheduleTerms, row.capEnabled == null ? settings.autopayCap.value
      : row.capEnabled && row.capAmount && row.capCurrency ? { enabled: true, amount: row.capAmount, currency: row.capCurrency } : { enabled: false }) : null;
    return lower || capGap ? [{ orgId: row.orgId, orgName: row.orgName, methodType: row.methodType,
      authorizedCardFeeBps, authorizedAchFeeAmount, cardFeeBps, achFeeAmount, ...(capGap ? { capGap } : {}) }] : [];
  });
}

type Cap = NonNullable<FeeAuthorizationGap['capGap']>['configured'];
/** The accepted cap is narrower than the configured one when the MSP raised it, removed it or
 * changed its currency: the effective cap stays the accepted one until the client re-accepts (2a-1). */
function narrowerAcceptedCap(scheduleTerms: unknown, configured: Cap): FeeAuthorizationGap['capGap'] {
  const accepted = autopayScheduleTermsSchema.safeParse(scheduleTerms);
  if (!accepted.success || !accepted.data.cap.enabled) return null;
  const cap = accepted.data.cap;
  const wider = !configured.enabled || configured.currency.toUpperCase() !== cap.currency.toUpperCase()
    || toMinorUnits(configured.amount, cap.currency) > toMinorUnits(cap.amount, cap.currency);
  return wider ? { authorized: cap, configured } : null;
}
