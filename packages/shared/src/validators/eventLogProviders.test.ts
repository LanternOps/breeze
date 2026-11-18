import { describe, it, expect } from 'vitest';
import {
  APPLICATION_INFO_EVENT_PROVIDERS,
  applicationProvidersSchema,
  eventLogCollectionGap,
  eventLogCollectionWarning,
  monitorEventLogCollectionWarnings,
} from './eventLogProviders';
import { eventLogInlineSettingsSchema } from './index';
import { monitorConditionSchemas } from './monitors';
import { alertRuleConditionSchema } from './alertRuleConditions';

describe('Application-log info provider allowlist (#8174)', () => {
  it('starts with MsiInstaller, includes APCPBEAgent, and stays small', () => {
    expect(APPLICATION_INFO_EVENT_PROVIDERS[0]).toBe('MsiInstaller');
    expect(APPLICATION_INFO_EVENT_PROVIDERS.length).toBeLessThanOrEqual(10);
    expect(APPLICATION_INFO_EVENT_PROVIDERS).toContain('APCPBEAgent');
  });
});

describe('eventLogCollectionWarning (#8174)', () => {
  const base = { category: 'application' as const, countThreshold: 1, windowMinutes: 60 };

  it('collects APC PowerChute warnings and info and names it in the no-source warning', () => {
    expect(eventLogCollectionWarning({ ...base, level: 'warning', sourcePattern: 'APCPBEAgent' })).toBeNull();
    expect(eventLogCollectionWarning({ ...base, level: 'info', sourcePattern: 'apcpbe' })).toBeNull();
    expect(eventLogCollectionWarning({ ...base, level: 'info' })).toMatch(/APCPBEAgent/);
  });

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

describe('policy Application providers (#10493)', () => {
  it('defaults to empty and threads the inline settings schema', () => {
    expect(applicationProvidersSchema.parse(undefined)).toEqual([]);
    expect(eventLogInlineSettingsSchema.parse({}).applicationProviders).toEqual([]);
    expect(eventLogInlineSettingsSchema.parse({ applicationProviders: [' Dell UPS Local Node Manager '] }).applicationProviders)
      .toEqual(['Dell UPS Local Node Manager']);
  });
  it('trims and deduplicates case-insensitively preserving order and spelling', () => {
    expect(applicationProvidersSchema.parse([' APCPBEAgent ', 'apcpbeagent', 'MSSQL$SQLEXPRESS', 'Dell UPS Local Node Manager']))
      .toEqual(['APCPBEAgent', 'MSSQL$SQLEXPRESS', 'Dell UPS Local Node Manager']);
  });
  it('applies the 20-provider limit after deduplication', () => {
    const names = Array.from({ length: 20 }, (_, i) => `Provider${i}`);
    expect(applicationProvidersSchema.parse([...names, ...names.map(n => n.toUpperCase())])).toEqual(names);
    expect(applicationProvidersSchema.safeParse([...names, 'Distinct21']).success).toBe(false);
  });
  it.each(['', ' ', 'A'.repeat(257), "Foo' or '1'='1", 'Foo"]', 'A[B]', 'x<y', 'a&b', 'a`b', 'a;b', 'a/b', 'a\\b', '.NET Runtime'])(
    'rejects unsafe or unsupported name %s', name => {
      expect(applicationProvidersSchema.safeParse([name]).success).toBe(false);
    },
  );
  it('accepts the exact length boundary and allowed punctuation', () => {
    expect(applicationProvidersSchema.safeParse(['A'.repeat(256), 'Microsoft-Windows-Foo', 'Provider.Name (x)_$-']).success).toBe(true);
  });
  it('uses scoped policy providers for substring matching and warning copy', () => {
    const condition = { category: 'application', level: 'warning', sourcePattern: 'dell UPS' };
    expect(eventLogCollectionGap(condition)).not.toBeNull();
    expect(eventLogCollectionGap(condition, ['Dell UPS Local Node Manager'])).toBeNull();
    expect(eventLogCollectionWarning(condition, ['Dell UPS Local Node Manager'])).toBeNull();
    const warning = eventLogCollectionWarning({ ...condition, sourcePattern: 'Other' }, ['Dell UPS Local Node Manager']);
    expect(warning).toContain('plus providers listed in Event Logs configuration policies: Dell UPS Local Node Manager');
    expect(warning).toContain('Configuration policy → Event Logs → Application providers');
    expect(monitorEventLogCollectionWarnings('composite', { children: [{ kind: 'event_log', condition }] }, ['Dell UPS Local Node Manager'])).toEqual([]);
  });
});
