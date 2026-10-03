import type {PaymentSettingsView,ResolvedPaymentSettings} from '@breeze/shared';
import { and, eq, isNull } from 'drizzle-orm';
import { billingPaymentSettings } from '../../db/schema';
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
        remindersEnabled: { value: false, source: 'default' },
        reminderBeforeDueDays: { value: 3, source: 'default' },
        reminderRepeatDays: { value: null, source: 'default' },
        overdueReminderEveryDays: { value: 7, source: 'default' }, };
  return {
    autopayEnabled: await isAutopayEnabledForPartner(connection, partnerId), effective, inherited,
    values: {
      autopayOffsetDays: row?.autopayOffsetDays ?? null,
      autopayOffsetRule: row?.autopayOffsetRule ?? null,
      autopayCapEnabled: row?.autopayCapEnabled ?? null,
      autopayCapAmount: row?.autopayCapAmount ?? null,
      autopayCapCurrency: row?.autopayCapCurrency ?? null,
      achMode: row?.achMode ?? null,
    },
  };
}
