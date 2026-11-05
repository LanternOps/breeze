/**
 * GET /monitoring/assets/:id/metrics — bucketed SNMP metric history (spec §6.3).
 *
 * Its own module: routes/monitoring.ts is already 1,071 lines and this handler
 * is a self-contained read. Mounted as a second sub-router at /monitoring in
 * index.ts; `/assets/:id` cannot shadow `/assets/:id/metrics`, so mount order
 * does not matter.
 *
 * Every cap in services/metricBucketing.ts is load-bearing. snmp_metrics is a
 * row-per-sample table (the spec explicitly does NOT make it a hypertable in
 * this scope), and once W02's walks land, one 48-port switch writes ~138k rows
 * a day. An uncapped range here is a sequential scan with a tenant on the other
 * end of it.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { zValidator } from '../lib/validation';
import { db } from '../db';
import { discoveredAssets } from '../db/schema';
import { authMiddleware, requirePermission, requireScope } from '../middleware/auth';
import { PERMISSIONS, canAccessSite, type UserPermissions } from '../services/permissions';
import { resolveOrgIdForAsset, type AssetAuthContext } from '../services/assetAccessScope';
import { loadAssetMetricHistory } from '../services/snmpMetricHistory';

// Re-exported for the route test; the cap lives with the query in the service.
export { MAX_INSTANCES_PER_OID } from '../services/snmpMetricHistory';

export const monitoringAssetMetricsRoutes = new Hono();
monitoringAssetMetricsRoutes.use('*', authMiddleware);

const querySchema = z.object({
  oid: z.string().min(1),
  from: z.string().optional(),
  to: z.string().optional(),
  bucket: z.enum(['auto', '1m', '5m', '1h', '1d']).optional(),
  delta: z.enum(['0', '1']).optional(),
  orgId: z.string().guid().optional(),
});

monitoringAssetMetricsRoutes.get(
  '/assets/:id/metrics',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.DEVICES_READ.resource, PERMISSIONS.DEVICES_READ.action),
  zValidator('query', querySchema),
  async (c) => {
    const auth = c.get('auth') as AssetAuthContext;
    const perms = c.get('permissions') as UserPermissions | undefined;
    const assetId = c.req.param('id')!;
    const query = c.req.valid('query');

    const orgResult = await resolveOrgIdForAsset(auth, assetId, query.orgId);
    if ('error' in orgResult) return c.json({ error: orgResult.error }, orgResult.status);
    const orgId = orgResult.orgId;
    if (!orgId) return c.json({ error: 'Could not determine organization context' }, 400);

    const [asset] = await db
      .select({ id: discoveredAssets.id, orgId: discoveredAssets.orgId, siteId: discoveredAssets.siteId })
      .from(discoveredAssets)
      .where(and(eq(discoveredAssets.id, assetId), eq(discoveredAssets.orgId, orgId)))
      .limit(1);
    if (!asset) return c.json({ error: 'Asset not found' }, 404);
    if (perms?.allowedSiteIds && (typeof asset.siteId !== 'string' || !canAccessSite(perms, asset.siteId))) {
      // Opaque 404, not 403 — an out-of-ceiling asset must be
      // indistinguishable from a missing one, or a restricted caller can
      // fingerprint asset ids in sites they cannot see (#5777, matching the
      // deployments existence-oracle fix in #5545).
      return c.json({ error: 'Asset not found' }, 404);
    }

    const history = await loadAssetMetricHistory({ id: asset.id, orgId: asset.orgId }, query);
    if (!history.ok) return c.json({ error: history.error }, history.status);
    return c.json(history.body);
  },
);
