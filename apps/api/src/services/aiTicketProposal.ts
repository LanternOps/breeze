import { and, desc, eq } from 'drizzle-orm';
import { db } from '../db';
import { aiAgentRuns } from '../db/schema/aiAgents';
import { mapTicketProposal } from './aiAgents/runTrace';
import type { TicketProposalOutcome } from './aiAgents/runLoop';
import type { AiAgentRunTicketProposalDto } from '@breeze/shared';

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
    ))
    .orderBy(desc(aiAgentRuns.finishedAt))
    .limit(1);

  const run = rows[0];
  if (!run) return null;
  const raw = (run.outcome as { ticketProposal?: TicketProposalOutcome } | null)?.ticketProposal;
  if (!raw) return null;
  const proposal = mapTicketProposal(raw, run.intentIds ?? [], [], undefined);
  if (!proposal) return null;
  return { runId: run.id, finishedAt: run.finishedAt ?? null, proposal };
}
