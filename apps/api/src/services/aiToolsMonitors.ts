/**
 * AI Monitor Tools (#5287 W02 / #5289 Task 8)
 *
 * MCP tools for the `monitor_definitions` feature — a monitor is the single
 * authored object (condition + severity + responses + delivery) that compiles
 * into a managed alert template / alert rule / automation
 * (`services/monitors/monitorCompiler.ts`). This is DELIBERATELY distinct
 * from `aiToolsMonitoring.ts`, which covers the unrelated network-monitor API
 * (`/monitors` on network devices, not `/monitor-definitions`).
 *
 * Ownership (org XOR partner) and access control are already enforced by
 * `services/monitors/monitorService.ts` — every handler below calls that
 * service rather than re-implementing `assertCanWrite` /
 * `resolveOwnerForCreate` here, so there is exactly one place that logic can
 * drift. `safeHandler` below only MAPS the service's typed errors to the
 * tool's `{ error }` JSON shape, mirroring `routes/monitorDefinitions.ts`'s
 * `errorResponse` helper.
 *
 * Attach/detach read and rewrite the monitors link through
 * `monitors/monitorAttachments.ts`, the same helper the REST route uses.
 */
import { pageEnvelope, pageParamSchema, readPageArgs } from './aiToolPagination';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db';
import { configPolicyMonitors, configPolicyFeatureLinks, configurationPolicies } from '../db/schema';
import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';
import { isMonitorAttachableToPolicy } from './monitors/monitorAttachability';
import { monitorsLinkSettings, readMonitorsLink, shouldRemoveEmptiedLink } from './monitors/monitorAttachments';
import { canManagePartnerWidePolicies, PARTNER_WIDE_WRITE_DENIED_MESSAGE } from './partnerWideAccess';
import { pgErrorCode, pgErrorConstraint } from '../utils/pgErrors';
import { toolErrorResult } from './aiToolErrors';
import { describeFirstZodIssue } from '../lib/zodIssues';
import {
  addFeatureLink,
  getConfigPolicy,
  removeFeatureLink,
  updateFeatureLink,
} from './configurationPolicy';
import {
  createMonitorDefinition,
  deleteMonitorDefinition,
  getMonitorDefinition,
  listMonitorDefinitions,
  MonitorNotFoundError,
  MonitorOwnershipError,
  MonitorValidationError,
  updateMonitorDefinition,
} from './monitors/monitorService';
import { listMonitorDeviceActivity, listMonitorEpisodes } from './monitors/episodeQueries';
import { resetMonitorEscalation } from './monitors/episodeReset';
import { writeAuditEvent, requestLikeFromSnapshot } from './auditEvents';
import {
  createMonitorDefinitionSchema,
  updateMonitorDefinitionSchema,
  MONITOR_KINDS,
  type MonitorKind,
} from '@breeze/shared';

type Handler = (input: Record<string, unknown>, auth: AuthContext) => Promise<string>;

/**
 * Map the service's typed errors to the tool's plain `{ error }` shape —
 * the AI-tool analogue of `routes/monitorDefinitions.ts`'s `errorResponse`.
 * Anything else falls through to `toolErrorResult`, which fails closed on a
 * raw driver string (#2603).
 */
function safeHandler(toolName: string, fn: Handler): Handler {
  return async (input, auth) => {
    try {
      return await fn(input, auth);
    } catch (err) {
      if (err instanceof MonitorOwnershipError) return JSON.stringify({ error: err.message });
      if (err instanceof MonitorNotFoundError) return JSON.stringify({ error: 'Monitor not found' });
      if (err instanceof MonitorValidationError) return JSON.stringify({ error: err.message });
      return toolErrorResult(`monitors:${toolName}`, err, { action: (input as { action?: unknown }).action });
    }
  };
}

function ownerScopeOf(row: { orgId: string | null }): 'organization' | 'partner' {
  return row.orgId ? 'organization' : 'partner';
}

/**
 * Best-effort audit write for the monitor AI tools — never blocks the tool
 * result (mirrors `auditOrgToolEvent` in `aiToolsOrgs.ts`).
 */
