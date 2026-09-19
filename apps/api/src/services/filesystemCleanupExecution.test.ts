import { describe, expect, it, vi } from 'vitest';
import { CLEANUP_GUARD_REJECTED_PREFIX } from '@breeze/shared';
import {
  MIN_AGENT_VERSION_CLEANUP_GUARD,
  agentSupportsCleanupGuard,
  buildFileDeletePayload,
  cleanupVolumeRoot,
  mapFileDeleteStatus,
  parseFileDeleteResult,
  runCleanupExecution,
  type FileDeleteDispatchResult,
} from './filesystemCleanupExecution';
import type { FilesystemCleanupCandidate } from './filesystemAnalysis';

const OLD = new Date(Date.now() - 72 * 3600_000).toISOString();
// Every execution pins the moment the operator looked at the plan; the agent
// refuses a target whose mtime is newer than this (spec §13 row 2).
const PREVIEWED_AT = new Date();

function tempCandidate(path: string, sizeBytes = 4096): FilesystemCleanupCandidate {
  return { path, category: 'temp_files', sizeBytes, safe: true, modifiedAt: OLD };
}

function ok(stdout: string): FileDeleteDispatchResult {
  return { status: 'completed', stdout };
}

describe('buildFileDeletePayload (spec §5.2, §13 rows 1-2)', () => {
  const previewedAt = '2026-09-19T12:00:00.000Z';

  it('asks for a permanent, guarded, NON-recursive delete for a file rule', () => {
    // §13 row 2: a file-granularity candidate that has become a directory since
    // the preview must not turn into a subtree delete.
    expect(buildFileDeletePayload({ path: '/tmp/a.tmp', granularity: 'file', volumeRoot: '/', previewedAt })).toEqual({
      path: '/tmp/a.tmp',
      recursive: false,
      permanent: true,
      cleanupGuard: true,
      contentsOnly: false,
      volumeRoot: '/',
      previewedAt,
    });
  });

  it('sets contentsOnly and recursive for a bin/trash root', () => {
    expect(buildFileDeletePayload({
      path: '/Users/alice/.Trash', granularity: 'contents', volumeRoot: '/', previewedAt,
    })).toMatchObject({ contentsOnly: true, recursive: true, volumeRoot: '/' });
  });

  it('derives the volume root the agent confines the anchor to', () => {
    expect(cleanupVolumeRoot('windows', 'D:\\$Recycle.Bin\\S-1-5-21-1')).toBe('D:\\');
    expect(cleanupVolumeRoot('linux', '/tmp/a.tmp')).toBe('/');
    expect(cleanupVolumeRoot('darwin', '/Users/alice/.Trash')).toBe('/');
  });
});

describe('agentSupportsCleanupGuard (spec §13 row 3)', () => {
  it('pins the minimum version W01 ships in', () => {
    // Bump this AND the constant together if the wave lands in another release.
    expect(MIN_AGENT_VERSION_CLEANUP_GUARD).toBe('0.115.0');
  });

  it('accepts the gate version and anything newer, including a prerelease of it', () => {
    expect(agentSupportsCleanupGuard('0.115.0')).toBe(true);
    expect(agentSupportsCleanupGuard('0.115.1')).toBe(true);
    expect(agentSupportsCleanupGuard('1.0.0')).toBe(true);
    // Core-only comparison: an RC of the gate release carries the guard.
    expect(agentSupportsCleanupGuard('0.115.0-rc1')).toBe(true);
    expect(agentSupportsCleanupGuard('v0.115.0')).toBe(true);
  });

  it('refuses older agents', () => {
    expect(agentSupportsCleanupGuard('0.114.0')).toBe(false);
    expect(agentSupportsCleanupGuard('0.99.9')).toBe(false);
  });

  it('FAILS CLOSED on an absent or unparseable version', () => {
    // compareAgentVersions returns 0 for unparseable input, so a naive
    // `compare(...) < 0` would fail OPEN and hand an unknown agent a permanent
    // recursive delete. These four are the whole reason for the helper.
    expect(agentSupportsCleanupGuard(null)).toBe(false);
    expect(agentSupportsCleanupGuard(undefined)).toBe(false);
    expect(agentSupportsCleanupGuard('')).toBe(false);
    expect(agentSupportsCleanupGuard('nightly')).toBe(false);
  });
});

describe('file_delete delivery class (spec §13 row 6)', () => {
  it('is live-only, so a permanent delete can never wait in the offline queue', async () => {
    const { COMMAND_OFFLINE_POLICY_REGISTRY, defaultOfflinePolicy } = await import('./commandOfflinePolicy');
    // A queued class would let a run the UI reported failed at 2h execute days
    // later against a machine whose state has moved on.
    expect(COMMAND_OFFLINE_POLICY_REGISTRY['file_delete']).toBe('live');
    expect(defaultOfflinePolicy('file_delete')).toEqual({ kind: 'reject' });
  });
});

