import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, desc, eq, gte, ilike, inArray, like, or, sql } from 'drizzle-orm';
import { createHash } from 'crypto';
import { db } from '../db';
import {
  aiSessions,
  alerts,
  alertRules,
  alertTemplates,
  deviceCommands,
  devices,
  mobileDevices,
  scriptExecutions,
  scripts,
  sites
} from '../db/schema';
import { authMiddleware, requireMfa, requirePermission, requireScope, type AuthContext } from '../middleware/auth';
import { userRateLimit } from '../middleware/userRateLimit';
import { setCooldown, markConfigPolicyRuleCooldown } from '../services/alertCooldown';
import { writeRouteAudit } from '../services/auditEvents';
import { publishEvent } from '../services/eventBus';
import { canAccessSite, PERMISSIONS, type UserPermissions } from '../services/permissions';
import { dispatchWake } from '../services/wakeOnLan';
import { getTrustedClientIpOrUndefined } from '../services/clientIp';

export const mobileRoutes = new Hono();
const requireMobileAlertRead = requirePermission(PERMISSIONS.ALERTS_READ.resource, PERMISSIONS.ALERTS_READ.action);
const requireMobileAlertAcknowledge = requirePermission(PERMISSIONS.ALERTS_ACKNOWLEDGE.resource, PERMISSIONS.ALERTS_ACKNOWLEDGE.action);
const requireMobileAlertWrite = requirePermission(PERMISSIONS.ALERTS_WRITE.resource, PERMISSIONS.ALERTS_WRITE.action);
const requireMobileDeviceRead = requirePermission(PERMISSIONS.DEVICES_READ.resource, PERMISSIONS.DEVICES_READ.action);
const requireMobileDeviceExecute = requirePermission(PERMISSIONS.DEVICES_EXECUTE.resource, PERMISSIONS.DEVICES_EXECUTE.action);

async function requireScriptExecuteForRunScript(c: import('hono').Context, next: import('hono').Next) {
  const data = (c.req as unknown as { valid: (target: 'json') => { action?: string } }).valid('json');
  if (data.action !== 'run_script') {
    return next();
  }
  return requirePermission(PERMISSIONS.SCRIPTS_EXECUTE.resource, PERMISSIONS.SCRIPTS_EXECUTE.action)(c, next);
}

// Helper functions
function getPagination(query: { page?: string; limit?: string }) {
  const page = Math.max(1, Number.parseInt(query.page ?? '1', 10) || 1);
  const limit = Math.min(100, Math.max(1, Number.parseInt(query.limit ?? '50', 10) || 50));
  return { page, limit, offset: (page - 1) * limit };
}

// Keyset cursor: opaque base64url JSON {ts,id}. Optional and additive — when
// not supplied, page/limit semantics are unchanged. When supplied, paginates
// past the (timestamp,id) pair on the ordering column.
// Exported for unit testing.
export type CursorTuple = { ts: Date; id: string };
export function encodeCursor(ts: Date | string | null | undefined, id: string): string | null {
  if (!ts || !id) return null;
  const iso = ts instanceof Date ? ts.toISOString() : ts;
  return Buffer.from(JSON.stringify({ ts: iso, id }), 'utf8').toString('base64url');
}
export function decodeCursor(raw: string | undefined): CursorTuple | null {
  if (!raw) return null;
  try {
    const json = Buffer.from(raw, 'base64url').toString('utf8');
    const parsed = JSON.parse(json) as { ts?: unknown; id?: unknown };
    if (typeof parsed.ts !== 'string' || typeof parsed.id !== 'string') return null;
    const ts = new Date(parsed.ts);
    if (Number.isNaN(ts.getTime())) return null;
    return { ts, id: parsed.id };
  } catch {
    return null;
  }
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

async function resolveSiteAllowedDeviceIds(orgId: string, perms: UserPermissions | undefined): Promise<string[] | null> {
  if (!perms?.allowedSiteIds) return null;
  const orgDevices = await db.select({ id: devices.id, siteId: devices.siteId }).from(devices).where(eq(devices.orgId, orgId));
  return orgDevices.filter((d) => typeof d.siteId === 'string' && canAccessSite(perms, d.siteId)).map((d) => d.id);
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
  cursor: z.string().optional(),
  status: z.enum(['active', 'acknowledged', 'resolved', 'suppressed']).optional(),
  orgId: z.string().uuid().optional()
});