function auditMonitorToolEvent(
  auth: AuthContext,
  entry: {
    orgId: string | null;
    action: string;
    resourceType: string;
    resourceId?: string;
    resourceName?: string;
    details?: Record<string, unknown>;
  },
): void {
  try {
    writeAuditEvent(requestLikeFromSnapshot({}), {
      orgId: entry.orgId,
      actorId: auth.user.id,
      actorEmail: auth.user.email,
      action: entry.action,
      resourceType: entry.resourceType,
      resourceId: entry.resourceId,
      resourceName: entry.resourceName,
      result: 'success',
      details: { ...entry.details, tool_name: 'reset_monitor_escalation' },
    });
  } catch (err) {
    console.error('[reset_monitor_escalation] audit write failed', err);
  }
}

async function attachmentCountsFor(monitorIds: string[]): Promise<Map<string, number>> {
  if (monitorIds.length === 0) return new Map();
  const rows = await db
    .select({ monitorId: configPolicyMonitors.monitorId, count: sql<number>`count(*)::int` })
    .from(configPolicyMonitors)
    .where(inArray(configPolicyMonitors.monitorId, monitorIds))
    .groupBy(configPolicyMonitors.monitorId);
  return new Map(rows.map((r) => [r.monitorId, r.count]));
}

async function attachmentsFor(monitorId: string) {
  return db
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
    .where(eq(configPolicyMonitors.monitorId, monitorId));
}

