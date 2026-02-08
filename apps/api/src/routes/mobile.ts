import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, desc, eq, inArray, like, or, sql } from 'drizzle-orm';
import { createHash } from 'crypto';
import { db } from '../db';
import {
  alerts,
  deviceCommands,
  devices,
  mobileDevices,
  scriptExecutions,
  scripts
} from '../db/schema';
import { authMiddleware, requireScope, type AuthContext } from '../middleware/auth';
import { writeRouteAudit } from '../services/auditEvents';

export const mobileRoutes = new Hono();

// Helper functions
function getPagination(query: { page?: string; limit?: string }) {
  const page = Math.max(1, Number.parseInt(query.page ?? '1', 10) || 1);
  const limit = Math.min(100, Math.max(1, Number.parseInt(query.limit ?? '50', 10) || 50));
  return { page, limit, offset: (page - 1) * limit };
}

function derivePushDeviceId(userId: string, platform: 'ios' | 'android', token: string) {
  const tokenHash = createHash('sha256')
    .update(`${userId}:${platform}:${token}`)
    .digest('hex')
    .slice(0, 48);
  return `push-${platform}-${tokenHash}`;
}

async function ensureOrgAccess(
  orgId: string,
  auth: Pick<AuthContext, 'scope' | 'orgId' | 'accessibleOrgIds' | 'canAccessOrg'>
) {
  if (auth.scope === 'organization') {
    return auth.orgId === orgId;
  }

  if (auth.scope === 'partner') {
    return auth.canAccessOrg(orgId);
  }

  // system scope has access to all
  return true;
}

async function getOrgIdsForAuth(
  auth: Pick<AuthContext, 'scope' | 'orgId' | 'accessibleOrgIds' | 'canAccessOrg'>,
  orgId?: string
) {
  if (auth.scope === 'organization') {
    if (!auth.orgId) {
      return { error: { message: 'Organization context required', status: 403 } };
    }
    return { orgIds: [auth.orgId] };
  }

  if (auth.scope === 'partner') {
    if (orgId) {
      const hasAccess = await ensureOrgAccess(orgId, auth);
      if (!hasAccess) {
        return { error: { message: 'Access to this organization denied', status: 403 } };
      }
      return { orgIds: [orgId] };
    }
    return { orgIds: auth.accessibleOrgIds ?? [] };
  }

  if (auth.scope === 'system' && orgId) {
    return { orgIds: [orgId] };
  }

  return { orgIds: null };
}

async function getDeviceWithOrgCheck(
  deviceId: string,
  auth: Pick<AuthContext, 'scope' | 'orgId' | 'accessibleOrgIds' | 'canAccessOrg'>
) {
  const [device] = await db
    .select()
    .from(devices)
    .where(eq(devices.id, deviceId))
    .limit(1);

  if (!device) {
    return null;
  }

  const hasAccess = await ensureOrgAccess(device.orgId, auth);
  if (!hasAccess) {
    return null;
  }

  return device;
}

async function getAlertWithOrgCheck(
  alertId: string,
  auth: Pick<AuthContext, 'scope' | 'orgId' | 'accessibleOrgIds' | 'canAccessOrg'>
) {
  const [alert] = await db
    .select()
    .from(alerts)
    .where(eq(alerts.id, alertId))
    .limit(1);

  if (!alert) {
    return null;
  }

  const hasAccess = await ensureOrgAccess(alert.orgId, auth);
  if (!hasAccess) {
    return null;
  }

  return alert;
}

// Validation schemas
const registerDeviceSchema = z.object({
  deviceId: z.string().min(1).max(255),
  platform: z.enum(['ios', 'android']),
  fcmToken: z.string().min(1).optional(),
  apnsToken: z.string().min(1).optional(),
  model: z.string().optional(),
  osVersion: z.string().optional(),
  appVersion: z.string().optional()
}).superRefine((data, ctx) => {
  if (data.platform === 'ios' && !data.apnsToken) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'apnsToken is required for iOS devices' });
  }
  if (data.platform === 'android' && !data.fcmToken) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'fcmToken is required for Android devices' });
  }
});

const registerPushTokenSchema = z.object({
  token: z.string().min(1),
  platform: z.enum(['ios', 'android'])
});

