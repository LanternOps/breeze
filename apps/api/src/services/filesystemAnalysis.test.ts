import { PgDialect } from 'drizzle-orm/pg-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../db', () => ({
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn() },
}));

import { db } from '../db';
import {
  readPlanScanPath,
  upsertFilesystemScanState,
  setFilesystemScanGeneration,
  clearFilesystemScanGeneration,
  claimFilesystemScanGeneration,
  buildCleanupPreview,
  mergeFilesystemAnalysisPayload,
  readPlanPreviewCandidates,
  readExecutedActions,
} from './filesystemAnalysis';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('filesystemAnalysis service', () => {
  it('builds safe cleanup preview from snapshot candidates', () => {
    const snapshot = {
      id: 'snap-1',
      cleanupCandidates: [
        { path: '/tmp/a.tmp', category: 'temp_files', sizeBytes: 100, safe: true },
        { path: '/tmp/a.tmp', category: 'temp_files', sizeBytes: 80, safe: true },
        { path: '/cache/b.bin', category: 'browser_cache', sizeBytes: 200, safe: true },
        { path: '/unsafe/c.log', category: 'logs', sizeBytes: 999, safe: true },
        { path: '/tmp/d.tmp', category: 'temp_files', sizeBytes: 50, safe: false }
      ]
    };

    const preview = buildCleanupPreview(snapshot);

    expect(preview.snapshotId).toBe('snap-1');
    expect(preview.candidateCount).toBe(2);
    expect(preview.estimatedBytes).toBe(300);
    expect(preview.candidates[0]?.path).toBe('/cache/b.bin');
    expect(preview.candidates[1]?.path).toBe('/tmp/a.tmp');
  });

  it('filters cleanup preview by requested categories', () => {
    const snapshot = {
      id: 'snap-2',
      cleanupCandidates: [
        { path: '/tmp/a.tmp', category: 'temp_files', sizeBytes: 100, safe: true },
        { path: '/cache/b.bin', category: 'browser_cache', sizeBytes: 200, safe: true }
      ]
    };

    const preview = buildCleanupPreview(snapshot, ['temp_files']);
    expect(preview.candidateCount).toBe(1);
    expect(preview.estimatedBytes).toBe(100);
    expect(preview.candidates[0]?.category).toBe('temp_files');
  });

  describe('readPlanPreviewCandidates', () => {
    it('extracts only safe candidates in known categories from a stored plan', () => {
      const plan = {
        preview: {
          candidates: [
            { path: '/tmp/a.tmp', category: 'temp_files', sizeBytes: 100, safe: true },
            { path: '/unsafe/c.log', category: 'logs', sizeBytes: 999, safe: true },
            { path: '/tmp/d.tmp', category: 'temp_files', sizeBytes: 50, safe: false },
          ],
        },
      };

      const candidates = readPlanPreviewCandidates(plan);
      expect(candidates).toHaveLength(1);
      expect(candidates[0]?.path).toBe('/tmp/a.tmp');
    });

    it('returns [] for malformed or empty plans', () => {
      expect(readPlanPreviewCandidates(null)).toEqual([]);
      expect(readPlanPreviewCandidates({})).toEqual([]);
      expect(readPlanPreviewCandidates({ preview: {} })).toEqual([]);
      expect(readPlanPreviewCandidates({ preview: { candidates: 'nope' } })).toEqual([]);
    });
  });

  describe('mergeFilesystemAnalysisPayload — checkpoint is the current run, not accumulated', () => {
    it('clears a stale checkpoint when the completing run omits it', () => {
      // Prior run left a checkpoint in the aggregate; the completing resume run
      // omits checkpoint (Go omitempty). The merged payload must NOT inherit the
      // stale pending dirs, or the baseline could never register as complete.
      const existing = { checkpoint: { pendingDirs: [{ path: '/a', depth: 1 }] } };
      const incoming = { summary: { filesScanned: 5 } }; // no checkpoint key

      const merged = mergeFilesystemAnalysisPayload(existing, incoming);
      expect(merged.checkpoint).toEqual({});
    });

    it('carries the incoming run checkpoint through', () => {
      const existing = {};
      const incoming = { checkpoint: { pendingDirs: [{ path: '/b', depth: 2 }] } };

      const merged = mergeFilesystemAnalysisPayload(existing, incoming);
      expect(merged.checkpoint).toEqual({ pendingDirs: [{ path: '/b', depth: 2 }] });
    });
  });
});

