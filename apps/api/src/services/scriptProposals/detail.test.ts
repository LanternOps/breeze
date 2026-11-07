import { describe, expect, it, vi, beforeEach } from 'vitest';

const getUserPermissions = vi.fn();
const canAccessOrg = vi.fn();
const userCanDecideApprovals = vi.fn();
const hasPermission = vi.fn();
vi.mock('../permissions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../permissions')>()),
  getUserPermissions: (...a: unknown[]) => getUserPermissions(...a),
  canAccessOrg: (...a: unknown[]) => canAccessOrg(...a),
  userCanDecideApprovals: (...a: unknown[]) => userCanDecideApprovals(...a),
  hasPermission: (...a: unknown[]) => hasPermission(...a),
}));
vi.mock('../../db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../db')>()),
  runOutsideDbContext: (fn: () => unknown) => fn(),
  withSystemDbAccessContext: (fn: () => unknown) => fn(),
}));

const loadProposalRow = vi.fn();
const loadProposalRequesterUserId = vi.fn();
const loadLatestReview = vi.fn<(...a: unknown[]) => Promise<unknown>>(async () => null);
const loadProposalExecutions = vi.fn<(...a: unknown[]) => Promise<unknown[]>>(async () => []);
const loadProposalDevices = vi.fn<(...a: unknown[]) => Promise<unknown[]>>(async () => []);
vi.mock('./queries', () => ({
  loadProposalRow: (...a: unknown[]) => loadProposalRow(...a),
  loadProposalRequesterUserId: (...a: unknown[]) => loadProposalRequesterUserId(...a),
  loadLatestReview: (...a: unknown[]) => loadLatestReview(...a),
  loadProposalExecutions: (...a: unknown[]) => loadProposalExecutions(...a),
  loadProposalDevices: (...a: unknown[]) => loadProposalDevices(...a),
}));

const scopeDeviceIdsToCaller = vi.fn<(...a: unknown[]) => Promise<string[] | null>>(async () => null);
vi.mock('../aiToolsSiteScope', () => ({
  scopeDeviceIdsToCaller: (...a: unknown[]) => scopeDeviceIdsToCaller(...a),
}));

import { loadScriptProposalDetail } from './detail';

const ORG = '11111111-1111-4111-8111-111111111111';
const REQUESTER = '22222222-2222-4222-8222-222222222222';
const STRANGER = '33333333-3333-4333-8333-333333333333';
const PROPOSAL = '44444444-4444-4444-8444-444444444444';

const auth = (userId: string, mfa = true, principal: Record<string, unknown> = { kind: 'user_session' }) => ({
  principal,
  user: { id: userId }, scope: 'organization', orgId: ORG, partnerId: null,
  accessibleOrgIds: [ORG], token: { mfa },
}) as never;

const baseRow = () => ({
  id: PROPOSAL, orgId: ORG, status: 'reviewed', language: 'powershell',
  content: 'Restart-Service spooler', contentDigest: 'a'.repeat(64), goal: 'g', expectedEffect: 'e',
  rollbackNote: null, verification: { kind: 'exit_code', equals: 0 }, runAs: 'system', timeoutSeconds: 300,
  strictHits: [], basicHits: [], touchClasses: ['services'], riskTier: 'medium', revision: 1,
  targetDeviceIds: [], acknowledgedPatterns: [], intentId: null, sessionId: null,
  verifiedAt: null, verificationResult: null, promotedScriptId: null,
  createdAt: new Date('2026-09-11T10:00:00Z'), expiresAt: new Date('2026-09-12T10:00:00Z'),
});

beforeEach(() => {
  vi.clearAllMocks();
  loadProposalRow.mockResolvedValue(baseRow());
  loadProposalRequesterUserId.mockResolvedValue(REQUESTER);
  getUserPermissions.mockResolvedValue({});
  hasPermission.mockReturnValue(false);
  loadProposalExecutions.mockResolvedValue([]);
  loadProposalDevices.mockResolvedValue([]);
  scopeDeviceIdsToCaller.mockResolvedValue(null);
});

