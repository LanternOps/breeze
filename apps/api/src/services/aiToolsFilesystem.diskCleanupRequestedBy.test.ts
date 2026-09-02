import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Review fix (#3826 Task 5 follow-up): `device_filesystem_cleanup_runs
// .requested_by` FK-references users.id, but an `ai_agent` principal's
// `auth.user.id` is the agent's `ai_agents.id`, not a users row
// (agentAuthContext.ts) — an unconditional insert dies on 23503, which made
// the `disk_cleanup` act step (both `preview` and `execute`) unreachable
// under act mode. This suite drives both branches under an agent auth
// context whose id does NOT resolve against `users` and asserts the insert
// succeeds with `requestedBy: null` instead of throwing.
// ---------------------------------------------------------------------------

const DEVICE_ID = '33333333-3333-3333-3333-333333333333';
const ORG_ID = '11111111-1111-1111-1111-111111111111';
const AGENT_USER_ID = 'agent-1';

const dbMockState = vi.hoisted(() => ({
  userRows: [] as unknown[],
  deviceRows: [] as unknown[],
  insertedRuns: [] as Record<string, unknown>[],
}));

vi.mock('../db', () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn((table: unknown) => {
        const chain: Record<string, unknown> = {};
        const tableName = String((table as Record<symbol, unknown>)[Symbol.for('drizzle:Name')]);
        chain.where = vi.fn(() => chain);
        chain.limit = vi.fn(() =>
          Promise.resolve(tableName === 'users' ? dbMockState.userRows : dbMockState.deviceRows));
        return chain;
      }),
    })),
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

vi.mock('./commandQueue', () => ({
  executeCommand: vi.fn(async () => ({ status: 'completed', stdout: '{}' })),
  CommandTypes: new Proxy({}, { get: (_t, prop) => String(prop) }),
}));

vi.mock('./filesystemAnalysis', () => ({
  buildCleanupPreview: vi.fn(() => ({
    candidates: [{ path: '/tmp/junk.log', category: 'temp', sizeBytes: 1024 }],
    estimatedBytes: 1024,
    candidateCount: 1,
    categories: ['temp'],
  })),
  getLatestFilesystemSnapshot: vi.fn(),
  getLatestFilesystemCleanupSnapshot: vi.fn(async () => ({ id: 'snap-1' })),
  parseFilesystemAnalysisStdout: vi.fn(),
  saveFilesystemSnapshot: vi.fn(),
  safeCleanupCategories: ['temp'],
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

// An `ai_agent` principal — `auth.user.id` is `ai_agents.id`, never a row in
// `users` (agentAuthContext.ts).
function makeAgentAuth(): AuthContext {
  return {
    user: { id: AGENT_USER_ID, email: 'agent@example.com', name: 'AI Agent' },
    token: {} as unknown,
    partnerId: null,
    orgId: ORG_ID,
    scope: 'organization',
    accessibleOrgIds: [ORG_ID],
    canAccessOrg: (orgId: string) => orgId === ORG_ID,
    orgCondition: vi.fn(() => undefined),
  } as unknown as AuthContext;
}

describe('disk_cleanup requestedBy FK under an agent principal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMockState.userRows = []; // agent id never resolves against `users`
    dbMockState.deviceRows = [
      { id: DEVICE_ID, orgId: ORG_ID, siteId: null, hostname: 'host-1', status: 'online' },
    ];
    dbMockState.insertedRuns = [];
  });

  it('preview does not throw on the FK — requestedBy degrades to null', async () => {
    const tool = getDiskCleanupTool();
    const raw = await tool.handler({ deviceId: DEVICE_ID, action: 'preview' }, makeAgentAuth());
    const result = JSON.parse(raw);

    expect(result.error).toBeUndefined();
    expect(result.cleanupRunId).toBe('run-1');
    expect(dbMockState.insertedRuns).toHaveLength(1);
    expect(dbMockState.insertedRuns[0]).toMatchObject({ requestedBy: null });
  });

  it('execute does not throw on the FK — requestedBy degrades to null', async () => {
    const tool = getDiskCleanupTool();
    const raw = await tool.handler(
      { deviceId: DEVICE_ID, action: 'execute', paths: ['/tmp/junk.log'] },
      makeAgentAuth(),
    );
    const result = JSON.parse(raw);

    expect(result.error).toBeUndefined();
    expect(dbMockState.insertedRuns).toHaveLength(1);
    expect(dbMockState.insertedRuns[0]).toMatchObject({ requestedBy: null, status: 'executed' });
  });

  it('a resolving user id is still written through (no regression for human-triggered runs)', async () => {
    dbMockState.userRows = [{ id: 'human-user-1' }];
    const tool = getDiskCleanupTool();
    const auth = { ...makeAgentAuth(), user: { id: 'human-user-1', email: 'h@example.com', name: 'Human' } } as AuthContext;
    const raw = await tool.handler({ deviceId: DEVICE_ID, action: 'preview' }, auth);
    const result = JSON.parse(raw);

    expect(result.error).toBeUndefined();
    expect(dbMockState.insertedRuns[0]).toMatchObject({ requestedBy: 'human-user-1' });
  });
});
