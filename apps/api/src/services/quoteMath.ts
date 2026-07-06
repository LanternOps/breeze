// Quote totals now live in @breeze/shared so the web editor's optimistic "Live
// totals" rail computes from the exact same logic the API persists — they can
// never settle to different figures. Re-exported here to keep the existing
// `./quoteMath` import sites (quoteService, quotesPublic, portal/quotes) stable.
// The quoteMath.test.ts beside this file exercises the shared implementation and
// guards parity.
export {
  computeQuoteTotals,
  validateQuoteDeposit,
  type QuoteLineForMath,
  type QuoteTotals,
  type QuoteDepositConfig,
  type QuoteDepositType,
  type QuoteDepositValidation,
} from '@breeze/shared';