// #10954: who may sign a proposal whose AI review reached no verdict.
describe('loadScriptProposalDetail — review failure and the human override', () => {
  const DEVICE = '55555555-5555-4555-8555-555555555551';
  const failedRow = (over: Record<string, unknown> = {}) => ({
    ...baseRow(), status: 'review_failed', riskTier: null, decidedBy: null,
    decisionNote: 'Reviewer returned no parseable JSON verdict', targetDeviceIds: [DEVICE],
    expiresAt: new Date(Date.now() + 3_600_000), ...over,
  });
  const failedReview = { id: 'r1', reviewerKind: 'model', status: 'failed', summary: 'Reviewer returned no parseable', verdict: { error: 'x' }, createdAt: new Date() };
  const grant = (...held: string[]) => hasPermission.mockImplementation((_p: unknown, resource: string, action: string) => held.includes(`${resource}:${action}`));
  const viewerOf = async (a: never) => {
    const r = await loadScriptProposalDetail(a, PROPOSAL);
    if (!r.ok) throw new Error(`denied: ${r.reason}`);
    return r.dto.viewer;
  };

  beforeEach(() => {
    canAccessOrg.mockReturnValue(true);
    userCanDecideApprovals.mockReturnValue(true);
    loadProposalRow.mockResolvedValue(failedRow());
    loadLatestReview.mockResolvedValue(failedReview);
    grant('scripts:execute', 'scripts:write');
  });

  it('offers both overrides to a human with run, write and decide permission and MFA', async () => {
    expect(await viewerOf(auth(STRANGER))).toMatchObject({ canOverrideRun: true, canOverrideSave: true, canPromote: false });
  });

  it('run needs approvals:decide; save does not', async () => {
    userCanDecideApprovals.mockReturnValue(false);
    expect(await viewerOf(auth(REQUESTER))).toMatchObject({ canOverrideRun: false, canOverrideSave: true });
  });

  it('neither is offered without scripts:execute, in the proposal org', async () => {
    grant('scripts:write');
    expect(await viewerOf(auth(STRANGER))).toMatchObject({ canOverrideRun: false, canOverrideSave: false });
    expect(getUserPermissions).toHaveBeenCalledWith(STRANGER, expect.objectContaining({ orgId: ORG }));
  });

  it('save needs scripts:write; run does not', async () => {
    grant('scripts:execute');
    expect(await viewerOf(auth(STRANGER))).toMatchObject({ canOverrideRun: true, canOverrideSave: false });
  });

  it('neither is offered without MFA', async () => {
    expect(await viewerOf(auth(STRANGER, false))).toMatchObject({ canOverrideRun: false, canOverrideSave: false });
  });

  it.each([
    [{ kind: 'api_key', apiKeyId: 'k1' }],
    [{ kind: 'oauth_grant', grantId: 'g1' }],
    [{ kind: 'ai_agent', agentId: 'a1', runId: 'r1' }],
    [{ kind: 'flow', flowId: 'f1', runId: 'r1' }],
  ])('neither is offered to the non-human principal %j', async (principal) => {
    expect(await viewerOf(auth(STRANGER, true, principal))).toMatchObject({ canOverrideRun: false, canOverrideSave: false });
  });

  it('run is not offered when a target is outside the caller\'s scope; save still is', async () => {
    loadProposalRow.mockResolvedValue(failedRow({ targetDeviceIds: [DEVICE, '55555555-5555-4555-8555-555555555552'] }));
    scopeDeviceIdsToCaller.mockResolvedValue([DEVICE]);
    expect(await viewerOf(auth(STRANGER))).toMatchObject({ canOverrideRun: false, canOverrideSave: true });
  });

  it('run is not offered once the proposal has expired; save still is', async () => {
    loadProposalRow.mockResolvedValue(failedRow({ expiresAt: new Date(Date.now() - 1000) }));
    expect(await viewerOf(auth(STRANGER))).toMatchObject({ canOverrideRun: false, canOverrideSave: true });
  });

  it.each([
    'proposed', 'scan_rejected', 'reviewed', 'approved', 'rejected', 'changes_requested',
    'expired', 'superseded', 'executed', 'verified', 'verification_failed', 'promoted',
  ])('neither is offered on a proposal in `%s`', async (status) => {
    loadProposalRow.mockResolvedValue(failedRow({ status }));
    expect(await viewerOf(auth(STRANGER))).toMatchObject({ canOverrideRun: false, canOverrideSave: false });
  });

  it('reports the whole failure reason from decision_note while the proposal is review_failed', async () => {
    const r = await loadScriptProposalDetail(auth(STRANGER), PROPOSAL);
    expect(r.ok && r.dto.reviewFailure).toEqual({ reason: 'Reviewer returned no parseable JSON verdict', humanApproved: false });
  });

  it('falls back to the review row when no note was written', async () => {
    loadProposalRow.mockResolvedValue(failedRow({ decisionNote: null }));
    const r = await loadScriptProposalDetail(auth(STRANGER), PROPOSAL);
    expect(r.ok && r.dto.reviewFailure).toEqual({ reason: failedReview.summary, humanApproved: false });
  });

  it('still reports the failure after a person signed it, and that they did', async () => {
    loadProposalRow.mockResolvedValue(failedRow({ status: 'executed', decidedBy: STRANGER, decisionNote: 'Approved by a person…' }));
    const r = await loadScriptProposalDetail(auth(STRANGER), PROPOSAL);
    expect(r.ok && r.dto.reviewFailure).toEqual({ reason: failedReview.summary, humanApproved: true });
  });

  it('is null for a proposal whose review completed', async () => {
    loadProposalRow.mockResolvedValue(failedRow({ status: 'reviewed', riskTier: 'low' }));
    loadLatestReview.mockResolvedValue({ ...failedReview, status: 'completed', summary: 'fine' });
    const r = await loadScriptProposalDetail(auth(STRANGER), PROPOSAL);
    expect(r.ok && r.dto.reviewFailure).toBeNull();
  });

  it('is null for a proposal that only has a static-scan row', async () => {
    loadProposalRow.mockResolvedValue(failedRow({ status: 'scan_rejected', decisionNote: null }));
    loadLatestReview.mockResolvedValue({ ...failedReview, reviewerKind: 'static_scan', status: 'failed' });
    const r = await loadScriptProposalDetail(auth(STRANGER), PROPOSAL);
    expect(r.ok && r.dto.reviewFailure).toBeNull();
  });
});