const unregisterPushTokenSchema = z.object({
  token: z.string().min(1)
});

const updateDeviceSettingsSchema = z.object({
  enabled: z.boolean().optional(),
  severities: z.array(z.enum(['critical', 'high', 'medium', 'low', 'info'])).optional(),
  quietHours: z.object({
    start: z.string().min(1),
    end: z.string().min(1),
    timezone: z.string().min(1).optional()
  }).nullable().optional()
});

const inboxQuerySchema = z.object({
  page: z.string().optional(),
  limit: z.string().optional(),
  status: z.enum(['active', 'acknowledged', 'resolved', 'suppressed']).optional(),
  orgId: z.string().uuid().optional()
});

const resolveAlertSchema = z.object({
  note: z.string().optional()
});

const listDevicesSchema = z.object({
  page: z.string().optional(),
  limit: z.string().optional(),
  orgId: z.string().uuid().optional(),
  status: z.enum(['online', 'offline', 'maintenance', 'decommissioned']).optional(),
  search: z.string().optional()
});

const deviceActionSchema = z.object({
  action: z.enum(['reboot', 'wake', 'run_script']),
  scriptId: z.string().uuid().optional(),
  parameters: z.record(z.unknown()).optional()
}).superRefine((data, ctx) => {
  if (data.action === 'run_script' && !data.scriptId) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'scriptId is required for run_script' });
  }
});

const summaryQuerySchema = z.object({
  orgId: z.string().uuid().optional()
});

// Apply auth middleware to all routes
mobileRoutes.use('*', authMiddleware);

// POST /notifications/register - Compatibility push token registration endpoint
mobileRoutes.post(
  '/notifications/register',
  requireScope('organization', 'partner', 'system'),
  zValidator('json', registerPushTokenSchema),
  async (c) => {
    const auth = c.get('auth');
    const { token, platform } = c.req.valid('json');
    const now = new Date();
    const deviceId = derivePushDeviceId(auth.user.id, platform, token);

    const [device] = await db
      .insert(mobileDevices)
      .values({
        userId: auth.user.id,
        deviceId,
        platform,
        fcmToken: platform === 'android' ? token : null,
        apnsToken: platform === 'ios' ? token : null,
        notificationsEnabled: true,
        lastActiveAt: now,
        updatedAt: now
      })
      .onConflictDoUpdate({
        target: mobileDevices.deviceId,
        set: {
          fcmToken: platform === 'android' ? token : null,
          apnsToken: platform === 'ios' ? token : null,
          notificationsEnabled: true,
          lastActiveAt: now,
          updatedAt: now
        }
      })
      .returning();

    writeRouteAudit(c, {
      orgId: auth.orgId,
      action: 'mobile.push.register',
      resourceType: 'mobile_device',
      resourceId: device?.id,
      resourceName: device?.deviceId,
      details: { platform }
    });

    return c.json({ success: true });
  }
);

// POST /notifications/unregister - Compatibility push token unregister endpoint
mobileRoutes.post(
  '/notifications/unregister',
  requireScope('organization', 'partner', 'system'),
  zValidator('json', unregisterPushTokenSchema),
  async (c) => {
    const auth = c.get('auth');
    const { token } = c.req.valid('json');

    const removed = await db
      .delete(mobileDevices)
      .where(
        and(
          eq(mobileDevices.userId, auth.user.id),
          or(eq(mobileDevices.fcmToken, token), eq(mobileDevices.apnsToken, token))
        )
      )
      .returning();

    writeRouteAudit(c, {
      orgId: auth.orgId,
      action: 'mobile.push.unregister',
      resourceType: 'mobile_device',
      details: { removedCount: removed.length }
    });

    return c.json({ success: true });
  }
);

