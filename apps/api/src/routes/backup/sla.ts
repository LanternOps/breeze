import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { eq, and, sql, gte, lte, isNull, desc } from 'drizzle-orm';
import { db } from '../../db';
import { backupSlaConfigs, backupSlaEvents, backupJobs, recoveryReadiness } from '../../db/schema';
import { requireMfa, requirePermission, requireScope } from '../../middleware/auth';
import { writeRouteAudit } from '../../services/auditEvents';
import { PERMISSIONS } from '../../services/permissions';
import { resolveScopedOrgId } from './helpers';
import {
  slaConfigCreateSchema,
  slaConfigUpdateSchema,
  slaEventsQuerySchema,
} from './schemas';

export const slaRoutes = new Hono();

const idParamSchema = z.object({ id: z.string().uuid() });

// ── POST /configs — create SLA config ────────────────────────────────────────

slaRoutes.post(
  '/configs',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.ORGS_WRITE.resource, PERMISSIONS.ORGS_WRITE.action),
  requireMfa(),
  zValidator('json', slaConfigCreateSchema),
  async (c) => {
    const auth = c.get('auth');
    const orgId = resolveScopedOrgId(auth);
    if (!orgId) {
      return c.json({ error: 'orgId is required for this scope' }, 400);
    }

    const payload = c.req.valid('json');
    const now = new Date();
    const [row] = await db
      .insert(backupSlaConfigs)
      .values({
        orgId,
        name: payload.name,
        rpoTargetMinutes: payload.rpoTargetMinutes,
        rtoTargetMinutes: payload.rtoTargetMinutes,
        targetDevices: payload.targetDevices ?? [],
        targetGroups: payload.targetGroups ?? [],
        alertOnBreach: payload.alertOnBreach ?? true,
        isActive: payload.isActive ?? true,
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    if (!row) {
      return c.json({ error: 'Failed to create SLA config' }, 500);
    }

    writeRouteAudit(c, {
      orgId,
      action: 'backup.sla_config.create',
      resourceType: 'backup_sla_config',
      resourceId: row.id,
      resourceName: row.name,
      details: { rpoMinutes: row.rpoTargetMinutes, rtoMinutes: row.rtoTargetMinutes },
    });

    return c.json({ data: row }, 201);
  }
);

// ── GET /configs — list SLA configs ──────────────────────────────────────────

slaRoutes.get('/configs', requirePermission(PERMISSIONS.ORGS_READ.resource, PERMISSIONS.ORGS_READ.action), async (c) => {
  const auth = c.get('auth');
  const orgId = resolveScopedOrgId(auth);
  if (!orgId) {
    return c.json({ error: 'orgId is required for this scope' }, 400);
  }

  const rows = await db
    .select()
    .from(backupSlaConfigs)
    .where(eq(backupSlaConfigs.orgId, orgId))
    .orderBy(desc(backupSlaConfigs.createdAt));

  return c.json({ data: rows });
});

// ── PATCH /configs/:id — update SLA config ───────────────────────────────────

slaRoutes.patch(
  '/configs/:id',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.ORGS_WRITE.resource, PERMISSIONS.ORGS_WRITE.action),
  requireMfa(),
  zValidator('param', idParamSchema),
  zValidator('json', slaConfigUpdateSchema),
  async (c) => {
    const auth = c.get('auth');
    const orgId = resolveScopedOrgId(auth);
    if (!orgId) {
      return c.json({ error: 'orgId is required for this scope' }, 400);
    }

    const { id } = c.req.valid('param');
    const payload = c.req.valid('json');

    const [existing] = await db
      .select()
      .from(backupSlaConfigs)
      .where(and(eq(backupSlaConfigs.id, id), eq(backupSlaConfigs.orgId, orgId)))
      .limit(1);

    if (!existing) {
      return c.json({ error: 'SLA config not found' }, 404);
    }

    const updateData: Record<string, unknown> = { updatedAt: new Date() };
    if (payload.name !== undefined) updateData.name = payload.name;
    if (payload.rpoTargetMinutes !== undefined) updateData.rpoTargetMinutes = payload.rpoTargetMinutes;
    if (payload.rtoTargetMinutes !== undefined) updateData.rtoTargetMinutes = payload.rtoTargetMinutes;
    if (payload.targetDevices !== undefined) updateData.targetDevices = payload.targetDevices;
    if (payload.targetGroups !== undefined) updateData.targetGroups = payload.targetGroups;
    if (payload.alertOnBreach !== undefined) updateData.alertOnBreach = payload.alertOnBreach;
    if (payload.isActive !== undefined) updateData.isActive = payload.isActive;

    const [updated] = await db
      .update(backupSlaConfigs)
      .set(updateData)
      .where(and(eq(backupSlaConfigs.id, id), eq(backupSlaConfigs.orgId, orgId)))
      .returning();

    writeRouteAudit(c, {
      orgId,
      action: 'backup.sla_config.update',
      resourceType: 'backup_sla_config',
      resourceId: id,
      details: payload,
    });

    return c.json({ data: updated });
  }
);

// ── DELETE /configs/:id — delete SLA config ──────────────────────────────────

