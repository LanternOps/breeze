/**
 * Canonical subject bindings (spec D1, D11, D13).
 *
 * A binding ties one contact to one directory identity (Entra tenant+OID)
 * and/or one OS principal (SID / uid@host) within an org. Bindings are
 * created ONLY from trusted evidence: a server-side Graph read
 * (`directory_sync`), a technician's explicit attestation after that read
 * (`technician_attested`), or an authenticated agent session report
 * (`observed_login`). Uploaded CSV/API external ids are never evidence.
 *
 * Collisions fail closed: when a claim would give the same identity to two
 * contacts, BOTH sides are revoked (plus every unconsumed grant that named
 * them) and an audit row records the conflict. The conflicting claim commits
 * its revocations and returns a revoked row — it never throws afterwards and
 * thereby rolls the revocation back. Explicit attestation may resolve a
 * previously revoked identity; automated sync may not silently resurrect it.
 *
 * Lock order: identity namespace → (contact) → subject bindings.
 */
import { and, eq, isNull, or, sql } from 'drizzle-orm';
import { db, assertInTransaction } from '../../db';
import { callerVerificationSubjectBindings as b, callerVerifications as v } from '../../db/schema/callerVerification';
import type { BindingRow, EntraSubject, CallerVerificationActor } from './types';
import { CallerVerificationRequiredError, CallerVerificationValidationError as Invalid } from './errors';
import { reachableContact } from './access';
import { withSubjectLocks } from './locks';

const SYSTEM_ACTOR = '00000000-0000-0000-0000-000000000000';

export interface BindingClaim {
  orgId: string;
  contactId: string;
  entraTenantId: string;
  entraOid: string;
  upn: string | null;
}

export async function bindingsForContact(orgId: string, contactId: string): Promise<BindingRow[]> {
  return db.select().from(b).where(and(eq(b.orgId, orgId), eq(b.contactId, contactId), isNull(b.revokedAt)));
}

/** Exactly one active binding for the subject, or a fail-closed refusal. */
export async function resolveTargetBinding(orgId: string, subject: EntraSubject): Promise<BindingRow> {
  const rows = await db.select().from(b)
    .where(and(eq(b.orgId, orgId), eq(b.entraTenantId, subject.entraTenantId), eq(b.entraOid, subject.entraOid), isNull(b.revokedAt)))
    .limit(2);
  if (rows.length !== 1) {
    throw new CallerVerificationRequiredError({
      orgId, contactId: null, action: 'reset_password', requiredTier: 2,
      reason: rows.length ? 'subject_ambiguous' : 'subject_unmatched', latest: null,
    });
  }
  return rows[0]!;
}

function idList(ids: string[]) {
  return sql.join(ids.map((id) => sql`${id}::uuid`), sql`,`);
}

async function revokeGrantsForBindings(orgId: string, ids: string[]): Promise<void> {
  if (!ids.length) return;
  await db.execute(sql`UPDATE caller_verifications SET status='revoked'
    WHERE org_id=${orgId}::uuid AND status='verified' AND consumed_at IS NULL
    AND (requester_binding_id IN (${idList(ids)}) OR target_binding_id IN (${idList(ids)}))`);
}

async function audit(orgId: string, action: string, resourceId: string, userId: string | null): Promise<void> {
  await db.execute(sql`INSERT INTO audit_logs(org_id,actor_type,actor_id,action,resource_type,resource_id,result)
    VALUES(${orgId}::uuid,${userId ? 'user' : 'system'}::actor_type,${userId ?? SYSTEM_ACTOR}::uuid,
    ${action},'caller_verification',${resourceId}::uuid,'success')`);
}

