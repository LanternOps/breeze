import { Hono } from 'hono';
import { zValidator } from '../../lib/validation';
import { and, eq, sql, desc, inArray, isNull, or, type SQL } from 'drizzle-orm';
import { db } from '../../db';
import { alertRules, alertTemplates, alerts, devices, deviceGroups, organizations, sites } from '../../db/schema';
import { canManagePartnerWidePolicies, PARTNER_WIDE_WRITE_DENIED_MESSAGE } from '../../services/partnerWideAccess';
import { requireMfa, requirePermission, requireScope, siteAccessCheck } from '../../middleware/auth';
import { writeRouteAudit } from '../../services/auditEvents';
import { PERMISSIONS } from '../../services/permissions';
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
        .orderBy(desc(alertRules.createdAt));

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

// POST /alerts/rules - Create alert rule
// DEPRECATED: Alert rules are now managed via Configuration Policies. These routes remain for legacy compatibility.
rulesRoutes.post(
  '/rules',
  requireScope('organization', 'partner', 'system'),
  requireAlertWrite,
  requireMfa(),
  zValidator('json', createAlertRuleSchema),
  async (c) => {
    const auth = c.get('auth');
    const data = c.req.valid('json');

    // Ownership axis (#2128). Partner-wide rules evaluate against devices in
    // ALL orgs under the partner (including orgs created later), so creation
    // is gated on the partner-wide capability — same gate as software/security
    // policies. The partner is ALWAYS derived from the caller's own token.
    const isPartnerWide = data.ownerScope === 'partner';
    let owner: { orgId: string | null; partnerId: string | null };
    if (isPartnerWide) {
      if (!auth.partnerId) {
        return c.json({ error: 'Partner-wide alert rules require partner scope' }, 403);
      }
      if (!canManagePartnerWidePolicies(auth)) {
        return c.json({ error: 'Partner-wide alert rules require full partner org access (orgAccess must be "all")' }, 403);
      }
      // Partner-wide rules always target 'all' (every device under the
      // partner); org/site/group/device targets have no meaning without an
      // owning org. targetId carries the partner id to satisfy NOT NULL — the
      // 'all' match ignores it.
      const requestedTargetType = data.targets?.type ?? data.targetType;
      if (requestedTargetType && requestedTargetType !== 'all') {
        return c.json({ error: 'Partner-wide alert rules only support the "all" target — scope narrower rules to an organization instead' }, 400);
      }
      owner = { orgId: null, partnerId: auth.partnerId };
    } else {
      const orgId = data.orgId ?? auth.orgId;
      if (!orgId) {
        return c.json({ error: 'Organization context required' }, 403);
      }
      if (!auth.canAccessOrg(orgId)) {
        return c.json({ error: 'Access to this organization denied' }, 403);
      }
      owner = { orgId, partnerId: null };
    }

    const { targetType, targetId, targetIds, targets } = isPartnerWide
      ? { targetType: 'all', targetId: owner.partnerId!, targetIds: [], targets: { type: 'all', ids: [] } }
      : normalizeTargetsForRule(
          {
            targets: data.targets,
            targetType: data.targetType,
            targetId: data.targetId
          },
          owner.orgId!
        );

    if (!targetId) {
      return c.json({ error: 'Target is required' }, 400);
    }
    if (!isPartnerWide && !await canAccessRuleTargets(auth, owner.orgId!, targetType, targetIds, true)) {
      return c.json({ error: 'Access to one or more alert rule targets denied' }, 403);
    }

    // Notification channels and escalation policies are org-scoped (#2130);
    // a partner-wide rule cannot bind them. Dispatch falls back to each firing
    // device's OWN org routing (the alert always carries the device's org).
    if (isPartnerWide) {
      const requestedChannels = data.notificationChannelIds ?? data.notificationChannels;
      if ((Array.isArray(requestedChannels) && requestedChannels.length > 0) || data.escalationPolicyId) {
        return c.json({ error: 'Partner-wide alert rules cannot bind org-scoped notification channels or escalation policies; each organization\'s default routing is used instead' }, 400);
      }
    }

    const { template, created } = await resolveAlertTemplate({
      templateId: data.templateId,
      orgId: owner.orgId,
      partnerId: owner.partnerId,
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

    if (!created) {
      // Org rules may use built-in, partner-shared, or same-org templates
      // (unchanged). Partner-wide rules may use built-in or OWN-partner
      // templates — never another tenant's org template.
      const templateDenied = isPartnerWide
        ? Boolean(template.orgId) || (template.partnerId ? template.partnerId !== owner.partnerId : !template.isBuiltIn)
        : Boolean(template.orgId && template.orgId !== owner.orgId);
      if (templateDenied) {
        return c.json({ error: 'Access to this alert template denied' }, 403);
      }
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

    if (!isPartnerWide) {
      const createNotificationBindingError = await validateAlertRuleNotificationBindings(
        owner.orgId!,
        getOverrides(baseOverrides)
      );
      if (createNotificationBindingError) {
        return c.json({ error: createNotificationBindingError }, 400);
      }
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
        orgId: owner.orgId,
        partnerId: owner.partnerId,
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
      orgId: owner.orgId,
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
  requireAlertWrite,
  requireMfa(),
  zValidator('json', updateAlertRuleSchema),
  async (c) => {
    const auth = c.get('auth');
    const ruleId = c.req.param('id')!;
    const data = c.req.valid('json');

    if (Object.keys(data).length === 0) {
      return c.json({ error: 'No updates provided' }, 400);
    }

    const rule = await getAlertRuleWithOrgCheck(ruleId, auth);
    if (!rule) {
      return c.json({ error: 'Alert rule not found' }, 404);
    }

    // Partner-wide rules are READABLE by any member of the partner but
    // administrable only with the partner-wide capability — editing them
    // changes alerting across every org under the partner (#2128).
    const isPartnerWide = rule.orgId === null;
    if (isPartnerWide && !canManagePartnerWidePolicies(auth)) {
      return c.json({ error: PARTNER_WIDE_WRITE_DENIED_MESSAGE }, 403);
    }

    if (!isPartnerWide) {
      const persistedTargets = persistedRuleTargets(rule);
      if (!await canAccessRuleTargets(auth, rule.orgId!, persistedTargets.targetType, persistedTargets.targetIds, true)) {
        return c.json({ error: 'Access to one or more alert rule targets denied' }, 403);
      }
    }

    const requestedTargets = data.targets || data.targetType || data.targetId
      ? normalizeTargetsForRule({ targets: data.targets, targetType: data.targetType, targetId: data.targetId }, rule.orgId!)
      : null;
    if (requestedTargets && !isPartnerWide && !await canAccessRuleTargets(
      auth, rule.orgId!, requestedTargets.targetType, requestedTargets.targetIds, true,
    )) {
      return c.json({ error: 'Access to one or more alert rule targets denied' }, 403);
    }

    const updates: Record<string, unknown> = {};
    let templateOwned = getOverrides(rule.overrideSettings).templateOwned;

    if (data.templateId !== undefined) {
      const resolved = await resolveAlertTemplate({
        templateId: data.templateId,
        orgId: rule.orgId,
        partnerId: rule.partnerId,
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

      const templateDenied = isPartnerWide
        ? !resolved.created && (Boolean(resolvedTemplate.orgId)
            || (resolvedTemplate.partnerId ? resolvedTemplate.partnerId !== rule.partnerId : !resolvedTemplate.isBuiltIn))
        : !resolved.created && Boolean(resolvedTemplate.orgId && resolvedTemplate.orgId !== rule.orgId);
      if (templateDenied) {
        return c.json({ error: 'Access to this alert template denied' }, 403);
      }

      updates.templateId = resolvedTemplate.id;
      templateOwned = resolved.created;
    }

    if (data.name !== undefined) updates.name = data.name;

    if (data.targets || data.targetType || data.targetId) {
      if (isPartnerWide) {
        const requestedTargetType = data.targets?.type ?? data.targetType;
        if (requestedTargetType && requestedTargetType !== 'all') {
          return c.json({ error: 'Partner-wide alert rules only support the "all" target — scope narrower rules to an organization instead' }, 400);
        }
      }
      const resolvedTargets = isPartnerWide
        ? { targetType: 'all', targetId: rule.partnerId!, targetIds: [], targets: { type: 'all', ids: [] } }
        : requestedTargets!;

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
      if (isPartnerWide) {
        // Channels/escalation are org-scoped (#2130); partner-wide rules use
        // each firing device's own org routing instead.
        return c.json({ error: 'Partner-wide alert rules cannot bind org-scoped notification channels or escalation policies; each organization\'s default routing is used instead' }, 400);
      }
      const updateNotificationBindingError = await validateAlertRuleNotificationBindings(
        rule.orgId!,
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
  requireAlertWrite,
  requireMfa(),
  async (c) => {
    const auth = c.get('auth');
    const ruleId = c.req.param('id')!;

    const rule = await getAlertRuleWithOrgCheck(ruleId, auth);
    if (!rule) {
      return c.json({ error: 'Alert rule not found' }, 404);
    }

    // Same partner-wide administration gate as PUT (#2128).
    if (rule.orgId === null && !canManagePartnerWidePolicies(auth)) {
      return c.json({ error: PARTNER_WIDE_WRITE_DENIED_MESSAGE }, 403);
    }

    if (rule.orgId !== null) {
      const { targetType, targetIds } = persistedRuleTargets(rule);
      const canAccessTargets = await canAccessRuleTargets(
        auth,
        rule.orgId,
        targetType,
        targetIds,
        true
      );
      if (!canAccessTargets) {
        return c.json({ error: 'Alert rule targets are outside your permitted sites' }, 403);
      }
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
  requireAlertRead,
  zValidator('json', testAlertRuleSchema),
  async (c) => {
    const auth = c.get('auth');
    const ruleId = c.req.param('id')!;
    const data = c.req.valid('json');

    const rule = await getAlertRuleWithOrgCheck(ruleId, auth);
    if (!rule) {
      return c.json({ error: 'Alert rule not found' }, 404);
    }

    if (rule.orgId !== null) {
      const { targetType, targetIds } = persistedRuleTargets(rule);
      const canAccessTargets = await canAccessRuleTargets(
        auth,
        rule.orgId,
        targetType,
        targetIds,
        false
      );
      if (!canAccessTargets) {
        return c.json({ error: 'Alert rule not found' }, 404);
      }
    }

    // Verify device exists and is governed by this rule: same org for
    // org-owned rules; any org under the rule's partner for partner-wide
    // rules (#2128).
    const deviceScope = rule.orgId !== null
      ? [eq(devices.orgId, rule.orgId)]
      : [sql`${devices.orgId} IN (SELECT id FROM ${organizations} WHERE ${organizations.partnerId} = ${rule.partnerId})`];
    const [device] = await db
      .select()
      .from(devices)
      .where(and(eq(devices.id, data.deviceId), ...deviceScope))
      .limit(1);

    if (!device) {
      return c.json({ error: 'Device not found or belongs to different organization' }, 404);
    }

    if (!siteAccessCheck(auth.allowedSiteIds)(device.siteId)) {
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
