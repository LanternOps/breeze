import { beforeEach, describe, expect, it, vi } from 'vitest';

const admitAnalysisRun = vi.hoisted(() => vi.fn());
const resolveArtifact = vi.hoisted(() => vi.fn());
const aiWorkspaceEnabled = vi.hoisted(() => vi.fn(() => true));
const watchRunForSession = vi.hoisted(() => vi.fn());
const sessionGet = vi.hoisted(() => vi.fn());

vi.mock('../aiAgents/analysisAdmission', () => ({ admitAnalysisRun }));
vi.mock('../artifacts/artifactService', () => ({ resolveArtifact }));
vi.mock('../../config/env', () => ({ aiWorkspaceEnabled }));
vi.mock('./chatRunBridge', () => ({ watchRunForSession }));
vi.mock('../streamingSessionManager', () => ({
  streamingSessionManager: { get: sessionGet },
}));

import {
  launchAnalysisFromChat,
  workspaceLaunchToolTiers,
  WORKSPACE_LAUNCH_TOOL_NAME,
} from './workspaceLaunchTool';
import type { AuthContext } from '../../middleware/auth';

const ORG = '11111111-1111-4111-8111-111111111111';
const RUN = '22222222-2222-4222-8222-222222222222';
const HANDLE = '33333333-3333-4333-8333-333333333333';
const SESSION = '44444444-4444-4444-8444-444444444444';

function auth(overrides: Partial<{ orgId: string | null; scope: string }> = {}): AuthContext {
  return {
    orgId: overrides.orgId === undefined ? ORG : overrides.orgId,
    accessibleOrgIds: [ORG],
    scope: overrides.scope ?? 'organization',
    user: { id: '55555555-5555-4555-8555-555555555555' },
  } as unknown as AuthContext;
}

beforeEach(() => {
  vi.clearAllMocks();
  aiWorkspaceEnabled.mockReturnValue(true);
  resolveArtifact.mockResolvedValue({ id: HANDLE, orgId: ORG, name: 'logs.jsonl' });
  admitAnalysisRun.mockResolvedValue({ created: true, runId: RUN, status: 'queued' });
  // What `makeSessionAwareHandler` resolved to hand us `sessionId`; re-read here
  // for its canonical `orgId` (ActiveSession.orgId is always set, even when the
  // caller's own auth carries none).
  sessionGet.mockReturnValue({ breezeSessionId: SESSION, orgId: ORG });
});

