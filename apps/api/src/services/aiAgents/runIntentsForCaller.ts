/**
 * Run-detail intents (`GET /ai/agents/runs/:runId`), read under the CALLER's
 * request context.
 *
 * #4442 W05 — read by `requesting_agent_run_id`, not `run.intent_ids` (that
 * column lists only PENDING intents; a decided or expired one drops out). Two
 * org predicates: the run's own org pins the read, the caller's condition
 * stays as defence-in-depth beside RLS.
 *
 * W2 #11085 — the run card decides a pending step inline (Wisp delegation),
 * so each intent carries the caller's OWN pending, unexpired approval row: its
 * id (the decide endpoint's handle) and the card's label. LEFT JOIN on the
 * caller's user id, so another approver's row is never exposed (RLS on
 * approval_requests is user-scoped too); a caller with no row gets nulls.
 * The decide route re-checks everything.
 */
import { and, eq, gt, type SQL } from 'drizzle-orm';
import { db } from '../../db';
import { actionIntents } from '../../db/schema/actionIntents';
import { approvalRequests } from '../../db/schema/approvals';
import type { RunTraceIntentRowInput } from './runTrace';

export async function selectRunIntentsForCaller(args: {
  runId: string;
  runOrgId: string;
  userId: string;
  /** The caller's org condition (auth.orgCondition); undefined = none. */
  orgCondition: SQL | undefined;
  now?: Date;
}): Promise<RunTraceIntentRowInput[]> {
  const rows = await db
    .select({
      id: actionIntents.id,
      status: actionIntents.status,
      actionName: actionIntents.actionName,
      approvalScope: actionIntents.approvalScope,
      decidedVia: actionIntents.decidedVia,
      approvalRequestId: approvalRequests.id,
      actionLabel: approvalRequests.actionLabel,
    })
    .from(actionIntents)
    .leftJoin(approvalRequests, and(
      eq(approvalRequests.intentId, actionIntents.id),
      eq(approvalRequests.userId, args.userId),
      eq(approvalRequests.status, 'pending'),
      gt(approvalRequests.expiresAt, args.now ?? new Date()),
    ))
    .where(and(
      eq(actionIntents.requestingAgentRunId, args.runId),
      eq(actionIntents.orgId, args.runOrgId),
      args.orgCondition,
    ));
  // One row per intent even if the join ever matched twice (first wins).
  const seen = new Set<string>();
  return rows.filter((row) => {
    if (seen.has(row.id)) return false;
    seen.add(row.id);
    return true;
  });
}
