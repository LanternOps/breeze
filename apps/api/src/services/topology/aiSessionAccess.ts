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
 */
import { inArray, isNull, or, sql, type SQL } from 'drizzle-orm';

import { aiSessions } from '../../db/schema';
import type { AuthContext } from '../../middleware/auth';
import { getUserPermissions, hasPermission } from '../permissions';
import { normalizeSiteAllowlist } from '../siteAllowlist';
import { topologyPermissionPairs } from './access';

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

/** Resolve and build in one step, for callers holding an `AuthContext`. */
export async function topologySessionAccessCondition(auth: AuthContext): Promise<SQL | undefined> {
  return topologySessionCondition(await resolveTopologySessionVisibility(auth));
}
