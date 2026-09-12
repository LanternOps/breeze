import type { AuthContext } from '../../middleware/auth';
import { hasSatisfiedMfa } from '../../middleware/auth';
import { canAccessOrg, getUserPermissions, hasPermission, userCanDecideApprovals, PERMISSIONS } from '../permissions';
import { runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import type { ScriptProposalDetailDto, ScriptProposalReviewFindingDto } from '@breeze/shared';
import {
  loadProposalRow, loadLatestReview, loadProposalExecutions, loadProposalDevices, loadProposalRequesterUserId,
} from './queries';

export type ProposalReadDenial = 'not_found' | 'forbidden';

const FINDING_SEVERITIES = new Set(['info', 'warning', 'blocking']);

function projectFindings(raw: unknown): ScriptProposalReviewFindingDto[] {
  if (!Array.isArray(raw)) return [];
  const out: ScriptProposalReviewFindingDto[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const f = item as { severity?: unknown; text?: unknown; lineRef?: unknown };
    if (typeof f.text !== 'string') continue;
    const severity = FINDING_SEVERITIES.has(String(f.severity)) ? (f.severity as ScriptProposalReviewFindingDto['severity']) : 'info';
    out.push({ severity, text: f.text, ...(typeof f.lineRef === 'number' ? { lineRef: f.lineRef } : {}) });
  }
  return out;
}

/**
 * THE read rule for a script proposal (spec §4.10, roadmap §3.5). One function,
 * shared by every surface that can hand back the script BODY, for the reason
 * `isIntentRowLiveAuthorized` exists (routes/approvals.ts, #3175): a demoted
 * approver must stop being able to fetch the code, not merely stop seeing the
 * row in a list.
 *
 * Authorised when the proposal's org is reachable by the caller AND either
 *   - the caller is the proposal's requester (derived — see
 *     loadProposalRequesterUserId), or
 *   - the caller STILL holds approvals:decide for that org.
 */
export async function loadScriptProposalDetail(
  auth: AuthContext,
  proposalId: string,
): Promise<{ ok: true; dto: ScriptProposalDetailDto } | { ok: false; reason: ProposalReadDenial }> {
  const proposal = await loadProposalRow(proposalId);
  if (!proposal) return { ok: false, reason: 'not_found' };

  const perms = await runOutsideDbContext(() =>
    withSystemDbAccessContext(() =>
      getUserPermissions(auth.user.id, { partnerId: auth.partnerId ?? undefined, orgId: proposal.orgId }),
    ),
  );
  const reachable = !!perms && canAccessOrg(perms, proposal.orgId);
  if (!reachable) return { ok: false, reason: 'forbidden' };
  const canDecide = userCanDecideApprovals(perms!);
  const requesterId = canDecide ? null : await loadProposalRequesterUserId(proposal);
  const isRequester = requesterId !== null && requesterId === auth.user.id;
  if (!canDecide && !isRequester) return { ok: false, reason: 'forbidden' };

  const canWriteScripts = hasPermission(perms!, PERMISSIONS.SCRIPTS_WRITE.resource, PERMISSIONS.SCRIPTS_WRITE.action);
  const mfaOk = hasSatisfiedMfa(auth);

  const [review, executions, devices] = await Promise.all([
    loadLatestReview(proposalId, proposal.orgId),
    loadProposalExecutions(proposalId),
    loadProposalDevices(proposal.targetDeviceIds ?? []),
  ]);

  const verdict = (review?.verdict ?? {}) as { findings?: unknown; blastRadius?: unknown };
  const verificationResult = (proposal.verificationResult ?? null) as
    | { outcome?: string; attempts?: number; detail?: string }
    | null;
  const storedOutcome = verificationResult?.outcome;
  const outcome: ScriptProposalDetailDto['verification']['outcome'] =
    proposal.status === 'verified' ? 'verified'
    : proposal.status === 'verification_failed'
      ? (storedOutcome === 'unknown' ? 'unknown' : 'verification_failed')
      : 'pending';

  return {
    ok: true,
    dto: {
      proposal: {
        id: proposal.id, status: proposal.status, language: proposal.language, content: proposal.content,
        contentDigest: proposal.contentDigest, goal: proposal.goal, expectedEffect: proposal.expectedEffect,
        rollbackNote: proposal.rollbackNote ?? null, verification: proposal.verification, runAs: proposal.runAs,
        timeoutSeconds: proposal.timeoutSeconds, targetDeviceIds: proposal.targetDeviceIds ?? [],
        basicHits: proposal.basicHits ?? [], strictHits: proposal.strictHits ?? [],
        touchClasses: proposal.touchClasses ?? [], riskTier: proposal.riskTier ?? null, revision: proposal.revision,
        acknowledgedPatterns: proposal.acknowledgedPatterns ?? [],
        intentId: proposal.intentId ?? null,
        createdAt: proposal.createdAt.toISOString(), expiresAt: proposal.expiresAt.toISOString(),
        promotedScriptId: proposal.promotedScriptId ?? null,
      },
      review: review
        ? {
            id: review.id, summary: review.summary ?? null, riskTier: review.riskTier ?? null,
            goalMatch: review.goalMatch ?? null, reversible: review.reversible ?? null,
            verificationAdequate: review.verificationAdequate ?? null,
            recommendedAction: review.recommendedAction ?? null,
            findings: projectFindings(verdict.findings),
            blastRadius: Array.isArray(verdict.blastRadius)
              ? (verdict.blastRadius as unknown[]).filter((b): b is string => typeof b === 'string')
              : [],
            model: review.model ?? null, createdAt: review.createdAt.toISOString(),
          }
        : null,
      devices: devices.map((d) => ({ id: d.id, hostname: d.hostname, osType: d.osType ?? null, status: d.status })),
      executions: executions.map((e) => ({
        id: e.id, deviceId: e.deviceId, deviceHostname: e.hostname ?? null, status: e.status,
        exitCode: e.exitCode ?? null,
        startedAt: e.startedAt?.toISOString() ?? null, completedAt: e.completedAt?.toISOString() ?? null,
      })),
      verification: {
        outcome,
        verifiedAt: proposal.verifiedAt?.toISOString() ?? null,
        attempts: verificationResult?.attempts ?? 0,
        detail: verificationResult?.detail ?? null,
      },
      viewer: {
        canDecide,
        canAcknowledge: canWriteScripts && mfaOk,
        canPromote: canWriteScripts && mfaOk && proposal.status === 'verified',
      },
    },
  };
}
