import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { and, eq, sql, desc, gte, lte, inArray } from 'drizzle-orm';
import { db } from '../../db';
import {
  alertRules,
  alertTemplates,
  alerts,
  notificationChannels,
  alertNotifications,
  devices,
} from '../../db/schema';
import { requireScope } from '../../middleware/auth';
import { setCooldown, markConfigPolicyRuleCooldown } from '../../services/alertCooldown';
import { writeRouteAudit } from '../../services/auditEvents';
import { publishEvent } from '../../services/eventBus';
import { listAlertsSchema, resolveAlertSchema, suppressAlertSchema } from './schemas';
import { getPagination, ensureOrgAccess, getAlertWithOrgCheck } from './helpers';

export const alertsRoutes = new Hono();

// GET /alerts - List alerts with filters
alertsRoutes.get(
  '/',
  requireScope('organization', 'partner', 'system'),
  zValidator('query', listAlertsSchema),
  async (c) => {
    const auth = c.get('auth');
    const query = c.req.valid('query');
    const { page, limit, offset } = getPagination(query);

    // Build conditions array
    const conditions: ReturnType<typeof eq>[] = [];

    // Filter by org access based on scope
    if (auth.scope === 'organization') {
      if (!auth.orgId) {
        return c.json({ error: 'Organization context required' }, 403);
      }
      conditions.push(eq(alerts.orgId, auth.orgId));
    } else if (auth.scope === 'partner') {
      if (query.orgId) {
        const hasAccess = ensureOrgAccess(query.orgId, auth);
        if (!hasAccess) {
          return c.json({ error: 'Access to this organization denied' }, 403);
        }
        conditions.push(eq(alerts.orgId, query.orgId));
      } else {
        const orgIds = auth.accessibleOrgIds ?? [];
        if (orgIds.length === 0) {
          return c.json({
            data: [],
            pagination: { page, limit, total: 0 }
          });
        }
        conditions.push(inArray(alerts.orgId, orgIds));
      }
    } else if (auth.scope === 'system' && query.orgId) {
      conditions.push(eq(alerts.orgId, query.orgId));
    }

    // Additional filters
    if (query.status) {
      conditions.push(eq(alerts.status, query.status));
    }

    if (query.severity) {
      conditions.push(eq(alerts.severity, query.severity));
    }

    if (query.deviceId) {
      conditions.push(eq(alerts.deviceId, query.deviceId));
    }

    if (query.startDate) {
      conditions.push(gte(alerts.triggeredAt, new Date(query.startDate)));
    }

    if (query.endDate) {
      conditions.push(lte(alerts.triggeredAt, new Date(query.endDate)));
    }

    const whereCondition = conditions.length > 0 ? and(...conditions) : undefined;

    // Get total count
    const countResult = await db
      .select({ count: sql<number>`count(*)` })
      .from(alerts)
      .where(whereCondition);
    const total = Number(countResult[0]?.count ?? 0);

    // Get alerts with device and rule info
    const alertsList = await db
      .select({
        id: alerts.id,
        ruleId: alerts.ruleId,
        deviceId: alerts.deviceId,
        orgId: alerts.orgId,
        status: alerts.status,
        severity: alerts.severity,
        title: alerts.title,
        message: alerts.message,
        context: alerts.context,
        triggeredAt: alerts.triggeredAt,
        acknowledgedAt: alerts.acknowledgedAt,
        acknowledgedBy: alerts.acknowledgedBy,
        resolvedAt: alerts.resolvedAt,
        resolvedBy: alerts.resolvedBy,
        resolutionNote: alerts.resolutionNote,
        suppressedUntil: alerts.suppressedUntil,
        createdAt: alerts.createdAt,
        deviceHostname: devices.hostname,
        ruleName: alertRules.name
      })
      .from(alerts)
      .leftJoin(devices, eq(alerts.deviceId, devices.id))
      .leftJoin(alertRules, eq(alerts.ruleId, alertRules.id))
      .where(whereCondition)
      .orderBy(desc(alerts.triggeredAt))
      .limit(limit)
      .offset(offset);

    return c.json({
      data: alertsList,
      pagination: { page, limit, total }
    });
  }
);

