import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { db } from '../../db';
import { notificationRoutingRules } from '../../db/schema';
import { eq, and, asc, inArray } from 'drizzle-orm';
import { requireMfa, requirePermission, requireScope } from '../../middleware/auth';
import { writeRouteAudit } from '../../services/auditEvents';
import { ensureOrgAccess } from './helpers';
import { PERMISSIONS } from '../../services/permissions';

const listRoutingRulesSchema = z.object({
  orgId: z.string().guid().optional(),
});

const createRoutingRuleSchema = z.object({
  name: z.string().min(1).max(255),
  priority: z.number().int().min(0),
  conditions: z.object({
    severities: z.array(z.enum(['critical', 'high', 'medium', 'low', 'info'])).optional(),
    conditionTypes: z.array(z.string()).optional(),
    deviceTags: z.array(z.string()).optional(),
    siteIds: z.array(z.string().guid()).optional(),
  }),
  channelIds: z.array(z.string().guid()).min(1),
  enabled: z.boolean().optional().default(true),
});

const updateRoutingRuleSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  priority: z.number().int().min(0).optional(),
  conditions: z.object({
    severities: z.array(z.enum(['critical', 'high', 'medium', 'low', 'info'])).optional(),
    conditionTypes: z.array(z.string()).optional(),
    deviceTags: z.array(z.string()).optional(),
    siteIds: z.array(z.string().guid()).optional(),
  }).optional(),
  channelIds: z.array(z.string().guid()).min(1).optional(),
  enabled: z.boolean().optional(),
});

export const routingRoutes = new Hono();

const requireAlertWrite = requirePermission(PERMISSIONS.ALERTS_WRITE.resource, PERMISSIONS.ALERTS_WRITE.action);

routingRoutes.get(
  '/routing-rules',
  requireScope('organization', 'partner', 'system'),
  zValidator('query', listRoutingRulesSchema),
  async (c) => {
    try {
      const auth = c.get('auth');
      const query = c.req.valid('query');

      // Scope the listing the same way GET /alerts/channels does so the page
      // can load without a specific org selected. Org-scoped users are pinned to
      // their own org; partner/system users honour an explicit ?orgId= and
      // otherwise fall back to all accessible orgs. A clean tenant with no rules
      // (or a partner with no accessible orgs) returns an empty list — never 400.
      let orgFilter;
      if (auth.scope === 'organization') {
        if (!auth.orgId) {
          return c.json({ error: 'Organization context required' }, 403);
        }
        orgFilter = eq(notificationRoutingRules.orgId, auth.orgId);
      } else if (query.orgId) {
        if (!ensureOrgAccess(query.orgId, auth)) {
          return c.json({ error: 'Access to this organization denied' }, 403);
        }
        orgFilter = eq(notificationRoutingRules.orgId, query.orgId);
      } else if (auth.scope === 'partner') {
        const orgIds = auth.accessibleOrgIds ?? [];
        if (orgIds.length === 0) {
          return c.json({ data: [] });
        }
        orgFilter = inArray(notificationRoutingRules.orgId, orgIds);
      }
      // system scope with no orgId falls through to no filter (sees all rules);
      // RLS still constrains what breeze_app can read.

      const rules = await db
        .select()
        .from(notificationRoutingRules)
        .where(orgFilter)
        .orderBy(asc(notificationRoutingRules.priority));

      return c.json({ data: rules });
    } catch (error) {
      console.error('[RoutingRules] Failed to list routing rules', error);
      return c.json({ error: 'Failed to list routing rules' }, 500);
    }
  }
);

