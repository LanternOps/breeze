import { describe, expect, it, vi } from 'vitest';

let stored: Record<string, unknown> | null = null;
vi.mock('../../db', () => ({
  db: { select: () => ({ from: () => ({ where: () => ({ limit: async () => (stored ? [stored] : []) }) }) }) },
  withSystemDbAccessContext: <T,>(fn: () => Promise<T>) => fn(),
  runOutsideDbContext: <T,>(fn: () => T) => fn(),
}));
import { loadProposalGuardrailContext } from './guardrailContext';

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
