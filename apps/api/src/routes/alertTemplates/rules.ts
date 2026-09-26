import { legacyAlertingGone } from '../legacyAlertingGone';
import { Hono } from 'hono';
import { zValidator } from '../../lib/validation';
import { db } from '../../db';
import { alertRules, alertTemplates, organizations } from '../../db/schema';
import { eq, and, like, or, desc, isNull, type SQL } from 'drizzle-orm';
import { requireMfa, requirePermission, requireScope } from '../../middleware/auth';
import { listRulesSchema } from './schemas';
import { resolveScopedOrgId, parseBoolean } from './helpers';
import { getPagination } from '../../utils/pagination';
import { PERMISSIONS } from '../../services/permissions';
import {
  canAccessAlertRuleTargets,
  persistedRuleTargets,
} from './siteScope';

export const ruleRoutes = new Hono();

const requireAlertRead = requirePermission(PERMISSIONS.ALERTS_READ.resource, PERMISSIONS.ALERTS_READ.action);
const requireAlertWrite = requirePermission(PERMISSIONS.ALERTS_WRITE.resource, PERMISSIONS.ALERTS_WRITE.action);

// Dual-axis rule condition for this legacy org-pinned route (#2128): the org's
// own rules PLUS the partner-wide rules (org_id NULL) of the org's partner —
// those govern this org's devices too, so hiding them here would misrepresent
// what alerting applies. Partner-wide rules are read-only on this route; they
// are retained for alert history.
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

ruleRoutes.get(
  '/rules',
  requireScope('organization', 'partner', 'system'),
  requireAlertRead,
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
  legacyAlertingGone
);

ruleRoutes.get(
  '/rules/:id',
  requireScope('organization', 'partner', 'system'),
  requireAlertRead,
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
  legacyAlertingGone
);

ruleRoutes.delete(
  '/rules/:id',
  requireScope('organization', 'partner', 'system'),
  requireAlertWrite,
  requireMfa(),
  legacyAlertingGone
);

ruleRoutes.post(
  '/rules/:id/toggle',
  requireScope('organization', 'partner', 'system'),
  requireAlertWrite,
  requireMfa(),
  legacyAlertingGone
);
