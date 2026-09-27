import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * #3189 — a BullMQ stalled-job replay of `execute-run` must not dispatch an
 * action a previous attempt of the same run already claimed.
 *
 * The dispatch loop claims each (run, device, action) ledger row
 * (pending -> dispatching) INSIDE the per-device transaction that creates the
 * action's effect, stamps the outcome in that same transaction, and on a
 * replay reuses what the row already stores instead of sending again. The real
 * CAS and lock order are proven against Postgres in
 * `automationReplayIdempotency.integration.test.ts`; this file proves the
 * runtime wiring around them.
 */

const txState = vi.hoisted(() => ({ depth: 0 }));

const {
  dispatchMock,
  resolveOwnedAutomationReferencesMock,
  recordActionDispatchMock,
  reconcileRunMock,
  seedActionResultsMock,
  claimActionMock,
  stampActionMock,
  readActionStateMock,
  cancelScriptExecutionMock,
  captureExceptionMock,
  executeMock,
  selectMock,
  sendWebhookNotificationMock,
} = vi.hoisted(() => ({
  dispatchMock: vi.fn(),
  resolveOwnedAutomationReferencesMock: vi.fn(),
  recordActionDispatchMock: vi.fn(),
  reconcileRunMock: vi.fn(),
  seedActionResultsMock: vi.fn(),
  claimActionMock: vi.fn(),
  stampActionMock: vi.fn(),
  readActionStateMock: vi.fn(),
  cancelScriptExecutionMock: vi.fn(),
  captureExceptionMock: vi.fn(),
  executeMock: vi.fn(),
  selectMock: vi.fn(),
  sendWebhookNotificationMock: vi.fn(),
}));

vi.mock('./automationReferenceAuthorization', () => ({
  AutomationReferenceAuthorizationError: class AutomationReferenceAuthorizationError extends Error {
    readonly code = 'unknown_or_unauthorized_reference';
  },
  resolveOwnedAutomationReferences: resolveOwnedAutomationReferencesMock,
}));

vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn(async (fn: () => Promise<unknown>) => {
    const saved = txState.depth;
    txState.depth = 0;
    try {
      return await fn();
    } finally {
      txState.depth = saved;
    }
  }),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => {
    txState.depth += 1;
    try {
      return await fn();
    } finally {
      txState.depth -= 1;
    }
  }),
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
  claimAutomationActionDispatch: claimActionMock,
  claimAutomationActionDispatches: vi.fn(),
  stampClaimedAutomationActionOutcome: stampActionMock,
  readAutomationActionState: readActionStateMock,
}));

vi.mock('./scriptCancellation', () => ({
  cancelScriptExecution: cancelScriptExecutionMock,
  deliverCancelCommand: vi.fn(),
  cancelExecutionsForRun: vi.fn(),
}));

