import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * #9853: file_operations `delete` used to dispatch `{ path }` only, so the
 * agent MOVED the item to ~/.breeze-trash on the same volume and answered
 * `{ deleted: true, trashId }`. The assistant read that as "space freed" on a
 * disk that stayed at 100 %.
 *
 * Pinned here:
 *   - a trash-move result says so, and says no space was reclaimed — and the
 *     words survive the chat compactor the model actually reads through;
 *   - `permanent: true` reaches only agents that pass the same version gate
 *     disk_cleanup's execute lane uses, and an older agent is refused rather
 *     than silently trashed;
 *   - the approval tier for a permanent delete is the same Tier 3 supervised
 *     approval as today's delete and as disk_cleanup execute.
 */

vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: {
    select: vi.fn(),
  },
}));

vi.mock('./commandQueue', () => ({
  CommandTypes: new Proxy({}, { get: (_t, prop) => String(prop) }),
}));

vi.mock('./aiDispatch', () => ({
  aiExecuteCommand: vi.fn(),
  aiExecuteCommandWithSystemPrecheck: vi.fn(),
  requireAiOrigin: vi.fn(),
}));

vi.mock('./filesystemAnalysis', () => ({
  buildCleanupPreview: vi.fn(),
  getLatestFilesystemSnapshot: vi.fn(),
  getLatestFilesystemCleanupSnapshot: vi.fn(),
  parseFilesystemAnalysisStdout: vi.fn(),
  saveFilesystemSnapshot: vi.fn(),
  setFilesystemScanGeneration: vi.fn(),
  clearFilesystemScanGeneration: vi.fn(),
  findInFlightFilesystemScan: vi.fn(),
  readPlanPreviewCandidates: vi.fn(),
  safeCleanupCategories: [],
}));

import { db } from '../db';
import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';
import { aiExecuteCommand } from './aiDispatch';
import { registerFilesystemTools } from './aiToolsFilesystem';
import { MIN_AGENT_VERSION_CLEANUP_GUARD } from './filesystemCleanupExecution';
import { compactToolResultForChat } from './aiToolOutput';
import { buildApprovalDescription, checkGuardrails } from './aiGuardrails';
import { validateToolInput } from './aiToolSchemas';

const ORG_ID = '11111111-1111-1111-1111-111111111111';
const DEVICE_ID = '33333333-3333-3333-3333-333333333333';
const LOG_PATH = '/var/log/runaway/app.log';

function createQueryChain(rows: any[] = []) {
  const chain: any = {};
  chain.from = vi.fn(() => chain);
  chain.where = vi.fn(() => chain);
  chain.limit = vi.fn(() => chain);
  chain.then = (resolve: (value: any[]) => unknown, reject?: (error: unknown) => unknown) =>
    Promise.resolve(rows).then(resolve, reject);
  return chain;
}

function makeAuth(): AuthContext {
  return {
    user: { id: 'user-1', email: 'test@example.com', name: 'Test User' },
    token: {} as any,
    partnerId: null,
    orgId: ORG_ID,
    scope: 'organization',
    accessibleOrgIds: [ORG_ID],
    canAccessOrg: (orgId: string) => orgId === ORG_ID,
    orgCondition: vi.fn(() => undefined),
    aiOrigin: { kind: 'ai_assistant', sessionId: 'test-session' },
  } as any;
}

function getFileOperationsTool(): AiTool {
  const aiTools = new Map<string, AiTool>();
  registerFilesystemTools(aiTools);
  const tool = aiTools.get('file_operations');
  if (!tool) throw new Error('file_operations tool not registered');
  return tool;
}

function deviceWithAgent(agentVersion: string | null) {
  vi.mocked(db.select).mockImplementation(
    () =>
      createQueryChain([
        { id: DEVICE_ID, orgId: ORG_ID, siteId: null, hostname: 'host-1', status: 'online', osType: 'linux', agentVersion },
      ]) as any,
  );
}

const TRASH_RESULT = {
  status: 'completed',
  stdout: JSON.stringify({ path: LOG_PATH, deleted: true, trashId: '1761200000000-app.log' }),
  durationMs: 12,
};

