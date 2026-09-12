import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockPolicy = vi.fn();
const mockCount = vi.fn();
const mockRunCount = vi.fn();
const mockLane = vi.fn();
const mockDevice = vi.fn();
const mockLock = vi.fn();
const mockToolPermission = vi.fn();
const mockAgentGuardrails = vi.fn();
const mockAgentPolicy = vi.fn();
const mockKillState = vi.fn();
const mockMaintenance = vi.fn();
const mockScan = vi.fn();

vi.mock('../../db', () => ({
  db: { select: vi.fn(), execute: vi.fn() },
  runOutsideDbContext: async (fn: () => unknown) => fn(),
  withSystemDbAccessContext: async (fn: () => unknown) => fn(),
  withDbAccessContext: async (_ctx: unknown, fn: () => unknown) => fn(),
  getCurrentDbAccessContext: () => undefined,
}));
vi.mock('../scriptProposals/policy', () => ({
  resolveEffectiveScriptPolicy: (...a: unknown[]) => mockPolicy(...a),
}));
vi.mock('../scriptProposals/proposals', () => ({
  loadProposalForRelease: vi.fn(),
  latestCompletedReview: vi.fn(),
}));
vi.mock('../aiGuardrails', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  checkToolPermission: (...a: unknown[]) => mockToolPermission(...a),
  checkAgentGuardrails: (...a: unknown[]) => mockAgentGuardrails(...a),
}));
vi.mock('../aiAgents/effectivePolicy', () => ({
  resolveEffectiveAgentSystem: (...a: unknown[]) => mockAgentPolicy(...a),
}));
vi.mock('../aiKillState', () => ({ readAiKillState: (...a: unknown[]) => mockKillState(...a) }));
vi.mock('../scriptMaintenanceGate', () => ({
  checkScriptMaintenanceSuppression: (...a: unknown[]) => mockMaintenance(...a),
}));
vi.mock('../sentry', () => ({ captureException: vi.fn() }));
vi.mock('./laneQueries', () => ({
  lockScriptLane: (...a: unknown[]) => mockLock(...a),
  readLaneState: (...a: unknown[]) => mockLane(...a),
  countRecentLaneIntents: (...a: unknown[]) => mockCount(...a),
  countRunLaneIntents: (...a: unknown[]) => mockRunCount(...a),
  readLaneDevice: (...a: unknown[]) => mockDevice(...a),
}));
vi.mock('@breeze/shared', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  scanScriptContent: (...a: unknown[]) => mockScan(...a),
}));

import { evaluateScriptReviewerAutonomy, UNATTENDED_MAX_TIMEOUT_SECONDS } from './scriptReviewerAutonomy';

const PROPOSAL = {
  id: 'prop-1', orgId: 'org-1', status: 'reviewed', contentDigest: 'd'.repeat(64),
  content: 'Restart-Service Spooler', language: 'powershell',
  scannerVersion: '2026-09-11.1', basicHits: [], strictHits: [],
  touchClasses: ['services'],
  timeoutSeconds: 120, targetDeviceIds: ['dev-1'], intentId: null,
  expiresAt: new Date(Date.now() + 3_600_000), supersedesId: null,
};
const REVIEW = {
  id: 'rev-1', proposalId: 'prop-1', reviewerKind: 'model', status: 'completed',
  riskTier: 'low', goalMatch: 'yes', reversible: true, verificationAdequate: true,
  recommendedAction: 'approve', model: 'sonnet-x', reviewerPromptVersion: 'v1',
};
const EFFECTIVE = {
  proposingEnabled: true, unattendedEnabled: true, maxUnattendedRiskTier: 'low',
  unattendedAllowedClasses: ['services', 'processes', 'temp_files', 'dns_cache', 'printing'],
  maxUnattendedPerHour: 10,
  protectedResources: { services: [], paths: [], registryKeys: [], deviceTags: [] },
  reviewerModel: null, source: { partnerRowId: 'p', orgRowId: 'o' },
};
const EMPTY_RESOURCES = { services: [], paths: [], registryKeys: [], deviceTags: [] };
const ACT_SNAPSHOT = {
  kind: 'patch', agentId: 'agent-1',
  effective: { mode: 'act', enabled: true, toolAllowlist: ['run_script'], protectedResources: EMPTY_RESOURCES, limits: { maxActionsPerRun: 3 } },
};
const LIVE_ACT = {
  agentId: 'agent-1', policyEpoch: 12,
  effective: { mode: 'act', enabled: true, toolAllowlist: ['run_script'], protectedResources: EMPTY_RESOURCES, limits: { maxActionsPerRun: 3 } },
};

