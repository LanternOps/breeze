import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, eq, sql, desc, gte, lte, inArray } from 'drizzle-orm';
import { db } from '../db';
import {
  alertRules,
  alerts,
  notificationChannels,
  escalationPolicies,
  alertNotifications,
  devices,
  organizations
} from '../db/schema';
import { authMiddleware, requireScope } from '../middleware/auth';

export const alertRoutes = new Hono();

// Helper functions
function getPagination(query: { page?: string; limit?: string }) {
  const page = Math.max(1, Number.parseInt(query.page ?? '1', 10) || 1);
  const limit = Math.min(100, Math.max(1, Number.parseInt(query.limit ?? '50', 10) || 50));
  return { page, limit, offset: (page - 1) * limit };
}

async function ensureOrgAccess(orgId: string, auth: { scope: string; partnerId: string | null; orgId: string | null }) {
  if (auth.scope === 'organization') {
    return auth.orgId === orgId;
  }

  if (auth.scope === 'partner') {
    const [org] = await db
      .select({ id: organizations.id })
      .from(organizations)
      .where(
        and(
          eq(organizations.id, orgId),
          eq(organizations.partnerId, auth.partnerId as string)
        )
      )
      .limit(1);

    return Boolean(org);
  }

  // system scope has access to all
  return true;
}

async function getAlertRuleWithOrgCheck(ruleId: string, auth: { scope: string; partnerId: string | null; orgId: string | null }) {
  const [rule] = await db
    .select()
    .from(alertRules)
    .where(eq(alertRules.id, ruleId))
    .limit(1);

  if (!rule) {
    return null;
  }

  const hasAccess = await ensureOrgAccess(rule.orgId, auth);
  if (!hasAccess) {
    return null;
  }

  return rule;
}

async function getAlertWithOrgCheck(alertId: string, auth: { scope: string; partnerId: string | null; orgId: string | null }) {
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

async function getNotificationChannelWithOrgCheck(channelId: string, auth: { scope: string; partnerId: string | null; orgId: string | null }) {
  const [channel] = await db
    .select()
    .from(notificationChannels)
    .where(eq(notificationChannels.id, channelId))
    .limit(1);

  if (!channel) {
    return null;
  }

  const hasAccess = await ensureOrgAccess(channel.orgId, auth);
  if (!hasAccess) {
    return null;
  }

  return channel;
}

async function getEscalationPolicyWithOrgCheck(policyId: string, auth: { scope: string; partnerId: string | null; orgId: string | null }) {
  const [policy] = await db
    .select()
    .from(escalationPolicies)
    .where(eq(escalationPolicies.id, policyId))
    .limit(1);

  if (!policy) {
    return null;
  }

  const hasAccess = await ensureOrgAccess(policy.orgId, auth);
  if (!hasAccess) {
    return null;
  }

  return policy;
}

// Validation schemas

// Alert Rules schemas
const listAlertRulesSchema = z.object({
  page: z.string().optional(),
  limit: z.string().optional(),
  orgId: z.string().uuid().optional(),
  enabled: z.enum(['true', 'false']).optional(),
  severity: z.enum(['critical', 'high', 'medium', 'low', 'info']).optional()
});

const createAlertRuleSchema = z.object({
  orgId: z.string().uuid().optional(),
  name: z.string().min(1).max(255),
  description: z.string().optional(),
  enabled: z.boolean().default(true),
  severity: z.enum(['critical', 'high', 'medium', 'low', 'info']),
  targets: z.any(), // JSONB for flexible targeting
  conditions: z.any(), // JSONB for flexible conditions
  cooldownMinutes: z.number().int().min(0).max(10080).default(15), // Max 1 week
  escalationPolicyId: z.string().uuid().optional(),
  notificationChannels: z.array(z.string().uuid()).optional(),
  autoResolve: z.boolean().default(true)
});

const updateAlertRuleSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  description: z.string().optional(),
  enabled: z.boolean().optional(),
  severity: z.enum(['critical', 'high', 'medium', 'low', 'info']).optional(),
  targets: z.any().optional(),
  conditions: z.any().optional(),
  cooldownMinutes: z.number().int().min(0).max(10080).optional(),
  escalationPolicyId: z.string().uuid().nullable().optional(),
  notificationChannels: z.array(z.string().uuid()).optional(),
  autoResolve: z.boolean().optional()
});