export function registerMonitorTools(aiTools: Map<string, AiTool>): void {
  function registerTool(tool: AiTool): void {
    aiTools.set(tool.definition.name, tool);
  }

  // ============================================
  // list_monitors — Tier 1 (read)
  // ============================================
  registerTool({
    tier: 1,
    domain: 'monitoring',
    searchHint: 'monitor definitions, authored conditions, severity and response rules across organizations',
    definition: {
      name: 'list_monitors',
      description:
        'List monitor definitions visible to the caller (org-owned plus, for partner-scoped callers, partner-wide monitors). A monitor is an authored condition + severity + responses + delivery that compiles into a managed alert rule and automation — use manage_monitor_definitions to create or change one.',
      input_schema: {
        type: 'object' as const,
        properties: {
          kind: { type: 'string', enum: [...MONITOR_KINDS], description: 'Filter by monitor kind' },
          enabled: { type: 'boolean', description: 'Filter by enabled state' },
          ...pageParamSchema(25, 100),
        },
      },
    },
    handler: safeHandler('list_monitors', async (input, auth) => {
      const filters: { kind?: MonitorKind; enabled?: boolean } = {};
      if (typeof input.kind === 'string') filters.kind = input.kind as MonitorKind;
      if (typeof input.enabled === 'boolean') filters.enabled = input.enabled;

      const pageArgs = readPageArgs('list_monitors', input, { defaultLimit: 25, maxLimit: 100 });
      if (!pageArgs.ok) return JSON.stringify({ error: pageArgs.error, code: pageArgs.code });
      const { limit, offset, fingerprint } = pageArgs;

      const rows = await listMonitorDefinitions(auth, filters);
      if (rows.length === 0) {
        return JSON.stringify(pageEnvelope({ key: 'monitors', items: [], limit, offset, fingerprint, total: 0 }));
      }

      // `rows` is the caller's whole visible set (no DB-side limit today), so
      // `total` is the true count and the page is sliced from it.
      const pageRows = rows.slice(offset, offset + limit);
      const counts = await attachmentCountsFor(pageRows.map((r) => r.id));

      return JSON.stringify(pageEnvelope({
        key: 'monitors',
        items: pageRows.map((r) => ({
          id: r.id,
          name: r.name,
          kind: r.kind,
          severity: r.severity,
          enabled: r.enabled,
          ownerScope: ownerScopeOf(r),
          attachmentCount: counts.get(r.id) ?? 0,
        })),
        limit, offset, fingerprint,
        total: rows.length,
      }));
    }),
  });

  // ============================================
  // get_monitor — Tier 1 (read)
  // ============================================
  registerTool({
    tier: 1,
    domain: 'monitoring',
    searchHint: 'monitor definition details, configuration policy attachments and compiled alert rules',
    definition: {
      name: 'get_monitor',
      description:
        'Get a single monitor definition by id, with its configuration-policy attachments and compiled alert-rule/automation ids.',
      input_schema: {
        type: 'object' as const,
        properties: {
          monitorId: { type: 'string', description: 'Monitor definition UUID' },
        },
        required: ['monitorId'],
      },
    },
    handler: safeHandler('get_monitor', async (input, auth) => {
      if (!input.monitorId) return JSON.stringify({ error: 'monitorId is required' });

      const monitor = await getMonitorDefinition(input.monitorId as string, auth);
      if (!monitor) return JSON.stringify({ error: 'Monitor not found or access denied' });

      const attachments = await attachmentsFor(monitor.id);

      return JSON.stringify({
        monitor: { ...monitor, ownerScope: ownerScopeOf(monitor) },
        attachments,
        compiled: {
          alertTemplateId: monitor.compiledAlertTemplateId,
          alertRuleId: monitor.compiledAlertRuleId,
          automationId: monitor.compiledAutomationId,
        },
      });
    }),
  });

  // ============================================
  // get_monitor_activity — Tier 2 (read)
  // ============================================
  registerTool({
    tier: 2,
    deviceArgs: ['deviceId'],
    domain: 'monitoring',
    searchHint: 'monitor breach episodes, device state, recurrence counts and escalation history',
    definition: {
      name: 'get_monitor_activity',
      description:
        'Get per-device breach state and recent breach episodes for a monitor definition: current state, open episode, recurrence-window count, escalation/pause status, and the episode history. Read-only — use reset_monitor_escalation to clear an escalated latch.',
      input_schema: {
        type: 'object' as const,
        properties: {
          monitorId: { type: 'string', description: 'Monitor definition UUID' },
          deviceId: { type: 'string', description: 'Filter to a single device UUID' },
          limit: { type: 'number', description: 'Max episodes to return (default 50, max 200)' },
        },
        required: ['monitorId'],
      },
    },
    handler: safeHandler('get_monitor_activity', async (input, auth) => {
      if (!input.monitorId) return JSON.stringify({ error: 'monitorId is required' });

      const monitor = await getMonitorDefinition(input.monitorId as string, auth);
      if (!monitor) return JSON.stringify({ error: 'Monitor not found or access denied' });

      const deviceId = typeof input.deviceId === 'string' ? input.deviceId : undefined;
      const limit = Math.min(Math.max(1, Number(input.limit) || 50), 200);

      const activity = await listMonitorDeviceActivity(monitor.id, auth);
      const devices = deviceId ? activity.filter((row) => row.deviceId === deviceId) : activity;

      const { episodes, nextCursor } = await listMonitorEpisodes(monitor.id, auth, {
        ...(deviceId ? { deviceId } : {}),
        limit,
      });

      return JSON.stringify({
        monitorId: monitor.id,
        devices,
        episodes,
        nextCursor,
      });
    }),
  });

  // ============================================
  // reset_monitor_escalation — Tier 2 (write, audited)
  // ============================================
  registerTool({
    tier: 2,
    deviceArgs: ['deviceId'],
    domain: 'monitoring',
    searchHint: 'monitor escalation latch reset for one device, resume automatic responses and restart recurrence window',
    definition: {
      name: 'reset_monitor_escalation',
      description:
        'Clear a recurrence-escalation latch for one monitor/device pair: resumes automatic responses and restarts the recurrence window. Does NOT close the open episode and does NOT resolve or acknowledge the requires-human alert — a device still in breach is still in breach.',
      input_schema: {
        type: 'object' as const,
        properties: {
          monitorId: { type: 'string', description: 'Monitor definition UUID' },
          deviceId: { type: 'string', description: 'Device UUID' },
        },
        required: ['monitorId', 'deviceId'],
      },
    },
    handler: safeHandler('reset_monitor_escalation', async (input, auth) => {
      if (!input.monitorId) return JSON.stringify({ error: 'monitorId is required' });
      if (!input.deviceId) return JSON.stringify({ error: 'deviceId is required' });

      const monitor = await getMonitorDefinition(input.monitorId as string, auth);
      if (!monitor) return JSON.stringify({ error: 'Monitor not found or access denied' });

      const deviceId = input.deviceId as string;
      const result = await resetMonitorEscalation({ monitorId: monitor.id, deviceId, auth });

      auditMonitorToolEvent(auth, {
        orgId: monitor.orgId ?? null,
        action: 'monitor.escalation.reset',
        resourceType: 'monitor_definition',
        resourceId: monitor.id,
        resourceName: monitor.name,
        details: { monitorId: monitor.id, deviceId, reset: result.reset },
      });

      return JSON.stringify({ reset: result.reset });
    }),
  });

  // ============================================
  // manage_monitor_definitions — Tier 3 (write)
  // NOTE: named manage_monitor_definitions, NOT manage_monitors — that name is
  // already taken by the unrelated network-monitor CRUD tool (aiToolsMonitoring.ts).
  // ============================================
  registerTool({
    tier: 3,
    domain: 'monitoring',
    searchHint: 'monitor definitions: create, update, delete, enable, disable, attach, detach configuration policies',
    definition: {
      name: 'manage_monitor_definitions',
      description:
        'Manage monitors; never edit compiled managed rows directly. Partner scope applies to every partner org and requires full partner org access; default is organization. Actions: create, update, delete, enable, disable, attach, detach. Kind network_check compiles to a managed network probe; set condition.assetId to bind it to a discovered asset.',
      input_schema: {
        type: 'object' as const,
        properties: {
          action: {
            type: 'string',
            enum: ['create', 'update', 'delete', 'enable', 'disable', 'attach', 'detach'],
            description: 'The action to perform',
          },
          monitorId: {
            type: 'string',
            description: 'Monitor definition UUID (required for update/delete/enable/disable/attach/detach)',
          },
          definition: {
            type: 'object',
            description:
              'Monitor fields: full definition for create, partial for update. ownerScope: organization (default) or partner; immutable after create.',
          },
          configPolicyId: { type: 'string', description: 'Configuration policy UUID to attach to (for attach)' },
          attachmentId: { type: 'string', description: 'Attachment UUID to remove (for detach)' },
          enabled: { type: 'boolean', description: 'Attachment enabled state (for attach; default true)' },
          overrides: { type: 'object', description: 'Per-attachment condition overrides (for attach)' },
        },
        required: ['action'],
      },
    },
    handler: safeHandler('manage_monitor_definitions', async (input, auth) => {
      const action = input.action as string;

      if (action === 'create') {
        const parsed = createMonitorDefinitionSchema.safeParse(input.definition ?? {});
        if (!parsed.success) {
          return JSON.stringify({
            error: describeFirstZodIssue(parsed.error) ?? 'Invalid monitor definition',
          });
        }
        const created = await createMonitorDefinition(parsed.data, auth);
        return JSON.stringify({ success: true, monitor: { ...created, ownerScope: ownerScopeOf(created) } });
      }

      if (action === 'update' || action === 'enable' || action === 'disable') {
        if (!input.monitorId) return JSON.stringify({ error: 'monitorId is required' });
        const patch: unknown =
          action === 'enable'
            ? { enabled: true }
            : action === 'disable'
              ? { enabled: false }
              : (input.definition ?? {});
        const parsed = updateMonitorDefinitionSchema.safeParse(patch);
        if (!parsed.success) {
          return JSON.stringify({
            error: describeFirstZodIssue(parsed.error) ?? 'Invalid monitor definition',
          });
        }
        const updated = await updateMonitorDefinition(input.monitorId as string, parsed.data, auth);
        return JSON.stringify({ success: true, monitor: { ...updated, ownerScope: ownerScopeOf(updated) } });
      }

      if (action === 'delete') {
        if (!input.monitorId) return JSON.stringify({ error: 'monitorId is required' });
        await deleteMonitorDefinition(input.monitorId as string, auth);
        return JSON.stringify({ success: true, message: 'Monitor deleted' });
      }

      if (action === 'attach') {
        if (!input.monitorId) return JSON.stringify({ error: 'monitorId is required' });
        if (!input.configPolicyId) return JSON.stringify({ error: 'configPolicyId is required' });

        const monitor = await getMonitorDefinition(input.monitorId as string, auth);
        if (!monitor) return JSON.stringify({ error: 'Monitor not found or access denied' });
        const policy = await getConfigPolicy(input.configPolicyId as string, auth);
        if (!policy) return JSON.stringify({ error: 'Configuration policy not found or access denied' });
        // A partner-wide policy applies to every org under the partner, so
        // mutating its monitor list takes the partner-wide capability, not just
        // visibility (CLAUDE.md "Partner-Wide First" step 2). RLS matches only
        // the partner id; the org_access subdivision is app-layer.
        if (policy.orgId === null && !canManagePartnerWidePolicies(auth)) {
          return JSON.stringify({ error: PARTNER_WIDE_WRITE_DENIED_MESSAGE });
        }

        const { linkId, items, inheritance } = await readMonitorsLink(input.configPolicyId as string);
        if (items.some((i) => i.monitorId === monitor.id)) {
          return JSON.stringify({ error: 'Monitor already attached to this policy' });
        }
        const nextItems = [
          ...items,
          {
            monitorId: monitor.id,
            enabled: (input.enabled as boolean | undefined) ?? true,
            overrides: (input.overrides as Record<string, unknown> | null | undefined) ?? null,
            sortOrder: items.length,
          },
        ];

        // Pre-checked, not caught: the database guard is a DEFERRABLE
        // INITIALLY DEFERRED trigger and this runs inside the request's
        // ambient transaction, so its 23514 would only fire at that
        // transaction's commit — after this tool already answered (#5580 class).
        if (!(await isMonitorAttachableToPolicy(monitor.id, input.configPolicyId as string))) {
          return JSON.stringify({
            error: 'Monitor cannot be attached to this policy — ownership axis mismatch (org vs partner-wide).',
          });
        }

        try {
          if (linkId) {
            await updateFeatureLink(
              linkId,
              { inlineSettings: monitorsLinkSettings(nextItems, inheritance) },
              input.configPolicyId as string,
            );
          } else {
            await addFeatureLink(input.configPolicyId as string, 'monitors', null, { items: nextItems });
          }
        } catch (error) {
          // Deferred compatibility trigger — surfaces at COMMIT as 23514 (see
          // routes/monitorDefinitions.ts's attach route for the same check).
          if (pgErrorCode(error) === '23514' && pgErrorConstraint(error) === 'config_policy_monitors_compat') {
            return JSON.stringify({
              error: 'Monitor cannot be attached to this policy — ownership axis mismatch (org vs partner-wide).',
            });
          }
          throw error;
        }

        return JSON.stringify({ success: true, monitorId: monitor.id, configPolicyId: input.configPolicyId });
      }

      if (action === 'detach') {
        if (!input.monitorId) return JSON.stringify({ error: 'monitorId is required' });
        if (!input.attachmentId) return JSON.stringify({ error: 'attachmentId is required' });

        const monitor = await getMonitorDefinition(input.monitorId as string, auth);
        if (!monitor) return JSON.stringify({ error: 'Monitor not found or access denied' });

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
              eq(configPolicyMonitors.id, input.attachmentId as string),
              eq(configPolicyMonitors.monitorId, monitor.id),
            ),
          )
          .limit(1);
        if (!attachment) return JSON.stringify({ error: 'Attachment not found' });

        const policy = await getConfigPolicy(attachment.configPolicyId, auth);
        if (!policy) return JSON.stringify({ error: 'Configuration policy not found or access denied' });
        // Detaching from a partner-wide policy removes the monitor from every
        // org under the partner — same capability as attaching.
        if (policy.orgId === null && !canManagePartnerWidePolicies(auth)) {
          return JSON.stringify({ error: PARTNER_WIDE_WRITE_DENIED_MESSAGE });
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

        return JSON.stringify({ success: true, monitorId: monitor.id });
      }

      return JSON.stringify({ error: `Unknown action: ${action}` });
    }),
  });
}
