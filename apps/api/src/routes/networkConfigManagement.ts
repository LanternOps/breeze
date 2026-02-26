import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db';
import {
  discoveredAssetTypeEnum,
  discoveredAssets,
  networkConfigRiskLevelEnum,
  networkConfigTypeEnum
} from '../db/schema';
import { authMiddleware, requirePermission, requireScope } from '../middleware/auth';
import { writeRouteAudit } from '../services/auditEvents';
import {
  backupNetworkConfig,
  collectNetworkDeviceConfig,
  listConfigBackups,
  listConfigDiffs,
  listFirmwareStatus,
  listManagedNetworkDevices
} from '../services/networkConfigManagement';
import { optionalQueryBooleanSchema, resolveOrgId } from './networkShared';

export const networkConfigRoutes = new Hono();

const managedAssetTypes = ['router', 'switch', 'firewall', 'access_point'] as const satisfies readonly (typeof discoveredAssetTypeEnum.enumValues[number])[];

const paginationQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional()
});

const devicesQuerySchema = paginationQuerySchema.extend({
  orgId: z.string().uuid().optional()
});

const backupsQuerySchema = paginationQuerySchema.extend({
  orgId: z.string().uuid().optional(),
  assetId: z.string().uuid().optional(),
  configType: z.enum(networkConfigTypeEnum.enumValues).optional(),
  changedOnly: optionalQueryBooleanSchema
});

const backupRequestSchema = z.object({
  orgId: z.string().uuid().optional(),
  assetId: z.string().uuid(),
  configType: z.enum(networkConfigTypeEnum.enumValues).default('running'),
  configText: z.string().min(1).max(500_000).optional(),
  metadata: z.record(z.unknown()).optional()
});

const diffsQuerySchema = paginationQuerySchema.extend({
  orgId: z.string().uuid().optional(),
  assetId: z.string().uuid().optional(),
  riskLevel: z.enum(networkConfigRiskLevelEnum.enumValues).optional()
});

const firmwareQuerySchema = paginationQuerySchema.extend({
  orgId: z.string().uuid().optional(),
  assetId: z.string().uuid().optional(),
  vulnerableOnly: optionalQueryBooleanSchema,
  eolBefore: z.string().datetime().optional()
});

function mapConfigResponse(row: {
  id: string;
  orgId: string;
  assetId: string;
  configType: typeof networkConfigTypeEnum.enumValues[number];
  hash: string;
  changedFromPrevious: boolean;
  capturedAt: Date;
  metadata: unknown;
}) {
  return {
    id: row.id,
    orgId: row.orgId,
    assetId: row.assetId,
    configType: row.configType,
    hash: row.hash,
    changedFromPrevious: row.changedFromPrevious,
    capturedAt: row.capturedAt.toISOString(),
    metadata: row.metadata ?? null
  };
}

networkConfigRoutes.use('*', authMiddleware);

networkConfigRoutes.get(
  '/devices',
  requireScope('organization', 'partner', 'system'),
  zValidator('query', devicesQuerySchema),
  async (c) => {
    const auth = c.get('auth');
    const query = c.req.valid('query');

    const orgResult = resolveOrgId(auth, query.orgId, true);
    if ('error' in orgResult) {
      return c.json({ error: orgResult.error }, orgResult.status);
    }

    if (!orgResult.orgId) {
      return c.json({ error: 'orgId is required' }, 400);
    }

    const limit = query.limit ?? 100;
    const offset = query.offset ?? 0;

    const result = await listManagedNetworkDevices({
      orgId: orgResult.orgId,
      limit,
      offset
    });

    return c.json({
      data: result.data,
      pagination: {
        limit,
        offset,
        total: result.total
      }
    });
  }
);

networkConfigRoutes.get(
  '/backups',
  requireScope('organization', 'partner', 'system'),
  zValidator('query', backupsQuerySchema),
  async (c) => {
    const auth = c.get('auth');
    const query = c.req.valid('query');

    const orgResult = resolveOrgId(auth, query.orgId, true);
    if ('error' in orgResult) {
      return c.json({ error: orgResult.error }, orgResult.status);
    }
    if (!orgResult.orgId) {
      return c.json({ error: 'orgId is required' }, 400);
    }

    const limit = query.limit ?? 100;
    const offset = query.offset ?? 0;

    const result = await listConfigBackups({
      orgId: orgResult.orgId,
      assetId: query.assetId,
      configType: query.configType,
      changedOnly: query.changedOnly,
      limit,
      offset
    });

    return c.json({
      data: result.data,
      pagination: {
        limit,
        offset,
        total: result.total
      }
    });
  }
);