// POST /devices - Register mobile device for push
mobileRoutes.post(
  '/devices',
  requireScope('organization', 'partner', 'system'),
  zValidator('json', registerDeviceSchema),
  async (c) => {
    const auth = c.get('auth');
    const data = c.req.valid('json');
    const fcmToken = data.platform === 'android' ? data.fcmToken : null;
    const apnsToken = data.platform === 'ios' ? data.apnsToken : null;
    const now = new Date();

    const updateSet: Record<string, unknown> = {
      userId: auth.user.id,
      platform: data.platform,
      fcmToken,
      apnsToken,
      lastActiveAt: now,
      updatedAt: now
    };
    if (data.model !== undefined) updateSet.model = data.model;
    if (data.osVersion !== undefined) updateSet.osVersion = data.osVersion;
    if (data.appVersion !== undefined) updateSet.appVersion = data.appVersion;

    const [device] = await db
      .insert(mobileDevices)
      .values({
        userId: auth.user.id,
        deviceId: data.deviceId,
        platform: data.platform,
        model: data.model,
        osVersion: data.osVersion,
        appVersion: data.appVersion,
        fcmToken,
        apnsToken,
        lastActiveAt: now,
        updatedAt: now
      })
      .onConflictDoUpdate({
        target: mobileDevices.deviceId,
        set: updateSet
      })
      .returning();

    writeRouteAudit(c, {
      orgId: auth.orgId,
      action: 'mobile.device.register',
      resourceType: 'mobile_device',
      resourceId: device?.id,
      resourceName: device?.deviceId,
      details: { platform: data.platform }
    });

    return c.json(device, 201);
  }
);

// PATCH /devices/:id/settings - Update mobile notification settings
mobileRoutes.patch(
  '/devices/:id/settings',
  requireScope('organization', 'partner', 'system'),
  zValidator('json', updateDeviceSettingsSchema),
  async (c) => {
    const auth = c.get('auth');
    const deviceId = c.req.param('id');
    const data = c.req.valid('json');

    if (data.enabled === undefined && data.severities === undefined && data.quietHours === undefined) {
      return c.json({ error: 'No settings provided' }, 400);
    }

    const updates: Record<string, unknown> = {
      updatedAt: new Date()
    };

    if (data.enabled !== undefined) {
      updates.notificationsEnabled = data.enabled;
    }
    if (data.severities !== undefined) {
      updates.alertSeverities = data.severities;
    }
    if (data.quietHours !== undefined) {
      updates.quietHours = data.quietHours;
    }

    const [updated] = await db
      .update(mobileDevices)
      .set(updates)
      .where(
        and(
          eq(mobileDevices.id, deviceId),
          eq(mobileDevices.userId, auth.user.id)
        )
      )
      .returning();

    if (!updated) {
      return c.json({ error: 'Mobile device not found' }, 404);
    }

    writeRouteAudit(c, {
      orgId: auth.orgId,
      action: 'mobile.device.settings.update',
      resourceType: 'mobile_device',
      resourceId: updated.id,
      resourceName: updated.deviceId,
      details: { changedFields: Object.keys(data) }
    });

    return c.json(updated);
  }
);

// DELETE /devices/:id - Unregister mobile device
mobileRoutes.delete(
  '/devices/:id',
  requireScope('organization', 'partner', 'system'),
  async (c) => {
    const auth = c.get('auth');
    const deviceId = c.req.param('id');

    const [deleted] = await db
      .delete(mobileDevices)
      .where(
        and(
          eq(mobileDevices.id, deviceId),
          eq(mobileDevices.userId, auth.user.id)
        )
      )
      .returning();

    if (!deleted) {
      return c.json({ error: 'Mobile device not found' }, 404);
    }

    writeRouteAudit(c, {
      orgId: auth.orgId,
      action: 'mobile.device.unregister',
      resourceType: 'mobile_device',
      resourceId: deleted.id,
      resourceName: deleted.deviceId
    });

    return c.json({ success: true });
  }
);

