/**
 * Org/site scope resolution for discovered-asset routes (spec §5, §12).
 *
 * Moved out of routes/monitoring.ts so the probe route can use the SAME
 * site-locking resolver rather than growing a third dialect of "which org is
 * this asset in, and may this caller touch it". Bodies are unchanged.
 *
 * resolveAssetForMutation takes `.for('update')` for a site-restricted caller,
 * so the ambient request transaction holds the row lock through the downstream
 * write and a concurrent asset move cannot invalidate the current-site decision
 * between check and use.
 */

import { and, eq } from 'drizzle-orm';
import { db } from '../db';
import { discoveredAssets } from '../db/schema';
import { canAccessSite, type UserPermissions } from './permissions';

export type AssetAuthContext = {
  scope: string;
  orgId: string | null;
  accessibleOrgIds: string[] | null;
  canAccessOrg: (orgId: string) => boolean;
  user?: { id: string } | null;
};

export function resolveOrgIdForAuth(
  auth: AssetAuthContext,
  requestedOrgId?: string,
  requireForNonOrg = false
) {
  if (auth.scope === 'organization') {
    if (!auth.orgId) return { error: 'Organization context required', status: 403 } as const;
    if (requestedOrgId && requestedOrgId !== auth.orgId) return { error: 'Access denied', status: 403 } as const;
    return { orgId: auth.orgId } as const;
  }

  if (requestedOrgId) {
    if (!auth.canAccessOrg(requestedOrgId)) return { error: 'Access denied', status: 403 } as const;
    return { orgId: requestedOrgId } as const;
  }

  if (auth.scope === 'partner') {
    const accessibleOrgIds = auth.accessibleOrgIds ?? [];
    if (!requireForNonOrg && accessibleOrgIds.length === 1) return { orgId: accessibleOrgIds[0] } as const;
    return { error: 'orgId is required when partner has multiple organizations', status: 400 } as const;
  }

  if (auth.scope === 'system' && !requestedOrgId) return { error: 'orgId is required for system scope', status: 400 } as const;
  if (requireForNonOrg && !requestedOrgId) return { error: 'orgId is required', status: 400 } as const;
  const resolvedOrgId = requestedOrgId ?? auth.orgId;
  if (!resolvedOrgId) return { error: 'Could not determine organization context', status: 400 } as const;
  return { orgId: resolvedOrgId } as const;
}

export async function resolveOrgIdForAsset(auth: AssetAuthContext, assetId: string, requestedOrgId?: string) {
  const orgResult = resolveOrgIdForAuth(auth, requestedOrgId);
  if (!('error' in orgResult)) return orgResult;

  const needsAssetResolution = (
    orgResult.error === 'orgId is required when partner has multiple organizations'
    || orgResult.error === 'orgId is required for system scope'
    || orgResult.error === 'orgId is required'
  );
  if (!needsAssetResolution) return orgResult;

  const [asset] = await db
    .select({ orgId: discoveredAssets.orgId })
    .from(discoveredAssets)
    .where(eq(discoveredAssets.id, assetId))
    .limit(1);
  if (!asset) return { error: 'Asset not found', status: 404 } as const;
  if (!auth.canAccessOrg(asset.orgId)) return { error: 'Access denied', status: 403 } as const;

  return { orgId: asset.orgId } as const;
}

/**
 * Resolve and, for a site-restricted caller, lock the discovered asset before a
 * monitoring mutation. The ambient request transaction holds the row lock
 * through the downstream SNMP/network-monitor write, so a concurrent asset move
 * cannot invalidate the current-site decision between check and use.
 */
export async function resolveAssetForMutation(
  auth: AssetAuthContext,
  perms: UserPermissions | undefined,
  assetId: string,
) {
  if (perms?.allowedSiteIds?.length === 0) {
    return { error: 'Access to this site denied', status: 403 } as const;
  }

  const orgResult = await resolveOrgIdForAsset(auth, assetId);
  if ('error' in orgResult) {
    return { error: orgResult.error, status: orgResult.status } as const;
  }
  const orgId = orgResult.orgId;
  if (!orgId) return { error: 'Could not determine organization context', status: 400 } as const;

  const query = db.select()
    .from(discoveredAssets)
    .where(and(eq(discoveredAssets.id, assetId), eq(discoveredAssets.orgId, orgId)))
    .limit(1);
  const rows = perms?.allowedSiteIds ? await query.for('update') : await query;
  const asset = rows[0];
  if (!asset) return { error: 'Asset not found', status: 404 } as const;
  if (perms?.allowedSiteIds && (typeof asset.siteId !== 'string' || !canAccessSite(perms, asset.siteId))) {
    return { error: 'Access to this site denied', status: 403 } as const;
  }

  return { asset } as const;
}