describe('readExecutedActions', () => {
  it('reads the new envelope', () => {
    expect(readExecutedActions({ partial: true, budgetMs: 240_000, actions: [{ path: '/tmp/a' }] })).toEqual({
      partial: true,
      budgetMs: 240_000,
      actions: [{ path: '/tmp/a' }],
    });
  });

  it('reads a legacy bare array, so pre-W01 runs still render', () => {
    expect(readExecutedActions([{ path: '/tmp/a', status: 'completed' }])).toEqual({
      partial: false,
      budgetMs: 0,
      actions: [{ path: '/tmp/a', status: 'completed' }],
    });
  });

  it('is total over junk', () => {
    expect(readExecutedActions(null)).toEqual({ partial: false, budgetMs: 0, actions: [] });
    expect(readExecutedActions('nope')).toEqual({ partial: false, budgetMs: 0, actions: [] });
    expect(readExecutedActions({ partial: 'yes', actions: 'nope' })).toEqual({ partial: false, budgetMs: 0, actions: [] });
  });
});

describe('mergeFilesystemAnalysisPayload summary', () => {
  it('carries duplicateTrackingTruncated across a checkpoint-resumed baseline', () => {
    const merged = mergeFilesystemAnalysisPayload(
      { summary: { filesScanned: 1, duplicateTrackingTruncated: true } },
      { summary: { filesScanned: 2 } },
    );
    const summary = merged.summary as Record<string, unknown>;
    expect(summary.filesScanned).toBe(3);
    // The five-field rebuild used to drop this, so a resumed baseline reported
    // "no duplicates" where the agent had actually stopped looking.
    expect(summary.duplicateTrackingTruncated).toBe(true);
  });

  it('leaves the flag off when neither half set it', () => {
    const merged = mergeFilesystemAnalysisPayload({ summary: {} }, { summary: {} });
    expect((merged.summary as Record<string, unknown>).duplicateTrackingTruncated).toBe(false);
  });
});

describe('readPlanScanPath', () => {
  it('reads the scan path a preview pinned into its stored plan', () => {
    expect(readPlanScanPath({ snapshotId: 's', scanPath: 'D:\\', preview: {} })).toBe('D:\\');
  });

  it('returns null for a plan with no pinned path, so the caller can fall back explicitly', () => {
    expect(readPlanScanPath({ snapshotId: 's' })).toBeNull();
    expect(readPlanScanPath(null)).toBeNull();
    expect(readPlanScanPath('not an object')).toBeNull();
    expect(readPlanScanPath({ scanPath: '' })).toBeNull();
    expect(readPlanScanPath({ scanPath: 42 })).toBeNull();
  });
});

describe('upsertFilesystemScanState — conflict target (spec §4 writer contract)', () => {
  it('conflicts on (deviceId, scanPath), not on deviceId alone', async () => {
    const onConflictDoUpdate = vi.fn().mockReturnValue({
      returning: vi.fn().mockResolvedValue([{ deviceId: 'device-1', scanPath: 'D:\\' }]),
    });
    const values = vi.fn().mockReturnValue({ onConflictDoUpdate });
    const insert = vi.fn().mockReturnValue({ values });
    vi.mocked(db.insert).mockImplementation(insert as never);

    await upsertFilesystemScanState('device-1', 'org-1', 'D:\\', { lastRunMode: 'baseline' });

    expect(values).toHaveBeenCalledWith(expect.objectContaining({
      deviceId: 'device-1',
      orgId: 'org-1',
      scanPath: 'D:\\',
    }));
    const target = onConflictDoUpdate.mock.calls[0]![0].target;
    // An array of TWO columns. A single column here is the 42P10 regression:
    // after the primary-key swap, `target: deviceId` names no unique index.
    expect(Array.isArray(target)).toBe(true);
    expect(target).toHaveLength(2);
    expect(target.map((column: { name: string }) => column.name)).toEqual(['device_id', 'scan_path']);
  });
});