const resolveAlertSchema = z.object({
  note: z.string().optional()
});

const listDevicesSchema = z.object({
  page: z.string().optional(),
  limit: z.string().optional(),
  cursor: z.string().optional(),
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
    let deviceId = derivePushDeviceId(auth.user.id, platform, token);

    // If a row already exists for this deviceId AND it's blocked, insert
    // a fresh row instead of reactivating the blocked one. We salt with
    // the current timestamp so the new deviceId is unique.
    const [existing] = await db
      .select({ status: mobileDevices.status })
      .from(mobileDevices)
      .where(eq(mobileDevices.deviceId, deviceId))
      .limit(1);
    if (existing?.status === 'blocked') {
      deviceId = `${deviceId}-${now.getTime()}`;
    }

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
        },
        // Belt-and-suspenders: never overwrite a blocked row via conflict
        // path; the salted-id branch above keeps us out of this case
        // entirely, but if a race lands a fresh row in between we still
        // want the conflict update to skip blocked rows.
        setWhere: sql`${mobileDevices.status} = 'active'`
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

    // `device_id` is globally unique. Without an ownership guard the conflict
    // path below would happily reassign another user's row to the caller
    // (and RLS permits it for same-tenant callers). Refuse up front if the
    // id is registered to anyone else — never touch a row we don't own. SR-002.
    const [existing] = await db
      .select({ status: mobileDevices.status, userId: mobileDevices.userId })
      .from(mobileDevices)
      .where(eq(mobileDevices.deviceId, data.deviceId))
      .limit(1);
    if (existing && existing.userId !== auth.user.id) {
      return c.json(
        {
          error: 'This device is already registered to another account.',
          code: 'device_owned_by_other',
        },
        409
      );
    }

    // Same blocked-row protection as /notifications/register: if our own row
    // for this deviceId is `blocked`, salt the id so the re-pair lands in a
    // fresh row instead of reactivating the blocked one.
    const insertDeviceId = existing?.status === 'blocked'
      ? `${data.deviceId}-${now.getTime()}`
      : data.deviceId;

    const [device] = await db
      .insert(mobileDevices)
      .values({
        userId: auth.user.id,
        deviceId: insertDeviceId,
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
        set: updateSet,
        // Defense-in-depth against a race between the ownership check above
        // and this upsert: the update can only ever touch an active row the
        // caller already owns. A foreign/blocked row yields 0 updated rows.
        setWhere: sql`${mobileDevices.status} = 'active' AND ${mobileDevices.userId} = ${auth.user.id}`
      })
      .returning();

    if (!device) {
      // Conflict fired but the owned-and-active guard matched no row — the id
      // was taken by another user between the check and the upsert. Never
      // fall through to a 201 with a null body.
      return c.json(
        {
          error: 'This device is already registered to another account.',
          code: 'device_owned_by_other',
        },
        409
      );
    }

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
    const deviceId = c.req.param('id')!;
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
    const deviceId = c.req.param('id')!;

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
//
// Pagination is dual-mode (additive):
//   - Legacy: page+limit; response carries `total` so callers can show "N of M".
//   - Cursor: opaque `cursor` from a prior response's `nextCursor`; keyset on
//     (triggered_at DESC, id DESC). Stable under concurrent inserts and cheap
//     on deep pages. When `cursor` is supplied, `page` is ignored.
mobileRoutes.get(
  '/alerts/inbox',
  requireScope('organization', 'partner', 'system'),
  requireMobileAlertRead,
  zValidator('query', inboxQuerySchema),
  async (c) => {
    const auth = c.get('auth');
    const query = c.req.valid('query');
    const { page, limit, offset } = getPagination(query);
    const cursor = decodeCursor(query.cursor);

    const orgCheck = await getOrgIdsForAuth(auth, query.orgId);
    if (orgCheck.error) {
      return c.json({ error: orgCheck.error.message }, orgCheck.error.status as 400 | 403 | 404);
    }

    const conditions: ReturnType<typeof eq>[] = [];
    if (orgCheck.orgIds !== null) {
      if (orgCheck.orgIds.length === 0) {
        return c.json({ data: [], pagination: { page, limit, total: 0, nextCursor: null } });
      }
      conditions.push(inArray(alerts.orgId, orgCheck.orgIds));
    }

    const perms = c.get('permissions') as UserPermissions | undefined;
    if (perms?.allowedSiteIds && auth.orgId) {
      const allowedDeviceIds = await resolveSiteAllowedDeviceIds(auth.orgId, perms);
      if (!allowedDeviceIds || allowedDeviceIds.length === 0) {
        return c.json({ data: [], pagination: { page, limit, total: 0, nextCursor: null } });
      }
      conditions.push(inArray(alerts.deviceId, allowedDeviceIds));
    }

    if (query.status) {
      conditions.push(eq(alerts.status, query.status));
    }

    if (cursor) {
      conditions.push(
        sql`(${alerts.triggeredAt} < ${cursor.ts.toISOString()} OR (${alerts.triggeredAt} = ${cursor.ts.toISOString()} AND ${alerts.id} < ${cursor.id}))`
      );
    }

    const whereCondition = conditions.length > 0 ? and(...conditions) : undefined;

    const countResult = await db
      .select({ count: sql<number>`count(*)` })
      .from(alerts)
      .where(whereCondition);
    const total = Number(countResult[0]?.count ?? 0);

    const fetchLimit = cursor ? limit + 1 : limit;
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
      .orderBy(desc(alerts.triggeredAt), desc(alerts.id))
      .limit(fetchLimit)
      .offset(cursor ? 0 : offset);

    let trimmedRows = alertRows;
    let nextCursor: string | null = null;
    if (cursor) {
      const hasMore = alertRows.length > limit;
      trimmedRows = hasMore ? alertRows.slice(0, limit) : alertRows;
      const last = trimmedRows[trimmedRows.length - 1];
      if (hasMore && last) {
        nextCursor = encodeCursor(last.triggeredAt, last.id);
      }
    }

    const data = trimmedRows.map(alert => ({
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
      pagination: { page, limit, total, nextCursor }
    });
  }
);

// POST /alerts/:id/acknowledge - Quick acknowledge from mobile
mobileRoutes.post(
  '/alerts/:id/acknowledge',
  requireScope('organization', 'partner', 'system'),
  requireMobileAlertAcknowledge,
  async (c) => {
    const auth = c.get('auth');
    const alertId = c.req.param('id')!;

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

    try {
      await publishEvent(
        'alert.acknowledged',
        alert.orgId,
        {
          alertId: updated?.id ?? alertId,
          ruleId: alert.ruleId,
          deviceId: alert.deviceId,
          acknowledgedBy: auth.user.id
        },
        'mobile-routes',
        { userId: auth.user.id }
      );
    } catch (error) {
      console.error('[MobileRoutes] Failed to publish alert.acknowledged event:', error);
    }

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
  requireMobileAlertWrite,
  zValidator('json', resolveAlertSchema),
  async (c) => {
    const auth = c.get('auth');
    const alertId = c.req.param('id')!;
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

    try {
      if (alert.ruleId) {
        const [rule] = await db
          .select()
          .from(alertRules)
          .where(eq(alertRules.id, alert.ruleId))
          .limit(1);

        if (rule) {
          const [template] = await db
            .select()
            .from(alertTemplates)
            .where(eq(alertTemplates.id, rule.templateId))
            .limit(1);

          const overrides = (rule.overrideSettings as Record<string, unknown> | null) ?? null;
          const cooldownMinutes = (overrides?.cooldownMinutes as number) ??
            template?.cooldownMinutes ?? 15;
          await setCooldown(alert.ruleId, alert.deviceId, cooldownMinutes);
        }
      } else if (alert.configPolicyId) {
        const ctx = alert.context as Record<string, unknown> | null;
        const cooldownMinutes = typeof ctx?.cooldownMinutes === 'number' ? ctx.cooldownMinutes : 5;
        await markConfigPolicyRuleCooldown(alert.configPolicyId, alert.deviceId, cooldownMinutes);
      }
    } catch (error) {
      console.error('[MobileRoutes] Failed to set alert cooldown on resolve:', error);
    }

    try {
      await publishEvent(
        'alert.resolved',
        alert.orgId,
        {
          alertId: updated?.id ?? alertId,
          ruleId: alert.ruleId,
          deviceId: alert.deviceId,
          resolvedBy: auth.user.id,
          resolutionNote: data.note
        },
        'mobile-routes',
        { userId: auth.user.id }
      );
    } catch (error) {
      console.error('[MobileRoutes] Failed to publish alert.resolved event:', error);
    }

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
//
// Pagination is dual-mode (additive):
//   - Legacy: page+limit; response carries `total` so callers can show "N of M".
//   - Cursor: opaque `cursor` from a prior response's `nextCursor`; keyset on
//     (last_seen_at DESC, id DESC). Stable under concurrent inserts and cheap
//     on deep pages. When `cursor` is supplied, `page` is ignored.
mobileRoutes.get(
  '/devices',
  requireScope('organization', 'partner', 'system'),
  requireMobileDeviceRead,
  zValidator('query', listDevicesSchema),
  async (c) => {
    const auth = c.get('auth');
    const query = c.req.valid('query');
    const { page, limit, offset } = getPagination(query);
    const cursor = decodeCursor(query.cursor);

    const orgCheck = await getOrgIdsForAuth(auth, query.orgId);
    if (orgCheck.error) {
      return c.json({ error: orgCheck.error.message }, orgCheck.error.status as 400 | 403 | 404);
    }

    const conditions: ReturnType<typeof eq>[] = [];
    if (orgCheck.orgIds !== null) {
      if (orgCheck.orgIds.length === 0) {
        return c.json({ data: [], pagination: { page, limit, total: 0, nextCursor: null } });
      }
      conditions.push(inArray(devices.orgId, orgCheck.orgIds));
    }

    const perms = c.get('permissions') as UserPermissions | undefined;
    if (perms?.allowedSiteIds) {
      if (perms.allowedSiteIds.length === 0) {
        return c.json({ data: [], pagination: { page, limit, total: 0, nextCursor: null } });
      }
      conditions.push(inArray(devices.siteId, perms.allowedSiteIds));
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

    if (cursor) {
      conditions.push(
        sql`(${devices.lastSeenAt} < ${cursor.ts.toISOString()} OR (${devices.lastSeenAt} = ${cursor.ts.toISOString()} AND ${devices.id} < ${cursor.id}))`
      );
    }

    const whereCondition = conditions.length > 0 ? and(...conditions) : undefined;

    const countResult = await db
      .select({ count: sql<number>`count(*)` })
      .from(devices)
      .where(whereCondition);
    const total = Number(countResult[0]?.count ?? 0);

    const fetchLimit = cursor ? limit + 1 : limit;
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
      .orderBy(desc(devices.lastSeenAt), desc(devices.id))
      .limit(fetchLimit)
      .offset(cursor ? 0 : offset);

    let items = deviceRows;
    let nextCursor: string | null = null;
    if (cursor) {
      const hasMore = deviceRows.length > limit;
      items = hasMore ? deviceRows.slice(0, limit) : deviceRows;
      const last = items[items.length - 1];
      if (hasMore && last) {
        nextCursor = encodeCursor(last.lastSeenAt, last.id);
      }
    }

    return c.json({
      data: items,
      pagination: { page, limit, total, nextCursor }
    });
  }
);

// POST /devices/:id/actions - Quick actions (reboot, wake, run_script)
mobileRoutes.post(
  '/devices/:id/actions',
  requireScope('organization', 'partner', 'system'),
  requireMobileDeviceExecute,
  requireMfa(),
  zValidator('json', deviceActionSchema),
  requireScriptExecuteForRunScript,
  async (c) => {
    const auth = c.get('auth');
    const deviceId = c.req.param('id')!;
    const data = c.req.valid('json');

    const device = await getDeviceWithOrgCheck(deviceId, auth);
    if (!device) {
      return c.json({ error: 'Device not found' }, 404);
    }
    const permissions = c.get('permissions') as UserPermissions | undefined;
    if (permissions?.allowedSiteIds && (typeof device.siteId !== 'string' || !canAccessSite(permissions, device.siteId))) {
      return c.json({ error: 'Access to this site denied' }, 403);
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
          orgId: device.orgId,
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

    // Wake-on-LAN: dispatch via the relay-aware service. Audit row is written
    // by the service against the target device; no route-level audit here to
    // avoid duplication.
    if (data.action === 'wake') {
      const wake = await dispatchWake(device.id, auth.user.id, {
        ipAddress: getTrustedClientIpOrUndefined(c),
        userAgent: c.req.header('user-agent'),
      });
      if (!wake.ok) {
        return c.json({ error: wake.message, code: wake.code }, 412);
      }
      return c.json({
        action: 'wake',
        commandId: wake.commandId,
        wakeAttemptId: wake.wakeAttemptId,
        relay: { deviceId: wake.relayDeviceId, hostname: wake.relayHostname },
        network: wake.network,
        broadcast: wake.broadcast,
        macs: wake.macs,
      }, 202);
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
  requireMobileDeviceRead,
  requireMobileAlertRead,
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

// GET /search - Unified mobile search across devices, alerts, AI sessions
const searchQuerySchema = z.object({
  q: z.string().trim().min(1).max(100),
  limit: z.coerce.number().int().min(1).max(50).optional()
});

type SearchResult =
  | {
      kind: 'device';
      id: string;
      title: string;
      subtitle: string;
      meta: {
        orgId: string;
        siteId: string | null;
        hostname: string | null;
        displayName: string | null;
        osType: string | null;
        status: string | null;
        lastSeenAt: string | null;
        siteName: string | null;
      };
    }
  | {
      kind: 'alert';
      id: string;
      title: string;
      subtitle: string;
      meta: {
        orgId: string;
        severity: string;
        status: string;
        deviceId: string | null;
        deviceName: string | null;
        message: string | null;
        triggeredAt: string | null;
      };
    }
  | {
      kind: 'session';
      id: string;
      title: string;
      subtitle: string;
      meta: {
        orgId: string;
        status: string;
        turnCount: number;
        lastActivityAt: string | null;
        createdAt: string | null;
      };
    };

mobileRoutes.get(
  '/search',
  requireScope('organization', 'partner', 'system'),
  userRateLimit('mobile-search', 30, 60),
  zValidator('query', searchQuerySchema),
  async (c) => {
    const auth = c.get('auth');
    const { q, limit = 20 } = c.req.valid('query');

    const orgCheck = await getOrgIdsForAuth(auth);
    if (orgCheck.error) {
      return c.json({ error: orgCheck.error.message }, orgCheck.error.status as 400 | 403 | 404);
    }
    if (orgCheck.orgIds !== null && orgCheck.orgIds.length === 0) {
      return c.json({ results: [] });
    }

    const term = `%${q.replace(/[%_]/g, (m) => `\\${m}`)}%`;
    const cappedLimit = Math.min(50, Math.max(1, limit));
    // Distribute results so one kind never starves others. Each kind gets
    // up to ~ceil(limit/3) candidates; we then trim to cappedLimit total.
    const perKind = Math.max(2, Math.ceil(cappedLimit / 3));
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const orgFilter = orgCheck.orgIds === null ? undefined : inArray;
    const perms = c.get('permissions') as UserPermissions | undefined;
    const allowedDeviceIds = perms?.allowedSiteIds && auth.orgId
      ? await resolveSiteAllowedDeviceIds(auth.orgId, perms)
      : null;

    const deviceWhere = and(
      orgCheck.orgIds === null ? sql`true` : inArray(devices.orgId, orgCheck.orgIds),
      perms?.allowedSiteIds ? inArray(devices.siteId, perms.allowedSiteIds) : sql`true`,
      or(
        ilike(devices.hostname, term),
        ilike(devices.displayName, term),
        ilike(sql`${devices.osType}::text`, term),
        ilike(sites.name, term)
      )
    );

    const alertWhere = and(
      orgCheck.orgIds === null ? sql`true` : inArray(alerts.orgId, orgCheck.orgIds),
      allowedDeviceIds === null ? sql`true` : inArray(alerts.deviceId, allowedDeviceIds),
      gte(alerts.triggeredAt, thirtyDaysAgo),
      or(ilike(alerts.title, term), ilike(alerts.message, term))
    );

    const sessionWhere = and(
      orgCheck.orgIds === null ? sql`true` : inArray(aiSessions.orgId, orgCheck.orgIds),
      gte(aiSessions.lastActivityAt, thirtyDaysAgo),
      ilike(aiSessions.title, term)
    );

    // Suppress the unused-import lint when orgCheck.orgIds is null.
    void orgFilter;

    const [deviceRows, alertRows, sessionRows] = await Promise.all([
      db
        .select({
          id: devices.id,
          orgId: devices.orgId,
          siteId: devices.siteId,
          hostname: devices.hostname,
          displayName: devices.displayName,
          osType: devices.osType,
          status: devices.status,
          lastSeenAt: devices.lastSeenAt,
          siteName: sites.name
        })
        .from(devices)
        .leftJoin(sites, eq(devices.siteId, sites.id))
        .where(deviceWhere)
        .orderBy(desc(devices.lastSeenAt))
        .limit(perKind),
      db
        .select({
          id: alerts.id,
          orgId: alerts.orgId,
          severity: alerts.severity,
          status: alerts.status,
          title: alerts.title,
          message: alerts.message,
          triggeredAt: alerts.triggeredAt,
          deviceId: alerts.deviceId,
          deviceHostname: devices.hostname,
          deviceDisplayName: devices.displayName
        })
        .from(alerts)
        .leftJoin(devices, eq(alerts.deviceId, devices.id))
        .where(alertWhere)
        .orderBy(desc(alerts.triggeredAt))
        .limit(perKind),
      db
        .select({
          id: aiSessions.id,
          orgId: aiSessions.orgId,
          title: aiSessions.title,
          status: aiSessions.status,
          turnCount: aiSessions.turnCount,
          lastActivityAt: aiSessions.lastActivityAt,
          createdAt: aiSessions.createdAt
        })
        .from(aiSessions)
        .where(sessionWhere)
        .orderBy(desc(aiSessions.lastActivityAt))
        .limit(perKind)
    ]);

    const severityRank: Record<string, number> = {
      critical: 0,
      high: 1,
      medium: 2,
      low: 3,
      info: 4
    };

    const deviceResults: SearchResult[] = deviceRows.map((row) => {
      const title = row.displayName?.trim() || row.hostname || 'Untitled device';
      const subtitleParts = [
        row.osType ?? null,
        row.siteName ?? null,
        row.status ?? null
      ].filter((v): v is string => Boolean(v));
      return {
        kind: 'device' as const,
        id: row.id,
        title,
        subtitle: subtitleParts.join(' · '),
        meta: {
          orgId: row.orgId,
          siteId: row.siteId ?? null,
          hostname: row.hostname ?? null,
          displayName: row.displayName ?? null,
          osType: row.osType ?? null,
          status: row.status ?? null,
          lastSeenAt: row.lastSeenAt ? new Date(row.lastSeenAt).toISOString() : null,
          siteName: row.siteName ?? null
        }
      };
    });

    const alertResults: SearchResult[] = alertRows.map((row) => {
      const deviceName = row.deviceHostname || row.deviceDisplayName || null;
      const subtitleParts = [row.severity, deviceName].filter((v): v is string => Boolean(v));
      return {
        kind: 'alert' as const,
        id: row.id,
        title: row.title,
        subtitle: subtitleParts.join(' · '),
        meta: {
          orgId: row.orgId,
          severity: row.severity,
          status: row.status,
          deviceId: row.deviceId ?? null,
          deviceName,
          message: row.message ?? null,
          triggeredAt: row.triggeredAt ? new Date(row.triggeredAt).toISOString() : null
        }
      };
    });

    const sessionResults: SearchResult[] = sessionRows.map((row) => ({
      kind: 'session' as const,
      id: row.id,
      title: row.title?.trim() || 'Untitled conversation',
      subtitle: `${row.turnCount} turn${row.turnCount === 1 ? '' : 's'}`,
      meta: {
        orgId: row.orgId,
        status: row.status,
        turnCount: row.turnCount,
        lastActivityAt: row.lastActivityAt ? new Date(row.lastActivityAt).toISOString() : null,
        createdAt: row.createdAt ? new Date(row.createdAt).toISOString() : null
      }
    }));

    // Severity-then-kind ordering: alerts sort by severity, devices and
    // sessions interleave by kind below. We round-robin to avoid one kind
    // monopolising the cap.
    alertResults.sort((a, b) => {
      const aRank = severityRank[(a.meta as { severity: string }).severity] ?? 99;
      const bRank = severityRank[(b.meta as { severity: string }).severity] ?? 99;
      return aRank - bRank;
    });

    const merged: SearchResult[] = [];
    const queues: SearchResult[][] = [alertResults, deviceResults, sessionResults];
    while (merged.length < cappedLimit) {
      let pulled = false;
      for (const queue of queues) {
        if (merged.length >= cappedLimit) break;
        const next = queue.shift();
        if (next) {
          merged.push(next);
          pulled = true;
        }
      }
      if (!pulled) break;
    }

    return c.json({ results: merged });
  }
);
