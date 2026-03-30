import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { and, eq, sql, inArray, desc } from 'drizzle-orm';
import { requireScope } from '../../middleware/auth';
import { db } from '../../db';
import { queueCommand, queueCommandForExecution } from '../../services/commandQueue';
import {
  patches,
  devicePatches,
  patchJobs,
  patchRollbacks,
  devices
} from '../../db/schema';
import { scanSchema, listJobsSchema, patchIdParamSchema, rollbackSchema } from './schemas';
import { getPagination, writePatchAuditForOrgIds } from './helpers';

export const operationsRoutes = new Hono();

// POST /patches/scan - Trigger patch scan for devices
operationsRoutes.post(
  '/scan',
  requireScope('organization', 'partner', 'system'),
  zValidator('json', scanSchema),
  async (c) => {
    const auth = c.get('auth');
    const data = c.req.valid('json');

    const requestedDevices = await db
      .select({
        id: devices.id,
        orgId: devices.orgId
      })
      .from(devices)
      .where(inArray(devices.id, data.deviceIds));

    const foundDeviceIDs = new Set(requestedDevices.map((d) => d.id));
    const missingDeviceIDs = data.deviceIds.filter((id) => !foundDeviceIDs.has(id));

    const accessibleDevices = requestedDevices.filter((device) => auth.canAccessOrg(device.orgId));
    const inaccessibleDeviceIDs = requestedDevices
      .filter((device) => !auth.canAccessOrg(device.orgId))
      .map((device) => device.id);

    const queueResults = await Promise.all(
      accessibleDevices.map(async (device) => {
        try {
          const queued = await queueCommandForExecution(
            device.id,
            'patch_scan',
            { source: data.source ?? null },
            {
              userId: auth.user.id,
              preferHeartbeat: false
            }
          );

          if (!queued.command) {
            return { ok: false as const, deviceId: device.id };
          }

          return {
            ok: true as const,
            commandId: queued.command.id,
            commandStatus: queued.command.status
          };
        } catch {
          return { ok: false as const, deviceId: device.id };
        }
      })
    );

    const queuedCommandIds = queueResults
      .filter((r): r is { ok: true; commandId: string; commandStatus: string } => r.ok)
      .map((r) => r.commandId);
    const dispatchedCommandIds = queueResults
      .filter((r): r is { ok: true; commandId: string; commandStatus: string } => r.ok && r.commandStatus === 'sent')
      .map((r) => r.commandId);
    const pendingCommandIds = queueResults
      .filter((r): r is { ok: true; commandId: string; commandStatus: string } => r.ok && r.commandStatus !== 'sent')
      .map((r) => r.commandId);
    const failedDeviceIDs = queueResults
      .filter((r): r is { ok: false; deviceId: string } => !r.ok)
      .map((r) => r.deviceId);

    writePatchAuditForOrgIds(
      c,
      accessibleDevices.map((d) => d.orgId),
      {
        action: 'patch.scan.trigger',
        resourceType: 'patch',
        details: {
          source: data.source ?? null,
          deviceCount: accessibleDevices.length,
          queuedCommandIds,
          dispatchedCommandIds,
          pendingCommandIds,
          failedDeviceIds: failedDeviceIDs
        }
      }
    );

    return c.json({
      success: failedDeviceIDs.length === 0,
      jobId: `scan-${Date.now()}`,
      deviceCount: accessibleDevices.length,
      queuedCommandIds,
      dispatchedCommandIds,
      pendingCommandIds,
      failedDeviceIds: failedDeviceIDs,
      skipped: {
        missingDeviceIds: missingDeviceIDs,
        inaccessibleDeviceIds: inaccessibleDeviceIDs
      }
    });
  }
);

// GET /patches/jobs - List patch deployment jobs
operationsRoutes.get(
  '/jobs',
  requireScope('organization', 'partner', 'system'),
  zValidator('query', listJobsSchema),
  async (c) => {
    const auth = c.get('auth');
    const query = c.req.valid('query');
    const { page, limit, offset } = getPagination(query);

    const conditions = [];
    const orgCond = auth.orgCondition(patchJobs.orgId);
    if (orgCond) conditions.push(orgCond);
    if (query.status) conditions.push(eq(patchJobs.status, query.status));

    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

    const jobs = await db
      .select()
      .from(patchJobs)
      .where(whereClause)
      .orderBy(desc(patchJobs.createdAt))
      .limit(limit)
      .offset(offset);

    const countResult = await db
      .select({ count: sql<number>`count(*)` })
      .from(patchJobs)
      .where(whereClause);

    return c.json({
      data: jobs,
      pagination: { page, limit, total: Number(countResult[0]?.count ?? 0) }
    });
  }
);

