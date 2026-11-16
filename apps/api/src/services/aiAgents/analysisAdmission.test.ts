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
const GrantDepthExceededError = vi.hoisted(() => class GrantDepthExceededError extends Error {
  readonly code = 'grant_depth_exceeded' as const;
});
vi.mock('./runService', () => ({ createAndEnqueueAgentRun, GrantDepthExceededError }));

const resolveArtifact = vi.hoisted(() => vi.fn());
vi.mock('../artifacts/artifactService', () => ({ resolveArtifact }));

const verifiedAnalysisSiteId = vi.hoisted(() => vi.fn());
vi.mock('./analysisRunSite', () => ({ verifiedAnalysisSiteId }));

// W03: the handle pre-check runs in a system DB context (Review Focus 4).
const dbCtx = vi.hoisted(() => ({
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));
vi.mock('../../db', () => ({
  db: {},
  runOutsideDbContext: dbCtx.runOutsideDbContext,
  withSystemDbAccessContext: dbCtx.withSystemDbAccessContext,
  getCurrentDbAccessContext: vi.fn(() => undefined),
}));

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
    scope: 'devices',
    deviceIds: ['dev-1'],
    siteId: null,
    stagedHandles: [],
    dedupeKey: 'chat-analysis:1',
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  resolveArtifact.mockResolvedValue({
    id: HANDLE, orgId: ORG_ID, kind: 'output', createdByTool: 'workspace_collect',
    expiresAt: new Date(Date.now() + 86_400_000),
  });
  verifiedAnalysisSiteId.mockImplementation(async (_orgId: string, siteId: string | null) => siteId);
  createAndEnqueueAgentRun.mockResolvedValue({
    created: true, run: { id: RUN_ID, status: 'queued', errorCode: null },
  });
});

