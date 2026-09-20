import { beforeEach, describe, expect, it, vi } from 'vitest';

// Defect 5: the agent RESULT lane guards this (routes/agents/helpers.ts:1607-1615
// warns and writes nothing when stdout is empty or non-JSON), but the AI lane
// saved the parsed `{}` unconditionally — and because "latest snapshot" is
// ordered by captured_at, that blank row became the snapshot every later
// preview read, zeroing the tab for everyone.

const DEVICE_ID = '33333333-3333-3333-3333-333333333333';
const ORG_ID = '11111111-1111-1111-1111-111111111111';

const dbMockState = vi.hoisted(() => ({
  deviceRows: [] as unknown[],
  userRows: [] as unknown[],
}));

vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn) => fn()),
  withDbAccessContext: vi.fn((_context, fn) => fn()),
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
      values: vi.fn(() => ({ returning: vi.fn(async () => [{ id: 'run-1' }]) })),
    })),
  },
}));

const commandResult = vi.hoisted(() => ({ value: { status: 'completed', stdout: '' } as Record<string, unknown> }));

vi.mock('./commandQueue', () => ({
  executeCommand: vi.fn(async () => commandResult.value),
  queueCommandForExecution: vi.fn(async () => ({ command: { id: 'cmd-scan' } })),
  waitForCommandResult: vi.fn(async () => ({ status: 'completed', result: commandResult.value })),
  CommandTypes: new Proxy({}, { get: (_t, prop) => String(prop) }),
}));

vi.mock('./filesystemAnalysis', () => ({
  buildCleanupPreview: vi.fn(() => ({ candidates: [], estimatedBytes: 0, candidateCount: 0, categories: [] })),
  getLatestFilesystemSnapshot: vi.fn(async () => null),
  getLatestFilesystemCleanupSnapshot: vi.fn(async () => null),
  parseFilesystemAnalysisStdout: vi.fn((stdout: string) => {
    try {
      const parsed = JSON.parse(stdout) as unknown;
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }),
  setFilesystemScanGeneration: vi.fn(),
  saveFilesystemSnapshot: vi.fn(async () => ({ id: 'snap-1' })),
  safeCleanupCategories: ['temp_files'],
}));

import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';
import { registerFilesystemTools } from './aiToolsFilesystem';
import { saveFilesystemSnapshot } from './filesystemAnalysis';

function getTool(name: string): AiTool {
  const aiTools = new Map<string, AiTool>();
  registerFilesystemTools(aiTools);
  const tool = aiTools.get(name);
  if (!tool) throw new Error(`${name} tool not registered`);
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

describe('analyze_disk_usage empty-snapshot guard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMockState.userRows = [{ id: 'user-1' }];
    dbMockState.deviceRows = [{ id: DEVICE_ID, orgId: ORG_ID, siteId: null, hostname: 'host-1', status: 'online', osType: 'linux', agentVersion: '0.115.0' }];
  });

  it('stores nothing and reports an error when stdout is empty', async () => {
    commandResult.value = { status: 'completed', stdout: '' };
    const raw = await getTool('analyze_disk_usage').handler({ deviceId: DEVICE_ID, refresh: true }, makeAuth());
    const result = JSON.parse(raw);
    expect(saveFilesystemSnapshot).not.toHaveBeenCalled();
    expect(result.error).toContain('no parseable result');
  });

  it('stores nothing when stdout is not JSON', async () => {
    commandResult.value = { status: 'completed', stdout: 'panic: runtime error' };
    const raw = await getTool('analyze_disk_usage').handler({ deviceId: DEVICE_ID, refresh: true }, makeAuth());
    expect(saveFilesystemSnapshot).not.toHaveBeenCalled();
    expect(JSON.parse(raw).error).toContain('no parseable result');
  });

  it('returns a real payload without writing a second snapshot', async () => {
    commandResult.value = {
      status: 'completed',
      stdout: JSON.stringify({ path: '/', summary: { filesScanned: 10 }, cleanupCandidates: [] }),
    };
    const raw = await getTool('analyze_disk_usage').handler({ deviceId: DEVICE_ID, refresh: true }, makeAuth());
    expect(saveFilesystemSnapshot).not.toHaveBeenCalled();
    expect(JSON.parse(raw).snapshot.summary.filesScanned).toBe(10);
    expect(JSON.parse(raw).error).toBeUndefined();
  });
});
