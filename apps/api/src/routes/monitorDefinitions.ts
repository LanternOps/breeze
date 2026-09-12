import { Hono } from 'hono';
import { z } from 'zod';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { zValidator } from '../lib/validation';
import { db } from '../db';
import {
  alertRules,
  alertTemplates,
  configPolicyAssignments,
  configPolicyFeatureLinks,
  configurationPolicies,
  devices,
  deviceGroupMemberships,
  configPolicyMonitors,
} from '../db/schema';
import { requireMfa, requirePermission, requireScope } from '../middleware/auth';
import { canManagePartnerWidePolicies, PARTNER_WIDE_WRITE_DENIED_MESSAGE } from '../services/partnerWideAccess';
import { convertAlertConditionToMonitor } from '../services/monitors/monitorConversion';
import { PERMISSIONS } from '../services/permissions';
import { writeRouteAudit } from '../services/auditEvents';
import { evaluateConditions } from '../services/alertConditions';
import {
  createMonitorDefinition,
  deleteMonitorDefinition,
  getMonitorDefinition,
  listMonitorDefinitions,
  MonitorNotFoundError,
  MonitorOwnershipError,
  MonitorValidationError,
  updateMonitorDefinition,
} from '../services/monitors/monitorService';
import { buildCompiledCondition } from '../services/monitors/monitorCompiler';
import { MONITOR_KIND_SPECS } from '../services/monitors/kinds';
import { resolveMonitorsForDevice } from '../services/monitors/monitorResolver';
import {
  addFeatureLink,
  assignPolicy,
  createConfigPolicy,
  getConfigPolicy,
  removeFeatureLink,
  updateFeatureLink,
} from '../services/configurationPolicy';
import {
  createMonitorDefinitionSchema,
  updateMonitorDefinitionSchema,
  monitorKindSchema,
} from '@breeze/shared';

/**
 * /monitor-definitions (#5287 W02).
 *
 * A monitor definition is authored here and COMPILED into the alert template /
 * alert rule / automation rows the sweep already executes; those rows are not
 * addressable through this API on purpose. Deployment is through configuration
 * policies, so every attachment route below goes through the policy service
 * rather than writing config_policy_monitors directly — that keeps the
 * ownership-compatibility trigger and the feature-link lifecycle in one place.
 */
export const monitorDefinitionRoutes = new Hono();

const requireAlertRead = requirePermission(PERMISSIONS.ALERTS_READ.resource, PERMISSIONS.ALERTS_READ.action);
const requireAlertWrite = requirePermission(PERMISSIONS.ALERTS_WRITE.resource, PERMISSIONS.ALERTS_WRITE.action);

function errorResponse(error: unknown): { body: Record<string, unknown>; status: 400 | 403 | 404 } | null {
  if (error instanceof MonitorOwnershipError) return { body: { error: error.message }, status: 403 };
  if (error instanceof MonitorNotFoundError) return { body: { error: 'Monitor not found' }, status: 404 };
  if (error instanceof MonitorValidationError) {
    return { body: { error: 'INVALID_MONITOR', details: error.message }, status: 400 };
  }
  return null;
}

const listQuerySchema = z.object({
  kind: monitorKindSchema.optional(),
  enabled: z.enum(['true', 'false']).optional(),
});

// GET /monitors
monitorDefinitionRoutes.get(
  '/',
  requireScope('organization', 'partner', 'system'),
  requireAlertRead,
  zValidator('query', listQuerySchema),
  async (c) => {
    const auth = c.get('auth');
    const { kind, enabled } = c.req.valid('query');
    const rows = await listMonitorDefinitions(auth, {
      kind,
      enabled: enabled === undefined ? undefined : enabled === 'true',
    });
    if (rows.length === 0) return c.json({ data: [] });

    const counts = await db
      .select({
        monitorId: configPolicyMonitors.monitorId,
        count: sql<number>`count(*)::int`,
      })
      .from(configPolicyMonitors)
      .where(inArray(configPolicyMonitors.monitorId, rows.map((r) => r.id)))
      .groupBy(configPolicyMonitors.monitorId);
    const countByMonitor = new Map(counts.map((r) => [r.monitorId, r.count]));

    return c.json({
      data: rows.map((row) => ({ ...row, attachmentCount: countByMonitor.get(row.id) ?? 0 })),
    });
  },
);

