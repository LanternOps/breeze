import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  proposal: null as Record<string, unknown> | null,
  ceiling: 'none' as string,
  review: null as Record<string, unknown> | null,
  effective: null as Record<string, unknown> | null,
  lane: null as { state: string; openedReason: string | null } | null,
  laneIntents: 0,
  mcpRuns: 0,
  locks: [] as string[],
}));

vi.mock('../../db', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({ limit: async () => (state.proposal ? [state.proposal] : []) }),
        innerJoin: () => ({ where: () => ({ limit: async () => [{ ceiling: state.ceiling }] }) }),
      }),
    }),
    execute: async () => [],
  },
  runOutsideDbContext: <T,>(fn: () => T) => fn(),
  withSystemDbAccessContext: <T,>(fn: () => T) => fn(),
  withDbAccessContext: <T,>(_ctx: unknown, fn: () => T) => fn(),
  getCurrentDbAccessContext: () => undefined,
}));
vi.mock('./proposals', () => ({
  latestCompletedReview: async () => state.review,
  loadProposalForRelease: vi.fn(),
}));
vi.mock('./policy', () => ({ resolveEffectiveScriptPolicy: async () => state.effective }));
vi.mock('../actionIntents/laneQueries', () => ({
  lockScriptLane: async (_tx: unknown, orgId: string) => { state.locks.push(orgId); },
  readLaneState: async () => state.lane,
  countRecentLaneIntents: async () => state.laneIntents,
  countRecentMcpUnattendedRuns: async () => state.mcpRuns,
  countRunLaneIntents: async () => 0,
  readLaneDevice: async () => null,
}));
vi.mock('../sentry', () => ({ captureException: vi.fn() }));

import { lockMcpUnattendedLane, mcpUnattendedProposalDecision, mcpUnattendedProposalRefusal } from './mcpUnattendedCeiling';

const EMPTY_RESOURCES = { services: [], paths: [], registryKeys: [], deviceTags: [] };
const PROPOSAL = {
  id: 'p1', orgId: 'org-1', status: 'reviewed', riskTier: 'low',
  content: 'Restart-Service Spooler', language: 'powershell',
  basicHits: [], strictHits: [], touchClasses: ['temp_files'],
  timeoutSeconds: 120, targetDeviceIds: ['dev-1'], intentId: null, mcpUnattendedClaimId: null,
  expiresAt: new Date(Date.now() + 3_600_000),
};
const REVIEW = {
  id: 'rev-1', status: 'completed', reviewerKind: 'model', riskTier: 'low',
  goalMatch: 'yes', reversible: true, verificationAdequate: true, recommendedAction: 'approve',
};
const EFFECTIVE = {
  proposingEnabled: true, unattendedEnabled: true, maxUnattendedRiskTier: 'medium',
  unattendedAllowedClasses: ['services', 'processes', 'temp_files'],
  maxUnattendedPerHour: 10,
  protectedResources: EMPTY_RESOURCES,
  source: { partnerRowId: 'p', orgRowId: 'o' },
};

const refusal = (deviceIds: string[] = ['dev-1']) => mcpUnattendedProposalRefusal('p1', 'org-1', deviceIds);

beforeEach(() => {
  state.proposal = { ...PROPOSAL };
  state.review = { ...REVIEW };
  state.effective = { ...EFFECTIVE };
  state.ceiling = 'medium';
  state.lane = { state: 'closed', openedReason: null };
  state.laneIntents = 0;
  state.mcpRuns = 0;
  state.locks = [];
});

