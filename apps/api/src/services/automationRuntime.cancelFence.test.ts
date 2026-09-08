import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * #3525 W05 (#4766) — the dispatch-loop side of the cancel fence.
 *
 * `automationRunCancelFence.integration.test.ts` proves the LOCK against real
 * Postgres. This file proves the runtime behaviour that lock is wrapped in,
 * and specifically the compensating path: the one mechanism standing between a
 * cancel that lands microseconds after a dispatch and a script that keeps
 * running on a customer endpoint. Without a test here, renaming
 * `outcome.scriptExecutionId` would turn the whole compensation into dead code
 * and nothing would go red.
 */

const {
  dispatchMock,
  resolveOwnedAutomationReferencesMock,
  recordActionDispatchMock,
  reconcileRunMock,
  seedActionResultsMock,
  cancelScriptExecutionMock,
  deliverCancelCommandMock,
  captureExceptionMock,
  executeMock,
  selectMock,
} = vi.hoisted(() => ({
  dispatchMock: vi.fn(),
  resolveOwnedAutomationReferencesMock: vi.fn(),
  recordActionDispatchMock: vi.fn(),
  reconcileRunMock: vi.fn(),
  seedActionResultsMock: vi.fn(),
  cancelScriptExecutionMock: vi.fn(),
  deliverCancelCommandMock: vi.fn(),
  captureExceptionMock: vi.fn(),
  executeMock: vi.fn(),
  selectMock: vi.fn(),
}));

vi.mock('./automationReferenceAuthorization', () => ({
  AutomationReferenceAuthorizationError: class AutomationReferenceAuthorizationError extends Error {
    readonly code = 'unknown_or_unauthorized_reference';
  },
  resolveOwnedAutomationReferences: resolveOwnedAutomationReferencesMock,
}));

vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  getCurrentDbAccessContext: vi.fn(() => ({ scope: 'system' })),
  db: {
    select: selectMock,
    insert: vi.fn(),
    update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(async () => undefined) })) })),
    delete: vi.fn(),
    transaction: vi.fn(),
    execute: executeMock,
  },
}));

vi.mock('../db/schema', () => ({
  automationRuns: { id: 'id', automationId: 'automationId', status: 'status', logs: 'logs' },
  automationActionResults: { runId: 'runId', status: 'status', actionIndex: 'actionIndex', actionType: 'actionType', id: 'id' },
  automationRunDeviceResults: { runId: 'runId', deviceId: 'deviceId' },
  automationResourceBindings: { automationId: 'automationId' },
  configPolicyAutomations: { featureLinkId: 'featureLinkId' },
  configPolicyFeatureLinks: { id: 'id', configPolicyId: 'configPolicyId' },
  configurationPolicies: { id: 'id', orgId: 'orgId' },
  devices: { id: 'id', hostname: 'hostname', osType: 'osType', status: 'status', displayName: 'displayName', agentId: 'agentId' },
  organizations: { id: 'id', partnerId: 'partnerId' },
  scripts: { id: 'id', deletedAt: 'deletedAt' },
  scriptExecutions: { id: 'id', deviceId: 'deviceId', automationRunId: 'automationRunId', status: 'status' },
  notificationChannels: { id: 'id', orgId: 'orgId' },
  automations: { id: 'id', runCount: 'runCount' },
  alerts: { id: 'id' },
  alertRules: { id: 'id', orgId: 'orgId', name: 'name', targetType: 'targetType', targetId: 'targetId' },
  alertTemplates: { id: 'id', orgId: 'orgId', name: 'name' },
  deviceGroupMemberships: { deviceId: 'deviceId', groupId: 'groupId' },
}));

vi.mock('./automationActionResults', () => ({
  recordAutomationActionDispatch: recordActionDispatchMock,
  reconcileAutomationRun: reconcileRunMock,
  seedAutomationActionResults: seedActionResultsMock,
}));

vi.mock('./scriptCancellation', () => ({
  cancelScriptExecution: cancelScriptExecutionMock,
  deliverCancelCommand: deliverCancelCommandMock,
  cancelExecutionsForRun: vi.fn(),
}));