function draft(over: Record<string, unknown> = {}) {
  return {
    orgId: 'org-1', approvalScope: 'supervised', agentRun: null,
    arguments: { proposalId: 'prop-1', deviceIds: ['dev-1'] },
    ...over,
  };
}
function args(over: Record<string, unknown> = {}) {
  return {
    auth: { scope: 'organization', principal: { kind: 'user' }, user: { id: 'u-1' } } as never,
    intentDraft: draft(),
    proposal: { ...PROPOSAL },
    review: { ...REVIEW },
    ...over,
  } as never;
}
const agentDraft = (over: Record<string, unknown> = {}) =>
  draft({ agentRun: { id: 'run-1', agentId: 'agent-1', policySnapshot: ACT_SNAPSHOT }, ...over });

beforeEach(() => {
  vi.clearAllMocks();
  mockPolicy.mockResolvedValue({ ...EFFECTIVE });
  mockCount.mockResolvedValue(0);
  mockRunCount.mockResolvedValue(0);
  mockLane.mockResolvedValue({ state: 'closed', openedReason: null });
  mockDevice.mockResolvedValue({ id: 'dev-1', status: 'online', osType: 'windows' });
  mockLock.mockResolvedValue(undefined);
  mockToolPermission.mockResolvedValue(null);
  mockAgentGuardrails.mockReturnValue({ allowed: true, disposition: 'allow' });
  mockAgentPolicy.mockResolvedValue(LIVE_ACT);
  mockKillState.mockResolvedValue({ killed: false, epoch: 4 });
  mockMaintenance.mockResolvedValue({ suppressed: false });
  mockScan.mockReturnValue({ touchedNames: { services: ['Spooler'], paths: [], registryKeys: [] } });
});

describe('evaluateScriptReviewerAutonomy — positive control', () => {
  it('POSITIVE CONTROL: grants and returns typed evidence', async () => {
    const res = await evaluateScriptReviewerAutonomy(args());
    expect(res).toMatchObject({ granted: true });
    if (!res.granted) throw new Error('unreachable');
    expect(res.evidence).toMatchObject({
      proposalId: 'prop-1', reviewId: 'rev-1', contentDigest: 'd'.repeat(64),
      scannerVersion: '2026-09-11.1', reviewerModel: 'sonnet-x', reviewerPromptVersion: 'v1',
      touchClasses: ['services'], checkpointRequired: true,
      policySnapshot: { ceiling: 'low', allowedClasses: EFFECTIVE.unattendedAllowedClasses, perHour: 10 },
    });
    expect(res.evidence.agent).toBeUndefined();
    expect(typeof res.evidence.laneReservationAt).toBe('string');
    expect(mockLock).toHaveBeenCalledWith(expect.anything(), 'org-1');
  });
});

