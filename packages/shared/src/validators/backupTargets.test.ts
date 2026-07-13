import { describe, it, expect } from 'vitest';
import {
  fileTargetsSchema,
  hypervTargetsSchema,
  mssqlTargetsSchema,
  systemImageTargetsSchema,
  backupInlineSettingsSchema,
  backupScheduleSchema,
  backupRetentionSchema,
  backupProfileSelectionsSchema,
  enabledBackupSelections,
  createBackupProfileSchema,
  updateBackupProfileSchema,
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

describe('backupProfileSelectionsSchema', () => {
  it('accepts a multi-source server profile', () => {
    const result = backupProfileSelectionsSchema.safeParse({
      file: { enabled: true, paths: ['C:\\Users'], excludes: ['*.tmp'] },
      system_image: { enabled: true },
      mssql: { enabled: true, backupType: 'full', excludeDatabases: ['tempdb'] },
    });
    expect(result.success).toBe(true);
  });

  it('rejects a profile with no enabled sources', () => {
    const result = backupProfileSelectionsSchema.safeParse({
      file: { enabled: false, paths: [] },
    });
    expect(result.success).toBe(false);
  });

  it('rejects file selection without paths', () => {
    const result = backupProfileSelectionsSchema.safeParse({
      file: { enabled: true, paths: [] },
    });
    expect(result.success).toBe(false);
  });

  // volumes is reserved for spec phase 3 (needs agent volume inventory). Until
  // job creation can expand it into paths, accepting it would fan out a file
  // job with zero paths — a backup that reports success and protects nothing.
  it('rejects volumes until job creation honors it', () => {
    const result = backupProfileSelectionsSchema.safeParse({
      file: { enabled: true, paths: [], volumes: 'all_fixed' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects volumes even alongside explicit paths', () => {
    const result = backupProfileSelectionsSchema.safeParse({
      file: { enabled: true, paths: ['C:\\Users'], volumes: ['C:'] },
    });
    expect(result.success).toBe(false);
  });
});

describe('enabledBackupSelections', () => {
  it('returns enabled sources in fan-out order', () => {
    const parsed = backupProfileSelectionsSchema.parse({
      hyperv: { enabled: true },
      file: { enabled: true, paths: ['/home'] },
      system_image: { enabled: false },
    });
    expect(enabledBackupSelections(parsed)).toEqual(['file', 'hyperv']);
  });
});

describe('createBackupProfileSchema', () => {
  it('defaults ownerScope to organization', () => {
    const result = createBackupProfileSchema.safeParse({
      name: 'Server',
      selections: { file: { enabled: true, paths: ['C:\\Users'] } },
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.ownerScope).toBe('organization');
  });

  it('rejects an empty name', () => {
    const result = createBackupProfileSchema.safeParse({
      name: '  ',
      selections: { file: { enabled: true, paths: ['/data'] } },
    });
    expect(result.success).toBe(false);
  });
});

describe('updateBackupProfileSchema', () => {
  it('has no ownerScope field (ownership axis is immutable)', () => {
    const result = updateBackupProfileSchema.safeParse({
      name: 'Renamed',
      ownerScope: 'partner',
    });
    // Unknown keys are stripped, not errors — assert it does not pass through.
    expect(result.success).toBe(true);
    if (result.success) {
      expect('ownerScope' in result.data).toBe(false);
    }
  });

  it('validates selections when provided', () => {
    const result = updateBackupProfileSchema.safeParse({
      selections: { file: { enabled: true, paths: [] } },
    });
    expect(result.success).toBe(false);
  });
});

// ── Exclusion-glob validation at the API boundary (#2473) ───────────────────
//
// The dialect itself is pinned by the cross-language contract in
// utils/backupExclusionGlob.test.ts (+ the Go half). These tests only assert
// the WIRING: that both entry points reject what the agent would drop, strip
// blank lines, and leave the optional/[] distinction intact.

describe('backup exclusion glob validation (#2473)', () => {
  describe('fileTargetsSchema.excludes', () => {
    it('accepts the OS-preset patterns shipped by the UI', () => {
      const result = fileTargetsSchema.safeParse({
        paths: ['/data'],
        excludes: ['*.tmp', 'Thumbs.db', 'node_modules/**', '**/AppData/Local/Temp/**'],
      });
      expect(result.success).toBe(true);
    });

    it('rejects a glob the agent would silently ignore', () => {
      // Valid in bash/minimatch; ErrBadPattern in the agent's path.Match dialect.
      const result = fileTargetsSchema.safeParse({
        paths: ['/data'],
        excludes: ['[a-z0-9_-].log'],
      });
      expect(result.success).toBe(false);
      expect(result.error?.issues[0]?.path).toEqual(['excludes', 0]);
      expect(result.error?.issues[0]?.message).toMatch(/silently exclude nothing/);
    });

    it('points at the offending index, not the whole array', () => {
      const result = fileTargetsSchema.safeParse({
        paths: ['/data'],
        excludes: ['*.tmp', 'node_modules/**', 'logs/[a-'],
      });
      expect(result.success).toBe(false);
      expect(result.error?.issues[0]?.path).toEqual(['excludes', 2]);
    });

    it('strips blank entries instead of failing the save', () => {
      // A textarea split on newlines produces these. Rejecting them would be an
      // over-strict regression that breaks a working configuration.
      const result = fileTargetsSchema.safeParse({
        paths: ['/data'],
        excludes: ['*.tmp', '', '   ', 'node_modules/**'],
      });
      expect(result.success).toBe(true);
      expect(result.data?.excludes).toEqual(['*.tmp', 'node_modules/**']);
    });

    it('accepts merely-unusual patterns the agent accepts', () => {
      // Over-strict validation is the worse failure mode: these all compile in
      // the agent, so blocking them would break a save that works today.
      const result = fileTargetsSchema.safeParse({
        paths: ['/data'],
        excludes: ['[z-a]', '[!a-z].txt', 'AppData\\Local\\Temp', 'temp\\'],
      });
      expect(result.success).toBe(true);
    });

    it('keeps omitted distinct from empty', () => {
      // undefined = fall back to agent-local excludes; [] = no exclusions.
      expect(fileTargetsSchema.safeParse({ paths: ['/d'] }).data?.excludes).toBeUndefined();
      expect(fileTargetsSchema.safeParse({ paths: ['/d'], excludes: [] }).data?.excludes).toEqual([]);
    });
  });

  describe('backupProfileSelectionsSchema.file.excludes', () => {
    it('rejects a malformed glob on a profile', () => {
      const result = backupProfileSelectionsSchema.safeParse({
        file: { enabled: true, paths: ['C:\\Users'], excludes: ['a[x/y]b'] },
      });
      expect(result.success).toBe(false);
      expect(result.error?.issues[0]?.path).toEqual(['file', 'excludes', 0]);
    });

    it('strips blank entries on a profile too', () => {
      const result = backupProfileSelectionsSchema.safeParse({
        file: { enabled: true, paths: ['C:\\Users'], excludes: ['*.tmp', ''] },
      });
      expect(result.success).toBe(true);
      expect(result.data?.file?.excludes).toEqual(['*.tmp']);
    });
  });
});
