import { eq } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { scriptProposals } from '../../db/schema/scriptProposals';
import type { GuardrailContext } from '../aiGuardrails';

/**
 * The DB half of the input-aware `run_script` guardrail.
 *
 * It lives HERE, not in aiGuardrails.ts: that module must not import the DB
 * schema (aiGuardrails.imports.contract.test.ts), and `checkGuardrails` is
 * synchronous by contract. So every caller loads the context first and hands it
 * in.
 *
 * `proposal` absent is still a DENY signal to `checkGuardrails` (a run
 * without a reviewed risk tier may never proceed), but as of #7129 it comes
 * with a `proposalDenyReason` so the deny message is model-actionable instead
 * of one catch-all `proposal_context_missing`:
 * - no row, or a row in a DIFFERENT org — collapsed into the SAME
 *   `proposal_not_found`. A cross-org id must be indistinguishable from a
 *   nonexistent one; giving either its own message would leak cross-tenant
 *   existence.
 * - a same-org row whose review hasn't finished yet (`status: 'proposed'`,
 *   `riskTier` still NULL) — `proposal_review_pending`, so the model polls
 *   `get_script_proposal` and retries instead of giving up.
 * - a same-org row that finished negatively (`scan_rejected` / `review_failed`,
 *   also no `riskTier`) — `proposal_review_failed`; a new proposal is needed.
 * - anything else with no `riskTier` — falls back to `proposal_not_found`. In
 *   practice this is a row `superseded` (proposals.ts's `supersedeProposal`)
 *   BEFORE it was ever scanned or reviewed: it never had a chance to earn a
 *   `proposal_review_failed`-shaped verdict, so calling it that would be a
 *   false diagnosis ("scan rejection or a technical review failure" when
 *   neither happened). `proposal_not_found` reads correctly either way — this
 *   id is not currently runnable and there is nothing to poll or wait on.
 * A later terminal status reached AFTER `reviewed` (`approved`/`rejected`/
 * `expired`/`superseded`-post-review/…) has already had a `riskTier` written
 * at the `reviewed` transition and is instead diagnosed by
 * `assertProposalRunnable` (scriptProposals/runnable.ts) once past this gate.
 */
export async function loadProposalGuardrailContext(
  input: Record<string, unknown>,
  orgId: string,
): Promise<GuardrailContext | undefined> {
  const proposalId = input.proposalId;
  if (typeof proposalId !== 'string' || proposalId.length === 0) return undefined;

  const [row] = await runOutsideDbContext(() => withSystemDbAccessContext(() =>
    db.select({
      orgId: scriptProposals.orgId,
      status: scriptProposals.status,
      riskTier: scriptProposals.riskTier,
      strictHits: scriptProposals.strictHits,
    })
      .from(scriptProposals)
      .where(eq(scriptProposals.id, proposalId))
      .limit(1)));

  if (!row || row.orgId !== orgId) return { proposalDenyReason: 'proposal_not_found' };
  if (row.riskTier) return { proposal: { riskTier: row.riskTier, strictHits: row.strictHits ?? [] } };
  if (row.status === 'proposed') return { proposalDenyReason: 'proposal_review_pending' };
  if (row.status === 'scan_rejected' || row.status === 'review_failed') {
    return { proposalDenyReason: 'proposal_review_failed' };
  }
  // Any other pre-review status with no riskTier (e.g. superseded before ever
  // being scanned/reviewed) is not a review failure — see the doc comment.
  return { proposalDenyReason: 'proposal_not_found' };
}
