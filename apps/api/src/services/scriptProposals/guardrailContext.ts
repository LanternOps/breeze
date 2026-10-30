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
  const row = await loadGuardrailRow(proposalId);
  return classifyProposalRow(row && row.orgId === orgId ? row : undefined);
}

/**
 * #10384: the same verdict as `loadProposalGuardrailContext`, but the proposal
 * is looked up within the caller's org REACH instead of pinned to one org, and
 * the proposal's own org is handed back.
 *
 * For the interactive chat gate. A chat session is bound to one org, yet
 * `propose_script` files the proposal under the TARGET DEVICE's org
 * (aiToolsScriptProposals.ts `resolveProposalOrgId`). Under a partner-scope
 * login (a Wisp session on a partner-wide grant, or a partner tech's ordinary
 * chat) those differ whenever the device sits outside the bound org, and an
 * exact-org lookup refused every such proposal as `proposal_not_found`.
 *
 * `canAccessOrg` is the caller's reach for THIS call: the session's tool auth,
 * cut to the Wisp ceiling when a grant governs the session. Nothing is widened:
 * the device gate, `assertProposalRunnable` and the action intent all still
 * require the same access. A proposal outside that reach collapses into
 * `proposal_not_found` with no org, indistinguishable from a missing id, so
 * the no-cross-tenant-existence-signal property above holds per reach.
 */
export async function loadProposalGuardrailContextInReach(
  input: Record<string, unknown>,
  canAccessOrg: (orgId: string) => boolean,
): Promise<{ context: GuardrailContext | undefined; proposalOrgId: string | null }> {
  const proposalId = input.proposalId;
  if (typeof proposalId !== 'string' || proposalId.length === 0) return { context: undefined, proposalOrgId: null };
  const row = await loadGuardrailRow(proposalId);
  const inReach = row && canAccessOrg(row.orgId) ? row : undefined;
  return { context: classifyProposalRow(inReach), proposalOrgId: inReach?.orgId ?? null };
}

/**
 * #10384: the org a proposal lives in, when the caller can reach it; null for
 * a missing id and for one outside `canAccessOrg` alike. For the chat
 * attribution back-fill (aiAgentSdk.ts `attachChatProposalToSession`), which
 * must write under the proposal's org, not the session's.
 */
export async function resolveProposalOrgInReach(
  proposalId: string,
  canAccessOrg: (orgId: string) => boolean,
): Promise<string | null> {
  const row = await loadGuardrailRow(proposalId);
  return row && canAccessOrg(row.orgId) ? row.orgId : null;
}

async function loadGuardrailRow(proposalId: string) {
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
  return row;
}

/** `row` is undefined both for a missing id and for one outside the caller's scope. */
function classifyProposalRow(row: Awaited<ReturnType<typeof loadGuardrailRow>>): GuardrailContext {
  if (!row) return { proposalDenyReason: 'proposal_not_found' };
  if (row.riskTier) return { proposal: { riskTier: row.riskTier, strictHits: row.strictHits ?? [] } };
  if (row.status === 'proposed') return { proposalDenyReason: 'proposal_review_pending' };
  if (row.status === 'scan_rejected' || row.status === 'review_failed') {
    return { proposalDenyReason: 'proposal_review_failed' };
  }
  // Any other pre-review status with no riskTier (e.g. superseded before ever
  // being scanned/reviewed) is not a review failure — see the doc comment.
  return { proposalDenyReason: 'proposal_not_found' };
}
