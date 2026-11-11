import { and, asc, eq, gt, sql } from 'drizzle-orm';
import { db } from '../../db';
import { contactExternalLinks, contactRoles, contacts, portalUsers } from '../../db/schema';
import { deleteContact, type ContactActor } from '../contacts/crud';
import { importContactSystem } from './importPeople';

/**
 * The contacts a source created, listed and removed as a set (#8313 W4b;
 * spec 2026-10-19 §5.13, routes §5.7). Both run in the caller's request
 * context (a partner-wide admin), so RLS confines them to the partner's orgs.
 *
 * The set is the contacts linked with the source's system,
 * `contact_external_links WHERE system = 'ticket-import:<sourceId>'`: the
 * same query answers after the source is deleted, as the link rows stay with
 * their contacts (exported and erased with the org).
 *
 * A contact is kept, not removed, once it is no longer "as imported":
 *   - `portal_login`: a portal user is linked to it;
 *   - `role`: it holds a role (`contacts.roles` or a `contact_roles` row);
 *   - `other_link`: another system linked it too (a PSA sync, a CSV import);
 *   - `edited`: it was changed after the import created it: its `updated_at`
 *     is later than its link's, which the import set to the contact's own
 *     `updated_at` when it linked it (importPeople.ts).
 * Removal is never refused because tickets reference the contact: a ticket
 * keeps its submitter snapshot and the FK sets `requester_contact_id` to NULL
 * (F37), which is where an import with the option off would have left it.
 */

export type KeptReason = 'portal_login' | 'role' | 'other_link' | 'edited';

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

function rowsQuery(system: string) {
  return db
    .select({
      contactId: contacts.id,
      orgId: contacts.orgId,
      name: contacts.name,
      email: contacts.email,
      sourceUserKey: contactExternalLinks.externalId,
      createdAt: contactExternalLinks.createdAt,
      portalLogin: sql<boolean>`EXISTS (SELECT 1 FROM ${portalUsers} pu WHERE pu.contact_id = ${contacts.id})`,
      role: sql<boolean>`(cardinality(${contacts.roles}) > 0
        OR EXISTS (SELECT 1 FROM ${contactRoles} cr WHERE cr.contact_id = ${contacts.id}))`,
      otherLink: sql<boolean>`EXISTS (SELECT 1 FROM ${contactExternalLinks} ol
        WHERE ol.contact_id = ${contacts.id} AND ol.system <> ${system})`,
      edited: sql<boolean>`${contacts.updatedAt} > ${contactExternalLinks.updatedAt}`,
    })
    .from(contactExternalLinks)
    .innerJoin(contacts, and(eq(contacts.id, contactExternalLinks.contactId), eq(contacts.orgId, contactExternalLinks.orgId)))
    .where(eq(contactExternalLinks.system, system))
    .$dynamic();
}

type Row = Awaited<ReturnType<typeof rowsQuery>>[number];

function view(row: Row): CreatedContactView {
  const keptBecause: KeptReason[] = [];
  if (row.portalLogin) keptBecause.push('portal_login');
  if (row.role) keptBecause.push('role');
  if (row.otherLink) keptBecause.push('other_link');
  if (row.edited) keptBecause.push('edited');
  return {
    contactId: row.contactId,
    orgId: row.orgId,
    name: row.name,
    email: row.email,
    sourceUserKey: row.sourceUserKey,
    createdAt: row.createdAt,
    keptBecause,
  };
}

/** One page of the source's created contacts, in contact id order after `after`. */
export async function listCreatedContacts(
  sourceId: string,
  page: { after?: string; limit?: number } = {},
): Promise<{ contacts: CreatedContactView[]; next: string | null }> {
  const limit = Math.min(500, Math.max(1, page.limit ?? 100));
  const system = importContactSystem(sourceId);
  const query = rowsQuery(system);
  const rows = await (page.after ? query.where(and(eq(contactExternalLinks.system, system), gt(contacts.id, page.after))) : query)
    .orderBy(asc(contacts.id))
    .limit(limit + 1);
  const pageRows = rows.slice(0, limit);
  return {
    contacts: pageRows.map(view),
    next: rows.length > limit ? pageRows[pageRows.length - 1]!.contactId : null,
  };
}

export type RemovedContact = { contactId: string; orgId: string; name: string | null; isPrimary: boolean };

export type RemoveCreatedContactsResult = {
  removed: RemovedContact[];
  /** Contacts kept because they are no longer as imported (`KeptReason`). */
  skipped: number;
  skippedBy: Record<KeptReason, number>;
  /** Contacts still as imported left for the next call (past CREATED_CONTACTS_REMOVE_BATCH). */
  remaining: number;
};

/**
 * Removes the source's created contacts that are still as imported, each
 * through `deleteContact` (the live delete path; the route writes its live
 * `contact.delete` audit row per contact). The caller holds the source lock
 * and has checked that no run is active, so no run creates or links one
 * meanwhile.
 */
export async function removeCreatedContacts(
  sourceId: string,
  actor: ContactActor,
  batch: number = CREATED_CONTACTS_REMOVE_BATCH,
): Promise<RemoveCreatedContactsResult> {
  const rows = (await rowsQuery(importContactSystem(sourceId)).orderBy(asc(contacts.id))).map(view);
  const skippedBy: Record<KeptReason, number> = { portal_login: 0, role: 0, other_link: 0, edited: 0 };
  const removable: CreatedContactView[] = [];
  for (const row of rows) {
    if (row.keptBecause.length === 0) {
      removable.push(row);
      continue;
    }
    for (const reason of row.keptBecause) skippedBy[reason] += 1;
  }
  const removed: RemovedContact[] = [];
  for (const row of removable.slice(0, batch)) {
    const deleted = await deleteContact(db, row.contactId, row.orgId, actor);
    // Gone meanwhile (a technician deleted it): nothing to remove or audit.
    if (deleted) removed.push({ contactId: deleted.id, orgId: deleted.orgId, name: deleted.name, isPrimary: deleted.isPrimary });
  }
  return {
    removed,
    skipped: rows.length - removable.length,
    skippedBy,
    remaining: Math.max(0, removable.length - batch),
  };
}
