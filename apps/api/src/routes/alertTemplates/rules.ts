import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { randomUUID } from 'crypto';
import { requireScope } from '../../middleware/auth';
import { writeRouteAudit } from '../../services/auditEvents';
import type { AlertTemplateTarget, AlertRule } from './schemas';
import { listRulesSchema, createRuleSchema, updateRuleSchema, toggleRuleSchema } from './schemas';
import { alertRules } from './data';
import { resolveScopedOrgId, paginate, parseBoolean, getTemplateById, getRuleForOrg, matchesTargetFilter } from './helpers';

export const ruleRoutes = new Hono();

ruleRoutes.get(
  '/rules',
  requireScope('organization', 'partner', 'system'),
  zValidator('query', listRulesSchema),
  async (c) => {
    try {
      const auth = c.get('auth');
      const orgId = resolveScopedOrgId(auth);
      if (!orgId) {
        return c.json({ error: 'orgId is required for this scope' }, 400);
      }

      const query = c.req.valid('query');
      if (query.orgId && query.orgId !== orgId) {
        return c.json({ error: 'Forbidden' }, 403);
      }

      let data = Array.from(alertRules.values()).filter((rule) => rule.orgId === orgId);

      if (query.orgId) {
        data = data.filter((rule) => rule.orgId === query.orgId);
      }

      const enabled = parseBoolean(query.enabled);
      if (enabled !== undefined) {
        data = data.filter((rule) => rule.enabled === enabled);
      }

      if (query.severity) {
        data = data.filter((rule) => rule.severity === query.severity);
      }

      if (query.templateId) {
        data = data.filter((rule) => rule.templateId === query.templateId);
      }

      if (query.search) {
        const search = query.search.toLowerCase();
        data = data.filter((rule) =>
          rule.name.toLowerCase().includes(search) ||
          (rule.description ?? '').toLowerCase().includes(search)
        );
      }

      data = data.filter((rule) => matchesTargetFilter(rule, query.targetType, query.targetValue));

      const result = paginate(data, query);
      return c.json(result);
    } catch {
      return c.json({ error: 'Failed to list rules' }, 500);
    }
  }
);

ruleRoutes.post(
  '/rules',
  requireScope('organization', 'partner', 'system'),
  zValidator('json', createRuleSchema),
  async (c) => {
    try {
      const auth = c.get('auth');
      const orgId = resolveScopedOrgId(auth);
      if (!orgId) {
        return c.json({ error: 'orgId is required for this scope' }, 400);
      }

      const data = c.req.valid('json');
      if (data.orgId && data.orgId !== orgId) {
        return c.json({ error: 'Forbidden' }, 403);
      }

      const template = getTemplateById(data.templateId, orgId);

      if (!template) {
        return c.json({ error: 'Template not found' }, 404);
      }

      const rule: AlertRule = {
        id: randomUUID(),
        orgId,
        name: data.name.trim(),
        description: data.description,
        templateId: template.id,
        templateName: template.name,
        severity: data.severity ?? template.severity,
        enabled: data.enabled ?? true,
        targets: (data.targets as AlertTemplateTarget) ?? template.targets,
        conditions: data.conditions ?? template.conditions,
        cooldownMinutes: data.cooldownMinutes ?? template.defaultCooldownMinutes,
        createdAt: new Date(),
        updatedAt: new Date(),
        lastTriggeredAt: null
      };

      alertRules.set(rule.id, rule);
      writeRouteAudit(c, {
        orgId,
        action: 'alert_rule.create',
        resourceType: 'alert_rule',
        resourceId: rule.id,
        resourceName: rule.name,
        details: {
          templateId: rule.templateId,
          enabled: rule.enabled,
          severity: rule.severity,
        },
      });
      return c.json({ data: rule }, 201);
    } catch {
      return c.json({ error: 'Failed to create rule' }, 500);
    }
  }
);