const testAlertRuleSchema = z.object({
  deviceId: z.string().uuid()
});

// Alerts schemas
const listAlertsSchema = z.object({
  page: z.string().optional(),
  limit: z.string().optional(),
  orgId: z.string().uuid().optional(),
  status: z.enum(['active', 'acknowledged', 'resolved', 'suppressed']).optional(),
  severity: z.enum(['critical', 'high', 'medium', 'low', 'info']).optional(),
  deviceId: z.string().uuid().optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional()
});

const resolveAlertSchema = z.object({
  note: z.string().optional()
});

const suppressAlertSchema = z.object({
  until: z.string() // ISO date string
});

// Notification Channels schemas
const listChannelsSchema = z.object({
  page: z.string().optional(),
  limit: z.string().optional(),
  orgId: z.string().uuid().optional(),
  type: z.enum(['email', 'slack', 'teams', 'webhook', 'pagerduty', 'sms']).optional(),
  enabled: z.enum(['true', 'false']).optional()
});

const createChannelSchema = z.object({
  orgId: z.string().uuid().optional(),
  name: z.string().min(1).max(255),
  type: z.enum(['email', 'slack', 'teams', 'webhook', 'pagerduty', 'sms']),
  config: z.any(), // JSONB for type-specific config
  enabled: z.boolean().default(true)
});

const updateChannelSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  config: z.any().optional(),
  enabled: z.boolean().optional()
});

// Escalation Policies schemas
const listPoliciesSchema = z.object({
  page: z.string().optional(),
  limit: z.string().optional(),
  orgId: z.string().uuid().optional()
});

const createPolicySchema = z.object({
  orgId: z.string().uuid().optional(),
  name: z.string().min(1).max(255),
  steps: z.any() // JSONB for escalation steps
});

const updatePolicySchema = z.object({
  name: z.string().min(1).max(255).optional(),
  steps: z.any().optional()
});

// Apply auth middleware to all routes
alertRoutes.use('*', authMiddleware);

// ============================================
// ALERT RULES ENDPOINTS
// ============================================

// GET /alerts/rules - List alert rules with pagination
alertRoutes.get(
  '/rules',
  requireScope('organization', 'partner', 'system'),
  zValidator('query', listAlertRulesSchema),
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
      conditions.push(eq(alertRules.orgId, auth.orgId));
    } else if (auth.scope === 'partner') {
      if (query.orgId) {
        const hasAccess = await ensureOrgAccess(query.orgId, auth);
        if (!hasAccess) {
          return c.json({ error: 'Access to this organization denied' }, 403);
        }
        conditions.push(eq(alertRules.orgId, query.orgId));
      } else {
        // Get rules from all orgs under this partner
        const partnerOrgs = await db
          .select({ id: organizations.id })
          .from(organizations)
          .where(eq(organizations.partnerId, auth.partnerId as string));

        const orgIds = partnerOrgs.map(o => o.id);
        if (orgIds.length === 0) {
          return c.json({
            data: [],
            pagination: { page, limit, total: 0 }
          });
        }
        conditions.push(inArray(alertRules.orgId, orgIds));
      }
    } else if (auth.scope === 'system' && query.orgId) {
      conditions.push(eq(alertRules.orgId, query.orgId));
    }

    // Additional filters
    if (query.enabled !== undefined) {
      conditions.push(eq(alertRules.enabled, query.enabled === 'true'));
    }

    if (query.severity) {
      conditions.push(eq(alertRules.severity, query.severity));
    }

    const whereCondition = conditions.length > 0 ? and(...conditions) : undefined;

    // Get total count
    const countResult = await db
      .select({ count: sql<number>`count(*)` })
      .from(alertRules)
      .where(whereCondition);
    const total = Number(countResult[0]?.count ?? 0);

    // Get rules
    const rulesList = await db
      .select()
      .from(alertRules)
      .where(whereCondition)
      .orderBy(desc(alertRules.updatedAt))
      .limit(limit)
      .offset(offset);

    return c.json({
      data: rulesList,
      pagination: { page, limit, total }
    });
  }
);

