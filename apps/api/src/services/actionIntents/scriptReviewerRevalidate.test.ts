import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockPolicy = vi.fn();
const mockLane = vi.fn();
const mockDevice = vi.fn();
const mockAgentPolicy = vi.fn();
const mockKillState = vi.fn();
const mockAgentGuardrails = vi.fn();
const mockMaintenance = vi.fn();
const mockLoadProposal = vi.fn();
const mockLatestReview = vi.fn();
const mockRunCount = vi.fn();
const mockScan = vi.fn();
const runRows: unknown[] = [];

vi.mock('../../db', () => ({
  db: {
    select: () => ({ from: () => ({ where: () => ({ limit: async () => runRows }) }) }),
    execute: vi.fn(),
  },
  runOutsideDbContext: async (fn: () => unknown) => fn(),
  withSystemDbAccessContext: async (fn: () => unknown) => fn(),
  withDbAccessContext: async (_ctx: unknown, fn: () => unknown) => fn(),
  getCurrentDbAccessContext: () => undefined,
}));
vi.mock('../scriptProposals/policy', () => ({ resolveEffectiveScriptPolicy: (...a: unknown[]) => mockPolicy(...a) }));
vi.mock('../scriptProposals/proposals', () => ({
  loadProposalForRelease: (...a: unknown[]) => mockLoadProposal(...a),
  latestCompletedReview: (...a: unknown[]) => mockLatestReview(...a),
}));
vi.mock('../aiGuardrails', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  checkToolPermission: vi.fn(),
  checkAgentGuardrails: (...a: unknown[]) => mockAgentGuardrails(...a),
}));
vi.mock('../aiAgents/effectivePolicy', () => ({ resolveEffectiveAgentSystem: (...a: unknown[]) => mockAgentPolicy(...a) }));
vi.mock('../aiKillState', () => ({ readAiKillState: (...a: unknown[]) => mockKillState(...a) }));
vi.mock('../scriptMaintenanceGate', () => ({ checkScriptMaintenanceSuppression: (...a: unknown[]) => mockMaintenance(...a) }));
vi.mock('../sentry', () => ({ captureException: vi.fn() }));
vi.mock('./laneQueries', () => ({
  lockScriptLane: vi.fn(),
  readLaneState: (...a: unknown[]) => mockLane(...a),
  countRecentLaneIntents: vi.fn(),
  countRunLaneIntents: (...a: unknown[]) => mockRunCount(...a),
  readLaneDevice: (...a: unknown[]) => mockDevice(...a),
}));
vi.mock('@breeze/shared', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  scanScriptContent: (...a: unknown[]) => mockScan(...a),
}));

import { revalidateScriptReviewerEvidence } from './scriptReviewerAutonomy';

const EMPTY_RESOURCES = { services: [], paths: [], registryKeys: [], deviceTags: [] };
const PROPOSAL = {
  id: 'prop-1', orgId: 'org-1', status: 'reviewed', contentDigest: 'd'.repeat(64),
  content: 'Restart-Service Spooler', language: 'powershell',
  scannerVersion: '2026-09-11.1', basicHits: [], strictHits: [], touchClasses: ['services'],
  timeoutSeconds: 120, targetDeviceIds: ['dev-1'], intentId: 'int-1',
  expiresAt: new Date(Date.now() + 3_600_000),
};
const REVIEW = {
  id: 'rev-1', proposalId: 'prop-1', reviewerKind: 'model', status: 'completed',
  riskTier: 'low', goalMatch: 'yes', reversible: true, verificationAdequate: true,
  recommendedAction: 'approve', model: 'sonnet-x', reviewerPromptVersion: 'v1',
};
const EFFECTIVE = {
  proposingEnabled: true, unattendedEnabled: true, maxUnattendedRiskTier: 'low',
  unattendedAllowedClasses: ['services', 'processes', 'temp_files', 'dns_cache', 'printing'],
  maxUnattendedPerHour: 10, protectedResources: EMPTY_RESOURCES,
  reviewerModel: null, source: { partnerRowId: 'p', orgRowId: 'o' },
};
const EVIDENCE = {
  proposalId: 'prop-1', reviewId: 'rev-1', contentDigest: 'd'.repeat(64),
  scannerVersion: '2026-09-11.1', reviewerModel: 'sonnet-x', reviewerPromptVersion: 'v1',
  touchClasses: ['services'],
  policySnapshot: { ceiling: 'low', allowedClasses: EFFECTIVE.unattendedAllowedClasses, perHour: 10 },
  laneReservationAt: new Date().toISOString(), checkpointRequired: true,
};
const INTENT = {
  id: 'int-1', orgId: 'org-1', decidedVia: 'script_reviewer', scriptReviewerEvidence: EVIDENCE,
  arguments: { proposalId: 'prop-1', deviceIds: ['dev-1'] }, requestingAgentRunId: null,
  approvalScope: 'supervised',
} as never;
const AGENT_INTENT = {
  ...(INTENT as object),
  requestingAgentRunId: 'run-1',
  scriptReviewerEvidence: { ...EVIDENCE, agent: { agentId: 'agent-1', policyEpoch: 1, killEpoch: 0 } },
} as never;
const LIVE_ACT = {
  agentId: 'agent-1', policyEpoch: 12,
  effective: { mode: 'act', enabled: true, toolAllowlist: ['run_script'], protectedResources: EMPTY_RESOURCES, limits: { maxActionsPerRun: 3 } },
};

