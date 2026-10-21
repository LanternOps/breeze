/**
 * §5.5 Grants, authorizations and directives, plus the old install's secrets.
 *
 * - `diagnostic_access_grants` (F8): pending requests expire and active grants
 *   are revoked, as `revokeDiagnosticGrantsForMove` does on a move, and their
 *   pending approval requests expire in the same transaction (the boundary runs
 *   in system scope, so it reaches every approver's row; the move needs a
 *   post-commit pass for that).
 * - `caller_verifications`: workstation grants keyed by
 *   `workstation_device_ref` are revoked through the move hook itself, under
 *   the same subject locks, scoped to the device's current org.
 * - `software_remediation_requests`: unused MFA-gated authorizations expire
 *   now (the consume requires `expires_at > now()`); `consumed_at` is not
 *   written, so the row never claims a consume that did not happen.
 * - `agent_rollback_directives`: requested/in-progress directives become
 *   `expired`, a state the CHECK already allows; their `agent_rollback_v1`
 *   commands were cancelled by the command handler.
 * - `provision_credential_handles`: an unfetched one-time handle carries the
 *   plaintext agent, watchdog and helper tokens (and mTLS key) minted for an
 *   install that is gone. Deleted, as a fetch would.
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../../../db';
import { approvalRequests } from '../../../db/schema';
import { revokeWorkstationGrantsForMove } from '../../callerVerification/deviceMove';
import { INSTALL_BOUNDARY_REASON, rowCount, type BoundaryHandler } from '../types';

export const grantsHandler: BoundaryHandler = {
  id: 'grants',
  spec: '§5.5',
  tables: [
    'diagnostic_access_grants',
    'caller_verifications',
    'software_remediation_requests',
    'agent_rollback_directives',
    'provision_credential_handles',
  ],
  async run(ctx) {
    const d = ctx.deviceId;
    const reason = INSTALL_BOUNDARY_REASON;

    const expiredGrants = (await db.execute(sql`
      UPDATE diagnostic_access_grants SET status = 'expired', updated_at = now()
       WHERE device_id = ${d}::uuid AND status = 'pending_approval'
      RETURNING id`)) as unknown as Array<{ id: string }>;
    const revokedGrants = (await db.execute(sql`
      UPDATE diagnostic_access_grants
         SET status = 'revoked', revoked_at = now(), revoked_by_user_id = ${ctx.actorUserId}::uuid,
             revoke_reason = ${reason}, updated_at = now()
       WHERE device_id = ${d}::uuid AND status = 'active'
      RETURNING id`)) as unknown as Array<{ id: string }>;
    const deadGrantIds = [...expiredGrants, ...revokedGrants].map((row) => row.id);
    let approvals = 0;
    if (deadGrantIds.length > 0) {
      const expired = await db
        .update(approvalRequests)
        .set({ status: 'expired', decidedAt: ctx.at })
        .where(and(eq(approvalRequests.status, 'pending'), inArray(approvalRequests.diagnosticAccessGrantId, deadGrantIds)))
        .returning({ id: approvalRequests.id });
      approvals = expired.length;
    }

    const [callers] = (await db.execute(sql`
      SELECT count(*)::int AS n FROM caller_verifications
       WHERE org_id = ${ctx.orgId}::uuid AND workstation_device_ref = ${d}::uuid
         AND method = 'workstation' AND status IN ('pending', 'verified') AND consumed_at IS NULL`)) as unknown as Array<{ n: number }>;
    await revokeWorkstationGrantsForMove(db, ctx.orgId, d);

    const remediation = rowCount(await db.execute(sql`
      UPDATE software_remediation_requests SET expires_at = now()
       WHERE device_id = ${d}::uuid AND consumed_at IS NULL AND expires_at > now()
      RETURNING id`));

    const directives = rowCount(await db.execute(sql`
      UPDATE agent_rollback_directives
         SET status = 'expired', last_error_code = ${reason}, updated_at = now()
       WHERE device_id = ${d}::uuid AND status IN ('requested', 'in_progress')
      RETURNING id`));

    const handles = rowCount(await db.execute(sql`
      DELETE FROM provision_credential_handles WHERE device_id = ${d}::uuid RETURNING id`));

    return {
      'diagnostic_access_grants.expired': expiredGrants.length,
      'diagnostic_access_grants.revoked': revokedGrants.length,
      'approval_requests.expired': approvals,
      'caller_verifications.revoked': callers?.n ?? 0,
      'software_remediation_requests.expired': remediation,
      'agent_rollback_directives.expired': directives,
      'provision_credential_handles.deleted': handles,
    };
  },
};