// GET /monitors/kinds — the editor renders its condition fields from this.
// Declared BEFORE /:id so 'kinds' is never read as an id.
monitorDefinitionRoutes.get('/kinds', requireScope('organization', 'partner', 'system'), requireAlertRead, (c) =>
  c.json({
    data: Object.values(MONITOR_KIND_SPECS).map((spec) => ({
      kind: spec.kind,
      overridableKeys: spec.overridableKeys,
      defaultSeverity: spec.defaultSeverity,
      agentDelivered: spec.agentDelivered,
      titleTemplate: spec.titleTemplate,
      messageTemplate: spec.messageTemplate,
    })),
  }),
);

// POST /monitors
monitorDefinitionRoutes.post(
  '/',
  requireScope('organization', 'partner', 'system'),
  requireAlertWrite,
  requireMfa(),
  zValidator('json', createMonitorDefinitionSchema),
  async (c) => {
    const auth = c.get('auth');
    try {
      const created = await createMonitorDefinition(c.req.valid('json'), auth);
      writeRouteAudit(c, {
        orgId: created.orgId ?? undefined,
        action: 'monitor.create',
        resourceType: 'monitor_definition',
        resourceId: created.id,
        resourceName: created.name,
        details: { kind: created.kind, partnerWide: created.orgId === null },
      });
      return c.json({ data: created }, 201);
    } catch (error) {
      const mapped = errorResponse(error);
      if (mapped) return c.json(mapped.body, mapped.status);
      throw error;
    }
  },
);

// GET /monitors/:id
monitorDefinitionRoutes.get('/:id', requireScope('organization', 'partner', 'system'), requireAlertRead, async (c) => {
  const auth = c.get('auth');
  const monitor = await getMonitorDefinition(c.req.param('id')!, auth);
  if (!monitor) return c.json({ error: 'Monitor not found' }, 404);

  const attachments = await db
    .select({
      id: configPolicyMonitors.id,
      configPolicyId: configPolicyFeatureLinks.configPolicyId,
      policyName: configurationPolicies.name,
      enabled: configPolicyMonitors.enabled,
      overrides: configPolicyMonitors.overrides,
    })
    .from(configPolicyMonitors)
    .innerJoin(
      configPolicyFeatureLinks,
      eq(configPolicyFeatureLinks.id, configPolicyMonitors.featureLinkId),
    )
    .innerJoin(
      configurationPolicies,
      eq(configurationPolicies.id, configPolicyFeatureLinks.configPolicyId),
    )
    .where(eq(configPolicyMonitors.monitorId, monitor.id));

  return c.json({
    data: {
      ...monitor,
      attachments,
      compiled: {
        alertTemplateId: monitor.compiledAlertTemplateId,
        alertRuleId: monitor.compiledAlertRuleId,
        automationId: monitor.compiledAutomationId,
      },
    },
  });
});

// PATCH /monitors/:id
monitorDefinitionRoutes.patch(
  '/:id',
  requireScope('organization', 'partner', 'system'),
  requireAlertWrite,
  requireMfa(),
  zValidator('json', updateMonitorDefinitionSchema),
  async (c) => {
    const auth = c.get('auth');
    try {
      const updated = await updateMonitorDefinition(c.req.param('id')!, c.req.valid('json'), auth);
      writeRouteAudit(c, {
        orgId: updated.orgId ?? undefined,
        action: 'monitor.update',
        resourceType: 'monitor_definition',
        resourceId: updated.id,
        resourceName: updated.name,
      });
      return c.json({ data: updated });
    } catch (error) {
      const mapped = errorResponse(error);
      if (mapped) return c.json(mapped.body, mapped.status);
      throw error;
    }
  },
);