describe('workspace_launch_analysis (spec §5.5)', () => {
  it('admits an analysis run with the chat user as owner and the session id attached', async () => {
    const raw = await launchAnalysisFromChat(
      {
        goal: 'Find external failed logons',
        deviceIds: ['66666666-6666-4666-8666-666666666666'],
        inputHandles: [HANDLE],
      },
      auth(),
      SESSION,
    );

    expect(admitAnalysisRun).toHaveBeenCalledTimes(1);
    const passed = admitAnalysisRun.mock.calls[0]![0];
    expect(passed).toMatchObject({
      orgId: ORG,
      requestedByUserId: '55555555-5555-4555-8555-555555555555',
      sessionId: SESSION,
      goal: 'Find external failed logons',
      deviceIds: ['66666666-6666-4666-8666-666666666666'],
      siteId: null,
      stagedHandles: [HANDLE],
    });
    expect(passed.dedupeKey).toMatch(/^chat:/);
    expect(JSON.parse(raw)).toEqual({ runId: RUN, status: 'queued' });
  });

  it('registers the bridge watch so the result can reach this session', async () => {
    await launchAnalysisFromChat({ goal: 'g' }, auth(), SESSION);
    expect(watchRunForSession).toHaveBeenCalledWith({ runId: RUN, sessionId: SESSION, orgId: ORG });
  });

  it('refuses outright when there is no chat session — never admits with sessionId null', async () => {
    // On the MCP path `makeSessionAwareHandler` already fails closed with
    // `no_active_session`, so this branch is for every OTHER caller. A run
    // admitted with a null session id has nowhere to deliver its result and no
    // conversation it belongs to; refusing is the only honest answer.
    const raw = await launchAnalysisFromChat({ goal: 'g' }, auth(), null);
    expect(JSON.parse(raw)).toEqual({
      error: 'chat_session_required',
      message: 'Analysis runs can only be started from a chat session.',
    });
    expect(admitAnalysisRun).not.toHaveBeenCalled();
    expect(watchRunForSession).not.toHaveBeenCalled();
  });

  it('falls back to the active session org when the caller auth carries none', async () => {
    // A partner-scope login: `auth.orgId` is null, but the session was created
    // against exactly one org and `ActiveSession.orgId` is always set.
    await launchAnalysisFromChat({ goal: 'g' }, auth({ orgId: null, scope: 'partner' }), SESSION);
    expect(sessionGet).toHaveBeenCalledWith(SESSION);
    expect(admitAnalysisRun.mock.calls[0]![0]).toMatchObject({ orgId: ORG, sessionId: SESSION });
  });

  it('refuses when neither the auth nor the session yields an org', async () => {
    sessionGet.mockReturnValue(undefined);
    const raw = await launchAnalysisFromChat(
      { goal: 'g' },
      auth({ orgId: null, scope: 'partner' }),
      SESSION,
    );
    expect(JSON.parse(raw).error).toBe('org_context_required');
    expect(admitAnalysisRun).not.toHaveBeenCalled();
  });

  it('refuses before admission when the workspace lane is not available', async () => {
    aiWorkspaceEnabled.mockReturnValue(false);
    const raw = await launchAnalysisFromChat({ goal: 'g' }, auth(), SESSION);
    expect(JSON.parse(raw)).toEqual({
      error: 'analysis_not_available',
      message: 'Sandboxed analysis runs are not available on this deployment.',
    });
    expect(admitAnalysisRun).not.toHaveBeenCalled();
  });

  it('maps an admission refusal to a typed tool error the model can read', async () => {
    admitAnalysisRun.mockResolvedValue({ created: false, refusal: 'external_processing_disabled' });
    const raw = await launchAnalysisFromChat({ goal: 'g' }, auth(), SESSION);
    expect(JSON.parse(raw)).toEqual({
      error: 'external_processing_disabled',
      message:
        'This organization has not enabled external processing, so analysis runs are turned off. '
        + 'An administrator can enable it under Settings → Organization → AI.',
    });
  });

  it('has a message for EVERY refusal W04 can return, including the ones added late', async () => {
    // Typed against W04's union, so this list is the compiler's business too —
    // but a missing MESSAGE is only a runtime `undefined` in front of a
    // technician, which is what this test exists to catch.
    for (const refusal of [
      'analysis_not_available',
      'external_processing_disabled',
      'workspace_capability_missing',
      'analysis_region_unavailable',
      'compute_budget_exceeded',
      'org_budget_exceeded',
      'max_concurrent_analysis_runs',
      'analysis_rate',
      'too_many_input_devices',
      'device_not_in_org',
      'artifact_forbidden',
      'enqueue_failed',
    ] as const) {
      admitAnalysisRun.mockResolvedValue({ created: false, refusal });
      const parsed = JSON.parse(await launchAnalysisFromChat({ goal: 'g' }, auth(), SESSION));
      expect(parsed.error).toBe(refusal);
      expect(typeof parsed.message).toBe('string');
      expect(parsed.message.length).toBeGreaterThan(0);
    }
  });

  it('appends the admission detail when one is supplied, without replacing the sentence', async () => {
    admitAnalysisRun.mockResolvedValue({
      created: false,
      refusal: 'device_not_in_org',
      detail: 'device 66666666-… is not in this organization',
    });
    const parsed = JSON.parse(await launchAnalysisFromChat({ goal: 'g' }, auth(), SESSION));
    expect(parsed.error).toBe('device_not_in_org');
    expect(parsed.message).toContain('device 66666666-…');
    // The human sentence survives: `detail` is context, never a replacement.
    expect(parsed.message.length).toBeGreaterThan(
      'device 66666666-… is not in this organization'.length,
    );
  });

  it('refuses an input handle that does not resolve in the caller org, without leaking why', async () => {
    resolveArtifact.mockResolvedValue(null);
    const raw = await launchAnalysisFromChat({ goal: 'g', inputHandles: [HANDLE] }, auth(), SESSION);
    expect(JSON.parse(raw)).toEqual({
      error: 'artifact_forbidden',
      message: `No artifact with handle ${HANDLE} is available to this organization.`,
    });
    expect(admitAnalysisRun).not.toHaveBeenCalled();
  });

  it('declares Tier 1 in its own tier table, the session-only tool shape', () => {
    // Session-only tools carry their tier in a table, not in an `aiTools` map
    // entry — the same shape as `m365ToolTiers` / `googleToolTiers`. Tier 1
    // because it executes nothing on the fleet: it queues work whose every
    // fleet-touching step goes back through the tier gate.
    expect(workspaceLaunchToolTiers[WORKSPACE_LAUNCH_TOOL_NAME]).toBe(1);
  });
});
