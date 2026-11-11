import { and, asc, eq, gt, sql, type SQL } from 'drizzle-orm';
import { db } from '../../db';
import { contactExternalLinks, contacts } from '../../db/schema';
import { lockOrganizationForProjection } from '../contacts/compat';
import { deleteContact, normalizeContactEmail, type ContactActor } from '../contacts/crud';
import { INBOUND_CONTACT_LOCK_NAMESPACE } from '../inboundEmail/resolveOrg';
import { importContactSystem } from './importPeople';
import { activeRunOf, lockSource, lockSourceShared, runActive } from './sourceStore';

/**
 * The contacts a source created, listed and removed as a set (#8313 W4b;
 * spec 2026-10-19 §5.7, §5.13). Every read and write runs in a context the
 * caller opens (a partner-wide admin's), so RLS confines them to the
 * partner's orgs.
 *
 * The set is the contacts linked with the source's system,
 * `contact_external_links WHERE system = 'ticket-import:<sourceId>'`. The
 * routes answer only while the source exists (404 after a delete); the link
 * rows stay with their contacts, exported and erased with the org, so after a
 * source is deleted the same query, run by hand, still finds the set.
 *
 * A contact is kept, not removed, once it is no longer "as imported"
 * (`KeptReason`). Removal is never refused because tickets the import wrote
 * reference the contact: such a ticket keeps its submitter snapshot and the
 * FK sets `requester_contact_id` to NULL (F37), where an import with the
 * option off would have left it.
 *
 * Every FK to `contacts` was decided (spec §5.13 "Decided in W4b"):
 *   - `contact_external_links`: this source's link is the marker (cascades
 *     with the contact); any other system's link is `other_link`;
 *   - `portal_users.contact_id` (SET NULL): `portal_login`;
 *   - `contact_roles` (cascade), and `contacts.roles`: `role`;
 *   - `tickets.requester_contact_id` (SET NULL): `in_use` for a ticket the
 *     import of this source did not write (a live ticket inbound mail or a
 *     technician attached later); the import's own tickets never keep it;
 *   - `report_schedule_recipients`, `manual_assets.assigned_contact_id`,
 *     `ai_operator_task_targets`, `caller_verification_subject_bindings`,
 *     `caller_verifications`: any row is `in_use` (the import writes none);
 *   - `caller_verification_destinations`: `in_use` for a row from any source
 *     but `import`, or an attested one (createContact records the imported
 *     email as an `import` destination, which does not count).
 */

export type KeptReason = 'portal_login' | 'role' | 'other_link' | 'edited' | 'in_use';
export const KEPT_REASONS: readonly KeptReason[] = ['portal_login', 'role', 'other_link', 'edited', 'in_use'];

/** The source whose set is read: its id (the link system) and principal (its import-written tickets). */
export type CreatedContactsScope = { sourceId: string; principalId: string };

export type CreatedContactView = {
  contactId: string;
  orgId: string;
  name: string | null;
  email: string | null;
  /** The source person's key (the link's external id). */
  sourceUserKey: string;
  createdAt: Date;
  /** Why a removal would keep it; empty when it is still as imported. */
  keptBecause: KeptReason[];
};

/** At most this many contacts are deleted by one removal call; the response says how many remain. */
export const CREATED_CONTACTS_REMOVE_BATCH = 500;

/** Each skip condition, over the outer `contacts` row and its `contact_external_links` row. */
function keptConditions(scope: CreatedContactsScope): Record<KeptReason, SQL> {
  const system = importContactSystem(scope.sourceId);
  const c = contacts.id;
  return {
    portal_login: sql`EXISTS (SELECT 1 FROM portal_users pu WHERE pu.contact_id = ${c})`,
    role: sql`(cardinality(${contacts.roles}) > 0 OR EXISTS (SELECT 1 FROM contact_roles cr WHERE cr.contact_id = ${c}))`,
    other_link: sql`EXISTS (SELECT 1 FROM contact_external_links ol WHERE ol.contact_id = ${c} AND ol.system <> ${system})`,
    // The import set the link's updated_at to the contact's as it left it (importPeople.ts).
    edited: sql`${contacts.updatedAt} > ${contactExternalLinks.updatedAt}`,
    in_use: sql`(
      EXISTS (SELECT 1 FROM tickets t
        WHERE t.requester_contact_id = ${c}
          AND NOT (t.migration_window_id IS NOT NULL AND EXISTS (
            SELECT 1 FROM ticket_external_refs r
            WHERE r.partner_service_principal_id = ${scope.principalId}
              AND (r.ticket_id = t.id OR r.origin_ticket_id = t.id))))
      OR EXISTS (SELECT 1 FROM report_schedule_recipients x WHERE x.contact_id = ${c})
      OR EXISTS (SELECT 1 FROM manual_assets x WHERE x.assigned_contact_id = ${c})
      OR EXISTS (SELECT 1 FROM ai_operator_task_targets x WHERE x.contact_id = ${c})
      OR EXISTS (SELECT 1 FROM caller_verification_subject_bindings x WHERE x.contact_id = ${c})
      OR EXISTS (SELECT 1 FROM caller_verifications x WHERE x.contact_id = ${c})
      OR EXISTS (SELECT 1 FROM caller_verification_destinations x
        WHERE x.contact_id = ${c} AND (x.source <> 'import' OR x.attested_at IS NOT NULL)))`,
  };
}

