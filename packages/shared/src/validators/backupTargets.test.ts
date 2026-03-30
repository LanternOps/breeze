import { describe, it, expect } from 'vitest';
import {
  fileTargetsSchema,
  hypervTargetsSchema,
  mssqlTargetsSchema,
  systemImageTargetsSchema,
  backupInlineSettingsSchema,
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
      exportPath: 'D:\\Backups\\VMs',
      consistencyType: 'application',
    });
    expect(result.success).toBe(true);
  });

  it('defaults consistencyType to application', () => {
    const result = hypervTargetsSchema.safeParse({
      exportPath: 'D:\\Backups',
    });
    expect(result.success).toBe(true);
    expect(result.data?.consistencyType).toBe('application');
  });

  it('defaults excludeVms to empty array', () => {
    const result = hypervTargetsSchema.safeParse({
      exportPath: 'D:\\Backups',
    });
    expect(result.success).toBe(true);
    expect(result.data?.excludeVms).toEqual([]);
  });

  it('rejects empty exportPath', () => {
    const result = hypervTargetsSchema.safeParse({ exportPath: '' });
    expect(result.success).toBe(false);
  });

  it('accepts excludeVms list', () => {
    const result = hypervTargetsSchema.safeParse({
      exportPath: 'D:\\Backups',
      excludeVms: ['TestVM', 'DevVM'],
    });
    expect(result.success).toBe(true);
    expect(result.data?.excludeVms).toEqual(['TestVM', 'DevVM']);
  });
});

describe('mssqlTargetsSchema', () => {
  it('accepts valid mssql targets', () => {
    const result = mssqlTargetsSchema.safeParse({
      outputPath: 'D:\\SQLBackups',
      backupType: 'full',
    });
    expect(result.success).toBe(true);
  });

  it('defaults backupType to full', () => {
    const result = mssqlTargetsSchema.safeParse({
      outputPath: 'D:\\SQLBackups',
    });
    expect(result.success).toBe(true);
    expect(result.data?.backupType).toBe('full');
  });

  it('defaults excludeDatabases to empty array', () => {
    const result = mssqlTargetsSchema.safeParse({
      outputPath: 'D:\\SQLBackups',
    });
    expect(result.success).toBe(true);
    expect(result.data?.excludeDatabases).toEqual([]);
  });

  it('accepts differential and log backup types', () => {
    expect(
      mssqlTargetsSchema.safeParse({ outputPath: '/bak', backupType: 'differential' }).success
    ).toBe(true);
    expect(
      mssqlTargetsSchema.safeParse({ outputPath: '/bak', backupType: 'log' }).success
    ).toBe(true);
  });

  it('rejects invalid backupType', () => {
    const result = mssqlTargetsSchema.safeParse({
      outputPath: '/bak',
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
      targets: { exportPath: 'D:\\Backups' },
      schedule: { frequency: 'daily', time: '02:00' },
    });
    expect(result.success).toBe(true);
  });

  it('rejects hyperv mode with file targets', () => {
    const result = backupInlineSettingsSchema.safeParse({
      backupMode: 'hyperv',
      targets: { paths: ['/data'] },
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
});
