import { describe, it, expect, vi, beforeEach } from 'vitest';

// #3162: automation `run_script` actions must queue the command against a REAL
// script_executions row so handleScriptResult can persist the agent's stdout.
// The old synthetic `${runId}:${deviceId}:${actionIndex}` executionId could
// never match `script_executions.id` (a uuid column).

const { insertMock, updateMock, deleteMock, queueMock } = vi.hoisted(() => ({
  insertMock: vi.fn(),
  updateMock: vi.fn(),
  deleteMock: vi.fn(),
  queueMock: vi.fn(),
}));

vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: {
    select: vi.fn(),
    insert: insertMock,
    update: updateMock,
    delete: deleteMock,
  },
}));

vi.mock('./sentry', () => ({ captureException: vi.fn() }));

vi.mock('../db/schema', () => ({
  automationRuns: { id: 'id', automationId: 'automationId', status: 'status' },
  automationRunDeviceResults: { runId: 'runId', deviceId: 'deviceId' },
  configPolicyAutomations: { featureLinkId: 'featureLinkId' },
  configurationPolicies: { id: 'id', orgId: 'orgId' },
  devices: { id: 'id', hostname: 'hostname', osType: 'osType', status: 'status', displayName: 'displayName' },
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
vi.mock('./commandQueue', () => ({
  CommandTypes: { SCRIPT: 'script' },
  queueCommandForExecution: queueMock,
}));
vi.mock('./notificationSenders', () => ({
  getEmailRecipients: vi.fn().mockReturnValue([]),
  sendEmailNotification: vi.fn().mockResolvedValue({ success: false }),
  sendWebhookNotification: vi.fn().mockResolvedValue({ success: false }),
}));

import { executeRunScriptAction } from './automationRuntime';

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
};

/** Captured `db.insert(...).values(x)` payloads. */
let insertedValues: Array<Record<string, unknown>>;
/** Captured `db.update(...).set(x)` payloads. */
let updatedValues: Array<Record<string, unknown>>;
/** Number of `db.delete(...)` calls (the unqueued-execution discard). */
let deleteCount: number;
/** Rows the mocked DELETE reports as removed. */
let deleteReturns: Array<{ id: string }>;

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
  insertedValues = [];
  updatedValues = [];
  deleteCount = 0;
  deleteReturns = [{ id: EXECUTION_ID }];

  deleteMock.mockReset().mockImplementation(() => {
    deleteCount += 1;
    return { where: () => ({ returning: async () => deleteReturns }) };
  });

  insertMock.mockReset().mockImplementation(() => ({
    values: (vals: Record<string, unknown>) => {
      insertedValues.push(vals);
      return { returning: async () => [{ id: EXECUTION_ID }] };
    },
  }));

  updateMock.mockReset().mockImplementation(() => ({
    set: (vals: Record<string, unknown>) => {
      updatedValues.push(vals);
      return { where: async () => undefined };
    },
  }));

  queueMock.mockReset().mockResolvedValue({ command: { id: 'cmd-1' } });
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

describe('executeRunScriptAction — script_executions correlation (#3162)', () => {
  it('queues the command with the minted script_executions uuid, not a synthetic id', async () => {
    const result = await executeRunScriptAction(
      { type: 'run_script', scriptId: 'script-1' },
      0,
      buildContext(),
    );

    expect(result.success).toBe(true);
    expect(queueMock).toHaveBeenCalledTimes(1);

    const payload = queueMock.mock.calls[0]![2] as Record<string, unknown>;
    expect(payload.executionId).toBe(EXECUTION_ID);
    // The pre-#3162 shape — must never come back.
    expect(payload.executionId).not.toContain(':');
  });

  it('records the execution against the device org and the automation run', async () => {
    await executeRunScriptAction(
      { type: 'run_script', scriptId: 'script-1' },
      0,
      buildContext(),
    );

    expect(insertedValues).toHaveLength(1);
    expect(insertedValues[0]).toMatchObject({
      scriptId: 'script-1',
      deviceId: 'device-1',
      // DEVICE's org, never the automation's — a partner-wide automation has none.
      orgId: 'org-1',
      triggeredBy: 'user-1',
      triggerType: 'automation',
      automationRunId: RUN_ID,
      status: 'pending',
    });
  });

  it('advances the execution to queued when the command was only enqueued', async () => {
    await executeRunScriptAction(
      { type: 'run_script', scriptId: 'script-1' },
      0,
      buildContext(),
    );

    expect(updatedValues).toEqual([{ status: 'queued' }]);
  });

  it('advances the execution to running with a start time once the command is on the wire', async () => {
    const executedAt = new Date('2026-08-14T00:00:00.000Z');
    queueMock.mockResolvedValue({ command: { id: 'cmd-1', status: 'sent', executedAt } });

    await executeRunScriptAction(
      { type: 'run_script', scriptId: 'script-1' },
      0,
      buildContext(),
    );

    // Mirrors the manual path — the UI derives a duration from startedAt.
    expect(updatedValues).toEqual([{ status: 'running', startedAt: executedAt }]);
  });

  it('guards every post-queue transition on the row still being pending', async () => {
    // queueCommandForExecution delivers over the WebSocket synchronously, so a
    // fast agent can drive the row terminal (with its stdout) before we get
    // here. An unguarded write would flip it back to queued and the reaper
    // would later mark it timeout.
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
    // `and(eq(id, …), eq(status, 'pending'))` — two conjuncts, not a bare id.
    // Assert on the bound parameter values so removing the status conjunct
    // fails here rather than passing on an incidental substring match.
    const tokens = collectSqlTokens(whereArgs[0]);
    expect(tokens).toContain(EXECUTION_ID);
    expect(tokens).toContain('status');
    expect(tokens).toContain('pending');
  });

  it('leaves the online/offline decision to queueCommandForExecution', async () => {
    // The run's device snapshot is taken once at the top of a fleet run and can
    // be minutes stale, so this must NOT pre-filter on it — queueCommandForExecution
    // re-reads devices.status live, and execute_command relies on that same check.
    const context = buildContext() as unknown as { device: { status: string } };
    context.device = { ...DEVICE, status: 'offline' };

    await executeRunScriptAction(
      { type: 'run_script', scriptId: 'script-1' },
      0,
      context as never,
    );

    expect(queueMock).toHaveBeenCalledTimes(1);
  });

  it('discards the execution row instead of stranding it when queueing fails', async () => {
    queueMock.mockResolvedValue({ command: null, error: 'Device is offline, cannot execute command' });

    const result = await executeRunScriptAction(
      { type: 'run_script', scriptId: 'script-1' },
      0,
      buildContext(),
    );

    expect(result.success).toBe(false);
    // No command was queued, so no execution happened — the row is removed
    // rather than left `failed`, which would add one row per offline device
    // per run and let the reaper misreport it as an agent timeout.
    expect(deleteCount).toBe(1);
    expect(updatedValues).toEqual([]);
    expect(result.log.details).toMatchObject({ error: 'Device is offline, cannot execute command' });
  });

  it('discards the execution row and rethrows when queueing throws', async () => {
    const boom = new Error('connection terminated');
    queueMock.mockRejectedValue(boom);

    await expect(executeRunScriptAction(
      { type: 'run_script', scriptId: 'script-1' },
      0,
      buildContext(),
    )).rejects.toThrow('connection terminated');

    expect(deleteCount).toBe(1);
  });

  it('warns rather than silently continuing when the discard removes nothing', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      queueMock.mockResolvedValue({ command: null, error: 'Device not found' });
      deleteReturns = [];

      await executeRunScriptAction(
        { type: 'run_script', scriptId: 'script-1' },
        0,
        buildContext(),
      );

      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('was not pending at discard time'));
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('does not create an execution row when the script is missing', async () => {
    const context = buildContext() as unknown as { scriptsById: Map<string, unknown> };
    context.scriptsById = new Map();

    const result = await executeRunScriptAction(
      { type: 'run_script', scriptId: 'script-1' },
      0,
      context as never,
    );

    expect(result.success).toBe(false);
    expect(insertMock).not.toHaveBeenCalled();
    expect(queueMock).not.toHaveBeenCalled();
  });

  it('does not create an execution row when the script OS does not match the device', async () => {
    const context = buildContext() as unknown as {
      scriptsById: Map<string, unknown>;
    };
    context.scriptsById = new Map([['script-1', { ...(SCRIPT as object), osTypes: ['linux'] }]]);

    const result = await executeRunScriptAction(
      { type: 'run_script', scriptId: 'script-1' },
      0,
      context as never,
    );

    expect(result.success).toBe(false);
    expect(insertMock).not.toHaveBeenCalled();
    expect(queueMock).not.toHaveBeenCalled();
  });
});