// GET /alerts/summary - Get alert counts by severity and status
alertsRoutes.get(
  '/summary',
  requireScope('organization', 'partner', 'system'),
  async (c) => {
    const auth = c.get('auth');
    const { orgId } = c.req.query();

    // Build org filter based on scope
    let orgFilter: ReturnType<typeof eq> | undefined;

    if (auth.scope === 'organization') {
      if (!auth.orgId) {
        return c.json({ error: 'Organization context required' }, 403);
      }
      orgFilter = eq(alerts.orgId, auth.orgId);
    } else if (auth.scope === 'partner') {
      if (orgId) {
        const hasAccess = ensureOrgAccess(orgId, auth);
        if (!hasAccess) {
          return c.json({ error: 'Access to this organization denied' }, 403);
        }
        orgFilter = eq(alerts.orgId, orgId);
      } else {
        const orgIds = auth.accessibleOrgIds ?? [];
        if (orgIds.length === 0) {
          return c.json({
            bySeverity: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
            byStatus: { active: 0, acknowledged: 0, resolved: 0, suppressed: 0 },
            total: 0
          });
        }
        orgFilter = inArray(alerts.orgId, orgIds) as ReturnType<typeof eq>;
      }
    } else if (auth.scope === 'system' && orgId) {
      orgFilter = eq(alerts.orgId, orgId);
    }

    // Get counts by severity (only active alerts)
    const severityCounts = await db
      .select({
        severity: alerts.severity,
        count: sql<number>`count(*)`
      })
      .from(alerts)
      .where(
        orgFilter
          ? and(orgFilter, eq(alerts.status, 'active'))
          : eq(alerts.status, 'active')
      )
      .groupBy(alerts.severity);

    // Get counts by status
    const statusCounts = await db
      .select({
        status: alerts.status,
        count: sql<number>`count(*)`
      })
      .from(alerts)
      .where(orgFilter)
      .groupBy(alerts.status);

    // Get total count
    const totalResult = await db
      .select({ count: sql<number>`count(*)` })
      .from(alerts)
      .where(orgFilter);

    // Format response
    const bySeverity = {
      critical: 0,
      high: 0,
      medium: 0,
      low: 0,
      info: 0
    };

    for (const row of severityCounts) {
      bySeverity[row.severity as keyof typeof bySeverity] = Number(row.count);
    }

    const byStatus = {
      active: 0,
      acknowledged: 0,
      resolved: 0,
      suppressed: 0
    };

    for (const row of statusCounts) {
      byStatus[row.status as keyof typeof byStatus] = Number(row.count);
    }

    return c.json({
      bySeverity,
      byStatus,
      total: Number(totalResult[0]?.count ?? 0)
    });
  }
);

// POST /alerts/:id/acknowledge - Acknowledge an alert
alertsRoutes.post(
  '/:id/acknowledge',
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
    if (!updated) {
      return c.json({ error: 'Failed to acknowledge alert' }, 500);
    }

    try {
      await publishEvent(
        'alert.acknowledged',
        alert.orgId,
        {
          alertId: updated.id,
          ruleId: alert.ruleId,
          deviceId: alert.deviceId,
          acknowledgedBy: auth.user.id
        },
        'alerts-route',
        { userId: auth.user.id }
      );
    } catch (error) {
      console.error('[AlertsRoute] Failed to publish alert.acknowledged event:', error);
    }

    writeRouteAudit(c, {
      orgId: alert.orgId,
      action: 'alert.acknowledge',
      resourceType: 'alert',
      resourceId: updated.id,
      resourceName: updated.title,
      details: {
        previousStatus: alert.status,
        nextStatus: updated.status,
      },
    });

    return c.json(updated);
  }
);

