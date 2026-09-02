import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentRunSkipReason, CreateAgentRunInput } from './aiAgents/runService';

const {
  createAndEnqueueAgentRunMock,
  publishEventMock,
  selectMock,
} = vi.hoisted(() => ({
  createAndEnqueueAgentRunMock: vi.fn(),
  publishEventMock: vi.fn(),
  selectMock: vi.fn(),
}));

vi.mock('../db', () => ({
  db: {
    insert: vi.fn(),
    update: vi.fn(),
    select: selectMock,
    selectDistinct: vi.fn(),
  },
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
}));

vi.mock('./eventBus', () => ({
  publishEvent: publishEventMock,
}));

vi.mock('./aiAgents/runService', () => ({
  createAndEnqueueAgentRun: createAndEnqueueAgentRunMock,
}));

import { __testOnly, type AutomationTriggerContext } from './automationRuntime';

// Expected terminal action outcome per skip reason — the INVERSE of the
// runtime's AI_TRIAGE_SKIP_IS_FAILURE table, restated independently so a flipped
// classification cannot pass. Typed as a total Record over the union: when 3c
// adds a skip reason this file stops compiling until it is classified here too.
const EXPECTED_OUTCOME: Record<AgentRunSkipReason, 'succeeded' | 'failed'> = {
  kill_switch_off: 'succeeded',
  no_effective_agent: 'succeeded',
  agent_disabled: 'succeeded',
  mode_off: 'succeeded',
  circuit_open: 'succeeded',
  trigger_filter_mismatch: 'succeeded',
  maintenance_window: 'succeeded',
  cooldown: 'succeeded',
  max_concurrent_runs: 'succeeded',
  max_runs_per_hour: 'succeeded',
  org_budget_exceeded: 'succeeded',
  agent_daily_budget_exceeded: 'succeeded',
  duplicate: 'succeeded',
  max_concurrent_verdict_runs: 'succeeded',
  verdict_rate: 'succeeded',
  max_concurrent_sweep_runs: 'succeeded',
  sweep_rate: 'succeeded',
  max_concurrent_narrative_runs: 'succeeded',
  narrative_rate: 'succeeded',
  max_concurrent_triage_runs: 'succeeded',
  triage_rate: 'succeeded',
  ownership_mismatch: 'failed',
  device_not_in_org: 'failed',
};

const DEFAULT_TRIGGER: AutomationTriggerContext = {
  alertId: 'alert-1',
  eventId: 'evt-1',
  severity: 'high',
  ruleId: 'rule-1',
};

function makeContext(overrides: Record<string, unknown> = {}) {
  const context = {
    automation: {
      id: 'auto-1',
      orgId: 'org-owner',
      name: 'Alert triage',
      createdBy: 'user-1',
      managedByAgentId: 'agent-1',
    },
    runId: 'run-1',
    trigger: DEFAULT_TRIGGER,
    device: {
      id: 'dev-1',
      orgId: 'org-device',
      hostname: 'dev-1.example',
      displayName: 'Database server',
      osType: 'linux',
      status: 'online',
      agentId: 'device-agent-1',
      siteId: 'site-1',
      customFields: {},
    },
    scriptsById: new Map(),
    channelsById: new Map(),
    variableScope: { orgIds: new Set(['org-device']) },
  };

  return {
    ...context,
    ...overrides,
    automation: {
      ...context.automation,
      ...(overrides.automation as Record<string, unknown> | undefined),
    },
    device: {
      ...context.device,
      ...(overrides.device as Record<string, unknown> | undefined),
    },
  } as any;
}

/**
 * The nth argument object handed to the admission gate, typed as the frozen 3c
 * input. Throws rather than returning undefined so a missing call fails as a
 * named error instead of a downstream `undefined.foo`.
 */
function gateInput(index = 0): CreateAgentRunInput {
  const call = createAndEnqueueAgentRunMock.mock.calls[index];
  if (!call) {
    throw new Error(`no createAndEnqueueAgentRun call at index ${index} (calls: ${createAndEnqueueAgentRunMock.mock.calls.length})`);
  }
  return call[0] as CreateAgentRunInput;
}

function mockDeviceTags(rows: Array<{ tags: string[] | null }>) {
  const limitMock = vi.fn().mockResolvedValue(rows);
  const whereMock = vi.fn().mockReturnValue({ limit: limitMock });
  const fromMock = vi.fn().mockReturnValue({ where: whereMock });
  selectMock.mockReturnValue({ from: fromMock });
}