describe('mcpUnattendedProposalRefusal', () => {
  it('allows a proposal every lane rule and the MCP ceiling accept', async () => {
    await expect(refusal()).resolves.toBeNull();
  });

  it.each([
    ['missing proposal', () => { state.proposal = null; }, 'not_reviewed'],
    ['no reviewed risk', () => { state.proposal = { ...PROPOSAL, riskTier: null }; }, 'not_reviewed'],
    ['org has not opted in to the lane', () => { state.effective = { ...EFFECTIVE, unattendedEnabled: false }; }, 'lane_disabled'],
    ['not reviewed', () => { state.proposal = { ...PROPOSAL, status: 'proposed' }; }, 'proposal_not_runnable'],
    ['expired', () => { state.proposal = { ...PROPOSAL, expiresAt: new Date(Date.now() - 1000) }; }, 'proposal_not_runnable'],
    ['consumed by an intent', () => { state.proposal = { ...PROPOSAL, intentId: 'intent-1' }; }, 'proposal_not_runnable'],
    ['consumed by an MCP run', () => { state.proposal = { ...PROPOSAL, mcpUnattendedClaimId: 'ledger-1' }; }, 'proposal_not_runnable'],
    ['basic hits', () => { state.proposal = { ...PROPOSAL, basicHits: ['x'] }; }, 'proposal_not_runnable'],
    ['strict hits', () => { state.proposal = { ...PROPOSAL, strictHits: ['x'] }; }, 'strict_hits'],
    ['no completed model review', () => { state.review = null; }, 'review_missing'],
    ['human review', () => { state.review = { ...REVIEW, reviewerKind: 'human' }; }, 'review_missing'],
    ['risk above the lane ceiling', () => { state.effective = { ...EFFECTIVE, maxUnattendedRiskTier: 'low' }; state.review = { ...REVIEW, riskTier: 'medium' }; }, 'risk_above_ceiling'],
    ['review recommends changes', () => { state.review = { ...REVIEW, recommendedAction: 'changes' }; }, 'verdict_not_approve'],
    ['goal only partly matched', () => { state.review = { ...REVIEW, goalMatch: 'partial' }; }, 'verdict_not_approve'],
    ['verification inadequate', () => { state.review = { ...REVIEW, verificationAdequate: false }; }, 'verdict_not_approve'],
    ['irreversible', () => { state.review = { ...REVIEW, reversible: false }; }, 'verdict_not_approve'],
    ['no touch classes', () => { state.proposal = { ...PROPOSAL, touchClasses: [] }; }, 'class_not_allowed'],
    ['class outside the allowlist', () => { state.proposal = { ...PROPOSAL, touchClasses: ['printing'] }; }, 'class_not_allowed'],
    ['services class needs a restore point', () => { state.proposal = { ...PROPOSAL, touchClasses: ['services'] }; }, 'checkpoint_unavailable'],
    ['registry class needs a restore point', () => { state.effective = { ...EFFECTIVE, unattendedAllowedClasses: [...EFFECTIVE.unattendedAllowedClasses, 'registry'] }; state.proposal = { ...PROPOSAL, touchClasses: ['registry'] }; }, 'checkpoint_unavailable'],
    ['files_system class needs a restore point', () => { state.effective = { ...EFFECTIVE, unattendedAllowedClasses: [...EFFECTIVE.unattendedAllowedClasses, 'files_system'] }; state.proposal = { ...PROPOSAL, touchClasses: ['temp_files', 'files_system'] }; }, 'checkpoint_unavailable'],
    ['hard-denied class', () => { state.proposal = { ...PROPOSAL, touchClasses: ['credentials'] }; }, 'class_hard_denied'],
    ['protected service', () => { state.effective = { ...EFFECTIVE, protectedResources: { ...EMPTY_RESOURCES, services: ['Spooler'] } }; }, 'protected_resource'],
    ['timeout over the unattended cap', () => { state.proposal = { ...PROPOSAL, timeoutSeconds: 3600 }; }, 'timeout_too_long'],
    ['MCP ceiling none', () => { state.ceiling = 'none'; }, 'mcp_ceiling'],
    ['risk above the MCP ceiling', () => { state.ceiling = 'low'; state.review = { ...REVIEW, riskTier: 'medium' }; }, 'mcp_ceiling'],
    ['MCP ceiling outside the known values', () => { state.ceiling = 'critical'; }, 'mcp_ceiling'],
    ['several proposal targets', () => { state.proposal = { ...PROPOSAL, targetDeviceIds: ['dev-1', 'dev-2'] }; }, 'multi_device'],
    ['lane circuit open', () => { state.lane = { state: 'open', openedReason: 'failures' }; }, 'lane_open'],
    ['hourly cap reached by lane admissions', () => { state.laneIntents = 10; }, 'hourly_cap'],
    ['hourly cap reached by lane admissions and MCP runs together', () => { state.laneIntents = 6; state.mcpRuns = 4; }, 'hourly_cap'],
  ])('refuses: %s', async (_label, arrange, reason) => {
    arrange();
    await expect(refusal()).resolves.toBe(reason);
  });

  it('refuses a call naming several devices or a device that is not the target', async () => {
    await expect(refusal(['dev-1', 'dev-2'])).resolves.toBe('multi_device');
    await expect(refusal(['dev-2'])).resolves.toBe('multi_device');
    await expect(refusal([])).resolves.toBe('multi_device');
  });

  it('counts a repeated device id once', async () => {
    await expect(refusal(['dev-1', 'dev-1'])).resolves.toBeNull();
  });

  it('returns the ceiling it evaluated, for the audit row', async () => {
    state.ceiling = 'low';
    await expect(mcpUnattendedProposalDecision('p1', 'org-1', ['dev-1'])).resolves.toEqual({ refusal: null, ceiling: 'low' });
    state.effective = { ...EFFECTIVE, unattendedEnabled: false };
    await expect(mcpUnattendedProposalDecision('p1', 'org-1', ['dev-1'])).resolves.toEqual({ refusal: 'lane_disabled', ceiling: null });
  });

  it('one below the hourly cap is allowed', async () => {
    state.laneIntents = 5;
    state.mcpRuns = 4;
    await expect(refusal()).resolves.toBeNull();
  });
});

