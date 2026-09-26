import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * #3445 — "scheduled script never completes, the same script run manually
 * completes in seconds".
 *
 * The automation runtime dispatches each device's action inside a short system
 * transaction that holds the device row lock (SEC-118, #5562). The
 * script_executions row and the device_commands row are INSERTed in that
 * transaction. If the WebSocket send also happens inside it, a fast agent can
 * answer before the transaction commits: the result path reads device_commands
 * on its own connection, cannot see the uncommitted row, and drops the result
 * as an orphan. The command then sits `sent` until the stale reaper fails it at
 * timeout + 5 min with "Agent result was delivered but never recorded".
 *
 * The contract proven here: the rows are created under the lock, and the send
 * happens only after that transaction has closed.
 */

const txState = vi.hoisted(() => ({ depth: 0 }));

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
  // Models the real AsyncLocalStorage semantics closely enough for this test:
  // runOutsideDbContext drops the ambient transaction, and
  // withSystemDbAccessContext opens one that is held until `fn` settles.
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
  name: 'system-performance',
  language: 'powershell',
  content: 'Get-Counter',
  osTypes: ['windows'],
  timeoutSeconds: 3600,
  runAs: 'system',
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

type Recorded = { event: 'rows_created' | 'sent'; depth: number };

/**
 * A stand-in for dispatchScriptToDevice that honours its real contract: rows
 * are written when it is called, and the agent send happens either inline
 * (the default) or when the caller invokes `deliver()` (deferDelivery).
 */
function fakeDispatch(events: Recorded[]) {
  return async (input: { deferDelivery?: boolean; source: { kind: string } }) => {
    events.push({ event: 'rows_created', depth: txState.depth });
    const base = {
      ok: true as const,
      commandId: 'cmd-1',
      executionId: input.source.kind === 'saved' ? EXECUTION_ID : null,
      deliverBy: null,
      ignoredParameters: [],
      runAs: 'system' as const,
      targetSessionId: null,
    };
    const send = () => {
      events.push({ event: 'sent', depth: txState.depth });
      return { ...base, delivered: true, deliveryOutcome: 'sent' as const, executedAt: new Date() };
    };
    if (input.deferDelivery) {
      return {
        ...base,
        delivered: false,
        deliveryOutcome: 'deferred' as const,
        executedAt: null,
        deliver: async () => send(),
      };
    }
    return send();
  };
}

function args(actions: unknown[]) {
  return {
    actions,
    devices: [DEVICE],
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
  } as unknown as Parameters<typeof __testOnly.executeAutomationActionsInOrder>[0];
}

beforeEach(() => {
  vi.clearAllMocks();
  txState.depth = 0;
  recordActionDispatchMock.mockResolvedValue(true);
  reconcileRunMock.mockResolvedValue(undefined);
  seedActionResultsMock.mockResolvedValue(undefined);
  executeMock.mockResolvedValue([]);
  selectMock.mockImplementation(() => ({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([{ status: 'running' }]) }),
    }),
  }));
});

describe('executeAutomationActionsInOrder — commit before send (#3445)', () => {
  it.each([
    ['run_script', { type: 'run_script', scriptId: 'script-1' }],
    ['execute_command', { type: 'execute_command', command: 'Get-Counter', shell: 'powershell' }],
  ])('%s: creates the rows inside the dispatch transaction and sends only after it closes', async (_name, action) => {
    const events: Recorded[] = [];
    dispatchMock.mockImplementation(fakeDispatch(events));

    await __testOnly.executeAutomationActionsInOrder(args([action]));

    const created = events.find((e) => e.event === 'rows_created');
    const sent = events.find((e) => e.event === 'sent');
    // Rows are still written under the per-device lock (SEC-118).
    expect(created?.depth).toBeGreaterThan(0);
    // The send happened, and it happened with NO transaction open: the rows it
    // refers to are committed and visible to the result path.
    expect(sent).toBeDefined();
    expect(sent?.depth).toBe(0);
    expect(events.indexOf(sent!)).toBeGreaterThan(events.indexOf(created!));
  });

  it('records the post-send outcome (delivered), not the pre-send placeholder', async () => {
    const events: Recorded[] = [];
    dispatchMock.mockImplementation(fakeDispatch(events));

    await __testOnly.executeAutomationActionsInOrder(args([{ type: 'run_script', scriptId: 'script-1' }]));

    expect(recordActionDispatchMock).toHaveBeenCalledWith(expect.objectContaining({
      status: 'delivered',
      commandId: 'cmd-1',
      scriptExecutionId: EXECUTION_ID,
    }));
  });

  it('a throwing deliver() leaves the action queued, not failed — the committed command can still reach the agent', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    dispatchMock.mockImplementation(async () => ({
      ok: true,
      commandId: 'cmd-1',
      executionId: EXECUTION_ID,
      deliverBy: null,
      ignoredParameters: [],
      runAs: 'system',
      targetSessionId: null,
      delivered: false,
      deliveryOutcome: 'deferred',
      executedAt: null,
      deliver: async () => { throw new Error('connection reset'); },
    }));

    const out = await __testOnly.executeAutomationActionsInOrder(args([{ type: 'run_script', scriptId: 'script-1' }]));

    expect(out.devicesFailed).toBe(0);
    expect(out.hasNonterminalActions).toBe(true);
    expect(recordActionDispatchMock).toHaveBeenCalledWith(expect.objectContaining({ status: 'queued' }));
    expect(recordActionDispatchMock).not.toHaveBeenCalledWith(expect.objectContaining({ status: 'failed' }));
    expect(captureExceptionMock).toHaveBeenCalled();
    consoleErrorSpy.mockRestore();
  });
});
