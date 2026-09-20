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
  listArgs: [] as Record<string, unknown>[],
  runArgs: [] as Record<string, unknown>[],
  awaitArgs: [] as unknown[][],
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
    auditState.rows = [];
    serviceState.listResult = { ok: true, commandId: 'cmd-list-1' };
    serviceState.runResult = { ok: true, commandId: 'cmd-run-1', cleanupRunId: 'run-9' };
    serviceState.awaited = { status: 'completed', result: { catalogVersion: 1, actions: [], volumesBefore: [] } };
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
    expect(Object.keys(props).sort()).toEqual(['action', 'actionIds', 'deviceId', 'params']);
    expect((props.action as { enum: string[] }).enum).toEqual(['list', 'run']);
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
    // The wait is scoped to the device's org, not the caller's context.
    expect(serviceState.awaitArgs[0]!.slice(0, 2)).toEqual(['cmd-list-1', ORG_ID]);
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

  it('run delegates to the shared service, waits, reports the measured result and audits it', async () => {
    serviceState.awaited = {
      status: 'completed',
      result: {
        runId: 'run-9',
        freedBytes: 1234,
        actions: [{ id: 'linux_pkg_cache_clean', status: 'completed', exitCode: 0 }],
        volumes: [{ mount: '/', freeBefore: 10, freeAfter: 1244 }],
      },
    };
    const raw = await getTool('system_cleanup').handler(
      { deviceId: DEVICE_ID, action: 'run', actionIds: ['linux_pkg_cache_clean'] },
      makeAuth(),
    );
    const result = JSON.parse(raw);

    expect(result.error).toBeUndefined();
    expect(result.cleanupRunId).toBe('run-9');
    expect(result.commandId).toBe('cmd-run-1');
    expect(result.status).toBe('completed');
    expect(result.freedBytes).toBe(1234);
    expect(result.actions).toHaveLength(1);
    expect(result.volumes).toHaveLength(1);
    expect(serviceState.runArgs[0]).toMatchObject({
      actionIds: ['linux_pkg_cache_clean'],
      aiOrigin: { kind: 'ai_assistant', sessionId: 'sess-1' },
    });
    expect(auditState.rows).toHaveLength(1);
    expect(auditState.rows[0]).toMatchObject({
      orgId: ORG_ID,
      action: 'device.filesystem.system_cleanup.run',
      resourceId: DEVICE_ID,
      result: 'success',
      details: { cleanupRunId: 'run-9', surface: 'ai_tool', freedBytes: 1234 },
    });
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
});
