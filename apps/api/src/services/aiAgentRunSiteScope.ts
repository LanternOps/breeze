import { sql, type SQL } from 'drizzle-orm';
import { aiAgentRuns } from '../db/schema';
import type { AuthContext } from '../middleware/auth';

/**
 * Site-axis visibility for historical run data. Organization RLS does not
 * enforce sites, so a restricted caller sees a run only while its device
 * still exists in the run's organization and is currently assigned to one of
 * the caller's allowed sites. Null/deleted/device-less/moved-out runs fail
 * closed. Callers must apply this in SQL before DISTINCT, LIMIT, or cursors.
 *
 * Lives in its own module rather than beside its first caller
 * (`routes/aiAgents.ts`) because `routes/aiOperatorTasks.ts` needs the same
 * predicate for the linked-run projection on task detail, and a route
 * importing another route's module would drag that route's whole service
 * graph into every test that mounts it.
 */
export function runSiteScopeCondition(
  auth: Pick<AuthContext, 'allowedSiteIds'>,
): SQL | undefined {
  const allowed = auth.allowedSiteIds;
  if (allowed === undefined) return undefined;
  if (allowed.length === 0) return sql`false`;
  const allowedSql = sql.join(allowed.map((siteId) => sql`${siteId}`), sql`, `);
  return sql`EXISTS (
    SELECT 1
    FROM "devices" AS "run_scope_device"
    WHERE "run_scope_device"."id" = ${aiAgentRuns.deviceId}
      AND "run_scope_device"."org_id" = ${aiAgentRuns.orgId}
      AND "run_scope_device"."site_id" IN (${allowedSql})
  )`;
}