// DELETE /monitors/:id
monitorDefinitionRoutes.delete(
  '/:id',
  requireScope('organization', 'partner', 'system'),
  requireAlertWrite,
  requireMfa(),
  async (c) => {
    const auth = c.get('auth');
    const id = c.req.param('id')!;
    try {
      const existing = await getMonitorDefinition(id, auth);
      await deleteMonitorDefinition(id, auth);
      writeRouteAudit(c, {
        orgId: existing?.orgId ?? undefined,
        action: 'monitor.delete',
        resourceType: 'monitor_definition',
        resourceId: id,
        resourceName: existing?.name,
      });
      return c.body(null, 204);
    } catch (error) {
      const mapped = errorResponse(error);
      if (mapped) return c.json(mapped.body, mapped.status);
      throw error;
    }
  },
);

const attachSchema = z.union([
  z.object({
    configPolicyId: z.string().uuid(),
    enabled: z.boolean().optional(),
    overrides: z.record(z.string(), z.unknown()).nullable().optional(),
  }),
  z.object({
    createPolicyFor: z.object({
      level: z.enum(['organization', 'site', 'device_group']),
      targetId: z.string().uuid(),
      name: z.string().min(1).max(255).optional(),
    }),
    enabled: z.boolean().optional(),
    overrides: z.record(z.string(), z.unknown()).nullable().optional(),
  }),
]);

interface AttachmentItem {
  monitorId: string;
  enabled: boolean;
  overrides: Record<string, unknown> | null;
  sortOrder: number;
}

/**
 * Current attachment items for a policy, read from the NORMALIZED rows rather
 * than the link's inline settings — the child table is what the resolver and
 * the compatibility trigger see, so it is the only honest source.
 */
async function currentItems(configPolicyId: string): Promise<{ linkId: string | null; items: AttachmentItem[] }> {
  const [link] = await db
    .select({ id: configPolicyFeatureLinks.id })
    .from(configPolicyFeatureLinks)
    .where(
      and(
        eq(configPolicyFeatureLinks.configPolicyId, configPolicyId),
        eq(configPolicyFeatureLinks.featureType, 'monitors'),
      ),
    )
    .limit(1);
  if (!link) return { linkId: null, items: [] };

  const rows = await db
    .select({
      monitorId: configPolicyMonitors.monitorId,
      enabled: configPolicyMonitors.enabled,
      overrides: configPolicyMonitors.overrides,
      sortOrder: configPolicyMonitors.sortOrder,
    })
    .from(configPolicyMonitors)
    .where(eq(configPolicyMonitors.featureLinkId, link.id))
    .orderBy(configPolicyMonitors.sortOrder);

  return {
    linkId: link.id,
    items: rows.map((r) => ({
      monitorId: r.monitorId,
      enabled: r.enabled,
      overrides: (r.overrides as Record<string, unknown> | null) ?? null,
      sortOrder: r.sortOrder,
    })),
  };
}