describe('lockMcpUnattendedLane', () => {
  it('takes the lane lock for the org and re-runs the whole gate', async () => {
    await expect(lockMcpUnattendedLane('p1', 'org-1', ['dev-1'])).resolves.toBeNull();
    expect(state.locks).toEqual(['org-1']);
  });

  it.each([
    ['lane switched off since the early check', () => { state.effective = { ...EFFECTIVE, unattendedEnabled: false }; }, 'lane_disabled'],
    ['circuit opened since the early check', () => { state.lane = { state: 'open', openedReason: 'failures' }; }, 'lane_open'],
    ['hourly cap reached since the early check', () => { state.mcpRuns = 10; }, 'hourly_cap'],
    ['class removed from the allowlist since the early check', () => { state.effective = { ...EFFECTIVE, unattendedAllowedClasses: ['processes'] }; }, 'class_not_allowed'],
    ['service protected since the early check', () => { state.effective = { ...EFFECTIVE, protectedResources: { ...EMPTY_RESOURCES, services: ['Spooler'] } }; }, 'protected_resource'],
    ['lane ceiling lowered since the early check', () => { state.effective = { ...EFFECTIVE, maxUnattendedRiskTier: 'low' }; state.review = { ...REVIEW, riskTier: 'medium' }; }, 'risk_above_ceiling'],
    ['MCP ceiling lowered since the early check', () => { state.ceiling = 'none'; }, 'mcp_ceiling'],
    ['claimed by another MCP run since the early check', () => { state.proposal = { ...PROPOSAL, mcpUnattendedClaimId: 'ledger-2' }; }, 'proposal_not_runnable'],
    ['a newer review recommends changes', () => { state.review = { ...REVIEW, recommendedAction: 'changes' }; }, 'verdict_not_approve'],
  ])('refuses under the lock: %s', async (_label, arrange, reason) => {
    arrange();
    await expect(lockMcpUnattendedLane('p1', 'org-1', ['dev-1'])).resolves.toBe(reason);
    expect(state.locks).toEqual(['org-1']);
  });
});
