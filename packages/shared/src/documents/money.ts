import { formatMoney } from '../utils/currency';
import type { DocumentMoney } from './model';

/**
 * A money value for the document: the screen text in the document's locale,
 * plus the raw decimal string and currency so the PDF can re-format it
 * glyph-safely (`formatMoneyForPdf`). Strings only — a caller holding computed
 * cents passes `(cents / 100).toFixed(2)`, so no float reaches the PDF path.
 */
export function documentMoney(
  amount: string,
  currency: string,
  locale: string,
  suffix: { text: string; srText: string } | null = null,
): DocumentMoney {
  return { text: formatMoney(amount, currency, locale), amount, currency, suffix: suffix ?? null };
}
