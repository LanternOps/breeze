import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * #5128 W4 — the `whenOffline` automation-action option and the `queued` step
 * state it produces.
 *
 * Four axes are asserted here because each is independently load-bearing: the
 * ACTION's choice ('queue'/'skip'), the FLAG
 * (`DEVICE_COMMAND_OFFLINE_QUEUE_ENABLED`), the OUTCOME written to
 * `automation_action_results`, and the fact that a queued step does NOT fail
 * the run — which is what would silently break every existing automation the
 * moment the flag default flipped on.
 */

const { updateMock, dispatchMock, recordDispatchMock } = vi.hoisted(() => ({
  updateMock: vi.fn(),
  dispatchMock: vi.fn(),
  recordDispatchMock: vi.fn(),
}));

vi.mock('./automationReferenceAuthorization', () => ({
  AutomationReferenceAuthorizationError: class extends Error {},
  resolveOwnedAutomationReferences: vi.fn(),
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
vi.mock('./automationActionResults', () => ({
  recordAutomationActionDispatch: recordDispatchMock,
  seedAutomationActionResults: vi.fn(),
  applyAutomationActionTerminal: vi.fn(),
  aggregateAutomationDeviceResultStatus: vi.fn(),
}));

import {
  executeRunScriptAction,
  executeCommandAction,
  normalizeAutomationActions,
  persistActionExecutionOutcome,
} from './automationRuntime';
import { deliveryTtlMs } from './commandOfflinePolicy';

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
  status: 'offline',
  agentId: 'agent-1',
};

function buildContext() {
  return {
    automation: { id: 'automation-1', name: 'Nightly', createdBy: 'user-1' },
    runId: RUN_ID,
    device: DEVICE,
    scriptsById: new Map([['script-1', SCRIPT]]),
    channelsById: new Map(),
  } as never;
}

/** The dispatch core's "row persisted, agent not reached" shape. */
function queuedDispatch() {
  return {
    ok: true,
    commandId: 'cmd-1',
    executionId: EXECUTION_ID,
    delivered: false,
    deliveryOutcome: 'no_agent',
    deliverBy: new Date('2026-09-14T00:00:00.000Z'),
    executedAt: null,
    ignoredParameters: [],
  };
}

beforeEach(() => {
  updateMock.mockReset().mockImplementation(() => ({
    set: () => ({ where: async () => undefined }),
  }));
  dispatchMock.mockReset().mockResolvedValue(queuedDispatch());
  recordDispatchMock.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function policyOf(callIndex = 0) {
  return (dispatchMock.mock.calls[callIndex]![0] as Record<string, unknown>).offlinePolicy;
}

describe('whenOffline normalisation', () => {
  it('defaults run_script and execute_command to queue when the field is absent', () => {
    const [runScript, execCommand] = normalizeAutomationActions([
      { type: 'run_script', scriptId: 'script-1' },
      { type: 'execute_command', command: 'whoami' },
    ]);
    expect(runScript).toMatchObject({ type: 'run_script', whenOffline: 'queue' });
    expect(execCommand).toMatchObject({ type: 'execute_command', whenOffline: 'queue' });
  });

  it('accepts an explicit skip on both action types', () => {
    const [runScript, execCommand] = normalizeAutomationActions([
      { type: 'run_script', scriptId: 'script-1', whenOffline: 'skip' },
      { type: 'execute_command', command: 'whoami', whenOffline: 'skip' },
    ]);
    expect(runScript).toMatchObject({ whenOffline: 'skip' });
    expect(execCommand).toMatchObject({ whenOffline: 'skip' });
  });

  it('falls back to queue for an unrecognised stored value rather than throwing mid-run', () => {
    const [action] = normalizeAutomationActions([
      { type: 'run_script', scriptId: 'script-1', whenOffline: 'explode' },
    ]);
    expect(action).toMatchObject({ whenOffline: 'queue' });
  });
});

describe('executeRunScriptAction — offline policy', () => {
  it('passes a standard-TTL queue policy when the flag is on and whenOffline is queue', async () => {
    vi.stubEnv('DEVICE_COMMAND_OFFLINE_QUEUE_ENABLED', 'true');

    await executeRunScriptAction(
      { type: 'run_script', scriptId: 'script-1', whenOffline: 'queue' },
      0,
      buildContext(),
    );

    expect(policyOf()).toEqual({ kind: 'queue', deliverWithinMs: deliveryTtlMs('standard') });
  });

  it('passes a reject policy when whenOffline is skip, even with the flag on', async () => {
    vi.stubEnv('DEVICE_COMMAND_OFFLINE_QUEUE_ENABLED', 'true');

    await executeRunScriptAction(
      { type: 'run_script', scriptId: 'script-1', whenOffline: 'skip' },
      0,
      buildContext(),
    );

    expect(policyOf()).toEqual({ kind: 'reject' });
  });

  it('passes a reject policy when the flag is OFF, even though the action says queue', async () => {
    vi.stubEnv('DEVICE_COMMAND_OFFLINE_QUEUE_ENABLED', 'false');

    await executeRunScriptAction(
      { type: 'run_script', scriptId: 'script-1', whenOffline: 'queue' },
      0,
      buildContext(),
    );

    expect(policyOf()).toEqual({ kind: 'reject' });
  });

  it('reports the queued step as queued (not failed) with the offline message', async () => {
    vi.stubEnv('DEVICE_COMMAND_OFFLINE_QUEUE_ENABLED', 'true');

    const result = await executeRunScriptAction(
      { type: 'run_script', scriptId: 'script-1' },
      0,
      buildContext(),
    );

    expect(result.outcome).toEqual({
      status: 'queued',
      commandId: 'cmd-1',
      scriptExecutionId: EXECUTION_ID,
      message: 'Queued — device offline',
    });
  });

  it("skip reproduces today's failure message byte-for-byte", async () => {
    vi.stubEnv('DEVICE_COMMAND_OFFLINE_QUEUE_ENABLED', 'true');
    dispatchMock.mockResolvedValue({
      ok: false,
      code: 'device_offline',
      error: 'Device is offline, cannot execute command',
    });

    const result = await executeRunScriptAction(
      { type: 'run_script', scriptId: 'script-1', whenOffline: 'skip' },
      0,
      buildContext(),
    );

    expect(result.outcome).toEqual({
      status: 'failed',
      message: 'Device is offline, cannot execute command',
    });
  });
});

describe('executeCommandAction — offline policy', () => {
  it('queues with a standard TTL when the flag is on', async () => {
    vi.stubEnv('DEVICE_COMMAND_OFFLINE_QUEUE_ENABLED', 'true');

    const result = await executeCommandAction(
      { type: 'execute_command', command: 'whoami' },
      0,
      buildContext(),
    );

    expect(policyOf()).toEqual({ kind: 'queue', deliverWithinMs: deliveryTtlMs('standard') });
    expect(result.outcome).toEqual({
      status: 'queued',
      commandId: 'cmd-1',
      message: 'Queued — device offline',
    });
  });

  it('rejects when whenOffline is skip', async () => {
    vi.stubEnv('DEVICE_COMMAND_OFFLINE_QUEUE_ENABLED', 'true');

    await executeCommandAction(
      { type: 'execute_command', command: 'whoami', whenOffline: 'skip' },
      0,
      buildContext(),
    );

    expect(policyOf()).toEqual({ kind: 'reject' });
  });
});

describe('persistActionExecutionOutcome — queued row', () => {
  it('writes the automation_action_results row as queued with the offline message', async () => {
    vi.stubEnv('DEVICE_COMMAND_OFFLINE_QUEUE_ENABLED', 'true');

    const result = await executeRunScriptAction(
      { type: 'run_script', scriptId: 'script-1' },
      0,
      buildContext(),
    );
    await persistActionExecutionOutcome(RUN_ID, DEVICE.id, 0, result);

    expect(recordDispatchMock).toHaveBeenCalledWith(expect.objectContaining({
      runId: RUN_ID,
      deviceId: DEVICE.id,
      actionIndex: 0,
      status: 'queued',
      commandId: 'cmd-1',
      scriptExecutionId: EXECUTION_ID,
      message: 'Queued — device offline',
    }));
  });
});
