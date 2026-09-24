import { beforeEach, describe, expect, it, vi } from 'vitest';

// Defect 1, second lane. `disk_cleanup action=execute` had its OWN dispatch
// loop that sent { path, recursive: true } with no `permanent`, so the agent
// MOVED every "deleted" file into ~/.breeze-trash on the same volume for 30
// days — zero bytes freed — and across volumes fell back to copy+remove, so an
// AI-driven cleanup of D:\ grew C:\. This suite pins the dispatched payload and
// the shared screening, so the two lanes cannot drift again.

const DEVICE_ID = '33333333-3333-3333-3333-333333333333';
const ORG_ID = '11111111-1111-1111-1111-111111111111';
const RUN_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PREVIEWED_AT = new Date();
const AGED = new Date(Date.now() - 72 * 3600_000).toISOString();

const dbMockState = vi.hoisted(() => ({
  deviceRows: [] as unknown[],
  userRows: [] as unknown[],
  insertedRuns: [] as Record<string, unknown>[],
}));

const previewState = vi.hoisted(() => ({
  candidates: [] as unknown[],
}));

vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  db: {
    update: vi.fn(() => ({
      set: vi.fn((values: Record<string, unknown>) => ({
        where: vi.fn(() => {
          Object.assign(dbMockState.insertedRuns[0]!, values);
          return { returning: vi.fn(async () => dbMockState.insertedRuns) };
        }),
      })),
    })),
    select: vi.fn(() => {
      const chain: Record<string, unknown> = {};
      chain.from = vi.fn((table: unknown) => {
        const tableName = String((table as Record<symbol, unknown>)[Symbol.for('drizzle:Name')]);
        chain.where = vi.fn(() => chain);
        chain.limit = vi.fn(() => Promise.resolve(tableName === 'users' ? dbMockState.userRows : dbMockState.deviceRows));
        return chain;
      });
      return chain;
    }),
    insert: vi.fn(() => ({
      values: vi.fn((row: Record<string, unknown>) => ({
        returning: vi.fn(async () => {
          const id = `run-${dbMockState.insertedRuns.length + 1}`;
          dbMockState.insertedRuns.push({ ...row, id });
          return [{ id, ...row }];
        }),
      })),
    })),
  },
}));

const executeCommandWithSystemPrecheck = vi.hoisted(() => vi.fn());

vi.mock('./commandQueue', () => ({
  // The AI system-precheck adapter preserves the origin and tenant binding.
  // so asserting here asserts exactly what reaches the device.
  executeCommand: vi.fn(),
  executeCommandWithSystemPrecheck,
  CommandTypes: new Proxy({}, { get: (_t, prop) => String(prop) }),
}));

vi.mock('./auditEvents', () => ({ writeAuditEvent: vi.fn(), requestLikeFromSnapshot: vi.fn(() => ({})) }));

vi.mock('./filesystemAnalysis', () => ({
  buildCleanupPreview: vi.fn(() => ({
    snapshotId: 'snap-1',
    estimatedBytes: 4096,
    candidateCount: previewState.candidates.length,
    categories: [{ category: 'temp_files', count: 1, estimatedBytes: 4096 }],
    candidates: previewState.candidates,
  })),
  getLatestFilesystemSnapshot: vi.fn(async () => null),
  getLatestFilesystemCleanupSnapshot: vi.fn(async () => ({ id: 'snap-1', capturedAt: new Date('2026-09-19T12:00:00Z'), cleanupCandidates: [] })),
  parseFilesystemAnalysisStdout: vi.fn(() => ({})),
  saveFilesystemSnapshot: vi.fn(),
  readPlanPreviewCandidates: vi.fn((plan) => plan.preview.candidates),
  safeCleanupCategories: ['temp_files', 'browser_cache', 'package_cache', 'trash'],
}));

import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';
import { registerFilesystemTools } from './aiToolsFilesystem';

function getDiskCleanupTool(): AiTool {
  const aiTools = new Map<string, AiTool>();
  registerFilesystemTools(aiTools);
  const tool = aiTools.get('disk_cleanup');
  if (!tool) throw new Error('disk_cleanup tool not registered');
  return tool;
}