vi.mock('./sentry', () => ({ captureException: captureExceptionMock }));
vi.mock('./eventBus', () => ({ publishEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('./deploymentEngine', () => ({ resolveDeploymentTargets: vi.fn().mockResolvedValue([]) }));
vi.mock('./scriptDispatch', () => ({ dispatchScriptToDevice: dispatchMock }));
vi.mock('./notificationSenders', () => ({
  getEmailRecipients: vi.fn().mockReturnValue([]),
  sendEmailNotification: vi.fn().mockResolvedValue({ success: false }),
  sendWebhookNotification: sendWebhookNotificationMock,
}));

import { __testOnly } from './automationRuntime';

const RUN_ID = '99999999-8888-4777-8666-555555555555';
const EXECUTION_ID = '11111111-2222-4333-8444-555555555555';

const SCRIPT = {
  id: 'script-1',
  name: 'system-performance',
  language: 'powershell',
  content: 'Get-Counter',
  osTypes: ['windows'],
  timeoutSeconds: 3600,
  runAs: 'system',
} as never;

const CHANNEL = {
  id: 'channel-1',
  type: 'webhook',
  config: { url: 'https://hooks.example.com/x', method: 'POST' },
} as never;

const DEVICE = {
  id: 'device-1',
  orgId: 'org-1',
  hostname: 'device-1',
  displayName: null,
  osType: 'windows' as const,
  status: 'online',
  agentId: 'agent-device-1',
  siteId: null,
  customFields: null,
};

function ledger(state: Partial<{
  status: string;
  commandId: string | null;
  scriptExecutionId: string | null;
  deploymentResultId: string | null;
  agentRunId: string | null;
  message: string | null;
  error: string | null;
}>) {
  return {
    status: 'pending',
    commandId: null,
    scriptExecutionId: null,
    deploymentResultId: null,
    agentRunId: null,
    message: null,
    error: null,
    ...state,
  };
}

function args(actions: unknown[], onFailure: 'stop' | 'continue' | 'notify' = 'stop') {
  return {
    actions,
    devices: [DEVICE],
    automation: { id: 'auto-1', orgId: 'org-1', name: 'a', createdBy: null, managedByAgentId: null },
    runId: RUN_ID,
    scriptsById: new Map([['script-1', SCRIPT]]),
    channelsById: new Map([['channel-1', CHANNEL]]),
    variableScope: undefined,
    trigger: undefined,
    onFailure,
    notificationTargets: onFailure === 'notify' ? { channelIds: ['channel-1'] } : undefined,
    createdBy: null,
    resolvedReferences: {
      scriptsById: new Map([['script-1', SCRIPT]]),
      notificationChannelsById: new Map([['channel-1', CHANNEL]]),
    },
  } as unknown as Parameters<typeof __testOnly.executeAutomationActionsInOrder>[0];
}

function deferredDispatch() {
  return async () => ({
    ok: true,
    commandId: 'cmd-new',
    executionId: EXECUTION_ID,
    deliverBy: null,
    ignoredParameters: [],
    runAs: 'system',
    targetSessionId: null,
    delivered: false,
    deliveryOutcome: 'deferred',
    executedAt: null,
    deliver: async () => ({
      ok: true,
      commandId: 'cmd-new',
      executionId: EXECUTION_ID,
      deliverBy: null,
      ignoredParameters: [],
      runAs: 'system',
      targetSessionId: null,
      delivered: true,
      deliveryOutcome: 'sent',
      executedAt: new Date(),
    }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  txState.depth = 0;
  recordActionDispatchMock.mockResolvedValue(true);
  reconcileRunMock.mockResolvedValue(undefined);
  seedActionResultsMock.mockResolvedValue(undefined);
  stampActionMock.mockResolvedValue(true);
  readActionStateMock.mockResolvedValue(null);
  claimActionMock.mockResolvedValue({ kind: 'claimed' });
  sendWebhookNotificationMock.mockResolvedValue({ success: true });
  executeMock.mockResolvedValue([]);
  selectMock.mockImplementation(() => ({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([{ status: 'running' }]) }),
    }),
  }));
});

describe('executeAutomationActionsInOrder — per-action claim (#3189)', () => {
  it('claims the action and stamps its correlation ids inside the dispatch transaction', async () => {
    const order: string[] = [];
    claimActionMock.mockImplementation(async () => {
      order.push(`claim@${txState.depth}`);
      return { kind: 'claimed' };
    });
    dispatchMock.mockImplementation(async (...a: unknown[]) => {
      order.push(`dispatch@${txState.depth}`);
      return deferredDispatch()(...(a as []));
    });
    stampActionMock.mockImplementation(async () => {
      order.push(`stamp@${txState.depth}`);
      return true;
    });

    await __testOnly.executeAutomationActionsInOrder(args([{ type: 'run_script', scriptId: 'script-1' }]));

    expect(claimActionMock).toHaveBeenCalledWith({ runId: RUN_ID, deviceId: DEVICE.id, actionIndex: 0 });
    expect(order).toEqual(['claim@1', 'dispatch@1', 'stamp@1']);
    expect(stampActionMock).toHaveBeenCalledWith(expect.objectContaining({
      runId: RUN_ID,
      deviceId: DEVICE.id,
      actionIndex: 0,
      status: 'queued',
      commandId: 'cmd-new',
      scriptExecutionId: EXECUTION_ID,
    }));
    // The post-send outcome still upgrades the row after commit.
    expect(recordActionDispatchMock).toHaveBeenCalledWith(expect.objectContaining({ status: 'delivered' }));
  });

  it('a replay that finds the action already dispatched sends nothing and reuses the stored ids', async () => {
    claimActionMock.mockResolvedValue({
      kind: 'already_claimed',
      state: ledger({ status: 'delivered', commandId: 'cmd-first', scriptExecutionId: 'exec-first' }),
    });
    dispatchMock.mockImplementation(deferredDispatch());

    const out = await __testOnly.executeAutomationActionsInOrder(args([{ type: 'run_script', scriptId: 'script-1' }]));

    expect(dispatchMock).not.toHaveBeenCalled();
    expect(stampActionMock).not.toHaveBeenCalled();
    // Nothing new was minted, so nothing new may be recorded against the row.
    expect(recordActionDispatchMock).not.toHaveBeenCalledWith(expect.objectContaining({ commandId: 'cmd-new' }));
    expect(out.hasNonterminalActions).toBe(true);
    expect(out.devicesFailed).toBe(0);
    expect(out.logs.some((entry) => /already dispatched/i.test(entry.message))).toBe(true);
    expect(out.logs.find((entry) => /already dispatched/i.test(entry.message))?.commandId).toBe('cmd-first');
  });

  it('a replay that finds the action claimed but not yet upgraded treats it as queued, not failed', async () => {
    claimActionMock.mockResolvedValue({
      kind: 'already_claimed',
      state: ledger({ status: 'dispatching', commandId: 'cmd-first', scriptExecutionId: 'exec-first' }),
    });

    const out = await __testOnly.executeAutomationActionsInOrder(args([
      { type: 'execute_command', command: 'Get-Counter', shell: 'powershell' },
    ]));

    expect(dispatchMock).not.toHaveBeenCalled();
    expect(out.hasNonterminalActions).toBe(true);
    expect(out.devicesFailed).toBe(0);
  });

  it('a replay never re-sends a notification the first attempt already sent', async () => {
    claimActionMock.mockResolvedValue({ kind: 'already_claimed', state: ledger({ status: 'succeeded' }) });

    const out = await __testOnly.executeAutomationActionsInOrder(args([
      { type: 'send_notification', notificationChannelId: 'channel-1' },
    ]));

    expect(sendWebhookNotificationMock).not.toHaveBeenCalled();
    expect(out.hasNonterminalActions).toBe(false);
    expect(out.devicesFailed).toBe(0);
  });

  it('a notification action stamps its terminal outcome inside the claim transaction', async () => {
    const out = await __testOnly.executeAutomationActionsInOrder(args([
      { type: 'send_notification', notificationChannelId: 'channel-1' },
    ]));

    expect(sendWebhookNotificationMock).toHaveBeenCalledTimes(1);
    expect(stampActionMock).toHaveBeenCalledWith(expect.objectContaining({ status: 'succeeded' }));
    expect(out.devicesFailed).toBe(0);
  });

  it('a replayed failure stops the device but does not re-send the on-failure notification', async () => {
    claimActionMock.mockResolvedValue({
      kind: 'already_claimed',
      state: ledger({ status: 'failed', message: 'Script not found' }),
    });

    const out = await __testOnly.executeAutomationActionsInOrder(args([
      { type: 'run_script', scriptId: 'script-1' },
      { type: 'run_script', scriptId: 'script-1' },
    ], 'notify'));

    expect(out.devicesFailed).toBe(1);
    expect(dispatchMock).not.toHaveBeenCalled();
    expect(sendWebhookNotificationMock).not.toHaveBeenCalled();
    // Trailing actions are skipped only if nobody has claimed them.
    expect(recordActionDispatchMock).toHaveBeenCalledWith(expect.objectContaining({
      actionIndex: 1,
      status: 'skipped',
      onlyFromPending: true,
    }));
  });

  it('a claim refused because the run was cancelled stops quietly, recording no failure', async () => {
    claimActionMock.mockResolvedValue({ kind: 'run_cancelled' });

    const out = await __testOnly.executeAutomationActionsInOrder(args([{ type: 'run_script', scriptId: 'script-1' }]));

    expect(dispatchMock).not.toHaveBeenCalled();
    expect(out.cancelled).toBe(true);
    expect(out.devicesFailed).toBe(0);
    expect(recordActionDispatchMock).not.toHaveBeenCalledWith(expect.objectContaining({ status: 'failed' }));
  });

  it('a catch-block failure never overwrites an action another attempt owns', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    claimActionMock.mockRejectedValue(new Error('connection reset'));
    recordActionDispatchMock.mockResolvedValue(false);
    readActionStateMock.mockResolvedValue(ledger({ status: 'queued', commandId: 'cmd-first' }));

    const out = await __testOnly.executeAutomationActionsInOrder(args([
      { type: 'run_script', scriptId: 'script-1' },
      { type: 'run_script', scriptId: 'script-1' },
    ]));

    expect(recordActionDispatchMock).toHaveBeenCalledWith(expect.objectContaining({
      actionIndex: 0,
      status: 'failed',
      onlyFromPending: true,
    }));
    // The row belongs to an attempt that dispatched it: not a failure, and the
    // device's trailing actions are not skipped out from under that attempt.
    expect(out.devicesFailed).toBe(0);
    expect(out.hasNonterminalActions).toBe(true);
    expect(recordActionDispatchMock).not.toHaveBeenCalledWith(expect.objectContaining({ status: 'skipped' }));
    consoleErrorSpy.mockRestore();
  });
});
