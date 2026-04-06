import { describe, it, expect } from 'vitest';
import {
  fileTargetsSchema,
  hypervTargetsSchema,
  mssqlTargetsSchema,
  systemImageTargetsSchema,
  backupInlineSettingsSchema,
  backupScheduleSchema,
  backupRetentionSchema,
} from './backupTargets';

describe('fileTargetsSchema', () => {
  it('accepts valid file targets', () => {
    const result = fileTargetsSchema.safeParse({
      paths: ['/Users', '/etc'],
      excludes: ['*.tmp'],
    });
    expect(result.success).toBe(true);
  });

  it('requires at least one path', () => {
    const result = fileTargetsSchema.safeParse({ paths: [] });
    expect(result.success).toBe(false);
  });

  it('excludes is optional', () => {
    const result = fileTargetsSchema.safeParse({ paths: ['/data'] });
    expect(result.success).toBe(true);
    expect(result.data?.excludes).toBeUndefined();
  });
});

describe('hypervTargetsSchema', () => {
  it('accepts valid hyperv targets', () => {
    const result = hypervTargetsSchema.safeParse({
      consistencyType: 'application',
    });
    expect(result.success).toBe(true);
  });

  it('defaults consistencyType to application', () => {
    const result = hypervTargetsSchema.safeParse({});
    expect(result.success).toBe(true);
    expect(result.data?.consistencyType).toBe('application');
  });

  it('defaults excludeVms to empty array', () => {
    const result = hypervTargetsSchema.safeParse({});
    expect(result.success).toBe(true);
    expect(result.data?.excludeVms).toEqual([]);
  });

  it('accepts excludeVms list', () => {
    const result = hypervTargetsSchema.safeParse({
      excludeVms: ['TestVM', 'DevVM'],
    });
    expect(result.success).toBe(true);
    expect(result.data?.excludeVms).toEqual(['TestVM', 'DevVM']);
  });
});

describe('mssqlTargetsSchema', () => {
  it('accepts valid mssql targets', () => {
    const result = mssqlTargetsSchema.safeParse({
      backupType: 'full',
    });
    expect(result.success).toBe(true);
  });

  it('defaults backupType to full', () => {
    const result = mssqlTargetsSchema.safeParse({});
    expect(result.success).toBe(true);
    expect(result.data?.backupType).toBe('full');
  });

  it('defaults excludeDatabases to empty array', () => {
    const result = mssqlTargetsSchema.safeParse({});
    expect(result.success).toBe(true);
    expect(result.data?.excludeDatabases).toEqual([]);
  });

  it('accepts differential and log backup types', () => {
    expect(
      mssqlTargetsSchema.safeParse({ backupType: 'differential' }).success
    ).toBe(true);
    expect(
      mssqlTargetsSchema.safeParse({ backupType: 'log' }).success
    ).toBe(true);
  });

  it('rejects invalid backupType', () => {
    const result = mssqlTargetsSchema.safeParse({
      backupType: 'incremental',
    });
    expect(result.success).toBe(false);
  });
});

describe('systemImageTargetsSchema', () => {
  it('defaults includeSystemState to true', () => {
    const result = systemImageTargetsSchema.safeParse({});
    expect(result.success).toBe(true);
    expect(result.data?.includeSystemState).toBe(true);
  });

  it('accepts explicit false', () => {
    const result = systemImageTargetsSchema.safeParse({
      includeSystemState: false,
    });
    expect(result.success).toBe(true);
    expect(result.data?.includeSystemState).toBe(false);
  });
});

describe('backupInlineSettingsSchema', () => {
  it('validates file mode with matching targets', () => {
    const result = backupInlineSettingsSchema.safeParse({
      backupMode: 'file',
      targets: { paths: ['/data'] },
      schedule: { frequency: 'daily', time: '02:00' },
      retention: { keepDaily: 7 },
    });
    expect(result.success).toBe(true);
  });

  it('validates hyperv mode with matching targets', () => {
    const result = backupInlineSettingsSchema.safeParse({
      backupMode: 'hyperv',
      targets: { consistencyType: 'application' },
      schedule: { frequency: 'daily', time: '02:00' },
    });
    expect(result.success).toBe(true);
  });

  it('rejects hyperv mode with invalid targets', () => {
    const result = backupInlineSettingsSchema.safeParse({
      backupMode: 'hyperv',
      targets: { consistencyType: 'invalid_type' },
      schedule: { frequency: 'daily', time: '02:00' },
    });
    expect(result.success).toBe(false);
  });

  it('defaults backupMode to file when omitted', () => {
    const result = backupInlineSettingsSchema.safeParse({
      targets: { paths: ['/data'] },
      schedule: { frequency: 'daily', time: '02:00' },
    });
    expect(result.success).toBe(true);
    expect(result.data?.backupMode).toBe('file');
  });

  it('validates backup windows and retention settings', () => {
    const result = backupInlineSettingsSchema.safeParse({
      backupMode: 'file',
      targets: { paths: ['/data'], excludes: ['*.tmp'] },
      paths: ['/data'],
      schedule: {
        frequency: 'weekly',
        time: '02:00',
        dayOfWeek: 1,
        windowStart: '01:00',
        windowEnd: '05:00',
      },
      retention: {
        preset: 'custom',
        retentionDays: 45,
        maxVersions: 12,
        keepDaily: 14,
        keepWeekly: 8,
        keepMonthly: 12,
        keepYearly: 3,
        weeklyDay: 1,
      },
    });
    expect(result.success).toBe(true);
  });
});

describe('backupScheduleSchema', () => {
  it('rejects invalid backup window values', () => {
    const result = backupScheduleSchema.safeParse({
      frequency: 'daily',
      time: '02:00',
      windowStart: 'bad',
    });
    expect(result.success).toBe(false);
  });
});

describe('backupRetentionSchema', () => {
  it('accepts derived retention values used by the config-policy tab', () => {
    const result = backupRetentionSchema.safeParse({
      preset: 'standard',
      retentionDays: 30,
      maxVersions: 5,
      keepDaily: 7,
      keepWeekly: 4,
      keepMonthly: 12,
      keepYearly: 3,
      weeklyDay: 0,
      legalHold: true,
      legalHoldReason: 'Regulatory matter',
      immutabilityMode: 'application',
      immutableDays: 90,
    });
    expect(result.success).toBe(true);
  });

  it('requires a reason when legal hold is enabled', () => {
    const result = backupRetentionSchema.safeParse({
      legalHold: true,
    });
    expect(result.success).toBe(false);
  });

  it('requires immutableDays when application immutability is enabled', () => {
    const result = backupRetentionSchema.safeParse({
      immutabilityMode: 'application',
    });
    expect(result.success).toBe(false);
  });
});
