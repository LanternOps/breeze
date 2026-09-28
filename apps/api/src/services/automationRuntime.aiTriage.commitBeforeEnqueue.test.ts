import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * #7187 — the ai_triage action must not enqueue its agent run before the
 * automation's per-device claim transaction commits.
 *
 * The dispatch loop runs `executeAction` inside a short SYSTEM transaction that
 * holds the claim (#3189). The admission gate's own `inSystemDbContext` joins a
 * system-scope ambient transaction, so the `ai_agent_runs` row it inserts is
 * still uncommitted when the gate would announce and enqueue it. The runner
 * compare-and-sets that row out of `queued` on its own connection: before the
 * commit it matches nothing and the run is stranded until the stall reaper. A
 * rollback of the claim transaction would instead leave a job for a row that
 * never existed. Same class as #3445 for run_script.
 *
 * The contract proven here, through the real dispatch loop: the row is created
 * with the claim transaction open, the enqueue runs with none open, and a claim
 * transaction that rolls back enqueues nothing.
 */

const txState = vi.hoisted(() => ({ depth: 0, open: 0 }));

const {
  createAndEnqueueAgentRunMock,
  resolveOwnedAutomationReferencesMock,
  recordActionDispatchMock,
  reconcileRunMock,
  seedActionResultsMock,
  claimActionDispatchMock,
  claimActionDispatchesMock,
  stampClaimedActionOutcomeMock,
  readActionStateMock,
  captureExceptionMock,
  executeMock,
  selectMock,
} = vi.hoisted(() => ({
  createAndEnqueueAgentRunMock: vi.fn(),
  resolveOwnedAutomationReferencesMock: vi.fn(),
  recordActionDispatchMock: vi.fn(),
  reconcileRunMock: vi.fn(),
  seedActionResultsMock: vi.fn(),
  claimActionDispatchMock: vi.fn(),
  claimActionDispatchesMock: vi.fn(),
  stampClaimedActionOutcomeMock: vi.fn(),
  readActionStateMock: vi.fn(),
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
    const opensTransaction = txState.depth === 0;
    txState.depth += 1;
    if (opensTransaction) txState.open += 1;
    try {
      return await fn();
    } finally {
      txState.depth -= 1;
      if (opensTransaction) txState.open -= 1;
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
  devices: { id: 'id', hostname: 'hostname', osType: 'osType', status: 'status', displayName: 'displayName', agentId: 'agentId', tags: 'tags' },
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
  claimAutomationActionDispatch: claimActionDispatchMock,
  claimAutomationActionDispatches: claimActionDispatchesMock,
  stampClaimedAutomationActionOutcome: stampClaimedActionOutcomeMock,
  readAutomationActionState: readActionStateMock,
}));

vi.mock('./scriptCancellation', () => ({
  cancelScriptExecution: vi.fn(),
  deliverCancelCommand: vi.fn(),
  cancelExecutionsForRun: vi.fn(),
}));

vi.mock('./sentry', () => ({ captureException: captureExceptionMock }));
vi.mock('./eventBus', () => ({ publishEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('./deploymentEngine', () => ({ resolveDeploymentTargets: vi.fn().mockResolvedValue([]) }));
vi.mock('./scriptDispatch', () => ({ dispatchScriptToDevice: vi.fn() }));
vi.mock('./notificationSenders', () => ({
  getEmailRecipients: vi.fn().mockReturnValue([]),
  sendEmailNotification: vi.fn().mockResolvedValue({ success: false }),
  sendWebhookNotification: vi.fn().mockResolvedValue({ success: false }),
}));
vi.mock('./aiAgents/runService', () => ({ createAndEnqueueAgentRun: createAndEnqueueAgentRunMock }));
vi.mock('./aiAgents/patchWorkClassifier', () => ({
  resolveAlertCategory: vi.fn().mockResolvedValue({
    category: null, monitorKind: null, isPatchWork: false, source: null,
  }),
}));

import { __testOnly } from './automationRuntime';

const RUN_ID = '99999999-8888-4777-8666-555555555555';
const AGENT_RUN_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

const DEVICE = {
  id: 'device-1',
  orgId: 'org-1',
  hostname: 'device-1',
  displayName: null,
  osType: 'windows' as const,
  status: 'online',
  agentId: 'agent-device-1',
  siteId: 'site-1',
  customFields: null,
};

type Recorded = { event: 'run_row_created' | 'enqueued'; depth: number; open: number };

/**
 * A stand-in for createAndEnqueueAgentRun that honours its contract: the row
 * is inserted when it is called, and the announce/enqueue happens either
 * inline (the default) or when the caller invokes `enqueue()` (deferEnqueue).
 */
function fakeGate(events: Recorded[], enqueueResult?: () => unknown) {
  return async (_input: unknown, options?: { deferEnqueue?: boolean }) => {
    events.push({ event: 'run_row_created', depth: txState.depth, open: txState.open });
    const run = { id: AGENT_RUN_ID, status: 'queued', errorCode: null };
    const enqueue = async () => {
      events.push({ event: 'enqueued', depth: txState.depth, open: txState.open });
      return enqueueResult ? enqueueResult() : { created: true, run };
    };
    if (options?.deferEnqueue) return { created: true, run, enqueue };
    return enqueue();
  };
}

function args() {
  return {
    actions: [{ type: 'ai_triage' }],
    devices: [DEVICE],
    automation: { id: 'auto-1', orgId: 'org-1', name: 'triage', createdBy: null, managedByAgentId: 'agent-1' },
    runId: RUN_ID,
    scriptsById: new Map(),
    channelsById: new Map(),
    variableScope: undefined,
    trigger: { alertId: 'alert-1', eventId: 'evt-1', severity: 'high', ruleId: 'rule-1' },
    onFailure: 'stop' as const,
    notificationTargets: undefined,
    createdBy: null,
    resolvedReferences: { scriptsById: new Map(), notificationChannelsById: new Map() },
  } as unknown as Parameters<typeof __testOnly.executeAutomationActionsInOrder>[0];
}

beforeEach(() => {
  vi.clearAllMocks();
  txState.depth = 0;
  txState.open = 0;
  recordActionDispatchMock.mockResolvedValue(true);
  reconcileRunMock.mockResolvedValue(undefined);
  seedActionResultsMock.mockResolvedValue(undefined);
  claimActionDispatchMock.mockResolvedValue({ kind: 'claimed' });
  stampClaimedActionOutcomeMock.mockResolvedValue(true);
  readActionStateMock.mockResolvedValue(null);
  executeMock.mockResolvedValue([]);
  selectMock.mockImplementation(() => ({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([{ status: 'running', tags: [] }]) }),
    }),
  }));
});

describe('executeAutomationActionsInOrder — ai_triage enqueues after commit (#7187)', () => {
  it('creates the agent run inside the claim transaction and enqueues only after it closes', async () => {
    const events: Recorded[] = [];
    createAndEnqueueAgentRunMock.mockImplementation(fakeGate(events));

    await __testOnly.executeAutomationActionsInOrder(args());

    const created = events.find((e) => e.event === 'run_row_created');
    const enqueued = events.find((e) => e.event === 'enqueued');
    expect(created?.open).toBe(1);
    expect(enqueued).toBeDefined();
    expect(enqueued?.depth).toBe(0);
    expect(enqueued?.open).toBe(0);
    expect(events.indexOf(enqueued!)).toBeGreaterThan(events.indexOf(created!));
    expect(createAndEnqueueAgentRunMock).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'triage', alertId: 'alert-1' }),
      { deferEnqueue: true },
    );
  });

  it('stamps the queued outcome with the agent run correlation inside the claim transaction', async () => {
    createAndEnqueueAgentRunMock.mockImplementation(fakeGate([]));

    const out = await __testOnly.executeAutomationActionsInOrder(args());

    expect(stampClaimedActionOutcomeMock).toHaveBeenCalledWith(expect.objectContaining({
      status: 'queued',
      agentRunId: AGENT_RUN_ID,
    }));
    expect(out.devicesFailed).toBe(0);
    expect(out.hasNonterminalActions).toBe(true);
  });

  it('a claim transaction that rolls back enqueues nothing', async () => {
    const events: Recorded[] = [];
    createAndEnqueueAgentRunMock.mockImplementation(fakeGate(events));
    // An unstamped claim throws inside the transaction and rolls it back.
    stampClaimedActionOutcomeMock.mockResolvedValue(false);
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const out = await __testOnly.executeAutomationActionsInOrder(args());

    expect(events.map((e) => e.event)).toEqual(['run_row_created']);
    expect(out.devicesFailed).toBe(1);
    consoleErrorSpy.mockRestore();
  });

  it('an enqueue that fails after commit records the action failed', async () => {
    createAndEnqueueAgentRunMock.mockImplementation(fakeGate([], () => ({
      created: true,
      run: { id: AGENT_RUN_ID, status: 'failed', errorCode: 'enqueue_failed' },
    })));

    const out = await __testOnly.executeAutomationActionsInOrder(args());

    expect(out.devicesFailed).toBe(1);
    expect(recordActionDispatchMock).toHaveBeenCalledWith(expect.objectContaining({
      status: 'failed',
      message: 'ai_triage agent run was created but could not be enqueued',
    }));
  });

  it('a throwing enqueue() is reported, and the action is recorded failed rather than silently queued', async () => {
    createAndEnqueueAgentRunMock.mockImplementation(fakeGate([], () => {
      throw new Error('redis down');
    }));
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const out = await __testOnly.executeAutomationActionsInOrder(args());

    expect(out.devicesFailed).toBe(1);
    expect(recordActionDispatchMock).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed' }));
    expect(captureExceptionMock).toHaveBeenCalled();
    consoleErrorSpy.mockRestore();
  });
});