describe('scan generation (spec §13 #18)', () => {
  function mockUpdateReturning(rows: unknown[]) {
    const returning = vi.fn().mockResolvedValue(rows);
    const where = vi.fn().mockReturnValue({ returning });
    const set = vi.fn().mockReturnValue({ where });
    vi.mocked(db.update).mockReturnValue({ set } as never);
    return { set, where, returning };
  }

  function mockSelectRows(rows: unknown[]) {
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue(rows) }),
      }),
    } as never);
  }

  it('creates first-volume state and replaces the generation on conflict', async () => {
    const onConflictDoUpdate = vi.fn().mockResolvedValue(undefined);
    const values = vi.fn().mockReturnValue({ onConflictDoUpdate });
    vi.mocked(db.insert).mockReturnValue({ values } as never);
    await setFilesystemScanGeneration('device-1', 'org-1', 'D:\\', 'cmd-1');
    expect(values).toHaveBeenCalledWith(expect.objectContaining({ deviceId: 'device-1', orgId: 'org-1', scanPath: 'D:\\', scanGeneration: 'cmd-1' }));
    expect(onConflictDoUpdate).toHaveBeenCalledWith(expect.objectContaining({ set: expect.objectContaining({ scanGeneration: 'cmd-1' }) }));
  });

  it('accepts a NULL generation with a durable command ordering guard', async () => {
    const { where, set } = mockUpdateReturning([{ deviceId: 'device-1' }]);
    await expect(claimFilesystemScanGeneration('device-1', 'D:\\', 'cmd-2')).resolves.toBe('claimed');
    const query = new PgDialect().sqlToQuery(where.mock.calls[0]![0]);
    expect(query.sql).toMatch(/scan_generation" is null/i);
    expect(query.sql).toMatch(/last_applied_command_id" IS DISTINCT FROM/i);
    expect(query.sql).toMatch(/NOT EXISTS[\s\S]*device_commands[\s\S]*applied\.created_at >= arriving\.created_at/i);
    expect(query.sql).toContain('JOIN device_commands AS arriving ON arriving.id = $4');
    expect(query.sql).toContain('WHERE applied.id = "device_filesystem_scan_state"."last_applied_command_id"');
    expect(query.params).toEqual(['device-1', 'D:\\', 'cmd-2', 'cmd-2', 'cmd-2']);
    expect(set).toHaveBeenCalledWith(expect.objectContaining({ lastAppliedCommandId: 'cmd-2' }));
  });

  it('applies two first scans in order, including an unregistered legacy result', async () => {
    // The first scan creates state; a later legacy command has no registered
    // generation. Evaluate the generated predicate against that steady state.
    let state: { scanGeneration: string | null; lastAppliedCommandId: string | null } | null = null;
    vi.mocked(db.insert).mockReturnValue({ values: vi.fn(() => ({
      onConflictDoNothing: vi.fn(() => ({ returning: vi.fn(async () => {
        if (state) return [];
        state = { scanGeneration: null, lastAppliedCommandId: null };
        return [{ deviceId: 'device-1' }];
      }) })),
    })) } as never);
    vi.mocked(db.update).mockReturnValue({ set: vi.fn((updates) => ({
      where: vi.fn((predicate) => ({ returning: vi.fn(async () => {
        const query = new PgDialect().sqlToQuery(predicate);
        const command = query.params[2];
        const acceptsNull = /scan_generation" is null/i.test(query.sql);
        if (!state || (state.scanGeneration !== command && !(acceptsNull && state.scanGeneration === null)) || state.lastAppliedCommandId === command) return [];
        state = { ...state, ...updates };
        return [{ deviceId: 'device-1' }];
      }) })),
    })) } as never);
    vi.mocked(db.select).mockImplementation(() => ({ from: () => ({ where: () => ({ limit: async () => state ? [state] : [] }) }) }) as never);
    await expect(claimFilesystemScanGeneration('device-1', '/', 'cmd-1', db, 'org-1')).resolves.toBe('absent');
    await expect(claimFilesystemScanGeneration('device-1', '/', 'cmd-2', db, 'org-1')).resolves.toBe('claimed');
    expect(state).toMatchObject({ scanGeneration: null, lastAppliedCommandId: 'cmd-2' });
  });

  // Stateful executor: exercise registration, receipt persistence and late
  // delivery using the predicates emitted by the service, rather than returning
  // a predetermined claim result regardless of the query.
  function generationStore() {
    const commands = new Map([['A', 1], ['B', 2], ['equal-B', 2]]);
    let state = { scanGeneration: null as string | null, lastAppliedCommandId: null as string | null };
    vi.mocked(db.insert).mockReturnValue({ values: (values: typeof state) => ({
      onConflictDoUpdate: async () => { state.scanGeneration = values.scanGeneration; },
    }) } as never);
    vi.mocked(db.update).mockReturnValue({ set: (updates: typeof state) => ({
      where: (predicate: Parameters<PgDialect['sqlToQuery']>[0]) => ({ returning: async () => {
        const query = new PgDialect().sqlToQuery(predicate);
        const command = updates.lastAppliedCommandId!;
        const priorTime = commands.get(state.lastAppliedCommandId!);
        const arrivalTime = commands.get(command);
        const checksOrdering = /NOT EXISTS[\s\S]*device_commands[\s\S]*applied\.created_at >= arriving\.created_at/i.test(query.sql);
        const outdated = checksOrdering && priorTime !== undefined && arrivalTime !== undefined && priorTime >= arrivalTime;
        const ownsGeneration = state.scanGeneration === command;
        if (state.lastAppliedCommandId === command || (!ownsGeneration && (state.scanGeneration !== null || outdated))) return [];
        state = { ...state, ...updates };
        return [{ deviceId: 'device-1' }];
      } }),
    }) } as never);
    vi.mocked(db.select).mockImplementation(() => ({ from: () => ({ where: () => ({ limit: async () => [state] }) }) }) as never);
    return {
      commands,
      state: () => ({ ...state }),
      register: (id: string) => setFilesystemScanGeneration('device-1', 'org-1', '/', id),
      apply: (id: string) => claimFilesystemScanGeneration('device-1', '/', id),
    };
  }

  it('rejects A arriving after registered B applied and leaves the state unchanged', async () => {
    const store = generationStore();
    await store.register('A');
    await store.register('B');
    await expect(store.apply('B')).resolves.toBe('claimed');
    const afterB = store.state();
    await expect(store.apply('A')).resolves.toBe('superseded');
    expect(store.state()).toEqual(afterB);
  });

  it('applies ordered A then B and rejects A replayed after B', async () => {
    const store = generationStore();
    await store.register('A');
    await expect(store.apply('A')).resolves.toBe('claimed');
    await store.register('B');
    await expect(store.apply('B')).resolves.toBe('claimed');
    const afterB = store.state();
    await expect(store.apply('A')).resolves.toBe('superseded');
    expect(store.state()).toEqual(afterB);
  });

  it('rejects an unregistered command with the same creation time as B', async () => {
    const store = generationStore();
    await store.register('B');
    await store.apply('B');
    const afterB = store.state();
    await expect(store.apply('equal-B')).resolves.toBe('superseded');
    expect(store.state()).toEqual(afterB);
  });

  it('applies an unregistered result when the last-applied command was pruned', async () => {
    const store = generationStore();
    await store.register('B');
    await store.apply('B');
    store.commands.delete('B');
    await expect(store.apply('A')).resolves.toBe('claimed');
    expect(store.state().lastAppliedCommandId).toBe('A');
  });

  it('keeps an explicitly registered generation authoritative regardless of creation time', async () => {
    const store = generationStore();
    await store.register('B');
    await store.apply('B');
    await store.register('A');
    await expect(store.apply('A')).resolves.toBe('claimed');
    expect(store.state().lastAppliedCommandId).toBe('A');
  });

  it('claims the generation when the command id matches, clearing it in the same statement', async () => {
    const { set } = mockUpdateReturning([{ deviceId: 'device-1' }]);

    await expect(claimFilesystemScanGeneration('device-1', 'D:\\', 'cmd-1')).resolves.toBe('claimed');

    // The applied command is the idempotency marker, independently of the generation.
    expect(set).toHaveBeenCalledWith(expect.objectContaining({ scanGeneration: null }));
  });

  it('reports superseded when a DIFFERENT generation owns the row', async () => {
    mockUpdateReturning([]);
    mockSelectRows([{ scanGeneration: 'cmd-2' }]);

    await expect(claimFilesystemScanGeneration('device-1', 'D:\\', 'cmd-1')).resolves.toBe('superseded');
  });

  it('reports already_applied for a duplicate delivery of the same command', async () => {
    // The claim nulled the generation the first time round, so the second
    // delivery finds a row with no generation and must NOT re-apply.
    mockUpdateReturning([]);
    mockSelectRows([{ scanGeneration: null, lastAppliedCommandId: 'cmd-1' }]);

    await expect(claimFilesystemScanGeneration('device-1', 'D:\\', 'cmd-1')).resolves.toBe('already_applied');
  });

  it('reports absent when there is no scan-state row at all', async () => {
    mockUpdateReturning([]);
    mockSelectRows([]);

    await expect(claimFilesystemScanGeneration('device-1', 'D:\\', 'cmd-1')).resolves.toBe('absent');
  });
});


describe('clearFilesystemScanGeneration', () => {
  it.each(['failed-command', 'newer-command'])('conditionally clears only the failed generation (current: %s)', async (current) => {
    let generation: string | null = current;
    const where = vi.fn(async (predicate) => {
      const query = new PgDialect().sqlToQuery(predicate);
      expect(query.sql).toBe('("device_filesystem_scan_state"."device_id" = $1 and "device_filesystem_scan_state"."scan_path" = $2 and "device_filesystem_scan_state"."scan_generation" = $3)');
      expect(query.params).toEqual(['device-1', '/', 'failed-command']);
      if (generation === query.params[2]) generation = null;
    });
    const set = vi.fn(() => ({ where }));
    vi.mocked(db.update).mockReturnValue({ set } as never);

    await clearFilesystemScanGeneration('device-1', '/', 'failed-command');

    expect(set).toHaveBeenCalledWith({ scanGeneration: null });
    expect(generation).toBe(current === 'failed-command' ? null : 'newer-command');
  });
});
