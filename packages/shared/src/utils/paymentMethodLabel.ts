/** Client-facing payment method labels. One formatter for the API (notices,
 * receipts, terms snapshots) and the web/portal, so no surface prints a raw
 * Stripe code ("visa", "link", "credit"). */

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
