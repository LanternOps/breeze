/**
 * POST /discovery/assets/:id/probe — the "Check now" button (spec §5, D2).
 *
 * Its own module rather than a 27th route in routes/discovery.ts (2,247 lines).
 * Mounted as a second sub-router at /discovery in index.ts.
 *
 * Shape, in order:
 *   1. resolve + LOCK the asset (site-locking resolver, shared with monitoring)
 *   2. require ip_address and site_id
 *   3. refuse a second in-flight probe (409 PROBE_IN_FLIGHT)
 *   4. pick a site-strict executor (409 NO_AGENT_IN_SITE)
 *   5. stamp pending + last_probe_ref, THEN dispatch — never the other way
 *      round, or a fast agent's result arrives before the row it must match
 *   6. wait up to 8 s, then answer 200 or 202
 */

import { Hono } from 'hono';
import { authMiddleware, requireMfa, requirePermission, requireScope } from '../middleware/auth';
import { PERMISSIONS, type UserPermissions } from '../services/permissions';
import { writeRouteAudit } from '../services/auditEvents';
import { resolveAssetForMutation, type AssetAuthContext } from '../services/assetAccessScope';
import { runAssetProbe } from '../services/assetProbeRun';

export const discoveryAssetProbeRoutes = new Hono();
discoveryAssetProbeRoutes.use('*', authMiddleware);

const requireDiscoveryWrite = requirePermission(
  PERMISSIONS.DEVICES_WRITE.resource,
  PERMISSIONS.DEVICES_WRITE.action,
);

discoveryAssetProbeRoutes.post(
  '/assets/:id/probe',
  requireScope('organization', 'partner', 'system'),
  requireDiscoveryWrite,
  requireMfa(),
  async (c) => {
    const auth = c.get('auth') as AssetAuthContext;
    const perms = c.get('permissions') as UserPermissions | undefined;
    const assetId = c.req.param('id')!;

    // 1. Resolve and lock. The ambient request transaction holds the row lock
    //    through the pending stamp below, so two concurrent "Check now" clicks
    //    cannot both pass the in-flight guard.
    const resolved = await resolveAssetForMutation(auth, perms, assetId);
    if ('error' in resolved) return c.json({ error: resolved.error }, resolved.status);
    const asset = resolved.asset;

    // 2-6. The probe itself lives in services/assetProbeRun.ts (shared with the AI tool).
    const result = await runAssetProbe(asset, ({ agentId, commandId }) => {
      writeRouteAudit(c, {
        orgId: asset.orgId,
        action: 'discovery.asset.probe',
        resourceType: 'discovered_asset',
        resourceId: asset.id,
        resourceName: asset.label ?? asset.hostname ?? String(asset.ipAddress),
        details: { agentId, commandId },
      });
    });
    return c.json(result.body, result.status);
  },
);
