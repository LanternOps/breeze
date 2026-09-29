import { describe, expect, it } from 'vitest';
import { REPORT_TYPES } from '@breeze/shared';
import { isSystemManagedReportType } from '../ReportsList';
import {
  availableCoversModes,
  configNamesOrgEntities,
  coversFromSeries,
  firstCoveredOrgId,
  isReportRecipientEmail,
  isSeriesSchedule,
  isSeriesEligibleReportType,
  matchesRecipientRule,
  sameTargets,
  seriesBuilderDefaults,
  stripSeriesConfig,
} from './seriesConfig';
import type { SeriesDetail } from './types';

describe('isSeriesEligibleReportType', () => {
  it('accepts org-executable builder and curated types', () => {
    for (const t of ['device_inventory', 'alert_summary', 'executive_summary', 'security_compliance_posture', 'hardware_lifecycle']) {
      expect(isSeriesEligibleReportType(t), t).toBe(true);
    }
  });
  it('refuses business, managed-evidence and system-managed types', () => {
    for (const t of ['ar_aging', 'ticket_sla_attainment', 'technician_time_billability', 'threat_detection_review',
      'endpoint_management_review', 'vulnerability_management', 'identity_access_review', 'ai_org_narrative', 'ai_fleet_design']) {
      expect(isSeriesEligibleReportType(t), t).toBe(false);
    }
  });
  it('never offers a system-managed type (parity with ReportsList)', () => {
    for (const t of REPORT_TYPES) {
      if (isSystemManagedReportType(t)) expect(isSeriesEligibleReportType(t), t).toBe(false);
    }
  });
  it('refuses a missing type', () => expect(isSeriesEligibleReportType(undefined)).toBe(false));
});

describe('availableCoversModes', () => {
  it('offers only one organization without the partner-wide gate', () => {
    expect(availableCoversModes('device_inventory', false)).toEqual(['org']);
    expect(availableCoversModes('ar_aging', false)).toEqual(['org']);
  });
  it('offers series for an eligible type and combined for a business type, never both', () => {
    expect(availableCoversModes('device_inventory', true)).toEqual(['org', 'series']);
    expect(availableCoversModes('ar_aging', true)).toEqual(['org', 'combined']);
    expect(availableCoversModes('threat_detection_review', true)).toEqual(['org']);
  });
});

describe('stripSeriesConfig', () => {
  it('drops every org-specific selector and the email list, keeps the rest', () => {
    const out = stripSeriesConfig({
      dateRange: { preset: 'last_30_days' },
      sites: ['s1'],
      siteIds: ['s1'],
      deviceIds: ['d1'],
      groupIds: ['g1'],
      deviceGroupIds: ['g2'],
      orgId: 'o1',
      orgIds: ['o1'],
      emailRecipients: ['a@x.io'],
      filters: { siteIds: ['s1'], deviceIds: ['d1'], osTypes: ['windows'] },
      legacyFilters: { siteIds: ['s1'] },
      filterConditions: [
        { id: 'c1', logic: 'and', field: 'site', operator: 'equals', value: 'HQ' },
        { id: 'c2', logic: 'and', field: 'os', operator: 'equals', value: 'windows' },
      ],
      columns: ['hostname'],
    });
    expect(out).toEqual({
      dateRange: { preset: 'last_30_days' },
      filters: { osTypes: ['windows'] },
      filterConditions: [{ id: 'c2', logic: 'and', field: 'os', operator: 'equals', value: 'windows' }],
      columns: ['hostname'],
    });
  });
  it('does not mutate its input', () => {
    const input = { filters: { siteIds: ['s1'] } };
    stripSeriesConfig(input);
    expect(input).toEqual({ filters: { siteIds: ['s1'] } });
  });
});

describe('configNamesOrgEntities', () => {
  it('is true for any non-empty org selector, false for empty ones', () => {
    expect(configNamesOrgEntities({ filters: { siteIds: ['s1'] } })).toBe(true);
    expect(configNamesOrgEntities({ sites: [] , filters: { siteIds: [] } })).toBe(false);
    expect(configNamesOrgEntities({ filterConditions: [{ field: 'site', value: 'HQ' }] })).toBe(true);
    expect(configNamesOrgEntities({ columns: ['site'] })).toBe(false);
  });
});

describe('recipient helpers', () => {
  it('accepts the same loose shape as the builder and the API', () => {
    expect(isReportRecipientEmail('ops@msp.example')).toBe(true);
    expect(isReportRecipientEmail(' ops@msp.example ')).toBe(true);
    expect(isReportRecipientEmail('ops@msp')).toBe(false);
  });
  it('matches the org-level primary contact and role overlap', () => {
    const rule = { primaryContact: true, roles: ['billing'] };
    expect(matchesRecipientRule({ isPrimary: true, siteId: null, roles: [] }, rule)).toBe(true);
    expect(matchesRecipientRule({ isPrimary: true, siteId: 'site-1', roles: [] }, rule)).toBe(false);
    expect(matchesRecipientRule({ isPrimary: false, siteId: null, roles: ['billing'] }, rule)).toBe(true);
    expect(matchesRecipientRule({ isPrimary: false, siteId: null, roles: ['technical'] }, rule)).toBe(false);
  });
});

describe('targets and defaults', () => {
  const detail: SeriesDetail = {
    series: {
      id: 's-1', name: 'Monthly health', type: 'device_inventory', format: 'pdf', schedule: 'monthly',
      config: { schedule: { time: '07:30', day: 'monday', date: '3' }, dateRange: { preset: 'last_7_days' } },
      targetMode: 'all', recipientRule: { primaryContact: true, roles: ['technical'] }, internalCc: ['ops@msp.example'],
      revision: 2, enabled: true, ownerUserId: 'u-1', createdAt: '', updatedAt: '',
    },
    targets: ['o-2'],
    orgs: [],
  };
  it('compares targets ignoring order', () => {
    expect(sameTargets({ targetMode: 'all', orgIds: ['a', 'b'] }, { targetMode: 'all', orgIds: ['b', 'a'] })).toBe(true);
    expect(sameTargets({ targetMode: 'all', orgIds: ['a'] }, { targetMode: 'selected', orgIds: ['a'] })).toBe(false);
  });
  it('accepts only recurring schedules', () => {
    expect(['daily', 'weekly', 'monthly'].every((v) => isSeriesSchedule(v))).toBe(true);
    expect(isSeriesSchedule('one_time')).toBe(false);
    expect(isSeriesSchedule(undefined)).toBe(false);
  });
  it('picks the first covered org for the live preview', () => {
    const orgs = [{ id: 'a' }, { id: 'b' }];
    expect(firstCoveredOrgId({ targetMode: 'all', orgIds: ['a'] }, orgs)).toBe('b');
    expect(firstCoveredOrgId({ targetMode: 'selected', orgIds: ['b'] }, orgs)).toBe('b');
    expect(firstCoveredOrgId({ targetMode: 'selected', orgIds: [] }, orgs)).toBeNull();
  });
  it('rebuilds the Covers value and the builder defaults from a stored series', () => {
    expect(coversFromSeries(detail)).toEqual({
      mode: 'series', targetMode: 'all', orgIds: ['o-2'],
      recipientRule: { primaryContact: true, roles: ['technical'] }, internalCc: ['ops@msp.example'],
    });
    expect(seriesBuilderDefaults(detail.series)).toMatchObject({
      name: 'Monthly health', type: 'device_inventory', schedule: 'monthly', format: 'pdf',
      scheduleTime: '07:30', scheduleDay: 'monday', scheduleDate: '3', dateRange: { preset: 'last_7_days' },
    });
  });
});
