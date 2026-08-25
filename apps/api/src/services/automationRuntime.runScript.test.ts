import { describe, it, expect, vi, beforeEach } from 'vitest';

// #3162: automation `run_script` actions must queue the command against a REAL
// script_executions row so handleScriptResult can persist the agent's stdout.
// The old synthetic `${runId}:${deviceId}:${actionIndex}` executionId could
// never match `script_executions.id` (a uuid column).
//
// #3409 PR0: the execution insert / queueCommand / claim-deliver / discard
// mechanics now live in services/scriptDispatch.ts (dispatchScriptToDevice),
// covered by its own test suite (scriptDispatch.test.ts). This file only
// covers what automationRuntime.ts itself still owns: the script-load / OS
// pre-check, mapping dispatch results onto action logs, and the caller-side
// 'queued' status write for the undelivered-but-queued case.

const { updateMock, dispatchMock, resolveOwnedAutomationReferencesMock } = vi.hoisted(() => ({
  updateMock: vi.fn(),
  dispatchMock: vi.fn(),
  resolveOwnedAutomationReferencesMock: vi.fn(),
}));

vi.mock('./automationReferenceAuthorization', () => ({
  AutomationReferenceAuthorizationError: class AutomationReferenceAuthorizationError extends Error {
    readonly code = 'unknown_or_unauthorized_reference';
    constructor() {
      super('Unknown or unauthorized automation reference');
    }
  },
  resolveOwnedAutomationReferences: resolveOwnedAutomationReferencesMock,
}));

vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: updateMock,
    delete: vi.fn(),
    transaction: vi.fn(),
  },
}));

vi.mock('./sentry', () => ({ captureException: vi.fn() }));

vi.mock('../db/schema', () => ({
  automationRuns: { id: 'id', automationId: 'automationId', status: 'status' },
  automationRunDeviceResults: { runId: 'runId', deviceId: 'deviceId' },
  automationResourceBindings: { automationId: 'automationId', state: 'state', resourceKind: 'resourceKind', resourceId: 'resourceId' },
  configPolicyAutomations: { featureLinkId: 'featureLinkId' },
  configurationPolicies: { id: 'id', orgId: 'orgId' },
  devices: { id: 'id', hostname: 'hostname', osType: 'osType', status: 'status', displayName: 'displayName', agentId: 'agentId' },
  organizations: { id: 'id', partnerId: 'partnerId' },
  scripts: { id: 'id', deletedAt: 'deletedAt' },
  scriptExecutions: { id: 'id', deviceId: 'deviceId', automationRunId: 'automationRunId', status: 'status' },
  notificationChannels: { id: 'id', orgId: 'orgId' },
  automations: { id: 'id', runCount: 'runCount', lastRunAt: 'lastRunAt', updatedAt: 'updatedAt' },
  alerts: { id: 'id' },
  alertRules: { id: 'id', orgId: 'orgId', name: 'name', targetType: 'targetType', targetId: 'targetId' },
  alertTemplates: { id: 'id', orgId: 'orgId', name: 'name' },
  deviceGroupMemberships: { deviceId: 'deviceId', groupId: 'groupId' },
}));

