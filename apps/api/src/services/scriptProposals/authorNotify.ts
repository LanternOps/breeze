import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { aiMessages } from '../../db/schema/ai';
import { streamingSessionManager } from '../streamingSessionManager';
import { createNotification } from '../userNotifications';
import { captureException } from '../sentry';

export type ProposalAuthorEvent =
  | { kind: 'changes_requested'; note: string; findings: Array<{ severity: string; text: string }> }
  | { kind: 'verified'; detail: string }
  | { kind: 'verification_failed'; detail: string }
  | { kind: 'verification_unknown'; detail: string };

const TITLES: Record<ProposalAuthorEvent['kind'], string> = {
  changes_requested: 'Changes requested on your script proposal',
  verified: 'Script proposal verified',
  verification_failed: 'Script proposal failed verification',
  verification_unknown: 'Script proposal could not be verified',
};

/** Plain text, because it lands in a chat transcript AND a notification body. */
export function renderAuthorMessage(proposalId: string, event: ProposalAuthorEvent): string {
  const head = `${TITLES[event.kind]} (proposal ${proposalId}).`;
  if (event.kind !== 'changes_requested') return `${head}\n${event.detail}`;
  const findings = event.findings.length
    ? `\n\nReviewer findings:\n${event.findings.map((f) => `- [${f.severity}] ${f.text}`).join('\n')}`
    : '';
  return `${head}\n\nApprover note: ${event.note}${findings}\n\nCall propose_script again with supersedesProposalId set to this id; do not retry the same content.`;
}

export interface ProposalAuthorTarget {
  id: string;
  orgId: string;
  authorKind: 'chat_session' | 'agent_run';
  sessionId: string | null;
  agentRunId: string | null;
  /** The human to notify (see queries.loadProposalRequesterUserId); null = nobody. */
  requestedByUserId?: string | null;
}

/**
 * Deliver a proposal outcome to whoever authored it (spec §4.7, §4.9).
 *
 * Chat: a durable `ai_messages` row (role 'system') plus a best-effort publish
 * on the in-process SessionEventBus. The bus is PROCESS-LOCAL
 * (streamingSessionManager) — there is no Redis fan-out for session streams —
 * so a session streaming from another API replica gets the row and nothing
 * else, and the client picks it up on its next fetch. That is the contract,
 * not a bug to "fix" with a broadcast.
 *
 * Agent: nothing is written into the run transcript here. The pending
 * run_script tool call is resolved by the intent denial itself (runLoop.ts
 * turns a non-pending intent into an intentError), so this only raises the
 * durable notification for the human who requested the run, when there is one.
 */
export async function postProposalOutcomeToAuthor(
  proposal: ProposalAuthorTarget,
  event: ProposalAuthorEvent,
): Promise<void> {
  const body = renderAuthorMessage(proposal.id, event);

  if (proposal.authorKind === 'chat_session' && proposal.sessionId) {
    const sessionId = proposal.sessionId;
    await runOutsideDbContext(() =>
      withSystemDbAccessContext(() =>
        db.insert(aiMessages).values({ sessionId, role: 'system', content: body }),
      ),
    );
    try {
      streamingSessionManager.get(sessionId)?.eventBus.publish({
        type: 'script_proposal_update',
        proposalId: proposal.id,
        outcome: event.kind,
        message: body,
      });
    } catch (err) {
      // A live-stream nudge failing must never fail the decision or the job.
      captureException(err, undefined, { area: 'script_proposal_author_notify' });
    }
  }

  if (proposal.requestedByUserId) {
    const userId = proposal.requestedByUserId;
    await runOutsideDbContext(() =>
      withSystemDbAccessContext(() =>
        createNotification({
          userId,
          orgId: proposal.orgId,
          type: 'approval',
          priority: event.kind === 'verification_failed' ? 'high' : 'normal',
          title: TITLES[event.kind],
          message: body.slice(0, 500),
          link: '/approvals',
          metadata: { proposalId: proposal.id, outcome: event.kind },
          dedupeKey: `script-proposal:${proposal.id}:${event.kind}`,
        }),
      ),
    );
  }
}