describe('admitAnalysisRun', () => {
  it('records the requested site only when the site check confirms it', async () => {
    const SITE = '00000000-0000-4000-8000-0000000000b1';
    verifiedAnalysisSiteId.mockResolvedValueOnce(SITE);
    await admitAnalysisRun(input({ siteId: SITE, deviceIds: ['dev-1', 'dev-2'] }));
    expect(verifiedAnalysisSiteId).toHaveBeenCalledWith(ORG_ID, SITE, ['dev-1', 'dev-2']);
    expect((createAndEnqueueAgentRun.mock.calls[0]![0] as any).triggerRef.siteId).toBe(SITE);

    verifiedAnalysisSiteId.mockResolvedValueOnce(null);
    await admitAnalysisRun(input({ siteId: SITE, deviceIds: ['dev-1', 'dev-2'] }));
    // A site that does not hold every input device is not recorded; the run is still admitted.
    expect((createAndEnqueueAgentRun.mock.calls[1]![0] as any).triggerRef.siteId).toBeNull();
    expect(createAndEnqueueAgentRun).toHaveBeenCalledTimes(2);
  });

  it('admits as profile analysis with the frozen inputs, never as a device-bound run', async () => {
    await expect(admitAnalysisRun(input({ stagedHandles: [HANDLE] }))).resolves.toEqual({
      created: true, runId: RUN_ID, status: 'queued',
    });
    const call = createAndEnqueueAgentRun.mock.calls[0]![0] as Record<string, unknown>;
    expect(call.profile).toBe('analysis');
    expect(call.deviceId).toBeNull();
    expect(call.analysis).toEqual({ scope: 'devices', siteId: null, deviceIds: ['dev-1'], inputHandles: [HANDLE] });
    // The CHAT session belongs in trigger_ref — `ai_agent_runs.session_id` is
    // the agent session the run loop opens, a different thing entirely.
    expect(call.sessionId).toBeUndefined();
    expect(call.triggerRef).toMatchObject({ source: 'chat_analysis', chatSessionId: 'chat-1', originSessionId: 'chat-1' });
  });

  it('forwards the trusted export grants and scope when given, and no exportGrants key when not', async () => {
    const grants = { datasets: ['metrics'], sensitiveGates: [] };
    await admitAnalysisRun(input({ scope: 'org', deviceIds: [], exportGrants: grants }));
    expect((createAndEnqueueAgentRun.mock.calls[0]![0] as any).analysis)
      .toEqual({ scope: 'org', siteId: null, deviceIds: [], inputHandles: [], exportGrants: grants });
    await admitAnalysisRun(input());
    expect((createAndEnqueueAgentRun.mock.calls[1]![0] as any).analysis).not.toHaveProperty('exportGrants');
  });

  it('forwards the requested site as the frame siteId even when it is not recorded in trigger_ref', async () => {
    const SITE = '00000000-0000-4000-8000-0000000000b1';
    verifiedAnalysisSiteId.mockResolvedValueOnce(null);
    await admitAnalysisRun(input({ scope: 'site', siteId: SITE, deviceIds: [] }));
    const call = createAndEnqueueAgentRun.mock.calls[0]![0] as any;
    expect(call.analysis).toMatchObject({ scope: 'site', siteId: SITE });
  });

  it('records originSessionId as null (key present) when there is no chat session', async () => {
    await admitAnalysisRun(input({ sessionId: null }));
    const call = createAndEnqueueAgentRun.mock.calls[0]![0] as { triggerRef: Record<string, unknown> };
    expect(call.triggerRef).toHaveProperty('originSessionId', null);
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
    ['frame_too_large', 'frame_too_large'],
    ['site_not_in_scope', 'site_not_in_scope'],
    ['frame_empty', 'frame_empty'],
    ['external_processing_disabled', 'external_processing_disabled'],
    ['workspace_capability_missing', 'workspace_capability_missing'],
    ['workspace_unavailable', 'analysis_not_available'],
    ['max_concurrent_analysis_runs', 'max_concurrent_analysis_runs'],
    ['duplicate', 'analysis_rate'],
    ['agent_daily_budget_exceeded', 'org_budget_exceeded'],
    // AI model registry W03: its own refusal, like org_budget_exceeded — the
    // thing to fix (the agents' AI model) is a different setting.
    ['model_unavailable', 'model_unavailable'],
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
      'device_not_in_org', 'artifact_forbidden', 'enqueue_failed', 'model_unavailable',
      'grant_refused',
      'frame_too_large', 'site_not_in_scope', 'frame_empty',
      'analysis_continuation_not_found', 'analysis_chain_too_long', 'analysis_chain_budget_exceeded',
    ]);
    for (const [skip, refusal] of Object.entries(SKIP_REASON_REFUSALS)) {
      expect(allowed.has(refusal), `${skip} -> ${refusal}`).toBe(true);
    }
  });

  // Wisp W07 — the coordinator's analysis launcher is the only grant-bearing caller.
  it('maps the grant_* skips onto grant_refused', async () => {
    expect(SKIP_REASON_REFUSALS.grant_inactive).toBe('grant_refused');
    expect(SKIP_REASON_REFUSALS.grant_org_out_of_ceiling).toBe('grant_refused');
    createAndEnqueueAgentRun.mockResolvedValue({ created: false, skipped: 'grant_inactive' });
    await expect(admitAnalysisRun(input())).resolves.toMatchObject({ created: false, refusal: 'grant_refused' });
  });

  it('catches GrantDepthExceededError as grant_refused (never a thrown 500 on the chat path)', async () => {
    createAndEnqueueAgentRun.mockRejectedValue(new GrantDepthExceededError('depth'));
    await expect(admitAnalysisRun(input({ grant: { grantId: 'g', grantRevisionId: 'r', requestedByRunId: 'parent' } })))
      .resolves.toEqual({ created: false, refusal: 'grant_refused' });
  });

  it('other admission errors still propagate', async () => {
    createAndEnqueueAgentRun.mockRejectedValue(new Error('db down'));
    await expect(admitAnalysisRun(input())).rejects.toThrow('db down');
  });

  it('forwards grant to createAndEnqueueAgentRun, and omits it when absent', async () => {
    const grant = { grantId: 'g', grantRevisionId: 'r', requestedByRunId: 'parent' };
    await admitAnalysisRun(input({ grant }));
    expect(createAndEnqueueAgentRun.mock.calls[0]![0]).toMatchObject({ grant });
    await admitAnalysisRun(input());
    expect(createAndEnqueueAgentRun.mock.calls[1]![0]).not.toHaveProperty('grant');
  });

  // Wisp analysis sessions W03.
  it.each([['analysis_chain_too_long'], ['analysis_chain_budget_exceeded'], ['analysis_continuation_not_found']])(
    'maps %s onto itself', async (skipped) => {
      createAndEnqueueAgentRun.mockResolvedValue({ created: false, skipped });
      await expect(admitAnalysisRun(input())).resolves.toMatchObject({ created: false, refusal: skipped });
    });

  it.each([
    ['an expired output', { kind: 'output', createdByTool: 'workspace_collect', expiresAt: new Date(Date.now() - 1) }],
    ['a step_stdout artifact', { kind: 'step_stdout', createdByTool: 'workspace_run', expiresAt: new Date(Date.now() + 86_400_000) }],
    ['a non-export capture', { kind: 'input_capture', createdByTool: 'search_logs', expiresAt: new Date(Date.now() + 86_400_000) }],
  ])('refuses %s as artifact_forbidden, without admitting', async (_label, record) => {
    resolveArtifact.mockResolvedValueOnce({ id: HANDLE, orgId: ORG_ID, ...record });
    await expect(admitAnalysisRun(input({ stagedHandles: [HANDLE] })))
      .resolves.toEqual({ created: false, refusal: 'artifact_forbidden' });
    expect(createAndEnqueueAgentRun).not.toHaveBeenCalled();
  });

  it('admits an unexpired export_dataset capture', async () => {
    resolveArtifact.mockResolvedValueOnce({
      id: HANDLE, orgId: ORG_ID, kind: 'input_capture', createdByTool: 'export_dataset',
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    await expect(admitAnalysisRun(input({ stagedHandles: [HANDLE] }))).resolves.toMatchObject({ created: true });
  });

  it('reads every handle inside a system DB context', async () => {
    await admitAnalysisRun(input({ stagedHandles: [HANDLE] }));
    expect(dbCtx.runOutsideDbContext).toHaveBeenCalled();
    expect(dbCtx.withSystemDbAccessContext).toHaveBeenCalled();
    expect(resolveArtifact.mock.invocationCallOrder[0])
      .toBeGreaterThan(dbCtx.withSystemDbAccessContext.mock.invocationCallOrder[0]!);
    expect(resolveArtifact).toHaveBeenCalledWith(HANDLE, { orgId: ORG_ID });
  });

  it('writes trigger_ref.continuation and forwards the lineage to admission', async () => {
    const PRIOR = '00000000-0000-4000-8000-0000000000f1';
    const ROOT = '00000000-0000-4000-8000-0000000000f0';
    const dropped = [{ handle: '00000000-0000-4000-8000-0000000000e1', reason: 'expired' as const }];
    await admitAnalysisRun(input({ continuation: { fromRunId: PRIOR, chainRootRunId: ROOT, chainDepth: 1, seed: 'S', dropped } }));
    const call = createAndEnqueueAgentRun.mock.calls[0]![0] as any;
    expect(call.triggerRef.continuation).toEqual({ fromRunId: PRIOR, seed: 'S', dropped });
    expect(call.triggerRef.originSessionId).toBe('chat-1');
    expect(call.analysis.continuation).toEqual({ fromRunId: PRIOR, chainRootRunId: ROOT, chainDepth: 1 });
  });

  it('a fresh run carries no continuation key on either side', async () => {
    await admitAnalysisRun(input());
    const call = createAndEnqueueAgentRun.mock.calls[0]![0] as any;
    expect(call.triggerRef).not.toHaveProperty('continuation');
    expect(call.analysis).not.toHaveProperty('continuation');
  });
});
