import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { db } from '../../db';
import { alertRules, alertTemplates, organizations } from '../../db/schema';
import { eq, and, like, or, desc, isNull, type SQL } from 'drizzle-orm';
import { requireMfa, requirePermission, requireScope } from '../../middleware/auth';
import { writeRouteAudit } from '../../services/auditEvents';
import { listRulesSchema, createRuleSchema, updateRuleSchema, toggleRuleSchema } from './schemas';
import { resolveScopedOrgId, parseBoolean } from './helpers';
import { getPagination } from '../../utils/pagination';
import { PERMISSIONS } from '../../services/permissions';

export const ruleRoutes = new Hono();

const requireAlertWrite = requirePermission(PERMISSIONS.ALERTS_WRITE.resource, PERMISSIONS.ALERTS_WRITE.action);

// Dual-axis rule condition for this legacy org-pinned route (#2128): the org's
// own rules PLUS the partner-wide rules (org_id NULL) of the org's partner —
// those govern this org's devices too, so hiding them here would misrepresent
// what alerting applies. Partner-wide rules are read-only on this route; they
// are managed via /alerts/rules at partner scope.
async function ruleOwnershipConditionForOrg(orgId: string): Promise<SQL> {
  const [orgRow] = await db
    .select({ partnerId: organizations.partnerId })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);
  const partnerId = orgRow?.partnerId ?? null;
  if (!partnerId) return eq(alertRules.orgId, orgId) as unknown as SQL;
  return or(
    eq(alertRules.orgId, orgId),
    and(isNull(alertRules.orgId), eq(alertRules.partnerId, partnerId))
  ) as SQL;
}

const PARTNER_WIDE_RULE_READONLY_HERE =
  'This is a partner-wide alert rule; manage it via /alerts/rules at partner scope';

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

      const conditions: SQL[] = [await ruleOwnershipConditionForOrg(orgId)];

      const enabled = parseBoolean(query.enabled);
      if (enabled !== undefined) {
        conditions.push(eq(alertRules.isActive, enabled));
      }

      if (query.templateId) {
        conditions.push(eq(alertRules.templateId, query.templateId));
      }

      if (query.targetType) {
        conditions.push(eq(alertRules.targetType, query.targetType));
      }

      if (query.search) {
        const search = `%${query.search.toLowerCase()}%`;
        conditions.push(like(alertRules.name, search));
      }

      const rows = await db
        .select({
          rule: alertRules,
          templateName: alertTemplates.name,
          templateSeverity: alertTemplates.severity,
        })
        .from(alertRules)
        .leftJoin(alertTemplates, eq(alertRules.templateId, alertTemplates.id))
        .where(and(...conditions))
        .orderBy(desc(alertRules.createdAt));

      // Merge template info into rule response
      const data = rows.map(r => {
        const overrides = r.rule.overrideSettings as Record<string, unknown> | null;
        return {
          ...r.rule,
          templateName: r.templateName,
          severity: (overrides?.severity as string) ?? r.templateSeverity ?? r.rule.targetType,
          enabled: r.rule.isActive,
        };
      });

      // Filter by severity if requested (after overrides are resolved)
      let filtered = data;
      if (query.severity) {
        filtered = data.filter(d => d.severity === query.severity);
      }

      const { page, limit, offset } = getPagination(query);
      return c.json({
        data: filtered.slice(offset, offset + limit),
        page,
        limit,
        total: filtered.length
      });
    } catch (err) {
      console.error('[alertTemplates/rules] list failed:', err);
      return c.json({ error: 'Failed to list rules' }, 500);
    }
  }
);

