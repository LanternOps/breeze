import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Disk Cleanup v2 W05 — `system_cleanup` AI tool (spec §9.1, §9.3 items 1-2).
 *
 * The handler is THIN: gate, validation, run row and dispatch all live in
 * services/systemCleanup.ts (mocked here as the seam). This suite pins what
 * the handler itself owns — registration shape, access check ordering, the
 * aiOrigin requirement, and how the service's answers are surfaced.
 */

const DEVICE_ID = '33333333-3333-3333-3333-333333333333';
const ORG_ID = '11111111-1111-1111-1111-111111111111';
const RUN_ID = '44444444-4444-4444-8444-444444444444';
const DEADLINE = '2026-09-19T10:20:00.000Z';

const dbMockState = vi.hoisted(() => ({
  deviceRows: [] as unknown[],
  userRows: [] as unknown[],
}));

vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
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
      values: vi.fn(() => ({ returning: vi.fn(async () => [{ id: 'run-1' }]) })),
    })),
  },
}));

const serviceState = vi.hoisted(() => ({
  listResult: { ok: true, commandId: 'cmd-list-1' } as Record<string, unknown>,
  runResult: { ok: true, commandId: 'cmd-run-1', cleanupRunId: 'run-9' } as Record<string, unknown>,
  awaited: { status: 'completed', result: { catalogVersion: 1, actions: [], volumesBefore: [] } } as Record<string, unknown>,
  statusResult: { ok: false, status: 404, error: 'run_not_found' } as Record<string, unknown>,
  listArgs: [] as Record<string, unknown>[],
  runArgs: [] as Record<string, unknown>[],
  awaitArgs: [] as unknown[][],
  statusArgs: [] as Record<string, unknown>[],
}));

vi.mock('./systemCleanup', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./systemCleanup')>();
  return {
    ...actual,
    queueSystemCleanupList: vi.fn(async (args: Record<string, unknown>) => {
      serviceState.listArgs.push(args);
      return serviceState.listResult;
    }),
    startSystemCleanupRun: vi.fn(async (args: Record<string, unknown>) => {
      serviceState.runArgs.push(args);
      return serviceState.runResult;
    }),
    awaitSystemCleanupResult: vi.fn(async (...args: unknown[]) => {
      serviceState.awaitArgs.push(args);
      return serviceState.awaited;
    }),
    resolveSystemCleanupRunStatus: vi.fn(async (args: Record<string, unknown>) => {
      serviceState.statusArgs.push(args);
      return serviceState.statusResult;
    }),
  };
});

vi.mock('./commandQueue', () => ({
  executeCommand: vi.fn(),
  executeCommandWithSystemPrecheck: vi.fn(async () => ({ status: 'completed', stdout: '{}' })),
  CommandTypes: new Proxy({}, { get: (_t, prop) => String(prop) }),
}));

const auditState = vi.hoisted(() => ({ rows: [] as Record<string, unknown>[] }));
vi.mock('./auditService', () => ({
  createAuditLogAsync: vi.fn(async (row: Record<string, unknown>) => { auditState.rows.push(row); }),
}));
vi.mock('./auditEvents', () => ({ writeAuditEvent: vi.fn(), requestLikeFromSnapshot: vi.fn(() => ({})) }));

vi.mock('./filesystemAnalysis', () => ({
  buildCleanupPreview: vi.fn(() => ({ candidates: [], estimatedBytes: 0, candidateCount: 0, categories: [] })),
  getLatestFilesystemSnapshot: vi.fn(),
  getLatestFilesystemCleanupSnapshot: vi.fn(async () => null),
  parseFilesystemAnalysisStdout: vi.fn(),
  setFilesystemScanGeneration: vi.fn(),
  clearFilesystemScanGeneration: vi.fn(),
  readPlanPreviewCandidates: vi.fn(() => []),
  saveFilesystemSnapshot: vi.fn(),
  safeCleanupCategories: ['temp_files'],
}));

import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';
import { registerFilesystemTools } from './aiToolsFilesystem';

function getTool(name: string): AiTool {
  const aiTools = new Map<string, AiTool>();
  registerFilesystemTools(aiTools);
  const tool = aiTools.get(name);
  if (!tool) throw new Error(`${name} tool not registered`);
  return tool;
}