beforeEach(() => {
  vi.clearAllMocks();
  mockPolicy.mockResolvedValue({ ...EFFECTIVE });
  mockLane.mockResolvedValue({ state: 'closed', openedReason: null });
  mockDevice.mockResolvedValue({ id: 'dev-1', status: 'online', osType: 'windows' });
  mockAgentPolicy.mockResolvedValue(LIVE_ACT);
  mockKillState.mockResolvedValue({ killed: false, epoch: 0 });
  mockAgentGuardrails.mockReturnValue({ allowed: true, disposition: 'allow' });
  mockMaintenance.mockResolvedValue({ suppressed: false });
  mockLoadProposal.mockResolvedValue({ ...PROPOSAL });
  mockLatestReview.mockResolvedValue({ ...REVIEW });
  mockRunCount.mockResolvedValue(0);
  mockScan.mockReturnValue({ touchedNames: { services: ['Spooler'], paths: [], registryKeys: [] } });
  runRows.length = 0;
  runRows.push({ policySnapshot: { kind: 'patch', agentId: 'agent-1', effective: { ...LIVE_ACT.effective } } });
});

describe('revalidateScriptReviewerEvidence', () => {
  it('POSITIVE CONTROL: unchanged state revalidates (chat origin)', async () => {
    await expect(revalidateScriptReviewerEvidence(INTENT)).resolves.toEqual({ ok: true });
    expect(mockLoadProposal).toHaveBeenCalledWith(expect.anything(), 'prop-1', 'org-1');
  });

  it('POSITIVE CONTROL: unchanged state revalidates (agent origin)', async () => {
    await expect(revalidateScriptReviewerEvidence(AGENT_INTENT)).resolves.toEqual({ ok: true });
    expect(mockAgentPolicy).toHaveBeenCalledWith('org-1', 'patch');
  });

  it('the ORG GRANT was revoked', async () => {
    mockPolicy.mockResolvedValue({ ...EFFECTIVE, unattendedEnabled: false });
    await expect(revalidateScriptReviewerEvidence(INTENT)).resolves.toEqual({ ok: false, reason: 'lane_disabled' });
  });

  it('the PARTNER CEILING was lowered below the review tier', async () => {
    mockLatestReview.mockResolvedValue({ ...REVIEW, riskTier: 'medium' });
    mockPolicy.mockResolvedValue({ ...EFFECTIVE, maxUnattendedRiskTier: 'low' });
    await expect(revalidateScriptReviewerEvidence(INTENT)).resolves.toEqual({ ok: false, reason: 'risk_above_ceiling' });
  });

  it('a class was removed from the allowlist', async () => {
    mockPolicy.mockResolvedValue({ ...EFFECTIVE, unattendedAllowedClasses: ['printing'] });
    await expect(revalidateScriptReviewerEvidence(INTENT)).resolves.toEqual({ ok: false, reason: 'class_not_allowed' });
  });

  it('a protected resource was added that the script touches', async () => {
    mockPolicy.mockResolvedValue({ ...EFFECTIVE, protectedResources: { ...EMPTY_RESOURCES, services: ['Spooler'] } });
    await expect(revalidateScriptReviewerEvidence(INTENT)).resolves.toEqual({ ok: false, reason: 'protected_resource' });
  });

  it('the agent was demoted act -> shadow', async () => {
    mockAgentPolicy.mockResolvedValue({ ...LIVE_ACT, effective: { ...LIVE_ACT.effective, mode: 'shadow' } });
    await expect(revalidateScriptReviewerEvidence(AGENT_INTENT)).resolves.toEqual({ ok: false, reason: 'requester_unauthorized' });
  });

  it('the kill switch was engaged', async () => {
    mockKillState.mockResolvedValue({ killed: true, epoch: 9 });
    await expect(revalidateScriptReviewerEvidence(AGENT_INTENT)).resolves.toEqual({ ok: false, reason: 'requester_unauthorized' });
  });

  it('an agent-origin row whose evidence has no agent block is refused as forged', async () => {
    await expect(revalidateScriptReviewerEvidence({ ...(INTENT as object), requestingAgentRunId: 'run-1' } as never))
      .resolves.toEqual({ ok: false, reason: 'requester_unauthorized' });
  });

  it('the lane circuit opened after approval', async () => {
    mockLane.mockResolvedValue({ state: 'open', openedReason: 'two failed verifications' });
    await expect(revalidateScriptReviewerEvidence(INTENT)).resolves.toEqual({ ok: false, reason: 'lane_open' });
  });

  it('the review was SUPERSEDED — a newer completed review exists', async () => {
    mockLatestReview.mockResolvedValue({ ...REVIEW, id: 'rev-2' });
    await expect(revalidateScriptReviewerEvidence(INTENT)).resolves.toEqual({ ok: false, reason: 'review_missing' });
  });

  it('the proposal is no longer runnable (superseded)', async () => {
    mockLoadProposal.mockResolvedValue({ ...PROPOSAL, status: 'superseded' });
    await expect(revalidateScriptReviewerEvidence(INTENT)).resolves.toEqual({ ok: false, reason: 'proposal_not_runnable' });
  });

  it('the proposal was claimed by a DIFFERENT intent', async () => {
    mockLoadProposal.mockResolvedValue({ ...PROPOSAL, intentId: 'int-other' });
    await expect(revalidateScriptReviewerEvidence(INTENT)).resolves.toEqual({ ok: false, reason: 'proposal_not_runnable' });
  });

  it('the content digest in the evidence no longer matches the proposal', async () => {
    mockLoadProposal.mockResolvedValue({ ...PROPOSAL, contentDigest: 'e'.repeat(64) });
    await expect(revalidateScriptReviewerEvidence(INTENT)).resolves.toEqual({ ok: false, reason: 'proposal_not_runnable' });
  });

  it('the device went offline', async () => {
    mockDevice.mockResolvedValue({ id: 'dev-1', status: 'offline', osType: 'windows' });
    await expect(revalidateScriptReviewerEvidence(INTENT)).resolves.toEqual({ ok: false, reason: 'device_unavailable' });
  });

  it('a maintenance window opened', async () => {
    mockMaintenance.mockResolvedValue({ suppressed: true, reason: 'window_active' });
    await expect(revalidateScriptReviewerEvidence(INTENT)).resolves.toEqual({ ok: false, reason: 'device_unavailable' });
  });

  it('a missing or malformed evidence blob revalidates as FALSE, never as absent-therefore-fine', async () => {
    await expect(revalidateScriptReviewerEvidence({ ...(INTENT as object), scriptReviewerEvidence: null } as never))
      .resolves.toEqual({ ok: false, reason: 'lane_disabled' });
    await expect(revalidateScriptReviewerEvidence({ ...(INTENT as object), scriptReviewerEvidence: { proposalId: 'prop-1' } } as never))
      .resolves.toEqual({ ok: false, reason: 'lane_disabled' });
  });

  it('a thrown read revokes (fail-closed)', async () => {
    mockLoadProposal.mockRejectedValue(new Error('db gone'));
    await expect(revalidateScriptReviewerEvidence(INTENT)).resolves.toEqual({ ok: false, reason: 'lane_disabled' });
  });
});