routingRoutes.post(
  '/routing-rules',
  requireScope('organization', 'partner', 'system'),
  requireAlertWrite,
  requireMfa(),
  zValidator('json', createRoutingRuleSchema),
  async (c) => {
    try {
      const auth = c.get('auth');
      const orgId = auth.orgId;
      if (!orgId) {
        return c.json({ error: 'orgId is required' }, 400);
      }

      const data = c.req.valid('json');

      const [rule] = await db
        .insert(notificationRoutingRules)
        .values({
          orgId,
          name: data.name,
          priority: data.priority,
          conditions: data.conditions,
          channelIds: data.channelIds,
          enabled: data.enabled,
        })
        .returning();

      writeRouteAudit(c, {
        orgId,
        action: 'notification_routing_rule.create',
        resourceType: 'notification_routing_rule',
        resourceId: rule?.id,
        resourceName: data.name,
        details: { priority: data.priority, channelCount: data.channelIds.length },
      });

      return c.json({ data: rule }, 201);
    } catch (error) {
      console.error('[RoutingRules] Failed to create routing rule', error);
      return c.json({ error: 'Failed to create routing rule' }, 500);
    }
  }
);

routingRoutes.patch(
  '/routing-rules/:id',
  requireScope('organization', 'partner', 'system'),
  requireAlertWrite,
  requireMfa(),
  zValidator('json', updateRoutingRuleSchema),
  async (c) => {
    try {
      const auth = c.get('auth');
      const orgId = auth.orgId;
      if (!orgId) {
        return c.json({ error: 'orgId is required' }, 400);
      }

      const ruleId = c.req.param('id')!;
      const updates = c.req.valid('json');

      const [existing] = await db
        .select()
        .from(notificationRoutingRules)
        .where(and(eq(notificationRoutingRules.id, ruleId), eq(notificationRoutingRules.orgId, orgId)))
        .limit(1);

      if (!existing) {
        return c.json({ error: 'Routing rule not found' }, 404);
      }

      const setValues: Record<string, unknown> = { updatedAt: new Date() };
      if (updates.name !== undefined) setValues.name = updates.name;
      if (updates.priority !== undefined) setValues.priority = updates.priority;
      if (updates.conditions !== undefined) setValues.conditions = updates.conditions;
      if (updates.channelIds !== undefined) setValues.channelIds = updates.channelIds;
      if (updates.enabled !== undefined) setValues.enabled = updates.enabled;

      const [updated] = await db
        .update(notificationRoutingRules)
        .set(setValues)
        .where(and(eq(notificationRoutingRules.id, ruleId), eq(notificationRoutingRules.orgId, orgId)))
        .returning();

      writeRouteAudit(c, {
        orgId,
        action: 'notification_routing_rule.update',
        resourceType: 'notification_routing_rule',
        resourceId: ruleId,
        resourceName: updated?.name ?? existing.name,
        details: { updatedFields: Object.keys(updates) },
      });

      return c.json({ data: updated });
    } catch (error) {
      console.error('[RoutingRules] Failed to update routing rule', error);
      return c.json({ error: 'Failed to update routing rule' }, 500);
    }
  }
);

routingRoutes.delete(
  '/routing-rules/:id',
  requireScope('organization', 'partner', 'system'),
  requireAlertWrite,
  requireMfa(),
  async (c) => {
    try {
      const auth = c.get('auth');
      const orgId = auth.orgId;
      if (!orgId) {
        return c.json({ error: 'orgId is required' }, 400);
      }

      const ruleId = c.req.param('id')!;

      const [existing] = await db
        .select()
        .from(notificationRoutingRules)
        .where(and(eq(notificationRoutingRules.id, ruleId), eq(notificationRoutingRules.orgId, orgId)))
        .limit(1);

      if (!existing) {
        return c.json({ error: 'Routing rule not found' }, 404);
      }

      await db.delete(notificationRoutingRules).where(
        and(eq(notificationRoutingRules.id, ruleId), eq(notificationRoutingRules.orgId, orgId))
      );

      writeRouteAudit(c, {
        orgId,
        action: 'notification_routing_rule.delete',
        resourceType: 'notification_routing_rule',
        resourceId: existing.id,
        resourceName: existing.name,
      });

      return c.json({ data: { id: ruleId, deleted: true } });
    } catch (error) {
      console.error('[RoutingRules] Failed to delete routing rule', error);
      return c.json({ error: 'Failed to delete routing rule' }, 500);
    }
  }
);
