import { beforeEach, describe, expect, it, vi } from 'vitest';

const DEVICE_ID = '33333333-3333-3333-3333-333333333333';
const ORG_ID = '11111111-1111-1111-1111-111111111111';
const AGENT_USER_ID = 'pin-agent';
const RUN_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_RUN_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
let testNumber = 0;

const dbMockState = vi.hoisted(() => ({
  userRows: [] as unknown[],
  deviceRows: [] as unknown[],
  insertedRuns: [] as Record<string, unknown>[],
  claimedRows: [] as Record<string, unknown>[],
  updates: [] as Record<string, unknown>[],
  predicates: [] as SQL[],
  terminalRows: null as Record<string, unknown>[] | null,
  existingRows: [] as Record<string, unknown>[],
}));

vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  db: {
    update: vi.fn(() => ({
      set: vi.fn((row: Record<string, unknown>) => {
        dbMockState.updates.push(row);
        return { where: vi.fn((predicate: SQL) => {
          dbMockState.predicates.push(predicate);
          return { returning: vi.fn(async () => row.status === 'running' ? dbMockState.claimedRows : (dbMockState.terminalRows ?? [{ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }])) };
        }) };
      }),
    })),
    select: vi.fn(() => ({
      from: vi.fn((table: unknown) => {
        const chain: Record<string, unknown> = {};
        const tableName = String((table as Record<symbol, unknown>)[Symbol.for('drizzle:Name')]);
        chain.where = vi.fn(() => chain);
        chain.limit = vi.fn(() =>
          Promise.resolve(tableName === 'users' ? dbMockState.userRows : tableName === 'device_filesystem_cleanup_runs' ? dbMockState.existingRows : dbMockState.deviceRows));
        return chain;
      }),
    })),
    insert: vi.fn(() => ({
      values: vi.fn((row: Record<string, unknown>) => ({
        returning: vi.fn(async () => {
          const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
          dbMockState.insertedRuns.push({ ...row, id });
          return [{ id, ...row }];
        }),
      })),
    })),
  },
}));

vi.mock('./commandQueue', () => ({
  executeCommand: vi.fn(),
  executeCommandWithSystemPrecheck: vi.fn(async () => ({ status: 'completed', stdout: '{}' })),
  CommandTypes: new Proxy({}, { get: (_t, prop) => String(prop) }),
}));

vi.mock('./sentry', () => ({ captureException: vi.fn() }));
vi.mock('./auditEvents', () => ({ writeAuditEvent: vi.fn(), requestLikeFromSnapshot: vi.fn(() => ({})) }));
import { captureException } from './sentry';
import { writeAuditEvent } from './auditEvents';

vi.mock('./filesystemAnalysis', () => ({
  buildCleanupPreview: vi.fn(() => ({
    candidates: [{ path: '/tmp/junk.log', category: 'temp_files', sizeBytes: 1024, safe: true, modifiedAt: new Date(Date.now() - 72 * 3600_000).toISOString() }],
    estimatedBytes: 1024,
    candidateCount: 1,
    categories: ['temp'],
  })),
  getLatestFilesystemSnapshot: vi.fn(),
  getLatestFilesystemCleanupSnapshot: vi.fn(async () => ({ id: 'snap-1' })),
  parseFilesystemAnalysisStdout: vi.fn(),
  saveFilesystemSnapshot: vi.fn(),
  readPlanPreviewCandidates: vi.fn((plan) => plan.preview.candidates),
  safeCleanupCategories: ['temp'],
}));

import { db } from '../db';
import { toolInputSchemas } from './aiToolSchemas';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { executeCommand, executeCommandWithSystemPrecheck } from './commandQueue';
import { readPlanPreviewCandidates, getLatestFilesystemCleanupSnapshot } from './filesystemAnalysis';
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
    user: { id: `${AGENT_USER_ID}-${testNumber}`, email: 'agent@example.com', name: 'AI Agent' },
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

const tool = getDiskCleanupTool();
const callTool = (input: Record<string, unknown>) => tool.handler({ deviceId: DEVICE_ID, ...input }, makeAgentAuth());
function claimReturnsRun(overrides: Record<string, unknown> = {}) {
  dbMockState.claimedRows = [{
    id: RUN_ID, requestedAt: new Date(), scanPath: '/',
    plan: { snapshotId: 'pinned-snapshot', preview: { candidates: [{
      path: '/tmp/junk.log', category: 'temp_files', sizeBytes: 1024,
      modifiedAt: new Date(Date.now() - 72 * 3_600_000).toISOString(),
    }] } }, ...overrides,
  }];
}

