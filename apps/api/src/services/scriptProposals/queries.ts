import { and, desc, eq, inArray } from 'drizzle-orm';
import type { ScriptApprovalMethod } from '@breeze/shared';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { scriptProposals, scriptProposalReviews, type ScriptProposalRow } from '../../db/schema/scriptProposals';
import { scriptExecutions } from '../../db/schema/scripts';
import { devices } from '../../db/schema/devices';
import { aiSessions } from '../../db/schema/ai';
import { actionIntents } from '../../db/schema/actionIntents';

/**
 * System-scope reads for the proposal detail surface (W03, roadmap §3.5).
 *
 * System scope for the same reason approvals.ts's pending list does it: a
 * partner approver with orgAccess 'selected' legitimately decides for an org
 * outside its curated list, so the REQUEST context is not guaranteed to see
 * the row. Authority is then re-derived in detail.ts from the caller's live
 * permissions — never inferred from row visibility.
 */
export async function loadProposalRow(proposalId: string): Promise<ScriptProposalRow | null> {
  return runOutsideDbContext(() =>
    withSystemDbAccessContext(async () => {
      const [row] = await db.select().from(scriptProposals).where(eq(scriptProposals.id, proposalId)).limit(1);
      return row ?? null;
    }),
  );
}

export async function loadLatestReview(proposalId: string, orgId: string) {
  return runOutsideDbContext(() =>
    withSystemDbAccessContext(async () => {
      const [row] = await db
        .select()
        .from(scriptProposalReviews)
        .where(and(eq(scriptProposalReviews.proposalId, proposalId), eq(scriptProposalReviews.orgId, orgId)))
        .orderBy(desc(scriptProposalReviews.createdAt))
        .limit(1);
      return row ?? null;
    }),
  );
}

export async function loadProposalExecutions(proposalId: string) {
  return runOutsideDbContext(() =>
    withSystemDbAccessContext(() =>
      db
        .select({
          id: scriptExecutions.id,
          deviceId: scriptExecutions.deviceId,
          status: scriptExecutions.status,
          exitCode: scriptExecutions.exitCode,
          startedAt: scriptExecutions.startedAt,
          completedAt: scriptExecutions.completedAt,
          hostname: devices.hostname,
        })
        .from(scriptExecutions)
        .leftJoin(devices, eq(devices.id, scriptExecutions.deviceId))
        .where(eq(scriptExecutions.proposalId, proposalId))
        .orderBy(desc(scriptExecutions.startedAt)),
    ),
  );
}

/**
 * #5645 — the `approval_method` the release stamped on this proposal's run
 * (spec §4.1), for `promoteProposalToLibrary` to carry onto the promoted
 * version. Every execution of one proposal comes from the same release (the
 * proposal is single-consumption), so the newest row is representative.
 * `null` when no execution carries one — the caller stores that as-is rather
 * than inventing a method.
 */
export async function loadProposalRunApprovalMethod(
  proposalId: string,
  orgId: string,
): Promise<ScriptApprovalMethod | null> {
  return runOutsideDbContext(() =>
    withSystemDbAccessContext(async () => {
      const [row] = await db
        .select({ approvalMethod: scriptExecutions.approvalMethod })
        .from(scriptExecutions)
        .where(and(eq(scriptExecutions.proposalId, proposalId), eq(scriptExecutions.orgId, orgId)))
        .orderBy(desc(scriptExecutions.createdAt))
        .limit(1);
      return row?.approvalMethod ?? null;
    }),
  );
}

export async function loadProposalDevices(deviceIds: string[]) {
  if (deviceIds.length === 0) return [];
  return runOutsideDbContext(() =>
    withSystemDbAccessContext(() =>
      db
        .select({ id: devices.id, hostname: devices.hostname, osType: devices.osType, status: devices.status })
        .from(devices)
        .where(inArray(devices.id, deviceIds)),
    ),
  );
}

/**
 * The human who asked for this proposal to run — the "requester" half of the
 * read rule (spec §4.10: "requester, or approvals:decide with org access").
 *
 * `script_proposals` deliberately carries no requester column (W01b): a chat
 * proposal's author is the session owner, and a proposal only becomes a run
 * REQUEST when an intent claims it. So the requester is derived, in order:
 *   1. the claiming intent's `requested_by_user_id` (set for every human-
 *      requested intent, NULL for agent-run intents);
 *   2. the chat session's owner (`ai_sessions.user_id`).
 * Returns null for an agent-authored proposal with no human requester — there
 * is then no requester grant, and only approvals:decide holders may read it.
 */
export async function loadProposalRequesterUserId(
  proposal: Pick<ScriptProposalRow, 'sessionId' | 'intentId'>,
): Promise<string | null> {
  return runOutsideDbContext(() =>
    withSystemDbAccessContext(async () => {
      if (proposal.intentId) {
        const [intent] = await db
          .select({ requestedByUserId: actionIntents.requestedByUserId })
          .from(actionIntents)
          .where(eq(actionIntents.id, proposal.intentId))
          .limit(1);
        if (intent?.requestedByUserId) return intent.requestedByUserId;
      }
      if (proposal.sessionId) {
        const [session] = await db
          .select({ userId: aiSessions.userId })
          .from(aiSessions)
          .where(eq(aiSessions.id, proposal.sessionId))
          .limit(1);
        if (session?.userId) return session.userId;
      }
      return null;
    }),
  );
}
