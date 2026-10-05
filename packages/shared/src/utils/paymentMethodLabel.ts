/**
 * Customer-facing words for saved payment methods, fees and dates. One source
 * for the API (emails, frozen notice labels) and the portal, so a client never
 * sees a raw Stripe slug ("visa credit"), a funding code ("unknown"), a basis-
 * point figure or an ISO date (autopay lab D-11).
 */

export interface PaymentMethodLabelSource {
  type: string;
  cardBrand?: string | null;
  cardFunding?: string | null;
  cardLast4?: string | null;
  bankName?: string | null;
  bankLast4?: string | null;
}

const CARD_BRANDS: Record<string, string> = {
  visa: 'Visa', mastercard: 'Mastercard', amex: 'American Express', american_express: 'American Express',
  discover: 'Discover', diners: 'Diners Club', jcb: 'JCB', unionpay: 'UnionPay',
  cartes_bancaires: 'Cartes Bancaires', eftpos_au: 'eftpos', interac: 'Interac', link: 'Link',
};
const SHOWN_FUNDING = new Set(['credit', 'debit', 'prepaid']);

/**
 * long:  "Visa credit card ending in 4242" · "Bank account ending in 6789"
 * short: "Visa ending in 4242" · "Bank account ending in 6789"
 */
export function formatPaymentMethod(method: PaymentMethodLabelSource, style: 'long' | 'short' = 'long'): string {
  if (method.type === 'us_bank_account') {
    return method.bankLast4 ? `Bank account ending in ${method.bankLast4}` : 'Bank account';
  }
  const brand = method.cardBrand ? CARD_BRANDS[method.cardBrand.toLowerCase()] : undefined;
  const ending = method.cardLast4 ? ` ending in ${method.cardLast4}` : '';
  if (brand === 'Link') return `Link${ending}`;
  const funding = method.cardFunding && SHOWN_FUNDING.has(method.cardFunding) ? method.cardFunding : null;
  if (style === 'short') return `${brand ?? 'Card'}${ending}`;
  if (brand) return `${brand} ${funding ? `${funding} ` : ''}card${ending}`;
  if (funding && ending) return `${funding[0]!.toUpperCase()}${funding.slice(1)} card${ending}`;
  return `Card${ending}`;
}

/** 300 → "3%", 250 → "2.5%", 299 → "2.99%". */
export function formatPercentBps(bps: number): string {
  const whole = Math.trunc(bps / 100);
  const fraction = String(Math.abs(bps % 100)).padStart(2, '0').replace(/0+$/, '');
  return `${whole}${fraction ? `.${fraction}` : ''}%`;
}

/**
 * "November 4, 2026". A date-only value (YYYY-MM-DD) is a calendar day and is
 * rendered as that day in every timezone; a timestamp is rendered in `timeZone`
 * (the viewer's zone when omitted). Unparseable input is returned unchanged.
 */
export function formatCalendarDate(value: string | null | undefined, locale = 'en-US', timeZone?: string): string {
  if (!value) return '';
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value);
  const date = new Date(dateOnly ? `${value}T00:00:00Z` : value);
  if (Number.isNaN(date.getTime())) return value;
  try {
    return new Intl.DateTimeFormat(locale, { month: 'long', day: 'numeric', year: 'numeric',
      timeZone: dateOnly ? 'UTC' : timeZone }).format(date);
  } catch {
    return new Intl.DateTimeFormat('en-US', { month: 'long', day: 'numeric', year: 'numeric',
      timeZone: dateOnly ? 'UTC' : timeZone }).format(date);
  }
}

/** Card expiry: (12, 2031) → "December 2031". */
export function formatMonthYear(month: number | null | undefined, year: number | null | undefined, locale = 'en-US'): string {
  if (!month || !year || month < 1 || month > 12) return '';
  return new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric', timeZone: 'UTC' })
    .format(new Date(Date.UTC(year, month - 1, 1)));
}

/** When an automatic payment is charged, as a short phrase for summaries. */
export function autopayScheduleSummary(terms: { offsetDays: number; rule: 'earlier' | 'later' }): string {
  const days = `${terms.offsetDays} ${terms.offsetDays === 1 ? 'day' : 'days'}`;
  if (terms.offsetDays === 0) return terms.rule === 'later' ? "On each invoice's due date" : 'On the day each invoice is issued';
  return terms.rule === 'later'
    ? `On the due date, or ${days} after the invoice is issued if that's later`
    : `${days} after the invoice is issued, or on the due date if that's sooner`;
}
