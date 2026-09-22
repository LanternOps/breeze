/**
 * Fence-first rejection (spec D16, D18).
 *
 * "This is not me" is accepted from ANY non-rejected state, even long after
 * the challenge expired: the caller is telling us someone impersonated them.
 * In one transaction, in this order:
 *   1. the fence — the row's own status/decision timestamp (CAS);
 *   2. one security incident per verification (idempotent by source_ref);
 *   3. revoke every other unconsumed grant for the subject;
 *   4. the W05 intent-revocation seam;
 *   5. audit + ticket effects;
 *   6. incident summary with what could/could not be stopped.
 * The contact lock blocks new starts while the binding set is gathered; the
 * sorted union of subject locks is then taken before the CAS.
 *
 * `fenceOverride` lets a reviewer lift the cooling-off fence for a contact
 * with a recorded reason; it never un-rejects the verification.
 */
import { and, eq, ne, isNull, or, sql } from 'drizzle-orm';
import { db, assertInTransaction } from '../../db';
import { callerVerifications as v, callerVerificationSubjectBindings as b } from '../../db/schema/callerVerification';
import { incidents } from '../../db/schema/incidentResponse';
import type { CallerVerificationActor } from './types';
import { CallerVerificationValidationError as Invalid } from './errors';
import { getEffectivePolicy } from './policy';
import { lockContact, withSubjectLocks } from './locks';
import { reachableContact } from './access';
import { recordEffect } from './effects';
import { revokeIntentsForSubject } from '../actionIntents/revokeIntentsForSubject';

export async function handleRejection(verificationId: string): Promise<void> {
  assertInTransaction('handleRejection');
  const [initial] = await db.select().from(v).where(eq(v.id, verificationId)).limit(1);
  if (!initial) throw new Invalid('not_found', 'Verification not found');
  await lockContact(initial.orgId, initial.contactId);
  const grants = await db.select().from(v).where(and(eq(v.orgId, initial.orgId), eq(v.contactId, initial.contactId)));
  const bindings = await db.select().from(b).where(and(eq(b.orgId, initial.orgId), eq(b.contactId, initial.contactId)));
  const ids = [...bindings.map((r) => r.id), ...grants.flatMap((r) => [r.requesterBindingId, r.targetBindingId])];
  await withSubjectLocks(db, ids, async () => {
    const [fresh] = await db.select().from(v).where(eq(v.id, verificationId)).limit(1);
    if (!fresh || fresh.status === 'rejected_by_user') return;
    const [row] = await db.update(v)
      .set({ status: 'rejected_by_user', decidedAt: new Date(), fenceOverrideUntil: null, rejectionNotifiedAt: null })
      .where(and(eq(v.id, verificationId), ne(v.status, 'rejected_by_user')))
      .returning();
    if (!row) return;
    await db.insert(incidents).values({
      orgId: row.orgId,
      title: 'Caller denied an identity-change request',
      classification: 'social_engineering',
      severity: 'p2',
      status: 'detected',
      sourceType: 'caller_verification',
      sourceRef: row.id,
      affectedUsers: [row.contactId],
      detectedAt: new Date(),
      summary: 'Caller selected This is not me. Review related identity actions.',
    }).onConflictDoNothing({ target: [incidents.orgId, incidents.sourceType, incidents.sourceRef], where: sql`${incidents.sourceRef} IS NOT NULL` });
    await db.update(v).set({ status: 'revoked' }).where(and(
      eq(v.orgId, row.orgId), ne(v.id, row.id), eq(v.status, 'verified'), isNull(v.consumedAt),
      or(
        eq(v.contactId, row.contactId),
        sql`${v.targetBindingId} IN (SELECT id FROM caller_verification_subject_bindings WHERE contact_id=${row.contactId}::uuid AND org_id=${row.orgId}::uuid)`,
      ),
    ));
    const outcome = await revokeIntentsForSubject({ orgId: row.orgId, bindingIds: bindings.map((r) => r.id), verificationId: row.id });
    await recordEffect(row, 'rejected');
    const summary = `Caller rejection fenced the subject. Already executing: ${outcome.alreadyExecuting.join(', ') || 'none'}. `
      + `Dispatched before rejection; confirm in Entra whether the change landed: ${outcome.alreadyDispatched.join(', ') || 'none'}.`;
    await db.execute(sql`UPDATE incidents SET summary=${summary}
      WHERE org_id=${row.orgId}::uuid AND source_type='caller_verification' AND source_ref=${row.id}`);
  });
}

export async function fenceOverride(actor: CallerVerificationActor, orgId: string, contactId: string, reason: string): Promise<void> {
  if (reason.trim().length < 20) throw new Invalid('invalid_reason', 'Override reason must contain at least 20 characters');
  await reachableContact(actor, orgId, contactId);
  await lockContact(orgId, contactId);
  const bindings = await db.select().from(b).where(and(eq(b.orgId, orgId), eq(b.contactId, contactId)));
  const p = await getEffectivePolicy(orgId);
  await withSubjectLocks(db, bindings.map((r) => r.id), async () => {
    await db.update(v)
      .set({ fenceOverrideUntil: sql`${v.decidedAt}+(${p.coolingOffHours}*interval '1 hour')` })
      .where(and(eq(v.orgId, orgId), eq(v.contactId, contactId), eq(v.status, 'rejected_by_user')));
    await db.execute(sql`INSERT INTO audit_logs(org_id,actor_type,actor_id,action,resource_type,resource_id,result,details)
      VALUES(${orgId}::uuid,'user',${actor.userId}::uuid,'caller_verification.fence_override','caller_verification',${contactId}::uuid,'success',${JSON.stringify({ reason: reason.trim() })}::jsonb)`);
  });
}
