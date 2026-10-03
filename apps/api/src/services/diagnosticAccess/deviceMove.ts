/**
 * Device org-move hook: a diagnostic access grant was approved by an
 * administrator of the device's ORIGINAL organization, for that organization's
 * technician. Once the device leaves the org the approval no longer speaks for
 * anyone, so every pending request expires and every active grant is revoked.
 *
 * `revokeDiagnosticGrantsForMove` is called by the shared move engine
 * (services/deviceOrgMove/moveDeviceOrgInTransaction.ts, used by the admin
 * move route and by parked-device assignment) inside its `tx`, after the
 * device row is locked FOR UPDATE and before `UPDATE devices SET org_id` (whose
 * breeze_cascade_device_org_id() trigger restamps grant rows to the new org —
 * restamped rows are already dead by then). Undelivered diag commands stop at
 * delivery (the refresher re-reads the grant); an authorization already
 * delivered names the old org and fails the agent's org check.
 */
import { sql } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import type { Tx } from '../callerVerification/locks';

export async function revokeDiagnosticGrantsForMove(
  tx: Tx,
  sourceOrgId: string,
  deviceId: string,
  actorUserId: string,
): Promise<void> {
  await tx.execute(sql`UPDATE diagnostic_access_grants
    SET status = 'expired', updated_at = NOW()
    WHERE org_id = ${sourceOrgId}::uuid AND device_id = ${deviceId}::uuid AND status = 'pending_approval'`);
  await tx.execute(sql`UPDATE diagnostic_access_grants
    SET status = 'revoked', revoked_at = NOW(), revoked_by_user_id = ${actorUserId}::uuid,
        revoke_reason = 'device moved to another organization', updated_at = NOW()
    WHERE org_id = ${sourceOrgId}::uuid AND device_id = ${deviceId}::uuid AND status = 'active'`);
}

/**
 * Post-commit half: expire every approver's still-pending approval row for a
 * grant the move killed. approval_requests is visible per approver, so the
 * mover's own transaction only reaches their own rows; this runs in system
 * scope after the move committed. Best effort — a leftover row can only be
 * answered with 409 (the grant is no longer pending) until it lapses.
 */
export async function expireDiagnosticApprovalsForMovedDevice(deviceId: string): Promise<void> {
  await runOutsideDbContext(() =>
    withSystemDbAccessContext(() =>
      db.execute(sql`UPDATE approval_requests SET status = 'expired', decided_at = NOW()
        WHERE status = 'pending' AND diagnostic_access_grant_id IN (
          SELECT id FROM diagnostic_access_grants
          WHERE device_id = ${deviceId}::uuid AND status IN ('expired', 'revoked'))`),
    ),
  );
}
