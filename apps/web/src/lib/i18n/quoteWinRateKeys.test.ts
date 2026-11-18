import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const localesDir = join(dirname(fileURLToPath(import.meta.url)), '../../locales');
const LOCALES = ['en', 'de-DE', 'es-419', 'fr-FR', 'fr-CA', 'it-IT', 'pt-BR', 'tr-TR'] as const;

const KEYS = [
  'reports.reportPreview.reportTypes.quote_win_rate',
  'reports.reportsList.reportTypes.quote_win_rate',
  'reports.reportTemplates.reportTypes.quote_win_rate',
  'reports.reportTemplates.templates.quote_win_rate.name',
  'reports.reportTemplates.templates.quote_win_rate.description',
  'reports.quoteWinRateOptions.groupBy',
  'reports.quoteWinRateOptions.groupByAutomatic',
  'reports.quoteWinRateOptions.groupByValues.organization',
  'reports.quoteWinRateOptions.groupByValues.author',
  'reports.quoteWinRateOptions.groupByValues.currency',
  'reports.quoteWinRateOptions.periodNote',
  'reports.quoteWinRateOptions.cancel',
  'reports.quoteWinRateOptions.createReport',
] as const;

function load(locale: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(localesDir, locale, 'reports.json'), 'utf8'));
}
function at(source: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce<unknown>((cur, seg) =>
    typeof cur === 'object' && cur !== null ? (cur as Record<string, unknown>)[seg] : undefined, source);
}

describe('quote_win_rate locale keys', () => {
  const en = load('en');

  it.each(LOCALES)('%s defines every key as a non-empty string', (locale) => {
    const catalog = load(locale);
    for (const key of KEYS) {
      const value = at(catalog, key);
      expect(typeof value, `${locale}:${key}`).toBe('string');
      expect((value as string).trim().length, `${locale}:${key}`).toBeGreaterThan(0);
    }
  });

  it.each(LOCALES.filter((l) => l !== 'en'))('%s translates the headline strings instead of copying English', (locale) => {
    const catalog = load(locale);
    for (const key of [
      'reports.reportTemplates.templates.quote_win_rate.name',
      'reports.reportTemplates.templates.quote_win_rate.description',
      'reports.quoteWinRateOptions.groupByAutomatic',
      'reports.quoteWinRateOptions.periodNote',
    ]) {
      expect(at(catalog, key), `${locale}:${key}`).not.toBe(at(en, key));
    }
  });

  it('the English period note says the period applies to the first send date', () => {
    expect(at(en, 'reports.quoteWinRateOptions.periodNote')).toMatch(/first sent/);
  });
});
