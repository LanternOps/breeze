/**
 * AI Tools — which organization a list row belongs to (#10408).
 *
 * A partner-wide caller (partner auth, a Wisp grant ceiling, system scope)
 * reads devices and alerts from many orgs in one page. Without the org on
 * each row the model groups them wrongly, narrates the wrong customer, and
 * builds one proposal across orgs that the write path then refuses.
 *
 * Shape, for multi-org callers only:
 *   - every row carries `orgId` (exact, unambiguous — two orgs may share a name);
 *   - the envelope carries `organizations: [{ orgId, orgName }]`, one entry per
 *     org on the page, so a name costs its bytes once rather than once per row.
 * A single-org caller's rows are unchanged: the org is implied.
 *
 * Byte budget: a list tool's default page must fit MAX_TOOL_RESULT_CHARS
 * uncompacted (aiToolOutputBudget.testkit.ts). Per-row names did not fit; the
 * per-row id plus the deduped legend does at the tools' default page sizes.
 */
import { sql, type SQL } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import { organizations } from '../db/schema';
import type { AuthContext } from '../middleware/auth';

/**
 * True when the caller's read reach covers more than one org. `null` means
 * unrestricted (system scope, or every org under the partner). Anything that
 * is not an array or null (a hand-built context with no reach recorded) is
 * treated as single-org, which only omits the extra fields.
 */
export function readReachSpansOrgs(auth: Pick<AuthContext, 'accessibleOrgIds'>): boolean {
  const ids = auth.accessibleOrgIds;
  if (ids === null) return true;
  return Array.isArray(ids) && ids.length > 1;
}

/**
 * The org's display name for a row's `org_id` column, as a correlated scalar
 * subquery. It runs under the caller's RLS like the rest of the query, so an
 * org the caller cannot read yields null rather than a name.
 */
export function orgNameOf(orgIdColumn: PgColumn): SQL<string | null> {
  return sql<string | null>`(select ${organizations.name} from ${organizations} where ${organizations.id} = ${orgIdColumn})`;
}

export type OrgLegendEntry = { orgId: string; orgName: string | null };

/**
 * Moves `orgName` off each row into a deduped legend, in first-seen order.
 * Rows keep `orgId`.
 */
export function splitOrgLegend<T extends { orgId: string; orgName: string | null }>(
  rows: readonly T[],
): { rows: Array<Omit<T, 'orgName'>>; organizations: OrgLegendEntry[] } {
  const legend = new Map<string, string | null>();
  const stripped = rows.map(({ orgName, ...rest }) => {
    if (!legend.has(rest.orgId)) legend.set(rest.orgId, orgName ?? null);
    return rest;
  });
  return {
    rows: stripped,
    organizations: [...legend].map(([orgId, orgName]) => ({ orgId, orgName })),
  };
}
