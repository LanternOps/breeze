/**
 * Org-merge hooks for caller verification (#6354 W01).
 *
 * Subject bindings are canonical per org: the partial unique indexes
 * `cv_bindings_entra_active_uq` / `cv_bindings_os_active_uq` would 23505 on a
 * plain repoint whenever the loser and survivor both bound the same Entra OID
 * or OS principal to (possibly different) contacts. An ambiguous identity is
 * no identity, so the resolve pass revokes BOTH colliding sides and audits
 * each; the move pass then repoints; and `finishBindingMerge` runs after both
 * passes to expire the loser's pending challenges and revoke every unconsumed
 * grant whose requester/target binding was revoked. Consumed grants are
 * history and are never touched.
 *
 * All four helpers run inside the merge engine's existing system transaction.
 */
import { sql } from 'drizzle-orm';
import { db, assertInTransaction } from '../../db';
import { extractRowCount } from '../../db/rowCount';
import type { CustomMergeExecutor } from '../orgMergeCustomExecutors';

const SYSTEM_ACTOR = '00000000-0000-0000-0000-000000000000';

export const resolveBindingMerge: CustomMergeExecutor = async (loser, survivor) => {
  assertInTransaction('resolveBindingMerge');
  await db.execute(sql`WITH pairs AS (
    SELECT l.id AS l_id, s.id AS s_id FROM caller_verification_subject_bindings l
    JOIN caller_verification_subject_bindings s ON s.org_id = ${survivor}::uuid AND s.revoked_at IS NULL
      AND ((l.entra_tenant_id = s.entra_tenant_id AND l.entra_oid = s.entra_oid) OR l.os_principal = s.os_principal)
    WHERE l.org_id = ${loser}::uuid AND l.revoked_at IS NULL
  ), conflicts AS (SELECT l_id AS id FROM pairs UNION SELECT s_id FROM pairs), changed AS (
    UPDATE caller_verification_subject_bindings b SET revoked_at = now(), updated_at = now()
    FROM conflicts c WHERE b.id = c.id RETURNING b.*
  ) INSERT INTO audit_logs(org_id, actor_type, actor_id, action, resource_type, resource_id, result, details)
  SELECT org_id, 'system'::actor_type, ${SYSTEM_ACTOR}::uuid, 'caller_verification.binding_conflict',
    'caller_verification', id, 'success'::audit_result,
    jsonb_build_object('loserOrgId', ${loser}::text, 'survivorOrgId', ${survivor}::text) FROM changed`);
  return { moved: 0, dropped: 0, notes: [] };
};

export const moveBindings: CustomMergeExecutor = async (loser, survivor) => ({
  moved: extractRowCount(await db.execute(sql`UPDATE caller_verification_subject_bindings SET org_id = ${survivor}::uuid WHERE org_id = ${loser}::uuid`)),
  dropped: 0,
  notes: [],
});

/** Snapshot the loser's contact ids BEFORE the walk moves `contacts`. */
export async function captureLoserContacts(orgId: string): Promise<string[]> {
  const rows = await db.execute(sql`SELECT id FROM contacts WHERE org_id = ${orgId}::uuid`);
  return (rows as unknown as Array<{ id: string }>).map((r) => r.id);
}

export async function finishBindingMerge(ids: string[], survivorOrgId: string): Promise<void> {
  if (!ids.length) return;
  const idList = sql.join(ids.map((id) => sql`${id}::uuid`), sql`,`);
  // Loser-side: pending challenges expire, unconsumed grants are revoked.
  await db.execute(sql`UPDATE caller_verifications SET status = CASE WHEN status='pending' THEN 'expired'::caller_verification_status ELSE 'revoked'::caller_verification_status END
    WHERE contact_id IN (${idList})
    AND (status='pending' OR (status='verified' AND consumed_at IS NULL))`);
  // Survivor-side: revoke grants whose requester/target lost its canonical binding.
  await db.execute(sql`UPDATE caller_verifications v SET status='revoked' WHERE v.org_id = ${survivorOrgId}::uuid AND v.status='verified' AND v.consumed_at IS NULL
    AND EXISTS(SELECT 1 FROM caller_verification_subject_bindings b WHERE b.id IN (v.requester_binding_id, v.target_binding_id) AND b.revoked_at IS NOT NULL)`);
}
