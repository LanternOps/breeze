import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, eq, sql, desc, gte, lte, inArray } from 'drizzle-orm';
import { db } from '../db';
import {
  alertRules,
  alertTemplates,
  alerts,
  notificationChannels,
  escalationPolicies,
  alertNotifications,
  devices,
  organizations
} from '../db/schema';
import { authMiddleware, requireScope } from '../middleware/auth';
import { setCooldown } from '../services/alertCooldown';
import { writeRouteAudit } from '../services/auditEvents';

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

type AlertRuleRow = typeof alertRules.$inferSelect;
type AlertTemplateRow = typeof alertTemplates.$inferSelect;

type AlertRuleOverrides = {
  description?: string;
  severity?: string;
  conditions?: unknown;
  cooldownMinutes?: number;
  cooldown?: number;
  autoResolve?: boolean;
  notificationChannelIds?: string[];
  notificationChannels?: string[];
  escalationPolicyId?: string;
  targets?: {
    type?: string;
    ids?: string[];
  };
  targetIds?: string[];
  templateOwned?: boolean;
  updatedAt?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function getOverrides(value: unknown): AlertRuleOverrides {
  return isRecord(value) ? value as AlertRuleOverrides : {};
}

function normalizeTargetsForRule(
  data: {
    targets?: { type?: string; ids?: string[] };
    targetType?: string;
    targetId?: string;
  },
  orgId: string
) {
  const inputTargets = data.targets ?? (data.targetType ? { type: data.targetType, ids: data.targetId ? [data.targetId] : [] } : { type: 'all', ids: [] });
  const targetType = inputTargets.type ?? 'all';
  const targetIds = Array.isArray(inputTargets.ids) ? inputTargets.ids.filter(Boolean) : [];
  let targetId: string | undefined;

  if (targetType === 'all' || targetType === 'org') {
    targetId = orgId;
  } else {
    targetId = targetIds[0] ?? data.targetId;
  }

  return {
    targetType,
    targetId,
    targetIds,
    targets: {
      type: targetType,
      ids: targetIds.length > 0 ? targetIds : (targetType === 'all' || targetType === 'org') ? [] : targetIds
    }
  };
}

function getNotificationChannelIds(overrides: AlertRuleOverrides) {
  if (Array.isArray(overrides.notificationChannelIds)) return overrides.notificationChannelIds;
  if (Array.isArray(overrides.notificationChannels)) return overrides.notificationChannels;
  return [];
}

function formatAlertRuleResponse(rule: AlertRuleRow, template?: AlertTemplateRow | null) {
  const overrides = getOverrides(rule.overrideSettings);
  const overrideTargets = overrides.targets;
  const targetType = overrideTargets?.type ?? rule.targetType ?? 'all';
  const targetIds = Array.isArray(overrideTargets?.ids)
    ? overrideTargets?.ids
    : Array.isArray(overrides.targetIds)
      ? overrides.targetIds
      : (targetType === 'all' || targetType === 'org') ? [] : [rule.targetId];

  const notificationChannelIds = getNotificationChannelIds(overrides);
  const severity = overrides.severity ?? template?.severity ?? 'medium';
  const cooldownMinutes = overrides.cooldownMinutes ?? overrides.cooldown ?? template?.cooldownMinutes ?? 15;
  const autoResolve = overrides.autoResolve ?? template?.autoResolve ?? false;

  return {
    id: rule.id,
    orgId: rule.orgId,
    name: rule.name,
    description: overrides.description ?? template?.description ?? null,
    enabled: rule.isActive,
    isActive: rule.isActive,
    severity,
    targets: {
      type: targetType,
      ids: targetIds
    },
    targetType: rule.targetType,
    targetId: rule.targetId,
    conditions: overrides.conditions ?? template?.conditions ?? [],
    cooldownMinutes,
    autoResolve,
    escalationPolicyId: overrides.escalationPolicyId ?? null,
    notificationChannelIds,
    notificationChannels: notificationChannelIds,
    templateId: rule.templateId,
    templateName: template?.name,
    createdAt: rule.createdAt,
    updatedAt: overrides.updatedAt ?? rule.createdAt
  };
}

async function resolveAlertTemplate(params: {
  templateId?: string;
  orgId: string;
  name?: string;
  description?: string;
  severity?: string;
  conditions?: unknown;
  cooldownMinutes?: number;
  autoResolve?: boolean;
}) {
  const templateName = params.name?.trim() || 'Custom Alert Template';
  const templateSeverity = (params.severity ?? 'medium') as AlertTemplateRow['severity'];
  const templateConditions = params.conditions ?? {};
  const templateCooldownMinutes = params.cooldownMinutes ?? 15;
  const templateAutoResolve = params.autoResolve ?? false;

  if (params.templateId) {
    const [existing] = await db
      .select()
      .from(alertTemplates)
      .where(eq(alertTemplates.id, params.templateId))
      .limit(1);

    if (existing) {
      return { template: existing, created: false };
    }

    const [createdTemplate] = await db
      .insert(alertTemplates)
      .values({
        id: params.templateId,
        orgId: params.orgId,
        name: templateName,
        description: params.description,
        conditions: templateConditions,
        severity: templateSeverity,
        titleTemplate: `${templateName} alert`,
        messageTemplate: `Alert triggered for ${templateName}.`,
        autoResolve: templateAutoResolve,
        cooldownMinutes: templateCooldownMinutes,
        isBuiltIn: false
      })
      .returning();

    return { template: createdTemplate, created: true };
  }

  const [createdTemplate] = await db
    .insert(alertTemplates)
    .values({
      orgId: params.orgId,
      name: templateName,
      description: params.description,
      conditions: templateConditions,
      severity: templateSeverity,
      titleTemplate: `${templateName} alert`,
      messageTemplate: `Alert triggered for ${templateName}.`,
      autoResolve: templateAutoResolve,
      cooldownMinutes: templateCooldownMinutes,
      isBuiltIn: false
    })
    .returning();

  return { template: createdTemplate, created: true };
}

// Validation schemas

// Alert Rules schemas
const listAlertRulesSchema = z.object({
  page: z.string().optional(),
  limit: z.string().optional(),
  orgId: z.string().uuid().optional(),
  isActive: z.enum(['true', 'false']).optional(),
  enabled: z.enum(['true', 'false']).optional()
});

const createAlertRuleSchema = z.object({
  orgId: z.string().uuid().optional(),
  templateId: z.string().uuid().optional(),
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).optional(),
  severity: z.enum(['critical', 'high', 'medium', 'low', 'info']).optional(),
  targetType: z.string().min(1).max(50).optional(),
  targetId: z.string().uuid().optional(),
  targets: z.object({
    type: z.enum(['all', 'org', 'site', 'group', 'device']),
    ids: z.array(z.string().uuid()).optional()
  }).optional(),
  conditions: z.any().optional(),
  notificationChannelIds: z.array(z.string().uuid()).optional(),
  notificationChannels: z.array(z.string().uuid()).optional(),
  cooldownMinutes: z.coerce.number().int().min(1).max(1440).optional(),
  autoResolve: z.boolean().optional(),
  enabled: z.boolean().optional(),
  active: z.boolean().optional(),
  isActive: z.boolean().optional(),
  overrideSettings: z.any().optional(),
  overrides: z.any().optional(),
  escalationPolicyId: z.string().uuid().optional()
}).superRefine((data, ctx) => {
  if (!data.templateId) {
    if (!data.name) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['name'],
        message: 'Rule name is required'
      });
    }
    if (!data.severity) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['severity'],
        message: 'Severity is required'
      });
    }
    if (data.conditions === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['conditions'],
        message: 'Conditions are required'
      });
    }
  }
});