// GET /alerts/rules/:id - Get single alert rule
alertRoutes.get(
  '/rules/:id',
  requireScope('organization', 'partner', 'system'),
  async (c) => {
    const auth = c.get('auth');
    const ruleId = c.req.param('id');

    const rule = await getAlertRuleWithOrgCheck(ruleId, auth);
    if (!rule) {
      return c.json({ error: 'Alert rule not found' }, 404);
    }

    return c.json(rule);
  }
);

// POST /alerts/rules - Create alert rule
alertRoutes.post(
  '/rules',
  requireScope('organization', 'partner', 'system'),
  zValidator('json', createAlertRuleSchema),
  async (c) => {
    const auth = c.get('auth');
    const data = c.req.valid('json');

    // Determine orgId
    let orgId = data.orgId;

    if (auth.scope === 'organization') {
      if (!auth.orgId) {
        return c.json({ error: 'Organization context required' }, 403);
      }
      orgId = auth.orgId;
    } else if (auth.scope === 'partner') {
      if (!orgId) {
        return c.json({ error: 'orgId is required for partner scope' }, 400);
      }
      const hasAccess = await ensureOrgAccess(orgId, auth);
      if (!hasAccess) {
        return c.json({ error: 'Access to this organization denied' }, 403);
      }
    } else if (auth.scope === 'system' && !orgId) {
      return c.json({ error: 'orgId is required' }, 400);
    }

    // Verify escalation policy belongs to org if provided
    if (data.escalationPolicyId) {
      const [policy] = await db
        .select()
        .from(escalationPolicies)
        .where(
          and(
            eq(escalationPolicies.id, data.escalationPolicyId),
            eq(escalationPolicies.orgId, orgId!)
          )
        )
        .limit(1);

      if (!policy) {
        return c.json({ error: 'Escalation policy not found or belongs to different organization' }, 400);
      }
    }

    // Verify notification channels belong to org if provided
    if (data.notificationChannels && data.notificationChannels.length > 0) {
      const validChannels = await db
        .select({ id: notificationChannels.id })
        .from(notificationChannels)
        .where(
          and(
            inArray(notificationChannels.id, data.notificationChannels),
            eq(notificationChannels.orgId, orgId!)
          )
        );

      if (validChannels.length !== data.notificationChannels.length) {
        return c.json({ error: 'One or more notification channels not found or belong to different organization' }, 400);
      }
    }

    const [rule] = await db
      .insert(alertRules)
      .values({
        orgId: orgId!,
        name: data.name,
        description: data.description,
        enabled: data.enabled,
        severity: data.severity,
        targets: data.targets,
        conditions: data.conditions,
        cooldownMinutes: data.cooldownMinutes,
        escalationPolicyId: data.escalationPolicyId,
        notificationChannels: data.notificationChannels || [],
        autoResolve: data.autoResolve,
        createdBy: auth.user.id
      })
      .returning();

    return c.json(rule, 201);
  }
);