// POST /monitors/:id/attachments
monitorDefinitionRoutes.post(
  '/:id/attachments',
  requireScope('organization', 'partner', 'system'),
  requireAlertWrite,
  requireMfa(),
  zValidator('json', attachSchema),
  async (c) => {
    const auth = c.get('auth');
    const monitor = await getMonitorDefinition(c.req.param('id')!, auth);
    if (!monitor) return c.json({ error: 'Monitor not found' }, 404);
    const body = c.req.valid('json');

    let configPolicyId: string;
    if ('configPolicyId' in body) {
      const policy = await getConfigPolicy(body.configPolicyId, auth);
      if (!policy) return c.json({ error: 'Configuration policy not found' }, 404);
      configPolicyId = body.configPolicyId;
    } else {
      // "Deploy this monitor to X" with no policy in hand: create a policy
      // owned the same way the monitor is, and assign it at the requested
      // level. A partner-wide monitor therefore never lands under an
      // org-owned policy, which the compatibility trigger would refuse anyway.
      const owner = monitor.orgId
        ? ({ orgId: monitor.orgId } as const)
        : ({ partnerId: monitor.partnerId as string } as const);
      const created = await createConfigPolicy(
        owner,
        { name: body.createPolicyFor.name ?? `Monitor: ${monitor.name}` },
        auth.user.id,
      );
      if (!created) return c.json({ error: 'Failed to create configuration policy' }, 500);
      configPolicyId = created.id;
      await assignPolicy(created.id, body.createPolicyFor.level, body.createPolicyFor.targetId, 0, auth.user.id);
    }

    const { linkId, items } = await currentItems(configPolicyId);
    if (items.some((i) => i.monitorId === monitor.id)) {
      return c.json({ error: 'Monitor already attached to this policy' }, 409);
    }
    const nextItems = [
      ...items,
      {
        monitorId: monitor.id,
        enabled: body.enabled ?? true,
        overrides: body.overrides ?? null,
        sortOrder: items.length,
      },
    ];

    try {
      if (linkId) {
        await updateFeatureLink(linkId, { inlineSettings: { items: nextItems } }, configPolicyId);
      } else {
        await addFeatureLink(configPolicyId, 'monitors', null, { items: nextItems });
      }
    } catch (error) {
      // The deferred compatibility trigger surfaces at COMMIT as 23514.
      if (typeof error === 'object' && error && (error as { code?: string }).code === '23514') {
        return c.json({ error: 'MONITOR_NOT_ATTACHABLE' }, 400);
      }
      throw error;
    }

    writeRouteAudit(c, {
      orgId: monitor.orgId ?? undefined,
      action: 'monitor.attach',
      resourceType: 'monitor_definition',
      resourceId: monitor.id,
      resourceName: monitor.name,
      details: { configPolicyId },
    });

    return c.json({ data: { configPolicyId, monitorId: monitor.id } }, 201);
  },
);

// DELETE /monitors/:id/attachments/:attachmentId
monitorDefinitionRoutes.delete(
  '/:id/attachments/:attachmentId',
  requireScope('organization', 'partner', 'system'),
  requireAlertWrite,
  requireMfa(),
  async (c) => {
    const auth = c.get('auth');
    const monitor = await getMonitorDefinition(c.req.param('id')!, auth);
    if (!monitor) return c.json({ error: 'Monitor not found' }, 404);

    const [attachment] = await db
      .select({
        id: configPolicyMonitors.id,
        featureLinkId: configPolicyMonitors.featureLinkId,
        configPolicyId: configPolicyFeatureLinks.configPolicyId,
      })
      .from(configPolicyMonitors)
      .innerJoin(
        configPolicyFeatureLinks,
        eq(configPolicyFeatureLinks.id, configPolicyMonitors.featureLinkId),
      )
      .where(
        and(
          eq(configPolicyMonitors.id, c.req.param('attachmentId')!),
          eq(configPolicyMonitors.monitorId, monitor.id),
        ),
      )
      .limit(1);
    if (!attachment) return c.json({ error: 'Attachment not found' }, 404);

    const policy = await getConfigPolicy(attachment.configPolicyId, auth);
    if (!policy) return c.json({ error: 'Configuration policy not found' }, 404);

    const { items } = await currentItems(attachment.configPolicyId);
    const nextItems = items.filter((i) => i.monitorId !== monitor.id);
    if (nextItems.length === 0) {
      // An empty monitors link would keep claiming the feature for this policy
      // (and shadow a parent policy's monitors link), so remove it outright.
      await removeFeatureLink(attachment.featureLinkId, attachment.configPolicyId);
    } else {
      await updateFeatureLink(
        attachment.featureLinkId,
        { inlineSettings: { items: nextItems } },
        attachment.configPolicyId,
      );
    }

    writeRouteAudit(c, {
      orgId: monitor.orgId ?? undefined,
      action: 'monitor.detach',
      resourceType: 'monitor_definition',
      resourceId: monitor.id,
      resourceName: monitor.name,
      details: { configPolicyId: attachment.configPolicyId },
    });

    return c.body(null, 204);
  },
);

