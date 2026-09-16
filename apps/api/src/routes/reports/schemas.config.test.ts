import { describe, expect, it } from 'vitest';
import {
  createReportSchema,
  endpointManagementConfigFields,
  endpointManagementConfigSchema,
  hardwareLifecycleConfigFields,
  hardwareLifecycleConfigSchema,
  securityCompliancePostureConfigFields,
  securityCompliancePostureConfigSchema,
  updateReportSchema,
} from './schemas';

const builderConfig = {
  builderType: 'device_inventory',
  dataSource: 'devices',
  columns: ['hostname'],
  filterConditions: [{ field: 'status', operator: 'eq', value: 'online' }],
  schedule: { time: '09:00', day: 'monday', date: '1' },
  exportFormats: ['pdf'],
  emailRecipients: ['client@example.com', 'msp@example.com'],
};

describe('report config schema', () => {
  it('preserves schedule detail and emailRecipients on create', () => {
    const parsed = createReportSchema.parse({
      name: 'Monthly posture',
      type: 'security_compliance_posture',
      schedule: 'monthly',
      format: 'pdf',
      config: builderConfig,
    });
    expect(parsed.config.schedule).toEqual({ time: '09:00', day: 'monday', date: '1' });
    expect(parsed.config.emailRecipients).toEqual(['client@example.com', 'msp@example.com']);
    // Builder metadata must round-trip for the edit page.
    expect((parsed.config as Record<string, unknown>).builderType).toBe('device_inventory');
    expect((parsed.config as Record<string, unknown>).exportFormats).toEqual(['pdf']);
  });

  it('rejects malformed recipients and times', () => {
    expect(() =>
      createReportSchema.parse({
        name: 'x', type: 'compliance',
        config: { emailRecipients: ['not-an-email'] },
      })
    ).toThrow();
    expect(() =>
      createReportSchema.parse({
        name: 'x', type: 'compliance',
        config: { emailRecipients: ['a@b'] },
      })
    ).toThrow();
    expect(() =>
      createReportSchema.parse({
        name: 'x', type: 'compliance',
        config: { schedule: { time: '25:99' } },
      })
    ).toThrow();
  });

  // Same loose chip regex as ReportBuilder/recipientsOf — persistence must
  // never reject what the builder already accepted as a chip.
  it('accepts a unicode-local-part address, matching the builder chip validator', () => {
    const parsed = createReportSchema.parse({
      name: 'x', type: 'compliance',
      config: { emailRecipients: ['jörg@example.com'] },
    });
    expect(parsed.config.emailRecipients).toEqual(['jörg@example.com']);
  });

  it('validates config on update too (was z.any())', () => {
    expect(() =>
      updateReportSchema.parse({ config: { emailRecipients: ['nope'] } })
    ).toThrow();
    const ok = updateReportSchema.parse({ config: builderConfig });
    expect(ok.config?.emailRecipients).toHaveLength(2);
  });

  it('coerces a legacy numeric schedule.date to string on both create and update', () => {
    const created = createReportSchema.parse({
      name: 'x', type: 'compliance',
      config: { schedule: { date: 1 } },
    });
    expect(created.config.schedule).toEqual({ date: '1' });

    const updated = updateReportSchema.parse({ config: { schedule: { date: 1 } } });
    expect(updated.config?.schedule).toEqual({ date: '1' });
  });

  // The generation schema (with defaults) and the persistence field map are
  // maintained by hand. Drift is silent and one-directional: a key added to the
  // former but not the latter is stripped on save, then silently reappears at
  // generation as its default — the user's setting quietly ignored.
  it('keeps the posture persistence fields in sync with the generation schema', () => {
    expect(Object.keys(securityCompliancePostureConfigFields).sort()).toEqual(
      Object.keys(securityCompliancePostureConfigSchema.shape).sort(),
    );
  });

  it('keeps the hardware lifecycle persistence fields in sync with the generation schema', () => {
    expect(Object.keys(hardwareLifecycleConfigFields).sort()).toEqual(
      Object.keys(hardwareLifecycleConfigSchema.shape).sort(),
    );
  });

  it('keeps the endpoint management persistence fields in sync with the generation schema', () => {
    expect(Object.keys(endpointManagementConfigFields).sort()).toEqual(
      Object.keys(endpointManagementConfigSchema.shape).sort(),
    );
  });

  it('defaults an endpoint management config', () => {
    expect(endpointManagementConfigSchema.parse({})).toEqual({
      sites: [], staleEnrolmentDays: 14, trendDays: 30, includeLicences: true,
    });
  });

  it('rejects an out-of-range trendDays', () => {
    expect(() => endpointManagementConfigSchema.parse({ trendDays: 0 })).toThrow();
    expect(() => endpointManagementConfigSchema.parse({ trendDays: 400 })).toThrow();
  });

  it('preserves endpoint management staleEnrolmentDays on create', () => {
    const parsed = createReportSchema.parse({
      name: 'Endpoints', type: 'endpoint_management_review',
      config: { staleEnrolmentDays: 30, includeLicences: false },
    });
    expect(parsed.config.staleEnrolmentDays).toBe(30);
    expect(parsed.config.includeLicences).toBe(false);
  });

  it('preserves hardware lifecycle replaceAgeYears on create', () => {
    const parsed = createReportSchema.parse({
      name: 'Lifecycle', type: 'hardware_lifecycle',
      config: { replaceAgeYears: 5, includeOtherEquipment: false },
    });
    expect(parsed.config.replaceAgeYears).toBe(5);
    expect(parsed.config.includeOtherEquipment).toBe(false);
  });

  it('round-trips serverReplaceAgeYears independently of replaceAgeYears on create', () => {
    const parsed = createReportSchema.parse({
      name: 'Lifecycle', type: 'hardware_lifecycle',
      config: { replaceAgeYears: 4, serverReplaceAgeYears: 6 },
    });
    expect(parsed.config.replaceAgeYears).toBe(4);
    expect(parsed.config.serverReplaceAgeYears).toBe(6);
  });

  it('rejects replaceAgeYears/serverReplaceAgeYears outside [1, 15] and non-integers', () => {
    for (const field of ['replaceAgeYears', 'serverReplaceAgeYears'] as const) {
      expect(() =>
        createReportSchema.parse({ name: 'x', type: 'hardware_lifecycle', config: { [field]: 0 } })
      ).toThrow();
      expect(() =>
        createReportSchema.parse({ name: 'x', type: 'hardware_lifecycle', config: { [field]: 16 } })
      ).toThrow();
      expect(() =>
        createReportSchema.parse({ name: 'x', type: 'hardware_lifecycle', config: { [field]: 4.5 } })
      ).toThrow();
    }
  });

  it('preserves posture backupRequired on create and update', () => {
    const created = createReportSchema.parse({
      name: 'Workstation posture',
      type: 'security_compliance_posture',
      schedule: 'one_time',
      format: 'pdf',
      config: { backupRequired: false },
    });
    expect(created.config.backupRequired).toBe(false);

    const updated = updateReportSchema.parse({
      config: { backupRequired: true },
    });
    expect(updated.config?.backupRequired).toBe(true);
  });
});