networkConfigRoutes.post(
  '/backup',
  requireScope('organization', 'partner', 'system'),
  requirePermission('devices', 'write'),
  zValidator('json', backupRequestSchema),
  async (c) => {
    const auth = c.get('auth');
    const body = c.req.valid('json');

    const orgResult = resolveOrgId(auth, body.orgId, true);
    if ('error' in orgResult) {
      return c.json({ error: orgResult.error }, orgResult.status);
    }
    if (!orgResult.orgId) {
      return c.json({ error: 'orgId is required' }, 400);
    }

    const [asset] = await db
      .select()
      .from(discoveredAssets)
      .where(
        and(
          eq(discoveredAssets.id, body.assetId),
          eq(discoveredAssets.orgId, orgResult.orgId)
        )
      )
      .limit(1);

    if (!asset) {
      return c.json({ error: 'Network device asset not found' }, 404);
    }

    if (!managedAssetTypes.includes(asset.assetType as typeof managedAssetTypes[number])) {
      return c.json({ error: 'Asset type is not managed by network config workflows' }, 400);
    }

    const collected = body.configText
      ? {
        configText: body.configText,
        metadata: {
          source: 'manual',
          ...(body.metadata ?? {})
        },
        collector: 'manual'
      }
      : await collectNetworkDeviceConfig(asset, body.configType);

    if (!collected?.configText) {
      return c.json({ error: 'No configuration data could be collected for this asset' }, 422);
    }

    const result = await backupNetworkConfig({
      orgId: orgResult.orgId,
      assetId: asset.id,
      configType: body.configType,
      configText: collected.configText,
      unchangedSnapshotMinIntervalMinutes: body.configText ? 0 : 60,
      metadata: {
        collector: collected.collector,
        ...(collected.metadata ?? {}),
        ...(body.metadata ?? {})
      }
    });

    writeRouteAudit(c, {
      orgId: orgResult.orgId,
      action: 'network.config.backup',
      resourceType: 'network_device_config',
      resourceId: result.config.id,
      resourceName: asset.hostname ?? asset.ipAddress,
      details: {
        assetId: asset.id,
        configType: body.configType,
        changedFromPrevious: result.changed,
        skipped: result.skipped,
        diffId: result.diff?.id ?? null,
        riskLevel: result.diff?.riskLevel ?? 'low'
      }
    });

    return c.json({
      config: {
        ...mapConfigResponse(result.config),
        changedFromPrevious: result.changed
      },
      changedFromPrevious: result.changed,
      skipped: result.skipped,
      diff: result.diff
        ? {
          ...result.diff,
          createdAt: result.diff.createdAt.toISOString()
        }
        : null
    }, result.skipped ? 200 : 201);
  }
);

networkConfigRoutes.get(
  '/diffs',
  requireScope('organization', 'partner', 'system'),
  zValidator('query', diffsQuerySchema),
  async (c) => {
    const auth = c.get('auth');
    const query = c.req.valid('query');

    const orgResult = resolveOrgId(auth, query.orgId, true);
    if ('error' in orgResult) {
      return c.json({ error: orgResult.error }, orgResult.status);
    }
    if (!orgResult.orgId) {
      return c.json({ error: 'orgId is required' }, 400);
    }

    const limit = query.limit ?? 100;
    const offset = query.offset ?? 0;

    const result = await listConfigDiffs({
      orgId: orgResult.orgId,
      assetId: query.assetId,
      riskLevel: query.riskLevel,
      limit,
      offset
    });

    return c.json({
      data: result.data,
      pagination: {
        limit,
        offset,
        total: result.total
      }
    });
  }
);

networkConfigRoutes.get(
  '/firmware-status',
  requireScope('organization', 'partner', 'system'),
  zValidator('query', firmwareQuerySchema),
  async (c) => {
    const auth = c.get('auth');
    const query = c.req.valid('query');

    const orgResult = resolveOrgId(auth, query.orgId, true);
    if ('error' in orgResult) {
      return c.json({ error: orgResult.error }, orgResult.status);
    }
    if (!orgResult.orgId) {
      return c.json({ error: 'orgId is required' }, 400);
    }

    const limit = query.limit ?? 100;
    const offset = query.offset ?? 0;

    const result = await listFirmwareStatus({
      orgId: orgResult.orgId,
      assetId: query.assetId,
      vulnerableOnly: query.vulnerableOnly,
      eolBefore: query.eolBefore ? new Date(query.eolBefore) : undefined,
      limit,
      offset
    });

    return c.json({
      data: result.data,
      pagination: {
        limit,
        offset,
        total: result.total
      }
    });
  }
);