slaRoutes.delete(
  '/configs/:id',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.ORGS_WRITE.resource, PERMISSIONS.ORGS_WRITE.action),
  requireMfa(),
  zValidator('param', idParamSchema),
  async (c) => {
    const auth = c.get('auth');
    const orgId = resolveScopedOrgId(auth);
    if (!orgId) {
      return c.json({ error: 'orgId is required for this scope' }, 400);
    }

    const { id } = c.req.valid('param');

    const [existing] = await db
      .select({ id: backupSlaConfigs.id })
      .from(backupSlaConfigs)
      .where(and(eq(backupSlaConfigs.id, id), eq(backupSlaConfigs.orgId, orgId)))
      .limit(1);

    if (!existing) {
      return c.json({ error: 'SLA config not found' }, 404);
    }

    // Delete related events first
    await db
      .delete(backupSlaEvents)
      .where(eq(backupSlaEvents.slaConfigId, id));

    await db
      .delete(backupSlaConfigs)
      .where(and(eq(backupSlaConfigs.id, id), eq(backupSlaConfigs.orgId, orgId)));

    writeRouteAudit(c, {
      orgId,
      action: 'backup.sla_config.delete',
      resourceType: 'backup_sla_config',
      resourceId: id,
    });

    return c.json({ success: true });
  }
);

// ── GET /events — list SLA breach events ─────────────────────────────────────

slaRoutes.get(
  '/events',
  requirePermission(PERMISSIONS.ORGS_READ.resource, PERMISSIONS.ORGS_READ.action),
  zValidator('query', slaEventsQuerySchema),
  async (c) => {
    const auth = c.get('auth');
    const orgId = resolveScopedOrgId(auth);
    if (!orgId) {
      return c.json({ error: 'orgId is required for this scope' }, 400);
    }

    const query = c.req.valid('query');
    const conditions = [eq(backupSlaEvents.orgId, orgId)];

    if (query.configId) {
      conditions.push(eq(backupSlaEvents.slaConfigId, query.configId));
    }
    if (query.deviceId) {
      conditions.push(eq(backupSlaEvents.deviceId, query.deviceId));
    }
    if (query.eventType) {
      conditions.push(eq(backupSlaEvents.eventType, query.eventType));
    }
    if (query.from) {
      const fromDate = new Date(query.from);
      if (!Number.isNaN(fromDate.getTime())) {
        conditions.push(gte(backupSlaEvents.detectedAt, fromDate));
      }
    }
    if (query.to) {
      const toDate = new Date(query.to);
      if (!Number.isNaN(toDate.getTime())) {
        conditions.push(lte(backupSlaEvents.detectedAt, toDate));
      }
    }

    const limit = query.limit ?? 100;

    const rows = await db
      .select()
      .from(backupSlaEvents)
      .where(and(...conditions))
      .orderBy(desc(backupSlaEvents.detectedAt))
      .limit(limit);

    return c.json({ data: rows });
  }
);

// ── GET /dashboard — compliance dashboard ────────────────────────────────────

slaRoutes.get('/dashboard', requirePermission(PERMISSIONS.ORGS_READ.resource, PERMISSIONS.ORGS_READ.action), async (c) => {
  const auth = c.get('auth');
  const orgId = resolveScopedOrgId(auth);
  if (!orgId) {
    return c.json({ error: 'orgId is required for this scope' }, 400);
  }

  const [configs, activeBreaches, totalEvents, avgReadiness] = await Promise.all([
    // Total active SLA configs
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(backupSlaConfigs)
      .where(and(eq(backupSlaConfigs.orgId, orgId), eq(backupSlaConfigs.isActive, true)))
      .then((r) => r[0]?.count ?? 0),

    // Active breaches (unresolved events)
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(backupSlaEvents)
      .where(and(eq(backupSlaEvents.orgId, orgId), isNull(backupSlaEvents.resolvedAt)))
      .then((r) => r[0]?.count ?? 0),

    // Total events in last 30 days
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(backupSlaEvents)
      .where(
        and(
          eq(backupSlaEvents.orgId, orgId),
          gte(backupSlaEvents.detectedAt, new Date(Date.now() - 30 * 24 * 60 * 60 * 1000))
        )
      )
      .then((r) => r[0]?.count ?? 0),

    // Average RPO/RTO from recovery readiness
    db
      .select({
        avgRpo: sql<number>`coalesce(avg(${recoveryReadiness.estimatedRpoMinutes}), 0)::int`,
        avgRto: sql<number>`coalesce(avg(${recoveryReadiness.estimatedRtoMinutes}), 0)::int`,
      })
      .from(recoveryReadiness)
      .where(eq(recoveryReadiness.orgId, orgId))
      .then((r) => r[0] ?? { avgRpo: 0, avgRto: 0 }),
  ]);

  // Compliance %: configs with zero active breaches / total active configs
  const configsWithBreaches = activeBreaches > 0
    ? await db
        .select({ count: sql<number>`count(distinct ${backupSlaEvents.slaConfigId})::int` })
        .from(backupSlaEvents)
        .where(and(eq(backupSlaEvents.orgId, orgId), isNull(backupSlaEvents.resolvedAt)))
        .then((r) => r[0]?.count ?? 0)
    : 0;

  const compliantConfigs = Math.max(0, configs - configsWithBreaches);
  const compliancePercent = configs > 0
    ? Math.round((compliantConfigs / configs) * 100)
    : 100;

  return c.json({
    data: {
      activeConfigs: configs,
      compliancePercent,
      compliantConfigs,
      activeBreaches,
      totalEventsLast30d: totalEvents,
      avgRpoMinutes: avgReadiness.avgRpo,
      avgRtoMinutes: avgReadiness.avgRto,
    },
  });
});