vi.mock('./sentry', () => ({ captureException: captureExceptionMock }));
vi.mock('./eventBus', () => ({ publishEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('./deploymentEngine', () => ({ resolveDeploymentTargets: vi.fn().mockResolvedValue([]) }));
vi.mock('./scriptDispatch', () => ({ dispatchScriptToDevice: dispatchMock }));
vi.mock('./notificationSenders', () => ({
  getEmailRecipients: vi.fn().mockReturnValue([]),
  sendEmailNotification: vi.fn().mockResolvedValue({ success: false }),
  sendWebhookNotification: vi.fn().mockResolvedValue({ success: false }),
}));

import { __testOnly } from './automationRuntime';

const RUN_ID = '99999999-8888-4777-8666-555555555555';
const EXECUTION_ID = '11111111-2222-4333-8444-555555555555';

const SCRIPT = {
  id: 'script-1',
  name: 'Collect logs',
  language: 'bash',
  content: 'sleep 120',
  osTypes: ['linux'],
  timeoutSeconds: 300,
  runAs: 'system',
} as never;

function device(id: string) {
  return {
    id,
    orgId: 'org-1',
    hostname: id,
    displayName: null,
    osType: 'linux' as const,
    status: 'online',
    agentId: `agent-${id}`,
    siteId: null,
    customFields: null,
  };
}

/** What the run-status re-read inside `cancelDispatchIfRunCancelled` sees. */
function runStatusIs(status: string) {
  selectMock.mockImplementation(() => ({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([{ status }]) }),
    }),
  }));
}

/** What the FOR SHARE fence read sees, per call, in order. */
function fenceSees(...statuses: Array<string | null>) {
  executeMock.mockReset();
  for (const status of statuses) {
    executeMock.mockResolvedValueOnce(status === null ? [] : [{ status }]);
  }
  // Anything past the scripted sequence: run still live.
  executeMock.mockResolvedValue([]);
}

beforeEach(() => {
  vi.clearAllMocks();
  recordActionDispatchMock.mockResolvedValue(true);
  reconcileRunMock.mockResolvedValue(undefined);
  seedActionResultsMock.mockResolvedValue(undefined);
  deliverCancelCommandMock.mockResolvedValue(true);
  runStatusIs('running');
  fenceSees();
});