// GET /alerts/inbox - Get alert inbox with status filter
mobileRoutes.get(
  '/alerts/inbox',
  requireScope('organization', 'partner', 'system'),
  zValidator('query', inboxQuerySchema),
  async (c) => {
    const auth = c.get('auth');
    const query = c.req.valid('query');
    const { page, limit, offset } = getPagination(query);

    const orgCheck = await getOrgIdsForAuth(auth, query.orgId);
    if (orgCheck.error) {
      return c.json({ error: orgCheck.error.message }, orgCheck.error.status as 400 | 403 | 404);
    }

    const conditions: ReturnType<typeof eq>[] = [];
    if (orgCheck.orgIds !== null) {
      if (orgCheck.orgIds.length === 0) {
        return c.json({ data: [], pagination: { page, limit, total: 0 } });
      }
      conditions.push(inArray(alerts.orgId, orgCheck.orgIds));
    }

    if (query.status) {
      conditions.push(eq(alerts.status, query.status));
    }

    const whereCondition = conditions.length > 0 ? and(...conditions) : undefined;

    const countResult = await db
      .select({ count: sql<number>`count(*)` })
      .from(alerts)
      .where(whereCondition);
    const total = Number(countResult[0]?.count ?? 0);

    const alertRows = await db
      .select({
        id: alerts.id,
        orgId: alerts.orgId,
        status: alerts.status,
        severity: alerts.severity,
        title: alerts.title,
        message: alerts.message,
        triggeredAt: alerts.triggeredAt,
        acknowledgedAt: alerts.acknowledgedAt,
        resolvedAt: alerts.resolvedAt,
        deviceId: alerts.deviceId,
        deviceHostname: devices.hostname,
        deviceOsType: devices.osType,
        deviceStatus: devices.status
      })
      .from(alerts)
      .leftJoin(devices, eq(alerts.deviceId, devices.id))
      .where(whereCondition)
      .orderBy(desc(alerts.triggeredAt))
      .limit(limit)
      .offset(offset);

    const data = alertRows.map(alert => ({
      id: alert.id,
      orgId: alert.orgId,
      status: alert.status,
      severity: alert.severity,
      title: alert.title,
      message: alert.message,
      triggeredAt: alert.triggeredAt,
      acknowledgedAt: alert.acknowledgedAt,
      resolvedAt: alert.resolvedAt,
      device: alert.deviceId ? {
        id: alert.deviceId,
        hostname: alert.deviceHostname,
        osType: alert.deviceOsType,
        status: alert.deviceStatus
      } : null
    }));

    return c.json({
      data,
      pagination: { page, limit, total }
    });
  }
);

// POST /alerts/:id/acknowledge - Quick acknowledge from mobile
mobileRoutes.post(
  '/alerts/:id/acknowledge',
  requireScope('organization', 'partner', 'system'),
  async (c) => {
    const auth = c.get('auth');
    const alertId = c.req.param('id');

    const alert = await getAlertWithOrgCheck(alertId, auth);
    if (!alert) {
      return c.json({ error: 'Alert not found' }, 404);
    }

    if (alert.status !== 'active') {
      return c.json({ error: `Cannot acknowledge alert with status: ${alert.status}` }, 400);
    }

    const [updated] = await db
      .update(alerts)
      .set({
        status: 'acknowledged',
        acknowledgedAt: new Date(),
        acknowledgedBy: auth.user.id
      })
      .where(eq(alerts.id, alertId))
      .returning();

    writeRouteAudit(c, {
      orgId: alert.orgId,
      action: 'mobile.alert.acknowledge',
      resourceType: 'alert',
      resourceId: updated?.id ?? alertId,
      resourceName: updated?.title ?? alert.title
    });

    return c.json(updated);
  }
);

// POST /alerts/:id/resolve - Quick resolve with optional note
mobileRoutes.post(
  '/alerts/:id/resolve',
  requireScope('organization', 'partner', 'system'),
  zValidator('json', resolveAlertSchema),
  async (c) => {
    const auth = c.get('auth');
    const alertId = c.req.param('id');
    const data = c.req.valid('json');

    const alert = await getAlertWithOrgCheck(alertId, auth);
    if (!alert) {
      return c.json({ error: 'Alert not found' }, 404);
    }

    if (alert.status === 'resolved') {
      return c.json({ error: 'Alert is already resolved' }, 400);
    }

    const [updated] = await db
      .update(alerts)
      .set({
        status: 'resolved',
        resolvedAt: new Date(),
        resolvedBy: auth.user.id,
        resolutionNote: data.note
      })
      .where(eq(alerts.id, alertId))
      .returning();

    writeRouteAudit(c, {
      orgId: alert.orgId,
      action: 'mobile.alert.resolve',
      resourceType: 'alert',
      resourceId: updated?.id ?? alertId,
      resourceName: updated?.title ?? alert.title,
      details: { hasNote: Boolean(data.note) }
    });

    return c.json(updated);
  }
);

