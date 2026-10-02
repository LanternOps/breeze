import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const localesDir = join(dirname(fileURLToPath(import.meta.url)), '../../locales');
const LOCALES = ['en', 'de-DE', 'es-419', 'fr-FR', 'fr-CA', 'it-IT', 'pt-BR', 'tr-TR'] as const;

const KEYS = [
  'reports.reportPreview.reportTypes.ai_usage_by_client',
  'reports.reportsList.reportTypes.ai_usage_by_client',
  'reports.reportTemplates.reportTypes.ai_usage_by_client',
  'reports.reportTemplates.templates.ai_usage_by_client.name',
  'reports.reportTemplates.templates.ai_usage_by_client.description',
  'reports.aiUsageByClientOptions.groupBy',
  'reports.aiUsageByClientOptions.groupByAutomatic',
  'reports.aiUsageByClientOptions.groupByValues.organization',
  'reports.aiUsageByClientOptions.groupByValues.model',
  'reports.aiUsageByClientOptions.periodNote',
  'reports.aiUsageByClientOptions.unpricedNote',
  'reports.aiUsageByClientOptions.cancel',
  'reports.aiUsageByClientOptions.createReport',
] as const;

function load(locale: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(localesDir, locale, 'reports.json'), 'utf8'));
}
function at(source: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce<unknown>((cur, seg) =>
    typeof cur === 'object' && cur !== null ? (cur as Record<string, unknown>)[seg] : undefined, source);
}

describe('ai_usage_by_client locale keys (#7608 W10)', () => {
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
      'reports.reportTemplates.templates.ai_usage_by_client.name',
      'reports.reportTemplates.templates.ai_usage_by_client.description',
      'reports.aiUsageByClientOptions.groupByAutomatic',
      'reports.aiUsageByClientOptions.groupByValues.model',
      'reports.aiUsageByClientOptions.periodNote',
      'reports.aiUsageByClientOptions.unpricedNote',
    ]) {
      expect(at(catalog, key), `${locale}:${key}`).not.toBe(at(en, key));
    }
  });

  it('the English period note states the UTC-month rule the generator also prints', () => {
    expect(at(en, 'reports.aiUsageByClientOptions.periodNote')).toMatch(/UTC calendar month/);
  });
});