ruleRoutes.post(
  '/rules',
  requireScope('organization', 'partner', 'system'),
  requireAlertWrite,
  requireMfa(),
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

      // Verify template exists and is accessible
      const [template] = await db
        .select()
        .from(alertTemplates)
        .where(
          and(
            eq(alertTemplates.id, data.templateId),
            or(
              eq(alertTemplates.isBuiltIn, true),
              eq(alertTemplates.orgId, orgId)
            )
          )
        )
        .limit(1);

      if (!template) {
        return c.json({ error: 'Template not found' }, 404);
      }

      const overrideSettings: Record<string, unknown> = {};
      if (data.severity) overrideSettings.severity = data.severity;
      if (data.conditions) overrideSettings.conditions = data.conditions;
      if (data.cooldownMinutes !== undefined) overrideSettings.cooldownMinutes = data.cooldownMinutes;

      // Determine target type and ID from targets object
      const targets = data.targets as Record<string, unknown> | undefined;
      let targetType = 'all';
      let targetId = orgId; // default to org

      if (targets) {
        if (targets.deviceIds && Array.isArray(targets.deviceIds) && targets.deviceIds.length > 0) {
          targetType = 'device';
          targetId = targets.deviceIds[0];
        } else if (targets.siteIds && Array.isArray(targets.siteIds) && targets.siteIds.length > 0) {
          targetType = 'site';
          targetId = targets.siteIds[0];
        } else if (targets.scope === 'organization') {
          targetType = 'org';
          targetId = orgId;
        }
      }

      const [rule] = await db
        .insert(alertRules)
        .values({
          orgId,
          templateId: template.id,
          name: data.name.trim(),
          targetType,
          targetId,
          overrideSettings: Object.keys(overrideSettings).length > 0 ? overrideSettings : null,
          isActive: data.enabled ?? true,
        })
        .returning();

      if (!rule) {
        return c.json({ error: 'Failed to create rule' }, 500);
      }

      writeRouteAudit(c, {
        orgId,
        action: 'alert_rule.create',
        resourceType: 'alert_rule',
        resourceId: rule.id,
        resourceName: rule.name,
        details: {
          templateId: rule.templateId,
          enabled: rule.isActive,
        },
      });
      return c.json({ data: { ...rule, templateName: template.name, enabled: rule.isActive } }, 201);
    } catch (err) {
      console.error('[alertTemplates/rules] create failed:', err);
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

      const ruleId = c.req.param('id')!;
      const [row] = await db
        .select({ rule: alertRules, templateName: alertTemplates.name })
        .from(alertRules)
        .leftJoin(alertTemplates, eq(alertRules.templateId, alertTemplates.id))
        .where(and(eq(alertRules.id, ruleId), await ruleOwnershipConditionForOrg(orgId)))
        .limit(1);

      if (!row) {
        return c.json({ error: 'Rule not found' }, 404);
      }

      return c.json({ data: { ...row.rule, templateName: row.templateName, enabled: row.rule.isActive } });
    } catch (err) {
      console.error('[alertTemplates/rules] fetch failed:', err);
      return c.json({ error: 'Failed to fetch rule' }, 500);
    }
  }
);

ruleRoutes.patch(
  '/rules/:id',
  requireScope('organization', 'partner', 'system'),
  requireAlertWrite,
  requireMfa(),
  zValidator('json', updateRuleSchema),
  async (c) => {
    try {
      const auth = c.get('auth');
      const orgId = resolveScopedOrgId(auth);
      if (!orgId) {
        return c.json({ error: 'orgId is required for this scope' }, 400);
      }

      const ruleId = c.req.param('id')!;
      const updates = c.req.valid('json');

      const [existing] = await db
        .select()
        .from(alertRules)
        .where(and(eq(alertRules.id, ruleId), await ruleOwnershipConditionForOrg(orgId)))
        .limit(1);

      if (!existing) {
        return c.json({ error: 'Rule not found' }, 404);
      }

      if (existing.orgId === null) {
        return c.json({ error: PARTNER_WIDE_RULE_READONLY_HERE }, 403);
      }

      if (Object.keys(updates).length === 0) {
        return c.json({ error: 'No updates provided' }, 400);
      }

      const setValues: Record<string, unknown> = {};
      if (updates.name !== undefined) setValues.name = updates.name.trim();
      if (updates.enabled !== undefined) setValues.isActive = updates.enabled;

      // Merge override settings
      const existingOverrides = (existing.overrideSettings as Record<string, unknown>) ?? {};
      const newOverrides = { ...existingOverrides };
      if (updates.severity !== undefined) newOverrides.severity = updates.severity;
      if (updates.conditions !== undefined) newOverrides.conditions = updates.conditions;
      if (updates.cooldownMinutes !== undefined) newOverrides.cooldownMinutes = updates.cooldownMinutes;
      setValues.overrideSettings = newOverrides;

      const [updated] = await db
        .update(alertRules)
        .set(setValues)
        .where(eq(alertRules.id, ruleId))
        .returning();

      writeRouteAudit(c, {
        orgId,
        action: 'alert_rule.update',
        resourceType: 'alert_rule',
        resourceId: ruleId,
        resourceName: updated?.name ?? existing.name,
        details: { updatedFields: Object.keys(updates) },
      });
      return c.json({ data: { ...updated, enabled: updated?.isActive } });
    } catch (err) {
      console.error('[alertTemplates/rules] update failed:', err);
      return c.json({ error: 'Failed to update rule' }, 500);
    }
  }
);