const PERMANENT_RESULT = {
  status: 'completed',
  stdout: JSON.stringify({ path: LOG_PATH, deleted: true, permanent: true, bytesFreed: 57_000_000_000, skippedLocked: [] }),
  durationMs: 40,
};

async function run(input: Record<string, unknown>): Promise<Record<string, any>> {
  const tool = getFileOperationsTool();
  return JSON.parse(await tool.handler({ deviceId: DEVICE_ID, path: LOG_PATH, ...input }, makeAuth()));
}

function dispatchedPayload(): Record<string, unknown> {
  const call = vi.mocked(aiExecuteCommand).mock.calls[0];
  if (!call) throw new Error('nothing was dispatched');
  return call[4] as Record<string, unknown>;
}

describe('file_operations delete — trash move is reported as a trash move (#9853)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    deviceWithAgent(MIN_AGENT_VERSION_CLEANUP_GUARD);
    vi.mocked(aiExecuteCommand).mockResolvedValue(TRASH_RESULT as any);
  });

  it('dispatches the same payload as before: no permanent flag on a plain delete', async () => {
    await run({ action: 'delete' });
    expect(vi.mocked(aiExecuteCommand).mock.calls[0]?.[3]).toBe('file_delete');
    expect(dispatchedPayload()).not.toHaveProperty('permanent');
    expect(dispatchedPayload()).not.toHaveProperty('cleanupGuard');
  });

  it('says the item was moved to the agent trash on the same volume and no space was reclaimed', async () => {
    const result = await run({ action: 'delete' });
    expect(result.outcome).toBe('moved_to_trash');
    expect(result.spaceReclaimed).toBe(false);
    expect(result.message).toMatch(/moved to the agent trash/i);
    expect(result.message).toMatch(/same volume/i);
    expect(result.message).toMatch(/no disk space was reclaimed/i);
    // Points at the two ways that DO free space.
    expect(result.message).toContain('disk_cleanup');
    expect(result.message).toContain('permanent: true');
    // The agent's own body (with its trashId) is still there for restore.
    expect(JSON.parse(result.stdout).trashId).toBe('1761200000000-app.log');
  });

  it('the trash-move wording survives the chat compactor the model reads through', async () => {
    const tool = getFileOperationsTool();
    const raw = await tool.handler({ deviceId: DEVICE_ID, action: 'delete', path: LOG_PATH }, makeAuth());
    const seen = JSON.parse(compactToolResultForChat('file_operations', raw));
    expect(seen.outcome).toBe('moved_to_trash');
    expect(seen.spaceReclaimed).toBe(false);
    expect(seen.message).toMatch(/no disk space was reclaimed/i);
  });

  it('every message fits the tightest compaction tier (300 chars) uncut', async () => {
    const results = [await run({ action: 'delete' })];
    vi.mocked(aiExecuteCommand).mockResolvedValue({ status: 'timeout', error: 'timed out' } as any);
    results.push(await run({ action: 'delete' }));
    for (const version of [MIN_AGENT_VERSION_CLEANUP_GUARD, '0.114.9']) {
      deviceWithAgent(version);
      vi.mocked(aiExecuteCommand).mockResolvedValue(PERMANENT_RESULT as any);
      results.push(await run({ action: 'delete', permanent: true }));
      vi.mocked(aiExecuteCommand).mockResolvedValue(TRASH_RESULT as any);
      results.push(await run({ action: 'delete', permanent: true }));
    }
    for (const result of results) {
      expect(typeof result.message).toBe('string');
      expect(result.message.length).toBeLessThanOrEqual(300);
    }
  });

  it('a completed reply that does not look like a trash move is not called one', async () => {
    vi.mocked(aiExecuteCommand).mockResolvedValue({ status: 'completed', stdout: 'ok' } as any);
    const result = await run({ action: 'delete' });
    expect(result.outcome).toBe('unverified');
    expect(result).not.toHaveProperty('spaceReclaimed');
  });

  it('a delete that timed out says it may still have happened', async () => {
    vi.mocked(aiExecuteCommand).mockResolvedValue({ status: 'timeout', error: 'timed out' } as any);
    const result = await run({ action: 'delete' });
    expect(result.status).toBe('timeout');
    expect(result.outcome).toBe('unverified');
    expect(result.message).toMatch(/may still have/i);
  });

  it('a failed delete is passed through without a trash claim', async () => {
    vi.mocked(aiExecuteCommand).mockResolvedValue({ status: 'failed', error: 'path does not exist' } as any);
    const result = await run({ action: 'delete' });
    expect(result.status).toBe('failed');
    expect(result).not.toHaveProperty('outcome');
    expect(result).not.toHaveProperty('spaceReclaimed');
  });

  it('other actions keep their result shape', async () => {
    vi.mocked(aiExecuteCommand).mockResolvedValue({ status: 'completed', stdout: '{"content":"x"}' } as any);
    const result = await run({ action: 'read' });
    expect(result).toEqual({ status: 'completed', stdout: '{"content":"x"}' });
  });
});

