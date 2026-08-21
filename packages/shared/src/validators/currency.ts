import { z } from 'zod';
import { isKnownCurrency } from '../utils/currency';

/** ISO-4217 currency code, normalized to uppercase and restricted to the
 *  curated supported list (multi-currency spec §4). The DB backstops this via
 *  the supported_currencies FK — but Zod is the user-facing error. */
export const currencyCodeSchema = z
  .string()
  .transform((s) => s.trim().toUpperCase())
  .refine((s) => isKnownCurrency(s), { message: 'Unsupported currency code' });
