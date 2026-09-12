import { sql } from 'drizzle-orm';
import { db } from '../../db';

/**
 * AI Risk Dashboard "Script Proposals" panel (W06, #5618): reviewer
 * disagreements between a human's decision and the proposal's latest
 * completed MODEL review.
 *
 * Extracted from routes/ai.ts into its own module so a live-Postgres test
 * can exercise this exact raw SQL — DISTINCT ON needs raw SQL (Drizzle's
 * query builder has no portable equivalent used elsewhere in this repo; see
 * tenantCascade.ts for the same db.execute + row-normalising pattern), and a
 * hand-written multi-table query with enum literals is exactly the class of
 * bug this repo's own history says mocks don't catch (CLAUDE.md's tenancy
 * section: "the contract tests caught it 5/5, code review 0/5").
 *
 * `decided_by IS NOT NULL` excludes the unattended lane's auto-approved
 * proposals (decidedBy stays null there, per W04/#5612), which have no human
 * decision to disagree with. `changes_requested` counts alongside `rejected`
 * on the "approve" arm (both are the human rejecting the AI-recommended
 * content); `verification_failed` counts alongside the other post-approval
 * statuses on the "reject" arm (the human approved despite the reviewer's
 * reject recommendation, and the run's own verification later failing is
 * still that same disagreement, not a different one).
 */

// Small local normaliser for a raw db.execute() result across driver
// shapes — mirrors services/tenantCascade.ts's own rowsFromExecute helper
// (not exported from there, so duplicated locally per CLAUDE.md's guidance
// that small cross-file helpers may be duplicated rather than shared).
function rowsFromExecute<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  const rows = (result as { rows?: unknown } | null)?.rows;
  return Array.isArray(rows) ? (rows as T[]) : [];
}

export interface ScriptProposalReviewerDisagreements {
  humanRejectedAfterApprove: number;
  humanApprovedAfterReject: number;
}

export async function loadScriptProposalReviewerDisagreements(
  orgId: string,
  since: Date,
  until: Date,
): Promise<ScriptProposalReviewerDisagreements> {
  const result = await db.execute(sql`
    WITH latest_review AS (
      SELECT DISTINCT ON (proposal_id) proposal_id, recommended_action
      FROM script_proposal_reviews
      WHERE org_id = ${orgId} AND reviewer_kind = 'model' AND status = 'completed'
      ORDER BY proposal_id, created_at DESC
    )
    SELECT
      COUNT(*) FILTER (WHERE lr.recommended_action = 'approve' AND sp.status IN ('rejected', 'changes_requested')) AS "humanRejectedAfterApprove",
      COUNT(*) FILTER (WHERE lr.recommended_action = 'reject' AND sp.status IN ('approved', 'executed', 'verified', 'verification_failed', 'promoted')) AS "humanApprovedAfterReject"
    FROM script_proposals sp
    JOIN latest_review lr ON lr.proposal_id = sp.id
    WHERE sp.org_id = ${orgId}
      AND sp.decided_by IS NOT NULL
      AND sp.created_at BETWEEN ${since.toISOString()} AND ${until.toISOString()}
  `);
  const [row] = rowsFromExecute<{ humanRejectedAfterApprove: string | number; humanApprovedAfterReject: string | number }>(result);
  return {
    humanRejectedAfterApprove: Number(row?.humanRejectedAfterApprove ?? 0),
    humanApprovedAfterReject: Number(row?.humanApprovedAfterReject ?? 0),
  };
}
