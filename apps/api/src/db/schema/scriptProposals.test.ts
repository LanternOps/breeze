import { describe, expect, it } from 'vitest';
import { getTableColumns, getTableName } from 'drizzle-orm';
import { scriptProposalReviews, scriptProposals } from './scriptProposals';
import { scriptExecutions, scripts } from './scripts';

describe('script proposal schema', () => {
  it('declares script_proposals with the spec §4.1 columns', () => {
    expect(getTableName(scriptProposals)).toBe('script_proposals');
    expect(Object.keys(getTableColumns(scriptProposals))).toEqual(expect.arrayContaining([
      'id', 'orgId', 'authorKind', 'sessionId', 'agentRunId', 'language', 'content',
      'contentDigest', 'timeoutSeconds', 'runAs', 'goal', 'expectedEffect', 'verification',
      'rollbackNote', 'targetDeviceIds', 'scannerVersion', 'basicHits', 'strictHits',
      'touchClasses', 'status', 'revision', 'supersedesId', 'riskTier', 'decidedBy',
      'decidedAt', 'decisionNote', 'intentId', 'verifiedAt', 'verificationResult',
      'promotedScriptId', 'promotedVersionId', 'createdAt', 'expiresAt',
    ]));
  });

  it('declares script_proposal_reviews with the review columns', () => {
    expect(getTableName(scriptProposalReviews)).toBe('script_proposal_reviews');
    expect(Object.keys(getTableColumns(scriptProposalReviews))).toEqual(expect.arrayContaining([
      'id', 'orgId', 'proposalId', 'reviewerKind', 'model', 'reviewerPromptVersion', 'status',
      'summary', 'riskTier', 'goalMatch', 'reversible', 'verificationAdequate',
      'recommendedAction', 'verdict', 'inputTokens', 'outputTokens', 'costCents',
      'budgetReservationId', 'createdAt',
    ]));
  });

  it('makes script_executions.script_id optional and adds the source + provenance columns', () => {
    const cols = getTableColumns(scriptExecutions);
    expect(cols.scriptId.notNull).toBe(false);
    for (const name of [
      'sourceKind', 'proposalId', 'language', 'timeoutSeconds', 'contentDigest',
      'scriptVersionId', 'reviewId', 'approvedBy', 'approvalMethod',
      'reviewRiskTier', 'reviewSummary',
    ]) {
      expect(cols[name as keyof typeof cols], name).toBeDefined();
    }
  });

  it('adds origin provenance to scripts', () => {
    const cols = getTableColumns(scripts);
    expect(cols.origin).toBeDefined();
    expect(cols.originProposalId).toBeDefined();
  });
});