// PUT /alerts/rules/:id - Update alert rule
alertRoutes.put(
  '/rules/:id',
  requireScope('organization', 'partner', 'system'),
  zValidator('json', updateAlertRuleSchema),
  async (c) => {
    const auth = c.get('auth');
    const ruleId = c.req.param('id');
    const data = c.req.valid('json');

    if (Object.keys(data).length === 0) {
      return c.json({ error: 'No updates provided' }, 400);
    }

    const rule = await getAlertRuleWithOrgCheck(ruleId, auth);
    if (!rule) {
      return c.json({ error: 'Alert rule not found' }, 404);
    }

    // Verify escalation policy if being updated
    if (data.escalationPolicyId !== undefined && data.escalationPolicyId !== null) {
      const [policy] = await db
        .select()
        .from(escalationPolicies)
        .where(
          and(
            eq(escalationPolicies.id, data.escalationPolicyId),
            eq(escalationPolicies.orgId, rule.orgId)
          )
        )
        .limit(1);

      if (!policy) {
        return c.json({ error: 'Escalation policy not found or belongs to different organization' }, 400);
      }
    }

    // Verify notification channels if being updated
    if (data.notificationChannels && data.notificationChannels.length > 0) {
      const validChannels = await db
        .select({ id: notificationChannels.id })
        .from(notificationChannels)
        .where(
          and(
            inArray(notificationChannels.id, data.notificationChannels),
            eq(notificationChannels.orgId, rule.orgId)
          )
        );

      if (validChannels.length !== data.notificationChannels.length) {
        return c.json({ error: 'One or more notification channels not found or belong to different organization' }, 400);
      }
    }

    // Build updates object
    const updates: Record<string, unknown> = { updatedAt: new Date() };

    if (data.name !== undefined) updates.name = data.name;
    if (data.description !== undefined) updates.description = data.description;
    if (data.enabled !== undefined) updates.enabled = data.enabled;
    if (data.severity !== undefined) updates.severity = data.severity;
    if (data.targets !== undefined) updates.targets = data.targets;
    if (data.conditions !== undefined) updates.conditions = data.conditions;
    if (data.cooldownMinutes !== undefined) updates.cooldownMinutes = data.cooldownMinutes;
    if (data.escalationPolicyId !== undefined) updates.escalationPolicyId = data.escalationPolicyId;
    if (data.notificationChannels !== undefined) updates.notificationChannels = data.notificationChannels;
    if (data.autoResolve !== undefined) updates.autoResolve = data.autoResolve;

    const [updated] = await db
      .update(alertRules)
      .set(updates)
      .where(eq(alertRules.id, ruleId))
      .returning();

    return c.json(updated);
  }
);

// DELETE /alerts/rules/:id - Delete alert rule
alertRoutes.delete(
  '/rules/:id',
  requireScope('organization', 'partner', 'system'),
  async (c) => {
    const auth = c.get('auth');
    const ruleId = c.req.param('id');

    const rule = await getAlertRuleWithOrgCheck(ruleId, auth);
    if (!rule) {
      return c.json({ error: 'Alert rule not found' }, 404);
    }

    // Check for active alerts using this rule
    const activeAlerts = await db
      .select({ count: sql<number>`count(*)` })
      .from(alerts)
      .where(
        and(
          eq(alerts.ruleId, ruleId),
          eq(alerts.status, 'active')
        )
      );

    const activeCount = Number(activeAlerts[0]?.count ?? 0);
    if (activeCount > 0) {
      return c.json({
        error: 'Cannot delete rule with active alerts',
        activeAlerts: activeCount
      }, 409);
    }

    await db
      .delete(alertRules)
      .where(eq(alertRules.id, ruleId));

    return c.json({ success: true });
  }
);