function makeAuth(overrides: Partial<AuthContext> = {}): AuthContext {
  return {
    user: { id: 'user-1', email: 'tech@example.com', name: 'Tech' },
    token: {} as unknown,
    partnerId: null,
    orgId: ORG_ID,
    scope: 'organization',
    accessibleOrgIds: [ORG_ID],
    canAccessOrg: (orgId: string) => orgId === ORG_ID,
    orgCondition: vi.fn(() => undefined),
    aiOrigin: { kind: 'ai_assistant', sessionId: 'sess-1' },
    ...overrides,
  } as unknown as AuthContext;
}

describe('system_cleanup AI tool (spec §9.1, §9.3 items 1-2)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    serviceState.listArgs = [];
    serviceState.runArgs = [];
    serviceState.awaitArgs = [];
    serviceState.statusArgs = [];
    auditState.rows = [];
    serviceState.listResult = { ok: true, commandId: 'cmd-list-1' };
    serviceState.runResult = { ok: true, commandId: 'cmd-run-1', cleanupRunId: 'run-9', deadlineAt: DEADLINE };
    serviceState.awaited = { status: 'completed', result: { catalogVersion: 1, actions: [], volumesBefore: [] } };
    serviceState.statusResult = { ok: false, status: 404, error: 'run_not_found' };
    dbMockState.userRows = [{ id: 'user-1' }];
    dbMockState.deviceRows = [
      { id: DEVICE_ID, orgId: ORG_ID, siteId: null, hostname: 'lab-1', status: 'online', osType: 'linux', agentVersion: '0.115.0' },
    ];
  });

  it('registers at tier 1 and declares its device arg for the central gate', () => {
    const tool = getTool('system_cleanup');
    expect(tool.tier).toBe(1);
    expect(tool.domain).toBe('devices');
    // Amendment B1: an ARRAY, and its absence misattributes the MCP ledger to
    // the caller's first accessible org rather than erroring.
    expect(tool.deviceArgs).toEqual(['deviceId']);
    const props = tool.definition.input_schema.properties as Record<string, unknown>;
    expect(Object.keys(props).sort()).toEqual(['action', 'actionIds', 'cleanupRunId', 'commandId', 'deviceId', 'params']);
    expect((props.action as { enum: string[] }).enum).toEqual(['list', 'run', 'status']);
    expect(tool.definition.input_schema.required).toEqual(['deviceId', 'action']);
  });

  it('list delegates to the shared service and returns the agent catalog', async () => {
    const raw = await getTool('system_cleanup').handler({ deviceId: DEVICE_ID, action: 'list' }, makeAuth());
    const result = JSON.parse(raw);

    expect(result.error).toBeUndefined();
    expect(result.commandId).toBe('cmd-list-1');
    expect(result.catalog).toEqual({ catalogVersion: 1, actions: [], volumesBefore: [] });
    expect(serviceState.listArgs).toHaveLength(1);
    expect(serviceState.listArgs[0]).toMatchObject({
      device: { id: DEVICE_ID, orgId: ORG_ID, agentVersion: '0.115.0', status: 'online' },
      requestedBy: 'user-1',
      aiOrigin: { kind: 'ai_assistant', sessionId: 'sess-1' },
    });
    // F2: the wait is scoped by the VERIFIED device and the command type — the
    // org context filters nothing on device_commands.
    expect(serviceState.awaitArgs[0]![0]).toEqual({
      commandId: 'cmd-list-1', deviceId: DEVICE_ID, orgId: ORG_ID, type: 'system_cleanup_list',
    });
    // F1: no single tool call holds a pooled connection for more than ~60 s.
    expect(serviceState.awaitArgs[0]![1]).toBeLessThanOrEqual(60_000);
    expect(result.status).toBe('completed');
  });

  it('list answers pending with the commandId when the 60 s cap passes, instead of holding on', async () => {
    serviceState.awaited = { status: 'timeout', error: 'timed out' };
    const raw = await getTool('system_cleanup').handler({ deviceId: DEVICE_ID, action: 'list' }, makeAuth());
    const result = JSON.parse(raw);
    expect(result.error).toBeUndefined();
    expect(result).toMatchObject({ status: 'pending', commandId: 'cmd-list-1' });
    expect(typeof result.note).toBe('string');
  });

  it('list with a commandId re-checks THAT command (device + type verified) and dispatches nothing', async () => {
    const raw = await getTool('system_cleanup').handler(
      { deviceId: DEVICE_ID, action: 'list', commandId: 'cmd-list-earlier' },
      makeAuth(),
    );
    const result = JSON.parse(raw);
    expect(result.status).toBe('completed');
    expect(result.commandId).toBe('cmd-list-earlier');
    expect(serviceState.listArgs).toHaveLength(0);
    expect(serviceState.awaitArgs[0]![0]).toEqual({
      commandId: 'cmd-list-earlier', deviceId: DEVICE_ID, orgId: ORG_ID, type: 'system_cleanup_list',
    });
  });

  it('list with a commandId that is not this device\'s catalog command answers not found', async () => {
    serviceState.awaited = { status: 'not_found', error: 'command not found' };
    const raw = await getTool('system_cleanup').handler(
      { deviceId: DEVICE_ID, action: 'list', commandId: 'cmd-of-another-device' },
      makeAuth(),
    );
    expect(JSON.parse(raw)).toEqual({ error: 'command not found' });
  });

  it('list rejects an unreadable catalog rather than presenting an empty one', async () => {
    serviceState.awaited = { status: 'completed', result: { nope: true } };
    const raw = await getTool('system_cleanup').handler({ deviceId: DEVICE_ID, action: 'list' }, makeAuth());
    expect(JSON.parse(raw).error).toBe('The agent returned an unreadable cleanup catalog');
  });

  it('run requires actionIds', async () => {
    const raw = await getTool('system_cleanup').handler({ deviceId: DEVICE_ID, action: 'run' }, makeAuth());
    expect(JSON.parse(raw).error).toBe('actionIds are required for the run action');
    expect(serviceState.runArgs).toHaveLength(0);
  });

  it('run dispatches, audits ONCE at dispatch, and returns immediately with a status handle (F1)', async () => {
    const raw = await getTool('system_cleanup').handler(
      { deviceId: DEVICE_ID, action: 'run', actionIds: ['linux_pkg_cache_clean'] },
      makeAuth(),
    );
    const result = JSON.parse(raw);

    expect(result.error).toBeUndefined();
    expect(result).toEqual({
      status: 'running',
      cleanupRunId: 'run-9',
      commandId: 'cmd-run-1',
      deviceId: DEVICE_ID,
      actionIds: ['linux_pkg_cache_clean'],
      deadlineAt: DEADLINE,
      note: expect.stringContaining('status'),
    });
    expect(result.note).toContain('cleanupRunId');
    // No wait at all: the SDK's per-tool context must not be pinned for a
    // three-hour DISM run (#1105 class).
    expect(serviceState.awaitArgs).toHaveLength(0);
    expect(serviceState.statusArgs).toHaveLength(0);
    expect(serviceState.runArgs[0]).toMatchObject({
      actionIds: ['linux_pkg_cache_clean'],
      aiOrigin: { kind: 'ai_assistant', sessionId: 'sess-1' },
    });
    // The "an AI surface asked for this" row, written once, at dispatch. The
    // result handler owns completion.
    expect(auditState.rows).toHaveLength(1);
    expect(auditState.rows[0]).toMatchObject({
      orgId: ORG_ID,
      action: 'device.filesystem.system_cleanup.run',
      resourceId: DEVICE_ID,
      initiatedBy: 'ai',
      result: 'success',
      details: { cleanupRunId: 'run-9', commandId: 'cmd-run-1', surface: 'ai_tool', status: 'running', actionIds: ['linux_pkg_cache_clean'] },
    });
    expect((auditState.rows[0]!.details as Record<string, unknown>).freedBytes).toBeUndefined();
  });

  it('degrades requestedBy to null for an ai_agent principal that is not a users row', async () => {
    dbMockState.userRows = [];
    await getTool('system_cleanup').handler(
      { deviceId: DEVICE_ID, action: 'run', actionIds: ['linux_pkg_cache_clean'] },
      makeAuth({ user: { id: 'agent-1', email: 'agent@example.com', name: 'Agent' } } as Partial<AuthContext>),
    );
    expect(serviceState.runArgs[0]).toMatchObject({ requestedBy: null });
  });

  it('surfaces the 409 agent gate verbatim instead of dispatching', async () => {
    serviceState.listResult = {
      ok: false, status: 409, error: 'agent_update_required', minAgentVersion: '0.115.0',
    };
    const raw = await getTool('system_cleanup').handler({ deviceId: DEVICE_ID, action: 'list' }, makeAuth());
    const result = JSON.parse(raw);

    expect(result.error).toBe('agent_update_required');
    expect(result.minAgentVersion).toBe('0.115.0');
    expect(serviceState.awaitArgs).toHaveLength(0);
  });

  it('surfaces run_in_progress with the in-flight run id', async () => {
    serviceState.runResult = { ok: false, status: 409, error: 'run_in_progress', cleanupRunId: 'run-other' };
    const raw = await getTool('system_cleanup').handler(
      { deviceId: DEVICE_ID, action: 'run', actionIds: ['linux_pkg_cache_clean'] },
      makeAuth(),
    );
    const result = JSON.parse(raw);
    expect(result.error).toBe('run_in_progress');
    expect(result.cleanupRunId).toBe('run-other');
    // #6485 F-4: the model narrated this refusal as "approved and is now
    // running" because the payload looked like a success (a cleanupRunId and
    // no unambiguous refusal marker). `refused: true` plus a sentence a model
    // cannot paraphrase into an approval closes that.
    expect(result.refused).toBe(true);
    expect(typeof result.note).toBe('string');
    expect(result.note).toMatch(/already (in progress|running)/i);
    expect(result.note).toMatch(/do not start (a |)another/i);
  });

  it('refuses a device the caller cannot reach, before any dispatch', async () => {
    dbMockState.deviceRows = [];
    const raw = await getTool('system_cleanup').handler({ deviceId: DEVICE_ID, action: 'list' }, makeAuth());
    expect(JSON.parse(raw).error).toBe('Device not found or access denied');
    expect(serviceState.listArgs).toHaveLength(0);
  });

  it('refuses an AuthContext with no aiOrigin rather than dispatching unattributed', async () => {
    await expect(
      getTool('system_cleanup').handler(
        { deviceId: DEVICE_ID, action: 'list' },
        makeAuth({ aiOrigin: undefined } as Partial<AuthContext>),
      ),
    ).rejects.toThrow(/aiOrigin/);
    expect(serviceState.listArgs).toHaveLength(0);
  });

  describe('status action', () => {
    it('requires a cleanupRunId', async () => {
      const raw = await getTool('system_cleanup').handler({ deviceId: DEVICE_ID, action: 'status' }, makeAuth());
      expect(JSON.parse(raw).error).toBe('cleanupRunId is required for the status action');
      expect(serviceState.statusArgs).toHaveLength(0);
    });

    it('reads the run through the SHARED resolver, scoped to the verified device, and writes no audit row', async () => {
      serviceState.statusResult = {
        ok: true,
        run: {
          cleanupRunId: RUN_ID, commandId: 'cmd-run-1', status: 'running', error: null, freedBytes: 0,
          actions: [], volumes: [], requestedAt: new Date('2026-09-19T10:00:00Z'), deadlineAt: DEADLINE,
        },
      };
      const raw = await getTool('system_cleanup').handler({ deviceId: DEVICE_ID, action: 'status', cleanupRunId: RUN_ID }, makeAuth());
      const result = JSON.parse(raw);
      expect(result).toMatchObject({ cleanupRunId: RUN_ID, status: 'running', deadlineAt: DEADLINE, freedBytes: 0 });
      expect(result.error).toBeUndefined();
      expect(serviceState.statusArgs[0]).toEqual({ device: { id: DEVICE_ID, orgId: ORG_ID }, cleanupRunId: RUN_ID });
      expect(auditState.rows).toHaveLength(0);
      expect(serviceState.listArgs).toHaveLength(0);
      expect(serviceState.runArgs).toHaveLength(0);
    });

    it('reports the persisted result of a finished run — the result handler is authoritative', async () => {
      serviceState.statusResult = {
        ok: true,
        run: {
          cleanupRunId: RUN_ID, commandId: 'cmd-run-1', status: 'executed', error: null, freedBytes: 1234,
          actions: [{ id: 'linux_pkg_cache_clean', status: 'completed', exitCode: 0 }],
          volumes: [{ mount: '/', freeBefore: 10, freeAfter: 1244 }],
          requestedAt: new Date('2026-09-19T10:00:00Z'), deadlineAt: DEADLINE,
        },
      };
      const raw = await getTool('system_cleanup').handler({ deviceId: DEVICE_ID, action: 'status', cleanupRunId: RUN_ID }, makeAuth());
      const result = JSON.parse(raw);
      expect(result).toMatchObject({ status: 'executed', freedBytes: 1234 });
      expect(result.actions).toHaveLength(1);
      expect(result.volumes).toHaveLength(1);
    });

    it('reports a run whose every action failed as failed (F3), with the handler\'s error', async () => {
      serviceState.statusResult = {
        ok: true,
        run: {
          cleanupRunId: RUN_ID, commandId: 'cmd-run-1', status: 'failed', error: '1 cleanup action(s) did not complete',
          freedBytes: 0, actions: [{ id: 'win_cleanmgr', status: 'failed', exitCode: 1 }], volumes: [],
          requestedAt: new Date(), deadlineAt: DEADLINE,
        },
      };
      const raw = await getTool('system_cleanup').handler({ deviceId: DEVICE_ID, action: 'status', cleanupRunId: RUN_ID }, makeAuth());
      expect(JSON.parse(raw)).toMatchObject({ status: 'failed', error: '1 cleanup action(s) did not complete', freedBytes: 0 });
    });

    it('surfaces a run the resolver finalised past its deadline as failed/timed out (F4)', async () => {
      serviceState.statusResult = {
        ok: true,
        run: {
          cleanupRunId: RUN_ID, commandId: 'cmd-run-1', status: 'failed', error: 'timed out',
          freedBytes: 0, actions: [], volumes: [], requestedAt: new Date(), deadlineAt: DEADLINE,
        },
      };
      const raw = await getTool('system_cleanup').handler({ deviceId: DEVICE_ID, action: 'status', cleanupRunId: RUN_ID }, makeAuth());
      expect(JSON.parse(raw)).toMatchObject({ status: 'failed', error: 'timed out' });
    });

    it('answers not found for a run outside the verified device', async () => {
      const raw = await getTool('system_cleanup').handler({ deviceId: DEVICE_ID, action: 'status', cleanupRunId: RUN_ID }, makeAuth());
      expect(JSON.parse(raw)).toEqual({ error: 'Cleanup run not found' });
    });

    it('does not require the device to be online', async () => {
      dbMockState.deviceRows = [{ ...dbMockState.deviceRows[0] as Record<string, unknown>, status: 'offline' }];
      serviceState.statusResult = {
        ok: true,
        run: { cleanupRunId: RUN_ID, commandId: 'cmd-run-1', status: 'running', error: null, freedBytes: 0, actions: [], volumes: [], requestedAt: new Date(), deadlineAt: DEADLINE },
      };
      const raw = await getTool('system_cleanup').handler({ deviceId: DEVICE_ID, action: 'status', cleanupRunId: RUN_ID }, makeAuth());
      expect(JSON.parse(raw).status).toBe('running');
    });
  });

  describe('F5 — every agent_update_required answer carries minAgentVersion', () => {
    const expected = { error: 'agent_update_required', minAgentVersion: '0.115.0' };

    it('from the list gate', async () => {
      serviceState.listResult = { ok: false, status: 409, error: 'agent_update_required', minAgentVersion: '0.115.0' };
      const raw = await getTool('system_cleanup').handler({ deviceId: DEVICE_ID, action: 'list' }, makeAuth());
      expect(JSON.parse(raw)).toEqual(expected);
    });

    it('from the awaited list command (the agent\'s "unknown command type:" fallback)', async () => {
      serviceState.awaited = { status: 'failed', error: 'agent_update_required' };
      const raw = await getTool('system_cleanup').handler({ deviceId: DEVICE_ID, action: 'list' }, makeAuth());
      expect(JSON.parse(raw)).toEqual(expected);
    });

    it('from the run gate', async () => {
      serviceState.runResult = { ok: false, status: 409, error: 'agent_update_required', minAgentVersion: '0.115.0' };
      const raw = await getTool('system_cleanup').handler(
        { deviceId: DEVICE_ID, action: 'run', actionIds: ['linux_pkg_cache_clean'] },
        makeAuth(),
      );
      expect(JSON.parse(raw)).toEqual(expected);
      expect(auditState.rows).toHaveLength(0);
    });

    it('from status (unknown command type on the run or its command)', async () => {
      serviceState.statusResult = { ok: false, status: 409, error: 'agent_update_required', minAgentVersion: '0.115.0' };
      const raw = await getTool('system_cleanup').handler({ deviceId: DEVICE_ID, action: 'status', cleanupRunId: RUN_ID }, makeAuth());
      expect(JSON.parse(raw)).toEqual(expected);
    });
  });
});
