import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const localesDir = join(dirname(fileURLToPath(import.meta.url)), '../../locales');
const LOCALES = ['en', 'de-DE', 'es-419', 'fr-FR', 'fr-CA', 'it-IT', 'pt-BR', 'tr-TR'] as const;

const KEYS = [
  'reports.reportPreview.reportTypes.ticket_sla_performance',
  'reports.reportPreview.slaPerformance.priority',
  'reports.reportPreview.slaPerformance.ticketsOpened',
  'reports.reportPreview.slaPerformance.firstResponse',
  'reports.reportPreview.slaPerformance.resolution',
  'reports.reportPreview.slaPerformance.target',
  'reports.reportPreview.slaPerformance.measured',
  'reports.reportPreview.slaPerformance.withinSla',
  'reports.reportPreview.slaPerformance.median',
  'reports.reportPreview.slaPerformance.mean',
  'reports.reportPreview.slaPerformance.varies',
  'reports.reportPreview.slaPerformance.breaches',
  'reports.reportPreview.slaPerformance.breachCount_one',
  'reports.reportPreview.slaPerformance.breachCount_other',
  'reports.reportPreview.slaPerformance.notes',
  'reports.reportPreview.slaPerformance.unavailable',
  'reports.reportPreview.slaPerformance.priorities.urgent',
  'reports.reportPreview.slaPerformance.priorities.high',
  'reports.reportPreview.slaPerformance.priorities.normal',
  'reports.reportPreview.slaPerformance.priorities.low',
  'reports.reportTemplates.templates.ticket_sla_performance.name',
  'reports.reportTemplates.templates.ticket_sla_performance.description',
  'reports.ticketSlaPerformanceOptions.includeSubjects',
  'reports.ticketSlaPerformanceOptions.includeSubjectsHelp',
  'reports.ticketSlaPerformanceOptions.cancel',
  'reports.ticketSlaPerformanceOptions.createReport',
] as const;

const TRANSLATED = [
  'reports.reportTemplates.templates.ticket_sla_performance.name',
  'reports.reportTemplates.templates.ticket_sla_performance.description',
  'reports.ticketSlaPerformanceOptions.includeSubjects',
  'reports.ticketSlaPerformanceOptions.includeSubjectsHelp',
] as const;

const load = (locale: string) => JSON.parse(readFileSync(join(localesDir, locale, 'reports.json'), 'utf8')) as Record<string, unknown>;
const at = (catalog: Record<string, unknown>, path: string): unknown =>
  path.split('.').reduce<unknown>((node, key) => (node as Record<string, unknown> | undefined)?.[key], catalog);

describe('ticket_sla_performance locale keys (#11018)', () => {
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
    for (const key of TRANSLATED) {
      expect(at(catalog, key), `${locale}:${key}`).not.toBe(at(en, key));
    }
  });

  it('the English copy states who can read subjects', () => {
    expect(at(en, 'reports.reportTemplates.templates.ticket_sla_performance.name')).toBe('SLA performance');
    expect(at(en, 'reports.reportTemplates.templates.ticket_sla_performance.description'))
      .toBe('Customer-ready response and resolution times against SLA, by priority, with breaches.');
    expect(at(en, 'reports.ticketSlaPerformanceOptions.includeSubjects')).toBe('Include ticket subjects');
    expect(at(en, 'reports.ticketSlaPerformanceOptions.includeSubjectsHelp'))
      .toBe('Delivered reports are visible to every portal user of this organization. Leave off unless every user may see every ticket subject.');
  });
});