describe('file_operations delete — permanent: true (#9853)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(aiExecuteCommand).mockResolvedValue(PERMANENT_RESULT as any);
  });

  it.each([MIN_AGENT_VERSION_CLEANUP_GUARD, '0.116.2', `${MIN_AGENT_VERSION_CLEANUP_GUARD}-rc1`])(
    'sends permanent: true to an agent at %s, without cleanupGuard or recursive',
    async (version) => {
      deviceWithAgent(version);
      await run({ action: 'delete', permanent: true });
      expect(vi.mocked(aiExecuteCommand)).toHaveBeenCalledTimes(1);
      const payload = dispatchedPayload();
      expect(payload).toEqual({ path: LOG_PATH, permanent: true });
    },
  );

  it('reports the bytes the agent removed without claiming the space is back', async () => {
    deviceWithAgent(MIN_AGENT_VERSION_CLEANUP_GUARD);
    const result = await run({ action: 'delete', permanent: true });
    expect(result.outcome).toBe('permanently_deleted');
    expect(result.bytesRemoved).toBe(57_000_000_000);
    // The agent's size comes from a link-following stat, and an unlinked file
    // a process still holds open (a runaway log) keeps its blocks: the API
    // cannot know the space came back, so it must not say so.
    expect(result).not.toHaveProperty('spaceReclaimed');
    expect(result.message).toMatch(/cannot be restored/i);
    expect(result.message).toMatch(/still has the file open/i);
    expect(result.message).toContain('analyze_disk_usage');
  });

  it('a failed permanent delete is passed through without an outcome', async () => {
    deviceWithAgent(MIN_AGENT_VERSION_CLEANUP_GUARD);
    vi.mocked(aiExecuteCommand).mockResolvedValue({ status: 'failed', error: 'directory not empty' } as any);
    const result = await run({ action: 'delete', permanent: true });
    expect(result).toEqual({ status: 'failed', error: 'directory not empty' });
  });

  it('a permanent delete that timed out says it may still have happened', async () => {
    deviceWithAgent(MIN_AGENT_VERSION_CLEANUP_GUARD);
    vi.mocked(aiExecuteCommand).mockResolvedValue({ status: 'timeout', error: 'timed out' } as any);
    const result = await run({ action: 'delete', permanent: true });
    expect(result.status).toBe('timeout');
    expect(result.outcome).toBe('unverified');
    expect(result.message).toMatch(/may still have/i);
  });

  it('the permanent and unverified results survive the compactor with a large agent body', async () => {
    deviceWithAgent(MIN_AGENT_VERSION_CLEANUP_GUARD);
    const bulky = {
      status: 'completed',
      stdout: JSON.stringify({
        path: LOG_PATH, deleted: true, permanent: true, bytesFreed: 42,
        skippedLocked: Array.from({ length: 500 }, (_, i) => `/var/log/runaway/held-${i}.log`),
      }),
    };
    for (const [agentResult, outcome] of [[bulky, 'permanently_deleted'], [TRASH_RESULT, 'unverified']] as const) {
      vi.mocked(aiExecuteCommand).mockResolvedValue(agentResult as any);
      const tool = getFileOperationsTool();
      const raw = await tool.handler({ deviceId: DEVICE_ID, action: 'delete', path: LOG_PATH, permanent: true }, makeAuth());
      const seen = JSON.parse(compactToolResultForChat('file_operations', raw));
      expect(seen.outcome).toBe(outcome);
      expect(seen.message).toBe(JSON.parse(raw).message);
    }
  });

  it('a plain delete still works on an agent below the gate', async () => {
    deviceWithAgent('0.114.9');
    vi.mocked(aiExecuteCommand).mockResolvedValue(TRASH_RESULT as any);
    const result = await run({ action: 'delete' });
    expect(aiExecuteCommand).toHaveBeenCalledTimes(1);
    expect(result.outcome).toBe('moved_to_trash');
  });

  it.each(['0.114.9', '', null, 'not-a-version'])(
    'refuses agent %s without dispatching anything — never falls back to the trash',
    async (version) => {
      deviceWithAgent(version as string | null);
      const result = await run({ action: 'delete', permanent: true });
      expect(aiExecuteCommand).not.toHaveBeenCalled();
      expect(result.error).toBe('agent_update_required');
      expect(result.minAgentVersion).toBe(MIN_AGENT_VERSION_CLEANUP_GUARD);
      expect(result.message).toMatch(/nothing was deleted/i);
      expect(result.message).toContain('disk_cleanup');
    },
  );

  it('does not claim space was freed when the agent did not confirm a permanent delete', async () => {
    deviceWithAgent(MIN_AGENT_VERSION_CLEANUP_GUARD);
    vi.mocked(aiExecuteCommand).mockResolvedValue(TRASH_RESULT as any);
    const result = await run({ action: 'delete', permanent: true });
    expect(result.outcome).toBe('unverified');
    expect(result.spaceReclaimed).not.toBe(true);
    expect(result.message).toMatch(/did not confirm/i);
  });

  it('permanent: false is a plain trash delete', async () => {
    deviceWithAgent(MIN_AGENT_VERSION_CLEANUP_GUARD);
    vi.mocked(aiExecuteCommand).mockResolvedValue(TRASH_RESULT as any);
    const result = await run({ action: 'delete', permanent: false });
    expect(dispatchedPayload()).not.toHaveProperty('permanent');
    expect(result.outcome).toBe('moved_to_trash');
  });

  it('rejects permanent on any action other than delete', async () => {
    deviceWithAgent(MIN_AGENT_VERSION_CLEANUP_GUARD);
    const result = await run({ action: 'rename', newPath: '/tmp/x', permanent: true });
    expect(aiExecuteCommand).not.toHaveBeenCalled();
    expect(result.error).toMatch(/permanent/);
  });
});