// POST /patches/:id/rollback - Queue rollback commands for a patch
operationsRoutes.post(
  '/:id/rollback',
  requireScope('organization', 'partner', 'system'),
  zValidator('param', patchIdParamSchema),
  zValidator('json', rollbackSchema),
  async (c) => {
    const auth = c.get('auth');
    const { id } = c.req.valid('param');
    const data = c.req.valid('json');

    if (data.scheduleType === 'scheduled') {
      return c.json({ error: 'Scheduled rollback is not supported yet' }, 400);
    }

    const [patch] = await db
      .select({
        id: patches.id,
        source: patches.source,
        externalId: patches.externalId,
        title: patches.title
      })
      .from(patches)
      .where(eq(patches.id, id))
      .limit(1);

    if (!patch) {
      return c.json({ error: 'Patch not found' }, 404);
    }

    let candidateDevices: Array<{ id: string; orgId: string }> = [];
    let missingDeviceIds: string[] = [];

    if (data.deviceIds && data.deviceIds.length > 0) {
      candidateDevices = await db
        .select({
          id: devices.id,
          orgId: devices.orgId
        })
        .from(devices)
        .where(inArray(devices.id, data.deviceIds));

      const foundIds = new Set(candidateDevices.map((device) => device.id));
      missingDeviceIds = data.deviceIds.filter((deviceId) => !foundIds.has(deviceId));
    } else {
      candidateDevices = await db
        .select({
          id: devices.id,
          orgId: devices.orgId
        })
        .from(devicePatches)
        .innerJoin(devices, eq(devicePatches.deviceId, devices.id))
        .where(
          and(
            eq(devicePatches.patchId, id),
            eq(devicePatches.status, 'installed')
          )
        );
    }

    const accessibleDevices = candidateDevices.filter((device) => auth.canAccessOrg(device.orgId));
    const inaccessibleDeviceIds = candidateDevices
      .filter((device) => !auth.canAccessOrg(device.orgId))
      .map((device) => device.id);

    if (accessibleDevices.length === 0) {
      return c.json({
        error: 'No accessible devices found for rollback',
        skipped: {
          missingDeviceIds,
          inaccessibleDeviceIds
        }
      }, 404);
    }

    const queueResults = await Promise.all(
      accessibleDevices.map(async (device) => {
        try {
          const command = await queueCommand(
            device.id,
            'rollback_patches',
            {
              patchIds: [id],
              patches: [patch],
              reason: data.reason ?? null
            },
            auth.user.id
          );

          return { ok: true as const, deviceId: device.id, commandId: command.id };
        } catch {
          return { ok: false as const, deviceId: device.id };
        }
      })
    );

    const queued = queueResults.filter((result): result is { ok: true; deviceId: string; commandId: string } => result.ok);
    const failedDeviceIds = queueResults
      .filter((result): result is { ok: false; deviceId: string } => !result.ok)
      .map((result) => result.deviceId);

    if (queued.length > 0) {
      await db
        .insert(patchRollbacks)
        .values(
          queued.map((entry) => ({
            deviceId: entry.deviceId,
            patchId: id,
            reason: data.reason ?? null,
            status: 'pending' as const,
            initiatedBy: auth.user.id
          }))
        );
    }

    writePatchAuditForOrgIds(
      c,
      accessibleDevices.map((d) => d.orgId),
      {
        action: 'patch.rollback',
        resourceType: 'patch',
        resourceId: id,
        resourceName: patch.title,
        details: {
          queuedCommandIds: queued.map((entry) => entry.commandId),
          deviceCount: accessibleDevices.length,
          failedDeviceIds,
          reason: data.reason ?? null
        }
      }
    );

    return c.json({
      success: failedDeviceIds.length === 0,
      patchId: id,
      queuedCommandIds: queued.map((entry) => entry.commandId),
      deviceCount: accessibleDevices.length,
      failedDeviceIds,
      skipped: {
        missingDeviceIds,
        inaccessibleDeviceIds
      }
    });
  }
);
