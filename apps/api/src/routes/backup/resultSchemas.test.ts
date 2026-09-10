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

// D15 Wave 1 finding #1: a state-only system_image run's ordinary manifest
// must publish `"files":[]`, never `"files":null` — the agent-side fix is at
// backup.go's state-only Snapshot literal. This documents the API-side half
// of that contract: `snapshot.files` is `z.array(...).optional()`, which
// accepts a MISSING key or an empty array, but Zod's `.optional()` rejects an
// explicit `null` — so a result that regressed back to emitting `null` would
// 400 and silently drop the whole job result (snapshot id, size, everything).
describe('backupCommandResultSchema — snapshot.files null-vs-empty contract (D15)', () => {
  it('parses a system_image result whose snapshot.files is an empty array', () => {
    const parsed = backupCommandResultSchema.parse({
      snapshotId: 'snap-1',
      backupType: 'system_image',
      systemStateManifest: {
        platform: 'linux',
        artifacts: [{ name: 'services_systemd', category: 'services' }],
      },
      snapshot: {
        id: 'snap-1',
        files: [],
      },
    });
    expect(parsed.snapshot?.files).toEqual([]);
    expect(parsed.systemStateManifest?.platform).toBe('linux');
  });

  it('rejects a result whose snapshot.files is null', () => {
    expect(() =>
      backupCommandResultSchema.parse({
        snapshotId: 'snap-1',
        backupType: 'system_image',
        snapshot: {
          id: 'snap-1',
          files: null,
        },
      }),
    ).toThrow();
  });
});

describe('backupCommandResultSchema — incremental-backup referenced stats', () => {
  it('accepts referencedBytes + referencedFiles from an agent that deduped files', () => {
    const parsed = backupCommandResultSchema.parse({
      snapshotId: 'snap-1',
      filesBackedUp: 3,
      bytesBackedUp: 1_000,
      referencedBytes: 50_000,
      referencedFiles: 17,
    });
    expect(parsed.referencedBytes).toBe(50_000);
    expect(parsed.referencedFiles).toBe(17);
  });

  it('leaves referencedBytes/referencedFiles undefined for an old-agent result that omits them', () => {
    const parsed = backupCommandResultSchema.parse({
      snapshotId: 'snap-1',
      filesBackedUp: 5,
    });
    expect(parsed.referencedBytes).toBeUndefined();
    expect(parsed.referencedFiles).toBeUndefined();
  });
});

// #3000: the agent's own terminal status is the ONLY channel through which a
// `partial` run can be distinguished — the outer command-result status is a
// binary completed/failed derived from a success bool.
describe('backupCommandResultSchema — agent terminal status (#3000)', () => {
  it('preserves a partial status from the agent payload', () => {
    const parsed = backupCommandResultSchema.parse({
      jobId: 'job-1',
      snapshotId: 'snap-1',
      status: 'partial',
      filesBackedUp: 1,
      bytesBackedUp: 85,
      errorCount: 21,
      warning: '21 of 22 files failed to upload',
    });
    expect(parsed.status).toBe('partial');
    expect(parsed.errorCount).toBe(21);
  });

  it('accepts an agent status outside the DB enum instead of rejecting the whole result', () => {
    // The agent's vocabulary is wider than backup_status (it also emits
    // `skipped`/`stopped`). A strict enum here would 400 the ENTIRE result,
    // losing the snapshot id and counters over a value we do not care about.
    const parsed = backupCommandResultSchema.parse({
      snapshotId: 'snap-1',
      status: 'skipped',
      filesBackedUp: 0,
    });
    expect(parsed.status).toBe('skipped');
    expect(parsed.snapshotId).toBe('snap-1');
  });

  it('treats a result with no status as an ordinary completion (legacy agent)', () => {
    const parsed = backupCommandResultSchema.parse({ snapshotId: 'snap-1', filesBackedUp: 3 });
    expect(parsed.status).toBeUndefined();
  });
});