describe('parseFileDeleteResult', () => {
  it('reads the new agent result body', () => {
    expect(
      parseFileDeleteResult(JSON.stringify({
        path: '/tmp/a', deleted: true, bytesFreed: 4096,
        skippedLocked: ['/tmp/locked'], skippedLinks: [], failedChildren: [],
      })),
    ).toEqual({
      deleted: true, bytesFreed: 4096,
      skippedLocked: ['/tmp/locked'], skippedLinks: [], failedChildren: [],
    });
  });

  it('returns null for an OLD agent body, which carries no bytesFreed', () => {
    expect(parseFileDeleteResult(JSON.stringify({ path: '/tmp/a', deleted: true, permanent: true }))).toBeNull();
  });

  it('returns null for missing or non-JSON stdout', () => {
    expect(parseFileDeleteResult(undefined)).toBeNull();
    expect(parseFileDeleteResult('')).toBeNull();
    expect(parseFileDeleteResult('not json')).toBeNull();
    expect(parseFileDeleteResult('[]')).toBeNull();
  });
});

describe('mapFileDeleteStatus (spec §5.2 status vocabulary)', () => {
  it('maps a guard refusal onto rejected, not failed', () => {
    expect(
      mapFileDeleteStatus(
        { status: 'failed', error: `${CLEANUP_GUARD_REJECTED_PREFIX} /tmp/x is a symlink` },
        null,
      ),
    ).toBe('rejected');
  });

  it('maps any other dispatch failure onto failed', () => {
    expect(mapFileDeleteStatus({ status: 'failed', error: 'device offline' }, null)).toBe('failed');
    expect(mapFileDeleteStatus({ status: 'timeout' }, null)).toBe('failed');
  });

  it('maps a locked file onto skipped_locked', () => {
    expect(
      mapFileDeleteStatus({ status: 'completed' }, {
        deleted: false, bytesFreed: 0, skippedLocked: ['/tmp/x'], skippedLinks: [], failedChildren: [],
      }),
    ).toBe('skipped_locked');
  });

  it('keeps a locked-but-productive contentsOnly delete as completed', () => {
    expect(
      mapFileDeleteStatus({ status: 'completed' }, {
        deleted: false, bytesFreed: 2048, skippedLocked: ['/trash/locked'], skippedLinks: [], failedChildren: [],
      }),
    ).toBe('completed');
  });

  it('maps ANY failed child onto partial, never completed (spec §13 row 13)', () => {
    // "Emptied most of the bin but three children failed" used to be
    // indistinguishable from a clean run.
    expect(
      mapFileDeleteStatus({ status: 'completed' }, {
        deleted: false, bytesFreed: 2048, skippedLocked: [], skippedLinks: [], failedChildren: ['/trash/x'],
      }),
    ).toBe('partial');
  });

  it('maps an all-children-failed contentsOnly delete onto failed', () => {
    expect(
      mapFileDeleteStatus({ status: 'completed' }, {
        deleted: false, bytesFreed: 0, skippedLocked: [], skippedLinks: [], failedChildren: ['/trash/x'],
      }),
    ).toBe('failed');
  });

  it('treats an OLD agent success as completed', () => {
    expect(mapFileDeleteStatus({ status: 'completed' }, null)).toBe('completed');
  });
});

