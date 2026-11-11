import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import { contacts, ticketExternalRefs, users } from '../../db/schema';

/**
 * The Breeze reads a slice makes for the ledger and for a conversion (#8313
 * W4; spec 2026-10-19 §5.2, §5.8, §5.9). Each runs in the narrowest context
 * that answers it, and none writes.
 */

const SLICE = 500;

function lowerEmails(emails: readonly string[] | undefined): string[] {
  return [...new Set((emails ?? []).map((e) => e.trim().toLowerCase()).filter((e) => e.length > 0 && e.length <= 320))];
}

/**
 * Users the import may assign this org's ticket to, by lower-cased email: of
 * the partner, with an org that is null or the ticket's (deactivated users
 * included, as import eligibility accepts them, F16). System scope with an
 * explicit partner predicate, as `assertImportAssigneeEligible` does.
 */
export async function eligibleUsersByEmail(partnerId: string, orgId: string, emails: readonly string[] | undefined): Promise<Map<string, string>> {
  const wanted = lowerEmails(emails);
  const out = new Map<string, string>();
  if (wanted.length === 0) return out;
  await withSystemDbAccessContext(async () => {
    for (let i = 0; i < wanted.length; i += SLICE) {
      const rows = await db
        .select({ id: users.id, email: sql<string>`lower(${users.email})` })
        .from(users)
        .where(and(
          eq(users.partnerId, partnerId),
          or(isNull(users.orgId), eq(users.orgId, orgId)),
          inArray(sql`lower(${users.email})`, wanted.slice(i, i + SLICE)),
        ));
      for (const row of rows) out.set(row.email, row.id);
    }
  }, 'ticketImport.lookupUsers');
  return out;
}

/**
 * The run's read-only context for contacts: partner scope limited to the orgs
 * the run may import into (the window's on an import, the mapped ones on a
 * dry run), with no user.
 */
export function contactLookupContext(partnerId: string, orgIds: readonly string[]): DbAccessContext {
  return {
    scope: 'partner',
    orgId: null,
    accessibleOrgIds: [...orgIds],
    accessiblePartnerIds: [partnerId],
    currentPartnerId: partnerId,
    userId: null,
    label: 'ticketImport.lookupContacts',
  };
}

/**
 * Contacts of one org by lower-cased email, only where exactly one contact
 * has the address (`matchContactByEmail`'s rule, F15: a shared mailbox is no
 * match). Read-only, in `context`.
 */
export async function singleContactsByEmail(
  context: DbAccessContext,
  orgId: string,
  emails: readonly string[] | undefined,
): Promise<Map<string, string>> {
  const wanted = lowerEmails(emails);
  const out = new Map<string, string>();
  if (wanted.length === 0) return out;
  await withDbAccessContext(context, async () => {
    for (let i = 0; i < wanted.length; i += SLICE) {
      const rows = await db
        .select({
          email: sql<string>`lower(${contacts.email})`,
          ids: sql<string[]>`array_agg(${contacts.id})`,
        })
        .from(contacts)
        .where(and(eq(contacts.orgId, orgId), inArray(sql`lower(${contacts.email})`, wanted.slice(i, i + SLICE))))
        .groupBy(sql`lower(${contacts.email})`);
      for (const row of rows) {
        if (row.ids.length === 1) out.set(row.email, row.ids[0]!);
      }
    }
  });
  return out;
}

/**
 * The source keys that still have this principal's ref (§5.9 "changed, but
 * gone from Breeze"). Read in system scope, so a window's narrowed RLS can
 * never make a ticket in another org look gone; one batched query per page.
 */
export async function keysWithRef(principalId: string, keys: readonly string[]): Promise<Set<string>> {
  const out = new Set<string>();
  if (keys.length === 0) return out;
  await withSystemDbAccessContext(async () => {
    for (let i = 0; i < keys.length; i += SLICE) {
      const rows = await db
        .select({ key: ticketExternalRefs.externalId })
        .from(ticketExternalRefs)
        .where(and(
          eq(ticketExternalRefs.partnerServicePrincipalId, principalId),
          inArray(ticketExternalRefs.externalId, keys.slice(i, i + SLICE) as string[]),
        ));
      for (const row of rows) out.add(row.key);
    }
  }, 'ticketImport.lookupRefs');
  return out;
}