ruleRoutes.get(
  '/rules/:id',
  requireScope('organization', 'partner', 'system'),
  async (c) => {
    try {
      const auth = c.get('auth');
      const orgId = resolveScopedOrgId(auth);
      if (!orgId) {
        return c.json({ error: 'orgId is required for this scope' }, 400);
      }

      const ruleId = c.req.param('id');
      const rule = getRuleForOrg(ruleId, orgId);

      if (!rule) {
        return c.json({ error: 'Rule not found' }, 404);
      }

      return c.json({ data: rule });
    } catch {
      return c.json({ error: 'Failed to fetch rule' }, 500);
    }
  }
);

ruleRoutes.patch(
  '/rules/:id',
  requireScope('organization', 'partner', 'system'),
  zValidator('json', updateRuleSchema),
  async (c) => {
    try {
      const auth = c.get('auth');
      const orgId = resolveScopedOrgId(auth);
      if (!orgId) {
        return c.json({ error: 'orgId is required for this scope' }, 400);
      }

      const ruleId = c.req.param('id');
      const updates = c.req.valid('json');
      const existing = getRuleForOrg(ruleId, orgId);

      if (!existing) {
        return c.json({ error: 'Rule not found' }, 404);
      }

      if (Object.keys(updates).length === 0) {
        return c.json({ error: 'No updates provided' }, 400);
      }

      const updated: AlertRule = {
        ...existing,
        ...updates,
        name: updates.name?.trim() ?? existing.name,
        targets: (updates.targets as AlertTemplateTarget) ?? existing.targets,
        updatedAt: new Date()
      };

      alertRules.set(ruleId, updated);
      writeRouteAudit(c, {
        orgId,
        action: 'alert_rule.update',
        resourceType: 'alert_rule',
        resourceId: updated.id,
        resourceName: updated.name,
        details: {
          updatedFields: Object.keys(updates),
        },
      });
      return c.json({ data: updated });
    } catch {
      return c.json({ error: 'Failed to update rule' }, 500);
    }
  }
);

ruleRoutes.delete(
  '/rules/:id',
  requireScope('organization', 'partner', 'system'),
  async (c) => {
    try {
      const auth = c.get('auth');
      const orgId = resolveScopedOrgId(auth);
      if (!orgId) {
        return c.json({ error: 'orgId is required for this scope' }, 400);
      }

      const ruleId = c.req.param('id');
      const existing = getRuleForOrg(ruleId, orgId);

      if (!existing) {
        return c.json({ error: 'Rule not found' }, 404);
      }

      alertRules.delete(ruleId);
      writeRouteAudit(c, {
        orgId,
        action: 'alert_rule.delete',
        resourceType: 'alert_rule',
        resourceId: existing.id,
        resourceName: existing.name,
      });
      return c.json({ data: { id: ruleId, deleted: true } });
    } catch {
      return c.json({ error: 'Failed to delete rule' }, 500);
    }
  }
);

ruleRoutes.post(
  '/rules/:id/toggle',
  requireScope('organization', 'partner', 'system'),
  zValidator('json', toggleRuleSchema),
  async (c) => {
    try {
      const auth = c.get('auth');
      const orgId = resolveScopedOrgId(auth);
      if (!orgId) {
        return c.json({ error: 'orgId is required for this scope' }, 400);
      }

      const ruleId = c.req.param('id');
      const { enabled } = c.req.valid('json');
      const existing = getRuleForOrg(ruleId, orgId);

      if (!existing) {
        return c.json({ error: 'Rule not found' }, 404);
      }

      const updated: AlertRule = {
        ...existing,
        enabled,
        updatedAt: new Date()
      };

      alertRules.set(ruleId, updated);
      writeRouteAudit(c, {
        orgId,
        action: 'alert_rule.toggle',
        resourceType: 'alert_rule',
        resourceId: updated.id,
        resourceName: updated.name,
        details: {
          enabled,
        },
      });
      return c.json({ data: updated });
    } catch {
      return c.json({ error: 'Failed to toggle rule' }, 500);
    }
  }
);
