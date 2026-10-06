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

/** F-8: an invoice frozen at issue as above the authorized cap stays manual (it was issued
 * before the client's updated authorization, and the re-authorization says received invoices
 * aren't included), but once the latest accepted authorization covers its amount, saying it
 * is "over the limit you authorized" is no longer true. */
export async function coveredByAcceptedCap(tx: Tx, key: AutopayConsentKey, total: string, currency: string): Promise<boolean> {
  const cap = await acceptedAutopayCap(tx, key);
  if (!cap) return false;
  if (!cap.enabled) return true;
  return cap.currency.toUpperCase() === currency.toUpperCase() && toMinorUnits(total, currency) <= toMinorUnits(cap.amount, currency);
}
