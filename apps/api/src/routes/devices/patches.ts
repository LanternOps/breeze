import { Hono } from 'hono';
import { eq, desc, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { db } from '../../db';
import { patches, devicePatches } from '../../db/schema';
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
