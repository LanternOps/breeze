/** Warn-don't-block (multi-currency spec §10): the document's currency differs from
 *  the connected Stripe account's default. Stripe still presents the document
 *  currency; the partner bears the FX spread on settlement. */
export interface StripeCurrencyWarning {
  code: 'CURRENCY_DIFFERS_FROM_STRIPE_ACCOUNT';
  documentCurrency: string;
  accountCurrency: string;
  message: string;
}