vi.mock('./eventBus', () => ({ publishEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('./deploymentEngine', () => ({ resolveDeploymentTargets: vi.fn().mockResolvedValue([]) }));
vi.mock('./scriptDispatch', () => ({ dispatchScriptToDevice: dispatchMock }));
vi.mock('./notificationSenders', () => ({
  getEmailRecipients: vi.fn().mockReturnValue([]),
  sendEmailNotification: vi.fn().mockResolvedValue({ success: false }),
  sendWebhookNotification: vi.fn().mockResolvedValue({ success: false }),
}));

import { db } from '../db';
import { createAutomationRunRecord, executeRunScriptAction } from './automationRuntime';

const EXECUTION_ID = '11111111-2222-4333-8444-555555555555';
const RUN_ID = '99999999-8888-4777-8666-555555555555';

const SCRIPT = {
  id: 'script-1',
  name: 'Collect logs',
  language: 'powershell',
  content: 'Get-Date',
  osTypes: ['windows'],
  timeoutSeconds: 300,
  runAs: 'system',
} as never;

const DEVICE = {
  id: 'device-1',
  orgId: 'org-1',
  hostname: 'HOST-1',
  displayName: null,
  osType: 'windows' as const,
  status: 'online',
  agentId: 'agent-1',
};

/** Captured `db.update(...).set(x)` payloads. */
let updatedValues: Array<Record<string, unknown>>;

function buildContext() {
  return {
    automation: { id: 'automation-1', name: 'Nightly', createdBy: 'user-1' },
    runId: RUN_ID,
    device: DEVICE,
    scriptsById: new Map([['script-1', SCRIPT]]),
    channelsById: new Map(),
  } as never;
}

beforeEach(() => {
  updatedValues = [];

  updateMock.mockReset().mockImplementation(() => ({
    set: (vals: Record<string, unknown>) => {
      updatedValues.push(vals);
      return { where: async () => undefined };
    },
  }));

  dispatchMock.mockReset().mockResolvedValue({
    ok: true,
    commandId: 'cmd-1',
    executionId: EXECUTION_ID,
    delivered: true,
    executedAt: new Date('2026-08-14T00:00:00.000Z'),
    ignoredParameters: [],
  });
  resolveOwnedAutomationReferencesMock.mockReset().mockResolvedValue({
    scriptsById: new Map(),
    softwareCatalogsById: new Map(),
    softwareVersionsByCatalogId: new Map(),
    notificationChannelsById: new Map(),
  });
  vi.mocked(db.transaction).mockImplementation(async (fn: any) => fn(db as any));
});

describe('createAutomationRunRecord — ownership admission', () => {
  it('rejects a moved script before creating a run or any downstream execution state', async () => {
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn(() => ({ where: vi.fn().mockResolvedValue([]) })),
    } as any);
    vi.mocked(db.insert).mockReturnValue({
      values: vi.fn(() => ({
        returning: vi.fn().mockResolvedValue([{ id: RUN_ID, logs: [] }]),
      })),
    } as any);
    resolveOwnedAutomationReferencesMock.mockRejectedValueOnce(
      Object.assign(new Error('Unknown or unauthorized automation reference'), {
        code: 'unknown_or_unauthorized_reference',
      }),
    );

    await expect(createAutomationRunRecord({
      automation: {
        id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        orgId: null,
        partnerId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        name: 'Moved reference',
        trigger: { type: 'manual' },
        conditions: null,
        actions: [{ type: 'run_script', scriptId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' }],
        onFailure: 'stop',
        notificationTargets: null,
      } as never,
      triggeredBy: 'manual:user-1',
    })).rejects.toMatchObject({ code: 'unknown_or_unauthorized_reference' });

    expect(vi.mocked(db.insert)).toHaveBeenCalledTimes(0);
    expect(dispatchMock).toHaveBeenCalledTimes(0);
  });
});

/** Flatten a drizzle SQL node into its literal tokens (column names + values). */
function collectSqlTokens(node: unknown): string[] {
  const found: string[] = [];
  const visit = (value: unknown) => {
    if (value == null) return;
    if (typeof value === 'string') {
      found.push(value);
      return;
    }
    if (typeof value !== 'object') return;
    for (const child of Object.values(value as Record<string, unknown>)) {
      if (Array.isArray(child)) child.forEach(visit);
      else visit(child);
    }
  };
  visit(node);
  return found;
}

describe('executeRunScriptAction — dispatch via scriptDispatch core (#3409 PR0)', () => {
  it('dispatches the saved script through the core with automation trigger metadata', async () => {
    const result = await executeRunScriptAction(
      { type: 'run_script', scriptId: 'script-1' },
      0,
      buildContext(),
    );

    expect(result.outcome.status).toBe('delivered');
    expect(dispatchMock).toHaveBeenCalledTimes(1);

    const input = dispatchMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(input.device).toBe(DEVICE);
    // automationRunId now lives on the 'saved' source variant, not the
    // top-level dispatch input (#3409 PR0 Wave A — makes a 'raw' source
    // silently dropping it an unrepresentable state).
    expect(input.source).toEqual({ kind: 'saved', script: SCRIPT, automationRunId: RUN_ID });
    expect(input.triggerType).toBe('automation');
    expect(input.triggeredBy).toBe('user-1');
    expect(input.createdBy).toBe('user-1');
    expect(input.runAs).toBe('system');
    expect(input.requireOnline).toBe(true);
  });

  it('logs success with the core-assigned commandId and executionId once delivered', async () => {
    const result = await executeRunScriptAction(
      { type: 'run_script', scriptId: 'script-1' },
      0,
      buildContext(),
    );

    expect(result.outcome).toEqual({
      status: 'delivered',
      commandId: 'cmd-1',
      scriptExecutionId: EXECUTION_ID,
    });
    expect(result.log.commandId).toBe('cmd-1');
    expect(result.log.details).toMatchObject({ scriptId: 'script-1', executionId: EXECUTION_ID });
    // Delivered: the core already wrote 'running' itself, so the caller must
    // not also write 'queued'.
    expect(updatedValues).toEqual([]);
  });

  it('advances the execution to queued when the core reports undelivered-but-queued', async () => {
    dispatchMock.mockResolvedValue({
      ok: true,
      commandId: 'cmd-1',
      executionId: EXECUTION_ID,
      delivered: false,
      executedAt: null,
      ignoredParameters: [],
    });

    const result = await executeRunScriptAction(
      { type: 'run_script', scriptId: 'script-1' },
      0,
      buildContext(),
    );

    expect(result.outcome).toEqual({
      status: 'queued',
      commandId: 'cmd-1',
      scriptExecutionId: EXECUTION_ID,
    });
    expect(updatedValues).toEqual([{ status: 'queued' }]);
  });

  it('guards the queued write on the execution id and pending status', async () => {
    dispatchMock.mockResolvedValue({
      ok: true,
      commandId: 'cmd-1',
      executionId: EXECUTION_ID,
      delivered: false,
      executedAt: null,
      ignoredParameters: [],
    });

    const whereArgs: unknown[] = [];
    updateMock.mockImplementation(() => ({
      set: (vals: Record<string, unknown>) => {
        updatedValues.push(vals);
        return {
          where: async (condition: unknown) => {
            whereArgs.push(condition);
          },
        };
      },
    }));

    await executeRunScriptAction(
      { type: 'run_script', scriptId: 'script-1' },
      0,
      buildContext(),
    );

    expect(whereArgs).toHaveLength(1);
    const tokens = collectSqlTokens(whereArgs[0]);
    expect(tokens).toContain(EXECUTION_ID);
    expect(tokens).toContain('status');
    expect(tokens).toContain('pending');
  });

  it('does not write a status update when the core reports no executionId', async () => {
    dispatchMock.mockResolvedValue({
      ok: true,
      commandId: 'cmd-1',
      executionId: null,
      delivered: false,
      executedAt: null,
      ignoredParameters: [],
    });

    await executeRunScriptAction(
      { type: 'run_script', scriptId: 'script-1' },
      0,
      buildContext(),
    );

    expect(updatedValues).toEqual([]);
  });

  it('logs failure with the core error when the device is offline (requireOnline gate)', async () => {
    dispatchMock.mockResolvedValue({
      ok: false,
      code: 'device_offline',
      error: 'Device is offline, cannot execute command',
    });

    const result = await executeRunScriptAction(
      { type: 'run_script', scriptId: 'script-1' },
      0,
      buildContext(),
    );

    expect(result.outcome.status).toBe('failed');
    expect(result.log.details).toMatchObject({
      error: 'Device is offline, cannot execute command',
      scriptId: 'script-1',
    });
    // No status write to make — the core never inserted an execution row for
    // an offline device (requireOnline is checked before any insert).
    expect(updatedValues).toEqual([]);
  });

  it('propagates a dispatch throw (the core discards its own pending execution row)', async () => {
    const boom = new Error('connection terminated');
    dispatchMock.mockRejectedValue(boom);

    await expect(executeRunScriptAction(
      { type: 'run_script', scriptId: 'script-1' },
      0,
      buildContext(),
    )).rejects.toThrow('connection terminated');

    // No orphan-row discard logic lives here anymore (#3409 PR0) — it's inside
    // dispatchScriptToDevice and asserted by scriptDispatch.test.ts.
    expect(updatedValues).toEqual([]);
  });

  it('does not dispatch when the script is missing', async () => {
    const context = buildContext() as unknown as { scriptsById: Map<string, unknown> };
    context.scriptsById = new Map();

    const result = await executeRunScriptAction(
      { type: 'run_script', scriptId: 'script-1' },
      0,
      context as never,
    );

    expect(result.outcome.status).toBe('failed');
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it('does not dispatch when the script OS does not match the device', async () => {
    const context = buildContext() as unknown as {
      scriptsById: Map<string, unknown>;
    };
    context.scriptsById = new Map([['script-1', { ...(SCRIPT as object), osTypes: ['linux'] }]]);

    const result = await executeRunScriptAction(
      { type: 'run_script', scriptId: 'script-1' },
      0,
      context as never,
    );

    expect(result.outcome.status).toBe('failed');
    expect(dispatchMock).not.toHaveBeenCalled();
  });
});