describe('evaluateScriptReviewerAutonomy — invariants 1-6', () => {
  it('1 — lane disabled', async () => {
    mockPolicy.mockResolvedValue({ ...EFFECTIVE, unattendedEnabled: false });
    expect(await evaluateScriptReviewerAutonomy(args())).toEqual({ granted: false, reason: 'lane_disabled' });
    expect(mockLock).not.toHaveBeenCalled();
  });

  it.each([
    ['status not reviewed', { status: 'changes_requested' }],
    ['expired', { expiresAt: new Date(Date.now() - 1000) }],
    ['superseded', { status: 'superseded' }],
    ['already consumed', { intentId: 'other-intent' }],
    ['basic hits present', { basicHits: ['curl | bash'] }],
  ])('2 — proposal not runnable (%s)', async (_label, patch) => {
    expect(await evaluateScriptReviewerAutonomy(args({ proposal: { ...PROPOSAL, ...patch } })))
      .toEqual({ granted: false, reason: 'proposal_not_runnable' });
  });

  it.each([
    ['no review at all', null],
    ['review failed', { ...REVIEW, status: 'failed' }],
    ['static scan is not a model review', { ...REVIEW, reviewerKind: 'static_scan' }],
    ['no tier on the review', { ...REVIEW, riskTier: null }],
  ])('3 — review missing (%s)', async (_label, review) => {
    expect(await evaluateScriptReviewerAutonomy(args({ review }))).toEqual({ granted: false, reason: 'review_missing' });
  });

  it('3 — risk above the effective ceiling', async () => {
    expect(await evaluateScriptReviewerAutonomy(args({ review: { ...REVIEW, riskTier: 'medium' } })))
      .toEqual({ granted: false, reason: 'risk_above_ceiling' });
  });

  it('3 — a medium review passes under a medium ceiling', async () => {
    mockPolicy.mockResolvedValue({ ...EFFECTIVE, maxUnattendedRiskTier: 'medium' });
    expect(await evaluateScriptReviewerAutonomy(args({ review: { ...REVIEW, riskTier: 'medium' } })))
      .toMatchObject({ granted: true });
  });

  it.each([
    ['goalMatch partial', { goalMatch: 'partial' }],
    ['not reversible', { reversible: false }],
    ['verification inadequate', { verificationAdequate: false }],
    ['recommends changes', { recommendedAction: 'changes' }],
  ])('4 — verdict not approve (%s)', async (_label, patch) => {
    expect(await evaluateScriptReviewerAutonomy(args({ review: { ...REVIEW, ...patch } })))
      .toEqual({ granted: false, reason: 'verdict_not_approve' });
  });

  it('5 — any STRICT hit refuses', async () => {
    expect(await evaluateScriptReviewerAutonomy(args({ proposal: { ...PROPOSAL, strictHits: ['Invoke-Expression'] } })))
      .toEqual({ granted: false, reason: 'strict_hits' });
  });

  it('6 — an empty class set refuses (a script the classifier cannot place gets a human)', async () => {
    expect(await evaluateScriptReviewerAutonomy(args({ proposal: { ...PROPOSAL, touchClasses: [] } })))
      .toEqual({ granted: false, reason: 'class_not_allowed' });
  });

  it('6 — a class outside the effective allowlist refuses', async () => {
    expect(await evaluateScriptReviewerAutonomy(args({ proposal: { ...PROPOSAL, touchClasses: ['services', 'packages'] } })))
      .toEqual({ granted: false, reason: 'class_not_allowed' });
  });

  it('6 — a hard-denied class refuses even if an operator put it in the allowlist', async () => {
    mockPolicy.mockResolvedValue({ ...EFFECTIVE, unattendedAllowedClasses: ['services', 'credentials'] });
    expect(await evaluateScriptReviewerAutonomy(args({ proposal: { ...PROPOSAL, touchClasses: ['credentials'] } })))
      .toEqual({ granted: false, reason: 'class_hard_denied' });
  });
});

describe('evaluateScriptReviewerAutonomy — invariants 7-10', () => {
  it('7 — a policy-protected service named by the classifier refuses', async () => {
    mockPolicy.mockResolvedValue({
      ...EFFECTIVE,
      protectedResources: { services: ['Spooler'], paths: [], registryKeys: [], deviceTags: [] },
    });
    expect(await evaluateScriptReviewerAutonomy(args())).toEqual({ granted: false, reason: 'protected_resource' });
    expect(mockScan).toHaveBeenCalledWith('Restart-Service Spooler', 'powershell');
  });

  it("7 — the AGENT's own protected resources also apply; the lane never widens an agent envelope", async () => {
    expect(await evaluateScriptReviewerAutonomy(args({
      intentDraft: agentDraft({
        agentRun: {
          id: 'run-1', agentId: 'agent-1',
          policySnapshot: { ...ACT_SNAPSHOT, effective: { ...ACT_SNAPSHOT.effective, protectedResources: { services: ['spooler'], paths: [], registryKeys: [], deviceTags: [] } } },
        },
      }),
    }))).toEqual({ granted: false, reason: 'protected_resource' });
  });

  it('8 — a timeout above 300s refuses', async () => {
    expect(UNATTENDED_MAX_TIMEOUT_SECONDS).toBe(300);
    expect(await evaluateScriptReviewerAutonomy(args({ proposal: { ...PROPOSAL, timeoutSeconds: 301 } })))
      .toEqual({ granted: false, reason: 'timeout_too_long' });
  });

  it('9 — a four_eyes-resolved scope refuses', async () => {
    expect(await evaluateScriptReviewerAutonomy(args({ intentDraft: draft({ approvalScope: 'four_eyes' }) })))
      .toEqual({ granted: false, reason: 'scope_not_supervised' });
  });

  it('10 — more than one target device refuses (D6: canary by construction)', async () => {
    expect(await evaluateScriptReviewerAutonomy(args({
      proposal: { ...PROPOSAL, targetDeviceIds: ['dev-1', 'dev-2'] },
      intentDraft: draft({ arguments: { proposalId: 'prop-1', deviceIds: ['dev-1', 'dev-2'] } }),
    }))).toEqual({ granted: false, reason: 'multi_device' });
  });

  it('10 — one target but two requested devices also refuses', async () => {
    expect(await evaluateScriptReviewerAutonomy(args({
      intentDraft: draft({ arguments: { proposalId: 'prop-1', deviceIds: ['dev-1', 'dev-2'] } }),
    }))).toEqual({ granted: false, reason: 'multi_device' });
  });

  it('10 — a requested device that is not the proposal target refuses', async () => {
    expect(await evaluateScriptReviewerAutonomy(args({
      intentDraft: draft({ arguments: { proposalId: 'prop-1', deviceIds: ['dev-9'] } }),
    }))).toEqual({ granted: false, reason: 'multi_device' });
  });
});

