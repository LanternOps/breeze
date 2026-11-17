import { isBillingEnabledForPartner } from '../billingEnabled';
import { isAutopayEnabledForPartner } from './autopayGate';
import type { Tx } from './types';

/**
 * Whether the platform may START or COMPLETE a charge on the partner's behalf:
 * automatic payments enabled AND the partner's billing master switch on
 * (BRZ-8807). Billing off must not move new money, but only the charging paths
 * use this: setup, status views and the client's own on-session payment keep
 * `isAutopayEnabledForPartner`, and collectionEngine defers the schedule
 * (`charging_disabled`) so the client is told through the normal not-charged notice.
 */
export async function isAutopayChargingAllowed(db: Tx, partnerId: string): Promise<boolean> {
  return await isAutopayEnabledForPartner(db, partnerId) && await isBillingEnabledForPartner(partnerId);
}