function makeAuth(): AuthContext {
  return {
    user: { id: 'user-1', email: 'u@example.com', name: 'U' },
    token: {} as unknown,
    partnerId: null,
    orgId: ORG_ID,
    scope: 'organization',
    accessibleOrgIds: [ORG_ID],
    canAccessOrg: (orgId: string) => orgId === ORG_ID,
    orgCondition: vi.fn(() => undefined),
    aiOrigin: { kind: 'ai_assistant', sessionId: 'test-session' },
  } as unknown as AuthContext;
}

describe('disk_cleanup execute dispatches a permanent, guarded delete', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMockState.userRows = [{ id: 'user-1' }];
    dbMockState.deviceRows = [{
      id: DEVICE_ID, orgId: ORG_ID, siteId: null, hostname: 'host-1', status: 'online', osType: 'linux', agentVersion: '0.115.0',
    }];
    dbMockState.insertedRuns = [{
      id: RUN_ID, status: 'previewed', requestedAt: PREVIEWED_AT, scanPath: '/',
      plan: { preview: { get candidates() { return previewState.candidates; } } },
    }];
    previewState.candidates = [
      { path: '/tmp/a.tmp', category: 'temp_files', sizeBytes: 4096, safe: true, modifiedAt: AGED },
    ];
    executeCommandWithSystemPrecheck.mockResolvedValue({
      status: 'completed',
      stdout: JSON.stringify({ deleted: true, bytesFreed: 4096, skippedLocked: [], skippedLinks: [], failedChildren: [] }),
    });
  });

  it('sends permanent + cleanupGuard, not a trash-move', async () => {
    const raw = await getDiskCleanupTool().handler(
      { deviceId: DEVICE_ID, action: 'execute', cleanupRunId: RUN_ID, paths: ['/tmp/a.tmp'] },
      makeAuth(),
    );
    const result = JSON.parse(raw);

    expect(executeCommandWithSystemPrecheck).toHaveBeenCalledTimes(1);
    expect(executeCommandWithSystemPrecheck).toHaveBeenCalledWith(
      DEVICE_ID,
      'file_delete',
      {
        path: '/tmp/a.tmp',
        recursive: false,
        permanent: true,
        cleanupGuard: true,
        contentsOnly: false,
        volumeRoot: '/',
        previewedAt: PREVIEWED_AT.toISOString(),
        cleanupRunId: RUN_ID,
      },
      expect.objectContaining({ userId: 'user-1' }),
    );
    expect(result.bytesReclaimed).toBe(4096);
    expect(result.status).toBe('executed');
  });

  it('sets contentsOnly for a trash root, from the same rule table the route uses', async () => {
    dbMockState.deviceRows = [{
      id: DEVICE_ID, orgId: ORG_ID, siteId: null, hostname: 'host-1', status: 'online', osType: 'macos', agentVersion: '0.115.0',
    }];
    previewState.candidates = [
      { path: '/Users/alice/.Trash', category: 'trash', sizeBytes: 100, safe: true },
    ];

    await getDiskCleanupTool().handler(
      { deviceId: DEVICE_ID, action: 'execute', cleanupRunId: RUN_ID, paths: ['/Users/alice/.Trash'] },
      makeAuth(),
    );

    expect(executeCommandWithSystemPrecheck).toHaveBeenCalledWith(
      DEVICE_ID,
      'file_delete',
      expect.objectContaining({ contentsOnly: true, permanent: true, cleanupGuard: true }),
      expect.anything(),
    );
  });

  it('rejects a path the rule table no longer claims and never dispatches it', async () => {
    dbMockState.deviceRows = [{
      id: DEVICE_ID, orgId: ORG_ID, siteId: null, hostname: 'host-1', status: 'online', osType: 'windows', agentVersion: '0.115.0',
    }];
    const stale = 'C:\\Users\\alice\\AppData\\Local\\Google\\Chrome\\User Data\\Default\\Bookmarks';
    previewState.candidates = [{ path: stale, category: 'browser_cache', sizeBytes: 2048, safe: true }];

    const raw = await getDiskCleanupTool().handler(
      { deviceId: DEVICE_ID, action: 'execute', cleanupRunId: RUN_ID, paths: [stale] },
      makeAuth(),
    );
    const result = JSON.parse(raw);

    expect(executeCommandWithSystemPrecheck).not.toHaveBeenCalled();
    expect(result.rejectedPaths).toEqual([stale]);
    expect(result.error).toContain('No valid cleanup');
  });

  it('reports a path outside the preview set instead of dropping it silently', async () => {
    const raw = await getDiskCleanupTool().handler(
      { deviceId: DEVICE_ID, action: 'execute', cleanupRunId: RUN_ID, paths: ['/tmp/a.tmp', '/home/bob/taxes.pdf'] },
      makeAuth(),
    );
    const result = JSON.parse(raw);

    expect(executeCommandWithSystemPrecheck).toHaveBeenCalledTimes(1);
    expect(result.rejectedPaths).toEqual(['/home/bob/taxes.pdf']);
    expect(result.actions.map((a: { path: string; status: string }) => [a.path, a.status])).toEqual([
      ['/tmp/a.tmp', 'completed'],
      ['/home/bob/taxes.pdf', 'rejected'],
    ]);
  });

  it('stores the executedActions envelope, matching the route', async () => {
    await getDiskCleanupTool().handler(
      { deviceId: DEVICE_ID, action: 'execute', cleanupRunId: RUN_ID, paths: ['/tmp/a.tmp'] },
      makeAuth(),
    );
    const run = dbMockState.insertedRuns[0] as { executedActions: { partial: boolean; budgetMs: number; actions: unknown[] } };
    expect(run.executedActions.partial).toBe(false);
    expect(run.executedActions.budgetMs).toBe(240_000);
    expect(run.executedActions.actions).toHaveLength(1);
  });

  it('refuses an agent older than the cleanupGuard release (spec §13 row 3)', async () => {
    dbMockState.deviceRows = [{
      id: DEVICE_ID, orgId: ORG_ID, siteId: null, hostname: 'host-1', status: 'online', osType: 'linux', agentVersion: '0.114.0',
    }];
    const raw = await getDiskCleanupTool().handler(
      { deviceId: DEVICE_ID, action: 'execute', cleanupRunId: RUN_ID, paths: ['/tmp/a.tmp'] },
      makeAuth(),
    );
    const result = JSON.parse(raw);
    expect(executeCommandWithSystemPrecheck).not.toHaveBeenCalled();
    expect(result.error).toBe('agent_update_required');
    expect(result.minAgentVersion).toBe('0.115.0');
  });

  // Defect: `dispatchedPaths` treated an agent-guard rejection as
  // never-dispatched, so an all-rejected run short-circuited into the "no
  // valid candidates" branch BEFORE the run insert — the command had already
  // reached the device with no run row to show for it.
  it('persists a run when every dispatched path came back rejected by the agent guard', async () => {
    executeCommandWithSystemPrecheck.mockResolvedValue({
      status: 'failed',
      error: 'cleanup guard rejected: a.tmp is a symlink',
    });

    const raw = await getDiskCleanupTool().handler(
      { deviceId: DEVICE_ID, action: 'execute', cleanupRunId: RUN_ID, paths: ['/tmp/a.tmp'] },
      makeAuth(),
    );
    const result = JSON.parse(raw);

    expect(executeCommandWithSystemPrecheck).toHaveBeenCalledTimes(1);
    // Consistent with runCleanupExecution's own outcome: nothing completed or
    // partial, so the run is `failed`, matching the route's all-failed shape.
    expect(result.status).toBe('failed');
    expect(result.counts.rejected).toBe(1);
    expect(dbMockState.insertedRuns).toHaveLength(1);
    expect(dbMockState.insertedRuns[0]).toMatchObject({ status: 'failed' });
  });

  it('exposes both the W02 volume path and W03 cleanupRunId', () => {
    const properties = getDiskCleanupTool().definition.input_schema.properties as Record<string, unknown>;
    // Explicit run ids coexist with volume selection and the remembered preview.
    expect(properties).toHaveProperty('path', expect.objectContaining({ type: 'string' }));
    expect(properties).toHaveProperty('cleanupRunId', expect.objectContaining({ type: 'string', format: 'uuid' }));
    expect(Object.keys(properties).sort()).toEqual(['action', 'categories', 'cleanupRunId', 'deviceId', 'includeReasons', 'maxCandidates', 'path', 'paths']);
  });
});
