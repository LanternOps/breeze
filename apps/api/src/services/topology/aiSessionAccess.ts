/**
 * Topology M4-D2 (#6000): which pinned topology sessions a caller may see in
 * ANY session list, search, count, detail, message or replay read.
 *
 * A session with `topology_site_id` carries site-scoped evidence and answers,
 * so org access alone is not enough: the caller must currently hold
 * topology:read AND devices:read and reach the pinned site under both the
 * token's and the permission row's site ceilings. The condition is applied IN
 * the SQL WHERE clause — before ORDER BY / LIMIT / OFFSET — so no page, total
 * or title of an inaccessible session ever leaks by post-limit filtering.
 * Unpinned sessions are unaffected (their existing owner/org rules apply).
 * Audit rows are the exception: `topologyAuditSessionCondition` withholds an
 * `ai_session` audit row whose session no longer exists, pinned or not, from
 * every reader whose visibility is not `kind: 'all'`.
 */
import { and, eq, inArray, isNull, ne, or, sql, type SQL } from 'drizzle-orm';

import { aiSessions, auditLogs } from '../../db/schema';
import type { AuthContext } from '../../middleware/auth';
import { getUserPermissions, hasPermission } from '../permissions';
import { normalizeSiteAllowlist } from '../siteAllowlist';
import { topologyPermissionPairs } from './permissionPairs';

export type TopologySessionVisibility =
  | { kind: 'all' }
  | { kind: 'none' }
  | { kind: 'sites'; siteIds: string[] };

export async function resolveTopologySessionVisibility(auth: AuthContext): Promise<TopologySessionVisibility> {
  let permissions: Awaited<ReturnType<typeof getUserPermissions>>;
  try {
    permissions = await getUserPermissions(auth.user.id, {
      partnerId: auth.partnerId ?? undefined,
      orgId: auth.orgId ?? undefined,
      scope: auth.scope,
    });
  } catch {
    // Fail closed for pinned sessions only: an unreadable permission row hides
    // topology sessions and leaves every ordinary session read unchanged.
    return { kind: 'none' };
  }
  if (!permissions) return { kind: 'none' };
  if (!topologyPermissionPairs('read').every(([resource, action]) => hasPermission(permissions, resource, action))) return { kind: 'none' };
  const token = normalizeSiteAllowlist(auth.allowedSiteIds);
  const granted = normalizeSiteAllowlist(permissions.allowedSiteIds);
  if (token === undefined && granted === undefined) return { kind: 'all' };
  const sites = token === undefined ? [...granted!] : granted === undefined ? [...token] : token.filter((site) => granted.includes(site));
  return sites.length ? { kind: 'sites', siteIds: [...new Set(sites)] } : { kind: 'none' };
}

/** The WHERE fragment for a resolved visibility; `undefined` adds no condition. */
export function topologySessionCondition(visibility: TopologySessionVisibility): SQL | undefined {
  switch (visibility.kind) {
    case 'all': return undefined;
    case 'none': return isNull(aiSessions.topologySiteId);
    case 'sites': return or(isNull(aiSessions.topologySiteId), inArray(aiSessions.topologySiteId, visibility.siteIds)) ?? sql`false`;
  }
}

/**
 * M4-D2 for audit rows: an `ai_session` audit row (tool calls, authority
 * changes, injection flags) names its session and carries the tool input, so a
 * row about a topology session pinned to a site the caller cannot read is
 * withheld exactly like the session itself. Applied in SQL before LIMIT.
 *
 * Fails CLOSED (#4342 W4, plan correction 9): the row stays visible only when
 * it is not an `ai_session` row, names no session, or EXISTS a session this
 * caller may see (`topologySessionCondition`). A session that no longer exists
 * (transcript retention hard-deletes stubs) cannot be shown to be visible, so
 * its rows are withheld (any deleter: retention, device deletion, site cleanup).
 * An unrestricted reader (`kind: 'all'`) gets no condition at all.
 */
export function topologyAuditSessionCondition(visibility: TopologySessionVisibility): SQL | undefined {
  const visible = topologySessionCondition(visibility);
  if (!visible) return undefined;
  return or(
    ne(auditLogs.resourceType, 'ai_session'),
    isNull(auditLogs.resourceId),
    sql`exists (select 1 from ${aiSessions} where ${and(eq(aiSessions.id, auditLogs.resourceId), visible)})`,
  );
}

/** Resolve and build in one step, for callers holding an `AuthContext`. */
export async function topologySessionAccessCondition(auth: AuthContext): Promise<SQL | undefined> {
  return topologySessionCondition(await resolveTopologySessionVisibility(auth));
}
