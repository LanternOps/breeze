import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, desc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { authMiddleware, requireScope } from '../middleware/auth';
import { db } from '../db';
import { discoveredAssets, networkMonitors, snmpDevices, snmpMetrics } from '../db/schema';
import { writeRouteAudit } from '../services/auditEvents';
import { isRedisAvailable } from '../services/redis';

type AuthContext = {
  scope: string;
  orgId: string | null;
  accessibleOrgIds: string[] | null;
  canAccessOrg: (orgId: string) => boolean;
  user?: { id: string } | null;
};

function resolveOrgId(
  auth: AuthContext,
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
    return { error: 'orgId is required for partner scope', status: 400 } as const;
  }

  if (auth.scope === 'system' && !requestedOrgId) return { error: 'orgId is required for system scope', status: 400 } as const;
  if (requireForNonOrg && !requestedOrgId) return { error: 'orgId is required', status: 400 } as const;
  return { orgId: requestedOrgId ?? auth.orgId ?? null } as const;
}

async function resolveOrgIdForAsset(auth: AuthContext, assetId: string, requestedOrgId?: string) {
  const orgResult = resolveOrgId(auth, requestedOrgId);
  if (!('error' in orgResult)) return orgResult;

  const needsAssetResolution = (
    orgResult.error === 'orgId is required for partner scope'
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

export const monitoringRoutes = new Hono();
monitoringRoutes.use('*', authMiddleware);

const listAssetsSchema = z.object({
  orgId: z.string().uuid().optional(),
  includeUnconfigured: z.coerce.boolean().optional()
});

monitoringRoutes.get(
  '/assets',
  requireScope('organization', 'partner', 'system'),
  zValidator('query', listAssetsSchema),
  async (c) => {
    const auth = c.get('auth') as AuthContext;
    const query = c.req.valid('query');

    // For partner scope: auto-select the org if there is exactly one accessible org.
    // For system scope: still requires an explicit orgId.
    const orgResult = resolveOrgId(auth, query.orgId);
    if ('error' in orgResult) return c.json({ error: orgResult.error }, orgResult.status);
    const orgId = orgResult.orgId!;

    // Pull monitoring config for discovered assets in this org.
    const snmpRows = await db
      .select({
        id: snmpDevices.id,
        assetId: snmpDevices.assetId,
        snmpVersion: snmpDevices.snmpVersion,
        templateId: snmpDevices.templateId,
        pollingInterval: snmpDevices.pollingInterval,
        port: snmpDevices.port,
        isActive: snmpDevices.isActive,
        lastPolled: snmpDevices.lastPolled,
        lastStatus: snmpDevices.lastStatus,
        createdAt: snmpDevices.createdAt
      })
      .from(snmpDevices)
      .where(and(eq(snmpDevices.orgId, orgId), isNotNull(snmpDevices.assetId)))
      .orderBy(desc(snmpDevices.createdAt));

    const snmpByAssetId = new Map<string, typeof snmpRows[number]>();
    for (const row of snmpRows) {
      if (!row.assetId) continue;
      const key = row.assetId;
      const existing = snmpByAssetId.get(key);
      if (!existing) {
        snmpByAssetId.set(key, row);
        continue;
      }
      const existingRank = existing.isActive ? 2 : 1;
      const nextRank = row.isActive ? 2 : 1;
      if (nextRank > existingRank) {
        snmpByAssetId.set(key, row);
        continue;
      }
      if (nextRank === existingRank && row.createdAt > existing.createdAt) {
        snmpByAssetId.set(key, row);
      }
    }

    const networkCounts = await db
      .select({
        assetId: networkMonitors.assetId,
        totalCount: sql<number>`count(*)`,
        activeCount: sql<number>`sum(case when ${networkMonitors.isActive} then 1 else 0 end)`
      })
      .from(networkMonitors)
      .where(and(eq(networkMonitors.orgId, orgId), isNotNull(networkMonitors.assetId)))
      .groupBy(networkMonitors.assetId);

    const networkByAssetId = new Map<string, { totalCount: number; activeCount: number }>();
    for (const row of networkCounts) {
      if (!row.assetId) continue;
      networkByAssetId.set(row.assetId, {
        totalCount: Number(row.totalCount ?? 0),
        activeCount: Number(row.activeCount ?? 0)
      });
    }

    const configuredAssetIds = new Set<string>([
      ...snmpByAssetId.keys(),
      ...networkByAssetId.keys()
    ]);

    if (!query.includeUnconfigured && configuredAssetIds.size === 0) {
      return c.json({ data: [] });
    }

    const assets = await db
      .select({
        id: discoveredAssets.id,
        orgId: discoveredAssets.orgId,
        siteId: discoveredAssets.siteId,
        hostname: discoveredAssets.hostname,
        ipAddress: discoveredAssets.ipAddress,
        assetType: discoveredAssets.assetType,
        status: discoveredAssets.status,
        lastSeenAt: discoveredAssets.lastSeenAt,
        createdAt: discoveredAssets.createdAt,
        updatedAt: discoveredAssets.updatedAt
      })
      .from(discoveredAssets)
      .where(and(
        eq(discoveredAssets.orgId, orgId),
        query.includeUnconfigured ? sql`true` : inArray(discoveredAssets.id, Array.from(configuredAssetIds))
      ))
      .orderBy(desc(discoveredAssets.lastSeenAt));

    return c.json({
      data: assets.map((a) => {
        const snmp = snmpByAssetId.get(a.id);
        const net = networkByAssetId.get(a.id);
        const snmpConfigured = Boolean(snmp);
        const snmpActive = Boolean(snmp?.isActive);
        const networkConfigured = Boolean(net && net.totalCount > 0);
        const networkActive = Boolean(net && net.activeCount > 0);

        return {
          id: a.id,
          orgId: a.orgId,
          siteId: a.siteId,
          hostname: a.hostname,
          ipAddress: a.ipAddress,
          assetType: a.assetType,
          status: a.status,
          lastSeenAt: a.lastSeenAt?.toISOString() ?? null,
          createdAt: a.createdAt.toISOString(),
          updatedAt: a.updatedAt.toISOString(),
          monitoring: {
            configured: snmpConfigured || networkConfigured,
            active: snmpActive || networkActive
          },
          snmp: snmpConfigured ? {
            configured: true,
            deviceId: snmp!.id,
            snmpVersion: snmp!.snmpVersion,
            templateId: snmp!.templateId,
            pollingInterval: snmp!.pollingInterval,
            port: snmp!.port,
            isActive: snmp!.isActive,
            lastPolled: snmp!.lastPolled?.toISOString?.() ?? (snmp!.lastPolled ? new Date(snmp!.lastPolled as any).toISOString() : null),
            lastStatus: snmp!.lastStatus ?? null
          } : {
            configured: false,
            deviceId: null,
            snmpVersion: null,
            templateId: null,
            pollingInterval: null,
            port: null,
            isActive: false,
            lastPolled: null,
            lastStatus: null
          },
          network: {
            configured: networkConfigured,
            totalCount: net?.totalCount ?? 0,
            activeCount: net?.activeCount ?? 0
          }
        };
      })
    });
  }
);

monitoringRoutes.get(
  '/assets/:id',
  requireScope('organization', 'partner', 'system'),
  async (c) => {
    const auth = c.get('auth') as AuthContext;
    const assetId = c.req.param('id');

    const orgResult = await resolveOrgIdForAsset(auth, assetId);
    if ('error' in orgResult) return c.json({ error: orgResult.error }, orgResult.status);

    const [asset] = await db
      .select({ id: discoveredAssets.id, orgId: discoveredAssets.orgId })
      .from(discoveredAssets)
      .where(and(eq(discoveredAssets.id, assetId), eq(discoveredAssets.orgId, orgResult.orgId!)))
      .limit(1);
    if (!asset) return c.json({ error: 'Asset not found' }, 404);

    const snmpRows = await db.select()
      .from(snmpDevices)
      .where(and(eq(snmpDevices.assetId, assetId), eq(snmpDevices.orgId, asset.orgId)))
      .orderBy(desc(snmpDevices.createdAt))
      .limit(10);

    const snmpDevice = (() => {
      if (snmpRows.length === 0) return null;
      const active = snmpRows.find((row) => row.isActive);
      return active ?? snmpRows[0];
    })();

    const [networkMonitorTotal] = await db
      .select({ count: sql<number>`count(*)` })
      .from(networkMonitors)
      .where(and(eq(networkMonitors.assetId, assetId), eq(networkMonitors.orgId, asset.orgId)));

    const [networkMonitorActive] = await db
      .select({ count: sql<number>`count(*)` })
      .from(networkMonitors)
      .where(and(
        eq(networkMonitors.assetId, assetId),
        eq(networkMonitors.orgId, asset.orgId),
        eq(networkMonitors.isActive, true)
      ));

    if (!snmpDevice) {
      return c.json({
        enabled: Number(networkMonitorActive?.count ?? 0) > 0,
        snmpDevice: null,
        networkMonitors: {
          totalCount: Number(networkMonitorTotal?.count ?? 0),
          activeCount: Number(networkMonitorActive?.count ?? 0)
        },
        recentMetrics: []
      });
    }

    const recentMetrics = await db.select()
      .from(snmpMetrics)
      .where(eq(snmpMetrics.deviceId, snmpDevice.id))
      .orderBy(desc(snmpMetrics.timestamp))
      .limit(20);

    return c.json({
      enabled: snmpDevice.isActive || Number(networkMonitorActive?.count ?? 0) > 0,
      snmpDevice: {
        id: snmpDevice.id,
        snmpVersion: snmpDevice.snmpVersion,
        templateId: snmpDevice.templateId,
        pollingInterval: snmpDevice.pollingInterval,
        port: snmpDevice.port,
        isActive: snmpDevice.isActive,
        lastPolled: snmpDevice.lastPolled?.toISOString?.() ?? (snmpDevice.lastPolled ? new Date(snmpDevice.lastPolled as any).toISOString() : null),
        lastStatus: snmpDevice.lastStatus,
        username: snmpDevice.username ?? null
      },
      networkMonitors: {
        totalCount: Number(networkMonitorTotal?.count ?? 0),
        activeCount: Number(networkMonitorActive?.count ?? 0)
      },
      recentMetrics: recentMetrics.map((m) => ({
        id: m.id,
        oid: m.oid,
        name: m.name,
        value: m.value,
        valueType: m.valueType,
        timestamp: m.timestamp.toISOString()
      }))
    });
  }
);

const upsertSnmpSchema = z.object({
  snmpVersion: z.enum(['v1', 'v2c', 'v3']),
  community: z.string().optional(),
  username: z.string().optional(),
  authProtocol: z.enum(['md5', 'sha', 'sha256']).optional(),
  authPassword: z.string().optional(),
  privProtocol: z.enum(['des', 'aes', 'aes256']).optional(),
  privPassword: z.string().optional(),
  templateId: z.string().uuid().nullable().optional(),
  pollingInterval: z.number().int().min(30).max(86400).optional(),
  port: z.number().int().min(1).max(65535).optional()
}).refine((data) => {
  if (data.snmpVersion === 'v1' || data.snmpVersion === 'v2c') return Boolean(data.community);
  if (data.snmpVersion === 'v3') return Boolean(data.username);
  return true;
}, { message: 'Community string required for v1/v2c; username required for v3' });

monitoringRoutes.put(
  '/assets/:id/snmp',
  requireScope('organization', 'partner', 'system'),
  zValidator('json', upsertSnmpSchema),
  async (c) => {
    const auth = c.get('auth') as AuthContext;
    const assetId = c.req.param('id');
    const body = c.req.valid('json');

    const orgResult = await resolveOrgIdForAsset(auth, assetId);
    if ('error' in orgResult) return c.json({ error: orgResult.error }, orgResult.status);

    const [asset] = await db.select()
      .from(discoveredAssets)
      .where(and(eq(discoveredAssets.id, assetId), eq(discoveredAssets.orgId, orgResult.orgId!)))
      .limit(1);
    if (!asset) return c.json({ error: 'Asset not found' }, 404);

    const existingRows = await db.select({ id: snmpDevices.id, isActive: snmpDevices.isActive, createdAt: snmpDevices.createdAt })
      .from(snmpDevices)
      .where(and(eq(snmpDevices.assetId, assetId), eq(snmpDevices.orgId, asset.orgId)))
      .orderBy(desc(snmpDevices.createdAt))
      .limit(10);

    const existing = (() => {
      if (existingRows.length === 0) return null;
      const active = existingRows.find((row) => row.isActive);
      return active ?? existingRows[0];
    })();

    const setValues: Record<string, unknown> = {
      name: asset.hostname ?? (asset.ipAddress as any) ?? 'Unknown',
      ipAddress: (asset.ipAddress as any) ?? '',
      snmpVersion: body.snmpVersion,
      pollingInterval: body.pollingInterval ?? 300,
      port: body.port ?? 161,
      templateId: body.templateId ?? null,
      community: body.community ?? null,
      username: body.username ?? null,
      authProtocol: body.authProtocol ?? null,
      authPassword: body.authPassword ?? null,
      privProtocol: body.privProtocol ?? null,
      privPassword: body.privPassword ?? null,
      isActive: true
    };

    const upserted = await (async () => {
      if (existing) {
        const [row] = await db.update(snmpDevices)
          .set(setValues)
          .where(eq(snmpDevices.id, existing.id))
          .returning();
        return row ?? null;
      }
      const [row] = await db.insert(snmpDevices)
        .values({
          orgId: asset.orgId,
          assetId: asset.id,
          ...setValues
        } as any)
        .returning();
      return row ?? null;
    })();

    if (!upserted) return c.json({ error: 'Failed to save SNMP monitoring configuration' }, 500);

    // Best effort: if multiple rows exist, make sure only one remains active.
    if (existingRows.length > 1) {
      try {
        await db.update(snmpDevices)
          .set({ isActive: false })
          .where(and(eq(snmpDevices.assetId, assetId), eq(snmpDevices.orgId, asset.orgId), sql`${snmpDevices.id} <> ${upserted.id}`));
      } catch {
        // ignore
      }
    }

    writeRouteAudit(c, {
      orgId: asset.orgId,
      action: existing ? 'monitoring.snmp.update' : 'monitoring.snmp.create',
      resourceType: 'discovered_asset',
      resourceId: assetId,
      resourceName: asset.hostname ?? (asset.ipAddress as any) ?? undefined,
      details: { snmpDeviceId: upserted.id, snmpVersion: upserted.snmpVersion }
    });

    return c.json({
      success: true,
      snmpDevice: {
        id: upserted.id,
        snmpVersion: upserted.snmpVersion,
        port: upserted.port,
        community: upserted.community ? '***' : null,
        username: upserted.username ?? null,
        templateId: upserted.templateId,
        pollingInterval: upserted.pollingInterval,
        isActive: upserted.isActive,
        lastPolled: upserted.lastPolled?.toISOString?.() ?? (upserted.lastPolled ? new Date(upserted.lastPolled as any).toISOString() : null),
        lastStatus: upserted.lastStatus
      }
    });
  }
);

const patchSnmpSchema = z.object({
  snmpVersion: z.enum(['v1', 'v2c', 'v3']).optional(),
  community: z.string().optional(),
  username: z.string().optional(),
  authProtocol: z.enum(['md5', 'sha', 'sha256']).optional(),
  authPassword: z.string().optional(),
  privProtocol: z.enum(['des', 'aes', 'aes256']).optional(),
  privPassword: z.string().optional(),
  templateId: z.string().uuid().nullable().optional(),
  pollingInterval: z.number().int().min(30).max(86400).optional(),
  port: z.number().int().min(1).max(65535).optional(),
  isActive: z.boolean().optional()
});

monitoringRoutes.patch(
  '/assets/:id/snmp',
  requireScope('organization', 'partner', 'system'),
  zValidator('json', patchSnmpSchema),
  async (c) => {
    const auth = c.get('auth') as AuthContext;
    const assetId = c.req.param('id');
    const body = c.req.valid('json');

    const orgResult = await resolveOrgIdForAsset(auth, assetId);
    if ('error' in orgResult) return c.json({ error: orgResult.error }, orgResult.status);

    const [asset] = await db.select({ id: discoveredAssets.id, orgId: discoveredAssets.orgId })
      .from(discoveredAssets)
      .where(and(eq(discoveredAssets.id, assetId), eq(discoveredAssets.orgId, orgResult.orgId!)))
      .limit(1);
    if (!asset) return c.json({ error: 'Asset not found' }, 404);

    const [existing] = await db.select()
      .from(snmpDevices)
      .where(and(eq(snmpDevices.assetId, assetId), eq(snmpDevices.orgId, asset.orgId)))
      .orderBy(desc(snmpDevices.isActive), desc(snmpDevices.createdAt))
      .limit(1);
    if (!existing) return c.json({ error: 'No SNMP monitoring configuration found for this asset' }, 404);

    const setValues: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(body)) {
      if (v !== undefined) setValues[k] = v;
    }
    if (Object.keys(setValues).length === 0) return c.json({ error: 'No fields to update' }, 400);

    const [updated] = await db.update(snmpDevices)
      .set(setValues)
      .where(eq(snmpDevices.id, existing.id))
      .returning();
    if (!updated) return c.json({ error: 'Failed to update SNMP monitoring configuration' }, 500);

    writeRouteAudit(c, {
      orgId: asset.orgId,
      action: 'monitoring.snmp.patch',
      resourceType: 'discovered_asset',
      resourceId: assetId,
      details: { snmpDeviceId: updated.id, changes: Object.keys(setValues) }
    });

    return c.json({
      success: true,
      snmpDevice: {
        id: updated.id,
        snmpVersion: updated.snmpVersion,
        port: updated.port,
        community: updated.community ? '***' : null,
        username: updated.username ?? null,
        templateId: updated.templateId,
        pollingInterval: updated.pollingInterval,
        isActive: updated.isActive,
        lastPolled: updated.lastPolled?.toISOString?.() ?? (updated.lastPolled ? new Date(updated.lastPolled as any).toISOString() : null),
        lastStatus: updated.lastStatus
      }
    });
  }
);

monitoringRoutes.delete(
  '/assets/:id',
  requireScope('organization', 'partner', 'system'),
  async (c) => {
    const auth = c.get('auth') as AuthContext;
    const assetId = c.req.param('id');

    const orgResult = await resolveOrgIdForAsset(auth, assetId);
    if ('error' in orgResult) return c.json({ error: orgResult.error }, orgResult.status);

    const [asset] = await db.select({ id: discoveredAssets.id, orgId: discoveredAssets.orgId })
      .from(discoveredAssets)
      .where(and(eq(discoveredAssets.id, assetId), eq(discoveredAssets.orgId, orgResult.orgId!)))
      .limit(1);
    if (!asset) return c.json({ error: 'Asset not found' }, 404);

    const disabledSnmp = await db.update(snmpDevices)
      .set({ isActive: false })
      .where(and(eq(snmpDevices.assetId, assetId), eq(snmpDevices.orgId, asset.orgId), eq(snmpDevices.isActive, true)))
      .returning({ id: snmpDevices.id });

    const disabledNetworkMonitors = await db.update(networkMonitors)
      .set({ isActive: false, updatedAt: new Date() })
      .where(and(eq(networkMonitors.assetId, assetId), eq(networkMonitors.orgId, asset.orgId), eq(networkMonitors.isActive, true)))
      .returning({ id: networkMonitors.id });

    if (disabledSnmp.length === 0 && disabledNetworkMonitors.length === 0) {
      return c.json({ error: 'No active monitoring found for this asset' }, 404);
    }

    writeRouteAudit(c, {
      orgId: asset.orgId,
      action: 'monitoring.asset.disable',
      resourceType: 'discovered_asset',
      resourceId: assetId,
      details: {
        disabledSnmpDeviceCount: disabledSnmp.length,
        disabledNetworkMonitorCount: disabledNetworkMonitors.length,
        redisAvailable: isRedisAvailable()
      }
    });

    return c.json({ success: true });
  }
);