describe('evaluateScriptReviewerAutonomy — invariants 11-12', () => {
  it('11 — a class needing a checkpoint on a NON-Windows device refuses', async () => {
    mockDevice.mockResolvedValue({ id: 'dev-1', status: 'online', osType: 'linux' });
    expect(await evaluateScriptReviewerAutonomy(args())).toEqual({ granted: false, reason: 'checkpoint_unavailable' });
  });

  it('11 — a class that needs NO checkpoint passes on Linux and records checkpointRequired false', async () => {
    mockDevice.mockResolvedValue({ id: 'dev-1', status: 'online', osType: 'linux' });
    const res = await evaluateScriptReviewerAutonomy(args({ proposal: { ...PROPOSAL, touchClasses: ['temp_files'] } }));
    if (!res.granted) throw new Error(`expected a grant, got ${res.reason}`);
    expect(res.evidence.checkpointRequired).toBe(false);
  });

  it('11 — a checkpoint class on Windows records checkpointRequired true', async () => {
    mockPolicy.mockResolvedValue({ ...EFFECTIVE, unattendedAllowedClasses: [...EFFECTIVE.unattendedAllowedClasses, 'registry'] });
    const res = await evaluateScriptReviewerAutonomy(args({ proposal: { ...PROPOSAL, touchClasses: ['registry'] } }));
    if (!res.granted) throw new Error(`expected a grant, got ${res.reason}`);
    expect(res.evidence.checkpointRequired).toBe(true);
  });

  it('12 — an OPEN lane refuses', async () => {
    mockLane.mockResolvedValue({ state: 'open', openedReason: '2 consecutive failed verifications' });
    expect(await evaluateScriptReviewerAutonomy(args())).toEqual({ granted: false, reason: 'lane_open' });
  });

  it('12 — the hourly cap refuses at the cap, not above it', async () => {
    mockCount.mockResolvedValue(10);
    expect(await evaluateScriptReviewerAutonomy(args())).toEqual({ granted: false, reason: 'hourly_cap' });
    mockCount.mockResolvedValue(9);
    expect(await evaluateScriptReviewerAutonomy(args())).toMatchObject({ granted: true });
  });

  it('12 — the advisory lock is taken BEFORE the lane read and the count', async () => {
    const order: string[] = [];
    mockLock.mockImplementation(async () => { order.push('lock'); });
    mockLane.mockImplementation(async () => { order.push('lane'); return { state: 'closed' }; });
    mockCount.mockImplementation(async () => { order.push('count'); return 0; });
    await evaluateScriptReviewerAutonomy(args());
    expect(order).toEqual(['lock', 'lane', 'count']);
  });
});

