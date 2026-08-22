// apps/api/src/services/stripeMoney.ts
//
// Currency-aware conversion between Stripe's smallest-currency-unit integers and
// our decimal major-unit strings. Stripe expects amounts in the currency's
// minor unit (cents for USD), EXCEPT for zero-decimal currencies (JPY, KRW, …)
// where the "smallest unit" IS the major unit — there a 1000 JPY charge is
// `unit_amount: 1000`, not 100000. Blindly multiplying by 100 over-charges those
// customers 100x, so every Stripe amount conversion must route through here.
//
// Source: https://docs.stripe.com/currencies#zero-decimal

export { toMinorUnits, fromMinorUnits, isZeroDecimal } from '@breeze/shared';