describe('backupCommandResultSchema — VSS metadata (#3027)', () => {
  it('keeps the agent-reported vssMetadata instead of stripping it', () => {
    // Regression: the schema had no vssMetadata key, so zod's default strip
    // behaviour silently discarded the field at the first server-side parse and
    // backup_jobs.vss_metadata stayed an orphan column forever.
    const parsed = backupCommandResultSchema.parse({
      snapshotId: 'snap-1',
      status: 'completed',
      vssMetadata: {
        shadowCopyId: '{11111111-2222-3333-4444-555555555555}',
        creationTime: '2026-08-02T00:00:00Z',
        writers: [
          { name: 'SqlServerWriter', id: 'w-1', state: 'stable' },
          { name: 'NTDS', id: 'w-2', state: 'failed', lastError: 'timed out' },
        ],
        exposedPaths: { 'C:\\': '\\\\?\\GLOBALROOT\\Device\\HarddiskVolumeShadowCopy1' },
        unprotectedVolumes: ['D:\\'],
        warnings: ['volume D:\\ has no shadow copy'],
        durationMs: 4200,
      },
    });

    const vss = parsed.vssMetadata as Record<string, unknown>;
    expect(vss.shadowCopyId).toBe('{11111111-2222-3333-4444-555555555555}');
    expect(vss.writers).toHaveLength(2);
    expect(vss.unprotectedVolumes).toEqual(['D:\\']);
    expect(vss.durationMs).toBe(4200);
  });

  it('NEVER fails the result over a malformed vssMetadata — that would flip a good backup to failed', () => {
    // agentWs gates the recorded job status on this parse succeeding
    // (`result.status === 'completed' && parsedBackup.success`), so rejecting a
    // diagnostics blob would mark a backup that genuinely succeeded as failed
    // and strand its snapshot. Every shape must parse; validation happens in
    // sanitizeVssMetadata, one hop later.
    for (const vssMetadata of [
      { writers: 'not-an-array' },
      'a bare string',
      42,
      [],
      null,
      { writers: [{ name: { nested: 'object' } }] },
    ]) {
      const parsed = backupCommandResultSchema.safeParse({
        snapshotId: 'snap-1',
        bytesBackedUp: 42,
        vssMetadata,
      });
      expect(parsed.success).toBe(true);
      // The fields that matter still survive.
      expect(parsed.success && parsed.data.snapshotId).toBe('snap-1');
      expect(parsed.success && parsed.data.bytesBackedUp).toBe(42);
    }
  });

  it('leaves vssMetadata undefined for a non-Windows / VSS-disabled run', () => {
    const parsed = backupCommandResultSchema.parse({ snapshotId: 'snap-1', filesBackedUp: 3 });
    expect(parsed.vssMetadata).toBeUndefined();
  });
});

describe('backupCommandResultSchema — snapshot file manifest originalPath (D12)', () => {
  it('preserves originalPath on a snapshot file entry instead of stripping it', () => {
    // Regression: zod strips unrecognized object keys by default, so without a
    // modeled `originalPath` field the agent's stable, user-facing path for a
    // Windows VSS-backed file (as opposed to the transient shadow-copy device
    // path in sourcePath) was silently dropped at this parse — the very first
    // hop the field crosses — before backupResultPersistence.ts ever saw it.
    const parsed = backupCommandResultSchema.parse({
      snapshotId: 'snap-1',
      snapshot: {
        id: 'snap-1',
        files: [
          {
            sourcePath: '\\\\?\\GLOBALROOT\\Device\\HarddiskVolumeShadowCopy1\\assure\\src\\x',
            originalPath: 'C:\\assure\\src\\x',
            backupPath: 'snapshots/snap-1/files/x.gz',
          },
        ],
      },
    });

    expect(parsed.snapshot?.files?.[0]?.originalPath).toBe('C:\\assure\\src\\x');
    expect(parsed.snapshot?.files?.[0]?.sourcePath).toBe(
      '\\\\?\\GLOBALROOT\\Device\\HarddiskVolumeShadowCopy1\\assure\\src\\x'
    );
  });

  it('leaves originalPath undefined for a non-Windows / non-VSS run that omits it', () => {
    const parsed = backupCommandResultSchema.parse({
      snapshotId: 'snap-1',
      snapshot: {
        id: 'snap-1',
        files: [{ sourcePath: '/home/user/file.txt', backupPath: 'snapshots/snap-1/files/file.txt.gz' }],
      },
    });

    expect(parsed.snapshot?.files?.[0]?.originalPath).toBeUndefined();
    expect(parsed.snapshot?.files?.[0]?.sourcePath).toBe('/home/user/file.txt');
  });
});
