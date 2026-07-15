import { describe, expect, it } from 'vitest';
import {
  createReportSchema,
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
