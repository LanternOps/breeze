import { legacyAlertingGone } from '../legacyAlertingGone';
import { Hono } from 'hono';
import { zValidator } from '../../lib/validation';
import { and, eq, sql, desc, inArray, isNull, or, type SQL } from 'drizzle-orm';
import { db } from '../../db';
import { alertRules, alertTemplates, devices, deviceGroups, organizations, sites } from '../../db/schema';
import { requireMfa, requirePermission, requireScope, siteAccessCheck } from '../../middleware/auth';
import { PERMISSIONS } from '../../services/permissions';
import { notSystemManagedRule, systemManagedRule } from '../../services/monitors/systemManagedRules';
import { writeRouteAudit } from '../../services/auditEvents';
import { LEGACY_ALERTING_GONE } from '../legacyAlertingGone';
import {
  listAlertRulesSchema,
  setBuiltInRuleActiveSchema,
} from './schemas';
import {
  getPagination,
  ensureOrgAccess,
  getAlertRuleWithOrgCheck,
  isRecord,
  getOverrides,
  formatAlertRuleResponse,
} from './helpers';

export const rulesRoutes = new Hono();

const requireAlertRead = requirePermission(PERMISSIONS.ALERTS_READ.resource, PERMISSIONS.ALERTS_READ.action);
const requireAlertWrite = requirePermission(PERMISSIONS.ALERTS_WRITE.resource, PERMISSIONS.ALERTS_WRITE.action);

type RuleTargetAuth = {
  allowedSiteIds?: string[];
};

type RuleTargetRow = { id: string; orgId: string; siteId?: string | null };

function persistedRuleTargets(rule: {
  targetType: string;
  targetId: string;
  overrideSettings?: unknown;
}) {
  const overrides = getOverrides(rule.overrideSettings);
  const storedTargets = isRecord(overrides.targets) ? overrides.targets : {};
  const targetType = typeof storedTargets.type === 'string' ? storedTargets.type : rule.targetType;
  const ids = new Set<string>();
  if (targetType !== 'all' && targetType !== 'org' && rule.targetId) ids.add(rule.targetId);
  if (Array.isArray(storedTargets.ids)) {
    for (const id of storedTargets.ids) if (typeof id === 'string' && id) ids.add(id);
  }
  if (Array.isArray(overrides.targetIds)) {
    for (const id of overrides.targetIds) if (typeof id === 'string' && id) ids.add(id);
  }
  return { targetType, targetIds: [...ids] };
}

async function canAccessRuleTargets(
  auth: RuleTargetAuth,
  orgId: string,
  targetType: string,
  targetIds: string[],
  validateOwnership: boolean,
): Promise<boolean> {
  const restricted = auth.allowedSiteIds !== undefined;
  if (!restricted && !validateOwnership) return true;
  if (targetType === 'all' || targetType === 'org') return !restricted;

  const ids = [...new Set(targetIds.filter(Boolean))];
  if (ids.length === 0) return false;

  let rows: RuleTargetRow[];
  if (targetType === 'site') {
    rows = await db.select({ id: sites.id, orgId: sites.orgId })
      .from(sites)
      .where(and(inArray(sites.id, ids), eq(sites.orgId, orgId)));
  } else if (targetType === 'device') {
    rows = await db.select({ id: devices.id, orgId: devices.orgId, siteId: devices.siteId })
      .from(devices)
      .where(and(inArray(devices.id, ids), eq(devices.orgId, orgId)));
  } else if (targetType === 'group') {
    rows = await db.select({ id: deviceGroups.id, orgId: deviceGroups.orgId, siteId: deviceGroups.siteId })
      .from(deviceGroups)
      .where(and(inArray(deviceGroups.id, ids), eq(deviceGroups.orgId, orgId)));
  } else {
    return false;
  }

  if (rows.length !== ids.length || rows.some((row) => row.orgId !== orgId)) return false;
  if (!restricted) return true;
  const canAccessSite = siteAccessCheck(auth.allowedSiteIds);
  return rows.every((row) => canAccessSite(targetType === 'site' ? row.id : row.siteId));
}