describe('evaluateScriptReviewerAutonomy — invariant 13 (requester authority)', () => {
  it('chat — the session user must still hold live run_script permission', async () => {
    mockToolPermission.mockResolvedValue('Missing permission scripts:execute');
    expect(await evaluateScriptReviewerAutonomy(args())).toEqual({ granted: false, reason: 'requester_unauthorized' });
  });

  it('chat — checkToolPermission is called with the TOOL name and the intent arguments', async () => {
    await evaluateScriptReviewerAutonomy(args());
    expect(mockToolPermission).toHaveBeenCalledWith('run_script', { proposalId: 'prop-1', deviceIds: ['dev-1'] }, expect.anything());
  });

  it('agent — checkToolPermission is NEVER called (it denies ai_agent principals outright)', async () => {
    const res = await evaluateScriptReviewerAutonomy(args({ intentDraft: agentDraft() }));
    expect(res).toMatchObject({ granted: true });
    expect(mockToolPermission).not.toHaveBeenCalled();
  });

  it('agent — a shadow-mode SNAPSHOT refuses', async () => {
    expect(await evaluateScriptReviewerAutonomy(args({
      intentDraft: agentDraft({ agentRun: { id: 'run-1', agentId: 'agent-1', policySnapshot: { ...ACT_SNAPSHOT, effective: { ...ACT_SNAPSHOT.effective, mode: 'shadow' } } } }),
    }))).toEqual({ granted: false, reason: 'requester_unauthorized' });
    expect(mockAgentPolicy).not.toHaveBeenCalled();
  });

  it('agent — a shadow-mode LIVE policy refuses even when the snapshot said act', async () => {
    mockAgentPolicy.mockResolvedValue({ ...LIVE_ACT, effective: { ...LIVE_ACT.effective, mode: 'shadow' } });
    expect(await evaluateScriptReviewerAutonomy(args({ intentDraft: agentDraft() })))
      .toEqual({ granted: false, reason: 'requester_unauthorized' });
  });

  it('agent — a different live agent identity refuses', async () => {
    mockAgentPolicy.mockResolvedValue({ ...LIVE_ACT, agentId: 'agent-2' });
    expect(await evaluateScriptReviewerAutonomy(args({ intentDraft: agentDraft() })))
      .toEqual({ granted: false, reason: 'requester_unauthorized' });
  });

  it('agent — run_script absent from the live allowlist refuses', async () => {
    mockAgentPolicy.mockResolvedValue({ ...LIVE_ACT, effective: { ...LIVE_ACT.effective, toolAllowlist: ['restart_service'] } });
    expect(await evaluateScriptReviewerAutonomy(args({ intentDraft: agentDraft() })))
      .toEqual({ granted: false, reason: 'requester_unauthorized' });
  });

  it('agent — an engaged kill switch refuses', async () => {
    mockKillState.mockResolvedValue({ killed: true, epoch: 7 });
    expect(await evaluateScriptReviewerAutonomy(args({ intentDraft: agentDraft() })))
      .toEqual({ granted: false, reason: 'requester_unauthorized' });
  });

  it('agent — a structural guardrail denial refuses', async () => {
    mockAgentGuardrails.mockReturnValue({ allowed: false, disposition: 'deny', reason: 'Denied: site out of scope' });
    expect(await evaluateScriptReviewerAutonomy(args({ intentDraft: agentDraft() })))
      .toEqual({ granted: false, reason: 'requester_unauthorized' });
  });

  it('agent — an exhausted per-run action cap refuses', async () => {
    mockRunCount.mockResolvedValue(3);
    expect(await evaluateScriptReviewerAutonomy(args({ intentDraft: agentDraft() })))
      .toEqual({ granted: false, reason: 'requester_unauthorized' });
    expect(mockRunCount).toHaveBeenCalledWith(expect.anything(), 'run-1');
  });

  it('agent — a grant stamps the agent block into the evidence', async () => {
    const res = await evaluateScriptReviewerAutonomy(args({ intentDraft: agentDraft() }));
    if (!res.granted) throw new Error(`expected a grant, got ${res.reason}`);
    expect(res.evidence.agent).toEqual({ agentId: 'agent-1', policyEpoch: 12, killEpoch: 4 });
  });
});

describe('evaluateScriptReviewerAutonomy — invariant 14 (device)', () => {
  it('an offline device refuses', async () => {
    mockDevice.mockResolvedValue({ id: 'dev-1', status: 'offline', osType: 'windows' });
    expect(await evaluateScriptReviewerAutonomy(args())).toEqual({ granted: false, reason: 'device_unavailable' });
  });

  it('a device in another org refuses', async () => {
    mockDevice.mockResolvedValue(null);
    expect(await evaluateScriptReviewerAutonomy(args())).toEqual({ granted: false, reason: 'device_unavailable' });
  });

  it('an OPEN maintenance window refuses — the operator already said "not now"', async () => {
    mockMaintenance.mockResolvedValue({ suppressed: true, reason: 'window_active', message: 'x', windowEndsAt: null });
    expect(await evaluateScriptReviewerAutonomy(args())).toEqual({ granted: false, reason: 'device_unavailable' });
  });

  it('an UNREADABLE maintenance window refuses too (fail-closed, matching scriptDispatch)', async () => {
    mockMaintenance.mockResolvedValue({ suppressed: true, reason: 'check_failed', message: 'x', windowEndsAt: null });
    expect(await evaluateScriptReviewerAutonomy(args())).toEqual({ granted: false, reason: 'device_unavailable' });
  });
});

describe('evaluateScriptReviewerAutonomy — fail-closed', () => {
  it('an exception anywhere in the gate chain denies instead of escaping', async () => {
    mockPolicy.mockRejectedValue(new Error('db is on fire'));
    expect(await evaluateScriptReviewerAutonomy(args())).toEqual({ granted: false, reason: 'lane_disabled' });
  });

  it('an exception under the lock still denies (the caller transaction rolls back nothing here)', async () => {
    mockCount.mockRejectedValue(new Error('count failed'));
    expect(await evaluateScriptReviewerAutonomy(args())).toEqual({ granted: false, reason: 'lane_disabled' });
  });
});
