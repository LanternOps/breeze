import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { and, eq, sql, desc, inArray } from 'drizzle-orm';
import { db } from '../../db';
import { alertRules, alertTemplates, alerts, devices } from '../../db/schema';
import { requireScope } from '../../middleware/auth';
import { writeRouteAudit } from '../../services/auditEvents';
import {
  listAlertRulesSchema,
  createAlertRuleSchema,
  updateAlertRuleSchema,
  testAlertRuleSchema,
} from './schemas';
import {
  getPagination,
  ensureOrgAccess,
  getAlertRuleWithOrgCheck,
  isRecord,
  getOverrides,
  normalizeTargetsForRule,
  getNotificationChannelIds,
  containsNotificationBindingOverride,
  validateAlertRuleNotificationBindings,
  formatAlertRuleResponse,
  resolveAlertTemplate,
} from './helpers';

export const rulesRoutes = new Hono();

// GET /alerts/rules - List alert rules with pagination
rulesRoutes.get(
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
        const hasAccess = ensureOrgAccess(query.orgId, auth);
        if (!hasAccess) {
          return c.json({ error: 'Access to this organization denied' }, 403);
        }
        conditions.push(eq(alertRules.orgId, query.orgId));
      } else {
        const orgIds = auth.accessibleOrgIds ?? [];
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
rulesRoutes.get(
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
// DEPRECATED: Alert rules are now managed via Configuration Policies. These routes remain for legacy compatibility.
rulesRoutes.post(
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
    if (!template) {
      return c.json({ error: 'Failed to resolve alert template' }, 500);
    }

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

    const createNotificationBindingError = await validateAlertRuleNotificationBindings(
      orgId,
      getOverrides(baseOverrides)
    );
    if (createNotificationBindingError) {
      return c.json({ error: createNotificationBindingError }, 400);
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
    if (!rule) {
      return c.json({ error: 'Failed to create alert rule' }, 500);
    }

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
// DEPRECATED: Alert rules are now managed via Configuration Policies. These routes remain for legacy compatibility.
rulesRoutes.put(
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
      if (!resolved.template) {
        return c.json({ error: 'Failed to resolve alert template' }, 500);
      }
      const resolvedTemplate = resolved.template;

      if (!resolved.created && resolvedTemplate.orgId && resolvedTemplate.orgId !== rule.orgId) {
        return c.json({ error: 'Access to this alert template denied' }, 403);
      }

      updates.templateId = resolvedTemplate.id;
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

    const shouldValidateNotificationBindings =
      data.escalationPolicyId !== undefined
      || data.notificationChannelIds !== undefined
      || data.notificationChannels !== undefined
      || containsNotificationBindingOverride(data.overrideSettings)
      || containsNotificationBindingOverride(data.overrides);

    if (shouldValidateNotificationBindings) {
      const updateNotificationBindingError = await validateAlertRuleNotificationBindings(
        rule.orgId,
        getOverrides(baseOverrides)
      );
      if (updateNotificationBindingError) {
        return c.json({ error: updateNotificationBindingError }, 400);
      }
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
    if (!updated) {
      return c.json({ error: 'Failed to update alert rule' }, 500);
    }

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
// DEPRECATED: Alert rules are now managed via Configuration Policies. These routes remain for legacy compatibility.
rulesRoutes.delete(
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
rulesRoutes.post(
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