// GET /devices - Get simplified device list for mobile
mobileRoutes.get(
  '/devices',
  requireScope('organization', 'partner', 'system'),
  zValidator('query', listDevicesSchema),
  async (c) => {
    const auth = c.get('auth');
    const query = c.req.valid('query');
    const { page, limit, offset } = getPagination(query);

    const orgCheck = await getOrgIdsForAuth(auth, query.orgId);
    if (orgCheck.error) {
      return c.json({ error: orgCheck.error.message }, orgCheck.error.status as 400 | 403 | 404);
    }

    const conditions: ReturnType<typeof eq>[] = [];
    if (orgCheck.orgIds !== null) {
      if (orgCheck.orgIds.length === 0) {
        return c.json({ data: [], pagination: { page, limit, total: 0 } });
      }
      conditions.push(inArray(devices.orgId, orgCheck.orgIds));
    }

    if (query.status) {
      conditions.push(eq(devices.status, query.status));
    }

    if (query.search) {
      conditions.push(like(devices.hostname, `%${query.search}%`));
    }

    if (!query.status) {
      conditions.push(sql`${devices.status} != 'decommissioned'`);
    }

    const whereCondition = conditions.length > 0 ? and(...conditions) : undefined;

    const countResult = await db
      .select({ count: sql<number>`count(*)` })
      .from(devices)
      .where(whereCondition);
    const total = Number(countResult[0]?.count ?? 0);

    const deviceRows = await db
      .select({
        id: devices.id,
        orgId: devices.orgId,
        siteId: devices.siteId,
        hostname: devices.hostname,
        displayName: devices.displayName,
        osType: devices.osType,
        status: devices.status,
        lastSeenAt: devices.lastSeenAt
      })
      .from(devices)
      .where(whereCondition)
      .orderBy(desc(devices.lastSeenAt))
      .limit(limit)
      .offset(offset);

    return c.json({
      data: deviceRows,
      pagination: { page, limit, total }
    });
  }
);

// POST /devices/:id/actions - Quick actions (reboot, wake, run_script)
mobileRoutes.post(
  '/devices/:id/actions',
  requireScope('organization', 'partner', 'system'),
  zValidator('json', deviceActionSchema),
  async (c) => {
    const auth = c.get('auth');
    const deviceId = c.req.param('id');
    const data = c.req.valid('json');

    const device = await getDeviceWithOrgCheck(deviceId, auth);
    if (!device) {
      return c.json({ error: 'Device not found' }, 404);
    }

    if (device.status === 'decommissioned') {
      return c.json({ error: 'Device is decommissioned' }, 400);
    }

    if (data.action === 'run_script') {
      const [script] = await db
        .select()
        .from(scripts)
        .where(eq(scripts.id, data.scriptId as string))
        .limit(1);

      if (!script) {
        return c.json({ error: 'Script not found' }, 404);
      }

      if (script.orgId) {
        const hasAccess = await ensureOrgAccess(script.orgId, auth);
        if (!hasAccess) {
          return c.json({ error: 'Access to this script denied' }, 403);
        }
      }

      if (!script.osTypes.includes(device.osType)) {
        return c.json({ error: 'Script is not compatible with device OS' }, 400);
      }

      const executionResult = await db
        .insert(scriptExecutions)
        .values({
          scriptId: script.id,
          deviceId: device.id,
          triggeredBy: auth.user.id,
          triggerType: 'manual',
          parameters: data.parameters,
          status: 'pending'
        })
        .returning();
      const execution = executionResult[0];

      if (!execution) {
        return c.json({ error: 'Failed to create execution' }, 500);
      }

      const commandResult = await db
        .insert(deviceCommands)
        .values({
          deviceId: device.id,
          type: 'script',
          payload: {
            scriptId: script.id,
            executionId: execution.id,
            language: script.language,
            content: script.content,
            parameters: data.parameters,
            timeoutSeconds: script.timeoutSeconds,
            runAs: script.runAs
          },
          status: 'pending',
          createdBy: auth.user.id
        })
        .returning();
      const command = commandResult[0];

      if (!command) {
        return c.json({ error: 'Failed to create command' }, 500);
      }

      writeRouteAudit(c, {
        orgId: device.orgId,
        action: 'mobile.device.action',
        resourceType: 'device',
        resourceId: device.id,
        resourceName: device.hostname,
        details: {
          action: data.action,
          scriptId: script.id,
          executionId: execution.id,
          commandId: command.id
        }
      });

      return c.json({
        action: data.action,
        executionId: execution.id,
        commandId: command.id
      }, 201);
    }

    const cmdResult = await db
      .insert(deviceCommands)
      .values({
        deviceId: device.id,
        type: data.action,
        payload: { source: 'mobile' },
        status: 'pending',
        createdBy: auth.user.id
      })
      .returning();
    const cmd = cmdResult[0];

    if (!cmd) {
      return c.json({ error: 'Failed to create command' }, 500);
    }

    writeRouteAudit(c, {
      orgId: device.orgId,
      action: 'mobile.device.action',
      resourceType: 'device',
      resourceId: device.id,
      resourceName: device.hostname,
      details: {
        action: data.action,
        commandId: cmd.id
      }
    });

    return c.json({
      action: data.action,
      commandId: cmd.id
    }, 201);
  }
);

