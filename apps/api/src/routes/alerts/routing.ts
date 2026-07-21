import { Hono } from 'hono';
import { zValidator } from '../../lib/validation';
import { z } from 'zod';
import { db } from '../../db';
import { notificationRoutingRules, organizations, sites } from '../../db/schema';
import { eq, and, asc, inArray, isNull, or, sql } from 'drizzle-orm';
import { requireMfa, requirePermission, requireScope, siteAccessCheck } from '../../middleware/auth';
import { writeRouteAudit } from '../../services/auditEvents';
import { ensureOrgAccess, resolveWriteOrgId } from './helpers';
import {
  canManagePartnerWidePolicies,
  PARTNER_WIDE_WRITE_DENIED_MESSAGE,
} from '../../services/partnerWideAccess';
import { PERMISSIONS } from '../../services/permissions';

const listRoutingRulesSchema = z.object({
  orgId: z.string().guid().optional(),
});

const createRoutingRuleSchema = z.object({
  // 'partner' creates a partner-wide ("all orgs") routing rule: orgId NULL,
  // partnerId = caller's partner (#2130). Create-only.
  ownerScope: z.enum(['organization', 'partner']).optional(),
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

const requireAlertRead = requirePermission(PERMISSIONS.ALERTS_READ.resource, PERMISSIONS.ALERTS_READ.action);
const requireAlertWrite = requirePermission(PERMISSIONS.ALERTS_WRITE.resource, PERMISSIONS.ALERTS_WRITE.action);

type RoutingSiteAuth = { allowedSiteIds?: string[] };
type RoutingRuleOwner = { orgId: string | null; partnerId: string | null };

function routingSiteIds(conditions: unknown): string[] {
  if (!conditions || typeof conditions !== 'object' || Array.isArray(conditions)) return [];
  const value = (conditions as Record<string, unknown>).siteIds;
  return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [];
}

async function canAccessRoutingSites(
  auth: RoutingSiteAuth,
  owner: RoutingRuleOwner,
  siteIds: string[],
  validateOwnership: boolean
): Promise<boolean> {
  const uniqueSiteIds = [...new Set(siteIds)];
  if (uniqueSiteIds.length === 0) return auth.allowedSiteIds === undefined;
  if (!validateOwnership && auth.allowedSiteIds === undefined) return true;

  const ownershipCondition = owner.orgId !== null
    ? eq(sites.orgId, owner.orgId)
    : owner.partnerId
      ? sql`${sites.orgId} IN (SELECT ${organizations.id} FROM ${organizations} WHERE ${organizations.partnerId} = ${owner.partnerId})`
      : undefined;
  if (!ownershipCondition) return false;

  const rows = await db
    .select({ id: sites.id })
    .from(sites)
    .where(and(inArray(sites.id, uniqueSiteIds), ownershipCondition));
  if (rows.length !== uniqueSiteIds.length) return false;

  const canAccessSite = siteAccessCheck(auth.allowedSiteIds);
  return rows.every((row) => canAccessSite(row.id));
}

// Dual-axis by-id lookup (#2130): org-owned rules via org access; partner-wide
// rules (orgId NULL) via the caller's own partner (or system scope). Writes are
// additionally gated on canManagePartnerWidePolicies at the routes.
async function getRoutingRuleWithAccess(
  ruleId: string,
  auth: { scope?: string; partnerId?: string | null; canAccessOrg: (orgId: string) => boolean }
) {
  const [rule] = await db
    .select()
    .from(notificationRoutingRules)
    .where(eq(notificationRoutingRules.id, ruleId))
    .limit(1);

  if (!rule) {
    return null;
  }

  const hasAccess = rule.orgId !== null
    ? ensureOrgAccess(rule.orgId, auth)
    : auth.scope === 'system' || (!!auth.partnerId && rule.partnerId === auth.partnerId);
  return hasAccess ? rule : null;
}

routingRoutes.get(
  '/routing-rules',
  requireScope('organization', 'partner', 'system'),
  requireAlertRead,
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
        // "All orgs" view: org-owned rules across accessible orgs PLUS this
        // partner's own partner-wide rules (org_id NULL, #2130).
        const orgIds = auth.accessibleOrgIds ?? [];
        const orgCondition = orgIds.length > 0
          ? inArray(notificationRoutingRules.orgId, orgIds)
          : undefined;
        const partnerCondition = auth.partnerId
          ? and(isNull(notificationRoutingRules.orgId), eq(notificationRoutingRules.partnerId, auth.partnerId))
          : undefined;
        orgFilter = orgCondition && partnerCondition
          ? or(orgCondition, partnerCondition)
          : (orgCondition ?? partnerCondition);
        if (!orgFilter) {
          return c.json({ data: [] });
        }
      }
      // system scope with no orgId falls through to no filter (sees all rules);
      // RLS still constrains what breeze_app can read.

      const rules = await db
        .select()
        .from(notificationRoutingRules)
        .where(orgFilter)
        .orderBy(asc(notificationRoutingRules.priority));

      const visibleRules = auth.allowedSiteIds === undefined
        ? rules
        : (await Promise.all(rules.map(async (rule) => ({
          rule,
          visible: await canAccessRoutingSites(
            auth,
            { orgId: rule.orgId, partnerId: rule.partnerId },
            routingSiteIds(rule.conditions),
            false
          ),
        })))).filter(({ visible }) => visible).map(({ rule }) => rule);

      return c.json({ data: visibleRules });
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
      const data = c.req.valid('json');

      // Resolve the ownership axis (#2130): partner-wide creation requires
      // the partner-wide capability; the default path stays org-owned.
      let owner: { orgId: string | null; partnerId: string | null };
      if (data.ownerScope === 'partner') {
        if (!canManagePartnerWidePolicies(auth) || !auth.partnerId) {
          return c.json({ error: PARTNER_WIDE_WRITE_DENIED_MESSAGE }, 403);
        }
        owner = { orgId: null, partnerId: auth.partnerId };
      } else {
        const resolved = resolveWriteOrgId(auth, c.req.query('orgId'));
        if (resolved.error) {
          return c.json({ error: resolved.error }, resolved.status ?? 400);
        }
        owner = { orgId: resolved.orgId!, partnerId: null };
      }

      const canAccessSites = await canAccessRoutingSites(
        auth,
        owner,
        routingSiteIds(data.conditions),
        true
      );
      if (!canAccessSites) {
        return c.json({ error: 'Routing rule sites are outside your permitted sites' }, 403);
      }

      const [rule] = await db
        .insert(notificationRoutingRules)
        .values({
          orgId: owner.orgId,
          partnerId: owner.partnerId,
          name: data.name,
          priority: data.priority,
          conditions: data.conditions,
          channelIds: data.channelIds,
          enabled: data.enabled,
        })
        .returning();

      writeRouteAudit(c, {
        orgId: owner.orgId,
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
      const ruleId = c.req.param('id')!;
      const updates = c.req.valid('json');

      const existing = await getRoutingRuleWithAccess(ruleId, auth);
      if (!existing) {
        return c.json({ error: 'Routing rule not found' }, 404);
      }

      // Partner-wide routing rules are administrable only with the
      // partner-wide capability (#2130).
      if (existing.orgId === null && !canManagePartnerWidePolicies(auth)) {
        return c.json({ error: PARTNER_WIDE_WRITE_DENIED_MESSAGE }, 403);
      }

      const owner = { orgId: existing.orgId, partnerId: existing.partnerId };
      const canAccessExistingSites = await canAccessRoutingSites(
        auth,
        owner,
        routingSiteIds(existing.conditions),
        true
      );
      if (!canAccessExistingSites) {
        return c.json({ error: 'Routing rule sites are outside your permitted sites' }, 403);
      }
      if (updates.conditions !== undefined) {
        const canAccessUpdatedSites = await canAccessRoutingSites(
          auth,
          owner,
          routingSiteIds(updates.conditions),
          true
        );
        if (!canAccessUpdatedSites) {
          return c.json({ error: 'Routing rule sites are outside your permitted sites' }, 403);
        }
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
        orgId: existing.orgId,
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
      const ruleId = c.req.param('id')!;

      const existing = await getRoutingRuleWithAccess(ruleId, auth);
      if (!existing) {
        return c.json({ error: 'Routing rule not found' }, 404);
      }

      // Partner-wide routing rules are administrable only with the
      // partner-wide capability (#2130).
      if (existing.orgId === null && !canManagePartnerWidePolicies(auth)) {
        return c.json({ error: PARTNER_WIDE_WRITE_DENIED_MESSAGE }, 403);
      }

      const canAccessExistingSites = await canAccessRoutingSites(
        auth,
        { orgId: existing.orgId, partnerId: existing.partnerId },
        routingSiteIds(existing.conditions),
        true
      );
      if (!canAccessExistingSites) {
        return c.json({ error: 'Routing rule sites are outside your permitted sites' }, 403);
      }

      await db.delete(notificationRoutingRules).where(
        eq(notificationRoutingRules.id, ruleId)
      );

      writeRouteAudit(c, {
        orgId: existing.orgId,
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
