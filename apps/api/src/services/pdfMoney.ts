import { formatMoney } from '@breeze/shared';

/**
 * PDF-safe money formatting (#3777 review finding).
 *
 * Invoice/quote PDFs draw money with pdfkit's standard Helvetica, which is
 * WinAnsi-encoded: any code point outside Latin-1 that is not in pdfkit's
 * small WIN_ANSI_MAP is written as its raw hex string and renders as garbage
 * glyphs. `Intl` currency output routinely contains such characters — fr-FR
 * groups with U+202F NARROW NO-BREAK SPACE, and ₹ / ₺ / ₩ / ₪ have no WinAnsi
 * slot at all. This helper keeps the shared formatter as the single source of
 * glyphs (no conversion, same number) and only repairs what Helvetica cannot
 * encode: thin/narrow spaces fold to U+00A0 (which WinAnsi has), and a symbol
 * that still cannot be encoded falls back to the ISO code display
 * (`1 234,56 TRY`) — still the document's locale, never a different locale.
 *
 * HTML email / portal rendering must keep using `formatMoney` directly; this
 * helper is for text handed to pdfkit only.
 */

// Non-Latin-1 code points pdfkit's AFM standard fonts can still encode
// (mirrors pdfkit's WIN_ANSI_MAP keys).
const WIN_ANSI_EXTRA = new Set([
  0x0152, 0x0153, 0x0160, 0x0161, 0x0178, 0x017d, 0x017e, 0x0192, 0x02c6, 0x02dc,
  0x2013, 0x2014, 0x2018, 0x2019, 0x201a, 0x201c, 0x201d, 0x201e, 0x2020, 0x2021,
  0x2022, 0x2026, 0x2030, 0x2039, 0x203a, 0x20ac, 0x2122,
]);

// Width-bearing Unicode spaces Intl emits as grouping / symbol separators.
const THIN_SPACES = /[\u2007\u2009\u200a\u202f]/g;
// Zero-width joiners/markers: drop rather than render.
const ZERO_WIDTH = /[\u200b\u200c\u200d\u2060\ufeff]/g;

/** True when every code point can be encoded by pdfkit's WinAnsi standard fonts. */
export function isWinAnsiSafe(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code > 0xff && !WIN_ANSI_EXTRA.has(code)) return false;
  }
  return true;
}

function foldSpaces(text: string): string {
  return text.replace(THIN_SPACES, '\u00a0').replace(ZERO_WIDTH, '');
}

/**
 * `formatMoney` for pdfkit text: identical output whenever the shared
 * formatter's string is WinAnsi-encodable (after folding thin spaces to NBSP);
 * otherwise the same locale with `currencyDisplay: 'code'`; last resort
 * `<fixed2> <CODE>` (the shared formatter's own unknown-currency shape).
 */
export function formatMoneyForPdf(value: string | number | null | undefined, currency: string, locale?: string): string {
  const symbolForm = foldSpaces(formatMoney(value, currency, locale));
  if (isWinAnsiSafe(symbolForm)) return symbolForm;

  const n = Number(value ?? 0);
  const safe = Number.isFinite(n) ? n : 0;
  const code = String(currency ?? '').trim().toUpperCase();
  try {
    const codeForm = foldSpaces(new Intl.NumberFormat(locale, { style: 'currency', currency: code, currencyDisplay: 'code' }).format(safe));
    if (isWinAnsiSafe(codeForm)) return codeForm;
  } catch {
    // fall through to the neutral shape
  }
  return `${safe.toFixed(2)} ${code}`;
}
