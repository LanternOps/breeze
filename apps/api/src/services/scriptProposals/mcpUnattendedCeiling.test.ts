import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  proposal: null as Record<string, unknown> | null,
  ceiling: 'none' as string,
  review: null as Record<string, unknown> | null,
}));

vi.mock('../../db', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({ limit: async () => (state.proposal ? [state.proposal] : []) }),
        innerJoin: () => ({ where: () => ({ limit: async () => [{ ceiling: state.ceiling }] }) }),
      }),
    }),
  },
  runOutsideDbContext: <T,>(fn: () => T) => fn(),
  withSystemDbAccessContext: <T,>(fn: () => T) => fn(),
}));
vi.mock('./proposals', () => ({ latestCompletedReview: async () => state.review }));

import { mcpUnattendedProposalRefusal } from './mcpUnattendedCeiling';

const approve = { goalMatch: 'yes', verificationAdequate: true, reversible: false, recommendedAction: 'approve' };

beforeEach(() => {
  state.proposal = { status: 'reviewed', riskTier: 'high', strictHits: [] };
  state.ceiling = 'critical';
  state.review = { ...approve };
});

describe('mcpUnattendedProposalRefusal', () => {
  it('allows a reviewed, approved, strict-clean proposal within the ceiling, irreversible included', async () => {
    await expect(mcpUnattendedProposalRefusal('p1', 'org-1')).resolves.toBeNull();
  });

  it.each([
    ['missing proposal', () => { state.proposal = null; }, 'not_reviewed'],
    ['not reviewed', () => { state.proposal = { ...state.proposal, status: 'proposed' }; }, 'not_reviewed'],
    ['strict hits', () => { state.proposal = { ...state.proposal, strictHits: ['x'] }; }, 'strict_hits'],
    ['no completed review', () => { state.review = null; }, 'review_missing'],
    ['review recommends changes', () => { state.review = { ...approve, recommendedAction: 'changes' }; }, 'verdict_not_approve'],
    ['review recommends reject', () => { state.review = { ...approve, recommendedAction: 'reject' }; }, 'verdict_not_approve'],
    ['goal only partly matched', () => { state.review = { ...approve, goalMatch: 'partial' }; }, 'verdict_not_approve'],
    ['verification inadequate', () => { state.review = { ...approve, verificationAdequate: false }; }, 'verdict_not_approve'],
    ['risk above the ceiling', () => { state.ceiling = 'medium'; }, 'risk_above_ceiling'],
    ['ceiling none', () => { state.ceiling = 'none'; }, 'risk_above_ceiling'],
  ])('refuses: %s', async (_label, arrange, reason) => {
    arrange();
    await expect(mcpUnattendedProposalRefusal('p1', 'org-1')).resolves.toBe(reason);
  });
});
