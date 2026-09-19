import { and, eq } from 'drizzle-orm';
import type { db } from '../../db';
import { actionIntents } from '../../db/schema/actionIntents';
import { approvalRequests } from '../../db/schema/approvals';
import { publishIntentTerminalOutbox } from '../aiOperator/taskOutbox';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0] | typeof db;

/**
 * Deny the one intent a proposal was consumed by, with a typed reason
 * (spec §4.7 "Request changes").
 *
 * CAS on `pending_approval` so a race with a real approver decision (or the
 * expiry reaper) loses cleanly instead of resurrecting a decided intent. The
 * sibling `approval_requests` rows are expired exactly as the decide core does
 * on a deny, and the terminal outbox publish is what unblocks the waiting tool
 * call: chat sees it through the intent-decision poll in aiAgentSdk.ts, agents
 * through runLoop.ts's non-pending-intent branch.
 *
 * Must run inside the caller's transaction (`tx`) — the outbox row has to
 * commit with the status change or not at all.
 */
export async function denyIntentForProposal(
  tx: Tx,
  proposal: { intentId: string | null },
  reason: 'changes_requested',
  decidedByUserId: string,
): Promise<boolean> {
  if (!proposal.intentId) return false;
  const rows = await tx
    .update(actionIntents)
    .set({ status: 'rejected', decidedAt: new Date(), decidedByUserId, errorCode: reason })
    .where(and(eq(actionIntents.id, proposal.intentId), eq(actionIntents.status, 'pending_approval')))
    .returning({ id: actionIntents.id, orgId: actionIntents.orgId, taskId: actionIntents.taskId });
  const intent = rows[0];
  if (!intent) return false;

  await tx
    .update(approvalRequests)
    .set({ status: 'expired', decidedAt: new Date() })
    .where(and(eq(approvalRequests.intentId, intent.id), eq(approvalRequests.status, 'pending')));

  await publishIntentTerminalOutbox(tx, intent, 'intent_rejected');
  return true;
}
