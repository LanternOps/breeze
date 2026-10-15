import { and, eq, inArray, ne, or, type SQL } from 'drizzle-orm';
import { db } from '../../db';
import { deviceGroupMemberships, devices } from '../../db/schema';
import type { AuthContext } from '../../middleware/auth';
import { canAccessSite, type UserPermissions } from '../../services/permissions';
import type { EndpointMessageTargets } from '@breeze/shared';

/**
 * Resolve a send's targets to concrete devices, once (a snapshot), grouped per
 * organization.
 *
 * Runs under the request's own RLS context (`withDbAccessContext` from the auth
 * middleware), so a device in a tenant the caller cannot see is never even
 * returned by the query. The explicit org/site checks below are defence in
 * depth AND what lets us report the denial: a device the caller NAMED but could
 * not be resolved comes back in `denied`, so the route can mark it
 * `failed:no_permission` while leaving every other target intact.
 *
 * Decisions (documented because the contract leaves them open):
 *  - A device in an org the caller cannot access is `denied` if it was named in
 *    `deviceIds`; devices reached only through a site/group/org selector in an
 *    inaccessible org are silently dropped (never enumerated to the caller).
 *  - A named device the query did not return at all is `denied` with
 *    `orgId: null` - indistinguishable from "does not exist", so there is no
 *    existence oracle.
 *  - `orgId` next to other selectors is a scope RESTRICTION (AND), never a
 *    widening: it can only shrink what the other selectors reach. Alone, it
 *    means every device in that org.
 *  - Decommissioned devices are never resolved.
 *  - Dynamic groups resolve through their materialized membership rows.
 *  - No partner-owned artifact exists: every group is one org's devices.
 */
export interface ResolvedDevice {
  id: string;
  siteId: string;
  agentVersion: string | null;
}

export interface TargetGroup {
  orgId: string;
  deviceIds: string[];
  devices: ResolvedDevice[];
}

export interface DeniedTarget {
  deviceId: string;
  orgId: string | null;
}

export interface ResolveTargetsResult {
  groups: TargetGroup[];
  denied: DeniedTarget[];
}

type ResolveAuth = Pick<AuthContext, 'scope' | 'orgId' | 'accessibleOrgIds' | 'canAccessOrg'>;

function orgAccessible(auth: ResolveAuth, orgId: string): boolean {
  if (auth.scope === 'organization') return auth.orgId === orgId;
  if (auth.scope === 'partner') return auth.canAccessOrg(orgId);
  return true; // system
}

export async function resolveTargetsDetailed(
  auth: ResolveAuth,
  targets: EndpointMessageTargets,
  opts: { permissions?: Pick<UserPermissions, 'allowedSiteIds'> } = {},
): Promise<ResolveTargetsResult> {
  const selectors: SQL[] = [];
  if (targets.deviceIds?.length) selectors.push(inArray(devices.id, targets.deviceIds));
  if (targets.siteIds?.length) selectors.push(inArray(devices.siteId, targets.siteIds));
  if (targets.deviceGroupIds?.length) {
    selectors.push(
      inArray(
        devices.id,
        db
          .select({ id: deviceGroupMemberships.deviceId })
          .from(deviceGroupMemberships)
          .where(inArray(deviceGroupMemberships.groupId, targets.deviceGroupIds)),
      ),
    );
  }

  const notDecommissioned = ne(devices.status, 'decommissioned');
  let where: SQL | undefined;
  if (selectors.length > 0) {
    const union = or(...selectors);
    where = and(notDecommissioned, union, targets.orgId ? eq(devices.orgId, targets.orgId) : undefined);
  } else if (targets.orgId) {
    where = and(notDecommissioned, eq(devices.orgId, targets.orgId));
  }
  if (!where) return { groups: [], denied: [] };

  const rows = await db
    .select({
      id: devices.id,
      orgId: devices.orgId,
      siteId: devices.siteId,
      agentVersion: devices.agentVersion,
    })
    .from(devices)
    .where(where);

  const named = new Set(targets.deviceIds ?? []);
  const permissions = opts.permissions;
  const byOrg = new Map<string, TargetGroup>();
  const seen = new Set<string>();
  const denied: DeniedTarget[] = [];

  for (const r of rows) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);

    // Defence in depth behind RLS, and the org-restriction clause.
    const orgOk = orgAccessible(auth, r.orgId) && (!targets.orgId || r.orgId === targets.orgId);
    const siteOk = !permissions || canAccessSite(permissions as UserPermissions, r.siteId);
    if (!orgOk || !siteOk) {
      if (named.has(r.id)) denied.push({ deviceId: r.id, orgId: r.orgId });
      continue;
    }

    let group = byOrg.get(r.orgId);
    if (!group) {
      group = { orgId: r.orgId, deviceIds: [], devices: [] };
      byOrg.set(r.orgId, group);
    }
    group.deviceIds.push(r.id);
    group.devices.push({ id: r.id, siteId: r.siteId, agentVersion: r.agentVersion });
  }

  // Named devices the query never returned: no existence oracle.
  for (const id of named) {
    if (!seen.has(id)) denied.push({ deviceId: id, orgId: null });
  }

  return { groups: [...byOrg.values()], denied };
}

export async function resolveTargets(
  auth: ResolveAuth,
  targets: EndpointMessageTargets,
  opts: { permissions?: Pick<UserPermissions, 'allowedSiteIds'> } = {},
): Promise<TargetGroup[]> {
  return (await resolveTargetsDetailed(auth, targets, opts)).groups;
}
