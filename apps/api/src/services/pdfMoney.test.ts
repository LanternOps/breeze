import { describe, it, expect } from 'vitest';
import { formatMoney } from '@breeze/shared';
import { formatMoneyForPdf, isWinAnsiSafe } from './pdfMoney';

describe('isWinAnsiSafe', () => {
  it('accepts Latin-1 plus pdfkit WIN_ANSI_MAP extras (€, dashes, quotes)', () => {
    expect(isWinAnsiSafe('1.000,00 € — “x”')).toBe(true);
  });
  it('rejects narrow no-break space and non-WinAnsi currency symbols', () => {
    expect(isWinAnsiSafe('1 000')).toBe(false);
    expect(isWinAnsiSafe('\u20ba1,00')).toBe(false);
    expect(isWinAnsiSafe('\u20b91.00')).toBe(false);
  });
});

describe('formatMoneyForPdf', () => {
  it('is byte-identical to formatMoney when the locale output is already WinAnsi (en USD, de-DE EUR)', () => {
    expect(formatMoneyForPdf(1234.5, 'USD', 'en')).toBe(formatMoney(1234.5, 'USD', 'en'));
    expect(formatMoneyForPdf(1234.5, 'EUR', 'de-DE')).toBe(formatMoney(1234.5, 'EUR', 'de-DE'));
  });

  it('folds fr-FR narrow no-break grouping spaces to NBSP without changing digits or symbol', () => {
    const raw = formatMoney(1000, 'EUR', 'fr-FR');
    expect(raw).toContain(' ');
    const pdf = formatMoneyForPdf(1000, 'EUR', 'fr-FR');
    expect(pdf).toBe(raw.replace(/ /g, ' '));
    expect(pdf).toBe('1 000,00 €');
    expect(isWinAnsiSafe(pdf)).toBe(true);
  });

  it('falls back to the ISO code display in the SAME locale when the symbol is not WinAnsi (tr-TR TRY, en INR)', () => {
    const tr = formatMoneyForPdf(1234.5, 'TRY', 'tr-TR');
    expect(tr).not.toContain('\u20ba');
    expect(tr).toContain('TRY');
    expect(tr).toContain('1.234,50');
    expect(isWinAnsiSafe(tr)).toBe(true);

    const inr = formatMoneyForPdf(99.99, 'INR', 'en');
    expect(inr).not.toContain('\u20b9');
    expect(inr).toContain('INR');
    expect(inr).toContain('99.99');
    expect(isWinAnsiSafe(inr)).toBe(true);
  });

  it('never converts: the numeric part matches the shared formatter for every supported locale', () => {
    for (const locale of ['en', 'de-DE', 'es-419', 'fr-CA', 'fr-FR', 'it-IT', 'pt-BR', 'tr-TR']) {
      for (const currency of ['USD', 'EUR', 'GBP', 'TRY', 'BRL', 'JPY']) {
        const digits = (s: string) => s.replace(/[^0-9]/g, '');
        expect(digits(formatMoneyForPdf(98765.43, currency, locale)), `${locale}/${currency}`).toBe(digits(formatMoney(98765.43, currency, locale)));
        expect(isWinAnsiSafe(formatMoneyForPdf(98765.43, currency, locale)), `${locale}/${currency}`).toBe(true);
      }
    }
  });

  it('keeps the shared fallback shape for unknown currency codes', () => {
    expect(formatMoneyForPdf(12, 'ZZ1', 'en')).toBe(formatMoney(12, 'ZZ1', 'en'));
  });
});
