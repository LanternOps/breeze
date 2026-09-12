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
const loadLatestReview = vi.fn(async () => null);
vi.mock('./queries', () => ({
  loadProposalRow: (...a: unknown[]) => loadProposalRow(...a),
  loadProposalRequesterUserId: (...a: unknown[]) => loadProposalRequesterUserId(...a),
  loadLatestReview: (...a: unknown[]) => loadLatestReview(...a),
  loadProposalExecutions: vi.fn(async () => []),
  loadProposalDevices: vi.fn(async () => []),
}));

import { loadScriptProposalDetail } from './detail';

const ORG = '11111111-1111-4111-8111-111111111111';
const REQUESTER = '22222222-2222-4222-8222-222222222222';
const STRANGER = '33333333-3333-4333-8333-333333333333';
const PROPOSAL = '44444444-4444-4444-8444-444444444444';

const auth = (userId: string, mfa = true) => ({
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
    expect(reviewed.ok && reviewed.dto.viewer).toEqual({ canDecide: true, canAcknowledge: true, canPromote: false });

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
});
