/**
 * AI patch agent W04 (#5750) — exclusive patch-work routing at the ONE place
 * alert-driven remediation is admitted (`executeAiTriageAction`).
 *
 * A patch-classified alert wakes the PATCH agent (device-less, focus hint);
 * every other case falls back to the existing triage admission with the
 * reason recorded on `triggerRef.patchWorkFallbackReason`. A fallback never
 * bypasses an org opt-out or an open circuit — those are the gate's own
 * skips, and triage picks the alert up exactly as if no patch agent existed.
 * The verdict lane (`alertVerdictSubscriber`) is not touched by this module.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CreateAgentRunInput } from './aiAgents/runService';

const {
  createAndEnqueueAgentRunMock,
  publishEventMock,
  selectMock,
  resolveAlertCategoryMock,
} = vi.hoisted(() => ({
  createAndEnqueueAgentRunMock: vi.fn(),
  publishEventMock: vi.fn(),
  selectMock: vi.fn(),
  resolveAlertCategoryMock: vi.fn(),
}));

vi.mock('../db', () => ({
  db: { insert: vi.fn(), update: vi.fn(), select: selectMock, selectDistinct: vi.fn() },
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
}));
vi.mock('./eventBus', () => ({ publishEvent: publishEventMock }));
vi.mock('./aiAgents/runService', () => ({ createAndEnqueueAgentRun: createAndEnqueueAgentRunMock }));
vi.mock('./aiAgents/patchWorkClassifier', () => ({
  resolveAlertCategory: resolveAlertCategoryMock,
  classifyAlertAsPatchWork: vi.fn(),
}));

import { __testOnly, type AutomationTriggerContext } from './automationRuntime';

const TRIGGER: AutomationTriggerContext = { alertId: 'alert-1', eventId: 'evt-1', severity: 'high', ruleId: 'rule-1' };

function makeContext() {
  return {
    automation: { id: 'auto-1', orgId: 'org-device', name: 'Alert triage', createdBy: 'user-1', managedByAgentId: 'agent-1' },
    runId: 'run-1',
    trigger: TRIGGER,
    device: {
      id: 'dev-1', orgId: 'org-device', hostname: 'dev-1.example', displayName: 'DB', osType: 'linux',
      status: 'online', agentId: 'device-agent-1', siteId: 'site-1', customFields: {},
    },
    scriptsById: new Map(),
    channelsById: new Map(),
    variableScope: { orgIds: new Set(['org-device']) },
  } as any;
}

function gateInput(index = 0): CreateAgentRunInput {
  const call = createAndEnqueueAgentRunMock.mock.calls[index];
  if (!call) throw new Error(`no createAndEnqueueAgentRun call at index ${index}`);
  return call[0] as CreateAgentRunInput;
}

function mockDeviceTags(rows: Array<{ tags: string[] | null }>) {
  const limitMock = vi.fn().mockResolvedValue(rows);
  const whereMock = vi.fn().mockReturnValue({ limit: limitMock });
  const fromMock = vi.fn().mockReturnValue({ where: whereMock });
  selectMock.mockReturnValue({ from: fromMock });
}

const PATCH = { category: 'patching', monitorKind: null, isPatchWork: true };
const NOT_PATCH = { category: 'monitor', monitorKind: 'cpu', isPatchWork: false };

describe('executeAiTriageAction — patch-work routing (W04)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDeviceTags([{ tags: ['sql'] }]);
    createAndEnqueueAgentRunMock.mockResolvedValue({ created: true, run: { id: 'agent-run-1' } });
  });

  it('routes a patch-classified alert to the patch agent, device-less with a focus hint, and admits NO triage run', async () => {
    resolveAlertCategoryMock.mockResolvedValue(PATCH);

    const result = await __testOnly.executeAiTriageAction({ type: 'ai_triage' }, 0, makeContext());

    expect(resolveAlertCategoryMock).toHaveBeenCalledWith('alert-1', 'org-device');
    expect(createAndEnqueueAgentRunMock).toHaveBeenCalledTimes(1);
    expect(gateInput()).toEqual({
      orgId: 'org-device',
      kind: 'patch',
      profile: 'patch',
      triggerKind: 'alert',
      deviceId: null,
      alertId: 'alert-1',
      triggerEventId: 'evt-1',
      triggerRef: {
        automationId: 'auto-1',
        automationRunId: 'run-1',
        alertRuleId: 'rule-1',
        managedByAgentId: 'agent-1',
        focusDeviceId: 'dev-1',
        routedFrom: 'triage',
      },
      alertContext: {
        severity: 'high', ruleId: 'rule-1', siteId: 'site-1', deviceTags: ['sql'],
        category: 'patching', focusDeviceId: 'dev-1',
      },
      dedupeKey: 'patch-alert:alert-1',
    });
    // The lane is named: a technician chasing this run is sent to the PATCH agent.
    expect(result.outcome).toEqual({ status: 'queued', agentRunId: 'agent-run-1', message: 'ai_triage queued patch agent run' });
    expect(result.log.details).toMatchObject({ routedTo: 'patch' });
  });

  it.each([
    ['no_effective_agent', 'no_patch_agent'],
    ['agent_disabled', 'patch_agent_off'],
    ['mode_off', 'patch_agent_off'],
    ['circuit_open', 'patch_agent_circuit_open'],
  ] as const)('falls back to triage on patch skip %s and RECORDS %s', async (skip, reason) => {
    resolveAlertCategoryMock.mockResolvedValue(PATCH);
    createAndEnqueueAgentRunMock
      .mockResolvedValueOnce({ created: false, skipped: skip })
      .mockResolvedValueOnce({ created: true, run: { id: 'triage-run-1' } });

    const result = await __testOnly.executeAiTriageAction({ type: 'ai_triage' }, 0, makeContext());

    expect(createAndEnqueueAgentRunMock).toHaveBeenCalledTimes(2);
    expect(gateInput(0)).toMatchObject({ kind: 'patch', profile: 'patch', deviceId: null });
    expect(gateInput(1)).toMatchObject({
      kind: 'triage',
      deviceId: 'dev-1',
      alertId: 'alert-1',
      dedupeKey: 'alert:alert-1',
      triggerRef: expect.objectContaining({ patchWorkFallbackReason: reason }),
    });
    expect(gateInput(1)).not.toHaveProperty('profile');
    expect(result.outcome).toEqual({ status: 'queued', agentRunId: 'triage-run-1', message: 'ai_triage queued agent run' });
    expect(result.log.details).toMatchObject({ routedTo: 'triage' });
  });

  it('falls back to triage on any other patch skip (e.g. a trigger filter) and records the skip', async () => {
    resolveAlertCategoryMock.mockResolvedValue(PATCH);
    createAndEnqueueAgentRunMock
      .mockResolvedValueOnce({ created: false, skipped: 'trigger_filter_mismatch' })
      .mockResolvedValueOnce({ created: true, run: { id: 'triage-run-1' } });

    await __testOnly.executeAiTriageAction({ type: 'ai_triage' }, 0, makeContext());

    expect(createAndEnqueueAgentRunMock).toHaveBeenCalledTimes(2);
    expect(gateInput(1).triggerRef).toMatchObject({
      patchWorkFallbackReason: 'patch_agent_skipped',
      patchWorkSkipReason: 'trigger_filter_mismatch',
    });
  });

  it('does NOT fall back on a duplicate patch admission — the patch agent already owns the alert', async () => {
    resolveAlertCategoryMock.mockResolvedValue(PATCH);
    createAndEnqueueAgentRunMock.mockResolvedValueOnce({ created: false, skipped: 'duplicate' });

    const result = await __testOnly.executeAiTriageAction({ type: 'ai_triage' }, 0, makeContext());

    expect(createAndEnqueueAgentRunMock).toHaveBeenCalledTimes(1);
    expect(result.outcome).toEqual({ status: 'succeeded' });
  });

  it('leaves a non-patch alert on triage, recording not_patch_work and the resolved category', async () => {
    resolveAlertCategoryMock.mockResolvedValue(NOT_PATCH);

    await __testOnly.executeAiTriageAction({ type: 'ai_triage' }, 0, makeContext());

    expect(createAndEnqueueAgentRunMock).toHaveBeenCalledTimes(1);
    expect(gateInput()).toMatchObject({
      kind: 'triage',
      deviceId: 'dev-1',
      triggerRef: expect.objectContaining({ patchWorkFallbackReason: 'not_patch_work' }),
      alertContext: expect.objectContaining({ category: 'monitor' }),
      dedupeKey: 'alert:alert-1',
    });
    expect(gateInput()).not.toHaveProperty('profile');
  });

  it('skips classification and records not_patch_work when the trigger carries no alert', async () => {
    const ctx = makeContext();
    ctx.trigger = { eventId: 'evt-9', severity: 'high', ruleId: null };

    await __testOnly.executeAiTriageAction({ type: 'ai_triage' }, 0, ctx);

    expect(resolveAlertCategoryMock).not.toHaveBeenCalled();
    expect(gateInput()).toMatchObject({ kind: 'triage', dedupeKey: 'event:evt-9' });
  });

  it('a patch run that was created but could not be enqueued is a failed action, not a triage fallback', async () => {
    resolveAlertCategoryMock.mockResolvedValue(PATCH);
    createAndEnqueueAgentRunMock.mockResolvedValueOnce({
      created: true, run: { id: 'agent-run-1', status: 'failed', errorCode: 'enqueue_failed' },
    });

    const result = await __testOnly.executeAiTriageAction({ type: 'ai_triage' }, 0, makeContext());

    expect(createAndEnqueueAgentRunMock).toHaveBeenCalledTimes(1);
    expect(result.outcome).toEqual({ status: 'failed', message: 'ai_triage: patch agent run was created but could not be enqueued' });
    expect(result.log.details).toMatchObject({ routedTo: 'patch', agentRunId: 'agent-run-1' });
  });
});
