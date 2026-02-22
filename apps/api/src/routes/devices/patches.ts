import { Hono } from 'hono';
import { eq, desc, inArray, and, sql } from 'drizzle-orm';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { db } from '../../db';
import { patches, devicePatches, deviceCommands, users } from '../../db/schema';
import { authMiddleware, requireScope } from '../../middleware/auth';
import { getDeviceWithOrgCheck } from './helpers';
import { queueCommandForExecution } from '../../services/commandQueue';
import { writeRouteAudit } from '../../services/auditEvents';

export const patchesRoutes = new Hono();

patchesRoutes.use('*', authMiddleware);

const installPatchesSchema = z.object({
  patchIds: z.array(z.string().uuid()).min(1)
});

const rollbackPatchParamsSchema = z.object({
  id: z.string().uuid(),
  patchId: z.string().uuid()
});

const patchHistoryQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).default(0),
  type: z.enum(['install', 'scan', 'rollback', 'all']).default('all'),
  status: z.enum(['completed', 'failed', 'pending', 'timeout', 'all']).default('all')
});

const PATCH_COMMAND_TYPES = ['install_patches', 'patch_scan', 'rollback_patches', 'download_patches'] as const;

const TYPE_FILTER_MAP: Record<string, string[]> = {
  install: ['install_patches'],
  scan: ['patch_scan'],
  rollback: ['rollback_patches'],
  all: [...PATCH_COMMAND_TYPES]
};

function safeParsePatchResult(result: unknown): unknown {
  if (!result || typeof result !== 'object') return result;
  const raw = result as Record<string, unknown>;
  // The result field contains {status, stdout, stderr, durationMs} where stdout
  // is often a JSON string with the actual patch results.
  if (typeof raw.stdout === 'string') {
    try {
      raw.stdout = JSON.parse(raw.stdout);
    } catch {
      // Leave as string if not valid JSON
    }
  }
  return raw;
}

// GET /devices/:id/patches/history - Get patch operation history for a device
patchesRoutes.get(
  '/:id/patches/history',
  requireScope('organization', 'partner', 'system'),
  zValidator('query', patchHistoryQuerySchema),
  async (c) => {
    const auth = c.get('auth');
    const deviceId = c.req.param('id');
    const { limit, offset, type, status } = c.req.valid('query');

    const device = await getDeviceWithOrgCheck(deviceId, auth);
    if (!device) {
      return c.json({ error: 'Device not found' }, 404);
    }

    const commandTypes = TYPE_FILTER_MAP[type] ?? PATCH_COMMAND_TYPES;

    const conditions = [
      eq(deviceCommands.deviceId, deviceId),
      inArray(deviceCommands.type, commandTypes)
    ];
    if (status !== 'all') {
      conditions.push(eq(deviceCommands.status, status));
    }
    const whereClause = and(...conditions);

    // Get total count
    const countResult = await db
      .select({ count: sql<number>`count(*)` })
      .from(deviceCommands)
      .where(whereClause);
    const total = Number(countResult[0]?.count ?? 0);

    // Get paginated results with user join
    const rows = await db
      .select({
        id: deviceCommands.id,
        type: deviceCommands.type,
        status: deviceCommands.status,
        createdAt: deviceCommands.createdAt,
        completedAt: deviceCommands.completedAt,
        result: deviceCommands.result,
        createdBy: deviceCommands.createdBy,
        createdByEmail: users.email
      })
      .from(deviceCommands)
      .leftJoin(users, eq(deviceCommands.createdBy, users.id))
      .where(whereClause)
      .orderBy(desc(deviceCommands.createdAt))
      .limit(limit)
      .offset(offset);

    const history = rows.map((row) => ({
      id: row.id,
      type: row.type,
      status: row.status,
      createdAt: row.createdAt,
      completedAt: row.completedAt,
      result: safeParsePatchResult(row.result),
      createdBy: row.createdBy,
      createdByEmail: row.createdByEmail
    }));

    return c.json({ history, total });
  }
);

