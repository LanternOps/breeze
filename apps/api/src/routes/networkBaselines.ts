import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { and, desc, eq, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db';
import {
  discoveryProfiles,
  networkBaselines,
  networkChangeEvents,
  sites
} from '../db/schema';
import { authMiddleware, requirePermission, requireScope, type AuthContext } from '../middleware/auth';
import { enqueueBaselineScan } from '../jobs/networkBaselineWorker';
import {
  normalizeBaselineAlertSettings,
  normalizeBaselineScanSchedule
} from '../services/networkBaseline';
import { isRedisAvailable } from '../services/redis';
import { writeRouteAudit } from '../services/auditEvents';
import {
  networkEventTypes,
  optionalQueryBooleanSchema,
  mapNetworkChangeRow,
  resolveOrgId
} from './networkShared';

export const networkBaselineRoutes = new Hono();

const cidrSchema = z.string().trim().regex(/^\d{1,3}(?:\.\d{1,3}){3}\/\d{1,2}$/, 'Invalid CIDR subnet');

const scanScheduleSchema = z.object({
  enabled: z.boolean().optional(),
  intervalHours: z.number().int().min(1).max(168).optional(),
  nextScanAt: z.string().datetime().optional()
});

const alertSettingsSchema = z.object({
  newDevice: z.boolean().optional(),
  disappeared: z.boolean().optional(),
  changed: z.boolean().optional(),
  rogueDevice: z.boolean().optional()
});

const listBaselinesSchema = z.object({
  orgId: z.string().uuid().optional(),
  siteId: z.string().uuid().optional(),
  subnet: cidrSchema.optional(),
  limit: z.coerce.number().int().positive().max(200).optional(),
  offset: z.coerce.number().int().min(0).optional()
});

const createBaselineSchema = z.object({
  orgId: z.string().uuid().optional(),
  siteId: z.string().uuid(),
  subnet: cidrSchema,
  profileId: z.string().uuid().optional(),
  scanSchedule: scanScheduleSchema.optional(),
  alertSettings: alertSettingsSchema.optional()
});

const updateBaselineSchema = z.object({
  scanSchedule: scanScheduleSchema.optional(),
  alertSettings: alertSettingsSchema.optional()
}).refine((value) => value.scanSchedule || value.alertSettings, {
  message: 'At least one of scanSchedule or alertSettings is required'
});

const baselineChangesQuerySchema = z.object({
  eventType: z.enum(networkEventTypes).optional(),
  acknowledged: optionalQueryBooleanSchema,
  limit: z.coerce.number().int().positive().max(200).optional(),
  offset: z.coerce.number().int().min(0).optional()
});

const deleteBaselineQuerySchema = z.object({
  deleteChanges: optionalQueryBooleanSchema
});

function mapBaselineRow(row: typeof networkBaselines.$inferSelect) {
  return {
    ...row,
    lastScanAt: row.lastScanAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString()
  };
}

async function getBaselineWithAccess(
  baselineId: string,
  auth: AuthContext
): Promise<typeof networkBaselines.$inferSelect | null> {
  const conditions: SQL[] = [eq(networkBaselines.id, baselineId)];
  const orgCondition = auth.orgCondition(networkBaselines.orgId);
  if (orgCondition) {
    conditions.push(orgCondition);
  }

  const [baseline] = await db
    .select()
    .from(networkBaselines)
    .where(and(...conditions))
    .limit(1);

  return baseline ?? null;
}

networkBaselineRoutes.use('*', authMiddleware);

networkBaselineRoutes.get(
  '/',
  requireScope('organization', 'partner', 'system'),
  zValidator('query', listBaselinesSchema),
  async (c) => {
    const auth = c.get('auth');
    const query = c.req.valid('query');

    const orgResult = resolveOrgId(auth, query.orgId);
    if ('error' in orgResult) {
      return c.json({ error: orgResult.error }, orgResult.status);
    }

    const conditions: SQL[] = [];
    if (orgResult.orgId) {
      conditions.push(eq(networkBaselines.orgId, orgResult.orgId));
    } else {
      const orgCondition = auth.orgCondition(networkBaselines.orgId);
      if (orgCondition) {
        conditions.push(orgCondition);
      }
    }

    if (query.siteId) {
      // Validate that siteId belongs to the resolved org (same pattern as POST /)
      if (orgResult.orgId) {
        const [site] = await db
          .select({ id: sites.id })
          .from(sites)
          .where(
            and(
              eq(sites.id, query.siteId),
              eq(sites.orgId, orgResult.orgId)
            )
          )
          .limit(1);

        if (!site) {
          return c.json({ error: 'Site not found for this organization' }, 404);
        }
      }
      conditions.push(eq(networkBaselines.siteId, query.siteId));
    }

    if (query.subnet) {
      conditions.push(eq(networkBaselines.subnet, query.subnet));
    }

    const where = conditions.length > 0 ? and(...conditions) : undefined;
    const limit = query.limit ?? 100;
    const offset = query.offset ?? 0;

    const [countRow] = await db
      .select({ count: sql<number>`count(*)` })
      .from(networkBaselines)
      .where(where);

    const rows = await db
      .select()
      .from(networkBaselines)
      .where(where)
      .orderBy(desc(networkBaselines.createdAt))
      .limit(limit)
      .offset(offset);

    return c.json({
      data: rows.map(mapBaselineRow),
      pagination: {
        limit,
        offset,
        total: Number(countRow?.count ?? 0)
      }
    });
  }
);

networkBaselineRoutes.post(
  '/',
  requireScope('organization', 'partner', 'system'),
  requirePermission('devices', 'write'),
  zValidator('json', createBaselineSchema),
  async (c) => {
    const auth = c.get('auth');
    const body = c.req.valid('json');

    const orgResult = resolveOrgId(auth, body.orgId, true);
    if ('error' in orgResult) {
      return c.json({ error: orgResult.error }, orgResult.status);
    }

    const orgId = orgResult.orgId;
    if (!orgId) {
      return c.json({ error: 'orgId is required' }, 400);
    }

    const [site] = await db
      .select({ id: sites.id })
      .from(sites)
      .where(
        and(
          eq(sites.id, body.siteId),
          eq(sites.orgId, orgId)
        )
      )
      .limit(1);

    if (!site) {
      return c.json({ error: 'Site not found for this organization' }, 404);
    }

    if (body.profileId) {
      const [profile] = await db
        .select({ id: discoveryProfiles.id, subnets: discoveryProfiles.subnets })
        .from(discoveryProfiles)
        .where(
          and(
            eq(discoveryProfiles.id, body.profileId),
            eq(discoveryProfiles.orgId, orgId),
            eq(discoveryProfiles.siteId, body.siteId)
          )
        )
        .limit(1);

      if (!profile) {
        return c.json({ error: 'Discovery profile not found for this organization/site' }, 404);
      }

      if (!(profile.subnets ?? []).includes(body.subnet)) {
        return c.json({ error: 'Discovery profile does not include the requested subnet' }, 400);
      }
    }

    const schedule = normalizeBaselineScanSchedule(body.scanSchedule);
    const alertSettings = normalizeBaselineAlertSettings(body.alertSettings);

    try {
      const [created] = await db
        .insert(networkBaselines)
        .values({
          orgId,
          siteId: body.siteId,
          subnet: body.subnet,
          knownDevices: [],
          scanSchedule: schedule,
          alertSettings,
          lastScanAt: null,
          lastScanJobId: null,
          updatedAt: new Date()
        })
        .returning();

      if (!created) {
        return c.json({ error: 'Failed to create baseline' }, 500);
      }

      writeRouteAudit(c, {
        orgId,
        action: 'network.baseline.create',
        resourceType: 'network_baseline',
        resourceId: created.id,
        resourceName: created.subnet,
        details: {
          siteId: created.siteId,
          profileId: body.profileId ?? null,
          scanSchedule: created.scanSchedule,
          alertSettings: created.alertSettings
        }
      });

      return c.json(mapBaselineRow(created), 201);
    } catch (error) {
      const pgError = error as { code?: string };
      if (pgError.code === '23505') {
        return c.json({ error: 'Baseline already exists for this org/site/subnet' }, 409);
      }
      throw error;
    }
  }
);

networkBaselineRoutes.get(
  '/:id',
  requireScope('organization', 'partner', 'system'),
  async (c) => {
    const auth = c.get('auth');
    const baselineId = c.req.param('id');

    const baseline = await getBaselineWithAccess(baselineId, auth);
    if (!baseline) {
      return c.json({ error: 'Baseline not found' }, 404);
    }

    return c.json(mapBaselineRow(baseline));
  }
);

networkBaselineRoutes.patch(
  '/:id',
  requireScope('organization', 'partner', 'system'),
  requirePermission('devices', 'write'),
  zValidator('json', updateBaselineSchema),
  async (c) => {
    const auth = c.get('auth');
    const baselineId = c.req.param('id');
    const body = c.req.valid('json');

    const baseline = await getBaselineWithAccess(baselineId, auth);
    if (!baseline) {
      return c.json({ error: 'Baseline not found' }, 404);
    }

    const currentSchedule = normalizeBaselineScanSchedule(baseline.scanSchedule);
    const currentAlertSettings = normalizeBaselineAlertSettings(baseline.alertSettings);

    const nextSchedule = body.scanSchedule
      ? normalizeBaselineScanSchedule({ ...currentSchedule, ...body.scanSchedule }, currentSchedule.intervalHours)
      : currentSchedule;
    const nextAlertSettings = body.alertSettings
      ? normalizeBaselineAlertSettings({ ...currentAlertSettings, ...body.alertSettings })
      : currentAlertSettings;

    const [updated] = await db
      .update(networkBaselines)
      .set({
        scanSchedule: nextSchedule,
        alertSettings: nextAlertSettings,
        updatedAt: new Date()
      })
      .where(eq(networkBaselines.id, baseline.id))
      .returning();

    if (!updated) {
      return c.json({ error: 'Failed to update baseline' }, 500);
    }

    writeRouteAudit(c, {
      orgId: updated.orgId,
      action: 'network.baseline.update',
      resourceType: 'network_baseline',
      resourceId: updated.id,
      resourceName: updated.subnet,
      details: {
        changedFields: [
          ...(body.scanSchedule ? ['scanSchedule'] : []),
          ...(body.alertSettings ? ['alertSettings'] : [])
        ]
      }
    });

    return c.json(mapBaselineRow(updated));
  }
);

networkBaselineRoutes.post(
  '/:id/scan',
  requireScope('organization', 'partner', 'system'),
  requirePermission('devices', 'write'),
  async (c) => {
    const auth = c.get('auth');
    const baselineId = c.req.param('id');

    const baseline = await getBaselineWithAccess(baselineId, auth);
    if (!baseline) {
      return c.json({ error: 'Baseline not found' }, 404);
    }

    if (!isRedisAvailable()) {
      return c.json({ error: 'Background job service unavailable. Redis is required.' }, 503);
    }

    const queueJobId = await enqueueBaselineScan(
      baseline.id,
      baseline.orgId,
      baseline.siteId,
      baseline.subnet
    );

    writeRouteAudit(c, {
      orgId: baseline.orgId,
      action: 'network.baseline.scan.trigger',
      resourceType: 'network_baseline',
      resourceId: baseline.id,
      resourceName: baseline.subnet,
      details: { queueJobId }
    });

    return c.json({
      success: true,
      baselineId: baseline.id,
      queueJobId
    });
  }
);

networkBaselineRoutes.get(
  '/:id/changes',
  requireScope('organization', 'partner', 'system'),
  zValidator('query', baselineChangesQuerySchema),
  async (c) => {
    const auth = c.get('auth');
    const baselineId = c.req.param('id');
    const query = c.req.valid('query');

    const baseline = await getBaselineWithAccess(baselineId, auth);
    if (!baseline) {
      return c.json({ error: 'Baseline not found' }, 404);
    }

    const conditions: SQL[] = [eq(networkChangeEvents.baselineId, baseline.id)];

    if (query.eventType) {
      conditions.push(eq(networkChangeEvents.eventType, query.eventType));
    }

    if (query.acknowledged !== undefined) {
      conditions.push(eq(networkChangeEvents.acknowledged, query.acknowledged));
    }

    const where = and(...conditions);
    const limit = query.limit ?? 50;
    const offset = query.offset ?? 0;

    const [countRow] = await db
      .select({ count: sql<number>`count(*)` })
      .from(networkChangeEvents)
      .where(where);

    const rows = await db
      .select()
      .from(networkChangeEvents)
      .where(where)
      .orderBy(desc(networkChangeEvents.detectedAt))
      .limit(limit)
      .offset(offset);

    return c.json({
      data: rows.map(mapNetworkChangeRow),
      pagination: {
        limit,
        offset,
        total: Number(countRow?.count ?? 0)
      }
    });
  }
);

networkBaselineRoutes.delete(
  '/:id',
  requireScope('organization', 'partner', 'system'),
  requirePermission('devices', 'write'),
  zValidator('query', deleteBaselineQuerySchema),
  async (c) => {
    const auth = c.get('auth');
    const baselineId = c.req.param('id');
    const query = c.req.valid('query');

    const baseline = await getBaselineWithAccess(baselineId, auth);
    if (!baseline) {
      return c.json({ error: 'Baseline not found' }, 404);
    }

    const deleteChanges = query.deleteChanges ?? true;

    try {
      if (deleteChanges) {
        await db.transaction(async (tx) => {
          await tx
            .delete(networkChangeEvents)
            .where(eq(networkChangeEvents.baselineId, baseline.id));

          await tx
            .delete(networkBaselines)
            .where(eq(networkBaselines.id, baseline.id));
        });
      } else {
        await db
          .delete(networkBaselines)
          .where(eq(networkBaselines.id, baseline.id));
      }
    } catch (error) {
      const pgError = error as { code?: string };
      if (!deleteChanges && pgError.code === '23503') {
        return c.json({
          error: 'Cannot delete baseline without deleting associated change events',
          hint: 'Use ?deleteChanges=true to delete events with the baseline'
        }, 409);
      }

      throw error;
    }

    writeRouteAudit(c, {
      orgId: baseline.orgId,
      action: 'network.baseline.delete',
      resourceType: 'network_baseline',
      resourceId: baseline.id,
      resourceName: baseline.subnet,
      details: { deleteChanges }
    });

    return c.json({
      success: true,
      baselineId: baseline.id,
      deletedChanges: deleteChanges
    });
  }
);
