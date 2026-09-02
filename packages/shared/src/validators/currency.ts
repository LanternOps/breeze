import { z } from 'zod';
import { isKnownCurrency } from '../utils/currency';

/** ISO-4217 currency code, normalized to uppercase and restricted to the
 *  curated supported list (multi-currency spec §4). The DB backstops this via
 *  the supported_currencies FK — but Zod is the user-facing error. */
export const currencyCodeSchema = z
  .string()
  .transform((s) => s.trim().toUpperCase())
  .refine((s) => isKnownCurrency(s), { message: 'Unsupported currency code' });

/**
 * Body for the draft-only atomic change-currency operation (multi-currency
 * wave 2, #3774): POST /quotes/:id/currency, /invoices/:id/currency,
 * /contracts/:id/currency. One shared schema — the shape is identical across
 * the three document types (defining it per-document would collide in the
 * validators barrel anyway). `clearLines` opts into deleting the document's
 * monetary lines inside the same transaction as the restamp; without it a
 * document that has lines is refused with CURRENCY_LOCKED (409). Strict so a
 * mis-keyed field (e.g. `convert`) is a 400, never a silent default.
 */
export const changeCurrencySchema = z.object({
  currencyCode: currencyCodeSchema,
  clearLines: z.boolean().default(false),
  // Wave 3: re-resolve catalog-sourced lines from the price book in the new
  // currency inside the same transaction. Mutually exclusive with clearLines.
  reprice: z.boolean().default(false),
}).strict().refine((v) => !(v.clearLines && v.reprice), {
  message: 'clearLines and reprice are mutually exclusive',
  path: ['reprice'],
});

export type ChangeCurrencyInput = z.infer<typeof changeCurrencySchema>;

/**
 * Reporting-only FX (multi-currency spec §8, wave 7 #3779). `rate` is a
 * positive decimal STRING with at most 8 places — a JS number would lose
 * precision at the numeric(18,8) boundary. The service re-validates (and owns
 * real-calendar-date validity, e.g. 2026-02-30, plus the EUR-pivot rule); this
 * is the user-facing shape error.
 */
const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');
const positiveRateSchema = z
  .string()
  .regex(/^\d+(\.\d{1,8})?$/, 'Expected a positive decimal with at most 8 places')
  // The scale is bounded above; the PRECISION must be bounded too. numeric(18,8)
  // leaves 10 digits left of the point, and an over-long integer part would
  // reach Postgres as a `numeric field overflow` — which is not an
  // ExchangeRateServiceError, so the admin route rethrows it as a 500 instead
  // of the intended coded 400.
  .refine((s) => s.split('.')[0]!.replace(/^0+(?=\d)/, '').length <= 10, {
    message: 'Expected at most 10 digits before the decimal point',
  })
  .refine((s) => Number(s) > 0, { message: 'Rate must be greater than zero' });

export const exchangeRateKeyParamSchema = z.object({
  rateDate: isoDateSchema,
  baseCode: currencyCodeSchema,
  quoteCode: currencyCodeSchema,
}).strict().refine((v) => v.baseCode !== v.quoteCode, {
  message: 'base and quote currency must differ',
  path: ['quoteCode'],
});

/** Strict: an operator who thinks they are pinning an ECB rate must be told
 *  they cannot, not have `source` silently dropped. */
export const manualExchangeRateBodySchema = z.object({ rate: positiveRateSchema }).strict();

export const exchangeRateListQuerySchema = z.object({
  baseCode: currencyCodeSchema.optional(),
  quoteCode: currencyCodeSchema.optional(),
  source: z.enum(['ecb', 'manual']).optional(),
  onOrBefore: isoDateSchema.optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
}).strict();

export type ExchangeRateKeyParam = z.infer<typeof exchangeRateKeyParamSchema>;
export type ManualExchangeRateBody = z.infer<typeof manualExchangeRateBodySchema>;
export type ExchangeRateListQuery = z.infer<typeof exchangeRateListQuerySchema>;

/**
 * Query for GET /api/v1/billing/reporting-totals (wave 7, #3779).
 *
 * `groups` is the caller's OWN per-currency segmentation as `CODE:amount`
 * pairs; the server converts and totals it (spec §8 — the browser never
 * multiplies money). Amount is a decimal STRING because a JS number loses
 * precision on a large portfolio. The pair grammar is validated in
 * `parseGroupsParam` (reportingTotals.ts), which owns the currency-code and
 * duplicate rules; Zod only bounds the raw string here.
 *
 * `to` is OPTIONAL — omitted, the server derives the actor's partner reporting
 * currency, which is what lets ORGANIZATION-scoped viewers use this endpoint.
 * `date` is REQUIRED and never defaulted server-side, and there is deliberately
 * no `maxStalenessDays` param: a client must not be able to widen the ceiling.
 * `.strict()` so a mis-keyed field is a 400 rather than a silent default.
 */
export const reportingTotalsQuerySchema = z.object({
  groups: z.string().min(1).max(1024),
  to: currencyCodeSchema.optional(),
  date: isoDateSchema,
}).strict();

export type ReportingTotalsQuery = z.infer<typeof reportingTotalsQuerySchema>;
