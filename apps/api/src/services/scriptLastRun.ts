import { sql, type SQL } from 'drizzle-orm';
import { scriptExecutions } from '../db/schema';

/**
 * Which tenants' executions may feed a script's "last run" (#9563).
 *
 * `orgs` mirrors the org filter GET /scripts already applied to the script
 * rows themselves: an org-scope caller sees only its own org's runs of a
 * partner-wide or system script, never another tenant's. An empty list means
 * the caller can see no executions at all. `all` is reserved for a
 * system-scope caller with no org filter.
 */
export type ScriptLastRunScope =
  | { kind: 'orgs'; orgIds: readonly string[] }
  | { kind: 'all' };

function inList(values: readonly string[]): SQL {
  return sql.join(values.map((value) => sql`${value}`), sql`, `);
}

/**
 * A correlated scalar subquery selecting the newest `script_executions.created_at`
 * for the OUTER `scripts` row, for use as a column in the GET /scripts SELECT.
 *
 * One subquery per returned row, evaluated inside the same statement as the
 * page — no N+1 round trips, and the page's LIMIT/OFFSET is untouched. The
 * (script_id, created_at DESC) index lets Postgres answer each `max()` with a
 * short backward index scan (2027-01-02-170000). A site-restricted caller's
 * EXISTS on devices defeats that rewrite and reads the script's rows instead —
 * still one statement, just not O(1) per script.
 *
 * The outer column is spelled `"scripts"."id"` explicitly: inside a raw
 * fragment Drizzle renders `${scripts.id}` as a bare `id`, which would resolve
 * against `se` (see the reviewedAtHead comment in routes/scripts.ts).
 *
 * RLS on script_executions/devices still applies underneath; these filters
 * keep the app layer from relying on it and narrow a partner caller to the
 * org it filtered the list by.
 */
export function scriptLastRunAtSql(
  scope: ScriptLastRunScope,
  allowedSiteIds: readonly string[] | undefined,
): SQL<Date | null> {
  const noVisibleRuns =
    (scope.kind === 'orgs' && scope.orgIds.length === 0)
    || (allowedSiteIds !== undefined && allowedSiteIds.length === 0);
  if (noVisibleRuns) {
    return sql<Date | null>`NULL::timestamp`.mapWith(scriptExecutions.createdAt);
  }

  let orgFilter = sql``;
  if (scope.kind === 'orgs') {
    orgFilter = scope.orgIds.length === 1
      ? sql` AND se.org_id = ${scope.orgIds[0]}`
      : sql` AND se.org_id IN (${inList(scope.orgIds)})`;
  }

  const siteFilter = allowedSiteIds
    ? sql` AND EXISTS (SELECT 1 FROM devices d WHERE d.id = se.device_id AND d.site_id IN (${inList(allowedSiteIds)}))`
    : sql``;

  return sql<Date | null>`(
    SELECT max(se.created_at) FROM script_executions se
    WHERE se.script_id = ${sql.identifier('scripts')}.${sql.identifier('id')}${orgFilter}${siteFilter}
  )`.mapWith(scriptExecutions.createdAt);
}