describe('cancelDispatchIfRunCancelled — the compensating half of the fence', () => {
  const withExecution = {
    outcome: { status: 'delivered' as const, commandId: 'cmd-1', scriptExecutionId: EXECUTION_ID },
    log: { timestamp: 'now', level: 'info' as const, message: 'Queued run_script action' },
  };
  const withoutExecution = {
    outcome: { status: 'delivered' as const, commandId: 'cmd-1' },
    log: { timestamp: 'now', level: 'info' as const, message: 'Queued execute_command action' },
  };

  it('does not even read the run for a dispatch with no script execution to stop', async () => {
    runStatusIs('cancelled');
    await expect(
      __testOnly.cancelDispatchIfRunCancelled(RUN_ID, 'device-1', withoutExecution),
    ).resolves.toBe('not_needed');
    // execute_command has no agent-side stop; paying for a read per dispatch
    // to discover that would be pure cost.
    expect(selectMock).not.toHaveBeenCalled();
    expect(cancelScriptExecutionMock).not.toHaveBeenCalled();
  });

  it('leaves a live run alone', async () => {
    runStatusIs('running');
    await expect(
      __testOnly.cancelDispatchIfRunCancelled(RUN_ID, 'device-1', withExecution),
    ).resolves.toBe('not_needed');
    expect(cancelScriptExecutionMock).not.toHaveBeenCalled();
  });

  it('stops the execution it just created when the run went cancelled mid-dispatch', async () => {
    // THE residual-window case. The cancel committed after this dispatcher's
    // pre-dispatch fence read but before its execution row was visible to the
    // fan-out, so nothing else will ever stop this script.
    runStatusIs('cancelled');
    cancelScriptExecutionMock.mockResolvedValue({
      kind: 'cancelling',
      executionId: EXECUTION_ID,
      cancelCommandId: 'cancel-cmd-1',
      deviceId: 'device-1',
      alreadyQueued: false,
    });

    await expect(
      __testOnly.cancelDispatchIfRunCancelled(RUN_ID, 'device-1', withExecution),
    ).resolves.toBe('requested');

    expect(cancelScriptExecutionMock).toHaveBeenCalledWith(expect.objectContaining({
      executionId: EXECUTION_ID,
    }));
    // POST-COMMIT delivery, same contract as every other cancel caller.
    expect(deliverCancelCommandMock).toHaveBeenCalledWith('cancel-cmd-1', 'device-1');
  });

  it('does not re-deliver a cancel that was already queued', async () => {
    runStatusIs('cancelled');
    cancelScriptExecutionMock.mockResolvedValue({
      kind: 'cancelling',
      executionId: EXECUTION_ID,
      cancelCommandId: 'cancel-cmd-1',
      deviceId: 'device-1',
      alreadyQueued: true,
    });
    await __testOnly.cancelDispatchIfRunCancelled(RUN_ID, 'device-1', withExecution);
    expect(deliverCancelCommandMock).not.toHaveBeenCalled();
  });

  // The distinction that matters: `settled` means nothing is running any more,
  // `requested` means we only ASKED. Collapsing them (as a boolean did) makes
  // the caller write "the execution was stopped" into the run log for a stop
  // the device never confirmed.
  it.each(['retracted', 'recovered', 'already_terminal', 'idempotent'] as const)(
    'reports %s as settled and delivers nothing',
    async (kind) => {
      runStatusIs('cancelled');
      cancelScriptExecutionMock.mockResolvedValue({ kind, status: 'completed' });
      await expect(
        __testOnly.cancelDispatchIfRunCancelled(RUN_ID, 'device-1', withExecution),
      ).resolves.toBe('settled');
      expect(deliverCancelCommandMock).not.toHaveBeenCalled();
    },
  );

  it.each(['not_found', 'inconsistent'] as const)(
    'reports %s as FAILED — absence is not proof that nothing is running',
    async (kind) => {
      runStatusIs('cancelled');
      cancelScriptExecutionMock.mockResolvedValue({ kind });
      await expect(
        __testOnly.cancelDispatchIfRunCancelled(RUN_ID, 'device-1', withExecution),
      ).resolves.toBe('failed');
      expect(captureExceptionMock).toHaveBeenCalled();
    },
  );

  it('reports a throw as failed, loudly, without throwing — a cancelled run must not become a retried job', async () => {
    runStatusIs('cancelled');
    cancelScriptExecutionMock.mockRejectedValue(new Error('deadlock detected'));
    await expect(
      __testOnly.cancelDispatchIfRunCancelled(RUN_ID, 'device-1', withExecution),
    ).resolves.toBe('failed');
    // This is the ONE path that can leave a script running after a cancel, so
    // reporting it as a stop is exactly the lie the feature exists to prevent.
    expect(captureExceptionMock).toHaveBeenCalled();
  });
});

