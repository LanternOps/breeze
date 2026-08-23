/**
 * Warn-don't-block (multi-currency spec §10). Two shapes share one channel:
 *
 * - `CURRENCY_DIFFERS_FROM_STRIPE_ACCOUNT` — the document's currency differs
 *   from the connected Stripe account's cached default. Stripe still presents
 *   the document currency; the partner bears the FX spread on settlement.
 * - `STRIPE_ACCOUNT_CURRENCY_UNKNOWN` — the account is connected but its
 *   default currency has never been cached (pre-cache connections, or Stripe
 *   reported none). "Unknown" is NOT "matches": the partner is told the check
 *   could not be made and to refresh the account details (#3777 review F6).
 *
 * Neither shape ever blocks a pay link and neither implies a conversion.
 */
export type StripeCurrencyWarning =
  | {
      code: 'CURRENCY_DIFFERS_FROM_STRIPE_ACCOUNT';
      documentCurrency: string;
      accountCurrency: string;
      message: string;
    }
  | {
      code: 'STRIPE_ACCOUNT_CURRENCY_UNKNOWN';
      documentCurrency: string;
      accountCurrency: null;
      message: string;
    };
