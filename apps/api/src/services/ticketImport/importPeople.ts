import { and, eq, sql } from 'drizzle-orm';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import { contactExternalLinks, contacts } from '../../db/schema';
import { createContact, matchContactByEmail, normalizeContactEmail } from '../contacts/crud';
import { INBOUND_CONTACT_LOCK_NAMESPACE } from '../inboundEmail/resolveOrg';
import type { ImportedContactRequest } from './importedTicket';

/**
 * Created contacts (#8313 W4b; spec
 * docs/superpowers/specs/api-platform/2026-10-19-ticket-import-modules-design.md
 * §5.3 item 6, §5.13): the writer's resolution of a `{ createContact }`
 * requester, and the dry run's prediction of it.
 *
 * The resolution runs inside the ticket's header transaction, under the
 * window's org context, so a contact is created only for a ticket that is
 * actually written, and rolls back with it. In order:
 *   1. this source's link for (org, source user key): its contact;
 *   2. exactly one contact of the org with the email: that one, with no link
 *      (the import did not create it);
 *   3. none: `createContact` (no roles, so no portal access; destination
 *      source `import`), then the link: `contact_external_links` with system
 *      `ticket-import:<sourceId>` and the source user key as external id;
 *   4. several (a shared mailbox), or the match vanished: display-only.
 *
 * Steps 2 to 4 run after the advisory lock on (org, lower(email)) of the
 * inbound pipeline's own namespace (INBOUND_CONTACT_LOCK_NAMESPACE, F36), so
 * the import, live inbound mail and the portal invite never create the same
 * person twice. The link is the record of each creation and the marker of a
 * created contact (no column is added to `contacts`).
 *
 * Side effects: none. `createContact` emits no event, writes no audit row and
 * sends nothing; this file adds none either (ticketService.sideEffects.test.ts
 * scans it). The run's audit row carries the count.
 */

/** The `contact_external_links.system` of the contacts a source created. */
export function importContactSystem(sourceId: string): string {
  return `ticket-import:${sourceId}`;
}

/** What the header transaction does with a `{ createContact }` requester. */
export type ImportRequesterResolution =
  | { kind: 'linked' | 'matched' | 'created'; contactId: string }
  | { kind: 'display_only'; reason: 'unusable_address' | 'shared_mailbox' | 'vanished' };

export type ImportRequesterInput = {
  orgId: string;
  sourceId: string;
  request: ImportedContactRequest;
};

/** The contact of this source's link for (org, source user key), pinned FOR KEY SHARE, or null. */
async function linkedContact(orgId: string, system: string, sourceUserKey: string): Promise<string | null> {
  const [link] = await db
    .select({ contactId: contactExternalLinks.contactId })
    .from(contactExternalLinks)
    .where(and(
      eq(contactExternalLinks.orgId, orgId),
      eq(contactExternalLinks.system, system),
      eq(contactExternalLinks.externalId, sourceUserKey),
    ))
    .limit(1);
  if (!link) return null;
  // The ticket's requester FK takes the same lock on the same parent: taking it
  // here keeps the order matchContactByEmail uses (#3911). The link cascades
  // with its contact, so a link always has one; the pin closes a concurrent
  // delete between the two reads.
  const [pinned] = await db
    .select({ id: contacts.id })
    .from(contacts)
    .where(and(eq(contacts.id, link.contactId), eq(contacts.orgId, orgId)))
    .for('key share')
    .limit(1);
  return pinned?.id ?? null;
}

/**
 * Resolves a `{ createContact }` requester (§5.13). Must run inside the
 * ticket's header transaction, under the window's org context: the lock is
 * transaction-scoped and the created rows commit or roll back with the ticket.
 */
export async function resolveImportRequester(input: ImportRequesterInput): Promise<ImportRequesterResolution> {
  const { orgId, request } = input;
  const system = importContactSystem(input.sourceId);
  const linked = await linkedContact(orgId, system, request.sourceUserKey);
  if (linked) return { kind: 'linked', contactId: linked };

  const email = normalizeContactEmail(request.email);
  if (!email) return { kind: 'display_only', reason: 'unusable_address' };
  await db.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext(${INBOUND_CONTACT_LOCK_NAMESPACE}), hashtext(${`${orgId}:${email}`}))`,
  );

  const found = await matchContactByEmail(db, orgId, email);
  if (found.kind === 'contact') return { kind: 'matched', contactId: found.contactId };
  if (found.kind === 'none') {
    return { kind: 'display_only', reason: found.reason === 'shared-mailbox' ? 'shared_mailbox' : found.reason === 'vanished' ? 'vanished' : 'unusable_address' };
  }

  const created = await createContact(
    db,
    { orgId, email, name: request.name ?? null, roles: [] },
    { userId: null, destinationSource: 'import' },
  );
  // The link's updated_at is the contact's as the import left it: createContact
  // stamps it again after its insert (the legacy roles sync, on the API's
  // clock), so "edited since the import" is a later contact updated_at than
  // the link's, both on the same clock (createdContacts.ts).
  const [stamped] = await db
    .select({ updatedAt: contacts.updatedAt })
    .from(contacts)
    .where(and(eq(contacts.id, created.id), eq(contacts.orgId, orgId)))
    .limit(1);
  // A link of this source for the same person can only race another run of
  // the same source, which W4's one active run per source rules out; a unique
  // violation here rolls the whole header back, contact included, and the
  // ticket is retried by the next run.
  await db.insert(contactExternalLinks).values({
    contactId: created.id,
    orgId,
    system,
    externalId: request.sourceUserKey,
    createdBy: null,
    ...(stamped ? { updatedAt: stamped.updatedAt } : {}),
  });
  return { kind: 'created', contactId: created.id };
}

/** What a dry run predicts for a `{ createContact }` requester (§5.10 `predicted.contactsToCreate`). */
export type ImportRequesterPrediction = 'linked' | 'matched' | 'create' | 'display_only';

/**
 * The dry run's answer for one requester, read-only in `context` (the run's
 * contact lookup context): the same order as `resolveImportRequester`, with
 * no lock and no write. Deduplication across the run's tickets is the
 * caller's (the run's cursor).
 */
export async function predictImportRequester(
  context: DbAccessContext,
  input: ImportRequesterInput,
): Promise<ImportRequesterPrediction> {
  const { orgId, request } = input;
  const system = importContactSystem(input.sourceId);
  return withDbAccessContext(context, async () => {
    const [link] = await db
      .select({ contactId: contactExternalLinks.contactId })
      .from(contactExternalLinks)
      .where(and(
        eq(contactExternalLinks.orgId, orgId),
        eq(contactExternalLinks.system, system),
        eq(contactExternalLinks.externalId, request.sourceUserKey),
      ))
      .limit(1);
    if (link) return 'linked';
    const email = normalizeContactEmail(request.email);
    if (!email) return 'display_only';
    const found = await db
      .select({ id: contacts.id })
      .from(contacts)
      .where(and(eq(contacts.orgId, orgId), sql`lower(${contacts.email}) = ${email}`))
      .limit(2);
    if (found.length === 0) return 'create';
    return found.length === 1 ? 'matched' : 'display_only';
  });
}
