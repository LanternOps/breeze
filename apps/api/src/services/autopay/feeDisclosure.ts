import type Stripe from 'stripe';
import type { FeeQuote } from './processingFee';
import { fromMinorUnits, toMinorUnits } from '../stripeMoney';
export function displayMoney(amount: string, currency: string): string {
  return currency === 'USD' ? `$${amount}` : `${currency} ${amount}`;
}
export function prospectiveFeeText(quote: FeeQuote, currency: string): string {
  if (quote.kind === 'none') return 'No processing fee applies.';
  if (quote.kind === 'ach_flat') return `Each bank payment includes a ${displayMoney(quote.feeAmount,currency)} processing fee. Saving this method does not itself charge a fee.`;
  const bps = quote.appliedBps!;
  const percent = `${Math.trunc(bps / 100)}.${String(bps % 100).padStart(2,'0')}`;
  return `Credit card: up to ${percent}% per automatic payment. Debit, prepaid and unknown-funding cards have no fee. Saving this method does not itself charge a fee.`;
}
// Match the real card networks admitted by collectionEngine; stored funding and
// brand alone cannot distinguish Link (which can be bank-funded) from a card.
const CARD_NETWORKS = new Set(['visa', 'mastercard', 'amex', 'discover', 'diners', 'jcb', 'unionpay', 'cartes_bancaires']);
const CARD_WALLETS = new Set(['apple_pay', 'google_pay', 'samsung_pay', 'amex_express_checkout', 'masterpass', 'visa_checkout']);
/** Every Checkout that saves a method for autopay hides Link: a Link wallet card
 * fails hasSupportedCardEvidence, so collection could never charge it (#7894). */
export const AUTOPAY_CHECKOUT_WALLET_OPTIONS: Stripe.Checkout.SessionCreateParams.WalletOptions = { link: { display: 'never' } };
/** Shared live evidence gate for disclosure and collection admission. */
export function hasSupportedCardEvidence(card?: Stripe.PaymentMethod.Card): boolean {
  return !!card && (card.wallet === null || !!card.wallet && CARD_WALLETS.has(card.wallet.type))
    && CARD_NETWORKS.has(card.brand) && !!card.networks?.available.length
    && card.networks.available.every(network => CARD_NETWORKS.has(network))
    && (!card.networks.preferred || CARD_NETWORKS.has(card.networks.preferred));
}
export function verifiedFeeText(type: string, funding: string | null, acceptedText: string,
  card?: Stripe.PaymentMethod.Card): string {
  if (type !== 'card') return acceptedText;
  const verified = funding === 'credit' && card?.funding === 'credit' && hasSupportedCardEvidence(card);
  return verified ? acceptedText : 'No processing fee applies to this card.';
}
export function paymentFeeLine(principal: string, fee: string, currency: string, methodType: string): string {
  return /^0(?:\.0+)?$/.test(fee) ? `${displayMoney(principal,currency)}; no processing fee`
    : `${displayMoney(principal,currency)} + ${displayMoney(fee,currency)} ${methodType === 'us_bank_account' ? 'bank' : 'card'} processing fee`;
}
/** The pre-charge notice's locked amount line: the total that will be charged, then
 * how it splits into the invoice amount and the processing fee. */
export function chargeTotalLine(principal: string, fee: string, currency: string, methodType: string): string {
  const total = fromMinorUnits(toMinorUnits(principal, currency) + toMinorUnits(fee, currency), currency);
  return /^0(?:\.0+)?$/.test(fee) ? `Total charge: ${displayMoney(principal, currency)} (no processing fee)`
    : `Total charge: ${displayMoney(total, currency)} (${paymentFeeLine(principal, fee, currency, methodType)})`;
}
