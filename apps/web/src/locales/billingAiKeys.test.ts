import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const localesDir = dirname(fileURLToPath(import.meta.url));
const LOCALES = ['en', 'de-DE', 'es-419', 'fr-FR', 'fr-CA', 'it-IT', 'pt-BR', 'tr-TR'] as const;
const AI_KEYS = [
  'column', 'sectionTitle', 'sectionHelp', 'coverage', 'coverageBillable', 'coverageIncluded', 'coverageNotBilled',
  'markup', 'markupHelp', 'markupInvalid', 'priceListTitle', 'priceListHelp', 'priceListEmpty', 'addRate', 'removeRate',
  'modelId', 'modelPlaceholder', 'inputPrice', 'outputPrice', 'cacheReadPrice', 'cacheWritePrice', 'rowInvalid',
  'rowDuplicate', 'choicesUnavailable', 'usdOnlyWarning', 'summaryBillableMarkup',
  'summaryBillablePriceList_one', 'summaryBillablePriceList_other',
  'summaryBillablePriceListMarkup_one', 'summaryBillablePriceListMarkup_other',
  'summaryBillableUnpriced', 'summaryIncluded', 'summaryNotBilled',
];
const read = (locale: string) => JSON.parse(readFileSync(join(localesDir, locale, 'billing.json'), 'utf8'));
const tokens = (value: string) => [...value.matchAll(/{{\s*([^},\s]+)[^}]*}}/g)].map((m) => m[1]).sort();

describe('billing AI usage pricing i18n (#7608)', () => {
  it.each(LOCALES)('%s carries exactly the rates.ai keys and orgBillingProfile.aiUsage', (locale) => {
    const bundle = read(locale);
    expect(Object.keys(bundle.rates?.ai ?? {}).sort()).toEqual([...AI_KEYS].sort());
    expect(typeof bundle.orgBillingProfile?.aiUsage).toBe('string');
    for (const key of AI_KEYS) expect(String(bundle.rates.ai[key]).trim(), `${locale} ${key}`).not.toBe('');
  });

  it.each(LOCALES.filter((l) => l !== 'en'))('%s keeps the English interpolation tokens', (locale) => {
    const en = read('en');
    const bundle = read(locale);
    for (const key of AI_KEYS) {
      expect(tokens(bundle.rates.ai[key]), `${locale} ${key}`).toEqual(tokens(en.rates.ai[key]));
    }
    expect(tokens(bundle.orgBillingProfile.aiUsage)).toEqual(tokens(en.orgBillingProfile.aiUsage));
  });

  it.each(LOCALES.filter((l) => l !== 'en'))('%s is really translated, not an English copy', (locale) => {
    const en = read('en');
    const bundle = read(locale);
    // "Input"/"Output"/"Model" legitimately survive in some Romance locales, so allow a handful.
    const identical = AI_KEYS.filter((key) => bundle.rates.ai[key] === en.rates.ai[key]);
    expect(identical.length, `${locale} identical to English: ${identical.join(', ')}`).toBeLessThanOrEqual(4);
  });
});
