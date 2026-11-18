/**
 * resolveBusinessCalendar (#8973 W4, spec §4.2) — the ONLY reader of "which
 * hours does the SLA clock count for a ticket created in this org now".
 *
 *   1. the org override  org_ticket_settings.business_calendar_id, when it
 *                        names a non-archived calendar of this org or of the
 *                        org's partner;
 *   2. the partner default  the partner's is_partner_default calendar
 *                        (non-archived by CHECK);
 *   3. none              24×7, today's wall-clock rule.
 *
 * Gate B1: it reads on the CALLER's connection with explicit partner_id /
 * org_id filters taken from the ticket's org row — never a nested
 * runOutsideDbContext(withSystemDbAccessContext) read (retired for XOR config
 * tables, tenancy-rls.md step 3, and it stalled CI behind a queued TRUNCATE,
 * #9446). Every context that creates tickets must therefore see the
 * partner-wide row: staff partner tokens through breeze_has_partner_access,
 * org tokens and the portal create route through the partner-wide SELECT
 * branch (currentPartnerId), inbound email and workers through system scope.
 * businessCalendarCallerContexts.integration.test.ts proves each one.
 */
import { sql } from 'drizzle-orm';
import type { Database } from '../../db';

export type ResolvedBusinessCalendar = {
  revisionId: string | null;
  calendarId: string | null;
  source: 'org' | 'partner' | 'none';
};

type ResolveRow = { calendar_id: string; source: 'org' | 'partner'; revision_id: string | null };

const NONE: ResolvedBusinessCalendar = { revisionId: null, calendarId: null, source: 'none' };

export async function resolveBusinessCalendar(
  db: Pick<Database, 'execute'>,
  owner: { partnerId: string; orgId: string },
): Promise<ResolvedBusinessCalendar> {
  const result = await db.execute<ResolveRow>(sql`
    WITH picked AS (
      SELECT c.id, 'org'::text AS source, 1 AS rank
        FROM org_ticket_settings s JOIN business_calendars c ON c.id = s.business_calendar_id
       WHERE s.org_id = ${owner.orgId}
         AND c.archived_at IS NULL
         AND (c.org_id = ${owner.orgId} OR (c.org_id IS NULL AND c.partner_id = ${owner.partnerId}))
      UNION ALL
      SELECT c.id, 'partner'::text AS source, 2 AS rank
        FROM business_calendars c
       WHERE c.partner_id = ${owner.partnerId}
         AND c.org_id IS NULL
         AND c.is_partner_default
         AND c.archived_at IS NULL
      ORDER BY rank
      LIMIT 1
    )
    SELECT p.id AS calendar_id, p.source,
           (SELECT r.id FROM business_calendar_revisions r
             WHERE r.calendar_id = p.id
             ORDER BY r.revision DESC
             LIMIT 1) AS revision_id
      FROM picked p
  `);
  const rows = (result as unknown as { rows?: ResolveRow[] }).rows ?? (result as unknown as ResolveRow[]);
  const row = rows[0];
  if (!row || !row.revision_id) return NONE;
  return { calendarId: row.calendar_id, revisionId: row.revision_id, source: row.source };
}
