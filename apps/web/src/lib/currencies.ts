// Moved to @breeze/shared (multi-currency wave 1, #3773) so API/portal share
// the same curated list. This file remains as the web-side import point.
export {
  CURRENCY_CODES, isKnownCurrency, currencyLabel, currencyOptions,
  type CurrencyCode,
} from '@breeze/shared';
