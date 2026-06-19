import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { db } from '../../db';
import { notificationRoutingRules } from '../../db/schema';
import { eq, and, asc, inArray, type SQL } from 'drizzle-orm';
import { requireMfa, requirePermission, requireScope } from '../../middleware/auth';
import { writeRouteAudit } from '../../services/auditEvents';
import { PERMISSIONS } from '../../services/permissions';
import { ensureOrgAccess } from './helpers';

const listRoutingRulesSchema = z.object({
  orgId: z.string().guid().optional(),
});

type RoutingAuth = {
  scope: string;
  orgId: string | null;
  accessibleOrgIds: string[] | null;
  canAccessOrg: (orgId: string) => boolean;
};

// Resolve the single org a write (create/update/delete) targets, scope-aware.
// Mirrors the escalation-policies route (policies.ts) so partner-scoped users —
// whose auth.orgId is null and who select an org per request — can manage routing
// rules via the ?orgId query param instead of always 400ing (issue #1633).
// RLS still backstops tenant isolation; this just resolves a valid orgId to write.
function resolveWriteOrgId(
  auth: RoutingAuth,
  requestedOrgId: string | undefined,
): { orgId: string } | { error: string; status: 400 | 403 } {
  if (auth.scope === 'organization') {
    if (!auth.orgId) return { error: 'Organization context required', status: 403 };
    return { orgId: auth.orgId };
  }
  if (auth.scope === 'partner') {
    let orgId = requestedOrgId;
    if (!orgId) {
      const orgs = auth.accessibleOrgIds ?? [];
      if (orgs.length === 1 && orgs[0]) {
        orgId = orgs[0];
      } else {
        return { error: 'orgId is required when partner has multiple organizations', status: 400 };
      }
    }
    if (!ensureOrgAccess(orgId, auth)) {
      return { error: 'Access to this organization denied', status: 403 };
    }
    return { orgId };
  }
  // system
  if (!requestedOrgId) return { error: 'orgId is required', status: 400 };
  return { orgId: requestedOrgId };
}

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
      const auth = c.get('auth') as RoutingAuth;
      const query = c.req.valid('query');

      // Build the org filter the same way the policies list does, so partner-scoped
      // users (auth.orgId null) can list by the selected ?orgId or across all their
      // accessible orgs, instead of always 400ing (issue #1633).
      const conditions: SQL[] = [];
      if (auth.scope === 'organization') {
        if (!auth.orgId) {
          return c.json({ error: 'Organization context required' }, 403);
        }
        conditions.push(eq(notificationRoutingRules.orgId, auth.orgId));
      } else if (auth.scope === 'partner') {
        if (query.orgId) {
          if (!ensureOrgAccess(query.orgId, auth)) {
            return c.json({ error: 'Access to this organization denied' }, 403);
          }
          conditions.push(eq(notificationRoutingRules.orgId, query.orgId));
        } else {
          const orgIds = auth.accessibleOrgIds ?? [];
          if (orgIds.length === 0) {
            return c.json({ data: [] });
          }
          conditions.push(inArray(notificationRoutingRules.orgId, orgIds));
        }
      } else if (auth.scope === 'system' && query.orgId) {
        conditions.push(eq(notificationRoutingRules.orgId, query.orgId));
      }

      const whereCondition = conditions.length === 1 ? conditions[0] : and(...conditions);

      const rules = await db
        .select()
        .from(notificationRoutingRules)
        .where(whereCondition)
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
      const auth = c.get('auth') as RoutingAuth;
      const resolved = resolveWriteOrgId(auth, c.req.query('orgId') || undefined);
      if ('error' in resolved) {
        return c.json({ error: resolved.error }, resolved.status);
      }
      const orgId = resolved.orgId;

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
      const auth = c.get('auth') as RoutingAuth;
      const resolved = resolveWriteOrgId(auth, c.req.query('orgId') || undefined);
      if ('error' in resolved) {
        return c.json({ error: resolved.error }, resolved.status);
      }
      const orgId = resolved.orgId;

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
      const auth = c.get('auth') as RoutingAuth;
      const resolved = resolveWriteOrgId(auth, c.req.query('orgId') || undefined);
      if ('error' in resolved) {
        return c.json({ error: resolved.error }, resolved.status);
      }
      const orgId = resolved.orgId;

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
