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
  workspaceLaunchAnalysisHandler,
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

describe('disabled chat analysis launch', () => {
  it.each([
    ['organization user', auth(), SESSION],
    ['partner user', auth({ orgId: null, scope: 'partner' }), SESSION],
    ['missing session', auth(), null],
  ] as const)('refuses %s without reading data or admitting work', async (_label, caller, sessionId) => {
    const raw = await launchAnalysisFromChat({ goal: 'Analyze devices', inputHandles: [HANDLE] }, caller, sessionId);
    expect(JSON.parse(raw)).toEqual({
      error: 'chat_analysis_launch_disabled',
      message: 'Starting background analysis from chat is disabled while delegated authorization is redesigned.',
    });
    expect(resolveArtifact).not.toHaveBeenCalled();
    expect(sessionGet).not.toHaveBeenCalled();
    expect(admitAnalysisRun).not.toHaveBeenCalled();
    expect(watchRunForSession).not.toHaveBeenCalled();
  });

  it('refuses direct or stale handler invocation even with workspace enabled', async () => {
    const raw = await workspaceLaunchAnalysisHandler({ goal: 'Analyze devices' }, auth(), SESSION);
    expect(JSON.parse(raw).error).toBe('chat_analysis_launch_disabled');
    expect(resolveArtifact).not.toHaveBeenCalled();
    expect(sessionGet).not.toHaveBeenCalled();
    expect(admitAnalysisRun).not.toHaveBeenCalled();
    expect(watchRunForSession).not.toHaveBeenCalled();
  });

  it('retains the reserved name and tier for historical records', () => {
    expect(workspaceLaunchToolTiers[WORKSPACE_LAUNCH_TOOL_NAME]).toBe(1);
  });
});
