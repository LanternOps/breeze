import { beforeEach, describe, expect, it, vi } from 'vitest';

// Defect 1, second lane. `disk_cleanup action=execute` had its OWN dispatch
// loop that sent { path, recursive: true } with no `permanent`, so the agent
// MOVED every "deleted" file into ~/.breeze-trash on the same volume for 30
// days — zero bytes freed — and across volumes fell back to copy+remove, so an
// AI-driven cleanup of D:\ grew C:\. This suite pins the dispatched payload and
// the shared screening, so the two lanes cannot drift again.

const DEVICE_ID = '33333333-3333-3333-3333-333333333333';
const ORG_ID = '11111111-1111-1111-1111-111111111111';
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
  db: {
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

const executeCommand = vi.hoisted(() => vi.fn());

vi.mock('./commandQueue', () => ({
  // aiExecuteCommand delegates straight to executeCommand (aiDispatch.ts:66-76),
  // so asserting here asserts exactly what reaches the device.
  executeCommand,
  CommandTypes: new Proxy({}, { get: (_t, prop) => String(prop) }),
}));

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
    dbMockState.insertedRuns = [];
    previewState.candidates = [
      { path: '/tmp/a.tmp', category: 'temp_files', sizeBytes: 4096, safe: true, modifiedAt: AGED },
    ];
    executeCommand.mockResolvedValue({
      status: 'completed',
      stdout: JSON.stringify({ deleted: true, bytesFreed: 4096, skippedLocked: [], skippedLinks: [], failedChildren: [] }),
    });
  });

  it('sends permanent + cleanupGuard, not a trash-move', async () => {
    const raw = await getDiskCleanupTool().handler(
      { deviceId: DEVICE_ID, action: 'execute', paths: ['/tmp/a.tmp'] },
      makeAuth(),
    );
    const result = JSON.parse(raw);

    expect(executeCommand).toHaveBeenCalledTimes(1);
    expect(executeCommand).toHaveBeenCalledWith(
      DEVICE_ID,
      'file_delete',
      {
        path: '/tmp/a.tmp',
        recursive: false,
        permanent: true,
        cleanupGuard: true,
        contentsOnly: false,
        volumeRoot: '/',
        previewedAt: '2026-09-19T12:00:00.000Z',
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
      { deviceId: DEVICE_ID, action: 'execute', paths: ['/Users/alice/.Trash'] },
      makeAuth(),
    );

    expect(executeCommand).toHaveBeenCalledWith(
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
      { deviceId: DEVICE_ID, action: 'execute', paths: [stale] },
      makeAuth(),
    );
    const result = JSON.parse(raw);

    expect(executeCommand).not.toHaveBeenCalled();
    expect(result.rejectedPaths).toEqual([stale]);
    expect(result.error).toContain('No valid cleanup');
  });

  it('reports a path outside the preview set instead of dropping it silently', async () => {
    const raw = await getDiskCleanupTool().handler(
      { deviceId: DEVICE_ID, action: 'execute', paths: ['/tmp/a.tmp', '/home/bob/taxes.pdf'] },
      makeAuth(),
    );
    const result = JSON.parse(raw);

    expect(executeCommand).toHaveBeenCalledTimes(1);
    expect(result.rejectedPaths).toEqual(['/home/bob/taxes.pdf']);
    expect(result.actions.map((a: { path: string; status: string }) => [a.path, a.status])).toEqual([
      ['/tmp/a.tmp', 'completed'],
      ['/home/bob/taxes.pdf', 'rejected'],
    ]);
  });

  it('stores the executedActions envelope, matching the route', async () => {
    await getDiskCleanupTool().handler(
      { deviceId: DEVICE_ID, action: 'execute', paths: ['/tmp/a.tmp'] },
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
      { deviceId: DEVICE_ID, action: 'execute', paths: ['/tmp/a.tmp'] },
      makeAuth(),
    );
    const result = JSON.parse(raw);
    expect(executeCommand).not.toHaveBeenCalled();
    expect(result.error).toBe('agent_update_required');
    expect(result.minAgentVersion).toBe('0.115.0');
  });

  it('keeps the W01 input schema unchanged — no path, no cleanupRunId', () => {
    const properties = getDiskCleanupTool().definition.input_schema.properties as Record<string, unknown>;
    // Both arrive in W05 with the rest of §9; W01 unifies the EXECUTION path only.
    expect(properties).not.toHaveProperty('path');
    expect(properties).not.toHaveProperty('cleanupRunId');
    expect(Object.keys(properties).sort()).toEqual(['action', 'categories', 'deviceId', 'maxCandidates', 'paths']);
  });
});
