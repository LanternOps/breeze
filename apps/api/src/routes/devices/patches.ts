import { Hono } from 'hono';
import { eq, desc } from 'drizzle-orm';
import { db } from '../../db';
import { patches, devicePatches } from '../../db/schema';
import { authMiddleware, requireScope } from '../../middleware/auth';
import { getDeviceWithOrgCheck } from './helpers';

export const patchesRoutes = new Hono();

patchesRoutes.use('*', authMiddleware);

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

    // Separate into pending and installed
    const pending = devicePatchList
      .filter(p => p.status === 'pending' || p.status === 'missing')
      .map(p => ({
        id: p.patchId,
        name: p.title,
        title: p.title,
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
        installed,
        failed,
        patches: devicePatchList.map(p => ({
          id: p.patchId,
          name: p.title,
          title: p.title,
          severity: p.severity,
          status: p.status,
          releaseDate: p.releaseDate,
          installedAt: p.installedAt
        }))
      }
    });
  }
);