// POST /alerts/rules/:id/test - Test alert rule against a device
alertRoutes.post(
  '/rules/:id/test',
  requireScope('organization', 'partner', 'system'),
  zValidator('json', testAlertRuleSchema),
  async (c) => {
    const auth = c.get('auth');
    const ruleId = c.req.param('id');
    const data = c.req.valid('json');

    const rule = await getAlertRuleWithOrgCheck(ruleId, auth);
    if (!rule) {
      return c.json({ error: 'Alert rule not found' }, 404);
    }

    // Verify device exists and belongs to same org
    const [device] = await db
      .select()
      .from(devices)
      .where(
        and(
          eq(devices.id, data.deviceId),
          eq(devices.orgId, rule.orgId)
        )
      )
      .limit(1);

    if (!device) {
      return c.json({ error: 'Device not found or belongs to different organization' }, 404);
    }

    // Evaluate conditions against device
    // This is a simplified simulation - real implementation would evaluate all conditions
    const conditions = rule.conditions as Record<string, unknown>;
    const targets = rule.targets as Record<string, unknown>;

    // Check if device matches targets
    let targetMatch = true;
    if (targets) {
      // Example target matching - can be extended based on schema
      if (targets.osType && targets.osType !== device.osType) {
        targetMatch = false;
      }
      if (targets.tags && Array.isArray(targets.tags)) {
        const deviceTags = device.tags || [];
        const hasMatchingTag = (targets.tags as string[]).some(t => deviceTags.includes(t));
        if (!hasMatchingTag && targets.tags.length > 0) {
          targetMatch = false;
        }
      }
    }

    // Simulate condition evaluation
    const conditionResults: Array<{ condition: string; result: boolean; reason: string }> = [];

    // Example condition evaluation - would be more complex in production
    if (conditions && typeof conditions === 'object') {
      for (const [key, value] of Object.entries(conditions)) {
        // Simulate evaluation based on condition type
        conditionResults.push({
          condition: key,
          result: false, // Would evaluate actual condition
          reason: `Test evaluation of ${key} condition`
        });
      }
    }

    return c.json({
      rule: {
        id: rule.id,
        name: rule.name,
        severity: rule.severity
      },
      device: {
        id: device.id,
        hostname: device.hostname,
        osType: device.osType
      },
      targetMatch,
      conditionResults,
      wouldTrigger: targetMatch && conditionResults.every(r => r.result),
      testedAt: new Date().toISOString()
    });
  }
);

// ============================================
// ALERTS ENDPOINTS
// ============================================

// GET /alerts - List alerts with filters
alertRoutes.get(
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
        const hasAccess = await ensureOrgAccess(query.orgId, auth);
        if (!hasAccess) {
          return c.json({ error: 'Access to this organization denied' }, 403);
        }
        conditions.push(eq(alerts.orgId, query.orgId));
      } else {
        // Get alerts from all orgs under this partner
        const partnerOrgs = await db
          .select({ id: organizations.id })
          .from(organizations)
          .where(eq(organizations.partnerId, auth.partnerId as string));

        const orgIds = partnerOrgs.map(o => o.id);
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
alertRoutes.get(
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
        const hasAccess = await ensureOrgAccess(orgId, auth);
        if (!hasAccess) {
          return c.json({ error: 'Access to this organization denied' }, 403);
        }
        orgFilter = eq(alerts.orgId, orgId);
      } else {
        // Get all orgs under this partner
        const partnerOrgs = await db
          .select({ id: organizations.id })
          .from(organizations)
          .where(eq(organizations.partnerId, auth.partnerId as string));

        const orgIds = partnerOrgs.map(o => o.id);
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

// GET /alerts/:id - Get alert details
alertRoutes.get(
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

    const [rule] = await db
      .select()
      .from(alertRules)
      .where(eq(alertRules.id, alert.ruleId))
      .limit(1);

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
        severity: rule.severity
      } : null,
      notifications
    });
  }
);

// POST /alerts/:id/acknowledge - Acknowledge an alert
alertRoutes.post(
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

    return c.json(updated);
  }
);

// POST /alerts/:id/resolve - Resolve an alert with optional note
alertRoutes.post(
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

    return c.json(updated);
  }
);

// POST /alerts/:id/suppress - Suppress alert until specified time
alertRoutes.post(
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

    return c.json(updated);
  }
);

// ============================================
// NOTIFICATION CHANNELS ENDPOINTS
// ============================================