describe('disk_cleanup run pinning (spec §13 #16)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    testNumber++;
    dbMockState.terminalRows = null;
    dbMockState.existingRows = [{ status: 'running', orgId: ORG_ID, kind: 'files' }];
    dbMockState.userRows = [];
    dbMockState.deviceRows = [{ id: DEVICE_ID, orgId: ORG_ID, siteId: null,
      hostname: 'host-1', status: 'online', osType: 'linux', agentVersion: '0.115.0' }];
    dbMockState.insertedRuns = [];
    dbMockState.updates = [];
    dbMockState.predicates = [];
    claimReturnsRun();
  });

  it('rejects execute with neither an explicit cleanupRunId nor a pinned one', async () => {
    const out = JSON.parse(await callTool({ action: 'execute', paths: ['/tmp/junk.log'] }));
    expect(out.error).toBe('cleanup_run_required');
    expect(executeCommandWithSystemPrecheck).not.toHaveBeenCalled();
  });

  it('remembers the run id from its own preview and uses it on the next execute', async () => {
    const preview = JSON.parse(await callTool({ action: 'preview' }));
    expect(preview.cleanupRunId).toBe(RUN_ID);
    vi.mocked(getLatestFilesystemCleanupSnapshot).mockClear();
    const out = JSON.parse(await callTool({ action: 'execute', paths: ['/tmp/junk.log'] }));
    expect(out.cleanupRunId).toBe(RUN_ID);
    expect(readPlanPreviewCandidates).toHaveBeenCalledWith(dbMockState.claimedRows[0]!.plan);
    expect(getLatestFilesystemCleanupSnapshot).not.toHaveBeenCalled();
    expect(executeCommandWithSystemPrecheck).toHaveBeenCalledWith(DEVICE_ID, 'file_delete',
      expect.objectContaining({ cleanupRunId: RUN_ID, recursive: false, permanent: true, cleanupGuard: true }),
      expect.objectContaining({ expectedOrgId: ORG_ID, aiOrigin: { kind: 'ai_assistant', sessionId: 'test-session' } }));
    expect(executeCommand).not.toHaveBeenCalled();
  });

  it('honours an explicit cleanupRunId over the pinned one', async () => {
    await callTool({ action: 'preview' });
    claimReturnsRun({ id: OTHER_RUN_ID });
    const out = JSON.parse(await callTool({ action: 'execute', paths: ['/tmp/junk.log'], cleanupRunId: OTHER_RUN_ID }));
    expect(out.cleanupRunId).toBe(OTHER_RUN_ID);
  });

  it('refuses a pinned run older than the preview TTL', async () => {
    claimReturnsRun({ requestedAt: new Date(Date.now() - 25 * 3_600_000) });
    const out = JSON.parse(await callTool({ action: 'execute', paths: ['/tmp/junk.log'], cleanupRunId: RUN_ID }));
    expect(out.error).toBe('preview_expired');
    expect(executeCommandWithSystemPrecheck).not.toHaveBeenCalled();
    expect(dbMockState.updates.at(-1)).toMatchObject({ status: 'previewed', approvedAt: null });
  });

  it('finalises the pinned run instead of inserting a second one', async () => {
    await callTool({ action: 'execute', paths: ['/tmp/junk.log'], cleanupRunId: RUN_ID });
    expect(db.insert).not.toHaveBeenCalled();
    expect(dbMockState.updates).toEqual([
      expect.objectContaining({ status: 'running' }),
      expect.objectContaining({ status: 'executed', executedActions: expect.objectContaining({ actions: expect.any(Array) }) }),
    ]);
  });

  it('refuses a run when the scoped atomic claim matches no preview', async () => {
    dbMockState.claimedRows = [];
    const out = JSON.parse(await callTool({ action: 'execute', paths: ['/tmp/junk.log'], cleanupRunId: RUN_ID }));
    expect(out.error).toBe('run_not_previewed');
    expect(executeCommandWithSystemPrecheck).not.toHaveBeenCalled();
  });

  it('releases an undispatched claim when paths are outside the pinned plan', async () => {
    const out = JSON.parse(await callTool({ action: 'execute', paths: ['/tmp/not-previewed'], cleanupRunId: RUN_ID }));
    expect(out.rejectedPaths).toEqual(['/tmp/not-previewed']);
    expect(executeCommandWithSystemPrecheck).not.toHaveBeenCalled();
    expect(dbMockState.updates.at(-1)).toMatchObject({ status: 'previewed' });
  });

  it('does not reuse another user’s preview pin', async () => {
    await callTool({ action: 'preview' });
    testNumber++;
    const out = JSON.parse(await callTool({ action: 'execute', paths: ['/tmp/junk.log'] }));
    expect(out.error).toBe('cleanup_run_required');
    expect(executeCommandWithSystemPrecheck).not.toHaveBeenCalled();
  });

  it('scopes the claim to the run, device, organization, kind and previewed state', async () => {
    await callTool({ action: 'execute', paths: ['/tmp/junk.log'], cleanupRunId: OTHER_RUN_ID });
    const query = new PgDialect().sqlToQuery(dbMockState.predicates[0]!);
    expect(query.params).toEqual([OTHER_RUN_ID, DEVICE_ID, ORG_ID, 'files', 'previewed']);
    for (const column of ['id', 'device_id', 'org_id', 'kind', 'status']) {
      expect(query.sql).toContain(`"device_filesystem_cleanup_runs"."${column}" =`);
    }
  });

  it('does not reuse a preview from a different conversation', async () => {
    await callTool({ action: 'preview' });
    const auth = makeAgentAuth();
    auth.aiOrigin = { kind: 'ai_assistant', sessionId: 'other-session' };
    const out = JSON.parse(await tool.handler({ deviceId: DEVICE_ID, action: 'execute', paths: ['/tmp/junk.log'] }, auth));
    expect(out.error).toBe('cleanup_run_required');
    expect(executeCommandWithSystemPrecheck).not.toHaveBeenCalled();
  });

  it('records completed actions and audits a dispatch exception', async () => {
    const row = dbMockState.claimedRows[0]!;
    const candidates = (row.plan as any).preview.candidates;
    candidates.push({ ...candidates[0], path: '/tmp/second.log' });
    vi.mocked(executeCommandWithSystemPrecheck).mockResolvedValueOnce({ status: 'completed' } as never).mockRejectedValueOnce(new Error('insert failed'));
    const out = JSON.parse(await callTool({ action: 'execute', cleanupRunId: RUN_ID, paths: ['/tmp/junk.log', '/tmp/second.log'] }));
    expect(out.error).toBe('cleanup_dispatch_failed');
    expect(out.data.actions).toHaveLength(1);
    expect(dbMockState.updates.at(-1)).toMatchObject({ status: 'failed', error: 'dispatch_failed: insert failed', executedActions: { actions: [expect.objectContaining({ path: '/tmp/junk.log' })] } });
    expect(writeAuditEvent).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ result: 'failure' }));
    expect(captureException).toHaveBeenCalled();
  });

  it('returns the cancelled terminal state when finalisation loses its conditional update', async () => {
    dbMockState.terminalRows = [];
    dbMockState.existingRows = [{ status: 'failed', error: 'cancelled', executedActions: [{ path: '/tmp/late.tmp', lateResult: true }] }];
    const out = JSON.parse(await callTool({ action: 'execute', cleanupRunId: RUN_ID, paths: ['/tmp/junk.log'] }));
    expect(out.status).toBe('failed');
    expect(out.error).toBe('cancelled');
    expect(out.actions).toEqual([{ path: '/tmp/late.tmp', lateResult: true }]);
    expect(captureException).toHaveBeenCalled();
  });

  it('distinguishes a missing or wrong-kind run from an already used run', async () => {
    dbMockState.claimedRows = [];
    dbMockState.existingRows = [];
    expect(JSON.parse(await callTool({ action: 'execute', cleanupRunId: RUN_ID, paths: ['/tmp/junk.log'] })).error).toBe('cleanup_run_not_found');
    dbMockState.existingRows = [{ status: 'previewed', orgId: ORG_ID, kind: 'system' }];
    expect(JSON.parse(await callTool({ action: 'execute', cleanupRunId: RUN_ID, paths: ['/tmp/junk.log'] })).error).toBe('cleanup_run_kind_mismatch');
  });

  it('validates explicit UUIDs while allowing the handler to resolve a remembered pin', () => {
    const schema = toolInputSchemas.disk_cleanup!;
    const input = { deviceId: DEVICE_ID, action: 'execute', paths: ['/tmp/junk.log'] };
    expect(schema.safeParse({ ...input, cleanupRunId: RUN_ID }).success).toBe(true);
    expect(schema.safeParse({ ...input, cleanupRunId: 'not-a-uuid' }).success).toBe(false);
    expect(schema.safeParse(input).success).toBe(true);
    expect(schema.safeParse({ ...input, paths: [] }).success).toBe(false);
  });

});