describe('runCleanupExecution', () => {
  it('dispatches the guarded permanent payload for a rule-matching candidate', async () => {
    const dispatch = vi.fn(async () => ok(JSON.stringify({ deleted: true, bytesFreed: 4096, skippedLocked: [], skippedLinks: [], failedChildren: [] })));
    const outcome = await runCleanupExecution({
      os: 'linux',
      requestedPaths: ['/tmp/a.tmp'],
      candidates: [tempCandidate('/tmp/a.tmp')],
      previewedAt: PREVIEWED_AT,
      dispatch,
    });

    expect(dispatch).toHaveBeenCalledWith('/tmp/a.tmp', {
      path: '/tmp/a.tmp', recursive: false, permanent: true, cleanupGuard: true, contentsOnly: false,
      volumeRoot: '/', previewedAt: PREVIEWED_AT.toISOString(),
    });
    expect(outcome.actions).toEqual([
      expect.objectContaining({ path: '/tmp/a.tmp', status: 'completed', bytesFreed: 4096 }),
    ]);
    expect(outcome.rejectedPaths).toEqual([]);
    expect(outcome.bytesReclaimed).toBe(4096);
  });

  it('sets contentsOnly from the rule granularity, without a new candidate field', async () => {
    const dispatch = vi.fn(async () => ok(JSON.stringify({ deleted: true, bytesFreed: 10, skippedLocked: [], skippedLinks: [], failedChildren: [] })));
    await runCleanupExecution({
      os: 'darwin',
      requestedPaths: ['/Users/alice/.Trash'],
      candidates: [{ path: '/Users/alice/.Trash', category: 'trash', sizeBytes: 10, safe: true }],
      previewedAt: PREVIEWED_AT,
      dispatch,
    });
    expect(dispatch).toHaveBeenCalledWith('/Users/alice/.Trash', expect.objectContaining({ contentsOnly: true }));
  });

  it('rejects a path that is not in the pinned plan and never dispatches it (defect 10)', async () => {
    const dispatch = vi.fn(async () => ok('{}'));
    const outcome = await runCleanupExecution({
      os: 'linux',
      requestedPaths: ['/tmp/a.tmp', '/home/bob/taxes.pdf'],
      candidates: [tempCandidate('/tmp/a.tmp')],
      previewedAt: PREVIEWED_AT,
      dispatch,
    });
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(outcome.rejectedPaths).toEqual(['/home/bob/taxes.pdf']);
    expect(outcome.actions).toContainEqual(
      expect.objectContaining({ path: '/home/bob/taxes.pdf', status: 'rejected', reason: 'not_in_plan' }),
    );
  });

  it('rejects a planned candidate the rule table no longer claims (a stale pre-W01 snapshot)', async () => {
    const dispatch = vi.fn(async () => ok('{}'));
    const stale: FilesystemCleanupCandidate = {
      path: 'C:\\Users\\alice\\AppData\\Local\\Google\\Chrome\\User Data\\Default\\Bookmarks',
      category: 'browser_cache',
      sizeBytes: 2048,
      safe: true,
    };
    const outcome = await runCleanupExecution({
      os: 'windows',
      requestedPaths: [stale.path],
      candidates: [stale],
      previewedAt: PREVIEWED_AT,
      dispatch,
    });
    expect(dispatch).not.toHaveBeenCalled();
    expect(outcome.actions[0]).toMatchObject({ status: 'rejected', reason: 'rule_rejected' });
    expect(outcome.rejectedPaths).toEqual([stale.path]);
  });

  it('rejects a cleanup-denied root before anything else', async () => {
    const dispatch = vi.fn(async () => ok('{}'));
    const outcome = await runCleanupExecution({
      os: 'linux',
      requestedPaths: ['/etc/passwd'],
      candidates: [{ path: '/etc/passwd', category: 'temp_files', sizeBytes: 1, safe: true, modifiedAt: OLD }],
      previewedAt: PREVIEWED_AT,
      dispatch,
    });
    expect(dispatch).not.toHaveBeenCalled();
    expect(outcome.actions[0]).toMatchObject({ status: 'rejected', reason: 'denied_root' });
  });

  it('records an agent guard refusal as rejected and lists it in rejectedPaths', async () => {
    const dispatch = vi.fn(async (): Promise<FileDeleteDispatchResult> => ({
      status: 'failed',
      error: `${CLEANUP_GUARD_REJECTED_PREFIX} /tmp/a.tmp is a symlink`,
    }));
    const outcome = await runCleanupExecution({
      os: 'linux',
      requestedPaths: ['/tmp/a.tmp'],
      candidates: [tempCandidate('/tmp/a.tmp')],
      previewedAt: PREVIEWED_AT,
      dispatch,
    });
    expect(outcome.actions[0]).toMatchObject({ status: 'rejected', reason: 'agent_guard' });
    expect(outcome.rejectedPaths).toEqual(['/tmp/a.tmp']);
    expect(outcome.bytesReclaimed).toBe(0);
  });

  it('falls back to the snapshot size when an OLD agent reports no bytesFreed', async () => {
    const dispatch = vi.fn(async () => ok(JSON.stringify({ path: '/tmp/a.tmp', deleted: true, permanent: true })));
    const outcome = await runCleanupExecution({
      os: 'linux',
      requestedPaths: ['/tmp/a.tmp'],
      candidates: [tempCandidate('/tmp/a.tmp', 8192)],
      previewedAt: PREVIEWED_AT,
      dispatch,
    });
    expect(outcome.actions[0]).toMatchObject({ status: 'completed', bytesFreed: 8192 });
    expect(outcome.bytesReclaimed).toBe(8192);
  });

  it('prefers the agent bytesFreed over the snapshot size when they differ', async () => {
    const dispatch = vi.fn(async () => ok(JSON.stringify({ deleted: true, bytesFreed: 12, skippedLocked: [], skippedLinks: [], failedChildren: [] })));
    const outcome = await runCleanupExecution({
      os: 'linux',
      requestedPaths: ['/tmp/a.tmp'],
      candidates: [tempCandidate('/tmp/a.tmp', 999_999)],
      previewedAt: PREVIEWED_AT,
      dispatch,
    });
    expect(outcome.bytesReclaimed).toBe(12);
  });

  it('deduplicates requested paths and preserves request order', async () => {
    const dispatch = vi.fn(async () => ok(JSON.stringify({ deleted: true, bytesFreed: 1, skippedLocked: [], skippedLinks: [], failedChildren: [] })));
    const outcome = await runCleanupExecution({
      os: 'linux',
      requestedPaths: ['/tmp/b.tmp', '/tmp/a.tmp', '/tmp/b.tmp'],
      candidates: [tempCandidate('/tmp/a.tmp'), tempCandidate('/tmp/b.tmp')],
      previewedAt: PREVIEWED_AT,
      dispatch,
    });
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(outcome.actions.map((a) => a.path)).toEqual(['/tmp/b.tmp', '/tmp/a.tmp']);
  });

  it('rejects everything when the device OS cannot be mapped (fail closed)', async () => {
    const dispatch = vi.fn(async () => ok('{}'));
    const outcome = await runCleanupExecution({
      os: null,
      requestedPaths: ['/tmp/a.tmp'],
      candidates: [tempCandidate('/tmp/a.tmp')],
      previewedAt: PREVIEWED_AT,
      dispatch,
    });
    expect(dispatch).not.toHaveBeenCalled();
    expect(outcome.actions[0]).toMatchObject({ status: 'rejected', reason: 'rule_rejected' });
  });
});

