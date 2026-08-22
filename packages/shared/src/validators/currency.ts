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
}).strict();

export type ChangeCurrencyInput = z.infer<typeof changeCurrencySchema>;
