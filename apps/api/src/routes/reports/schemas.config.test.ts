import { describe, expect, it } from 'vitest';
import { createReportSchema, updateReportSchema } from './schemas';

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
        config: { schedule: { time: '25:99' } },
      })
    ).toThrow();
  });

  it('validates config on update too (was z.any())', () => {
    expect(() =>
      updateReportSchema.parse({ config: { emailRecipients: ['nope'] } })
    ).toThrow();
    const ok = updateReportSchema.parse({ config: builderConfig });
    expect(ok.config?.emailRecipients).toHaveLength(2);
  });
});