// GET /alerts/rules - List alert rules with pagination
rulesRoutes.get(
  '/rules',
  requireScope('organization', 'partner', 'system'),
  requireAlertRead,
  zValidator('query', listAlertRulesSchema),
  async (c) => {
    const auth = c.get('auth');
    const query = c.req.valid('query');
    const { page, limit, offset } = getPagination(query);

    // Build conditions array
    const conditions: SQL[] = [];

    // Filter by org access based on scope. Partner callers also see their
    // partner-wide rules (org_id NULL, #2128) — including in org-filtered
    // views, since those rules govern that org's devices too. For system
    // callers the NULL branch is scoped to the QUERIED org's own partner
    // (mirrors listConfigPolicies) so it never returns unrelated partners'
    // rules platform-wide.
    if (auth.scope === 'organization') {
      if (!auth.orgId) {
        return c.json({ error: 'Organization context required' }, 403);
      }
      conditions.push(eq(alertRules.orgId, auth.orgId));
    } else if (auth.scope === 'partner') {
      const partnerWideMine = auth.partnerId
        ? and(isNull(alertRules.orgId), eq(alertRules.partnerId, auth.partnerId))
        : undefined;
      if (query.orgId) {
        const hasAccess = ensureOrgAccess(query.orgId, auth);
        if (!hasAccess) {
          return c.json({ error: 'Access to this organization denied' }, 403);
        }
        conditions.push(
          partnerWideMine
            ? (or(eq(alertRules.orgId, query.orgId), partnerWideMine) as SQL)
            : eq(alertRules.orgId, query.orgId)
        );
      } else {
        const orgIds = auth.accessibleOrgIds ?? [];
        if (orgIds.length === 0 && !partnerWideMine) {
          return c.json({
            data: [],
            pagination: { page, limit, total: 0 }
          });
        }
        const orgOwned = orgIds.length > 0 ? inArray(alertRules.orgId, orgIds) : undefined;
        if (orgOwned && partnerWideMine) {
          conditions.push(or(orgOwned, partnerWideMine) as SQL);
        } else if (orgOwned) {
          conditions.push(orgOwned);
        } else if (partnerWideMine) {
          conditions.push(partnerWideMine as SQL);
        }
      }
    } else if (auth.scope === 'system' && query.orgId) {
      const [orgRow] = await db
        .select({ partnerId: organizations.partnerId })
        .from(organizations)
        .where(eq(organizations.id, query.orgId))
        .limit(1);
      const orgPartnerId = orgRow?.partnerId ?? null;
      conditions.push(
        orgPartnerId
          ? (or(
              eq(alertRules.orgId, query.orgId),
              and(isNull(alertRules.orgId), eq(alertRules.partnerId, orgPartnerId))
            ) as SQL)
          : eq(alertRules.orgId, query.orgId)
      );
    }

    // Additional filters
    const enabledFilter = query.enabled ?? query.isActive;
    if (enabledFilter !== undefined) {
      conditions.push(eq(alertRules.isActive, enabledFilter === 'true'));
    }
    if (query.includeRetired !== 'true') conditions.push(isNull(alertRules.retiredAt));
    // #7206: in SQL, not client-side, so the page slice and `total` match the
    // rows the Needs-conversion list renders.
    if (query.needsConversion === 'true') {
      conditions.push(isNull(alertRules.managedByMonitorId), notSystemManagedRule());
    }
    if (query.systemManaged === 'true') {
      conditions.push(isNull(alertRules.managedByMonitorId), systemManagedRule());
    }

    const whereCondition = conditions.length > 0 ? and(...conditions) : undefined;

    // Site authorization depends on the persisted target records, so it
    // cannot be expressed by the alert_rules predicates alone. Filter the
    // complete tenant-scoped candidate set before slicing the requested page;
    // otherwise denied rows consume page slots and make later allowed rules
    // undiscoverable while also producing an incorrect total.
    if (auth.allowedSiteIds !== undefined) {
      const candidateRules = await db
        .select({
          rule: alertRules,
          template: alertTemplates
        })
        .from(alertRules)
        .leftJoin(alertTemplates, eq(alertRules.templateId, alertTemplates.id))
        .where(whereCondition)
        .orderBy(desc(alertRules.createdAt), desc(alertRules.id));

      const accessibleRules = [];
      for (const row of candidateRules) {
        const targets = persistedRuleTargets(row.rule);
        if (await canAccessRuleTargets(auth, row.rule.orgId!, targets.targetType, targets.targetIds, false)) {
          accessibleRules.push(row);
        }
      }

      return c.json({
        data: accessibleRules
          .slice(offset, offset + limit)
          .map(({ rule, template }) => formatAlertRuleResponse(rule, template)),
        pagination: { page, limit, total: accessibleRules.length }
      });
    }

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
      .orderBy(desc(alertRules.createdAt), desc(alertRules.id))
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
  requireAlertRead,
  async (c) => {
    const auth = c.get('auth');
    const ruleId = c.req.param('id')!;

    const rule = await getAlertRuleWithOrgCheck(ruleId, auth);
    if (!rule) {
      return c.json({ error: 'Alert rule not found' }, 404);
    }
    if (rule.orgId !== null) {
      const targets = persistedRuleTargets(rule);
      if (!await canAccessRuleTargets(auth, rule.orgId, targets.targetType, targets.targetIds, false)) {
        return c.json({ error: 'Alert rule not found' }, 404);
      }
    }

    const [template] = await db
      .select()
      .from(alertTemplates)
      .where(eq(alertTemplates.id, rule.templateId))
      .limit(1);

    return c.json(formatAlertRuleResponse(rule, template ?? null));
  }
);

rulesRoutes.post(
  '/rules',
  requireScope('organization', 'partner', 'system'),
  requireAlertWrite,
  requireMfa(),
  legacyAlertingGone
);

rulesRoutes.put(
  '/rules/:id',
  requireScope('organization', 'partner', 'system'),
  requireAlertWrite,
  requireMfa(),
  legacyAlertingGone
);

// PATCH /alerts/rules/:id/active - Switch a built-in system anchor rule on/off (#7626)
//
// The consolidation retired every legacy rule write (410 below), but built-in
// anchor rules (patch job failures, reboot pending, policy violations —
// services/monitors/systemManagedRules.ts) are never converted to monitors and
// Breeze raises their alerts itself, so this on/off switch is the only control
// an operator has over them. `createAlert` honours `is_active` for every
// producer, and the producers' ensure-rule lookups return an inactive row
// rather than re-creating it, so "off" stays off.
rulesRoutes.patch(
  '/rules/:id/active',
  requireScope('organization', 'partner', 'system'),
  requireAlertWrite,
  requireMfa(),
  zValidator('json', setBuiltInRuleActiveSchema),
  async (c) => {
    const auth = c.get('auth');
    const ruleId = c.req.param('id')!;
    const { isActive } = c.req.valid('json');

    const rule = await getAlertRuleWithOrgCheck(ruleId, auth);
    if (!rule) {
      return c.json({ error: 'Alert rule not found' }, 404);
    }
    // Built-in anchor rules are always org-owned. A partner-wide rule is an
    // ordinary legacy rule, and its writes stay retired.
    const orgId = rule.orgId;
    if (orgId === null) {
      return c.json(LEGACY_ALERTING_GONE, 410);
    }
    // Same visibility as GET /alerts/rules/:id: a site-restricted caller does
    // not see (and so cannot switch) an org-wide rule.
    const targets = persistedRuleTargets(rule);
    if (!await canAccessRuleTargets(auth, orgId, targets.targetType, targets.targetIds, false)) {
      return c.json({ error: 'Alert rule not found' }, 404);
    }

    const [template] = await db
      .select()
      .from(alertTemplates)
      .where(eq(alertTemplates.id, rule.templateId))
      .limit(1);
    if (template?.isBuiltIn !== true || rule.managedByMonitorId !== null || rule.retiredAt !== null) {
      return c.json(LEGACY_ALERTING_GONE, 410);
    }

    // `org_id = <rule org>` can never match a partner-wide (org_id NULL) row.
    const [updated] = await db
      .update(alertRules)
      .set({ isActive })
      .where(and(eq(alertRules.id, rule.id), eq(alertRules.orgId, orgId)))
      .returning();
    if (!updated) {
      return c.json({ error: 'Alert rule not found' }, 404);
    }

    writeRouteAudit(c, {
      orgId,
      action: 'alert_rule.update',
      resourceType: 'alert_rule',
      resourceId: updated.id,
      resourceName: updated.name,
      details: {
        isActive,
        previousIsActive: rule.isActive,
        systemManaged: true,
      },
    });

    return c.json(formatAlertRuleResponse(updated, template));
  }
);

rulesRoutes.delete(
  '/rules/:id',
  requireScope('organization', 'partner', 'system'),
  requireAlertWrite,
  requireMfa(),
  legacyAlertingGone
);

rulesRoutes.post(
  '/rules/:id/test',
  requireScope('organization', 'partner', 'system'),
  requireAlertRead,
  legacyAlertingGone
);