describe('runCleanupExecution wall-clock budget (spec §5.2)', () => {
  it('exports a four-minute budget', async () => {
    const { CLEANUP_EXECUTE_BUDGET_MS } = await import('./filesystemCleanupExecution');
    expect(CLEANUP_EXECUTE_BUDGET_MS).toBe(240_000);
  });

  it('stops dispatching once the budget is spent and marks the rest skipped_budget', async () => {
    // 200 candidates x a 30s per-command timeout is a 100-minute worst case on
    // a request thread; the budget is what keeps that bounded (defect 10).
    let clock = 0;
    const dispatch = vi.fn(async () => {
      clock += 60_000;
      return ok(JSON.stringify({ deleted: true, bytesFreed: 1, skippedLocked: [], skippedLinks: [], failedChildren: [] }));
    });
    const paths = ['/tmp/a.tmp', '/tmp/b.tmp', '/tmp/c.tmp', '/tmp/d.tmp'];
    const outcome = await runCleanupExecution({
      os: 'linux',
      requestedPaths: paths,
      candidates: paths.map((p) => tempCandidate(p)),
      previewedAt: PREVIEWED_AT,
      dispatch,
      budgetMs: 120_000,
      now: () => clock,
    });

    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(outcome.actions.map((a) => a.status)).toEqual([
      'completed', 'completed', 'skipped_budget', 'skipped_budget',
    ]);
    expect(outcome.partial).toBe(true);
    expect(outcome.budgetMs).toBe(120_000);
    expect(outcome.rejectedPaths).toEqual([]);
  });

  it('is not partial when everything fits in the budget', async () => {
    const dispatch = vi.fn(async () => ok(JSON.stringify({ deleted: true, bytesFreed: 1, skippedLocked: [], skippedLinks: [], failedChildren: [] })));
    const outcome = await runCleanupExecution({
      os: 'linux',
      requestedPaths: ['/tmp/a.tmp'],
      candidates: [tempCandidate('/tmp/a.tmp')],
      previewedAt: PREVIEWED_AT,
      dispatch,
      budgetMs: 120_000,
      now: () => 0,
    });
    expect(outcome.partial).toBe(false);
  });

  it('still screens budget-skipped paths, so a rejection is never hidden by the budget', async () => {
    let clock = 0;
    const dispatch = vi.fn(async () => {
      clock += 60_000;
      return ok(JSON.stringify({ deleted: true, bytesFreed: 1, skippedLocked: [], skippedLinks: [], failedChildren: [] }));
    });
    const outcome = await runCleanupExecution({
      os: 'linux',
      requestedPaths: ['/tmp/a.tmp', '/home/bob/taxes.pdf', '/tmp/c.tmp'],
      candidates: [tempCandidate('/tmp/a.tmp'), tempCandidate('/tmp/c.tmp')],
      previewedAt: PREVIEWED_AT,
      dispatch,
      budgetMs: 30_000,
      now: () => clock,
    });
    expect(outcome.actions.map((a) => a.status)).toEqual(['completed', 'rejected', 'skipped_budget']);
    expect(outcome.rejectedPaths).toEqual(['/home/bob/taxes.pdf']);
  });
});
