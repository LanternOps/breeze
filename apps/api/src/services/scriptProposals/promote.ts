import { db } from '../../db';
import type { AuthContext } from '../../middleware/auth';
import type { ScriptProposalPromoteInput } from '@breeze/shared';
import { insertScriptRow, resolveScriptCreateScope, isScriptScopeError } from '../scriptWrite';
import { transitionProposal } from './proposals';

export interface PromotableProposal {
  id: string;
  orgId: string;
  status: string;
  content: string;
  contentDigest: string;
  language: 'powershell' | 'bash' | 'python' | 'cmd';
  timeoutSeconds: number;
  runAs: 'system' | 'user';
  goal: string;
  acknowledgedPatterns: string[];
  decidedBy: string | null;
  decidedAt: Date | null;
}

export type PromoteResult =
  | { ok: true; scriptId: string; versionId: string }
  | { ok: false; status: 400 | 403 | 409; error: string };

/**
 * Spec §4.8. Promotion is the trust step that turns a one-off remediation into a
 * repeatable library script, so it is deliberately narrow:
 *  - only from `verified` (D5 + D12 — a run that was never proved is not evidence);
 *  - the caller's `scripts:write` + MFA are enforced by the ROUTE middleware, the
 *    same pair `POST /scripts` uses;
 *  - partner-wide ownership is gated by `resolveScriptCreateScope`, which already
 *    calls `canManagePartnerWidePolicies`. One gate, not two.
 *
 * Ordering inside the transaction: the `verified → promoted` CAS runs FIRST, so
 * two concurrent promotions of one proposal cannot both insert a script — the
 * loser's CAS matches nothing and it writes nothing. `insertScriptRow` runs as
 * a savepoint inside the same transaction, and the ids are stamped afterwards.
 */
export async function promoteProposalToLibrary(args: {
  auth: AuthContext;
  proposal: PromotableProposal;
  review: { id: string; riskTier: string | null; summary: string | null; createdAt: Date } | null;
  input: ScriptProposalPromoteInput;
}): Promise<PromoteResult> {
  const { auth, proposal, review, input } = args;

  if (proposal.status !== 'verified') {
    return { ok: false, status: 409, error: 'proposal_not_verified' };
  }

  // An org-owned promotion is pinned to the PROPOSAL's org, never to whatever
  // org the caller's token happens to default to — a partner approver deciding
  // for org B must not land the script in org A.
  const scope = resolveScriptCreateScope(
    auth,
    input.ownerScope === 'partner' ? 'partner' : 'org',
    proposal.orgId,
  );
  if (isScriptScopeError(scope)) {
    return { ok: false, status: scope.status, error: scope.error };
  }

  const approver = proposal.decidedBy ?? auth.user.id;
  const approvedAt = proposal.decidedAt ?? new Date();

  return db.transaction(async (tx): Promise<PromoteResult> => {
    const claimed = await transitionProposal(tx, proposal.id, ['verified'], 'promoted', {});
    if (!claimed) return { ok: false, status: 409, error: 'proposal_not_verified' };

    const script = await insertScriptRow(
      auth,
      scope,
      {
        name: input.name,
        description: input.description ?? proposal.goal,
        osTypes: [],
        language: proposal.language,
        content: proposal.content,
        timeoutSeconds: proposal.timeoutSeconds,
        runAs: proposal.runAs,
        acknowledgedSecurityPatterns: proposal.acknowledgedPatterns,
      },
      {
        tx,
        securityAcknowledgedBy: approver,
        provenance: {
          origin: 'ai_proposal',
          proposalId: proposal.id,
          reviewId: review?.id ?? null,
          reviewedAt: review?.createdAt ?? null,
          approvedBy: approver,
          approvedAt,
          // Supervised-vs-four_eyes is the intent's property; the proposal-side
          // record keeps the coarse value the version panel renders. W04 widens
          // this to 'unattended_reviewer_gated'.
          approvalMethod: 'four_eyes',
          changelog: `Promoted from AI proposal ${proposal.id}`,
          createdBy: auth.user.id,
        },
      },
    );

    await transitionProposal(tx, proposal.id, ['promoted'], 'promoted', {
      promotedScriptId: script.id,
      promotedVersionId: script.headVersionId,
    });

    return { ok: true, scriptId: script.id, versionId: script.headVersionId };
  });
}
