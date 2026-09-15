/**
 * Execution plane W04 (R1) — the ONE entry point W05's chat tool calls.
 *
 * `createAndEnqueueAgentRun` is the real admission and stays that way; this
 * wrapper exists because W05 must not depend on `AgentRunSkipReason`, a union
 * shared by six other profiles that grows whenever any of them does. The
 * translation is a TOTAL function over that union (`satisfies Record<…>`), so
 * a reason added by a future wave is a compile error there rather than an
 * `undefined` refusal rendered as a blank error toast — and this file asserts
 * the runtime object is total too, which the type alone cannot do.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const createAndEnqueueAgentRun = vi.hoisted(() => vi.fn());
vi.mock('./runService', () => ({ createAndEnqueueAgentRun }));

const resolveArtifact = vi.hoisted(() => vi.fn());
vi.mock('../artifacts/artifactService', () => ({ resolveArtifact }));

import { admitAnalysisRun, SKIP_REASON_REFUSALS, type AdmitAnalysisRunInput } from './analysisAdmission';

const ORG_ID = '00000000-0000-4000-8000-0000000000a1';
const RUN_ID = '00000000-0000-4000-8000-0000000000a6';
const HANDLE = '11111111-1111-4111-8111-111111111111';

function input(over: Partial<AdmitAnalysisRunInput> = {}): AdmitAnalysisRunInput {
  return {
    orgId: ORG_ID,
    requestedByUserId: 'user-1',
    sessionId: 'chat-1',
    goal: 'why are three devices slow',
    deviceIds: ['dev-1'],
    siteId: null,
    stagedHandles: [],
    dedupeKey: 'chat-analysis:1',
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  resolveArtifact.mockResolvedValue({ id: HANDLE, orgId: ORG_ID });
  createAndEnqueueAgentRun.mockResolvedValue({
    created: true, run: { id: RUN_ID, status: 'queued', errorCode: null },
  });
});

describe('admitAnalysisRun', () => {
  it('admits as profile analysis with the frozen inputs, never as a device-bound run', async () => {
    await expect(admitAnalysisRun(input({ stagedHandles: [HANDLE] }))).resolves.toEqual({
      created: true, runId: RUN_ID, status: 'queued',
    });
    const call = createAndEnqueueAgentRun.mock.calls[0]![0] as Record<string, unknown>;
    expect(call.profile).toBe('analysis');
    expect(call.deviceId).toBeNull();
    expect(call.analysis).toEqual({ deviceIds: ['dev-1'], inputHandles: [HANDLE] });
    // The CHAT session belongs in trigger_ref — `ai_agent_runs.session_id` is
    // the agent session the run loop opens, a different thing entirely.
    expect(call.sessionId).toBeUndefined();
    expect(call.triggerRef).toMatchObject({ source: 'chat_analysis', chatSessionId: 'chat-1' });
  });

  it('refuses artifact_forbidden for a handle that does not resolve in the org, without admitting', async () => {
    resolveArtifact.mockResolvedValueOnce(null);
    await expect(admitAnalysisRun(input({ stagedHandles: [HANDLE] }))).resolves.toEqual({
      created: false, refusal: 'artifact_forbidden',
    });
    expect(createAndEnqueueAgentRun).not.toHaveBeenCalled();
  });

  it('translates a skip into a refusal, with a detail where the refusal alone would mislead', async () => {
    createAndEnqueueAgentRun.mockResolvedValue({ created: false, skipped: 'compute_credits_exhausted' });
    await expect(admitAnalysisRun(input())).resolves.toEqual({
      created: false,
      refusal: 'compute_budget_exceeded',
      detail: expect.stringContaining('credits'),
    });
  });

  it('reports an enqueue failure as a refusal even though admission said created', async () => {
    createAndEnqueueAgentRun.mockResolvedValue({
      created: true, run: { id: RUN_ID, status: 'failed', errorCode: 'enqueue_failed' },
    });
    await expect(admitAnalysisRun(input())).resolves.toEqual({
      created: false, refusal: 'enqueue_failed',
    });
  });

  it.each([
    ['too_many_input_devices', 'too_many_input_devices'],
    ['device_not_in_org', 'device_not_in_org'],
    ['external_processing_disabled', 'external_processing_disabled'],
    ['workspace_capability_missing', 'workspace_capability_missing'],
    ['workspace_unavailable', 'analysis_not_available'],
    ['max_concurrent_analysis_runs', 'max_concurrent_analysis_runs'],
    ['duplicate', 'analysis_rate'],
    ['agent_daily_budget_exceeded', 'org_budget_exceeded'],
  ])('maps %s onto %s', async (skipped, refusal) => {
    createAndEnqueueAgentRun.mockResolvedValue({ created: false, skipped });
    const result = await admitAnalysisRun(input());
    expect(result).toMatchObject({ created: false, refusal });
  });

  it('keeps too_many_input_devices and device_not_in_org distinct', () => {
    // Collapsing them would either leak a tenancy signal for a benign
    // over-selection or send the technician hunting a permissions problem.
    expect(SKIP_REASON_REFUSALS.too_many_input_devices)
      .not.toBe(SKIP_REASON_REFUSALS.device_not_in_org);
  });

  it('every mapped refusal is a member of the refusal union at runtime', () => {
    const allowed = new Set([
      'analysis_not_available', 'external_processing_disabled', 'workspace_capability_missing',
      'analysis_region_unavailable', 'compute_budget_exceeded', 'org_budget_exceeded',
      'max_concurrent_analysis_runs', 'analysis_rate', 'too_many_input_devices',
      'device_not_in_org', 'artifact_forbidden', 'enqueue_failed',
    ]);
    for (const [skip, refusal] of Object.entries(SKIP_REASON_REFUSALS)) {
      expect(allowed.has(refusal), `${skip} -> ${refusal}`).toBe(true);
    }
  });
});
