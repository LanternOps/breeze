import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { REPORT_TYPES } from '@breeze/shared';
import { reportConfigSchema } from './schemas';

/**
 * The shape `reportConfigSchema` had BEFORE the registry split: one loose
 * object over every declared key. Frozen here as a test-only fixture so the
 * discriminated lookup can be compared against what actually shipped.
 */
const LEGACY_LOOSE = z.looseObject({
  dateRange: z.object({ start: z.string().optional(), end: z.string().optional(),
    preset: z.enum(['last_7_days', 'last_30_days', 'last_90_days', 'custom']).optional() }).optional(),
  filters: z.object({ siteIds: z.array(z.string().guid()).optional(),
    deviceIds: z.array(z.string().guid()).optional(),
    osTypes: z.array(z.enum(['windows', 'macos', 'linux'])).optional(),
    status: z.array(z.string()).optional(), severity: z.array(z.string()).optional() }).optional(),
  columns: z.array(z.string()).optional(), groupBy: z.string().optional(),
  sortBy: z.string().optional(), sortOrder: z.enum(['asc', 'desc']).optional(),
  schedule: z.object({ time: z.string().optional(), day: z.string().optional(),
    date: z.coerce.string().optional() }).optional(),
  emailRecipients: z.array(z.string().max(254)).max(50).optional(),
  sites: z.array(z.string().guid()).optional(), windowDays: z.number().int().optional(),
  minPasswordLength: z.number().int().optional(), maxLocalAdmins: z.number().int().optional(),
  maxAvDefinitionsAgeDays: z.number().int().optional(), maxSecurityStatusAgeDays: z.number().int().optional(),
  includeCis: z.boolean().optional(), backupRequired: z.boolean().optional(),
  replaceAgeYears: z.number().int().optional(), serverReplaceAgeYears: z.number().int().optional(),
  includeManualAssets: z.boolean().optional(), includeOtherEquipment: z.boolean().optional(),
  includeCarriedIn: z.boolean().optional(), topIncidents: z.number().int().optional(),
  staleEnrolmentDays: z.number().int().optional(), trendDays: z.number().int().optional(),
  includeLicences: z.boolean().optional(),
  severityFloor: z.enum(['critical', 'high', 'medium', 'low']).optional(),
  topN: z.number().int().optional(), includeAccepted: z.boolean().optional(),
  dormantDays: z.number().int().optional(), homeCountries: z.array(z.string()).optional(),
  adminDetail: z.boolean().optional(),
});

/** Presentation metadata the builder round-trips through `config`. NONE of it
 *  is declared by any schema; all of it must survive. */
const BUILDER_METADATA = {
  builderType: 'devices', dataSource: { devices: true }, filterConditions: [],
  aggregation: 'count', chartType: 'bar', exportFormats: ['csv'], templateName: 'My template',
} as const;

/** One realistic stored config per type — the shapes that are actually in
 *  `reports.config` on production rows today. */
const FIXTURES: Record<string, Record<string, unknown>> = {
  device_inventory: { ...BUILDER_METADATA, columns: ['hostname'], sortBy: 'hostname', sortOrder: 'asc',
    filters: { siteIds: [], osTypes: ['windows'] }, schedule: { time: '07:00', day: 'monday' },
    emailRecipients: ['ops@example.com'] },
  software_inventory: { ...BUILDER_METADATA, dateRange: { preset: 'last_30_days' } },
  alert_summary: { ...BUILDER_METADATA, dateRange: { preset: 'last_7_days' }, groupBy: 'severity' },
  compliance: { ...BUILDER_METADATA },
  performance: { ...BUILDER_METADATA, dateRange: { start: '2026-08-01', end: '2026-08-31' } },
  executive_summary: { dateRange: { preset: 'last_30_days' }, filters: { siteIds: [] } },
  security_compliance_posture: { dateRange: { preset: 'last_30_days' }, sites: [], windowDays: 30,
    minPasswordLength: 8, maxLocalAdmins: 2, maxAvDefinitionsAgeDays: 7, maxSecurityStatusAgeDays: 30,
    includeCis: true, backupRequired: true },
  ai_org_narrative: { sourceAiAgentScheduleId: 'x' },
  ai_fleet_design: {},
  hardware_lifecycle: { sites: [], replaceAgeYears: 4, serverReplaceAgeYears: 5,
    includeManualAssets: true, includeOtherEquipment: true },
  threat_detection_review: { sites: [], includeCarriedIn: true, topIncidents: 100 },
  endpoint_management_review: { sites: [], staleEnrolmentDays: 14, trendDays: 30, includeLicences: true },
  vulnerability_management: { sites: [], severityFloor: 'high', topN: 25, includeAccepted: true },
  identity_access_review: { dormantDays: 45, homeCountries: ['US'], adminDetail: true },
  ticket_sla_attainment: { period: { kind: 'last_full_month' }, groupBy: 'organization', includeNoSla: true },
  technician_time_billability: { period: { kind: 'last_30_days' }, groupBy: 'technician', weeklyCapacityHours: 40 },
  ar_aging: { groupBy: 'organization', includePaidInPeriod: false },
};

describe('reportConfigSchema — discriminated lookup keeps the loose contract', () => {
  it('has a fixture for every report type', () => {
    expect(Object.keys(FIXTURES).sort()).toEqual([...REPORT_TYPES].sort());
  });

  for (const type of REPORT_TYPES) {
    it(`${type}: parses, and drops no key the old loose schema kept`, () => {
      const fixture = FIXTURES[type]!;
      const before = LEGACY_LOOSE.parse(fixture);
      const after = reportConfigSchema.parse({ ...fixture, type });
      for (const key of Object.keys(before)) {
        expect(after, `${type}.${key} was dropped`).toHaveProperty(key);
        expect(after[key as keyof typeof after]).toEqual(before[key as keyof typeof before]);
      }
    });

    it(`${type}: keeps undeclared builder metadata`, () => {
      const after = reportConfigSchema.parse({ ...FIXTURES[type]!, ...BUILDER_METADATA, type });
      for (const key of Object.keys(BUILDER_METADATA)) expect(after).toHaveProperty(key);
    });
  }

  it('a config with no `type` discriminator still parses (legacy rows and PATCHes)', () => {
    const after = reportConfigSchema.parse({ ...BUILDER_METADATA, columns: ['hostname'] });
    expect(after).toHaveProperty('builderType');
    expect(after).toHaveProperty('columns');
  });

  it('applies the OWNING type\'s validation — a bad posture windowDays is rejected on posture', () => {
    expect(() => reportConfigSchema.parse({ type: 'security_compliance_posture', windowDays: 9999 })).toThrow();
  });

  it('DELIBERATE LOOSENING: a foreign key is passed through, not validated, on another type', () => {
    // Before the split this threw (one spread object validated every key).
    // Now it is an undeclared passthrough key. Recorded so nobody "fixes" it
    // into a strict schema and silently deletes builder metadata.
    const after = reportConfigSchema.parse({ type: 'device_inventory', windowDays: 9999 });
    expect(after).toMatchObject({ windowDays: 9999 });
  });
});
