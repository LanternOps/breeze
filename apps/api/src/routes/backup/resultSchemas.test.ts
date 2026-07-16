import { describe, expect, it } from 'vitest';
import { backupCommandResultSchema } from './resultSchemas';

describe('backupCommandResultSchema — system_image manifest', () => {
  it('parses a system_image result and preserves the manifest + backupType', () => {
    const parsed = backupCommandResultSchema.parse({
      jobId: 'job-1',
      snapshotId: 'snap-1',
      filesBackedUp: 13,
      bytesBackedUp: 103,
      backupType: 'system_image',
      systemStateManifest: {
        platform: 'windows',
        osVersion: 'Windows Server 2022',
        artifacts: [{ name: 'registry_SYSTEM', category: 'registry' }],
        hardwareProfile: { cpuCores: 4, totalMemoryMB: 8192 },
      },
    });
    expect(parsed.backupType).toBe('system_image');
    expect(parsed.systemStateManifest?.platform).toBe('windows');
    expect(parsed.systemStateManifest?.hardwareProfile).toEqual({ cpuCores: 4, totalMemoryMB: 8192 });
  });

  it('passes through an unmodeled manifest field instead of dropping/rejecting it (F13)', () => {
    // A forward-compatible agent may add manifest fields we do not model yet.
    // .passthrough() must keep them AND must not fail the parse — otherwise the
    // whole result is rejected and snapshot id / size are silently lost.
    const parsed = backupCommandResultSchema.parse({
      snapshotId: 'snap-1',
      systemStateManifest: { platform: 'windows', incompleteSteps: ['certs'], futureField: 42 },
    });
    expect(parsed.snapshotId).toBe('snap-1');
    expect((parsed.systemStateManifest as { futureField: number }).futureField).toBe(42);
    expect((parsed.systemStateManifest as { incompleteSteps: string[] }).incompleteSteps).toEqual(['certs']);
  });

  it('parses a plain file result with no manifest', () => {
    const parsed = backupCommandResultSchema.parse({
      snapshotId: 'snap-1',
      filesBackedUp: 5,
    });
    expect(parsed.systemStateManifest).toBeUndefined();
    expect(parsed.backupType).toBeUndefined();
  });

  it('rejects an invalid backupType', () => {
    expect(() =>
      backupCommandResultSchema.parse({ snapshotId: 'snap-1', backupType: 'bogus' }),
    ).toThrow();
  });
});
