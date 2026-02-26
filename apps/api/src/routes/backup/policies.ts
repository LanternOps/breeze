import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { eq, and } from 'drizzle-orm';
import { db } from '../../db';
import { backupPolicies, backupConfigs } from '../../db/schema';
import { writeRouteAudit } from '../../services/auditEvents';
import { resolveScopedOrgId } from './helpers';
import { policySchema, policyUpdateSchema } from './schemas';
import type {
  BackupPolicySchedule,
  BackupPolicyRetention,
  BackupPolicyTargets,
} from './types';

export const policiesRoutes = new Hono();

policiesRoutes.get('/policies', async (c) => {
  const auth = c.get('auth');
  const orgId = resolveScopedOrgId(auth);
  if (!orgId) {
    return c.json({ error: 'orgId is required for this scope' }, 400);
  }

  const rows = await db
    .select()
    .from(backupPolicies)
    .where(eq(backupPolicies.orgId, orgId));

  return c.json({ data: rows.map(toPolicyResponse) });
});

policiesRoutes.post(
  '/policies',
  zValidator('json', policySchema),
  async (c) => {
    const auth = c.get('auth');
    const orgId = resolveScopedOrgId(auth);
    if (!orgId) {
      return c.json({ error: 'orgId is required for this scope' }, 400);
    }

    const payload = c.req.valid('json');

    // Verify config exists and belongs to this org
    const [config] = await db
      .select({ id: backupConfigs.id })
      .from(backupConfigs)
      .where(
        and(
          eq(backupConfigs.id, payload.configId),
          eq(backupConfigs.orgId, orgId)
        )
      )
      .limit(1);

    if (!config) {
      return c.json({ error: 'Config not found' }, 400);
    }

    const now = new Date();
    const targets: BackupPolicyTargets = {
      deviceIds: payload.targets?.deviceIds ?? [],
      siteIds: payload.targets?.siteIds ?? [],
      groupIds: payload.targets?.groupIds ?? [],
    };
    const schedule: BackupPolicySchedule = {
      frequency: payload.schedule.frequency,
      time: payload.schedule.time,
      timezone: payload.schedule.timezone ?? 'UTC',
      dayOfWeek: payload.schedule.dayOfWeek,
      dayOfMonth: payload.schedule.dayOfMonth,
    };
    const retention: BackupPolicyRetention = {
      keepDaily: payload.retention?.keepDaily ?? 7,
      keepWeekly: payload.retention?.keepWeekly ?? 4,
      keepMonthly: payload.retention?.keepMonthly ?? 3,
    };

    const [row] = await db
      .insert(backupPolicies)
      .values({
        orgId,
        configId: payload.configId,
        name: payload.name,
        enabled: payload.enabled ?? true,
        targets,
        schedule,
        retention,
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    if (!row) {
      return c.json({ error: 'Failed to create policy' }, 500);
    }

    writeRouteAudit(c, {
      orgId,
      action: 'backup.policy.create',
      resourceType: 'backup_policy',
      resourceId: row.id,
      resourceName: row.name,
    });

    return c.json(toPolicyResponse(row), 201);
  }
);

policiesRoutes.patch(
  '/policies/:id',
  zValidator('json', policyUpdateSchema),
  async (c) => {
    const auth = c.get('auth');
    const orgId = resolveScopedOrgId(auth);
    if (!orgId) {
      return c.json({ error: 'orgId is required for this scope' }, 400);
    }

    const policyId = c.req.param('id');
    const payload = c.req.valid('json');

    // If configId is being changed, verify new config
    if (payload.configId !== undefined) {
      const [configExists] = await db
        .select({ id: backupConfigs.id })
        .from(backupConfigs)
        .where(
          and(
            eq(backupConfigs.id, payload.configId),
            eq(backupConfigs.orgId, orgId)
          )
        )
        .limit(1);

      if (!configExists) {
        return c.json({ error: 'Config not found' }, 400);
      }
    }

    // Load current row to merge partial updates
    const [current] = await db
      .select()
      .from(backupPolicies)
      .where(
        and(eq(backupPolicies.id, policyId), eq(backupPolicies.orgId, orgId))
      )
      .limit(1);

    if (!current) {
      return c.json({ error: 'Policy not found' }, 404);
    }

    const currentTargets = current.targets as BackupPolicyTargets;
    const currentSchedule = current.schedule as BackupPolicySchedule;
    const currentRetention = current.retention as BackupPolicyRetention;

    const updateData: Record<string, unknown> = { updatedAt: new Date() };
    if (payload.name !== undefined) updateData.name = payload.name;
    if (payload.enabled !== undefined) updateData.enabled = payload.enabled;
    if (payload.configId !== undefined) updateData.configId = payload.configId;
    if (payload.targets !== undefined) {
      updateData.targets = {
        deviceIds: payload.targets.deviceIds ?? currentTargets.deviceIds,
        siteIds: payload.targets.siteIds ?? currentTargets.siteIds,
        groupIds: payload.targets.groupIds ?? currentTargets.groupIds,
      };
    }
    if (payload.schedule !== undefined) {
      updateData.schedule = {
        frequency: payload.schedule.frequency ?? currentSchedule.frequency,
        time: payload.schedule.time ?? currentSchedule.time,
        timezone: payload.schedule.timezone ?? currentSchedule.timezone,
        dayOfWeek: payload.schedule.dayOfWeek ?? currentSchedule.dayOfWeek,
        dayOfMonth: payload.schedule.dayOfMonth ?? currentSchedule.dayOfMonth,
      };
    }
    if (payload.retention !== undefined) {
      updateData.retention = {
        keepDaily: payload.retention.keepDaily ?? currentRetention.keepDaily,
        keepWeekly: payload.retention.keepWeekly ?? currentRetention.keepWeekly,
        keepMonthly:
          payload.retention.keepMonthly ?? currentRetention.keepMonthly,
      };
    }

    const [row] = await db
      .update(backupPolicies)
      .set(updateData)
      .where(
        and(eq(backupPolicies.id, policyId), eq(backupPolicies.orgId, orgId))
      )
      .returning();

    if (!row) {
      return c.json({ error: 'Policy not found' }, 404);
    }

    writeRouteAudit(c, {
      orgId,
      action: 'backup.policy.update',
      resourceType: 'backup_policy',
      resourceId: row.id,
      resourceName: row.name,
      details: { changedFields: Object.keys(payload) },
    });

    return c.json(toPolicyResponse(row));
  }
);

policiesRoutes.delete('/policies/:id', async (c) => {
  const auth = c.get('auth');
  const orgId = resolveScopedOrgId(auth);
  if (!orgId) {
    return c.json({ error: 'orgId is required for this scope' }, 400);
  }

  const policyId = c.req.param('id');
  const [deleted] = await db
    .delete(backupPolicies)
    .where(
      and(eq(backupPolicies.id, policyId), eq(backupPolicies.orgId, orgId))
    )
    .returning();

  if (!deleted) {
    return c.json({ error: 'Policy not found' }, 404);
  }

  writeRouteAudit(c, {
    orgId,
    action: 'backup.policy.delete',
    resourceType: 'backup_policy',
    resourceId: deleted.id,
    resourceName: deleted.name,
  });

  return c.json({ deleted: true });
});

function toPolicyResponse(row: typeof backupPolicies.$inferSelect) {
  const targets = row.targets as BackupPolicyTargets;
  const schedule = row.schedule as BackupPolicySchedule;
  const retention = row.retention as BackupPolicyRetention;
  return {
    id: row.id,
    name: row.name,
    configId: row.configId,
    enabled: row.enabled,
    targets: {
      deviceIds: targets?.deviceIds ?? [],
      siteIds: targets?.siteIds ?? [],
      groupIds: targets?.groupIds ?? [],
    },
    schedule: {
      frequency: schedule?.frequency ?? 'daily',
      time: schedule?.time ?? '02:00',
      timezone: schedule?.timezone ?? 'UTC',
      dayOfWeek: schedule?.dayOfWeek,
      dayOfMonth: schedule?.dayOfMonth,
    },
    retention: {
      keepDaily: retention?.keepDaily ?? 7,
      keepWeekly: retention?.keepWeekly ?? 4,
      keepMonthly: retention?.keepMonthly ?? 3,
    },
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