describe('executeAiTriageAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDeviceTags([]);
    createAndEnqueueAgentRunMock.mockResolvedValue({
      created: true,
      run: { id: 'agent-run-1' },
    });
  });

  it('queues one agent run bound to the context device and alert', async () => {
    const result = await __testOnly.executeAiTriageAction(
      { type: 'ai_triage' },
      2,
      makeContext(),
    );

    expect(createAndEnqueueAgentRunMock).toHaveBeenCalledTimes(1);
    const actual = gateInput();
    expect(actual).toEqual({
      orgId: 'org-device',
      kind: 'triage',
      triggerKind: 'alert',
      deviceId: 'dev-1',
      alertId: 'alert-1',
      triggerEventId: 'evt-1',
      triggerRef: {
        automationId: 'auto-1',
        automationRunId: 'run-1',
        alertRuleId: 'rule-1',
        managedByAgentId: 'agent-1',
      },
      alertContext: {
        severity: 'high',
        ruleId: 'rule-1',
        siteId: 'site-1',
        deviceTags: [],
      },
      dedupeKey: 'alert:alert-1',
    });
    expect(result.outcome.status).toBe('succeeded');
    expect(result.log.message).toBe('ai_triage queued agent run');
    expect(result.log.details).toEqual({ agentRunId: 'agent-run-1' });
  });

  it('passes the device org — not the automation owner — as the run org', async () => {
    await __testOnly.executeAiTriageAction(
      { type: 'ai_triage' },
      0,
      makeContext({ automation: { orgId: null } }),
    );

    expect(createAndEnqueueAgentRunMock).toHaveBeenCalledTimes(1);
    const actual = gateInput();
    expect(actual.orgId).toBe('org-device');
  });

  it('maps a cooldown skip to a succeeded terminal outcome with an info log', async () => {
    createAndEnqueueAgentRunMock.mockResolvedValue({ created: false, skipped: 'cooldown' });

    const result = await __testOnly.executeAiTriageAction(
      { type: 'ai_triage' },
      0,
      makeContext(),
    );

    expect(createAndEnqueueAgentRunMock).toHaveBeenCalledTimes(1);
    const actual = gateInput();
    expect(actual.deviceId).toBe('dev-1');
    expect(result.outcome).toEqual({ status: 'succeeded' });
    expect(result.log.level).toBe('info');
    expect(result.log.message).toContain('cooldown');
  });

  it('maps ownership_mismatch to a failed terminal outcome', async () => {
    createAndEnqueueAgentRunMock.mockResolvedValue({ created: false, skipped: 'ownership_mismatch' });

    const result = await __testOnly.executeAiTriageAction(
      { type: 'ai_triage' },
      0,
      makeContext(),
    );

    expect(createAndEnqueueAgentRunMock).toHaveBeenCalledTimes(1);
    const actual = gateInput();
    expect(actual.orgId).toBe('org-device');
    expect(result.outcome).toEqual({
      status: 'failed',
      message: 'ai_triage skipped: ownership_mismatch',
    });
    expect(result.log.level).toBe('error');
  });

  it('maps device_not_in_org to a failed terminal outcome', async () => {
    createAndEnqueueAgentRunMock.mockResolvedValue({ created: false, skipped: 'device_not_in_org' });

    const result = await __testOnly.executeAiTriageAction(
      { type: 'ai_triage' },
      0,
      makeContext(),
    );

    expect(createAndEnqueueAgentRunMock).toHaveBeenCalledTimes(1);
    const actual = gateInput();
    expect(actual.orgId).toBe('org-device');
    expect(result.outcome).toEqual({
      status: 'failed',
      message: 'ai_triage skipped: device_not_in_org',
    });
    expect(result.log.level).toBe('error');
  });

  it('every AgentRunSkipReason is classified and produces a recorded log', async () => {
    for (const [reason, expectedOutcome] of Object.entries(EXPECTED_OUTCOME) as Array<[
      AgentRunSkipReason,
      'succeeded' | 'failed',
    ]>) {
      createAndEnqueueAgentRunMock.mockResolvedValueOnce({ created: false, skipped: reason });

      const result = await __testOnly.executeAiTriageAction(
        { type: 'ai_triage' },
        0,
        makeContext(),
      );

      const actual = gateInput(createAndEnqueueAgentRunMock.mock.calls.length - 1);
      expect(actual.deviceId).toBe('dev-1');
      expect(result.outcome, reason).toEqual(
        expectedOutcome === 'failed'
          ? { status: 'failed', message: `ai_triage skipped: ${reason}` }
          : { status: 'succeeded' },
      );
      expect(result.log.message, reason).toContain(reason);
      expect(result.log.message.length, reason).toBeGreaterThan(0);
    }
  });

  it('fails the action when the admission gate created a run it could not enqueue', async () => {
    // 3c inserts the ledger row, then announces/enqueues; a Redis blip makes it
    // mark the row `failed`/`enqueue_failed` and STILL return created:true.
    // Reporting that as a queued run leaves the automation green with no worker
    // job, while the row owns the alert's dedupe key.
    createAndEnqueueAgentRunMock.mockResolvedValue({
      created: true,
      run: { id: 'agent-run-1', status: 'failed', errorCode: 'enqueue_failed' },
    });

    const result = await __testOnly.executeAiTriageAction(
      { type: 'ai_triage' },
      0,
      makeContext(),
    );

    expect(result.outcome).toEqual({
      status: 'failed',
      message: 'ai_triage agent run was created but could not be enqueued',
    });
    expect(result.log.level).toBe('error');
    expect(result.log.message).not.toContain('queued agent run');
    expect(result.log.details).toEqual({
      agentRunId: 'agent-run-1',
      errorCode: 'enqueue_failed',
    });
  });

  it('fails the action on a terminal-failed run even without an errorCode', async () => {
    createAndEnqueueAgentRunMock.mockResolvedValue({
      created: true,
      run: { id: 'agent-run-2', status: 'failed', errorCode: null },
    });

    const result = await __testOnly.executeAiTriageAction(
      { type: 'ai_triage' },
      0,
      makeContext(),
    );

    expect(result.outcome).toEqual({
      status: 'failed',
      message: 'ai_triage agent run was created but could not be enqueued',
    });
    expect(result.log.details).toMatchObject({ errorCode: 'enqueue_failed' });
  });

  it('terminalizes the parent action after a genuinely queued child run', async () => {
    createAndEnqueueAgentRunMock.mockResolvedValue({
      created: true,
      run: { id: 'agent-run-3', status: 'queued', errorCode: null },
    });

    const result = await __testOnly.executeAiTriageAction(
      { type: 'ai_triage' },
      0,
      makeContext(),
    );

    expect(result.outcome.status).toBe('succeeded');
    expect(result.log.message).toBe('ai_triage queued agent run');
  });

  it('refuses ai_triage on an unmanaged automation', async () => {
    const result = await __testOnly.executeAiTriageAction(
      { type: 'ai_triage' },
      0,
      makeContext({ automation: { managedByAgentId: null } }),
    );

    expect(result.outcome).toEqual({
      status: 'failed',
      message: 'ai_triage action on an unmanaged automation — refusing',
    });
    expect(result.log.level).toBe('error');
    expect(createAndEnqueueAgentRunMock).not.toHaveBeenCalled();
    expect(selectMock).not.toHaveBeenCalled();
  });

  it('dedupeKey is alert:<id> so a re-delivered event cannot double-run', async () => {
    await __testOnly.executeAiTriageAction({ type: 'ai_triage' }, 0, makeContext());
    await __testOnly.executeAiTriageAction(
      { type: 'ai_triage' },
      0,
      makeContext({
        trigger: { ...DEFAULT_TRIGGER, alertId: null, eventId: 'evt-9' },
      }),
    );
    await __testOnly.executeAiTriageAction(
      { type: 'ai_triage' },
      0,
      makeContext({
        runId: 'run-fallback',
        trigger: { ...DEFAULT_TRIGGER, alertId: null, eventId: null },
      }),
    );

    expect(createAndEnqueueAgentRunMock).toHaveBeenCalledTimes(3);
    expect(gateInput(0).dedupeKey).toBe('alert:alert-1');
    expect(gateInput(1).dedupeKey).toBe('event:evt-9');
    expect(gateInput(2).dedupeKey).toBe('event:run-fallback');
  });

  it('omits alertContext (and issues no device query) when the trigger carries no severity', async () => {
    await __testOnly.executeAiTriageAction(
      { type: 'ai_triage' },
      0,
      makeContext({ trigger: { ...DEFAULT_TRIGGER, severity: null } }),
    );

    expect(createAndEnqueueAgentRunMock).toHaveBeenCalledTimes(1);
    const actual = gateInput();
    expect(actual.alertContext).toBeUndefined();
    expect(actual).not.toHaveProperty('alertContext');
    expect(selectMock).not.toHaveBeenCalled();
  });

  it("builds alertContext from the trigger and the device's tags", async () => {
    mockDeviceTags([{ tags: ['prod', 'db'] }]);

    await __testOnly.executeAiTriageAction({ type: 'ai_triage' }, 0, makeContext());

    let actual = gateInput();
    expect(actual.alertContext).toEqual({
      severity: 'high',
      ruleId: 'rule-1',
      siteId: 'site-1',
      deviceTags: ['prod', 'db'],
    });

    mockDeviceTags([]);
    await __testOnly.executeAiTriageAction({ type: 'ai_triage' }, 0, makeContext());

    actual = gateInput(1);
    expect(actual.alertContext).toEqual({
      severity: 'high',
      ruleId: 'rule-1',
      siteId: 'site-1',
      deviceTags: [],
    });
  });

  it("executeAction dispatches ai_triage with the run's trigger context", async () => {
    const automation = makeContext().automation;
    const device = makeContext().device;
    const trigger: AutomationTriggerContext = {
      alertId: 'alert-from-builder',
      eventId: 'evt-from-builder',
      severity: 'critical',
      ruleId: 'rule-from-builder',
    };
    const context = __testOnly.buildActionExecutionContext({
      automation,
      runId: 'run-from-builder',
      scriptsById: new Map(),
      channelsById: new Map(),
      variableScope: { orgIds: new Set(['org-device']) } as any,
      trigger,
    }, device);

    await __testOnly.executeAction({ type: 'ai_triage' }, 0, context);

    expect(createAndEnqueueAgentRunMock).toHaveBeenCalledTimes(1);
    const actual = gateInput();
    expect(actual.alertId).toBe('alert-from-builder');
  });
});