// GET /devices/:id/patches - Get patch status for a device
patchesRoutes.get(
  '/:id/patches',
  requireScope('organization', 'partner', 'system'),
  async (c) => {
    const auth = c.get('auth');
    const deviceId = c.req.param('id');

    const device = await getDeviceWithOrgCheck(deviceId, auth);
    if (!device) {
      return c.json({ error: 'Device not found' }, 404);
    }

    // Get all patches associated with this device
    const devicePatchList = await db
      .select({
        id: devicePatches.id,
        patchId: devicePatches.patchId,
        status: devicePatches.status,
        installedAt: devicePatches.installedAt,
        lastCheckedAt: devicePatches.lastCheckedAt,
        failureCount: devicePatches.failureCount,
        lastError: devicePatches.lastError,
        // Join patch details
        title: patches.title,
        externalId: patches.externalId,
        description: patches.description,
        severity: patches.severity,
        category: patches.category,
        source: patches.source,
        releaseDate: patches.releaseDate,
        requiresReboot: patches.requiresReboot
      })
      .from(devicePatches)
      .innerJoin(patches, eq(devicePatches.patchId, patches.id))
      .where(eq(devicePatches.deviceId, deviceId))
      .orderBy(desc(devicePatches.lastCheckedAt));

    // Separate actionable pending updates from stale missing records.
    const pending = devicePatchList
      .filter(p => p.status === 'pending')
      .map(p => ({
        id: p.patchId,
        name: p.title,
        title: p.title,
        externalId: p.externalId,
        description: p.description,
        severity: p.severity,
        status: p.status,
        releaseDate: p.releaseDate,
        category: p.category,
        source: p.source,
        requiresReboot: p.requiresReboot
      }));

    const missing = devicePatchList
      .filter(p => p.status === 'missing')
      .map(p => ({
        id: p.patchId,
        name: p.title,
        title: p.title,
        externalId: p.externalId,
        description: p.description,
        severity: p.severity,
        status: p.status,
        releaseDate: p.releaseDate,
        category: p.category,
        source: p.source,
        requiresReboot: p.requiresReboot
      }));

    const installed = devicePatchList
      .filter(p => p.status === 'installed')
      .map(p => ({
        id: p.patchId,
        name: p.title,
        title: p.title,
        externalId: p.externalId,
        description: p.description,
        severity: p.severity,
        status: p.status,
        installedAt: p.installedAt,
        category: p.category,
        source: p.source
      }));

    const failed = devicePatchList
      .filter(p => p.status === 'failed')
      .map(p => ({
        id: p.patchId,
        name: p.title,
        title: p.title,
        externalId: p.externalId,
        description: p.description,
        severity: p.severity,
        status: p.status,
        lastError: p.lastError,
        failureCount: p.failureCount
      }));

    const total = pending.length + installed.length;
    const compliancePercent = total > 0
      ? Math.round((installed.length / total) * 100)
      : 100;

    return c.json({
      data: {
        compliancePercent,
        pending,
        missing,
        installed,
        failed,
        patches: devicePatchList.map(p => ({
          id: p.patchId,
          name: p.title,
          title: p.title,
          externalId: p.externalId,
          description: p.description,
          severity: p.severity,
          status: p.status,
          releaseDate: p.releaseDate,
          installedAt: p.installedAt
        }))
      }
    });
  }
);

// POST /devices/:id/patches/install - Queue patch install command for a device
patchesRoutes.post(
  '/:id/patches/install',
  requireScope('organization', 'partner', 'system'),
  zValidator('json', installPatchesSchema),
  async (c) => {
    const auth = c.get('auth');
    const deviceId = c.req.param('id');
    const data = c.req.valid('json');

    const device = await getDeviceWithOrgCheck(deviceId, auth);
    if (!device) {
      return c.json({ error: 'Device not found' }, 404);
    }

    const patchRefs = await db
      .select({
        id: patches.id,
        source: patches.source,
        externalId: patches.externalId,
        title: patches.title
      })
      .from(patches)
      .where(inArray(patches.id, data.patchIds));

    if (patchRefs.length === 0) {
      return c.json({ error: 'No matching patches found' }, 404);
    }

    const queued = await queueCommandForExecution(
      deviceId,
      'install_patches',
      {
        patchIds: data.patchIds,
        patches: patchRefs
      },
      {
        userId: auth.user.id,
        preferHeartbeat: false
      }
    );

    if (!queued.command) {
      return c.json({ error: queued.error || 'Failed to queue install_patches command' }, 503);
    }

    const command = queued.command;

    writeRouteAudit(c, {
      orgId: device.orgId,
      action: 'device.patch.install.queue',
      resourceType: 'device',
      resourceId: deviceId,
      resourceName: device.hostname,
      details: {
        commandId: command.id,
        commandStatus: command.status,
        patchCount: data.patchIds.length
      }
    });

    return c.json({
      success: true,
      commandId: command.id,
      commandStatus: command.status,
      patchCount: data.patchIds.length
    });
  }
);

// POST /devices/:id/patches/:patchId/rollback - Queue patch rollback command for a device
patchesRoutes.post(
  '/:id/patches/:patchId/rollback',
  requireScope('organization', 'partner', 'system'),
  zValidator('param', rollbackPatchParamsSchema),
  async (c) => {
    const auth = c.get('auth');
    const { id: deviceId, patchId } = c.req.valid('param');

    const device = await getDeviceWithOrgCheck(deviceId, auth);
    if (!device) {
      return c.json({ error: 'Device not found' }, 404);
    }

    const [patch] = await db
      .select({
        id: patches.id,
        source: patches.source,
        externalId: patches.externalId,
        title: patches.title
      })
      .from(patches)
      .where(eq(patches.id, patchId))
      .limit(1);

    if (!patch) {
      return c.json({ error: 'Patch not found' }, 404);
    }

    const queued = await queueCommandForExecution(
      deviceId,
      'rollback_patches',
      {
        patchIds: [patchId],
        patches: [patch]
      },
      {
        userId: auth.user.id,
        preferHeartbeat: false
      }
    );

    if (!queued.command) {
      return c.json({ error: queued.error || 'Failed to queue rollback_patches command' }, 503);
    }

    const command = queued.command;

    writeRouteAudit(c, {
      orgId: device.orgId,
      action: 'device.patch.rollback.queue',
      resourceType: 'device',
      resourceId: deviceId,
      resourceName: device.hostname,
      details: {
        commandId: command.id,
        commandStatus: command.status,
        patchId
      }
    });

    return c.json({
      success: true,
      commandId: command.id,
      commandStatus: command.status,
      patchId
    });
  }
);