// GET /alerts/channels - List notification channels
alertRoutes.get(
  '/channels',
  requireScope('organization', 'partner', 'system'),
  zValidator('query', listChannelsSchema),
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
      conditions.push(eq(notificationChannels.orgId, auth.orgId));
    } else if (auth.scope === 'partner') {
      if (query.orgId) {
        const hasAccess = await ensureOrgAccess(query.orgId, auth);
        if (!hasAccess) {
          return c.json({ error: 'Access to this organization denied' }, 403);
        }
        conditions.push(eq(notificationChannels.orgId, query.orgId));
      } else {
        // Get channels from all orgs under this partner
        const partnerOrgs = await db
          .select({ id: organizations.id })
          .from(organizations)
          .where(eq(organizations.partnerId, auth.partnerId as string));

        const orgIds = partnerOrgs.map(o => o.id);
        if (orgIds.length === 0) {
          return c.json({
            data: [],
            pagination: { page, limit, total: 0 }
          });
        }
        conditions.push(inArray(notificationChannels.orgId, orgIds));
      }
    } else if (auth.scope === 'system' && query.orgId) {
      conditions.push(eq(notificationChannels.orgId, query.orgId));
    }

    // Additional filters
    if (query.type) {
      conditions.push(eq(notificationChannels.type, query.type));
    }

    if (query.enabled !== undefined) {
      conditions.push(eq(notificationChannels.enabled, query.enabled === 'true'));
    }

    const whereCondition = conditions.length > 0 ? and(...conditions) : undefined;

    // Get total count
    const countResult = await db
      .select({ count: sql<number>`count(*)` })
      .from(notificationChannels)
      .where(whereCondition);
    const total = Number(countResult[0]?.count ?? 0);

    // Get channels
    const channelsList = await db
      .select()
      .from(notificationChannels)
      .where(whereCondition)
      .orderBy(desc(notificationChannels.updatedAt))
      .limit(limit)
      .offset(offset);

    return c.json({
      data: channelsList,
      pagination: { page, limit, total }
    });
  }
);

// POST /alerts/channels - Create notification channel
alertRoutes.post(
  '/channels',
  requireScope('organization', 'partner', 'system'),
  zValidator('json', createChannelSchema),
  async (c) => {
    const auth = c.get('auth');
    const data = c.req.valid('json');

    // Determine orgId
    let orgId = data.orgId;

    if (auth.scope === 'organization') {
      if (!auth.orgId) {
        return c.json({ error: 'Organization context required' }, 403);
      }
      orgId = auth.orgId;
    } else if (auth.scope === 'partner') {
      if (!orgId) {
        return c.json({ error: 'orgId is required for partner scope' }, 400);
      }
      const hasAccess = await ensureOrgAccess(orgId, auth);
      if (!hasAccess) {
        return c.json({ error: 'Access to this organization denied' }, 403);
      }
    } else if (auth.scope === 'system' && !orgId) {
      return c.json({ error: 'orgId is required' }, 400);
    }

    const [channel] = await db
      .insert(notificationChannels)
      .values({
        orgId: orgId!,
        name: data.name,
        type: data.type,
        config: data.config,
        enabled: data.enabled
      })
      .returning();

    return c.json(channel, 201);
  }
);

// PUT /alerts/channels/:id - Update notification channel
alertRoutes.put(
  '/channels/:id',
  requireScope('organization', 'partner', 'system'),
  zValidator('json', updateChannelSchema),
  async (c) => {
    const auth = c.get('auth');
    const channelId = c.req.param('id');
    const data = c.req.valid('json');

    if (Object.keys(data).length === 0) {
      return c.json({ error: 'No updates provided' }, 400);
    }

    const channel = await getNotificationChannelWithOrgCheck(channelId, auth);
    if (!channel) {
      return c.json({ error: 'Notification channel not found' }, 404);
    }

    // Build updates object
    const updates: Record<string, unknown> = { updatedAt: new Date() };

    if (data.name !== undefined) updates.name = data.name;
    if (data.config !== undefined) updates.config = data.config;
    if (data.enabled !== undefined) updates.enabled = data.enabled;

    const [updated] = await db
      .update(notificationChannels)
      .set(updates)
      .where(eq(notificationChannels.id, channelId))
      .returning();

    return c.json(updated);
  }
);

// DELETE /alerts/channels/:id - Delete notification channel
alertRoutes.delete(
  '/channels/:id',
  requireScope('organization', 'partner', 'system'),
  async (c) => {
    const auth = c.get('auth');
    const channelId = c.req.param('id');

    const channel = await getNotificationChannelWithOrgCheck(channelId, auth);
    if (!channel) {
      return c.json({ error: 'Notification channel not found' }, 404);
    }

    // Check if channel is used by any rules
    const rulesUsingChannel = await db
      .select({ count: sql<number>`count(*)` })
      .from(alertRules)
      .where(sql`${channelId} = ANY(${alertRules.notificationChannels})`);

    const usageCount = Number(rulesUsingChannel[0]?.count ?? 0);
    if (usageCount > 0) {
      return c.json({
        error: 'Cannot delete channel that is used by alert rules',
        rulesUsingChannel: usageCount
      }, 409);
    }

    await db
      .delete(notificationChannels)
      .where(eq(notificationChannels.id, channelId));

    return c.json({ success: true });
  }
);