const updateAlertRuleSchema = z.object({
  templateId: z.string().uuid().optional(),
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).optional(),
  severity: z.enum(['critical', 'high', 'medium', 'low', 'info']).optional(),
  targetType: z.string().min(1).max(50).optional(),
  targetId: z.string().uuid().optional(),
  targets: z.object({
    type: z.enum(['all', 'org', 'site', 'group', 'device']),
    ids: z.array(z.string().uuid()).optional()
  }).optional(),
  conditions: z.any().optional(),
  notificationChannelIds: z.array(z.string().uuid()).optional(),
  notificationChannels: z.array(z.string().uuid()).optional(),
  cooldownMinutes: z.coerce.number().int().min(1).max(1440).optional(),
  autoResolve: z.boolean().optional(),
  enabled: z.boolean().optional(),
  active: z.boolean().optional(),
  overrideSettings: z.any().optional(),
  overrides: z.any().optional(),
  escalationPolicyId: z.string().uuid().optional(),
  isActive: z.boolean().optional()
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
    const enabledFilter = query.enabled ?? query.isActive;
    if (enabledFilter !== undefined) {
      conditions.push(eq(alertRules.isActive, enabledFilter === 'true'));
    }

    const whereCondition = conditions.length > 0 ? and(...conditions) : undefined;

    // Get total count
    const countResult = await db
      .select({ count: sql<number>`count(*)` })
      .from(alertRules)
      .where(whereCondition);
    const total = Number(countResult[0]?.count ?? 0);

    // Get rules with templates
    const rulesList = await db
      .select({
        rule: alertRules,
        template: alertTemplates
      })
      .from(alertRules)
      .leftJoin(alertTemplates, eq(alertRules.templateId, alertTemplates.id))
      .where(whereCondition)
      .orderBy(desc(alertRules.createdAt))
      .limit(limit)
      .offset(offset);

    return c.json({
      data: rulesList.map(({ rule, template }) => formatAlertRuleResponse(rule, template)),
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

    const [template] = await db
      .select()
      .from(alertTemplates)
      .where(eq(alertTemplates.id, rule.templateId))
      .limit(1);

    return c.json(formatAlertRuleResponse(rule, template ?? null));
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

    const orgId = data.orgId ?? auth.orgId;
    if (!orgId) {
      return c.json({ error: 'Organization context required' }, 403);
    }

    if (!auth.canAccessOrg(orgId)) {
      return c.json({ error: 'Access to this organization denied' }, 403);
    }

    const { targetType, targetId, targetIds, targets } = normalizeTargetsForRule(
      {
        targets: data.targets,
        targetType: data.targetType,
        targetId: data.targetId
      },
      orgId
    );

    if (!targetId) {
      return c.json({ error: 'Target is required' }, 400);
    }

    const { template, created } = await resolveAlertTemplate({
      templateId: data.templateId,
      orgId,
      name: data.name,
      description: data.description,
      severity: data.severity,
      conditions: data.conditions,
      cooldownMinutes: data.cooldownMinutes,
      autoResolve: data.autoResolve
    });

    if (!created && template.orgId && template.orgId !== orgId) {
      return c.json({ error: 'Access to this alert template denied' }, 403);
    }

    const baseOverrides: Record<string, unknown> = {
      ...(isRecord(data.overrideSettings) ? data.overrideSettings : {}),
      ...(isRecord(data.overrides) ? data.overrides : {})
    };

    if (data.description !== undefined) baseOverrides.description = data.description;
    if (data.severity !== undefined) baseOverrides.severity = data.severity;
    if (data.conditions !== undefined) baseOverrides.conditions = data.conditions;
    if (data.cooldownMinutes !== undefined) baseOverrides.cooldownMinutes = data.cooldownMinutes;
    if (data.autoResolve !== undefined) baseOverrides.autoResolve = data.autoResolve;
    if (data.escalationPolicyId !== undefined) baseOverrides.escalationPolicyId = data.escalationPolicyId;
    if (baseOverrides.cooldownMinutes === undefined && typeof baseOverrides.cooldown === 'number') {
      baseOverrides.cooldownMinutes = baseOverrides.cooldown;
    }

    const notificationChannelIds = data.notificationChannelIds ?? data.notificationChannels;
    if (notificationChannelIds !== undefined) {
      baseOverrides.notificationChannelIds = notificationChannelIds;
    }

    baseOverrides.targets = targets;
    baseOverrides.targetIds = targetIds;

    if (created) {
      baseOverrides.templateOwned = true;
    }

    const isActive = data.isActive ?? data.enabled ?? data.active ?? true;
    const ruleName = data.name?.trim() ?? template.name;

    const [rule] = await db
      .insert(alertRules)
      .values({
        orgId,
        templateId: template.id,
        name: ruleName,
        targetType,
        targetId,
        overrideSettings: Object.keys(baseOverrides).length > 0 ? baseOverrides : undefined,
        isActive
      })
      .returning();

    writeRouteAudit(c, {
      orgId,
      action: 'alert_rule.create',
      resourceType: 'alert_rule',
      resourceId: rule.id,
      resourceName: rule.name,
      details: {
        templateId: template.id,
        isActive: rule.isActive,
        targetType: rule.targetType,
      },
    });

    return c.json(formatAlertRuleResponse(rule, template), 201);
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

    const updates: Record<string, unknown> = {};
    let templateOwned = getOverrides(rule.overrideSettings).templateOwned;

    if (data.templateId !== undefined) {
      const resolved = await resolveAlertTemplate({
        templateId: data.templateId,
        orgId: rule.orgId,
        name: data.name,
        description: data.description,
        severity: data.severity,
        conditions: data.conditions,
        cooldownMinutes: data.cooldownMinutes,
        autoResolve: data.autoResolve
      });

      if (!resolved.created && resolved.template.orgId && resolved.template.orgId !== rule.orgId) {
        return c.json({ error: 'Access to this alert template denied' }, 403);
      }

      updates.templateId = resolved.template.id;
      templateOwned = resolved.created;
    }

    if (data.name !== undefined) updates.name = data.name;

    if (data.targets || data.targetType || data.targetId) {
      const resolvedTargets = normalizeTargetsForRule(
        {
          targets: data.targets,
          targetType: data.targetType,
          targetId: data.targetId
        },
        rule.orgId
      );

      if (!resolvedTargets.targetId) {
        return c.json({ error: 'Target is required' }, 400);
      }

      updates.targetType = resolvedTargets.targetType;
      updates.targetId = resolvedTargets.targetId;

      const overrides = getOverrides(rule.overrideSettings);
      overrides.targets = resolvedTargets.targets;
      overrides.targetIds = resolvedTargets.targetIds;
      rule.overrideSettings = overrides;
    }

    const baseOverrides: Record<string, unknown> = {
      ...getOverrides(rule.overrideSettings),
      ...(isRecord(data.overrideSettings) ? data.overrideSettings : {}),
      ...(isRecord(data.overrides) ? data.overrides : {})
    };

    if (data.description !== undefined) baseOverrides.description = data.description;
    if (data.severity !== undefined) baseOverrides.severity = data.severity;
    if (data.conditions !== undefined) baseOverrides.conditions = data.conditions;
    if (data.cooldownMinutes !== undefined) baseOverrides.cooldownMinutes = data.cooldownMinutes;
    if (data.autoResolve !== undefined) baseOverrides.autoResolve = data.autoResolve;
    if (data.escalationPolicyId !== undefined) baseOverrides.escalationPolicyId = data.escalationPolicyId;
    if (baseOverrides.cooldownMinutes === undefined && typeof baseOverrides.cooldown === 'number') {
      baseOverrides.cooldownMinutes = baseOverrides.cooldown;
    }

    const notificationChannelIds = data.notificationChannelIds ?? data.notificationChannels;
    if (notificationChannelIds !== undefined) {
      baseOverrides.notificationChannelIds = notificationChannelIds;
    }

    if (templateOwned !== undefined) {
      baseOverrides.templateOwned = templateOwned;
    }
    if (Object.keys(baseOverrides).length > 0) {
      baseOverrides.updatedAt = new Date().toISOString();
      updates.overrideSettings = baseOverrides;
    }

    const isActive = data.isActive ?? data.enabled ?? data.active;
    if (isActive !== undefined) updates.isActive = isActive;

    if (Object.keys(updates).length === 0) {
      return c.json({ error: 'No updates provided' }, 400);
    }

    if (templateOwned) {
      const [currentTemplate] = await db
        .select()
        .from(alertTemplates)
        .where(eq(alertTemplates.id, (updates.templateId as string) ?? rule.templateId))
        .limit(1);

      if (currentTemplate) {
        const templateUpdates: Record<string, unknown> = {};
        if (data.name !== undefined) templateUpdates.name = data.name.trim();
        if (data.description !== undefined) templateUpdates.description = data.description;
        if (data.conditions !== undefined) templateUpdates.conditions = data.conditions;
        if (data.severity !== undefined) templateUpdates.severity = data.severity;
        if (data.cooldownMinutes !== undefined) templateUpdates.cooldownMinutes = data.cooldownMinutes;
        if (data.autoResolve !== undefined) templateUpdates.autoResolve = data.autoResolve;

        if (Object.keys(templateUpdates).length > 0) {
          await db
            .update(alertTemplates)
            .set(templateUpdates)
            .where(eq(alertTemplates.id, currentTemplate.id));
        }
      }
    }

    const [updated] = await db
      .update(alertRules)
      .set(updates)
      .where(eq(alertRules.id, ruleId))
      .returning();

    writeRouteAudit(c, {
      orgId: updated.orgId,
      action: 'alert_rule.update',
      resourceType: 'alert_rule',
      resourceId: updated.id,
      resourceName: updated.name,
      details: {
        updatedFields: Object.keys(updates),
      },
    });

    const [template] = await db
      .select()
      .from(alertTemplates)
      .where(eq(alertTemplates.id, updated.templateId))
      .limit(1);

    return c.json(formatAlertRuleResponse(updated, template ?? null));
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

    writeRouteAudit(c, {
      orgId: rule.orgId,
      action: 'alert_rule.delete',
      resourceType: 'alert_rule',
      resourceId: rule.id,
      resourceName: rule.name,
      details: {
        activeAlerts: activeCount,
      },
    });

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

    const [template] = await db
      .select()
      .from(alertTemplates)
      .where(eq(alertTemplates.id, rule.templateId))
      .limit(1);

    if (!template) {
      return c.json({ error: 'Alert template not found' }, 404);
    }

    // Evaluate conditions against device
    // This is a simplified simulation - real implementation would evaluate all conditions
    const conditions = template.conditions as Record<string, unknown>;

    // Check if device matches targets
    let targetMatch = true;
    if (rule.targetType === 'device') {
      targetMatch = rule.targetId === device.id;
    }

    // Simulate condition evaluation
    const conditionResults: Array<{ condition: string; result: boolean; reason: string }> = [];

    // Example condition evaluation - would be more complex in production
    if (conditions && typeof conditions === 'object') {
      for (const key of Object.keys(conditions)) {
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
        severity: template.severity
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

    // Set cooldown to prevent immediate re-trigger by the evaluation worker
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

    const orgId = data.orgId ?? auth.orgId;
    if (!orgId) {
      return c.json({ error: 'Organization context required' }, 403);
    }

    if (!auth.canAccessOrg(orgId)) {
      return c.json({ error: 'Access to this organization denied' }, 403);
    }

    const [channel] = await db
      .insert(notificationChannels)
      .values({
        orgId,
        name: data.name,
        type: data.type,
        config: data.config,
        enabled: data.enabled
      })
      .returning();

    writeRouteAudit(c, {
      orgId,
      action: 'notification_channel.create',
      resourceType: 'notification_channel',
      resourceId: channel.id,
      resourceName: channel.name,
      details: {
        type: channel.type,
        enabled: channel.enabled,
      },
    });

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

    writeRouteAudit(c, {
      orgId: channel.orgId,
      action: 'notification_channel.update',
      resourceType: 'notification_channel',
      resourceId: updated.id,
      resourceName: updated.name,
      details: {
        updatedFields: Object.keys(data),
      },
    });

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

    await db
      .delete(notificationChannels)
      .where(eq(notificationChannels.id, channelId));

    writeRouteAudit(c, {
      orgId: channel.orgId,
      action: 'notification_channel.delete',
      resourceType: 'notification_channel',
      resourceId: channel.id,
      resourceName: channel.name,
    });

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

    const response = {
      channelId: channel.id,
      channelName: channel.name,
      channelType: channel.type,
      testMessage,
      testResult,
      testedAt: new Date().toISOString(),
      testedBy: auth.user.id
    };

    writeRouteAudit(c, {
      orgId: channel.orgId,
      action: 'notification_channel.test',
      resourceType: 'notification_channel',
      resourceId: channel.id,
      resourceName: channel.name,
      details: {
        success: testResult.success,
      },
      result: testResult.success ? 'success' : 'failure',
    });

    return c.json(response);
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

    writeRouteAudit(c, {
      orgId: policy.orgId,
      action: 'escalation_policy.create',
      resourceType: 'escalation_policy',
      resourceId: policy.id,
      resourceName: policy.name,
      details: {
        stepCount: Array.isArray(policy.steps) ? policy.steps.length : undefined,
      },
    });

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

    writeRouteAudit(c, {
      orgId: policy.orgId,
      action: 'escalation_policy.update',
      resourceType: 'escalation_policy',
      resourceId: updated.id,
      resourceName: updated.name,
      details: {
        updatedFields: Object.keys(data),
      },
    });

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

    await db
      .delete(escalationPolicies)
      .where(eq(escalationPolicies.id, policyId));

    writeRouteAudit(c, {
      orgId: policy.orgId,
      action: 'escalation_policy.delete',
      resourceType: 'escalation_policy',
      resourceId: policy.id,
      resourceName: policy.name,
    });

    return c.json({ success: true });
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
        templateId: rule.templateId,
        targetType: rule.targetType,
        targetId: rule.targetId,
        isActive: rule.isActive
      } : null,
      notifications
    });
  }
);
