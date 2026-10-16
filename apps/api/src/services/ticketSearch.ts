import { and, ilike, inArray, isNotNull, or, sql, type SQL } from 'drizzle-orm';
import { ticketExternalRefs, tickets } from '../db/schema';
import { escapeLike } from '../utils/sql';

/**
 * The staff ticket search box (routes/tickets/tickets.ts): a substring of the
 * subject or the Breeze number, or — #8313 (spec §5) — the WHOLE source
 * number an import recorded on `ticket_external_refs.external_number`
 * (Zammad's "#41023"), case-insensitively. The source number is matched
 * exactly, through the (org_id, lower(external_number)) index: a substring
 * match over every integration's refs would be unindexable. Breeze still
 * allocates its own number; the source number is never the ticket number.
 *
 * `visibleOrgIds` bounds the ref lookup to the caller's orgs (RLS bounds it
 * too); null for a system-scope caller, an empty list matches nothing.
 */
export function ticketSearchCondition(search: string, visibleOrgIds: readonly string[] | null): SQL {
  const term = `%${escapeLike(search)}%`;
  const whole = search.trim();
  const refOrgs = visibleOrgIds === null
    ? undefined
    : visibleOrgIds.length > 0 ? inArray(ticketExternalRefs.orgId, [...visibleOrgIds]) : sql`false`;
  const bySourceNumber = whole
    ? sql`${tickets.id} IN (SELECT ${ticketExternalRefs.ticketId} FROM ${ticketExternalRefs} WHERE ${and(
      refOrgs,
      isNotNull(ticketExternalRefs.externalNumber),
      sql`lower(${ticketExternalRefs.externalNumber}) = lower(${whole})`,
    )})`
    : undefined;
  return or(ilike(tickets.subject, term), ilike(tickets.internalNumber, term), bySourceNumber)!;
}
