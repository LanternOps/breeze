import { eq } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { scriptProposals } from '../../db/schema';
import type { GuardrailContext } from '../aiGuardrails';

/**
 * The DB half of the input-aware `run_script` guardrail.
 *
 * It lives HERE, not in aiGuardrails.ts: that module must not import the DB
 * schema (aiGuardrails.imports.contract.test.ts), and `checkGuardrails` is
 * synchronous by contract. So every caller loads the context first and hands it
 * in.
 *
 * Returning `undefined` is a DENY signal, not a "no opinion": `checkGuardrails`
 * turns a `run_script` call that names a proposal but arrives with no context
 * into tier 4 / `proposal_context_missing`. That is why a cross-org id and an
 * unreviewed proposal both return undefined rather than a fabricated tier —
 * failing closed here is strictly safer than guessing.
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
      riskTier: scriptProposals.riskTier,
      strictHits: scriptProposals.strictHits,
    })
      .from(scriptProposals)
      .where(eq(scriptProposals.id, proposalId))
      .limit(1)));

  if (!row || row.orgId !== orgId || !row.riskTier) return undefined;
  return { proposal: { riskTier: row.riskTier, strictHits: row.strictHits ?? [] } };
}