describe('loadScriptProposalDetail', () => {
  it('lets the requester read their own proposal without approvals:decide', async () => {
    userCanDecideApprovals.mockReturnValue(false);
    canAccessOrg.mockReturnValue(true);
    const r = await loadScriptProposalDetail(auth(REQUESTER), PROPOSAL);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.dto.viewer.canDecide).toBe(false);
      expect(r.dto.proposal.createdAt).toBe('2026-09-11T10:00:00.000Z');
    }
  });

  it('lets a live approvals:decide holder with org access read it', async () => {
    userCanDecideApprovals.mockReturnValue(true);
    canAccessOrg.mockReturnValue(true);
    const r = await loadScriptProposalDetail(auth(STRANGER), PROPOSAL);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.dto.viewer.canDecide).toBe(true);
  });

  it('denies a stranger who holds neither', async () => {
    userCanDecideApprovals.mockReturnValue(false);
    canAccessOrg.mockReturnValue(true);
    expect(await loadScriptProposalDetail(auth(STRANGER), PROPOSAL)).toEqual({ ok: false, reason: 'forbidden' });
  });

  it('denies a decide-holder who has LOST org access since fan-out', async () => {
    userCanDecideApprovals.mockReturnValue(true);
    canAccessOrg.mockReturnValue(false);
    expect(await loadScriptProposalDetail(auth(STRANGER), PROPOSAL)).toEqual({ ok: false, reason: 'forbidden' });
  });

  it('denies the requester when they can no longer reach the org', async () => {
    userCanDecideApprovals.mockReturnValue(false);
    canAccessOrg.mockReturnValue(false);
    expect(await loadScriptProposalDetail(auth(REQUESTER), PROPOSAL)).toEqual({ ok: false, reason: 'forbidden' });
  });

  it('reports not_found for a missing proposal without leaking existence', async () => {
    loadProposalRow.mockResolvedValue(null);
    expect(await loadScriptProposalDetail(auth(REQUESTER), PROPOSAL)).toEqual({ ok: false, reason: 'not_found' });
  });

  it('derives canAcknowledge from scripts:write + MFA and canPromote only on verified', async () => {
    userCanDecideApprovals.mockReturnValue(true);
    canAccessOrg.mockReturnValue(true);
    hasPermission.mockReturnValue(true);
    const reviewed = await loadScriptProposalDetail(auth(STRANGER, true), PROPOSAL);
    expect(reviewed.ok && reviewed.dto.viewer).toEqual({
      canDecide: true, canAcknowledge: true, canPromote: false, canOverrideRun: false, canOverrideSave: false,
    });

    const noMfa = await loadScriptProposalDetail(auth(STRANGER, false), PROPOSAL);
    expect(noMfa.ok && noMfa.dto.viewer.canAcknowledge).toBe(false);

    loadProposalRow.mockResolvedValue({ ...baseRow(), status: 'verified' });
    const verified = await loadScriptProposalDetail(auth(STRANGER, true), PROPOSAL);
    expect(verified.ok && verified.dto.viewer.canPromote).toBe(true);
    expect(verified.ok && verified.dto.verification.outcome).toBe('verified');
  });

  it('projects the latest review verdict findings and blast radius', async () => {
    userCanDecideApprovals.mockReturnValue(true);
    canAccessOrg.mockReturnValue(true);
    loadLatestReview.mockResolvedValue({
      id: 'r1', summary: 's', riskTier: 'high', goalMatch: 'yes', reversible: true, verificationAdequate: true,
      recommendedAction: 'approve', model: 'm', createdAt: new Date('2026-09-11T11:00:00Z'),
      verdict: { findings: [{ severity: 'warning', text: 'x' }], blastRadius: ['spooler'] },
    } as never);
    const r = await loadScriptProposalDetail(auth(STRANGER), PROPOSAL);
    expect(r.ok && r.dto.review).toMatchObject({
      id: 'r1', findings: [{ severity: 'warning', text: 'x' }], blastRadius: ['spooler'], createdAt: '2026-09-11T11:00:00.000Z',
    });
  });

  it('distinguishes a genuine verification failure from a final unknown (status is the same)', async () => {
    userCanDecideApprovals.mockReturnValue(true);
    canAccessOrg.mockReturnValue(true);
    loadProposalRow.mockResolvedValue({ ...baseRow(), status: 'verification_failed', verificationResult: { outcome: 'verification_failed', attempts: 1, detail: 'exit 3' } });
    const failed = await loadScriptProposalDetail(auth(STRANGER), PROPOSAL);
    expect(failed.ok && failed.dto.verification).toMatchObject({ outcome: 'verification_failed', attempts: 1, detail: 'exit 3' });

    loadProposalRow.mockResolvedValue({ ...baseRow(), status: 'verification_failed', verificationResult: { outcome: 'unknown', attempts: 3, detail: 'no response' } });
    const unknown = await loadScriptProposalDetail(auth(STRANGER), PROPOSAL);
    expect(unknown.ok && unknown.dto.verification).toMatchObject({ outcome: 'unknown', attempts: 3 });
    expect(unknown.ok && unknown.dto.viewer.canPromote).toBe(false);
  });

  it('denies a decide-holder whose site ceiling excludes every target device', async () => {
    userCanDecideApprovals.mockReturnValue(true);
    canAccessOrg.mockReturnValue(true);
    loadProposalRow.mockResolvedValue({ ...baseRow(), targetDeviceIds: ['dev-1', 'dev-2'] });
    scopeDeviceIdsToCaller.mockResolvedValue([]); // site-restricted, no overlap
    expect(await loadScriptProposalDetail(auth(STRANGER), PROPOSAL)).toEqual({ ok: false, reason: 'forbidden' });
    expect(scopeDeviceIdsToCaller).toHaveBeenCalledWith(auth(STRANGER), ORG, ['dev-1', 'dev-2']);
  });

  it('narrows the device and execution lists to the caller site-visible subset', async () => {
    userCanDecideApprovals.mockReturnValue(true);
    canAccessOrg.mockReturnValue(true);
    loadProposalRow.mockResolvedValue({ ...baseRow(), targetDeviceIds: ['dev-1', 'dev-2'] });
    scopeDeviceIdsToCaller.mockResolvedValue(['dev-1']); // site-restricted, only dev-1 visible
    loadProposalDevices.mockResolvedValue([
      { id: 'dev-1', hostname: 'h1', osType: 'windows', status: 'online' },
    ] as never);
    loadProposalExecutions.mockResolvedValue([
      { id: 'e1', deviceId: 'dev-1', status: 'success', exitCode: 0, startedAt: null, completedAt: null, hostname: 'h1' },
      { id: 'e2', deviceId: 'dev-2', status: 'success', exitCode: 0, startedAt: null, completedAt: null, hostname: 'h2' },
    ] as never);
    const r = await loadScriptProposalDetail(auth(STRANGER), PROPOSAL);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.dto.devices.map((d) => d.id)).toEqual(['dev-1']);
    expect(r.dto.executions.map((e) => e.id)).toEqual(['e1']);
    expect(loadProposalDevices).toHaveBeenCalledWith(['dev-1']);
  });

  it('does not narrow for an unrestricted caller (null = no site/device ceiling)', async () => {
    userCanDecideApprovals.mockReturnValue(true);
    canAccessOrg.mockReturnValue(true);
    loadProposalRow.mockResolvedValue({ ...baseRow(), targetDeviceIds: ['dev-1', 'dev-2'] });
    scopeDeviceIdsToCaller.mockResolvedValue(null);
    const r = await loadScriptProposalDetail(auth(STRANGER), PROPOSAL);
    expect(r.ok).toBe(true);
    expect(loadProposalDevices).toHaveBeenCalledWith(['dev-1', 'dev-2']);
  });
});