// GET /summary - Get dashboard summary
mobileRoutes.get(
  '/summary',
  requireScope('organization', 'partner', 'system'),
  zValidator('query', summaryQuerySchema),
  async (c) => {
    const auth = c.get('auth');
    const query = c.req.valid('query');

    const orgCheck = await getOrgIdsForAuth(auth, query.orgId);
    if (orgCheck.error) {
      return c.json({ error: orgCheck.error.message }, orgCheck.error.status as 400 | 403 | 404);
    }

    const deviceConditions: ReturnType<typeof eq>[] = [];
    if (orgCheck.orgIds !== null) {
      if (orgCheck.orgIds.length === 0) {
        return c.json({
          devices: { total: 0, online: 0, offline: 0, maintenance: 0 },
          alerts: { total: 0, active: 0, acknowledged: 0, resolved: 0, critical: 0 }
        });
      }
      deviceConditions.push(inArray(devices.orgId, orgCheck.orgIds));
    }

    const deviceWhere = deviceConditions.length > 0 ? and(...deviceConditions) : undefined;

    const deviceStats = await db
      .select({
        total: sql<number>`count(*)`,
        online: sql<number>`sum(case when ${devices.status} = 'online' then 1 else 0 end)`,
        offline: sql<number>`sum(case when ${devices.status} = 'offline' then 1 else 0 end)`,
        maintenance: sql<number>`sum(case when ${devices.status} = 'maintenance' then 1 else 0 end)`
      })
      .from(devices)
      .where(deviceWhere);

    const alertConditions: ReturnType<typeof eq>[] = [];
    if (orgCheck.orgIds !== null) {
      alertConditions.push(inArray(alerts.orgId, orgCheck.orgIds));
    }
    const alertWhere = alertConditions.length > 0 ? and(...alertConditions) : undefined;

    const alertStats = await db
      .select({
        total: sql<number>`count(*)`,
        active: sql<number>`sum(case when ${alerts.status} = 'active' then 1 else 0 end)`,
        acknowledged: sql<number>`sum(case when ${alerts.status} = 'acknowledged' then 1 else 0 end)`,
        resolved: sql<number>`sum(case when ${alerts.status} = 'resolved' then 1 else 0 end)`,
        critical: sql<number>`sum(case when ${alerts.status} in ('active', 'acknowledged') and ${alerts.severity} = 'critical' then 1 else 0 end)`
      })
      .from(alerts)
      .where(alertWhere);

    return c.json({
      devices: {
        total: Number(deviceStats[0]?.total ?? 0),
        online: Number(deviceStats[0]?.online ?? 0),
        offline: Number(deviceStats[0]?.offline ?? 0),
        maintenance: Number(deviceStats[0]?.maintenance ?? 0)
      },
      alerts: {
        total: Number(alertStats[0]?.total ?? 0),
        active: Number(alertStats[0]?.active ?? 0),
        acknowledged: Number(alertStats[0]?.acknowledged ?? 0),
        resolved: Number(alertStats[0]?.resolved ?? 0),
        critical: Number(alertStats[0]?.critical ?? 0)
      }
    });
  }
);
