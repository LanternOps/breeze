import type Stripe from 'stripe';
import { eq } from 'drizzle-orm';
import { runOutsideDbContext } from '../../db';
import { stripeConnectAccounts } from '../../db/schema/stripePayments';
import type { Tx } from './types';

export type AutopayStripeCapability = 'customers_write' | 'setup_intents_write' | 'payment_intents_write' | 'payment_methods_write' | 'mandates_read';
const COUNTRIES = new Set(['US', 'CA', 'GB', 'AU', 'NZ', 'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IS', 'IE', 'IT', 'LV', 'LI', 'LT', 'LU', 'MT', 'NL', 'NO', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE']);

export async function probeAutopayCapabilities(stripe: Stripe): Promise<{ missing: AutopayStripeCapability[] }> {
  const probes: Array<[AutopayStripeCapability, () => Promise<unknown>]> = [
    ['customers_write', () => stripe.customers.update('cus_breeze_autopay_permission_probe', { metadata: {} })],
    ['setup_intents_write', () => stripe.setupIntents.update('seti_breeze_autopay_permission_probe', { metadata: {} })],
    ['payment_intents_write', () => stripe.paymentIntents.update('pi_breeze_autopay_permission_probe', { metadata: {} })],
    ['payment_methods_write', () => stripe.paymentMethods.update('pm_breeze_autopay_permission_probe', { metadata: {} })],
    ['mandates_read', () => stripe.mandates.retrieve('mandate_breeze_autopay_permission_probe')],
  ];
  const missing: AutopayStripeCapability[] = [];
  for (const [capability, probe] of probes) {
    try { await runOutsideDbContext(probe); }
    catch (error) {
      const failure = error as { type?: string; code?: string };
      if (failure.type === 'StripePermissionError') { missing.push(capability); continue; }
      if (failure.type === 'StripeInvalidRequestError' && failure.code === 'resource_missing') continue;
      throw error;
    }
  }
  return { missing };
}

export async function getAutopayStripeReadiness(db: Tx, partnerId: string): Promise<{ ready: boolean; missing: AutopayStripeCapability[]; stripeAccountId: string | null; accountCountry: string | null }> {
  const [row] = await db.select({ status: stripeConnectAccounts.status, stripeAccountId: stripeConnectAccounts.stripeAccountId, accountCountry: stripeConnectAccounts.accountCountry, autopayCapabilitiesCheckedAt: stripeConnectAccounts.autopayCapabilitiesCheckedAt, autopayMissingPermissions: stripeConnectAccounts.autopayMissingPermissions })
    .from(stripeConnectAccounts).where(eq(stripeConnectAccounts.partnerId, partnerId)).limit(1);
  if (!row || row.status !== 'connected') return { ready: false, missing: [], stripeAccountId: null, accountCountry: null };
  const all: AutopayStripeCapability[] = ['customers_write', 'setup_intents_write', 'payment_intents_write', 'payment_methods_write', 'mandates_read'];
  const known = new Set<string>(all);
  const raw = row.autopayMissingPermissions;
  const missing = raw.filter((value): value is AutopayStripeCapability => known.has(value));
  return { ready: row.autopayCapabilitiesCheckedAt !== null && raw.length === 0 && COUNTRIES.has(row.accountCountry ?? ''), missing, stripeAccountId: row.stripeAccountId, accountCountry: row.accountCountry };
}
