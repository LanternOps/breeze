/**
 * Physical placement of a discovered network asset.
 * Spec: docs/superpowers/specs/monitoring/2026-10-07-physical-placement-circuits-design.md §5.1, §8.1
 *
 * GET    /discovery/assets/:id/placement
 * PUT    /discovery/assets/:id/placement   (an all-NULL body removes the row)
 * DELETE /discovery/assets/:id/placement
 *
 * Own module (like discoveryAssetProbe.ts) rather than growing routes/discovery.ts;
 * mounted as another sub-router at /discovery in index.ts.
 *
 * Authority: once the asset is linked to a managed device, the DEVICE owns the
 * placement. GET returns the device's placement with `authority.linked = true`;
 * PUT/DELETE answer 409 PLACEMENT_AUTHORITY_DEVICE so a second, conflicting row
 * can never be created for the same physical box.
 */

import { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';
import { db } from '../db';
import { discoveredAssets } from '../db/schema';
import { zValidator } from '../lib/validation';
import { authMiddleware, requireMfa, requirePermission, requireScope } from '../middleware/auth';
import { canAccessSite, PERMISSIONS, type UserPermissions } from '../services/permissions';
import { writeRouteAudit } from '../services/auditEvents';
import {
  resolveAssetForMutation,
  resolveOrgIdForAsset,
  type AssetAuthContext,
} from '../services/assetAccessScope';
import {
  deletePlacement,
  placementBodySchema,
  readPlacement,
  resolvePlacementAuthority,
  savePlacement,
  type PlacementSubject,
} from '../services/assetPlacement';

export const discoveryAssetPlacementRoutes = new Hono();

discoveryAssetPlacementRoutes.use('*', authMiddleware);

const requireDevicesRead = requirePermission(PERMISSIONS.DEVICES_READ.resource, PERMISSIONS.DEVICES_READ.action);
const requireDevicesWrite = requirePermission(PERMISSIONS.DEVICES_WRITE.resource, PERMISSIONS.DEVICES_WRITE.action);

const AUTHORITY_DEVICE_STATUS = 409 as const;

function subjectBody(subject: PlacementSubject) {
  return { kind: subject.kind, id: subject.id, orgId: subject.orgId, siteId: subject.siteId };
}

discoveryAssetPlacementRoutes.get(
  '/assets/:id/placement',
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

    const subject: PlacementSubject = { kind: 'discovered', id: asset.id, orgId: asset.orgId, siteId: asset.siteId };
    const { authority, linked } = await resolvePlacementAuthority(subject);
    if (linked && perms?.allowedSiteIds && !canAccessSite(perms, authority.siteId)) {
      return c.json({ error: 'Access to this site denied' }, 403);
    }

    return c.json({
      subject: subjectBody(subject),
      authority: { kind: authority.kind, id: authority.id, linked },
      placement: await readPlacement(authority.kind, authority.id),
    });
  },
);

discoveryAssetPlacementRoutes.put(
  '/assets/:id/placement',
  requireScope('organization', 'partner', 'system'),
  requireDevicesWrite,
  requireMfa(),
  zValidator('json', placementBodySchema),
  async (c) => {
    const auth = c.get('auth') as AssetAuthContext;
    const perms = c.get('permissions') as UserPermissions | undefined;
    const assetId = c.req.param('id')!;

    const resolved = await resolveAssetForMutation(auth, perms, assetId);
    if ('error' in resolved) return c.json({ error: resolved.error }, resolved.status);
    const asset = resolved.asset;

    // Serialize with the link writers (manual link, auto-link, BMC link): they
    // UPDATE this row, so holding its lock for the rest of the transaction means
    // a concurrent link either commits first (we see it below) or waits for us
    // and then reconciles the placement we just wrote.
    await db
      .select({ id: discoveredAssets.id })
      .from(discoveredAssets)
      .where(eq(discoveredAssets.id, asset.id))
      .for('update');

    const subject: PlacementSubject = { kind: 'discovered', id: asset.id, orgId: asset.orgId, siteId: asset.siteId };
    const { authority, linked } = await resolvePlacementAuthority(subject);
    if (linked) {
      return c.json(
        {
          error: 'This asset is linked to a managed device; edit the placement on the device.',
          code: 'PLACEMENT_AUTHORITY_DEVICE',
          deviceId: authority.id,
        },
        AUTHORITY_DEVICE_STATUS,
      );
    }

    const before = await readPlacement('discovered', asset.id);
    const placement = await savePlacement(subject, c.req.valid('json'));

    writeRouteAudit(c, {
      orgId: asset.orgId,
      action: placement ? 'asset.placement.update' : 'asset.placement.delete',
      resourceType: 'discovered_asset',
      resourceId: asset.id,
      resourceName: asset.hostname ?? asset.ipAddress ?? undefined,
      details: { before, after: placement },
    });

    return c.json({
      subject: subjectBody(subject),
      authority: { kind: 'discovered', id: asset.id, linked: false },
      placement,
    });
  },
);

discoveryAssetPlacementRoutes.delete(
  '/assets/:id/placement',
  requireScope('organization', 'partner', 'system'),
  requireDevicesWrite,
  requireMfa(),
  async (c) => {
    const auth = c.get('auth') as AssetAuthContext;
    const perms = c.get('permissions') as UserPermissions | undefined;
    const assetId = c.req.param('id')!;

    const resolved = await resolveAssetForMutation(auth, perms, assetId);
    if ('error' in resolved) return c.json({ error: resolved.error }, resolved.status);
    const asset = resolved.asset;

    await db
      .select({ id: discoveredAssets.id })
      .from(discoveredAssets)
      .where(eq(discoveredAssets.id, asset.id))
      .for('update');

    const subject: PlacementSubject = { kind: 'discovered', id: asset.id, orgId: asset.orgId, siteId: asset.siteId };
    const { authority, linked } = await resolvePlacementAuthority(subject);
    if (linked) {
      return c.json(
        {
          error: 'This asset is linked to a managed device; edit the placement on the device.',
          code: 'PLACEMENT_AUTHORITY_DEVICE',
          deviceId: authority.id,
        },
        AUTHORITY_DEVICE_STATUS,
      );
    }

    const before = await readPlacement('discovered', asset.id);
    await deletePlacement({ kind: 'discovered', id: asset.id });

    if (before) {
      writeRouteAudit(c, {
        orgId: asset.orgId,
        action: 'asset.placement.delete',
        resourceType: 'discovered_asset',
        resourceId: asset.id,
        resourceName: asset.hostname ?? asset.ipAddress ?? undefined,
        details: { before, after: null },
      });
    }

    return c.json({ success: true });
  },
);