describe('executeAutomationActionsInOrder — mid-flight cancellation', () => {
  function args(overrides: Partial<Parameters<typeof __testOnly.executeAutomationActionsInOrder>[0]> = {}) {
    return {
      actions: [
        { type: 'run_script', scriptId: 'script-1' },
        { type: 'run_script', scriptId: 'script-1' },
      ],
      devices: [device('device-1')],
      automation: { id: 'auto-1', orgId: 'org-1', name: 'a', createdBy: null, managedByAgentId: null },
      runId: RUN_ID,
      scriptsById: new Map([['script-1', SCRIPT]]),
      channelsById: new Map(),
      variableScope: undefined,
      trigger: undefined,
      onFailure: 'stop' as const,
      notificationTargets: undefined,
      createdBy: null,
      resolvedReferences: {
        scriptsById: new Map([['script-1', SCRIPT]]),
        notificationChannelsById: new Map(),
      },
      ...overrides,
    } as unknown as Parameters<typeof __testOnly.executeAutomationActionsInOrder>[0];
  }

  it('stops between actions when the run is cancelled part-way', async () => {
    dispatchMock.mockResolvedValue({
      ok: true, commandId: 'cmd-1', executionId: null, delivered: true,
      executedAt: new Date(), ignoredParameters: [],
    });
    // Action 0's fence read is clean; action 1's sees the cancel.
    // (The per-device read for action 0 also comes from this sequence.)
    fenceSees(null, null, 'cancelled');

    const out = await __testOnly.executeAutomationActionsInOrder(args());

    expect(out.cancelled).toBe(true);
    // Action 0 dispatched, action 1 never did.
    expect(dispatchMock).toHaveBeenCalledTimes(1);
    expect(out.logs.some((entry) => entry.message.includes('remaining actions were not dispatched'))).toBe(true);
  });

  it('records NO failure when a device is fenced off — nothing failed, an operator stopped it', async () => {
    dispatchMock.mockResolvedValue({
      ok: true, commandId: 'cmd-1', executionId: null, delivered: true,
      executedAt: new Date(), ignoredParameters: [],
    });
    // Per-action read clean, per-device read sees the cancel.
    fenceSees(null, 'cancelled');

    const out = await __testOnly.executeAutomationActionsInOrder(args({
      actions: [{ type: 'run_script', scriptId: 'script-1' }],
    }));

    expect(out.cancelled).toBe(true);
    expect(out.devicesFailed).toBe(0);
    expect(dispatchMock).not.toHaveBeenCalled();
    // Reporting a stop as an automation defect is the exact dishonesty this
    // whole feature exists to prevent.
    expect(recordActionDispatchMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ status: 'failed' }),
    );
  });

  it('leaves an uncancelled run completely unaffected', async () => {
    dispatchMock.mockResolvedValue({
      ok: true, commandId: 'cmd-1', executionId: null, delivered: true,
      executedAt: new Date(), ignoredParameters: [],
    });
    fenceSees();

    const out = await __testOnly.executeAutomationActionsInOrder(args());

    expect(out.cancelled).toBe(false);
    expect(dispatchMock).toHaveBeenCalledTimes(2);
    expect(out.hasNonterminalActions).toBe(true);
  });

  /**
   * #5128 W4, END TO END. Every other assertion about the queued path stops at
   * `executeRunScriptAction`'s return value. This is the one that drives the
   * whole chain — `automationOfflinePolicy()` → `dispatchScriptToDevice` →
   * `delivered: false` → outcome `queued` → `hasNonterminalActions` → run status
   * — and it is the assertion that matters most: W4 flipped the flag default ON
   * for every existing customer, so if a queued step failed the run, every
   * nightly automation over a fleet with sleeping laptops would go red at once.
   */
  it('a queued (offline) dispatch does NOT fail the run and does not skip trailing actions', async () => {
    vi.stubEnv('DEVICE_COMMAND_OFFLINE_QUEUE_ENABLED', 'true');
    dispatchMock.mockResolvedValue({
      ok: true, commandId: 'cmd-1', executionId: null, delivered: false,
      deliveryOutcome: 'no_agent', deliverBy: new Date('2026-09-14T00:00:00.000Z'),
      executedAt: null, ignoredParameters: [],
    });
    fenceSees();

    // args() defaults are exactly what this needs: ONE device, TWO run_script
    // actions, and onFailure: 'stop' — so a queued first action wrongly treated
    // as a failure would stop the run and skip the second.
    const out = await __testOnly.executeAutomationActionsInOrder(args());

    expect(out.cancelled).toBe(false);
    expect(out.devicesFailed).toBe(0);
    // Non-terminal, so the run stays 'running' and waits for the agent rather
    // than being computed as completed or failed.
    expect(out.hasNonterminalActions).toBe(true);
    // onFailure: 'stop' must NOT trigger — the SECOND action still dispatched.
    expect(dispatchMock).toHaveBeenCalledTimes(2);
    expect(recordActionDispatchMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ status: 'failed' }),
    );
    expect(recordActionDispatchMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ status: 'skipped' }),
    );
    expect(recordActionDispatchMock).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'queued', message: 'Queued — device offline' }),
    );
  });
});
