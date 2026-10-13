import { describe, it, expect } from 'vitest';
import {
  APPLICATION_INFO_EVENT_PROVIDERS,
  eventLogCollectionWarning,
  monitorEventLogCollectionWarnings,
} from './eventLogProviders';
import { monitorConditionSchemas } from './monitors';
import { alertRuleConditionSchema } from './alertRuleConditions';

describe('Application-log info provider allowlist (#8174)', () => {
  it('starts with MsiInstaller and stays small', () => {
    expect(APPLICATION_INFO_EVENT_PROVIDERS[0]).toBe('MsiInstaller');
    expect(APPLICATION_INFO_EVENT_PROVIDERS.length).toBeLessThanOrEqual(10);
  });
});

describe('eventLogCollectionWarning (#8174)', () => {
  const base = { category: 'application' as const, countThreshold: 1, windowMinutes: 60 };

  it('does not warn for an allowlisted provider at info level', () => {
    expect(eventLogCollectionWarning({ ...base, level: 'info', sourcePattern: 'MsiInstaller' })).toBeNull();
  });

  it('matches the handler: a substring of an allowlisted provider, case-insensitive', () => {
    // The evaluator matches source with ILIKE %pattern%, so "msi" hits MsiInstaller.
    expect(eventLogCollectionWarning({ ...base, level: 'info', sourcePattern: 'msi' })).toBeNull();
    expect(eventLogCollectionWarning({ ...base, level: 'warning', sourcePattern: ' MSIINSTALLER ' })).toBeNull();
  });

  it('warns for an info-level Application source outside the allowlist', () => {
    const w = eventLogCollectionWarning({ ...base, level: 'info', sourcePattern: 'Application Error' });
    expect(w).toMatch(/Application Error/);
    expect(w).toMatch(/MsiInstaller/);
  });

  it('warns for a warning-level Application source outside the allowlist', () => {
    expect(eventLogCollectionWarning({ ...base, level: 'warning', sourcePattern: 'VSS' })).toMatch(/VSS/);
  });

  it('warns when an info/warning Application rule names no source', () => {
    expect(eventLogCollectionWarning({ ...base, level: 'info' })).toMatch(/MsiInstaller/);
    expect(eventLogCollectionWarning({ ...base, level: 'warning', sourcePattern: '  ' })).toMatch(/MsiInstaller/);
  });

  it('does not warn at error/critical level (collected from every provider)', () => {
    expect(eventLogCollectionWarning({ ...base, level: 'error', sourcePattern: 'VSS' })).toBeNull();
    expect(eventLogCollectionWarning({ ...base, level: 'critical' })).toBeNull();
  });

  it('does not warn for other categories', () => {
    expect(eventLogCollectionWarning({ ...base, category: 'system', level: 'info', sourcePattern: 'VSS' })).toBeNull();
  });
});

describe('monitorEventLogCollectionWarnings (#8174)', () => {
  it('warns for an event_log monitor', () => {
    expect(
      monitorEventLogCollectionWarnings('event_log', { category: 'application', level: 'info', sourcePattern: 'Foo' }),
    ).toHaveLength(1);
  });

  it('walks composite children', () => {
    const warnings = monitorEventLogCollectionWarnings('composite', {
      operator: 'any',
      children: [
        { kind: 'cpu', condition: { operator: 'gt', value: 90 } },
        { kind: 'event_log', condition: { category: 'application', level: 'info', sourcePattern: 'Foo' } },
        { kind: 'event_log', condition: { category: 'application', level: 'info', sourcePattern: 'MsiInstaller' } },
      ],
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/Foo/);
  });

  it('returns nothing for other kinds or malformed input', () => {
    expect(monitorEventLogCollectionWarnings('cpu', { operator: 'gt', value: 90 })).toEqual([]);
    expect(monitorEventLogCollectionWarnings('event_log', null)).toEqual([]);
    expect(monitorEventLogCollectionWarnings('composite', { children: 'nope' })).toEqual([]);
  });
});

describe('event_log level accepts info (#8174)', () => {
  it('monitor condition schema', () => {
    expect(
      monitorConditionSchemas.event_log.safeParse({
        category: 'application',
        level: 'info',
        sourcePattern: 'MsiInstaller',
      }).success,
    ).toBe(true);
  });

  it('alert rule condition schema', () => {
    expect(
      alertRuleConditionSchema.safeParse({
        type: 'event_log',
        category: 'application',
        level: 'info',
        sourcePattern: 'MsiInstaller',
      }).success,
    ).toBe(true);
  });
});