// POST /alerts/channels/:id/test - Test notification channel
alertRoutes.post(
  '/channels/:id/test',
  requireScope('organization', 'partner', 'system'),
  async (c) => {
    const auth = c.get('auth');
    const channelId = c.req.param('id');

    const channel = await getNotificationChannelWithOrgCheck(channelId, auth);
    if (!channel) {
      return c.json({ error: 'Notification channel not found' }, 404);
    }

    // Simulate sending a test notification based on channel type
    // In production, this would actually send the notification
    const testMessage = {
      title: 'Test Alert from Breeze RMM',
      message: `This is a test notification sent to channel "${channel.name}" at ${new Date().toISOString()}`,
      severity: 'info',
      source: 'manual_test'
    };

    let testResult: { success: boolean; message: string; details?: unknown };

    try {
      switch (channel.type) {
        case 'email':
          // Would send email via SMTP/email service
          testResult = {
            success: true,
            message: 'Test email would be sent',
            details: { recipients: (channel.config as { recipients?: string[] })?.recipients }
          };
          break;

        case 'slack':
          // Would post to Slack webhook
          testResult = {
            success: true,
            message: 'Test message would be posted to Slack',
            details: { channel: (channel.config as { channel?: string })?.channel }
          };
          break;

        case 'teams':
          // Would post to Teams webhook
          testResult = {
            success: true,
            message: 'Test message would be posted to Microsoft Teams',
            details: { webhook: 'configured' }
          };
          break;

        case 'webhook':
          // Would POST to custom webhook
          testResult = {
            success: true,
            message: 'Test payload would be sent to webhook',
            details: { url: (channel.config as { url?: string })?.url }
          };
          break;

        case 'pagerduty':
          // Would create PagerDuty event
          testResult = {
            success: true,
            message: 'Test event would be sent to PagerDuty',
            details: { serviceKey: 'configured' }
          };
          break;

        case 'sms':
          // Would send SMS
          testResult = {
            success: true,
            message: 'Test SMS would be sent',
            details: { phoneNumbers: (channel.config as { phoneNumbers?: string[] })?.phoneNumbers }
          };
          break;

        default:
          testResult = {
            success: false,
            message: `Unknown channel type: ${channel.type}`
          };
      }
    } catch (error) {
      testResult = {
        success: false,
        message: `Failed to test channel: ${error instanceof Error ? error.message : 'Unknown error'}`
      };
    }

    return c.json({
      channelId: channel.id,
      channelName: channel.name,
      channelType: channel.type,
      testMessage,
      testResult,
      testedAt: new Date().toISOString(),
      testedBy: auth.user.id
    });
  }
);

// ============================================
// ESCALATION POLICIES ENDPOINTS
// ============================================

// GET /alerts/policies - List escalation policies
alertRoutes.get(
  '/policies',
  requireScope('organization', 'partner', 'system'),
  zValidator('query', listPoliciesSchema),
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
      conditions.push(eq(escalationPolicies.orgId, auth.orgId));
    } else if (auth.scope === 'partner') {
      if (query.orgId) {
        const hasAccess = await ensureOrgAccess(query.orgId, auth);
        if (!hasAccess) {
          return c.json({ error: 'Access to this organization denied' }, 403);
        }
        conditions.push(eq(escalationPolicies.orgId, query.orgId));
      } else {
        // Get policies from all orgs under this partner
        const partnerOrgs = await db
          .select({ id: organizations.id })
          .from(organizations)
          .where(eq(organizations.partnerId, auth.partnerId as string));

        const orgIds = partnerOrgs.map(o => o.id);
        if (orgIds.length === 0) {
          return c.json({
            data: [],
            pagination: { page, limit, total: 0 }
          });
        }
        conditions.push(inArray(escalationPolicies.orgId, orgIds));
      }
    } else if (auth.scope === 'system' && query.orgId) {
      conditions.push(eq(escalationPolicies.orgId, query.orgId));
    }

    const whereCondition = conditions.length > 0 ? and(...conditions) : undefined;

    // Get total count
    const countResult = await db
      .select({ count: sql<number>`count(*)` })
      .from(escalationPolicies)
      .where(whereCondition);
    const total = Number(countResult[0]?.count ?? 0);

    // Get policies
    const policiesList = await db
      .select()
      .from(escalationPolicies)
      .where(whereCondition)
      .orderBy(desc(escalationPolicies.updatedAt))
      .limit(limit)
      .offset(offset);

    return c.json({
      data: policiesList,
      pagination: { page, limit, total }
    });
  }
);

