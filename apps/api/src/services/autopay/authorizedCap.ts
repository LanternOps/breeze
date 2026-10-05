import { autopayScheduleTermsSchema, type AutopayScheduleTerms } from '@breeze/shared';
import { toMinorUnits } from '../stripeMoney';
import { latestAutopayConsent, type AutopayConsentKey } from './collectionFee';
import type { Tx } from './types';

type Cap = AutopayScheduleTerms['cap'];
export type AutopayCapReason = 'cap_currency_mismatch' | 'over_cap' | 'above_authorized_cap';

/** The cap in the latest consent accepted for this exact authority (the consent
 * text said "Only invoices up to X qualify"). Null when there is no consent or its
 * schedule terms cannot be read: callers fail closed with consent_required. */
export async function acceptedAutopayCap(tx: Tx, key: AutopayConsentKey): Promise<Cap | null> {
  const consent = await latestAutopayConsent(tx, key);
  const terms = autopayScheduleTermsSchema.safeParse(consent?.scheduleTerms);
  return terms.success ? terms.data.cap : null;
}

/** Mirrors the approved fee rule, "never more than the client was told": the
 * effective cap is the lower of the current setting and the accepted consent, and a
 * disabled cap is no limit on that side. Raising or removing the MSP cap therefore
 * never widens an existing authorization, while lowering it applies at once.
 * Returns the staff-visible reason an invoice total is ineligible, or null. */
export function autopayCapReason(input: { current: Cap; accepted: Cap; total: string; currency: string }): AutopayCapReason | null {
  const sides: Array<[Cap, AutopayCapReason]> = [[input.current, 'over_cap'], [input.accepted, 'above_authorized_cap']];
  for (const [cap, over] of sides) {
    if (!cap.enabled) continue;
    if (cap.currency.toUpperCase() !== input.currency.toUpperCase()) return 'cap_currency_mismatch';
    if (toMinorUnits(input.total, input.currency) > toMinorUnits(cap.amount, input.currency)) return over;
  }
  return null;
}
