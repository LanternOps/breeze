/**
 * Destination provenance (spec "Tiers and establishment", D7/D8).
 *
 * `caller_verification_destinations` is an append-only history of hashed
 * contact email/mobile values with a source and (optional) technician
 * attestation. A destination is ESTABLISHED — and can carry tier 2 — only
 * when it is (a) at least `destinationMinAgeDays` old AND (b) human-sourced:
 * entered by a technician or explicitly attested. Import/inbound/AI provenance
 * never establishes on its own.
 *
 * Invariants enforced here:
 *  - same normalized value (any source) is a no-op: age is never renewed;
 *  - A→B→A inserts a fresh epoch for A: old age/attestation never resurrect;
 *  - an invalid/cleared value supersedes the current row but inserts nothing
 *    usable, so the contact has no destination until corrected.
 *
 * Every writer of `contacts.email` / `contacts.mobile` must call
 * `recordDestinationChangeWithExecutor` inside its own transaction (pinned by
 * writers.test.ts). The contact advisory lock serializes this with starts.
 */
import { createHash } from 'node:crypto';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { db, assertInTransaction } from '../../db';
import { callerVerificationDestinations as d } from '../../db/schema/callerVerification';
import type { ContactExecutor } from '../contacts/compat';
import type { DestinationSource, DestinationRow, CallerVerificationActor } from './types';
import type { EffectiveCallerVerificationPolicy } from './policy';
import { reachableContact } from './access';
import { CallerVerificationValidationError as Invalid } from './errors';

export type DestinationKind = 'email' | 'mobile';

export function normalizeDestination(kind: DestinationKind, value: string | null | undefined): string | null {
  if (!value) return null;
  const v = kind === 'email' ? value.trim().toLowerCase() : value.replace(/[\s().-]/g, '');
  // Mobile must be E.164 with an explicit country code; a national number is
  // never guessed into one.
  return (kind === 'email' ? /^[^@\s]+@[^@\s]+$/ : /^\+[1-9][0-9]{7,14}$/).test(v) ? v : null;
}

export const destinationHash = (value: string): string => createHash('sha256').update(value).digest('hex');

export function redactDestination(kind: DestinationKind, value: string): string {
  return (kind === 'email' ? `${value[0]}***@${value.split('@')[1]}` : `+***${value.slice(-2)}`).slice(0, 64);
}

export interface DestinationChange {
  orgId: string;
  contactId: string;
  kind: DestinationKind;
  value: string | null | undefined;
  source: DestinationSource;
  userId: string | null;
}

export async function recordDestinationChange(input: DestinationChange): Promise<void> {
  assertInTransaction('recordDestinationChange');
  await recordDestinationChangeWithExecutor(db, input);
}

/** Executor overload: preserves the caller's transaction handle (CRUD `tx`). */
export async function recordDestinationChangeWithExecutor(exec: ContactExecutor, input: DestinationChange): Promise<void> {
  await exec.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`caller-contact:${input.orgId}:${input.contactId}`}))`);
  const [old] = await exec.select().from(d)
    .where(and(eq(d.orgId, input.orgId), eq(d.contactId, input.contactId), eq(d.kind, input.kind), isNull(d.supersededAt)))
    .limit(1);
  const value = normalizeDestination(input.kind, input.value);
  const hash = value ? destinationHash(value) : null;
  if ((old?.valueHash ?? null) === hash) return;
  if (old) await exec.update(d).set({ supersededAt: new Date() }).where(eq(d.id, old.id));
  if (value && hash) {
    await exec.insert(d).values({
      orgId: input.orgId,
      contactId: input.contactId,
      kind: input.kind,
      valueHash: hash,
      valueRedacted: redactDestination(input.kind, value),
      source: input.source,
      setByUserId: input.userId,
    });
  }
}

export async function currentDestination(orgId: string, contactId: string, kind: DestinationKind): Promise<DestinationRow | null> {
  const [row] = await db.select().from(d)
    .where(and(eq(d.orgId, orgId), eq(d.contactId, contactId), eq(d.kind, kind), isNull(d.supersededAt)))
    .limit(1);
  return row ?? null;
}

export function isEstablished(row: DestinationRow, policy: EffectiveCallerVerificationPolicy, now = new Date()): boolean {
  return row.supersededAt === null
    && row.setAt.getTime() <= now.getTime() - policy.destinationMinAgeDays * 86400000
    && (row.source === 'technician' || row.attestedAt !== null)
    && (!policy.requireAttestedDestination || row.attestedAt !== null);
}

/**
 * A technician vouches for the CURRENT destination after confirming it out of
 * band. Refuses when the contact's stored value no longer hashes to this row
 * (correct the contact first) or the row was superseded meanwhile.
 */
export async function attestDestination(actor: CallerVerificationActor, orgId: string, destinationId: string): Promise<DestinationRow> {
  const [row] = await db.select().from(d).where(and(eq(d.id, destinationId), eq(d.orgId, orgId))).limit(1);
  if (!row) throw new Invalid('not_found', 'Destination not found');
  const contact = await reachableContact(actor, orgId, row.contactId);
  const normalized = normalizeDestination(row.kind, contact[row.kind]);
  if (!normalized || destinationHash(normalized) !== row.valueHash) {
    throw new Invalid('destination_changed', 'Correct the current destination before attesting it');
  }
  await db.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`caller-contact:${orgId}:${row.contactId}`}))`);
  const [updated] = await db.update(d)
    .set({ attestedAt: new Date(), attestedByUserId: actor.userId })
    .where(and(eq(d.id, row.id), eq(d.orgId, orgId), isNull(d.supersededAt)))
    .returning();
  if (!updated) throw new Invalid('destination_changed', 'Destination was superseded');
  await db.execute(sql`INSERT INTO audit_logs(org_id,actor_type,actor_id,action,resource_type,resource_id,result)
    VALUES(${orgId}::uuid,'user',${actor.userId}::uuid,'caller_verification.destination_attested','caller_verification',${row.id}::uuid,'success')`);
  return updated;
}