// POST /alerts/policies - Create escalation policy
alertRoutes.post(
  '/policies',
  requireScope('organization', 'partner', 'system'),
  zValidator('json', createPolicySchema),
  async (c) => {
    const auth = c.get('auth');
    const data = c.req.valid('json');

    // Determine orgId
    let orgId = data.orgId;

    if (auth.scope === 'organization') {
      if (!auth.orgId) {
        return c.json({ error: 'Organization context required' }, 403);
      }
      orgId = auth.orgId;
    } else if (auth.scope === 'partner') {
      if (!orgId) {
        return c.json({ error: 'orgId is required for partner scope' }, 400);
      }
      const hasAccess = await ensureOrgAccess(orgId, auth);
      if (!hasAccess) {
        return c.json({ error: 'Access to this organization denied' }, 403);
      }
    } else if (auth.scope === 'system' && !orgId) {
      return c.json({ error: 'orgId is required' }, 400);
    }

    const [policy] = await db
      .insert(escalationPolicies)
      .values({
        orgId: orgId!,
        name: data.name,
        steps: data.steps
      })
      .returning();

    return c.json(policy, 201);
  }
);

// PUT /alerts/policies/:id - Update escalation policy
alertRoutes.put(
  '/policies/:id',
  requireScope('organization', 'partner', 'system'),
  zValidator('json', updatePolicySchema),
  async (c) => {
    const auth = c.get('auth');
    const policyId = c.req.param('id');
    const data = c.req.valid('json');

    if (Object.keys(data).length === 0) {
      return c.json({ error: 'No updates provided' }, 400);
    }

    const policy = await getEscalationPolicyWithOrgCheck(policyId, auth);
    if (!policy) {
      return c.json({ error: 'Escalation policy not found' }, 404);
    }

    // Build updates object
    const updates: Record<string, unknown> = { updatedAt: new Date() };

    if (data.name !== undefined) updates.name = data.name;
    if (data.steps !== undefined) updates.steps = data.steps;

    const [updated] = await db
      .update(escalationPolicies)
      .set(updates)
      .where(eq(escalationPolicies.id, policyId))
      .returning();

    return c.json(updated);
  }
);

// DELETE /alerts/policies/:id - Delete escalation policy
alertRoutes.delete(
  '/policies/:id',
  requireScope('organization', 'partner', 'system'),
  async (c) => {
    const auth = c.get('auth');
    const policyId = c.req.param('id');

    const policy = await getEscalationPolicyWithOrgCheck(policyId, auth);
    if (!policy) {
      return c.json({ error: 'Escalation policy not found' }, 404);
    }

    // Check if policy is used by any rules
    const rulesUsingPolicy = await db
      .select({ count: sql<number>`count(*)` })
      .from(alertRules)
      .where(eq(alertRules.escalationPolicyId, policyId));

    const usageCount = Number(rulesUsingPolicy[0]?.count ?? 0);
    if (usageCount > 0) {
      return c.json({
        error: 'Cannot delete policy that is used by alert rules',
        rulesUsingPolicy: usageCount
      }, 409);
    }

    await db
      .delete(escalationPolicies)
      .where(eq(escalationPolicies.id, policyId));

    return c.json({ success: true });
  }
);
