/**
 * WAN circuits and interfaces of a discovered network asset (read only).
 * Spec: docs/superpowers/specs/monitoring/2026-10-07-physical-placement-circuits-design.md §8, §9.1
 *
 * GET /discovery/assets/:id/circuits
 *
 * Unlike placement, authority is NOT redirected to a linked device: circuits are
 * resolved through the asset's own topology binding.
 */

import { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';
import { db } from '../db';
import { discoveredAssets } from '../db/schema';
import { authMiddleware, requirePermission, requireScope } from '../middleware/auth';
import { canAccessSite, PERMISSIONS, type UserPermissions } from '../services/permissions';
import { resolveOrgIdForAsset, type AssetAuthContext } from '../services/assetAccessScope';
import { respondAssetCircuits } from './assetCircuitsResponse';

export const discoveryAssetCircuitsRoutes = new Hono();

discoveryAssetCircuitsRoutes.use('*', authMiddleware);

const requireDevicesRead = requirePermission(PERMISSIONS.DEVICES_READ.resource, PERMISSIONS.DEVICES_READ.action);

discoveryAssetCircuitsRoutes.get(
  '/assets/:id/circuits',
  requireScope('organization', 'partner', 'system'),
  requireDevicesRead,
  async (c) => {
    const auth = c.get('auth') as AssetAuthContext;
    const perms = c.get('permissions') as UserPermissions | undefined;
    const assetId = c.req.param('id')!;

    const orgResult = await resolveOrgIdForAsset(auth, assetId);
    if ('error' in orgResult) return c.json({ error: orgResult.error }, orgResult.status);

    const [asset] = await db
      .select({ id: discoveredAssets.id, orgId: discoveredAssets.orgId, siteId: discoveredAssets.siteId })
      .from(discoveredAssets)
      .where(and(eq(discoveredAssets.id, assetId), eq(discoveredAssets.orgId, orgResult.orgId!)))
      .limit(1);
    if (!asset) return c.json({ error: 'Asset not found' }, 404);
    if (perms?.allowedSiteIds && !canAccessSite(perms, asset.siteId)) {
      return c.json({ error: 'Access to this site denied' }, 403);
    }

    return respondAssetCircuits(c, { kind: 'discovered', id: asset.id, orgId: asset.orgId, siteId: asset.siteId });
  },
);
