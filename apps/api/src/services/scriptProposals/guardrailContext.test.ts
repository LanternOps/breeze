import { describe, expect, it, vi } from 'vitest';

let stored: Record<string, unknown> | null = null;
vi.mock('../../db', () => ({
  db: { select: () => ({ from: () => ({ where: () => ({ limit: async () => (stored ? [stored] : []) }) }) }) },
  withSystemDbAccessContext: <T,>(fn: () => Promise<T>) => fn(),
  runOutsideDbContext: <T,>(fn: () => T) => fn(),
}));
import {
  loadProposalGuardrailContext, loadProposalGuardrailContextInReach, resolveProposalOrgInReach,
} from './guardrailContext';

describe('loadProposalGuardrailContext', () => {
  it('returns undefined when the input names no proposal — every other tool is unaffected', async () => {
    await expect(loadProposalGuardrailContext({ scriptId: 's1' }, 'org-1')).resolves.toBeUndefined();
  });

  it('returns the persisted risk tier and strict hits for a same-org proposal', async () => {
    stored = { id: 'p1', orgId: 'org-1', status: 'reviewed', riskTier: 'medium', strictHits: ['PowerShell HKLM modification'] };
    await expect(loadProposalGuardrailContext({ proposalId: 'p1' }, 'org-1')).resolves.toEqual({
      proposal: { riskTier: 'medium', strictHits: ['PowerShell HKLM modification'] },
    });
  });

  it('reports proposal_not_found (never a distinguishing signal) for a missing id', async () => {
    stored = null;
    await expect(loadProposalGuardrailContext({ proposalId: 'p1' }, 'org-1')).resolves.toEqual({
      proposalDenyReason: 'proposal_not_found',
    });
  });

  it('reports the SAME proposal_not_found for a cross-org proposal — must not leak cross-tenant existence', async () => {
    stored = { id: 'p1', orgId: 'org-2', status: 'reviewed', riskTier: 'low', strictHits: [] };
    await expect(loadProposalGuardrailContext({ proposalId: 'p1' }, 'org-1')).resolves.toEqual({
      proposalDenyReason: 'proposal_not_found',
    });
  });

  it('reports proposal_review_pending when the proposal is still queued/under review', async () => {
    stored = { id: 'p1', orgId: 'org-1', status: 'proposed', riskTier: null, strictHits: [] };
    await expect(loadProposalGuardrailContext({ proposalId: 'p1' }, 'org-1')).resolves.toEqual({
      proposalDenyReason: 'proposal_review_pending',
    });
  });

  it('reports proposal_review_failed for a scan rejection', async () => {
    stored = { id: 'p1', orgId: 'org-1', status: 'scan_rejected', riskTier: null, strictHits: [] };
    await expect(loadProposalGuardrailContext({ proposalId: 'p1' }, 'org-1')).resolves.toEqual({
      proposalDenyReason: 'proposal_review_failed',
    });
  });

  it('reports proposal_review_failed for a technical review failure', async () => {
    stored = { id: 'p1', orgId: 'org-1', status: 'review_failed', riskTier: null, strictHits: [] };
    await expect(loadProposalGuardrailContext({ proposalId: 'p1' }, 'org-1')).resolves.toEqual({
      proposalDenyReason: 'proposal_review_failed',
    });
  });

  it('reports proposal_not_found (never review_failed) for a proposal superseded before it was ever scanned or reviewed', async () => {
    // supersedeProposal can move 'proposed'/'scan_rejected'/'review_failed' straight
    // to 'superseded' without ever setting riskTier — calling that a "review
    // failure" would be a false diagnosis, since no scan/review verdict happened.
    stored = { id: 'p1', orgId: 'org-1', status: 'superseded', riskTier: null, strictHits: [] };
    await expect(loadProposalGuardrailContext({ proposalId: 'p1' }, 'org-1')).resolves.toEqual({
      proposalDenyReason: 'proposal_not_found',
    });
  });
});

// #10384: a partner-scope chat (a Wisp session under a partner-wide grant, or a
// partner tech's ordinary chat) is bound to ONE org, but propose_script files a
// proposal under the TARGET DEVICE's org. The chat gate resolves the proposal
// within the caller's reach and keys everything after on the proposal's org.
describe('loadProposalGuardrailContextInReach', () => {
  const reach = (...orgIds: string[]) => (orgId: string) => orgIds.includes(orgId);

  it('returns no context and no org when the input names no proposal', async () => {
    await expect(loadProposalGuardrailContextInReach({ scriptId: 's1' }, reach('org-1'))).resolves.toEqual({
      context: undefined, proposalOrgId: null,
    });
  });

  it('resolves a reviewed proposal in ANOTHER org the caller can reach, and names that org', async () => {
    stored = { id: 'p1', orgId: 'org-2', status: 'reviewed', riskTier: 'medium', strictHits: ['hit'] };
    await expect(loadProposalGuardrailContextInReach({ proposalId: 'p1' }, reach('org-1', 'org-2'))).resolves.toEqual({
      context: { proposal: { riskTier: 'medium', strictHits: ['hit'] } },
      proposalOrgId: 'org-2',
    });
  });

  it('keeps the review-state diagnoses for an in-reach proposal', async () => {
    stored = { id: 'p1', orgId: 'org-2', status: 'proposed', riskTier: null, strictHits: [] };
    await expect(loadProposalGuardrailContextInReach({ proposalId: 'p1' }, reach('org-2'))).resolves.toEqual({
      context: { proposalDenyReason: 'proposal_review_pending' },
      proposalOrgId: 'org-2',
    });
  });

  it('answers an out-of-reach proposal exactly like a missing one — no org, proposal_not_found', async () => {
    stored = { id: 'p1', orgId: 'org-3', status: 'reviewed', riskTier: 'low', strictHits: [] };
    const outOfReach = await loadProposalGuardrailContextInReach({ proposalId: 'p1' }, reach('org-1', 'org-2'));
    stored = null;
    const missing = await loadProposalGuardrailContextInReach({ proposalId: 'p1' }, reach('org-1', 'org-2'));
    expect(outOfReach).toEqual({ context: { proposalDenyReason: 'proposal_not_found' }, proposalOrgId: null });
    expect(outOfReach).toEqual(missing);
  });
});

// #10384: the attribution back-fill writes under the org this returns.
describe('resolveProposalOrgInReach', () => {
  const reach = (...orgIds: string[]) => (orgId: string) => orgIds.includes(orgId);

  it("returns the proposal's org when the caller reaches it", async () => {
    stored = { id: 'p1', orgId: 'org-2', status: 'reviewed', riskTier: 'low', strictHits: [] };
    await expect(resolveProposalOrgInReach('p1', reach('org-1', 'org-2'))).resolves.toBe('org-2');
  });

  it('returns null for a proposal outside the reach', async () => {
    stored = { id: 'p1', orgId: 'org-3', status: 'reviewed', riskTier: 'low', strictHits: [] };
    await expect(resolveProposalOrgInReach('p1', reach('org-1', 'org-2'))).resolves.toBeNull();
  });

  it('returns null for a missing proposal', async () => {
    stored = null;
    await expect(resolveProposalOrgInReach('p1', reach('org-1'))).resolves.toBeNull();
  });
});