// GET /monitors/:id/devices — which devices this monitor actually resolves to.
monitorDefinitionRoutes.get(
  '/:id/devices',
  requireScope('organization', 'partner', 'system'),
  requireAlertRead,
  async (c) => {
    const auth = c.get('auth');
    const monitor = await getMonitorDefinition(c.req.param('id')!, auth);
    if (!monitor) return c.json({ error: 'Monitor not found' }, 404);

    // Candidates come from the assignments of the policies that attach this
    // monitor (plus any policy whose PARENT attaches it), then each candidate
    // is confirmed through the resolver so per-device overrides and a closer
    // `enabled: false` are reported exactly as the sweep will see them.
    const attachingPolicies = await db
      .select({ configPolicyId: configPolicyFeatureLinks.configPolicyId })
      .from(configPolicyMonitors)
      .innerJoin(
        configPolicyFeatureLinks,
        eq(configPolicyFeatureLinks.id, configPolicyMonitors.featureLinkId),
      )
      .where(eq(configPolicyMonitors.monitorId, monitor.id));
    if (attachingPolicies.length === 0) return c.json({ data: [] });

    const policyIds = [...new Set(attachingPolicies.map((p) => p.configPolicyId))];
    const children = await db
      .select({ id: configurationPolicies.id })
      .from(configurationPolicies)
      .where(inArray(configurationPolicies.parentPolicyId, policyIds));
    const allPolicyIds = [...new Set([...policyIds, ...children.map((ch) => ch.id)])];

    const assignments = await db
      .select({ level: configPolicyAssignments.level, targetId: configPolicyAssignments.targetId })
      .from(configPolicyAssignments)
      .where(inArray(configPolicyAssignments.configPolicyId, allPolicyIds));
    if (assignments.length === 0) return c.json({ data: [] });

    const byLevel = (level: string) =>
      assignments.filter((a) => a.level === level).map((a) => a.targetId);
    const orgTargets = [...byLevel('organization')];
    const siteTargets = [...byLevel('site')];
    const groupTargets = [...byLevel('device_group')];
    const deviceTargets = [...byLevel('device')];
    const partnerTargets = [...byLevel('partner')];

    const deviceConditions = [];
    if (orgTargets.length) deviceConditions.push(inArray(devices.orgId, orgTargets));
    if (siteTargets.length) deviceConditions.push(inArray(devices.siteId, siteTargets));
    if (deviceTargets.length) deviceConditions.push(inArray(devices.id, deviceTargets));
    if (groupTargets.length) {
      deviceConditions.push(
        sql`${devices.id} IN (SELECT ${deviceGroupMemberships.deviceId} FROM ${deviceGroupMemberships} WHERE ${inArray(deviceGroupMemberships.groupId, groupTargets)})`,
      );
    }
    if (partnerTargets.length) {
      // Partner-level assignment: every device in every org under that partner.
      deviceConditions.push(
        sql`${devices.orgId} IN (SELECT id FROM organizations WHERE partner_id IN (${sql.join(
          partnerTargets.map((id) => sql`${id}::uuid`),
          sql`, `,
        )}))`,
      );
    }
    if (deviceConditions.length === 0) return c.json({ data: [] });

    const orgCondition = auth.orgCondition(devices.orgId);
    const candidates = await db
      .select({ id: devices.id, hostname: devices.hostname, displayName: devices.displayName })
      .from(devices)
      .where(
        orgCondition
          ? and(orgCondition, sql`(${sql.join(deviceConditions, sql` OR `)})`)
          : sql`(${sql.join(deviceConditions, sql` OR `)})`,
      )
      .limit(1000);

    const data: Array<Record<string, unknown>> = [];
    for (const device of candidates) {
      const effective = await resolveMonitorsForDevice(device.id);
      const match = effective.find((m) => m.monitorId === monitor.id);
      if (!match) continue;
      data.push({
        deviceId: device.id,
        deviceName: device.displayName || device.hostname,
        enabled: match.enabled,
        overrides: match.overrides,
        sourcePolicyId: match.sourcePolicyId,
        sourceLevel: match.sourceLevel,
      });
    }

    return c.json({ data });
  },
);

