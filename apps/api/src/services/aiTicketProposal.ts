import { and, desc, eq, isNotNull } from 'drizzle-orm';
import { db } from '../db';
import { aiAgentRuns } from '../db/schema/aiAgents';
import { mapTicketProposal } from './aiAgents/runTrace';
import type { TicketProposalOutcome } from './aiAgents/runLoop';
import type { TicketTriageSkip, AiAgentRunTicketProposalDto } from '@breeze/shared';

export interface LatestTicketProposal {
  runId: string;
  finishedAt: Date | null;
  proposal: AiAgentRunTicketProposalDto;
}

/**
 * #4211 (W01) — the newest FINISHED `profile: 'triage'` run for this ticket
 * that actually produced a `ticketProposal`, projected through the SAME
 * mapper the agent-runs detail page uses (`runTrace.mapTicketProposal`) so the
 * two surfaces cannot drift.
 *
 * Tenant safety: this function does NOT scope by org. Every caller must have
 * already resolved the ticket through `getScopedTicketOr404(auth, id)`, which
 * applies the org + site axes; `ai_agent_runs` is then reached by the
 * ticket's own id. Do not call this from anywhere that skipped that step.
 *
 * Drafts are deliberately NOT read here: `mapTicketProposal`'s draft rows only
 * enrich `draftsWritten`, and the ticket detail already has a live drafts card
 * fed by `GET /tickets/:id/ai-drafts`. Passing an empty draft list keeps this
 * endpoint one query.
 */
export async function getLatestTicketProposal(ticketId: string): Promise<LatestTicketProposal | null> {
  const rows = await db
    .select({
      id: aiAgentRuns.id,
      finishedAt: aiAgentRuns.finishedAt,
      intentIds: aiAgentRuns.intentIds,
      outcome: aiAgentRuns.outcome,
    })
    .from(aiAgentRuns)
    .where(and(
      eq(aiAgentRuns.ticketId, ticketId),
      eq(aiAgentRuns.profile, 'triage'),
      eq(aiAgentRuns.status, 'completed'),
      // Postgres sorts NULLs FIRST on a plain DESC ORDER BY, so a completed
      // row with an unset finishedAt would otherwise outrank every real
      // finished run. Every genuinely completed run stamps finishedAt
      // (runFinalizers.ts), so this excludes only malformed/legacy rows.
      isNotNull(aiAgentRuns.finishedAt),
    ))
    .orderBy(desc(aiAgentRuns.finishedAt))
    .limit(1);

  const run = rows[0];
  if (!run) return null;
  const outcome = run.outcome as { ticketProposal?: TicketProposalOutcome; ticketTriageSkipped?: TicketTriageSkip[] } | null;
  const raw = outcome?.ticketProposal;
  if (!raw) return null;
  // #4211 review: pass the run's OWN ticketTriageSkipped through, same as
  // runTrace.ts's buildRunTrace call site — omitting it (an earlier version
  // of this function always passed `undefined`) silently dropped the
  // "skipped" section from this surface only, contradicting this function's
  // own "cannot drift from the run-detail page" claim.
  const proposal = mapTicketProposal(raw, run.intentIds ?? [], [], outcome?.ticketTriageSkipped);
  return { runId: run.id, finishedAt: run.finishedAt, proposal };
}
