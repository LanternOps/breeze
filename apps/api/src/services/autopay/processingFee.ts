import type { AutopayPaymentMethodType, CardFundingType } from '@breeze/shared';
import { toMinorUnits, fromMinorUnits } from '../stripeMoney';

export interface FeeQuoteInput {
  methodType: AutopayPaymentMethodType; cardFunding: CardFundingType | null;
  principal: string; currency: string; stripeAccountCountry: string | null;
  orgBillingCountry: string | null; orgBillingRegion: string | null;
  cardFeeBps: number; achFeeAmount: string; feeAttested: boolean;
}
export interface FeeQuote {
  feeAmount: string; kind: 'none' | 'card_percent' | 'ach_flat'; appliedBps: number | null;
  reason: 'disabled' | 'not_attested' | 'debit_or_prepaid' | 'unknown_funding' | 'non_us' | 'state_banned' | 'state_capped' | 'applied';
}

// Approved conservative product policy, 2026-10-01, autopay design §10.2.
// Changes require updated table tests and review before fee settings are opened.
export const SURCHARGE_STATE_RULES: Record<string, { banned: true } | { maxBps: number }> = {
  CA: { banned: true }, CT: { banned: true }, ME: { banned: true }, MA: { banned: true }, CO: { maxBps: 200 },
};
const US_REGIONS = new Set('AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY'.split(' '));
const upper = (v: string | null) => v?.trim().toUpperCase() ?? '';
function minor(value: string): bigint {
  if (!/^\d{1,10}(?:\.\d{1,2})?$/.test(value)) throw new Error('Invalid money value');
  const cents = toMinorUnits(value, 'USD');
  if (!Number.isSafeInteger(cents) || cents > 999999999999) throw new Error('Invalid money range');
  return BigInt(cents);
}
/** The card fee (bps) the engine below applies to a credit card for a client, given the configured
 * fee: 0 outside the US or without a US state, the state's ban or cap, never above 300. Settings
 * comparisons use it so they agree with what collection would charge (F-7, G4). */
export function allowedCardFeeBps(configured: number, orgBillingCountry: string | null | undefined, orgBillingRegion: string | null | undefined): number {
  const state = upper(orgBillingRegion ?? null);
  if (upper(orgBillingCountry ?? null) !== 'US' || !US_REGIONS.has(state)) return 0;
  const rule = SURCHARGE_STATE_RULES[state];
  if (rule && 'banned' in rule) return 0;
  return Math.min(configured, 300, rule && 'maxBps' in rule ? rule.maxBps : 300);
}
export function quoteProcessingFee(input: FeeQuoteInput): FeeQuote {
  const principal = minor(input.principal);
  const flat = minor(input.achFeeAmount);
  if (!Number.isSafeInteger(input.cardFeeBps) || input.cardFeeBps < 0) throw new Error('Invalid fee bps');
  const none = (reason: FeeQuote['reason']): FeeQuote => ({ feeAmount: '0.00', kind: 'none', appliedBps: null, reason });
  if (principal === 0n) return none('disabled');
  const country = upper(input.stripeAccountCountry);
  const currency = upper(input.currency);
  if (input.methodType === 'us_bank_account') {
    if (flat === 0n) return none('disabled');
    if (country !== 'US' || currency !== 'USD') return none('non_us');
    const capped = flat > 2500n ? 2500n : flat;
    return { feeAmount: fromMinorUnits(Number(capped), 'USD'), kind: 'ach_flat', appliedBps: null, reason: 'applied' };
  }
  if (input.cardFeeBps === 0) return none('disabled');
  if (!input.feeAttested) return none('not_attested');
  if (input.cardFunding === 'debit' || input.cardFunding === 'prepaid') return none('debit_or_prepaid');
  if (input.cardFunding !== 'credit') return none('unknown_funding');
  const state = upper(input.orgBillingRegion);
  if (country !== 'US' || currency !== 'USD' || upper(input.orgBillingCountry) !== 'US' || !US_REGIONS.has(state)) return none('non_us');
  const rule = SURCHARGE_STATE_RULES[state];
  if (rule && 'banned' in rule) return none('state_banned');
  const stateCap = rule && 'maxBps' in rule ? rule.maxBps : 300;
  const bps = Math.min(input.cardFeeBps, 300, stateCap);
  const fee = (principal * BigInt(bps) + 5000n) / 10000n;
  return { feeAmount: fromMinorUnits(Number(fee), 'USD'), kind: 'card_percent', appliedBps: bps,
    reason: stateCap < Math.min(input.cardFeeBps, 300) ? 'state_capped' : 'applied' };
}
