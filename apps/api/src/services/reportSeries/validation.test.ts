import { describe, expect, it } from 'vitest';
import { REPORT_TYPES } from '@breeze/shared';
import { INTERNAL_REPORT_TYPES, PARTNER_ONLY_DELIVERY_REPORT_TYPES } from '../../routes/reports/schemas';
import { ReportSeriesError } from './errors';
import { assertSeriesConfigOrgAgnostic, assertSeriesTypeSupported } from './validation';

function codeOf(fn: () => void): string | null {
  try {
    fn();
    return null;
  } catch (err) {
    return err instanceof ReportSeriesError ? err.code : `unexpected:${String(err)}`;
  }
}

describe('assertSeriesTypeSupported', () => {
  it('admits exactly the org-executable, user-authored, non-business types', () => {
    const supported = REPORT_TYPES.filter((type) => codeOf(() => assertSeriesTypeSupported(type)) === null);
    expect([...supported].sort()).toEqual([
      'alert_summary',
      'backup_status',
      'compliance',
      'device_inventory',
      'executive_summary',
      'hardware_lifecycle',
      'performance',
      'security_compliance_posture',
      'software_inventory',
    ]);
  });

  it('refuses every system-authored type the routes treat as internal', () => {
    for (const type of INTERNAL_REPORT_TYPES) {
      expect(codeOf(() => assertSeriesTypeSupported(type))).toBe('series_type_unsupported');
    }
  });

  it('refuses every business (partner-only delivery) type', () => {
    for (const type of PARTNER_ONLY_DELIVERY_REPORT_TYPES) {
      expect(codeOf(() => assertSeriesTypeSupported(type))).toBe('series_type_unsupported');
    }
  });

  it('refuses managed-evidence types and unknown strings', () => {
    for (const type of ['threat_detection_review', 'endpoint_management_review', 'vulnerability_management', 'identity_access_review', 'nope']) {
      expect(codeOf(() => assertSeriesTypeSupported(type))).toBe('series_type_unsupported');
    }
  });
});

describe('assertSeriesConfigOrgAgnostic', () => {
  it.each([
    [{ filters: { siteIds: ['11111111-1111-4111-8111-111111111111'] } }, 'filters.siteIds'],
    [{ filters: { deviceIds: ['11111111-1111-4111-8111-111111111111'] } }, 'filters.deviceIds'],
    [{ filters: { groupIds: ['g'] } }, 'filters.groupIds'],
    [{ sites: ['11111111-1111-4111-8111-111111111111'] }, 'sites'],
    [{ siteIds: ['s'] }, 'siteIds'],
    [{ deviceIds: ['d'] }, 'deviceIds'],
    [{ deviceGroupIds: ['g'] }, 'deviceGroupIds'],
    [{ orgId: '11111111-1111-4111-8111-111111111111' }, 'orgId'],
    [{ orgIds: ['o'] }, 'orgIds'],
    // W04 Review Focus #3: the builder's legacy filter round-trip and its
    // per-condition site field also name one org's objects.
    [{ legacyFilters: { deviceIds: ['d'] } }, 'legacyFilters.deviceIds'],
    [{ legacyFilters: { siteIds: ['s'] } }, 'legacyFilters.siteIds'],
    [{ filterConditions: [{ id: 'f1', logic: 'and', field: 'siteId', operator: 'is', value: 's' }] }, 'filterConditions.siteId'],
    [{ filterConditions: [{ id: 'f1', logic: 'and', field: 'site', operator: 'equals', value: 'HQ' }] }, 'filterConditions.site'],
  ])('refuses %j naming %s', (config, key) => {
    try {
      assertSeriesConfigOrgAgnostic(config);
      throw new Error('expected a refusal');
    } catch (err) {
      expect(err).toBeInstanceOf(ReportSeriesError);
      expect((err as ReportSeriesError).code).toBe('series_config_org_specific');
      expect((err as ReportSeriesError).status).toBe(400);
      expect((err as ReportSeriesError).body).toEqual({ key });
    }
  });

  it.each([
    [undefined],
    [{}],
    [{ filters: {} }],
    [{ filters: { siteIds: [] } }],
    [{ sites: [] }],
    [{ filters: { osTypes: ['windows'], severity: ['critical'] }, dateRange: { preset: 'last_30_days' }, columns: ['hostname'] }],
    [{ legacyFilters: {} , filterConditions: [{ id: 'f1', logic: 'and', field: 'severity', operator: 'is', value: 'critical' }] }],
  ])('admits an org-agnostic config %j', (config) => {
    expect(() => assertSeriesConfigOrgAgnostic(config)).not.toThrow();
  });

  it('refuses a non-object config', () => {
    expect(codeOf(() => assertSeriesConfigOrgAgnostic(['x']))).toBe('series_config_org_specific');
  });
});
