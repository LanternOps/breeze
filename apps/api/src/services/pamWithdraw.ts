/**
 * #8971: the end user's device withdraws a pending elevation request.
 *
 * When the person at the keyboard answers Deny on the PAM dialog, lets it time
 * out, or the dialog fails, the agent refuses consent.exe locally and records
 * the decline durably (agent/internal/pamdecline), then calls
 * POST /agents/:id/elevation-requests/:requestId/withdraw. Before this route a
 * technician could still approve that request for the rest of its pending TTL,
 * and the approval would launch the app the user had declined.
 *
 * The agent's local record is authoritative for the endpoint: it refuses any
 * later apply for a declined request even if this call never lands. This
 * service makes the server row agree, so no technician or phone can approve it:
 *   - locks the owned row (FOR UPDATE: conflicts with the respond CAS and with
 *     decideApprovalRequest's FOR NO KEY UPDATE, so exactly one of
 *     approve / deny / withdraw / TTL expiry wins);
 *   - moves pending -> withdrawn with withdrawn_at / withdrawn_reason (no
 *     revision bump, same as respond);
 *   - writes one 'withdrawn' elevation_audit row, actor end_user.
 * A row already withdrawn is a replay (the agent retries after a lost
 * response): the stored withdrawnAt is returned and nothing is written. Any
 * other status is reported as not_pending, and the agent acks it.
 *
 * The caller runs this inside the agent's org-scoped DB context. Ownership is
 * part of the WHERE: the row must be a uac_intercept request of the calling
 * device in the calling org; anything else is not_found (no existence oracle
 * across devices). The caller expires linked phone approvals and publishes the
 * event after the context exits.
 */
import { and, eq } from 'drizzle-orm';

import { db } from '../db';
import { elevationAudit, elevationRequests, type PamWithdrawReason } from '../db/schema';

export type WithdrawOutcome =
  | { kind: 'withdrawn'; withdrawnAt: Date; replay: boolean }
  | { kind: 'not_pending'; status: string }
  | { kind: 'not_found' };

export async function withdrawElevationRequest(input: {
  orgId: string;
  deviceId: string;
  requestId: string;
  reason: PamWithdrawReason;
  /** When the agent recorded the decline; informative only (audit). */
  agentDeclinedAt: Date | null;
}): Promise<WithdrawOutcome> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({
        id: elevationRequests.id,
        orgId: elevationRequests.orgId,
        status: elevationRequests.status,
        withdrawnAt: elevationRequests.withdrawnAt,
      })
      .from(elevationRequests)
      .where(and(
        eq(elevationRequests.id, input.requestId),
        eq(elevationRequests.orgId, input.orgId),
        eq(elevationRequests.deviceId, input.deviceId),
        // Only the flow the agent itself creates. A technician's JIT grant or
        // a governed AI action on the same device is not the end user's to
        // withdraw.
        eq(elevationRequests.flowType, 'uac_intercept'),
      ))
      .limit(1)
      .for('update');

    if (!row) return { kind: 'not_found' as const };

    if (row.status === 'withdrawn') {
      if (!row.withdrawnAt) {
        // elevation_requests_status_timestamps_chk makes this unreachable.
        throw new Error(`elevation request ${row.id} is withdrawn without withdrawn_at`);
      }
      return { kind: 'withdrawn' as const, withdrawnAt: row.withdrawnAt, replay: true };
    }
    if (row.status !== 'pending') {
      return { kind: 'not_pending' as const, status: row.status };
    }

    const now = new Date();
    const updated = await tx
      .update(elevationRequests)
      .set({ status: 'withdrawn', withdrawnAt: now, withdrawnReason: input.reason, updatedAt: now })
      .where(and(eq(elevationRequests.id, row.id), eq(elevationRequests.status, 'pending')))
      .returning({ withdrawnAt: elevationRequests.withdrawnAt });

    if (updated.length === 0) {
      // Unreachable under the row lock above. Report what is there rather than
      // claiming a write that did not happen.
      const [current] = await tx
        .select({ status: elevationRequests.status })
        .from(elevationRequests)
        .where(eq(elevationRequests.id, row.id))
        .limit(1);
      return { kind: 'not_pending' as const, status: current?.status ?? row.status };
    }

    await tx.insert(elevationAudit).values({
      orgId: row.orgId,
      elevationRequestId: row.id,
      eventType: 'withdrawn',
      actor: 'end_user',
      details: {
        cause: input.reason,
        agent_declined_at: input.agentDeclinedAt ? input.agentDeclinedAt.toISOString() : null,
      },
      occurredAt: now,
    });

    return { kind: 'withdrawn' as const, withdrawnAt: updated[0]!.withdrawnAt ?? now, replay: false };
  });
}