ruleRoutes.delete(
  '/rules/:id',
  requireScope('organization', 'partner', 'system'),
  requireAlertWrite,
  requireMfa(),
  async (c) => {
    try {
      const auth = c.get('auth');
      const orgId = resolveScopedOrgId(auth);
      if (!orgId) {
        return c.json({ error: 'orgId is required for this scope' }, 400);
      }

      const ruleId = c.req.param('id')!;
      const [existing] = await db
        .select()
        .from(alertRules)
        .where(and(eq(alertRules.id, ruleId), await ruleOwnershipConditionForOrg(orgId)))
        .limit(1);

      if (!existing) {
        return c.json({ error: 'Rule not found' }, 404);
      }

      if (existing.orgId === null) {
        return c.json({ error: PARTNER_WIDE_RULE_READONLY_HERE }, 403);
      }

      await db.delete(alertRules).where(eq(alertRules.id, ruleId));

      writeRouteAudit(c, {
        orgId,
        action: 'alert_rule.delete',
        resourceType: 'alert_rule',
        resourceId: existing.id,
        resourceName: existing.name,
      });
      return c.json({ data: { id: ruleId, deleted: true } });
    } catch (err) {
      console.error('[alertTemplates/rules] delete failed:', err);
      return c.json({ error: 'Failed to delete rule' }, 500);
    }
  }
);

ruleRoutes.post(
  '/rules/:id/toggle',
  requireScope('organization', 'partner', 'system'),
  requireAlertWrite,
  requireMfa(),
  zValidator('json', toggleRuleSchema),
  async (c) => {
    try {
      const auth = c.get('auth');
      const orgId = resolveScopedOrgId(auth);
      if (!orgId) {
        return c.json({ error: 'orgId is required for this scope' }, 400);
      }

      const ruleId = c.req.param('id')!;
      const { enabled } = c.req.valid('json');

      const [existing] = await db
        .select()
        .from(alertRules)
        .where(and(eq(alertRules.id, ruleId), await ruleOwnershipConditionForOrg(orgId)))
        .limit(1);

      if (!existing) {
        return c.json({ error: 'Rule not found' }, 404);
      }

      if (existing.orgId === null) {
        return c.json({ error: PARTNER_WIDE_RULE_READONLY_HERE }, 403);
      }

      const [updated] = await db
        .update(alertRules)
        .set({ isActive: enabled })
        .where(eq(alertRules.id, ruleId))
        .returning();

      writeRouteAudit(c, {
        orgId,
        action: 'alert_rule.toggle',
        resourceType: 'alert_rule',
        resourceId: ruleId,
        resourceName: updated?.name ?? existing.name,
        details: { enabled },
      });
      return c.json({ data: { ...updated, enabled: updated?.isActive } });
    } catch (err) {
      console.error('[alertTemplates/rules] toggle failed:', err);
      return c.json({ error: 'Failed to toggle rule' }, 500);
    }
  }
);