// POST /monitors/:id/test — evaluate the compiled condition against one device.
monitorDefinitionRoutes.post(
  '/:id/test',
  requireScope('organization', 'partner', 'system'),
  requireAlertRead,
  zValidator('json', z.object({ deviceId: z.string().uuid() })),
  async (c) => {
    const auth = c.get('auth');
    const monitor = await getMonitorDefinition(c.req.param('id')!, auth);
    if (!monitor) return c.json({ error: 'Monitor not found' }, 404);

    const { deviceId } = c.req.valid('json');
    const deviceConditions = [eq(devices.id, deviceId)];
    const orgCondition = auth.orgCondition(devices.orgId);
    if (orgCondition) deviceConditions.push(orgCondition);
    const [device] = await db
      .select({ id: devices.id })
      .from(devices)
      .where(and(...deviceConditions))
      .limit(1);
    if (!device) return c.json({ error: 'Device not found' }, 404);

    try {
      const result = await evaluateConditions(buildCompiledCondition(monitor), deviceId);
      return c.json({ data: result });
    } catch (error) {
      const mapped = errorResponse(error);
      if (mapped) return c.json(mapped.body, mapped.status);
      throw error;
    }
  },
);

// POST /monitor-definitions/convert-from-rule/:ruleId (#5289)
//
// The one-way door off the legacy standalone alert rules (that router is
// deprecated). It lives HERE rather than on /alerts/rules/:id — the plan's
// original path — because importing the configuration-policy service into
// routes/alerts/rules.ts pulls a far larger module graph into that file and
// broke seven existing suites' `db/schema` mocks. Conversion is a
// monitor-creation operation, so this is also the more honest home.
//
// All-or-nothing in one transaction: a half-converted rule (monitor created,
// old rule still active) would double-alert on every device it targets.
monitorDefinitionRoutes.post(
  '/convert-from-rule/:ruleId',
  requireScope('organization', 'partner', 'system'),
  requireAlertWrite,
  requireMfa(),
  async (c) => {
    const auth = c.get('auth');
    const ruleId = c.req.param('ruleId')!;

    const [rule] = await db.select().from(alertRules).where(eq(alertRules.id, ruleId)).limit(1);
    if (!rule) return c.json({ error: 'Alert rule not found' }, 404);

    // Dual-axis access, mirroring getAlertRuleWithOrgCheck: an org-owned rule
    // via org access; a partner-wide rule only for system scope or the owning
    // partner's own PARTNER-scoped token (an org token carries a partnerId too,
    // so matching on that alone would hand every partner-wide rule to every org
    // user under that partner — #4952).
    const canSee = rule.orgId
      ? auth.canAccessOrg(rule.orgId)
      : auth.scope === 'system' || (auth.scope === 'partner' && auth.partnerId === rule.partnerId);
    if (!canSee) return c.json({ error: 'Alert rule not found' }, 404);
    if (rule.managedByMonitorId) return c.json({ error: 'RULE_ALREADY_MANAGED' }, 409);
    if (rule.orgId === null && !canManagePartnerWidePolicies(auth)) {
      return c.json({ error: PARTNER_WIDE_WRITE_DENIED_MESSAGE }, 403);
    }

    const [template] = await db
      .select()
      .from(alertTemplates)
      .where(eq(alertTemplates.id, rule.templateId))
      .limit(1);
    if (!template) return c.json({ error: 'Alert template not found' }, 404);

    const overrides = (rule.overrideSettings ?? {}) as Record<string, unknown>;
    const converted = convertAlertConditionToMonitor(overrides.conditions ?? template.conditions);
    if (!converted) {
      // A condition group, a multi-condition rule, or a metric with no monitor
      // kind: converting would change what the rule measures.
      return c.json({ error: 'RULE_NOT_CONVERTIBLE' }, 409);
    }

    // The policy is assigned exactly where the rule targeted, so the converted
    // monitor reaches the same devices. 'all' means "everything this rule's
    // owner covers": org-level for an org rule, partner-level for a
    // partner-wide one.
    const assignment: { level: 'partner' | 'organization' | 'site' | 'device_group' | 'device'; targetId: string } | null =
      rule.targetType === 'all'
        ? rule.orgId
          ? { level: 'organization', targetId: rule.orgId }
          : rule.partnerId
            ? { level: 'partner', targetId: rule.partnerId }
            : null
        : rule.targetType === 'org'
          ? { level: 'organization', targetId: rule.targetId }
          : rule.targetType === 'site'
            ? { level: 'site', targetId: rule.targetId }
            : rule.targetType === 'group'
              ? { level: 'device_group', targetId: rule.targetId }
              : rule.targetType === 'device'
                ? { level: 'device', targetId: rule.targetId }
                : null;
    if (!assignment) return c.json({ error: 'RULE_NOT_CONVERTIBLE' }, 409);

    const severity =
      (overrides.severity as 'critical' | 'high' | 'medium' | 'low' | 'info' | undefined) ?? template.severity;
    const channelIds = Array.isArray(overrides.notificationChannelIds)
      ? (overrides.notificationChannelIds as string[])
      : [];

    try {
      const result = await db.transaction(async () => {
        const monitor = await createMonitorDefinition(
          {
            ownerScope: rule.orgId ? 'organization' : 'partner',
            orgId: rule.orgId ?? undefined,
            name: rule.name,
            description: template.description ?? undefined,
            kind: converted.kind,
            enabled: rule.isActive,
            condition: converted.condition,
            severity,
            cooldownMinutes: (overrides.cooldownMinutes as number | undefined) ?? template.cooldownMinutes,
            autoResolve: template.autoResolve,
            responses: [],
            deliveryMode: channelIds.length > 0 ? 'channels' : 'inherit',
            deliveryChannelIds: channelIds,
            escalationPolicyId: (overrides.escalationPolicyId as string | undefined) ?? null,
            recurrenceActions: [],
            pauseResponsesOnEscalation: true,
          } as Parameters<typeof createMonitorDefinition>[0],
          auth,
        );

        const policy = await createConfigPolicy(
          rule.orgId ? { orgId: rule.orgId } : { partnerId: rule.partnerId as string },
          { name: `Converted: ${rule.name}` },
          auth.user.id,
        );
        if (!policy) throw new Error('Failed to create configuration policy');

        await assignPolicy(policy.id, assignment.level, assignment.targetId, 0, auth.user.id);
        await addFeatureLink(policy.id, 'monitors', null, {
          items: [{ monitorId: monitor.id, enabled: true }],
        });

        // The old rule is deactivated, never deleted: its alert history keeps
        // pointing at it, and convertedToMonitorId is what the UI reads to send
        // a technician to the monitor that replaced it.
        await db
          .update(alertRules)
          .set({ isActive: false, overrideSettings: { ...overrides, convertedToMonitorId: monitor.id } })
          .where(eq(alertRules.id, ruleId));

        return { monitorId: monitor.id, configPolicyId: policy.id };
      });

      writeRouteAudit(c, {
        orgId: rule.orgId ?? undefined,
        action: 'alert_rule.convert_to_monitor',
        resourceType: 'alert_rule',
        resourceId: ruleId,
        resourceName: rule.name,
        details: result,
      });

      return c.json({ data: result }, 201);
    } catch (error) {
      const mapped = errorResponse(error);
      if (mapped) return c.json(mapped.body, mapped.status);
      throw error;
    }
  },
);
