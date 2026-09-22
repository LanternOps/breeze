/**
 * Device org-move hook (#6354 W01): a workstation grant proves "someone at
 * THIS device in THIS org"; once the device leaves the org that proof is
 * void. Called from routes/devices/moveOrg.ts inside its explicit `tx`,
 * after the device row is locked FOR UPDATE and before `UPDATE devices SET
 * org_id`. Pending challenges expire, unconsumed grants are revoked;
 * consumed history is untouched (the gate rechecks the device's org under
 * the same subject locks on any retry, so a consumed-but-undispatched grant
 * cannot regain authorization after the move).
 *
 * Never opens a second DB context or uses ambient `db`: everything goes
 * through the caller's transaction handle.
 */
import { sql } from 'drizzle-orm';
import { withSubjectLocks, type Tx } from './locks';

export async function revokeWorkstationGrantsForMove(tx: Tx, sourceOrgId: string, deviceId: string): Promise<void> {
  const rows = await tx.execute(sql`SELECT requester_binding_id, target_binding_id FROM caller_verifications
    WHERE org_id=${sourceOrgId}::uuid AND workstation_device_ref=${deviceId}::uuid
    AND method='workstation' AND status IN ('pending','verified')`);
  const ids = (rows as unknown as Array<{ requester_binding_id: string | null; target_binding_id: string | null }>)
    .flatMap((r) => [r.requester_binding_id, r.target_binding_id]);
  await withSubjectLocks(tx, ids, async () => {
    await tx.execute(sql`UPDATE caller_verifications
      SET status=CASE WHEN status='pending' THEN 'expired'::caller_verification_status ELSE 'revoked'::caller_verification_status END
      WHERE org_id=${sourceOrgId}::uuid AND workstation_device_ref=${deviceId}::uuid
      AND method='workstation' AND status IN ('pending','verified') AND consumed_at IS NULL`);
  });
}
