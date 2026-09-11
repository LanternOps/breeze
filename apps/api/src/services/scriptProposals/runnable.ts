import { eq } from 'drizzle-orm';
import { db } from '../../db';
import { scriptProposals, type ScriptProposalRow } from '../../db/schema';
import type { AuthContext } from '../../middleware/auth';

export type ProposalRunnabilityReason =
  | 'not_found' | 'wrong_org' | 'not_reviewed' | 'expired' | 'superseded' | 'consumed'
  | 'device_not_targeted' | 'run_as_mismatch' | 'timeout_mismatch' | 'parameters_not_allowed';

export type ProposalRunnability =
  | { ok: true; proposal: ScriptProposalRow }
  | { ok: false; reason: ProposalRunnabilityReason };

/**
 * The spec §4.2 validation list for `run_script { proposalId }`.
 *
 * Order matters for the message the author gets back: identity and lifecycle
 * first, then the request-vs-proposal equalities. A failure is ALWAYS a tool
 * error — there is no fallback to `scriptId`, because silently running a
 * different thing than the one that was reviewed is the exact failure this
 * whole design exists to prevent.
 *
 * This is a pre-check, not the mutual exclusion. `consumeProposalForIntent`
 * (proposals.ts) is the real gate, and it runs inside the intent transaction.
 * A `consumed` verdict here just turns a lost race into a readable error.
 */
export async function assertProposalRunnable(
  auth: AuthContext,
  input: {
    proposalId: string; deviceIds: string[];
    runAs?: string; timeoutSeconds?: number; parameters?: unknown;
  },
): Promise<ProposalRunnability> {
  const [proposal] = await db
    .select().from(scriptProposals).where(eq(scriptProposals.id, input.proposalId)).limit(1);

  if (!proposal) return { ok: false, reason: 'not_found' };
  if (proposal.orgId !== auth.orgId) return { ok: false, reason: 'wrong_org' };
  if (proposal.status === 'superseded') return { ok: false, reason: 'superseded' };
  if (proposal.status !== 'reviewed') return { ok: false, reason: 'not_reviewed' };
  if (proposal.intentId !== null) return { ok: false, reason: 'consumed' };
  if (proposal.expiresAt.getTime() <= Date.now()) return { ok: false, reason: 'expired' };

  const targeted = new Set(proposal.targetDeviceIds);
  if (!input.deviceIds.every((id) => targeted.has(id))) {
    return { ok: false, reason: 'device_not_targeted' };
  }
  // Equality, not "absent means inherit": a caller that names a run context at
  // all must name the one that was reviewed, because run_as changes what the
  // script can do on the device.
  if (input.runAs !== undefined && input.runAs !== proposal.runAs) {
    return { ok: false, reason: 'run_as_mismatch' };
  }
  if (input.timeoutSeconds !== undefined && input.timeoutSeconds !== proposal.timeoutSeconds) {
    return { ok: false, reason: 'timeout_mismatch' };
  }
  // A proposal has no parameter definitions: its content is literal and its
  // digest pins that literal content. Accepting parameters would mean running
  // something the reviewer never saw.
  if (input.parameters !== undefined && input.parameters !== null
      && Object.keys(input.parameters as Record<string, unknown>).length > 0) {
    return { ok: false, reason: 'parameters_not_allowed' };
  }

  return { ok: true, proposal };
}
