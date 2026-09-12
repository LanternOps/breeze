import { describe, expect, it, vi, beforeEach } from 'vitest';

const loadProposalRow = vi.fn();
const loadLatestReview = vi.fn();
vi.mock('./queries', () => ({
  loadProposalRow: (...a: unknown[]) => loadProposalRow(...a),
  loadLatestReview: (...a: unknown[]) => loadLatestReview(...a),
}));
vi.mock('../sentry', () => ({ captureException: vi.fn() }));

import { loadProposalApprovalSummary } from './approvalSummary';

const ORG = '11111111-1111-4111-8111-111111111111';
const proposal = {
  id: 'p1', orgId: ORG, goal: 'Restart the spooler', expectedEffect: 'Spooler running',
  content: 'Restart-Service spooler', riskTier: 'medium', strictHits: ['PowerShell HKLM write'],
};

beforeEach(() => {
  vi.clearAllMocks();
  loadProposalRow.mockResolvedValue(proposal);
  loadLatestReview.mockResolvedValue({
    summary: 'Targets one service', riskTier: 'low',
    verdict: { findings: [{ severity: 'warning', text: 'Loose match' }, { severity: 'info', text: 'ok' }] },
  });
});

describe('loadProposalApprovalSummary', () => {
  it('returns null for a non-proposal input without reading anything', async () => {
    expect(await loadProposalApprovalSummary({ scriptId: 's1' }, ORG)).toBeNull();
    expect(loadProposalRow).not.toHaveBeenCalled();
  });

  it('builds the trimmed block from the proposal and its latest review', async () => {
    expect(await loadProposalApprovalSummary({ proposalId: 'p1' }, ORG)).toEqual({
      proposalId: 'p1', goal: 'Restart the spooler', summary: 'Targets one service', riskTier: 'low',
      findings: ['[warning] Loose match', '[info] ok'], content: 'Restart-Service spooler',
      strictHits: ['PowerShell HKLM write'],
    });
  });

  it('is org-pinned: a proposal from another org yields null', async () => {
    expect(await loadProposalApprovalSummary({ proposalId: 'p1' }, 'other-org')).toBeNull();
  });

  it('falls back to the proposal fields when there is no review', async () => {
    loadLatestReview.mockResolvedValue(null);
    expect(await loadProposalApprovalSummary({ proposalId: 'p1' }, ORG)).toMatchObject({
      summary: 'Spooler running', riskTier: 'medium', findings: [],
    });
  });

  it('caps findings at 20 and content at 16 KiB', async () => {
    loadLatestReview.mockResolvedValue({
      summary: 's', riskTier: 'low',
      verdict: { findings: Array.from({ length: 30 }, (_, i) => ({ severity: 'info', text: `f${i}` })) },
    });
    loadProposalRow.mockResolvedValue({ ...proposal, content: 'x'.repeat(20 * 1024) });
    const r = await loadProposalApprovalSummary({ proposalId: 'p1' }, ORG);
    expect(r!.findings).toHaveLength(20);
    expect(r!.content.length).toBeLessThan(17 * 1024);
    expect(r!.content.endsWith('(truncated)')).toBe(true);
  });

  it('degrades to null on a read failure', async () => {
    loadProposalRow.mockRejectedValue(new Error('db down'));
    expect(await loadProposalApprovalSummary({ proposalId: 'p1' }, ORG)).toBeNull();
  });
});
