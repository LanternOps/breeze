import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const localesDir = join(dirname(fileURLToPath(import.meta.url)), '../../locales');
const LOCALES = ['en', 'de-DE', 'es-419', 'fr-FR', 'fr-CA', 'it-IT', 'pt-BR', 'tr-TR'] as const;

const KEYS = [
  'reports.reportPreview.reportTypes.mrr_renewals',
  'reports.reportsList.reportTypes.mrr_renewals',
  'reports.reportTemplates.reportTypes.mrr_renewals',
  'reports.reportTemplates.templates.mrr_renewals.name',
  'reports.reportTemplates.templates.mrr_renewals.description',
  'reports.reportTemplates.spec.asOfRunDate',
  'reports.mrrRenewalsOptions.groupBy',
  'reports.mrrRenewalsOptions.groupByValues.organization',
  'reports.mrrRenewalsOptions.groupByValues.contract',
  'reports.mrrRenewalsOptions.renewalHorizon',
  'reports.mrrRenewalsOptions.renewalHorizonOption',
  'reports.mrrRenewalsOptions.renewalHorizonHelp',
  'reports.mrrRenewalsOptions.runTimeNote',
  'reports.mrrRenewalsOptions.cancel',
  'reports.mrrRenewalsOptions.createReport',
] as const;

function load(locale: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(localesDir, locale, 'reports.json'), 'utf8'));
}
function at(source: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce<unknown>((cur, seg) =>
    typeof cur === 'object' && cur !== null ? (cur as Record<string, unknown>)[seg] : undefined, source);
}

describe('mrr_renewals locale keys', () => {
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
      'reports.reportTemplates.templates.mrr_renewals.name',
      'reports.reportTemplates.templates.mrr_renewals.description',
      'reports.mrrRenewalsOptions.renewalHorizonHelp',
      'reports.mrrRenewalsOptions.runTimeNote',
    ]) {
      expect(at(catalog, key), `${locale}:${key}`).not.toBe(at(en, key));
    }
  });

  it('every locale keeps the {{days}} placeholder in the horizon option', () => {
    for (const locale of LOCALES) {
      expect(at(load(locale), 'reports.mrrRenewalsOptions.renewalHorizonOption'), locale).toContain('{{days}}');
    }
  });

  it('the English run-time note says there is no period to choose', () => {
    expect(at(en, 'reports.mrrRenewalsOptions.runTimeNote')).toMatch(/day the report runs/);
  });
});