describe('file_operations permanent delete — approval tier is unchanged (#9853)', () => {
  it('is Tier 3 supervised, the same as a plain delete and as disk_cleanup execute', () => {
    const permanent = checkGuardrails('file_operations', { action: 'delete', permanent: true });
    const plain = checkGuardrails('file_operations', { action: 'delete' });
    const cleanup = checkGuardrails('disk_cleanup', { action: 'execute' });
    expect(permanent.tier).toBe(3);
    expect(permanent.requiresApproval).toBe(true);
    expect(permanent.approvalScope).toBe(plain.approvalScope);
    expect(permanent.approvalScope).toBe(cleanup.approvalScope);
    expect(plain.tier).toBe(3);
    expect(cleanup.tier).toBe(3);
  });

  it('the approval prompt says the delete is permanent', () => {
    expect(buildApprovalDescription('file_operations', 'delete', { action: 'delete', path: LOG_PATH, permanent: true }))
      .toMatch(/permanent/i);
    expect(buildApprovalDescription('file_operations', 'delete', { action: 'delete', path: LOG_PATH }))
      .not.toMatch(/permanent/i);
  });

  it('the input schema accepts a boolean permanent and rejects anything else', () => {
    expect(validateToolInput('file_operations', { deviceId: DEVICE_ID, action: 'delete', path: LOG_PATH, permanent: true }).success).toBe(true);
    expect(validateToolInput('file_operations', { deviceId: DEVICE_ID, action: 'delete', path: LOG_PATH, permanent: 'yes' }).success).toBe(false);
  });

  it('the tool definition advertises permanent and tells the model a trash move frees nothing', () => {
    const tool = getFileOperationsTool();
    const props = tool.definition.input_schema.properties as Record<string, { type?: string }>;
    expect(props.permanent?.type).toBe('boolean');
    expect(tool.definition.description).toContain('disk_cleanup');
    expect(tool.definition.description).toMatch(/frees no (disk )?space/i);
  });
});
