/** Client-facing payment method labels, fee percents and dates. One formatter for
 * the API (notices, receipts, terms snapshots) and the web/portal, so no surface
 * prints a raw Stripe code ("visa", "link", "credit"), a basis-point figure or an
 * ISO date. */

// Stripe card.brand values. Brand names are proper nouns, so they are not translated.
const CARD_BRANDS: Record<string, string> = {
  amex: 'American Express', cartes_bancaires: 'Cartes Bancaires', diners: 'Diners Club', discover: 'Discover',
  eftpos_au: 'eftpos Australia', interac: 'Interac', jcb: 'JCB', link: 'Link', mastercard: 'Mastercard',
  unionpay: 'UnionPay', visa: 'Visa',
};
const SHOWN_FUNDING = new Set(['credit', 'debit', 'prepaid']);

/** Display name for a Stripe card brand code; a generic "Card" when Stripe does not know it. */
export function cardBrandLabel(brand: string | null | undefined): string {
  const code = brand?.trim().toLowerCase() ?? '';
  if (!code || code === 'unknown') return 'Card';
  // A brand Stripe adds later reads as words, never as its code.
  return CARD_BRANDS[code] ?? code.split(/[_\s]+/).filter(Boolean)
    .map(word => word[0]!.toUpperCase() + word.slice(1)).join(' ');
}

export interface PaymentMethodLabelInput {
  type: string;
  cardBrand?: string | null;
  cardFunding?: string | null;
  cardLast4?: string | null;
  /** Accepted (method rows carry it) but never printed in the label: Stripe's bank names are codes in capitals. */
  bankName?: string | null;
  bankLast4?: string | null;
}

/**
 * long:  "Visa credit card ending in 4242" | "Card ending in 4242" | "Bank account ending in 6789"
 * short: "Visa ending in 4242" | "Bank account ending in 6789"
 * Funding is shown only when Stripe reports credit, debit or prepaid.
 */
export function formatPaymentMethod(method: PaymentMethodLabelInput, style: 'long' | 'short' = 'long'): string {
  const ending = (last4: string | null | undefined) => last4?.trim() ? ` ending in ${last4.trim()}` : '';
  if (method.type === 'us_bank_account') return `Bank account${ending(method.bankLast4)}`;
  if (method.type !== 'card') return 'Payment method';
  const code = method.cardBrand?.trim().toLowerCase() ?? '';
  const brand = cardBrandLabel(code);
  // Link is a wallet, not a card network.
  if (code === 'link') return `Link${ending(method.cardLast4)}`;
  const funding = method.cardFunding?.trim().toLowerCase() ?? '';
  const known = brand !== 'Card';
  if (style === 'short') return `${brand}${ending(method.cardLast4)}`;
  if (!SHOWN_FUNDING.has(funding)) return `${known ? `${brand} card` : 'Card'}${ending(method.cardLast4)}`;
  return `${known ? `${brand} ${funding}` : funding[0]!.toUpperCase() + funding.slice(1)} card${ending(method.cardLast4)}`;
}

const GENERIC_LABEL = /^(Bank account|Card|Credit card|Debit card|Prepaid card|Payment method|Online payment)\b/;
/** A label placed mid-sentence ("charge your bank account ending in 6789"):
 * generic words are lowercased, brand names keep their capital. */
export function paymentMethodInSentence(label: string): string {
  return GENERIC_LABEL.test(label) ? label[0]!.toLowerCase() + label.slice(1) : label;
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
export function formatCalendarDate(value: string | Date | null | undefined, locale = 'en-US', timeZone?: string): string {
  if (!value) return '';
  const raw = value instanceof Date ? value.toISOString() : value;
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(raw);
  const date = new Date(dateOnly ? `${raw}T00:00:00Z` : raw);
  if (Number.isNaN(date.getTime())) return raw;
  const options: Intl.DateTimeFormatOptions = { month: 'long', day: 'numeric', year: 'numeric', timeZone: dateOnly ? 'UTC' : timeZone };
  try { return new Intl.DateTimeFormat(locale, options).format(date); }
  catch { return new Intl.DateTimeFormat('en-US', options).format(date); }
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