// POST /alerts/:id/resolve - Resolve an alert with optional note
alertsRoutes.post(
  '/:id/resolve',
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
    if (!updated) {
      return c.json({ error: 'Failed to resolve alert' }, 500);
    }

    // Set cooldown to prevent immediate re-trigger by the evaluation worker
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

        const overrides = rule.overrideSettings as Record<string, unknown> | null;
        const cooldownMinutes = (overrides?.cooldownMinutes as number) ??
          template?.cooldownMinutes ?? 15;
        await setCooldown(alert.ruleId, alert.deviceId, cooldownMinutes);
      }
    } else if (alert.configPolicyId) {
      // Config policy alert — cooldownMinutes stored in alert context
      const ctx = alert.context as Record<string, unknown> | null;
      const cooldownMinutes = typeof ctx?.cooldownMinutes === 'number' ? ctx.cooldownMinutes : 5;
      await markConfigPolicyRuleCooldown(alert.configPolicyId, alert.deviceId, cooldownMinutes);
    }

    try {
      await publishEvent(
        'alert.resolved',
        alert.orgId,
        {
          alertId: updated.id,
          ruleId: alert.ruleId,
          deviceId: alert.deviceId,
          resolvedBy: auth.user.id,
          resolutionNote: data.note
        },
        'alerts-route',
        { userId: auth.user.id }
      );
    } catch (error) {
      console.error('[AlertsRoute] Failed to publish alert.resolved event:', error);
    }

    writeRouteAudit(c, {
      orgId: alert.orgId,
      action: 'alert.resolve',
      resourceType: 'alert',
      resourceId: updated.id,
      resourceName: updated.title,
      details: {
        previousStatus: alert.status,
        nextStatus: updated.status,
        hasResolutionNote: Boolean(data.note),
      },
    });

    return c.json(updated);
  }
);

// POST /alerts/:id/suppress - Suppress alert until specified time
alertsRoutes.post(
  '/:id/suppress',
  requireScope('organization', 'partner', 'system'),
  zValidator('json', suppressAlertSchema),
  async (c) => {
    const auth = c.get('auth');
    const alertId = c.req.param('id');
    const data = c.req.valid('json');

    const alert = await getAlertWithOrgCheck(alertId, auth);
    if (!alert) {
      return c.json({ error: 'Alert not found' }, 404);
    }

    if (alert.status === 'resolved') {
      return c.json({ error: 'Cannot suppress a resolved alert' }, 400);
    }

    const suppressedUntil = new Date(data.until);
    if (suppressedUntil <= new Date()) {
      return c.json({ error: 'Suppression time must be in the future' }, 400);
    }

    const [updated] = await db
      .update(alerts)
      .set({
        status: 'suppressed',
        suppressedUntil
      })
      .where(eq(alerts.id, alertId))
      .returning();
    if (!updated) {
      return c.json({ error: 'Failed to suppress alert' }, 500);
    }

    writeRouteAudit(c, {
      orgId: alert.orgId,
      action: 'alert.suppress',
      resourceType: 'alert',
      resourceId: updated.id,
      resourceName: updated.title,
      details: {
        previousStatus: alert.status,
        nextStatus: updated.status,
        suppressedUntil: suppressedUntil.toISOString(),
      },
    });

    return c.json(updated);
  }
);

// GET /alerts/:id - Get alert details
alertsRoutes.get(
  '/:id',
  requireScope('organization', 'partner', 'system'),
  async (c) => {
    const auth = c.get('auth');
    const alertId = c.req.param('id');

    // Skip if this is a route like /alerts/rules, /alerts/channels, etc.
    if (['rules', 'channels', 'policies', 'summary'].includes(alertId)) {
      return c.notFound();
    }

    const alert = await getAlertWithOrgCheck(alertId, auth);
    if (!alert) {
      return c.json({ error: 'Alert not found' }, 404);
    }

    // Get related information
    const [device] = await db
      .select()
      .from(devices)
      .where(eq(devices.id, alert.deviceId))
      .limit(1);

    const [rule] = alert.ruleId ? await db
      .select()
      .from(alertRules)
      .where(eq(alertRules.id, alert.ruleId))
      .limit(1) : [undefined];

    // Get notification history
    const notifications = await db
      .select({
        id: alertNotifications.id,
        channelId: alertNotifications.channelId,
        status: alertNotifications.status,
        sentAt: alertNotifications.sentAt,
        errorMessage: alertNotifications.errorMessage,
        createdAt: alertNotifications.createdAt,
        channelName: notificationChannels.name,
        channelType: notificationChannels.type
      })
      .from(alertNotifications)
      .leftJoin(notificationChannels, eq(alertNotifications.channelId, notificationChannels.id))
      .where(eq(alertNotifications.alertId, alertId))
      .orderBy(desc(alertNotifications.createdAt));

    return c.json({
      ...alert,
      device: device ? {
        id: device.id,
        hostname: device.hostname,
        osType: device.osType,
        status: device.status
      } : null,
      rule: rule ? {
        id: rule.id,
        name: rule.name,
        templateId: rule.templateId,
        targetType: rule.targetType,
        targetId: rule.targetId,
        isActive: rule.isActive
      } : null,
      notifications
    });
  }
);