function anyKept(conditions: Record<KeptReason, SQL>): SQL {
  return sql`(${sql.join(KEPT_REASONS.map((r) => conditions[r]), sql` OR `)})`;
}

/** The set: the links of this source joined to their contacts (same org, by the composite FK). */
function inSet(scope: CreatedContactsScope): SQL {
  return eq(contactExternalLinks.system, importContactSystem(scope.sourceId));
}

function setQuery(fields: Record<string, unknown>) {
  return db
    .select(fields as never)
    .from(contactExternalLinks)
    .innerJoin(contacts, and(eq(contacts.id, contactExternalLinks.contactId), eq(contacts.orgId, contactExternalLinks.orgId)));
}

function keptFlags(conditions: Record<KeptReason, SQL>) {
  return Object.fromEntries(KEPT_REASONS.map((r) => [r, sql<boolean>`${conditions[r]}`])) as Record<KeptReason, SQL<boolean>>;
}

function reasonsOf(row: Record<string, unknown>): KeptReason[] {
  return KEPT_REASONS.filter((r) => row[r] === true);
}

/** One page of the source's created contacts, in contact id order after `after`. */
export async function listCreatedContacts(
  scope: CreatedContactsScope,
  page: { after?: string; limit?: number } = {},
): Promise<{ contacts: CreatedContactView[]; next: string | null }> {
  const limit = Math.min(500, Math.max(1, page.limit ?? 100));
  const conditions = keptConditions(scope);
  const rows = await setQuery({
    contactId: contacts.id,
    orgId: contacts.orgId,
    name: contacts.name,
    email: contacts.email,
    sourceUserKey: contactExternalLinks.externalId,
    createdAt: contactExternalLinks.createdAt,
    ...keptFlags(conditions),
  })
    .where(page.after ? and(inSet(scope), gt(contacts.id, page.after)) : inSet(scope))
    .orderBy(asc(contacts.id))
    .limit(limit + 1) as unknown as Array<Record<string, unknown> & Omit<CreatedContactView, 'keptBecause'>>;
  const pageRows = rows.slice(0, limit);
  return {
    contacts: pageRows.map((row) => ({
      contactId: row.contactId,
      orgId: row.orgId,
      name: row.name,
      email: row.email,
      sourceUserKey: row.sourceUserKey,
      createdAt: row.createdAt,
      keptBecause: reasonsOf(row),
    })),
    next: rows.length > limit ? pageRows[pageRows.length - 1]!.contactId : null,
  };
}

export type RemovedContact = { contactId: string; orgId: string; name: string | null; isPrimary: boolean };

export type RemoveCreatedContactsResult = {
  removed: RemovedContact[];
  /** Contacts of the set kept because they are no longer as imported, after this call. */
  skipped: number;
  /** Per reason; a contact kept for several reasons counts under each. */
  skippedBy: Record<KeptReason, number>;
  /** Contacts still as imported left for the next call (past the batch, or after a stop). */
  remaining: number;
  /** Set when the call stopped early: a run of the source started meanwhile. */
  stoppedBy: 'run_active' | null;
};

export type RemoveCreatedContactsInput = {
  partnerId: string;
  sourceId: string;
  actor: ContactActor;
  /**
   * Opens one transaction in the caller's context (the route: the request's
   * auth context). Removal runs one short transaction to choose the batch,
   * one per contact, and one to count, so no lock is held across the batch.
   */
  transaction: <T>(fn: () => Promise<T>) => Promise<T>;
  batch?: number;
  /** Tests only: runs after the batch is chosen, before each contact's transaction. */
  beforeContact?: (contactId: string) => Promise<void>;
};

type ContactStep = { kind: 'removed'; contact: RemovedContact } | { kind: 'kept' | 'gone' } | { kind: 'run_active' };

