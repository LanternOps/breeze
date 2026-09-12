import type { AiApprovalScriptProposalSummary } from '@breeze/shared';
import { captureException } from '../sentry';
import { loadLatestReview, loadProposalRow } from './queries';

const MAX_CONTENT_BYTES = 16 * 1024;
const MAX_FINDINGS = 20;

/**
 * W03 (#5612): the trimmed proposal block that rides the `approval_required`
 * SSE frame. The helper has no API client of its own for
 * `GET /ai/script-proposals/:id`, so the summary travels on the event —
 * capped deliberately (this is an SSE frame to a desktop client, not a
 * paginated API). Org-pinned: a proposal from another org is `null`, never a
 * cross-tenant summary.
 *
 * Non-fatal by contract: any failure degrades to `null` (the card falls back
 * to the parameter JSON), never to a failed approval.
 */
export async function loadProposalApprovalSummary(
  input: Record<string, unknown>,
  orgId: string,
): Promise<AiApprovalScriptProposalSummary | null> {
  const proposalId = input.proposalId;
  if (typeof proposalId !== 'string' || proposalId.length === 0) return null;
  try {
    const proposal = await loadProposalRow(proposalId);
    if (!proposal || proposal.orgId !== orgId) return null;
    const review = await loadLatestReview(proposal.id, proposal.orgId);
    const verdict = (review?.verdict ?? {}) as { findings?: unknown };
    const findings = Array.isArray(verdict.findings)
      ? (verdict.findings as unknown[])
          .filter((f): f is { severity?: unknown; text: string } =>
            !!f && typeof f === 'object' && typeof (f as { text?: unknown }).text === 'string')
          .slice(0, MAX_FINDINGS)
          .map((f) => `[${String(f.severity ?? 'info')}] ${f.text}`)
      : [];
    const content = Buffer.byteLength(proposal.content, 'utf8') > MAX_CONTENT_BYTES
      ? `${Buffer.from(proposal.content, 'utf8').subarray(0, MAX_CONTENT_BYTES).toString('utf8')}\n… (truncated)`
      : proposal.content;
    return {
      proposalId: proposal.id,
      goal: proposal.goal,
      summary: review?.summary ?? proposal.expectedEffect,
      riskTier: review?.riskTier ?? proposal.riskTier ?? 'medium',
      findings,
      content,
      strictHits: proposal.strictHits ?? [],
    };
  } catch (err) {
    captureException(err instanceof Error ? err : new Error(String(err)), undefined, { area: 'script_proposal_approval_summary' });
    console.error('[AI-SDK] Failed to load script proposal summary for approval:', err);
    return null;
  }
}