async function claim(input: BindingClaim, source: 'directory_sync' | 'technician_attested', userId: string | null): Promise<BindingRow> {
  assertInTransaction('claimBinding');
  await db.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`caller-identity:${input.orgId}`}))`);
  const rows = await db.select().from(b)
    .where(and(eq(b.orgId, input.orgId), eq(b.entraTenantId, input.entraTenantId), eq(b.entraOid, input.entraOid)));
  const active = rows.filter((r) => !r.revokedAt);
  const same = active.find((r) => r.contactId === input.contactId);
  const conflict = active.some((r) => r.contactId !== input.contactId);
  return withSubjectLocks(db, active.map((r) => r.id), async () => {
    if (same && !conflict) {
      const [r] = await db.update(b).set({
        upnSnapshot: input.upn, updatedAt: new Date(),
        ...(source === 'technician_attested' ? { source, attestedAt: new Date(), attestedByUserId: userId } : {}),
      }).where(eq(b.id, same.id)).returning();
      return r!;
    }
    // Automated sync never resurrects an identity that was revoked for this org.
    const blocked = conflict || (source === 'directory_sync' && rows.some((r) => r.revokedAt !== null));
    if (conflict) {
      await db.update(b).set({ revokedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(b.orgId, input.orgId), eq(b.entraTenantId, input.entraTenantId), eq(b.entraOid, input.entraOid), isNull(b.revokedAt)));
      await revokeGrantsForBindings(input.orgId, active.map((r) => r.id));
    }
    const [r] = await db.insert(b).values({
      orgId: input.orgId, contactId: input.contactId, entraTenantId: input.entraTenantId, entraOid: input.entraOid,
      upnSnapshot: input.upn, source, revokedAt: blocked ? new Date() : null,
      attestedByUserId: userId, attestedAt: userId ? new Date() : null,
    }).returning();
    await audit(input.orgId, blocked ? 'caller_verification.binding_conflict' : 'caller_verification.binding_created', r!.id, userId);
    return r!;
  });
}

/** Trusted server-side directory read established this identity. */
export async function upsertDirectorySyncBinding(input: BindingClaim): Promise<void> {
  await claim(input, 'directory_sync', null);
}

/** A technician vouches for this identity after a server-side directory read. */
export async function attestBinding(actor: CallerVerificationActor, input: BindingClaim): Promise<BindingRow> {
  await reachableContact(actor, input.orgId, input.contactId);
  return claim(input, 'technician_attested', actor.userId);
}

/**
 * An authenticated agent reported a console login whose UPN matches exactly
 * one directory-bound contact in the org. Records the OS principal on that
 * binding; an OS principal already bound to a different contact is a
 * collision and revokes both sides.
 */
export async function observeLogin(input: { orgId: string; contactId: string; osPrincipal: string; osUsername: string; upn: string | null }): Promise<void> {
  if (!input.upn) return;
  assertInTransaction('observeLogin');
  await db.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`caller-identity:${input.orgId}`}))`);
  const matches = await db.select().from(b).where(and(
    eq(b.orgId, input.orgId), isNull(b.revokedAt),
    sql`${b.entraOid} IS NOT NULL AND ${b.entraTenantId} IS NOT NULL`,
    sql`lower(${b.upnSnapshot})=lower(${input.upn})`,
  )).limit(2);
  if (matches.length !== 1 || matches[0]!.contactId !== input.contactId) return;
  const target = matches[0]!;
  const others = await db.select().from(b)
    .where(and(eq(b.orgId, input.orgId), eq(b.osPrincipal, input.osPrincipal), isNull(b.revokedAt)));
  await withSubjectLocks(db, [target.id, ...others.map((r) => r.id)], async () => {
    if (others.some((r) => r.contactId !== input.contactId)) {
      const ids = [...new Set([target.id, ...others.map((r) => r.id)])];
      await db.execute(sql`UPDATE caller_verification_subject_bindings SET revoked_at=now(),updated_at=now() WHERE id IN (${idList(ids)})`);
      await revokeGrantsForBindings(input.orgId, ids);
      await audit(input.orgId, 'caller_verification.binding_conflict', target.id, null);
      return;
    }
    await db.update(b)
      .set({ osPrincipal: input.osPrincipal, osUsername: input.osUsername, source: 'observed_login', updatedAt: new Date() })
      .where(and(eq(b.id, target.id), isNull(b.revokedAt)));
  });
}

export async function revokeBinding(actor: CallerVerificationActor, orgId: string, bindingId: string): Promise<void> {
  const [row] = await db.select().from(b).where(and(eq(b.id, bindingId), eq(b.orgId, orgId))).limit(1);
  if (!row) throw new Invalid('not_found', 'Binding not found');
  await reachableContact(actor, orgId, row.contactId);
  await withSubjectLocks(db, [row.id], async () => {
    await db.update(b).set({ revokedAt: new Date(), updatedAt: new Date() }).where(eq(b.id, row.id));
    await db.update(v).set({ status: 'revoked' }).where(and(
      eq(v.orgId, orgId), isNull(v.consumedAt), eq(v.status, 'verified'),
      or(eq(v.requesterBindingId, row.id), eq(v.targetBindingId, row.id)),
    ));
    await audit(orgId, 'caller_verification.binding_revoked', row.id, actor.userId);
  });
}
