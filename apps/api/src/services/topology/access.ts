import { topologyScopeSchema, type TopologyScope } from '@breeze/shared';
import { eq } from 'drizzle-orm';

import { db } from '../../db';
import { sites } from '../../db/schema';
import { siteAccessCheck, type AuthContext } from '../../middleware/auth';
import {
  canAccessOrg,
  canAccessSite,
  hasPermission,
  type UserPermissions,
} from '../permissions';

export type TopologyCapability = 'read' | 'write' | 'execute' | 'configure';

export type TopologyRequestContext = {
  auth: AuthContext;
  permissions: UserPermissions;
  scope: TopologyScope;
};

export type TopologyErrorCode =
  | 'topology_site_not_found'
  | 'topology_permission_denied';

export class TopologyError extends Error {
  constructor(
    public readonly code: TopologyErrorCode,
    public readonly status: 403 | 404,
    message: string,
  ) {
    super(message);
    this.name = 'TopologyError';
  }
}

export type TopologyPermissionPair = readonly [resource: string, action: string];

/**
 * Minimum grants for each topology capability. Execution still requires the
 * action path's MFA, target/origin, and current-authority checks.
 */
export function topologyPermissionPairs(
  capability: TopologyCapability,
): TopologyPermissionPair[] {
  const read: TopologyPermissionPair[] = [
    ['topology', 'read'],
    ['devices', 'read'],
  ];

  switch (capability) {
    case 'read':
      return read;
    case 'write':
      return [...read, ['topology', 'write']];
    case 'execute':
      return [...read, ['topology', 'execute'], ['devices', 'execute']];
    case 'configure':
      return [
        ...read,
        ['topology', 'write'],
        ['devices', 'write'],
        ['devices', 'execute'],
      ];
  }
}

const hiddenSite = () => new TopologyError(
  'topology_site_not_found',
  404,
  'Topology site not found',
);

const deniedCapability = () => new TopologyError(
  'topology_permission_denied',
  403,
  'Topology permission denied',
);

/**
 * Resolve one site through the request's RLS context, then bind all downstream
 * topology work to the site's stored org. No caller-supplied org participates
 * in this decision.
 */
export async function requireTopologySiteAccess(
  auth: AuthContext,
  permissions: UserPermissions,
  siteId: string,
  capability: TopologyCapability,
): Promise<TopologyRequestContext> {
  if (!topologyScopeSchema.shape.siteId.safeParse(siteId).success) {
    throw hiddenSite();
  }

  const [site] = await db
    .select({ id: sites.id, orgId: sites.orgId })
    .from(sites)
    .where(eq(sites.id, siteId))
    .limit(1);

  // The same response covers an unknown row, an RLS-hidden row, and every
  // application-level org/site ceiling. Do not reveal which check failed.
  if (
    !site
    || !auth.canAccessOrg(site.orgId)
    || !canAccessOrg(permissions, site.orgId)
    || !siteAccessCheck(auth.allowedSiteIds)(site.id)
    || !canAccessSite(permissions, site.id)
  ) {
    throw hiddenSite();
  }

  if (
    !topologyPermissionPairs(capability).every(([resource, action]) =>
      hasPermission(permissions, resource, action))
  ) {
    throw deniedCapability();
  }

  return {
    auth,
    permissions,
    scope: { orgId: site.orgId, siteId: site.id },
  };
}