/**
 * Removes up to `batch` of the source's created contacts that are still as
 * imported (§5.13), each through `deleteContact`, the live delete path (the
 * route writes its live `contact.delete` audit row per contact).
 *
 * 1. Choose: under the source lock (FOR UPDATE, as a run's start takes it),
 *    refuse while a run is queued or running (409), then select the batch in
 *    SQL, the skip conditions in the WHERE.
 * 2. Per contact, in its own transaction: the source FOR SHARE and the run
 *    check again (a run started since stops the call: `stoppedBy`), the
 *    inbound pipeline's (org, lower(email)) advisory lock (the same one the
 *    portal invite and inbound mail take before they attach a contact), the
 *    org projection lock and the contact FOR UPDATE (deleteContact's parent-
 *    first order), then every skip condition again; only then the delete. A
 *    contact that became ineligible since step 1 is kept and counted under
 *    its reason.
 * 3. Count: `skippedBy` and `remaining` from one aggregate query.
 */
export async function removeCreatedContacts(input: RemoveCreatedContactsInput): Promise<RemoveCreatedContactsResult> {
  const batch = Math.max(1, input.batch ?? CREATED_CONTACTS_REMOVE_BATCH);
  const { candidates, scope } = await input.transaction(async () => {
    const source = await lockSource(input.partnerId, input.sourceId);
    const active = await activeRunOf(input.sourceId);
    if (active) throw runActive(active);
    const sc: CreatedContactsScope = { sourceId: input.sourceId, principalId: source.principalId };
    const rows = await setQuery({ contactId: contacts.id, orgId: contacts.orgId, email: contacts.email })
      .where(and(inSet(sc), sql`NOT ${anyKept(keptConditions(sc))}`))
      .orderBy(asc(contacts.id))
      .limit(batch) as unknown as Array<{ contactId: string; orgId: string; email: string | null }>;
    return { candidates: rows, scope: sc };
  });

  const removed: RemovedContact[] = [];
  let stoppedBy: RemoveCreatedContactsResult['stoppedBy'] = null;
  for (const candidate of candidates) {
    await input.beforeContact?.(candidate.contactId);
    const step = await input.transaction((): Promise<ContactStep> => removeOne(input, scope, candidate));
    if (step.kind === 'run_active') {
      stoppedBy = 'run_active';
      break;
    }
    if (step.kind === 'removed') removed.push(step.contact);
  }

  const counts = await input.transaction(async () => {
    const conditions = keptConditions(scope);
    const [row] = await setQuery({
      skipped: sql<number>`count(*) FILTER (WHERE ${anyKept(conditions)})::int`,
      remaining: sql<number>`count(*) FILTER (WHERE NOT ${anyKept(conditions)})::int`,
      ...Object.fromEntries(KEPT_REASONS.map((r) => [r, sql<number>`count(*) FILTER (WHERE ${conditions[r]})::int`])),
    }).where(inSet(scope)) as unknown as Array<Record<string, number>>;
    return row ?? {};
  });
  const skippedBy = Object.fromEntries(KEPT_REASONS.map((r) => [r, Number(counts[r] ?? 0)])) as Record<KeptReason, number>;
  return { removed, skipped: Number(counts.skipped ?? 0), skippedBy, remaining: Number(counts.remaining ?? 0), stoppedBy };
}

async function removeOne(
  input: RemoveCreatedContactsInput,
  scope: CreatedContactsScope,
  candidate: { contactId: string; orgId: string; email: string | null },
): Promise<ContactStep> {
  // A run that started since the batch was chosen: stop before touching more.
  await lockSourceShared(input.partnerId, input.sourceId);
  if (await activeRunOf(input.sourceId)) return { kind: 'run_active' };
  const email = normalizeContactEmail(candidate.email);
  if (email) {
    await db.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${INBOUND_CONTACT_LOCK_NAMESPACE}), hashtext(${`${candidate.orgId}:${email}`}))`,
    );
  }
  await lockOrganizationForProjection(db, candidate.orgId);
  const [locked] = await db
    .select({ id: contacts.id })
    .from(contacts)
    .where(and(eq(contacts.id, candidate.contactId), eq(contacts.orgId, candidate.orgId)))
    .limit(1)
    .for('update');
  if (!locked) return { kind: 'gone' };
  // Every skip condition again, under the locks: a role, an edit, a login or
  // a live ticket committed since the batch was chosen keeps the contact.
  const [row] = await setQuery({ contactId: contacts.id, ...keptFlags(keptConditions(scope)) })
    .where(and(inSet(scope), eq(contacts.id, candidate.contactId)))
    .limit(1) as unknown as Array<Record<string, unknown>>;
  if (!row) return { kind: 'gone' };
  if (reasonsOf(row).length > 0) return { kind: 'kept' };
  const deleted = await deleteContact(db, candidate.contactId, candidate.orgId, input.actor);
  if (!deleted) return { kind: 'gone' };
  return { kind: 'removed', contact: { contactId: deleted.id, orgId: deleted.orgId, name: deleted.name, isPrimary: deleted.isPrimary } };
}
