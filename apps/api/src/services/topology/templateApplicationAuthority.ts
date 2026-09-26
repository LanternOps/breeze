import { eq, inArray, sql } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { users } from '../../db/schema';
import type { AuthContext } from '../../middleware/auth';
import {
  getPermissionAuthorityVersion,
  getUserPermissions,
  type UserPermissions,
} from '../permissions';
import { TopologyOperationError } from './operationErrors';
import type { ApplicationActor } from './templateApplicationTypes';

export function freezeApplicationActor(auth: AuthContext): ApplicationActor {
  // Deferred configuration changes must remain attributable to a human session.
  if (
    auth.principal.kind !== 'user_session' ||
    !auth.token?.aep ||
    !auth.token.mep
  )
    throw new TopologyOperationError('topology_permission_denied', 403);
  return {
    user: auth.user,
    principal: auth.principal,
    scope: auth.scope,
    orgId: auth.orgId,
    partnerId: auth.partnerId,
    accessibleOrgIds: auth.accessibleOrgIds,
    allowedSiteIds: auth.allowedSiteIds,
    partnerOrgAccess: auth.partnerOrgAccess,
    authEpoch: auth.token.aep,
    mfaEpoch: auth.token.mep,
    mfa: auth.token.mfa,
  };
}
/**
 * `freezeApplicationActor` plus the permission authority version at freeze
 * time (M3-D3). The version is the freeze-time witness only: the GLOBAL
 * permission version is bumped on every API boot (index.ts clearPermissionCache),
 * so a standing grant (policy or telemetry arm) cannot fence on version
 * equality — its boundaries re-derive permissions live through
 * `currentApplicationAuthority` (bypassCache) instead. A missing version is
 * unavailability, never a pass.
 */
export async function freezeApplicationAuthority(
  auth: AuthContext,
  permissionVersion: (userId: string) => Promise<string | null> = getPermissionAuthorityVersion,
): Promise<{ actor: ApplicationActor; permissionVersion: string }> {
  const actor = freezeApplicationActor(auth);
  const version = await permissionVersion(actor.user.id);
  if (version === null)
    throw new TopologyOperationError('topology_authority_unavailable', 503);
  return { actor, permissionVersion: version };
}
export async function currentApplicationAuthority(
  actor: ApplicationActor,
): Promise<{
  auth: AuthContext;
  permissions: UserPermissions;
  version: string;
}> {
  const current = await runOutsideDbContext(() =>
    withSystemDbAccessContext(async () => {
      const [user] = await db
        .select({
          id: users.id,
          status: users.status,
          authEpoch: users.authEpoch,
          mfaEpoch: users.mfaEpoch,
          partnerId: users.partnerId,
          orgId: users.orgId,
        })
        .from(users)
        .where(eq(users.id, actor.user.id))
        .limit(1);
      if (
        !user ||
        user.status !== 'active' ||
        user.authEpoch !== actor.authEpoch ||
        user.mfaEpoch !== actor.mfaEpoch ||
        user.partnerId !== actor.partnerId
      )
        throw new TopologyOperationError('permission_changed', 403);
      if (actor.scope === 'organization' && user.orgId !== actor.orgId)
        throw new TopologyOperationError('permission_changed', 403);
      const version = await getPermissionAuthorityVersion(actor.user.id);
      if (version === null)
        throw new TopologyOperationError('topology_authority_unavailable', 503);
      const permissions = await getUserPermissions(
        actor.user.id,
        {
          partnerId: actor.partnerId ?? undefined,
          orgId: actor.orgId ?? undefined,
          scope: actor.scope,
        },
        { bypassCache: true },
      );
      if (!permissions)
        throw new TopologyOperationError('permission_changed', 403);
      if ((await getPermissionAuthorityVersion(actor.user.id)) !== version)
        throw new TopologyOperationError('topology_authority_unavailable', 503);
      return { permissions, version };
    }, 'topology template application current authority'),
  );
  const orgs = actor.accessibleOrgIds;
  const auth: AuthContext = {
    ...actor,
    token: {
      sub: actor.user.id,
      email: actor.user.email,
      roleId: current.permissions.roleId,
      orgId: actor.orgId,
      partnerId: actor.partnerId,
      scope: actor.scope,
      type: 'access',
      mfa: actor.mfa,
      aep: actor.authEpoch,
      mep: actor.mfaEpoch,
    },
    canAccessOrg: (id) => orgs === null || orgs.includes(id),
    orgCondition: (column) =>
      orgs === null
        ? undefined
        : orgs.length
          ? inArray(column, orgs)
          : sql`false`,
    canAccessSite: (id) =>
      actor.allowedSiteIds === undefined ||
      (!!id && actor.allowedSiteIds.includes(id)),
  };
  return { auth, ...current };
}
