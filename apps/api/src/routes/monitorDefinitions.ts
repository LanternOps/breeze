import { Hono } from 'hono';
import { monitorConversionRoutes } from './monitorDefinitions.conversion';
import { z } from 'zod';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { zValidator } from '../lib/validation';
import { db } from '../db';
import {
  configPolicyAssignments,
  configPolicyFeatureLinks,
  configurationPolicies,
  devices,
  deviceGroupMemberships,
  configPolicyMonitors,
} from '../db/schema';
import { authMiddleware, requireMfa, requirePermission, requireScope } from '../middleware/auth';
import { PERMISSIONS } from '../services/permissions';
import { writeRouteAudit } from '../services/auditEvents';
import { evaluateConditions } from '../services/alertConditions';
import { pgErrorCode, pgErrorConstraint } from '../utils/pgErrors';
import {
  createMonitorDefinition,
  deleteMonitorDefinition,
  getMonitorDefinition,
  listMonitorDefinitions,
  MonitorHasDependentsError,
  MonitorNotFoundError,
  MonitorOwnershipError,
  MonitorValidationError,
  updateMonitorDefinition,
} from '../services/monitors/monitorService';
import { buildCompiledCondition } from '../services/monitors/monitorCompiler';
import { MONITOR_KIND_SPECS } from '../services/monitors/kinds';
import { resolveMonitorsForDevice } from '../services/monitors/monitorResolver';
import {
  monitorsLinkSettings,
  readMonitorsLink,
  shouldRemoveEmptiedLink,
} from '../services/monitors/monitorAttachments';
import { isMonitorAttachableToPolicy } from '../services/monitors/monitorAttachability';
import { canManagePartnerWidePolicies, PARTNER_WIDE_WRITE_DENIED_MESSAGE } from '../services/partnerWideAccess';
import { convertRuleToMonitor } from '../services/monitors/ruleConversionService';
import {
  listMonitorDeviceActivity,
  listMonitorEpisodes,
} from '../services/monitors/episodeQueries';
import { resetMonitorEscalation } from '../services/monitors/episodeReset';
import { getDeviceWithOrgAndSiteCheck, SITE_ACCESS_DENIED } from './devices/helpers';
import {
  addFeatureLink,
  assignPolicy,
  authorizeAssignmentTarget,
  createConfigPolicy,
  getConfigPolicy,
  removeFeatureLink,
  updateFeatureLink,
  validateAssignmentTarget,
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

// Every route needs an auth context: requireScope/requirePermission read
// c.get('auth') and 401 without it. Guarded by monitorDefinitions.authGate.test.ts.
monitorDefinitionRoutes.use('*', authMiddleware);

const requireAlertRead = requirePermission(PERMISSIONS.ALERTS_READ.resource, PERMISSIONS.ALERTS_READ.action);
const requireAlertWrite = requirePermission(PERMISSIONS.ALERTS_WRITE.resource, PERMISSIONS.ALERTS_WRITE.action);

function errorResponse(error: unknown): { body: Record<string, unknown>; status: 400 | 403 | 404 | 409 } | null {
  if (error instanceof MonitorOwnershipError) return { body: { error: error.message }, status: 403 };
  if (error instanceof MonitorNotFoundError) return { body: { error: 'Monitor not found' }, status: 404 };
  if (error instanceof MonitorValidationError) {
    return { body: { error: 'INVALID_MONITOR', details: error.message }, status: 400 };
  }
  if (error instanceof MonitorHasDependentsError) {
    // #6509 — a clean, non-leaking 409 in place of the raw postgres FK
    // constraint-violation text this used to fall through and surface as a 500.
    // This is expected to be unreachable in the ordinary case (the known
    // alerts.rule_id cascade is fixed at the DB level, migration
    // 2026-10-25-130200) — it's a belt-and-braces map for any other/future FK
    // the cascade hits, so the message stays generic rather than naming the
    // specific (now-fixed) alerts case.
    return {
      body: {
        error: 'MONITOR_HAS_DEPENDENTS',
        details: 'This monitor still has rows referencing it that cannot be automatically cleared. Try again or contact support.',
      },
      status: 409,
    };
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
    // The web client carries the selected org as an ambient `?orgId=` query,
    // not in the body. Partner tokens have auth.orgId === null, so without
    // this fallback every "This organization only" create 403s (cf. #808).
    const body = c.req.valid('json');
    const queryOrgId = z.string().uuid().safeParse(c.req.query('orgId'));
    const input =
      body.orgId || !queryOrgId.success || body.ownerScope === 'partner'
        ? body
        : { ...body, orgId: queryOrgId.data };
    try {
      const created = await createMonitorDefinition(input, auth);
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

// Literal conversion resource must be registered before parameterized ids.
monitorDefinitionRoutes.route('/conversion', monitorConversionRoutes);

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

    // "Deploy this monitor to X" with no policy in hand creates a policy,
    // assigns it and attaches the monitor. Those three writes run inside ONE
    // db.transaction so a failure in the second or third does not strand a
    // committed, empty, unassigned policy that nothing will ever clean up (and
    // that a client retry would duplicate).
    const creatingPolicy = !('configPolicyId' in body);
    let configPolicyId: string;
    if ('configPolicyId' in body) {
      const policy = await getConfigPolicy(body.configPolicyId, auth);
      if (!policy) return c.json({ error: 'Configuration policy not found' }, 404);
      // Attaching a monitor to a PARTNER-WIDE policy changes what every org
      // under that partner runs, so it takes the same capability every other
      // partner-wide config write takes (CLAUDE.md "Partner-Wide First" step 2).
      // `policyAccessCondition` admits any partner-scoped caller to these rows
      // and RLS only matches the partner id — the org_access subdivision is
      // app-layer only, which is exactly why this check cannot be skipped.
      if (policy.orgId === null && !canManagePartnerWidePolicies(auth)) {
        return c.json({ error: PARTNER_WIDE_WRITE_DENIED_MESSAGE }, 403);
      }
      configPolicyId = body.configPolicyId;
    } else {
      // A partner-wide monitor therefore never lands under an org-owned policy,
      // which the compatibility check below would refuse anyway.
      const owner = monitor.orgId
        ? ({ orgId: monitor.orgId } as const)
        : ({ partnerId: monitor.partnerId as string } as const);

      // Creating a PARTNER-WIDE policy here is the same privileged act as
      // creating one through /configuration-policies, and takes the same gate.
      // Partner-wide MONITORS are deliberately readable by any caller carrying
      // a partnerId (monitorService's read branch), so without this an ordinary
      // org technician could reach this branch off a monitor they can merely
      // see.
      if (owner.partnerId && !canManagePartnerWidePolicies(auth)) {
        return c.json({ error: PARTNER_WIDE_WRITE_DENIED_MESSAGE }, 403);
      }

      // The assignment target is client-supplied: validate it against the
      // policy's own ownership axis and against the caller's site allowlist,
      // exactly as POST /configuration-policies/:id/assignments does. Without
      // this the route accepts a dangling or out-of-scope target silently.
      const targetValidation = await validateAssignmentTarget(
        { orgId: owner.orgId ?? null, partnerId: owner.partnerId ?? null },
        body.createPolicyFor.level,
        body.createPolicyFor.targetId,
      );
      if (!targetValidation.valid) {
        return c.json({ error: targetValidation.error }, 403);
      }
      const siteAuth = await authorizeAssignmentTarget(
        auth,
        body.createPolicyFor.level,
        body.createPolicyFor.targetId,
      );
      if (!siteAuth.valid) {
        return c.json({ error: siteAuth.error }, 403);
      }

      const created = await db.transaction(async () => {
        const policy = await createConfigPolicy(
          owner,
          { name: body.createPolicyFor.name ?? `Monitor: ${monitor.name}` },
          auth.user.id,
        );
        if (!policy) throw new Error('Failed to create configuration policy');
        await assignPolicy(policy.id, body.createPolicyFor.level, body.createPolicyFor.targetId, 0, auth.user.id);
        return policy;
      });
      configPolicyId = created.id;
    }

    const { linkId, items, inheritance } = await readMonitorsLink(configPolicyId);
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

    // Ownership compatibility is checked HERE, before the write, not by
    // catching the database's own guard: that guard is a DEFERRABLE INITIALLY
    // DEFERRED constraint trigger, and the whole request already runs inside
    // one ambient transaction, so `addFeatureLink`'s db.transaction() is a
    // SAVEPOINT whose release never forces the deferred check. The 23514 would
    // land at the middleware's commit, long after this handler returned 201
    // (same class as #5580). The catch below is kept as a belt-and-braces map
    // for any path that does surface it synchronously.
    if (!(await isMonitorAttachableToPolicy(monitor.id, configPolicyId))) {
      // A policy created a few lines up for a monitor that then turns out not
      // to be attachable would be an orphan; `creatingPolicy` says the caller
      // never had a policy of their own here, so say so in the response rather
      // than leaving them guessing what the id refers to.
      return c.json({ error: 'MONITOR_NOT_ATTACHABLE', ...(creatingPolicy ? { configPolicyId } : {}) }, 400);
    }

    try {
      if (linkId) {
        await updateFeatureLink(linkId, { inlineSettings: monitorsLinkSettings(nextItems, inheritance) }, configPolicyId);
      } else {
        await addFeatureLink(configPolicyId, 'monitors', null, { items: nextItems });
      }
    } catch (error) {
      if (
        pgErrorCode(error) === '23514' &&
        pgErrorConstraint(error) === 'config_policy_monitors_compat'
      ) {
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
    // Detaching from a partner-wide policy removes the monitor from every org
    // under the partner — same capability as attaching (see the POST handler).
    if (policy.orgId === null && !canManagePartnerWidePolicies(auth)) {
      return c.json({ error: PARTNER_WIDE_WRITE_DENIED_MESSAGE }, 403);
    }

    const { items, inheritance } = await readMonitorsLink(attachment.configPolicyId);
    const nextItems = items.filter((i) => i.monitorId !== monitor.id);
    if (shouldRemoveEmptiedLink(nextItems, inheritance)) {
      await removeFeatureLink(attachment.featureLinkId, attachment.configPolicyId);
    } else {
      await updateFeatureLink(
        attachment.featureLinkId,
        { inlineSettings: monitorsLinkSettings(nextItems, inheritance) },
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

    // Site axis: RLS does not defend it, so a site-restricted caller is narrowed
    // here, inside the query — filtering after the LIMIT would silently drop
    // in-scope devices. `undefined` = unrestricted; `[]` = no site at all.
    const allowedSiteIds = auth.allowedSiteIds;
    if (allowedSiteIds?.length === 0) return c.json({ data: [] });

    const candidates = await db
      .select({ id: devices.id, hostname: devices.hostname, displayName: devices.displayName })
      .from(devices)
      .where(
        and(
          auth.orgCondition(devices.orgId),
          allowedSiteIds ? inArray(devices.siteId, allowedSiteIds) : undefined,
          sql`(${sql.join(deviceConditions, sql` OR `)})`,
        ),
      )
      .limit(1000);

    // #5290 — one indexed read of the operational state for the whole monitor,
    // merged onto the resolved devices below. A pair with no state row has
    // simply never been evaluated; it reports lastState 'unknown'.
    const activity = await listMonitorDeviceActivity(monitor.id, auth);
    const activityByDevice = new Map(activity.map((row) => [row.deviceId, row]));

    const data: Array<Record<string, unknown>> = [];
    for (const device of candidates) {
      // A device that vanished between the candidate query above and here
      // (raced a delete) resolves as `device_missing`, not a fabricated
      // "zero monitors apply" — either way it drops out of this listing,
      // but the two must stay distinguishable at the resolver (#5677).
      const resolution = await resolveMonitorsForDevice(device.id);
      const match =
        resolution.kind === 'resolved'
          ? resolution.monitors.find((m) => m.monitorId === monitor.id)
          : undefined;
      if (!match) continue;
      const state = activityByDevice.get(device.id);
      data.push({
        deviceId: device.id,
        deviceName: device.displayName || device.hostname,
        enabled: match.enabled,
        overrides: match.overrides,
        sourcePolicyId: match.sourcePolicyId,
        sourceLevel: match.sourceLevel,
        lastState: state?.lastState ?? 'unknown',
        lastEvaluatedAt: state?.lastEvaluatedAt ?? null,
        currentEpisodeId: state?.currentEpisodeId ?? null,
        openSince: state?.openSince ?? null,
        episodesInWindow: state?.episodesInWindow ?? 0,
        windowStartedAt: state?.windowStartedAt ?? null,
        escalatedAt: state?.escalatedAt ?? null,
        escalationAlertId: state?.escalationAlertId ?? null,
        responsesPaused: state?.responsesPaused ?? false,
        resetAt: state?.resetAt ?? null,
        resetBy: state?.resetBy ?? null,
      });
    }

    return c.json({ data });
  },
);

// GET /monitor-definitions/:id/episodes — breach history, newest first (#5290).
monitorDefinitionRoutes.get(
  '/:id/episodes',
  requireScope('organization', 'partner', 'system'),
  requireAlertRead,
  async (c) => {
    const auth = c.get('auth');
    const monitor = await getMonitorDefinition(c.req.param('id')!, auth);
    if (!monitor) return c.json({ error: 'Monitor not found' }, 404);

    const rawLimit = Number.parseInt(c.req.query('limit') ?? '', 10);
    const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), 200) : 50;
    const deviceId = c.req.query('deviceId');
    const cursor = c.req.query('cursor');

    const { episodes, nextCursor } = await listMonitorEpisodes(monitor.id, auth, {
      ...(deviceId ? { deviceId } : {}),
      limit,
      ...(cursor ? { cursor } : {}),
    });
    return c.json({ data: episodes, nextCursor });
  },
);

// POST /monitor-definitions/:id/devices/:deviceId/reset — clear a recurrence
// escalation for one pair (#5290). Does NOT close the open episode and does NOT
// resolve or acknowledge the requires-human alert.
monitorDefinitionRoutes.post(
  '/:id/devices/:deviceId/reset',
  requireScope('organization', 'partner', 'system'),
  requireAlertWrite,
  requireMfa(),
  async (c) => {
    const auth = c.get('auth');
    const id = c.req.param('id')!;
    const deviceId = c.req.param('deviceId')!;
    const monitor = await getMonitorDefinition(id, auth);
    if (!monitor) return c.json({ error: 'Monitor not found' }, 404);

    // Site is an app-layer axis only — RLS does not defend it — so the device
    // must pass the canonical org + site gate before its per-device episode
    // state is touched (site-scope coverage contract).
    const device = await getDeviceWithOrgAndSiteCheck(c, deviceId, auth);
    if (device === SITE_ACCESS_DENIED) return c.json({ error: 'Access to this site denied' }, 403);
    if (!device) return c.json({ error: 'Device not found' }, 404);

    const result = await resetMonitorEscalation({ monitorId: monitor.id, deviceId: device.id, auth });

    writeRouteAudit(c, {
      orgId: monitor.orgId ?? undefined,
      action: 'monitor.escalation.reset',
      resourceType: 'monitor_definition',
      resourceId: monitor.id,
      resourceName: monitor.name,
      details: { monitorId: monitor.id, deviceId, reset: result.reset },
    });

    return c.json(result);
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
      .select({ id: devices.id, siteId: devices.siteId })
      .from(devices)
      .where(and(...deviceConditions))
      .limit(1);
    // Same 404 for a device outside the caller's sites as for a missing one, so
    // a site-restricted technician cannot probe other sites' devices.
    const allowedSiteIds = auth.allowedSiteIds;
    if (!device || (allowedSiteIds && !allowedSiteIds.includes(device.siteId))) {
      return c.json({ error: 'Device not found' }, 404);
    }

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
// Thin HTTP shell; the orchestration (and the reason it does not live on
// /alerts/rules/:id) is in services/monitors/ruleConversionService.ts.
monitorDefinitionRoutes.post(
  '/convert-from-rule/:ruleId',
  requireScope('organization', 'partner', 'system'),
  requireAlertWrite,
  requireMfa(),
  async (c) => {
    const auth = c.get('auth');
    const ruleId = c.req.param('ruleId')!;

    try {
      const result = await convertRuleToMonitor(ruleId, auth);
      if (!result.ok) {
        switch (result.failure.kind) {
          case 'rule_not_found':
            return c.json({ error: 'Alert rule not found' }, 404);
          case 'template_not_found':
            return c.json({ error: 'Alert template not found' }, 404);
          case 'already_managed':
            return c.json({ error: 'RULE_ALREADY_MANAGED' }, 409);
          case 'not_convertible':
            return c.json({ error: 'RULE_NOT_CONVERTIBLE' }, 409);
          case 'partner_wide_denied':
            return c.json({ error: result.failure.message }, 403);
        }
      }

      const { monitorId, configPolicyId, ruleName, ruleOrgId } = result.data;
      writeRouteAudit(c, {
        orgId: ruleOrgId ?? undefined,
        action: 'alert_rule.convert_to_monitor',
        resourceType: 'alert_rule',
        resourceId: ruleId,
        resourceName: ruleName,
        details: { monitorId, configPolicyId },
      });

      return c.json({ data: { monitorId, configPolicyId } }, 201);
    } catch (error) {
      const mapped = errorResponse(error);
      if (mapped) return c.json(mapped.body, mapped.status);
      throw error;
    }
  },
);
