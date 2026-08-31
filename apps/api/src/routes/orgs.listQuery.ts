/**
 * The paginated organization-list query for `GET /orgs/organizations`.
 *
 * Extracted from the route handler so the ORDER BY / LIMIT relationship can be
 * asserted on the COMPILED statement without a database (`.toSQL()`), the way
 * `routes/incidents.helpers.ts` is. That relationship is the whole point of
 * this module: the partner's preferred order has to be part of the sort key the
 * LIMIT/OFFSET walks, not a re-sort of rows a different sort already chose
 * (#4004).
 */
import { sql, type SQL } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import { db } from '../db';
import { organizations } from '../db/schema';
import { PG_UUID_REGEX } from '../utils/uuid';

export interface OrganizationListQueryParams {
  /** Fully-built tenant predicate from the route (already fail-closed). */
  conditions: SQL | undefined;
  limit: number;
  offset: number;
  /** `partners.settings.organizationOrder`, as stored. May be absent or junk. */
  preferredOrder?: string[] | null;
}

/**
 * The stored order, reduced to what can safely be cast to `uuid[]`.
 *
 * `partners.settings` is a jsonb blob: nothing in the database constrains what
 * `organizationOrder` holds, and the array survives orgs being deleted. The
 * previous in-JS sort simply never matched a junk entry, but a `::uuid[]` cast
 * over one raises 22P02 and would take the whole list endpoint down with it, so
 * the filter is load-bearing rather than defensive tidying.
 *
 * Lower-cased and de-duplicated because `array_position` returns the FIRST
 * match: de-duplicating here keeps the emitted array a faithful picture of the
 * sort it produces, and Postgres would fold the case on cast anyway.
 */
function sanitizePreferredOrderIds(preferredOrder?: string[] | null): string[] {
  if (!Array.isArray(preferredOrder) || preferredOrder.length === 0) return [];

  const seen = new Set<string>();
  const ids: string[] = [];
  for (const raw of preferredOrder) {
    if (typeof raw !== 'string' || !PG_UUID_REGEX.test(raw)) continue;
    const id = raw.toLowerCase();
    if (seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

/**
 * ORDER BY terms for the organization list: the partner's preferred order
 * first, then the stable pagination tiebreaker.
 *
 * `array_position` returns the 1-based index of the org in the stored array, or
 * NULL when it is absent — and an ASC sort puts NULLs last, so orgs the partner
 * never placed trail the ones it did, in registration order. That reproduces
 * exactly what the old in-JS `applyOrganizationOrder` computed (ordered ids by
 * stored index, then the remainder in `created_at, id` order), with the one
 * difference that matters: Postgres now applies it to the whole result set
 * rather than to the rows a `created_at, id` LIMIT already picked.
 *
 * `created_at, id` stays as the tiebreaker and `id` remains mandatory (#3462):
 * `created_at` is `defaultNow()` and Postgres `now()` is the TRANSACTION
 * timestamp, so every org written in one transaction (seed, bulk import,
 * migration) shares a byte-identical value. Ordering on a tied key alone leaves
 * row order undefined between two LIMIT/OFFSET queries, and the page walk in
 * `apps/web/src/lib/fetchAllOrganizations.ts` would silently see some orgs twice
 * and miss others.
 *
 * The ids are bound as N individual parameters inside an `ARRAY[...]::uuid[]`
 * constructor, NOT as `${ids}::uuid[]`: Drizzle's `sql` template spreads a JS
 * array into N positional parameters, so the natural-looking form compiles to
 * `(...)::uuid[]` over a record and fails at runtime with "cannot cast type
 * record to uuid[]" (the same trap documented at `routes/devices/core.ts:771`).
 * The array is bounded by the partner's own org count — `PATCH
 * /organizations/order` sanitizes against it and caps at 10k — so the parameter
 * count stays far below Postgres's 65535 limit.
 */
export function organizationOrderBy(
  preferredOrder?: string[] | null,
): (SQL | PgColumn)[] {
  const ids = sanitizePreferredOrderIds(preferredOrder);
  if (ids.length === 0) return [organizations.createdAt, organizations.id];

  const idArray = sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `,
  );
  return [
    sql`array_position(ARRAY[${idArray}]::uuid[], ${organizations.id}) asc nulls last`,
    organizations.createdAt,
    organizations.id,
  ];
}

export function buildOrganizationListQuery(params: OrganizationListQueryParams) {
  return db
    .select()
    .from(organizations)
    .where(params.conditions)
    .limit(params.limit)
    .offset(params.offset)
    .orderBy(...organizationOrderBy(params.preferredOrder));
}
