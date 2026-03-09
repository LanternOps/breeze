import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { db } from '../../db';
import { notificationRoutingRules } from '../../db/schema';
import { eq, and, asc } from 'drizzle-orm';
import { requireScope } from '../../middleware/auth';
import { writeRouteAudit } from '../../services/auditEvents';

const createRoutingRuleSchema = z.object({
  name: z.string().min(1).max(255),
  priority: z.number().int().min(0),
  conditions: z.object({
    severities: z.array(z.enum(['critical', 'high', 'medium', 'low', 'info'])).optional(),
    conditionTypes: z.array(z.string()).optional(),
    deviceTags: z.array(z.string()).optional(),
    siteIds: z.array(z.string().uuid()).optional(),
  }),
  channelIds: z.array(z.string().uuid()).min(1),
  enabled: z.boolean().optional().default(true),
});

const updateRoutingRuleSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  priority: z.number().int().min(0).optional(),
  conditions: z.object({
    severities: z.array(z.enum(['critical', 'high', 'medium', 'low', 'info'])).optional(),
    conditionTypes: z.array(z.string()).optional(),
    deviceTags: z.array(z.string()).optional(),
    siteIds: z.array(z.string().uuid()).optional(),
  }).optional(),
  channelIds: z.array(z.string().uuid()).min(1).optional(),
  enabled: z.boolean().optional(),
});

export const routingRoutes = new Hono();

routingRoutes.get(
  '/routing-rules',
  requireScope('organization', 'partner', 'system'),
  async (c) => {
    try {
      const auth = c.get('auth');
      const orgId = auth.orgId;
      if (!orgId) {
        return c.json({ error: 'orgId is required' }, 400);
      }

      const rules = await db
        .select()
        .from(notificationRoutingRules)
        .where(eq(notificationRoutingRules.orgId, orgId))
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
  zValidator('json', updateRoutingRuleSchema),
  async (c) => {
    try {
      const auth = c.get('auth');
      const orgId = auth.orgId;
      if (!orgId) {
        return c.json({ error: 'orgId is required' }, 400);
      }

      const ruleId = c.req.param('id');
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
        .where(eq(notificationRoutingRules.id, ruleId))
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
  async (c) => {
    try {
      const auth = c.get('auth');
      const orgId = auth.orgId;
      if (!orgId) {
        return c.json({ error: 'orgId is required' }, 400);
      }

      const ruleId = c.req.param('id');

      const [existing] = await db
        .select()
        .from(notificationRoutingRules)
        .where(and(eq(notificationRoutingRules.id, ruleId), eq(notificationRoutingRules.orgId, orgId)))
        .limit(1);

      if (!existing) {
        return c.json({ error: 'Routing rule not found' }, 404);
      }

      await db.delete(notificationRoutingRules).where(eq(notificationRoutingRules.id, ruleId));

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
