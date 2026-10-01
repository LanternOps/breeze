import { describe, expect, it } from 'vitest';
import type { ReportType } from '@breeze/shared';
import {
  canonicalize,
  combineGroupKey,
  normalizeCombineConfig,
  normalizeEmail,
  seriesConfigFrom,
  type CombineCadence,
  type CombineFormat,
} from './combineKey';

/** What ReportBuilder.tsx:1451-1480 persists for a legacy builder type. */
const builderConfig = {
  builderType: 'template',
  dataSource: 'alerts',
  columns: ['severity', 'title', 'createdAt'],
  filterConditions: [{ id: 'filter-1a2b', logic: 'and', field: 'severity', operator: 'is', value: 'critical' }],
  groupBy: '',
  aggregation: { type: 'count' },
  chartType: 'table',
  schedule: { time: '08:00', day: 'monday', date: '1' },
  exportFormats: ['pdf'],
  emailRecipients: ['cc@msp.test'],
  saveTemplate: false,
};

function keyOf(
  config: unknown,
  type: ReportType = 'alert_summary',
  cadence: CombineCadence = 'weekly',
  format: CombineFormat = 'pdf',
) {
  const normalized = normalizeCombineConfig(type, cadence, config);
  if (!normalized) throw new Error('config did not normalize');
  return combineGroupKey({ type, format, schedule: cadence, canonicalConfig: normalized.canonical });
}

describe('canonicalize', () => {
  it('sorts keys, drops null/undefined, treats primitive arrays as sets except columns', () => {
    expect(canonicalize({ b: 1, a: null, c: undefined, filters: { osTypes: ['macos', 'windows', 'macos'] }, columns: ['z', 'a'] }))
      .toEqual({ b: 1, columns: ['z', 'a'], filters: { osTypes: ['macos', 'windows'] } });
    expect(JSON.stringify(canonicalize({ b: 1, a: 2 }))).toBe('{"a":2,"b":1}');
  });

  it('drops the client-generated id of filterConditions but keeps their order', () => {
    expect(canonicalize({ filterConditions: [{ id: 'x', field: 'b' }, { id: 'y', field: 'a' }] }, ''))
      .toEqual({ filterConditions: [{ field: 'b' }, { field: 'a' }] });
  });
});

describe('Combine group key (Review Focus #1)', () => {
  it('groups builder twins: id, key order, day case, time padding, recipients and template toggles differ', () => {
    const twin = {
      saveTemplate: true,
      templateName: 'My weekly',
      emailRecipients: ['someone-else@msp.test'],
      schedule: { day: 'Monday', time: '8:00' },
      exportFormats: ['pdf'],
      chartType: 'table',
      aggregation: { type: 'count' },
      groupBy: '',
      filterConditions: [{ value: 'critical', operator: 'is', field: 'severity', logic: 'and', id: 'filter-9z8y' }],
      columns: ['severity', 'title', 'createdAt'],
      dataSource: 'alerts',
      builderType: 'template',
      legacyFilters: null,
    };
    expect(keyOf(twin)).toBe(keyOf(builderConfig));
    expect(keyOf(builderConfig)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('treats an explicit per-type default as equal to leaving it out', () => {
    const posture = { schedule: { time: '07:00', day: 'friday' } };
    expect(keyOf({ ...posture, windowDays: 30, includeCis: true }, 'security_compliance_posture'))
      .toBe(keyOf(posture, 'security_compliance_posture'));
  });

  it('separates a different column order, filter value, fire time, cadence, format or type', () => {
    const base = keyOf(builderConfig);
    expect(keyOf({ ...builderConfig, columns: ['title', 'severity', 'createdAt'] })).not.toBe(base);
    expect(keyOf({ ...builderConfig, filterConditions: [{ ...builderConfig.filterConditions[0], value: 'high' }] })).not.toBe(base);
    expect(keyOf({ ...builderConfig, schedule: { time: '09:00', day: 'monday' } })).not.toBe(base);
    expect(keyOf({ ...builderConfig, schedule: { time: '08:00', day: 'tuesday' } })).not.toBe(base);
    expect(keyOf(builderConfig, 'alert_summary', 'daily')).not.toBe(base);
    expect(keyOf(builderConfig, 'alert_summary', 'weekly', 'csv')).not.toBe(base);
    expect(keyOf(builderConfig, 'device_inventory')).not.toBe(base);
  });

  it('ignores the day of a daily report and the date of a weekly one', () => {
    expect(keyOf({ ...builderConfig, schedule: { time: '08:00', day: 'friday' } }, 'alert_summary', 'daily'))
      .toBe(keyOf(builderConfig, 'alert_summary', 'daily'));
    expect(keyOf({ ...builderConfig, schedule: { time: '08:00', day: 'monday', date: '20' } }))
      .toBe(keyOf(builderConfig));
  });
});

describe('normalizeCombineConfig', () => {
  it('normalizes, de-duplicates and sorts emailRecipients', () => {
    // No surrounding whitespace in stored values: the config schema's email
    // regex (reportConfigSchemas.ts) already refuses it.
    expect(normalizeCombineConfig('alert_summary', 'weekly', { emailRecipients: ['B@msp.test', 'b@msp.test', 'a@msp.test'] })?.emailRecipients)
      .toEqual(['a@msp.test', 'b@msp.test']);
    expect(normalizeEmail('  Ops@MSP.test ')).toBe('ops@msp.test');
  });

  it('returns null for a config its type schema rejects, or a non-object', () => {
    expect(normalizeCombineConfig('alert_summary', 'weekly', { schedule: { time: 'nope' } })).toBeNull();
    expect(normalizeCombineConfig('alert_summary', 'weekly', null)).toBeNull();
    expect(normalizeCombineConfig('alert_summary', 'weekly', ['x'])).toBeNull();
  });
});

describe('seriesConfigFrom', () => {
  it('keeps the stored config minus the ignored keys (no defaults added)', () => {
    expect(seriesConfigFrom(builderConfig)).toEqual({
      builderType: 'template', dataSource: 'alerts', columns: ['severity', 'title', 'createdAt'],
      filterConditions: builderConfig.filterConditions, groupBy: '', aggregation: { type: 'count' },
      chartType: 'table', schedule: builderConfig.schedule, exportFormats: ['pdf'],
    });
  });
});
